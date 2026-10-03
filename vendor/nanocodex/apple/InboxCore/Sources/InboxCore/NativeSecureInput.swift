import Foundation
import CryptoKit

/// Fetched directly from the authenticated account; never accepted from a tool result.
public struct NativeSecureInputDescription: Sendable {
    public let requestID: String
    public let machineID: String
    public let executable: String
    public let arguments: [String]
    public let uid: UInt32
    public let cwd: String
    public let expiresAt: Double
    private let commandDigest: String
    private let publicKey: P256.KeyAgreement.PublicKey

    /// Render control and directional formatting characters visibly during review.
    public static func displayLiteral(_ value: String) -> String {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.withoutEscapingSlashes]
        guard let bytes = try? encoder.encode(value), let literal = String(data: bytes, encoding: .utf8) else { return "" }
        return literal.unicodeScalars.map { scalar in
            if scalar.properties.generalCategory == .format {
                return String(format: "\\u%04x", scalar.value)
            }
            return String(scalar)
        }.joined()
    }
    public static func parse(_ value: JSON, intake: SecureInputRequest) throws -> Self {
        guard intake.isNative, intake.isCurrent(agentID: intake.agentID),
              case .object(let fields) = value,
              Set(fields.keys) == Set(["request_id", "machine_id", "executable", "arguments", "cwd", "command_digest", "public_key", "expires_at", "uid"]),
              value["request_id"].string == intake.requestID,
              value["machine_id"].string == intake.machineID,
              case .number(let rawUID) = value["uid"], let uid = UInt32(exactly: rawUID), uid > 0,
              case .string(let executable) = value["executable"], executable.hasPrefix("/"),
              case .string(let cwd) = value["cwd"], cwd.hasPrefix("/"),
              case .array(let rawArguments) = value["arguments"], rawArguments.count <= 128,
              case .number(let expiry) = value["expires_at"], expiry == intake.expiresAt,
              let digest = Data(base64Encoded: value["command_digest"].string), digest.count == 32,
              let keyData = Data(base64Encoded: value["public_key"].string), keyData.count == 65,
              let key = try? P256.KeyAgreement.PublicKey(x963Representation: keyData) else { throw APIError.invalidResponse }
        let arguments = try rawArguments.map { argument -> String in
            guard case .string(let text) = argument, !text.contains("\0"), text.utf8.count <= 4096 else { throw APIError.invalidResponse }
            return text
        }
        guard !executable.contains("\0"), !cwd.contains("\0"), executable.utf8.count <= 4096, cwd.utf8.count <= 4096 else { throw APIError.invalidResponse }
        struct Binding: Encodable { let arguments: [String]; let cwd: String; let executable: String; let uid: UInt32 }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let binding = try encoder.encode(Binding(arguments: arguments, cwd: cwd, executable: executable, uid: uid))
        guard Data(SHA256.hash(data: binding)) == digest else { throw APIError.invalidResponse }
        return .init(requestID: intake.requestID, machineID: value["machine_id"].string, executable: executable, arguments: arguments, uid: uid, cwd: cwd, expiresAt: expiry, commandDigest: value["command_digest"].string, publicKey: key)
    }
    fileprivate func envelope(intake: SecureInputRequest, value: String) throws -> JSON {
        guard requestID == intake.requestID, machineID == intake.machineID, expiresAt == intake.expiresAt,
              intake.isCurrent(agentID: intake.agentID), !value.isEmpty, value.utf8.count <= 4096,
              !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw APIError.invalidResponse }
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let shared = try ephemeral.sharedSecretFromKeyAgreement(with: publicKey)
        let key = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(), sharedInfo: Data(requestID.utf8), outputByteCount: 32)
        var plaintext = try JSONEncoder().encode(JSON.object(["request_id": .string(requestID), "command_digest": .string(commandDigest), "value": .string(value)]))
        defer { plaintext.resetBytes(in: 0..<plaintext.count) }
        guard let ciphertext = try AES.GCM.seal(plaintext, using: key).combined else { throw APIError.invalidResponse }
        return .object(["request_id": .string(requestID), "ephemeral_public_key": .string(ephemeral.publicKey.x963Representation.base64EncodedString()), "ciphertext": .string(ciphertext.base64EncodedString())])
    }
}

extension ManagedClient {
    public func describeNativeSecureInput(_ intake: SecureInputRequest, configuration: URLSessionConfiguration = .ephemeral) async throws -> NativeSecureInputDescription {
        guard intake.isNative, intake.isCurrent(agentID: intake.agentID) else { throw APIError.invalidResponse }
        let response = try await vaultIntakeJSON(path: Self.agentPath(intake.agentID) + "/native-secure-input", method: "POST", body: .object(["request_id": .string(intake.requestID), "action": .string("describe")]), configuration: configuration)
        return try NativeSecureInputDescription.parse(response, intake: intake)
    }
    public func submitNativeSecureInput(_ intake: SecureInputRequest, description: NativeSecureInputDescription, value: String, configuration: URLSessionConfiguration = .ephemeral) async throws -> SecureInputReceipt {
        guard intake.isNative else { throw APIError.invalidResponse }
        let envelope = try description.envelope(intake: intake, value: value)
        let response = try await vaultIntakeJSON(path: Self.agentPath(intake.agentID) + "/native-secure-input", method: "POST", body: envelope, configuration: configuration)
        let receipt = try SecureInputReceipt.parse(response, requestID: intake.requestID, native: true)
        guard ["completed", "failed", "outcome_unknown"].contains(receipt.status) else { throw APIError.invalidResponse }
        return receipt
    }
}

/// Local approval and foreground eligibility are separate: the OS auth sheet can
/// finish before SwiftUI reports the scene active again. Cancellation wins while
/// waiting, and no submission closure runs until both conditions hold.
@MainActor public enum NativeSecureInputAuthorization {
    public static func perform<Result>(authenticate: () async throws -> Bool,
                                       isActive: () -> Bool,
                                       isCancelled: () -> Bool,
                                       submit: () async throws -> Result) async throws -> Result {
        guard !Task.isCancelled, !isCancelled(), try await authenticate() else { throw APIError.invalidCredential }
        while !isActive() {
            guard !Task.isCancelled, !isCancelled() else { throw APIError.invalidCredential }
            try await Task.sleep(for: .milliseconds(25))
        }
        guard !Task.isCancelled, !isCancelled() else { throw APIError.invalidCredential }
        return try await submit()
    }
}
