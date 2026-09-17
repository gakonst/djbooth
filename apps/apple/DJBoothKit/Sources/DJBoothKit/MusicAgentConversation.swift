import Foundation

public struct MusicAgentMessage: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let role: String
    public let text: String
    public let createdAt: Date
    public init(id: String = UUID().uuidString, role: String, text: String, createdAt: Date = .now) {
        self.id = id; self.role = role; self.text = text; self.createdAt = createdAt
    }
}

/// Offline cache of the grant-bound server conversation. Pending turn IDs are
/// persisted before submission so relaunches reuse the server's idempotency key.
public struct MusicAgentConversation: Codable, Equatable, Sendable {
    public var messages: [MusicAgentMessage]
    public var agentID: String?
    public var nextBefore: String?
    public var draft: String
    public var pendingID: String?
    public var pendingInput: String?
    public init(messages: [MusicAgentMessage] = [], draft: String = "", pendingID: String? = nil, pendingInput: String? = nil, agentID: String? = nil, nextBefore: String? = nil) {
        self.agentID = agentID; self.nextBefore = nextBefore
        self.messages = messages; self.draft = draft
        self.pendingID = pendingID; self.pendingInput = pendingInput
    }

    /// Call only after a status 404 and a successful refresh of this agent's
    /// history. Never resubmit an accepted request whose outcome is unknown.
    @discardableResult public mutating func recoverMissingTurn(_ id: String) -> Bool {
        guard pendingID == id, pendingInput == nil else { return false }
        if !messages.contains(where: { $0.id == "assistant:\(id)" || $0.id == "status:\(id)" }) {
            messages.append(MusicAgentMessage(id: "status:\(id)", role: "Status",
                text: "The previous request is no longer available. Its outcome is unknown; check your library or import status before repeating it. You can send a new message."))
        }
        pendingID = nil
        return true
    }

    /// The broker's returned ID is authoritative, including after an
    /// idempotent submission. Keep the optimistic message and polling aligned.
    public mutating func acceptTurn(_ serverID: String) {
        guard let previous = pendingID else { return }
        if previous != serverID {
            messages = messages.map { message in
                guard message.id == "user:\(previous)" else { return message }
                return MusicAgentMessage(id: "user:\(serverID)", role: message.role,
                                         text: message.text, createdAt: message.createdAt)
            }
        }
        pendingID = serverID
        pendingInput = nil
    }
}

public struct MusicAgentHistory: Decodable, Sendable {
    public struct Message: Decodable, Sendable {
        public let id: String
        public let role: String
        public let text: String
        public let timestamp: Double
    }
    public let agentID: String
    public let messages: [Message]
    public let nextBefore: String?

    /// Server messages replace cached copies, including their canonical timestamps.
    public func merging(_ cached: [MusicAgentMessage]) -> [MusicAgentMessage] {
        var byID = Dictionary(cached.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        for message in messages {
            byID[message.id] = MusicAgentMessage(id: message.id, role: message.role, text: message.text,
                                               createdAt: Date(timeIntervalSince1970: message.timestamp))
        }
        return byID.values.sorted {
            if $0.createdAt != $1.createdAt { return $0.createdAt < $1.createdAt }
            let roles = ["You": 0, "DJ Booth": 1, "Status": 2]
            if $0.role != $1.role { return (roles[$0.role] ?? 3) < (roles[$1.role] ?? 3) }
            return $0.id < $1.id
        }
    }
}
