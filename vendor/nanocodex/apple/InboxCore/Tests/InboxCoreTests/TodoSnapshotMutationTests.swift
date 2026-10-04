import Foundation
import XCTest
@testable import InboxCore

final class TodoSnapshotMutationTests: XCTestCase {
    // Recovery failures: mutation success followed by offline restart; retries
    // duplicating captures; failed writes changing saved state; older GET races.
    func testSuccessfulMutationsRemainReadableWithoutAnotherGET() async throws {
        let seed = #"{"items":[{"id":"old","body":"Existing","status":"captured","version":1}],"decisions":[{"id":"resolve","title":"Reply?","status":"needs_you","version":1,"choices":[]},{"id":"keep","title":"Keep?","status":"needs_you","version":1,"choices":[]}],"traces":[{"id":1,"outcome":"no_reply"}],"feed_bounds":{"trace_limit":100}}"#
        let fixture = try HTTPFixture { request in
            if request.method == "GET" { return .init(body: seed) }
            if request.path.hasSuffix("/respond") { return .init(body: "{}") }
            if request.json["body"] as? String == "Reject" { return .init(status: 409) }
            return .init(body: #"{"item":{"id":"new","body":"Captured","status":"captured","version":1}}"#)
        }
        defer { fixture.close() }
        let credential = try AccountCredential(origin: fixture.origin, apiKey: fixtureKey)
        let client = ManagedClient(credential: credential, configuration: fixture.configuration)
        defer { client.clearCachedResponses(); client.close() }
        let initial = try await client.todoSnapshot()
        _ = try await client.captureTodo("Captured", operationID: UUID())
        _ = try await client.captureTodo("Captured", operationID: UUID())
        try await client.respondToTodoDecision(initial.decisions[0], choiceID: nil, text: "Done", operationID: UUID())
        do { _ = try await client.captureTodo("Reject", operationID: UUID()); XCTFail("Must reject failed write") }
        catch APIError.http(409) {}
        fixture.close()
        let reopened = ManagedClient(credential: credential, configuration: fixture.configuration)
        defer { reopened.close() }
        let cached = await reopened.cachedJSON(path: "/v1/todo")
        let body = try XCTUnwrap(cached)
        let saved = try TodoSnapshot(body)
        XCTAssertEqual(Set(saved.captures.map(\.id)), ["old", "new"])
        XCTAssertEqual(saved.captures.count, 2)
        XCTAssertEqual(saved.decisions.map(\.id), ["keep"])
        XCTAssertEqual(saved.traces.map(\.id), [1])
        XCTAssertEqual(body["feed_bounds"]["trace_limit"], .number(100))
    }

    func testConcurrentAcknowledgementsSharingTicketBothApply() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PersistentReadCache(directory: directory)
        let ticket = store.ticket()
        store.save(Data(#"{"items":[],"decisions":[{"id":"resolve","title":"Reply?","status":"needs_you","version":1,"choices":[]}],"traces":[]}"#.utf8), path: "/v1/todo", ticket: ticket)
        let capture = try JSONDecoder().decode(JSON.self, from: Data(#"{"item":{"id":"new","body":"Captured","status":"captured","version":1}}"#.utf8))
        XCTAssertTrue(store.applyTodoMutation(path: "/v1/todo", method: "POST", response: capture, ticket: ticket))
        XCTAssertTrue(store.applyTodoMutation(path: "/v1/todo/decisions/resolve/respond", method: "POST", response: .object([:]), ticket: ticket))
        let saved = try TodoSnapshot(JSONDecoder().decode(JSON.self, from: XCTUnwrap(store.read(path: "/v1/todo"))))
        XCTAssertEqual(saved.captures.map(\.id), ["new"])
        XCTAssertTrue(saved.decisions.isEmpty)
    }

    func testFirstCaptureCreatesSnapshotAndFencesOldReads() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PersistentReadCache(directory: directory)
        let before = store.ticket()
        let response = try JSONDecoder().decode(JSON.self, from: Data(#"{"item":{"id":"new","body":"Captured","status":"captured","version":1}}"#.utf8))
        XCTAssertTrue(store.applyTodoMutation(path: "/v1/todo", method: "POST", response: response, ticket: before))
        store.save(Data(#"{"items":[],"decisions":[]}"#.utf8), path: "/v1/todo", ticket: before)
        let reopened = PersistentReadCache(directory: directory)
        let snapshot = try TodoSnapshot(JSONDecoder().decode(JSON.self, from: XCTUnwrap(reopened.read(path: "/v1/todo"))))
        XCTAssertEqual(snapshot.captures.map(\.id), ["new"])
        XCTAssertTrue(snapshot.decisions.isEmpty)
        XCTAssertTrue(snapshot.traces.isEmpty)
        store.clear()
        XCTAssertTrue(store.applyTodoMutation(path: "/v1/todo", method: "POST", response: response, ticket: before))
        XCTAssertNil(store.read(path: "/v1/todo"), "A late mutation must not repopulate after logout")
        XCTAssertTrue(store.applyTodoMutation(path: "/v1/todo/decisions/absent/respond", method: "POST", response: .object([:]), ticket: store.ticket()))
        XCTAssertNil(store.read(path: "/v1/todo"), "A response without a prior snapshot must not invent a feed")
    }
}
