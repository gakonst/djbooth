import Foundation

public struct RecordingUploadAvailability: Decodable, Sendable {
    public let available: Bool
    public let reason: String?
}
public struct RecordingUploadResult: Codable, Sendable {
    public let url: URL
    public let id: String
    public let state: String
}

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
    // A replica of completed import provenance, not download/workflow state.
    // Optional for catalogs written before these links were cached.
    public var downloadedCollections: [String: String]?
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
    private func sourceKey(_ value: String) -> String {
        guard var url = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines)) else { return value }
        url.fragment = nil
        if let host = url.host, host.hasPrefix("www.") { url.host = String(host.dropFirst(4)) }
        let query = (url.queryItems ?? []).filter { !$0.name.hasPrefix("utm_") && !["si", "feature"].contains($0.name) }
            .sorted { $0.name == $1.name ? ($0.value ?? "") < ($1.value ?? "") : $0.name < $1.name }
        url.queryItems = query.isEmpty ? nil : query
        return url.string ?? value
    }
    @discardableResult public mutating func rememberDownloads(_ jobs: [CloudImportJob]) -> Bool {
        var links = downloadedCollections ?? [:]
        // Apply the newest successful publication last. Failed retries never
        // discard a previously acquired library playlist.
        for job in jobs.filter({ $0.status == "complete" }).sorted(by: { $0.updatedAt < $1.updatedAt }) {
            if let id = job.collectionID { links[sourceKey(job.source)] = id }
        }
        guard links != (downloadedCollections ?? [:]) else { return false }
        downloadedCollections = links
        return true
    }
    public func downloadedCollection(for item: MusicPlaylist, library: [Collection]) -> Collection? {
        guard sources.contains(where: { $0.id == item.sourceID }),
              let id = downloadedCollections?[sourceKey(item.url)] else { return nil }
        return library.first { $0.id == id && !$0.trackIDs.isEmpty }
    }
    public func collections(jobs: [CloudImportJob], library: [Collection]) -> [Collection] {
        var catalog = self
        catalog.rememberDownloads(jobs)
        return playlists.compactMap { item in
            guard let source = sources.first(where: { $0.id == item.sourceID }) else { return nil }
            let imported = catalog.downloadedCollection(for: item, library: library)
            return Collection(id: item.id, name: item.name, trackIDs: imported?.trackIDs ?? snapshots[item.id]?.tracks.map(\.id) ?? [], folderPath: folder(for: source))
        }
    }
}
