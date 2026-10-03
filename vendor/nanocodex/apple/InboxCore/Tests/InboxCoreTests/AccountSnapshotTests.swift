import Foundation
import XCTest
@testable import InboxCore

final class AccountSnapshotTests: XCTestCase {
    // Recovery failures: process recreation must retain data, logout must reject
    // in-flight writes, malformed files must be misses, and unsafe paths excluded.
    func testDiskRecoveryAndLogoutWriteFence() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = PersistentReadCache(directory: directory)
        let ticket = first.ticket()
        first.save(Data(#"{"data":[]}"#.utf8), path: "/v1/agents", ticket: ticket)
        let reopened = PersistentReadCache(directory: directory)
        XCTAssertEqual(reopened.read(path: "/v1/agents"), Data(#"{"data":[]}"#.utf8))
        first.clear()
        first.save(Data("late".utf8), path: "/v1/agents", ticket: ticket)
        XCTAssertNil(reopened.read(path: "/v1/agents"))
        first.save(Data("{}".utf8), path: "/v1/credentials", ticket: first.ticket())
        XCTAssertNil(first.read(path: "/v1/credentials"))
        first.save(Data("{}".utf8), path: "/v1/connectors/link?attempt=secret", ticket: first.ticket())
        XCTAssertNil(first.read(path: "/v1/connectors/link?attempt=secret"))
    }

    func testMutationInvalidatesFamilyAndFencesOlderReads() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PersistentReadCache(directory: directory)
        let ticket = store.ticket()
        store.save(Data("{}".utf8), path: "/v1/crm", ticket: ticket)
        store.save(Data("{}".utf8), path: "/v1/agents", ticket: ticket)
        store.invalidate(path: "/v1/crm/synthetic")
        store.save(Data("late".utf8), path: "/v1/crm", ticket: ticket)
        XCTAssertNil(store.read(path: "/v1/crm"))
        XCTAssertNotNil(store.read(path: "/v1/agents"))
    }

    func testManualDonePersistsWithoutRemovingHistoryAndFencesStaleRoster() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PersistentReadCache(directory: directory)
        let roster = Data(#"{"data":["synthetic"],"summaries":{"synthetic":{"title":"Working","presentation":{"status":"running"}}}}"#.utf8)
        let ticket = store.ticket()
        store.save(roster, path: "/v1/agents", ticket: ticket)
        let historyPath = "/v1/agents/synthetic/events/history?limit=128"
        store.save(Data("history".utf8), path: historyPath, ticket: ticket)
        XCTAssertTrue(store.applySessionDoneMutation(path: "/v1/agents/synthetic/done", method: "PUT",
            response: .object(["done": .bool(true), "done_at": .number(123)]), ticket: ticket))
        store.save(roster, path: "/v1/agents", ticket: ticket)
        let reopened = PersistentReadCache(directory: directory)
        let recovered = try JSONDecoder().decode(JSON.self, from: XCTUnwrap(reopened.read(path: "/v1/agents")))
        XCTAssertEqual(recovered["summaries"]["synthetic"]["presentation"]["done"], .bool(true))
        XCTAssertEqual(recovered["summaries"]["synthetic"]["presentation"]["doneAt"], .number(123))
        XCTAssertEqual(recovered["summaries"]["synthetic"]["presentation"]["status"], .string("running"))
        XCTAssertEqual(reopened.read(path: historyPath), Data("history".utf8))
        XCTAssertTrue(store.applySessionDoneMutation(path: "/v1/agents/synthetic/done", method: "PUT",
            response: .object(["done": .bool(false), "done_at": .null]), ticket: store.ticket()))
        let restored = try JSONDecoder().decode(JSON.self, from: XCTUnwrap(reopened.read(path: "/v1/agents")))
        XCTAssertEqual(restored["summaries"]["synthetic"]["presentation"]["done"], .bool(false))
    }

    func testAgentMutationsPreserveUnrelatedOfflineHistory() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PersistentReadCache(directory: directory)
        let history = "/v1/agents/first/events/history?limit=128"
        let other = "/v1/agents/second/events/history?limit=128"
        for path in [history, other, "/v1/agents", "/v1/agents/first/triggers"] {
            store.save(Data("{}".utf8), path: path, ticket: store.ticket())
        }
        store.save(Data(#"{"data":["first","second"],"summaries":{"first":{},"second":{}}}"#.utf8), path: "/v1/agents", ticket: store.ticket())
        store.invalidate(path: "/v1/agents", method: "POST")
        XCTAssertNotNil(store.read(path: "/v1/agents"))
        store.invalidate(path: "/v1/agents/first/turns")
        XCTAssertNotNil(store.read(path: history))
        XCTAssertNotNil(store.read(path: "/v1/agents"))
        store.invalidate(path: "/v1/agents/first/triggers/job", method: "PATCH")
        XCTAssertNil(store.read(path: "/v1/agents/first/triggers"))
        XCTAssertNotNil(store.read(path: history))
        store.invalidate(path: "/v1/agents/first", method: "DELETE")
        XCTAssertNil(store.read(path: history))
        let roster = try JSONDecoder().decode(JSON.self, from: XCTUnwrap(store.read(path: "/v1/agents")))
        XCTAssertEqual(roster["data"].array, [.string("second")])
        XCTAssertEqual(roster["summaries"]["first"], .null)
        XCTAssertNotNil(store.read(path: other))
    }

    func testSnapshotAccountsAndOriginsAreIsolated() throws {
        let first = try AccountCredential(origin: "https://snapshot-a.invalid", apiKey: fixtureKey)
        let second = try AccountCredential(origin: first.origin, apiKey: "ncx_live_abcdefgh1234_" + String(repeating: "y", count: 43))
        let third = try AccountCredential(origin: "https://snapshot-b.invalid", apiKey: fixtureKey)
        let store = PersistentReadCache.scoped(to: first)
        defer { store.clear() }
        store.save(Data("{}".utf8), path: "/v1/agents", ticket: store.ticket())
        XCTAssertNil(PersistentReadCache.scoped(to: second).read(path: "/v1/agents"))
        XCTAssertNil(PersistentReadCache.scoped(to: third).read(path: "/v1/agents"))
    }

    func testCancelledHistoryDoesNotUseSavedSnapshot() async throws {
        let fixture = try HTTPFixture { _ in .init(body: #"{"data":[],"latest_cursor":"0","has_more":false}"#) }
        defer { fixture.close() }
        let client = ManagedClient(credential: try .init(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
        defer { client.clearCachedResponses(); client.close() }
        _ = try await client.history("synthetic")
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await client.history("synthetic")
        }
        do { _ = try await task.value; XCTFail("Cancellation must not restore a snapshot") }
        catch is CancellationError {}
    }

    func testStreamSnapshotRestoresAndRejectsRegressingNetworkTail() async throws {
        let fixture = try HTTPFixture { _ in .init(body: #"{"data":[],"latest_cursor":"1","has_more":false}"#) }
        defer { fixture.close() }
        let credential = try AccountCredential(origin: fixture.origin, apiKey: fixtureKey)
        let client = ManagedClient(credential: credential, configuration: fixture.configuration)
        defer { client.clearCachedResponses(); client.close() }
        let event = try AgentEvent(.object(["type": .string("turn_accepted"), "turn_id": .string("synthetic"), "input": .string("Saved streamed message")]), cursor: "2")
        await client.saveConversationSnapshot("synthetic", events: [event], latest: event.cursor, hasMore: false)
        _ = try await client.history("synthetic") // stale server tail cannot regress disk
        let reopened = ManagedClient(credential: credential, configuration: fixture.configuration)
        defer { reopened.close() }
        let saved = await reopened.cachedConversationHistory("synthetic")
        XCTAssertEqual(saved?.latest.rawValue, "2")
        XCTAssertEqual(saved?.events.first?.cursor.rawValue, "2")
        XCTAssertEqual(saved?.events.first?.data["input"].string, "Saved streamed message")
    }

    func testRetiredClientCannotWriteStreamSnapshotAfterLogout() async throws {
        let credential = try AccountCredential(origin: "https://retired-snapshot.invalid", apiKey: fixtureKey)
        let client = ManagedClient(credential: credential)
        client.clearCachedResponses()
        await client.saveConversationSnapshot("synthetic", events: [], latest: .zero, hasMore: false)
        let fresh = ManagedClient(credential: credential)
        defer { client.close(); fresh.clearCachedResponses(); fresh.close() }
        let saved = await fresh.cachedConversationHistory("synthetic")
        XCTAssertNil(saved)
    }

    func testRosterSurvivesSnapshotEviction() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PersistentReadCache(directory: directory)
        store.save(Data("{}".utf8), path: "/v1/agents", ticket: store.ticket())
        let data = Data(repeating: 120, count: 24 * 1024 * 1024)
        for id in ["one", "two", "three"] {
            store.save(data, path: "/v1/agents/" + id + "/events/history?limit=128", ticket: store.ticket())
        }
        XCTAssertNotNil(store.read(path: "/v1/agents"))
        XCTAssertNil(store.read(path: "/v1/agents/one/events/history?limit=128"))
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.fileSizeKey])
        let total = try files.reduce(0) { try $0 + $1.resourceValues(forKeys: [.fileSizeKey]).fileSize! }
        XCTAssertLessThanOrEqual(total, 64 * 1024 * 1024)
    }

    func testColdProcessSnapshot() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let path = environment["NANOCODEX_SNAPSHOT_TEST_DIRECTORY"],
              let phase = environment["NANOCODEX_SNAPSHOT_TEST_PHASE"] else {
            throw XCTSkip("Run seed/read phases in separate processes with an isolated snapshot directory")
        }
        let store = PersistentReadCache(directory: URL(fileURLWithPath: path))
        let data = Data(#"{"data":["cold-process-agent"]}"#.utf8)
        if phase == "seed" { store.save(data, path: "/v1/agents", ticket: store.ticket()) }
        else {
            XCTAssertEqual(store.read(path: "/v1/agents"), data)
            store.clear()
            XCTAssertNil(store.read(path: "/v1/agents"))
        }
    }

    func testNoStoreGETSurvivesClientRecreationAndLogout() async throws {
        let fixture = try HTTPFixture { _ in .init(headers: ["Cache-Control": "no-store"], body: #"{"data":[]}"#) }
        defer { fixture.close() }
        let credential = try AccountCredential(origin: fixture.origin, apiKey: fixtureKey)
        let first = ManagedClient(credential: credential, configuration: fixture.configuration)
        _ = try await first.json(path: "/v1/agents")
        first.close()
        let second = ManagedClient(credential: credential, configuration: fixture.configuration)
        defer { second.clearCachedResponses(); second.close() }
        let restored = await second.cachedJSON(path: "/v1/agents")
        XCTAssertNotNil(restored)
        second.clearCachedResponses()
        let cleared = await second.cachedJSON(path: "/v1/agents")
        XCTAssertNil(cleared)
    }
}
