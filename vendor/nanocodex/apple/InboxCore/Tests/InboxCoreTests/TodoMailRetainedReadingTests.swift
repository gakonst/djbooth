import Foundation
import XCTest
import InboxCore

/// The public reader/client journey over the shipped URLSession transport.
/// Only the external mail provider is synthetic; cache, parsing, cancellation,
/// recovery, draft locks and admission guards are the production implementation.
final class TodoMailRetainedReadingTests: XCTestCase {
    private let accounts = #"{"accounts":[{"connection_id":"mail-a","email":"alex@example.com","label":"Alex"}]}"#
    private let page = #"{"threads":[{"id":"thread-a","connection_id":"mail-a","subject":"Plan","from":"maya@example.com","snippet":"Please review","date":"2026-10-01T12:00:00Z","unread":true,"message_count":1}],"next_page_token":"next"}"#
    private let body = #"{"thread":{"id":"thread-a","connection_id":"mail-a","subject":"Plan","messages":[{"id":"message-a","thread_id":"thread-a","from":"maya@example.com","to":"alex@example.com","subject":"Plan","body_text":"Please review the plan.","attachments":[]}]}}"#

    @MainActor
    func testRelaunchReadsImmediatelyWhileLiveChecksFailWithoutGrantingSendAuthority() async throws {
        var fail = false
        let gate = DispatchGroup(); gate.enter()
        let fixture = try HTTPFixture { request in
            XCTAssertEqual(request.method, "GET")
            if fail { return .init(status: 503, gate: gate) }
            if request.path.hasSuffix("accounts") { return .init(body: self.accounts) }
            if request.path.hasSuffix("drafts") { return .init(body: #"{"drafts":[]}"#) }
            if request.path.hasSuffix("thread-a") { return .init(body: self.body) }
            return .init(body: self.page)
        }
        defer { fixture.close() }
        let credential = try AccountCredential(origin: fixture.origin, apiKey: fixtureKey)
        let initial = ManagedClient(credential: credential, configuration: fixture.configuration)
        _ = try await initial.todoMailAccounts()
        _ = try await initial.todoMailThreads(connectionID: "mail-a", query: "in:inbox")
        _ = try await initial.todoMailThread(connectionID: "mail-a", threadID: "thread-a")
        initial.close()
        fail = true
        let reopened = ManagedClient(credential: credential, configuration: fixture.configuration)
        defer { reopened.clearCachedResponses(); reopened.close() }
        let savedPage = await reopened.cachedTodoMailThreads(connectionID: "mail-a", query: "in:inbox")
        XCTAssertEqual(savedPage?.threads.first?.subject, "Plan")
        let otherQuery = await reopened.cachedTodoMailThreads(connectionID: "mail-a", query: "in:sent")
        XCTAssertNil(otherQuery)
        let otherAccount = await reopened.cachedTodoMailThread(connectionID: "mail-b", threadID: "thread-a")
        XCTAssertNil(otherAccount)
        let reader = TodoMailSession(client: reopened, connectionID: "mail-a", threadID: "thread-a")
        let pending = Task { await reader.load() }
        for _ in 0..<200 where reader.thread == nil { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertEqual(reader.thread?.messages.last?.bodyText, "Please review the plan.")
        XCTAssertTrue(reader.loading)
        XCTAssertTrue(reader.readingFromCache)
        XCTAssertFalse(reader.liveReadVerified)
        XCTAssertFalse(reader.canBegin)
        XCTAssertFalse(reader.canSend)
        XCTAssertFalse(reader.preparedAuthorityVerified)
        gate.leave()
        await pending.value
        XCTAssertEqual(reader.thread?.subject, "Plan")
        XCTAssertNotNil(reader.error)
        XCTAssertFalse(reader.canSend)
        XCTAssertFalse(reader.loading)
        print("JOURNEY retained mail: reopened list/body visible during blocked live GET; 503 keeps body; query/account isolation and send guard hold")
    }

    func testArchiveAndUndoInvalidateAllQueryPagesAndFenceOlderReadResponses() async throws {
        let gate = DispatchGroup(); gate.enter()
        let started = expectation(description: "older list request started")
        var delayed = false
        var reject = false
        let fixture = try HTTPFixture { request in
            if request.method == "POST" {
                XCTAssertEqual(request.json["connection_id"] as? String, "mail-a")
                return .init(status: reject ? 503 : 200)
            }
            if request.path.hasSuffix("accounts") { return .init(body: self.accounts) }
            if request.path.hasSuffix("thread-a") { return .init(body: self.body) }
            if delayed { started.fulfill(); return .init(body: self.page, gate: gate) }
            return .init(body: self.page)
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try .init(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
        defer { client.clearCachedResponses(); client.close() }
        _ = try await client.todoMailAccounts()
        _ = try await client.todoMailThread(connectionID: "mail-a", threadID: "thread-a")
        _ = try await client.todoMailThreads(connectionID: "mail-a", query: "in:inbox")
        _ = try await client.todoMailThreads(connectionID: "mail-a", query: "in:inbox", pageToken: "next")
        reject = true
        do { try await client.modifyTodoMailThread(connectionID: "mail-a", threadID: "thread-a", archive: true); XCTFail("Expected provider rejection") }
        catch APIError.http(503) {}
        let retained = await client.cachedTodoMailThreads(connectionID: "mail-a", query: "in:inbox")
        XCTAssertEqual(retained?.threads.count, 1)
        reject = false; delayed = true
        let oldRead = Task { try await client.todoMailThreads(connectionID: "mail-a", query: "in:inbox") }
        await fulfillment(of: [started], timeout: 3)
        try await client.modifyTodoMailThread(connectionID: "mail-a", threadID: "thread-a", archive: true)
        gate.leave(); _ = try await oldRead.value
        delayed = false
        let reopened = ManagedClient(credential: try .init(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
        defer { reopened.close() }
        let invalidated = await reopened.cachedTodoMailThreads(connectionID: "mail-a", query: "in:inbox")
        let continuation = await reopened.cachedTodoMailThreads(connectionID: "mail-a", query: "in:inbox", pageToken: "next")
        let invalidatedBody = await reopened.cachedTodoMailThread(connectionID: "mail-a", threadID: "thread-a")
        XCTAssertNil(invalidated); XCTAssertNil(continuation); XCTAssertNil(invalidatedBody)
        let roster = await reopened.cachedTodoMailAccounts()
        XCTAssertEqual(roster?.count, 1)
        _ = try await client.todoMailThreads(connectionID: "mail-a", query: "in:inbox")
        try await client.modifyTodoMailThread(connectionID: "mail-a", threadID: "thread-a", archive: false)
        let afterUndo = await reopened.cachedTodoMailThreads(connectionID: "mail-a", query: "in:inbox")
        XCTAssertNil(afterUndo)
        print("JOURNEY archive/undo: rejected write retains cache; acknowledged mutation evicts every page/body; late GET cannot repopulate; roster survives")
    }

    func testLookaheadIsBoundedAndDoesNotCacheDraftOrAttachmentAuthority() async throws {
        var requested: [String] = []
        let fixture = try HTTPFixture { request in
            requested.append(request.path)
            let id = request.path.components(separatedBy: "/").last ?? ""
            return .init(body: #"{"thread":{"id":"ID","connection_id":"mail-a","messages":[]}}"#.replacingOccurrences(of: "ID", with: id))
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try .init(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
        defer { client.clearCachedResponses(); client.close() }
        let rows = try (1...8).map { n in try TodoMailThreadSummary(.object(["id": .string("thread-\(n)"), "connection_id": .string("mail-a")])) }
        await client.prefetchTodoMailThreads(rows)
        XCTAssertEqual(Set(requested), Set((1...3).map { "/v1/todo/mail/threads/thread-\($0)" }))
        let first = await client.cachedTodoMailThread(connectionID: "mail-a", threadID: "thread-1")
        XCTAssertNotNil(first)
        let before = requested.count
        await client.prefetchTodoMailThreads(rows)
        XCTAssertEqual(requested.count, before)
        _ = try await client.json(path: "/v1/todo/mail/drafts/draft-a")
        _ = try await client.json(path: "/v1/todo/mail/messages/m/attachments/a?connection_id=mail-a")
        let draftCache = await client.cachedJSON(path: "/v1/todo/mail/drafts/draft-a")
        let attachmentCache = await client.cachedJSON(path: "/v1/todo/mail/messages/m/attachments/a?connection_id=mail-a")
        XCTAssertNil(draftCache); XCTAssertNil(attachmentCache)
        print("JOURNEY lookahead: eight available rows admit three GETs; retained bodies reused; draft/status and attachment reads never persisted")
    }
}
