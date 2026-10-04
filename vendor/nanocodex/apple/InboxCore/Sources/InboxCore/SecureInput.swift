import Foundation

/// Safe presentation metadata only; values never enter the conversation model.
public struct SecureInputRequest: Codable, Equatable, Sendable {
    public let requestID: String
    public let agentID: String
    public let origin: String
    public private(set) var machineID: String? = nil
    private var browserKind: String? = nil
    public var isForm: Bool { browserKind == "browser_form" }
    public var isNative: Bool { machineID != nil }
    public let expiresAt: Double
    public func isCurrent(agentID: String, now: Date = Date()) -> Bool {
        self.agentID == agentID && expiresAt > now.timeIntervalSince1970 * 1000
    }
    public static func parse(_ raw: JSON, depth: Int = 0) -> Self? {
        guard depth < 12 else { return nil }
        let value = ToolPresentation.decoded(raw)
        if value["type"].string == "secure_input", value["kind"].string == "native_sudo" {
            guard case .object(let fields) = value,
                  Set(fields.keys) == Set(["type", "status", "request_id", "agent_id", "machine_id", "expires_at", "kind"]),
                  value["status"].string == "input_required",
                  UUID(uuidString: value["request_id"].string) != nil,
                  (try? ManagedClient.agentPath(value["agent_id"].string)) != nil,
                  case .string(let machine) = value["machine_id"], !machine.isEmpty, machine.utf8.count <= 256,
                  !machine.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
                  case .number(let expiry) = value["expires_at"], expiry.isFinite, expiry > 0 else { return nil }
            var request = Self(requestID: value["request_id"].string, agentID: value["agent_id"].string, origin: "", expiresAt: expiry)
            request.machineID = machine
            return request
        }
        if value["type"].string == "secure_input" {
            guard case .object(let fields) = value,
                  Set(fields.keys) == Set(["type", "status", "request_id", "agent_id", "origin", "expires_at", "kind"]),
                  value["status"].string == "input_required", ["browser_password", "browser_form"].contains(value["kind"].string),
                  UUID(uuidString: value["request_id"].string) != nil,
                  (try? ManagedClient.agentPath(value["agent_id"].string)) != nil,
                  case .number(let expiry) = value["expires_at"], expiry.isFinite, expiry > 0,
                  let validated = VaultIntake.parse(.object(["type": .string("vault_intake"), "status": .string("input_required"), "kind": .string("login"), "origin": value["origin"]])),
                  let origin = validated.origin else { return nil }
            var request = Self(requestID: value["request_id"].string, agentID: value["agent_id"].string, origin: origin, expiresAt: expiry)
            request.browserKind = value["kind"].string
            return request
        }
        switch value {
        case .array(let values): return values.lazy.compactMap { parse($0, depth: depth + 1) }.first
        case .object(let fields):
            for key in ["content", "text", "structuredContent", "result", "output"] {
                if let child = fields[key], let request = parse(child, depth: depth + 1) { return request }
            }
            return nil
        default: return nil
        }
    }
}
public struct SecureInputReceipt: Sendable {
    public let requestID: String
    public let status: String
    public var message: String {
        switch status {
        case "completed": return "Protected command completed successfully."
        case "failed": return "Protected command failed. Check the machine before continuing."
        case "filled": return "Sensitive fields filled in browser."
        case "submitted": return "Sensitive fields submitted. Completion is not yet verified."
        case "action_required": return "Sensitive fields filled. A separate private browser action is required."
        case "cancelled": return "Secure input cancelled."
        default: return "Submission outcome unknown. Check the private browser before any further attempt."
        }
    }
    public var json: JSON { .object(["type": .string("secure_input_receipt"), "request_id": .string(requestID), "status": .string(status)]) }
    public static func parse(_ value: JSON, requestID: String, native: Bool = false) throws -> Self {
        guard case .object(let fields) = value,
              Set(fields.keys) == Set(["type", "request_id", "status"]),
              value["type"].string == "secure_input_receipt", value["request_id"].string == requestID,
              (native ? ["completed", "failed", "outcome_unknown", "cancelled"] : ["submitted", "filled", "action_required", "outcome_unknown", "cancelled"]).contains(value["status"].string) else { throw APIError.invalidResponse }
        return .init(requestID: requestID, status: value["status"].string)
    }
}
extension ManagedClient {
    public func cancelSecureInput(_ intake: SecureInputRequest, configuration: URLSessionConfiguration = .ephemeral) async throws -> SecureInputReceipt {
        let response = try await vaultIntakeJSON(path: Self.agentPath(intake.agentID) + (intake.isNative ? "/native-secure-input" : "/secure-input"), method: "POST", body: .object(["request_id": .string(intake.requestID), "action": .string("cancel")]), configuration: configuration)
        let receipt = try SecureInputReceipt.parse(response, requestID: intake.requestID, native: intake.isNative)
        guard receipt.status == "cancelled" else { throw APIError.invalidResponse }
        return receipt
    }
    public func submitSecureInput(_ intake: SecureInputRequest, value: String, configuration: URLSessionConfiguration = .ephemeral) async throws -> SecureInputReceipt {
        guard !intake.isNative, intake.isCurrent(agentID: intake.agentID), !value.isEmpty, value.utf16.count <= 4096, !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw APIError.invalidResponse }
        let response = try await vaultIntakeJSON(path: Self.agentPath(intake.agentID) + "/secure-input", method: "POST", body: .object(["request_id": .string(intake.requestID), "value": .string(value)]), configuration: configuration)
        let receipt = try SecureInputReceipt.parse(response, requestID: intake.requestID)
        guard receipt.status != "cancelled" else { throw APIError.invalidResponse }
        return receipt
    }
}
