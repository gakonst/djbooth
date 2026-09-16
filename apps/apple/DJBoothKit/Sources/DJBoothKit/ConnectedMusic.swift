import Foundation

public struct MusicSource: Codable, Identifiable, Sendable, Equatable {
    public var id, provider, connectionID, accountID, label: String
    public var providerName: String { provider == "spotify" ? "Spotify" : "SoundCloud" }
    public var route: String { "v1/music/\(provider)/\(connectionID)" }
}
public struct MusicPlaylist: Codable, Identifiable, Sendable, Equatable {
    public var id, remoteID, sourceID, name, url: String
    public var trackCount: Int
}
public struct MusicTrack: Codable, Identifiable, Sendable, Equatable {
    public var id, remoteID, title: String
    public var artists: [String]
    public var album: String?
    public var durationSeconds: Double
    public var url: String
    public var isrc: String?
    public var available: Bool
    public func libraryTrack(provider: String) -> Track {
        Track(id: id, title: title, artist: artists.joined(separator: ", "), album: album,
              durationSeconds: durationSeconds, hosted: HostedTrack(provider: provider, remoteId: remoteID, externalUrl: url, localContentId: nil, downloadState: "disabled"))
    }
}
public struct MusicPlaylistSnapshot: Codable, Sendable, Equatable {
    public var playlist: MusicPlaylist
    public var tracks: [MusicTrack]
    public var fetchedAt: Double
}
public struct MusicPlaylistPage: Codable, Sendable {
    public var playlists: [MusicPlaylist]
    public var next: String?
}
/// Account-local metadata replica. It never enters the sync outbox or owns acquisition state.
public struct MusicCatalog: Codable, Sendable, Equatable {
    public var sources: [MusicSource] = []
    public var playlists: [MusicPlaylist] = []
    public var snapshots: [String: MusicPlaylistSnapshot] = [:]
    public var fetchedAt: Double = 0
    public init() {}
    public func folder(for source: MusicSource) -> [String] {
        sources.filter { $0.provider == source.provider }.count > 1
            ? [source.providerName, "\(source.label) · \(source.connectionID.prefix(6))"] : [source.providerName]
    }
    public var tracks: [Track] {
        let providers = Dictionary(uniqueKeysWithValues: sources.map { ($0.id, $0.provider) })
        var seen = Set<String>()
        return snapshots.values.flatMap { snapshot -> [Track] in
            guard let provider = providers[snapshot.playlist.sourceID] else { return [] }
            return snapshot.tracks.filter { seen.insert($0.id).inserted }.map { $0.libraryTrack(provider: provider) }
        }
    }
    public func collections(jobs: [CloudImportJob], library: [Collection]) -> [Collection] {
        playlists.compactMap { item in
            guard let source = sources.first(where: { $0.id == item.sourceID }) else { return nil }
            let imported = jobs.first { $0.source == item.url && $0.status == "complete" }.flatMap { job in library.first { $0.id == job.collectionID } }
            return Collection(id: item.id, name: item.name, trackIDs: imported?.trackIDs ?? snapshots[item.id]?.tracks.map(\.id) ?? [], folderPath: folder(for: source))
        }
    }
}
