import Foundation
import GRDB

/// Protected, synchronous SQLite journal: a checkpoint contains text, not audio.
/// Capturing rows recover as partial documents after death, never as agent tasks.
public final class MeetingRecordingStore: @unchecked Sendable {
    public enum State: String, Codable, Sendable { case capturing, pending, synced, conflicted, deleting, deleted }
    public struct Entry: Codable, Equatable, Identifiable, Sendable {
        public var record: MeetingRecord
        public var state: State
        public var detailsLoaded: Bool
        /// Exact payload persisted before HTTP admission; never mutated by later edits.
        public var attempted: MeetingRecord?
        /// Latest conflicting server version; the local document remains record.
        public var remote: MeetingRecord?
        /// Last acknowledged cloud revision, independent of local checkpoints.
        public var serverRevision: Int?
        public var attemptedServerRevision: Int?
        public var id: UUID { record.id }
        public init(record: MeetingRecord, state: State, detailsLoaded: Bool = true) {
            self.record = record; self.state = state; self.detailsLoaded = detailsLoaded; self.attempted = nil; self.remote = nil
            self.serverRevision = state == .synced ? record.revision : 0
            self.attemptedServerRevision = nil
        }
    }
    private let database: DatabaseQueue
    public init(path: String) throws {
        var config = Configuration()
        config.prepareDatabase { db in try db.execute(sql: "PRAGMA synchronous = FULL") }
        database = try DatabaseQueue(path: path, configuration: config)
        var migrator = DatabaseMigrator()
        migrator.registerMigration("meeting-recordings-v1") { db in
            try db.execute(sql: "CREATE TABLE meeting_recordings (scope TEXT NOT NULL, id TEXT NOT NULL, entry BLOB NOT NULL, PRIMARY KEY(scope,id))")
        }
        try migrator.migrate(database)
    }
    public static func applicationStore() throws -> MeetingRecordingStore {
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("MeetingRecordings", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        #if os(iOS)
        // Remains available during an explicitly authorized locked recording after
        // first unlock; neither app-group defaults nor widget storage holds text.
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: directory.path)
        #endif
        let store = try MeetingRecordingStore(path: directory.appendingPathComponent("recordings.sqlite").path)
        #if os(iOS)
        for url in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
        }
        #endif
        return store
    }
    public func entries(scope: String, includeDeleted: Bool = false) throws -> [Entry] {
        try database.read { db in
            try Data.fetchAll(db, sql: "SELECT entry FROM meeting_recordings WHERE scope = ?", arguments: [scope])
                .map { try JSONDecoder().decode(Entry.self, from: $0) }
                .filter { includeDeleted || $0.state != .deleting && $0.state != .deleted }
                .sorted { $0.record.startedAt > $1.record.startedAt }
        }
    }
    /// Capture checkpoints must not decode every prior meeting's full transcript.
    public func entry(id: UUID, scope: String) throws -> Entry? {
        try database.read { db in try read(db, id: id, scope: scope) }
    }
    private func read(_ db: Database, id: UUID, scope: String) throws -> Entry? {
        guard let data = try Data.fetchOne(db, sql: "SELECT entry FROM meeting_recordings WHERE scope = ? AND id = ?", arguments: [scope, id.uuidString]) else { return nil }
        return try JSONDecoder().decode(Entry.self, from: data)
    }
    private func write(_ db: Database, _ entry: Entry, scope: String) throws {
        guard !scope.isEmpty else { throw APIError.invalidCredential }
        try db.execute(sql: "INSERT INTO meeting_recordings(scope,id,entry) VALUES (?,?,?) ON CONFLICT(scope,id) DO UPDATE SET entry=excluded.entry", arguments: [scope, entry.id.uuidString, try JSONEncoder().encode(entry)])
    }
    public func put(_ record: MeetingRecord, scope: String, state: State) throws {
        try database.write { db in
            let existing = try read(db, id: record.id, scope: scope)
            guard existing?.state != .deleting, existing?.state != .deleted else { throw APIError.invalidResponse }
            if var existing {
                var comparable = record
                if comparable.uploadStartedAt == existing.record.uploadStartedAt {
                    comparable.startedAt = existing.record.startedAt
                }
                comparable.revision = existing.record.revision; comparable.updatedAt = existing.record.updatedAt
                comparable.summary = existing.record.summary; comparable.summaryStatus = existing.record.summaryStatus
                if comparable == existing.record {
                    if existing.state == .capturing, state == .pending {
                        existing.state = .pending
                        try write(db, existing, scope: scope)
                        return
                    }
                    if existing.state == state || (state == .pending && [.synced, .pending, .conflicted].contains(existing.state)) { return }
                }
            }
            var next = record
            next.revision = max(1, max(record.revision, (existing?.record.revision ?? 0) + 1))
            next.updatedAt = Date(); next.summary = ""; next.summaryStatus = .none
            var entry = Entry(record: next, state: state)
            entry.attempted = existing?.attempted
            entry.remote = existing?.remote
            entry.serverRevision = existing?.serverRevision ?? (existing?.state == .synced ? existing?.record.revision : 0)
            if let existing, existing.state == .synced, record.revision < existing.record.revision {
                // A dirty editor can still hold its loaded cloud revision while a
                // background refresh advances this cache. Do not silently rebase
                // its stale full document onto that newer revision: preserve the
                // editor's base so HTTP CAS yields a durable two-copy conflict.
                entry.serverRevision = record.revision
            }
            entry.attemptedServerRevision = existing?.attemptedServerRevision
            if existing?.state == .conflicted { entry.state = .conflicted }
            try write(db, entry, scope: scope)
        }
    }
    public func recover(scope: String, excluding activeID: UUID? = nil) throws {
        try database.write { db in
            let rows = try Data.fetchAll(db, sql: "SELECT entry FROM meeting_recordings WHERE scope = ?", arguments: [scope])
            for data in rows {
                var entry = try JSONDecoder().decode(Entry.self, from: data)
                guard entry.state == .capturing, entry.id != activeID else { continue }
                entry.state = .pending; entry.record.partial = true; entry.record.revision += 1; entry.record.updatedAt = Date()
                try write(db, entry, scope: scope)
            }
        }
    }
    public func merge(_ record: MeetingRecord, scope: String, detailsLoaded: Bool) throws {
        try database.write { db in
            if let existing = try read(db, id: record.id, scope: scope) {
                guard existing.state == .synced, existing.record.revision <= record.revision else { return }
                if !detailsLoaded, existing.detailsLoaded, existing.record.revision == record.revision { return }
            }
            try write(db, Entry(record: record, state: .synced, detailsLoaded: detailsLoaded), scope: scope)
        }
    }
    /// Commit the immutable request BEFORE issuing it. Reopen/retry uses exactly
    /// this revision/body even when the displayed document was edited meanwhile.
    public func prepareUpload(id: UUID, scope: String) throws -> MeetingRecord? {
        try database.write { db in
            guard var entry = try read(db, id: id, scope: scope), entry.state == .pending else { return nil }
            if let attempted = entry.attempted {
                if entry.attemptedServerRevision == nil {
                    entry.attemptedServerRevision = entry.serverRevision ?? 0
                    try write(db, entry, scope: scope)
                }
                return attempted
            }
            entry.attempted = entry.record
            entry.attemptedServerRevision = entry.serverRevision ?? 0
            try write(db, entry, scope: scope)
            return entry.record
        }
    }
    public func uploadPrecondition(id: UUID, scope: String, revision: Int) throws -> Int {
        try database.read { db in
            guard let entry = try read(db, id: id, scope: scope), entry.attempted?.revision == revision,
                  let expected = entry.attemptedServerRevision else { throw APIError.invalidResponse }
            return expected
        }
    }
    public func acknowledge(_ record: MeetingRecord, scope: String, revision: Int) throws {
        try database.write { db in
            guard var entry = try read(db, id: record.id, scope: scope), entry.state == .pending,
                  entry.attempted?.revision == revision, record.revision >= revision else { return }
            if entry.record.revision == revision {
                entry = Entry(record: record, state: .synced)
            } else {
                // The older immutable attempt was admitted. Coalesce the newest
                // local text under a strictly higher revision, never under its ID.
                entry.record.revision = max(entry.record.revision, record.revision + 1)
                entry.attempted = nil; entry.attemptedServerRevision = nil
                entry.serverRevision = record.revision
            }
            try write(db, entry, scope: scope)
        }
    }
    /// Validation rejection is definitive non-admission, unlike a dropped
    /// connection. Let a corrected local document replace the rejected attempt.
    public func rejectUpload(id: UUID, scope: String, revision: Int) throws {
        try database.write { db in
            guard var entry = try read(db, id: id, scope: scope), entry.state == .pending,
                  entry.attempted?.revision == revision else { return }
            entry.attempted = nil; entry.attemptedServerRevision = nil
            try write(db, entry, scope: scope)
        }
    }
    /// A definitive conflict only proves original admission when GET has the
    /// immutable attempted content. Never automatically overwrite another device.
    public func reconcileConflict(_ remote: MeetingRecord, scope: String) throws {
        try database.write { db in
            guard var entry = try read(db, id: remote.id, scope: scope), entry.state == .pending else { return }
            var comparable = remote
            comparable.revision = entry.attempted?.revision ?? remote.revision
            if let attempted = entry.attempted, comparable.uploadBody == attempted.uploadBody {
                entry.record.revision = max(entry.record.revision, remote.revision + 1)
                entry.attempted = nil; entry.attemptedServerRevision = nil
                entry.serverRevision = remote.revision
            } else {
                entry.state = .conflicted; entry.remote = remote
            }
            try write(db, entry, scope: scope)
        }
    }
    /// Called only after explicit user resolution. The newest server snapshot is
    /// fetched by the library, not assumed from stale conflict metadata.
    public func resolveConflict(_ remote: MeetingRecord, scope: String, keepLocal: Bool) throws {
        try database.write { db in
            guard var entry = try read(db, id: remote.id, scope: scope), entry.state == .conflicted else { throw APIError.invalidResponse }
            if keepLocal {
                entry.record.revision = max(entry.record.revision, remote.revision + 1)
                entry.record.updatedAt = Date(); entry.record.summary = ""; entry.record.summaryStatus = .none
                entry.state = .pending; entry.remote = nil; entry.attempted = nil
                entry.serverRevision = remote.revision; entry.attemptedServerRevision = nil
            } else {
                entry = Entry(record: remote, state: .synced)
            }
            try write(db, entry, scope: scope)
        }
    }
    public func markDeleted(id: UUID, scope: String) throws {
        try database.write { db in
            guard var entry = try read(db, id: id, scope: scope) else { return }
            guard entry.state != .deleted else { return }
            entry.state = .deleting; try write(db, entry, scope: scope)
        }
    }
    public func removeDeleted(id: UUID, scope: String) throws {
        try database.write { db in
            guard var entry = try read(db, id: id, scope: scope) else { return }
            // Acknowledged tombstones suppress stale lists without retrying DELETE.
            entry.state = .deleted; entry.attempted = nil; entry.remote = nil; entry.attemptedServerRevision = nil
            entry.record.title = ""; entry.record.transcript = ""; entry.record.notes = ""
            entry.record.summary = ""; entry.record.summaryStatus = .none
            try write(db, entry, scope: scope)
        }
    }
}
