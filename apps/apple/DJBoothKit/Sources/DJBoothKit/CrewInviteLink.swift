import Foundation

/// Only accepts invitations for this installation's cloud, never an arbitrary login host.
public struct CrewInviteLink: Identifiable, Equatable, Sendable {
    public static let productionURL = "https://djbooth-library.gakonst.workers.dev"
    public let token: String
    public let url: URL
    public var id: String { url.absoluteString }

    public init?(_ value: String, endpoint: URL) {
        let value = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let token: String
        if Self.validToken(value) { token = value }
        else {
            guard let parts = URLComponents(string: value), parts.user == nil, parts.password == nil,
                  parts.query == nil, parts.fragment == nil else { return nil }
            let path = parts.path.split(separator: "/", omittingEmptySubsequences: false)
            if parts.scheme == "djbooth", parts.host == "join", parts.port == nil,
               path.count == 2, endpoint.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) == Self.productionURL {
                token = String(path[1])
            } else {
                guard parts.scheme == endpoint.scheme, parts.host == endpoint.host, parts.port == endpoint.port,
                      path.count == 3, path[1] == "join" else { return nil }
                token = String(path[2])
            }
        }
        guard Self.validToken(token) else { return nil }
        self.token = token
        self.url = endpoint.appendingPathComponent("join").appendingPathComponent(token)
    }

    private static func validToken(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil
    }
}

public struct CrewInvitePreview: Codable, Sendable, Equatable {
    public var crewName: String
    public var role: CrewRole
    public var expiresAt: Int
}
