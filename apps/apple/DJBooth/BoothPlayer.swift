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
    private(set) var timing = PlaybackTiming()
    private(set) var mediaClock = PlaybackMediaClock()
    var error: String?
    var onAdvance: ((Track) -> Void)?
    var onResumeRequested: (() -> Void)?
    var onPauseRequested: (() -> Void)?
    var onStateChange: ((Bool) -> Void)?
    var hasPreparedItem: Bool {
        if preparingItem { return true }
        guard let item = player.currentItem else { return false }
        return item.status != .failed
    }
    private var pendingSeek: Double?
    private var preparingItem = false
    private var seekGeneration = UUID()
    private var inFlightSeek: UUID?
    private var wantsToPlay = false
    private let player = AVPlayer()
    private var timeObserver: Any?
    private var ended: NSObjectProtocol?
    private var statusObservation: NSKeyValueObservation?
    private var itemObservation: NSKeyValueObservation?
    private var playbackGeneration = UUID()
    private var audioStartTask: Task<Void, Never>?
    private var audioStartID = UUID()
    init() {
        #if DEBUG
        // UI verification can exercise real cached audio without touching system volume.
        player.isMuted = ProcessInfo.processInfo.arguments.contains("--ui-test-muted")
        #endif
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.player.currentItem != nil, self.pendingSeek == nil else { return }
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
                guard let self else { return }
                self.captureCurrentTime()
                self.playing = self.player.timeControlStatus == .playing
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
    }
    func prepare(_ track: Track, url: URL?, queue: [Track], elapsed: Double = 0, autoplay: Bool = false) {
        cancelStartingPlayback()
        let generation = UUID(); playbackGeneration = generation
        wantsToPlay = autoplay
        player.pause(); player.replaceCurrentItem(with: nil)
        if let ended { NotificationCenter.default.removeObserver(ended); self.ended = nil }
        itemObservation = nil; pendingSeek = nil; inFlightSeek = nil; seekGeneration = UUID()
        self.track = track; self.queue = queue; duration = track.durationSeconds ?? 0
        self.elapsed = elapsed.isFinite ? max(0, duration > 0 ? min(elapsed, duration) : elapsed) : 0
        playing = false; error = nil
        preparingItem = false
        if let url { attach(url: url, autoplay: autoplay) }
        updateNowPlaying(); onStateChange?(true)
    }
    /// Resolve audio for an already-selected recording without resetting its
    /// player state, queue, or any seek made while the file was being located.
    func attach(url: URL, autoplay: Bool) {
        guard let track else { return }
        let generation = playbackGeneration
        wantsToPlay = autoplay
        preparingItem = true
        // New items already start at zero. An exact seek forces an unnecessary
        // decode/seek round trip before the first audio sample can be scheduled.
        pendingSeek = self.elapsed > 0 ? self.elapsed : nil
        Task { [weak self] in
            let mime = await AudioFiles.detectPlaybackMIMEType(url: url, mediaExtension: track.mediaExtension)
            guard let self, self.playbackGeneration == generation else { return }
            self.installItem(url: url, mimeType: mime, generation: generation)
        }
    }
    private func installItem(url: URL, mimeType: String?, generation: UUID) {
        let item = AVPlayerItem(asset: AudioFiles.playbackAsset(url: url, mimeType: mimeType))
        itemObservation = item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            let failed = item.status == .failed
            let ready = item.status == .readyToPlay
            let message = item.error?.localizedDescription ?? "This recording could not be played."
            Task { @MainActor in
                guard let self, self.playbackGeneration == generation else { return }
                if failed {
                    self.error = message; self.wantsToPlay = false; self.playing = false
                    self.pendingSeek = nil; self.inFlightSeek = nil
                    self.updateNowPlaying()
                }
                if ready { self.finishPreparing(generation: generation) }
            }
        }
        ended = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.playbackGeneration == generation else { return }
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
        guard inFlightSeek != seekGeneration else { return }
        let seekID = seekGeneration
        inFlightSeek = seekID
        player.seek(to: CMTime(seconds: position, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            Task { @MainActor in
                guard let self, self.playbackGeneration == generation,
                      self.seekGeneration == seekID, self.inFlightSeek == seekID else { return }
                self.pendingSeek = nil; self.inFlightSeek = nil
                if finished { self.elapsed = position }
                else { self.captureCurrentTime() }
                if self.wantsToPlay { self.startPlayback() }
                self.updateNowPlaying()
                self.onStateChange?(true)
            }
        }
    }
    private func startPlayback() {
        guard wantsToPlay else { return }
        #if os(iOS)
        guard audioStartTask == nil else { return }
        let generation = playbackGeneration
        let request = UUID(); audioStartID = request
        audioStartTask = Task { [weak self] in
            do {
                try await PlaybackAudioSession.shared.activate()
                guard let self, self.audioStartID == request else { return }
                self.audioStartTask = nil
                guard !Task.isCancelled, self.playbackGeneration == generation,
                      self.wantsToPlay, self.pendingSeek == nil else { return }
                self.player.play()
            } catch {
                guard let self, self.audioStartID == request else { return }
                self.audioStartTask = nil
                guard !Task.isCancelled, self.playbackGeneration == generation else { return }
                self.error = error.localizedDescription; self.wantsToPlay = false
                self.updateNowPlaying()
            }
        }
        #else
        player.play()
        #endif
    }
    private func cancelStartingPlayback() {
        audioStartTask?.cancel(); audioStartTask = nil; audioStartID = UUID()
    }
    func toggle() { playing ? pause() : resume() }
    func resume() {
        PerformanceProbe.playRequested(trackID: track?.id)
        guard hasPreparedItem else { onResumeRequested?(); return }
        wantsToPlay = true
        guard !preparingItem else { return }
        if pendingSeek == nil { startPlayback() }
    }
    func pause() {
        cancelStartingPlayback()
        wantsToPlay = false; player.pause(); playing = false
        captureCurrentTime()
        onPauseRequested?(); updateNowPlaying(); onStateChange?(true)
    }
    func seek(_ seconds: Double) {
        guard seconds.isFinite else { return }
        let position = max(0, duration > 0 ? min(seconds, duration) : seconds)
        elapsed = position
        if pendingSeek != nil || hasPreparedItem {
            pendingSeek = position
            seekGeneration = UUID(); inFlightSeek = nil
            if player.currentItem?.status == .readyToPlay { finishPreparing(generation: playbackGeneration) }
        }
        updateNowPlaying(); onStateChange?(true)
    }
    func stop() {
        cancelStartingPlayback()
        playbackGeneration = UUID(); wantsToPlay = false; pendingSeek = nil
        seekGeneration = UUID(); inFlightSeek = nil
        player.pause(); player.replaceCurrentItem(with: nil)
        if let ended { NotificationCenter.default.removeObserver(ended); self.ended = nil }
        itemObservation = nil
        preparingItem = false
        track = nil; queue = []; playing = false; elapsed = 0; duration = 0; error = nil
        timing = PlaybackTiming()
        mediaClock = PlaybackMediaClock()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }
    func advance(_ step: Int) {
        guard let track, let index = queue.firstIndex(where: { $0.id == track.id }) else { return }
        if step < 0 && elapsed > 3 { seek(0); return }
        let next = index + step
        guard queue.indices.contains(next) else { pause(); return }
        onAdvance?(queue[next])
    }
    private func updateNowPlaying() {
        refreshTiming()
        guard let track else { return }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [
            MPMediaItemPropertyTitle: track.title, MPMediaItemPropertyArtist: track.artist ?? "Unknown artist",
            MPMediaItemPropertyPlaybackDuration: duration, MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0
        ]
    }
    private func refreshTiming() {
        timing = PlaybackTiming(elapsed: elapsed, duration: duration, playing: playing)
        let timebase = pendingSeek == nil && player.currentItem?.status == .readyToPlay
            ? player.currentItem?.timebase : nil
        mediaClock = PlaybackMediaClock(timebase: timebase, elapsed: elapsed, duration: duration)
    }
    private func captureCurrentTime() {
        guard pendingSeek == nil, player.currentItem?.status == .readyToPlay else { return }
        let position = player.currentTime().seconds
        if position.isFinite { elapsed = max(0, position) }
    }
}

#if os(iOS)
/// Audio-session calls may wait on the media server. Serialize them away from UI
/// updates; AVPlayer itself and its observation remain owned by MainActor.
private actor PlaybackAudioSession {
    static let shared = PlaybackAudioSession()
    func activate() throws {
        try Task.checkCancellation()
        let session = AVAudioSession.sharedInstance()
        if session.category != .playback || session.mode != .default {
            try session.setCategory(.playback, mode: .default)
        }
        try session.setActive(true)
    }
}
#endif
