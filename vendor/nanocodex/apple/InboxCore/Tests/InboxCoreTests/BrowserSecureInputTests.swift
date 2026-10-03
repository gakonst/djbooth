import XCTest
@testable import InboxCore

final class BrowserSecureInputTests: XCTestCase {
    private let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private func intake() throws -> SecureInputRequest {
        try XCTUnwrap(SecureInputRequest.parse(.object(["type": .string("secure_input"), "status": .string("input_required"), "request_id": .string(id), "agent_id": .string("agent_1"), "origin": .string("https://example.com"), "expires_at": .number(Date().addingTimeInterval(300).timeIntervalSince1970 * 1000), "kind": .string("browser_form")])))
    }
    private func metadata(_ intake: SecureInputRequest) -> [String: JSON] {
        ["request_id": .string(id), "origin": .string(intake.origin), "expires_at": .number(intake.expiresAt), "fields": .array([.object(["id": .string("card"), "kind": .string("card_number"), "selector": .string("#card")])])]
    }
    func testOwnerMetadataRequiresExactBindingAndSupportedFields() throws {
        let intake = try intake()
        let valid = metadata(intake)
        XCTAssertNoThrow(try BrowserSecureInputDescription.parse(.object(valid), intake: intake))
        for (key, value) in [("request_id", JSON.string("other")), ("origin", .string("https://other.example")), ("expires_at", .number(intake.expiresAt + 1)), ("value", .string("synthetic-secret"))] {
            var changed = valid; changed[key] = value
            XCTAssertThrowsError(try BrowserSecureInputDescription.parse(.object(changed), intake: intake))
        }
        for field in [JSON.object(["id": .string("card"), "kind": .string("unknown"), "selector": .string("#card")]), .object(["id": .string("card"), "kind": .string("card_number"), "selector": .string("")]), .object(["id": .string("card"), "kind": .string("card_number"), "selector": .string("#card"), "label": .string("Model authority")])] {
            var changed = valid; changed["fields"] = .array([field])
            XCTAssertThrowsError(try BrowserSecureInputDescription.parse(.object(changed), intake: intake))
        }
        guard case .array(let fields) = valid["fields"] else { return XCTFail("Invalid fixture") }
        var duplicate = valid; duplicate["fields"] = .array([fields[0], fields[0]])
        XCTAssertThrowsError(try BrowserSecureInputDescription.parse(.object(duplicate), intake: intake))
    }
    func testLegacySheetDescribeThenValuesSubmissionUsesLegacyWireBody() async throws {
        let intake = try XCTUnwrap(SecureInputRequest.parse(.object(["type": .string("secure_input"), "status": .string("input_required"), "request_id": .string(id), "agent_id": .string("agent_1"), "origin": .string("https://example.com"), "expires_at": .number(Date().addingTimeInterval(300).timeIntervalSince1970 * 1000), "kind": .string("browser_password")])))
        let metadata: JSON = .object(["request_id": .string(id), "origin": .string(intake.origin), "expires_at": .number(intake.expiresAt), "fields": .array([.object(["id": .string("password"), "kind": .string("password"), "selector": .string("#password")])])])
        let body = try XCTUnwrap(String(data: JSONEncoder().encode(metadata), encoding: .utf8))
        let fixture = try HTTPFixture { request in
            if request.json["action"] as? String == "describe" { return FixtureReply(body: body) }
            XCTAssertEqual(Set(request.json.keys), Set(["request_id", "value"]))
            XCTAssertEqual(request.json["value"] as? String, "synthetic-password")
            XCTAssertNil(request.json["values"])
            return FixtureReply(body: "{\"type\":\"secure_input_receipt\",\"request_id\":\"\(self.id)\",\"status\":\"filled\"}")
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey))
        defer { client.close() }
        let description = try await client.describeSecureInput(intake, configuration: fixture.configuration)
        let receipt = try await client.submitSecureInput(intake, description: description, values: ["password": "synthetic-password"], configuration: fixture.configuration)
        XCTAssertEqual(receipt.status, "filled")
    }

    func testAllKindsAndOwnerDescribeTransport() async throws {
        let intake = try intake()
        var metadata = metadata(intake)
        metadata["fields"] = .array(BrowserSecureInputKind.allCases.enumerated().map { index, kind in
            .object(["id": .string("field_\(index)"), "kind": .string(kind.rawValue), "selector": .string("#field_\(index)")])
        })
        let data = try JSONEncoder().encode(JSON.object(metadata))
        let body = try XCTUnwrap(String(data: data, encoding: .utf8))
        let fixture = try HTTPFixture { request in
            XCTAssertEqual(request.path, "/v1/agents/agent_1/secure-input")
            XCTAssertEqual(Set(request.json.keys), Set(["request_id", "action"]))
            XCTAssertEqual(request.json["action"] as? String, "describe")
            XCTAssertEqual(request.json["request_id"] as? String, self.id)
            return FixtureReply(body: body)
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey))
        defer { client.close() }
        let description = try await client.describeSecureInput(intake, configuration: fixture.configuration)
        XCTAssertEqual(description.fields.map(\.kind), BrowserSecureInputKind.allCases)
        XCTAssertEqual(description.origin, intake.origin)
    }

    func testDirectMultiFieldSubmissionUsesOnlyPrivateValuesAndFixedReceipt() async throws {
        let intake = try intake()
        let description = try BrowserSecureInputDescription.parse(.object(metadata(intake)), intake: intake)
        let fixture = try HTTPFixture { request in
            XCTAssertEqual(request.path, "/v1/agents/agent_1/secure-input")
            XCTAssertEqual(request.method, "POST")
            XCTAssertEqual(request.headers["cache-control"], "no-store")
            XCTAssertEqual(Set(request.json.keys), Set(["request_id", "values"]))
            XCTAssertEqual((request.json["values"] as? [String: String])?["card"], "4242424242424242")
            return FixtureReply(body: "{\"type\":\"secure_input_receipt\",\"request_id\":\"\(self.id)\",\"status\":\"filled\"}")
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey))
        defer { client.close() }
        for values in [[String: String](), ["other": "synthetic"], ["card": ""], ["card": String(repeating: "é", count: 4097)]] {
            do { _ = try await client.submitSecureInput(intake, description: description, values: values, configuration: fixture.configuration); XCTFail("Invalid values must fail locally") } catch { XCTAssertTrue(error is APIError) }
        }
        let receipt = try await client.submitSecureInput(intake, description: description, values: ["card": "4242424242424242"], configuration: fixture.configuration)
        XCTAssertEqual(receipt.status, "filled")
    }
}
