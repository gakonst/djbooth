import Foundation

public struct TodoMailAccount: Identifiable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let email: String
    public init(_ json: JSON) throws {
        id = json["connection_id"].string
        guard !id.isEmpty else { throw APIError.invalidResponse }
        label = json["label"].string; email = json["email"].string
    }
}

public struct TodoMailThreadSummary: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let connectionID: String
    public let subject: String
    public let sender: String
    public let snippet: String
    public let updatedAt: Date
    public let isUnread: Bool
    public let messageCount: Int
    public let inInbox: Bool?
    /// Optional so retained summaries written before CRM enrichment still decode.
    public let peopleContext: TodoPeopleContext?
    public init(_ json: JSON) throws {
        id = json["id"].string; connectionID = json["connection_id"].string
        guard !id.isEmpty, !connectionID.isEmpty else { throw APIError.invalidResponse }
        subject = json["subject"].string; sender = json["from"].string; snippet = json["snippet"].string
        updatedAt = todoDate(json["date"].string) ?? .distantPast
        if case .bool(let inbox) = json["in_inbox"] { inInbox = inbox } else { inInbox = nil }
        isUnread = json["unread"].bool; messageCount = Int(exactly: json["message_count"].number) ?? 1
        if case .array = json["people"] { peopleContext = TodoPeopleContext(json) }
        else { peopleContext = nil }
    }
}
public struct TodoMailPage: Sendable {
    public let threads: [TodoMailThreadSummary]
    public let nextPageToken: String?
}

public struct TodoMeetingEvidence: Equatable, Sendable {
    public let text: String
    public let kind: String
    public let reference: String
    public init(_ json: JSON) {
        text = json["text"].string; kind = json["source"]["kind"].string; reference = json["source"]["reference"].string
    }
}
public struct TodoMeetingAttendee: Equatable, Sendable {
    public let name: String
    public let email: String
    public let responseStatus: String
    /// Linked only by the bounded exact CRM email/alias registry, never by name.
    public let personID: String?
    public let peopleStatus: String
    public let context: [TodoMeetingEvidence]
    public init(_ json: JSON) {
        name = json["name"].string; email = json["email"].string; responseStatus = json["response_status"].string
        peopleStatus = json["people_status"].string
        let candidate = json["person_id"].string
        let matched = json["people"].array.contains {
            $0["record_id"].string == candidate && ["exact_email", "exact_alias"].contains($0["match"].string)
        }
        personID = !candidate.isEmpty && matched ? candidate : nil
        context = json["context"].array.map(TodoMeetingEvidence.init)
    }
}
public struct TodoScheduleEvent: Identifiable, Equatable, Sendable {
    /// A provider event ID is unique only within an account and calendar.
    public var id: String { [connectionID, calendarID, eventID].map { "\($0.utf8.count):\($0)" }.joined() }
    public let eventID: String
    public let connectionID: String
    public let calendarID: String
    public let title: String
    public let startAt: Date
    public let endAt: Date
    public let isAllDay: Bool
    public let location: String
    public let details: String
    public let url: URL?
    public let briefing: String
    public let briefingScope: String
    public let attendees: [TodoMeetingAttendee]
    public let coverageReasons: [String]
    public let briefingState: TodoPreparationState
    public init(_ json: JSON) throws {
        eventID = json["id"].string; connectionID = json["connection_id"].string; calendarID = json["calendar_id"].string
        guard !eventID.isEmpty, !connectionID.isEmpty, !calendarID.isEmpty, let start = todoDate(json["start"].string), let end = todoDate(json["end"].string) else { throw APIError.invalidResponse }
        title = json["title"].string; startAt = start; endAt = end; isAllDay = json["all_day"].bool
        location = json["location"].string; details = json["description"].string
        briefing = json["briefing"].string
        briefingScope = json["briefing_scope"].string
        attendees = json["prepared_briefing"]["attendees"].array.map(TodoMeetingAttendee.init)
        coverageReasons = json["prepared_briefing"]["coverage"]["reasons"].array.map(\.string)
        briefingState = TodoPreparationState(serverValue: json["briefing_status"].string)
        let link = URL(string: json["html_url"].string)
        url = link?.scheme == "https" && link?.host != nil && link?.user == nil && link?.password == nil ? link : nil
    }
}
public struct TodoSchedule: Sendable {
    public let events: [TodoScheduleEvent]
    public let partial: Bool
    public init(_ json: JSON) throws {
        guard case .array(let events) = json["events"] else { throw APIError.invalidResponse }
        let briefings = json["briefings"].array
        self.events = try events.map { event in
            guard case .object(var fields) = event else { throw APIError.invalidResponse }
            if let briefing = briefings.first(where: {
                $0["source"]["connection_id"].string == event["connection_id"].string &&
                $0["source"]["calendar_id"].string == event["calendar_id"].string &&
                $0["source"]["event_id"].string == event["id"].string
            }) { fields["prepared_briefing"] = briefing }
            return try TodoScheduleEvent(.object(fields))
        }
        partial = json["partial"].bool
    }
}
private func todoDate(_ text: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: text) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    if let date = formatter.date(from: text) { return date }
    // Google all-day values have no timezone; display them on the local calendar day.
    let day = DateFormatter(); day.calendar = Calendar(identifier: .gregorian)
    day.locale = Locale(identifier: "en_US_POSIX"); day.dateFormat = "yyyy-MM-dd"; day.isLenient = false
    return day.date(from: text)
}
private func todoQuery(_ values: [String: String]) -> String {
    var components = URLComponents()
    components.queryItems = values.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
    return "?" + (components.percentEncodedQuery ?? "")
}
public extension ManagedClient {
    func todoMailAccounts() async throws -> [TodoMailAccount] {
        let response = try await json(path: "/v1/todo/mail/accounts")
        guard case .array(let accounts) = response["accounts"] else { throw APIError.invalidResponse }
        return try accounts.map(TodoMailAccount.init)
    }
    /// Possibly stale retained account roster; never authorizes a mutation.
    func cachedTodoMailAccounts() async -> [TodoMailAccount]? {
        guard let response = await cachedJSON(path: "/v1/todo/mail/accounts"), case .array(let accounts) = response["accounts"] else { return nil }
        return try? accounts.map(TodoMailAccount.init)
    }
    /// First-page/continuation snapshots are keyed by exact account and query.
    func cachedTodoMailThreads(connectionID: String, query: String, pageToken: String? = nil) async -> TodoMailPage? {
        var values = ["connection_id": connectionID, "q": query]
        values["page_token"] = pageToken
        guard let response = await cachedJSON(path: "/v1/todo/mail/threads" + todoQuery(values)),
              case .array(let threads) = response["threads"], let parsed = try? threads.map(TodoMailThreadSummary.init),
              parsed.allSatisfy({ $0.connectionID == connectionID }) else { return nil }
        return TodoMailPage(threads: parsed, nextPageToken: response["next_page_token"].string.isEmpty ? nil : response["next_page_token"].string)
    }
    func todoMailThreads(connectionID: String, query: String, pageToken: String? = nil) async throws -> TodoMailPage {
        var values = ["connection_id": connectionID, "q": query]
        values["page_token"] = pageToken
        let response = try await json(path: "/v1/todo/mail/threads" + todoQuery(values))
        guard case .array(let threads) = response["threads"] else { throw APIError.invalidResponse }
        let parsed = try threads.map(TodoMailThreadSummary.init)
        guard parsed.allSatisfy({ $0.connectionID == connectionID }) else { throw APIError.invalidResponse }
        return TodoMailPage(threads: parsed, nextPageToken: response["next_page_token"].string.isEmpty ? nil : response["next_page_token"].string)
    }
    func todoMailSummary(connectionID: String, threadID: String) async throws -> TodoMailThreadSummary {
        guard let id = threadID.addingPercentEncoding(withAllowedCharacters: .alphanumerics), !id.isEmpty else { throw APIError.invalidResponse }
        let response = try await json(path: "/v1/todo/mail/threads/" + id + todoQuery(["connection_id": connectionID, "format": "metadata"]))
        return try TodoMailThreadSummary(response["summary"])
    }
    func todoSchedule(briefingsOnly: Bool = false) async throws -> TodoSchedule {
        let response = try await json(path: "/v1/todo/schedule" + (briefingsOnly ? "?briefings_only=true" : ""))
        return try TodoSchedule(response)
    }
    func modifyTodoMailThread(connectionID: String, threadID: String, archive: Bool? = nil, unread: Bool? = nil) async throws {
        guard let id = threadID.addingPercentEncoding(withAllowedCharacters: .alphanumerics), !id.isEmpty else { throw APIError.invalidResponse }
        var fields: [String: JSON] = ["connection_id": .string(connectionID)]
        if let archive { fields["archive"] = .bool(archive) }
        if let unread { fields["unread"] = .bool(unread) }
        _ = try await json(path: "/v1/todo/mail/threads/" + id + "/modify", method: "POST", body: .object(fields))
    }
}
