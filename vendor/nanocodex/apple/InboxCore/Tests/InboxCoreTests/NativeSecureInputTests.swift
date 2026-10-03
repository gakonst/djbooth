import XCTest
import CryptoKit
@testable import InboxCore

final class NativeSecureInputTests: XCTestCase {
    private let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private func hint() -> JSON { .object(["type": .string("secure_input"), "status": .string("input_required"), "kind": .string("native_sudo"), "request_id": .string(id), "agent_id": .string("agent_1"), "machine_id": .string("fixture-machine"), "expires_at": .number(Date().addingTimeInterval(300).timeIntervalSince1970 * 1000)]) }
    // Boundary failures: model-injected fields/keys, different machine or request,
    // expired metadata, command substitution, oversized UTF8 input, and plaintext leakage.
    func testNativeReceiptStatusesDoNotCrossBrowserBoundary() throws {
        for status in ["completed", "failed", "outcome_unknown", "cancelled", "submitted", "filled", "action_required"] {
            let json: JSON = .object(["type": .string("secure_input_receipt"), "request_id": .string(id), "status": .string(status)])
            if ["completed", "failed", "outcome_unknown", "cancelled"].contains(status) {
                XCTAssertEqual(try SecureInputReceipt.parse(json, requestID: id, native: true).status, status)
            } else { XCTAssertThrowsError(try SecureInputReceipt.parse(json, requestID: id, native: true)) }
            if ["completed", "failed"].contains(status) {
                XCTAssertThrowsError(try SecureInputReceipt.parse(json, requestID: id))
            }
        }
    }
    func testCommandDisplayEscapesControlsWithoutChangingArguments() {
        XCTAssertEqual(NativeSecureInputDescription.displayLiteral("a\nb\u{202e}c"), "\"a\\nb\\u202ec\"")
        XCTAssertEqual(NativeSecureInputDescription.displayLiteral("quoted \"value\""), "\"quoted \\\"value\\\"\"")
    }
    func testNativeHintRejectsInjectedRecipientAndRemainsAgentBound() throws {
        let request = try XCTUnwrap(SecureInputRequest.parse(hint()))
        XCTAssertEqual(request.machineID, "fixture-machine")
        XCTAssertTrue(request.isCurrent(agentID: "agent_1"))
        XCTAssertFalse(request.isCurrent(agentID: "other"))
        var tool = ToolPresentation(name: "request_native_secure_input", arguments: .null)
        tool.finish(hint()); XCTAssertEqual(tool.secureInput?.machineID, "fixture-machine")
        var unrelated = ToolPresentation(name: "exec_command", arguments: .null)
        unrelated.finish(hint()); XCTAssertNil(unrelated.secureInput)
        tool.finish(hint(), failed: true); XCTAssertNil(tool.secureInput)
        guard case .object(var fields) = hint() else { return XCTFail() }
        fields["public_key"] = .string("untrusted")
        XCTAssertNil(SecureInputRequest.parse(.object(fields)))
    }
    func testPrivateDescriptionAndEncryptedSubmission() async throws {
        let intake = try XCTUnwrap(SecureInputRequest.parse(hint()))
        let recipient = P256.KeyAgreement.PrivateKey()
        let digest = Data(SHA256.hash(data: try JSONSerialization.data(withJSONObject: ["arguments": ["-u"], "cwd": "/", "executable": "/usr/bin/id", "uid": 501], options: [.sortedKeys, .withoutEscapingSlashes]))).base64EncodedString()
        let fixture = try HTTPFixture { request in
            XCTAssertEqual(request.path, "/v1/agents/agent_1/native-secure-input")
            XCTAssertEqual(request.headers["cache-control"], "no-store")
            if request.json["action"] as? String == "describe" {
                return FixtureReply(body: JSON.object(["request_id": .string(self.id), "machine_id": .string("fixture-machine"), "uid": .number(501), "executable": .string("/usr/bin/id"), "arguments": .array([.string("-u")]), "cwd": .string("/"), "command_digest": .string(digest), "public_key": .string(recipient.publicKey.x963Representation.base64EncodedString()), "expires_at": .number(intake.expiresAt)]).pretty)
            }
            XCTAssertEqual(Set(request.json.keys), Set(["request_id", "ephemeral_public_key", "ciphertext"]))
            do {
                let ephemeral = try P256.KeyAgreement.PublicKey(x963Representation: XCTUnwrap(Data(base64Encoded: request.json["ephemeral_public_key"] as? String ?? "")))
                let shared = try recipient.sharedSecretFromKeyAgreement(with: ephemeral)
                let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(), sharedInfo: Data(self.id.utf8), outputByteCount: 32)
                let box = try AES.GCM.SealedBox(combined: XCTUnwrap(Data(base64Encoded: request.json["ciphertext"] as? String ?? "")))
                let plaintext = try JSONDecoder().decode(JSON.self, from: AES.GCM.open(box, using: key))
                XCTAssertEqual(plaintext["value"].string, "synthetic-native-secret")
                XCTAssertEqual(plaintext["command_digest"].string, digest)
                XCTAssertEqual(plaintext["request_id"].string, self.id)
            } catch { XCTFail("Invalid encrypted submission: \(error)") }
            return FixtureReply(body: "{\"type\":\"secure_input_receipt\",\"request_id\":\"\(self.id)\",\"status\":\"completed\"}")
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try AccountCredential(origin: fixture.origin, apiKey: fixtureKey))
        defer { client.close() }
        let description = try await client.describeNativeSecureInput(intake, configuration: fixture.configuration)
        XCTAssertEqual(description.executable, "/usr/bin/id")
        XCTAssertEqual(description.arguments, ["-u"])
        do {
            _ = try await client.submitNativeSecureInput(intake, description: description, value: String(repeating: "é", count: 2049), configuration: fixture.configuration)
            XCTFail("UTF8 oversized password must fail before network")
        } catch { XCTAssertTrue(error is APIError) }
        let receipt = try await client.submitNativeSecureInput(intake, description: description, value: "synthetic-native-secret", configuration: fixture.configuration)
        XCTAssertEqual(receipt.status, "completed")
    }
    func testDescriptionRejectsMismatchExpiryAndExtraFields() throws {
        let intake = try XCTUnwrap(SecureInputRequest.parse(hint()))
        let key = P256.KeyAgreement.PrivateKey()
        let valid: [String: JSON] = ["request_id": .string(id), "machine_id": .string("fixture-machine"), "uid": .number(501), "executable": .string("/usr/bin/id"), "arguments": .array([]), "cwd": .string("/"), "command_digest": .string(Data(SHA256.hash(data: try JSONSerialization.data(withJSONObject: ["arguments": [String](), "cwd": "/", "executable": "/usr/bin/id", "uid": 501], options: [.sortedKeys, .withoutEscapingSlashes]))).base64EncodedString()), "public_key": .string(key.publicKey.x963Representation.base64EncodedString()), "expires_at": .number(intake.expiresAt)]
        XCTAssertNoThrow(try NativeSecureInputDescription.parse(.object(valid), intake: intake))
        for (field, value) in [("uid", JSON.number(502)), ("executable", .string("/usr/bin/other")), ("arguments", .array([.string("changed")])), ("cwd", .string("/other")), ("machine_id", JSON.string("other")), ("request_id", .string(UUID().uuidString)), ("expires_at", .number(1)), ("value", .string("injected")), ("public_key", .string("invalid"))] {
            var changed = valid; changed[field] = value
            XCTAssertThrowsError(try NativeSecureInputDescription.parse(.object(changed), intake: intake))
        }
    }
}
