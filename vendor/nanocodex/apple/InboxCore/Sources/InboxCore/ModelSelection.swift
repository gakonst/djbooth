import Foundation

/// Static choices are display metadata for retained history/demo, never account availability.
public struct ModelChoice: Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let efforts: [String]
    public let provider: String
    public let fastMode: Bool
    public let reasoningModes: [String]
    public init(id: String, name: String, efforts: [String], provider: String = "openai",
                fastMode: Bool = true, reasoningModes: [String] = ["standard", "pro"]) {
        self.id = id; self.name = name; self.efforts = efforts; self.provider = provider
        self.fastMode = fastMode; self.reasoningModes = reasoningModes
    }
    public static let all: [Self] = [
        .init(id: "gpt-6-astra", name: "Astra", efforts: ["low", "medium", "high", "xhigh", "max"]),
        .init(id: "gpt-6.1-sol", name: "Sol", efforts: ["low", "medium", "high", "xhigh", "max"]),
        .init(id: "gpt-6-luna", name: "Luna", efforts: ["none", "low", "medium", "high", "xhigh", "max"]),
        .init(id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", efforts: ["low", "medium", "high"], provider: "claude", fastMode: false, reasoningModes: ["standard"]),
        .init(id: "claude-opus-4-6", name: "Claude Opus 4.6", efforts: ["low", "medium", "high"], provider: "claude", fastMode: false, reasoningModes: ["standard"]),
        .init(id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", efforts: ["low", "medium", "high"], provider: "claude", fastMode: false, reasoningModes: ["standard"]),
        .init(id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: ["low", "medium", "high"], provider: "claude", fastMode: false, reasoningModes: ["standard"]),
        .init(id: "kimi-k3", name: "Kimi K3", efforts: ["low", "high"]),
        .init(id: "mimo-v2.6-pro", name: "MiMo V2.6 Pro", efforts: ["low", "medium", "high"]),
        .init(id: "@cf/zai-org/glm-5.3", name: "GLM 5.3", efforts: ["low", "medium", "high"]),
    ]
    public static func find(_ id: String) -> Self? { all.first { $0.id == id } }
    public static func effortName(_ value: String) -> String {
        value == "xhigh" ? "Extra high" : value == "max" ? "Maximum" : value.capitalized
    }
}

public struct ModelProviderAvailability: Equatable, Sendable {
    public let connected: Bool
    public let available: Bool

    init?(_ value: JSON) {
        guard case .bool(let connected) = value["connected"],
              case .bool(let available) = value["available"] else { return nil }
        self.connected = connected
        self.available = available
    }
}

public struct ModelCatalog: Equatable, Sendable {
    public let models: [ModelChoice]
    public let defaultModel: String?
    public let claudeAvailability: ModelProviderAvailability?
    public init(_ value: JSON) throws {
        guard value["object"].string == "list", case .array(let data) = value["data"], data.count <= 64,
              value["default_model"] == .null || !value["default_model"].string.isEmpty else { throw APIError.invalidResponse }
        var ids = Set<String>()
        models = try data.map { item in
            let id = item["id"].string, name = item["name"].string, provider = item["provider"].string
            guard !id.isEmpty, id.count <= 128, ids.insert(id).inserted, !name.isEmpty, name.count <= 128,
                  !provider.isEmpty, case .array(let efforts) = item["thinking"], !efforts.isEmpty,
                  efforts.allSatisfy({ ["none", "low", "medium", "high", "xhigh", "max"].contains($0.string) }),
                  case .bool(let fastMode) = item["fast_mode"], case .array(let modes) = item["reasoning_modes"],
                  !modes.isEmpty, modes.allSatisfy({ ["standard", "pro"].contains($0.string) }) else { throw APIError.invalidResponse }
            return ModelChoice(id: id, name: name, efforts: efforts.map(\.string), provider: provider,
                               fastMode: fastMode, reasoningModes: modes.map(\.string))
        }
        let selected = value["default_model"].string
        guard selected.isEmpty || ids.contains(selected) else { throw APIError.invalidResponse }
        defaultModel = selected.isEmpty ? nil : selected
        claudeAvailability = ModelProviderAvailability(value["availability"]["claude"])
    }
}

public struct ClaudeConnectionStatus: Equatable, Sendable {
    public let connected: Bool
    public let pending: Bool
    public init(_ value: JSON) throws {
        guard case .bool(let connected) = value["claude"]["connected"] else { throw APIError.invalidResponse }
        self.connected = connected
        pending = value["claude"]["state"].string == "pending" || value["claude"]["login"]["state"].string == "pending"
    }
}

/// Model/effort updates shared by the native picker and HTTP journeys.
public enum ManagedModelSelection: Sendable {
    case manual(model: String, thinking: String)
    case automatic
    case effort(String)
}

public extension ManagedClient {
    /// Routing owns fast/reasoning defaults; its contract only accepts model and thinking.
    @discardableResult
    func updateModelSelection(_ agentID: String, selection: ManagedModelSelection) async throws -> JSON {
        let path = try Self.agentPath(agentID)
        switch selection {
        case .manual(let model, let thinking):
            return try await json(path: path + "/routing", method: "POST",
                body: .object(["model": .string(model), "thinking": .string(thinking)]))
        case .automatic:
            return try await json(path: path + "/routing", method: "POST", body: .object([:]))
        case .effort(let thinking):
            return try await json(path: path + "/settings", method: "PATCH",
                body: .object(["thinking": .string(thinking)]))
        }
    }

    /// Always read account-authenticated availability; no hardcoded native model grants.
    func modelCatalog() async throws -> ModelCatalog { try ModelCatalog(await json(path: "/v1/models")) }
    func claudeConnectionStatus() async throws -> ClaudeConnectionStatus {
        try ClaudeConnectionStatus(await claudeConnectionJSON(path: "/v1/credentials"))
    }
    func startClaudeLogin() async throws -> URL {
        let value = try await claudeConnectionJSON(path: "/v1/credentials/claude/login", method: "POST")
        let expiry = value["expires_at"].number
        guard expiry.isFinite, expiry > 0, expiry <= 9_007_199_254_740_991 else { throw APIError.invalidResponse }
        let rawURL = value["authorization_url"].string
        let keys = Set(["code", "client_id", "response_type", "redirect_uri", "scope", "code_challenge", "code_challenge_method", "state"])
        guard rawURL.utf8.count <= 4096, let url = URL(string: rawURL),
              url.scheme == "https", url.host == "claude.com", url.path == "/cai/oauth/authorize",
              url.user == nil, url.password == nil, url.fragment == nil, url.port == nil,
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let encodedQuery = components.percentEncodedQuery else { throw APIError.invalidResponse }
        // Rust Url.query_pairs_mut uses application/x-www-form-urlencoded:
        // decode literal + as a space before percent decoding. Encoded %2B stays
        // a literal plus, so it cannot masquerade as a registered scope separator.
        components.percentEncodedQuery = encodedQuery.replacingOccurrences(of: "+", with: "%20")
        guard let items = components.queryItems,
              items.count == keys.count, Set(items.map(\.name)) == keys,
              items.first(where: { $0.name == "code" })?.value == "true",
              items.first(where: { $0.name == "client_id" })?.value == "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
              items.first(where: { $0.name == "redirect_uri" })?.value == "https://platform.claude.com/oauth/code/callback",
              items.first(where: { $0.name == "scope" })?.value == "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins",
              items.first(where: { $0.name == "response_type" })?.value == "code",
              items.first(where: { $0.name == "code_challenge_method" })?.value == "S256",
              (items.first(where: { $0.name == "code_challenge" })?.value ?? "").range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              (items.first(where: { $0.name == "state" })?.value ?? "").range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
        else { throw APIError.invalidResponse }
        return url
    }
    /// Private form submission only. Never insert this input in prompts, history or diagnostics.
    func completeClaudeLogin(code: String) async throws {
        guard !code.isEmpty, code.utf8.count <= 8192 else { throw APIError.invalidResponse }
        let value = try await claudeConnectionJSON(path: "/v1/credentials/claude/login/complete", method: "POST", body: .object(["code": .string(code)]))
        guard value["state"].string == "authenticated" else { throw APIError.invalidResponse }
    }
    func disconnectClaude() async throws {
        let value = try await claudeConnectionJSON(path: "/v1/credentials/claude", method: "DELETE")
        guard value["state"].string == "signed_out", value["connected"] == .bool(false) else { throw APIError.invalidResponse }
    }
}
