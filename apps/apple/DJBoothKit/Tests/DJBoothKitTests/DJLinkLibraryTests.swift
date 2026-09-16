import Foundation
import Testing
@testable import DJBoothKit

@Test func djLinkSharesOnlyDownloadedAudioAndPreservesPlaylistOrder() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let audio = root.appendingPathComponent("Audio")
    try FileManager.default.createDirectory(at: audio, withIntermediateDirectories: true)
    let hash = String(repeating: "a", count: 64)
    let bytes = Data("immutable fixture".utf8)
    try bytes.write(to: audio.appendingPathComponent(hash + ".audio"))
    let analysis = CDJAnalysis(mediaHash: hash, dat: hash, ext: hash, twoEx: hash)
    let tracks = [
        Track(id: "one", title: "One", mediaHash: hash, mediaExtension: "mp3", analysis: analysis),
        Track(id: "two", title: "Two", mediaHash: hash, mediaExtension: "mp3", analysis: analysis),
        Track(id: "missing", title: "Missing", mediaHash: String(repeating: "b", count: 64), mediaExtension: "mp3", analysis: analysis),
        Track(id: "unsafe", title: "Unsafe", mediaHash: "../secret", mediaExtension: "mp3", analysis: analysis),
        Track(id: "unsupported", title: "Unsupported", mediaHash: hash, mediaExtension: "webm")
    ]
    let library = try DJLinkLibrary.prepare(tracks: tracks,
        collections: [Collection(name: "Set", trackIDs: ["two", "missing", "one", "two"], folderPath: ["Sets", "Live"])],
        annotations: ["one": TrackAnnotation(note: "Keep this note")], audioDirectory: audio,
        sessionDirectory: root.appendingPathComponent("Session"))
    #expect(library.tracks.count == 2)
    #expect(library.omittedTracks == 3)
    #expect(library.tracks[0].comment == "Keep this note")
    #expect(library.playlists.map(\.name) == ["Sets", "Live", "Set"])
    #expect(library.playlists.map(\.parentId) == [0, library.playlists[0].playlistId, library.playlists[1].playlistId])
    let one = library.tracks[0].trackId, two = library.tracks[1].trackId
    #expect(library.playlists[2].tracks == [two, one, two])
    let expanded = try DJLinkLibrary.prepare(tracks: tracks + [Track(id: "aaa", title: "Earlier", mediaHash: hash, mediaExtension: "mp3", analysis: analysis)],
        collections: [], annotations: [:], audioDirectory: audio, sessionDirectory: root.appendingPathComponent("Expanded"))
    #expect(expanded.tracks.first { $0.canonicalName == "one" }?.trackId == one)
    #expect(expanded.tracks.first { $0.canonicalName == "two" }?.trackId == two)
    let served = URL(fileURLWithPath: library.tracks[0].mountPath)
    #expect(served.pathExtension == "mp3")
    #expect(try Data(contentsOf: served) == bytes)
    let exportedAnalysis = URL(fileURLWithPath: library.tracks[0].analysisDatPath!)
    try Data("relocated".utf8).write(to: exportedAnalysis)
    #expect(try Data(contentsOf: audio.appendingPathComponent(hash + ".audio")) == bytes)
    var absent = tracks[0]; absent.analysis = nil
    var stale = tracks[0]; stale.analysis?.mediaHash = String(repeating: "b", count: 64)
    let omitted = try DJLinkLibrary.prepare(tracks: [absent, stale], collections: [], annotations: [:],
        audioDirectory: audio, sessionDirectory: root.appendingPathComponent("Omitted"))
    #expect(omitted.tracks.isEmpty)

    try FileManager.default.removeItem(at: root.appendingPathComponent("Session"))
    #expect(try Data(contentsOf: audio.appendingPathComponent(hash + ".audio")) == bytes)
}

