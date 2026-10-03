import Foundation
import CryptoKit

public struct TodoDisposition: Codable, Equatable, Sendable {
    public let rowKey: String
    public let until: Double?
    public let version: Int
    public init(_ json: JSON) throws {
        guard !json["row_key"].string.isEmpty, case .number(let rawVersion) = json["version"], let version = Int(exactly: rawVersion), version >= 0 else { throw APIError.invalidResponse }
        rowKey = json["row_key"].string; self.version = version
        if json["until"] == .null { until = nil }
        else { guard case .number(let value) = json["until"], value.isFinite, value >= 0 else { throw APIError.invalidResponse }; until = value / 1000 }
    }
}
public struct TodoSnoozeCommand: Codable, Equatable, Sendable {
    public let rowKey: String
    public let until: Double?
    public let version: Int
    public let operationID: UUID
    public init(rowKey: String, until: Double?, version: Int, operationID: UUID = UUID()) { self.rowKey = rowKey; self.until = until; self.version = version; self.operationID = operationID }
}
public struct InboxSnoozeState: Codable, Sendable {
    public var snoozed: [String: Double]
    public var versions: [String: Int]
    public var commands: [TodoSnoozeCommand]
    public init(snoozed: [String: Double], versions: [String: Int], commands: [TodoSnoozeCommand]) { self.snoozed = snoozed; self.versions = versions; self.commands = commands }
}
/// Account-qualified atomic presentation journal. No credentials or mail bodies.
/// Persist the exact operation before dispatch; uncertain retries reuse its UUID.
public actor InboxSnoozeJournal {
    private let url: URL
    private var disabled = false
    public init(scope: String, root: URL? = nil) {
        let name = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
        url = (root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!)
            .appendingPathComponent("InboxPresentation", isDirectory: true).appendingPathComponent(name + ".json")
    }
    public func load() throws -> InboxSnoozeState? {
        guard !disabled else { throw CancellationError() }
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try JSONDecoder().decode(InboxSnoozeState.self, from: Data(contentsOf: url))
    }
    public func save(_ state: InboxSnoozeState) throws {
        guard !disabled else { throw CancellationError() }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(state)
        guard data.count <= 2 * 1024 * 1024 else { throw APIError.invalidResponse }
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: .atomic)
        #endif
        var directory = url.deletingLastPathComponent(); var values = URLResourceValues(); values.isExcludedFromBackup = true
        try? directory.setResourceValues(values)
    }
    public func clear() throws { disabled = true; if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) } }
}
public extension ManagedClient {
    func snoozeTodo(_ command: TodoSnoozeCommand) async throws -> TodoDisposition {
        let result = try await json(path: "/v1/todo/snooze", method: "POST", body: .object([
            "row_key": .string(command.rowKey), "until": command.until.map { .number(($0 * 1000).rounded()) } ?? .null,
            "version": .number(Double(command.version)), "operation_id": .string(command.operationID.uuidString.lowercased()),
        ]), idempotencyKey: command.operationID.uuidString.lowercased())
        let receipt = try TodoDisposition(result["disposition"])
        guard receipt.rowKey == command.rowKey, receipt.version == command.version + 1,
              receipt.until == command.until.map({ ($0 * 1000).rounded() / 1000 }) else { throw APIError.invalidResponse }
        return receipt
    }
}
