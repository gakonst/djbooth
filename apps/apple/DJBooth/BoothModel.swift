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

@MainActor @Observable final class BoothModel {
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
    var syncing = false
    var downloading: Set<String> = []
    var workstationConnected = false
    var workstationTracks: [String: Track] = [:]
    var showSettings = false
    var showImport = false
    var importJobs: [CloudImportJob] = []
    var importError: String?
    var importRefreshError: String?
    var submittingImport = false
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
    func beginAgentTurn(_ input: String) {
        guard cloud != nil, agentPendingID == nil else { return }
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
        agentMessages = []; agentPendingID = nil; agentPendingInput = nil; agentError = nil; cloudCapabilities = []
    }
    var cloudAccountID: String?
    var cloudURL: String
    var workstationURL: String
    let demo: Bool
    private(set) var store: LibraryStore
    private(set) var audio: AudioFiles
    private let syncEngine = SyncEngine()
    private let snapshotDecoder = LibrarySnapshotDecoder()
    private var reloadRequest = UUID()
    private var bootstrap: Bootstrap?
    private var bootstrapEndpoint: String?
    private var cloud: CloudClient?
    private let root: URL
    private var refreshRunning = false
    private var connectionGeneration = UUID()
    private var playbackRequest = UUID()
    private var playbackPreferences: PlaybackSessionPreferences?
    private var playbackSessionReady = false
    private var restoredSavedPlaybackSession = false
    private var lastSessionSave = Date.distantPast
    private var queueCollection: String?
    private var queueFilter = "All music"
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

    init() async throws {
        PerformanceProbe.libraryBegan()
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        var uiTestID: UUID?
        if let index = arguments.firstIndex(of: "--ui-test-library") {
            guard arguments.indices.contains(index + 1), let id = UUID(uuidString: arguments[index + 1]) else {
                throw ClientError.http(400, "UI test library requires a UUID")
            }
            uiTestID = id
        }
        demo = arguments.contains("--demo") || uiTestID != nil
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
        #else
        let uiTestID: UUID? = nil
        demo = false
        #endif
        let initialCloudURL = demo ? "" : (ProcessInfo.processInfo.environment["DJBOOTH_CLOUD_URL"]
            ?? UserDefaults.standard.string(forKey: "cloudURL") ?? "")
        cloudURL = initialCloudURL
        workstationURL = demo ? "http://127.0.0.1:4179" : (UserDefaults.standard.string(forKey: "workstationURL") ?? "http://127.0.0.1:4179")
        let applicationRoot = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DJBooth", isDirectory: true)
        if let uiTestID { root = applicationRoot.appendingPathComponent("UITests").appendingPathComponent(uiTestID.uuidString) }
        else if demo { root = FileManager.default.temporaryDirectory.appendingPathComponent("DJBoothPreview") }
        else { root = applicationRoot }
        // Connection changes never mix cursors, outboxes, or libraries from different servers.
        let initialEndpoint = try? Endpoint(initialCloudURL)
        let savedAccount = initialEndpoint.flatMap { UserDefaults.standard.string(forKey: "cloudAccount:" + $0.scope) }
        cloudAccountID = savedAccount
        let scope = initialEndpoint.flatMap { endpoint in savedAccount.map { endpoint.accountScope($0) } } ?? "local"
        store = try await LibraryStore.open(directory: demo && uiTestID == nil ? nil : root.appendingPathComponent(scope), inMemory: demo && uiTestID == nil)
        audio = try AudioFiles(directory: (scope == "local" ? root.appendingPathComponent("Audio") : root.appendingPathComponent(scope).appendingPathComponent("Audio")), session: PerformanceProbe.serverUnavailableSession)
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
                if savedAccount != nil, let token = try Keychain.read(scope) {
                    cloud = CloudClient(endpoint: endpoint, token: token, session: PerformanceProbe.serverUnavailableSession)
                }
            } catch {
                syncStatus = "Cloud sync needs attention"
                message = "Your local library is available. Cloud sync could not access its saved credentials: \(error.localizedDescription)"
            }
        }
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
        try await reload()
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
            do { try await configureCloud(url: initialCloudURL, token: token) }
            catch { message = error.localizedDescription }
        }
        #endif
        PerformanceProbe.libraryReady(trackCount: tracks.count)
        #if DEBUG
        if demo, arguments.contains("--ui-test-player"), let track = tracks.first(where: { $0.id == "demo-5" }) {
            player.prepare(track, url: nil, queue: tracks)
        }
        #endif
    }
    func reload() async throws {
        let request = UUID(); reloadRequest = request
        let source = store
        while true {
            // SwiftData objects never leave their owning actor. The handoff is
            // immutable strings; waveform JSON and filesystem work runs elsewhere.
            let payloads = try source.payloadSnapshot()
            let snapshot = try await snapshotDecoder.decode(payloads, audioDirectory: audio.directory)
            try Task.checkCancellation()
            guard request == reloadRequest, source === store else { return }
            guard snapshot.revision == source.revision else { continue }
            if tracks != snapshot.tracks { tracks = snapshot.tracks }
            if collections != snapshot.collections { collections = snapshot.collections }
            if favorites != snapshot.favorites { favorites = snapshot.favorites }
            if annotations != snapshot.annotations { annotations = snapshot.annotations }
            if offlineIDs != snapshot.offlineIDs { offlineIDs = snapshot.offlineIDs }
            prunePlaylistRemovalHistory()
            try reloadSyncState()
            if playbackSessionReady { reconcilePlaybackSession() }
            return
        }
    }
    private func reloadSyncState() throws {
        pendingCount = try store.pendingCount(); conflicts = try store.conflicts()
    }
    private func reloadCollections() throws {
        collections = try store.values(.collection, as: Collection.self).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
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
            candidates = members.compactMap { (selectedCollection?.hasPrefix("usb:") == true || seen.insert($0).inserted) ? tracksByID[$0] : nil }
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
        usbDevice = access; usbConnected = true; usbSignature = signature
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
            usbConnected = false
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
            if completed { await synchronize() }
        } catch {
            guard generation == connectionGeneration else { return }
            importRefreshError = error.localizedDescription
        }
    }
    @discardableResult
    func submitImport(_ source: String) async -> Bool {
        guard let cloud, !demo, !submittingImport else { return false }
        submittingImport = true; defer { submittingImport = false }
        let source = source.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = pendingImportKey
        let pending = UserDefaults.standard.dictionary(forKey: key)
        let id = pending?["source"] as? String == source ? (pending?["id"] as? String ?? UUID().uuidString) : UUID().uuidString
        // Persist the request identity before sending, so uncertain responses are safe to retry.
        UserDefaults.standard.set(["id": id, "source": source], forKey: key)
        let generation = connectionGeneration
        do {
            let job = try await cloud.submitImport(id: id, source: source)
            UserDefaults.standard.removeObject(forKey: key)
            guard generation == connectionGeneration else { return false }
            importJobs.removeAll { $0.id == job.id }; importJobs.insert(job, at: 0)
            importError = nil
            return true
        } catch {
            guard generation == connectionGeneration else { return false }
            importError = error.localizedDescription
            return false
        }
    }
    func retryImport(_ job: CloudImportJob) async {
        guard let cloud, !demo, !submittingImport else { return }
        submittingImport = true; defer { submittingImport = false }
        let generation = connectionGeneration
        do {
            let updated = try await cloud.retryImport(id: job.id)
            guard generation == connectionGeneration else { return }
            if let index = importJobs.firstIndex(where: { $0.id == job.id }) { importJobs[index] = updated }
            importError = nil
        } catch { if generation == connectionGeneration { importError = error.localizedDescription } }
    }
    func favorite(_ track: Track) {
        do { try store.toggleFavorite(track.id); favorites = try store.favoriteIDs(); try reloadSyncState() } catch { message = error.localizedDescription }
    }
    func annotation(for track: Track) -> TrackAnnotation { annotations[track.id] ?? TrackAnnotation() }
    func setNote(_ note: String, for track: Track) {
        guard note.utf8.count <= TrackAnnotation.maxNoteUTF8Bytes else {
            message = "This comment is too long. Keep it under 16 KB."; return
        }
        do {
            try store.setNote(note, trackID: track.id)
            try annotationChanged(track.id)
        } catch { message = error.localizedDescription }
    }
    func setColor(_ color: TrackColor?, for track: Track) {
        do {
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
        let ready = playbackSessionReady; playbackSessionReady = false
        update()
        playbackSessionReady = ready; persistPlaybackSession()
    }
    func browse(_ mode: LibraryBrowseMode, group: String? = nil) {
        changeNavigation {
            browseMode = mode; browseGroup = group
            trackSort = mode == .playlists ? "default" : "title"; trackSortAscending = true
            selectedCollection = nil; playlistFolderPath = []; query = ""; filter = "All music"
            showPlaylistBrowser = mode == .playlists
        }
    }
    func showLibrary(filter: String = "All music") {
        pendingQuickAddTrackID = nil; quickAddReturnSession = nil
        changeNavigation { showPlaylistBrowser = false; selectedCollection = nil; self.filter = filter; query = "" }
    }
    func openPlaylistBrowser() {
        changeNavigation { browseMode = .playlists; browseGroup = nil; showPlaylistBrowser = true; selectedCollection = nil; query = "" }
    }
    func openPlaylistFolder(_ path: [String]) {
        changeNavigation {
            browseMode = .playlists; browseGroup = nil
            playlistFolderPath = path; showPlaylistBrowser = true; selectedCollection = nil; query = ""
        }
    }
    func openCollection(_ collection: Collection) {
        guard let current = collections.first(where: { $0.id == collection.id }) else { return }
        if let trackID = pendingQuickAddTrackID {
            do {
                try store.addTrack(trackID, toCollection: current.id); try reloadCollections()
                finishQuickAdd(preferredID: current.id)
            } catch { message = error.localizedDescription }
            return
        }
        changeNavigation {
            browseMode = .playlists; browseGroup = nil
            preferredCollectionID = current.id; selectedCollection = current.id
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
        let previous = quickAddReturnSession?.resolved(tracks: tracks, collections: collections)
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
        guard tracks.contains(where: { $0.id == track.id }) else { return }
        if let target = quickAddTarget { add(track, to: target); return }
        choosePlaylist(for: track)
    }
    func choosePlaylist(for track: Track) {
        guard tracks.contains(where: { $0.id == track.id }) else { return }
        quickAddReturnSession = currentPlaybackSession(); pendingQuickAddTrackID = track.id
        openPlaylistBrowser()
        if collections.isEmpty { showNewCollection = true }
    }
    func createCollection(_ name: String) {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        do {
            let ids = pendingQuickAddTrackID.map { [$0] } ?? []
            let collection = try store.createCollection(name: name, folderPath: playlistFolderPath, trackIDs: ids)
            try reloadCollections()
            if pendingQuickAddTrackID != nil { finishQuickAdd(preferredID: collection.id) }
            else { openCollection(collection) }
        } catch { message = error.localizedDescription }
    }
    func add(_ track: Track, to collection: Collection) {
        do { try store.addTrack(track.id, toCollection: collection.id); try reloadCollections() }
        catch { message = error.localizedDescription }
    }
    func requestRemoval(_ track: Track, from collection: Collection) {
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
        guard !tracks.isEmpty else { return }
        playbackPreferences?.save(currentPlaybackSession())
        lastSessionSave = Date()
    }
    private func localAudioURL(_ track: Track) -> URL? {
        guard offlineIDs.contains(track.id), let hash = track.mediaHash else { return nil }
        return audio.url(hash: hash)
    }
    private func restorePlaybackSession() {
        playbackSessionReady = false
        let previous = playbackPreferences?.load()
        restoredSavedPlaybackSession = previous != nil
        let saved = previous ?? PlaybackSession()
        applyPlaybackSession(saved.resolved(tracks: tracks, collections: collections), replacingItem: true)
        playbackSessionReady = true
        persistPlaybackSession()
    }
    private func reconcilePlaybackSession() {
        let saved = player.track == nil ? (playbackPreferences?.load() ?? currentPlaybackSession()) : currentPlaybackSession()
        let resolved = saved.resolved(tracks: tracks, collections: collections)
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
        guard let canonical = tracksByID[track.id] else { return }
        if !preservingQueue { queueCollection = selectedCollection; queueFilter = filter }
        let queue = preservingQueue ? player.queue : visibleTracks
        let index = queuePosition ?? (preservingQueue ? player.queueIndex : nil)
        await preparePlayback(canonical, queue: queue.contains(where: { $0.id == canonical.id }) ? queue : [canonical] + queue, elapsed: 0, queueIndex: index)
    }
    private func preparePlayback(_ track: Track, queue: [Track], elapsed: Double, queueIndex: Int? = nil) async {
        PerformanceProbe.playRequested(trackID: track.id)
        let request = UUID(); playbackRequest = request
        let generation = connectionGeneration
        // Selection advances immediately, including rapid Next taps and downloads.
        // Resolving the URL later attaches audio to this preparation only once.
        player.prepare(track, url: nil, queue: queue, elapsed: elapsed, queueIndex: queueIndex)
        // Preview gestures select a paused fixture without pretending to acquire audio.
        if demo && !track.id.hasPrefix("usb:") { return }
        do {
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
            } else {
                guard track.id.hasPrefix("usb:") || (track.mediaHash != nil && cloud != nil) else {
                    throw ClientError.http(404, "This recording needs to be acquired on your Mac before it can play here")
                }
                let url = try await offlineAudio(current)
                guard request == playbackRequest, generation == connectionGeneration,
                      player.track?.id == track.id, let latest = tracksByID[track.id] else { return }
                player.track = latest
                player.queue = queue.compactMap { tracksByID[$0.id] }
                player.attach(url: url, autoplay: true)
            }
            if track.waveform == nil { Task { await loadWaveform(track) } }
        } catch { if request == playbackRequest, generation == connectionGeneration, !(error is CancellationError) { message = error.localizedDescription } }
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
    private func offlineAudio(_ track: Track) async throws -> URL {
        let generation = connectionGeneration
        if let hash = track.mediaHash, let file = await audio.existing(hash: hash) { return file }
        guard generation == connectionGeneration else { throw CancellationError() }
        let download: Task<(URL, String), Error>
        if let existing = audioDownloads[track.id] { download = existing }
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
            audioDownloads[track.id] = download; downloading.insert(track.id)
        }
        defer { if generation == connectionGeneration { audioDownloads.removeValue(forKey: track.id); downloading.remove(track.id) } }
        let result = try await download.value
        guard generation == connectionGeneration else { throw CancellationError() }
        if var updated = tracks.first(where: { $0.id == track.id }), updated.mediaHash != result.1 {
            guard updated.mediaHash == nil else { throw ClientError.http(409, "This recording changed while downloading; retry") }
            updated.mediaHash = result.1
            try store.save(updated, kind: .track, id: track.id)
        }
        try await reload()
        return result.0
    }
    func keepCollectionOffline(_ collection: Collection) async {
        let generation = connectionGeneration
        for id in collection.trackIDs {
            if Task.isCancelled || generation != connectionGeneration { break }
            if let track = tracks.first(where: { $0.id == id }) { await keepOffline(track) }
        }
    }
    func loadWaveform(_ track: Track) async {
        if track.id.hasPrefix("usb:") {
            guard track.waveform == nil, !loadingUSBWaveforms.contains(track.id), let access = usbDevice,
                  let location = try? store.usbFile(track.id) else { return }
            loadingUSBWaveforms.insert(track.id); defer { loadingUSBWaveforms.remove(track.id) }
            let generation = connectionGeneration
            do {
                let waveform = try await Task.detached(priority: .utility) {
                    try USBAnalysis.read(location, access: access, duration: track.durationSeconds ?? 0)
                }.value
                guard generation == connectionGeneration, let waveform, var updated = tracksByID[track.id] else { return }
                updated.waveform = waveform
                try store.save(updated, kind: .track, id: track.id)
                try await reload()
                if player.track?.id == track.id { player.track = updated }
            } catch { /* Missing/corrupt optional analysis never interrupts USB playback. */ }
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
        persistPlaybackSession()
        clearAgent()
        workstationConnected = false; workstationTracks = [:]; bootstrap = nil; bootstrapEndpoint = nil
        cloud = nil; cloudAccountID = nil; cloudURL = ""
        UserDefaults.standard.removeObject(forKey: "cloudURL")
        connectionGeneration = UUID(); playbackRequest = UUID()
        for task in audioDownloads.values { task.cancel() }
        audioDownloads.removeAll(); downloading.removeAll()
        player.stop(); selectedCollection = nil
        pendingQuickAddTrackID = nil; quickAddReturnSession = nil
        pendingPlaylistRemoval = nil; playlistRemovalHistory.removeAll()
        importJobs = []; importError = nil; importRefreshError = nil
        tracks = []; collections = []; favorites = []; annotations = [:]; offlineIDs = []
        #if DEBUG
        pendingOfflineTrackID = nil; offlineCollectionID = nil; offlineCollectionSelected = false; offlineLaunchRequestKey = nil
        #endif
        playbackSessionReady = false
        playbackPreferences = PlaybackSessionPreferences(scope: "local")
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
        persistPlaybackSession()
        playbackSessionReady = false
        playbackPreferences = PlaybackSessionPreferences(scope: scope)
        cloudURL = endpoint.url.absoluteString
        clearAgent()
        workstationConnected = false; workstationTracks = [:]; bootstrap = nil; bootstrapEndpoint = nil
        cloudCapabilities = account.capabilities
        cloudAccountID = account.id
        importJobs = []; importError = nil
        cloud = client
        connectionGeneration = UUID(); playbackRequest = UUID()
        #if DEBUG
        let offlineKey = "djbooth.debug.offline.\(scope)"
        offlineLaunchRequestKey = offlineKey
        pendingOfflineTrackID = UserDefaults.standard.string(forKey: offlineKey)
        offlineCollectionID = UserDefaults.standard.string(forKey: "\(offlineKey).collection")
        offlineCollectionSelected = false
        #endif
        for task in audioDownloads.values { task.cancel() }
        audioDownloads.removeAll(); downloading.removeAll()
        player.stop(); selectedCollection = nil
        pendingQuickAddTrackID = nil; quickAddReturnSession = nil
        pendingPlaylistRemoval = nil; playlistRemovalHistory.removeAll()
        tracks = []; collections = []; favorites = []; annotations = [:]; offlineIDs = []
        audio = newAudio
        store = newStore; usbDevice = try store.usbDevice(); usbConnected = false; usbSignature = nil
        try await reload()
        restorePlaybackSession()
        Task { await synchronize() }
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
