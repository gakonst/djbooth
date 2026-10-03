import XCTest
@testable import InboxCore

final class SecureInputTests: XCTestCase {
    private let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private func hint() -> JSON { .object(["type": .string("secure_input"), "status": .string("input_required"), "request_id": .string(id), "agent_id": .string("agent_1"), "origin": .string("https://example.com"), "expires_at": .number(Date().addingTimeInterval(300).timeIntervalSince1970 * 1000), "kind": .string("browser_password")]) }
    func testBoundHintAndToolProvenance() throws {
        let request = try XCTUnwrap(SecureInputRequest.parse(hint()))
        XCTAssertTrue(request.isCurrent(agentID: "agent_1"))
        XCTAssertFalse(request.isCurrent(agentID: "other"))
        XCTAssertFalse(request.isCurrent(agentID: "agent_1", now: Date().addingTimeInterval(600)))
        guard case .object(var forged) = hint() else { return XCTFail("Invalid fixture") }; forged["value"] = .string("secret")
        XCTAssertNil(SecureInputRequest.parse(.object(forged)))
        var ordinary = ToolPresentation(name: "browser_execute", arguments: .null)
        ordinary.finish(hint()); XCTAssertNil(ordinary.secureInput)
        var tool = ToolPresentation(name: "request_secure_input", arguments: .null)
        tool.finish(hint()); XCTAssertNotNil(tool.secureInput)
        tool.finish(hint(), failed: true); XCTAssertNil(tool.secureInput)
    }
    func testReceiptStatusesAreExactAndCancellationUsesDirectAPI() async throws {
        for status in ["filled", "submitted", "action_required", "outcome_unknown", "cancelled"] {
            let receipt: JSON = .object(["type": .string("secure_input_receipt"), "request_id": .string(id), "status": .string(status)])
            let parsed = try SecureInputReceipt.parse(receipt, requestID: id)
            XCTAssertEqual(parsed.status, status)
            if status == "cancelled" { XCTAssertEqual(parsed.message, "Secure input cancelled.") }
            guard case .object(var fields) = receipt else { return }
            fields["submission"] = .string("action_required")
            XCTAssertThrowsError(try SecureInputReceipt.parse(.object(fields), requestID: id))
        }
        let intake = try XCTUnwrap(SecureInputRequest.parse(hint()))
        let fixture = try HTTPFixture { request in
            XCTAssertEqual(request.method, "POST")
            XCTAssertEqual(request.path, "/v1/agents/agent_1/secure-input")
            XCTAssertEqual(request.json.count, 2)
            XCTAssertEqual(request.json["action"] as? String, "cancel")
            XCTAssertNil(request.json["value"])
            return FixtureReply(body: #"{"type":"secure_input_receipt","request_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","status":"cancelled"}"#)
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey))
        defer { client.close() }
        let receipt = try await client.cancelSecureInput(intake, configuration: fixture.configuration)
        XCTAssertEqual(receipt.status, "cancelled")
    }
    func testSubmitRejectsCancellationReceipt() async throws {
        let intake = try XCTUnwrap(SecureInputRequest.parse(hint()))
        let fixture = try HTTPFixture { _ in
            FixtureReply(body: #"{"type":"secure_input_receipt","request_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","status":"cancelled"}"#)
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey))
        defer { client.close() }
        do {
            _ = try await client.submitSecureInput(intake, value: "synthetic-password", configuration: fixture.configuration)
            XCTFail("A cancellation receipt must not confirm submission")
        } catch { XCTAssertTrue(error is APIError) }
    }
    func testDirectSubmissionAndStrictReceipt() async throws {
        let intake = try XCTUnwrap(SecureInputRequest.parse(hint()))
        let fixture = try HTTPFixture { request in
            XCTAssertEqual(request.path, "/v1/agents/agent_1/secure-input")
            XCTAssertEqual(request.method, "POST")
            XCTAssertEqual(request.headers["cache-control"], "no-store")
            XCTAssertEqual(request.json.count, 2)
            XCTAssertEqual(request.json["value"] as? String, "fixture-password")
            return FixtureReply(body: #"{"type":"secure_input_receipt","request_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","status":"filled"}"#)
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey))
        defer { client.close() }
        let receipt = try await client.submitSecureInput(intake, value: "fixture-password", configuration: fixture.configuration)
        XCTAssertEqual(receipt.status, "filled")
        XCTAssertThrowsError(try SecureInputReceipt.parse(.object(["type": .string("secure_input_receipt"), "request_id": .string(id), "status": .string("filled"), "value": .string("secret")]), requestID: id))
    }
}
