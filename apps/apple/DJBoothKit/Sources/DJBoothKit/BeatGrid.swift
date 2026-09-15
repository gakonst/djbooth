import Foundation

/// Exact analyzed beat times, never a BPM-derived approximation.
public struct BeatGrid: Codable, Sendable, Hashable {
    public let times: [Double]
    public let beats: [Int]
    public init?(times: [Double], beats: [Int]) {
        guard times.count == beats.count, times.count <= 20_000,
              beats.allSatisfy({ (1...4).contains($0) }) else { return nil }
        var previous = -Double.infinity
        for time in times {
            guard time.isFinite, time >= 0, time > previous else { return nil }
            previous = time
        }
        self.times = times; self.beats = beats
    }
    private enum CodingKeys: String, CodingKey { case times, beats }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let times = try values.decode([Double].self, forKey: .times)
        let beats = try values.decode([Int].self, forKey: .beats)
        guard let value = Self(times: times, beats: beats) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Invalid analyzed beat grid"))
        }
        self = value
    }
}

public struct BeatGridWindow: Sendable, Equatable {
    public let start: Double
    public let end: Double
    public let firstBeatIndex: Int
    /// Exclusive upper bound, so only the visible beats need to be drawn.
    public let endBeatIndex: Int
    public var beatRange: Range<Int> { firstBeatIndex..<endBeatIndex }
}

/// Build once alongside the waveform raster, off MainActor. Frame lookups are O(log n).
public struct BeatGridIndex: Sendable {
    public let times: [Double]
    public let beats: [Int]
    public let downbeatTimes: [Double]
    public init(_ grid: BeatGrid) {
        times = grid.times; beats = grid.beats
        downbeatTimes = zip(grid.times, grid.beats).compactMap { time, beat in beat == 1 ? time : nil }
    }
    public func fourBarWindow(at time: Double) -> BeatGridWindow? {
        barWindow(at: time, bars: 4)
    }
    /// Find only the measured beats visible within an arbitrary viewport in O(log n).
    public func beatRange(from start: Double, to end: Double) -> Range<Int> {
        guard start.isFinite, end.isFinite, start <= end else { return 0..<0 }
        return lowerBound(times, start)..<upperBound(times, end)
    }
    public func barWindow(at time: Double, bars: Int) -> BeatGridWindow? {
        guard bars > 0, time.isFinite, downbeatTimes.count > bars,
              let first = times.first, let last = times.last,
              time >= first, time <= last else { return nil }
        let currentBar: Double
        if time <= downbeatTimes[0] { currentBar = 0 }
        else if time >= downbeatTimes[downbeatTimes.count - 1] { currentBar = Double(downbeatTimes.count - 1) }
        else {
            let lower = upperBound(downbeatTimes, time) - 1
            let fraction = (time - downbeatTimes[lower]) / (downbeatTimes[lower + 1] - downbeatTimes[lower])
            currentBar = Double(lower) + fraction
        }
        let startBar = min(Double(downbeatTimes.count - 1 - bars), max(0, currentBar - Double(bars) / 2))
        let start = self.time(atBar: startBar)
        let end = self.time(atBar: startBar + Double(bars))
        return BeatGridWindow(start: start, end: end,
                              firstBeatIndex: lowerBound(times, start), endBeatIndex: upperBound(times, end))
    }
    /// A continuously moving viewport at the scale of the surrounding measured bars.
    /// At audio edges the viewport extends into blank space, without inventing beats.
    public func centeredBarWindow(at time: Double, bars: Int, duration: Double) -> BeatGridWindow? {
        guard time.isFinite, duration.isFinite, duration > 0, time >= 0, time <= duration,
              bars > 0, downbeatTimes.count > bars,
              let first = times.first, let last = times.last, first <= duration else { return nil }
        // Small gaps before the first beat and after the last beat are normal analysis edges.
        // A longer uncovered intro or tail cannot honestly use this grid's measured scale.
        if time < first, first > downbeatTimes[1] - downbeatTimes[0] { return nil }
        if time > last,
           duration - last > downbeatTimes[downbeatTimes.count - 1] - downbeatTimes[downbeatTimes.count - 2] {
            return nil
        }
        guard let measured = barWindow(at: min(last, max(first, time)), bars: bars) else { return nil }
        let start = time - (measured.end - measured.start) / 2
        let end = time + (measured.end - measured.start) / 2
        return BeatGridWindow(start: start, end: end,
                              firstBeatIndex: lowerBound(times, max(0, start)),
                              endBeatIndex: upperBound(times, min(duration, end)))
    }
    private func time(atBar coordinate: Double) -> Double {
        let lower = min(Int(coordinate), downbeatTimes.count - 1)
        guard lower + 1 < downbeatTimes.count else { return downbeatTimes[lower] }
        let fraction = coordinate - Double(lower)
        return downbeatTimes[lower] + fraction * (downbeatTimes[lower + 1] - downbeatTimes[lower])
    }
    private func lowerBound(_ values: [Double], _ target: Double) -> Int {
        var lower = 0, upper = values.count
        while lower < upper {
            let middle = lower + (upper - lower) / 2
            if values[middle] < target { lower = middle + 1 } else { upper = middle }
        }
        return lower
    }
    private func upperBound(_ values: [Double], _ target: Double) -> Int {
        var lower = 0, upper = values.count
        while lower < upper {
            let middle = lower + (upper - lower) / 2
            if values[middle] <= target { lower = middle + 1 } else { upper = middle }
        }
        return lower
    }
}
