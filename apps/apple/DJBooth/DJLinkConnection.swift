#if os(iOS)
import SwiftUI
import DJBoothKit
import Network

struct DJLinkInterface: Codable, Identifiable, Sendable, Equatable {
    let name, ip, broadcast, netmask: String
    let index: UInt32
    var id: String { "\(name):\(index):\(ip):\(netmask)" }
}
struct DJLinkStatus: Decodable, Sendable {
    struct Device: Decodable, Identifiable, Sendable {
        let player: Int
        let ip, model: String
        var id: String { "\(ip):\(player)" }
        var isOmnis: Bool { model.uppercased() == "OMNIS-DUO" }
        var displayPlayer: Int { isOmnis && (11...12).contains(player) ? player - 10 : player }
    }
    var running: Bool
    var ip: String?
    var trackCount: Int?
    var playlistCount: Int?
    var devices: [Device]?
    /// Discovery identifies appliances; monitoring and selection identify decks.
    var deckDevices: [Device] {
        (devices ?? []).flatMap { device -> [Device] in
            if device.isOmnis {
                return [11, 12].map { Device(player: $0, ip: device.ip, model: device.model) }
            }
            return (1...6).contains(device.player) ? [device] : []
        }.sorted { $0.player < $1.player }
    }
}
struct DJLinkDeck: Identifiable, Equatable, Sendable {
    let state: DJLinkDeckState
    let model: String
    let libraryTrackID: String?
    var waveform: Waveform? = nil
    var libraryKey: String? = nil
    var observedAt: Double = ProcessInfo.processInfo.systemUptime
    var id: Int { state.player }
    func presentationTrack(in tracks: [String: Track]) -> Track? {
        guard let trackID = state.track_id else { return nil }
        var track = libraryTrackID.flatMap { tracks[$0] }
            ?? Track(id: "deck-\(id)-\(state.source_player)-\(state.source_slot)-\(trackID)", title: "Track \(trackID)", durationSeconds: state.track_length_sec.map(Double.init))
        // Deck displays use only the ANLZ waveform decoded by shared Rust.
        // Never inherit the cloud track's overview, including while loading.
        track.waveform = waveform.flatMap { $0.peaks.isEmpty ? nil : $0 }
        track.key = libraryKey ?? track.key
        return track
    }
}
private struct LinkError: LocalizedError { let message: String; var errorDescription: String? { message } }

/// Serializes C ABI calls and disk preparation away from the UI actor.
private actor DJLinkEngine {
    private var bindingsVerified = false
    private var directory: URL?
    private var preparation = UUID()
    private var presentationByDeck: [Int: (track: UInt32?, canonical: String?, waveform: Waveform?, key: String?)] = [:]
    private var previousDecks: [DJLinkDeck] = []
    private func request<T: Decodable>(_ operation: String, input: String = "{}", as type: T.Type) throws -> T {
        try DJLinkBindings.decode(operation, input: input, as: type)
    }
    func interfaces(excluding excludedNames: [String]) async throws -> ([DJLinkInterface], DJLinkInterface?) {
        await AppDiagnostics.shared.ready()
        if !bindingsVerified { try DJLinkBindings.verifyInventory(); bindingsVerified = true }
        let available = try request("interfaces", as: [DJLinkInterface].self)
        struct Selection: Encodable {
            let interfaces: [DJLinkInterface]
            let excluded_names: [String]
        }
        let input = try JSONEncoder().encode(Selection(interfaces: available, excluded_names: excludedNames))
        let selected = try request("function.select_djlink_interface", input: String(decoding: input, as: UTF8.self), as: DJLinkInterface?.self)
        return (available, selected)
    }
    private var mixerSubscription: UInt64?
    private var mixers: [String: DJLinkMixerObservation] = [:]
    func midiStatus() throws -> [DJLinkMIDIMixer] {
        try request("midi.snapshot", as: [DJLinkMIDIMixer].self)
    }
    private func mixerStatus() throws -> [String: DJLinkMixerObservation] {
        if mixerSubscription == nil {
            mixerSubscription = try request("server.subscribe_mixer_telemetry", as: UInt64.self)
        }
        guard let subscription = mixerSubscription else { return mixers }
        struct Events: Decodable { let events: [DJLinkMixerEvent]; let lagged: Int; let closed: Bool }
        let batch = try request("server.poll_events", input: "{\"subscription\":\(subscription),\"limit\":128}", as: Events.self)
        let now = ProcessInfo.processInfo.systemUptime
        for event in batch.events {
            if mixers[event.source_ip] == nil {
                AppDiagnostics.shared.event("cdj_mixer_telemetry_started", ["ip": event.source_ip])
            }
            mixers[event.source_ip] = DJLinkMixerObservation(event: event, receivedAt: now)
        }
        if batch.lagged > 0 {
            AppDiagnostics.shared.event("cdj_mixer_telemetry_lagged", ["count": String(batch.lagged)])
        }
        if batch.closed {
            _ = try request("server.unsubscribe", input: "{\"subscription\":\(subscription)}", as: Bool.self)
            mixerSubscription = nil
            mixers.removeAll()
        }
        return mixers
    }
    func status() throws -> (DJLinkStatus, [DJLinkDeck], [String: DJLinkMixerObservation]) {
        let status = try request("status", as: DJLinkStatus.self)
        guard status.running else { previousDecks = []; return (status, [], [:]) }
        struct Snapshot: Decodable { let deck: DJLinkDeckState? }
        struct Metadata: Decodable { let track_id: UInt32; let key: String? }
        var decks: [DJLinkDeck] = []
        for device in status.deckDevices {
            let observedAt = ProcessInfo.processInfo.systemUptime
            let snapshot = try request("server.monitor_snapshot", input: "{\"player\":\(device.player)}", as: Snapshot.self)
            guard let state = snapshot.deck else { continue }
            // USB mobile browsing can report the deck itself as source_player.
            // Resolve identity through the same Rust library lookup as the web booth.
            var canonical: String?
            var waveform: Waveform?
            var key: String?
            if let known = presentationByDeck[state.player], known.track == state.track_id {
                canonical = known.canonical
                waveform = known.waveform
                key = known.key
            } else if let id = state.track_id {
                let metadata = try request("server.library_track_metadata", input: "{\"track_id\":\(id)}", as: Metadata?.self)
                canonical = metadata.flatMap { metadata in cached?.tracks.first { $0.trackId == metadata.track_id }?.canonicalName }
                key = metadata?.key.flatMap { $0.isEmpty ? nil : $0 }
                waveform = try request("server.library_waveform", input: "{\"track_id\":\(id)}", as: DJLinkWaveform?.self)?.waveform
            }
            presentationByDeck[state.player] = (state.track_id, canonical, waveform, key)
            // Repeated cached snapshots must not renew a stalled render clock.
            let previous = previousDecks.first { $0.id == state.player && $0.state == state }
            decks.append(DJLinkDeck(state: state, model: device.model, libraryTrackID: canonical, waveform: waveform,
                                    libraryKey: key, observedAt: previous?.observedAt ?? observedAt))
        }
        previousDecks = decks
        do {
            return (status, decks, try mixerStatus())
        } catch {
            // An optional mixer stream must not interrupt track serving.
            AppDiagnostics.shared.event("cdj_mixer_telemetry_failed", ["error": error.localizedDescription])
            if let subscription = mixerSubscription {
                _ = try? request("server.unsubscribe", input: "{\"subscription\":\(subscription)}", as: Bool.self)
            }
            mixerSubscription = nil
            mixers.removeAll()
            return (status, decks, [:])
        }
    }
    private struct Prepared {
        let revision = UUID()
        let source: [Track]
        let collections: [Collection]
        let folderNames: [String: String]
        let annotations: [String: TrackAnnotation]
        let audio: URL
        let availableArtifacts: Set<String>
        let tracks: [DJLinkLibrary.TrackRow]
        let playlists: [DJLinkLibrary.PlaylistRow]
        let omitted: Int
    }
    private var cached: Prepared?
    private var publishedRevision: UUID?
    func recordingLibrary() throws -> Data {
        try JSONEncoder().encode(cached?.tracks ?? [])
    }
    private var folder: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DJBooth-DJLink/v1", isDirectory: true)
    }
    @discardableResult
    func warm(tracks: [Track], collections: [Collection], folderNames: [String: String], annotations: [String: TrackAnnotation], audio: URL) async throws -> Bool {
        await AppDiagnostics.shared.ready()
        return try !prepare(tracks: tracks, collections: collections, folderNames: folderNames, annotations: annotations, audio: audio).tracks.isEmpty
    }
    private func prepare(tracks: [Track], collections: [Collection], folderNames: [String: String], annotations: [String: TrackAnnotation], audio: URL) throws -> Prepared {
        // Only fields consumed by DJLinkLibrary invalidate this projection.
        // UI waveform hydration, download flags and sync timestamps do not.
        let source = tracks.map {
            Track(id: $0.id, title: $0.title, artist: $0.artist, album: $0.album, genre: $0.genre,
                  key: $0.key, bpm: $0.bpm, durationSeconds: $0.durationSeconds,
                  mediaHash: $0.mediaHash, mediaExtension: $0.mediaExtension, analysis: $0.analysis,
                  artworkHash: $0.artworkHash)
        }.sorted { $0.id < $1.id }
        let collectionSource = collections.map {
            Collection(id: $0.id, name: $0.name, trackIDs: $0.trackIDs, folderPath: $0.folderPath)
        }
        let annotationSource = annotations.filter { !$0.value.note.isEmpty }
            .mapValues { TrackAnnotation(note: $0.note) }
        // Detect downloads/evictions even when their library metadata is unchanged.
        let availableArtifacts = Set(try FileManager.default.contentsOfDirectory(atPath: audio.path)
            .filter { $0.hasSuffix(".audio") })
        if let cached, cached.source == source, cached.collections == collectionSource,
           cached.folderNames == folderNames,
           cached.availableArtifacts == availableArtifacts,
           cached.annotations == annotationSource, cached.audio == audio,
           cached.tracks.allSatisfy({ row in
               [row.mountPath, row.analysisDatPath, row.analysisExtPath, row.analysisTwoexPath]
                   .compactMap { $0 }.allSatisfy { FileManager.default.fileExists(atPath: $0) }
           }) {
            AppDiagnostics.shared.event("cdj_library_cache_hit", ["tracks": String(cached.tracks.count)])
            return cached
        }
        if let cached {
            AppDiagnostics.shared.event("cdj_library_cache_miss", [
                "tracks_changed": String(cached.source != source),
                "playlists_changed": String(cached.collections != collectionSource),
                "notes_changed": String(cached.annotations != annotationSource),
                "artifacts_changed": String(cached.availableArtifacts != availableArtifacts),
                "audio_directory_changed": String(cached.audio != audio)
            ])
        }
        let began = ProcessInfo.processInfo.systemUptime
        let library = try DJLinkLibrary.prepare(tracks: tracks, collections: collections, annotations: annotations,
                                               audioDirectory: audio, sessionDirectory: folder, folderNames: folderNames, idForIdentity: { identity in
            let input = try JSONEncoder().encode(["value": identity])
            return try self.request("function.stable_text_id", input: String(decoding: input, as: UTF8.self), as: UInt32.self)
        })
        struct Prepare: Encodable { let audioPath, outputDirectory: String }
        struct Analysis: Decodable { let dat, ext, twoEx: String }
        var ready = library.tracks
        for index in ready.indices {
            try Task.checkCancellation()
            let audio = URL(fileURLWithPath: ready[index].mountPath)
            let output = URL(fileURLWithPath: ready[index].analysisDatPath!).deletingLastPathComponent()
            let input = try JSONEncoder().encode(Prepare(audioPath: audio.path, outputDirectory: output.path))
            let analysis = try request("relocateAnalysis", input: String(decoding: input, as: UTF8.self), as: Analysis.self)
            ready[index].analysisDatPath = analysis.dat
            ready[index].analysisExtPath = analysis.ext
            ready[index].analysisTwoexPath = analysis.twoEx
        }

        let prepared = Prepared(source: source, collections: collectionSource, folderNames: folderNames, annotations: annotationSource, audio: audio,
                                availableArtifacts: availableArtifacts,
                                tracks: ready, playlists: library.playlists, omitted: library.omittedTracks)
        cached = prepared
        AppDiagnostics.shared.event("cdj_library_ready", ["tracks": String(ready.count), "duration_ms": String(Int((ProcessInfo.processInfo.systemUptime - began) * 1000))])
        return prepared
    }
    func start(interface: DJLinkInterface, unicastDiscovery: Bool, tracks: [Track], collections: [Collection], folderNames: [String: String], annotations: [String: TrackAnnotation], audio: URL) async throws -> (DJLinkStatus, Int) {
        await AppDiagnostics.shared.ready()
        guard directory == nil else { throw LinkError(message: "Disconnect before reconnecting.") }
        let generation = UUID(); preparation = generation
        let library = try prepare(tracks: tracks, collections: collections, folderNames: folderNames, annotations: annotations, audio: audio)
        guard !library.tracks.isEmpty else { throw LinkError(message: "No downloaded tracks with DJ Link analysis are available on this iPhone.") }
        guard generation == preparation, !Task.isCancelled else { throw CancellationError() }
        struct Start: Encodable {
            let bindIp, broadcastIp: String
            let unicastDiscovery: Bool
            let stagehandMonitor: Bool
            let diagnostics: Bool
            let discoveryCachePath: String
            let tracks: [DJLinkLibrary.TrackRow]
            let playlists: [DJLinkLibrary.PlaylistRow]
        }
        #if DEBUG
        let diagnostics = true
        #else
        let diagnostics = false
        #endif
        let data = try JSONEncoder().encode(Start(bindIp: interface.ip, broadcastIp: interface.broadcast,
                                                 unicastDiscovery: unicastDiscovery,
                                                 stagehandMonitor: true,
                                                 diagnostics: diagnostics,
                                                 discoveryCachePath: folder.appendingPathComponent("discovery-peers.json").path,
                                                 tracks: library.tracks, playlists: library.playlists))
        let status = try request("start", input: String(decoding: data, as: UTF8.self), as: DJLinkStatus.self)
        directory = folder
        publishedRevision = library.revision
        return (status, library.omitted)
    }
    func refreshLibrary(tracks: [Track], collections: [Collection], folderNames: [String: String],
                        annotations: [String: TrackAnnotation], audio: URL) throws -> Int {
        guard directory != nil else { throw LinkError(message: "DJ Link is not running.") }
        let library = try prepare(tracks: tracks, collections: collections, folderNames: folderNames, annotations: annotations, audio: audio)
        try publish(library)
        return library.omitted
    }
    private func publish(_ library: Prepared) throws {
        guard publishedRevision != library.revision else { return }
        // Publish new downloads without restarting the source or invalidating
        // files already in use by the other deck.
        struct Snapshot: Encodable {
            let master_db_id = 1
            let tracks_by_id: [String: DJLinkLibrary.TrackRow]
            let all_tracks: [DJLinkLibrary.TrackRow]
            let playlists: [DJLinkLibrary.PlaylistRow]
        }
        struct Refresh: Encodable { let library: Snapshot }
        struct Refreshed: Decodable { let tracks: Int }
        let snapshot = Snapshot(tracks_by_id: Dictionary(uniqueKeysWithValues: library.tracks.map { (String($0.trackId), $0) }),
                                all_tracks: library.tracks, playlists: library.playlists)
        let refresh = try JSONEncoder().encode(Refresh(library: snapshot))
        _ = try request("server.refresh_library", input: String(decoding: refresh, as: UTF8.self), as: Refreshed.self)
        publishedRevision = library.revision
        presentationByDeck.removeAll()
        AppDiagnostics.shared.event("cdj_library_published", ["tracks": String(library.tracks.count), "playlists": String(library.playlists.count)])
    }
    func load(trackID: String, device: DJLinkStatus.Device, tracks: [Track], collections: [Collection],
              folderNames: [String: String], annotations: [String: TrackAnnotation], audio: URL) throws {
        guard directory != nil else { throw LinkError(message: "Turn on Share over Wi-Fi before loading a deck.") }
        let library = try prepare(tracks: tracks, collections: collections, folderNames: folderNames, annotations: annotations, audio: audio)
        guard let track = library.tracks.first(where: { $0.canonicalName == trackID }) else {
            throw LinkError(message: "Keep this track on your iPhone with its DJ Link analysis before loading it onto a deck.")
        }
        try publish(library)
        let (current, decks, _) = try status()
        guard current.running, current.deckDevices.contains(where: { $0.id == device.id }),
              let deck = decks.first(where: { $0.id == device.player }) else {
            throw LinkError(message: "The deck is no longer connected. Wait for its status before loading.")
        }
        guard !deck.state.playing else { throw LinkError(message: "Pause this deck before loading another track.") }
        struct Interval: Encodable { let secs = 0; let nanos = 250_000_000 }
        struct Load: Encodable {
            let target_player: Int
            let track_id: UInt32
            let source_player: Int? = nil
            let source_slot = 4
            let source_track_type = 1
            let `repeat` = 1
            let interval = Interval()
        }
        let input = try JSONEncoder().encode(Load(target_player: device.player, track_id: track.trackId))
        // Rust maps OMNIS 11/12 to physical 1/2 and confirms the requested
        // track/source on that exact deck. This never sends Play.
        _ = try request("server.send_load_track", input: String(decoding: input, as: UTF8.self), as: Int.self)
    }
    func stop() throws {
        presentationByDeck.removeAll()
        mixerSubscription = nil
        mixers.removeAll()
        preparation = UUID()
        _ = try request("stop", as: DJLinkStatus.self)
        directory = nil
        publishedRevision = nil
    }
}

@MainActor @Observable final class DJLinkConnection {
    // Explicit development-only unattended hardware run. Keep the phone awake
    // before IPv4 assignment too, so auto-lock cannot end the discovery test.
    private var unattendedHardwareTest: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("--dj-link-hardware-test")
        #else
        false
        #endif
    }
    var broadcastEnabled: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return Bundle.main.object(forInfoDictionaryKey: "DJBoothLinkEnabled") as? String == "YES"
        #endif
    }
    var interfaces: [DJLinkInterface] = []
    var selectedIP = ""
    // Opt-in: never advertise the phone's library on Wi-Fi just by launching the app.
    var wifiEnabled = false
    var status = DJLinkStatus(running: false)
    var decks: [DJLinkDeck] = []
    var mixers: [String: DJLinkMixerObservation] = [:]
    var selectedMixerIP: String?
    var midiMixers: [DJLinkMIDIMixer] = []
    private var midiInput: BoothMIDIInput?
    private var nextMIDIAt: TimeInterval = 0
    private var midiFailure: String?
    func mixerPercent(_ control: String, networkValue: UInt8?) -> Double? {
        if let midi = midiMixers.first(where: { $0.mixer.connected }),
           let percent = midi.mixer.controls[control]?.percent {
            return percent
        }
        return networkValue.map { Double($0) / 255 * 100 }
    }
    // 0 means explicitly unassigned. Player/channel matching is a default,
    // not an assertion about the user's physical audio wiring.
    private var channelAssignments: [Int: Int] = [:]
    var detectedDecks: [DJLinkStatus.Device] {
        status.deckDevices
    }
    func playerLabel(_ player: Int) -> String {
        guard let device = detectedDecks.first(where: { $0.player == player }), device.isOmnis else {
            return "Player \(player)"
        }
        return "OMNIS · Deck \(device.displayPlayer)"
    }
    var selectedMixer: DJLinkMixerObservation? {
        if let selectedMixerIP { return mixers[selectedMixerIP] }
        let ordered = mixers.keys.sorted().compactMap { mixers[$0] }
        return ordered.first { $0.isFresh(at: ProcessInfo.processInfo.systemUptime) } ?? ordered.first
    }
    func mixerChannel(for player: Int) -> Int? {
        let channel = channelAssignments[player] ?? ((1...4).contains(player) ? player : 0)
        return channel == 0 ? nil : channel
    }
    func assignMixerChannel(_ channel: Int?, to player: Int) {
        channelAssignments[player] = channel ?? 0
    }
    var selectedPlayer: Int?
    var showingPhonePlayer = false
    var cableDetected: Bool { !wiredNames.isEmpty || !usbWiredNames.isEmpty }
    var waitingForWiredAddress: Bool { cableDetected && automaticInterface == nil }
    /// Presentation only. Never suggest a Wi-Fi, Mac USB, or routed-network
    /// address: a real deck must have answered on this selected interface.
    var wiredSetupInterface: DJLinkInterface? {
        guard status.running, !detectedDecks.isEmpty,
              let interface = interfaces.first(where: { $0.id == activeInterfaceID }),
              interface.ip.hasPrefix("169.254."), interface.netmask == "255.255.0.0" else { return nil }
        return interface
    }
    var selectedDeck: DJLinkDeck? {
        let selected = DJLinkDeckState.selected(in: decks.map(\.state), preferred: selectedPlayer)
        return decks.first { $0.id == selected?.player }
    }
    var busy = false
    var error: String?
    var libraryRefreshError: String?
    var loadingTrackID: String?
    func load(_ track: Track, on device: DJLinkStatus.Device, model: BoothModel) async -> Bool {
        guard loadingTrackID == nil, !busy else { return false }
        let request = generation
        loadingTrackID = track.id
        defer { loadingTrackID = nil }
        do {
            guard status.running, let deck = decks.first(where: { $0.id == device.player }) else {
                throw LinkError(message: "Wait for the deck to connect before loading a track.")
            }
            guard !deck.state.playing else { throw LinkError(message: "Pause this deck before loading another track.") }
            guard !model.demo else { throw LinkError(message: "Demo decks cannot receive music. Connect your OMNIS to load a track.") }
            try await engine.load(trackID: track.id, device: device, tracks: model.tracks,
                                  collections: model.playlistCollections, folderNames: model.pairedMac.folderNames,
                                  annotations: model.annotations, audio: model.audio.directory)
            guard generation == request, !Task.isCancelled else { return false }
            selectedPlayer = device.player
            showingPhonePlayer = false
            nextStatusAt = 0
            await autoConnect(model: model)
            return true
        } catch {
            if generation == request, !(error is CancellationError) { model.message = error.localizedDescription }
            return false
        }
    }
    var waitingForLibrary = false
    var omittedTracks = 0
    private var wiredNames: Set<String> = []
    private var wirelessNames: Set<String> = ["en0"]
    private var automaticInterface: DJLinkInterface?
    private var usbWiredNames: Set<String> = []
    private let wiredMonitor = NWPathMonitor()
    private let usbMonitor = NWPathMonitor(requiredInterfaceType: .other)
    private weak var monitoredModel: BoothModel?
    private var lifecycle = DJLinkLifecycle()
    private var activeInterfaceID: String?
    private var monitorGeneration = UUID()
    private var checking = false
    private var checkAgain = false
    private var nextStatusAt: TimeInterval = 0
    private var nextLibraryAt: TimeInterval = 0
    private var nextInterfaceAt: TimeInterval = 0
    private var reportedInterfaces = ""
    private var reportedAutomaticState = ""
    private var generation = UUID()
    private let engine = DJLinkEngine()
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var backgroundExpired = false
    private var backgroundGeneration = UUID()
    private var backgroundAudio = false
    let recording = BoothRecordingController()
    func recordingLibrary() async throws -> Data { try await engine.recordingLibrary() }
    private var hasBackgroundAudio: Bool { backgroundAudio || recording.capturingAudio }
    func recordingChanged(_ active: Bool) {
        if active && recording.capturingAudio { backgroundExpired = false; endBackgroundTime() }
        else if UIApplication.shared.applicationState == .background { extendBackgroundSession() }
    }
    private var lastMonitorAt = ProcessInfo.processInfo.systemUptime
    private var canRun: Bool {
        UIApplication.shared.applicationState != .background || backgroundTask != .invalid || hasBackgroundAudio
    }

    #if DEBUG && targetEnvironment(simulator)
    /// Explicit UI-test fixture only; it never starts or advertises a Rust server.
    func installPreviewDecks() throws {
        func deck(_ player: Int, playing: Bool) throws -> DJLinkDeckState {
            let row: [String: Any] = ["player": player, "active": true, "source_player": 17,
                "source_slot": 4, "track_type": 1, "track_id": player, "playing": playing,
                "play_state": playing ? "playing" : "paused", "synced": false,
                "tempo_master": playing, "bpm_hundreds": 12800, "effective_bpm_hundreds": 12800,
                "pitch_centi_percent": 0, "beat_in_bar": 1, "playhead_ms": 45000,
                "track_length_sec": 240, "track_progress_milli": 188,
                "master_tempo": true, "key_shift_cents": player == 2 ? 200 : 0,
                "effective_key": player == 2 ? "D" : "C"]
            return try JSONDecoder().decode(DJLinkDeckState.self, from: JSONSerialization.data(withJSONObject: row))
        }
        decks = [DJLinkDeck(state: try deck(1, playing: false), model: "CDJ-3000", libraryTrackID: "demo-5"),
                 DJLinkDeck(state: try deck(2, playing: true), model: "CDJ-3000", libraryTrackID: "demo-7")]
        if ProcessInfo.processInfo.arguments.contains("--ui-test-six-decks") {
            for player in 3...6 {
                decks.append(DJLinkDeck(state: try deck(player, playing: false), model: "CDJ-3000", libraryTrackID: "demo-5"))
            }
            let channels: [[String: Int]] = (1...4).map { channel in
                ["channel": channel, "input_source": 1, "trim": 128, "eq_high": channel == 1 ? 255 : 128,
                 "eq_mid": 128, "eq_low": channel == 1 ? 0 : 128, "color": 128,
                 "fader": 255, "crossfader_assign": 1]
            }
            let event = try JSONDecoder().decode(DJLinkMixerEvent.self, from: JSONSerialization.data(withJSONObject:
                ["source_ip": "192.0.2.33", "mixer": ["channels": channels, "crossfader": 128]]))
            mixers[event.source_ip] = DJLinkMixerObservation(event: event, receivedAt: ProcessInfo.processInfo.systemUptime)
        }
        if !ProcessInfo.processInfo.arguments.contains("--ui-test-missing-deck-waveform") {
            for index in decks.indices {
                decks[index].waveform = Waveform(peaks: [0.25, 0.75, 1, 0.5],
                    colors: [[255, 0, 0], [0, 255, 0], [0, 128, 255], [255, 128, 0]],
                    source: "rekordbox", durationSeconds: 240)
            }
        }
        status = DJLinkStatus(running: true, trackCount: decks.count, devices: decks.map {
            DJLinkStatus.Device(player: $0.id, ip: "192.0.2.\($0.id)", model: $0.model)
        })
        if ProcessInfo.processInfo.arguments.contains("--ui-test-omnis") {
            decks = [DJLinkDeck(state: try deck(11, playing: false), model: "OMNIS-DUO", libraryTrackID: "demo-5", waveform: decks.first?.waveform),
                     DJLinkDeck(state: try deck(12, playing: true), model: "OMNIS-DUO", libraryTrackID: "demo-7", waveform: decks.last?.waveform)]
            status = DJLinkStatus(running: true, trackCount: 2, devices: [
                DJLinkStatus.Device(player: 11, ip: "192.0.2.11", model: "OMNIS-DUO")
            ])
        }
        if ProcessInfo.processInfo.arguments.contains("--ui-test-missing-deck-status") {
            decks.removeLast()
        }
    }
    #endif

    func sceneChanged(background: Bool, audioPlaying: Bool) {
        backgroundAudio = audioPlaying
        if background {
            extendBackgroundSession()
        } else {
            backgroundExpired = false
            endBackgroundTime()
            if let model = monitoredModel {
                // An unexpected suspension can leave BSD sockets defunct even
                // when iOS did not deliver the background expiration callback.
                let wasSuspended = ProcessInfo.processInfo.systemUptime - lastMonitorAt > 3
                Task {
                    if wasSuspended && self.status.running { await self.disconnect() }
                    await self.autoConnect(model: model)
                }
            }
        }
    }
    func audioPlaybackChanged(_ playing: Bool) {
        backgroundAudio = playing
        if UIApplication.shared.applicationState == .background { extendBackgroundSession() }
    }
    private func extendBackgroundSession() {
        guard status.running || busy, !hasBackgroundAudio, backgroundTask == .invalid else { return }
        guard !backgroundExpired else {
            Task { await self.disconnect(message: "Reopen DJBooth to reconnect your decks.") }
            return
        }
        let request = UUID(); backgroundGeneration = request
        backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "DJ Link connection") { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.backgroundGeneration == request,
                      UIApplication.shared.applicationState == .background else { return }
                self.backgroundExpired = true
                AppDiagnostics.shared.event("cdj_background_time_expired")
                if !self.hasBackgroundAudio {
                    await self.disconnect(message: "iOS paused the CDJ connection. Keep DJBooth open for uninterrupted playback.")
                }
                self.endBackgroundTime()
            }
        }
        AppDiagnostics.shared.event("cdj_background_time_started", ["granted": String(backgroundTask != .invalid)])
        if backgroundTask == .invalid {
            backgroundExpired = true
            Task { await self.disconnect(message: "Keep DJBooth open for uninterrupted deck playback.") }
        }
    }
    private func endBackgroundTime() {
        guard backgroundTask != .invalid else { return }
        backgroundGeneration = UUID()
        let task = backgroundTask; backgroundTask = .invalid
        UIApplication.shared.endBackgroundTask(task)
    }

    init() {
        let changed: @Sendable (NWPath, Bool) -> Void = { [weak self] path, usb in
            let names = Set(path.availableInterfaces.filter { $0.type == .wiredEthernet }.map(\.name))
            AppDiagnostics.shared.event("cdj_network_path", [
                "status": String(describing: path.status),
                "interfaces": path.availableInterfaces.map { "\($0.name):\($0.type)" }.joined(separator: ", ")
            ])
            Task { @MainActor [weak self] in
                if usb { self?.usbWiredNames = names } else {
                    self?.wiredNames = names
                    self?.wirelessNames = Set(path.availableInterfaces.filter {
                        $0.type == .wifi || $0.type == .cellular
                    }.map(\.name)).union(["en0"])
                }
                if let self, let model = self.monitoredModel {
                    self.nextInterfaceAt = 0
                    await self.autoConnect(model: model)
                }
                #if DEBUG
                NSLog("[DJLink] wired interfaces: %@", names.sorted().joined(separator: ", "))
                #endif
            }
        }
        wiredMonitor.pathUpdateHandler = { changed($0, false) }
        usbMonitor.pathUpdateHandler = { changed($0, true) }
        let queue = DispatchQueue(label: "xyz.gakonst.djbooth.djlink.network")
        wiredMonitor.start(queue: queue)
        usbMonitor.start(queue: queue)
    }
    deinit { wiredMonitor.cancel(); usbMonitor.cancel() }

    /// Network notifications trigger immediate checks. A cheap interface-only
    /// fallback covers USB adapters that iOS does not classify as Ethernet.
    /// Independent of USB storage enumeration, sheets, and library navigation.
    func monitor(model: BoothModel) async {
        AppDiagnostics.shared.event("cdj_monitor_started")
        if midiInput == nil {
            let input = BoothMIDIInput(live: true)
            midiInput = input
            Task {
                do { try await input.start() }
                catch { AppDiagnostics.shared.event("midi_start_failed", ["error": error.localizedDescription]) }
            }
        }
        if unattendedHardwareTest {
            UIApplication.shared.isIdleTimerDisabled = true
            AppDiagnostics.shared.event("cdj_unattended_test_awake")
        }
        let run = UUID(); monitorGeneration = run
        monitoredModel = model
        let warmup = Task { [engine] in
            try? await engine.warm(tracks: model.tracks, collections: model.playlistCollections, folderNames: model.pairedMac.folderNames,
                                   annotations: model.annotations, audio: model.audio.directory)
        }
        defer {
            warmup.cancel()
            if monitorGeneration == run { monitoredModel = nil }
            AppDiagnostics.shared.event("cdj_monitor_stopped")
        }
        while !Task.isCancelled {
            lastMonitorAt = ProcessInfo.processInfo.systemUptime
            if lastMonitorAt >= nextMIDIAt {
                do {
                    let snapshot = try await engine.midiStatus()
                    if midiMixers != snapshot { midiMixers = snapshot }
                    midiFailure = nil
                } catch {
                    if midiFailure != error.localizedDescription {
                        midiFailure = error.localizedDescription
                        AppDiagnostics.shared.event("midi_snapshot_failed", ["error": error.localizedDescription])
                    }
                }
                nextMIDIAt = lastMonitorAt + 0.1
            }
            await autoConnect(model: model)
            let interval = UIApplication.shared.applicationState == .background ? 1000 : (status.devices?.isEmpty == false ? 33 : 125)
            do { try await Task.sleep(for: .milliseconds(interval)) } catch { return }
        }
    }

    /// Called while foregrounded, even with the connection sheet closed.
    func autoConnect(model: BoothModel) async {
        #if DEBUG && targetEnvironment(simulator)
        if model.demo && ProcessInfo.processInfo.arguments.contains("--ui-test-six-decks") {
            let now = ProcessInfo.processInfo.systemUptime
            if mixers.values.contains(where: { now - $0.receivedAt >= 1 }) {
                mixers = mixers.mapValues { DJLinkMixerObservation(event: $0.event, receivedAt: now) }
            }
        }
        #endif
        guard !model.demo, canRun else { return }
        guard !checking else { checkAgain = true; return }
        guard !busy else { return }
        checking = true
        defer {
            checking = false
            if checkAgain {
                checkAgain = false
                Task { [weak self, weak model] in
                    guard let self, let model else { return }
                    await self.autoConnect(model: model)
                }
            }
        }
        let request = generation
        let now = ProcessInfo.processInfo.systemUptime
        if now >= nextInterfaceAt {
            await refresh()
            nextInterfaceAt = now + 0.125
        }
        guard generation == request, !Task.isCancelled, !busy, canRun else { return }
        let interface = automaticInterface
        let changed = lifecycle.observe(interface?.id)
        if changed {
            AppDiagnostics.shared.event("cdj_attachment_changed", ["interface": interface?.id ?? "detached"])
        }
        guard let interface else {
            waitingForLibrary = false
            if status.running { await disconnect() }
            reportAutomaticState(wifiEnabled ? "waiting_for_wifi_interface" : "waiting_for_wired_interface")
            return
        }
        reportAutomaticState("interface_ready:\(interface.id)")
        if status.running && activeInterfaceID != interface.id { await disconnect() }
        guard !Task.isCancelled, !busy, canRun else { return }
        if status.running {
            let now = ProcessInfo.processInfo.systemUptime
            if now >= nextLibraryAt, loadingTrackID == nil {
                nextLibraryAt = now + 1
                do {
                    // Cover backfills update the paired snapshot independently of library reloads.
                    let paired = Dictionary(uniqueKeysWithValues: model.pairedMac.tracks.map { ($0.id, $0.artworkHash) })
                    let tracks = model.tracks.map { original in
                        var track = original
                        if let hash = paired[track.id] { track.artworkHash = hash }
                        return track
                    }
                    let omitted = try await engine.refreshLibrary(tracks: tracks, collections: model.playlistCollections,
                                                                 folderNames: model.pairedMac.folderNames, annotations: model.annotations,
                                                                 audio: model.audio.directory)
                    guard generation == request, !Task.isCancelled, !busy, canRun else { return }
                    omittedTracks = omitted
                    libraryRefreshError = nil
                } catch {
                    guard generation == request, !Task.isCancelled, !busy, canRun else { return }
                    // Retain the last published generation and serving sockets.
                    // A failed update must not interrupt a deck already playing.
                    if libraryRefreshError != error.localizedDescription {
                        AppDiagnostics.shared.event("cdj_library_publish_failed", ["error": error.localizedDescription])
                    }
                    libraryRefreshError = error.localizedDescription
                    nextLibraryAt = now + 3
                }
            }
            if now >= nextStatusAt {
                let request = generation
                do {
                    let (next, observedDecks, observedMixers) = try await engine.status()
                    guard generation == request, !Task.isCancelled, !busy,
                          canRun else { return }
                    let previousDevices = status.devices?.map { "\($0.player):\($0.ip)" } ?? []
                    let nextDevices = next.devices?.map { "\($0.player):\($0.ip)" } ?? []
                    if previousDevices != nextDevices {
                        NSLog("[DJLink] discovered decks: %@", nextDevices.joined(separator: ", "))
                        AppDiagnostics.shared.event("cdj_devices_changed", ["devices": nextDevices.joined(separator: ",")])
                    }
                    status = next
                    if decks != observedDecks { decks = observedDecks }
                    // Publish knob changes immediately, but coalesce unchanged
                    // heartbeats so an open channel menu stays stable.
                    let mixerChanged = Set(mixers.keys) != Set(observedMixers.keys) || observedMixers.contains { ip, observation in
                        mixers[ip]?.event != observation.event || now - (mixers[ip]?.receivedAt ?? 0) >= 1
                    }
                    if mixerChanged { mixers = observedMixers }
                    nextStatusAt = now + (nextDevices.isEmpty ? 0.125 : 0)
                } catch {
                    guard generation == request, !Task.isCancelled, !busy, canRun else { return }
                    await disconnect(message: error.localizedDescription)
                }
            }
            return
        }
        guard lifecycle.mayStart(at: ProcessInfo.processInfo.systemUptime) else { return }
        selectedIP = interface.ip
        await connect(model: model)
    }

    private func reportAutomaticState(_ state: String) {
        guard reportedAutomaticState != state else { return }
        reportedAutomaticState = state
        AppDiagnostics.shared.event("cdj_automatic_state", ["state": state])
    }

    func refresh() async {
        let request = generation
        do {
            let excluded = wirelessNames.subtracting(wiredNames.union(usbWiredNames)).sorted()
            let (available, selected) = try await engine.interfaces(excluding: excluded)
            guard generation == request, !Task.isCancelled else { return }
            if interfaces != available { interfaces = available }
            automaticInterface = wifiEnabled ? available.first(where: { $0.name == "en0" }) : selected
            let description = interfaces.map { "\($0.name)=\($0.ip)/\($0.netmask)" }.joined(separator: ", ")
            if description != reportedInterfaces {
                reportedInterfaces = description
                AppDiagnostics.shared.event("cdj_interfaces", ["interfaces": description])
                NSLog("[DJLink] available interfaces: %@", description)
            }
            if !interfaces.contains(where: { $0.ip == selectedIP }) {
                selectedIP = interfaces.count == 1 ? interfaces[0].ip : ""
            }
        } catch {
            self.error = error.localizedDescription
            reportAutomaticState("interface_scan_failed:\(error.localizedDescription)")
        }
    }
    func connect(model: BoothModel) async {
        guard !Task.isCancelled, canRun,
              !busy, !status.running, let interface = interfaces.first(where: { $0.ip == selectedIP }) else { return }
        let request = UUID(); generation = request
        let shareOverWiFi = wifiEnabled
        defer {
            if generation == request {
                busy = false
                if !status.running { UIApplication.shared.isIdleTimerDisabled = unattendedHardwareTest && UIApplication.shared.applicationState != .background }
            }
        }
        do {
            // Missing downloads are a stable readiness state, not a failed
            // connection. Recheck the cached projection without flickering busy/error.
            let ready = try await engine.warm(tracks: model.tracks, collections: model.playlistCollections, folderNames: model.pairedMac.folderNames,
                                              annotations: model.annotations, audio: model.audio.directory)
            guard generation == request, wifiEnabled == shareOverWiFi, !Task.isCancelled, canRun else { return }
            waitingForLibrary = !ready
            guard ready else {
                error = nil
                lifecycle.failed(at: ProcessInfo.processInfo.systemUptime)
                return
            }
            AppDiagnostics.shared.event("cdj_connect_started", ["connection": request.uuidString, "interface": interface.name, "ip": interface.ip])
            busy = true; error = nil
            UIApplication.shared.isIdleTimerDisabled = true
            let result = try await engine.start(interface: interface, unicastDiscovery: !broadcastEnabled,
                                                tracks: model.tracks, collections: model.playlistCollections, folderNames: model.pairedMac.folderNames,
                                                annotations: model.annotations, audio: model.audio.directory)
            guard generation == request else { return }
            status = result.0; omittedTracks = result.1
            AppDiagnostics.shared.event("cdj_serving", ["connection": request.uuidString, "tracks": String(status.trackCount ?? 0), "playlists": String(status.playlistCount ?? 0), "omitted": String(omittedTracks)])
            #if DEBUG
            NSLog("[DJLink] sharing %d tracks at %@; unicast discovery: %@", status.trackCount ?? 0, interface.ip, String(!broadcastEnabled))
            #endif
            UIApplication.shared.isIdleTimerDisabled = true
            activeInterfaceID = interface.id
            lifecycle.resetRetry()
            nextStatusAt = 0
            nextLibraryAt = 0
            libraryRefreshError = nil
        } catch {
            guard generation == request else { return }
            lifecycle.failed(at: ProcessInfo.processInfo.systemUptime)
            self.error = error.localizedDescription
            AppDiagnostics.shared.event("cdj_connect_failed", ["connection": request.uuidString, "error": error.localizedDescription])
            #if DEBUG
            NSLog("[DJLink] connection failed: %@", error.localizedDescription)
            #endif
        }
    }
    func disconnect(message: String? = nil) async {
        if recording.isRecording { await recording.stop(reason: message ?? "The DJ Link connection ended. Recording saved.") }
        AppDiagnostics.shared.event("cdj_disconnect", ["connection": generation.uuidString, "reason": message ?? "lifecycle_or_interface_change"])
        lifecycle.resetRetry()
        activeInterfaceID = nil
        waitingForLibrary = false
        libraryRefreshError = nil
        decks = []; mixers = [:]; selectedPlayer = nil; showingPhonePlayer = false
        let request = UUID(); generation = request
        busy = true
        UIApplication.shared.isIdleTimerDisabled = unattendedHardwareTest && UIApplication.shared.applicationState != .background
        do {
            try await engine.stop()
            guard generation == request else { return }
            status = DJLinkStatus(running: false); error = message
        } catch {
            guard generation == request else { return }
            self.error = error.localizedDescription
        }
        busy = false
        endBackgroundTime()
    }
}

struct DJLinkConnectionView: View {
    @Bindable var model: BoothModel
    @Environment(\.dismiss) private var dismiss
    private var link: DJLinkConnection { model.djLink }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Play from your iPhone").font(.title2.bold())
                    Text("Keep DJBooth open. Connect a CDJ by USB or Ethernet, or join the same Wi-Fi network as your OMNIS-DUO. Choose djbooth-phone on the deck’s LINK/source screen.")
                    Toggle("Share over Wi-Fi (OMNIS-DUO)", isOn: $model.djLink.wifiEnabled)
                        .disabled(link.busy)
                        .accessibilityIdentifier("djlink.wifi")
                    Text("Shares downloaded music from this iPhone. It does not connect to or copy your Mac’s library.").font(.caption).foregroundStyle(.secondary)
                    Text("Wi-Fi sharing is optional and needs no cloud account. Use a trusted network. Local Network access must be allowed in iPhone Settings.").font(.caption).foregroundStyle(.secondary)
                    if link.status.running {
                        Text("Changing the connection interrupts music served from this phone.").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Section("Connection") {
                    if let download = model.cdjDownloadStatus {
                        ProgressView(download).font(.caption)
                    }
                    if link.status.running {
                        Label(link.status.devices?.isEmpty == false ? "DJ equipment found" : "Looking for decks…", systemImage: "network")
                            .accessibilityIdentifier("djlink.status")
                        ForEach(link.status.devices ?? []) { device in
                            LabeledContent(device.model, value: device.isOmnis ? "2 decks · \(device.ip)" : "Player \(device.player) · \(device.ip)")
                        }
                        if link.status.devices?.isEmpty != false {
                            Text("Allow Local Network access in iPhone Settings. Check that the phone and decks are on the same network, without client isolation.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if !link.broadcastEnabled, link.status.devices?.isEmpty != false {
                            Text("Discovering decks automatically. Large networks with 169.254 addresses can take several minutes to search.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    } else if link.waitingForLibrary {
                        Label("No music ready to share", systemImage: "music.note")
                            .accessibilityIdentifier("djlink.waitingForLibrary")
                        Text("This iPhone needs downloaded audio and DJ Link analysis before it can appear on the deck. Your Mac’s library is not synced to this phone automatically.")
                            .font(.caption).foregroundStyle(.secondary)
                    } else {
                        Label(link.wifiEnabled ? "Waiting for Wi-Fi…" : link.waitingForWiredAddress ? "Waiting for a wired address…" : "Waiting for a deck", systemImage: link.wifiEnabled ? "wifi" : "cable.connector")
                        Text(link.wifiEnabled ? "Join the same Wi-Fi network as your OMNIS-DUO. Sharing starts when local audio and analysis are available." : link.waitingForWiredAddress ? "iPhone is setting up the wired network. This can take about 20 seconds." : "Plug in the cable. Connection starts automatically.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let error = link.error { Text(error).foregroundStyle(.red).accessibilityIdentifier("djlink.error") }
                    if let error = link.libraryRefreshError {
                        Text("Library update will retry: \(error). Previously shared tracks remain available.")
                            .font(.caption).foregroundStyle(.red)
                    }
                }
                Section {
                    NavigationLink {
                        DJLinkWiredSetupView(link: link)
                    } label: {
                        Label("Connect faster next time", systemImage: "bolt.horizontal.circle")
                    }.accessibilityIdentifier("djlink.wiredSetup.open")
                } footer: {
                    Text("Optional one-time iPhone Ethernet setup to skip waiting for an automatic address. Your CDJs need no changes.")
                }
                Section("While connected") {
                    NavigationLink("Record your set") { BoothRecordingView(model: model) }
                    Text("An active USB audio recording keeps the audio session running in the background. Otherwise, keep DJBooth open for uninterrupted deck playback; iOS limits background time and returning to the app reconnects automatically.")
                    Text("Only audio already downloaded to this phone is shared. Reconnect after downloading more tracks or changing playlists.")
                    Text("CDJ waveforms, beat grids, seek tables, and cues download with your tracks. Connecting never analyzes audio.")
                        .font(.caption).foregroundStyle(.secondary)
                    if link.status.running, link.omittedTracks > 0 {
                        Text("\(link.omittedTracks) tracks need audio or CDJ analysis downloads, or use an unsupported file type.").font(.caption)
                    }
                }
            }.navigationTitle("DJ Link")
                .toolbar { Button("Done") { dismiss() } }
                .task { await link.refresh() }
        }
    }
}
#endif
