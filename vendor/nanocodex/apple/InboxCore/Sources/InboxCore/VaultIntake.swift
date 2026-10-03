import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

extension ManagedClient {
    /// Vault forms bypass transcript transport and all persistent HTTP caches.
    /// Never follow redirects or automatically replay credential submissions.
    func vaultIntakeJSON(path: String, method: String = "GET", body: JSON? = nil,
                         configuration: URLSessionConfiguration = .ephemeral, maximumResponseBytes: Int = 64 * 1024) async throws -> JSON {
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        let session = URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = try request(path: path, method: method, body: body)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        // Server error bodies can contain arbitrary text. Never display or retain them.
        guard (200..<300).contains(response.statusCode) else { throw APIError.http(response.statusCode) }
        guard data.count <= maximumResponseBytes else { throw APIError.invalidResponse }
        return try JSONDecoder().decode(JSON.self, from: data)
    }
}

/// Only safe presentation hints cross the conversation boundary.
public struct VaultIntake: Codable, Equatable, Sendable {
    public let kind: String
    public let name: String
    public let origin: String?
    public let operation: String?
    public let vaultID: String?
    public let challengeID: String?
    public let agentID: String?
    public var expiresAt: Double? = nil
    public var allowedOrigins: [String]? = nil

    public func isCurrentBrowserRequest(agentID: String, now: Date = Date()) -> Bool {
        guard operation == "browser_takeover" || operation == "browser_verification" || operation == "browser_login",
              self.agentID == agentID, challengeID != nil, let expiresAt else { return false }
        return expiresAt > now.timeIntervalSince1970 * 1000
    }

    public static func parse(_ value: JSON, depth: Int = 0) -> VaultIntake? {
        guard depth < 12 else { return nil }
        let value = ToolPresentation.decoded(value)
        if value["type"].string == "browser_login", value["status"].string == "input_required" {
            guard case .object(let fields) = value,
                  Set(fields.keys).isSubset(of: ["type", "status", "request_id", "challenge_id", "agent_id", "origin", "allowed_origins", "expires_at", "approved", "login_url"]),
                  UUID(uuidString: value["request_id"].string) != nil,
                  value["challenge_id"].string == value["request_id"].string,
                  (try? ManagedClient.agentPath(value["agent_id"].string)) != nil,
                  case .number(let expiry) = value["expires_at"], expiry.isFinite, expiry > 0,
                  case .array(let origins) = value["allowed_origins"], (1...8).contains(origins.count) else { return nil }
            let sites = origins.map(\.string)
            guard Set(sites).count == sites.count, sites.contains(value["origin"].string), sites.allSatisfy({ site in
                parse(.object(["type": .string("vault_intake"), "status": .string("input_required"), "kind": .string("login"), "origin": .string(site)]))?.origin != nil
            }) else { return nil }
            return .init(kind: "login", name: "", origin: value["origin"].string, operation: "browser_login", vaultID: nil,
                         challengeID: value["request_id"].string, agentID: value["agent_id"].string, expiresAt: expiry, allowedOrigins: sites)
        }
        if ["browser_vault_challenge", "browser_vault_takeover"].contains(value["type"].string), value["status"].string == "input_required" {
            guard case .object(let fields) = value,
                  Set(fields.keys) == Set(["type", "status", "challenge_id", "agent_id", "origin", "expires_at"]),
                  case .number(let expiry) = value["expires_at"], expiry.isFinite, expiry > 0,
                  value["challenge_id"].string.range(of: #"^[A-Za-z0-9_-]{22,256}$"#, options: .regularExpression) != nil,
                  (try? ManagedClient.agentPath(value["agent_id"].string)) != nil else { return nil }
            let origin = value["origin"].string
            guard let validated = parse(.object(["type": .string("vault_intake"), "status": .string("input_required"),
                "kind": .string("login"), "origin": .string(origin)])), validated.origin != nil else { return nil }
            return .init(kind: "login", name: "", origin: origin, operation: value["type"].string == "browser_vault_takeover" ? "browser_takeover" : "browser_verification", vaultID: nil,
                         challengeID: value["challenge_id"].string, agentID: value["agent_id"].string, expiresAt: expiry)
        }
        if value["type"].string == "vault_intake", value["status"].string == "input_required",
           ["login", "api_key", "card", "address", "phone"].contains(value["kind"].string) {
            guard case .object(let fields) = value,
                  Set(fields.keys).isSubset(of: ["type", "status", "kind", "name", "origin", "operation", "vault_id", "challenge_id", "agent_id"]) else { return nil }
            let name = value["name"].string
            let origin = value["origin"].string
            guard name.utf8.count <= 120, origin.utf8.count <= 2048, !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return nil }
            if !origin.isEmpty {
                guard let url = URL(string: origin), url.scheme == "https", url.host != nil,
                      url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
                      url.path.isEmpty, url.port != 443,
                      let host = url.host, host == host.lowercased(),
                      origin == "https://" + host + (url.port.map { ":" + String($0) } ?? "") else { return nil }
            }
            let operation = value["operation"].string
            guard operation.isEmpty || operation == "create" || operation == "authorize_origin" || operation == "browser_verification" else { return nil }
            let vaultID = value["vault_id"].string
            if operation == "authorize_origin" || operation == "browser_verification" {
                guard value["kind"].string == "login", !origin.isEmpty,
                      vaultID.range(of: #"^[A-Za-z0-9_-]{22,64}$"#, options: .regularExpression) != nil else { return nil }
            }
            guard (operation == "authorize_origin" || operation == "browser_verification" || vaultID.isEmpty), origin.isEmpty || value["kind"].string == "login" else { return nil }
            let challengeID = value["challenge_id"].string
            let agentID = value["agent_id"].string
            if operation == "browser_verification" {
                guard challengeID.range(of: #"^[A-Za-z0-9_-]{22,256}$"#, options: .regularExpression) != nil,
                      (try? ManagedClient.agentPath(agentID)) != nil else { return nil }
            } else if fields["challenge_id"] != nil || fields["agent_id"] != nil { return nil }
            return .init(kind: value["kind"].string, name: name, origin: origin.isEmpty ? nil : origin,
                         operation: operation.isEmpty ? nil : operation, vaultID: vaultID.isEmpty ? nil : vaultID, challengeID: challengeID.isEmpty ? nil : challengeID, agentID: agentID.isEmpty ? nil : agentID)
        }
        switch value {
        case .array(let values):
            return values.lazy.compactMap { parse($0, depth: depth + 1) }.first
        case .object(let fields):
            // Recognized transport envelopes only; do not interpret arbitrary tool data as UI.
            for key in ["content", "text", "structuredContent", "result", "output"] {
                if let child = fields[key], let intake = parse(child, depth: depth + 1) { return intake }
            }
            return nil
        default: return nil
        }
    }
}

public struct VaultIntakeReceipt: Equatable, Sendable {
    public let id: String
    public let kind: String
    public let name: String
}

extension ManagedClient {
    public func vaultLoginMetadata(id: String) async throws -> VaultIntakeReceipt {
        guard id.range(of: #"^[A-Za-z0-9_-]{22,64}$"#, options: .regularExpression) != nil else { throw APIError.invalidResponse }
        let response = try await vaultIntakeJSON(path: "/v1/credentials")
        guard case .array(let entries) = response["vault"],
              let item = entries.first(where: { $0["id"].string == id && $0["kind"].string == "login" }),
              !item["name"].string.isEmpty, item["name"].string.utf8.count <= 120 else { throw APIError.invalidResponse }
        return .init(id: id, kind: "login", name: item["name"].string)
    }
    public func authorizeVaultOrigin(id: String, origin: String, name: String) async throws -> VaultIntakeReceipt {
        guard VaultIntake.parse(.object(["type": .string("vault_intake"), "status": .string("input_required"),
            "kind": .string("login"), "operation": .string("authorize_origin"), "vault_id": .string(id), "origin": .string(origin)])) != nil else { throw APIError.invalidResponse }
        let response = try await vaultIntakeJSON(path: "/v1/credentials/vault/login/" + id + "/origin", method: "PUT",
            body: .object(["browser_origin": .string(origin)]))
        guard response["id"].string == id, response["kind"].string == "login", response["browser_origin"].string == origin else { throw APIError.invalidResponse }
        return .init(id: id, kind: "login", name: name)
    }
    public func saveVaultItem(kind: String, values: [String: String], configuration: URLSessionConfiguration = .ephemeral) async throws -> VaultIntakeReceipt {
        guard ["login", "api_key", "card", "address", "phone"].contains(kind) else { throw APIError.invalidResponse }
        let response = try await vaultIntakeJSON(path: "/v1/credentials/vault/" + kind, method: "POST",
            body: .object(values.mapValues(JSON.string)), configuration: configuration)
        let id = response["id"].string
        guard id.range(of: #"^[A-Za-z0-9_-]{22,64}$"#, options: .regularExpression) != nil,
              response["kind"].string == kind else { throw APIError.invalidResponse }
        return .init(id: id, kind: kind, name: values["name"] ?? "")
    }
}

extension ManagedClient {
    public func submitBrowserVerification(intake: VaultIntake, code: String, configuration: URLSessionConfiguration = .ephemeral) async throws {
        guard intake.operation == "browser_verification", let challenge = intake.challengeID, let agent = intake.agentID,
              code.range(of: #"^[0-9]{4,10}$"#, options: .regularExpression) != nil else { throw APIError.invalidResponse }
        let response = try await vaultIntakeJSON(path: Self.agentPath(agent) + "/browser-vault/challenge", method: "POST",
            body: .object(["challenge_id": .string(challenge), "code": .string(code)]), configuration: configuration)
        guard case .object(let fields) = response, fields.count == 3, response["type"].string == "browser_vault_challenge_receipt", response["challenge_id"].string == challenge, response["status"].string == "submitted" else { throw APIError.invalidResponse }
    }
}

public struct BrowserKeyboardHint: Sendable, Equatable {
    public let type: String
    public let multiline: Bool
}
public struct BrowserInputRegion: Sendable, Equatable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double
    public let keyboard: BrowserKeyboardHint
}
/// Value-free metadata from the private, authenticated browser transport.
public struct BrowserNativeField: Sendable, Equatable, Identifiable {
    public let id: String
    public let label: String
    public let type: String
    public let multiline: Bool
}
public struct BrowserNativeForm: Sendable, Equatable, Identifiable {
    public let id: String
    public let fields: [BrowserNativeField]

    static func parse(_ value: JSON) throws -> Self {
        guard case .object(let form) = value, Set(form.keys) == Set(["document_id", "fields"]),
              case .string(let id) = value["document_id"], UUID(uuidString: id) != nil,
              case .array(let entries) = value["fields"], (1...32).contains(entries.count) else { throw APIError.invalidResponse }
        var fields: [BrowserNativeField] = []
        for entry in entries {
            guard case .object(let field) = entry,
                  Set(field.keys) == Set(["ref", "label", "type", "multiline"]),
                  case .string(let fieldID) = entry["ref"], UUID(uuidString: fieldID) != nil,
                  !fields.contains(where: { $0.id == fieldID }),
                  case .string(let label) = entry["label"], !label.isEmpty, label.utf16.count <= 160,
                  !label.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
                  case .string(let type) = entry["type"], ["text", "email", "url", "tel", "number", "password"].contains(type),
                  case .bool(let multiline) = entry["multiline"], !multiline || type == "text" else { throw APIError.invalidResponse }
            fields.append(.init(id: fieldID, label: label, type: type, multiline: multiline))
        }
        return .init(id: id, fields: fields)
    }

    /// Build one fill-only request from the current discovery. Never submits the website form.
    public func fillAction(values: [String: String]) throws -> [String: JSON] {
        guard !values.isEmpty, Set(values.keys).isSubset(of: Set(fields.map(\.id))),
              values.values.allSatisfy({ $0.utf16.count <= 4096 && !$0.contains("\0") }),
              values.values.reduce(0, { $0 + $1.utf8.count }) <= 32768 else { throw APIError.invalidResponse }
        return ["action": .string("fill_fields"), "document_id": .string(id),
                "fields": .array(fields.compactMap { field in
                    values[field.id].map { .object(["ref": .string(field.id), "value": .string($0)]) }
                })]
    }
}

public enum BrowserTakeoverFrame: Sendable {
    case active(image: Data, width: Int, height: Int)
    case activeWithForm(image: Data, keyboard: BrowserKeyboardHint?, inputs: [BrowserInputRegion], form: BrowserNativeForm, origin: String?)
    case activeWithInput(image: Data, width: Int, height: Int, keyboard: BrowserKeyboardHint?, inputs: [BrowserInputRegion])

    public static func parse(_ response: JSON, finishing: Bool = false) throws -> Self {
        guard case .object(let fields) = response else { throw APIError.invalidResponse }
        if finishing, fields.count == 1, response["status"].string == "finished" { return .finished }
        let prefix = "data:image/png;base64,", encoded = response["image"].string
        guard case .number(let width) = response["width"], case .number(let height) = response["height"],
              !finishing, Set(fields.keys).isSubset(of: ["status", "image", "width", "height", "keyboard", "inputs", "native_form"]),
              response["status"].string == "active", encoded.hasPrefix(prefix),
              width.isFinite, height.isFinite, width >= 1, width <= 16384, height >= 1, height <= 16384,
              width.rounded() == width, height.rounded() == height,
              let data = Data(base64Encoded: String(encoded.dropFirst(prefix.count))), data.starts(with: [137,80,78,71,13,10,26,10]) else { throw APIError.invalidResponse }
        func hint(_ value: JSON, region: Bool = false) throws -> BrowserKeyboardHint {
            guard case .object(let fields) = value,
                  Set(fields.keys) == Set(region ? ["x", "y", "width", "height", "type", "multiline"] : ["type", "multiline"]),
                  ["text", "email", "url", "tel", "number", "password"].contains(value["type"].string),
                  case .bool(let multiline) = value["multiline"] else { throw APIError.invalidResponse }
            return BrowserKeyboardHint(type: value["type"].string, multiline: multiline)
        }
        let keyboard = try fields["keyboard"].map { try hint($0) }
        var inputs: [BrowserInputRegion] = []
        if let value = fields["inputs"] {
            guard case .array(let regions) = value, regions.count <= 32 else { throw APIError.invalidResponse }
            for region in regions {
                let keyboard = try hint(region, region: true)
                guard case .number(let x) = region["x"], case .number(let y) = region["y"],
                      case .number(let w) = region["width"], case .number(let h) = region["height"],
                      [x,y,w,h].allSatisfy({ $0.isFinite && $0 >= 0 && $0 <= 1 }),
                      w > 0, h > 0, x + w <= 1.000001, y + h <= 1.000001 else { throw APIError.invalidResponse }
                inputs.append(.init(x: x, y: y, width: w, height: h, keyboard: keyboard))
            }
        }
        if let value = fields["native_form"] {
            return .activeWithForm(image: data, keyboard: keyboard, inputs: inputs, form: try BrowserNativeForm.parse(value), origin: nil)
        }
        if keyboard != nil || !inputs.isEmpty {
            return .activeWithInput(image: data, width: Int(width), height: Int(height), keyboard: keyboard, inputs: inputs)
        }
        return .active(image: data, width: Int(width), height: Int(height))
    }
    case finished
    case approved
    case cancelled
    case loginActive(image: Data, keyboard: BrowserKeyboardHint?, inputs: [BrowserInputRegion], origin: String)
}
extension ManagedClient {
    public func browserTakeover(intake: VaultIntake, action: [String: JSON], configuration: URLSessionConfiguration = .ephemeral) async throws -> BrowserTakeoverFrame {
        guard ["browser_takeover", "browser_login"].contains(intake.operation ?? ""), let challenge = intake.challengeID, let agent = intake.agentID else { throw APIError.invalidResponse }
        var body = action; body["challenge_id"] = .string(challenge)
        let response = try await vaultIntakeJSON(path: Self.agentPath(agent) + "/browser-vault/takeover", method: "POST", body: .object(body), configuration: configuration, maximumResponseBytes: 16 * 1024 * 1024)
        if intake.operation == "browser_login" {
            guard case .object(var fields) = response else { throw APIError.invalidResponse }
            let mode = action["action"]?.string ?? ""
            if mode == "approve" {
                guard fields.count == 1, response["status"].string == "approved" else { throw APIError.invalidResponse }
                return .approved
            }
            if mode == "finish" || mode == "cancel" {
                guard Set(fields.keys) == Set(["type", "status", "request_id"]),
                      response["type"].string == "browser_login_receipt", response["request_id"].string == challenge,
                      response["status"].string == (mode == "finish" ? "finished" : "cancelled") else { throw APIError.invalidResponse }
                return mode == "finish" ? .finished : .cancelled
            }
            let origin = fields.removeValue(forKey: "origin")?.string ?? ""
            guard intake.allowedOrigins?.contains(origin) == true else { throw APIError.invalidResponse }
            switch try BrowserTakeoverFrame.parse(.object(fields)) {
            case .activeWithForm(let data, let keyboard, let inputs, let form, _): return .activeWithForm(image: data, keyboard: keyboard, inputs: inputs, form: form, origin: origin)
            case .active(let data, _, _): return .loginActive(image: data, keyboard: nil, inputs: [], origin: origin)
            case .activeWithInput(let data, _, _, let keyboard, let inputs): return .loginActive(image: data, keyboard: keyboard, inputs: inputs, origin: origin)
            default: throw APIError.invalidResponse
            }
        }
        return try BrowserTakeoverFrame.parse(response, finishing: action["action"] == .string("finish"))
    }
}

/// Transcript display only; the original bound receipt remains intact for delivery.
public enum BrowserReceiptPresentation {
    public static func summary(_ text: String) -> String? {
        guard text.utf8.count <= 1024, let data = text.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSON.self, from: data),
              case .object(let fields) = value else { return nil }
        if value["type"].string == "browser_login_receipt" {
            guard Set(fields.keys) == Set(["type", "status", "request_id"]), UUID(uuidString: value["request_id"].string) != nil else { return nil }
            switch value["status"].string {
            case "finished": return "Private sign-in finished; verification pending"
            case "cancelled": return "Private sign-in cancelled"
            default: return nil
            }
        }
        guard Set(fields.keys) == Set(["type", "status", "challenge_id"]),
              value["challenge_id"].string.range(of: #"^[A-Za-z0-9_-]{22,256}$"#, options: .regularExpression) != nil else { return nil }
        switch (value["type"].string, value["status"].string) {
        case ("browser_vault_takeover_receipt", "finished"): return "Private browser control finished"
        case ("browser_vault_challenge_receipt", "submitted"): return "Browser verification code submitted"
        default: return nil
        }
    }
}
