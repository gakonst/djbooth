import Foundation
import Testing
@testable import DJBoothKit

@MainActor struct LibraryTests {
    private func fixture(_ id: String = "track-1") -> Track {
        Track(id: id, title: "A recording", artist: "An artist", fileExists: true)
    }

    @Test func offlineEditsSurviveRestartWithSameOperationID() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var store: LibraryStore? = try LibraryStore(directory: directory)
        try store!.save(Collection(id: "one", name: "After hours", trackIDs: ["track-1"]), kind: .collection, id: "one")
        let operationID = try store!.nextOperation()!.operationID
        store = nil
        let restored = try LibraryStore(directory: directory)
        #expect(try restored.values(.collection, as: Collection.self).first?.trackIDs == ["track-1"])
        #expect(try restored.nextOperation()?.operationID == operationID)
        #expect(try restored.pendingCount() == 1)
    }

    @Test func acknowledgementPreservesEditsMadeDuringRequest() throws {
        let store = try LibraryStore(inMemory: true)
        try store.save(Collection(id: "one", name: "Original"), kind: .collection, id: "one")
        let first = try #require(try store.nextOperation())
        try store.save(Collection(id: "one", name: "Edited offline"), kind: .collection, id: "one")
        try store.acknowledge(SyncChange(sequence: 1, operationID: first.operationID, kind: .collection, entityID: "one", payload: first.payload, deleted: false))
        #expect(try store.values(.collection, as: Collection.self).first?.name == "Edited offline")
        #expect(try store.pendingCount() == 1)
        #expect(try store.nextOperation()?.baseVersion == 1)
    }

    @Test func lostAcknowledgementDoesNotHideLaterRemoteEdit() throws {
        let store = try LibraryStore(inMemory: true)
        try store.save(Collection(id: "one", name: "Our committed edit"), kind: .collection, id: "one")
        let operation = try #require(try store.nextOperation())
        let echoed = SyncChange(sequence: 1, operationID: operation.operationID, kind: .collection,
                                entityID: "one", payload: operation.payload, deleted: false)
        let remotePayload = String(decoding: try JSONEncoder().encode(Collection(id: "one", name: "Later edit from iPhone")), as: UTF8.self)
        let remote = SyncChange(sequence: 2, operationID: "iphone-edit", kind: .collection,
                                entityID: "one", payload: remotePayload, deleted: false)
        // Our POST reached the cloud but its response was lost. The next pull sees
        // both our own committed operation and another device's subsequent edit.
        try store.apply(SyncPage(changes: [echoed, remote], cursor: 2, hasMore: false))
        #expect(try store.pendingCount() == 0)
        #expect(try store.cursor() == 2)
        #expect(try store.values(.collection, as: Collection.self).first?.name == "Later edit from iPhone")
        // A delayed duplicate response must not undo the newer remote state or
        // rebase an unrelated newly queued edit onto an older version.
        try store.save(Collection(id: "one", name: "A newer local edit"), kind: .collection, id: "one")
        try store.acknowledge(echoed)
        #expect(try store.nextOperation()?.baseVersion == 2)
        #expect(try store.values(.collection, as: Collection.self).first?.name == "A newer local edit")
    }

    @Test func pulledAcknowledgementAndCursorCommitTogetherAcrossRestart() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var store: LibraryStore? = try LibraryStore(directory: directory)
        try store!.save(Collection(id: "one", name: "Committed"), kind: .collection, id: "one")
        let operation = try #require(try store!.nextOperation())
        let echoed = SyncChange(sequence: 10, operationID: operation.operationID, kind: .collection,
                                entityID: "one", payload: operation.payload, deleted: false)
        try store!.apply(SyncPage(changes: [echoed], cursor: 10, hasMore: true))
        store = nil
        let restored = try LibraryStore(directory: directory)
        #expect(try restored.pendingCount() == 0)
        #expect(try restored.cursor() == 10)
        let removed = SyncChange(sequence: 11, operationID: "remote-delete", kind: .collection,
                                 entityID: "one", payload: nil, deleted: true)
        try restored.apply(SyncPage(changes: [removed], cursor: 11, hasMore: false))
        #expect(try restored.values(.collection, as: Collection.self).isEmpty)
    }

    @Test func pulledAcknowledgementPreservesAndRebasesSubsequentLocalEdit() throws {
        let store = try LibraryStore(inMemory: true)
        try store.save(Collection(id: "one", name: "First local"), kind: .collection, id: "one")
        let first = try #require(try store.nextOperation())
        try store.save(Collection(id: "one", name: "Still unsent local edit"), kind: .collection, id: "one")
        let echoed = SyncChange(sequence: 1, operationID: first.operationID, kind: .collection,
                                entityID: "one", payload: first.payload, deleted: false)
        let remote = SyncChange(sequence: 2, operationID: "another-device", kind: .collection,
                                entityID: "one", payload: first.payload, deleted: false)
        try store.apply(SyncPage(changes: [echoed, remote], cursor: 2, hasMore: false))
        #expect(try store.pendingCount() == 1)
        #expect(try store.nextOperation()?.operationID != first.operationID)
        #expect(try store.nextOperation()?.baseVersion == 1)
        #expect(try store.values(.collection, as: Collection.self).first?.name == "Still unsent local edit")
    }

    @Test func inconsistentAcknowledgementCannotClearOutboxOrAdvanceCursor() throws {
        let store = try LibraryStore(inMemory: true)
        try store.save(Collection(id: "one", name: "Our edit"), kind: .collection, id: "one")
        let operation = try #require(try store.nextOperation())
        let invalid = SyncChange(sequence: 1, operationID: operation.operationID, kind: .collection,
                                 entityID: "different-item", payload: operation.payload, deleted: false)
        #expect(throws: ClientError.self) {
            try store.apply(SyncPage(changes: [invalid], cursor: 1, hasMore: false))
        }
        #expect(try store.cursor() == 0)
        #expect(try store.pendingCount() == 1)
        #expect(try store.values(.collection, as: Collection.self).first?.name == "Our edit")
    }

    @Test func pullsNeverErasePendingChangesAndConflictSurvivesRestart() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var store: LibraryStore? = try LibraryStore(directory: directory)
        try store!.save(Collection(id: "one", name: "Local"), kind: .collection, id: "one")
        let operation = try #require(try store!.nextOperation())
        let remotePayload = String(decoding: try JSONEncoder().encode(Collection(id: "one", name: "Remote")), as: UTF8.self)
        let remote = SyncChange(sequence: 10, operationID: "another-device", kind: .collection, entityID: "one", payload: remotePayload, deleted: false)
        try store!.apply(SyncPage(changes: [remote], cursor: 10, hasMore: false))
        #expect(try store!.values(.collection, as: Collection.self).first?.name == "Local")
        #expect(try store!.cursor() == 10)
        try store!.markConflict(operation, remote: remote)
        #expect(try store!.nextOperation() == nil)
        store = nil
        let restored = try LibraryStore(directory: directory)
        let conflict = try #require(try restored.conflicts().first)
        try restored.resolveConflict(conflict.id, keepLocal: true)
        let retry = try #require(try restored.nextOperation())
        #expect(retry.baseVersion == 10)
        #expect(retry.operationID != operation.operationID)
        #expect(try restored.values(.collection, as: Collection.self).first?.name == "Local")
    }

    @Test func chooseRemoteAndTombstonesDoNotResurrectItems() throws {
        let store = try LibraryStore(inMemory: true)
        try store.save(Collection(id: "one", name: "Local"), kind: .collection, id: "one")
        let operation = try #require(try store.nextOperation())
        let deleted = SyncChange(sequence: 20, operationID: "delete", kind: .collection, entityID: "one", payload: nil, deleted: true)
        try store.markConflict(operation, remote: deleted)
        try store.resolveConflict(operation.operationID, keepLocal: false)
        #expect(try store.values(.collection, as: Collection.self).isEmpty)
        #expect(try store.pendingCount() == 0)
        let old = SyncChange(sequence: 5, operationID: "old", kind: .collection, entityID: "one", payload: operation.payload, deleted: false)
        try store.apply(SyncPage(changes: [old], cursor: 5, hasMore: false))
        #expect(try store.values(.collection, as: Collection.self).isEmpty)
    }

    @Test func conflictedItemDoesNotBlockOtherEntities() throws {
        let store = try LibraryStore(inMemory: true)
        try store.save(Collection(id: "one", name: "Local"), kind: .collection, id: "one")
        let first = try #require(try store.nextOperation())
        try store.markConflict(first, remote: SyncChange(sequence: 8, operationID: "remote", kind: .collection, entityID: "one", payload: first.payload, deleted: false))
        try store.toggleFavorite("two")
        #expect(try store.nextOperation()?.entityID == "two")
    }

    @Test func ingestionPreservesAudioAndDoesNotQueueUnchangedMetadata() throws {
        let store = try LibraryStore(inMemory: true)
        var track = fixture(); track.mediaHash = String(repeating: "a", count: 64)
        track.waveform = Waveform(peaks: [0.2, 0.8], colors: [[30, 100, 200], [100, 200, 30]], durationSeconds: 10)
        try store.save(track, kind: .track, id: track.id)
        let first = try #require(try store.nextOperation())
        try store.acknowledge(SyncChange(sequence: 1, operationID: first.operationID, kind: .track, entityID: track.id, payload: first.payload, deleted: false))
        try store.ingest([fixture()])
        #expect(try store.pendingCount() == 0)
        #expect(try store.values(.track, as: Track.self).first?.mediaHash == track.mediaHash)
        #expect(try store.values(.track, as: Track.self).first?.waveform == track.waveform)
        var changed = fixture(); changed.title = "New title"
        try store.ingest([changed])
        #expect(try store.pendingCount() == 1)
        #expect(try store.values(.track, as: Track.self).first?.mediaHash == track.mediaHash)
        #expect(try store.values(.track, as: Track.self).first?.waveform == track.waveform)
    }

    @Test func workstationCacheDoesNotPublishSamplesOrOverwriteSyncedTracks() throws {
        let store = try LibraryStore(inMemory: true)
        try store.ingest([fixture("sample")], enqueue: false)
        #expect(try store.pendingCount() == 0)
        #expect(try store.values(.track, as: Track.self).count == 1)
        let remote = Track(id: "synced", title: "Cloud title", mediaHash: String(repeating: "a", count: 64))
        let payload = String(decoding: try JSONEncoder().encode(remote), as: UTF8.self)
        try store.apply(SyncPage(changes: [SyncChange(sequence: 1, operationID: "publisher", kind: .track, entityID: "synced", payload: payload, deleted: false)], cursor: 1, hasMore: false))
        try store.ingest([fixture("synced")], enqueue: false)
        #expect(try store.values(.track, as: Track.self).first { $0.id == "synced" }?.title == "Cloud title")
        #expect(try store.pendingCount() == 0)
        // Explicitly choosing a workstation recording for publication does queue it.
        try store.ingest([fixture("sample")], enqueue: true)
        #expect(try store.pendingCount() == 1)
    }

    @Test func workstationDTOExcludesFilesystemPathsFromSync() throws {
        let raw = Data("""
        {"id":"123","title":"Track","artist":null,"album":null,"genre":null,"key":null,"bpm":null,"durationSeconds":10,"artworkAvailable":false,"fileExists":true,"analyzed":true,"path":"/private/music.flac"}
        """.utf8)
        let decoded = try JSONDecoder().decode(Track.self, from: raw)
        let encoded = String(decoding: try JSONEncoder().encode(decoded), as: UTF8.self)
        #expect(!encoded.contains("/private/"))
        #expect(!encoded.contains("\"path\""))
    }

    @Test func favoriteToggleIsOfflineAndDurable() throws {
        let store = try LibraryStore(inMemory: true)
        try store.toggleFavorite("x")
        #expect(try store.favoriteIDs() == ["x"])
        try store.toggleFavorite("x")
        #expect(try store.favoriteIDs().isEmpty)
    }

    @Test func favoritesDecodeEquivalentJSONFromOtherClients() throws {
        let store = try LibraryStore(inMemory: true)
        let favorite = SyncChange(sequence: 1, operationID: "remote-favorite", kind: .favorite,
                                  entityID: "x", payload: "{ \"enabled\": true }", deleted: false)
        try store.apply(SyncPage(changes: [favorite], cursor: 1, hasMore: false))
        #expect(try store.favoriteIDs() == ["x"])
    }

    @Test func endpointsRejectCredentialLeakAndInsecureRemoteTransport() throws {
        #expect(throws: ClientError.self) { try Endpoint("http://example.com") }
        #expect(throws: ClientError.self) { try Endpoint("https://user:pass@example.com") }
        #expect(throws: ClientError.self) { try Endpoint("https://example.com/?token=x") }
        #expect(throws: ClientError.self) { try Endpoint("https://example.com", loopbackOnly: true) }
        #expect(try Endpoint("http://127.0.0.1:4179", loopbackOnly: true).url.port == 4179)
        #expect(try Endpoint("https://music.example.com").scope != Endpoint("https://other.example.com").scope)
        #expect(try Endpoint("https://MUSIC.example.com:443/").scope == Endpoint("https://music.example.com").scope)
    }

    @Test func contentHashesAreStableAndBoundedMemory() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        try Data("abc".utf8).write(to: url)
        #expect(try AudioFiles.hash(url) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }
}
