import Foundation
import XCTest
import InboxCore

final class GeneratedAppAgentJournalTests: XCTestCase {
    @MainActor
    func testManagedRequestRecoversLostReplyAndLocalFailureAcrossRestart() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("app-agent-journal-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        // Only the external Managed service uses a URLSession protocol fixture.
        // Journal, ManagedClient serialization and filesystem are production.
        var createKeys: [String] = [], turnIDs: [String] = [], inputs: [String] = []
        var observations = 0, requests = 0
        var loseCreateReply = true, loseTurnReply = true
        let fixture = try HTTPFixture { request in
            requests += 1
            XCTAssertEqual(request.headers["authorization"], "Bearer " + fixtureKey)
            if request.method == "POST", request.path == "/v1/agents" {
                createKeys.append(request.headers["idempotency-key"] ?? "")
                if loseCreateReply {
                    loseCreateReply = false
                    // Creation succeeded remotely, but its receipt was truncated.
                    return FixtureReply(body: "{")
                }
                return FixtureReply(body: #"{"agent_id":"synthetic-journal-agent"}"#)
            }
            if request.method == "POST", request.path == "/v1/agents/synthetic-journal-agent/turns" {
                let id = request.json["id"] as? String ?? ""
                turnIDs.append(id); inputs.append(request.json["input"] as? String ?? "")
                XCTAssertEqual(request.headers["idempotency-key"], "inbox:" + id)
                if loseTurnReply {
                    loseTurnReply = false
                    // Admission succeeded remotely, but its receipt was truncated.
                    return FixtureReply(body: "{")
                }
                return FixtureReply(body: #"{"accepted":true}"#)
            }
            if request.method == "GET", request.path.hasPrefix("/v1/agents/synthetic-journal-agent/turns/") {
                observations += 1
                XCTAssertTrue(turnIDs.contains(String(request.path.split(separator: "/").last!)))
                return FixtureReply(body: #"{"state":"completed","terminal":{"final_message":"Synthetic external operation completed"}}"#)
            }
            XCTFail("Unexpected bridge request \(request.method) \(request.path)")
            return FixtureReply(status: 404)
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
        var submitted = 0
        func perform(_ journal: GeneratedAppAgentJournal, title: String = "Tracker") async throws -> JSON {
            try await journal.request(appID: "tracker", title: title, purpose: "Synthetic task", prompt: "Record operation 42",
                client: client, isActive: { true }, onSubmitted: { submitted += 1 })
        }
        for expectedFailure in ["lost create receipt", "lost admission receipt"] {
            let journal = try GeneratedAppAgentJournal(directory: directory)
            do { _ = try await perform(journal); XCTFail("Expected \(expectedFailure)") }
            catch { print("BRIDGE expected \(expectedFailure): \(error.localizedDescription)") }
        }
        let restarted = try GeneratedAppAgentJournal(directory: directory)
        let receipt = try await perform(restarted, title: "Changed title after restart")
        XCTAssertEqual(receipt["result"].string, "Synthetic external operation completed")
        XCTAssertEqual(submitted, 1)
        fixture.queue.sync {
            XCTAssertEqual(createKeys.count, 2)
            XCTAssertEqual(Set(createKeys).count, 1)
            XCTAssertFalse(createKeys[0].isEmpty)
            XCTAssertEqual(turnIDs.count, 2)
            XCTAssertEqual(Set(turnIDs).count, 1)
            XCTAssertEqual(Set(inputs).count, 1)
            XCTAssertEqual(observations, 1)
        }
        print("BRIDGE lost create/admission replies reconciled with identical IDs and input")
        // A local app save/render failure does not acknowledge its completed receipt.
        let requestCount = fixture.queue.sync { requests }
        let afterLocalFailure = try GeneratedAppAgentJournal(directory: directory)
        let recovered = try await perform(afterLocalFailure)
        XCTAssertEqual(recovered, receipt)
        XCTAssertEqual(fixture.queue.sync { requests }, requestCount)
        print("BRIDGE restart after local-action failure returns terminal receipt with zero network calls")
        let pending = try afterLocalFailure.operation(appID: "tracker", prompt: "Still working", input: "Pending task")
        let other = try afterLocalFailure.operation(appID: "other", prompt: "Record operation 42", input: "Other app")
        try afterLocalFailure.setTerminal(receipt, appID: "other", prompt: "Record operation 42")
        try afterLocalFailure.acknowledge(appID: "tracker", prompts: ["Record operation 42", "Still working"])
        let afterCommit = try GeneratedAppAgentJournal(directory: directory)
        XCTAssertEqual(try afterCommit.operation(appID: "tracker", prompt: "Still working", input: "Ignored"), pending)
        XCTAssertEqual(try afterCommit.operation(appID: "other", prompt: "Record operation 42", input: "Ignored").turnID, other.turnID)
        let next = try await perform(afterCommit)
        XCTAssertNotEqual(next["turn_id"], receipt["turn_id"])
        fixture.queue.sync { XCTAssertEqual(Set(turnIDs).count, 2) }
        print("BRIDGE native commit retires only its receipt; deliberate next action gets a new turn")
        let beforeInactive = fixture.queue.sync { requests }
        do {
            _ = try await afterCommit.request(appID: "tracker", title: "Tracker", purpose: "Synthetic", prompt: "New action",
                client: client, isActive: { false }, onSubmitted: {})
            XCTFail("Inactive app must not submit")
        } catch is CancellationError { }
        XCTAssertEqual(fixture.queue.sync { requests }, beforeInactive)
    }

    @MainActor
    func testUnreadableCorruptAndFailedWritesDoNotSilentlyResetRecovery() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("app-agent-journal-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let journal = try GeneratedAppAgentJournal(directory: directory)
        _ = try journal.operation(appID: "tracker", prompt: "Save", input: "Synthetic task")
        let file = directory.appendingPathComponent("journal.json")
        let original = try Data(contentsOf: file)
        try Data("corrupt journal".utf8).write(to: file, options: .atomic)
        XCTAssertThrowsError(try GeneratedAppAgentJournal(directory: directory))
        XCTAssertThrowsError(try journal.operation(appID: "tracker", prompt: "Save", input: "Retry"))
        XCTAssertEqual(try Data(contentsOf: file), Data("corrupt journal".utf8))
        try original.write(to: file, options: .atomic)
        let recovered = try GeneratedAppAgentJournal(directory: directory)
        // POSIX directory permissions force a real atomic-write failure. No mock host.
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: directory.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path) }
        XCTAssertThrowsError(try recovered.setAgentID("synthetic-agent", appID: "tracker", prompt: "Save"))
        XCTAssertEqual(try Data(contentsOf: file), original)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        XCTAssertNil(try recovered.operation(appID: "tracker", prompt: "Save", input: "Retry").agentID)
        try FileManager.default.removeItem(at: file)
        XCTAssertThrowsError(try recovered.operation(appID: "tracker", prompt: "Save", input: "Retry"))
        print("JOURNAL corruption, failed atomic write and unexpected file loss all fail closed")
    }

    @MainActor
    func testCapacityPreservesExistingOperationsAndRecoversAfterCommit() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("app-agent-journal-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let journal = try GeneratedAppAgentJournal(directory: directory)
        var first: GeneratedAppAgentJournal.Entry?
        for index in 0..<128 {
            let entry = try journal.operation(appID: "tracker", prompt: "Task \(index)", input: "Synthetic")
            if index == 0 { first = entry }
        }
        let restarted = try GeneratedAppAgentJournal(directory: directory)
        XCTAssertThrowsError(try restarted.operation(appID: "tracker", prompt: "Overflow", input: "Synthetic"))
        XCTAssertEqual(try restarted.operation(appID: "tracker", prompt: "Task 0", input: "Retry"), first)
        try restarted.setTerminal(.object(["status": .string("completed")]), appID: "tracker", prompt: "Task 0")
        try restarted.acknowledge(appID: "tracker", prompts: ["Task 0"])
        _ = try restarted.operation(appID: "tracker", prompt: "Overflow", input: "Synthetic")
        print("JOURNAL 128-operation bound rejects new tasks, allows reconciliation, and releases capacity after commit")
    }
}
