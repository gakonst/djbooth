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
    @Test func downloadedPlaylistKeepsServiceIdentityAndCanonicalAnalysisAfterRestart() throws {
        var value = try catalog()
        let playlist = value.playlists[0]
        let job = CloudImportJob(id: "download", source: playlist.url + "?si=share&utm_source=mobile", status: "complete", phase: "complete", current: 2, total: 2, message: "Published", collectionID: "acquired", createdAt: 1, updatedAt: 2)
        let track = Track(id: "recording", title: "Acquired song", key: "8A", bpm: 128, analyzed: true, mediaHash: "audio", waveform: Waveform(peaks: [0.2, 0.8]))
        let acquired = Collection(id: "acquired", name: "Import name", trackIDs: [track.id, track.id])
        let changed = value.rememberDownloads([job])
        #expect(changed)
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        do {
            let store = try LibraryStore(directory: directory)
            try store.saveMusicCatalog(value)
            try store.ingest([track], enqueue: false)
        }
        let store = try LibraryStore(directory: directory)
        let restored = try store.musicCatalog()
        // No jobs response is needed on relaunch or after history is truncated.
        let projected = try #require(restored.collections(jobs: [], library: [acquired]).first)
        #expect(projected.id == playlist.id)
        #expect(projected.name == playlist.name)
        #expect(projected.folderPath == ["Spotify"])
        #expect(projected.trackIDs == [track.id, track.id])
        let storedTrack = try #require(store.values(.track, as: Track.self).first { $0.id == projected.trackIDs[0] })
        #expect(storedTrack.analyzed && storedTrack.bpm == 128 && storedTrack.key == "8A")
        #expect(storedTrack.waveform?.peaks == [0.2, 0.8])
        #expect(try store.pendingCount() == 0)
        #expect(restored.downloadedCollection(for: playlist, library: []) == nil)
        #expect(restored.collections(jobs: [], library: []).first?.trackIDs == value.snapshots[playlist.id]?.tracks.map(\.id))
        var revoked = restored; revoked.sources = []
        #expect(revoked.downloadedCollection(for: playlist, library: [acquired]) == nil)
    }
    @Test func newestCompletedDownloadWinsAndPrivateSoundCloudLinksStayDistinct() throws {
        var value = try catalog()
        value.sources[0].provider = "soundcloud"
        value.playlists[0].url = "https://soundcloud.com/dj/sets/set/s-private"
        let item = value.playlists[0]
        let old = CloudImportJob(id: "old", source: item.url, status: "complete", phase: "complete", current: 1, total: 1, message: "", collectionID: "old-library", createdAt: 1, updatedAt: 1)
        var latest = old; latest.id = "new"; latest.collectionID = "new-library"; latest.updatedAt = 2
        var failed = latest; failed.status = "failed"; failed.collectionID = nil; failed.updatedAt = 3
        value.rememberDownloads([latest, failed, old])
        let library = [Collection(id: "new-library", name: "Set", trackIDs: ["canonical"])]
        #expect(value.collections(jobs: [], library: library).first?.trackIDs == ["canonical"])
        #expect(value.collections(jobs: [], library: library).first?.folderPath == ["SoundCloud"])
        var other = item; other.url = "https://soundcloud.com/dj/sets/set/s-other"
        #expect(value.downloadedCollection(for: other, library: library) == nil)
    }
}
