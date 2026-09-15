import Foundation
import Testing
@testable import DJBoothKit

struct BeatGridTests {
    private func grid(downbeats: [Double]) throws -> BeatGrid {
        var times: [Double] = [], beats: [Int] = []
        for index in 0..<(downbeats.count - 1) {
            for beat in 0..<4 {
                times.append(downbeats[index] + (downbeats[index + 1] - downbeats[index]) * Double(beat) / 4)
                beats.append(beat + 1)
            }
        }
        times.append(downbeats.last!); beats.append(1)
        return try #require(BeatGrid(times: times, beats: beats))
    }
    @Test func fourBarsFollowActualVariableTempoAtFractionalBarPosition() throws {
        let grid = try grid(downbeats: [0, 4, 10, 18, 28, 40, 54])
        let index = BeatGridIndex(grid)
        let window = try #require(index.fourBarWindow(at: 14))
        // At bar2.5 the four-bar window runs from bar0.5 to bar4.5.
        #expect(window.start == 2 && window.end == 34)
        #expect(window.firstBeatIndex == 2 && window.endBeatIndex == 19)
        #expect(window.beatRange.allSatisfy { grid.times[$0] >= window.start && grid.times[$0] <= window.end })
        #expect(index.downbeatTimes == [0, 4, 10, 18, 28, 40, 54])
    }
    @Test func windowClampsToCompleteAnalyzedBarsAndNeverFabricatesMissingGrid() throws {
        let index = BeatGridIndex(try grid(downbeats: [2, 6, 10, 14, 18, 22]))
        #expect(index.fourBarWindow(at: 2)?.start == 2)
        #expect(index.fourBarWindow(at: 2)?.end == 18)
        #expect(index.fourBarWindow(at: 22)?.start == 6)
        #expect(index.fourBarWindow(at: 22)?.end == 22)
        #expect(index.fourBarWindow(at: .nan) == nil)
        #expect(BeatGridIndex(try grid(downbeats: [0, 4, 8, 12])).fourBarWindow(at: 6) == nil)
        #expect(BeatGridIndex(try #require(BeatGrid(times: [], beats: []))).fourBarWindow(at: 0) == nil)
    }
    @Test func partialGridReturnsNoWindowOutsideMeasuredCoverage() throws {
        let index = BeatGridIndex(try grid(downbeats: [2, 6, 10, 14, 18, 22]))
        #expect(index.fourBarWindow(at: 1.999) == nil)
        #expect(index.fourBarWindow(at: 22.001) == nil)
        #expect(index.fourBarWindow(at: 7_000) == nil)
        #expect(index.fourBarWindow(at: 2)?.start == 2)
        #expect(index.fourBarWindow(at: 22)?.end == 22)
    }
    @Test func sixteenBarsUseRealFractionalBarBoundariesAcrossTempoChanges() throws {
        // Each successive measured bar is one second longer than the preceding bar.
        let downbeats = (0...24).map { Double($0 * ($0 + 1) / 2) }
        let index = BeatGridIndex(try grid(downbeats: downbeats))
        let currentTime = (downbeats[10] + downbeats[11]) / 2
        let window = try #require(index.barWindow(at: currentTime, bars: 16))
        #expect(window.start == (downbeats[2] + downbeats[3]) / 2)
        #expect(window.end == (downbeats[18] + downbeats[19]) / 2)
        #expect(index.barWindow(at: downbeats[0], bars: 16)?.end == downbeats[16])
        #expect(index.barWindow(at: downbeats[24], bars: 16)?.start == downbeats[8])
        #expect(index.barWindow(at: -0.001, bars: 16) == nil)
        #expect(index.barWindow(at: downbeats[24] + 0.001, bars: 16) == nil)
        #expect(index.barWindow(at: currentTime, bars: 0) == nil)
        #expect(index.barWindow(at: currentTime, bars: Int.max) == nil)
        let tooShort = BeatGridIndex(try grid(downbeats: (0...15).map(Double.init)))
        #expect(tooShort.barWindow(at: 8, bars: 16) == nil)
    }
    @Test func compactGridRoundTripsAndLegacyWaveformRemainsReadable() throws {
        let grid = try grid(downbeats: [0, 4, 8, 12, 16])
        let waveform = Waveform(peaks: [0.1, 0.8], source: "rekordbox", durationSeconds: 16, beatGrid: grid)
        #expect(try JSONDecoder().decode(Waveform.self, from: JSONEncoder().encode(waveform)) == waveform)
        let old = try JSONDecoder().decode(Waveform.self, from: Data(#"{"peaks":[0.1,0.8],"source":"rekordbox","durationSeconds":16}"#.utf8))
        #expect(old.beatGrid == nil && old.peaks == waveform.peaks)
        let malformed = try JSONDecoder().decode(Waveform.self, from: Data(#"{"peaks":[0.1,0.8],"source":"rekordbox","beatGrid":{"times":[1,0],"beats":[1,2]}}"#.utf8))
        #expect(malformed.beatGrid == nil && malformed.peaks == waveform.peaks)
    }
    @Test func centeredSixteenBarViewportMovesImmediatelyThroughNormalAudioEdges() throws {
        let grid = try grid(downbeats: (0...20).map { 0.5 + Double($0) * 4 })
        let index = BeatGridIndex(grid)
        let initial = try #require(index.centeredBarWindow(at: 0, bars: 16, duration: 81))
        let moving = try #require(index.centeredBarWindow(at: 1, bars: 16, duration: 81))
        #expect(initial.start == -32 && initial.end == 32)
        #expect(moving.start == -31 && moving.end == 33)
        #expect(initial.firstBeatIndex == 0 && initial.endBeatIndex == 32)
        let ending = try #require(index.centeredBarWindow(at: 81, bars: 16, duration: 81))
        #expect(ending.start == 49 && ending.end == 113)
        #expect(ending.endBeatIndex == grid.times.count)
        #expect(ending.beatRange.allSatisfy { grid.times[$0] >= ending.start && grid.times[$0] <= 81 })
    }
    @Test func arbitraryViewportBeatRangeIncludesExactEdgesWithoutInventingBeats() throws {
        let index = BeatGridIndex(try grid(downbeats: [0, 4, 8, 12, 16]))
        #expect(index.beatRange(from: 4.5, to: 8) == 5..<9)
        #expect(index.beatRange(from: 4, to: 4) == 4..<5)
        #expect(index.beatRange(from: -8, to: 1) == 0..<2)
        #expect(index.beatRange(from: -8, to: -1).isEmpty)
        #expect(index.beatRange(from: 17, to: 32).isEmpty)
        #expect(index.beatRange(from: 8, to: 4).isEmpty)
        #expect(index.beatRange(from: .nan, to: 4).isEmpty)
        #expect(index.beatRange(from: 0, to: .infinity).isEmpty)
    }
    @Test func centeredViewportKeepsMeasuredVariableTempoScaleAndRejectsTruncatedCoverage() throws {
        let downbeats = (0...24).map { Double($0 * ($0 + 1) / 2) }
        let index = BeatGridIndex(try grid(downbeats: downbeats))
        let time = (downbeats[10] + downbeats[11]) / 2
        let exact = try #require(index.barWindow(at: time, bars: 16))
        let centered = try #require(index.centeredBarWindow(at: time, bars: 16, duration: 301))
        #expect(centered.end - centered.start == exact.end - exact.start)
        #expect((centered.start + centered.end) / 2 == time)
        #expect(index.centeredBarWindow(at: 301, bars: 16, duration: 700) == nil)
        #expect(index.centeredBarWindow(at: 700, bars: 16, duration: 700) == nil)
        let lateGrid = BeatGridIndex(try grid(downbeats: (0...20).map { 10 + Double($0) * 4 }))
        #expect(lateGrid.centeredBarWindow(at: 0, bars: 16, duration: 91) == nil)
        #expect(index.centeredBarWindow(at: .nan, bars: 16, duration: 301) == nil)
        #expect(index.centeredBarWindow(at: 0, bars: 16, duration: .infinity) == nil)
        #expect(index.centeredBarWindow(at: -1, bars: 16, duration: 301) == nil)
        #expect(index.centeredBarWindow(at: 302, bars: 16, duration: 301) == nil)
        #expect(index.centeredBarWindow(at: 0, bars: Int.max, duration: 301) == nil)
    }
    @Test func malformedOrOversizedGridsAreRejected() {
        #expect(BeatGrid(times: [0, 1], beats: [1]) == nil)
        #expect(BeatGrid(times: [0, 0], beats: [1, 2]) == nil)
        #expect(BeatGrid(times: [1, 0], beats: [1, 2]) == nil)
        #expect(BeatGrid(times: [-1], beats: [1]) == nil)
        #expect(BeatGrid(times: [.infinity], beats: [1]) == nil)
        #expect(BeatGrid(times: [0], beats: [5]) == nil)
        #expect(BeatGrid(times: (0...20_000).map(Double.init), beats: Array(repeating: 1, count: 20_001)) == nil)
    }
    @Test func workstationBeatObjectsDecodeToCompactGridAndInvalidEntriesStayUnavailable() throws {
        let waveform = try JSONDecoder().decode(Waveform.self, from: Data(#"{"peaks":[0.1,0.8],"source":"rekordbox","beatGrid":[{"beat":1,"timeSeconds":0},{"beat":2,"timeSeconds":0.5},{"beat":3,"timeSeconds":1}]}"#.utf8))
        #expect(waveform.beatGrid?.times == [0, 0.5, 1])
        #expect(waveform.beatGrid?.beats == [1, 2, 3])
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(waveform)) as? [String: Any]
        #expect(encoded?["beatGrid"] is [String: Any])
        let malformed = try JSONDecoder().decode(Waveform.self, from: Data(#"{"peaks":[0.1,0.8],"source":"rekordbox","beatGrid":[{"beat":1,"timeSeconds":1},{"beat":2,"timeSeconds":0}]}"#.utf8))
        #expect(malformed.beatGrid == nil && malformed.peaks == waveform.peaks)
    }
}
