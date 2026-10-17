import CoreMedia

/// A retained, read-only media clock for frame rendering, without polling AVPlayer.
/// A nil clock holds the requested position while an item or seek is preparing.
public struct PlaybackMediaClock: Sendable, Equatable {
    private let timebase: CMTimebase?
    private let elapsed: Double
    private let duration: Double
    private let timing: PlaybackTiming?
    private let rate: Double
    private let extrapolationLimit: Double
    private var correction: Double = 0
    private var correctionDuration: Double = 1

    public init(timebase: CMTimebase? = nil, elapsed: Double = 0, duration: Double = 0, timing: PlaybackTiming? = nil,
                rate: Double = 1, extrapolationLimit: Double = .infinity) {
        self.timebase = timebase; self.elapsed = elapsed; self.duration = duration; self.timing = timing
        self.rate = rate; self.extrapolationLimit = extrapolationLimit
    }

    public var hasTimebase: Bool { timebase != nil }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.timebase === rhs.timebase && lhs.elapsed == rhs.elapsed && lhs.duration == rhs.duration
            && lhs.timing == rhs.timing && lhs.correction == rhs.correction
            && lhs.correctionDuration == rhs.correctionDuration
            && lhs.rate == rhs.rate && lhs.extrapolationLimit == rhs.extrapolationLimit
    }

    /// Renderer positions can be quantized to whole seconds. Preserve the
    /// continuous presentation clock inside that uncertainty window instead of
    /// rewinding the waveform to an integer on every status response.
    public static func remoteReport(elapsed: Double, duration: Double, playing: Bool,
                                    resolution: Double, previous: PlaybackMediaClock?,
                                    at uptime: Double = ProcessInfo.processInfo.systemUptime) -> PlaybackMediaClock {
        let report = PlaybackMediaClock(elapsed: elapsed, duration: duration,
            timing: PlaybackTiming(elapsed: elapsed, playing: playing, observedAt: uptime))
        guard resolution.isFinite, resolution > 0, elapsed.isFinite,
              let previous, let previousTiming = previous.timing else { return report }
        let predicted = previous.position(at: uptime)
        // Include modest response latency, but do not turn a real seek into a
        // slow glide. Callers also discard the previous clock on explicit seeks
        // and queue changes, including repeated occurrences of the same track.
        let lower = max(0, elapsed - 0.25)
        let upper = elapsed + resolution + 0.25
        let target = min(upper, max(lower, predicted))
        let error = target - predicted
        // Cached Sonos snapshots advance from the same observation between
        // network replies. Keep the existing render clock when that report
        // agrees with both its current position and remaining correction.
        // Reanchoring on every UI poll restarts the correction and invalidates
        // the waveform timeline despite there being no new timing information.
        let age = max(0, uptime - previousTiming.observedAt)
        let remaining = previous.correction * max(0, 1 - age / previous.correctionDuration)
        let settled = predicted + remaining
        if previousTiming.playing == playing, previous.duration == duration,
           error == 0 || remaining * error > 0,
           settled >= lower - 0.000001, settled <= upper + 0.000001 {
            return previous
        }
        guard abs(error) < max(3, resolution * 3) else { return report }
        // Buffering/paused time is not an estimate of where playback resumed.
        // Starting a slow correction from that frozen anchor leaves the UI
        // seconds behind the speaker. Keep its fraction only when the first
        // playing report still contains it in the quantization interval.
        if previousTiming.playing != playing, error != 0 { return report }
        // A paused renderer cannot continue correcting its displayed position.
        if !playing, error != 0 { return report }
        var result = PlaybackMediaClock(elapsed: predicted, duration: duration,
            timing: PlaybackTiming(elapsed: predicted, playing: playing, observedAt: uptime))
        result.correction = error
        // At most a 15% speed adjustment, with no position discontinuity and no
        // backwards motion, while subsequent reports continue to refine drift.
        result.correctionDuration = max(1, abs(error) / 0.15)
        return result
    }

    /// Freeze the presentation clock without losing its subsecond anchor. The
    /// next quantized paused report can then refine it without rewinding it.
    public func paused(at uptime: Double = ProcessInfo.processInfo.systemUptime) -> PlaybackMediaClock {
        let position = position(at: uptime)
        return PlaybackMediaClock(elapsed: position, duration: duration,
            timing: PlaybackTiming(elapsed: position, playing: false, observedAt: uptime))
    }

    public func position(at uptime: Double = ProcessInfo.processInfo.systemUptime) -> Double {
        let age = timing.map { max(0, uptime - $0.observedAt) } ?? 0
        let adjustment = correction * min(1, age / correctionDuration)
        let measured = timebase.map { CMTimebaseGetTime($0).seconds } ?? timing.map {
            let delta = $0.playing ? min(age, extrapolationLimit) * rate : 0
            let projected = $0.position(at: $0.observedAt) + delta
            return ($0.duration > 0 ? min($0.duration, projected) : projected) + adjustment
        } ?? elapsed
        let fallback = elapsed.isFinite ? max(0, elapsed) : 0
        let position = measured.isFinite ? max(0, measured) : fallback
        return duration.isFinite && duration > 0 ? min(duration, position) : position
    }
}
