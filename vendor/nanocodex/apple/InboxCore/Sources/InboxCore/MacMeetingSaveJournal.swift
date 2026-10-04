import Foundation

/// Small fail-closed macOS editor journal. No payload is sent until its exact
/// revision and CAS base have committed. Bounds never evict an uncertain save.
@MainActor
public final class MacMeetingSaveJournal {
    public struct Submission: Codable, Equatable, Sendable {
        public let record: MeetingRecord
        public let ifMatch: Int
    }
    public struct Entry: Codable, Equatable, Sendable {
        public let scope: String
        public var record: MeetingRecord
        public var notes: String
        /// Nil uses the saved baseline; optional decoding preserves older journals.
        public var transcript: String?
        public var submitted: Submission?
    }
    public enum JournalError: Error, LocalizedError {
        case capacity, invalidScope, invalidDocument, staleAcknowledgement
        public var errorDescription: String? {
            switch self {
            case .capacity: return "The local meeting journal is full. Copy your notes before discarding a draft. No save was sent."
            case .invalidScope: return "Connect an account before saving meeting notes."
            case .invalidDocument: return "The local meeting journal could not be read. No save was sent."
            case .staleAcknowledgement: return "The meeting save acknowledgement no longer matches the local journal."
            }
        }
    }
    private struct Document: Codable { var version = 1; var entries: [Entry] = [] }
    private let url: URL
    private let maxEntries: Int
    private let maxBytes: Int
    private var document: Document

    public static func defaultURL() throws -> URL {
        try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("Nanocodex", isDirectory: true)
            .appendingPathComponent("MeetingEdits", isDirectory: true)
            .appendingPathComponent("mac-meeting-save-journal.json")
    }
    public init(url: URL, maxEntries: Int = 256, maxBytes: Int = 32 * 1024 * 1024) throws {
        self.url = url; self.maxEntries = maxEntries; self.maxBytes = maxBytes
        if FileManager.default.fileExists(atPath: url.path) {
            let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
            guard size <= maxBytes else { throw JournalError.capacity }
            document = try JSONDecoder().decode(Document.self, from: Data(contentsOf: url))
            guard document.version == 1, document.entries.count <= maxEntries,
                  Set(document.entries.map { "\($0.scope):\($0.record.id)" }).count == document.entries.count,
                  document.entries.allSatisfy({ !$0.scope.isEmpty && ($0.submitted == nil || ($0.submitted?.record.id == $0.record.id && $0.submitted?.ifMatch == $0.record.revision)) }) else {
                throw JournalError.invalidDocument
            }
        } else { document = Document() }
    }
    public func entries(scope: String) -> [Entry] { document.entries.filter { $0.scope == scope } }
    private func commit(_ entries: [Entry]) throws {
        let next = Document(entries: entries)
        let data = try JSONEncoder().encode(next)
        guard entries.count <= maxEntries, data.count <= maxBytes else { throw JournalError.capacity }
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        // The dedicated directory also protects atomic temporary files. Do not
        // rely on the user's umask or on an existing app directory's mode.
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        try data.write(to: url, options: .atomic)
        document = next
    }
    public func saveDraft(record: MeetingRecord, notes: String, transcript: String? = nil, scope: String) throws {
        guard !scope.isEmpty else { throw JournalError.invalidScope }
        let draftTranscript = transcript == record.transcript ? nil : transcript
        var entries = document.entries
        if let index = entries.firstIndex(where: { $0.scope == scope && $0.record.id == record.id }) {
            entries[index].notes = notes
            entries[index].transcript = draftTranscript
            // An uncertain submission owns its original editor/CAS baseline.
            if entries[index].submitted == nil { entries[index].record = record }
            if entries[index].submitted == nil && notes == record.notes && draftTranscript == nil { entries.remove(at: index) }
        } else if notes != record.notes || draftTranscript != nil {
            entries.append(Entry(scope: scope, record: record, notes: notes, transcript: draftTranscript))
        }
        try commit(entries)
    }
    public func prepare(record: MeetingRecord, notes: String, transcript: String? = nil, scope: String) throws -> Submission {
        guard !scope.isEmpty else { throw JournalError.invalidScope }
        try saveDraft(record: record, notes: notes, transcript: transcript, scope: scope)
        if let submitted = entries(scope: scope).first(where: { $0.record.id == record.id })?.submitted { return submitted }
        var edited = record; edited.notes = notes; edited.transcript = transcript ?? record.transcript; edited.revision += 1
        if edited.transcript != record.transcript { edited.summary = ""; edited.summaryStatus = .none }
        let submitted = Submission(record: edited, ifMatch: record.revision)
        var entries = document.entries
        if let index = entries.firstIndex(where: { $0.scope == scope && $0.record.id == record.id }) {
            entries[index].submitted = submitted
        } else { entries.append(Entry(scope: scope, record: record, notes: notes, transcript: transcript == record.transcript ? nil : transcript, submitted: submitted)) }
        try commit(entries)
        return submitted
    }
    /// Latest draft text, not the text at request start, survives the response.
    public func acknowledge(_ submitted: Submission, remote: MeetingRecord, scope: String) throws {
        var entries = document.entries
        guard remote.id == submitted.record.id,
              let index = entries.firstIndex(where: { $0.scope == scope && $0.record.id == remote.id }),
              entries[index].submitted == submitted else { throw JournalError.staleAcknowledgement }
        let latestTranscript = entries[index].transcript ?? entries[index].record.transcript
        entries[index].record = remote; entries[index].submitted = nil
        entries[index].transcript = latestTranscript == submitted.record.transcript || latestTranscript == remote.transcript ? nil : latestTranscript
        if entries[index].notes == submitted.record.notes { entries[index].notes = remote.notes }
        if entries[index].notes == remote.notes && entries[index].transcript == nil { entries.remove(at: index) }
        try commit(entries)
    }
    /// Definitive validation rejection means this payload was not admitted.
    /// Preserve editable text/base while allowing a corrected new submission.
    public func reject(_ submitted: Submission, scope: String) throws {
        var entries = document.entries
        guard let index = entries.firstIndex(where: { $0.scope == scope && $0.record.id == submitted.record.id }),
              entries[index].submitted == submitted else { throw JournalError.staleAcknowledgement }
        entries[index].submitted = nil
        try commit(entries)
    }
    public func remove(id: UUID, scope: String) throws {
        try commit(document.entries.filter { $0.scope != scope || $0.record.id != id })
    }
}
