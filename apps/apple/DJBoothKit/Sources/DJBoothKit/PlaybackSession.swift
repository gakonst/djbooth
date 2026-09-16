import Foundation

public struct PlaylistNavigation: Codable, Equatable, Sendable {
    public var browseMode: String?
    public var browseGroup: String?
    public var showBrowser: Bool
    public var folderPath: [String]
    public var preferredCollectionID: String?
    public var playlistSort: String
    public var playlistSortAscending: Bool
    public var trackSort: String
    public var trackSortAscending: Bool
    public init(showBrowser: Bool = false, folderPath: [String] = [], preferredCollectionID: String? = nil,
                playlistSort: String = "title", playlistSortAscending: Bool = true,
                trackSort: String = "default", trackSortAscending: Bool = true, browseMode: String? = nil, browseGroup: String? = nil) {
        self.browseMode = browseMode; self.browseGroup = browseGroup
        self.showBrowser = showBrowser; self.folderPath = folderPath; self.preferredCollectionID = preferredCollectionID
        self.playlistSort = playlistSort; self.playlistSortAscending = playlistSortAscending
        self.trackSort = trackSort; self.trackSortAscending = trackSortAscending
    }
}

/// Device preferences only: playback state never enters the cloud outbox.
public struct PlaybackSession: Codable, Equatable, Sendable {
    public var trackID: String?
    public var queueIDs: [String]
    public var queueIndex: Int?
    public var elapsed: Double
    public var selectedCollection: String?
    public var filter: String
    public var query: String
    public var queueCollection: String?
    public var queueFilter: String
    public var navigation: PlaylistNavigation?

    public init(trackID: String? = nil, queueIDs: [String] = [], elapsed: Double = 0,
                selectedCollection: String? = nil, filter: String = "All music", query: String = "",
                queueCollection: String? = nil, queueFilter: String = "All music", navigation: PlaylistNavigation? = nil, queueIndex: Int? = nil) {
        self.trackID = trackID; self.queueIDs = queueIDs; self.elapsed = elapsed
        self.selectedCollection = selectedCollection; self.filter = filter; self.query = query
        self.queueCollection = queueCollection; self.queueFilter = queueFilter
        self.navigation = navigation; self.queueIndex = queueIndex
    }

    public func resolved(tracks: [Track], collections: [Collection]) -> PlaybackSession {
        var result = self
        let current = Dictionary(tracks.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let collectionIDs = Set(collections.map(\.id))
        if let id = result.selectedCollection, !collectionIDs.contains(id) {
            result.selectedCollection = nil
            result.navigation = result.navigation ?? PlaylistNavigation()
            result.navigation?.showBrowser = true
        }
        if let id = result.queueCollection, !collectionIDs.contains(id) { result.queueCollection = nil }
        if var navigation = result.navigation {
            if let id = navigation.preferredCollectionID, !collectionIDs.contains(id) { navigation.preferredCollectionID = nil }
            if !navigation.folderPath.isEmpty, !collections.contains(where: { ($0.folderPath ?? []).starts(with: navigation.folderPath) }) { navigation.folderPath = [] }
            if !["title", "createdAt", "updatedAt"].contains(navigation.playlistSort) { navigation.playlistSort = "title" }
            if !["default", "title", "bpm", "key"].contains(navigation.trackSort) { navigation.trackSort = "default" }
            result.navigation = navigation
        }
        let filters = ["All music", "Favorites", "On this device", "Unsorted"]
        if !filters.contains(result.filter) { result.filter = "All music" }
        if !filters.contains(result.queueFilter) { result.queueFilter = "All music" }
        var seen = Set<String>()
        let entries = queueIDs.enumerated().filter { current[$0.element] != nil && (queueIndex != nil || seen.insert($0.element).inserted) }
        result.queueIDs = entries.map(\.element)
        result.queueIndex = entries.firstIndex { $0.offset == queueIndex && $0.element == trackID }
        if result.queueIDs.isEmpty {
            let fallbackCollection = result.queueCollection ?? result.selectedCollection
            result.queueIDs = fallbackCollection.flatMap { id in collections.first { $0.id == id }?.trackIDs.filter { current[$0] != nil } } ?? []
            result.queueCollection = fallbackCollection
            result.queueFilter = "All music"
            if result.queueIDs.isEmpty { result.queueIDs = tracks.map(\.id); result.queueCollection = nil }
        }
        if let id = trackID, current[id] != nil {
            if !result.queueIDs.contains(id) { result.queueIDs.insert(id, at: 0) }
        } else {
            result.trackID = result.queueIDs.first
            result.elapsed = 0
        }
        if queueIndex != nil, result.queueIndex == nil { result.queueIndex = result.queueIDs.firstIndex { $0 == result.trackID } }
        if !result.elapsed.isFinite { result.elapsed = 0 }
        result.elapsed = max(0, result.elapsed)
        if let id = result.trackID, let duration = current[id]?.durationSeconds, duration.isFinite, duration > 0 {
            result.elapsed = min(result.elapsed, duration)
        }
        return result
    }
}

@MainActor public final class PlaybackSessionPreferences {
    private let defaults: UserDefaults
    private let key: String
    public init(scope: String, defaults: UserDefaults = .standard) {
        self.defaults = defaults; key = "djbooth.playback.v1.\(scope)"
    }
    public func load() -> PlaybackSession? {
        guard let data = defaults.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(PlaybackSession.self, from: data)
    }
    public func save(_ session: PlaybackSession) {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(session), defaults.data(forKey: key) != data else { return }
        defaults.set(data, forKey: key)
    }
}
