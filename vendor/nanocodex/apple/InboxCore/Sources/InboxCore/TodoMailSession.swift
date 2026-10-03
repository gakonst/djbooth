import Foundation
import Combine
import os

/// Edits are protected on disk before scheduling network I/O. A server conflict
/// never replaces those edits implicitly. Sending freezes the exact saved version.
@MainActor
public final class TodoMailSession: ObservableObject {
    @Published public private(set) var thread: TodoMailThread?
    @Published public private(set) var draft: TodoMailDraft?
    /// Receipt content is never applied to dirty local unsent text.
    @Published public private(set) var receiptSnapshot: TodoMailDraft?
    @Published public private(set) var preparedAuthorityVerified = false
    @Published public private(set) var loading = false
    @Published public private(set) var readingFromCache = false
    /// Body snapshots are readable while live draft/account checks are pending.
    /// This flag is never restored from cache or recovery.
    @Published public private(set) var liveReadVerified = false
    public var readingStatus: String? {
        readingFromCache ? (loading ? "Saved conversation · checking current state…" : "Saved conversation · refresh unavailable") : nil
    }
    @Published public private(set) var saving = false
    @Published public private(set) var sending = false
    @Published public private(set) var suggesting = false
    @Published public private(set) var conflicted = false
    @Published public private(set) var error: String?
    @Published public private(set) var dirty = false
    private let client: ManagedClient?
    private let connectionID: String
    private let threadID: String?
    private let initialDraftID: String?
    private let fixtureMode: Bool
    private let recoveryURL: URL
    private var accountEmail = ""
    private var loaded = false
    private var recovered = false
    private let preparedReview: TodoMailDraft?
    private let preparedDecision: TodoDecision?
    private var acknowledgedPreparedDraft: TodoMailDraft?
    private let performanceLog = OSLog(subsystem: "com.nanocodex.mobile", category: .pointsOfInterest)
    private var persistence: Task<Bool, Never>?
    private var debounce: Task<Void, Never>?
    private var saveTask: Task<TodoMailDraft, Error>?
    private var sendOperation: UUID?
    private var editRevision = 0
    private var localPersistenceFailed = false
    private struct Recovery: Codable {
        var draft: TodoMailDraft
        var dirty: Bool
        var sendOperation: UUID?
        var receiptSnapshot: TodoMailDraft?
    }

    public init(client: ManagedClient?, connectionID: String, threadID: String? = nil, draftID: String? = nil,
         fixture: TodoMailThread? = nil, fixtureMode: Bool = false, preparedDraft: TodoMailDraft? = nil, preparedDecision: TodoDecision? = nil, recoveryRoot: URL? = nil) {
        self.client = client; self.connectionID = connectionID; self.threadID = threadID
        let isFixture = fixture != nil || fixtureMode
        initialDraftID = draftID; self.fixtureMode = isFixture
        thread = fixture
        draft = preparedDraft; acknowledgedPreparedDraft = preparedDraft; preparedReview = preparedDraft; self.preparedDecision = preparedDecision
        let fixtureProfile = Data((ProcessInfo.processInfo.environment["NANOCODEX_DEMO_PROFILE"] ?? "default").utf8).base64EncodedString()
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "+", with: "-")
        let scope = isFixture ? "fixture-" + fixtureProfile : (client?.todoMailStorageScope ?? "offline")
        let key = Data((connectionID + "\n" + (threadID ?? draftID ?? "compose")).utf8).base64EncodedString()
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "+", with: "-")
        let root = recoveryRoot ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("TodoMailDrafts", isDirectory: true).appendingPathComponent(scope, isDirectory: true)
        recoveryURL = root.appendingPathComponent(key + ".json")

    }
    public var saveLabel: String {
        if localPersistenceFailed { return "Draft recovery could not be saved on this device" }
        if sending { return "Sending the reviewed version…" }
        if dirty, let receiptSnapshot, receiptSnapshot.isLocked {
            return "Unsent local edits retained · separate server receipt: " + (receiptSnapshot.status == "sent" ? "provider accepted" : "send outcome unknown or pending")
        }
        switch draft?.status {
        case "sent": return fixtureMode ? "Fixture send complete · no email sent" : "Provider accepted · delivery not verified"
        case "unknown": return "Send outcome unknown · retry blocked"
        case "sending": return "Send pending · check status before continuing"
        default:
            if conflicted { return "Draft changed on another device · your edits are kept here" }
            if saving { return "Saving draft…" }
            if dirty { return "Saved on this device · awaiting server save" }
            return fixtureMode ? "Draft saved · fixture" : "Draft saved to your account"
        }
    }
    public var hasLockedReceipt: Bool { receiptSnapshot?.isLocked == true }
    public var canBegin: Bool { loaded && liveReadVerified && !loading && !hasLockedReceipt && (draft?.isLocked != true || draft?.status == "sent") }
    public var senderAddress: String { accountEmail }
    public var canSend: Bool {
        guard let draft else { return false }
        return loaded && liveReadVerified && !accountEmail.isEmpty && !loading && !sending && !saving && !suggesting && !conflicted && !draft.isLocked && !hasLockedReceipt && !localPersistenceFailed
            && (preparedReview == nil || (preparedAuthorityVerified && !dirty))
            && !draft.to.filter({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }).isEmpty
    }
    public var canSuggest: Bool {
        guard let draft else { return false }
        return loaded && liveReadVerified && !loading && !suggesting && !sending && !draft.isLocked && !hasLockedReceipt && !conflicted && draft.bodyText.isEmpty
            && (draft.mode == .reply || draft.mode == .replyAll)
            && draft.threadID != nil && draft.replyMessageID != nil
    }
    public func suggestReply() async {
        guard canSuggest, let snapshot = draft, let threadID = snapshot.threadID,
              let replyMessageID = snapshot.replyMessageID else { return }
        let revision = editRevision
        suggesting = true; error = nil
        defer { suggesting = false }
        do {
            let proposal: String
            if fixtureMode {
                proposal = "Thanks for the update. I’ll review the launch plan and follow up with my thoughts."
            } else {
                guard let client else { throw APIError.invalidCredential }
                proposal = try await client.suggestTodoMailReply(connectionID: connectionID, threadID: threadID, replyMessageID: replyMessageID)
            }
            guard draft?.id == snapshot.id, editRevision == revision, draft?.bodyText.isEmpty == true,
                  draft?.isLocked == false, !sending else {
                error = "The draft changed while the suggestion was being prepared. Your edits are preserved."
                return
            }
            edit { $0.bodyText = proposal }
        } catch {
            self.error = "A draft suggestion is unavailable right now. You can keep writing your reply. " + error.localizedDescription
        }
    }
    public func load() async {
        guard !loading else { return }
        loading = true; liveReadVerified = false; error = nil
        defer { loading = false }
        // Restore the body before recovery/network checks. Never mark loaded or
        // verify prepared authority from disk; retained content is reading only.
        if !fixtureMode, thread == nil, let client, let threadID,
           let saved = await client.cachedTodoMailThread(connectionID: connectionID, threadID: threadID) {
            guard !Task.isCancelled else { return }
            thread = saved; readingFromCache = true
        }
        guard !Task.isCancelled else { return }
        if !recovered {
            recovered = true
            let url = recoveryURL
            let recovery = await Task.detached(priority: .userInitiated) { () -> Recovery? in
                guard let data = try? Data(contentsOf: url) else { return nil }
                return try? JSONDecoder().decode(Recovery.self, from: data)
            }.value
            guard !Task.isCancelled else { recovered = false; return }
            if let recovery, recovery.draft.connectionID == connectionID,
               draft == nil || draft?.id == recovery.draft.id {
                draft = recovery.draft; dirty = recovery.dirty; sendOperation = recovery.sendOperation; receiptSnapshot = recovery.receiptSnapshot
                if dirty && draft?.isLocked == true {
                    // Migrate recovery written by older clients that applied a
                    // server receipt label to unsent local text.
                    draft?.status = "draft"
                } else if draft?.status == "sending" { draft?.status = "unknown" }
            }
        }
        if fixtureMode { accountEmail = "alex@example.com"; loaded = true; liveReadVerified = true; preparedAuthorityVerified = true; return }
        guard let client else { error = "Connect your account to open this message."; return }
        preparedAuthorityVerified = false
        do {
            if let preparedDecision {
                let current = try await client.todoDecision(id: preparedDecision.id)
                guard !Task.isCancelled else { return }
                guard let acknowledgedPreparedDraft,
                      TodoDecisionApproval.matches(reviewed: preparedDecision, current: current, acknowledgedDraft: acknowledgedPreparedDraft) else {
                    conflicted = true
                    error = "This prepared decision changed. Reopen the current decision before approving."
                    return
                }
            } else if preparedReview != nil {
                error = "Fresh decision context is unavailable. Approval is blocked."
                return
            }
            async let sender = client.todoMailAccountEmail(connectionID: connectionID)
            if let threadID {
                let fresh = try await client.todoMailThread(connectionID: connectionID, threadID: threadID)
                guard !Task.isCancelled else { return }
                thread = fresh; readingFromCache = false
            }
            let remote: TodoMailDraft?
            if let id = initialDraftID ?? draft?.id {
                do { remote = try await client.todoMailDraft(id: id) }
                catch APIError.http(404) where draft?.version == 0 { remote = nil }
            } else if let threadID {
                remote = try await client.todoMailDrafts(connectionID: connectionID, threadID: threadID)
                    .first(where: { $0.threadID == threadID && $0.status != "sent" })
            } else { remote = nil }
            guard !Task.isCancelled else { return }
            let freshAddress = try await sender
            guard !Task.isCancelled else { return }
            accountEmail = freshAddress
            if let remote { mergeRemote(remote) }
            loaded = true; liveReadVerified = true
            preparedAuthorityVerified = preparedDecision != nil && !conflicted
            if dirty && !conflicted && draft?.isLocked != true { scheduleSave() }
        } catch {
            guard !Task.isCancelled else { return }
            self.error = (thread != nil ? "Conversation retained. Current account/draft state could not be verified. " : "") + error.localizedDescription
        }
    }
    @discardableResult public func begin(mode: TodoMailDraftMode, message: TodoMailMessage? = nil) -> Bool {
        guard canBegin else { return false }
        // Reopening an existing draft always retains its edits; changing modes
        // must never silently replace a draft the user has already started.
        if let draft, draft.status != "sent" { return true }
        var recipients: [String] = []
        var copied: [String] = []
        var subject = ""
        var body = ""
        if let message {
            if mode == .reply || mode == .replyAll {
                recipients = Self.addresses(message.replyTo.isEmpty ? message.from : message.replyTo)
                if mode == .replyAll {
                    guard !accountEmail.isEmpty else { error = "Your account address could not be loaded. Refresh before replying to everyone."; return false }
                    recipients += Self.addresses(message.to)
                    copied = Self.addresses(message.cc)
                }
                recipients = Self.unique(recipients, excluding: [accountEmail])
                copied = Self.unique(copied, excluding: recipients + [accountEmail])
                subject = message.subject.lowercased().hasPrefix("re:") ? message.subject : "Re: " + message.subject
            } else if mode == .forward {
                subject = message.subject.lowercased().hasPrefix("fwd:") ? message.subject : "Fwd: " + message.subject
                body = "\n\n---------- Forwarded message ----------\nFrom: \(message.from)\nDate: \(message.date)\nSubject: \(message.subject)\nTo: \(message.to)\n\n\(message.bodyText)"
            }
        }
        receiptSnapshot = nil
        draft = TodoMailDraft(connectionID: connectionID, threadID: mode == .compose ? nil : threadID,
            replyMessageID: message?.id, mode: mode, to: recipients, cc: copied, subject: subject, bodyText: body)
        dirty = true; sendOperation = nil; error = nil; conflicted = false
        persist(); scheduleSave()
        return true
    }
    public func changeMode(_ mode: TodoMailDraftMode) {
        guard let current = draft, current.mode != mode, !current.isLocked, !hasLockedReceipt, !sending,
              let message = thread?.messages.last else { return }
        if mode == .replyAll && accountEmail.isEmpty {
            error = "Your account address could not be loaded. Refresh before replying to everyone."; return
        }
        edit { value in
            value.mode = mode
            value.threadID = mode == .compose ? nil : threadID
            value.replyMessageID = mode == .compose ? nil : message.id
            if mode == .forward {
                value.to = []; value.cc = []; value.bcc = []
                if !value.bodyText.contains("---------- Forwarded message ----------") {
                    value.bodyText += "\n\n---------- Forwarded message ----------\nFrom: \(message.from)\nDate: \(message.date)\nSubject: \(message.subject)\nTo: \(message.to)\n\n\(message.bodyText)"
                }
            } else if mode == .reply || mode == .replyAll {
                let sender = Self.addresses(message.replyTo.isEmpty ? message.from : message.replyTo)
                if mode == .reply {
                    value.to = Self.unique(sender, excluding: [accountEmail])
                    value.cc = []; value.bcc = []
                } else {
                    value.to = Self.unique(value.to + sender + Self.addresses(message.to), excluding: [accountEmail])
                    value.cc = Self.unique(value.cc + Self.addresses(message.cc), excluding: value.to + [accountEmail])
                }
            }
            let base = message.subject
            if [base, "Re: " + base, "Fwd: " + base].contains(value.subject) {
                value.subject = mode == .forward ? "Fwd: " + base : mode == .compose ? base : "Re: " + base
            }
        }
    }
    public func edit(_ change: (inout TodoMailDraft) -> Void) {
        guard var current = draft, !current.isLocked, !hasLockedReceipt, !sending else { return }
        change(&current); draft = current; dirty = true; editRevision += 1
        persist(); scheduleSave()
    }
    private func scheduleSave() {
        debounce?.cancel()
        debounce = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(800)) } catch { return }
            await self?.flush()
        }
    }
    public func flush() async {
        guard !sending else { return }
        _ = await saveCurrent()
        _ = await persistence?.value
    }
    @discardableResult private func saveCurrent() async -> Bool {
        // Await an admitted save without replaying it. Its owning invocation
        // merges the new version before another save can be admitted.
        if let saveTask {
            _ = try? await saveTask.value
            while saving { await Task.yield() }
        }
        guard dirty, let snapshot = draft else { return !conflicted }
        guard !snapshot.isLocked, !hasLockedReceipt, !conflicted else { return false }
        let revision = editRevision
        saving = true
        let task = Task<TodoMailDraft, Error> {
            if fixtureMode {
                var saved = snapshot; saved.version += 1; return saved
            }
            guard let client else { throw APIError.invalidCredential }
            return try await client.saveTodoMailDraft(snapshot)
        }
        saveTask = task
        do {
            let saved = try await task.value
            if saved.isLocked {
                mergeRemote(saved)
                error = "The server returned a locked receipt. Local unsent edits are retained."
            } else if editRevision == revision { draft = saved; dirty = false }
            else { draft?.id = saved.id; draft?.version = saved.version }
            if !saved.isLocked {
                if preparedReview != nil { acknowledgedPreparedDraft = saved }
                error = nil
            }; persist()
        } catch {
            if (error as? APIError) == .http(409) {
                conflicted = true
                self.error = "This draft changed on the server. Your edits remain on this device. Reload the server draft to continue."
            } else { self.error = "Couldn’t save to your account. " + error.localizedDescription }
            persist()
        }
        saveTask = nil; saving = false
        if dirty && !conflicted && error == nil { return await saveCurrent() }
        return !dirty && !conflicted
    }
    public func send(reviewed: TodoMailDraft? = nil) async {
        guard canSend else { return }
        if preparedReview != nil && reviewed == nil {
            error = "Review the exact prepared draft before approving."; return
        }
        if let reviewed, !TodoDraftApproval.matches(reviewed: reviewed, current: draft) {
            error = "The draft changed. Review the current version before approving."; return
        }
        let signpost = OSSignpostID(log: performanceLog)
        os_signpost(.begin, log: performanceLog, name: "DecisionApprovalAcknowledgment", signpostID: signpost)
        defer { os_signpost(.end, log: performanceLog, name: "DecisionApprovalAcknowledgment", signpostID: signpost) }
        // Freeze editing before waiting for the final save, then capture the
        // immutable draft/version and one durable operation ID for this send.
        sending = true; debounce?.cancel()
        if let reviewed, !fixtureMode {
            do {
                guard let client else { throw APIError.invalidCredential }
                if let preparedDecision {
                    let current = try await client.todoDecision(id: preparedDecision.id)
                    guard acknowledgedPreparedDraft == reviewed,
                          TodoDecisionApproval.matches(reviewed: preparedDecision, current: current, acknowledgedDraft: reviewed) else {
                        preparedAuthorityVerified = false; conflicted = true
                        error = "Decision context changed. No send was attempted. Reopen and review it."
                        sending = false; return
                    }
                }
                let remote = try await client.todoMailDraft(id: reviewed.id)
                guard TodoDraftApproval.matches(reviewed: reviewed, current: remote) else {
                    if remote.isLocked { mergeRemote(remote) }
                    else { conflicted = true }
                    error = "The server draft changed. Review its current version before approving."
                    sending = false; return
                }
            } catch {
                self.error = "Could not verify the reviewed draft. No send was attempted. " + error.localizedDescription
                sending = false; return
            }
        }
        guard await saveCurrent(), var snapshot = draft else { sending = false; return }
        if let reviewed, !TodoDraftApproval.matches(reviewed: reviewed, current: draft) {
            sending = false; error = "The saved draft changed. Review it again before approving."; return
        }
        let operation = sendOperation ?? UUID(); sendOperation = operation
        snapshot.status = "sending"; draft = snapshot; persist()
        _ = await persistence?.value
        guard !localPersistenceFailed else { draft?.status = "draft"; sending = false; return }
        do {
            if fixtureMode {
                #if DEBUG
                draft?.status = ProcessInfo.processInfo.arguments.contains("--todo-mail-unknown-fixture") ? "unknown" : "sent"
                #else
                draft?.status = "sent"
                #endif
            } else {
                guard let client else { throw APIError.invalidCredential }
                let receipt = try await client.sendTodoMailDraft(snapshot, operationID: operation)
                guard receipt.draftID == snapshot.id, receipt.operationID.lowercased() == operation.uuidString.lowercased() else { throw APIError.invalidResponse }
                draft?.status = receipt.status
            }
            error = draft?.status == "unknown" ? "The server could not confirm delivery. Sending again is blocked. Check the conversation or refresh send status." : nil
        } catch {
            if (error as? APIError) == .http(409) {
                // A conflict response rejects admission. Keep this exact content
                // until the user explicitly loads the current server version.
                draft?.status = "draft"; conflicted = true; sendOperation = nil
                self.error = "This draft changed before Send arrived. No new send was admitted. Reload the server draft to review the current version."
            } else if let api = error as? APIError, [.http(400), .http(401), .http(403), .http(404), .http(413), .http(422)].contains(api) {
                draft?.status = "draft"; sendOperation = nil
                self.error = "The send request was rejected. " + error.localizedDescription
            } else {
                // A transport error after admission is ambiguous. A fresh operation
                // could duplicate delivery, so only a read-only status check follows.
                draft?.status = "unknown"
                self.error = "Send outcome is unknown. Sending again is blocked. Check send status before taking another action."
            }
        }
        dirty = false; sending = false; persist()
    }
    public func refreshSendStatus() async {
        guard let current = draft, current.version > 0 else { return }
        if fixtureMode { return }
        guard let client else { return }
        do {
            let remote = try await client.todoMailDraft(id: current.id)
            // A still-editable server draft alone does not disprove an in-flight
            // request. Preserve uncertainty until the server reports a terminal send.
            if remote.isLocked { mergeRemote(remote) }
            error = dirty && hasLockedReceipt ? "Server receipt applies to its accepted snapshot, not your unsent local text." : draft?.status == "sent" ? nil : "Delivery is not confirmed. Retry remains blocked."
            persist()
        } catch { self.error = error.localizedDescription }
    }
    public func reloadServerDraft() async {
        guard let current = draft, !current.isLocked, !hasLockedReceipt, preparedReview == nil, let client else { return }
        debounce?.cancel()
        if let saveTask { _ = try? await saveTask.value; while saving { await Task.yield() } }
        do {
            draft = try await client.todoMailDraft(id: current.id)
            dirty = false; conflicted = false; error = nil; persist()
        } catch { self.error = error.localizedDescription }
    }
    private func mergeRemote(_ remote: TodoMailDraft) {
        if let local = draft {
            if preparedReview != nil && !dirty && !local.isLocked && !remote.isLocked && local != remote {
                conflicted = true
                error = "The prepared draft changed on the server. Load the current draft and review it before approving."
                return
            }
            if remote.isLocked {
                if dirty {
                    receiptSnapshot = remote
                    conflicted = true
                    error = "This draft was sent or locked on another device. Your unsaved text is retained on this device."
                } else { draft = remote; dirty = false }
            }
            else if local.isLocked { return }
            else if dirty {
                var comparable = local
                comparable.version = remote.version
                if comparable.saveJSON == remote.saveJSON {
                    draft = remote; dirty = false; persist(); return
                }
                if local.version != remote.version { conflicted = true; error = "This draft changed on another device. Your edits are kept here." }
                return
            } else { draft = remote }
        } else { draft = remote; dirty = false }
        persist()
    }
    private func persist() {
        guard let draft else { return }
        let recovery = Recovery(draft: draft, dirty: dirty, sendOperation: sendOperation, receiptSnapshot: receiptSnapshot)
        let url = recoveryURL, previous = persistence
        persistence = Task { [weak self] in
            _ = await previous?.value
            let ok = await Task.detached(priority: .utility) {
                do {
                    let directory = url.deletingLastPathComponent()
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    var protectedDirectory = directory
                    var values = URLResourceValues(); values.isExcludedFromBackup = true
                    try protectedDirectory.setResourceValues(values)
                    let data = try JSONEncoder().encode(recovery)
                    try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                    return true
                } catch { return false }
            }.value
            self?.localPersistenceFailed = !ok
            if !ok { self?.error = "Couldn’t save recovery on this device. Approval is blocked." }
            return ok
        }
    }
    public func waitForRecovery() async { _ = await persistence?.value }
    public func attachment(_ attachment: TodoMailAttachment, messageID: String) async throws -> URL {
        if fixtureMode {
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("TodoMailFixture", isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent("Launch notes.txt")
            try Data("Launch review\n\nThursday at 10. Confirm the launch date and first-round participants.\n".utf8).write(to: url, options: .atomic)
            return url
        }
        guard let client else { throw APIError.invalidCredential }
        return try await client.downloadTodoMailAttachment(connectionID: connectionID, messageID: messageID, attachment: attachment)
    }
    private static func addresses(_ header: String) -> [String] {
        let pattern = #"[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}"#
        guard let expression = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else { return [] }
        return expression.matches(in: header, range: NSRange(header.startIndex..., in: header)).compactMap {
            Range($0.range, in: header).map { String(header[$0]) }
        }
    }
    private static func unique(_ addresses: [String], excluding: [String]) -> [String] {
        var seen = Set(excluding.map { $0.lowercased() })
        return addresses.filter { !$0.isEmpty && seen.insert($0.lowercased()).inserted }
    }
}
