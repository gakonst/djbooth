import Foundation
import Testing
@testable import DJBoothKit

@MainActor struct LibrarySnapshotTests {
    @Test func firstRenderLoadsOnlyRequestedWaveformsAndReusesThemDuringBackgroundLoading() async throws {
        let store = try LibraryStore(inMemory: true)
        let waveform = Waveform(peaks: [0.1, 0.8], colors: [[1, 2, 3], [4, 5, 6]])
        try store.ingest([Track(id: "a", title: "A", waveform: waveform),
                          Track(id: "b", title: "B", waveform: waveform),
                          Track(id: "c", title: "C", waveform: waveform)], enqueue: false)
        let decoder = LibrarySnapshotDecoder()
        let source = try store.payloadSnapshot()
        let directory = FileManager.default.temporaryDirectory
        _ = try await decoder.decode(source, audioDirectory: directory, metadataOnly: true)
        let firstScreen = try await decoder.decode(source, audioDirectory: directory, metadataOnly: true, waveformTrackIDs: ["b"])
        #expect(firstScreen.tracks.map { $0.waveform != nil } == [false, true, false])
        #expect(firstScreen.tracks[1].waveform == waveform)
        #expect(await decoder.trackDecodeCount == 4)
        _ = try await decoder.decode(source, audioDirectory: directory, metadataOnly: true, waveformTrackIDs: ["b"])
        #expect(await decoder.trackDecodeCount == 4)
        let complete = try await decoder.decode(source, audioDirectory: directory)
        #expect(complete.tracks.allSatisfy { $0.waveform == waveform })
        #expect(await decoder.trackDecodeCount == 6, "Background loading must reuse the first screen's complete tracks")
        let revisited = try await decoder.decode(source, audioDirectory: directory, metadataOnly: true, waveformTrackIDs: ["c"])
        #expect(revisited.tracks == complete.tracks, "A viewport change must not discard already-loaded waveforms")
        var edited = try #require(try store.track(id: "b")); edited.waveform = Waveform(peaks: [0.9])
        try store.save(edited, kind: .track, id: edited.id)
        let refreshed = try await decoder.decode(store.payloadSnapshot(), audioDirectory: directory, metadataOnly: true, waveformTrackIDs: ["b"])
        #expect(refreshed.tracks[1].waveform == edited.waveform)
    }
    @Test func backgroundPreparationPreservesSavedLibraryAndSubsequentEdits() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let waveform = Waveform(peaks: [0.3, 0.9])
        var original: LibraryStore? = try LibraryStore(directory: directory)
        try original!.ingest([Track(id: "a", title: "Saved", waveform: waveform)], enqueue: false)
        try original!.setNote("Pending local edit", trackID: "a")
        let operation = try original!.nextOperation()?.operationID
        original = nil
        let prepared = try await Task.detached { try LibraryStore.prepare(directory: directory) }.value
        let store = try LibraryStore(prepared: prepared)
        let decoder = LibrarySnapshotDecoder()
        let first = try await decoder.decode(store.payloadSnapshot(), audioDirectory: directory, metadataOnly: true)
        #expect(first.tracks.first?.title == "Saved" && first.tracks.first?.waveform == nil)
        #expect(first.annotations["a"]?.note == "Pending local edit")
        #expect(try store.nextOperation()?.operationID == operation)
        try store.setNote("Edited after launch", trackID: "a")
        let latest = try await decoder.decode(store.payloadSnapshot(), audioDirectory: directory)
        #expect(latest.revision > first.revision)
        #expect(latest.annotations["a"]?.note == "Edited after launch" && latest.tracks.first?.waveform == waveform)
        let cancelled = Task { try LibraryStore.prepare(directory: directory) }
        cancelled.cancel()
        do { _ = try await cancelled.value; Issue.record("Cancelled preparation must stop") }
        catch is CancellationError { }
    }
    @Test func startupMetadataPreservesLibraryAndHydratesAnalysisAfterEarlyEdits() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let hash = String(repeating: "c", count: 64)
        try Data([1]).write(to: directory.appendingPathComponent("\(hash).audio"))
        let waveform = Waveform(peaks: [0.2, 0.8], colors: [[1, 2, 3], [4, 5, 6]],
            durationSeconds: 90, beatGrid: BeatGrid(times: [0, 0.5], beats: [1, 2]))
        let track = Track(id: "a", title: "Saved track", artist: "Artist", durationSeconds: 90,
            analyzed: true, mediaHash: hash, waveform: waveform)
        let store = try LibraryStore(inMemory: true)
        try store.ingest([track], enqueue: false)
        let playlist = try store.createCollection(name: "Saved playlist", trackIDs: [track.id])
        try store.toggleFavorite(track.id)
        try store.setNote("Saved cue notes", trackID: track.id)
        let decoder = LibrarySnapshotDecoder()
        let metadata = try await decoder.decode(store.payloadSnapshot(), audioDirectory: directory, metadataOnly: true)
        var expected = track; expected.waveform = nil
        #expect(metadata.tracks == [expected])
        #expect(metadata.collections == [playlist])
        #expect(metadata.favorites == [track.id] && metadata.offlineIDs == [track.id])
        #expect(metadata.annotations[track.id]?.note == "Saved cue notes")
        // An edit made before analysis appears must use the complete durable row.
        var edited = try #require(try store.track(id: track.id))
        #expect(edited == track)
        edited.title = "Early edit"
        try store.save(edited, kind: .track, id: edited.id)
        let complete = try await decoder.decode(store.payloadSnapshot(), audioDirectory: directory)
        #expect(complete.tracks == [edited] && complete.tracks[0].waveform == waveform)
        #expect(complete.collections == metadata.collections && complete.annotations == metadata.annotations)
        #expect(complete.offlineIDs == metadata.offlineIDs && complete.favorites == metadata.favorites)
        let decodeCount = await decoder.trackDecodeCount
        _ = try await decoder.decode(store.payloadSnapshot(), audioDirectory: directory)
        #expect(await decoder.trackDecodeCount == decodeCount)
        #expect(metadata.tracks[0].waveform == nil)
        try store.delete(kind: .track, id: track.id)
        #expect(try store.track(id: track.id) == nil)
    }
    @Test func asynchronousStoreOpeningPreservesDurableEditsAndHonorsCancellation() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var store: LibraryStore? = try await LibraryStore.open(directory: directory)
        try store!.ingest([Track(id: "a", title: "Durable")], enqueue: false)
        try store!.setNote("Saved locally", trackID: "a")
        let operationID = try #require(try store!.nextOperation()?.operationID)
        store = nil
        let cancelled = Task { try await LibraryStore.open(directory: directory) }
        cancelled.cancel()
        do { _ = try await cancelled.value; Issue.record("Cancelled opening must not return a store") }
        catch is CancellationError { }
        let reopened = try await LibraryStore.open(directory: directory)
        #expect(try reopened.values(.track, as: Track.self).first?.title == "Durable")
        #expect(try reopened.annotation(for: "a").note == "Saved locally")
        #expect(try reopened.nextOperation()?.operationID == operationID)
    }
    @Test func immutableSnapshotsReuseWaveformsAndReflectOnlyChangedRows() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let hash = String(repeating: "a", count: 64)
        try Data([1]).write(to: directory.appendingPathComponent(hash).appendingPathExtension("audio"))
        let store = try LibraryStore(inMemory: true)
        let waveform = Waveform(peaks: Array(repeating: 0.7, count: 512), source: "rekordbox")
        try store.ingest([Track(id: "a", title: "Z", mediaHash: hash, waveform: waveform), Track(id: "b", title: "A", waveform: waveform)], enqueue: false)
        let decoder = LibrarySnapshotDecoder()
        let original = try store.payloadSnapshot()
        let first = try await decoder.decode(original, audioDirectory: directory)
        #expect(first.tracks.map(\.id) == ["b", "a"] && first.offlineIDs == ["a"])
        try store.setNote("Later edit", trackID: "a")
        #expect(original.annotations.isEmpty && original.revision < store.revision)
        let second = try await decoder.decode(store.payloadSnapshot(), audioDirectory: directory)
        #expect(second.annotations["a"]?.note == "Later edit")
        #expect(await decoder.trackDecodeCount == 2)
        #expect(await decoder.trackSortCount == 1)
        try FileManager.default.removeItem(at: directory.appendingPathComponent(hash).appendingPathExtension("audio"))
        let withoutAudio = try await decoder.decode(store.payloadSnapshot(), audioDirectory: directory)
        #expect(withoutAudio.offlineIDs.isEmpty && withoutAudio.tracks == second.tracks)
        #expect(await decoder.trackDecodeCount == 2)
        #expect(await decoder.trackSortCount == 1)
        try store.delete(kind: .track, id: "b")
        let third = try await decoder.decode(store.payloadSnapshot(), audioDirectory: directory)
        #expect(third.tracks.map(\.id) == ["a"])
        #expect(await decoder.trackDecodeCount == 2)
        #expect(await decoder.trackSortCount == 2)
        #expect(first.tracks.count == 2 && first.annotations.isEmpty)
    }

    @Test func cachedSnapshotsRespectScopeChangesAddedAudioAndFailedDecoding() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let hash = String(repeating: "b", count: 64)
        let store = try LibraryStore(inMemory: true)
        try store.ingest([Track(id: "a", title: "A", mediaHash: hash)], enqueue: false)
        let decoder = LibrarySnapshotDecoder()
        let source = try store.payloadSnapshot()
        #expect(try await decoder.decode(source, audioDirectory: directory).offlineIDs.isEmpty)
        try Data([1]).write(to: directory.appendingPathComponent(hash).appendingPathExtension("audio"))
        #expect(try await decoder.decode(source, audioDirectory: directory).offlineIDs == ["a"])
        #expect(try await decoder.decode(source, audioDirectory: directory.appendingPathComponent("other-scope")).offlineIDs.isEmpty)
        var malformed = source; malformed.tracks["a"] = "{"
        do { _ = try await decoder.decode(malformed, audioDirectory: directory); Issue.record("Malformed metadata must fail") }
        catch is DecodingError { }
        let recovered = try await decoder.decode(source, audioDirectory: directory)
        #expect(recovered.tracks.first?.title == "A" && recovered.offlineIDs == ["a"])
        let otherStore = try LibraryStore(inMemory: true)
        try otherStore.ingest([Track(id: "a", title: "Other scope")], enqueue: false)
        let other = try await decoder.decode(otherStore.payloadSnapshot(), audioDirectory: directory)
        #expect(other.tracks.first?.title == "Other scope" && other.offlineIDs.isEmpty)
    }

    @Test func unchangedCacheIngestKeepsRevisionAndSingleTrackPublishingLeavesUnrelatedPayloadsAlone() throws {
        let store = try LibraryStore(inMemory: true)
        let track = Track(id: "a", title: "A", waveform: Waveform(peaks: [0.1, 0.8], colors: [[1, 2, 3], [4, 5, 6]]))
        try store.ingest([track], enqueue: false)
        let original = try store.payloadSnapshot()
        try store.ingest([track], enqueue: false)
        #expect(store.revision == original.revision)
        #expect(try store.pendingCount() == 0)
        // Targeted maintenance must not decode another entity's broken/unknown payload.
        try store.apply(SyncPage(changes: [SyncChange(sequence: 1, operationID: "unrelated", kind: .track,
            entityID: "other", payload: "{", deleted: false)], cursor: 1, hasMore: false))
        var edited = track; edited.title = "Updated"
        try store.ingest([edited])
        let latest = try store.payloadSnapshot()
        #expect(latest.tracks["other"] == "{")
        #expect(try JSONDecoder().decode(Track.self, from: Data(latest.tracks["a"]!.utf8)).title == "Updated")
        #expect(try store.pendingEntityIDs(.track) == ["a"])
    }

    @Test func pureBackgroundHashAndHeaderProbePreserveContent() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension("audio")
        defer { try? FileManager.default.removeItem(at: file) }
        let bytes = Data("RIFF0000WAVE".utf8) + Data(repeating: 0, count: 2 * 1024 * 1024)
        try bytes.write(to: file)
        let expected = try AudioFiles.hash(file)
        #expect(try await AudioFiles.hashAsync(file) == expected)
        #expect(await AudioFiles.detectPlaybackMIMEType(url: file) == "audio/wav")
        #expect(try Data(contentsOf: file) == bytes)
        let task = Task { try await AudioFiles.hashAsync(file) }
        task.cancel()
        do { _ = try await task.value; Issue.record("Cancelled hashing must stop") }
        catch is CancellationError { }
    }

    @Test func playbackTimingInterpolatesPausedSeekAndBoundsSafely() {
        let playing = PlaybackTiming(elapsed: 45, duration: 100, playing: true, observedAt: 200)
        #expect(playing.position(at: 200.25) == 45.25)
        #expect(playing.position(at: 400) == 100)
        #expect(playing.position(at: 199) == 45)
        #expect(PlaybackTiming(elapsed: 62, duration: 100, playing: false, observedAt: 200).position(at: 300) == 62)
        #expect(PlaybackTiming(elapsed: .nan, duration: .infinity, playing: true, observedAt: .nan).position(at: .infinity) == 0)
    }
}
