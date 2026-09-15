import Foundation
import Testing
@testable import DJBoothKit

@MainActor struct PlaybackSessionTests {
    private let tracks = [Track(id: "a", title: "A", durationSeconds: 100), Track(id: "b", title: "B", durationSeconds: 200)]
    private let collection = Collection(id: "set", name: "Set", trackIDs: ["b", "a"])

    @Test func restoresOrderedQueuePositionAndIndependentBrowseContext() {
        let session = PlaybackSession(trackID: "a", queueIDs: ["b", "a"], elapsed: 45,
                                      selectedCollection: "set", filter: "Favorites", query: "bass",
                                      queueCollection: "set", queueFilter: "All music")
        #expect(session.resolved(tracks: tracks, collections: [collection]) == session)
    }
    @Test func missingTracksCollectionsAndInvalidPositionRecoverSafely() {
        let session = PlaybackSession(trackID: "gone", queueIDs: ["gone", "b", "b", "a"], elapsed: 45,
                                      selectedCollection: "gone", filter: "obsolete", queueCollection: "gone")
        let restored = session.resolved(tracks: tracks, collections: [])
        #expect(restored.trackID == "b" && restored.queueIDs == ["b", "a"] && restored.elapsed == 0)
        #expect(restored.selectedCollection == nil && restored.queueCollection == nil && restored.filter == "All music")
        #expect(PlaybackSession(trackID: "a", elapsed: 900).resolved(tracks: tracks, collections: []).elapsed == 100)
        #expect(PlaybackSession(trackID: "a", elapsed: .nan).resolved(tracks: tracks, collections: []).elapsed == 0)
        #expect(session.resolved(tracks: [], collections: []).trackID == nil)
    }
    @Test func firstLaunchPreparesFirstTrackAndExistingCollectionOrder() {
        #expect(PlaybackSession().resolved(tracks: tracks, collections: [collection]).trackID == "a")
        let selected = PlaybackSession(selectedCollection: "set").resolved(tracks: tracks, collections: [collection])
        #expect(selected.trackID == "b" && selected.queueIDs == ["b", "a"] && selected.elapsed == 0)
    }
    @Test func deletedQueueFallsBackToPlayingCollectionInsteadOfBrowsedCollection() {
        let browsing = Collection(id: "browse", name: "Browsing", trackIDs: ["a"])
        let session = PlaybackSession(trackID: "gone", queueIDs: ["gone"], selectedCollection: "browse", queueCollection: "set")
        let restored = session.resolved(tracks: tracks, collections: [collection, browsing])
        #expect(restored.trackID == "b" && restored.queueIDs == ["b", "a"])
        #expect(restored.selectedCollection == "browse" && restored.queueCollection == "set")
    }
    @Test func sessionsSurviveRelaunchAndStayIsolatedAcrossEndpoints() throws {
        let suite = "djbooth.playback.test.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = PlaybackSessionPreferences(scope: "first-cloud", defaults: defaults)
        let second = PlaybackSessionPreferences(scope: "second-cloud", defaults: defaults)
        let session = PlaybackSession(trackID: "b", queueIDs: ["b", "a"], elapsed: 45, selectedCollection: "set")
        first.save(session)
        #expect(second.load() == nil)
        #expect(PlaybackSessionPreferences(scope: "first-cloud", defaults: defaults).load() == session)
        second.save(PlaybackSession(trackID: "a"))
        #expect(first.load() == session)
    }
}
