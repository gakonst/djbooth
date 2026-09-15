import Foundation
import Testing
@testable import DJBoothKit

@MainActor struct CollectionTests {
    private let tracks = [Track(id: "a", title: "A"), Track(id: "b", title: "B"), Track(id: "c", title: "C")]

    @Test func legacyCollectionAndSessionDecodeWithoutNewMetadata() throws {
        let value = try JSONDecoder().decode(Collection.self, from: Data(#"{"id":"old","name":"Original","trackIDs":["b","a"]}"#.utf8))
        #expect(value.trackIDs == ["b", "a"] && value.isPinned == nil && value.folderPath == nil)
        let extra = try JSONDecoder().decode(Collection.self, from: Data(#"{"id":"old","name":"Original","trackIDs":["b","a"],"isPinned":[],"folderPath":false}"#.utf8))
        #expect(extra == value)
        let session = try JSONDecoder().decode(PlaybackSession.self, from: Data(#"{"trackID":"b","queueIDs":["b","a"],"elapsed":45,"filter":"All music","query":"","queueFilter":"All music"}"#.utf8))
        #expect(session.navigation == nil && session.trackID == "b" && session.elapsed == 45)
    }
    @Test func membershipEditsUseCurrentPlaylistAndPersistMetadataAndOrder() throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: path) }
        var store: LibraryStore? = try LibraryStore(directory: path)
        try store!.ingest(tracks, enqueue: false)
        let original = try store!.createCollection(name: "Set", trackIDs: ["a"])
        try store!.addTrack("b", toCollection: original.id)
        try store!.updateCollection(original.id, name: "Renamed", mood: " Warm ", folderPath: [" DJ ", "", "Sets"])
        try store!.addTrack("c", toCollection: original.id)
        try store!.moveTrack("c", inCollection: original.id, by: -1)
        try store!.toggleCollectionPin(original.id)
        let count = try store!.pendingCount()
        try store!.addTrack("c", toCollection: original.id)
        try store!.removeTrack("missing", fromCollection: original.id)
        try store!.moveTrack("a", inCollection: original.id, by: -1)
        try store!.updateCollection(original.id, name: "Renamed", mood: "Warm", folderPath: ["DJ", "Sets"])
        #expect(try store!.pendingCount() == count)
        store = nil
        let restored = try LibraryStore(directory: path)
        let value = try #require(try restored.collection(original.id))
        #expect(value.name == "Renamed" && value.trackIDs == ["a", "c", "b"])
        #expect(value.isPinned == true && value.mood == "Warm" && value.folderPath == ["DJ", "Sets"])
        #expect(value.createdAt != nil && value.updatedAt != nil)
        #expect(try restored.pendingCount() == count)
    }
    @Test func deletionOnlyTombstonesPlaylistAndPreservesAudioMetadataAndNotes() throws {
        let store = try LibraryStore(inMemory: true)
        try store.ingest(tracks, enqueue: false)
        try store.setNote("Keep this", trackID: "a")
        let collection = try store.createCollection(name: "Set", trackIDs: ["a", "b"])
        try store.deleteCollection(collection.id)
        let count = try store.pendingCount()
        try store.deleteCollection(collection.id)
        #expect(try store.pendingCount() == count)
        #expect(try store.collection(collection.id) == nil)
        #expect(try store.values(.track, as: Track.self).count == 3)
        #expect(try store.annotation(for: "a").note == "Keep this")
        var sequence = 10
        while let op = try store.nextOperation() {
            if op.deleted { #expect(op.kind == .collection && op.entityID == collection.id && op.payload == nil) }
            try store.acknowledge(SyncChange(sequence: sequence, operationID: op.operationID, kind: op.kind, entityID: op.entityID, payload: op.payload, deleted: op.deleted))
            sequence += 1
        }
        #expect(try store.collection(collection.id) == nil)
    }
    @Test func removalReceiptRestoresOriginalPositionDurablyWithoutDuplicateOutboxEdits() throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: path) }
        var store: LibraryStore? = try LibraryStore(directory: path)
        try store!.ingest(tracks, enqueue: false)
        let collection = try store!.createCollection(name: "Set", trackIDs: ["a", "b", "c"])
        let receipt = try #require(try store!.removeTrack("b", fromCollection: collection.id))
        #expect(receipt.collectionID == collection.id && receipt.trackID == "b" && receipt.originalIndex == 1)
        #expect(receipt.previousTrackID == "a" && receipt.nextTrackID == "c")
        #expect(try store!.collection(collection.id)?.trackIDs == ["a", "c"])
        store = nil
        let restored = try LibraryStore(directory: path)
        let count = try restored.pendingCount()
        try restored.restoreTrack(receipt)
        #expect(try restored.collection(collection.id)?.trackIDs == collection.trackIDs)
        #expect(try restored.pendingCount() == count + 1)
        try restored.restoreTrack(receipt)
        #expect(try restored.removeTrack("missing", fromCollection: collection.id) == nil)
        #expect(try restored.pendingCount() == count + 1)
        var lastOperation: SyncOperation?
        var sequence = 1
        while let operation = try restored.nextOperation() {
            lastOperation = operation
            try restored.acknowledge(SyncChange(sequence: sequence, operationID: operation.operationID,
                kind: operation.kind, entityID: operation.entityID, payload: operation.payload, deleted: operation.deleted))
            sequence += 1
        }
        let payload = try #require(lastOperation?.payload)
        #expect(try JSONDecoder().decode(Collection.self, from: Data(payload.utf8)).trackIDs == ["a", "b", "c"])
    }
    @Test func undoUsesLatestPlaylistAndPreservesRenamePinFoldersNewMembersAndReordering() throws {
        let store = try LibraryStore(inMemory: true)
        try store.ingest(tracks + [Track(id: "d", title: "D")], enqueue: false)
        let collection = try store.createCollection(name: "Set", trackIDs: ["a", "b", "c"])
        let receipt = try #require(try store.removeTrack("b", fromCollection: collection.id))
        try store.updateCollection(collection.id, name: "New name", mood: "Warm", folderPath: ["DJ", "Sets"])
        try store.toggleCollectionPin(collection.id)
        try store.addTrack("d", toCollection: collection.id)
        try store.moveTrack("c", inCollection: collection.id, by: -1)
        let before = try #require(try store.collection(collection.id))
        try store.restoreTrack(receipt)
        let after = try #require(try store.collection(collection.id))
        #expect(after.trackIDs == ["b", "c", "a", "d"])
        #expect(after.trackIDs.filter { $0 != "b" } == before.trackIDs)
        #expect(after.name == before.name && after.mood == before.mood && after.folderPath == before.folderPath)
        #expect(after.isPinned == true && after.createdAt == before.createdAt)
    }
    @Test func undoFindsSurvivingNeighborsAndFallsBackToBoundedOriginalIndex() throws {
        for (removedNeighbors, expected) in [(["c"], ["a", "b", "d"]), (["a"], ["b", "c", "d"]), (["a", "c"], ["d", "b"])] {
            let store = try LibraryStore(inMemory: true)
            try store.ingest(tracks + [Track(id: "d", title: "D")], enqueue: false)
            let collection = try store.createCollection(name: "Set", trackIDs: ["a", "b", "c"])
            let receipt = try #require(try store.removeTrack("b", fromCollection: collection.id))
            for id in removedNeighbors { try store.removeTrack(id, fromCollection: collection.id) }
            try store.addTrack("d", toCollection: collection.id)
            try store.restoreTrack(receipt)
            #expect(try store.collection(collection.id)?.trackIDs == expected)
        }
        for id in ["a", "c"] {
            let store = try LibraryStore(inMemory: true)
            try store.ingest(tracks, enqueue: false)
            let collection = try store.createCollection(name: "Set", trackIDs: ["a", "b", "c"])
            let receipt = try #require(try store.removeTrack(id, fromCollection: collection.id))
            try store.restoreTrack(receipt)
            #expect(try store.collection(collection.id)?.trackIDs == collection.trackIDs)
        }
    }
    @Test func undoNeverResurrectsDeletedPlaylistOrTrack() throws {
        let store = try LibraryStore(inMemory: true)
        try store.ingest(tracks, enqueue: false)
        let deletedCollection = try store.createCollection(name: "Deleted", trackIDs: ["a", "b"])
        let receipt = try #require(try store.removeTrack("b", fromCollection: deletedCollection.id))
        try store.deleteCollection(deletedCollection.id)
        let beforePlaylistUndo = try store.pendingCount()
        #expect(throws: ClientError.self) { try store.restoreTrack(receipt) }
        #expect(try store.collection(deletedCollection.id) == nil)
        #expect(try store.pendingCount() == beforePlaylistUndo)

        let collection = try store.createCollection(name: "Still here", trackIDs: ["a", "b"])
        let deletedTrackReceipt = try #require(try store.removeTrack("a", fromCollection: collection.id))
        try store.delete(kind: .track, id: "a")
        let beforeTrackUndo = try store.pendingCount()
        #expect(throws: ClientError.self) { try store.restoreTrack(deletedTrackReceipt) }
        #expect(try store.collection(collection.id)?.trackIDs == ["b"])
        #expect(try store.values(.track, as: Track.self).allSatisfy { $0.id != "a" })
        #expect(try store.pendingCount() == beforeTrackUndo)
    }
    @Test func archiveIsIdempotentAndNeverOverwritesRenamedArchive() throws {
        let store = try LibraryStore(inMemory: true)
        try store.ingest(tracks, enqueue: false)
        let first = try store.archiveTrack("a")
        let count = try store.pendingCount()
        #expect(try store.archiveTrack("a").id == first.id)
        #expect(try store.pendingCount() == count)
        try store.updateCollection(first.id, name: "Saved gems", mood: "", folderPath: [])
        let second = try store.archiveTrack("b")
        #expect(second.id != first.id && second.trackIDs == ["b"])
        #expect(try store.collection(first.id)?.trackIDs == ["a"])
        #expect(try store.collection(first.id)?.name == "Saved gems")
        #expect(try store.archiveTrack("c").id == second.id)
        #expect(try store.collection(second.id)?.trackIDs == ["b", "c"])
    }
    @Test func deletedPlaylistReturnsToBrowserWithoutChangingPlaybackQueue() {
        let session = PlaybackSession(trackID: "b", queueIDs: ["b", "a"], elapsed: 45, selectedCollection: "gone",
            filter: "Unsorted", queueCollection: "gone", navigation: PlaylistNavigation(folderPath: ["gone"], preferredCollectionID: "gone"))
        let restored = session.resolved(tracks: tracks, collections: [])
        #expect(restored.trackID == "b" && restored.queueIDs == ["b", "a"] && restored.elapsed == 45)
        #expect(restored.selectedCollection == nil && restored.navigation?.showBrowser == true)
        #expect(restored.navigation?.preferredCollectionID == nil && restored.navigation?.folderPath == [])
        #expect(restored.filter == "Unsorted")
    }
}
