import Foundation
import SwiftData

/// Enough context to undo one membership edit without restoring an old playlist snapshot.
public struct CollectionTrackRemoval: Sendable, Equatable {
    public let collectionID: String
    public let trackID: String
    public let originalIndex: Int
    public let previousTrackID: String?
    public let nextTrackID: String?
}

@Model final class StoredEntity {
    @Attribute(.unique) var key: String
    var kind: String
    var entityID: String
    var payload: String?
    var version: Int
    @Attribute(originalName: "deleted") var tombstone: Bool
    init(kind: EntityKind, id: String, payload: String?, version: Int = 0, deleted: Bool = false) {
        key = "\(kind.rawValue):\(id)"; self.kind = kind.rawValue; entityID = id
        self.payload = payload; self.version = version; self.tombstone = deleted
    }
    init(localKind: String, id: String, payload: String) {
        key = "\(localKind):\(id)"; kind = localKind; entityID = id
        self.payload = payload; version = 0; tombstone = false
    }
}
@Model final class PendingEdit {
    @Attribute(.unique) var id: String
    var key: String
    var kind: String
    var entityID: String
    var payload: String?
    var baseVersion: Int
    @Attribute(originalName: "deleted") var tombstone: Bool
    var createdAt: Date
    var conflictPayload: String?
    var conflictVersion: Int?
    var submitted: Bool = false
    init(kind: EntityKind, id: String, payload: String?, baseVersion: Int, deleted: Bool) {
        self.id = UUID().uuidString; key = "\(kind.rawValue):\(id)"
        self.kind = kind.rawValue; entityID = id; self.payload = payload
        self.baseVersion = baseVersion; self.tombstone = deleted; createdAt = Date()
    }
}
@Model final class SyncPosition {
    @Attribute(.unique) var id: String
    var cursor: Int
    init(id: String = "cloud") { self.id = id; cursor = 0 }
}

/// The native replica and transactional outbox. Acquisition continues to belong to master.db.
@MainActor public final class LibraryStore {
    private let container: ModelContainer
    private let context: ModelContext
    private let usbEncoder: JSONEncoder = {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; return encoder
    }()
    private var deferringUSBSave = false
    private var usbRows: [String: StoredEntity]?
    private var usbEdits: [PendingEdit]?
    private var usbLastEdits: [String: PendingEdit]?
    private func persistContext() throws { if !deferringUSBSave { try context.save() } }
    private var cachedPayloadSnapshot: LibraryPayloadSnapshot?
    public private(set) var revision = 0
    // Replaying once on upgrade discovers annotations hidden from older clients.
    private let syncPositionID = "cloud-annotations-v1"

    public convenience init(directory: URL? = nil, inMemory: Bool = false) throws {
        try self.init(container: Self.makeContainer(directory: directory, inMemory: inMemory))
    }
    /// SQLite opening and migration run off the UI actor; the writable context stays owned here.
    public static func open(directory: URL? = nil, inMemory: Bool = false) async throws -> LibraryStore {
        let job = Task.detached(priority: .userInitiated) {
            try Task.checkCancellation()
            let container = try makeContainer(directory: directory, inMemory: inMemory)
            try Task.checkCancellation()
            return container
        }
        let container = try await withTaskCancellationHandler { try await job.value } onCancel: { job.cancel() }
        try Task.checkCancellation()
        return try LibraryStore(container: container)
    }
    private init(container: ModelContainer) throws {
        self.container = container
        context = ModelContext(container)
        context.autosaveEnabled = false
        // Older USB-reader builds queued external source rows as library imports.
        // Keep their metadata local and stop any pending automatic cloud imports.
        let prefix = "usb:"
        let pending = try context.fetch(FetchDescriptor<PendingEdit>(predicate: #Predicate { $0.entityID.starts(with: prefix) }))
        for edit in pending { context.delete(edit) }
        if !pending.isEmpty { try context.save() }
    }
    private nonisolated static func makeContainer(directory: URL?, inMemory: Bool) throws -> ModelContainer {
        let schema = Schema([StoredEntity.self, PendingEdit.self, SyncPosition.self])
        let configuration: ModelConfiguration
        if let directory {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            configuration = ModelConfiguration(schema: schema, url: directory.appendingPathComponent("Library.sqlite"), cloudKitDatabase: .none)
        } else {
            configuration = ModelConfiguration(schema: schema, isStoredInMemoryOnly: inMemory, cloudKitDatabase: .none)
        }
        return try ModelContainer(for: schema, configurations: [configuration])
    }

    private func entity(_ kind: EntityKind, _ id: String) throws -> StoredEntity? {
        try row(key: "\(kind.rawValue):\(id)")
    }
    private func row(key: String) throws -> StoredEntity? {
        if let usbRows { return usbRows[key] }
        var descriptor = FetchDescriptor<StoredEntity>(predicate: #Predicate { $0.key == key })
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }
    private func edits() throws -> [PendingEdit] {
        if let usbEdits { return usbEdits }
        return try context.fetch(FetchDescriptor<PendingEdit>(sortBy: [SortDescriptor(\.createdAt)]))
    }
    private func lastEdit(key: String) throws -> PendingEdit? {
        if let usbLastEdits { return usbLastEdits[key] }
        var descriptor = FetchDescriptor<PendingEdit>(predicate: #Predicate { $0.key == key }, sortBy: [SortDescriptor(\.createdAt, order: .reverse)])
        descriptor.fetchLimit = 1
        return try context.fetch(descriptor).first
    }
    public func values<T: Decodable>(_ kind: EntityKind, as: T.Type) throws -> [T] {
        let raw = kind.rawValue
        return try context.fetch(FetchDescriptor<StoredEntity>(predicate: #Predicate { $0.kind == raw && !$0.tombstone }))
            .compactMap { row in
                guard let payload = row.payload?.data(using: .utf8) else { return nil }
                return try JSONDecoder().decode(T.self, from: payload)
            }
    }
    public func payloadSnapshot() throws -> LibraryPayloadSnapshot {
        if let cachedPayloadSnapshot, cachedPayloadSnapshot.revision == revision { return cachedPayloadSnapshot }
        var result = LibraryPayloadSnapshot(revision: revision)
        for row in try context.fetch(FetchDescriptor<StoredEntity>(predicate: #Predicate { !$0.tombstone })) {
            guard let payload = row.payload else { continue }
            switch EntityKind(rawValue: row.kind) {
            case .track: result.tracks[row.entityID] = payload
            case .collection: result.collections[row.entityID] = payload
            case .favorite: result.favorites[row.entityID] = payload
            case .annotation: result.annotations[row.entityID] = payload
            case nil: break
            }
        }
        cachedPayloadSnapshot = result
        return result
    }
    public func favoriteIDs() throws -> Set<String> {
        let raw = EntityKind.favorite.rawValue
        return Set(try context.fetch(FetchDescriptor<StoredEntity>(predicate: #Predicate { $0.kind == raw && !$0.tombstone }))
            .filter { row in
                guard let data = row.payload?.data(using: .utf8) else { return false }
                return try JSONDecoder().decode(Favorite.self, from: data).enabled
            }.map(\.entityID))
    }
    public func annotations() throws -> [String: TrackAnnotation] {
        let kind = EntityKind.annotation.rawValue
        let rows = try context.fetch(FetchDescriptor<StoredEntity>(predicate: #Predicate { $0.kind == kind && !$0.tombstone }))
        return try Dictionary(uniqueKeysWithValues: rows.compactMap { row in
            guard let payload = row.payload?.data(using: .utf8) else { return nil }
            return (row.entityID, try JSONDecoder().decode(TrackAnnotation.self, from: payload))
        })
    }
    public func annotation(for trackID: String) throws -> TrackAnnotation {
        guard let row = try entity(.annotation, trackID), !row.tombstone,
              let data = row.payload?.data(using: .utf8) else { return TrackAnnotation() }
        return try JSONDecoder().decode(TrackAnnotation.self, from: data)
    }
    public func saveAnnotation(_ value: TrackAnnotation, trackID: String) throws {
        guard value.note.utf8.count <= TrackAnnotation.maxNoteUTF8Bytes else {
            throw ClientError.http(400, "Notes can contain at most 16,384 UTF-8 bytes")
        }
        guard try annotation(for: trackID) != value else { return }
        let payload = value.isEmpty ? nil : String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
        try edit(kind: .annotation, id: trackID, payload: payload, deleted: value.isEmpty, coalesce: true)
    }
    public func setNote(_ note: String, trackID: String) throws {
        var value = try annotation(for: trackID); value.note = note
        try saveAnnotation(value, trackID: trackID)
    }
    public func setColor(_ color: TrackColor?, trackID: String) throws {
        var value = try annotation(for: trackID); value.color = color
        try saveAnnotation(value, trackID: trackID)
    }
    /// Save the visible edit and its retryable operation in the same SQLite transaction.
    public func save<T: Encodable>(_ value: T, kind: EntityKind, id: String) throws {
        let data = try JSONEncoder().encode(value)
        try edit(kind: kind, id: id, payload: String(decoding: data, as: UTF8.self), deleted: false)
    }
    public func delete(kind: EntityKind, id: String) throws {
        try edit(kind: kind, id: id, payload: nil, deleted: true)
    }
    private func edit(kind: EntityKind, id: String, payload: String?, deleted: Bool, coalesce: Bool = false) throws {
        do {
            let row = try entity(kind, id) ?? StoredEntity(kind: kind, id: id, payload: nil)
            if row.modelContext == nil { context.insert(row); usbRows?[row.key] = row }
            // Keystrokes may replace an undispatched annotation operation. Once
            // handed to the transport its ID and payload remain immutable forever.
            if id.hasPrefix("usb:") {
                // External source metadata and edits belong to the remembered USB,
                // not the ordinary cloud library. Audio is never copied by browsing.
            } else if coalesce, let pending = try lastEdit(key: row.key),
               !pending.submitted, pending.conflictVersion == nil {
                pending.payload = payload; pending.tombstone = deleted
            } else {
                let pending = PendingEdit(kind: kind, id: id, payload: payload, baseVersion: row.version, deleted: deleted)
                context.insert(pending); usbEdits?.append(pending); usbLastEdits?[pending.key] = pending
            }
            row.payload = payload; row.tombstone = deleted
            try persistContext()
            revision += 1
        } catch { context.rollback(); throw error }
    }
    public func toggleFavorite(_ id: String) throws {
        try save(Favorite(enabled: !favoriteIDs().contains(id)), kind: .favorite, id: id)
    }
    public func collection(_ id: String) throws -> Collection? {
        guard let row = try entity(.collection, id), !row.tombstone, let payload = row.payload else { return nil }
        return try JSONDecoder().decode(Collection.self, from: Data(payload.utf8))
    }
    @discardableResult public func createCollection(name: String, folderPath: [String] = [], trackIDs: [String] = [], id: String = UUID().uuidString) throws -> Collection {
        let name = try collectionName(name)
        let now = Date().ISO8601Format()
        var seen = Set<String>()
        let members = trackIDs.filter { seen.insert($0).inserted }
        let path = folderPath.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard members.count <= 10_000, path.count <= 32, path.allSatisfy({ $0.utf8.count <= 1024 }) else {
            throw ClientError.http(400, "Playlist size or folder path exceeds the limit")
        }
        for trackID in members {
            guard let track = try entity(.track, trackID), !track.tombstone else { throw ClientError.http(404, "This track no longer exists") }
        }
        let value = Collection(id: id, name: name, trackIDs: members,
                               folderPath: path.isEmpty ? nil : path, createdAt: now, updatedAt: now)
        try save(value, kind: .collection, id: value.id)
        return value
    }
    private func collectionName(_ name: String) throws -> String {
        let value = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, value.utf8.count <= 4096 else { throw ClientError.http(400, "Enter a playlist name of at most 4 KB") }
        return value
    }
    private func mutateCollection(_ id: String, mutation: (inout Collection) throws -> Void) throws {
        guard let current = try collection(id) else { throw ClientError.http(404, "This playlist no longer exists") }
        var updated = current
        try mutation(&updated)
        guard updated != current else { return }
        updated.updatedAt = Date().ISO8601Format()
        try save(updated, kind: .collection, id: id)
    }
    public func updateCollection(_ id: String, name: String, mood: String, folderPath: [String]) throws {
        let name = try collectionName(name)
        let mood = mood.trimmingCharacters(in: .whitespacesAndNewlines)
        let path = folderPath.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        guard mood.utf8.count <= 4096, path.count <= 32, path.allSatisfy({ $0.utf8.count <= 1024 }) else {
            throw ClientError.http(400, "Playlist mood or folder path is too long")
        }
        try mutateCollection(id) { value in
            value.name = name
            value.mood = mood.isEmpty ? nil : mood
            value.folderPath = path.isEmpty ? nil : path
        }
    }
    public func toggleCollectionPin(_ id: String) throws {
        try mutateCollection(id) { $0.isPinned = !($0.isPinned ?? false) }
    }
    public func addTrack(_ trackID: String, toCollection id: String) throws {
        guard let track = try entity(.track, trackID), !track.tombstone else { throw ClientError.http(404, "This track no longer exists") }
        try mutateCollection(id) { value in
            guard !value.trackIDs.contains(trackID) else { return }
            guard value.trackIDs.count < 10_000 else { throw ClientError.http(400, "Playlists can contain at most 10,000 tracks") }
            value.trackIDs.append(trackID)
        }
    }
    @discardableResult public func removeTrack(_ trackID: String, fromCollection id: String) throws -> CollectionTrackRemoval? {
        var removal: CollectionTrackRemoval?
        try mutateCollection(id) { value in
            guard let index = value.trackIDs.firstIndex(of: trackID) else { return }
            removal = CollectionTrackRemoval(collectionID: id, trackID: trackID, originalIndex: index,
                previousTrackID: index > 0 ? value.trackIDs[index - 1] : nil,
                nextTrackID: index + 1 < value.trackIDs.count ? value.trackIDs[index + 1] : nil)
            value.trackIDs.removeAll { $0 == trackID }
        }
        return removal
    }
    public func restoreTrack(_ removal: CollectionTrackRemoval) throws {
        guard let track = try entity(.track, removal.trackID), !track.tombstone else {
            throw ClientError.http(404, "This track no longer exists")
        }
        try mutateCollection(removal.collectionID) { value in
            guard !value.trackIDs.contains(removal.trackID) else { return }
            guard value.trackIDs.count < 10_000 else {
                throw ClientError.http(400, "Playlists can contain at most 10,000 tracks")
            }
            let index: Int
            if let next = removal.nextTrackID, let nextIndex = value.trackIDs.firstIndex(of: next) {
                index = nextIndex
            } else if let previous = removal.previousTrackID, let previousIndex = value.trackIDs.firstIndex(of: previous) {
                index = previousIndex + 1
            } else {
                index = min(value.trackIDs.count, max(0, removal.originalIndex))
            }
            value.trackIDs.insert(removal.trackID, at: index)
        }
    }
    public func moveTrack(_ trackID: String, inCollection id: String, by direction: Int) throws {
        guard direction == -1 || direction == 1 else { return }
        try mutateCollection(id) { value in
            guard let index = value.trackIDs.firstIndex(of: trackID), value.trackIDs.indices.contains(index + direction) else { return }
            value.trackIDs.swapAt(index, index + direction)
        }
    }
    public func deleteCollection(_ id: String) throws {
        guard try collection(id) != nil else { return }
        try delete(kind: .collection, id: id)
    }
    @discardableResult public func archiveTrack(_ trackID: String) throws -> Collection {
        if let archive = try values(.collection, as: Collection.self).sorted(by: { $0.id < $1.id }).first(where: { $0.name.caseInsensitiveCompare("Archive") == .orderedSame }) {
            try addTrack(trackID, toCollection: archive.id)
            return try collection(archive.id)!
        }
        guard let track = try entity(.track, trackID), !track.tombstone else { throw ClientError.http(404, "This track no longer exists") }
        let id = try collection("system:archive") == nil ? "system:archive" : UUID().uuidString
        return try createCollection(name: "Archive", trackIDs: [trackID], id: id)
    }
    /// Refresh workstation metadata without erasing native media references or pending edits.
    public func ingest(_ tracks: [Track], enqueue: Bool = true) throws {
        if !enqueue {
            // Workstation discovery is a local cache refresh, not permission to
            // publish every recording to this cloud. Synced rows and pending
            // user edits remain authoritative over background workstation data.
            do {
                let pendingKeys = Set(try edits().map(\.key))
                var changed = false
                for var track in tracks {
                    let row = try entity(.track, track.id)
                    guard (row?.version ?? 0) == 0, !pendingKeys.contains("track:\(track.id)") else { continue }
                    if let payload = row?.payload?.data(using: .utf8), let old = try? JSONDecoder().decode(Track.self, from: payload) {
                        track.mediaHash = old.mediaHash; track.mediaExtension = old.mediaExtension
                        if track.waveform == nil { track.waveform = old.waveform }
                        if track == old, row?.tombstone == false { continue }
                    }
                    let payload = String(decoding: try JSONEncoder().encode(track), as: UTF8.self)
                    if let row { row.payload = payload; row.tombstone = false }
                    else { context.insert(StoredEntity(kind: .track, id: track.id, payload: payload)) }
                    changed = true
                }
                if changed { try persistContext(); revision += 1 }
            } catch { context.rollback(); throw error }
            return
        }
        let pendingKeys = Set(try edits().map(\.key))
        for var track in tracks {
            let row = try entity(.track, track.id)
            if let row, !row.tombstone, let payload = row.payload?.data(using: .utf8) {
                let old = try JSONDecoder().decode(Track.self, from: payload)
                track.mediaHash = old.mediaHash; track.mediaExtension = old.mediaExtension
                if track.waveform == nil { track.waveform = old.waveform }
                if track == old, track.id.hasPrefix("usb:") || row.version > 0 || pendingKeys.contains("track:\(track.id)") { continue }
            }
            try save(track, kind: .track, id: track.id)
        }
    }
    private func localUSBValue<T: Decodable>(_ kind: String, id: String, as type: T.Type) throws -> T? {
        let key = "\(kind):\(id)"
        let row = try row(key: key)
        guard let payload = row?.payload else { return nil }
        return try JSONDecoder().decode(T.self, from: Data(payload.utf8))
    }
    private func saveLocalUSB<T: Encodable>(_ value: T, kind: String, id: String) throws {
        let key = "\(kind):\(id)"
        let payload = String(decoding: try usbEncoder.encode(value), as: UTF8.self)
        if let row = try row(key: key) {
            if row.payload != payload { row.payload = payload }
        } else {
            let row = StoredEntity(localKind: kind, id: id, payload: payload)
            context.insert(row); usbRows?[key] = row
        }
        try persistContext()
    }
    public func usbDevice() throws -> USBDeviceAccess? {
        try localUSBValue("usb-access", id: "active", as: USBDeviceAccess.self)
    }
    public func usbFile(_ trackID: String) throws -> USBFileLocation? {
        try localUSBValue("usb-file", id: trackID, as: USBFileLocation.self)
    }
    /// Keep the device's grant when its local library first joins a cloud account.
    public func copyUSBAccess(to destination: LibraryStore) throws {
        let kind = "usb-"
        for row in try context.fetch(FetchDescriptor<StoredEntity>()) where row.kind.hasPrefix(kind) {
            if let payload = row.payload {
                let key = row.key
                if try destination.context.fetch(FetchDescriptor<StoredEntity>(predicate: #Predicate { $0.key == key })).isEmpty {
                    destination.context.insert(StoredEntity(localKind: row.kind, id: row.entityID, payload: payload))
                }
            }
        }
        try destination.context.save()
    }
    /// Cache external source metadata locally for normal browsing and fast reconnects.
    /// USB rows and edits never enter the cloud outbox; browsing never copies audio.
    public func ingestUSB(_ library: USBRekordboxLibrary, access: USBDeviceAccess) throws {
        // One indexed read per table, not repeated SwiftData fetches as unsaved
        // rows grow. Keep the whole import atomic and reuse lookups for notes.
        let rows = try context.fetch(FetchDescriptor<StoredEntity>())
        let pending = try edits()
        usbRows = Dictionary(uniqueKeysWithValues: rows.map { ($0.key, $0) })
        usbEdits = pending
        usbLastEdits = Dictionary(pending.map { ($0.key, $0) }, uniquingKeysWith: { _, last in last })
        deferringUSBSave = true
        defer { deferringUSBSave = false; usbRows = nil; usbEdits = nil; usbLastEdits = nil }
        do {
            func trackID(_ id: UInt32) -> String { "usb:\(access.id):track:\(id)" }
            let tracks = library.tracks.map { item in
                Track(id: trackID(item.id), title: item.title, artist: item.artist, album: item.album,
                      genre: item.genre, key: item.key, bpm: item.bpm, durationSeconds: Double(item.duration),
                      analyzed: !item.analysisPath.isEmpty, mediaExtension: URL(fileURLWithPath: item.filePath).pathExtension)
            }
            try ingest(tracks)
            for item in library.tracks {
                let id = trackID(item.id)
                let signature = "\(item.fileSize):\(item.duration):\(item.filePath)"
                if let previous = try usbFile(id), previous.path != item.filePath || (previous.sourceSignature != nil && previous.sourceSignature != signature),
                   let replacement = tracks.first(where: { $0.id == id }) {
                    // A re-export can reuse a device ID for different media. Never
                    // attach the old recording or analysis to the replacement row.
                    try save(replacement, kind: .track, id: id)
                }
                try saveLocalUSB(USBFileLocation(trackID: id, deviceID: access.id, path: item.filePath, analysisPath: item.analysisPath, sourceSignature: signature), kind: "usb-file", id: id)
                // Seed the exported notes/colors once; reopening never overwrites personal edits.
                if try localUSBValue("usb-seeded", id: id, as: Bool.self) != true {
                    let colors: [Int: TrackColor] = [1: .pink, 2: .red, 5: .cyan, 6: .blue]
                    var note = item.comment
                    while note.utf8.count > TrackAnnotation.maxNoteUTF8Bytes { note.removeLast() }
                    if try annotation(for: id).isEmpty { try saveAnnotation(TrackAnnotation(note: note, color: colors[item.colorID]), trackID: id) }
                    try saveLocalUSB(true, kind: "usb-seeded", id: id)
                }
            }
            let folders = Dictionary(uniqueKeysWithValues: library.playlists.map { ($0.id, $0) })
            func path(_ parent: UInt32) -> [String] {
                var id = parent, names: [String] = []
                while let node = folders[id] { names.insert(node.name, at: 0); id = node.parentID }
                return [access.folderName] + names
            }
            var collections = library.playlists.filter { !$0.isFolder }.map { item in
                Collection(id: "usb:\(access.id):playlist:\(item.id)", name: item.name,
                           trackIDs: item.trackIDs.map(trackID), folderPath: path(item.parentID))
            }
            collections.insert(Collection(id: "usb:\(access.id):all", name: "All tracks", trackIDs: library.tracks.map { trackID($0.id) }, folderPath: [access.folderName]), at: 0)
            collections += library.histories.map { item in
                Collection(id: "usb:\(access.id):history:\(item.id)", name: item.name, trackIDs: item.trackIDs.map(trackID), folderPath: [access.folderName, "CDJ histories"])
            }
            for item in collections {
                let current = try collection(item.id)
                let previous = try localUSBValue("usb-playlist-base", id: item.id, as: Collection.self)
                // Reconcile changes from the stick while retaining playlists edited in the app.
                if (current == nil && previous == nil) || current == previous, current != item { try save(item, kind: .collection, id: item.id) }
                try saveLocalUSB(item, kind: "usb-playlist-base", id: item.id)
            }
            let retained = Set(collections.map(\.id)), prefix = "usb:\(access.id):"
            let baseKind = "usb-playlist-base"
            for row in rows where row.kind == baseKind {
                guard row.entityID.hasPrefix(prefix), !retained.contains(row.entityID), let payload = row.payload else { continue }
                let previous = try JSONDecoder().decode(Collection.self, from: Data(payload.utf8))
                if try collection(row.entityID) == previous { try delete(kind: .collection, id: row.entityID) }
                context.delete(row)
            }
            try saveLocalUSB(access, kind: "usb-access", id: "active")
            try context.save()
        } catch { context.rollback(); throw error }
    }
    public func pendingCount() throws -> Int { try context.fetchCount(FetchDescriptor<PendingEdit>()) }
    public func pendingEntityIDs(_ kind: EntityKind) throws -> Set<String> {
        Set(try edits().filter { $0.kind == kind.rawValue }.map(\.entityID))
    }
    public func nextOperation() throws -> SyncOperation? {
        let all = try edits()
        let blocked = Set(all.filter { $0.conflictVersion != nil }.map(\.key))
        guard let first = all.first(where: { !blocked.contains($0.key) }) else { return nil }
        if !first.submitted {
            do { first.submitted = true; try persistContext() }
            catch { context.rollback(); throw error }
        }
        return SyncOperation(operationID: first.id, kind: EntityKind(rawValue: first.kind)!, entityID: first.entityID,
                             baseVersion: first.baseVersion, payload: first.payload, deleted: first.tombstone)
    }
    public func acknowledge(_ change: SyncChange) throws {
        do {
            var pending = try edits()
            try receive(change, pending: &pending)
            try persistContext()
            revision += 1
        } catch { context.rollback(); throw error }
    }
    /// A pulled copy of our own operation is also a durable acknowledgement. Remove
    /// it from the outbox before processing a later remote edit in the same page.
    /// Otherwise a lost POST response could make us skip that remote edit forever
    /// while still advancing the pull cursor past it.
    private func receive(_ change: SyncChange, pending: inout [PendingEdit]) throws {
        // Ignore external rows sent by older clients while still advancing the page cursor.
        guard !change.entityID.hasPrefix("usb:") else { return }
        let key = "\(change.kind.rawValue):\(change.entityID)"
        let row = try entity(change.kind, change.entityID) ?? StoredEntity(kind: change.kind, id: change.entityID, payload: nil)
        if row.modelContext == nil { context.insert(row) }
        if let index = pending.firstIndex(where: { $0.id == change.operationID }) {
            let acknowledged = pending[index]
            guard acknowledged.key == key, acknowledged.payload == change.payload,
                  acknowledged.tombstone == change.deleted else {
                throw ClientError.http(409, "Cloud returned an inconsistent operation acknowledgement")
            }
            context.delete(acknowledged)
            pending.remove(at: index)
            let remaining = pending.filter { $0.key == key }
            if let next = remaining.first { next.baseVersion = max(next.baseVersion, change.sequence) }
            if change.sequence >= row.version {
                row.version = change.sequence
                if remaining.isEmpty { row.payload = change.payload; row.tombstone = change.deleted }
            }
        } else if change.sequence > row.version, !pending.contains(where: { $0.key == key }) {
            // An unrelated remote change never overwrites a visible unsent edit.
            row.payload = change.payload; row.tombstone = change.deleted; row.version = change.sequence
        }
    }
    public func markConflict(_ operation: SyncOperation, remote: SyncChange) throws {
        if let edit = try edits().first(where: { $0.id == operation.operationID }) {
            edit.conflictPayload = remote.payload; edit.conflictVersion = remote.sequence
            try persistContext()
        }
    }
    public func conflicts() throws -> [SyncConflict] {
        try edits().filter { $0.conflictVersion != nil }.map {
            SyncConflict(id: $0.id, kind: EntityKind(rawValue: $0.kind)!, entityID: $0.entityID,
                         localPayload: $0.payload, remotePayload: $0.conflictPayload)
        }
    }
    public func resolveConflict(_ id: String, keepLocal: Bool) throws {
        do {
            guard let pending = try edits().first(where: { $0.id == id }), let version = pending.conflictVersion,
                  let kind = EntityKind(rawValue: pending.kind), let row = try entity(kind, pending.entityID) else { return }
            let all = try edits().filter { $0.key == pending.key }
            let latest = all.last!
            let payload = latest.payload; let deleted = latest.tombstone
            for edit in all { context.delete(edit) }
            row.version = version
            if keepLocal {
                context.insert(PendingEdit(kind: kind, id: pending.entityID, payload: payload, baseVersion: version, deleted: deleted))
            } else {
                row.payload = pending.conflictPayload; row.tombstone = pending.conflictPayload == nil
            }
            try persistContext()
            revision += 1
        } catch { context.rollback(); throw error }
    }
    private func position() throws -> SyncPosition? {
        let id = syncPositionID
        return try context.fetch(FetchDescriptor<SyncPosition>(predicate: #Predicate { $0.id == id })).first
    }
    public func cursor() throws -> Int { try position()?.cursor ?? 0 }
    public func apply(_ page: SyncPage) throws {
        do {
            var pending = try edits()
            for change in page.changes {
                try receive(change, pending: &pending)
            }
            let position = try position() ?? SyncPosition(id: syncPositionID)
            if position.modelContext == nil { context.insert(position) }
            position.cursor = max(position.cursor, page.cursor)
            try persistContext()
            if !page.changes.isEmpty { revision += 1 }
        } catch { context.rollback(); throw error }
    }
}
