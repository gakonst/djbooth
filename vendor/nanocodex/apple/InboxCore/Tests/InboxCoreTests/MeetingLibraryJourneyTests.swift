import Foundation
import XCTest
import InboxCore

/// Runs shipped ManagedClient/MeetingLibrary over real HTTP against the local
/// production account proxy, meeting router and persisted D1. Only authentication
/// and the optional inference provider are synthetic; no URLProtocol mock.
final class MeetingLibraryJourneyTests: XCTestCase {
    @MainActor
    func testInvalidDocumentDoesNotStarveFollowingValidUpload() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let origin = env["NANOCODEX_MEETINGS_FIXTURE_URL"], let directory = env["NANOCODEX_MEETINGS_JOURNEY_DIRECTORY"],
              let url = URL(string: origin), url.scheme == "http", ["127.0.0.1", "localhost"].contains(url.host ?? "") else {
            throw XCTSkip("Run against local meeting-library-fixture.mjs with journey directory")
        }
        let credential = try JSONDecoder().decode(AccountCredential.self, from: JSONSerialization.data(withJSONObject: ["origin": origin, "apiKey": fixtureKey]))
        let client = ManagedClient(credential: credential, configuration: .ephemeral)
        defer { client.close() }
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let store = try MeetingRecordingStore(path: URL(fileURLWithPath: directory).appendingPathComponent("invalid-" + UUID().uuidString + ".sqlite").path)
        let scope = "synthetic-invalid-queue"
        // Sort the malformed record FIRST in the actual journal retry order.
        var invalid = MeetingRecord(title: String(repeating: "Oversized title ", count: 100), startedAt: Date().addingTimeInterval(1), notes: "Keep this local draft editable.")
        // Also exercise definitive 413 at the actual HTTP body-size boundary.
        var oversized = MeetingRecord(title: "Oversized transcript", startedAt: Date().addingTimeInterval(2), transcript: String(repeating: "x", count: 1024 * 1024 + 1), notes: "Keep the oversized source locally.")
        let valid = MeetingRecord(title: "Valid upload after invalid draft", notes: "Must not be starved by validation failure.")
        try store.put(oversized, scope: scope, state: .pending)
        try store.put(invalid, scope: scope, state: .pending)
        try store.put(valid, scope: scope, state: .pending)
        let library = MeetingLibrary(store: store)
        library.activate(scope: scope, client: client)
        await library.retry()
        XCTAssertNotNil(library.error)
        XCTAssertTrue(library.error?.contains("Other meetings will continue syncing") == true)
        let preserved = try XCTUnwrap(library.entries.first { $0.id == invalid.id })
        XCTAssertEqual(preserved.state, .pending)
        XCTAssertEqual(preserved.record.notes, invalid.notes)
        XCTAssertNil(preserved.attempted)
        let preservedOversized = try XCTUnwrap(library.entries.first { $0.id == oversized.id })
        XCTAssertEqual(preservedOversized.state, .pending)
        XCTAssertEqual(preservedOversized.record.transcript, oversized.transcript)
        XCTAssertNil(preservedOversized.attempted)
        XCTAssertEqual(library.entries.first { $0.id == valid.id }?.state, .synced)
        let accepted = try await client.meeting(id: valid.id)
        XCTAssertEqual(accepted.notes, valid.notes)
        do { _ = try await client.meeting(id: invalid.id); XCTFail("Invalid payload was admitted") }
        catch APIError.http(404) { }
        do { _ = try await client.meeting(id: oversized.id); XCTFail("Oversized payload was admitted") }
        catch APIError.http(404) { }
        oversized.transcript = "Corrected transcript below the HTTP size boundary."
        try await library.save(oversized)
        let correctedOversized = try await client.meeting(id: oversized.id)
        XCTAssertEqual(correctedOversized.transcript, oversized.transcript)
        invalid.title = "Corrected editable draft"
        try await library.save(invalid)
        let corrected = try await client.meeting(id: invalid.id)
        XCTAssertEqual(corrected.title, invalid.title)
        XCTAssertEqual(corrected.notes, invalid.notes)
        XCTAssertNil(library.error)
        try await library.delete(id: invalid.id)
        try await library.delete(id: oversized.id)
        try await library.delete(id: valid.id)
        print("JOURNEY invalid title (400) and >1MiB body (413) rejected, local drafts preserved editable, following valid UUID synced in SAME retry; corrected drafts then admitted")
    }

    @MainActor
    func testStaleEditorAfterCloudRefreshPreservesBothCopies() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let origin = env["NANOCODEX_MEETINGS_FIXTURE_URL"], let directory = env["NANOCODEX_MEETINGS_JOURNEY_DIRECTORY"],
              let url = URL(string: origin), url.scheme == "http", ["127.0.0.1", "localhost"].contains(url.host ?? "") else {
            throw XCTSkip("Run against local meeting-library-fixture.mjs with journey directory")
        }
        let credential = try JSONDecoder().decode(AccountCredential.self, from: JSONSerialization.data(withJSONObject: ["origin": origin, "apiKey": fixtureKey]))
        let client = ManagedClient(credential: credential, configuration: .ephemeral)
        defer { client.close() }
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let path = URL(fileURLWithPath: directory).appendingPathComponent("stale-editor-" + UUID().uuidString + ".sqlite").path
        let store = try MeetingRecordingStore(path: path)
        let library = MeetingLibrary(store: store)
        let scope = "synthetic-stale-editor"
        library.activate(scope: scope, client: client)
        try await library.save(MeetingRecord(title: "Editable meeting", transcript: "Original transcript", notes: "Original notes"))
        let id = try XCTUnwrap(library.entries.first?.id)
        var editor = try await library.detail(id: id)
        var otherDevice = editor
        otherDevice.transcript = "Cloud transcript updated on another installation"
        otherDevice.notes = "Cloud notes updated on another installation"
        otherDevice.revision += 1
        let remote = try await client.saveMeeting(otherDevice, ifMatch: editor.revision)
        // The editor is still dirty at its loaded revision while polling refreshes
        // the journal. Neither a list merge nor a detail fetch may silently rebase it.
        await library.refresh()
        let cache = try await library.detail(id: id)
        XCTAssertEqual(cache.revision, remote.revision)
        editor.notes = "Unsaved local editor notes based on the original transcript"
        try await library.save(editor)
        XCTAssertNotNil(library.error)
        let reopened = try MeetingRecordingStore(path: path)
        let conflict = try XCTUnwrap(reopened.entries(scope: scope).first { $0.id == id })
        XCTAssertEqual(conflict.state, .conflicted)
        XCTAssertEqual(conflict.record.notes, editor.notes)
        XCTAssertEqual(conflict.record.transcript, editor.transcript)
        XCTAssertEqual(conflict.remote?.notes, remote.notes)
        XCTAssertEqual(conflict.remote?.transcript, remote.transcript)
        let untouched = try await client.meeting(id: id)
        XCTAssertEqual(untouched.revision, remote.revision)
        XCTAssertEqual(untouched.notes, remote.notes)
        XCTAssertEqual(untouched.transcript, remote.transcript)
        _ = try await library.reloadServer(id: id)
        XCTAssertEqual(library.entries.first { $0.id == id }?.record.transcript, remote.transcript)
        try await library.delete(id: id)
        print("JOURNEY stale editor after cloud list+detail refresh preserved both local and remote copies as SQLite conflict; explicit Reload Server selected cloud copy")
    }

    @MainActor
    func testConcurrentNewDocumentsDrainWithoutRefresh() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let origin = env["NANOCODEX_MEETINGS_FIXTURE_URL"], let directory = env["NANOCODEX_MEETINGS_JOURNEY_DIRECTORY"],
              let url = URL(string: origin), url.scheme == "http", ["127.0.0.1", "localhost"].contains(url.host ?? "") else {
            throw XCTSkip("Run against local meeting-library-fixture.mjs with journey directory")
        }
        let credential = try JSONDecoder().decode(AccountCredential.self, from: JSONSerialization.data(withJSONObject: ["origin": origin, "apiKey": fixtureKey]))
        let client = ManagedClient(credential: credential, configuration: .ephemeral)
        defer { client.close() }
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let store = try MeetingRecordingStore(path: URL(fileURLWithPath: directory).appendingPathComponent("concurrent-" + UUID().uuidString + ".sqlite").path)
        let library = MeetingLibrary(store: store)
        library.activate(scope: "synthetic-owner", client: client)
        let one = MeetingRecord(title: "Concurrent draft 1", notes: "Saved during another HTTP admission")
        let two = MeetingRecord(title: "Concurrent draft 2", notes: "Must sync without opening or refreshing library")
        let three = MeetingRecord(title: "Concurrent draft 3", notes: "Independent UUID, same outbox")
        async let saveOne: Void = library.save(one)
        async let saveTwo: Void = library.save(two)
        async let saveThree: Void = library.save(three)
        _ = try await (saveOne, saveTwo, saveThree)
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while library.entries.contains(where: { $0.state == .pending }), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(25))
        }
        XCTAssertEqual(library.entries.count, 3)
        XCTAssertTrue(library.entries.allSatisfy { $0.state == .synced })
        for document in [one, two, three] {
            let remote = try await client.meeting(id: document.id)
            XCTAssertEqual(remote.notes, document.notes)
            try await library.delete(id: document.id)
        }
        print("JOURNEY concurrent 3 UUID saves drained after active flush, without refresh or a second manual retry")
    }

    @MainActor
    func testDurableCaptureReopenAndCloudLibraryJourney() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let origin = env["NANOCODEX_MEETINGS_FIXTURE_URL"],
              let directory = env["NANOCODEX_MEETINGS_JOURNEY_DIRECTORY"] else {
            throw XCTSkip("Start meeting-library-fixture.mjs, set NANOCODEX_MEETINGS_FIXTURE_URL and NANOCODEX_MEETINGS_JOURNEY_DIRECTORY")
        }
        guard let url = URL(string: origin), url.scheme == "http", ["127.0.0.1", "localhost"].contains(url.host ?? "") else {
            throw XCTSkip("Synthetic authentication is restricted to local HTTP")
        }
        // Deserialize a fixture-only persisted credential for HTTP loopback. The
        // production entry form remains HTTPS-only and no secret is used here.
        let credential = try JSONDecoder().decode(AccountCredential.self, from: JSONSerialization.data(withJSONObject: ["origin": origin, "apiKey": fixtureKey]))
        let client = ManagedClient(credential: credential, configuration: .ephemeral)
        defer { client.close() }
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let path = URL(fileURLWithPath: directory).appendingPathComponent(UUID().uuidString + ".sqlite").path
        let scope = "synthetic-owner"
        var store = try MeetingRecordingStore(path: path)
        var record = MeetingRecord(title: "Planning Ελληνικά", durationSeconds: 72, transcript: "Ada: launch on Friday. Bea: prepare checklist.", notes: "Owner: Ada", revision: 23)
        try store.put(record, scope: scope, state: .capturing)
        store = try MeetingRecordingStore(path: path)
        try store.recover(scope: scope)
        record = try XCTUnwrap(store.entries(scope: scope).first?.record)
        XCTAssertTrue(record.partial)
        XCTAssertEqual(record.revision, 24)
        XCTAssertTrue(try store.entries(scope: "other-account").isEmpty)
        let otherCredential = try JSONDecoder().decode(AccountCredential.self, from: JSONSerialization.data(withJSONObject: ["origin": origin, "apiKey": "ncx_live_other1234567_" + String(repeating: "y", count: 43)]))
        let otherClient = ManagedClient(credential: otherCredential, configuration: .ephemeral)
        defer { otherClient.close() }
        print("JOURNEY recovered SQLite partial id=\(record.id) revision=\(record.revision) notes=\(record.notes)")

        // Simulate eviction after HTTP admission but before its acknowledgement
        // was journaled. Subsequent local edits must not mutate this request.
        let attempted = try XCTUnwrap(store.prepareUpload(id: record.id, scope: scope))
        let admitted = try await client.saveMeeting(attempted, ifMatch: try store.uploadPrecondition(id: record.id, scope: scope, revision: attempted.revision))
        XCTAssertEqual(admitted.revision, 24)
        do { _ = try await otherClient.meeting(id: record.id); XCTFail("Other account read owner's meeting") }
        catch APIError.http(404) { }
        print("JOURNEY actual transport denies cross-account detail with 404")
        record.notes = "Owner: Bea; follow up Monday"
        record.title = "Edited after uncertain save"
        try store.put(record, scope: scope, state: .pending)
        store = try MeetingRecordingStore(path: path)
        let retryPayload = try XCTUnwrap(store.prepareUpload(id: record.id, scope: scope))
        XCTAssertEqual(retryPayload, attempted)
        var library = MeetingLibrary(store: store)
        library.activate(scope: scope, client: client)
        await library.retry()
        XCTAssertNil(library.error)
        var remote = try await client.meeting(id: record.id)
        XCTAssertEqual(remote.notes, record.notes)
        XCTAssertEqual(remote.title, record.title)
        XCTAssertGreaterThan(remote.revision, admitted.revision)
        XCTAssertEqual(library.entries.first?.state, .synced)
        print("JOURNEY immutable revision \(admitted.revision) retried then coalesced at \(remote.revision): \(remote.notes)")

        // Offline notes-only document survives reopen, then syncs at reconnect.
        let notesOnly = MeetingRecord(title: "Typed notes", notes: "No microphone permission required.")
        library.activate(scope: scope, client: nil)
        try await library.save(notesOnly)
        store = try MeetingRecordingStore(path: path)
        library = MeetingLibrary(store: store)
        library.activate(scope: scope, client: client)
        XCTAssertTrue(library.entries.contains { $0.id == notesOnly.id && $0.state == .pending })
        await library.retry()
        let notesRemote = try await client.meeting(id: notesOnly.id)
        XCTAssertEqual(notesRemote.transcript, "")
        XCTAssertEqual(notesRemote.notes, notesOnly.notes)
        print("JOURNEY offline notes-only restored and synced \(notesOnly.id)")

        // A second native installation lists metadata, loads full transcript and
        // generates a revision-fenced recap using the production summary route.
        let secondStore = try MeetingRecordingStore(path: path + ".second")
        let second = MeetingLibrary(store: secondStore)
        second.activate(scope: scope, client: client)
        await second.refresh()
        XCTAssertTrue(second.entries.contains { $0.id == record.id })
        let opened = try await second.detail(id: record.id)
        XCTAssertEqual(opened.transcript, record.transcript)
        try await second.summarize(id: record.id)
        let summarized = try await client.meeting(id: record.id)
        XCTAssertEqual(summarized.summaryStatus, .ready)
        XCTAssertTrue(summarized.summary.contains("Friday"))
        print("JOURNEY second installation opened transcript and recap: \(summarized.summary)")
        // Default Stop/Save/discard checkpoints of the same semantic document
        // must not bump revisions or wipe an already generated summary.
        try secondStore.put(summarized, scope: scope, state: .pending)
        // The process-owned recorder still has the original subsecond start
        // Date and older local revision after cloud acknowledgement. Stop,
        // Save, and dismissal of that SAME capture must preserve the recap.
        try secondStore.put(record, scope: scope, state: .pending)
        let noOp = try XCTUnwrap(secondStore.entries(scope: scope).first { $0.id == record.id })
        XCTAssertEqual(noOp.state, .synced)
        XCTAssertEqual(noOp.record.revision, summarized.revision)
        XCTAssertEqual(noOp.record.summary, summarized.summary)
        try await second.summarize(id: record.id)
        let refreshedSummary = try await client.meeting(id: record.id)
        XCTAssertEqual(refreshedSummary.revision, summarized.revision)
        XCTAssertEqual(refreshedSummary.summary, summarized.summary)

        // A concurrent device's higher revision becomes an actionable conflict,
        // preserving BOTH copies until the user explicitly chooses a resolution.
        remote.notes = "Second device authoritative edit"
        remote.revision += 20
        _ = try await client.saveMeeting(remote)
        record.notes = "Newest local coalesced notes"
        // Arbitrarily many offline checkpoints must not bypass CAS by giving
        // this local document a numerically higher revision than the cloud.
        record.revision = remote.revision + 100
        try await library.save(record)
        XCTAssertNotNil(library.error)
        store = try MeetingRecordingStore(path: path)
        let conflict = try XCTUnwrap(store.entries(scope: scope).first { $0.id == record.id })
        XCTAssertEqual(conflict.state, .conflicted)
        XCTAssertEqual(conflict.record.notes, record.notes)
        XCTAssertEqual(conflict.remote?.notes, remote.notes)
        let untouched = try await client.meeting(id: record.id)
        XCTAssertEqual(untouched.notes, remote.notes)
        await library.retry()
        let stillUntouched = try await client.meeting(id: record.id)
        XCTAssertEqual(stillUntouched.notes, remote.notes)
        try await library.chooseKeepLocal(id: record.id)
        let rebased = try await client.meeting(id: record.id)
        XCTAssertGreaterThan(rebased.revision, remote.revision)
        XCTAssertEqual(rebased.notes, record.notes)
        XCTAssertEqual(rebased.summaryStatus, .none)
        print("JOURNEY concurrent edit preserved as durable conflict; explicit Keep Local \(remote.revision) -> \(rebased.revision)")

        // Full transcript and notes beyond the old 32KiB boundary must all reach
        // rolling inference, not silently truncate the source in a native client.
        let marker = UUID().uuidString
        let longTranscript = "TranscriptStart-" + marker + "\n" + String(repeating: "Ada: launch on Friday; Bea: prepare checklist.\n", count: 1500) + "TranscriptEnd-" + marker
        let longNotes = String(repeating: "Σημείωση: όλοι οι ιδιοκτήτες.\n", count: 300) + "NotesEnd-" + marker
        let large = MeetingRecord(title: "Full source rolling recap", transcript: longTranscript, notes: longNotes)
        let controlURL = URL(string: origin + "/__fixture/provider")!
        let beforeData = try await URLSession.shared.data(from: controlURL).0
        let beforeJSON = try JSONDecoder().decode(JSON.self, from: beforeData)
        let beforeCount = Int(beforeJSON["calls"].number)
        try await library.save(large)
        try await library.summarize(id: large.id)
        let largeRemote = try await client.meeting(id: large.id)
        XCTAssertEqual(largeRemote.transcript, longTranscript)
        XCTAssertEqual(largeRemote.notes, longNotes)
        XCTAssertEqual(largeRemote.summaryStatus, .ready)
        let providerData = try await URLSession.shared.data(from: controlURL).0
        let providerJSON = try JSONDecoder().decode(JSON.self, from: providerData)
        guard case .array(let requests) = providerJSON["requests"] else { return XCTFail("Missing real inference trace") }
        let source = requests.dropFirst(beforeCount).compactMap { request -> String? in
            guard case .array(let messages) = request["input"]["messages"], let user = messages.last,
                  let boundary = user["content"].string.range(of: "Next source chunk:\n") else { return nil }
            return String(user["content"].string[boundary.upperBound...])
        }.joined()
        XCTAssertTrue(source.contains(longTranscript), "Some transcript source chunks were omitted")
        XCTAssertTrue(source.contains(longNotes), "Some user notes were omitted")
        XCTAssertGreaterThan(requests.count - beforeCount, 1)
        try providerData.write(to: URL(fileURLWithPath: directory).appendingPathComponent("full-source-inference-trace.json"))
        print("JOURNEY full-source \(longTranscript.utf8.count + longNotes.utf8.count) bytes processed in \(requests.count - beforeCount) inference calls; tail transcript+notes verified")
        try await library.delete(id: large.id)

        // Remote deletion disappears on refresh, even from a full SQLite cache.
        try await client.deleteMeeting(id: notesOnly.id)
        await library.refresh()
        XCTAssertFalse(library.entries.contains { $0.id == notesOnly.id })
        XCTAssertEqual(try store.entries(scope: scope, includeDeleted: true).first { $0.id == notesOnly.id }?.state, .deleted)
        // Local delete acknowledges once; subsequent refresh/retry cannot ghost
        // or repeatedly issue an unacknowledged delete after SQLite reopen.
        try await library.delete(id: record.id)
        store = try MeetingRecordingStore(path: path)
        library = MeetingLibrary(store: store)
        library.activate(scope: scope, client: client)
        await library.refresh(); await library.retry()
        XCTAssertFalse(library.entries.contains { $0.id == record.id })
        XCTAssertEqual(try store.entries(scope: scope, includeDeleted: true).first { $0.id == record.id }?.state, .deleted)
        do { _ = try await client.saveMeeting(rebased); XCTFail("Deleted UUID resurrected") }
        catch APIError.http(410) { }
        // A stale installation's pending PUT receives 410 and becomes a settled
        // tombstone, not a forever-retrying upload.
        var staleEdit = opened; staleEdit.notes += " A stale installation edit."
        try await second.save(staleEdit)
        XCTAssertFalse(second.entries.contains { $0.id == record.id })
        print("JOURNEY remote/local deletes hidden, SQLite acknowledged tombstones retained, stale PUT 410 settled; database \(path)")
    }
}
