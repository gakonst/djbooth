import Foundation
import Testing
@testable import DJBoothKit

@MainActor struct ConnectedMusicTests {
    private func catalog() throws -> MusicCatalog {
        let data = Data(#"{"sources":[{"id":"spotify:a","provider":"spotify","connectionID":"a","accountID":"alice","label":"Alice"}],"playlists":[{"id":"connected:spotify:a:playlist:p","remoteID":"p","sourceID":"spotify:a","name":"Set","url":"https://open.spotify.com/playlist/p","trackCount":2}],"snapshots":{},"fetchedAt":1}"#.utf8)
        var value = try JSONDecoder().decode(MusicCatalog.self, from: data)
        let track = MusicTrack(id: "connected:spotify:a:track:t", remoteID: "t", title: "Song", artists: ["Artist"], durationSeconds: 100, url: "https://open.spotify.com/track/t", available: true)
        value.snapshots[value.playlists[0].id] = MusicPlaylistSnapshot(playlist: value.playlists[0], tracks: [track, track], fetchedAt: 1)
        return value
    }
    @Test func metadataCacheSurvivesRestartWithoutSyncEditsOrFabricatedAnalysis() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let value = try catalog()
        do {
            let store = try LibraryStore(directory: directory)
            try store.saveMusicCatalog(value)
            #expect(try store.pendingCount() == 0)
            #expect(try store.values(.track, as: Track.self).isEmpty)
        }
        let store = try LibraryStore(directory: directory)
        let restored = try store.musicCatalog()
        #expect(restored == value)
        #expect(restored.tracks.count == 1)
        #expect(restored.tracks[0].waveform == nil)
        #expect(restored.tracks[0].key == nil)
        #expect(!restored.tracks[0].analyzed)
        #expect(restored.tracks[0].mediaHash == nil)
        #expect(restored.collections(jobs: [], library: []).first?.trackIDs.count == 2)
    }
    @Test func revokedSourceCannotProjectCachedMetadataAndOtherAccountStartsEmpty() throws {
        var value = try catalog(); value.sources = []
        #expect(value.tracks.isEmpty)
        #expect(value.collections(jobs: [], library: []).isEmpty)
        let other = try LibraryStore(inMemory: true)
        #expect(try other.musicCatalog().sources.isEmpty)
    }
}
