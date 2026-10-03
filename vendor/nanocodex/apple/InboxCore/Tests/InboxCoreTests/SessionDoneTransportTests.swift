import Foundation
import XCTest
import InboxCore

final class SessionDoneTransportTests: XCTestCase {
    func testExplicitDoneAndReopenUseOneScopedWriteEach() async throws {
        var writes = 0
        let fixture = try HTTPFixture { request in
            writes += 1
            XCTAssertEqual(request.path, "/v1/agents/synthetic/done")
            XCTAssertEqual(request.method, "PUT")
            XCTAssertEqual(request.headers["authorization"], "Bearer " + fixtureKey)
            let done = request.json["done"] as? Bool
            XCTAssertEqual(done, writes == 1)
            XCTAssertEqual(request.json.count, 1)
            return FixtureReply(body: done == true ? "{\"done\":true,\"done_at\":123,\"presentation_revision\":6}" : "{\"done\":false,\"done_at\":null}")
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try .init(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
        defer { client.close() }
        let done = try await client.setDone("synthetic", done: true)
        XCTAssertTrue(done.done); XCTAssertEqual(done.doneAt, 123); XCTAssertEqual(done.presentationRevision, 6)
        let reopened = try await client.setDone("synthetic", done: false)
        XCTAssertFalse(reopened.done); XCTAssertNil(reopened.doneAt)
        XCTAssertEqual(writes, 2)
    }

    func testFailureAndMalformedReceiptAreNotRetriedOrReportedAsSuccess() async throws {
        for reply in [FixtureReply(status: 503, body: "{}"), FixtureReply(body: "{}"),
                      FixtureReply(body: "{\"done\":false,\"done_at\":null}"),
                      FixtureReply(body: "{\"done\":true,\"done_at\":null}")] {
            var writes = 0
            let fixture = try HTTPFixture { _ in writes += 1; return reply }
            defer { fixture.close() }
            let client = ManagedClient(credential: try .init(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
            defer { client.close() }
            do { _ = try await client.setDone("synthetic", done: true); XCTFail("Unconfirmed receipt must fail") }
            catch { }
            XCTAssertEqual(writes, 1)
        }
    }

    func testRejectedDoneReceiptsCannotMutateTheOfflineRoster() async throws {
        let roster = "{\"data\":[\"synthetic\"],\"summaries\":{\"synthetic\":{\"presentation\":{\"done\":true,\"doneAt\":123,\"revision\":2}}}}"
        for receipt in ["{\"done\":false,\"done_at\":null,\"presentation_revision\":3}",
                        "{\"done\":true,\"done_at\":456,\"presentation_revision\":3.5}",
                        "{\"done\":true,\"done_at\":456,\"presentation_revision\":-1}"] {
            var writes = 0
            let fixture = try HTTPFixture { request in
                if request.method == "GET" { return FixtureReply(body: roster) }
                writes += 1
                return FixtureReply(body: receipt)
            }
            defer { fixture.close() }
            let client = ManagedClient(credential: try .init(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
            defer { client.clearCachedResponses(); client.close() }
            let before = try await client.json(path: "/v1/agents")
            do { _ = try await client.setDone("synthetic", done: true); XCTFail("Malformed receipt must fail") }
            catch { }
            let cached = await client.cachedJSON(path: "/v1/agents")
            XCTAssertEqual(cached, before, "Rejected receipt corrupted the saved roster")
            XCTAssertEqual(writes, 1)
        }
    }

    func testRosterReadsManualDoneSeparatelyFromExecutionStatus() async throws {
        let fixture = try HTTPFixture { request in
            XCTAssertEqual(request.method, "GET")
            return FixtureReply(body: "{\"data\":[\"synthetic\"],\"summaries\":{\"synthetic\":{\"title\":\"Working\",\"turn_count\":1,\"presentation\":{\"done\":true,\"doneAt\":123,\"status\":\"running\",\"updatedAt\":456}}}}")
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try .init(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
        defer { client.close() }
        let cards = try await client.list()
        let card = try XCTUnwrap(cards.first)
        XCTAssertTrue(card.done); XCTAssertEqual(card.doneAt, 123)
        XCTAssertTrue(card.isRunningInSidebar)
    }
}
