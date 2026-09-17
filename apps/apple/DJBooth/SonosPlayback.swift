#if os(iOS)
import SwiftUI
import AVFoundation
import UIKit
import DJBoothKit

struct SonosRoom: Codable, Identifiable, Sendable {
    let id, name, ip, coordinator, coordinatorId: String
}
struct SonosVolumeLimits: Codable, Sendable {
    var master = 100
    var rooms: [String: Int] = [:]
}
private struct SonosGroup: Decodable, Sendable {
    let enabled: Bool
    let rooms: [SonosRoom]
    let volume: Int?
    let roomVolumes: [String: Int]
    let limits: SonosVolumeLimits
}
private struct SonosSnapshot: Decodable, Sendable {
    struct Status: Decodable, Sendable {
        let playing: Bool
        let state: String
        let position, duration: Double
        let queueIndex: Int
        let owned: Bool
        let volume: Int
    }
    let active: Bool
    let requestId: String?
    let room: SonosRoom?
    let status: Status?
    let queuedCount, totalCount: Int?
    let filling: Bool?
    let fillError: String?
    let controlError: String?
    let pendingQueueIndex: Int?
    let requestedPlaying: Bool?
    let group: SonosGroup?
}
private struct SonosLoadReceipt: Decodable, Sendable {
    let requestId: String
    let queueIndex: Int
    let position: Double
    let playAccepted: Bool
    let queuedCount, totalCount: Int
    let filling: Bool
    let status: SonosSnapshot.Status?
    let volume: Double?
}
private actor SonosBridge {
    func groupAll(preferredRoomID: String?) throws -> (SonosRoom, SonosGroup) {
        struct Result: Decodable { let room: SonosRoom; let group: SonosGroup }
        struct Input: Encodable { let preferredRoomId: String? }
        let result = try JSONDecoder().decode(Result.self, from: DJLinkBindings.request("sonos.groups.all", arguments: JSONEncoder().encode(Input(preferredRoomId: preferredRoomID))))
        return (result.room, result.group)
    }
    func limits(_ limits: SonosVolumeLimits) throws -> SonosGroup {
        try JSONDecoder().decode(SonosGroup.self, from: DJLinkBindings.request("sonos.groups.limits", arguments: JSONEncoder().encode(limits)))
    }
    func discover() throws -> [SonosRoom] {
        struct Result: Decodable { let rooms: [SonosRoom] }
        return try JSONDecoder().decode(Result.self, from: DJLinkBindings.request("sonos.discover")).rooms
    }
    func request(_ operation: String, arguments: Data = Data("{}".utf8)) throws {
        _ = try DJLinkBindings.request("sonos." + operation, arguments: arguments)
    }
    func checkpoint() throws -> Data { try DJLinkBindings.request("sonos.checkpoint") }
    func startLocalMedia(_ arguments: Data) throws -> [String] {
        struct Result: Decodable { let urls: [String] }
        return try JSONDecoder().decode(Result.self, from: DJLinkBindings.request("sonos.local.start", arguments: arguments)).urls
    }
    func load(_ arguments: Data) throws -> SonosLoadReceipt {
        try JSONDecoder().decode(SonosLoadReceipt.self, from: DJLinkBindings.request("sonos.load", arguments: arguments))
    }
    func restore(_ data: Data) throws -> SonosSnapshot {
        try JSONDecoder().decode(SonosSnapshot.self, from: DJLinkBindings.request("sonos.restore", arguments: data))
    }
    func status() throws -> SonosSnapshot {
        try JSONDecoder().decode(SonosSnapshot.self, from: DJLinkBindings.request("sonos.status"))
    }
    func submit(_ command: String, value: Double, requestID: String) throws {
        struct Arguments: Encodable { let requestId, command: String; let value: Double }
        try request("submit", arguments: JSONEncoder().encode(Arguments(requestId: requestID, command: command, value: value)))
    }
}

/// UI and transport adapter only. Rust owns discovery, SOAP, queue ownership,
/// timing and Sonos controls. The speaker streams from Cloudflare independently.
@MainActor @Observable final class SonosPlayback {
    var enabled = false
    var routing = false
    private(set) var grouped = false
    var limits = SonosVolumeLimits()
    private(set) var roomVolumes: [String: Int] = [:]
    private let groupBridge = SonosBridge()
    private var preferredRoomID: String?
    private struct Settings: Codable { let enabled: Bool; let limits: SonosVolumeLimits; let preferredRoomID: String? }
    var rooms: [SonosRoom] = []
    var room: SonosRoom?
    var discovering = false
    var loading = false
    var error: String?
    var volume: Double = 0
    private(set) var volumeKnown = false
    private var pendingPhoneVolumeDelta: Double = 0
    private var pendingPhoneVolumeAbsolute: Double?
    var editingVolume = false
    private(set) var queuedCount = 0
    private(set) var totalCount = 0
    private(set) var filling = false
    private var queueBackgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var queueBackgroundGeneration = UUID()
    private var queueBackgroundExpired = false
    private let bridge = SonosBridge()
    // Read-only monitoring must never queue a button press behind a slow poll.
    // Rust owns ordering and rejects snapshots superseded by a control command.
    private let statusBridge = SonosBridge()
    private let discoveryBridge = SonosBridge()
    private var readingStatus = false
    private var polling: Task<Void, Never>?
    private var controls: Task<Void, Never>?
    private var pendingControls: [(command: String, value: Double, request: String, revision: UInt64)] = []
    private var controlRevision: UInt64 = 0
    private var activeRequest: String?
    private var restoringSession = false
    var ownsPlayback: Bool { activeRequest != nil || restoringSession }
    private var awaitingFirstStatus = false
    private var failedStatusPolls = 0
    private var lastStatusFailureLogAt: TimeInterval?
    private var lastReportedRemoteFailure: String?
    private var lastPlayerObservation: (state: String, index: Int, playing: Bool, requested: Bool, at: TimeInterval)?
    // Hardware-test-only experiment. Never persist ephemeral phone URLs.
    private var localTestCloudTracks: Data?
    var testingLocalMedia: Bool { localTestCloudTracks != nil }
    private weak var player: BoothPlayer?
    private var queue: [Track] = []
    private var grant: (CloudClient, String)?
    private var preferences: PlaybackSessionPreferences?
    private var lifecycle = UUID()
    private var volumeObservation: NSKeyValueObservation?
    private var lastPhoneVolume: Double?
    private struct Saved: Codable {
        let room: SonosRoom
        let tracks: [Track]
        let rustSession: Data
        let grantToken: String
    }
    private var mediaScope = UUID()
    private var availableMedia: [String: ContinuousClock.Instant] = [:]
    func configure(_ preferences: PlaybackSessionPreferences?) {
        self.preferences = preferences
        mediaScope = UUID(); availableMedia.removeAll()
        let settings = preferences?.loadSpeakerSettings().flatMap { try? JSONDecoder().decode(Settings.self, from: $0) }
        enabled = settings?.enabled ?? (preferences?.loadSpeakerSession() != nil)
        limits = settings?.limits ?? SonosVolumeLimits()
        preferredRoomID = settings?.preferredRoomID ?? preferences?.loadSpeakerSession().flatMap { try? JSONDecoder().decode(Saved.self, from: $0).room.id }
        grouped = false
    }
    func rememberEnabled(_ value: Bool) {
        enabled = value
        saveSettings()
    }
    private func saveSettings() {
        if let data = try? JSONEncoder().encode(Settings(enabled: enabled, limits: limits, preferredRoomID: preferredRoomID)) { preferences?.saveSpeakerSettings(data) }
    }
    private func applyGroup(_ group: SonosGroup) {
        grouped = group.enabled
        roomVolumes = group.roomVolumes
        if group.enabled { rooms = group.rooms }
    }
    func connectAllRooms() async throws -> SonosRoom {
        _ = try await groupBridge.limits(limits)
        await discover()
        let (room, group) = try await groupBridge.groupAll(preferredRoomID: self.room?.id ?? preferredRoomID)
        applyGroup(group)
        preferredRoomID = room.id
        rememberEnabled(true)
        return room
    }
    func disableGroup() async {
        try? await groupBridge.request("groups.disable")
        grouped = false
        rememberEnabled(false)
    }
    func saveVolumeLimits() async {
        saveSettings()
        do { applyGroup(try await groupBridge.limits(limits)) }
        catch { logFailure("volume_limits", error); self.error = error.localizedDescription }
    }
    /// Library hydration updates labels and analysis, never the renderer's
    /// ordered queue, selected occurrence, or transport state.
    func refreshLibraryMetadata(_ tracks: [String: Track], player: BoothPlayer) {
        guard activeRequest != nil else { return }
        queue = queue.map { tracks[$0.id] ?? $0 }
        player.queue = queue
        if queue.indices.contains(player.queueIndex) { player.track = queue[player.queueIndex] }
    }
    private func acceptVolume(_ observed: Double) {
        guard observed.isFinite, (0...100).contains(observed) else { return }
        volumeKnown = true
        if let request = activeRequest,
           pendingPhoneVolumeAbsolute != nil || abs(pendingPhoneVolumeDelta) > 0.0001 {
            volume = min(100, max(0, pendingPhoneVolumeAbsolute ?? (observed + pendingPhoneVolumeDelta)))
            pendingPhoneVolumeDelta = 0; pendingPhoneVolumeAbsolute = nil
            enqueue("volume", value: volume, request: request)
        } else if !editingVolume { volume = observed }
    }
    private func resetVolumeBaseline() {
        volumeKnown = false; pendingPhoneVolumeDelta = 0; pendingPhoneVolumeAbsolute = nil
    }
    func mediaExists(_ hash: String, cloud: CloudClient) async throws -> Bool {
        let now = ContinuousClock.now
        if let checked = availableMedia[hash], checked.duration(to: now) < .seconds(300) { return true }
        let scope = mediaScope
        let exists = try await cloud.speakerMediaExists(hash: hash)
        guard scope == mediaScope else { throw CancellationError() }
        if exists {
            // Availability is account-scoped and short-lived; missing files are
            // never cached, so an upload can be retried immediately.
            if availableMedia.count >= 2000 { availableMedia.removeAll() }
            availableMedia[hash] = .now
        } else { availableMedia[hash] = nil }
        return exists
    }
    // Errors can contain reqwest URLs. Retain their diagnostic context without
    // persisting signed media capabilities or opaque session checkpoint data.
    private func logFailure(_ operation: String, _ failure: Error, request: String? = nil,
                            revision: UInt64? = nil, command: String? = nil, trackID: String? = nil) {
        let description = failure.localizedDescription.replacingOccurrences(
            of: #"(?i)https?:[^\s"'<>]+"#, with: "[redacted URL]", options: .regularExpression)
        var fields = ["operation": operation, "error": String(description.prefix(1000)),
                      "errorType": String(describing: type(of: failure)),
                      "queueIndex": String(player?.queueIndex ?? -1),
                      "revision": String(revision ?? controlRevision)]
        if let request = request ?? activeRequest { fields["requestId"] = request }
        if let command { fields["command"] = command }
        if let trackID { fields["track"] = trackID }
        AppDiagnostics.shared.event("sonos_\(operation)_failed", fields)
    }
    func logPreparationFailure(_ failure: Error, trackID: String, requestID: String) {
        logFailure("preparation", failure, request: requestID, trackID: trackID)
    }
    private func forgetSavedSession() { preferences?.saveSpeakerSession(nil) }
    private func beginQueueBackgroundTime() {
        guard queueBackgroundTask == .invalid, !queueBackgroundExpired else { return }
        let generation = UUID(); queueBackgroundGeneration = generation
        queueBackgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Sonos queue") { [weak self] in
            Task { @MainActor in
                guard let self, self.queueBackgroundGeneration == generation else { return }
                self.queueBackgroundExpired = true
                self.endQueueBackgroundTime()
                AppDiagnostics.shared.event("sonos_queue_background_time_expired")
            }
        }
    }
    private func endQueueBackgroundTime() {
        queueBackgroundGeneration = UUID()
        let task = queueBackgroundTask; queueBackgroundTask = .invalid
        if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
    }
    func suspendVolumeControl() {
        volumeObservation = nil; lastPhoneVolume = nil
    }
    private func observePhoneVolume() async {
        guard volumeObservation == nil, activeRequest != nil, UIApplication.shared.applicationState == .active else { return }
        do { try await PlaybackAudioSession.shared.activate() }
        catch { AppDiagnostics.shared.event("sonos_volume_observation_failed", ["error": error.localizedDescription]); return }
        guard activeRequest != nil, UIApplication.shared.applicationState == .active else { return }
        let audio = AVAudioSession.sharedInstance()
        let generation = lifecycle
        // Establish a baseline without changing the room's existing volume.
        lastPhoneVolume = Double(audio.outputVolume)
        volumeObservation = audio.observe(\.outputVolume, options: [.new]) { [weak self] _, change in
            guard let value = change.newValue else { return }
            Task { @MainActor in
                guard let self, self.lifecycle == generation else { return }
                self.phoneVolumeChanged(Double(value))
            }
        }
    }
    func phoneVolumeChanged(_ value: Double) {
        guard value.isFinite, (0...1).contains(value), UIApplication.shared.applicationState != .background,
              let previous = lastPhoneVolume, let request = activeRequest else { return }
        lastPhoneVolume = value
        guard abs(value - previous) > 0.0001 else { return }
        guard volumeKnown else {
            if value == 0 { pendingPhoneVolumeAbsolute = 0; pendingPhoneVolumeDelta = 0 }
            else if let absolute = pendingPhoneVolumeAbsolute {
                pendingPhoneVolumeAbsolute = min(100, max(0, absolute + (value - previous) * 100))
            } else { pendingPhoneVolumeDelta += (value - previous) * 100 }
            AppDiagnostics.shared.event("sonos_phone_volume_waiting_for_baseline")
            return
        }
        volume = min(100, max(0, value == 0 ? 0 : volume + (value - previous) * 100))
        AppDiagnostics.shared.event("sonos_phone_volume_changed", ["phone": String(value), "speaker": String(volume)])
        enqueue("volume", value: volume, request: request)
    }
    /// Returns false only for a transient network failure, so foreground startup
    /// can retry without discarding the saved room or touching its playback.
    func reconnect(cloud: CloudClient, tracks: [String: Track], player: BoothPlayer) async -> Bool {
        if UIApplication.shared.applicationState == .active { queueBackgroundExpired = false }
        if let request = activeRequest {
            if filling || queuedCount < totalCount { beginQueueBackgroundTime() }
            // Foreground recovery resumes Rust's existing queue worker without
            // replacing the session or discarding a pending transport intent.
            do { try await bridge.request("resume") }
            catch { logFailure("resume", error, request: request) }
            do { try await refresh(request) }
            catch { if activeRequest == request { statusReadFailed(error, request: request) } }
            await observePhoneVolume()
            return true
        }
        guard let data = preferences?.loadSpeakerSession(),
              let saved = try? JSONDecoder().decode(Saved.self, from: data) else { return true }
        let generation = lifecycle
        room = saved.room; loading = true; restoringSession = true
        beginQueueBackgroundTime()
        defer { if lifecycle == generation { restoringSession = false; loading = player.pendingStreamQueueIndex != nil && filling; if !filling { endQueueBackgroundTime() } } }
        do {
            let snapshot = try await bridge.restore(saved.rustSession)
            guard !Task.isCancelled, lifecycle == generation else { return true }
            guard snapshot.active, let room = snapshot.room, let request = snapshot.requestId,
                  let status = snapshot.status, saved.tracks.indices.contains(status.queueIndex) else {
                forgetSavedSession(); self.room = nil; return true
            }
            self.room = room
            if !rooms.contains(where: { $0.id == room.id }) { rooms.append(room) }
            self.queue = saved.tracks.map { tracks[$0.id] ?? $0 }
            self.player = player; grant = (cloud, saved.grantToken); activeRequest = request
            player.prepare(queue[status.queueIndex], url: nil, queue: queue, elapsed: status.position, queueIndex: status.queueIndex)
            attach(player, request: request, autoplay: status.playing)
            apply(snapshot, request: request)
            startPolling(player, request: request)
            await observePhoneVolume()
            AppDiagnostics.shared.event("sonos_session_restored", ["room": room.name, "queueIndex": String(status.queueIndex)])
            return true
        } catch {
            guard lifecycle == generation, !Task.isCancelled else { return true }
            logFailure("restore", error)
            self.error = "Reconnecting to \(saved.room.name): \(error.localizedDescription)"
            return false
        }
    }

    func discover() async {
        guard !discovering else { return }
        discovering = true; error = nil
        defer { discovering = false }
        do { rooms = try await discoveryBridge.discover() }
        catch { logFailure("discovery", error); self.error = error.localizedDescription }
    }
    func disconnect() async {
        lifecycle = UUID(); forgetSavedSession(); suspendVolumeControl()
        restoringSession = false; resetVolumeBaseline()
        let generation = lifecycle
        let previousGrant = grant; grant = nil
        endQueueBackgroundTime(); filling = false; queuedCount = 0; totalCount = 0
        activeRequest = nil; polling?.cancel(); polling = nil
        room = nil; loading = false; queue = []
        do { try await bridge.request("disconnect") }
        catch { logFailure("disconnect", error); if lifecycle == generation { self.error = error.localizedDescription } }
        try? await bridge.request("local.stop")
        localTestCloudTracks = nil
        if let previousGrant { try? await previousGrant.0.revokeSpeakerSession(previousGrant.1) }
    }
    func canSelect(_ track: Track, queue: [Track]) -> Bool {
        room != nil && activeRequest != nil && self.queue.map(\.id) == queue.filter { $0.mediaHash != nil }.map(\.id) && self.queue.contains { $0.id == track.id }
    }
    func select(_ track: Track, queuePosition: Int? = nil) async {
        let selectedIndex = queuePosition.flatMap { queue.indices.contains($0) && queue[$0].id == track.id ? $0 : nil }
            ?? queue.firstIndex(where: { $0.id == track.id })
        guard let request = activeRequest, let index = selectedIndex else { return }
        player?.pendingStreamQueueIndex = index
        loading = true
        enqueue("track", value: Double(index), request: request)
    }
    func setVolume(_ value: Double) async {
        guard let request = activeRequest, value.isFinite, (0...100).contains(value) else { return }
        volumeKnown = true; volume = value
        pendingPhoneVolumeDelta = 0; pendingPhoneVolumeAbsolute = nil
        enqueue("volume", value: value, request: request)
    }
    /// Controlled LAN/cloud comparison using the same queue, renderer and
    /// playback controls. This is deliberately absent from normal routing until
    /// suspension and source handoff have been verified on hardware.
    func setLocalMediaTest(_ enabled: Bool, audio: AudioFiles) async throws {
        guard ProcessInfo.processInfo.arguments.contains("--dj-link-hardware-test"),
              let request = activeRequest, let room, let player, controls == nil,
              enabled != testingLocalMedia else { return }
        guard !enabled || UIApplication.shared.applicationState == .active else {
            throw DJLinkBindingError(message: "Keep DJ Booth in the foreground for the local-streaming experiment")
        }
        // Let an in-progress queue switch finish if the scene changes, without
        // pretending this grants an indefinitely running background server.
        beginQueueBackgroundTime()
        defer { if !filling { endQueueBackgroundTime() } }
        let original: Data
        if let saved = localTestCloudTracks {
            original = saved
        } else {
            let checkpoint = try await bridge.checkpoint()
            guard let session = try JSONSerialization.jsonObject(with: checkpoint) as? [String: Any],
                  let tracks = session["tracks"] as? [[String: Any]] else { throw ClientError.invalidMedia }
            original = try JSONSerialization.data(withJSONObject: tracks)
        }
        guard var tracks = try JSONSerialization.jsonObject(with: original) as? [[String: Any]],
              tracks.count == queue.count else {
            throw ClientError.invalidMedia
        }
        if enabled {
            var files: [[String: String]] = [], positions: [Int] = []
            for (index, track) in queue.enumerated() {
                if let hash = track.mediaHash, let file = await audio.existing(hash: hash) {
                    files.append(["path": file.path, "mime": Self.mime(track.mediaExtension)])
                    positions.append(index)
                }
            }
            guard positions.contains(player.queueIndex) else {
                throw DJLinkBindingError(message: "Cache the selected track before testing phone streaming")
            }
            guard activeRequest == request else { throw CancellationError() }
            let urls = try await bridge.startLocalMedia(JSONSerialization.data(withJSONObject: ["files": files]))
            guard urls.count == positions.count else { throw ClientError.invalidMedia }
            for (position, url) in zip(positions, urls) { tracks[position]["url"] = url }
            localTestCloudTracks = original
        }
        guard activeRequest == request else { throw CancellationError() }
        polling?.cancel()
        loading = true; error = nil
        let arguments: [String: Any] = ["requestId": request, "roomId": room.id, "tracks": tracks,
            "index": player.queueIndex, "position": player.mediaClock.position(), "autoplay": player.transportPlaying]
        do {
            let receipt = try await bridge.load(JSONSerialization.data(withJSONObject: arguments))
            guard activeRequest == request else { return }
            queuedCount = receipt.queuedCount; totalCount = receipt.totalCount; filling = receipt.filling
            awaitingFirstStatus = true
            if !enabled { localTestCloudTracks = nil; try await bridge.request("local.stop") }
            loading = false
            startPolling(player, request: request)
            AppDiagnostics.shared.event("sonos_media_source_changed", ["source": enabled ? "phone" : "cloud",
                "queueIndex": String(player.queueIndex)])
        } catch {
            loading = false
            logFailure("local_media_test", error)
            self.error = error.localizedDescription
            startPolling(player, request: request)
            throw error
        }
    }
    private func enqueue(_ command: String, value: Double, request: String) {
        controlRevision &+= 1
        AppDiagnostics.shared.event("sonos_control_queued", ["command": command, "revision": String(controlRevision),
            "requestId": request, "queueIndex": String(player?.queueIndex ?? -1), "value": String(value)])
        // UI intent only; Rust still owns every wire operation. Coalesce pending
        // absolute controls rather than issuing obsolete seeks after a new gesture.
        if command == "stop" { pendingControls.removeAll { $0.request == request } }
        if command == "track" {
            // Selecting a track establishes its own position and playback intent.
            // Do not make it wait behind an older Play/Pause/seek. A Pause queued
            // after this selection retains its later position in the sequence.
            pendingControls.removeAll {
                $0.request == request && ["play", "pause", "seek", "track"].contains($0.command)
            }
        }
        if let last = pendingControls.last, last.request == request,
           (["seek", "volume", "track"].contains(command) && last.command == command
            || ["play", "pause"].contains(command) && ["play", "pause"].contains(last.command)) {
            pendingControls.removeLast()
        }
        pendingControls.append((command, value, request, controlRevision))
        guard controls == nil else { return }
        controls = Task { [weak self] in
            guard let self else { return }
            defer { self.controls = nil }
            while !self.pendingControls.isEmpty {
                let next = self.pendingControls.removeFirst()
                guard next.command == "stop" || self.activeRequest == next.request else { continue }
                do {
                    AppDiagnostics.shared.event("sonos_control_started", ["command": next.command, "revision": String(next.revision),
                        "requestId": next.request, "queueIndex": String(self.player?.queueIndex ?? -1), "value": String(next.value)])
                    // Register intent in order, then let Rust serialize/coalesce
                    // wire operations. A buffering speaker must not prevent a
                    // newer Pause/Next intent from reaching the controller.
                    try await self.bridge.submit(next.command, value: next.value, requestID: next.request)
                    AppDiagnostics.shared.event("sonos_control_submitted", ["command": next.command, "revision": String(next.revision),
                        "requestId": next.request, "queueIndex": String(self.player?.queueIndex ?? -1), "value": String(next.value)])
                    // Submission is not a playback measurement. Keep the clock
                    // attached to observed speaker state instead of advancing
                    // it during buffering and snapping back on the next poll.
                    if next.command != "stop", next.command != "volume", self.pendingControls.isEmpty {
                        Task { [weak self] in
                            guard let self, self.activeRequest == next.request else { return }
                            do { try await self.refresh(next.request) }
                            catch { if self.activeRequest == next.request { self.statusReadFailed(error, request: next.request) } }
                        }
                    }
                } catch {
                    self.logFailure("command", error, request: next.request, revision: next.revision, command: next.command)
                    if self.activeRequest == next.request {
                        self.error = error.localizedDescription
                        if next.command == "track", !self.pendingControls.contains(where: { $0.command == "track" && $0.request == next.request }) {
                            self.player?.pendingStreamQueueIndex = nil; self.loading = false
                        }
                    }
                }
            }
        }
    }

    func play(queue: [Track], index: Int, session: CloudClient.SpeakerSession, cloud: CloudClient, player: BoothPlayer, autoplay: Bool = true) async throws {
        guard let room, queue.indices.contains(index) else { throw CancellationError() }
        struct Media: Encodable { let url, title, artist, mime: String }
        struct Load: Encodable { let requestId, roomId: String; let tracks: [Media]; let index: Int; let position: Double; let autoplay: Bool }
        let media = try queue.map { track -> Media in
            guard let hash = track.mediaHash, let url = session.urls[hash] else { throw ClientError.invalidMedia }
            return Media(url: url.absoluteString, title: track.title, artist: track.artist ?? "", mime: Self.mime(track.mediaExtension))
        }
        lifecycle = UUID(); suspendVolumeControl()
        restoringSession = false
        endQueueBackgroundTime(); queueBackgroundExpired = false
        let request = UUID().uuidString
        let prior = grant
        grant = (cloud, session.session); activeRequest = request; self.queue = queue
        loading = true; error = nil; self.player = player
        queuedCount = 0; totalCount = queue.count; filling = false
        beginQueueBackgroundTime()
        polling?.cancel()
        player.queue = queue; player.queueIndex = index
        attach(player, request: request, autoplay: autoplay)
        let revision = controlRevision
        do {
            let receipt = try await bridge.load(JSONEncoder().encode(Load(requestId: request, roomId: room.id, tracks: media,
                index: index, position: player.elapsed, autoplay: autoplay)))
            guard activeRequest == request, receipt.requestId == request else { return }
            queuedCount = receipt.queuedCount; totalCount = receipt.totalCount; filling = receipt.filling
            if revision == controlRevision {
                awaitingFirstStatus = receipt.status == nil || receipt.status?.state == "TRANSITIONING"
                player.queueIndex = receipt.status?.queueIndex ?? receipt.queueIndex
                if queue.indices.contains(player.queueIndex) { player.track = queue[player.queueIndex] }
                if let status = receipt.status {
                    if status.duration > 0 { player.duration = status.duration }
                }
                // Play acknowledgment can precede audible playback by seconds.
                // Preserve transport intent, but start the visual clock only
                // from an observed PLAYING state so buffering cannot rewind it.
                player.updateStream(playing: receipt.status?.playing ?? false,
                                    elapsed: receipt.status?.position ?? receipt.position, error: nil, positionResolution: 1,
                                    requestedPlaying: awaitingFirstStatus ? receipt.playAccepted : nil)
            }
            if let observedVolume = receipt.volume ?? receipt.status.map({ Double($0.volume) }) { acceptVolume(observedVolume) }
            if !filling { endQueueBackgroundTime() }
        } catch {
            logFailure("load", error, request: request, revision: revision)
            if activeRequest == request {
                loading = false
                endQueueBackgroundTime()
                activeRequest = nil
                player.prepare(queue[index], url: nil, queue: queue, elapsed: player.elapsed, queueIndex: index)
                player.error = error.localizedDescription
                self.error = error.localizedDescription
            }
            try? await cloud.revokeSpeakerSession(session.session)
            throw error
        }
        // Revoking the previous capability must not delay observing the new
        // renderer state; its queue has already been replaced successfully.
        if let prior { Task { try? await prior.0.revokeSpeakerSession(prior.1) } }
        guard activeRequest == request else { return }
        if localTestCloudTracks != nil {
            localTestCloudTracks = nil
            try? await bridge.request("local.stop")
        }
        guard activeRequest == request else { return }
        // Playback is already accepted. Persistence failure must not leave a
        // live speaker with an unobserved clock and disabled volume controls.
        loading = false
        startPolling(player, request: request)
        do {
            let checkpoint = try await bridge.checkpoint()
            guard activeRequest == request else { return }
            let saved = Saved(room: room, tracks: queue.map { var track = $0; track.waveform = nil; return track },
                              rustSession: checkpoint, grantToken: session.session)
            preferences?.saveSpeakerSession(try JSONEncoder().encode(saved))
        } catch {
            logFailure("checkpoint", error, request: request)
            // A stale saved capability belongs to the replaced native queue.
            if activeRequest == request { forgetSavedSession() }
        }
        guard activeRequest == request else { return }
        await observePhoneVolume()
    }
    private func attach(_ player: BoothPlayer, request: String, autoplay: Bool = true) {
        awaitingFirstStatus = false
        failedStatusPolls = 0; lastStatusFailureLogAt = nil; lastReportedRemoteFailure = nil
        player.attachStream(playing: autoplay) { [weak self] command, position in
            guard let self else { return }
            if command == "stop", self.activeRequest == request {
                self.polling?.cancel(); self.polling = nil; self.activeRequest = nil
                self.endQueueBackgroundTime(); self.filling = false
            }
            self.enqueue(command, value: position, request: request)
        }
    }
    private func startPolling(_ player: BoothPlayer, request: String) {
        polling?.cancel()
        polling = Task { [weak self, weak player] in
            while let self, player != nil, !Task.isCancelled, self.activeRequest == request {
                do {
                    if self.controls == nil { try await self.refresh(request) }
                } catch {
                    guard !Task.isCancelled, self.activeRequest == request else { return }
                    self.statusReadFailed(error, request: request)
                    // A missed poll does not mean the independently playing
                    // speaker paused. Preserve its last confirmed media clock.
                }
                // Rust owns the single network observer. Read its cheap cached
                // snapshot promptly rather than adding another full second of
                // UI delay after a transport change has already been observed.
                let changing = self.lastPlayerObservation?.state == "TRANSITIONING"
                    || player?.playbackRequested != player?.playing
                    || player?.pendingStreamQueueIndex != nil
                try? await Task.sleep(for: .milliseconds(changing ? 100 : 250))
            }
        }
    }
    private func statusReadFailed(_ failure: Error, request: String) {
        failedStatusPolls += 1
        let now = ProcessInfo.processInfo.systemUptime
        if failedStatusPolls == 1 || failedStatusPolls == 3 || now - (lastStatusFailureLogAt ?? 0) >= 30 {
            lastStatusFailureLogAt = now
            logFailure("status", failure, request: request)
        }
        if failedStatusPolls >= 3 { error = "Waiting for \(room?.name ?? "Sonos") to respond…" }
    }
    private func refresh(_ request: String) async throws {
        guard !readingStatus, activeRequest == request else { return }
        readingStatus = true
        defer { readingStatus = false }
        let revision = controlRevision
        let snapshot: SonosSnapshot
        do { snapshot = try await statusBridge.status() }
        catch {
            guard revision == controlRevision, activeRequest == request else { return }
            throw error
        }
        guard !Task.isCancelled, revision == controlRevision else { return }
        apply(snapshot, request: request)
    }
    private func apply(_ snapshot: SonosSnapshot, request: String) {
        guard activeRequest == request, snapshot.requestId == request,
              let status = snapshot.status, let player else { return }
        failedStatusPolls = 0
        guard status.owned else {
            // A transitioning renderer may briefly omit its current URI.
            if status.state == "TRANSITIONING" { return }
            AppDiagnostics.shared.event("sonos_ownership_lost", ["requestId": request,
                "queueIndex": String(status.queueIndex), "state": status.state, "revision": String(controlRevision)])
            error = "Sonos is playing from another source. Choose a track to take over."
            activeRequest = nil; forgetSavedSession(); suspendVolumeControl()
            endQueueBackgroundTime(); filling = false; loading = false
            if let track = player.track {
                player.prepare(track, url: nil, queue: player.queue, elapsed: player.elapsed, queueIndex: player.queueIndex)
                player.error = error
            }
            return
        }
        let remoteFailure = snapshot.controlError ?? snapshot.fillError
        if let remoteFailure, remoteFailure != lastReportedRemoteFailure {
            let failure = NSError(domain: "Sonos", code: 0, userInfo: [NSLocalizedDescriptionKey: remoteFailure])
            logFailure(snapshot.controlError != nil ? "deferred_control" : "queue_fill", failure, request: request)
        }
        lastReportedRemoteFailure = remoteFailure
        error = remoteFailure
        queuedCount = max(0, snapshot.queuedCount ?? queue.count)
        totalCount = max(queuedCount, snapshot.totalCount ?? queue.count)
        filling = snapshot.filling ?? false
        player.pendingStreamQueueIndex = snapshot.pendingQueueIndex.flatMap { queue.indices.contains($0) ? $0 : nil }
        loading = player.pendingStreamQueueIndex != nil && error == nil
        if filling { beginQueueBackgroundTime() } else { endQueueBackgroundTime() }
        if let group = snapshot.group { applyGroup(group) }
        acceptVolume(Double(snapshot.group.flatMap { $0.enabled ? $0.volume : nil } ?? Int(status.volume)))
        let changedItem = queue.indices.contains(status.queueIndex)
            && (player.queueIndex != status.queueIndex || player.track?.id != queue[status.queueIndex].id)
        if queue.indices.contains(status.queueIndex) {
            if player.track?.id != queue[status.queueIndex].id { player.track = queue[status.queueIndex] }
            if player.queueIndex != status.queueIndex { player.queueIndex = status.queueIndex }
        }
        if status.duration.isFinite, status.duration > 0 {
            if player.duration != status.duration { player.duration = status.duration }
        } else if changedItem {
            // Transitional reports may omit duration. Never clamp the new
            // recording's clock to the previous recording's length.
            let duration = player.track?.durationSeconds ?? 0
            player.duration = duration.isFinite ? max(0, duration) : 0
        }
        player.updateStream(playing: status.playing, elapsed: status.position, error: nil,
                            positionResolution: awaitingFirstStatus ? 0 : 1,
                            requestedPlaying: snapshot.requestedPlaying ?? (status.state == "TRANSITIONING" ? player.playbackRequested : nil))
        let now = ProcessInfo.processInfo.systemUptime
        if lastPlayerObservation?.state != status.state || lastPlayerObservation?.index != status.queueIndex
            || lastPlayerObservation?.playing != player.playing || lastPlayerObservation?.requested != player.playbackRequested
            || now - (lastPlayerObservation?.at ?? 0) >= 5 {
            AppDiagnostics.shared.event("sonos_player_observed", ["requestId": request, "state": status.state,
                "queueIndex": String(status.queueIndex), "reportedPosition": String(status.position),
                "displayPosition": String(player.mediaClock.position()), "playing": String(player.playing),
                "requestedPlaying": String(player.playbackRequested), "revision": String(controlRevision)])
            lastPlayerObservation = (status.state, status.queueIndex, player.playing, player.playbackRequested, now)
        }
        if status.state != "TRANSITIONING" { awaitingFirstStatus = false }
    }
    static func mediaExtension(_ value: String?) -> String {
        let value = (value ?? "mp3").lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return ["mp3", "flac", "wav", "aiff", "aif", "m4a", "mp4", "aac", "ogg"].contains(value) ? value : "mp3"
    }
    private static func mime(_ value: String?) -> String {
        switch mediaExtension(value) {
        case "flac": "audio/flac"
        case "wav": "audio/wav"
        case "aif", "aiff": "audio/aiff"
        case "m4a", "mp4": "audio/mp4"
        case "aac": "audio/aac"
        case "ogg": "audio/ogg"
        default: "audio/mpeg"
        }
    }
}
#endif
