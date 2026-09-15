import Foundation
import SwiftData
import Testing
@testable import DJBoothKit

@MainActor struct AnnotationTests {
    private func encoded(_ value: TrackAnnotation) throws -> String {
        String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
    }

    @Test func annotationsPreserveExactNotesColorsAndPersistOfflineWithoutTrackEdits() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var store: LibraryStore? = try LibraryStore(directory: directory)
        let note = "  Bass comes in here\n2:30 🎛️  "
        try store!.setNote(note, trackID: "track")
        try store!.setColor(.cyan, trackID: "track")
        #expect(try store!.pendingCount() == 1)
        #expect(try store!.pendingEntityIDs(.track).isEmpty)
        store = nil
        let restored = try LibraryStore(directory: directory)
        #expect(try restored.annotation(for: "track") == TrackAnnotation(note: note, color: .cyan))
        #expect(try restored.annotations()["track"]?.note == note)
        #expect(try restored.nextOperation()?.kind == .annotation)
        try restored.setColor(nil, trackID: "track")
        #expect(try restored.annotation(for: "track").note == note)
        try restored.setNote("", trackID: "track")
        #expect(try restored.annotation(for: "track").isEmpty)
    }

    @Test func typingCoalescesButDispatchedOperationsRemainImmutableAndRebase() throws {
        let store = try LibraryStore(inMemory: true)
        for note in ["B", "Ba", "Bass"] { try store.setNote(note, trackID: "track") }
        #expect(try store.pendingCount() == 1)
        let first = try #require(try store.nextOperation())
        try store.setColor(.red, trackID: "track")
        try store.setNote("Bass drop", trackID: "track")
        #expect(try store.pendingCount() == 2)
        let retry = try #require(try store.nextOperation())
        #expect(retry.operationID == first.operationID)
        #expect(retry.payload == first.payload)
        try store.acknowledge(SyncChange(sequence: 10, operationID: first.operationID, kind: .annotation, entityID: "track", payload: first.payload, deleted: false))
        let second = try #require(try store.nextOperation())
        #expect(second.baseVersion == 10)
        #expect(second.operationID != first.operationID)
        #expect(try JSONDecoder().decode(TrackAnnotation.self, from: Data(second.payload!.utf8)) == TrackAnnotation(note: "Bass drop", color: .red))
        #expect(try store.annotation(for: "track") == TrackAnnotation(note: "Bass drop", color: .red))
    }

    @Test func noOpAndOversizedNotesDoNotChangeStore() throws {
        let store = try LibraryStore(inMemory: true)
        try store.setNote("", trackID: "track"); try store.setColor(nil, trackID: "track")
        #expect(try store.pendingCount() == 0)
        let note = String(repeating: "🎶", count: 4096)
        try store.setNote(note, trackID: "track")
        try store.setNote(note, trackID: "track")
        #expect(try store.pendingCount() == 1)
        #expect(throws: ClientError.self) { try store.setNote(note + "x", trackID: "track") }
        #expect(try store.annotation(for: "track").note == note)
        #expect(try store.pendingCount() == 1)
    }

    @Test func annotationsSurviveMetadataUpdatesAndConflictsPreserveLocalChanges() throws {
        let store = try LibraryStore(inMemory: true)
        try store.setNote("Local note", trackID: "track")
        let operation = try #require(try store.nextOperation())
        let remote = SyncChange(sequence: 12, operationID: "other-device", kind: .annotation, entityID: "track", payload: try encoded(TrackAnnotation(note: "Remote note", color: .pink)), deleted: false)
        let track = Track(id: "track", title: "New metadata", mediaHash: String(repeating: "a", count: 64))
        let payload = String(decoding: try JSONEncoder().encode(track), as: UTF8.self)
        try store.apply(SyncPage(changes: [remote, SyncChange(sequence: 13, operationID: "publisher", kind: .track, entityID: "track", payload: payload, deleted: false)], cursor: 13, hasMore: false))
        #expect(try store.annotation(for: "track").note == "Local note")
        #expect(try store.values(.track, as: Track.self).first?.title == "New metadata")
        try store.markConflict(operation, remote: remote)
        try store.setColor(.blue, trackID: "track")
        try store.resolveConflict(operation.operationID, keepLocal: true)
        #expect(try store.nextOperation()?.baseVersion == 12)
        #expect(try store.annotation(for: "track") == TrackAnnotation(note: "Local note", color: .blue))
    }

    @Test func clearingAnnotationCreatesTombstoneWithoutDeletingTrack() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = try LibraryStore(directory: directory)
        try store.setNote("Mix here", trackID: "track")
        let first = try #require(try store.nextOperation())
        try store.acknowledge(SyncChange(sequence: 1, operationID: first.operationID, kind: .annotation, entityID: "track", payload: first.payload, deleted: false))
        try store.setNote("", trackID: "track")
        let cleared = try #require(try store.nextOperation())
        #expect(cleared.kind == .annotation)
        #expect(cleared.deleted)
        #expect(cleared.payload == nil)
        #expect(cleared.operationID != first.operationID)
        #expect(try store.annotations().isEmpty)
        #expect(try store.pendingEntityIDs(.track).isEmpty)
        let restored = try LibraryStore(directory: directory)
        let retry = try #require(try restored.nextOperation())
        #expect(retry.operationID == cleared.operationID && retry.deleted && retry.payload == nil)
        #expect(try restored.annotation(for: "track").isEmpty)
    }

    @Test func legacyCursorUpgradeReplaysHistoricalAnnotationsOnce() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        do {
            let schema = Schema([StoredEntity.self, PendingEdit.self, SyncPosition.self])
            let configuration = ModelConfiguration(schema: schema, url: directory.appendingPathComponent("Library.sqlite"), cloudKitDatabase: .none)
            let container = try ModelContainer(for: schema, configurations: [configuration])
            let context = ModelContext(container)
            let legacy = SyncPosition(); legacy.cursor = 100
            context.insert(legacy); try context.save()
        }
        var store: LibraryStore? = try LibraryStore(directory: directory)
        #expect(try store!.cursor() == 0)
        let annotation = SyncChange(sequence: 60, operationID: "old-annotation", kind: .annotation, entityID: "track", payload: try encoded(TrackAnnotation(note: "Written before this app upgraded", color: .red)), deleted: false)
        try store!.apply(SyncPage(changes: [annotation], cursor: 100, hasMore: false))
        #expect(try store!.annotation(for: "track").color == .red)
        store = nil
        let restored = try LibraryStore(directory: directory)
        #expect(try restored.cursor() == 100)
        #expect(try restored.annotation(for: "track").note == "Written before this app upgraded")
    }
}
