import SwiftUI
import DJBoothKit
import Security

struct PlaylistRemovalRequest: Identifiable {
    let id = UUID()
    let trackID: String
    let trackTitle: String
    let collectionID: String
    let collectionName: String
    let connectionGeneration: UUID
}

struct PlaylistRemovalUndo {
    let removal: CollectionTrackRemoval
    let trackTitle: String
    let collectionName: String
    let connectionGeneration: UUID
}

enum LibraryBrowseMode: String, CaseIterable {
    case playlists = "Playlists", artists = "Artists", albums = "Albums", tracks = "All Tracks"
    var symbol: String {
        switch self {
        case .playlists: "music.note.list"
        case .artists: "person.2"
        case .albums: "square.stack"
        case .tracks: "music.note"
        }
    }
    func group(for track: Track) -> String {
        let value = (self == .artists ? track.artist : track.album)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? (self == .artists ? "Unknown artist" : "Unknown album") : value
    }
}

private struct BoothLaunchConfiguration: Sendable {
    let demo: Bool
    let uiTestID: UUID?
    let cloudURL: String
    let root: URL
    let scope: String
    let accountID: String?
    var inMemory: Bool { demo && uiTestID == nil }
    var directory: URL? { inMemory ? nil : root.appendingPathComponent(scope) }
    var audioDirectory: URL { (scope == "local" ? root : root.appendingPathComponent(scope)).appendingPathComponent("Audio") }
    init() throws {
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "--ui-test-library") {
            guard arguments.indices.contains(index + 1), let id = UUID(uuidString: arguments[index + 1]) else {
                throw ClientError.http(400, "UI test library requires a UUID")
            }
            uiTestID = id
        } else { uiTestID = nil }
        demo = arguments.contains("--demo") || uiTestID != nil
        #else
        uiTestID = nil; demo = false
        #endif
        cloudURL = demo ? "" : (ProcessInfo.processInfo.environment["DJBOOTH_CLOUD_URL"]
            ?? UserDefaults.standard.string(forKey: "cloudURL") ?? "")
        let applicationRoot = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DJBooth", isDirectory: true)
        if let uiTestID { root = applicationRoot.appendingPathComponent("UITests").appendingPathComponent(uiTestID.uuidString) }
        else if demo { root = FileManager.default.temporaryDirectory.appendingPathComponent("DJBoothPreview") }
        else { root = applicationRoot }
        let endpoint = try? Endpoint(cloudURL)
        let savedAccount = endpoint.flatMap { UserDefaults.standard.string(forKey: "cloudAccount:" + $0.scope) }
        accountID = savedAccount
        scope = endpoint.flatMap { endpoint in savedAccount.map { endpoint.accountScope($0) } } ?? "local"
    }
}

@MainActor @Observable final class BoothModel {
    func recordingUploadAvailability(_ source: MusicSource) async throws -> RecordingUploadAvailability {
        guard let cloud else { throw ClientError.http(401, "Sign in before uploading a recording") }
        return try await cloud.recordingUploadAvailability(source)
    }
    func uploadRecording(file: URL, source: MusicSource, title: String, description: String, progress: (@Sendable (String) -> Void)? = nil) async throws -> RecordingUploadResult {
        guard let cloud, musicCatalog.sources.contains(source) else { throw ClientError.http(403, "Connect this SoundCloud account first") }
        let key = "recording-upload:" + cloudStorageScope + ":" + source.connectionID + ":" + file.deletingLastPathComponent().lastPathComponent
        if let data = UserDefaults.standard.data(forKey: key + ":result"),
           let result = try? JSONDecoder().decode(RecordingUploadResult.self, from: data) { return result }
        let uploadID = UserDefaults.standard.string(forKey: key) ?? UUID().uuidString
        UserDefaults.standard.set(uploadID, forKey: key)
        let result = try await cloud.uploadRecording(file: file, source: source, title: title, description: description, uploadID: uploadID, progress: progress)
        UserDefaults.standard.set(try JSONEncoder().encode(result), forKey: key + ":result")
        return result
    }
    let spotifyStreaming = SpotifyStreaming()
    var spotifySignIn: MusicSource?
    private var pendingSpotifyTrackID: String?
    func beginSpotifySignIn(_ source: MusicSource) {
        pendingSpotifyTrackID = nil
        spotifySignIn = source
    }
    func spotifySignInDismissed() { pendingSpotifyTrackID = nil }
    private func spotifyKey(_ source: MusicSource) -> String { "spotify-streaming:" + cloudStorageScope + ":" + source.connectionID }
    func authorizeSpotify(_ source: MusicSource, token: String) async throws {
        let generation = connectionGeneration
        let pendingTrackID = pendingSpotifyTrackID
        let pendingRequest = playbackRequest
        guard musicCatalog.sources.contains(source), cloud != nil else { throw ClientError.http(403, "Connect this account first") }
        spotifyPrewarm?.cancel(); spotifyPrewarm = nil
        try await spotifyStreaming.authorize(source, key: spotifyKey(source), token: token)
        guard generation == connectionGeneration else { await spotifyStreaming.disconnect(); throw CancellationError() }
        try Task.checkCancellation()
        pendingSpotifyTrackID = nil
        if pendingRequest == playbackRequest, let track = player.track, track.id == pendingTrackID {
            await play(track, preservingQueue: true)
        }
    }
    private func prepareSpotifyPlayback(_ track: MusicTrack, source: MusicSource, request: UUID, generation: UUID) async throws {
        guard request == playbackRequest, generation == connectionGeneration else { return }
        do {
            guard let cloud, try await cloud.musicSources().contains(where: { $0.id == source.id && $0.accountID == source.accountID }) else { throw ClientError.http(403, "This Spotify connection is no longer approved") }
            guard request == playbackRequest, generation == connectionGeneration else { return }
            PerformanceProbe.event("spotify_grant_verified", trackID: track.id)
            try await spotifyStreaming.play(track, source: source, key: spotifyKey(source), player: player)
            guard request == playbackRequest, generation == connectionGeneration else { return }
            // librespot, like ncspot, keeps one transient next-track decoder. This
            // does not acquire a library file, persist audio, or run analysis.
            if let next = player.queue.dropFirst(player.queueIndex + 1).first,
               next.id.hasPrefix("connected:" + source.id + ":track:"),
               let item = musicCatalog.snapshots.values.lazy.flatMap({ $0.tracks }).first(where: { $0.id == next.id }) {
                await spotifyStreaming.preload(item, source: source, key: spotifyKey(source))
            }
        }
        catch {
            guard request == playbackRequest, generation == connectionGeneration else { return }
            if case ClientError.http(let status, _) = error, status == 401 || status == 400 { pendingSpotifyTrackID = track.id; spotifySignIn = source; return }
            throw error
        }
    }
    private var musicCatalogLoaded = false
    var musicCatalog = MusicCatalog()
    var musicLoading = false
    var musicError: String?
    var musicProviderErrors: [String: String] = [:]
    var musicProviderNames: [String] {
        Array(Set(musicCatalog.sources.map(\.providerName) + cloudCapabilities.compactMap {
            $0 == "spotify" ? "Spotify" : $0 == "soundcloud" ? "SoundCloud" : nil
        })).sorted()
    }
    func musicFolderError(_ provider: String) -> String? { musicProviderErrors[provider] ?? musicError }
    var musicPlaylistLoading: Set<String> = []
    var musicPlaylistErrors: [String: String] = [:]
    var musicDownloads: Set<String> = []
    private var musicDownloadIDs: [String: String] = [:]
    func connectedPlaylist(_ id: String) -> MusicPlaylist? { musicCatalog.playlists.first { $0.id == id } }
    func musicIsDownloaded(_ playlist: MusicPlaylist) -> Bool {
        guard let collection = musicCatalog.downloadedCollection(for: playlist, library: collections) else { return false }
        return collection.trackIDs.allSatisfy { tracksByID[$0]?.mediaHash != nil }
    }
    var playlistCollections: [Collection] {
        musicCatalog.visibleCollections(in: collections, jobs: importJobs).sorted { first, second in
            let comparison = first.name.localizedStandardCompare(second.name)
            return comparison == .orderedSame ? first.id < second.id : comparison == .orderedAscending
        }
    }
    private var musicRefreshTask: Task<Void, Never>?
    func refreshMusic(force: Bool = false, provider: String? = nil) async {
        if let task = musicRefreshTask {
            await task.value
            return
        }
        guard !Task.isCancelled else { return }
        let generation = connectionGeneration
        // Navigating into a folder must not cancel the shared account refresh.
        let task = Task {
            defer { if generation == connectionGeneration { musicRefreshTask = nil } }
            await refreshMusicCatalog(force: force, provider: provider)
        }
        musicRefreshTask = task
        await task.value
    }
    private func refreshMusicCatalog(force: Bool, provider: String?) async {
        guard let cloud, !demo, !musicLoading else { return }
        if !force, musicError == nil, musicProviderErrors.isEmpty, Date().timeIntervalSince1970 - musicCatalog.fetchedAt < 300 { return }
        let generation = connectionGeneration
        musicLoading = true; defer { if generation == connectionGeneration { musicLoading = false } }
        do {
            let sources = try await cloud.musicSources()
            guard generation == connectionGeneration else { return }
            try Task.checkCancellation()
            musicError = nil
            musicCatalog.sources = sources
            let ids = Set(sources.map(\.id))
            musicCatalog.playlists.removeAll { !ids.contains($0.sourceID) }
            musicCatalog.snapshots = musicCatalog.snapshots.filter { ids.contains($0.value.playlist.sourceID) }
            try store.saveMusicCatalog(musicCatalog); try await reload()
            guard generation == connectionGeneration else { return }
            // One provider page at a time; the broker coordinates quota across all agents/apps.
            musicProviderErrors = musicProviderErrors.filter { name, _ in sources.contains { $0.providerName == name } }
            let selected = sources.filter { provider == nil || $0.providerName == provider }
            for name in Set(selected.map(\.providerName)) { musicProviderErrors[name] = nil }
            for source in selected {
                do {
                var items: [MusicPlaylist] = [], cursor: String?, seen = Set<String>()
                repeat {
                    let page = try await cloud.musicPlaylists(source, cursor: cursor)
                    guard generation == connectionGeneration else { return }
                    items += page.playlists; cursor = page.next
                    if let cursor, !seen.insert(cursor).inserted { throw ClientError.http(502, "Playlist pagination did not finish") }
                    if items.count > 10000 { throw ClientError.http(413, "Too many playlists") }
                } while cursor != nil
                musicCatalog.playlists.removeAll { $0.sourceID == source.id }
                musicCatalog.playlists += items
                let retained = Set(musicCatalog.playlists.map(\.id))
                musicCatalog.snapshots = musicCatalog.snapshots.filter { retained.contains($0.key) }
                try store.saveMusicCatalog(musicCatalog); try await reload()
                guard generation == connectionGeneration else { return }
                } catch {
                    guard generation == connectionGeneration else { return }
                    if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled { return }
                    musicProviderErrors[source.providerName] = error.localizedDescription
                }
            }
            if provider == nil, musicProviderErrors.isEmpty { musicCatalog.fetchedAt = Date().timeIntervalSince1970 }
            try store.saveMusicCatalog(musicCatalog)
        } catch {
            if generation == connectionGeneration, !Task.isCancelled, !(error is CancellationError), (error as? URLError)?.code != .cancelled {
                if case ClientError.http(let status, _) = error, status == 401 || status == 403 {
                    musicCatalog = MusicCatalog(); musicCatalogLoaded = true; try? store.saveMusicCatalog(musicCatalog)
                    await spotifyStreaming.disconnect(); player.stop(); try? await reload()
                }
                guard generation == connectionGeneration else { return }
                musicError = error.localizedDescription
            }
        }
    }
    private var spotifyPrewarm: Task<Void, Never>?
    private func warmSpotifySession(_ source: MusicSource) {
        guard source.provider == "spotify", let cloud else { return }
        spotifyPrewarm?.cancel()
        let generation = connectionGeneration
        spotifyPrewarm = Task {
            guard let sources = try? await cloud.musicSources(), !Task.isCancelled,
                  generation == connectionGeneration,
                  sources.contains(where: { $0.id == source.id && $0.accountID == source.accountID }) else { return }
            await spotifyStreaming.warm(source, key: spotifyKey(source))
        }
    }
    private var soundCloudPrewarm: Task<Void, Never>?
    func warmVisibleMusicStreams(_ trackIDs: [String]) async {
        guard let cloud else { return }
        let snapshots = musicCatalog.snapshots.values.flatMap(\.tracks)
        var seen = Set<String>()
        let candidates = trackIDs.filter { seen.insert($0).inserted }.prefix(8).compactMap { id -> (MusicTrack, MusicSource)? in
            guard let track = snapshots.first(where: { $0.id == id && $0.available }),
                  let source = musicCatalog.sources.first(where: { $0.provider == "soundcloud" && id.hasPrefix("connected:" + $0.id + ":track:") }) else { return nil }
            return (track, source)
        }
        // Resolve only visible metadata, in pairs. Scrolling cancels the remaining
        // batches; the per-client cache shares any already-running resolution.
        for offset in stride(from: 0, to: candidates.count, by: 2) {
            guard !Task.isCancelled else { return }
            await withTaskGroup(of: Void.self) { group in
                for (track, source) in candidates[offset..<min(offset + 2, candidates.count)] {
                    group.addTask { _ = try? await cloud.musicStream(track, source: source) }
                }
            }
        }
    }
    private func warmSoundCloudStreams(_ tracks: [MusicTrack], source: MusicSource) {
        guard source.provider == "soundcloud", let cloud else { return }
        soundCloudPrewarm?.cancel()
        let upcoming = Array(tracks.filter { $0.available && $0.id.hasPrefix("connected:" + source.id + ":track:") }.prefix(2))
        // Metadata only: resolve signed URLs into the server's short-lived,
        // grant-bound cache. AVPlayer is created only after an actual play tap.
        soundCloudPrewarm = Task {
            await withTaskGroup(of: Void.self) { group in
                for track in upcoming {
                    guard !Task.isCancelled else { break }
                    group.addTask { _ = try? await cloud.musicStream(track, source: source) }
                }
            }
        }
    }
    func loadMusicPlaylist(_ item: MusicPlaylist, force: Bool = false) async {
        // Acquired recordings use the regular library player and analysis. They
        // do not need a streaming login or a connector request to open offline.
        if !force, musicIsDownloaded(item) { return }
        guard let cloud, let source = musicCatalog.sources.first(where: { $0.id == item.sourceID }), !musicPlaylistLoading.contains(item.id) else { return }
        warmSpotifySession(source)
        if !force, let cached = musicCatalog.snapshots[item.id], Date().timeIntervalSince1970 - cached.fetchedAt < 300 {
            warmSoundCloudStreams(cached.tracks, source: source)
            return
        }
        let generation = connectionGeneration
        musicPlaylistErrors[item.id] = nil
        musicPlaylistLoading.insert(item.id); defer { if generation == connectionGeneration { musicPlaylistLoading.remove(item.id) } }
        do {
            let value = try await cloud.musicPlaylist(item, source: source)
            guard generation == connectionGeneration else { return }
            musicCatalog.snapshots[item.id] = value
            try store.saveMusicCatalog(musicCatalog); try await reload()
            warmSoundCloudStreams(value.tracks, source: source)
        } catch { if generation == connectionGeneration, !Task.isCancelled { musicPlaylistErrors[item.id] = error.localizedDescription } }
    }
    func downloadMusic(_ item: MusicPlaylist) async {
        _ = await downloadMusicJob(item)
    }
    func downloadMusicJob(_ item: MusicPlaylist, requestID: String? = nil) async -> CloudImportJob? {
        guard let cloud, let source = musicCatalog.sources.first(where: { $0.id == item.sourceID }), !musicDownloads.contains(item.id) else { return nil }
        let generation = connectionGeneration
        let id = requestID ?? musicDownloadIDs[item.id] ?? UUID().uuidString
        musicDownloadIDs[item.id] = id
        musicDownloads.insert(item.id); defer { if generation == connectionGeneration { musicDownloads.remove(item.id) } }
        do {
            let job = try await cloud.downloadMusicPlaylist(item, source: source, id: id)
            guard generation == connectionGeneration else { return nil }
            importJobs.removeAll { $0.id == job.id }; importJobs.insert(job, at: 0)
            if musicCatalog.rememberDownloads(importJobs) { try store.saveMusicCatalog(musicCatalog) }
            try reloadCollections()
            if job.status == "complete" { await synchronize() }
            guard generation == connectionGeneration else { return nil }
            showImport = true; importError = nil
            return job
        } catch { if generation == connectionGeneration { message = error.localizedDescription } }
        return nil
    }
    var tracks: [Track] = [] {
        didSet { rebuildTrackIndex() }
    }
    private(set) var tracksByID: [String: Track] = [:]
    var collections: [Collection] = []
    var favorites: Set<String> = []
    var annotations: [String: TrackAnnotation] = [:]
    var offlineIDs: Set<String> = []
    var conflicts: [SyncConflict] = []
    var pendingCount = 0
    var browseMode: LibraryBrowseMode = .playlists
    var browseGroup: String?
    var query = "" { didSet { persistPlaybackSession() } }
    var selectedCollection: String? { didSet { persistPlaybackSession() } }
    var filter = "All music" { didSet { persistPlaybackSession() } }
    var showPlaylistBrowser = false { didSet { persistPlaybackSession() } }
    var playlistFolderPath: [String] = [] { didSet { persistPlaybackSession() } }
    var playlistSort = "title" { didSet { persistPlaybackSession() } }
    var playlistSortAscending = true { didSet { persistPlaybackSession() } }
    var trackSort = "default" { didSet { persistPlaybackSession() } }
    var trackSortAscending = true { didSet { persistPlaybackSession() } }
    var preferredCollectionID: String? { didSet { persistPlaybackSession() } }
    var pendingQuickAddTrackID: String?
    private var quickAddReturnSession: PlaybackSession?
    var pendingPlaylistRemoval: PlaylistRemovalRequest?
    private var playlistRemovalHistory: [PlaylistRemovalUndo] = []
    var undoablePlaylistRemoval: PlaylistRemovalUndo? { playlistRemovalHistory.last }
    var message: String?
    var syncStatus = "Saved on this device"
    var loading = false
    var usbDevice: USBDeviceAccess?
    var usbConnected = false
    var usbReading = false
    var usbError: String?
    private var usbSignature: String?
    private var checkingUSB = false
    private var loadingUSBWaveforms: Set<String> = []
    private var unavailableUSBWaveforms: Set<String> = []
    private let usbAnalysisReader = USBAnalysisReader()
    var syncing = false
    var downloading: Set<String> = []
    var workstationConnected = false
    var workstationTracks: [String: Track] = [:]
    #if os(iOS)
    var djLink = DJLinkConnection()
    var showDJLink = false
    #endif
    var showSettings = false
    var showImport = false
    var importJobs: [CloudImportJob] = []
    var importError: String?
    var importRefreshError: String?
    var submittingImport = false
    var crews: [CrewSummary] = []
    var crewDetails: [String: CrewDetail] = [:]
    var crewCrates: [String: CrewCrateDetail] = [:] { didSet { rebuildTrackIndex() } }
    private func rebuildTrackIndex() {
        var index = Dictionary(tracks.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for detail in crewCrates.values {
            for item in detail.items {
                if var track = item.track { track.id = "crew:" + item.id; index[track.id] = track }
            }
        }
        tracksByID = index
    }
    private var playbackTracks: [Track] {
        let personalIDs = Set(tracks.map(\.id))
        return tracks + tracksByID.values.filter { !personalIDs.contains($0.id) }.sorted { $0.id < $1.id }
    }
    private var crewAudioCache: Task<Void, Never>?
    private var crewLoadRequests: [String: UUID] = [:]
    var crewsLoading = false
    var crewError: String?
    var pendingCrewInvite: CrewInviteLink?
    var crewInviteEndpoint: URL { (try? Endpoint(cloudURL))?.url ?? URL(string: CrewInviteLink.productionURL)! }
    func receiveCrewInvite(_ value: String) {
        guard let invite = CrewInviteLink(value, endpoint: crewInviteEndpoint) else {
            message = "This isn’t a valid invite for your DJ Booth server. Ask for a new link."
            return
        }
        showAgent = false
        pendingCrewInvite = invite
    }
    var newSharedFolderPresented = false
    var joinSharedFolderPresented = false
    var crewMembersPresented = false
    var newCrewPlaylistPresented = false
    var selectedCrewID: String?
    var selectedCrewCrateID: String?
    private var refreshingImports = false
    var canImportToCloud: Bool { cloud != nil && !demo }
    private var pendingImportKey: String { "pendingImport:" + cloudStorageScope }
    private var cloudStorageScope: String { guard let endpoint = try? Endpoint(cloudURL), let cloudAccountID else { return "local" }; return endpoint.accountScope(cloudAccountID) }
    var pendingImportSource: String { UserDefaults.standard.dictionary(forKey: pendingImportKey)?["source"] as? String ?? "" }
    var showNewCollection = false
    var player = BoothPlayer()
    #if os(iOS)
    let sonos = SonosPlayback()
    var showSonosSettings = false
    func testSonosLocalMedia(_ enabled: Bool) async throws {
        if enabled, let track = player.track { _ = try await offlineAudio(track) }
        try await sonos.setLocalMediaTest(enabled, audio: audio)
    }
    func reconnectSonos() async {
        guard !demo, let cloud else { return }
        let generation = connectionGeneration
        while !Task.isCancelled, generation == connectionGeneration {
            if await sonos.reconnect(cloud: cloud, tracks: tracksByID, player: player) {
                if sonos.enabled && !sonos.grouped { await setSonosEnabled(true) }
                return
            }
            do { try await Task.sleep(for: .seconds(5)) } catch { return }
        }
    }
    func setSonosEnabled(_ enabled: Bool) async {
        guard !sonos.routing else { return }
        sonos.routing = true
        defer { sonos.routing = false }
        if !enabled {
            await useSonos(nil)
            return
        }
        do {
            let room = try await sonos.connectAllRooms()
            await useSonos(room)
        } catch {
            sonos.error = error.localizedDescription
            sonos.rememberEnabled(sonos.room != nil)
        }
    }
    func useSonos(_ room: SonosRoom?, reload: Bool = false) async {
        if room == nil { await sonos.disableGroup() }
        guard reload || sonos.room?.id != room?.id else { return }
        let track = player.track, queue = player.queue, elapsed = player.elapsed, playing = player.transportPlaying
        await sonos.disconnect()
        sonos.room = room
        guard let track else { return }
        await preparePlayback(track, queue: queue, elapsed: elapsed, queueIndex: player.queueIndex, autoplay: playing)
    }
    #endif
    var showAgent = false
    var agentMessages: [MusicAgentMessage] = []
    var agentDraft = ""
    var agentHistoryLoading = false
    var agentHistoryError: String?
    var agentHistoryNeedsConsent = false
    var agentNextBefore: String?
    private var agentID: String?
    var agentPendingID: String?
    var agentError: String?
    var agentRetry = 0
    var phoneToolsReady = false
    var phoneToolsError: String?
    private let phoneToolHost = PhoneToolHost()
    private var phoneToolsRunID = UUID()
    var accountConnectionID = UUID()
    var needsMobileSignIn: Bool { !demo && cloud == nil }
    var hasCloudSession: Bool { cloud != nil }
    private var agentPendingInput: String?
    var cloudCapabilities: [String] = []
    func refreshCloudAccount() async {
        guard let cloud else { return }
        let generation = connectionGeneration
        do {
            let account = try await cloud.account()
            guard generation == connectionGeneration else { return }
            cloudCapabilities = account.capabilities
        } catch { if generation == connectionGeneration { message = error.localizedDescription } }
    }
    func refreshCrews() async {
        guard let cloud, !crewsLoading else { return }
        let generation = connectionGeneration
        crewsLoading = true; defer { if generation == connectionGeneration { crewsLoading = false } }
        do {
            let value = try await cloud.crews()
            guard generation == connectionGeneration else { return }
            crews = value; crewError = nil; persistCrewCache()
        } catch {
            if generation == connectionGeneration, !(error is CancellationError) { crewError = error.localizedDescription }
        }
    }
    func observeCrewUpdates(_ crewID: String?) async {
        guard let cloud else { return }
        let generation = connectionGeneration
        var retry = 1.0
        while !Task.isCancelled, generation == connectionGeneration {
            do {
                try await cloud.observeCrew(crewID) { [weak self] in
                    await self?.reloadLiveCrew(crewID, generation: generation)
                }
            } catch {
                if Task.isCancelled || generation != connectionGeneration { return }
            }
            do { try await Task.sleep(for: .seconds(retry)) } catch { return }
            retry = min(retry * 2, 15)
        }
    }
    private func reloadLiveCrew(_ crewID: String?, generation: UUID) async {
        guard generation == connectionGeneration, !Task.isCancelled else { return }
        guard let crewID else { await refreshCrews(); return }
        await loadCrew(crewID)
        var crateIDs = Set(crewCrates.values.filter { $0.crate.crewID == crewID }.map { $0.crate.id })
        if selectedCrewID == crewID, let selectedCrewCrateID { crateIDs.insert(selectedCrewCrateID) }
        for crateID in crateIDs {
            guard generation == connectionGeneration, !Task.isCancelled else { return }
            await loadCrewCrate(crewID: crewID, crateID: crateID)
        }
        await refreshCrews()
    }
    func createCrew(_ name: String, displayName: String) async throws -> String {
        guard let cloud else { throw ClientError.http(401, "Connect DJ Booth first") }
        let crew = try await cloud.createCrew(name: name, displayName: displayName)
        crews.removeAll { $0.id == crew.id }; crews.insert(crew, at: 0)
        crewDetails[crew.id] = try await cloud.crew(crew.id)
        persistCrewCache()
        return crew.id
    }
    func acceptCrewInvite(_ value: String, displayName: String = "DJ") async throws -> String {
        guard let cloud else { throw ClientError.http(401, "Connect DJ Booth first") }
        guard let invite = CrewInviteLink(value, endpoint: crewInviteEndpoint) else { throw ClientError.http(400, "Invalid crew invite") }
        let generation = connectionGeneration
        let detail = try await cloud.acceptCrewInvite(token: invite.token, displayName: displayName)
        guard generation == connectionGeneration else { throw CancellationError() }
        crewDetails[detail.crew.id] = detail
        persistCrewCache()
        await refreshCrews()
        return detail.crew.id
    }
    func loadCrew(_ id: String) async {
        guard let cloud else { return }
        let generation = connectionGeneration, request = UUID()
        crewLoadRequests[id] = request
        do {
            let detail = try await cloud.crew(id)
            guard generation == connectionGeneration, crewLoadRequests[id] == request else { return }
            crewDetails[id] = detail; crewError = nil; persistCrewCache()
        } catch { if generation == connectionGeneration, crewLoadRequests[id] == request, !(error is CancellationError) { crewError = error.localizedDescription } }
    }
    func createCrewCrate(crewID: String, name: String) async throws {
        guard let cloud else { throw ClientError.http(401, "Connect DJ Booth first") }
        _ = try await cloud.createCrewCrate(crewID: crewID, name: name)
        crewDetails[crewID] = try await cloud.crew(crewID)
        persistCrewCache()
        await refreshCrews()
    }
    func loadCrewCrate(crewID: String, crateID: String) async {
        guard let cloud else { return }
        let generation = connectionGeneration, request = UUID()
        crewLoadRequests[crateID] = request
        do {
            let detail = try await cloud.crewCrate(crewID: crewID, crateID: crateID)
            guard generation == connectionGeneration, crewLoadRequests[crateID] == request else { return }
            crewCrates[crateID] = detail; crewError = nil; persistCrewCache(); cacheSharedAudio()
        } catch { if generation == connectionGeneration, crewLoadRequests[crateID] == request, !(error is CancellationError) { crewError = error.localizedDescription } }
    }
    func addToCrew(_ track: Track, crewID: String, crateID: String) async throws {
        guard let cloud else { throw ClientError.http(401, "Connect DJ Booth first") }
        guard track.mediaHash != nil else { throw ClientError.http(409, "Finish uploading this track to your cloud library before sharing it.") }
        crewCrates[crateID] = try await cloud.addCrewTrack(crewID: crewID, crateID: crateID, track: track)
        persistCrewCache(); cacheSharedAudio()
        await loadCrew(crewID)
    }
    func removeFromCrew(crewID: String, crateID: String, itemID: String) async throws {
        guard let cloud else { throw ClientError.http(401, "Connect DJ Booth first") }
        try await cloud.removeCrewTrack(crewID: crewID, crateID: crateID, itemID: itemID)
        crewCrates[crateID]?.items.removeAll { $0.id == itemID }
        persistCrewCache()
        await loadCrew(crewID)
    }
    func moveCrewItem(crewID: String, crateID: String, itemID: String, afterItemID: String?) async throws {
        #if DEBUG
        if demo, ProcessInfo.processInfo.arguments.contains("--ui-test-crews") {
            persistCrewCache(); return
        }
        #endif
        guard let cloud else { throw ClientError.http(401, "Connect DJ Booth first") }
        crewCrates[crateID] = try await cloud.moveCrewTrack(crewID: crewID, crateID: crateID, itemID: itemID, afterItemID: afterItemID)
        persistCrewCache()
    }
    func inviteToCrew(_ crewID: String) async throws -> CrewInvite {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--ui-test-library"), ProcessInfo.processInfo.arguments.contains("--ui-test-crews") {
            return try JSONDecoder().decode(CrewInvite.self, from: Data("{\"token\":\"\(String(repeating: "a", count: 43))\",\"role\":\"dj\",\"expiresAt\":2000000000}".utf8))
        }
        #endif
        guard let cloud else { throw ClientError.http(401, "Connect DJ Booth first") }
        return try await cloud.createCrewInvite(crewID: crewID)
    }
    func localTrack(for item: CrewCrateItem) -> Track? {
        tracksByID["crew:" + item.id] ?? tracksByID[item.localTrackID ?? item.recordingID]
            ?? tracks.first { item.assetHash != nil && $0.mediaHash == item.assetHash }
    }
    func openCrewFolder(_ crewID: String) {
        openPlaylistFolder([])
        selectedCrewID = crewID
        selectedCrewCrateID = nil
    }
    func openCrewPlaylist(crewID: String, crateID: String) {
        openCrewFolder(crewID)
        selectedCrewCrateID = crateID
    }
    func addPendingTrack(crewID: String, crateID: String) async throws {
        guard let trackID = pendingQuickAddTrackID, let track = tracksByID[trackID] else { return }
        try await addToCrew(track, crewID: crewID, crateID: crateID)
        finishQuickAdd(preferredID: nil)
    }
    private func persistCrewCache() {
        try? store.saveCrewCache(CrewCache(crews: crews, details: crewDetails, crates: crewCrates))
    }
    @discardableResult func persistAgentConversation() -> Bool {
        do {
            try store.saveAgentConversation(MusicAgentConversation(messages: agentMessages, draft: agentDraft, pendingID: agentPendingID, pendingInput: agentPendingInput, agentID: agentID, nextBefore: agentNextBefore))
            return true
        } catch { agentError = "Couldn’t save your conversation: \(error.localizedDescription)"; return false }
    }
    private func restoreAgentConversation() {
        do {
            let saved = try store.agentConversation()
            agentID = saved.agentID; agentNextBefore = saved.nextBefore
            agentMessages = saved.messages; agentDraft = saved.draft
            agentPendingID = saved.pendingID; agentPendingInput = saved.pendingInput
        } catch { agentError = "Couldn’t load your conversation: \(error.localizedDescription)" }
    }
    #if DEBUG
    var agentDiagnosticState: [String: Any] {
        ["phoneReady": phoneToolsReady, "phoneError": phoneToolsError ?? "", "agentError": agentError ?? "",
         "historyError": agentHistoryError ?? "", "historyNeedsConsent": agentHistoryNeedsConsent,
         "agentID": agentID ?? "", "pendingID": agentPendingID ?? "",
         "pendingSubmission": agentPendingInput != nil, "messages": agentMessages.count]
    }
    #endif
    func loadAgentHistory(earlier: Bool = false) async {
        guard let cloud, !agentHistoryLoading else { return }
        let generation = connectionGeneration
        let initialCursor = earlier ? agentNextBefore : nil
        if earlier && initialCursor == nil { return }
        agentHistoryLoading = true; agentHistoryError = nil; agentHistoryNeedsConsent = false
        defer { if generation == connectionGeneration { agentHistoryLoading = false } }
        do {
            var cursor = initialCursor
            // Skip pages containing only internal events, keeping a continuation
            // after a bounded batch so a large history cannot monopolize the UI.
            for _ in 0..<8 {
                let page = try await cloud.agentHistory(before: cursor)
                guard !Task.isCancelled, generation == connectionGeneration else { return }
                if let agentID, agentID != page.agentID {
                    agentMessages = []; agentPendingID = nil; agentPendingInput = nil
                    agentDraft = ""; agentNextBefore = nil
                }
                agentID = page.agentID
                agentMessages = page.merging(agentMessages)
                if earlier || initialCursor == nil { agentNextBefore = page.nextBefore }
                persistAgentConversation()
                guard page.messages.isEmpty, let next = page.nextBefore, next != cursor else { break }
                cursor = next
            }
        } catch {
            guard !Task.isCancelled, generation == connectionGeneration else { return }
            agentHistoryError = error.localizedDescription
            if case ClientError.http(403, _) = error { agentHistoryNeedsConsent = true }
        }
    }
    @discardableResult func beginAgentTurn(_ input: String) -> Bool {
        guard cloud != nil, agentPendingID == nil else { return false }
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= 16000 else { return false }
        let previousDraft = agentDraft
        let id = UUID().uuidString
        agentMessages.append(MusicAgentMessage(id: "user:\(id)", role: "You", text: text))
        agentPendingInput = text; agentPendingID = id
        agentDraft = ""; agentError = nil
        guard persistAgentConversation() else {
            agentMessages.removeLast(); agentPendingID = nil; agentPendingInput = nil; agentDraft = previousDraft
            return false
        }
        return true
    }
    func observeAgentTurn() async {
        guard let cloud, var id = agentPendingID else { return }
        let generation = connectionGeneration
        do {
            var turn = try await cloud.agentTurn(id: id, input: agentPendingInput)
            guard !Task.isCancelled, generation == connectionGeneration, agentPendingID == id else { return }
            var accepted = MusicAgentConversation(messages: agentMessages, pendingID: id, pendingInput: agentPendingInput)
            accepted.acceptTurn(turn.id)
            agentMessages = accepted.messages; agentPendingInput = accepted.pendingInput
            id = turn.id; agentPendingID = id; agentError = nil
            persistAgentConversation()
            while !Task.isCancelled {
                guard generation == connectionGeneration, agentPendingID == id else { return }
                if turn.status == "completed" {
                    let replyID = "assistant:\(id)"
                    if !agentMessages.contains(where: { $0.id == replyID }) {
                        agentMessages.append(MusicAgentMessage(id: replyID, role: "DJ Booth", text: turn.finalMessage ?? "No reply was shared by this connection."))
                    }
                    agentPendingID = nil; agentError = nil; persistAgentConversation(); return
                }
                if turn.status == "failed" || turn.status == "cancelled" {
                    agentError = turn.status == "cancelled" ? nil : (turn.error ?? "Your agent stopped.")
                    if !agentMessages.contains(where: { $0.id == "status:\(id)" }) {
                        agentMessages.append(MusicAgentMessage(id: "status:\(id)", role: "Status", text: agentError ?? "Stopped. Send a message whenever you’re ready to continue."))
                    }
                    agentPendingID = nil; persistAgentConversation(); return
                }
                try await Task.sleep(for: .seconds(1))
                turn = try await cloud.agentTurn(id: id)
            }
        } catch {
            guard !Task.isCancelled, generation == connectionGeneration, agentPendingID == id else { return }
            #if os(iOS)
            var fields = AppDiagnostics.failureFields(error)
            fields["turnID"] = id; fields["pending_submission"] = String(agentPendingInput != nil)
            AppDiagnostics.shared.event("agent_turn_failed", fields)
            #endif
            if case ClientError.http(404, _) = error, agentPendingInput == nil {
                // A missing accepted turn must not permanently disable the
                // composer. Reconcile history first; never replay its actions.
                do {
                    let page = try await cloud.agentHistory()
                    guard !Task.isCancelled, generation == connectionGeneration, agentPendingID == id else { return }
                    // Never reconcile a cached request against another thread.
                    guard agentID == nil || agentID == page.agentID else {
                        await loadAgentHistory()
                        return
                    }
                    agentID = page.agentID
                    var recovered = MusicAgentConversation(messages: page.merging(agentMessages), pendingID: id)
                    if recovered.recoverMissingTurn(id) {
                        agentMessages = recovered.messages; agentPendingID = nil; agentError = nil
                        persistAgentConversation()
                        #if os(iOS)
                        AppDiagnostics.shared.event("agent_missing_turn_recovered", ["turnID": id])
                        #endif
                        return
                    }
                } catch {
                    guard !Task.isCancelled, generation == connectionGeneration, agentPendingID == id else { return }
                    agentHistoryError = error.localizedDescription
                }
            }
            agentError = error.localizedDescription
        }
    }
    func cancelAgentTurn() async {
        guard let cloud, let id = agentPendingID else { return }
        let generation = connectionGeneration
        do {
            _ = try await cloud.agentTurn(id: id, cancel: true)
            guard generation == connectionGeneration, agentPendingID == id else { return }
            agentPendingInput = nil; agentError = nil; agentRetry += 1
            persistAgentConversation()
        } catch { if generation == connectionGeneration { agentError = error.localizedDescription } }
    }
    private func clearAgent() {
        persistAgentConversation()
        for task in phoneActions.values { task.cancel() }
        phoneActions.removeAll()
        stopPhoneTools(); phoneToolsError = nil
        accountConnectionID = UUID()
        agentID = nil; agentNextBefore = nil; agentHistoryLoading = false; agentHistoryError = nil; agentHistoryNeedsConsent = false
        showAgent = false; agentMessages = []; agentDraft = ""; agentPendingID = nil; agentPendingInput = nil; agentError = nil; cloudCapabilities = []
    }
    var phoneActions: [String: Task<Void, Never>] = [:]
    func servePhoneTools() async {
        guard let cloud else { return }
        let generation = connectionGeneration
        let runID = UUID(); phoneToolsRunID = runID
        await phoneToolHost.run(client: cloud, status: { [weak self] ready, error in
            guard let self, self.connectionGeneration == generation, self.phoneToolsRunID == runID else { return }
            #if os(iOS)
            if self.phoneToolsReady != ready || self.phoneToolsError != error {
                AppDiagnostics.shared.event("agent_phone_connection", ["ready": String(ready), "has_error": String(error != nil), "connectionID": runID.uuidString])
            }
            #endif
            self.phoneToolsReady = ready
            self.phoneToolsError = error
        }, diagnostics: { [weak self] error, attempt in
            guard let self, self.connectionGeneration == generation, self.phoneToolsRunID == runID else { return }
            #if os(iOS)
            var fields = AppDiagnostics.failureFields(error)
            fields["attempt"] = String(attempt); fields["connectionID"] = runID.uuidString
            AppDiagnostics.shared.event("agent_phone_connection_failed", fields)
            #endif
        }, query: { [weak self] arguments, budget in
            guard let self, self.connectionGeneration == generation, self.phoneToolsRunID == runID, self.cloud != nil else {
                throw ClientError.http(401, "This phone is no longer connected to that account")
            }
            let reply = PhoneMCPServer.handle(arguments) { name, input in
                try self.mcpCall(name, arguments: input, budget: budget)
            }
            return String(decoding: try JSONSerialization.data(withJSONObject: reply, options: [.sortedKeys]), as: UTF8.self)
        })
        if connectionGeneration == generation, phoneToolsRunID == runID { phoneToolsReady = false }
    }
    func stopPhoneTools() { phoneToolsRunID = UUID(); phoneToolHost.stop(); phoneToolsReady = false }
    func phoneLibraryQuery() -> PhoneLibraryQuery {
        var library = PhoneLibraryQuery()
        library.tracks = tracks; library.collections = collections; library.favorites = favorites
        library.offlineIDs = offlineIDs; library.annotations = annotations; library.downloading = downloading
        library.queue = player.queue; library.imports = importJobs
        library.conflicts = conflicts.map { ["id": $0.id, "kind": $0.kind.rawValue, "entityID": $0.entityID] }
        library.state = [
            "trackCount": tracks.count, "playlistCount": collections.count, "favoriteCount": favorites.count,
            "offlineTrackCount": offlineIDs.count, "downloadCount": downloading.count,
            "pendingSyncChanges": pendingCount, "conflictCount": conflicts.count, "syncing": syncing,
            "syncStatus": syncStatus, "search": query, "filter": filter,
            "browseMode": browseMode.rawValue, "browseGroup": browseGroup ?? "",
            "screen": showPlaylistBrowser ? "playlists" : "tracks", "playlistFolderPath": playlistFolderPath,
            "selectedPlaylistID": selectedCollection ?? "", "visibleTrackCount": visibleTracks.count,
            "playback": ["trackID": player.track?.id ?? "", "title": player.track?.title ?? "",
                         "playing": player.playing, "elapsedSeconds": player.elapsed, "durationSeconds": player.duration,
                         "queueIndex": player.queueIndex, "queueCount": player.queue.count],
            "activeImports": importJobs.filter(\.isActive).count, "usbConnected": usbConnected,
            "connectedMusicProviders": cloudCapabilities.filter { ["spotify", "soundcloud"].contains($0) }
        ]
        return library
    }
    var cloudAccountID: String?
    let playbackWaveformCache = PlaybackWaveformCache()
    private(set) var initialWaveformColumns: [String: AnalysisWaveformColumns] = [:]
    var cloudURL: String
    var workstationURL: String
    let demo: Bool
    private(set) var store: LibraryStore
    private(set) var audio: AudioFiles
    private let syncEngine = SyncEngine()
    private let snapshotDecoder: LibrarySnapshotDecoder
    private var reloadRequest = UUID()
    private var deferredWaveforms = true
    private var deferredWaveformRequests: Set<String> = []
    private var bootstrap: Bootstrap?
    private var bootstrapEndpoint: String?
    private var cloud: CloudClient?
    private let root: URL
    private var refreshRunning = false
    private var connectionGeneration = UUID()
    private var playbackRequest = UUID()
    private var playbackPreferences: PlaybackSessionPreferences?
    private var playbackSessionReady = false
    private var navigationChanged = false
    private var restoredSavedPlaybackSession = false
    private var lastSessionSave = Date.distantPast
    private var queueCollection: String?
    private var queueFilter = "All music"
    var cdjDownloadStatus: String?
    private var cdjDownloads: Task<Void, Never>?
    private var audioDownloads: [String: Task<(URL, String), Error>] = [:]
    private var exportingCollection = false
    #if DEBUG
    private var pendingOfflineTrackID: String?
    private var offlineCollectionID: String?
    private var offlineCollectionSelected = false
    private var offlineLaunchRequestKey: String?
    private var offlineLaunchActionRunning = false
    #endif
    var workstation: WorkstationClient? {
        guard cloudAccountID == nil || UserDefaults.standard.string(forKey: "workstationAllowed:" + cloudStorageScope) == workstationURL else { return nil }
        guard let endpoint = try? Endpoint(workstationURL, loopbackOnly: true) else { return nil }
        return WorkstationClient(endpoint: endpoint, session: PerformanceProbe.serverUnavailableSession)
    }

    /// Start disk work synchronously from App.init, before SwiftUI owns the main thread.
    static func startLoading() -> Task<BoothModel, Error> {
        do {
            let configuration = try BoothLaunchConfiguration()
            let decoder = LibrarySnapshotDecoder()
            let preparation = Task.detached(priority: .userInitiated) {
                let prepared = try LibraryStore.prepare(directory: configuration.directory, inMemory: configuration.inMemory)
                let snapshot = try await decoder.decode(prepared.payloads, audioDirectory: configuration.audioDirectory, metadataOnly: true)
                return (prepared, snapshot)
            }
            return Task {
                let (prepared, snapshot) = try await withTaskCancellationHandler { try await preparation.value } onCancel: { preparation.cancel() }
                try Task.checkCancellation()
                PerformanceProbe.event("model_init_begin")
                return try await BoothModel(configuration: configuration, prepared: prepared, snapshot: snapshot, decoder: decoder)
            }
        } catch { return Task { throw error } }
    }
    private init(configuration: BoothLaunchConfiguration, prepared: LibraryStore.Prepared, snapshot: LibrarySnapshot, decoder: LibrarySnapshotDecoder) async throws {
        PerformanceProbe.libraryBegan()
        demo = configuration.demo; root = configuration.root; cloudURL = configuration.cloudURL
        snapshotDecoder = decoder
        let uiTestID = configuration.uiTestID, scope = configuration.scope
        workstationURL = demo ? "http://127.0.0.1:4179" : (UserDefaults.standard.string(forKey: "workstationURL") ?? "http://127.0.0.1:4179")
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "--keep-offline"), arguments.indices.contains(index + 1),
           !arguments[index + 1].isEmpty, !arguments[index + 1].hasPrefix("--") {
            pendingOfflineTrackID = arguments[index + 1]
        }
        if let index = arguments.firstIndex(of: "--keep-offline-collection"), arguments.indices.contains(index + 1),
           !arguments[index + 1].isEmpty, !arguments[index + 1].hasPrefix("--") {
            offlineCollectionID = arguments[index + 1]
        }
        if !demo, !arguments.contains("--keep-offline"), !arguments.contains("--keep-offline-collection"),
           let id = Bundle.main.object(forInfoDictionaryKey: "DJBoothOfflineCollection") as? String,
           !id.isEmpty, !id.hasPrefix("$(") {
            offlineCollectionID = id
        }
        #endif
        // Connection changes never mix cursors, outboxes, or libraries from different servers.
        cloudAccountID = configuration.accountID
        let libraryStore = try LibraryStore(prepared: prepared)
        let crewCache = try libraryStore.crewCache()
        store = libraryStore
        crews = crewCache.crews; crewDetails = crewCache.details; crewCrates = crewCache.crates
        PerformanceProbe.event("library_store_ready")
        audio = try AudioFiles(directory: configuration.audioDirectory, session: PerformanceProbe.serverUnavailableSession)
        playbackPreferences = PlaybackSessionPreferences(scope: demo ? "demo-\(uiTestID?.uuidString ?? UUID().uuidString)" : scope)
        #if os(iOS)
        sonos.configure(playbackPreferences)
        #endif
        #if DEBUG
        if !demo {
            let key = "djbooth.debug.offline.\(scope)"
            offlineLaunchRequestKey = key
            let collectionKey = "\(key).collection"
            if let id = offlineCollectionID {
                UserDefaults.standard.set(id, forKey: collectionKey)
                pendingOfflineTrackID = nil
                UserDefaults.standard.removeObject(forKey: key)
            } else if pendingOfflineTrackID != nil {
                UserDefaults.standard.removeObject(forKey: collectionKey)
            } else {
                offlineCollectionID = UserDefaults.standard.string(forKey: collectionKey)
            }
            if let id = pendingOfflineTrackID { UserDefaults.standard.set(id, forKey: key) }
            else { pendingOfflineTrackID = UserDefaults.standard.string(forKey: key) }
        }
        #endif
        if !demo, !cloudURL.isEmpty, let endpoint = try? Endpoint(cloudURL) {
            do {
                if configuration.accountID != nil, let token = try Keychain.read(scope) {
                    cloud = CloudClient(endpoint: endpoint, token: token, session: PerformanceProbe.serverUnavailableSession)
                }
            } catch {
                syncStatus = "Cloud sync needs attention"
                message = "Your local library is available. Cloud sync could not access its saved credentials: \(error.localizedDescription)"
            }
        }
        PerformanceProbe.event("library_credentials_ready")
        if demo, try store.values(.track, as: Track.self).isEmpty {
            try store.ingest(DemoLibrary.tracks)
            for collection in DemoLibrary.collections { try store.save(collection, kind: .collection, id: collection.id) }
            try store.toggleFavorite(DemoLibrary.tracks[0].id)
            #if DEBUG
            if uiTestID != nil, arguments.contains("--ui-test-long-playlist") {
                try store.ingest(DemoLibrary.longPlaylistTracks)
                let collection = DemoLibrary.longPlaylist
                try store.save(collection, kind: .collection, id: collection.id)
            }
            #endif
        }
        #if DEBUG
        if uiTestID != nil, arguments.contains("--ui-test-crews") {
            let role = arguments.contains("--ui-test-crew-viewer") ? "viewer" : "owner"
            let contributors = arguments.contains("--ui-test-crew-contributors")
            let items = contributors ? """
            [{"id":"item-georgios","crateID":"crate-demo","recordingID":"demo-5","title":"A Walk","artist":"Tycho",
              "sortKey":1024,"addedBy":"georgios","createdAt":"now","updatedAt":"now"},
             {"id":"item-alex","crateID":"crate-demo","recordingID":"missing-edit","title":"Unreleased edit","artist":"Alex Rivera",
              "sortKey":2048,"addedBy":"alex","createdAt":"now","updatedAt":"now"},
             {"id":"item-unknown","crateID":"crate-demo","recordingID":"missing-recording","title":"Late night find",
              "sortKey":3072,"addedBy":"unavailable-account","createdAt":"now","updatedAt":"now"}]
            """ : "[]"
            let itemCount = contributors ? 3 : 0
            let fixture = """
            {"crews":[{"id":"crew-demo","name":"No Static","role":"\(role)","memberCount":2,"crateCount":1}],
             "details":{"crew-demo":{"crew":{"id":"crew-demo","name":"No Static","role":"\(role)"},
               "members":[{"accountID":"georgios","displayName":"\(contributors ? "Georgios Konstantopoulos" : "Georgios")","role":"owner","joinedAt":"now"},
                          {"accountID":"alex","displayName":"\(contributors ? "Alex Rivera" : "Alex")","role":"dj","joinedAt":"now"}],
               "crates":[{"id":"crate-demo","crewID":"crew-demo","name":"Friday Warmup","itemCount":\(itemCount)}]}},
             "crates":{"crate-demo":{"crate":{"id":"crate-demo","crewID":"crew-demo","name":"Friday Warmup","itemCount":\(itemCount)},"items":\(items)}}}
            """
            let cache = try JSONDecoder().decode(CrewCache.self, from: Data(fixture.utf8))
            crews = cache.crews; crewDetails = cache.details; crewCrates = cache.crates
            if contributors {
                var shared = DemoLibrary.tracks[4]
                shared.id = "someone-elses-track"; shared.mediaHash = String(repeating: "a", count: 64)
                shared.mediaExtension = "mp3"; shared.analyzed = true
                crewCrates["crate-demo"]?.items[1].track = shared
            }
            persistCrewCache()
        }
        #endif
        usbDevice = try store.usbDevice()
        if snapshot.revision == store.revision {
            try applyLibrarySnapshot(snapshot, metadataOnly: true)
        } else {
            // A new demo library may have been seeded after preparation.
            try await reload(metadataOnly: true)
        }
        player.onStateChange = { [weak self] force in
            guard let self else { return }
            self.persistPlaybackSession(force: force)
            #if os(iOS)
            self.djLink.audioPlaybackChanged(self.player.playing)
            #endif
        }
        player.onResumeRequested = { [weak self] in Task { await self?.togglePlayback() } }
        player.onPauseRequested = { [weak self] in self?.playbackRequest = UUID() }
        #if DEBUG
        if demo, arguments.contains("--ui-test-session"), playbackPreferences?.load() == nil,
           let collection = collections.first, collection.trackIDs.count > 1 {
            playbackPreferences?.save(PlaybackSession(trackID: collection.trackIDs[1], queueIDs: collection.trackIDs, elapsed: 45,
                                                      selectedCollection: collection.id, queueCollection: collection.id))
        }
        #endif
        restorePlaybackSession()
        restoreAgentConversation()
        #if DEBUG && os(iOS)
        // Recording-only synthetic data; MusicAgentView and the SDK own the UI.
        // No account, remote agent, music service, or playback is exercised.
        if demo, arguments.contains("--ui-test-sdk-recording"), agentMessages.isEmpty {
            agentMessages = [MusicAgentMessage(id: "fixture-boundary", role: "Status",
                text: "RESEARCH FIXTURE · Synthetic conversation · No connected account")]
            let selections = ["Start with space", "Keep the groove light", "Build the rhythm", "Open the room", "Hold the mood", "Leave room for the next DJ"]
            for (index, selection) in selections.enumerated() {
                agentMessages.append(MusicAgentMessage(id: "fixture-user-\(index)", role: "You",
                    text: "\(selection). What would you suggest for this part of the set?"))
                agentMessages.append(MusicAgentMessage(id: "fixture-booth-\(index)", role: "DJ Booth",
                    text: "**\(selection)**\n\nTry a warm, spacious selection and let the percussion lead. Keep the transition unhurried, with a little room between phrases.\n\nThis is sample conversation text for the native SDK recording."))
            }
            agentMessages.append(MusicAgentMessage(id: "fixture-last", role: "Status",
                text: "End of sample conversation · Draft a follow-up below"))
            persistAgentConversation()
        }
        if demo, arguments.contains("--ui-test-sdk-recording") { showAgent = true }
        #endif
        #if DEBUG
        if !demo, let token = ProcessInfo.processInfo.environment["DJBOOTH_SYNC_TOKEN"], !token.isEmpty {
            // Development bootstrap still goes through issuer verification and
            // account-scoped storage, exactly like the interactive login.
            do { try await configureCloud(url: cloudURL, token: token) }
            catch { message = error.localizedDescription }
        }
        #endif
        PerformanceProbe.event("library_session_restored")
        #if DEBUG
        if demo, arguments.contains("--ui-test-player"), let track = tracks.first(where: { $0.id == "demo-5" }) {
            player.prepare(track, url: nil, queue: tracks)
        }
        #endif
        #if DEBUG && os(iOS)
        if demo, arguments.contains("--ui-test-decks") { try djLink.installPreviewDecks() }
        #endif
        try await prepareInitialWaveforms()
        PerformanceProbe.libraryReady(trackCount: tracks.count)
    }
    private func prepareInitialWaveforms() async throws {
        // A screen-height upper bound covers the first viewport at every text size.
        // Playlist/artist/album indexes have no track waveforms to prepare.
        #if os(iOS)
        let rowLimit = Int(ceil(UIScreen.main.bounds.height / 58))
        let showsTracks = !showPlaylistBrowser && (selectedCollection != nil || browseMode == .tracks || browseGroup != nil)
        #else
        let rowLimit = 24
        let showsTracks = !showPlaylistBrowser
        #endif
        let rows = showsTracks ? Array(visibleTracks.prefix(rowLimit)) : []
        var needed = Set(rows.map(\.id))
        if let id = player.track?.id { needed.insert(id) }
        try await reload(metadataOnly: true, waveformTrackIDs: needed)
        let rowTracks = rows.compactMap { tracksByID[$0.id] }
        let columns = Task.detached(priority: .userInitiated) {
            Dictionary(rowTracks.compactMap { track -> (String, AnalysisWaveformColumns)? in
                guard let waveform = track.waveform,
                      let columns = AnalysisWaveformColumns.make(AnalysisWaveformRequest(waveform: waveform, count: min(32, waveform.peaks.count))) else { return nil }
                return (track.id, columns)
            }, uniquingKeysWith: { first, _ in first })
        }
        await playbackWaveformCache.load(player.track?.waveform, trackID: player.track?.id)
        initialWaveformColumns = await columns.value
        PerformanceProbe.event("first_render_waveforms_ready", count: needed.count,
                               fields: ["rowWaveforms": Double(initialWaveformColumns.count)])
    }
    func finishLoadingLibrary() async {
        guard deferredWaveforms else { return }
        do { try await reload() }
        catch is CancellationError { }
        catch { message = error.localizedDescription }
    }
    func reload(metadataOnly: Bool = false, waveformTrackIDs: Set<String> = []) async throws {
        let request = UUID(); reloadRequest = request
        let source = store
        while true {
            // SwiftData objects never leave their owning actor. The handoff is
            // immutable strings; waveform JSON and filesystem work runs elsewhere.
            if !musicCatalogLoaded, cloud != nil { musicCatalog = try store.musicCatalog(); musicCatalogLoaded = true }
            let payloads = try source.payloadSnapshot()
            PerformanceProbe.event("library_payloads_ready")
            let snapshot = try await snapshotDecoder.decode(payloads, audioDirectory: audio.directory, metadataOnly: metadataOnly, waveformTrackIDs: waveformTrackIDs)
            PerformanceProbe.event("library_decode_ready")
            try Task.checkCancellation()
            guard request == reloadRequest, source === store else { return }
            guard snapshot.revision == source.revision else { continue }
            try applyLibrarySnapshot(snapshot, metadataOnly: metadataOnly)
            return
        }
    }
    private func applyLibrarySnapshot(_ snapshot: LibrarySnapshot, metadataOnly: Bool) throws {
        let availableTracks = snapshot.tracks.filter { sourceIsAvailable($0.id) } + musicCatalog.tracks
        let availableCollections = snapshot.collections.filter { sourceIsAvailable($0.id) } + musicCatalog.collections(jobs: importJobs, library: snapshot.collections)
        if tracks != availableTracks { tracks = availableTracks }
        else { rebuildTrackIndex() } // A crew-only account can launch with no personal rows.
        if collections != availableCollections { collections = availableCollections }
        if favorites != snapshot.favorites { favorites = snapshot.favorites }
        if annotations != snapshot.annotations { annotations = snapshot.annotations }
        let sharedOffline = offlineIDs.filter { $0.hasPrefix("crew:") && tracksByID[$0] != nil }
        let availableOffline = snapshot.offlineIDs.filter { !$0.hasPrefix("usb:") }.union(sharedOffline)
        if offlineIDs != availableOffline { offlineIDs = availableOffline }
        cacheSharedAudio()
        prunePlaylistRemovalHistory()
        try reloadSyncState()
        if playbackSessionReady { reconcilePlaybackSession() }
        if !metadataOnly, deferredWaveforms {
            deferredWaveforms = false
            PerformanceProbe.event("library_analysis_ready")
            let requests = deferredWaveformRequests; deferredWaveformRequests.removeAll()
            for id in requests {
                if let track = tracksByID[id], track.waveform == nil {
                    Task { await loadWaveform(track) }
                }
            }
        }
    }
    private func reloadSyncState() throws {
        pendingCount = try store.pendingCount(); conflicts = try store.conflicts()
    }
    private func reloadCollections() throws {
        collections = try store.values(.collection, as: Collection.self).filter { sourceIsAvailable($0.id) }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        collections += musicCatalog.collections(jobs: importJobs, library: collections)
        prunePlaylistRemovalHistory()
        try reloadSyncState()
        if playbackSessionReady { reconcilePlaybackSession() }
    }
    var visibleTracks: [Track] {
        if let crateID = selectedCrewCrateID, let detail = crewCrates[crateID] { return detail.items.compactMap { localTrack(for: $0) } }
        let members = selectedCollection.flatMap { id in collections.first { $0.id == id }?.trackIDs }
        let assigned = filter == "Unsorted" ? Set(collections.flatMap(\.trackIDs)) : []
        let candidates: [Track]
        if let members {
            var seen = Set<String>()
            candidates = members.compactMap { (selectedCollection?.hasPrefix("usb:") == true || selectedCollection?.hasPrefix("connected:") == true || seen.insert($0).inserted) ? tracksByID[$0] : nil }
        } else { candidates = tracks }
        var result = candidates.filter { track in
            (selectedCollection != nil || showPlaylistBrowser || browseGroup == nil || browseMode.group(for: track) == browseGroup) &&
            (filter != "Favorites" || favorites.contains(track.id)) &&
            (filter != "Unsorted" || !assigned.contains(track.id)) &&
            (filter != "On this device" || offlineIDs.contains(track.id)) &&
            (query.isEmpty || "\(track.title) \(track.artist ?? "") \(track.album ?? "") \(track.genre ?? "") \(annotations[track.id]?.note ?? "")".localizedStandardContains(query))
        }
        if trackSort != "default" {
            result.sort { first, second in
                let comparison: ComparisonResult
                switch trackSort {
                case "bpm":
                    if first.bpm == nil || second.bpm == nil {
                        if first.bpm == second.bpm { return first.id < second.id }
                        return first.bpm != nil
                    }
                    comparison = first.bpm! == second.bpm! ? .orderedSame : first.bpm! < second.bpm! ? .orderedAscending : .orderedDescending
                case "key": comparison = (first.key ?? "").localizedStandardCompare(second.key ?? "")
                default: comparison = first.title.localizedStandardCompare(second.title)
                }
                if comparison == .orderedSame { return first.id < second.id }
                return comparison == (trackSortAscending ? .orderedAscending : .orderedDescending)
            }
        }
        return result
    }
    private func sourceIsAvailable(_ id: String) -> Bool {
        !id.hasPrefix("usb:") || (usbConnected && usbDevice.map { id.hasPrefix("usb:\($0.id):") } == true)
    }
    func connectUSB(_ root: URL, browse: Bool = true) async throws {
        guard !usbReading else { return }
        usbReading = true; usbError = nil
        defer { usbReading = false }
        let previous = usbDevice, generation = connectionGeneration
        let job = Task.detached(priority: .userInitiated) {
            let (access, library) = try USBDeviceFiles.authorize(root, previous: previous)
            return (access, library, try USBDeviceFiles.signature(access))
        }
        let (access, library, signature) = try await withTaskCancellationHandler { try await job.value } onCancel: { job.cancel() }
        try Task.checkCancellation()
        guard generation == connectionGeneration else { return }
        try store.ingestUSB(library, access: access)
        usbDevice = access; usbConnected = true; usbSignature = signature; unavailableUSBWaveforms.removeAll()
        try await reload()
        if browse { openPlaylistFolder([access.folderName]) }
    }
    func refreshUSBConnection() async {
        guard !checkingUSB, !usbReading, let access = usbDevice else { return }
        checkingUSB = true; defer { checkingUSB = false }
        let generation = connectionGeneration
        do {
            let signature = try await Task.detached(priority: .utility) { try USBDeviceFiles.signature(access) }.value
            guard generation == connectionGeneration else { return }
            if !usbConnected || signature != usbSignature {
                let root = try await Task.detached(priority: .utility) { try USBDeviceFiles.resolve(access) }.value
                try await connectUSB(root, browse: false)
            }
            guard generation == connectionGeneration, !Task.isCancelled else { return }
            usbConnected = true; usbError = nil
        } catch {
            guard generation == connectionGeneration else { return }
            let wasConnected = usbConnected
            usbConnected = false
            // Remove the external source from every view and playback queue at once.
            // Its local metadata/annotations remain available for the next connection.
            if wasConnected {
                tracks.removeAll { $0.id.hasPrefix("usb:") }
                collections.removeAll { $0.id.hasPrefix("usb:") }
                offlineIDs = offlineIDs.filter { !$0.hasPrefix("usb:") }
            }
            if player.track?.id.hasPrefix("usb:") == true {
                playbackRequest = UUID(); player.stop()
            } else if wasConnected { reconcilePlaybackSession() }
            if wasConnected, playlistFolderPath.first == access.folderName || selectedCollection?.hasPrefix("usb:\(access.id):") == true {
                openPlaylistFolder([])
            }
            usbError = "Reconnect your USB stick, or choose its folder again to renew access."
        }
    }
    func startup() async {
        guard !demo else { return }
        async let remote: Void = synchronize()
        #if os(macOS) || targetEnvironment(simulator)
        await refreshWorkstation()
        #endif
        await remote
        await refreshMusic()
        await fulfillOfflineLaunchRequest()
    }
    func connectWorkstation(url: String) async throws {
        _ = try Endpoint(url, loopbackOnly: true)
        workstationURL = url
        UserDefaults.standard.set(url, forKey: "workstationURL")
        if cloudAccountID != nil { UserDefaults.standard.set(url, forKey: "workstationAllowed:" + cloudStorageScope) }
        await refreshWorkstation()
    }
    func refreshWorkstation() async {
        guard !demo, !refreshRunning, let workstation else { return }
        refreshRunning = true; loading = tracks.isEmpty
        defer { refreshRunning = false; loading = false }
        do {
            bootstrap = try await workstation.get("api/bootstrap")
            bootstrapEndpoint = workstation.endpoint.scope
            workstationConnected = true
            let localTracks = try await workstation.allTracks()
            workstationTracks = Dictionary(localTracks.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
            try ingestWorkstation(localTracks); try await reload()
        } catch {
            workstationConnected = false
            if tracks.isEmpty { syncStatus = "Connect your Mac library or cloud to get started" }
        }
    }
    private func ingestWorkstation(_ items: [Track]) throws {
        for track in items { workstationTracks[track.id] = track }
        let portable = items.map { original in
            var track = original
            // Availability/artwork are properties of this Mac, never promises to another device.
            track.fileExists = false; track.artworkAvailable = false
            return track
        }
        try store.ingest(portable, enqueue: false)
    }
    func synchronize() async {
        guard !demo, !syncing, let cloud else { return }
        let generation = connectionGeneration
        syncing = true; defer { syncing = false }
        do {
            try await syncEngine.sync(store: store, client: cloud) {
                if generation == connectionGeneration { syncStatus = $0 }
            }
            guard generation == connectionGeneration else { return }
            try await reload()
            await fulfillOfflineLaunchRequest()
            downloadOfflineCDJAnalysis()
        } catch {
            guard generation == connectionGeneration, !(error is CancellationError) else { return }
            // Background sync is optional for local use. A server outage must
            // never put an alert over playback or require dismissal on every retry.
            syncStatus = "Offline · changes saved on this device"
        }
    }
    func refreshImports() async {
        guard !demo, !refreshingImports, let cloud else { return }
        refreshingImports = true; defer { refreshingImports = false }
        let generation = connectionGeneration
        do {
            let jobs = try await cloud.imports()
            guard generation == connectionGeneration else { return }
            let completed = jobs.contains { job in job.status == "complete" && !importJobs.contains { $0.id == job.id && $0.status == "complete" } }
            importJobs = jobs; importRefreshError = nil
            if musicCatalog.rememberDownloads(jobs) { try store.saveMusicCatalog(musicCatalog) }
            // Sync may already be running, or these tracks may already be on
            // disk. Reproject membership as soon as provenance arrives.
            try reloadCollections()
            if completed { await synchronize() }
        } catch {
            guard generation == connectionGeneration else { return }
            importRefreshError = error.localizedDescription
        }
    }
    @discardableResult
    func submitImport(_ source: String) async -> Bool {
        await submitImportJob(source) != nil
    }
    func submitImportJob(_ source: String, requestID: String? = nil) async -> CloudImportJob? {
        guard let cloud, !demo, !submittingImport else { return nil }
        submittingImport = true; defer { submittingImport = false }
        let source = source.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = pendingImportKey
        let pending = UserDefaults.standard.dictionary(forKey: key)
        let id = requestID ?? (pending?["source"] as? String == source ? (pending?["id"] as? String ?? UUID().uuidString) : UUID().uuidString)
        // Persist the request identity before sending, so uncertain responses are safe to retry.
        UserDefaults.standard.set(["id": id, "source": source], forKey: key)
        let generation = connectionGeneration
        do {
            let job = try await cloud.submitImport(id: id, source: source)
            UserDefaults.standard.removeObject(forKey: key)
            guard generation == connectionGeneration else { return nil }
            importJobs.removeAll { $0.id == job.id }; importJobs.insert(job, at: 0)
            importError = nil
            return job
        } catch {
            guard generation == connectionGeneration else { return nil }
            importError = error.localizedDescription
            return nil
        }
    }
    func retryImport(_ job: CloudImportJob) async {
        let generation = connectionGeneration
        do {
            _ = try await retryImportJob(id: job.id)
        } catch { if generation == connectionGeneration { importError = error.localizedDescription } }
    }
    func retryImportJob(id: String, requestID: String = UUID().uuidString, refresh: Bool = false) async throws -> CloudImportJob {
        guard let cloud, !demo, !submittingImport else { throw ClientError.http(409, "Cloud account is unavailable or an import submission is running") }
        submittingImport = true; defer { submittingImport = false }
        let generation = connectionGeneration
        let job = try await cloud.retryImport(id: id, requestID: requestID, refresh: refresh)
        guard generation == connectionGeneration else { throw CancellationError() }
        importJobs.removeAll { $0.id == job.id }; importJobs.insert(job, at: 0)
        importError = nil
        return job
    }
    func importStatus(id: String, offset: Int) async throws -> String {
        guard let cloud, !demo else { throw ClientError.http(503, "Cloud account is not connected") }
        return try await cloud.importStatus(id: id, offset: offset)
    }
    private func retainSharedTrack(_ track: Track) throws {
        guard track.id.hasPrefix("crew:"), try store.track(id: track.id) == nil else { return }
        try store.ingest([track])
        tracks.append(track)
    }
    func favorite(_ track: Track) {
        do { try retainSharedTrack(track); try store.toggleFavorite(track.id); favorites = try store.favoriteIDs(); try reloadSyncState() } catch { message = error.localizedDescription }
    }
    func annotation(for track: Track) -> TrackAnnotation { annotations[track.id] ?? TrackAnnotation() }
    func setNote(_ note: String, for track: Track) {
        guard note.utf8.count <= TrackAnnotation.maxNoteUTF8Bytes else {
            message = "This comment is too long. Keep it under 16 KB."; return
        }
        do {
            try retainSharedTrack(track)
            try store.setNote(note, trackID: track.id)
            try annotationChanged(track.id)
        } catch { message = error.localizedDescription }
    }
    func setColor(_ color: TrackColor?, for track: Track) {
        do {
            try retainSharedTrack(track)
            try store.setColor(color, trackID: track.id)
            try annotationChanged(track.id)
        } catch { message = error.localizedDescription }
    }
    private func annotationChanged(_ id: String) throws {
        annotations[id] = try store.annotation(for: id)
        pendingCount = try store.pendingCount()
        syncStatus = "Changes saved on this device"
    }
    var quickAddTarget: Collection? {
        let id = selectedCollection ?? preferredCollectionID
        return collections.first { $0.id == id }
    }
    private func changeNavigation(_ update: () -> Void) {
        navigationChanged = true
        let ready = playbackSessionReady; playbackSessionReady = false
        update()
        playbackSessionReady = ready; persistPlaybackSession()
    }
    func browse(_ mode: LibraryBrowseMode, group: String? = nil) {
        selectedCrewID = nil; selectedCrewCrateID = nil
        changeNavigation {
            browseMode = mode; browseGroup = group
            trackSort = mode == .playlists ? "default" : "title"; trackSortAscending = true
            selectedCollection = nil; playlistFolderPath = []; query = ""; filter = "All music"
            showPlaylistBrowser = mode == .playlists
        }
    }
    func showLibrary(filter: String = "All music") {
        selectedCrewID = nil; selectedCrewCrateID = nil
        pendingQuickAddTrackID = nil; quickAddReturnSession = nil
        changeNavigation { showPlaylistBrowser = false; selectedCollection = nil; self.filter = filter; query = "" }
    }
    func openPlaylistBrowser() {
        selectedCrewID = nil; selectedCrewCrateID = nil
        changeNavigation { browseMode = .playlists; browseGroup = nil; showPlaylistBrowser = true; selectedCollection = nil; query = "" }
    }
    func openPlaylistFolder(_ path: [String]) {
        selectedCrewID = nil; selectedCrewCrateID = nil
        changeNavigation {
            browseMode = .playlists; browseGroup = nil
            playlistFolderPath = path; showPlaylistBrowser = true; selectedCollection = nil; query = ""
        }
    }
    func openCollection(_ collection: Collection) {
        if let item = connectedPlaylist(collection.id) { Task { await loadMusicPlaylist(item) } }
        guard let current = collections.first(where: { $0.id == collection.id }) else { return }
        if let trackID = pendingQuickAddTrackID {
            do {
                if let track = tracksByID[trackID] { try retainSharedTrack(track) }
                try store.addTrack(trackID, toCollection: current.id); try reloadCollections()
                finishQuickAdd(preferredID: current.id)
            } catch { message = error.localizedDescription }
            return
        }
        changeNavigation {
            browseMode = .playlists; browseGroup = nil
            preferredCollectionID = current.id; selectedCollection = current.id
            selectedCrewID = nil; selectedCrewCrateID = nil
            // A pinned playlist may live elsewhere: Back returns to the folder
            // the user was browsing, including an explicitly selected root.
            if !showPlaylistBrowser { playlistFolderPath = current.folderPath ?? [] }
            showPlaylistBrowser = false
            filter = "All music"; query = ""
        }
    }
    func backFromCollection() {
        if pendingQuickAddTrackID != nil { cancelQuickAdd(); return }
        openPlaylistBrowser()
    }
    func cancelQuickAdd() { finishQuickAdd(preferredID: nil) }
    private func finishQuickAdd(preferredID: String?) {
        selectedCrewID = nil; selectedCrewCrateID = nil
        let previous = quickAddReturnSession?.resolved(tracks: tracks, collections: collections, additionalFolderPaths: musicProviderNames.map { [$0] })
        pendingQuickAddTrackID = nil; quickAddReturnSession = nil
        changeNavigation {
            if let previous {
                selectedCollection = previous.selectedCollection; filter = previous.filter; query = previous.query
                applyNavigation(previous.navigation)
            }
            if let preferredID { preferredCollectionID = preferredID }
        }
    }
    func quickAdd(_ track: Track) {
        guard tracksByID[track.id] != nil else { return }
        if let target = quickAddTarget { add(track, to: target); return }
        choosePlaylist(for: track)
    }
    func choosePlaylist(for track: Track) {
        guard tracksByID[track.id] != nil else { return }
        quickAddReturnSession = currentPlaybackSession(); pendingQuickAddTrackID = track.id
        openPlaylistBrowser()
        if collections.isEmpty && crews.isEmpty { showNewCollection = true }
    }
    func createCollection(_ name: String) {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        do {
            if let id = pendingQuickAddTrackID, let track = tracksByID[id] { try retainSharedTrack(track) }
            let ids = pendingQuickAddTrackID.map { [$0] } ?? []
            let collection = try store.createCollection(name: name, folderPath: playlistFolderPath, trackIDs: ids)
            try reloadCollections()
            if pendingQuickAddTrackID != nil { finishQuickAdd(preferredID: collection.id) }
            else { openCollection(collection) }
        } catch { message = error.localizedDescription }
    }
    func add(_ track: Track, to collection: Collection) {
        guard !collection.id.hasPrefix("connected:") else { return }
        do { try retainSharedTrack(track); try store.addTrack(track.id, toCollection: collection.id); try reloadCollections() }
        catch { message = error.localizedDescription }
    }
    func requestRemoval(_ track: Track, from collection: Collection) {
        guard !collection.id.hasPrefix("connected:") else { return }
        guard let current = collections.first(where: { $0.id == collection.id }),
              current.trackIDs.contains(track.id) else { return }
        pendingPlaylistRemoval = PlaylistRemovalRequest(trackID: track.id, trackTitle: track.title,
            collectionID: current.id, collectionName: current.name, connectionGeneration: connectionGeneration)
    }
    func confirmRemoval(_ request: PlaylistRemovalRequest) {
        pendingPlaylistRemoval = nil
        guard request.connectionGeneration == connectionGeneration else { return }
        do {
            guard let removal = try store.removeTrack(request.trackID, fromCollection: request.collectionID) else { return }
            playlistRemovalHistory.append(PlaylistRemovalUndo(removal: removal, trackTitle: request.trackTitle,
                collectionName: request.collectionName, connectionGeneration: connectionGeneration))
            try reloadCollections()
        } catch { message = error.localizedDescription }
    }
    func undoPlaylistRemoval() {
        guard let undo = playlistRemovalHistory.last else { return }
        guard undo.connectionGeneration == connectionGeneration else { dismissPlaylistRemovalUndo(); return }
        do {
            try store.restoreTrack(undo.removal)
            playlistRemovalHistory.removeLast()
            try reloadCollections()
        } catch { message = error.localizedDescription }
    }
    func dismissPlaylistRemovalUndo() { playlistRemovalHistory.removeAll() }
    private func prunePlaylistRemovalHistory() {
        guard !playlistRemovalHistory.isEmpty else { return }
        let collectionIDs = Set(collections.map(\.id))
        let trackIDs = Set(tracks.map(\.id))
        playlistRemovalHistory.removeAll {
            !collectionIDs.contains($0.removal.collectionID) || !trackIDs.contains($0.removal.trackID)
        }
    }
    func move(_ track: Track, in collection: Collection, by direction: Int) {
        guard !collection.id.hasPrefix("connected:") else { return }
        do { try store.moveTrack(track.id, inCollection: collection.id, by: direction); try reloadCollections() }
        catch { message = error.localizedDescription }
    }
    func archive(_ track: Track) {
        do { try store.archiveTrack(track.id); try reloadCollections() }
        catch { message = error.localizedDescription }
    }
    func togglePin(_ collection: Collection) {
        do { try store.toggleCollectionPin(collection.id); try reloadCollections() }
        catch { message = error.localizedDescription }
    }
    func updateCollection(_ collection: Collection, name: String, mood: String, folderPath: [String]) {
        do {
            try store.updateCollection(collection.id, name: name, mood: mood, folderPath: folderPath); try reloadCollections()
        } catch { message = error.localizedDescription }
    }
    func deleteCollection(_ collection: Collection) {
        do { try store.deleteCollection(collection.id); try reloadCollections() }
        catch { message = error.localizedDescription }
    }
    func exportCollection(_ collection: Collection) async {
        guard !exportingCollection, workstationConnected, let workstation, let bootstrap,
              bootstrapEndpoint == workstation.endpoint.scope, bootstrap.library.writeEnabled else { return }
        exportingCollection = true; defer { exportingCollection = false }
        let generation = connectionGeneration
        do {
            // Idempotent membership writes use the existing serialized master.db writer.
            let existing: Items<Playlist> = try await workstation.get("api/playlists")
            let name = collection.name
            var matches = existing.items.filter { $0.name == name && $0.type == "playlist" && $0.parentId == "root" }
            guard matches.count <= 1 else { throw ClientError.http(409, "Several root playlists have this name; choose a unique collection name before exporting") }
            var playlist = matches.first
            if playlist == nil {
                try await workstation.mutate(["type": "create-playlist", "name": name], token: bootstrap.csrfToken)
                let refreshed: Items<Playlist> = try await workstation.get("api/playlists")
                matches = refreshed.items.filter { $0.name == name && $0.type == "playlist" && $0.parentId == "root" }
                guard matches.count == 1 else { throw ClientError.http(409, "Could not identify the new root playlist") }
                playlist = matches.first
            }
            guard let playlist else { throw ClientError.http(409, "Could not find the new playlist") }
            var existingIDs = Set(try await workstation.allTracks(playlistID: playlist.id).map(\.id))
            for id in collection.trackIDs {
                guard generation == connectionGeneration else { return }
                try Task.checkCancellation()
                guard let track = workstationTracks[id], track.fileExists,
                      let localID = track.localContentID, !existingIDs.contains(localID) else { continue }
                try await workstation.mutate(["type": "add-track", "playlistId": playlist.id, "contentId": localID], token: bootstrap.csrfToken)
                existingIDs.insert(localID)
            }
            message = "Added collection to Rekordbox."
        } catch { message = error.localizedDescription }
    }
    private func currentPlaybackSession() -> PlaybackSession {
        PlaybackSession(trackID: player.track?.id, queueIDs: player.queue.map(\.id), elapsed: player.elapsed,
                        selectedCollection: selectedCollection, filter: filter, query: query,
                        queueCollection: queueCollection, queueFilter: queueFilter,
                        navigation: PlaylistNavigation(showBrowser: showPlaylistBrowser, folderPath: playlistFolderPath,
                            preferredCollectionID: preferredCollectionID, playlistSort: playlistSort,
                            playlistSortAscending: playlistSortAscending, trackSort: trackSort, trackSortAscending: trackSortAscending,
                            browseMode: browseMode.rawValue, browseGroup: browseGroup), queueIndex: player.queueIndex)
    }
    func persistPlaybackSession(force: Bool = true) {
        guard playbackSessionReady, force || Date().timeIntervalSince(lastSessionSave) >= 10 else { return }
        // An empty pre-sync launch must not erase a prior session before its library arrives.
        guard !tracksByID.isEmpty else { return }
        playbackPreferences?.save(currentPlaybackSession())
        lastSessionSave = Date()
    }
    private func localAudioURL(_ track: Track) -> URL? {
        guard !track.id.hasPrefix("usb:"), offlineIDs.contains(track.id), let hash = track.mediaHash else { return nil }
        return audio.url(hash: hash)
    }
    private func restorePlaybackSession() {
        navigationChanged = false
        playbackSessionReady = false
        let previous = playbackPreferences?.load()
        restoredSavedPlaybackSession = previous != nil
        let saved = previous ?? PlaybackSession()
        applyPlaybackSession(saved.resolved(tracks: playbackTracks, collections: collections, additionalFolderPaths: musicProviderNames.map { [$0] }), replacingItem: true)
        playbackSessionReady = true
        persistPlaybackSession()
    }
    private func reconcilePlaybackSession() {
        var saved = player.track == nil ? (playbackPreferences?.load() ?? currentPlaybackSession()) : currentPlaybackSession()
        // Metadata-only browsing cannot persist while the library has no tracks yet.
        // Keep the user's current page when the first provider tracks arrive.
        if navigationChanged {
            saved.selectedCollection = selectedCollection; saved.navigation = currentPlaybackSession().navigation
            saved.filter = filter; saved.query = query
        }
        let resolved = saved.resolved(tracks: playbackTracks, collections: collections, additionalFolderPaths: musicProviderNames.map { [$0] })
        playbackSessionReady = false
        applyPlaybackSession(resolved, replacingItem: player.track?.id != resolved.trackID)
        playbackSessionReady = true
        persistPlaybackSession()
    }
    private func applyPlaybackSession(_ session: PlaybackSession, replacingItem: Bool) {
        selectedCollection = session.selectedCollection; filter = session.filter; query = session.query
        applyNavigation(session.navigation)
        #if os(iOS)
        // Mobile presents playlists directly. Retired search/filter controls must
        // not leave recordings invisibly filtered out of a restored playlist.
        filter = "All music"; query = ""; trackSort = browseMode == .playlists ? "default" : "title"; trackSortAscending = true
        if selectedCollection == nil { showPlaylistBrowser = browseMode == .playlists }
        #endif
        queueCollection = session.queueCollection; queueFilter = session.queueFilter
        #if os(iOS)
        if sonos.ownsPlayback {
            sonos.refreshLibraryMetadata(tracksByID, player: player)
            return
        }
        #endif
        let queue = session.queueIDs.compactMap { tracksByID[$0] }
        guard let id = session.trackID, let track = tracksByID[id] else { player.stop(); return }
        if replacingItem {
            player.prepare(track, url: localAudioURL(track), queue: queue, elapsed: session.elapsed, queueIndex: session.queueIndex)
        } else {
            player.track = track; player.queue = queue; player.queueIndex = session.queueIndex ?? 0
        }
    }
    private func applyNavigation(_ navigation: PlaylistNavigation?) {
        let value = navigation ?? PlaylistNavigation()
        browseMode = value.browseMode.flatMap(LibraryBrowseMode.init(rawValue:)) ?? .playlists
        browseGroup = (browseMode == .artists || browseMode == .albums) ? value.browseGroup : nil
        showPlaylistBrowser = value.showBrowser; playlistFolderPath = value.folderPath
        preferredCollectionID = value.preferredCollectionID; playlistSort = value.playlistSort
        playlistSortAscending = value.playlistSortAscending; trackSort = value.trackSort; trackSortAscending = value.trackSortAscending
    }
    func togglePlayback() async {
        if player.transportPlaying { player.pause(); return }
        if player.hasPreparedItem { player.resume(); return }
        guard let track = player.track ?? visibleTracks.first ?? tracks.first else { return }
        await preparePlayback(track, queue: player.queue.isEmpty ? visibleTracks : player.queue,
                              elapsed: player.track?.id == track.id ? player.elapsed : 0, queueIndex: player.queueIndex)
    }
    func play(_ track: Track, preservingQueue: Bool = false, queuePosition: Int? = nil) async {
        let queue = preservingQueue ? player.queue : visibleTracks
        let index = queuePosition ?? (preservingQueue ? (player.pendingStreamQueueIndex ?? player.queueIndex) : nil)
        #if os(iOS)
        // A restored speaker queue already owns its media URLs and metadata.
        // Its controls must work before the local library finishes hydrating.
        let speakerTrack = tracksByID[track.id] ?? track
        if sonos.canSelect(speakerTrack, queue: queue) {
            if !preservingQueue { queueCollection = selectedCollection; queueFilter = filter }
            let speakerIndex = index.flatMap { position -> Int? in
                guard queue.indices.contains(position), queue[position].id == speakerTrack.id else { return nil }
                return queue.prefix(position).filter { $0.mediaHash != nil }.count
            }
            await sonos.select(speakerTrack, queuePosition: speakerIndex); return
        }
        #endif
        guard let canonical = tracksByID[track.id] else {
            #if os(iOS)
            AppDiagnostics.shared.event("playback_selection_dropped", ["track": track.id,
                "queueIndex": String(index ?? -1), "reason": "missing_library_track",
                "sonosOwned": String(sonos.ownsPlayback)])
            #endif
            return
        }
        if !preservingQueue { queueCollection = selectedCollection; queueFilter = filter }
        await preparePlayback(canonical, queue: queue.contains(where: { $0.id == canonical.id }) ? queue : [canonical] + queue, elapsed: 0, queueIndex: index)
    }
    private func preparePlayback(_ track: Track, queue: [Track], elapsed: Double, queueIndex: Int? = nil, autoplay: Bool = true) async {
        PerformanceProbe.playRequested(trackID: track.id)
        let request = UUID(); playbackRequest = request
        let generation = connectionGeneration
        // Selection advances immediately, including rapid Next taps and downloads.
        // Resolving the URL later attaches audio to this preparation only once.
        player.prepare(track, url: nil, queue: queue, elapsed: elapsed, queueIndex: queueIndex)
        // Preview gestures select a paused fixture without pretending to acquire audio.
        if demo && !track.id.hasPrefix("usb:") { return }
        do {
            #if os(iOS)
            if sonos.room != nil {
                guard let cloud else { throw ClientError.http(400, "Connect your cloud library to play on Sonos.") }
                guard !track.id.hasPrefix("connected:") else {
                    throw ClientError.http(400, "This Sonos connection plays your library files. Connected streaming tracks need an AirPlay-capable speaker.")
                }
                if track.mediaHash == nil { _ = try await offlineAudio(track) }
                guard request == playbackRequest, generation == connectionGeneration, sonos.room != nil,
                      let selected = tracksByID[track.id], let hash = selected.mediaHash else { return }
                let preparationStarted = ContinuousClock.now
                // Both requests are independent. Do not put a full cloud round trip
                // between checking the selected file and minting the queue capability.
                async let mediaExists = sonos.mediaExists(hash, cloud: cloud)
                // Keep the original occurrence while filtering unavailable rows.
                // Identical recordings can occur more than once in a playlist.
                let playableQueue = queue.enumerated().compactMap { position, track -> (position: Int, track: Track)? in
                    guard let canonical = tracksByID[track.id], canonical.mediaHash != nil else { return nil }
                    return (position, canonical)
                }
                let speakerQueue = playableQueue.map(\.track)
                let available = speakerQueue.contains(where: { $0.id == selected.id }) ? speakerQueue : [selected] + speakerQueue
                let index = playableQueue.firstIndex { $0.position == player.queueIndex && $0.track.id == selected.id }
                    ?? available.firstIndex { $0.id == selected.id } ?? 0
                let session = try await cloud.speakerSession(tracks: available.map {
                    CloudClient.SpeakerTrack(hash: $0.mediaHash!, mediaExtension: SonosPlayback.mediaExtension($0.mediaExtension))
                })
                do {
                    if !(try await mediaExists) {
                        let file = try await offlineAudio(selected)
                        try await cloud.upload(file: file, hash: hash)
                    }
                } catch {
                    Task { try? await cloud.revokeSpeakerSession(session.session) }
                    throw error
                }
                guard request == playbackRequest, generation == connectionGeneration, sonos.room != nil else {
                    Task { try? await cloud.revokeSpeakerSession(session.session) }; return
                }
                AppDiagnostics.shared.event("sonos_media_ready", ["track": selected.id,
                    "elapsed": String(describing: preparationStarted.duration(to: .now)), "queueCount": String(available.count)])
                try await sonos.play(queue: available, index: index, session: session, cloud: cloud, player: player, autoplay: autoplay)
                return
            }
            #endif
            // A paused transfer back to this phone only prepares the selected
            // item. Resume can acquire remote audio through the normal path.
            if !autoplay {
                if let url = localAudioURL(track) { player.attach(url: url, autoplay: false) }
                return
            }
            if track.id.hasPrefix("usb:") {
                guard sourceIsAvailable(track.id), let location = try store.usbFile(track.id), let access = usbDevice else {
                    throw USBLibraryError.disconnected
                }
                let source = try await Task.detached(priority: .userInitiated) {
                    try USBDeviceFiles.openForPlayback(location, access: access)
                }.value
                guard request == playbackRequest, generation == connectionGeneration, sourceIsAvailable(track.id) else { return }
                player.attachUSB(source, autoplay: true)
                if track.waveform == nil { Task { await loadWaveform(track) } }
                return
            }
            // Do the cheap filesystem check off MainActor. A local hit attaches
            // audio without a second player teardown or session write.
            let cached = if let hash = track.mediaHash { await audio.existing(hash: hash) } else { nil as URL? }
            guard request == playbackRequest, generation == connectionGeneration,
                  let current = tracksByID[track.id] else { return }
            let workstationAudio = workstationConnected ? workstationTracks[track.id].flatMap { workstation?.audioURL($0) } : nil
            if let url = cached ?? workstationAudio {
                player.track = current
                player.queue = queue.compactMap { tracksByID[$0.id] }
                player.attach(url: url, autoplay: true)
            } else if let source = musicCatalog.sources.first(where: { track.id.hasPrefix("connected:" + $0.id + ":track:") }),
                      let item = musicCatalog.snapshots.values.lazy.flatMap({ $0.tracks }).first(where: { $0.id == track.id }), let cloud {
                guard item.available else { throw ClientError.http(403, "This track is unavailable for streaming") }
                if source.provider == "soundcloud" {
                    PerformanceProbe.event("soundcloud_resolve_begin", trackID: track.id)
                    let url = try await cloud.musicStream(item, source: source)
                    guard request == playbackRequest, generation == connectionGeneration else { return }
                    PerformanceProbe.event("soundcloud_resolve_ready", trackID: track.id)
                    player.attach(url: url, autoplay: true, fastStreamStart: true, onStreamAuthorizationFailure: { [weak self] in
                        Task { @MainActor [weak self] in
                            guard let self, request == self.playbackRequest, generation == self.connectionGeneration else { return }
                            do {
                                let fresh = try await cloud.musicStream(item, source: source, forceRefresh: true)
                                guard request == self.playbackRequest, generation == self.connectionGeneration,
                                      self.player.track?.id == track.id else { return }
                                // One retry only; the new item has no retry callback.
                                self.player.attach(url: fresh, autoplay: self.player.playbackRequested, fastStreamStart: true)
                            } catch {
                                guard request == self.playbackRequest, generation == self.connectionGeneration else { return }
                                self.player.failStreamPreparation(error.localizedDescription)
                            }
                        }
                    })
                    var seen = Set<String>()
                    let nextIDs = queue.dropFirst(player.queueIndex + 1).map(\.id).filter { seen.insert($0).inserted }.prefix(2)
                    let snapshots = musicCatalog.snapshots.values.flatMap(\.tracks)
                    let next = nextIDs.compactMap { id in snapshots.first { $0.id == id } }
                    warmSoundCloudStreams(next, source: source)
                } else {
                    try await prepareSpotifyPlayback(item, source: source, request: request, generation: generation)
                }
                return
            } else {
                guard track.id.hasPrefix("usb:") || (track.mediaHash != nil && cloud != nil) else {
                    throw ClientError.http(404, "This recording needs to be acquired on your Mac before it can play here")
                }
                guard let cloud, let hash = current.mediaHash else { throw ClientError.invalidMedia }
                player.track = current
                player.attachCloud(client: cloud, hash: hash, mediaExtension: current.mediaExtension)
            }
            if track.waveform == nil { Task { await loadWaveform(track) } }
        } catch {
            if request == playbackRequest, generation == connectionGeneration, !(error is CancellationError) {
                #if os(iOS)
                if sonos.room != nil {
                    sonos.logPreparationFailure(error, trackID: track.id, requestID: request.uuidString)
                }
                #endif
                message = error.localizedDescription
            }
        }
    }
    func keepOffline(_ track: Track) async {
        guard !demo || track.id.hasPrefix("usb:") else { return }
        let generation = connectionGeneration
        do { _ = try await offlineAudio(track) }
        catch { if generation == connectionGeneration, !(error is CancellationError) { message = error.localizedDescription } }
    }
    private func fulfillOfflineLaunchRequest() async {
        #if DEBUG
        guard !demo, !offlineLaunchActionRunning else { return }
        if let id = offlineCollectionID {
            guard let collection = collections.first(where: { $0.id == id }) else { return }
            if !offlineCollectionSelected {
                if !restoredSavedPlaybackSession || ProcessInfo.processInfo.arguments.contains("--keep-offline-collection") {
                    selectedCollection = id; filter = "All music"
                }
                offlineCollectionSelected = true
            }
            let generation = connectionGeneration
            offlineLaunchActionRunning = true
            defer { offlineLaunchActionRunning = false }
            for trackID in collection.trackIDs where !offlineIDs.contains(trackID) {
                guard !Task.isCancelled, generation == connectionGeneration else { return }
                guard let track = tracks.first(where: { $0.id == trackID }), track.mediaHash != nil else { continue }
                do { _ = try await offlineAudio(track) }
                catch ClientError.http(404, _) { continue }
                catch is CancellationError { return }
                catch {
                    if generation == connectionGeneration { syncStatus = "Offline · downloads will resume when connected" }
                    return
                }
                let count = collection.trackIDs.filter { offlineIDs.contains($0) }.count
                syncStatus = "Saving collection offline: \(count)/\(collection.trackIDs.count)"
            }
            guard generation == connectionGeneration else { return }
            let count = collection.trackIDs.filter { offlineIDs.contains($0) }.count
            syncStatus = count == collection.trackIDs.count ? "Collection saved offline" : "Waiting for collection audio: \(count)/\(collection.trackIDs.count) saved"
            // Keep the device-local request so newly published collection members
            // are downloaded on later syncs, without changing cloud library state.
            return
        }
        guard let id = pendingOfflineTrackID else { return }
        guard let track = tracks.first(where: { $0.id == id }), track.mediaHash != nil else {
            syncStatus = "Waiting for the requested mix to finish uploading"
            return
        }
        offlineLaunchActionRunning = true
        defer { offlineLaunchActionRunning = false }
        if !offlineIDs.contains(id) {
            let generation = connectionGeneration
            do { _ = try await offlineAudio(track) }
            catch {
                if generation == connectionGeneration, !(error is CancellationError) {
                    syncStatus = "Offline · downloads will resume when connected"
                }
                return
            }
        }
        // A missing cloud object or interrupted transfer remains retryable on the
        // next successful sync. This debug action never starts audio playback.
        if offlineIDs.contains(id) {
            pendingOfflineTrackID = nil
            if let key = offlineLaunchRequestKey { UserDefaults.standard.removeObject(forKey: key) }
            syncStatus = "Saved offline on this device"
        }
        #endif
    }
    /// Fetch immutable desktop analysis during normal sync/download, independently of DJ Link.
    private func downloadOfflineCDJAnalysis() {
        guard cdjDownloads == nil, let cloud else { return }
        let generation = connectionGeneration
        cdjDownloads = Task { [weak self, audio] in
            defer {
                if self?.connectionGeneration == generation {
                    self?.cdjDownloads = nil; self?.cdjDownloadStatus = nil
                }
            }
            var visited = Set<String>()
            while !Task.isCancelled, self?.connectionGeneration == generation {
                guard let track = self?.tracksByID.values.first(where: {
                    !visited.contains($0.id) && self?.offlineIDs.contains($0.id) == true &&
                    $0.analysis != nil && $0.analysis?.mediaHash == $0.mediaHash
                }), let analysis = track.analysis else { return }
                visited.insert(track.id)
                do {
                    for hash in analysis.hashes {
                        if await audio.existing(hash: hash) != nil { continue }
                        self?.cdjDownloadStatus = "Downloading CDJ files · " + track.title
                        _ = try await audio.download(cloud.mediaRequest(hash: hash), expectedHash: hash)
                    }
                } catch {
                    guard !(error is CancellationError) else { return }
                    self?.syncStatus = "CDJ analysis download interrupted · will retry on sync"
                }
            }
        }
    }
    /// Shared playlist metadata is already persisted in the account's crew cache.
    /// Warm the same immutable audio cache used by personal tracks, without delaying playback.
    private func cacheSharedAudio() {
        guard !demo, cloud != nil, crewAudioCache == nil else { return }
        let generation = connectionGeneration
        crewAudioCache = Task { [weak self] in
            guard let self else { return }
            defer { if generation == connectionGeneration { crewAudioCache = nil } }
            var visited = Set<String>()
            while !Task.isCancelled, generation == connectionGeneration {
                guard let track = crewCrates.values.lazy.flatMap({ $0.items }).compactMap({ self.localTrack(for: $0) })
                    .first(where: { $0.mediaHash != nil && !visited.contains($0.id) }) else { return }
                visited.insert(track.id)
                do { _ = try await offlineAudio(track) }
                catch {
                    if error is CancellationError { return }
                    // A failed or interrupted download retries on the next playlist refresh.
                    #if os(iOS)
                    AppDiagnostics.shared.event("crew_audio_cache_failed", ["track": track.id, "error": error.localizedDescription])
                    #endif
                }
            }
        }
    }
    private func offlineAudio(_ track: Track) async throws -> URL {
        let generation = connectionGeneration
        if let hash = track.mediaHash, let file = await audio.existing(hash: hash) {
            guard generation == connectionGeneration else { throw CancellationError() }
            offlineIDs.insert(track.id); downloadOfflineCDJAnalysis(); return file
        }
        guard generation == connectionGeneration else { throw CancellationError() }
        let downloadKey = track.mediaHash ?? track.id
        let download: Task<(URL, String), Error>
        if let existing = audioDownloads[downloadKey] { download = existing }
        else {
            let usbLocation = try store.usbFile(track.id), usbAccess = usbDevice
            let cloud = cloud
            let workstation = workstationConnected ? workstation : nil
            let local = workstationTracks[track.id]
            download = Task { [audio] in
                if let usbLocation {
                    guard let usbAccess, usbAccess.id == usbLocation.deviceID else { throw USBLibraryError.disconnected }
                    return try await audio.readUSB(usbLocation, access: usbAccess)
                }
                if track.id.hasPrefix("usb:"), track.mediaHash == nil { throw USBLibraryError.disconnected }
                if let hash = track.mediaHash, let cloud {
                    do { return try await audio.download(cloud.mediaRequest(hash: hash), expectedHash: hash) }
                    catch ClientError.http(404, _) {
                        guard let local, local.fileExists, let localID = local.localContentID, let workstation else { throw ClientError.invalidMedia }
                        return try await audio.download(URLRequest(url: workstation.endpoint.path("api", "audio", localID)), expectedHash: hash)
                    }
                } else if let local, local.fileExists, let localID = local.localContentID, let workstation {
                    // Only acquired local recordings can become permanent offline files.
                    return try await audio.download(URLRequest(url: workstation.endpoint.path("api", "audio", localID)))
                } else { throw ClientError.http(404, "Download this recording on your Mac first") }
            }
            audioDownloads[downloadKey] = download
        }
        downloading.insert(track.id)
        defer { if generation == connectionGeneration { audioDownloads.removeValue(forKey: downloadKey); downloading.remove(track.id) } }
        let result = try await download.value
        guard generation == connectionGeneration else { throw CancellationError() }
        if var updated = try store.track(id: track.id), updated.mediaHash != result.1 {
            guard updated.mediaHash == nil else { throw ClientError.http(409, "This recording changed while downloading; retry") }
            updated.mediaHash = result.1
            try store.save(updated, kind: .track, id: track.id)
            applyTrackUpdate(updated)
        }
        offlineIDs.insert(track.id)
        downloadOfflineCDJAnalysis()
        pendingCount = try store.pendingCount()
        return result.0
    }
    func keepCollectionOffline(_ collection: Collection) async {
        let generation = connectionGeneration
        for id in collection.trackIDs {
            if Task.isCancelled || generation != connectionGeneration { break }
            if let track = tracks.first(where: { $0.id == id }) { await keepOffline(track) }
        }
    }
    private func applyTrackUpdate(_ track: Track) {
        guard let index = tracks.firstIndex(where: { $0.id == track.id }) else { return }
        tracks[index] = track
        if player.track?.id == track.id { player.track = track }
    }
    func loadWaveform(_ track: Track) async {
        guard !deferredWaveforms else { deferredWaveformRequests.insert(track.id); return }
        if track.id.hasPrefix("usb:") {
            guard track.waveform == nil, !loadingUSBWaveforms.contains(track.id), !unavailableUSBWaveforms.contains(track.id), let access = usbDevice,
                  let location = try? store.usbFile(track.id) else { return }
            loadingUSBWaveforms.insert(track.id); defer { loadingUSBWaveforms.remove(track.id) }
            let generation = connectionGeneration
            do {
                let waveform = try await usbAnalysisReader.read(location, access: access, duration: track.durationSeconds ?? 0)
                guard generation == connectionGeneration, !Task.isCancelled else { return }
                guard let waveform, var updated = tracksByID[track.id] else { unavailableUSBWaveforms.insert(track.id); return }
                updated.waveform = waveform
                try store.save(updated, kind: .track, id: track.id)
                applyTrackUpdate(updated)
                pendingCount = try store.pendingCount()
            } catch {
                if generation == connectionGeneration, !(error is CancellationError) { unavailableUSBWaveforms.insert(track.id) }
            }
            return
        }
        guard workstationConnected, let workstation, let id = track.localContentID else { return }
        let generation = connectionGeneration
        struct Response: Decodable, Sendable { var waveform: Waveform }
        do {
            let response: Response = try await workstation.get("api/waveforms/\(id)")
            guard generation == connectionGeneration, response.waveform.source == "rekordbox", !response.waveform.peaks.isEmpty,
                  var updated = tracks.first(where: { $0.id == track.id }) else { return }
            updated.waveform = response.waveform
            try store.ingest([updated], enqueue: false); try await reload()
            if player.track?.id == track.id { player.track = updated }
        } catch { /* Missing analysis never interrupts playback. */ }
    }
    func resolve(_ conflict: SyncConflict, keepLocal: Bool) {
        do {
            try store.resolveConflict(conflict.id, keepLocal: keepLocal)
            Task { do { try await reload() } catch { message = error.localizedDescription } }
        } catch { message = error.localizedDescription }
    }
    func signOutCloud() async throws {
        guard !syncing, !refreshRunning, !exportingCollection else { throw ClientError.http(409, "Wait for the current sync or export to finish") }
        let localStore = try LibraryStore(directory: root.appendingPathComponent("local"))
        let localAudio = try AudioFiles(directory: root.appendingPathComponent("Audio"), session: PerformanceProbe.serverUnavailableSession)
        if let endpoint = try? Endpoint(cloudURL), let cloudAccountID {
            try Keychain.remove(endpoint.accountScope(cloudAccountID))
            UserDefaults.standard.removeObject(forKey: "cloudAccount:" + endpoint.scope)
        }
        soundCloudPrewarm?.cancel(); soundCloudPrewarm = nil
        spotifyPrewarm?.cancel(); spotifyPrewarm = nil
        connectionGeneration = UUID(); playbackRequest = UUID()
        #if os(iOS)
        await djLink.disconnect()
        await spotifyStreaming.disconnect(); spotifySignIn = nil
        await sonos.disconnect()
        #endif
        persistPlaybackSession()
        clearAgent()
        workstationConnected = false; workstationTracks = [:]; bootstrap = nil; bootstrapEndpoint = nil
        cloud = nil; cloudAccountID = nil; cloudURL = ""
        crews = []; crewDetails = [:]; crewCrates = [:]; crewError = nil
        selectedCrewID = nil; selectedCrewCrateID = nil
        UserDefaults.standard.removeObject(forKey: "cloudURL")
        crewAudioCache?.cancel(); crewAudioCache = nil
        cdjDownloads?.cancel(); cdjDownloads = nil; cdjDownloadStatus = nil
        for task in audioDownloads.values { task.cancel() }
        audioDownloads.removeAll(); downloading.removeAll()
        player.stop(); selectedCollection = nil
        playbackWaveformCache.reset(); initialWaveformColumns.removeAll()
        deferredWaveformRequests.removeAll(); importRefreshError = nil
        pendingQuickAddTrackID = nil; quickAddReturnSession = nil
        pendingPlaylistRemoval = nil; playlistRemovalHistory.removeAll()
        importJobs = []; importError = nil
        musicRefreshTask?.cancel(); musicRefreshTask = nil
        musicCatalog = MusicCatalog(); musicCatalogLoaded = false; musicError = nil; musicProviderErrors = [:]; musicLoading = false; musicPlaylistLoading = []; musicPlaylistErrors = [:]; pendingSpotifyTrackID = nil; musicDownloads = []; musicDownloadIDs = [:]
        tracks = []; collections = []; favorites = []; annotations = [:]; offlineIDs = []
        #if DEBUG
        pendingOfflineTrackID = nil; offlineCollectionID = nil; offlineCollectionSelected = false; offlineLaunchRequestKey = nil
        #endif
        playbackSessionReady = false
        playbackPreferences = PlaybackSessionPreferences(scope: "local")
        #if os(iOS)
        sonos.configure(playbackPreferences)
        #endif
        audio = localAudio; store = localStore
        usbDevice = try store.usbDevice(); usbConnected = false; usbSignature = nil
        try await reload(); restorePlaybackSession()
        syncStatus = "Signed out"
    }
    func configureCloud(url: String, token: String) async throws {
        guard !syncing, !refreshRunning, !exportingCollection else { throw ClientError.http(409, "Wait for the current sync or export to finish") }
        let endpoint = try Endpoint(url)
        let token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { throw ClientError.http(401, "Sign in with Nanocodex") }
        let client = CloudClient(endpoint: endpoint, token: token, session: PerformanceProbe.serverUnavailableSession)
        let account = try await client.account()
        guard !syncing, !refreshRunning, !exportingCollection else { throw ClientError.http(409, "Wait for the current sync or export to finish") }
        let scope = endpoint.accountScope(account.id)
        let newStore = try LibraryStore(directory: root.appendingPathComponent(scope))
        let newAudio = try AudioFiles(directory: root.appendingPathComponent(scope).appendingPathComponent("Audio"), session: PerformanceProbe.serverUnavailableSession)
        try Keychain.save(token, key: scope)
        UserDefaults.standard.set(account.id, forKey: "cloudAccount:" + endpoint.scope)
        UserDefaults.standard.set(endpoint.url.absoluteString, forKey: "cloudURL")
        soundCloudPrewarm?.cancel(); soundCloudPrewarm = nil
        spotifyPrewarm?.cancel(); spotifyPrewarm = nil
        connectionGeneration = UUID(); playbackRequest = UUID()
        #if os(iOS)
        await djLink.disconnect()
        await spotifyStreaming.disconnect(); spotifySignIn = nil
        await sonos.disconnect()
        #endif
        persistPlaybackSession()
        playbackSessionReady = false
        playbackPreferences = PlaybackSessionPreferences(scope: scope)
        #if os(iOS)
        sonos.configure(playbackPreferences)
        #endif
        cloudURL = endpoint.url.absoluteString
        clearAgent()
        workstationConnected = false; workstationTracks = [:]; bootstrap = nil; bootstrapEndpoint = nil
        cloudCapabilities = account.capabilities
        cloudAccountID = account.id
        importJobs = []; importError = nil
        musicRefreshTask?.cancel(); musicRefreshTask = nil
        musicCatalog = MusicCatalog(); musicCatalogLoaded = false; musicError = nil; musicProviderErrors = [:]; musicLoading = false; musicPlaylistLoading = []; musicPlaylistErrors = [:]; pendingSpotifyTrackID = nil; musicDownloads = []; musicDownloadIDs = [:]
        cloud = client
        #if DEBUG
        let offlineKey = "djbooth.debug.offline.\(scope)"
        offlineLaunchRequestKey = offlineKey
        pendingOfflineTrackID = UserDefaults.standard.string(forKey: offlineKey)
        offlineCollectionID = UserDefaults.standard.string(forKey: "\(offlineKey).collection")
        offlineCollectionSelected = false
        #endif
        crewAudioCache?.cancel(); crewAudioCache = nil
        cdjDownloads?.cancel(); cdjDownloads = nil; cdjDownloadStatus = nil
        for task in audioDownloads.values { task.cancel() }
        audioDownloads.removeAll(); downloading.removeAll()
        player.stop(); selectedCollection = nil
        playbackWaveformCache.reset(); initialWaveformColumns.removeAll()
        deferredWaveformRequests.removeAll(); importRefreshError = nil
        pendingQuickAddTrackID = nil; quickAddReturnSession = nil
        pendingPlaylistRemoval = nil; playlistRemovalHistory.removeAll()
        tracks = []; collections = []; favorites = []; annotations = [:]; offlineIDs = []
        audio = newAudio
        store = newStore
        let crewCache = try store.crewCache()
        crews = crewCache.crews; crewDetails = crewCache.details; crewCrates = crewCache.crates; crewError = nil
        selectedCrewID = nil; selectedCrewCrateID = nil
        usbDevice = try store.usbDevice(); usbConnected = false; usbSignature = nil
        restoreAgentConversation()
        try await reload()
        restorePlaybackSession()
        Task { await synchronize(); await refreshMusic(force: true); await refreshCrews() }
    }
}

@MainActor enum Keychain {
    static func read(_ key: String) throws -> String? {
        try withoutInteraction {
            if let value = try readItem(base(key)) { return value }
            #if os(macOS)
            // Earlier ad-hoc builds used this service. Preserve it and read only
            // when its existing access policy permits access without a prompt.
            var legacy = base(key); legacy[kSecAttrService as String] = "ai.djbooth.sync"
            return try readItem(legacy)
            #else
            return nil
            #endif
        }
    }
    private static func readItem(_ baseQuery: [String: Any]) throws -> String? {
        var query = baseQuery; query[kSecReturnData as String] = true; query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let result = SecItemCopyMatching(query as CFDictionary, &value)
        if result == errSecItemNotFound { return nil }
        guard result == errSecSuccess, let data = value as? Data else { throw ClientError.http(Int(result), "Could not read saved credentials") }
        return String(data: data, encoding: .utf8)
    }
    static func remove(_ key: String) throws {
        try withoutInteraction {
            let result = SecItemDelete(base(key) as CFDictionary)
            guard result == errSecSuccess || result == errSecItemNotFound else { throw ClientError.http(Int(result), "Could not remove saved credentials") }
        }
    }
    static func save(_ value: String, key: String) throws {
        try withoutInteraction {
            let query = base(key)
            let values: [String: Any] = [kSecValueData as String: Data(value.utf8)]
            var result = SecItemUpdate(query as CFDictionary, values as CFDictionary)
            if result == errSecItemNotFound {
                var add = query; add.merge(values) { _, new in new }
                add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                result = SecItemAdd(add as CFDictionary, nil)
            }
            guard result == errSecSuccess else { throw ClientError.http(Int(result), "Could not save credentials") }
        }
    }
    private static func base(_ key: String) -> [String: Any] {
        #if os(macOS)
        let service = "xyz.gakonst.djbooth.sync"
        #else
        let service = "ai.djbooth.sync"
        #endif
        return [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
    }
    private static func withoutInteraction<Value>(_ operation: () throws -> Value) throws -> Value {
        #if os(macOS)
        // The unsandboxed Mac app uses the file-based keychain: SecItem's
        // authentication-context flags do not suppress its legacy ACL dialogs.
        // Keep this process-local setting scoped to synchronous, serialized calls.
        var previous: DarwinBoolean = true
        let readStatus = SecKeychainGetUserInteractionAllowed(&previous)
        guard readStatus == errSecSuccess else { throw ClientError.http(Int(readStatus), "Could not access saved credentials") }
        let setStatus = SecKeychainSetUserInteractionAllowed(false)
        guard setStatus == errSecSuccess else { throw ClientError.http(Int(setStatus), "Could not access saved credentials") }
        defer { SecKeychainSetUserInteractionAllowed(previous.boolValue) }
        #endif
        return try operation()
    }
}
