import SwiftUI
import AVFoundation
import MediaPlayer
import DJBoothKit

@MainActor @Observable final class BoothPlayer {
    var track: Track?
    var playing = false
    var elapsed: Double = 0
    var duration: Double = 0
    var queue: [Track] = []
    private(set) var seekRevision: UInt64 = 0
    private(set) var scrubPosition: Double?
    var playbackRequested: Bool { wantsToPlay }
    var transportPlaying: Bool { scrubSession == nil && streamControl == nil ? playing : wantsToPlay }
    var queueIndex = 0
    /// Navigation intent while a remote renderer is still selecting a track.
    /// The actual queue index and waveform stay attached to its latest report.
    var pendingStreamQueueIndex: Int?
    private var cloudPlayback: CloudPlayback?
    private var usbPlaybackAccess: USBPlaybackAccess?
    private(set) var timing = PlaybackTiming()
    private(set) var mediaClock = PlaybackMediaClock()
    var error: String?
    var onAdvance: ((Track) -> Void)?
    var onResumeRequested: (() -> Void)?
    var onPauseRequested: (() -> Void)?
    var onStateChange: ((Bool) -> Void)?
    private var streamControl: ((String, Double) -> Void)?
    private var streamClock: PlaybackMediaClock?
    private var streamClockTrackID: String?
    private var streamClockQueueIndex: Int?
    private struct PublishedMetadata: Equatable {
        let trackID, title: String
        let artist: String?
        let duration: Double
        let playing: Bool
    }
    private var publishedMetadata: PublishedMetadata?
    private var publishedTiming: PlaybackTiming?
    func attachStream(playing requestedPlaying: Bool = true, control: @escaping (String, Double) -> Void) {
        pendingStreamQueueIndex = nil
        streamClock = nil; streamClockTrackID = track?.id; streamClockQueueIndex = queueIndex
        streamControl = control; preparingItem = false; pendingSeek = nil; wantsToPlay = requestedPlaying; updateNowPlaying()
    }
    func updateStream(playing: Bool, elapsed: Double, error: String?, positionResolution: Double = 0,
                      requestedPlaying: Bool? = nil) {
        guard streamControl != nil else { return }
        let sameItem = streamClockTrackID == track?.id && streamClockQueueIndex == queueIndex
        if !sameItem, scrubSession != nil {
            // A speaker can advance independently while a finger is held. Drop
            // that old item's scrub without restoring its origin on the new
            // item; later gesture cancellation/release must become a no-op.
            scrubSession = nil; scrubPosition = nil; seekRevision &+= 1
        }
        self.playing = scrubSession == nil && playing
        if scrubSession == nil {
            let now = ProcessInfo.processInfo.systemUptime
            let clock = PlaybackMediaClock.remoteReport(elapsed: elapsed, duration: duration, playing: playing,
                resolution: positionResolution, previous: sameItem ? streamClock : nil, at: now)
            streamClock = clock; streamClockTrackID = track?.id; streamClockQueueIndex = queueIndex
            self.elapsed = clock.position(at: now); wantsToPlay = requestedPlaying ?? playing
        }
        self.error = error
        PerformanceProbe.playbackState(playing: self.playing, trackID: track?.id)
        updateNowPlaying(coalescingRemoteTick: true); onStateChange?(false)
    }
    var hasPreparedItem: Bool {
        if streamControl != nil { return true }
        if preparingItem { return true }
        guard let item = player.currentItem else { return false }
        return item.status != .failed
    }
    #if DEBUG
    var actualPlaybackTime: Double { player.currentTime().seconds }
    var seekIsSettled: Bool { pendingSeek == nil && inFlightSeek == nil }
    var itemIsReady: Bool { player.currentItem?.status == .readyToPlay }
    var preparationDiagnostic: String {
        "preparing=\(preparingItem), wants=\(wantsToPlay), pendingSeek=\(pendingSeek.map(String.init(describing:)) ?? "none"), seekInFlight=\(inFlightSeek != nil), activating=\(audioStartTask != nil), itemStatus=\(player.currentItem?.status.rawValue ?? -1), timeControl=\(player.timeControlStatus.rawValue), rate=\(player.rate), waiting=\(player.reasonForWaitingToPlay?.rawValue ?? "none")"
    }
    #endif
    private var pendingSeek: Double?
    private var preparingItem = false
    private var inFlightSeek: UUID?
    private var scrubSession: (id: UUID, origin: Double)?
    private var wantsToPlay = false
    private let player: AVPlayer
    private var timeObserver: Any?
    private var ended: NSObjectProtocol?
    private var statusObservation: NSKeyValueObservation?
    private var itemObservation: NSKeyValueObservation?
    private var itemGeneration = UUID()
    private var streamAuthorizationFailure: (() -> Void)?
    private var bufferObservation: NSKeyValueObservation?
    private var fastStreamStartup = false
    private var playbackGeneration = UUID()
    private var audioStartTask: Task<Void, Never>?
    private var audioStartID = UUID()
    init() {
        PerformanceProbe.event("player_init_begin")
        player = AVPlayer()
        PerformanceProbe.event("player_engine_ready")
        #if DEBUG
        // UI verification can exercise real cached audio without touching system volume.
        player.isMuted = ProcessInfo.processInfo.arguments.contains("--ui-test-muted")
        #endif
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.player.currentItem != nil, self.pendingSeek == nil, self.scrubSession == nil else { return }
                let time = self.player.currentTime().seconds
                self.elapsed = time.isFinite ? time : 0
                let duration = self.player.currentItem?.duration.seconds ?? 0
                if duration.isFinite, duration > 0, self.duration != duration {
                    self.duration = duration
                    self.updateNowPlaying()
                } else if !self.mediaClock.hasTimebase {
                    self.refreshTiming()
                }
                self.onStateChange?(false)
            }
        }
        statusObservation = player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in
                guard let self, self.streamControl == nil else { return }
                self.captureCurrentTime()
                self.playing = self.player.timeControlStatus == .playing
                if self.playing { self.fastStreamStartup = false; self.bufferObservation = nil }
                PerformanceProbe.playbackState(playing: self.playing, trackID: self.track?.id)
                self.updateNowPlaying()
            }
        }
        MPRemoteCommandCenter.shared().playCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.resume() }; return .success
        }
        MPRemoteCommandCenter.shared().pauseCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.pause() }; return .success
        }
        MPRemoteCommandCenter.shared().nextTrackCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.advance(1) }; return .success
        }
        MPRemoteCommandCenter.shared().previousTrackCommand.addTarget { [weak self] _ in
            Task { @MainActor in self?.advance(-1) }; return .success
        }
        MPRemoteCommandCenter.shared().changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let position = event.positionTime
            Task { @MainActor in self?.seek(position) }; return .success
        }
        PerformanceProbe.event("player_init_end")
    }
    func prepare(_ track: Track, url: URL?, queue: [Track], elapsed: Double = 0, autoplay: Bool = false, queueIndex: Int? = nil) {
        PerformanceProbe.event("player_prepare", trackID: track.id)
        seekRevision &+= 1
        streamControl?("stop", 0); streamControl = nil
        streamClock = nil
        pendingStreamQueueIndex = nil
        cancelStartingPlayback()
        let generation = UUID(); playbackGeneration = generation
        wantsToPlay = autoplay
        player.pause(); player.replaceCurrentItem(with: nil); usbPlaybackAccess = nil; cloudPlayback = nil
        if let ended { NotificationCenter.default.removeObserver(ended); self.ended = nil }
        itemObservation = nil; bufferObservation = nil; fastStreamStartup = false
        itemGeneration = UUID(); streamAuthorizationFailure = nil
        pendingSeek = nil; inFlightSeek = nil
        scrubSession = nil; scrubPosition = nil
        self.queueIndex = queueIndex.flatMap { queue.indices.contains($0) && queue[$0].id == track.id ? $0 : nil } ?? queue.firstIndex { $0.id == track.id } ?? 0
        self.track = track; self.queue = queue; duration = track.durationSeconds ?? 0
        self.elapsed = elapsed.isFinite ? max(0, duration > 0 ? min(elapsed, duration) : elapsed) : 0
        playing = false; error = nil
        preparingItem = false
        if let url { attach(url: url, autoplay: autoplay) }
        updateNowPlaying(); onStateChange?(true)
    }
    func attachCloud(client: CloudClient, hash: String, mediaExtension: String?) {
        let playback = CloudPlayback(client: client, hash: hash, mediaExtension: mediaExtension)
        cloudPlayback = playback; wantsToPlay = true; preparingItem = true
        pendingSeek = elapsed > 0 ? elapsed : nil
        installItem(asset: playback.asset, generation: playbackGeneration)
    }
    func attachUSB(_ access: USBPlaybackAccess, autoplay: Bool) {
        usbPlaybackAccess = access
        attach(url: access.url, autoplay: autoplay)
    }
    /// Resolve audio for an already-selected recording without resetting its
    /// player state, queue, or any seek made while the file was being located.
    func attach(url: URL, autoplay: Bool, fastStreamStart: Bool = false, onStreamAuthorizationFailure: (() -> Void)? = nil) {
        guard let track else { return }
        let generation = playbackGeneration
        fastStreamStartup = fastStreamStart
        let attachment = UUID(); itemGeneration = attachment
        streamAuthorizationFailure = fastStreamStart ? onStreamAuthorizationFailure : nil
        wantsToPlay = autoplay
        preparingItem = true
        // New items already start at zero. An exact seek forces an unnecessary
        // decode/seek round trip before the first audio sample can be scheduled.
        pendingSeek = self.elapsed > 0 ? self.elapsed : nil
        Task { [weak self] in
            let mime = await AudioFiles.detectPlaybackMIMEType(url: url, mediaExtension: track.mediaExtension)
            guard let self, self.playbackGeneration == generation, self.itemGeneration == attachment else { return }
            PerformanceProbe.event("player_mime_ready", trackID: track.id)
            let asset = AudioFiles.playbackAsset(url: url, mimeType: mime)
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--ui-test-load-asset") {
                PerformanceProbe.event("player_asset_load_begin", trackID: track.id)
                do {
                    let (playable, _) = try await asset.load(.isPlayable, .duration)
                    guard self.playbackGeneration == generation, self.itemGeneration == attachment else { return }
                    PerformanceProbe.event(playable ? "player_asset_load_ready" : "player_asset_unplayable", trackID: track.id)
                } catch {
                    guard self.playbackGeneration == generation, self.itemGeneration == attachment else { return }
                    PerformanceProbe.event("player_asset_load_failed", trackID: track.id)
                    self.preparingItem = false; self.wantsToPlay = false
                    self.error = error.localizedDescription
                    return
                }
            }
            #endif
            self.installItem(asset: asset, generation: generation)
        }
    }
    func failStreamPreparation(_ message: String) {
        cancelStartingPlayback()
        itemGeneration = UUID(); streamAuthorizationFailure = nil
        itemObservation = nil; bufferObservation = nil; fastStreamStartup = false
        if let ended { NotificationCenter.default.removeObserver(ended); self.ended = nil }
        preparingItem = false; pendingSeek = nil; inFlightSeek = nil
        scrubSession = nil; scrubPosition = nil; seekRevision &+= 1
        wantsToPlay = false; playing = false
        player.pause(); player.replaceCurrentItem(with: nil)
        error = message; updateNowPlaying(); onStateChange?(false)
    }
    private func installItem(asset: AVURLAsset, generation: UUID) {
        itemObservation = nil; bufferObservation = nil
        if let ended { NotificationCenter.default.removeObserver(ended); self.ended = nil }
        let itemID = UUID(); itemGeneration = itemID
        let item = AVPlayerItem(asset: asset)
        if fastStreamStartup {
            // Start a chosen remote track when its first segment arrives. Keep
            // AVPlayer's automatic stall recovery for the rest of the stream.
            item.preferredForwardBufferDuration = 5
            bufferObservation = item.observe(\.isPlaybackBufferEmpty, options: [.initial, .new]) { [weak self] item, _ in
                let buffered = !item.isPlaybackBufferEmpty
                Task { @MainActor in
                    guard let self, buffered, self.playbackGeneration == generation, self.itemGeneration == itemID,
                          self.fastStreamStartup, self.player.currentItem?.status == .readyToPlay,
                          self.wantsToPlay, self.pendingSeek == nil, self.scrubSession == nil else { return }
                    self.startPlayback()
                }
            }
        }
        itemObservation = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            let failed = item.status == .failed
            let ready = item.status == .readyToPlay
            let httpStatus = item.errorLog()?.events.last?.errorStatusCode
            let authorizationFailed = httpStatus == 401 || httpStatus == 403
            let message = item.error?.localizedDescription ?? "This recording could not be played."
            Task { @MainActor in
                guard let self, self.playbackGeneration == generation, self.itemGeneration == itemID else { return }
                if failed {
                    if authorizationFailed, self.wantsToPlay, let retry = self.streamAuthorizationFailure {
                        self.streamAuthorizationFailure = nil
                        self.itemGeneration = UUID() // Ignore any other callbacks queued by this failed item.
                        self.playing = false; self.preparingItem = true; self.error = nil
                        self.updateNowPlaying(); retry(); return
                    }
                    self.error = message; self.wantsToPlay = false; self.playing = false
                    self.pendingSeek = nil; self.inFlightSeek = nil
                    self.scrubSession = nil; self.scrubPosition = nil; self.seekRevision &+= 1
                    self.updateNowPlaying()
                }
                if ready {
                    PerformanceProbe.event("player_item_ready", trackID: self.track?.id)
                    self.finishPreparing(generation: generation)
                }
            }
        }
        ended = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.playbackGeneration == generation, self.itemGeneration == itemID, self.scrubSession == nil,
                      self.pendingSeek == nil, self.wantsToPlay else { return }
                let end = self.player.currentItem?.duration.seconds ?? self.duration
                guard end.isFinite, end > 0, self.player.currentTime().seconds >= end - 0.1 else { return }
                self.advance(1)
            }
        }
        player.replaceCurrentItem(with: item)
        preparingItem = false
        // Audio-session activation and the item's initial load can run together.
        if pendingSeek == nil, wantsToPlay { startPlayback() }
        updateNowPlaying()
    }
    private func finishPreparing(generation: UUID) {
        guard let position = pendingSeek else {
            if wantsToPlay, !playing { startPlayback() }
            updateNowPlaying()
            return
        }
        // Chase the latest requested position with one native seek at a time.
        // Cancelling/restarting on every finger movement starves the decoder.
        guard inFlightSeek == nil else { return }
        let seekID = UUID()
        inFlightSeek = seekID
        player.seek(to: CMTime(seconds: position, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            Task { @MainActor in
                guard let self, self.playbackGeneration == generation, self.inFlightSeek == seekID else { return }
                self.inFlightSeek = nil
                if self.pendingSeek != position {
                    self.finishPreparing(generation: generation)
                    return
                }
                self.pendingSeek = nil
                if finished { self.elapsed = position }
                else {
                    // An interrupted native seek is not a warmed target. While
                    // held, reconcile the preview so release retries its target.
                    let actual = self.player.currentTime().seconds
                    self.elapsed = actual.isFinite ? max(0, actual) : self.scrubSession?.origin ?? 0
                    if self.scrubSession != nil { self.scrubPosition = self.elapsed }
                    else {
                        self.wantsToPlay = false; self.player.pause(); self.playing = false
                        self.error = "The playback position could not be changed. Please try again."
                    }
                }
                guard self.scrubSession == nil else { self.refreshTiming(); return }
                if self.wantsToPlay { self.startPlayback() }
                self.updateNowPlaying()
                self.onStateChange?(true)
            }
        }
    }
    private func startPlayback() {
        if let streamControl { if wantsToPlay && scrubSession == nil { streamControl("play", elapsed) }; return }
        guard wantsToPlay, scrubSession == nil else { return }
        #if os(iOS)
        guard audioStartTask == nil else { return }
        let generation = playbackGeneration
        let request = UUID(); audioStartID = request
        audioStartTask = Task { [weak self] in
            do {
                PerformanceProbe.event("player_session_begin", trackID: self?.track?.id)
                try await PlaybackAudioSession.shared.activate()
                PerformanceProbe.event("player_session_ready", trackID: self?.track?.id)
                guard let self, self.audioStartID == request else { return }
                self.audioStartTask = nil
                guard !Task.isCancelled, self.playbackGeneration == generation,
                      self.wantsToPlay, self.pendingSeek == nil, self.scrubSession == nil else { return }
                self.playBufferedItem()
            } catch {
                guard let self, self.audioStartID == request else { return }
                self.audioStartTask = nil
                guard !Task.isCancelled, self.playbackGeneration == generation else { return }
                self.error = error.localizedDescription; self.wantsToPlay = false
                self.updateNowPlaying()
            }
        }
        #else
        playBufferedItem()
        #endif
    }
    private func playBufferedItem() {
        if fastStreamStartup, player.currentItem?.status == .readyToPlay,
           player.currentItem?.isPlaybackBufferEmpty == false {
            player.playImmediately(atRate: 1)
        } else { player.play() }
    }
    private func cancelStartingPlayback() {
        audioStartTask?.cancel(); audioStartTask = nil; audioStartID = UUID()
    }
    func toggle() { transportPlaying ? pause() : resume() }
    func resume() {
        if let streamControl { wantsToPlay = true; streamControl("play", elapsed); return }
        PerformanceProbe.playRequested(trackID: track?.id)
        guard hasPreparedItem else { onResumeRequested?(); return }
        wantsToPlay = true
        guard !preparingItem else { return }
        if pendingSeek == nil { startPlayback() }
    }
    func pause() {
        PerformanceProbe.event("player_pause", trackID: track?.id)
        if streamControl != nil {
            let held = mediaClock.paused()
            elapsed = held.position(); streamClock = held
        }
        streamControl?("pause", elapsed)
        cancelStartingPlayback()
        wantsToPlay = false; player.pause(); playing = false
        captureCurrentTime()
        onPauseRequested?(); updateNowPlaying(); onStateChange?(true)
    }
    func seek(_ seconds: Double) {
        guard seconds.isFinite else { return }
        seekRevision &+= 1
        scrubSession = nil; scrubPosition = nil
        requestSeek(seconds)
        updateNowPlaying(); onStateChange?(true)
    }
    /// Both the timeline and eight-bar waveform share this held position. Keep
    /// the decoder close to the finger while holding audio until release.
    @discardableResult func beginScrubbing() -> UUID? {
        guard track != nil, duration.isFinite, duration > 0, scrubSession == nil else { return nil }
        let id = UUID(), origin = mediaClock.position()
        streamClock = nil
        scrubSession = (id, origin); scrubPosition = origin; elapsed = origin
        streamControl?("pause", elapsed)
        cancelStartingPlayback()
        player.pause(); playing = false
        refreshTiming()
        return id
    }
    func isScrubbing(_ id: UUID) -> Bool { scrubSession?.id == id }
    func updateScrubbing(_ id: UUID, to seconds: Double) {
        guard scrubSession?.id == id, seconds.isFinite else { return }
        let position = max(0, min(seconds, duration))
        guard scrubPosition != position else { return }
        scrubPosition = position
        // Remote speakers cannot consume a network seek for every drag frame.
        // Preview locally while held; send the final position on release.
        if streamControl != nil { elapsed = position }
        else { requestSeek(position) }
        refreshTiming()
    }
    func endScrubbing(_ id: UUID, at seconds: Double) {
        guard scrubSession?.id == id else { return }
        updateScrubbing(id, to: seconds)
        scrubSession = nil; scrubPosition = nil; seekRevision &+= 1
        if streamControl != nil { requestSeek(seconds) }
        // A settled held seek is already at the release position. Do not issue
        // another exact seek before playing it.
        if pendingSeek == nil, !preparingItem { startPlayback() }
        updateNowPlaying(); onStateChange?(true)
    }
    func cancelScrubbing(_ id: UUID) {
        guard let session = scrubSession, session.id == id else { return }
        scrubSession = nil; scrubPosition = nil; seekRevision &+= 1
        requestSeek(session.origin)
        if streamControl != nil { startPlayback() }
        updateNowPlaying(); onStateChange?(true)
    }
    private func requestSeek(_ seconds: Double) {
        let position = max(0, duration > 0 ? min(seconds, duration) : seconds)
        elapsed = position
        streamClock = nil
        if let streamControl { streamControl("seek", position); updateNowPlaying(); return }
        if pendingSeek != nil || hasPreparedItem {
            pendingSeek = position
            if player.currentItem?.status == .readyToPlay { finishPreparing(generation: playbackGeneration) }
        }
    }
    func stop() {
        streamControl?("stop", 0); streamControl = nil
        streamClock = nil
        pendingStreamQueueIndex = nil
        cancelStartingPlayback()
        playbackGeneration = UUID(); wantsToPlay = false; pendingSeek = nil
        inFlightSeek = nil; scrubSession = nil; scrubPosition = nil
        seekRevision &+= 1
        player.pause(); player.replaceCurrentItem(with: nil); usbPlaybackAccess = nil; cloudPlayback = nil
        if let ended { NotificationCenter.default.removeObserver(ended); self.ended = nil }
        itemObservation = nil; bufferObservation = nil; fastStreamStartup = false
        itemGeneration = UUID(); streamAuthorizationFailure = nil
        preparingItem = false
        track = nil; queue = []; playing = false; elapsed = 0; duration = 0; error = nil
        timing = PlaybackTiming()
        mediaClock = PlaybackMediaClock()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
    func advance(_ step: Int) {
        guard let track else { return }
        let pending = streamControl != nil ? pendingStreamQueueIndex.flatMap { queue.indices.contains($0) ? $0 : nil } : nil
        guard let index = pending ?? (queue.indices.contains(queueIndex) && queue[queueIndex].id == track.id ? queueIndex : queue.firstIndex(where: { $0.id == track.id })) else { return }
        if step < 0 && elapsed > 3 && (streamControl == nil || index == queueIndex) { seek(0); return }
        let next = index + step
        guard queue.indices.contains(next) else { pause(); return }
        if streamControl != nil { pendingStreamQueueIndex = next }
        else { queueIndex = next }
        onAdvance?(queue[next])
    }
    private func updateNowPlaying(coalescingRemoteTick: Bool = false) {
        refreshTiming()
        guard let track else { return }
        let metadata = PublishedMetadata(trackID: track.id, title: track.title, artist: track.artist,
                                         duration: duration, playing: playing)
        let now = ProcessInfo.processInfo.systemUptime
        if coalescingRemoteTick, metadata == publishedMetadata, let publishedTiming,
           now - publishedTiming.observedAt < 15, abs(publishedTiming.position(at: now) - elapsed) < 0.5 {
            // The system advances its own clock from elapsed/rate. Re-sending
            // the complete dictionary on every Sonos poll adds synchronous
            // media-server work without changing the lock-screen presentation.
            return
        }
        publishedMetadata = metadata
        publishedTiming = PlaybackTiming(elapsed: elapsed, duration: duration, playing: playing, observedAt: now)
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: track.title, MPMediaItemPropertyArtist: track.artist ?? "Unknown artist",
            MPMediaItemPropertyPlaybackDuration: duration, MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0
        ]
    }
    private func refreshTiming() {
        timing = PlaybackTiming(elapsed: elapsed, duration: duration, playing: playing)
        let timebase = pendingSeek == nil && scrubSession == nil && player.currentItem?.status == .readyToPlay
            ? player.currentItem?.timebase : nil
        if streamControl != nil, scrubSession == nil, let streamClock {
            if mediaClock != streamClock { mediaClock = streamClock }
        } else {
            mediaClock = PlaybackMediaClock(timebase: timebase, elapsed: elapsed, duration: duration,
                                           timing: streamControl != nil && scrubSession == nil ? timing : nil)
        }
    }
    private func captureCurrentTime() {
        guard pendingSeek == nil, scrubSession == nil, player.currentItem?.status == .readyToPlay else { return }
        let position = player.currentTime().seconds
        if position.isFinite { elapsed = max(0, position) }
    }
}

#if os(iOS)
/// Audio-session calls may wait on the media server. Serialize them away from UI
/// updates; AVPlayer itself and its observation remain owned by MainActor.
actor PlaybackAudioSession {
    static let shared = PlaybackAudioSession()
    private var recordingEngine: AVAudioEngine?
    private var recordingWriter: BoothAudioWriter?
    private var recordingInput: String?
    private var recordingRate: Double = 0
    private var recordingChannels: AVAudioChannelCount = 0
    struct Input: Sendable { let uid, name: String }
    /// Configure routing before opening the system picker, without taking over
    /// another app's audio or changing an active mixer recording session.
    func prepareRouting() throws {
        let session = AVAudioSession.sharedInstance()
        if recordingInput == nil && (session.category != .playback || session.mode != .default || session.routeSharingPolicy != .longFormAudio) {
            try session.setCategory(.playback, mode: .default, policy: .longFormAudio)
        }
    }
    func activate() throws {
        try Task.checkCancellation()
        try prepareRouting()
        try AVAudioSession.sharedInstance().setActive(true)
    }
    func prepareRecording() throws -> Input {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .measurement, policy: .default, options: [.defaultToSpeaker])
        try session.setActive(true)
        let inputs = (session.availableInputs ?? []).filter { $0.portType == .usbAudio }
        guard let usb = inputs.first(where: { $0.portName.localizedCaseInsensitiveContains("DJM-A9") }) ?? (inputs.count == 1 ? inputs.first : nil) else {
            throw DJLinkBindingError(message: "Connect the mixer's USB audio output to the phone. The CDJ network cable alone does not carry master audio.")
        }
        try session.setPreferredInput(usb)
        if session.maximumInputNumberOfChannels > 0 {
            try session.setPreferredInputNumberOfChannels(session.maximumInputNumberOfChannels)
        }
        guard session.currentRoute.inputs.contains(where: { $0.uid == usb.uid && $0.portType == .usbAudio }) else {
            throw DJLinkBindingError(message: "The USB mixer is not the active audio input.")
        }
        recordingInput = usb.uid
        return Input(uid: usb.uid, name: usb.portName)
    }
    func startRecording(at directory: URL) throws {
        guard recordingInput != nil else { throw DJLinkBindingError(message: "Select a USB mixer before recording.") }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else { throw DJLinkBindingError(message: "The mixer has no audio input channels.") }
        let writer = try BoothAudioWriter(url: directory.appendingPathComponent("master.caf"), format: format)
        recordingRate = format.sampleRate; recordingChannels = format.channelCount
        recordingWriter = writer; recordingEngine = engine
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, time in writer.append(buffer, at: time) }
        try engine.start()
        let session = AVAudioSession.sharedInstance()
        let route = session.currentRoute.inputs.map { ["name": $0.portName, "uid": $0.uid, "type": $0.portType.rawValue] }
        _ = try DJLinkBindings.request("recording.event", arguments: JSONSerialization.data(withJSONObject: ["kind": "audioStarted", "payload": [
            "file": "master.caf", "sampleRate": format.sampleRate, "channels": format.channelCount,
            "inputLatency": session.inputLatency, "ioBufferDuration": session.ioBufferDuration, "inputs": route]]))
    }
    func recordingHealth() async -> String? {
        guard let engine = recordingEngine, engine.isRunning else { return "The audio engine stopped. Recording saved." }
        let format = engine.inputNode.outputFormat(forBus: 0)
        guard format.sampleRate == recordingRate, format.channelCount == recordingChannels else { return "The mixer audio format changed. Recording saved." }
        return await recordingWriter?.health()
    }
    func stopRecording() async -> String? {
        if let engine = recordingEngine { engine.inputNode.removeTap(onBus: 0); engine.stop() }
        recordingEngine = nil
        let writer = recordingWriter; recordingWriter = nil
        let error = await writer?.finish()
        recordingInput = nil
        do { try prepareRouting() }
        catch { return error.localizedDescription }
        return error
    }
}
#endif
