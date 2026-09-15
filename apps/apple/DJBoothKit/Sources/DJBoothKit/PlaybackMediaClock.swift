import CoreMedia

/// A retained, read-only media clock for frame rendering, without polling AVPlayer.
/// A nil clock holds the requested position while an item or seek is preparing.
public struct PlaybackMediaClock: Sendable {
    private let timebase: CMTimebase?
    private let elapsed: Double
    private let duration: Double

    public init(timebase: CMTimebase? = nil, elapsed: Double = 0, duration: Double = 0) {
        self.timebase = timebase; self.elapsed = elapsed; self.duration = duration
    }

    public var hasTimebase: Bool { timebase != nil }

    public func position() -> Double {
        let measured = timebase.map { CMTimebaseGetTime($0).seconds } ?? elapsed
        let fallback = elapsed.isFinite ? max(0, elapsed) : 0
        let position = measured.isFinite ? max(0, measured) : fallback
        return duration.isFinite && duration > 0 ? min(duration, position) : position
    }
}
