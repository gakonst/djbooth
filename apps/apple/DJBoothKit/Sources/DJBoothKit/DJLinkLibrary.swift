import Foundation

/// A session-only projection of downloaded library rows into the existing Link engine.
/// Audio hard links retain the original immutable bytes and their decoder extension.
public struct DJLinkLibrary: Encodable, Sendable {
    public struct TrackRow: Encodable, Sendable {
        public let trackId: UInt32
        public let title, artist, album, genre, key, comment, canonicalName: String
        public let artistId, albumId, genreId, keyId, durationSec, bpmHundreds: UInt32
        public let mountPath: String
        public var analysisDatPath, analysisExtPath, analysisTwoexPath: String?
        public let artworkId: UInt32
        public let artworkUrl: String?
    }
    public struct PlaylistRow: Encodable, Sendable {
        public let playlistId: UInt32
        public let name: String
        public let parentId: UInt32
        public let isFolder: Bool
        public let sequence: UInt32
        public let tracks: [UInt32]
    }
    public let tracks: [TrackRow]
    public let playlists: [PlaylistRow]
    public let omittedTracks: Int

    public static func prepare(tracks source: [Track], collections: [Collection], annotations: [String: TrackAnnotation],
                               audioDirectory: URL, sessionDirectory: URL, folderNames: [String: String] = [:],
                               idForIdentity: (String) throws -> UInt32) throws -> DJLinkLibrary {
        let files = FileManager.default
        try files.createDirectory(at: sessionDirectory, withIntermediateDirectories: true)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var directory = sessionDirectory; try directory.setResourceValues(values)
        var rows: [TrackRow] = [], ids: [String: UInt32] = [:]
        var identities: [UInt32: String] = [:]
        func stableID(_ identity: String) throws -> UInt32 {
            // Identity generation belongs to the shared Rust engine.
            let id = try idForIdentity(identity)
            guard id > 0 else { throw ClientError.http(409, "DJ Link returned a zero library ID.") }
            if let existing = identities[id], existing != identity {
                throw ClientError.http(409, "Two library items have conflicting DJ Link IDs. Sharing was stopped to avoid loading the wrong track.")
            }
            identities[id] = identity
            return id
        }
        func category(_ kind: String, _ value: String) throws -> UInt32 {
            value.isEmpty ? 0 : try stableID(kind + ":" + value)
        }
        for track in source.sorted(by: { $0.id < $1.id }) {
            try Task.checkCancellation()
            guard ids[track.id] == nil, let hash = track.mediaHash,
                  hash.count == 64, hash.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
                  let ext = track.mediaExtension?.lowercased(),
                  ["mp3", "wav", "aiff", "aif", "flac", "m4a", "aac"].contains(ext) else { continue }
            let audio = audioDirectory.appendingPathComponent(hash).appendingPathExtension("audio")
            guard files.fileExists(atPath: audio.path) else { continue }
            guard let analysis = track.analysis, analysis.mediaHash == hash,
                  analysis.hashes.allSatisfy({ $0.count == 64 && $0.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) }) else { continue }
            let originals = analysis.hashes.map { audioDirectory.appendingPathComponent($0).appendingPathExtension("audio") }
            guard originals.allSatisfy({ files.fileExists(atPath: $0.path) }) else { continue }
            // Copy-on-write copies keep content-addressed originals immutable
            // when Rust updates PPTH for this installation's audio location.
            let analysisFolder = sessionDirectory.appendingPathComponent(hash).appendingPathComponent(analysis.hashes.joined(separator: "-"))
            try files.createDirectory(at: analysisFolder, withIntermediateDirectories: true)
            let analysisPaths = ["DAT", "EXT", "2EX"].map { analysisFolder.appendingPathComponent("ANLZ0000." + $0) }
            for (original, destination) in zip(originals, analysisPaths) where !files.fileExists(atPath: destination.path) {
                try files.copyItem(at: original, to: destination)
            }
            let destination = sessionDirectory.appendingPathComponent(hash).appendingPathExtension(ext)
            if !files.fileExists(atPath: destination.path) { try files.linkItem(at: audio, to: destination) }
            let id = try stableID("track:" + track.id + ":" + hash)
            ids[track.id] = id
            var artworkId: UInt32 = 0
            var artworkUrl: String?
            if let coverHash = track.artworkHash, coverHash.count == 64,
               coverHash.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) {
                let cover = audioDirectory.appendingPathComponent(coverHash).appendingPathExtension("audio")
                if files.fileExists(atPath: cover.path) {
                    artworkId = try stableID("artwork:" + coverHash)
                    artworkUrl = cover.path
                }
            }
            rows.append(try TrackRow(trackId: id, title: track.title, artist: track.artist ?? "", album: track.album ?? "",
                                 genre: track.genre ?? "", key: track.key ?? "", comment: annotations[track.id]?.note ?? "",
                                 canonicalName: track.id, artistId: category("artist", track.artist ?? ""), albumId: category("album", track.album ?? ""),
                                 genreId: category("genre", track.genre ?? ""), keyId: category("key", track.key ?? ""),
                                 durationSec: bounded(track.durationSeconds?.rounded(.up)), bpmHundreds: bounded(track.bpm.map { $0 * 100 }),
                                 mountPath: destination.path, analysisDatPath: analysisPaths[0].path, analysisExtPath: analysisPaths[1].path, analysisTwoexPath: analysisPaths[2].path,
                                 artworkId: artworkId, artworkUrl: artworkUrl))
        }
        var playlists: [PlaylistRow] = [], folders: [[String]: UInt32] = [:]
        var collectionIDs = Set<String>()
        for collection in collections {
            // The library can contain both durable and connected-provider copies.
            // Keep the first (canonical library) row, as with track identity above.
            guard collectionIDs.insert(collection.id).inserted else { continue }
            let playable = collection.trackIDs.compactMap { ids[$0] }
            // Streaming-only and not-yet-downloaded playlists have no CDJ
            // entries. Filter before creating their ancestor folders too.
            guard !playable.isEmpty else { continue }
            var parent: UInt32 = 0, path: [String] = []
            for name in collection.folderPath ?? [] {
                path.append(name)
                if let id = folders[path] { parent = id; continue }
                let id = try stableID("folder:" + String(decoding: JSONEncoder().encode(path), as: UTF8.self))
                playlists.append(PlaylistRow(playlistId: id, name: folderNames[name] ?? name, parentId: parent, isFolder: true,
                                             sequence: UInt32(playlists.filter { $0.parentId == parent }.count + 1), tracks: []))
                folders[path] = id; parent = id
            }
            let id = try stableID("playlist:" + collection.id)
            playlists.append(PlaylistRow(playlistId: id, name: collection.name, parentId: parent, isFolder: false,
                                         sequence: UInt32(playlists.filter { $0.parentId == parent }.count + 1),
                                         tracks: playable))
        }
        return DJLinkLibrary(tracks: rows, playlists: playlists, omittedTracks: source.count - rows.count)
    }

    private static func bounded(_ value: Double?) -> UInt32 {
        guard let value, value.isFinite, value > 0 else { return 0 }
        return UInt32(min(Double(UInt32.max), value.rounded()))
    }
}
