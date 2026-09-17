import Foundation

public enum CrewRole: String, Codable, Sendable, CaseIterable {
    case owner, admin, dj, viewer
    public var canEdit: Bool { self != .viewer }
    public var canInvite: Bool { self == .owner || self == .admin }
}

public struct CrewSummary: Codable, Identifiable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var role: CrewRole
    public var memberCount: Int
    public var crateCount: Int
    public var updatedAt: String?
}

public struct CrewMember: Codable, Identifiable, Sendable, Equatable {
    public var accountID: String
    public var displayName: String
    public var role: CrewRole
    public var joinedAt: String
    public var id: String { accountID }
}

public struct CrewCrate: Codable, Identifiable, Sendable, Equatable {
    public var id: String
    public var crewID: String
    public var name: String
    public var note: String?
    public var itemCount: Int?
    public var updatedAt: String?
}

public struct Crew: Codable, Identifiable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var role: CrewRole
    public var createdAt: String?
    public var updatedAt: String?
}

public struct CrewDetail: Codable, Sendable, Equatable {
    public var crew: Crew
    public var members: [CrewMember]
    public var crates: [CrewCrate]
}

public struct CrewInvite: Codable, Sendable, Equatable {
    public var token: String
    public var role: CrewRole
    public var expiresAt: Int
}

public struct CrewTrackReference: Codable, Sendable, Equatable {
    public var recordingID: String
    public var assetHash: String?
    public var localTrackID: String?
    public var title: String
    public var artist: String?
    public var bpm: Double?
    public var musicalKey: String?
    public var durationSeconds: Double?
    public init(_ track: Track) {
        recordingID = track.id; assetHash = track.mediaHash; localTrackID = track.localContentID
        title = track.title; artist = track.artist; bpm = track.bpm; musicalKey = track.key
        durationSeconds = track.durationSeconds
    }
}

public struct CrewCrateItem: Codable, Identifiable, Sendable, Equatable {
    public var id: String
    public var crateID: String
    public var recordingID: String
    public var assetHash: String?
    public var localTrackID: String?
    public var title: String
    public var artist: String?
    public var bpm: Double?
    public var musicalKey: String?
    public var durationSeconds: Double?
    public var note: String?
    public var sortKey: Double
    public var addedBy: String
    public var createdAt: String
    public var updatedAt: String
}

public struct CrewCrateDetail: Codable, Sendable, Equatable {
    public var crate: CrewCrate
    public var items: [CrewCrateItem]
}

public struct CrewCache: Codable, Sendable, Equatable {
    public var crews: [CrewSummary]
    public var details: [String: CrewDetail]
    public var crates: [String: CrewCrateDetail]
    public init(crews: [CrewSummary] = [], details: [String: CrewDetail] = [:], crates: [String: CrewCrateDetail] = [:]) {
        self.crews = crews; self.details = details; self.crates = crates
    }
}
