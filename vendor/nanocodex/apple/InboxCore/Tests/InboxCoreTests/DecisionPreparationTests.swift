import Foundation
import XCTest
@testable import InboxCore

final class DecisionPreparationTests: XCTestCase {
    private let decisionID = "36404373-b1bd-4e37-8a8d-acf212cf74ce"
    private let draftID = "36404373-b1bd-4e37-8a8d-acf212cf74cf"
    private func draftJSON(status: String = "draft", body: String = "Reviewed proposal") -> JSON {
        .object(["id": .string(draftID), "connection_id": .string("account"), "thread_id": .string("thread"),
                 "reply_message_id": .string("message"), "mode": .string("reply"), "version": .number(1),
                 "to": .array([.string("peer@example.test")]), "body_text": .string(body), "status": .string(status)])
    }
    private func decisionJSON(state: String = "ready", status: String = "needs_you", message: String = "message", version: Int = 1) -> JSON {
        .object(["id": .string(decisionID), "title": .string("Review response"), "status": .string(status), "version": .number(Double(version)),
                 "choices": .array([]), "source_connection_id": .string("account"), "source_thread_id": .string("thread"),
                 "source_message_id": .string(message), "preparation": .object(["status": .string(state),
                 "context": .string("Sourced context"), "scope": .string("Bounded research"), "sources": .array([.object(["kind": .string("email"), "reference": .string("message"), "detail": .string("Exact source")])]),
                 "recommendation": .string("Send this response"), "proposal": .string("Complete proposal"), "prepared_draft": draftJSON()])])
    }
    private func encoded(_ json: JSON) -> String { String(decoding: try! JSONEncoder().encode(json), as: UTF8.self) }

    func testNestedContractSupportsPreparationAndExactSourceIdentity() throws {
        let reviewed = try TodoDecision(decisionJSON())
        XCTAssertTrue(reviewed.isPreparedForReview)
        XCTAssertEqual(reviewed.preparationContext, "Sourced context")
        XCTAssertEqual(reviewed.preparationSources.first?.reference, "message")
        XCTAssertEqual(reviewed.preparedDraft?.replyMessageID, "message")
        XCTAssertFalse(try TodoDecision(decisionJSON(message: "other-message")).isPreparedForReview)
        for (key, value) in [("connection_id", "other-account"), ("thread_id", "other-thread"), ("mode", "forward")] {
            guard case .object(var fields) = decisionJSON(), case .object(var preparation) = fields["preparation"],
                  case .object(var draft) = preparation["prepared_draft"] else { return XCTFail() }
            draft[key] = .string(value); preparation["prepared_draft"] = .object(draft); fields["preparation"] = .object(preparation)
            XCTAssertFalse(try TodoDecision(.object(fields)).isPreparedForReview, "Must bind \(key)")
        }
        XCTAssertFalse(try TodoDecision(decisionJSON(state: "pending", status: "preparing")).isPreparedForReview)
        XCTAssertFalse(try TodoDecision(decisionJSON(state: "unknown-future-state")).isPreparedForReview)
        XCTAssertFalse(TodoDecisionApproval.matches(reviewed: reviewed, current: try TodoDecision(decisionJSON(version: 2))))
        for state in ["unprepared", "pending", "preparing", "ready", "blocked", "failed"] {
            XCTAssertEqual(try TodoDecision(decisionJSON(state: state, status: "preparing")).preparationState.rawValue, state)
        }
    }
    func testCalendarIdentityComposesAccountCalendarAndEventWithoutDelimiterCollision() throws {
        func event(account: String, calendar: String) throws -> TodoScheduleEvent {
            try TodoScheduleEvent(.object(["id": .string("same-event"), "connection_id": .string(account), "calendar_id": .string(calendar),
                "title": .string("Review"), "start": .string("2026-09-30T12:00:00Z"), "end": .string("2026-09-30T13:00:00Z")]))
        }
        let events = try [event(account: "a", calendar: "b:c"), event(account: "a:b", calendar: "c"), event(account: "a", calendar: "other")]
        XCTAssertEqual(Set(events.map(\.id)).count, 3)
        XCTAssertEqual(events[0].eventID, "same-event")
    }
    func testActionReviewReadyProposalIsVisibleButNeverProvidesAnEmailDraft() throws {
        var json = decisionJSON()
        guard case .object(var fields) = json, case .object(var preparation) = fields["preparation"] else { return XCTFail() }
        preparation["kind"] = .string("action_review")
        preparation["prepared_draft"] = .null
        fields["preparation"] = .object(preparation); json = .object(fields)
        let action = try TodoDecision(json)
        XCTAssertTrue(action.isPreparedForReview)
        XCTAssertNil(action.preparedDraft)
        preparation["kind"] = .string("email_reply"); fields["preparation"] = .object(preparation)
        XCTAssertFalse(try TodoDecision(.object(fields)).isPreparedForReview)
    }
    func testDraftApprovalIncludesAllRecipientContentAndVersionChanges() throws {
        let reviewed = try TodoMailDraft(draftJSON())
        XCTAssertTrue(TodoDraftApproval.matches(reviewed: reviewed, current: reviewed))
        var current = reviewed; current.to = ["other@example.test"]
        XCTAssertFalse(TodoDraftApproval.matches(reviewed: reviewed, current: current))
        current = reviewed; current.cc = ["copied@example.test"]
        XCTAssertFalse(TodoDraftApproval.matches(reviewed: reviewed, current: current))
        current = reviewed; current.bcc = ["hidden@example.test"]
        XCTAssertFalse(TodoDraftApproval.matches(reviewed: reviewed, current: current))
        current = reviewed; current.bodyText += " edited"
        XCTAssertFalse(TodoDraftApproval.matches(reviewed: reviewed, current: current))
        current = reviewed; current.version += 1
        XCTAssertFalse(TodoDraftApproval.matches(reviewed: reviewed, current: current))
        current = reviewed; current.status = "unknown"
        XCTAssertFalse(TodoDraftApproval.matches(reviewed: reviewed, current: current))
    }
    func testWarmPersistedProjectionTimingIsMacCPUNotDeviceRendering() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let cache = PersistentReadCache(directory: root)
        let payload = JSON.object(["items": .array([]), "decisions": .array([decisionJSON()]), "traces": .array([])])
        cache.save(try JSONEncoder().encode(payload), path: "/v1/todo", ticket: cache.ticket())
        var milliseconds: [Double] = []
        for _ in 0..<8 {
            let start = DispatchTime.now().uptimeNanoseconds
            let data = try XCTUnwrap(cache.read(path: "/v1/todo"))
            let snapshot = try TodoSnapshot(JSONDecoder().decode(JSON.self, from: data))
            XCTAssertTrue(snapshot.decisions[0].isPreparedForReview)
            milliseconds.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000)
        }
        let warm = milliseconds.dropFirst().sorted()
        print("DECISION_MAC_CACHE_CPU n=7 p50_ms=\(warm[3]) p95_ms=\(warm[6]) not_UI_not_device=true")
    }
    @MainActor func testCachedPreparedDecisionHasNoSendAuthorityOffline() async throws {
        let reviewed = try TodoDecision(decisionJSON())
        let session = TodoMailSession(client: nil, connectionID: "account", draftID: draftID, preparedDraft: reviewed.preparedDraft, preparedDecision: reviewed)
        XCTAssertNotNil(session.draft)
        XCTAssertFalse(session.canSend)
        await session.load()
        XCTAssertFalse(session.canSend)
        XCTAssertFalse(session.preparedAuthorityVerified)
    }
    @MainActor func testFreshReadOnlyDetailVerifiesAndStaleDecisionAtApprovalNeverPosts() async throws {
        let reviewed = try TodoDecision(decisionJSON())
        var reads = 0
        let fixture = try HTTPFixture { request in
            XCTAssertEqual(request.method, "GET", "Stale approval must never reach a provider mutation or send")
            if request.path.contains("/decisions/") {
                reads += 1
                return FixtureReply(body: self.encoded(.object(["decision": self.decisionJSON(version: reads == 1 ? 1 : 2)])))
            }
            if request.path.hasSuffix("/accounts") { return FixtureReply(body: #"{"accounts":[{"connection_id":"account","email":"owner@example.test"}]}"#) }
            if request.path.contains("/drafts/") { return FixtureReply(body: self.encoded(.object(["draft": self.draftJSON()]))) }
            XCTFail("Unexpected request: \(request.path)"); return FixtureReply(status: 404)
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
        defer { client.clearCachedResponses(); client.close() }
        XCTAssertEqual(try client.request(path: "/v1/todo/decisions/" + decisionID).cachePolicy, .reloadIgnoringLocalCacheData)
        XCTAssertEqual(try client.request(path: "/v1/todo/mail/drafts/" + draftID).cachePolicy, .reloadIgnoringLocalCacheData)
        let session = TodoMailSession(client: client, connectionID: "account", draftID: draftID, preparedDraft: reviewed.preparedDraft, preparedDecision: reviewed)
        await session.load()
        XCTAssertTrue(session.canSend)
        await session.send(reviewed: reviewed.preparedDraft)
        XCTAssertFalse(session.canSend)
        XCTAssertTrue(session.conflicted)
        XCTAssertEqual(session.draft?.status, "draft")
        XCTAssertEqual(reads, 2)
    }
    @MainActor func testAcknowledgedPreparedLocalEditCanApproveButRemoteDraftContextAndGenerationChangesCannot() async throws {
        for change in ["none", "remote-draft", "target-version", "source", "preparation-time"] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let initial = try TodoDecision(decisionJSON())
            var serverDraft = try XCTUnwrap(initial.preparedDraft)
            var saved = false, sends = 0
            func jsonDraft(_ draft: TodoMailDraft) -> JSON {
                guard case .object(var fields) = draft.saveJSON else { return .null }
                fields["status"] = .string(draft.status)
                return .object(fields)
            }
            let fixture = try HTTPFixture { request in
                if request.path.hasSuffix("/accounts") {
                    XCTAssertEqual(request.method, "GET")
                    return FixtureReply(body: #"{"accounts":[{"connection_id":"account","email":"owner@example.test"}]}"#)
                }
                if request.path.hasSuffix("/drafts"), request.method == "POST" {
                    XCTAssertEqual(request.json["body_text"] as? String, "My locally reviewed edit")
                    XCTAssertEqual(request.json["version"] as? Int, 1)
                    serverDraft.bodyText = "My locally reviewed edit"; serverDraft.version = 2; saved = true
                    return FixtureReply(body: self.encoded(.object(["draft": jsonDraft(serverDraft)])))
                }
                if request.path.contains("/decisions/") {
                    XCTAssertEqual(request.method, "GET")
                    guard case .object(var fields) = self.decisionJSON(), case .object(var prep) = fields["preparation"] else { return FixtureReply(status: 500) }
                    var currentDraft = serverDraft
                    if saved {
                        if change == "remote-draft" { currentDraft.bodyText = "An unreviewed remote edit"; currentDraft.version = 3 }
                        if change == "target-version" { fields["version"] = .number(2) }
                        if change == "source" { fields["source_message_id"] = .string("new-source") }
                        if change == "preparation-time" { prep["updated_at"] = .string("2026-09-30T05:00:00Z") }
                    }
                    prep["prepared_draft"] = jsonDraft(currentDraft); fields["preparation"] = .object(prep)
                    return FixtureReply(body: self.encoded(.object(["decision": .object(fields)])))
                }
                if request.path.contains("/drafts/") {
                    XCTAssertEqual(request.method, "GET")
                    return FixtureReply(body: self.encoded(.object(["draft": jsonDraft(serverDraft)])))
                }
                if request.path.hasSuffix("/send") {
                    XCTAssertEqual(change, "none", "Changed authority must never POST send")
                    XCTAssertEqual(request.method, "POST"); sends += 1
                    XCTAssertEqual(request.json["version"] as? Int, 2)
                    return FixtureReply(body: self.encoded(.object(["receipt": .object([
                        "draft_id": .string(self.draftID), "operation_id": .string(request.json["operation_id"] as? String ?? ""), "status": .string("sent")])])) )
                }
                XCTFail("Unexpected \(request.method) \(request.path)"); return FixtureReply(status: 404)
            }
            defer { fixture.close() }
            let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
            defer { client.clearCachedResponses(); client.close() }
            let session = TodoMailSession(client: client, connectionID: "account", draftID: draftID,
                preparedDraft: initial.preparedDraft, preparedDecision: initial, recoveryRoot: root)
            await session.load(); XCTAssertTrue(session.canSend)
            session.edit { $0.bodyText = "My locally reviewed edit" }
            await session.flush()
            XCTAssertFalse(session.dirty); XCTAssertEqual(session.draft?.version, 2)
            let reviewed = try XCTUnwrap(session.draft)
            await session.send(reviewed: reviewed)
            XCTAssertEqual(sends, change == "none" ? 1 : 0)
            XCTAssertEqual(session.draft?.bodyText, "My locally reviewed edit")
            XCTAssertEqual(session.draft?.status, change == "none" ? "sent" : "draft")
            XCTAssertFalse(session.canSend)
            if change != "none" { XCTAssertTrue(session.conflicted) }
            await session.waitForRecovery()
        }
    }

    @MainActor func testUnavailableFreshDetailKeepsCachedPreviewButBlocksApproval() async throws {
        let fixture = try HTTPFixture { request in
            XCTAssertEqual(request.method, "GET")
            XCTAssertTrue(request.path.contains("/decisions/"))
            return FixtureReply(status: 503)
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
        defer { client.clearCachedResponses(); client.close() }
        let reviewed = try TodoDecision(decisionJSON())
        let session = TodoMailSession(client: client, connectionID: "account", draftID: draftID, preparedDraft: reviewed.preparedDraft, preparedDecision: reviewed)
        await session.load()
        XCTAssertEqual(session.draft?.bodyText, "Reviewed proposal")
        XCTAssertFalse(session.canSend)
        XCTAssertFalse(session.preparedAuthorityVerified)
    }
    @MainActor func testOpeningThreadOnlyReadsAndDoesNotMarkRead() async throws {
        let fixture = try HTTPFixture { request in
            XCTAssertEqual(request.method, "GET")
            if request.path.contains("/threads/") { return FixtureReply(body: #"{"thread":{"id":"thread","connection_id":"account","messages":[]}}"#) }
            if request.path.hasSuffix("/accounts") { return FixtureReply(body: #"{"accounts":[{"connection_id":"account","email":"owner@example.test"}]}"#) }
            return FixtureReply(body: #"{"drafts":[]}"#)
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
        defer { client.clearCachedResponses(); client.close() }
        let session = TodoMailSession(client: client, connectionID: "account", threadID: "thread")
        await session.load(); await session.load()
        XCTAssertNotNil(session.thread)
    }
    @MainActor func testDirtyUnsentTextAndReceiptSurviveRefreshAndReopenSeparately() async throws {
        for status in ["sent", "unknown", "sending"] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: root) }
            let fixture = try HTTPFixture { request in
                XCTAssertEqual(request.method, "GET")
                if request.path.hasSuffix("/accounts") { return FixtureReply(body: #"{"accounts":[{"connection_id":"account","email":"owner@example.test"}]}"#) }
                return FixtureReply(body: self.encoded(.object(["draft": self.draftJSON(status: status, body: "Accepted snapshot")])))
            }
            defer { fixture.close() }
            let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
            defer { client.clearCachedResponses(); client.close() }
            var local = try TodoMailDraft(draftJSON()); local.bodyText = "Dirty never-sent text"
            struct Recovery: Codable { let draft: TodoMailDraft; let dirty: Bool; let sendOperation: UUID? }
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let key = Data(("account\n" + draftID).utf8).base64EncodedString().replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "+", with: "-")
            try JSONEncoder().encode(Recovery(draft: local, dirty: true, sendOperation: nil)).write(to: root.appendingPathComponent(key + ".json"))
            let session = TodoMailSession(client: client, connectionID: "account", draftID: draftID, recoveryRoot: root)
            await session.load(); await session.refreshSendStatus(); await session.waitForRecovery()
            XCTAssertEqual(session.draft?.bodyText, "Dirty never-sent text")
            XCTAssertEqual(session.draft?.status, "draft")
            XCTAssertTrue(session.dirty)
            XCTAssertEqual(session.receiptSnapshot?.bodyText, "Accepted snapshot")
            XCTAssertEqual(session.receiptSnapshot?.status, status)
            XCTAssertTrue(session.saveLabel.hasPrefix("Unsent local edits"))
            XCTAssertFalse(session.canSend)
            let reopened = TodoMailSession(client: client, connectionID: "account", draftID: draftID, recoveryRoot: root)
            await reopened.load()
            XCTAssertEqual(reopened.draft?.bodyText, "Dirty never-sent text")
            XCTAssertEqual(reopened.receiptSnapshot?.status, status)
            XCTAssertFalse(reopened.canSend)
            await reopened.waitForRecovery()
        }
    }
}
