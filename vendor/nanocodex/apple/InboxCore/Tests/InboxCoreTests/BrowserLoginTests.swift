import Foundation
import XCTest
@testable import InboxCore

final class BrowserLoginTests: XCTestCase {
    private let requestID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private var hint: JSON { .object([
        "type": .string("browser_login"), "status": .string("input_required"),
        "request_id": .string(requestID), "challenge_id": .string(requestID), "agent_id": .string("agent_1"),
        "origin": .string("https://example.com"), "allowed_origins": .array([.string("https://example.com"), .string("https://auth.example.com")]),
        "expires_at": .number(Date().addingTimeInterval(300).timeIntervalSince1970 * 1000), "approved": .bool(false)
    ]) }

    func testLoginToolPresentsBoundPaneAndPrivateHTTPJourneyReturnsOnlyReceipt() async throws {
        var tool = ToolPresentation(name: "request_browser_login", arguments: .null)
        tool.finish(hint)
        let intake = try XCTUnwrap(tool.vaultIntake)
        XCTAssertTrue(intake.isCurrentBrowserRequest(agentID: "agent_1"))
        XCTAssertFalse(intake.isCurrentBrowserRequest(agentID: "another"))
        XCTAssertFalse(intake.isCurrentBrowserRequest(agentID: "agent_1", now: Date().addingTimeInterval(600)))
        var unrelated = ToolPresentation(name: "browser_execute", arguments: .null)
        unrelated.finish(hint)
        XCTAssertNil(unrelated.vaultIntake)
        let fixture = try HTTPFixture { request in
            XCTAssertEqual(request.method, "POST")
            XCTAssertEqual(request.path, "/v1/agents/agent_1/browser-vault/takeover")
            XCTAssertEqual(request.headers["authorization"], "Bearer \(fixtureKey)")
            XCTAssertEqual(request.headers["cache-control"], "no-store")
            XCTAssertEqual(request.json["challenge_id"] as? String, self.requestID)
            switch request.json["action"] as? String {
            case "approve": return FixtureReply(body: #"{"status":"approved"}"#)
            case "type":
                XCTAssertEqual(request.json["text"] as? String, "synthetic-password")
                return FixtureReply(body: #"{"status":"active","origin":"https://auth.example.com","image":"data:image/png;base64,iVBORw0KGgo=","width":1,"height":1}"#)
            case "finish": return FixtureReply(body: "{\"type\":\"browser_login_receipt\",\"status\":\"finished\",\"request_id\":\"\(self.requestID)\"}")
            case "cancel": return FixtureReply(body: "{\"type\":\"browser_login_receipt\",\"status\":\"cancelled\",\"request_id\":\"\(self.requestID)\"}")
            default: return FixtureReply(status: 400, body: "{}")
            }
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey))
        defer { client.close() }
        guard case .approved = try await client.browserTakeover(intake: intake, action: ["action": .string("approve")], configuration: fixture.configuration) else { return XCTFail("approval") }
        guard case .loginActive(_, _, _, let origin) = try await client.browserTakeover(intake: intake, action: ["action": .string("type"), "text": .string("synthetic-password")], configuration: fixture.configuration) else { return XCTFail("private frame") }
        XCTAssertEqual(origin, "https://auth.example.com")
        guard case .finished = try await client.browserTakeover(intake: intake, action: ["action": .string("finish")], configuration: fixture.configuration) else { return XCTFail("finish") }
        guard case .cancelled = try await client.browserTakeover(intake: intake, action: ["action": .string("cancel")], configuration: fixture.configuration) else { return XCTFail("cancel") }
        let receipt = "{\"type\":\"browser_login_receipt\",\"status\":\"finished\",\"request_id\":\"\(requestID)\"}"
        XCTAssertEqual(BrowserReceiptPresentation.summary(receipt), "Private sign-in finished; verification pending")
    }

    func testUnapprovedSiteAndWrongReceiptCannotEnterNativePane() async throws {
        let intake = try XCTUnwrap(VaultIntake.parse(hint))
        let fixture = try HTTPFixture { request in
            if request.json["action"] as? String == "finish" {
                return FixtureReply(body: #"{"type":"browser_login_receipt","status":"finished","request_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}"#)
            }
            return FixtureReply(body: #"{"status":"active","origin":"https://unapproved.example.com","image":"data:image/png;base64,iVBORw0KGgo=","width":1,"height":1}"#)
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey))
        defer { client.close() }
        for mode in ["observe", "finish"] {
            do { _ = try await client.browserTakeover(intake: intake, action: ["action": .string(mode)], configuration: fixture.configuration); XCTFail("accepted invalid response") }
            catch { XCTAssertTrue(error is APIError) }
        }
    }
}
