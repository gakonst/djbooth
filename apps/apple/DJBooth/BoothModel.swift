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
    var musicPlaylistLoading: Set<String> = []
    var musicPlaylistErrors: [String: String] = [:]
    var musicDownloads: Set<String> = []
    private var musicDownloadIDs: [String: String] = [:]
    func connectedPlaylist(_ id: String) -> MusicPlaylist? { musicCatalog.playlists.first { $0.id == id } }
    func musicIsDownloaded(_ playlist: MusicPlaylist) -> Bool {
        guard let job = importJobs.first(where: { $0.source == playlist.url && $0.status == "complete" }),
              let collection = collections.first(where: { $0.id == job.collectionID }), !collection.trackIDs.isEmpty else { return false }
        return collection.trackIDs.allSatisfy { tracksByID[$0]?.mediaHash != nil }
    }
    func refreshMusic(force: Bool = false) async {
        guard let cloud, !demo, !musicLoading else { return }
        if !force, Date().timeIntervalSince1970 - musicCatalog.fetchedAt < 300 { return }
        let generation = connectionGeneration
        musicLoading = true; defer { if generation == connectionGeneration { musicLoading = false } }
        do {
            let sources = try await cloud.musicSources()
            guard generation == connectionGeneration else { return }
            musicCatalog.sources = sources
            let ids = Set(sources.map(\.id))
            musicCatalog.playlists.removeAll { !ids.contains($0.sourceID) }
            musicCatalog.snapshots = musicCatalog.snapshots.filter { ids.contains($0.value.playlist.sourceID) }
            try store.saveMusicCatalog(musicCatalog); try await reload()
            // One provider page at a time; the broker coordinates quota across all agents/apps.
            var failures: [String] = []
            for source in sources {
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
                } catch {
                    guard generation == connectionGeneration else { return }
                    failures.append(source.providerName + ": " + error.localizedDescription)
                }
            }
            musicCatalog.fetchedAt = Date().timeIntervalSince1970
            try store.saveMusicCatalog(musicCatalog); musicError = failures.isEmpty ? nil : failures.joined(separator: "\n")
        } catch {
            if generation == connectionGeneration {
                if case ClientError.http(let status, _) = error, status == 401 || status == 403 {
                    musicCatalog = MusicCatalog(); musicCatalogLoaded = true; try? store.saveMusicCatalog(musicCatalog)
                    await spotifyStreaming.disconnect(); player.stop(); try? await reload()
                }
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
            try store.saveMusicCatalog(musicCatalog); try await reload(); musicError = nil
            warmSoundCloudStreams(value.tracks, source: source)
        } catch { if generation == connectionGeneration, !Task.isCancelled { musicPlaylistErrors[item.id] = error.localizedDescription } }
    }
    func downloadMusic(_ item: MusicPlaylist) async {
        guard let cloud, let source = musicCatalog.sources.first(where: { $0.id == item.sourceID }), !musicDownloads.contains(item.id) else { return }
        let generation = connectionGeneration
        let id = musicDownloadIDs[item.id] ?? UUID().uuidString
        musicDownloadIDs[item.id] = id
        musicDownloads.insert(item.id); defer { if generation == connectionGeneration { musicDownloads.remove(item.id) } }
        do {
            let job = try await cloud.downloadMusicPlaylist(item, source: source, id: id)
            guard generation == connectionGeneration else { return }
            importJobs.removeAll { $0.id == job.id }; importJobs.insert(job, at: 0)
            showImport = true; importError = nil
        } catch { if generation == connectionGeneration { message = error.localizedDescription } }
    }
    var tracks: [Track] = [] {
        didSet { tracksByID = Dictionary(tracks.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }) }
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
    var crewCrates: [String: CrewCrateDetail] = [:]
    var crewsLoading = false
    var crewError: String?
    var showCrews = false
    var crewTrackToAdd: Track?
    private var refreshingImports = false
    var canImportToCloud: Bool { cloud != nil && !demo }
    private var pendingImportKey: String { "pendingImport:" + cloudStorageScope }
    private var cloudStorageScope: String { guard let endpoint = try? Endpoint(cloudURL), let cloudAccountID else { return "local" }; return endpoint.accountScope(cloudAccountID) }
    var pendingImportSource: String { UserDefaults.standard.dictionary(forKey: pendingImportKey)?["source"] as? String ?? "" }
    var showNewCollection = false
    var player = BoothPlayer()
    var showAgent = false
    var agentMessages: [MusicAgentMessage] = []
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
    func createCrew(_ name: String) async throws {
        guard let cloud else { throw ClientError.http(401, "Connect DJ Booth first") }
        let crew = try await cloud.createCrew(name: name)
        crews.removeAll { $0.id == crew.id }; crews.insert(crew, at: 0)
        crewDetails[crew.id] = try await cloud.crew(crew.id)
        persistCrewCache()
    }
    func acceptCrewInvite(_ value: String, displayName: String = "DJ") async throws {
        guard let cloud else { throw ClientError.http(401, "Connect DJ Booth first") }
        let token = value.split(separator: "/").last.map(String.init) ?? value
        let detail = try await cloud.acceptCrewInvite(token: token.trimmingCharacters(in: .whitespacesAndNewlines), displayName: displayName)
        crewDetails[detail.crew.id] = detail
        persistCrewCache()
        await refreshCrews()
    }
    func loadCrew(_ id: String) async {
        guard let cloud else { return }
        do { crewDetails[id] = try await cloud.crew(id); crewError = nil; persistCrewCache() }
        catch { if !(error is CancellationError) { crewError = error.localizedDescription } }
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
        do { crewCrates[crateID] = try await cloud.crewCrate(crewID: crewID, crateID: crateID); crewError = nil; persistCrewCache() }
        catch { if !(error is CancellationError) { crewError = error.localizedDescription } }
    }
    func addToCrew(_ track: Track, crewID: String, crateID: String) async throws {
        guard let cloud else { throw ClientError.http(401, "Connect DJ Booth first") }
        crewCrates[crateID] = try await cloud.addCrewTrack(crewID: crewID, crateID: crateID, track: track)
        persistCrewCache()
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
        guard let cloud else { throw ClientError.http(401, "Connect DJ Booth first") }
        crewCrates[crateID] = try await cloud.moveCrewTrack(crewID: crewID, crateID: crateID, itemID: itemID, afterItemID: afterItemID)
        persistCrewCache()
    }
    func inviteToCrew(_ crewID: String) async throws -> CrewInvite {
        guard let cloud else { throw ClientError.http(401, "Connect DJ Booth first") }
        return try await cloud.createCrewInvite(crewID: crewID)
    }
    func localTrack(for item: CrewCrateItem) -> Track? {
        tracksByID[item.localTrackID ?? item.recordingID]
            ?? tracks.first { item.assetHash != nil && $0.mediaHash == item.assetHash }
    }
    func beginCrewAdd(_ track: Track) {
        crewTrackToAdd = track; showCrews = true
    }
    func addPendingTrack(crewID: String, crateID: String) async throws {
        guard let track = crewTrackToAdd else { return }
        try await addToCrew(track, crewID: crewID, crateID: crateID)
        crewTrackToAdd = nil; showCrews = false
    }
    private func persistCrewCache() {
        try? store.saveCrewCache(CrewCache(crews: crews, details: crewDetails, crates: crewCrates))
    }
    func beginAgentTurn(_ input: String) {
        guard cloud != nil, phoneToolsReady, agentPendingID == nil else { return }
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= 16000 else { return }
        agentMessages.append(MusicAgentMessage(role: "You", text: text))
        agentPendingInput = text; agentPendingID = UUID().uuidString
        agentError = nil
    }
    func observeAgentTurn() async {
        guard let cloud, let id = agentPendingID else { return }
        let generation = connectionGeneration
        do {
            var turn = try await cloud.agentTurn(id: id, input: agentPendingInput)
            guard generation == connectionGeneration, agentPendingID == id else { return }
            agentPendingInput = nil
            while !Task.isCancelled {
                guard generation == connectionGeneration, agentPendingID == id else { return }
                if turn.status == "completed" {
                    agentMessages.append(MusicAgentMessage(role: "DJ Booth", text: turn.finalMessage ?? "No reply was shared by this connection."))
                    agentPendingID = nil; agentError = nil; return
                }
                if turn.status == "failed" || turn.status == "cancelled" {
                    agentError = turn.status == "cancelled" ? nil : (turn.error ?? "Your agent stopped.")
                    agentPendingID = nil; return
                }
                try await Task.sleep(for: .seconds(1))
                turn = try await cloud.agentTurn(id: id)
            }
        } catch {
            if !Task.isCancelled, generation == connectionGeneration, agentPendingID == id { agentError = error.localizedDescription }
        }
    }
    func cancelAgentTurn() async {
        guard let cloud, let id = agentPendingID else { return }
        let generation = connectionGeneration
        do {
            _ = try await cloud.agentTurn(id: id, cancel: true)
            guard generation == connectionGeneration, agentPendingID == id else { return }
            agentPendingInput = nil; agentError = nil; agentRetry += 1
        } catch { if generation == connectionGeneration { agentError = error.localizedDescription } }
    }
    private func clearAgent() {
        stopPhoneTools(); phoneToolsError = nil
        accountConnectionID = UUID()
        agentMessages = []; agentPendingID = nil; agentPendingInput = nil; agentError = nil; cloudCapabilities = []
    }
    func servePhoneTools() async {
        guard let cloud else { return }
        let generation = connectionGeneration
        let runID = UUID(); phoneToolsRunID = runID
        await phoneToolHost.run(client: cloud, status: { [weak self] ready, error in
            guard let self, self.connectionGeneration == generation, self.phoneToolsRunID == runID else { return }
            self.phoneToolsReady = ready
            self.phoneToolsError = error
        }, query: { [weak self] arguments, budget in
            guard let self, self.connectionGeneration == generation, self.phoneToolsRunID == runID, self.cloud != nil else {
                throw ClientError.http(401, "This phone is no longer connected to that account")
            }
            return try self.phoneLibraryQuery().execute(arguments, byteBudget: budget)
        })
        if connectionGeneration == generation, phoneToolsRunID == runID { phoneToolsReady = false }
    }
    func stopPhoneTools() { phoneToolsRunID = UUID(); phoneToolHost.stop(); phoneToolsReady = false }
    private func phoneLibraryQuery() -> PhoneLibraryQuery {
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
        usbDevice = try store.usbDevice()
        if snapshot.revision == store.revision {
            try applyLibrarySnapshot(snapshot, metadataOnly: true)
        } else {
            // A new demo library may have been seeded after preparation.
            try await reload(metadataOnly: true)
        }
        player.onStateChange = { [weak self] force in self?.persistPlaybackSession(force: force) }
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
        if collections != availableCollections { collections = availableCollections }
        if favorites != snapshot.favorites { favorites = snapshot.favorites }
        if annotations != snapshot.annotations { annotations = snapshot.annotations }
        let availableOffline = snapshot.offlineIDs.filter { !$0.hasPrefix("usb:") }
        if offlineIDs != availableOffline { offlineIDs = availableOffline }
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
