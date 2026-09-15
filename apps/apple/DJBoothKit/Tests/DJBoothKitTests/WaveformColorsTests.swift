import Foundation
import Testing
@testable import DJBoothKit

struct WaveformColorsTests {
    @Test func realisticRGBWaveformsPackLosslesslyAndExposeAllocationFreeComponents() throws {
        let rows = (0..<8192).map { [$0 % 256, ($0 * 3) % 256, 255 - $0 % 256] }
        let wire = try JSONEncoder().encode(rows)
        let colors = try JSONDecoder().decode(WaveformColors.self, from: wire)
        #expect(colors.packedByteCount == 8192 * 3)
        #expect(Array(colors) == rows)
        #expect(try JSONDecoder().decode([[Int]].self, from: JSONEncoder().encode(colors)) == rows)
        #expect(colors == WaveformColors(rows))
        let sample = try #require(colors.rgb(at: 255))
        #expect(sample.red == 1 && sample.green == Double(253) / 255 && sample.blue == 0)
        #expect(colors.rgb(at: -1) == nil && colors.rgb(at: colors.count) == nil)
    }
    @Test func irregularLegacyRowsRemainLosslessAndKeepClampedRenderingFallback() throws {
        let rows = [[0, 1, 2], [], [1, 2], [-20, 300, 128, 7], [255, 0, 255]]
        let colors = try JSONDecoder().decode(WaveformColors.self, from: JSONEncoder().encode(rows))
        #expect(colors.packedByteCount == nil && Array(colors) == rows)
        #expect(try JSONDecoder().decode([[Int]].self, from: JSONEncoder().encode(colors)) == rows)
        #expect(colors.rgb(at: 1) == nil && colors.rgb(at: 2) == nil)
        let sample = try #require(colors.rgb(at: 3))
        #expect(sample.red == 0 && sample.green == 1 && sample.blue == Double(128) / 255)
        #expect(colors == WaveformColors(rows))
    }
    @Test func waveformWireAndExistingArrayInitializerRemainCompatible() throws {
        let waveform = Waveform(peaks: [0.5], colors: [[1, 2, 3]], durationSeconds: 10)
        let decoded = try JSONDecoder().decode(Waveform.self, from: JSONEncoder().encode(waveform))
        #expect(decoded == waveform && decoded.colors?[0] == [1, 2, 3])
        #expect(try JSONDecoder().decode(WaveformColors.self, from: Data("[]".utf8)).isEmpty)
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(WaveformColors.self, from: Data("[[1,2,2.5]]".utf8)) }
        #expect(throws: DecodingError.self) { try JSONDecoder().decode(WaveformColors.self, from: Data("[1,2,3]".utf8)) }
    }
}
