import AVFoundation
import Foundation
import Testing
@testable import DJBoothKit

struct PlaybackAssetTests {
    @Test func extensionlessCachedWavePlaysWithNativeAVFoundation() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = try AudioFiles(directory: directory)
        let file = try #require(cache.url(hash: String(repeating: "a", count: 64)))
        var wave = Data("RIFF".utf8)
        func integer(_ value: UInt32, bytes: Int) { for shift in 0..<bytes { wave.append(UInt8(truncatingIfNeeded: value >> (shift * 8))) } }
        integer(8036, bytes: 4); wave.append(Data("WAVEfmt ".utf8)); integer(16, bytes: 4)
        integer(1, bytes: 2); integer(1, bytes: 2); integer(8000, bytes: 4); integer(16000, bytes: 4)
        integer(2, bytes: 2); integer(16, bytes: 2); wave.append(Data("data".utf8)); integer(8000, bytes: 4)
        wave.append(Data(repeating: 0, count: 8000)); try wave.write(to: file)
        let asset = AudioFiles.playbackAsset(url: file)
        #expect(try await asset.load(.isPlayable))
        #expect(abs(try await asset.load(.duration).seconds - 0.5) < 0.01)
        #expect(try Data(contentsOf: file) == wave)
    }

    @Test func cacheContainerDetectionUsesBytesAndSupportsMetadataFallback() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension("audio")
        defer { try? FileManager.default.removeItem(at: file) }
        let signatures: [(Data, String)] = [
            (Data([0, 0, 0, 24]) + Data("ftypM4A ".utf8), "audio/mp4"),
            (Data("RIFF0000WAVE".utf8), "audio/wav"),
            (Data("FORM0000AIFF".utf8), "audio/aiff"),
            (Data("fLaC".utf8), "audio/flac"),
            (Data("OggS".utf8), "audio/ogg"),
            (Data("ID3".utf8), "audio/mpeg"),
            (Data([0xff, 0xfb]), "audio/mpeg"),
            (Data([0xff, 0xf1]), "audio/aac"),
        ]
        for (bytes, mime) in signatures {
            try bytes.write(to: file)
            #expect(AudioFiles.playbackMIMEType(url: file, mediaExtension: "txt") == mime)
        }
        try Data(repeating: 0, count: 16).write(to: file)
        #expect(AudioFiles.playbackMIMEType(url: file, mediaExtension: "mp3") == "audio/mpeg")
        #expect(AudioFiles.playbackMIMEType(url: file) == nil)
    }
}
