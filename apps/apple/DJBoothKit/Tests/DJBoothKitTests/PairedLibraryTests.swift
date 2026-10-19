import Foundation
import Testing
@testable import DJBoothKit

struct PairedLibraryTests {
    private let hash = String(repeating: "a", count: 64)
    private let token = String(repeating: "b", count: 64)

    @Test func descriptorRejectsUnscopedOriginsMalformedPinsAndCredentials() throws {
        let valid: [String: Any] = ["version": 1, "url": "https://MAC.local:443/", "certificateSHA256": hash,
                                    "token": token, "libraryID": "studio", "name": "Studio Mac"]
        let descriptor = try PairedLibrary(json: JSONSerialization.data(withJSONObject: valid))
        #expect(descriptor.url.absoluteString == "https://mac.local")
        #expect(try JSONDecoder().decode(PairedLibrary.self, from: JSONEncoder().encode(descriptor)) == descriptor)
        #expect(!String(describing: descriptor).contains(token))
        #expect(!String(reflecting: descriptor).contains(token))
        for url in ["http://192.168.1.3", "http://localhost", "file:///tmp/library", "https://user:pass@mac.local",
                    "https://mac.local/path", "https://mac.local?token=x", "https://mac.local#x", "https://mac.local:0", "https://mac.local:65536"] {
            var input = valid; input["url"] = url
            let data = try JSONSerialization.data(withJSONObject: input)
            #expect(throws: PairedLibraryError.self) { try PairedLibrary(json: data) }
        }
        for (key, value) in [("certificateSHA256", hash.uppercased()), ("certificateSHA256", String(hash.dropLast())),
                             ("token", token + "\n"), ("token", String(repeating: "g", count: 64)), ("libraryID", ""), ("name", "\n")] {
            var input = valid; input[key] = value
            let data = try JSONSerialization.data(withJSONObject: input)
            #expect(throws: PairedLibraryError.self) { try PairedLibrary(json: data) }
        }
        var future = valid; future["version"] = 2
        let data = try JSONSerialization.data(withJSONObject: future)
        #expect(throws: PairedLibraryError.self) { try PairedLibrary(json: data) }
        let oldTrack = Track(id: "old", title: "Old")
        #expect(try JSONDecoder().decode(Track.self, from: JSONEncoder().encode(oldTrack)).sourceRevision == nil)
    }

    @Test func projectionKeepsHierarchyOrderRepeatsEmptyFoldersAndLibraryIsolation() throws {
        let tracks = [Track(id: "A", title: "First", sourceRevision: "r1"), Track(id: "B", title: "Second", sourceRevision: "r1")]
        let playlists = [
            PairedLibraryPlaylist(id: "late", name: "Later", seq: 9, trackIDs: ["B"]),
            PairedLibraryPlaylist(id: "leaf", name: "Set", parentId: "inner", trackIDs: ["A", "B", "A"]),
            PairedLibraryPlaylist(id: "empty", name: "Empty", parentId: "outer", type: "folder", seq: 2),
            PairedLibraryPlaylist(id: "inner", name: "B", parentId: "outer", type: "folder", seq: 1),
            PairedLibraryPlaylist(id: "outer", name: "A", type: "folder", seq: 0),
        ]
        let first = try PairedLibrarySnapshot(libraryID: "one", name: "Mac", tracks: tracks, playlists: playlists)
        let second = try PairedLibrarySnapshot(libraryID: "two", name: "Mac", tracks: tracks, playlists: playlists)
        #expect(first.collections.map(\.name) == ["Set", "Later"])
        #expect(first.collections[0].trackIDs == ["paired:one:track:A", "paired:one:track:B", "paired:one:track:A"])
        #expect(first.collections[0].folderPath == ["Mac", "A", "B"])
        #expect(first.folderPaths == [["Mac"], ["Mac", "A"], ["Mac", "A", "B"], ["Mac", "A", "Empty"]])
        #expect(Set(first.projectedTracks.map(\.id)).isDisjoint(with: second.projectedTracks.map(\.id)))
        #expect(first.collections[0].id != second.collections[0].id)
        #expect(first.rawTrackID(for: first.projectedTrackID("A")) == "A")
        #expect(first.rawTrackID(for: second.projectedTrackID("A")) == nil)
        #expect(first.rawTrackID(for: first.projectedTrackID("deleted")) == nil)
        let opaque = try PairedLibrarySnapshot(libraryID: "one:track:x", name: "Mac", tracks: tracks, playlists: [])
        #expect(opaque.projectedTrackID("A") != first.projectedTrackID("x:track:A"))
        #expect(opaque.rawTrackID(for: opaque.projectedTrackID("A")) == "A")
        let siblings = try PairedLibrarySnapshot(libraryID: "one", name: "Mac", tracks: tracks, playlists: [
            PairedLibraryPlaylist(id: "left", name: "Same", type: "folder"),
            PairedLibraryPlaylist(id: "right", name: "Same", type: "folder"),
            PairedLibraryPlaylist(id: "smart", name: "Smart", parentId: "left", type: "smart", trackIDs: ["B", "A", "B"]),
        ])
        #expect(siblings.folderIDPaths == [["paired:one:root"], ["paired:one:root", "paired:one:playlist:left"], ["paired:one:root", "paired:one:playlist:right"]])
        #expect(siblings.folderName(for: siblings.folderRootID) == "Mac")
        #expect(siblings.folderName(for: "paired:one:playlist:left") == "Same")
        #expect(siblings.folderName(for: "paired:one:playlist:right") == "Same")
        #expect(siblings.collectionsWithFolderIDs[0].folderPath == ["paired:one:root", "paired:one:playlist:left"])
        #expect(siblings.collections[0].trackIDs == ["paired:one:track:B", "paired:one:track:A", "paired:one:track:B"])
    }

    @Test func fullRefreshInvalidatesChangedRevisionsAndRejectsLateDownloads() throws {
        let analysis = CDJAnalysis(mediaHash: hash, dat: hash, ext: hash, twoEx: hash)
        let waveform = Waveform(peaks: [0.1, 0.8])
        func downloaded(_ id: String, revision: String = "r1") -> Track {
            Track(id: id, title: id, fileExists: true, analyzed: true, mediaHash: hash, mediaExtension: "wav",
                  waveform: waveform, analysis: analysis, sourceRevision: revision)
        }
        let old = try PairedLibrarySnapshot(libraryID: "mac", name: "Old", tracks: [downloaded("A"), downloaded("B"), downloaded("removed")],
                                           playlists: [PairedLibraryPlaylist(id: "removed", name: "Removed", trackIDs: ["removed"])])
        let catalog = try PairedLibrarySnapshot(libraryID: "mac", name: "Renamed", tracks: [downloaded("A"), downloaded("B", revision: "r2"), downloaded("new")],
                                               playlists: [PairedLibraryPlaylist(id: "new", name: "Current", trackIDs: ["A", "B", "A"])])
        let merged = try old.merging(catalog)
        #expect(merged.name == "Renamed")
        #expect(merged.tracks.map(\.id) == ["A", "B", "new"])
        #expect(merged.tracks[0] == old.tracks[0])
        for track in merged.tracks.dropFirst() {
            #expect(!track.fileExists && !track.analyzed)
            #expect(track.mediaHash == nil && track.analysis == nil && track.waveform == nil)
        }
        #expect(merged.playlists.map(\.id) == ["new"])
        #expect(throws: PairedLibraryError.self) { try merged.updating(downloaded("B")) }
        #expect(throws: PairedLibraryError.self) { try merged.updating(downloaded("removed")) }
        #expect(try merged.updating(downloaded("B", revision: "r2")).tracks[1].analysis == analysis)
        let other = try PairedLibrarySnapshot(libraryID: "other", name: "Mac", tracks: [], playlists: [])
        #expect(throws: PairedLibraryError.self) { try merged.merging(other) }
    }

    @Test func malformedHierarchyAndDuplicateIDsFailWithoutProjectionLoops() throws {
        let track = Track(id: "A", title: "A", sourceRevision: "r1")
        for playlists in [
            [PairedLibraryPlaylist(id: "a", name: "A", parentId: "b", type: "folder"), PairedLibraryPlaylist(id: "b", name: "B", parentId: "a", type: "folder")],
            [PairedLibraryPlaylist(id: "a", name: "A", parentId: "missing")],
            [PairedLibraryPlaylist(id: "a", name: "A", trackIDs: ["missing"])],
            [PairedLibraryPlaylist(id: "a", name: "A"), PairedLibraryPlaylist(id: "a", name: "B")],
        ] {
            #expect(throws: PairedLibraryError.self) { try PairedLibrarySnapshot(libraryID: "mac", name: "Mac", tracks: [track], playlists: playlists) }
        }
        #expect(throws: PairedLibraryError.self) { try PairedLibrarySnapshot(libraryID: "mac", name: "Mac", tracks: [track, track], playlists: []) }
    }

    @Test @MainActor func snapshotPersistsAndClearsWithoutCloudRowsOrOutbox() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let analysis = CDJAnalysis(mediaHash: hash, dat: hash, ext: hash, twoEx: hash)
        let legacy = Track(id: "a", title: "A", fileExists: true, analyzed: true, mediaHash: hash,
                           mediaExtension: "wav", analysis: analysis, sourceRevision: "r1", artworkHash: hash)
        #expect(try JSONDecoder().decode(Track.self, from: JSONEncoder().encode(legacy)).addedAt == nil)
        let old = try PairedLibrarySnapshot(libraryID: "mac", name: "Mac", tracks: [legacy], playlists: [])
        let dated = Track(id: "a", title: "A", sourceRevision: "r1", addedAt: "2026-10-17T12:30:00.900Z")
        let snapshot = try old.merging(PairedLibrarySnapshot(libraryID: "mac", name: "Mac", tracks: [dated], playlists: []))
        #expect(snapshot.projectedTracks[0].addedAt == "2026-10-17T12:30:00.900Z")
        #expect(snapshot.tracks[0].fileExists && snapshot.tracks[0].mediaHash == hash, "Timestamp backfill must not discard offline audio")
        var decoded = snapshot.tracks[0]
        decoded.waveform = Waveform(peaks: Array(repeating: 0.8, count: 20_000),
                                    colors: Array(repeating: [20, 100, 240], count: 20_000))
        let hydrated = try snapshot.updating(decoded)
        var store: LibraryStore? = try LibraryStore(directory: directory)
        try store!.savePairedLibrary(hydrated)
        #expect(hydrated.tracks[0].waveform?.peaks.count == 20_000, "Saving must not discard the displayed waveform")
        #expect(try store!.pendingCount() == 0)
        #expect(try store!.values(.track, as: Track.self).isEmpty)
        #expect(try store!.payloadSnapshot().tracks.isEmpty)
        store = nil
        let reopened = try LibraryStore(directory: directory)
        #expect(try reopened.pairedLibrary() == snapshot, "Persist analysis references, not decoded arrays that grow every download")
        #expect(try reopened.nextOperation() == nil)
        let encoded = String(decoding: try JSONEncoder().encode(snapshot), as: UTF8.self)
        #expect(!encoded.contains("certificateSHA256") && !encoded.contains("token") && !encoded.contains("https://"))
        try reopened.clearPairedLibrary()
        #expect(try reopened.pairedLibrary() == nil)
        #expect(try reopened.pendingCount() == 0)
        #expect(try LibraryStore(directory: directory).pairedLibrary() == nil)
    }
}

#if os(macOS)
/// Real TLS, redirects and download bytes, not URLProtocol mocks that bypass trust.
@Suite(.serialized) struct PairedLibraryTLSTests {
    @Test @MainActor func artworkBackfillsWithoutAudioAndSurvivesOfflineStoreRelaunch() async throws {
        let server = try await PairedTLSServer(); defer { server.stop() }
        let client = PairedLibraryClient(try server.pairing())
        let files = try AudioFiles(directory: server.directory.appendingPathComponent("audio"))
        var snapshot = try PairedLibrarySnapshot(libraryID: "mac", name: "Mac", tracks: [
            Track(id: "art-good", title: "Already downloaded", sourceRevision: "r1"),
        ], playlists: [])
        snapshot = try snapshot.updating(await client.download(trackID: "art-good", to: files))
        let music = snapshot.tracks[0]
        #expect(music.artworkHash == nil && music.fileExists)
        let before = try server.requests().count
        let cover = try await client.artwork(trackID: "art-good", to: files)
        let hash = try #require(cover.artworkHash)
        snapshot = try snapshot.updatingArtwork(cover)
        #expect(snapshot.tracks[0].mediaHash == music.mediaHash && snapshot.tracks[0].analysis == music.analysis)
        #expect(snapshot.tracks[0].fileExists && snapshot.tracks[0].analyzed)
        #expect(try server.requests().dropFirst(before).map(\.path) == ["/pair/v1/tracks/art-good", "/pair/v1/tracks/art-good/artwork"])
        #expect(try server.requests().last?.query == ["hash": [hash]])
        let metadata = try PairedLibrarySnapshot(libraryID: "mac", name: "Mac", tracks: [
            Track(id: "art-good", title: "Renamed", artworkAvailable: false, sourceRevision: "r1"),
        ], playlists: [])
        snapshot = try snapshot.merging(metadata)
        #expect(snapshot.tracks[0].artworkHash == hash, "Catalog hints must not discard verified embedded artwork")
        var late = cover; late.sourceRevision = "r2"
        #expect(throws: PairedLibraryError.self) { try snapshot.updatingArtwork(late) }
        let storeDirectory = server.directory.appendingPathComponent("library")
        var store: LibraryStore? = try LibraryStore(directory: storeDirectory)
        try store!.savePairedLibrary(snapshot)
        #expect(try store!.pendingCount() == 0)
        store = nil
        server.stopServing()
        let reloaded = try #require(try LibraryStore(directory: storeDirectory).pairedLibrary())
        let image = try #require(await PairedLibraryClient.cachedArtwork(hash: reloaded.tracks[0].artworkHash!, files: files))
        #expect(image.width == 3 && image.height == 2)
        let artworkFile = try #require(await files.existing(hash: hash))
        #expect(try AudioFiles.hash(artworkFile) == hash)
        try Data("corrupted cache".utf8).write(to: artworkFile)
        await #expect(throws: ClientError.self) { try await PairedLibraryClient.cachedArtwork(hash: hash, files: files) }
        #expect(try AudioFiles.hash(await files.existing(hash: music.mediaHash!)!) == music.mediaHash)
    }

    @Test func artworkRejectsUnboundedInvalidOrRedirectedBytesWithoutBreakingMusic() async throws {
        let server = try await PairedTLSServer(); defer { server.stop() }
        let client = PairedLibraryClient(try server.pairing())
        for id in ["art-corrupt", "art-invalid-image", "art-large-header", "art-large-stream", "art-missing", "art-redirect", "art-bad-mime"] {
            let files = try AudioFiles(directory: server.directory.appendingPathComponent(id))
            await #expect(throws: ClientError.self) { try await client.artwork(trackID: id, to: files) }
            #expect(try FileManager.default.contentsOfDirectory(atPath: (await files.directory).path).isEmpty)
            let music = try await client.download(trackID: id, to: files)
            #expect(music.fileExists && music.analyzed, "A failed optional cover must not invalidate music")
        }
        let files = try AudioFiles(directory: server.directory.appendingPathComponent("no-cover"))
        #expect(try await client.artwork(trackID: "ok", to: files).artworkHash == nil)
        #expect(try await client.artwork(trackID: "art-malformed-hash", to: files).artworkHash == nil)
        let before = try server.requests().count
        let wrong = PairedLibraryClient(try server.pairing(pin: String(repeating: "0", count: 64)))
        await #expect(throws: (any Error).self) { try await wrong.artwork(trackID: "art-good", to: files) }
        #expect(try server.requests().count == before)
        #expect(try server.requests().allSatisfy { $0.authorized && !$0.path.contains("sink") })
    }

    @Test(.timeLimit(.minutes(1))) func separateClientsBoundSixDownloadsAndVerifyEveryOfflineObject() async throws {
        let server = try await PairedTLSServer(); defer { server.stop() }
        try await verifiedConcurrentDownloads(server)
    }

    private func verifiedConcurrentDownloads(_ server: PairedTLSServer) async throws {
        let pairing = try server.pairing()
        let files = try AudioFiles(directory: server.directory.appendingPathComponent("audio"))
        let tracks = try await withThrowingTaskGroup(of: Track.self) { group in
            for index in 0..<6 {
                group.addTask { try await PairedLibraryClient(pairing).download(trackID: "capped-\(index)", to: files) }
            }
            var tracks: [Track] = []
            for try await track in group { tracks.append(track) }
            return tracks
        }
        #expect(Set(tracks.map(\.id)) == Set((0..<6).map { "capped-\($0)" }))
        for track in tracks {
            #expect(track.fileExists && track.analyzed)
            let analysis = try #require(track.analysis)
            for (kind, hash) in [("audio", track.mediaHash!), ("dat", analysis.dat), ("ext", analysis.ext), ("twoEx", analysis.twoEx)] {
                let file = try #require(await files.existing(hash: hash))
                #expect(try Data(contentsOf: file) == Data("\(track.id) \(kind)".utf8))
                #expect(try AudioFiles.hash(file) == hash)
            }
        }
        let requests = try server.requests()
        #expect(requests.map(\.active).max() == 3, "Separate clients must share three download slots")
        #expect(!requests.contains { $0.rejected }, "Leave capacity for catalog refresh instead of flooding the server")
    }

    @Test(.timeLimit(.minutes(1))) func busyRetriesAreBoundedAndOtherFailuresKeepTheirErrors() async throws {
        let server = try await PairedTLSServer(); defer { server.stop() }
        let client = PairedLibraryClient(try server.pairing())
        let files = try AudioFiles(directory: server.directory.appendingPathComponent("audio"))
        for id in ["busy-detail", "busy-audio", "busy-ext"] {
            let track = try await client.download(trackID: id, to: files)
            #expect(track.fileExists && track.analyzed)
        }
        for (id, status) in [("always-busy", 503), ("busy-forever", 503), ("unauthorized", 401), ("server-error", 500)] {
            do { _ = try await client.download(trackID: id, to: files); Issue.record("Expected HTTP \(status), not a ready recording") }
            catch ClientError.http(let actual, let message) {
                #expect(actual == status)
                #expect(message == (id == "busy-forever" ? HTTPURLResponse.localizedString(forStatusCode: 503) : "Paired library request failed"))
            }
        }
        let requests = try server.requests()
        func count(_ suffix: String) -> Int { requests.filter { $0.path == "/pair/v1/tracks/" + suffix }.count }
        #expect(count("busy-detail") == 4) // Two busy responses, detail success, final revision check.
        #expect(count("busy-audio/audio") == 3)
        #expect(count("busy-ext/analysis/ext") == 3)
        #expect(count("always-busy") == 4)
        #expect(count("busy-forever/audio") == 4)
        #expect(count("unauthorized") == 1 && count("server-error") == 1)
    }

    @Test(.timeLimit(.minutes(1))) func cancellationReclaimsWaitingActiveAndRetryingSlotsWhileCatalogRemainsReachable() async throws {
        let server = try await PairedTLSServer(); defer { server.stop() }
        let pairing = try server.pairing()
        let files = try AudioFiles(directory: server.directory.appendingPathComponent("audio"))
        let active = (0..<3).map { index in
            Task { try await PairedLibraryClient(pairing).download(trackID: "blocked-\(index)", to: files) }
        }
        defer { for task in active { task.cancel() } }
        for _ in 0..<500 {
            if try server.requests().filter({ $0.path.contains("blocked-") }).count == 3 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(try server.requests().filter { $0.path.contains("blocked-") }.count == 3)
        let queued = Task { try await PairedLibraryClient(pairing).download(trackID: "must-not-start", to: files) }
        defer { queued.cancel() }
        // The fourth server slot must remain usable while downloads are held.
        #expect(try await PairedLibraryClient(pairing).catalog().libraryID == "mac")
        #expect(try server.requests().last?.active == 4)
        queued.cancel()
        let cancellation = ContinuousClock.now
        await #expect(throws: CancellationError.self) { try await queued.value }
        #expect(cancellation.duration(to: .now) < .seconds(1))
        #expect(try !server.requests().contains { $0.path.contains("must-not-start") })
        for task in active { task.cancel() }
        for task in active {
            do { _ = try await task.value; Issue.record("Canceled active download returned a recording") }
            catch { #expect(error is CancellationError || (error as? URLError)?.code == .cancelled) }
        }
        server.stopServing()

        let next = try await PairedTLSServer(); defer { next.stop() }
        let nextPairing = try next.pairing()
        let retrying = Task { try await PairedLibraryClient(nextPairing).download(trackID: "always-busy", to: files) }
        defer { retrying.cancel() }
        for _ in 0..<500 {
            if try !next.requests().isEmpty { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        retrying.cancel()
        await #expect(throws: CancellationError.self) { try await retrying.value }
        #expect(try next.requests().filter { $0.path.contains("always-busy") }.count == 1)
        // All three process-shared slots must be reusable, even on a new client/origin.
        try await verifiedConcurrentDownloads(next)
    }

    @Test func exactPinAndBearerProtectCatalogAndEncodedTrackRoutes() async throws {
        let server = try await PairedTLSServer(); defer { server.stop() }
        let client = PairedLibraryClient(try server.pairing())
        let catalog = try await client.catalog()
        #expect(catalog.libraryID == "mac")
        #expect(catalog.tracks[0].mediaHash == nil && !catalog.tracks[0].fileExists && !catalog.tracks[0].analyzed)
        let raw = "https://elsewhere.invalid/a?b#c"
        #expect(try await client.track(id: raw).id == raw)
        let before = try server.requests().count
        let wrong = PairedLibraryClient(try server.pairing(pin: String(repeating: "0", count: 64)))
        await #expect(throws: (any Error).self) { try await wrong.catalog() }
        #expect(try server.requests().count == before, "A pin mismatch must stop before sending bearer credentials")
        let otherLibrary = PairedLibraryClient(try server.pairing(libraryID: "other"))
        await #expect(throws: PairedLibraryError.self) { try await otherLibrary.catalog() }
        #expect(try server.requests().allSatisfy { $0.authorized && $0.path.hasPrefix("/pair/v1/") })
    }

    @Test func redirectsNeverForwardCredentialsEvenOnPairedOrigin() async throws {
        let server = try await PairedTLSServer(); defer { server.stop() }
        let client = PairedLibraryClient(try server.pairing())
        for id in ["redirect-same", "redirect-host", "redirect-http"] {
            do { _ = try await client.track(id: id); Issue.record("Followed a redirect") }
            catch ClientError.http(let status, _) { #expect(status == 302) }
        }
        let files = try AudioFiles(directory: server.directory.appendingPathComponent("audio"))
        do { _ = try await client.download(trackID: "audio-redirect", to: files); Issue.record("Followed an audio redirect") }
        catch ClientError.http(let status, _) { #expect(status == 302) }
        #expect(try server.requests().count == 5)
        #expect(try server.requests().allSatisfy { !$0.path.contains("sink") })
    }

    @Test func downloadVerifiesAllObjectsBoundToAudioAndRejectsChangedRevision() async throws {
        let server = try await PairedTLSServer(); defer { server.stop() }
        let client = PairedLibraryClient(try server.pairing())
        let files = try AudioFiles(directory: server.directory.appendingPathComponent("audio"))
        let detail = try await client.download(trackID: "ok", to: files)
        #expect(detail.fileExists && detail.analyzed)
        let analysis = try #require(detail.analysis)
        for (kind, hash) in [("audio", detail.mediaHash!), ("dat", analysis.dat), ("ext", analysis.ext), ("twoEx", analysis.twoEx)] {
            let file = try #require(await files.existing(hash: hash))
            #expect(try Data(contentsOf: file) == Data("paired fixture \(kind)".utf8))
        }
        let cachedAudio = try #require(await files.existing(hash: detail.mediaHash!))
        try Data("damaged cache".utf8).write(to: cachedAudio)
        _ = try await client.download(trackID: "ok", to: files)
        #expect(try Data(contentsOf: cachedAudio) == Data("paired fixture audio".utf8), "A verified download must not return a corrupt pre-existing cache file")
        #expect(try server.requests().filter { $0.path.contains("/analysis/") }.allSatisfy { $0.query["mediaHash"] == [detail.mediaHash!] })
        for id in ["bad-audio", "bad-ext"] {
            await #expect(throws: ClientError.self) { try await client.download(trackID: id, to: files) }
        }
        await #expect(throws: PairedLibraryError.self) { try await client.download(trackID: "unbound", to: files) }
        await #expect(throws: PairedLibraryError.self) { try await client.download(trackID: "revision-race", to: files) }
        let audioOnly = try await client.download(trackID: "audio-only", to: files)
        #expect(audioOnly.fileExists && !audioOnly.analyzed && audioOnly.analysis == nil)
        #expect(try server.requests().allSatisfy(\.authorized))
    }

    @Test @MainActor func downloadBuildsMissingWaveformFromVerifiedDATAndEXTAndRereadsOffline() async throws {
        let server = try await PairedTLSServer(); defer { server.stop() }
        // Same bounded PMAI/PQTZ/PWAV layouts as USBDeviceTests. DAT preview
        // differs from EXT RGB, so choosing the wrong source cannot pass.
        func put(_ data: inout Data, _ offset: Int, _ value: Int) {
            for i in 0..<4 { data[offset + i] = UInt8(truncatingIfNeeded: value >> (24 - i * 8)) }
        }
        func anlz(_ tags: [Data]) -> Data {
            var data = Data(repeating: 0, count: 28)
            data.replaceSubrange(0..<4, with: "PMAI".utf8)
            put(&data, 4, 28); put(&data, 8, 28 + tags.reduce(0) { $0 + $1.count })
            for tag in tags { data.append(tag) }
            return data
        }
        var beats = Data(repeating: 0, count: 48)
        beats.replaceSubrange(0..<4, with: "PQTZ".utf8)
        put(&beats, 4, 24); put(&beats, 8, 48); put(&beats, 20, 3)
        for (index, time) in [125, 650, 1225].enumerated() {
            beats[25 + index * 8] = UInt8(index + 1); put(&beats, 28 + index * 8, time)
        }
        var preview = Data(repeating: 0, count: 23)
        preview.replaceSubrange(0..<4, with: "PWAV".utf8)
        put(&preview, 4, 20); put(&preview, 8, 23); put(&preview, 12, 3)
        preview.replaceSubrange(20..<23, with: [31, 15, 2])
        var rgb = Data(repeating: 0, count: 30)
        rgb.replaceSubrange(0..<4, with: "PWV5".utf8)
        put(&rgb, 4, 24); put(&rgb, 8, 30); put(&rgb, 16, 3)
        for (index, value) in [57484, 7292, 9132].enumerated() {
            rgb[24 + index * 2] = UInt8(value >> 8); rgb[25 + index * 2] = UInt8(value & 255)
        }
        try anlz([beats, preview]).write(to: server.directory.appendingPathComponent("waveform.dat"))
        try anlz([rgb]).write(to: server.directory.appendingPathComponent("waveform.ext"))
        let client = PairedLibraryClient(try server.pairing())
        let files = try AudioFiles(directory: server.directory.appendingPathComponent("audio"))
        #expect(try await client.track(id: "local-analysis").waveform == nil)
        let downloaded = try await client.download(trackID: "local-analysis", to: files)
        let waveform = try #require(downloaded.waveform)
        #expect(downloaded.fileExists && downloaded.analyzed)
        #expect(waveform.peaks == [3.0 / 31, 1, 11.0 / 31])
        #expect(waveform.colors.map(Array.init) == [[255, 0, 36], [0, 255, 0], [36, 0, 255]])
        #expect(waveform.beatGrid?.times == [0.125, 0.65, 1.225])
        #expect(waveform.beatGrid?.beats == [1, 2, 3])
        #expect(waveform.durationSeconds == 3.5)
        let malformed = try await client.download(trackID: "no-waveform", to: files)
        #expect(malformed.fileExists && malformed.analyzed && malformed.waveform == nil,
                "Optional display parsing must not reject verified playable media")
        server.stopServing()
        let directory = server.directory.appendingPathComponent("library")
        var store: LibraryStore? = try LibraryStore(directory: directory)
        try store!.savePairedLibrary(PairedLibrarySnapshot(libraryID: "mac", name: "Mac",
                                                          tracks: [downloaded], playlists: []))
        store = nil
        let restored = try #require(try LibraryStore(directory: directory).pairedLibrary()?.tracks.first)
        #expect(restored.waveform == nil)
        #expect(restored.fileExists && restored.analyzed && restored.mediaHash == downloaded.mediaHash)
        let analysis = try #require(restored.analysis)
        #expect(try await USBAnalysis.read(analysis, files: files, duration: 3.5) == waveform)
        let ext = try #require(await files.existing(hash: analysis.ext))
        let oversized = try FileHandle(forWritingTo: ext)
        try oversized.truncate(atOffset: 32 * 1_024 * 1_024 + 1); try oversized.close()
        await #expect(throws: USBLibraryError.tooLarge) { try await USBAnalysis.read(analysis, files: files, duration: 3.5) }
    }
}

private final class PairedTLSServer {
    let directory: URL
    private let process: Process
    private let exited = DispatchSemaphore(value: 0)
    private let port: Int
    private let pin: String
    struct Request: Decodable {
        let path: String
        let query: [String: [String]]
        let authorized: Bool
        let active: Int
        let rejected: Bool
    }
    init() async throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = [Bundle.module.url(forResource: "paired-library-server", withExtension: "py", subdirectory: "Fixtures")!.path, directory.path]
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        let exited = self.exited
        process.terminationHandler = { _ in exited.signal() }
        try process.run()
        let ready = directory.appendingPathComponent("ready.json")
        do {
            for _ in 0..<200 where !FileManager.default.fileExists(atPath: ready.path) {
                guard process.isRunning else { throw CocoaError(.executableLoad) }
                try await Task.sleep(for: .milliseconds(50))
            }
            struct Ready: Decodable { let port: Int; let certificateSHA256: String }
            let value = try JSONDecoder().decode(Ready.self, from: Data(contentsOf: ready))
            port = value.port; pin = value.certificateSHA256
        } catch {
            if process.isRunning {
                process.terminate()
                for _ in 0..<100 where process.isRunning { try? await Task.sleep(for: .milliseconds(50)) }
            }
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }
    func pairing(pin: String? = nil, libraryID: String = "mac") throws -> PairedLibrary {
        try PairedLibrary(url: URL(string: "https://127.0.0.1:\(port)")!, certificateSHA256: pin ?? self.pin,
                          token: String(repeating: "b", count: 64), libraryID: libraryID, name: "Studio Mac")
    }
    func requests() throws -> [Request] {
        let path = directory.appendingPathComponent("requests.jsonl")
        guard FileManager.default.fileExists(atPath: path.path) else { return [] }
        return try String(contentsOf: path, encoding: .utf8).split(separator: "\n").map { try JSONDecoder().decode(Request.self, from: Data($0.utf8)) }
    }
    func stopServing() {
        // Process.waitUntilExit can strand a Swift task on a departed thread's
        // run loop. The termination callback does not depend on that run loop.
        if process.isRunning {
            process.terminate()
            #expect(exited.wait(timeout: .now() + 5) == .success)
        }
    }
    func stop() {
        stopServing()
        try? FileManager.default.removeItem(at: directory)
    }
}
#endif
