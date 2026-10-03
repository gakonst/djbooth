import Foundation

/// Missing preparation metadata is never interpreted as a prepared decision.
public enum TodoPreparationState: String, Sendable {
    case unprepared, pending, preparing, ready, blocked, failed, parked
    public var title: String {
        switch self { case .unprepared: return "Not prepared"; case .pending: return "Pending"; case .preparing: return "Preparing"; case .ready: return "Ready to review"; case .blocked: return "Blocked"; case .failed: return "Preparation failed"; case .parked: return "Parked" }
    }
    public init(serverValue: String) { self = Self(rawValue: serverValue) ?? .unprepared }
}

/// Approval is for the complete, persisted and visible version, not an ID alone.
public enum TodoDecisionApproval {
    /// Cached metadata can be rendered, but authority requires a fresh detail read.
    public static func matches(reviewed: TodoDecision, current: TodoDecision) -> Bool {
        reviewed.isPreparedForReview && current.isPreparedForReview && reviewed == current
    }

    /// A locally acknowledged edit may advance only the same bound draft. Every
    /// decision/preparation field (including target version and preparation
    /// timestamp) remains unchanged; the current draft must be the exact edit
    /// shown and acknowledged by this session, not an arbitrary remote update.
    public static func matches(reviewed: TodoDecision, current: TodoDecision, acknowledgedDraft: TodoMailDraft) -> Bool {
        guard reviewed.isPreparedForReview, current.isPreparedForReview,
              reviewed.preparedDraft?.id == acknowledgedDraft.id,
              TodoDraftApproval.matches(reviewed: acknowledgedDraft, current: current.preparedDraft) else { return false }
        var boundContext = current
        boundContext.preparedDraft = reviewed.preparedDraft
        return reviewed == boundContext
    }
}

public enum TodoDraftApproval {
    public static func matches(reviewed: TodoMailDraft, current: TodoMailDraft?) -> Bool {
        guard let current, reviewed.version > 0, !reviewed.isLocked, !current.isLocked else { return false }
        return reviewed == current
    }
}

public extension TodoDecision {
    var isPreparedForReview: Bool {
        guard status == "needs_you", preparationState == .ready, !recommendation.isEmpty else { return false }
        if let draft = preparedDraft {
            return draft.version > 0 && !draft.isLocked && !draft.bodyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && !draft.to.isEmpty && draft.to.allSatisfy { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                && (draft.mode == .reply || draft.mode == .replyAll) && sourceMessageID != nil && sourceMessageID == draft.replyMessageID
                && sourceConnectionID == draft.connectionID
                && sourceThreadID == draft.threadID
        }
        // Email decisions cannot fall back to a textual proposal send control.
        return !proposal.isEmpty && (preparationKind == "action_review" || (sourceConnectionID == nil && sourceThreadID == nil))
    }
}

public struct TodoPreparationSource: Codable, Equatable, Sendable {
    public let kind: String
    public let reference: String
    public let detail: String
    public init(_ json: JSON) { kind = json["kind"].string; reference = json["reference"].string; detail = json["detail"].string }
}

public extension ManagedClient {
    func todoDecision(id: String) async throws -> TodoDecision {
        guard let target = UUID(uuidString: id) else { throw APIError.invalidResponse }
        return try TodoDecision(await json(path: "/v1/todo/decisions/\(target.uuidString.lowercased())")["decision"])
    }
    func prepareTodo(kind: String, id: String, version: Int, instructions: String, operationID: UUID) async throws {
        guard ["items", "decisions"].contains(kind), let target = UUID(uuidString: id), version > 0,
              !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw APIError.invalidResponse }
        _ = try await json(path: "/v1/todo/\(kind)/\(target.uuidString.lowercased())/prepare", method: "POST", body: .object([
            "version": .number(Double(version)), "text": .string(instructions),
            "operation_id": .string(operationID.uuidString.lowercased())
        ]), idempotencyKey: operationID.uuidString.lowercased())
    }
}

/// Identity links come from the deterministic account CRM registry, never from
/// generated prose. Cached links are context, not fresh approval authority.
public struct TodoLinkedPerson: Identifiable, Codable, Equatable, Sendable {
    public var id: String { recordID }
    public let recordID: String
    public let name: String
    public let email: String
    public let title: String
    public let company: String
    public let summary: String
    public let match: String
    public let sources: [TodoPreparationSource]
    public let timeline: [TodoPersonTimelineEntry]
    public let relationships: [String]
    public init?(_ json: JSON) {
        let record = json["record_id"].string, match = json["match"].string
        guard !record.isEmpty, ["exact_email", "exact_alias"].contains(match),
              json["sources"].array.contains(where: { $0["kind"].string == "crm_record" && $0["reference"].string == record }) else { return nil }
        recordID = record; self.match = match
        name = json["name"].string; email = json["email"].string
        title = json["title"].string; company = json["company"].string; summary = json["summary"].string
        sources = json["sources"].array.prefix(8).map(TodoPreparationSource.init)
        timeline = json["timeline"].array.prefix(3).map(TodoPersonTimelineEntry.init)
        relationships = json["relationships"].array.prefix(3).map { $0["description"].string.isEmpty ? $0["type"].string + ($0["role"].string.isEmpty ? "" : " · " + $0["role"].string) : $0["description"].string }
    }
}
public struct TodoPersonTimelineEntry: Codable, Equatable, Sendable {
    public let text: String
    public let occurredAt: String
    public let timestampBasis: String
    public let sources: [TodoPreparationSource]
    public init(_ json: JSON) { text = json["text"].string; occurredAt = json["occurred_at"].string; timestampBasis = json["timestamp_basis"].string; sources = json["sources"].array.map(TodoPreparationSource.init) }
}
public struct TodoPeopleContext: Codable, Equatable, Sendable {
    public let people: [TodoLinkedPerson]
    public let status: String
    public let coverageReasons: [String]
    public let checkedAt: String
    public init(_ json: JSON) {
        people = json["people"].array.prefix(6).compactMap(TodoLinkedPerson.init)
        status = json["people_status"].string.isEmpty ? "unknown" : json["people_status"].string
        coverageReasons = json["people_coverage"]["reasons"].array.prefix(8).map(\.string)
        checkedAt = json["people_coverage"]["checked_at"].string
    }
    public var referenceSnapshot: JSON {
        guard let data = try? JSONEncoder().encode(self), let value = try? JSONDecoder().decode(JSON.self, from: data) else { return .null }
        return value
    }
}
