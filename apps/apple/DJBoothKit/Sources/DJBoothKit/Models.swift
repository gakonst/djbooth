import Foundation

extension CodingUserInfoKey {
    static let libraryMetadataOnly = CodingUserInfoKey(rawValue: "djbooth.library.metadataOnly")!
}

public struct Track: Codable, Identifiable, Sendable, Equatable {
    public var id: String
    public var title: String
    public var artist: String?
    public var album: String?
    public var genre: String?
    public var key: String?
    public var bpm: Double?
    public var durationSeconds: Double?
    public var artworkAvailable: Bool
    /// Optional immutable cover bytes; never a remote URL or credential.
    public var artworkHash: String?
    public var fileExists: Bool
    public var analyzed: Bool
    public var hosted: HostedTrack?
    // Only content hashes cross devices; workstation filesystem paths never do.
    public var mediaHash: String?
    public var mediaExtension: String?
    public var analysis: CDJAnalysis?
    public var waveform: Waveform?
    /// Revision of a paired workstation recording, not a cloud sync sequence.
    public var sourceRevision: String?
    /// When the recording entered its source library, not its file modification date.
    public var addedAt: String?

    public init(id: String, title: String, artist: String? = nil, album: String? = nil,
                genre: String? = nil, key: String? = nil, bpm: Double? = nil,
                durationSeconds: Double? = nil, artworkAvailable: Bool = false,
                fileExists: Bool = false, analyzed: Bool = false, hosted: HostedTrack? = nil,
                mediaHash: String? = nil, mediaExtension: String? = nil, waveform: Waveform? = nil, analysis: CDJAnalysis? = nil,
                sourceRevision: String? = nil, artworkHash: String? = nil, addedAt: String? = nil) {
        self.id = id; self.title = title; self.artist = artist; self.album = album
        self.genre = genre; self.key = key; self.bpm = bpm; self.durationSeconds = durationSeconds
        self.artworkAvailable = artworkAvailable; self.fileExists = fileExists
        self.artworkHash = artworkHash
        self.analyzed = analyzed; self.hosted = hosted; self.mediaHash = mediaHash
        self.mediaExtension = mediaExtension
        self.analysis = analysis
        self.waveform = waveform
        self.sourceRevision = sourceRevision
        self.addedAt = addedAt
    }
    public var source: String { hosted?.provider.capitalized ?? "Library" }
    public var localContentID: String? { hosted == nil ? id : hosted?.localContentId }
}

/// Original desktop ANLZ objects, tied to the exact recording hash.
public struct CDJAnalysis: Codable, Sendable, Equatable {
    public var mediaHash, dat, ext, twoEx: String
    public init(mediaHash: String, dat: String, ext: String, twoEx: String) {
        self.mediaHash = mediaHash; self.dat = dat; self.ext = ext; self.twoEx = twoEx
    }
    public var hashes: [String] { [dat, ext, twoEx] }
}

public struct Waveform: Codable, Sendable, Equatable {
    public var peaks: [Double]
    public var colors: WaveformColors?
    public var source: String
    public var durationSeconds: Double?
    public var beatGrid: BeatGrid?
    public init(peaks: [Double], colors: [[Int]]? = nil, source: String = "rekordbox", durationSeconds: Double? = nil, beatGrid: BeatGrid? = nil) {
        self.peaks = peaks; self.colors = colors.map { WaveformColors($0) }; self.source = source; self.durationSeconds = durationSeconds; self.beatGrid = beatGrid
    }
    private enum CodingKeys: String, CodingKey { case peaks, colors, source, durationSeconds, beatGrid }
    public init(from decoder: Decoder) throws {
        if decoder.userInfo[.libraryMetadataOnly] as? Bool == true {
            // The startup snapshot discards this placeholder. The original
            // analysis stays in the database and is decoded after first display.
            peaks = []; colors = nil; source = ""; durationSeconds = nil; beatGrid = nil
            return
        }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        peaks = try values.decode([Double].self, forKey: .peaks)
        colors = try values.decodeIfPresent(WaveformColors.self, forKey: .colors)
        source = try values.decode(String.self, forKey: .source)
        durationSeconds = try values.decodeIfPresent(Double.self, forKey: .durationSeconds)
        // The older wire format had no grid. A malformed optional extension
        // must not make a recording or its existing waveform unavailable.
        beatGrid = try? values.decode(BeatGrid.self, forKey: .beatGrid)
        if beatGrid == nil {
            // Workstation analysis predates the compact cloud representation.
            struct WorkstationBeat: Decodable { let beat: Int; let timeSeconds: Double }
            if let entries = try? values.decode([WorkstationBeat].self, forKey: .beatGrid) {
                beatGrid = BeatGrid(times: entries.map(\.timeSeconds), beats: entries.map(\.beat))
            }
        }
    }
}

public struct HostedTrack: Codable, Sendable, Equatable {
    public var provider: String
    public var remoteId: String
    public var externalUrl: String?
    public var localContentId: String?
    public var downloadState: String
}

public struct Playlist: Codable, Identifiable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var parentId: String
    public var type: String
    public var trackCount: Int?
    public var hosted: HostedPlaylist?
    public init(id: String, name: String, parentId: String = "root", type: String = "playlist",
                trackCount: Int? = nil, hosted: HostedPlaylist? = nil) {
        self.id = id; self.name = name; self.parentId = parentId; self.type = type
        self.trackCount = trackCount; self.hosted = hosted
    }
}

public struct HostedPlaylist: Codable, Sendable, Equatable {
    public var provider: String
    public var downloadEnabled: Bool
    public var syncState: String
    public var syncError: String?
    public var syncCurrent: Int?
    public var syncTotal: Int?
}

public struct Bootstrap: Decodable, Sendable {
    public struct Library: Decodable, Sendable {
        public var writeEnabled: Bool
        public var stats: Stats
    }
    public struct Stats: Decodable, Sendable {
        public var tracks: Int
        public var playlists: Int
        public var analyzed: Int
    }
    public var csrfToken: String
    public var library: Library
}

public struct TracksResponse: Decodable, Sendable {
    public var items: [Track]
    public var count: Int
}
public struct Items<T: Decodable & Sendable>: Decodable, Sendable { public var items: [T] }

/// Native collections are offline editable. Their membership uses stable master.db content IDs.
public struct Collection: Codable, Identifiable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var trackIDs: [String]
    public var isPinned: Bool?
    public var mood: String?
    public var folderPath: [String]?
    public var createdAt: String?
    public var updatedAt: String?
    public init(id: String = UUID().uuidString, name: String, trackIDs: [String] = [], isPinned: Bool? = nil,
                mood: String? = nil, folderPath: [String]? = nil, createdAt: String? = nil, updatedAt: String? = nil) {
        self.id = id; self.name = name; self.trackIDs = trackIDs
        self.isPinned = isPinned; self.mood = mood; self.folderPath = folderPath
        self.createdAt = createdAt; self.updatedAt = updatedAt
    }
    private enum CodingKeys: String, CodingKey { case id, name, trackIDs, isPinned, mood, folderPath, createdAt, updatedAt }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        trackIDs = try values.decode([String].self, forKey: .trackIDs)
        // Older servers treated extra metadata as opaque. Invalid optional
        // extensions must not prevent the authoritative membership from loading.
        isPinned = try? values.decode(Bool.self, forKey: .isPinned)
        mood = try? values.decode(String.self, forKey: .mood)
        folderPath = try? values.decode([String].self, forKey: .folderPath)
        createdAt = try? values.decode(String.self, forKey: .createdAt)
        updatedAt = try? values.decode(String.self, forKey: .updatedAt)
    }
}

public struct Favorite: Codable, Sendable { public var enabled: Bool }

public enum TrackColor: String, Codable, CaseIterable, Sendable {
    case red, blue, pink, cyan
}

/// Personal notes and colors sync independently of acquisition metadata and media.
public struct TrackAnnotation: Codable, Sendable, Equatable {
    public static let maxNoteUTF8Bytes = 16_384
    public var note: String
    public var color: TrackColor?
    public init(note: String = "", color: TrackColor? = nil) {
        self.note = note; self.color = color
    }
    public var isEmpty: Bool { note.isEmpty && color == nil }
}

public enum EntityKind: String, Codable, Sendable { case track, collection, favorite, annotation }

public struct SyncChange: Codable, Sendable {
    public var sequence: Int
    public var operationID: String
    public var kind: EntityKind
    public var entityID: String
    public var payload: String?
    public var deleted: Bool
    public init(sequence: Int, operationID: String, kind: EntityKind, entityID: String,
                payload: String?, deleted: Bool) {
        self.sequence = sequence; self.operationID = operationID; self.kind = kind
        self.entityID = entityID; self.payload = payload; self.deleted = deleted
    }
}
public struct SyncOperation: Codable, Sendable {
    public var operationID: String
    public var kind: EntityKind
    public var entityID: String
    public var baseVersion: Int
    public var payload: String?
    public var deleted: Bool
}
public struct SyncPage: Codable, Sendable { public var changes: [SyncChange]; public var cursor: Int; public var hasMore: Bool }
public struct SyncConflict: Identifiable, Sendable {
    public var id: String
    public var kind: EntityKind
    public var entityID: String
    public var localPayload: String?
    public var remotePayload: String?
}
