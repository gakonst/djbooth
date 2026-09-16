import Foundation

/// Only immutable values cross from the SwiftData owner to the decoding actor.
public struct LibraryPayloadSnapshot: Sendable {
    public var revision: Int
    public var tracks: [String: String] = [:]
    public var collections: [String: String] = [:]
    public var favorites: [String: String] = [:]
    public var annotations: [String: String] = [:]
    public init(revision: Int) { self.revision = revision }
}

public struct LibrarySnapshot: Sendable {
    public var revision: Int
    public var tracks: [Track]
    public var collections: [Collection]
    public var favorites: Set<String>
    public var annotations: [String: TrackAnnotation]
    public var offlineIDs: Set<String>
}

/// Decoding waveforms, sorting and filesystem checks never execute on MainActor.
public actor LibrarySnapshotDecoder {
    private var tracks: [String: (payload: String, value: Track, complete: Bool)] = [:]
    private var collections: [String: (payload: String, value: Collection)] = [:]
    private var previousSource: LibraryPayloadSnapshot?
    private var sortedTracks: [Track] = []
    private var sortedCollections: [Collection] = []
    private var favorites: Set<String> = []
    private var annotations: [String: TrackAnnotation] = [:]
    private var audioCandidates: [String: String] = [:]
    private(set) var trackDecodeCount = 0
    private(set) var trackSortCount = 0
    public init() {}

    public func decode(_ source: LibraryPayloadSnapshot, audioDirectory: URL, metadataOnly: Bool = false, waveformTrackIDs: Set<String> = []) throws -> LibrarySnapshot {
        try Task.checkCancellation()
        let decoder = JSONDecoder()
        let requested = metadataOnly ? waveformTrackIDs : Set(source.tracks.keys)
        let needsAnalysis = requested.contains { tracks[$0]?.complete != true && source.tracks[$0] != nil }
        var currentTracks = tracks, currentCollections = collections
        var currentSortedTracks = sortedTracks, currentSortedCollections = sortedCollections
        var currentFavorites = favorites, currentAnnotations = annotations
        var currentAudioCandidates = audioCandidates
        if needsAnalysis || previousSource?.tracks != source.tracks {
            currentTracks = [:]; currentTracks.reserveCapacity(source.tracks.count)
            for (id, payload) in source.tracks {
                try Task.checkCancellation()
                let complete = requested.contains(id)
                if let cached = tracks[id], cached.payload == payload, cached.complete || !complete { currentTracks[id] = cached }
                else {
                    decoder.userInfo[.libraryMetadataOnly] = !complete
                    var track = try decoder.decode(Track.self, from: Data(payload.utf8))
                    if !complete { track.waveform = nil }
                    currentTracks[id] = (payload, track, complete)
                    trackDecodeCount += 1
                }
            }
            currentSortedTracks = currentTracks.values.map(\.value).sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
            trackSortCount += 1
            currentAudioCandidates = Dictionary(currentSortedTracks.compactMap { track -> (String, String)? in
                guard let hash = track.mediaHash, hash.count == 64, hash.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { return nil }
                return (track.id, "\(hash).audio")
            }, uniquingKeysWith: { first, _ in first })
        }
        if previousSource?.collections != source.collections {
            currentCollections = [:]; currentCollections.reserveCapacity(source.collections.count)
            for (id, payload) in source.collections {
                if let cached = collections[id], cached.payload == payload { currentCollections[id] = cached }
                else { currentCollections[id] = (payload, try decoder.decode(Collection.self, from: Data(payload.utf8))) }
            }
            currentSortedCollections = currentCollections.values.map(\.value).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        }
        if previousSource?.favorites != source.favorites {
            currentFavorites = try Set(source.favorites.compactMap { id, payload in
                try decoder.decode(Favorite.self, from: Data(payload.utf8)).enabled ? id : nil
            })
        }
        if previousSource?.annotations != source.annotations {
            currentAnnotations = try source.annotations.mapValues { try decoder.decode(TrackAnnotation.self, from: Data($0.utf8)) }
        }
        // Availability can change without any metadata edit. Enumerate once per reload
        // instead of issuing an individual filesystem query for every library track.
        let names = try? FileManager.default.contentsOfDirectory(atPath: audioDirectory.path)
        let present = names.map { Set($0) }
        let offlineIDs = Set(currentAudioCandidates.compactMap { id, name in
            let exists = present?.contains(name) ?? FileManager.default.fileExists(atPath: audioDirectory.appendingPathComponent(name).path)
            return exists ? id : nil
        })
        tracks = currentTracks; collections = currentCollections
        sortedTracks = currentSortedTracks; sortedCollections = currentSortedCollections
        favorites = currentFavorites; annotations = currentAnnotations
        audioCandidates = currentAudioCandidates; previousSource = source
        return LibrarySnapshot(revision: source.revision, tracks: currentSortedTracks, collections: currentSortedCollections,
                               favorites: currentFavorites, annotations: currentAnnotations, offlineIDs: offlineIDs)
    }
}

public struct PlaybackTiming: Sendable, Equatable {
    public var elapsed: Double
    public var duration: Double
    public var playing: Bool
    public var observedAt: Double
    public init(elapsed: Double = 0, duration: Double = 0, playing: Bool = false, observedAt: Double = ProcessInfo.processInfo.systemUptime) {
        self.elapsed = elapsed; self.duration = duration; self.playing = playing; self.observedAt = observedAt
    }
    public func position(at uptime: Double) -> Double {
        let anchor = elapsed.isFinite ? max(0, elapsed) : 0
        let delta = playing && uptime.isFinite && observedAt.isFinite ? max(0, uptime - observedAt) : 0
        let projected = anchor + delta
        let position = projected.isFinite ? projected : anchor
        return duration.isFinite && duration > 0 ? min(duration, position) : position
    }
}
