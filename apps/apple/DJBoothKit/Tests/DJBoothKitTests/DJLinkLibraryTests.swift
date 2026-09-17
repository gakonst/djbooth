import Foundation
import Testing
@testable import DJBoothKit

@Test func djLinkUsesProviderFoldersAndOnlyPlayableDownloadedPlaylists() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    let audio = root.appendingPathComponent("Audio")
    try FileManager.default.createDirectory(at: audio, withIntermediateDirectories: true)
    let hash = String(repeating: "a", count: 64)
    try Data("downloaded fixture".utf8).write(to: audio.appendingPathComponent(hash + ".audio"))
    let analysis = CDJAnalysis(mediaHash: hash, dat: hash, ext: hash, twoEx: hash)
    let tracks = ["one", "two"].map { Track(id: $0, title: $0, mediaHash: hash, mediaExtension: "mp3", analysis: analysis) }
        + [Track(id: "not-ready", title: "No CDJ analysis", mediaHash: hash, mediaExtension: "mp3")]
    var catalog = MusicCatalog()
    catalog.sources = [
        MusicSource(id: "spotify:a", provider: "spotify", connectionID: "abcdef1", accountID: "alice", label: "Alice"),
        MusicSource(id: "spotify:b", provider: "spotify", connectionID: "ghijkl2", accountID: "bob", label: "Bob"),
        MusicSource(id: "soundcloud:a", provider: "soundcloud", connectionID: "mnopqr3", accountID: "dj", label: "DJ")
    ]
    catalog.playlists = [
        MusicPlaylist(id: "connected:spotify:a:set", remoteID: "set", sourceID: "spotify:a", name: "Saved mix", url: "https://open.spotify.com/playlist/set", trackCount: 4),
        MusicPlaylist(id: "connected:soundcloud:a:set", remoteID: "set", sourceID: "soundcloud:a", name: "Night mix", url: "https://soundcloud.com/dj/sets/set", trackCount: 1),
        MusicPlaylist(id: "connected:spotify:b:stream", remoteID: "stream", sourceID: "spotify:b", name: "Streaming only", url: "https://open.spotify.com/playlist/stream", trackCount: 1)
    ]
    let durable = [
        Collection(id: "import-spotify", name: "Old import title", trackIDs: ["two", "not-ready", "one", "two"], folderPath: ["Imports"]),
        Collection(id: "import-soundcloud", name: "Other import title", trackIDs: ["one"]),
        Collection(id: "manual", name: "Saved mix", trackIDs: ["two"], folderPath: ["Sets", "Live"]),
        Collection(id: "pending", name: "Not ready", trackIDs: ["not-ready"], folderPath: ["Pending"])
    ]
    let jobs = zip(catalog.playlists.prefix(2), durable.prefix(2)).enumerated().map { index, pair in
        CloudImportJob(id: "job-\(index)", source: pair.0.url + "?utm_source=phone", status: "complete", phase: "complete", current: 1, total: 1, message: "", collectionID: pair.1.id, createdAt: 1, updatedAt: 2)
    }
    catalog.rememberDownloads(jobs)
    // Relaunch offline: the cached provider/import association must suffice.
    catalog = try JSONDecoder().decode(MusicCatalog.self, from: JSONEncoder().encode(catalog))
    let projected = durable + catalog.collections(jobs: [], library: durable)
    let visible = catalog.visibleCollections(in: projected)
    #expect(!visible.contains { ["import-spotify", "import-soundcloud"].contains($0.id) })
    #expect(catalog.visibleCollections(in: durable) == durable, "Missing provider projections cannot hide durable downloads")
    var identities: [String: UInt32] = [:]
    let library = try DJLinkLibrary.prepare(tracks: tracks, collections: visible, annotations: [:], audioDirectory: audio,
        sessionDirectory: root.appendingPathComponent("Session"), idForIdentity: { identity in
            if let id = identities[identity] { return id }
            let id = UInt32(identities.count + 1); identities[identity] = id; return id
        })
    let byID = Dictionary(uniqueKeysWithValues: library.playlists.map { ($0.playlistId, $0) })
    func path(_ row: DJLinkLibrary.PlaylistRow) throws -> [String] {
        var names = [row.name], parent = row.parentId
        while parent != 0 {
            let folder = try #require(byID[parent])
            #expect(folder.isFolder)
            names.insert(folder.name, at: 0); parent = folder.parentId
        }
        return names
    }
    let leaves = library.playlists.filter { !$0.isFolder }
    #expect(try leaves.map(path) == [["Sets", "Live", "Saved mix"], ["Spotify", "Alice · abcdef", "Saved mix"], ["SoundCloud", "Night mix"]])
    #expect(!library.playlists.contains { ["Imports", "Pending", "Bob · ghijkl", "Streaming only"].contains($0.name) })
    let ids = Dictionary(uniqueKeysWithValues: library.tracks.map { ($0.canonicalName, $0.trackId) })
    let spotify = try #require(leaves.first { $0.name == "Saved mix" && $0.tracks.count == 3 })
    #expect(spotify.tracks == [ids["two"]!, ids["one"]!, ids["two"]!])
    for parent in Set(library.playlists.map(\.parentId)) {
        let children = library.playlists.filter { $0.parentId == parent }
        #expect(children.map(\.sequence) == (1...children.count).map(UInt32.init))
    }
}

@Test func djLinkSharesOnlyDownloadedAudioAndPreservesPlaylistOrder() throws {
    // Test adapter only: production supplies the Rust stable_text_id binding.
    var fixtureIDs: [String: UInt32] = [:]
    func fixtureID(_ identity: String) -> UInt32 {
        if let id = fixtureIDs[identity] { return id }
        let id = UInt32(fixtureIDs.count + 1); fixtureIDs[identity] = id; return id
    }
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
        sessionDirectory: root.appendingPathComponent("Session"), idForIdentity: fixtureID)
    #expect(library.tracks.count == 2)
    #expect(library.omittedTracks == 3)
    #expect(library.tracks[0].comment == "Keep this note")
    #expect(library.playlists.map(\.name) == ["Sets", "Live", "Set"])
    #expect(library.playlists.map(\.parentId) == [0, library.playlists[0].playlistId, library.playlists[1].playlistId])
    let one = library.tracks[0].trackId, two = library.tracks[1].trackId
    #expect(library.playlists[2].tracks == [two, one, two])
    let duplicateCollections = try DJLinkLibrary.prepare(tracks: tracks,
        collections: [
            Collection(id: "set", name: "Set", trackIDs: ["two", "one", "two"], folderPath: ["Sets"]),
            Collection(id: "set", name: "Provider copy", trackIDs: [], folderPath: ["Provider"]),
            Collection(id: "other", name: "Set", trackIDs: ["one"], folderPath: ["Sets"])
        ], annotations: [:], audioDirectory: audio,
        sessionDirectory: root.appendingPathComponent("Duplicates"), idForIdentity: fixtureID)
    #expect(duplicateCollections.playlists.map(\.name) == ["Sets", "Set", "Set"])
    #expect(Set(duplicateCollections.playlists.map(\.playlistId)).count == 3)
    #expect(duplicateCollections.playlists[1].tracks == [two, one, two])
    #expect(duplicateCollections.playlists[2].tracks == [one])
    let expanded = try DJLinkLibrary.prepare(tracks: tracks + [Track(id: "aaa", title: "Earlier", mediaHash: hash, mediaExtension: "mp3", analysis: analysis)],
        collections: [], annotations: [:], audioDirectory: audio, sessionDirectory: root.appendingPathComponent("Expanded"), idForIdentity: fixtureID)
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
        audioDirectory: audio, sessionDirectory: root.appendingPathComponent("Omitted"), idForIdentity: fixtureID)
    #expect(omitted.tracks.isEmpty)

    try FileManager.default.removeItem(at: root.appendingPathComponent("Session"))
    #expect(try Data(contentsOf: audio.appendingPathComponent(hash + ".audio")) == bytes)
}
