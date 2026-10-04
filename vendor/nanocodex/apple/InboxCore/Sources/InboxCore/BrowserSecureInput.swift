import Foundation

public enum BrowserSecureInputKind: String, Sendable, CaseIterable {
    case password
    case cardNumber = "card_number"
    case cardExpiry = "card_expiry"
    case cardCVC = "card_cvc"
    case sensitiveText = "sensitive_text"

    /// Fixed app-owned labels; tool output cannot supply authority or instructions.
    public var label: String {
        switch self {
        case .password: return "Password"
        case .cardNumber: return "Card number"
        case .cardExpiry: return "Expiry date"
        case .cardCVC: return "Security code"
        case .sensitiveText: return "Sensitive value"
        }
    }
}

public struct BrowserSecureInputField: Identifiable, Sendable, Equatable {
    public let id: String
    public let kind: BrowserSecureInputKind
    public let selector: String
    public var label: String { kind.label }
}

/// Only the authenticated owner endpoint supplies this schema. It is never parsed
/// from a conversation tool result and contains no entered values.
public struct BrowserSecureInputDescription: Sendable {
    public let requestID: String
    public let origin: String
    public let expiresAt: Double
    public let fields: [BrowserSecureInputField]
    private let agentID: String
    private let isForm: Bool

    public static func parse(_ value: JSON, intake: SecureInputRequest) throws -> Self {
        guard !intake.isNative, intake.isCurrent(agentID: intake.agentID),
              case .object(let object) = value,
              Set(object.keys) == Set(["request_id", "origin", "expires_at", "fields"]),
              value["request_id"].string == intake.requestID,
              value["origin"].string == intake.origin,
              case .number(let expiry) = value["expires_at"], expiry == intake.expiresAt,
              case .array(let rawFields) = value["fields"], !rawFields.isEmpty, rawFields.count <= 8 else { throw APIError.invalidResponse }
        let fields = try rawFields.map { raw -> BrowserSecureInputField in
            guard case .object(let object) = raw,
                  Set(object.keys) == Set(["id", "kind", "selector"]),
                  case .string(let id) = raw["id"], !id.isEmpty, id.utf8.count <= 64,
                  let first = id.unicodeScalars.first, (65...90).contains(first.value) || (97...122).contains(first.value),
                  id.unicodeScalars.allSatisfy({ (48...57).contains($0.value) || (65...90).contains($0.value) || (97...122).contains($0.value) || $0 == "_" || $0 == "-" }),
                  let kind = BrowserSecureInputKind(rawValue: raw["kind"].string),
                  case .string(let selector) = raw["selector"], !selector.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, selector.utf16.count <= 512,
                  !selector.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw APIError.invalidResponse }
            return .init(id: id, kind: kind, selector: selector)
        }
        guard Set(fields.map(\.id)).count == fields.count,
              Set(fields.map(\.selector)).count == fields.count else { throw APIError.invalidResponse }
        guard intake.isForm || (fields.count == 1 && fields[0].id == "password" && fields[0].kind == .password) else { throw APIError.invalidResponse }
        return .init(requestID: intake.requestID, origin: intake.origin, expiresAt: expiry, fields: fields, agentID: intake.agentID, isForm: intake.isForm)
    }

    fileprivate func submission(_ intake: SecureInputRequest, values: [String: String]) throws -> JSON {
        guard !intake.isNative, intake.isCurrent(agentID: agentID),
              intake.requestID == requestID, intake.origin == origin, intake.expiresAt == expiresAt, intake.isForm == isForm,
              Set(values.keys) == Set(fields.map(\.id)),
              values.values.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 4096 && !$0.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) }) else { throw APIError.invalidResponse }
        if !isForm {
            guard let password = values["password"] else { throw APIError.invalidResponse }
            return .object(["request_id": .string(requestID), "value": .string(password)])
        }
        return .object(["request_id": .string(requestID), "values": .object(values.mapValues(JSON.string))])
    }
}

extension ManagedClient {
    public func describeSecureInput(_ intake: SecureInputRequest, configuration: URLSessionConfiguration = .ephemeral) async throws -> BrowserSecureInputDescription {
        guard !intake.isNative, intake.isCurrent(agentID: intake.agentID) else { throw APIError.invalidResponse }
        let response = try await vaultIntakeJSON(path: Self.agentPath(intake.agentID) + "/secure-input", method: "POST", body: .object(["request_id": .string(intake.requestID), "action": .string("describe")]), configuration: configuration)
        return try BrowserSecureInputDescription.parse(response, intake: intake)
    }

    public func submitSecureInput(_ intake: SecureInputRequest, description: BrowserSecureInputDescription, values: [String: String], configuration: URLSessionConfiguration = .ephemeral) async throws -> SecureInputReceipt {
        let body = try description.submission(intake, values: values)
        guard try JSONEncoder().encode(body).count <= 32_768 else { throw APIError.invalidResponse }
        let response = try await vaultIntakeJSON(path: Self.agentPath(intake.agentID) + "/secure-input", method: "POST", body: body, configuration: configuration)
        let receipt = try SecureInputReceipt.parse(response, requestID: intake.requestID)
        guard receipt.status != "cancelled" else { throw APIError.invalidResponse }
        return receipt
    }
}
