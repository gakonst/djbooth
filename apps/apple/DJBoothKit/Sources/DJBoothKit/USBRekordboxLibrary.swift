import Foundation

/// A read-only snapshot of a removable Rekordbox Device Library. IDs belong to this
/// snapshot, never to the local/cloud library. No media or database files are copied.
public struct USBRekordboxLibrary: Sendable {
    public struct Track: Identifiable, Sendable {
        public let id: UInt32
        public let title: String
        public let artist: String
        public let album: String
        public let genre: String
        public let key: String
        public let bpm: Double
        public let duration: Int
        public let comment: String
        public let filePath: String
    }

    public struct Playlist: Identifiable, Sendable {
        public let id: UInt32
        public let parentID: UInt32
        public let name: String
        public let isFolder: Bool
        public let sortOrder: UInt32
        public let trackIDs: [UInt32]
    }

    public struct History: Identifiable, Sendable {
        public let id: UInt32
        public let name: String
        public let trackIDs: [UInt32]
    }

    public let name: String
    public let tracks: [Track]
    public let playlists: [Playlist]
    public let histories: [History]
    public let tracksByID: [UInt32: Track]

    /// Select the volume root so this never needs access beyond the granted folder.
    /// Call off the main actor: coordination and USB reads can block.
    public static func read(root: URL) throws -> Self {
        let accessed = root.startAccessingSecurityScopedResource()
        defer { if accessed { root.stopAccessingSecurityScopedResource() } }
        let directory = root.appendingPathComponent("PIONEER/rekordbox", isDirectory: true)
        let database = directory.appendingPathComponent("export.pdb")
        if !FileManager.default.fileExists(atPath: database.path) {
            if FileManager.default.fileExists(atPath: directory.appendingPathComponent("exportLibrary.db").path) {
                throw USBLibraryError.oneLibraryOnly
            }
            throw USBLibraryError.libraryNotFound
        }
        // Resolve symlinks before coordinating so a selected folder cannot grant
        // access to an unrelated database via a symlink inside PIONEER.
        let rootPath = root.resolvingSymlinksInPath().standardizedFileURL.path
        guard database.resolvingSymlinksInPath().standardizedFileURL.path.hasPrefix(rootPath + "/") else {
            throw USBLibraryError.invalidDatabase
        }
        var coordinationError: NSError?
        var result: Result<Self, Error>?
        NSFileCoordinator().coordinate(readingItemAt: database, options: [], error: &coordinationError) { url in
            result = Result {
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                var data = Data()
                while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty {
                    try Task.checkCancellation()
                    guard data.count + chunk.count <= maximumBytes else { throw USBLibraryError.tooLarge }
                    data.append(chunk)
                }
                return try parse(data, name: root.lastPathComponent)
            }
        }
        if let coordinationError { throw coordinationError }
        guard let result else { throw USBLibraryError.invalidDatabase }
        return try result.get()
    }

    public static func parse(_ data: Data, name: String) throws -> Self {
        let reader = try DeviceSQLReader(data: data)
        let artists = try reader.names(table: 2, idOffset: 4) { row in
            try row.u16(0) == 0x64 ? row.u16(10) : row.u8(9)
        }
        let albums = try reader.names(table: 3, idOffset: 12) { row in
            try row.u16(0) == 0x84 ? row.u16(22) : row.u8(21)
        }
        let genres = try reader.names(table: 1, idOffset: 0) { _ in 4 }
        let keys = try reader.names(table: 5, idOffset: 0) { _ in 8 }
        let tracks = try reader.rows(table: 0).map { row in
            func string(_ index: Int) throws -> String { try row.string(row.u16(0x5e + index * 2)) }
            return try Track(id: row.u32(0x48), title: string(17),
                             artist: artists[row.u32(0x44)] ?? "", album: albums[row.u32(0x40)] ?? "",
                             genre: genres[row.u32(0x3c)] ?? "", key: keys[row.u32(0x20)] ?? "",
                             bpm: Double(row.u32(0x38)) / 100, duration: row.u16(0x54),
                             comment: string(16), filePath: string(20))
        }
        var tracksByID: [UInt32: Track] = [:]
        for track in tracks {
            guard track.id != 0, tracksByID.updateValue(track, forKey: track.id) == nil else {
                throw USBLibraryError.invalidDatabase
            }
        }
        var members: [UInt32: [(position: UInt32, track: UInt32)]] = [:]
        for row in try reader.rows(table: 8) {
            try members[row.u32(8), default: []].append((row.u32(0), row.u32(4)))
        }
        let playlists = try reader.rows(table: 7).map { row in
            let id = try row.u32(12)
            return try Playlist(id: id, parentID: row.u32(0), name: row.string(20),
                                isFolder: row.u32(16) != 0, sortOrder: row.u32(8),
                                trackIDs: (members[id] ?? []).sorted { $0.position < $1.position }.map(\.track))
        }
        var playlistMap: [UInt32: Playlist] = [:]
        for playlist in playlists {
            guard playlist.id != 0, playlistMap.updateValue(playlist, forKey: playlist.id) == nil else {
                throw USBLibraryError.invalidDatabase
            }
        }
        // Reject broken/cyclic trees rather than silently hiding playlists or
        // allowing unbounded recursive navigation. Keep missing track references
        // in their original slots so the UI can show them explicitly.
        var validated: Set<UInt32> = [0]
        for playlist in playlists {
            var path: Set<UInt32> = []
            var current = playlist.id
            while !validated.contains(current) {
                guard path.insert(current).inserted, let node = playlistMap[current] else {
                    throw USBLibraryError.invalidDatabase
                }
                if node.parentID != 0, playlistMap[node.parentID]?.isFolder != true {
                    throw USBLibraryError.invalidDatabase
                }
                current = node.parentID
            }
            validated.formUnion(path)
        }
        var historyMembers: [UInt32: [(position: UInt32, track: UInt32)]] = [:]
        for row in try reader.rows(table: 12) {
            try historyMembers[row.u32(4), default: []].append((row.u32(8), row.u32(0)))
        }
        var historyIDs: Set<UInt32> = []
        let histories = try reader.rows(table: 11).map { row in
            let id = try row.u32(0)
            guard id != 0, historyIDs.insert(id).inserted else { throw USBLibraryError.invalidDatabase }
            return try History(id: id, name: row.string(4),
                               trackIDs: (historyMembers[id] ?? []).sorted { $0.position < $1.position }.map(\.track))
        }
        guard historyMembers.keys.allSatisfy({ historyIDs.contains($0) }) else { throw USBLibraryError.invalidDatabase }
        return Self(name: name, tracks: tracks, playlists: playlists, histories: histories, tracksByID: tracksByID)
    }

    public func children(of parentID: UInt32) -> [Playlist] {
        playlists.filter { $0.parentID == parentID }.sorted {
            $0.sortOrder == $1.sortOrder ? $0.id < $1.id : $0.sortOrder < $1.sortOrder
        }
    }

    private static let maximumBytes = 256 * 1_024 * 1_024
}

public enum USBLibraryError: LocalizedError, Equatable {
    case libraryNotFound, oneLibraryOnly, invalidDatabase, tooLarge

    public var errorDescription: String? {
        switch self {
        case .libraryNotFound:
            "No Rekordbox Device Library found. Select the USB stick’s top-level folder containing PIONEER. If the stick was disconnected, reconnect it and choose it again."
        case .oneLibraryOnly:
            "This stick contains only OneLibrary (Device Library Plus). This reader currently needs the classic Device Library, export.pdb. Export a Device Library from Rekordbox and try again."
        case .invalidDatabase:
            "The Rekordbox Device Library is damaged or uses an unsupported format. Try exporting it again from Rekordbox."
        case .tooLarge:
            "This USB library exceeds the current 256 MB database limit."
        }
    }
}

/// DeviceSQL layout shared with packages/rekordbox-ts/src/devicelib/pdb.ts.
/// Far album pointers and the 13-bit row-offset count follow the format analysis:
/// https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/exports.html
/// Every offset is checked before indexing; deleted slots and non-data pages are skipped.
private struct DeviceSQLReader {
    let bytes: [UInt8]
    let pageSize: Int
    let tables: [UInt32: (first: Int, last: Int)]

    init(data: Data) throws {
        guard data.count >= 4096, data.count <= 256 * 1_024 * 1_024 else { throw USBLibraryError.invalidDatabase }
        let bytes = Array(data)
        let header = Row(bytes: bytes, start: 0, end: bytes.count)
        let pageSize = Int(try header.u32(4))
        guard try header.u32(0) == 0, pageSize >= 512, pageSize <= 65536,
              pageSize.nonzeroBitCount == 1, bytes.count % pageSize == 0 else { throw USBLibraryError.invalidDatabase }
        let count = Int(try header.u32(8))
        guard count > 0, count <= (pageSize - 28) / 16 else { throw USBLibraryError.invalidDatabase }
        var tables: [UInt32: (first: Int, last: Int)] = [:]
        for index in 0..<count {
            let offset = 28 + index * 16
            let type = try header.u32(offset)
            let first = Int(try header.u32(offset + 8)), last = Int(try header.u32(offset + 12))
            guard tables[type] == nil, first > 0, last > 0,
                  first < bytes.count / pageSize, last < bytes.count / pageSize else { throw USBLibraryError.invalidDatabase }
            tables[type] = (first, last)
        }
        guard tables[0] != nil else { throw USBLibraryError.invalidDatabase }
        self.bytes = bytes; self.pageSize = pageSize; self.tables = tables
    }

    func names(table: UInt32, idOffset: Int, nameOffset: (Row) throws -> Int) throws -> [UInt32: String] {
        var values: [UInt32: String] = [:]
        for row in try rows(table: table) { try values[row.u32(idOffset)] = row.string(nameOffset(row)) }
        return values
    }

    func rows(table: UInt32) throws -> [Row] {
        guard let bounds = tables[table] else { return [] }
        var page = bounds.first, visited: Set<Int> = [], rows: [Row] = []
        while true {
            try Task.checkCancellation()
            guard page > 0, page < bytes.count / pageSize, visited.insert(page).inserted else { throw USBLibraryError.invalidDatabase }
            let start = page * pageSize
            let view = Row(bytes: bytes, start: start, end: start + pageSize)
            guard try view.u32(4) == UInt32(page), try view.u32(8) == table else { throw USBLibraryError.invalidDatabase }
            if try view.u8(0x1b) & 0x40 == 0 {
                let slots = try view.u16(0x18) & 0x1fff
                let directoryStart = pageSize - (slots * 2 + ((slots + 15) / 16) * 4)
                guard directoryStart >= 0x28 else { throw USBLibraryError.invalidDatabase }
                // Strings can be allocated elsewhere in the page heap, beyond
                // another row. Bound reads to the heap, not to the next row.
                // Deleted slots may contain stale offsets and must not be read.
                var offsets: [Int] = []
                for slot in 0..<slots {
                    let base = pageSize - (slot / 16) * 36
                    let present = try view.u16(base - 4) & (1 << (slot % 16)) != 0
                    let offset = try view.u16(base - 6 - (slot % 16) * 2) + 0x28
                    if !present { continue }
                    guard offset >= 0x28, offset < directoryStart else { throw USBLibraryError.invalidDatabase }
                    offsets.append(offset)
                }
                guard Set(offsets).count == offsets.count else { throw USBLibraryError.invalidDatabase }
                for entry in offsets {
                    rows.append(Row(bytes: bytes, start: start + entry, end: start + directoryStart))
                }
            }
            if page == bounds.last { break }
            page = Int(try view.u32(12))
        }
        return rows
    }

    struct Row {
        let bytes: [UInt8]
        let start: Int
        let end: Int

        func check(_ offset: Int, _ length: Int) throws {
            guard offset >= 0, length >= 0, offset <= end - start, length <= end - start - offset else {
                throw USBLibraryError.invalidDatabase
            }
        }
        func u8(_ offset: Int) throws -> Int { try check(offset, 1); return Int(bytes[start + offset]) }
        func u16(_ offset: Int) throws -> Int { try check(offset, 2); return Int(bytes[start + offset]) | Int(bytes[start + offset + 1]) << 8 }
        func u32(_ offset: Int) throws -> UInt32 {
            try check(offset, 4)
            return (0..<4).reduce(0) { $0 | UInt32(bytes[start + offset + $1]) << ($1 * 8) }
        }
        func string(_ offset: Int) throws -> String {
            let kind = try u8(offset)
            let length: Int, prefix: Int, encoding: String.Encoding
            if kind & 1 != 0 {
                guard kind >= 3 else { throw USBLibraryError.invalidDatabase }
                length = (kind >> 1) - 1; prefix = 1; encoding = .utf8
            } else {
                guard kind == 0x40 || kind == 0x90 else { throw USBLibraryError.invalidDatabase }
                length = try u16(offset + 1) - 4; prefix = 4
                encoding = kind == 0x90 ? .utf16LittleEndian : .utf8
                if kind == 0x90, length % 2 != 0 { throw USBLibraryError.invalidDatabase }
            }
            try check(offset, prefix)
            try check(offset + prefix, length)
            let range = (start + offset + prefix)..<(start + offset + prefix + length)
            guard let value = String(bytes: bytes[range], encoding: encoding) else { throw USBLibraryError.invalidDatabase }
            return value
        }
    }
}
