import Foundation
import XCTest
@testable import InboxCore

final class MacMeetingSaveJournalTests: XCTestCase {
    private func location() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("mac-meeting-journal-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return directory.appendingPathComponent("journal.json")
    }
    @MainActor
    func testLostResponseRestartReplaysExactPayloadAndCASBeforeLaterDraft() throws {
        let url = try location()
        let base = MeetingRecord(title: "Original", transcript: "Entire source", notes: "Cloud", revision: 19)
        var journal = try MacMeetingSaveJournal(url: url)
        let submitted = try journal.prepare(record: base, notes: "Submitted", scope: "owner")
        XCTAssertEqual(submitted.ifMatch, 19)
        XCTAssertEqual(submitted.record.revision, 20)
        try journal.saveDraft(record: base, notes: "Later typing", scope: "owner")
        journal = try MacMeetingSaveJournal(url: url)
        let entry = try XCTUnwrap(journal.entries(scope: "owner").first)
        XCTAssertEqual(entry.record, base)
        XCTAssertEqual(entry.notes, "Later typing")
        XCTAssertEqual(try journal.prepare(record: base, notes: entry.notes, scope: "owner"), submitted)
        XCTAssertEqual(entry.submitted?.record.uploadBody, submitted.record.uploadBody)
        var admitted = submitted.record; admitted.updatedAt = Date().addingTimeInterval(10)
        try journal.acknowledge(submitted, remote: admitted, scope: "owner")
        journal = try MacMeetingSaveJournal(url: url)
        let later = try XCTUnwrap(journal.entries(scope: "owner").first)
        XCTAssertNil(later.submitted)
        XCTAssertEqual(later.record, admitted)
        XCTAssertEqual(later.notes, "Later typing")
        let second = try journal.prepare(record: later.record, notes: later.notes, scope: "owner")
        XCTAssertEqual(second.ifMatch, 20)
        XCTAssertEqual(second.record.revision, 21)
        XCTAssertEqual(second.record.notes, "Later typing")
        XCTAssertEqual(second.record.transcript, base.transcript)
    }
    @MainActor
    func testTypingDuringRequestSurvivesAcknowledgementIncludingReversionToBaseline() throws {
        let url = try location(), base = MeetingRecord(notes: "Original")
        let journal = try MacMeetingSaveJournal(url: url)
        let submitted = try journal.prepare(record: base, notes: "Sent", scope: "a")
        try journal.saveDraft(record: base, notes: "Original", scope: "a")
        try journal.acknowledge(submitted, remote: submitted.record, scope: "a")
        let reopened = try MacMeetingSaveJournal(url: url)
        XCTAssertEqual(reopened.entries(scope: "a").first?.notes, "Original")
        XCTAssertEqual(reopened.entries(scope: "a").first?.record.notes, "Sent")
    }
    @MainActor
    func testSuccessfulAcknowledgementWithoutLaterEditRemovesJournalEntry() throws {
        let url = try location(), base = MeetingRecord()
        let journal = try MacMeetingSaveJournal(url: url)
        let submitted = try journal.prepare(record: base, notes: "Sent", scope: "a")
        try journal.acknowledge(submitted, remote: submitted.record, scope: "a")
        XCTAssertTrue(try MacMeetingSaveJournal(url: url).entries(scope: "a").isEmpty)
    }
    @MainActor
    func testAccountSwitchSameUUIDNeverSharesDraftOrSubmission() throws {
        let url = try location(), base = MeetingRecord(notes: "Cloud")
        var journal = try MacMeetingSaveJournal(url: url)
        let a = try journal.prepare(record: base, notes: "Private A", scope: "a")
        let b = try journal.prepare(record: base, notes: "Private B", scope: "b")
        journal = try MacMeetingSaveJournal(url: url)
        XCTAssertTrue(journal.entries(scope: "c").isEmpty)
        XCTAssertEqual(journal.entries(scope: "a").first?.submitted, a)
        XCTAssertEqual(journal.entries(scope: "b").first?.submitted, b)
        XCTAssertThrowsError(try journal.acknowledge(a, remote: a.record, scope: "b"))
        try journal.remove(id: base.id, scope: "a")
        XCTAssertTrue(journal.entries(scope: "a").isEmpty)
        XCTAssertEqual(try MacMeetingSaveJournal(url: url).entries(scope: "b").first?.submitted, b)
    }
    @MainActor
    func testDefinitiveRejectionPreservesDraftButCorrectedPayloadCanReplaceAttempt() throws {
        let url = try location(), base = MeetingRecord(notes: "Base", revision: 6)
        var journal = try MacMeetingSaveJournal(url: url)
        let invalid = try journal.prepare(record: base, notes: "Rejected", scope: "a")
        try journal.saveDraft(record: base, notes: "Correction typed during request", scope: "a")
        try journal.reject(invalid, scope: "a")
        journal = try MacMeetingSaveJournal(url: url)
        let draft = try XCTUnwrap(journal.entries(scope: "a").first)
        XCTAssertNil(draft.submitted)
        XCTAssertEqual(draft.notes, "Correction typed during request")
        XCTAssertEqual(draft.record, base)
        let corrected = try journal.prepare(record: draft.record, notes: draft.notes, scope: "a")
        XCTAssertEqual(corrected.ifMatch, invalid.ifMatch)
        XCTAssertEqual(corrected.record.revision, invalid.record.revision)
        XCTAssertNotEqual(corrected.record.notes, invalid.record.notes)
        XCTAssertEqual(try MacMeetingSaveJournal(url: url).entries(scope: "a").first?.submitted, corrected)
    }
    @MainActor
    func testTranscriptReplacementRejectionRestartCorrectionAndAcknowledgement() throws {
        let url = try location(), base = MeetingRecord(transcript: "Saved source", notes: "Unchanged", revision: 6)
        var journal = try MacMeetingSaveJournal(url: url)
        let rejected = try journal.prepare(record: base, notes: base.notes, transcript: "Recovered source", scope: "a")
        try journal.reject(rejected, scope: "a")
        try journal.saveDraft(record: base, notes: base.notes, transcript: "Recovered source", scope: "a")
        journal = try MacMeetingSaveJournal(url: url)
        let draft = try XCTUnwrap(journal.entries(scope: "a").first)
        XCTAssertEqual(draft.record, base)
        XCTAssertEqual(draft.transcript, "Recovered source")
        XCTAssertNil(draft.submitted)
        let corrected = try journal.prepare(record: draft.record, notes: draft.notes, transcript: "Shortened recovery", scope: "a")
        XCTAssertEqual(corrected.ifMatch, base.revision)
        XCTAssertEqual(corrected.record.transcript, "Shortened recovery")
        journal = try MacMeetingSaveJournal(url: url)
        XCTAssertEqual(try journal.prepare(record: base, notes: base.notes, transcript: "Later recovery", scope: "a"), corrected)
        try journal.acknowledge(corrected, remote: corrected.record, scope: "a")
        journal = try MacMeetingSaveJournal(url: url)
        let later = try XCTUnwrap(journal.entries(scope: "a").first)
        XCTAssertEqual(later.transcript, "Later recovery")
        XCTAssertEqual(later.record, corrected.record)
        let final = try journal.prepare(record: later.record, notes: later.notes, transcript: later.transcript, scope: "a")
        try journal.acknowledge(final, remote: final.record, scope: "a")
        XCTAssertTrue(try MacMeetingSaveJournal(url: url).entries(scope: "a").isEmpty)
    }
    @MainActor
    func testTranscriptReversionDuringUncertainSaveAndLegacyJournalDecode() throws {
        let url = try location(), base = MeetingRecord(transcript: "Original", notes: "Notes")
        let journal = try MacMeetingSaveJournal(url: url)
        let submitted = try journal.prepare(record: base, notes: base.notes, transcript: "Sent replacement", scope: "a")
        try journal.saveDraft(record: base, notes: base.notes, transcript: nil, scope: "a")
        try journal.acknowledge(submitted, remote: submitted.record, scope: "a")
        XCTAssertEqual(try MacMeetingSaveJournal(url: url).entries(scope: "a").first?.transcript, "Original")
        // Older journals have no transcript key and must still replay their
        // exact uncertain notes submission after upgrading.
        try journal.remove(id: base.id, scope: "a")
        let notes = try journal.prepare(record: base, notes: "Legacy notes", scope: "a")
        var document = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        var entries = try XCTUnwrap(document["entries"] as? [[String: Any]])
        entries[0].removeValue(forKey: "transcript"); document["entries"] = entries
        try JSONSerialization.data(withJSONObject: document).write(to: url, options: .atomic)
        let restored = try MacMeetingSaveJournal(url: url)
        XCTAssertNil(restored.entries(scope: "a").first?.transcript)
        XCTAssertEqual(restored.entries(scope: "a").first?.submitted, notes)
    }
    @MainActor
    func testBoundsFailClosedWithoutEvictingUncertainPayloadAcrossAccounts() throws {
        let url = try location(), base = MeetingRecord()
        var journal = try MacMeetingSaveJournal(url: url, maxEntries: 1)
        let first = try journal.prepare(record: base, notes: "Uncertain", scope: "a")
        XCTAssertThrowsError(try journal.prepare(record: MeetingRecord(), notes: "Other", scope: "b"))
        journal = try MacMeetingSaveJournal(url: url, maxEntries: 1)
        XCTAssertEqual(journal.entries(scope: "a").first?.submitted, first)
        XCTAssertTrue(journal.entries(scope: "b").isEmpty)
    }
    @MainActor
    func testByteLimitAndWriteFailureDoNotAdvanceInMemoryOrOnDiskSubmission() throws {
        let url = try location(), base = MeetingRecord()
        let journal = try MacMeetingSaveJournal(url: url, maxBytes: 2000)
        let first = try journal.prepare(record: base, notes: "Sent", scope: "a")
        XCTAssertThrowsError(try journal.saveDraft(record: base, notes: String(repeating: "x", count: 3000), scope: "a"))
        XCTAssertEqual(journal.entries(scope: "a").first?.notes, "Sent")
        XCTAssertEqual(try MacMeetingSaveJournal(url: url).entries(scope: "a").first?.submitted, first)
        // Replace the destination with a directory: atomic write must fail,
        // retaining the original attempt in memory for an exact retry.
        try FileManager.default.removeItem(at: url)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        XCTAssertThrowsError(try journal.acknowledge(first, remote: first.record, scope: "a"))
        XCTAssertEqual(journal.entries(scope: "a").first?.submitted, first)
    }
    @MainActor
    func testCorruptJournalIsNotSilentlyReplacedAndEmptyScopeCannotSubmit() throws {
        let url = try location()
        let journal = try MacMeetingSaveJournal(url: url)
        XCTAssertThrowsError(try journal.prepare(record: MeetingRecord(), notes: "Private", scope: ""))
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        let corrupt = Data("not a journal".utf8)
        try corrupt.write(to: url)
        XCTAssertThrowsError(try MacMeetingSaveJournal(url: url))
        XCTAssertEqual(try Data(contentsOf: url), corrupt)
    }
}
