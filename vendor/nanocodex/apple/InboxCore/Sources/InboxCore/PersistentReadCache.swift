import Foundation
import CryptoKit

/// Application-owned snapshots, independent of HTTP freshness and no-store.
/// Only presentation GETs are admitted; auth and action responses never enter disk.
final class PersistentReadCache: @unchecked Sendable {
    private static let registryLock = NSLock()
    private static var stores: [String: PersistentReadCache] = [:]
    private let lock = NSLock()
    private let directory: URL
    private var generation: UInt64 = 0
    private var lastClearGeneration: UInt64 = 0

    static func scoped(to credential: AccountCredential) -> PersistentReadCache {
        let key = digest(credential.origin + "\n" + credential.apiKey)
        registryLock.lock(); defer { registryLock.unlock() }
        if let existing = stores[key] { return existing }
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let store = PersistentReadCache(directory: base.appendingPathComponent("NanocodexSnapshots/" + key))
        stores[key] = store
        return store
    }

    init(directory: URL) { self.directory = directory }
    private static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    static func allows(_ path: String) -> Bool {
        let endpoint = String(path.split(separator: "?", maxSplits: 1).first ?? "")
        if ["/v1/agents", "/v1/todo", "/v1/todo/schedule", "/v1/crm", "/v1/connectors", "/v1/connectors/catalog", "/v1/connectors/mcp-connections"].contains(endpoint) { return true }
        if endpoint.hasPrefix("/v1/crm/") { return true }
        // Mail snapshots are presentation only. Draft/status/decision/attachment
        // reads are deliberately excluded: disk never grants approval authority.
        if endpoint == "/v1/todo/mail/accounts" { return true }
        if endpoint == "/v1/todo/mail/threads" || (endpoint.hasPrefix("/v1/todo/mail/threads/") && endpoint.split(separator: "/").count == 5) {
            guard let components = URLComponents(string: path),
                  let connection = components.queryItems?.first(where: { $0.name == "connection_id" })?.value,
                  !connection.isEmpty else { return false }
            return true
        }
        let parts = endpoint.split(separator: "/")
        return parts.count >= 4 && parts[0] == "v1" && parts[1] == "agents"
            && ((parts.count == 4 && parts[3] == "triggers")
                || (parts.count == 5 && parts[3] == "events" && parts[4] == "history"))
    }
    private static func family(_ path: String) -> String {
        let endpoint = path.split(separator: "?", maxSplits: 1).first ?? ""
        let parts = endpoint.split(separator: "/")
        guard parts.count >= 2 else { return "unknown" }
        if parts.count >= 4, parts[1] == "todo", parts[2] == "mail" {
            if parts[3] == "accounts" { return "todo-mail-accounts" }
            return parts.count == 4 ? "todo-mail-list" : "todo-mail-thread"
        }
        if parts[1] == "agents" {
            guard parts.count > 2 else { return "agents-roster" }
            return "agent-" + digest(String(parts[2])) + (parts.count > 3 && parts[3] == "triggers" ? "-triggers" : "-history")
        }
        return String(parts[1])
    }
    private func file(_ path: String) -> URL {
        directory.appendingPathComponent(Self.family(path) + "-" + Self.digest(path))
    }
    func invalidate(path: String, method: String = "POST") {
        let endpoint = path.split(separator: "?", maxSplits: 1).first ?? ""
        let parts = endpoint.split(separator: "/")
        guard parts.count >= 2 else { return }
        let prefixes: [String]
        if parts[1] == "agents" {
            if parts.count == 2 && method == "POST" { return } // Keep the usable roster until the next list refresh.
            else if parts.count == 3 && method == "DELETE" {
                prefixes = ["agent-" + Self.digest(String(parts[2])) + "-"]
            } else if parts.count >= 4 && parts[3] == "triggers" {
                prefixes = ["agent-" + Self.digest(String(parts[2])) + "-triggers-"]
            } else { return } // Sending/preparing a turn preserves saved history.
        } else if parts.count >= 4, parts[1] == "todo", parts[2] == "mail" {
            // Conservatively evict every query/page after archive, undo or send.
            // Generation fences older reads so relaunch cannot restore pre-write
            // inbox membership. Draft autosaves need not evict retained bodies.
            if parts[3] == "drafts" || parts[3] == "suggest" { return }
            prefixes = ["todo-mail-list-", "todo-mail-thread-"]
        } else if ["crm", "todo", "connectors"].contains(parts[1]) {
            prefixes = [String(parts[1]) + "-"]
        } else { return }
        lock.lock(); defer { lock.unlock() }
        generation &+= 1
        if parts[1] == "agents", parts.count == 3, method == "DELETE",
           let data = try? Data(contentsOf: file("/v1/agents")),
           let value = try? JSONDecoder().decode(JSON.self, from: data), case .object(var roster) = value {
            let id = String(parts[2])
            roster["data"] = .array(value["data"].array.filter { $0.string != id })
            if case .object(var summaries) = value["summaries"] {
                summaries.removeValue(forKey: id); roster["summaries"] = .object(summaries)
            }
            if let revised = try? JSONEncoder().encode(JSON.object(roster)) {
                try? revised.write(to: file("/v1/agents"), options: .atomic)
            }
        }
        for file in (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
            where prefixes.contains(where: { file.lastPathComponent.hasPrefix($0) }) {
            try? FileManager.default.removeItem(at: file)
        }
    }
    /// Preserve transcript/history while updating only acknowledged manual organization.
    @discardableResult
    func applySessionDoneMutation(path: String, method: String, response: JSON, ticket: UInt64, expectedDone: Bool? = nil) -> Bool {
        let parts = path.split(separator: "/")
        guard method == "PUT", parts.count == 4, parts[0] == "v1", parts[1] == "agents", parts[3] == "done" else { return false }
        guard case .bool(let done) = response["done"], expectedDone == nil || done == expectedDone else { return true }
        switch response["presentation_revision"] {
        case .null: break // Compatibility with services without revision metadata.
        case .number(let revision) where revision.isFinite && revision >= 0 && revision.rounded(.down) == revision: break
        default: return true
        }
        if done {
            guard case .number(let at) = response["done_at"], at.isFinite, at >= 0 else { return true }
        } else { guard response["done_at"] == .null else { return true } }
        lock.lock(); defer { lock.unlock() }
        guard ticket >= lastClearGeneration else { return true }
        generation &+= 1 // Older roster requests must not restore pre-write state.
        guard let data = try? Data(contentsOf: file("/v1/agents")),
              let value = try? JSONDecoder().decode(JSON.self, from: data),
              case .object(var roster) = value, case .object(var summaries) = value["summaries"],
              case .object(var summary) = summaries[String(parts[2])] else { return true }
        var presentation: [String: JSON] = [:]
        if case .object(let saved) = summary["presentation"] { presentation = saved }
        if case .number(let revision) = response["presentation_revision"], revision.isFinite, revision >= 0 {
            guard revision >= (presentation["revision"]?.number ?? 0) else { return true }
            presentation["revision"] = .number(revision)
        }
        presentation["done"] = .bool(done); presentation["doneAt"] = response["done_at"]
        summary["presentation"] = .object(presentation); summaries[String(parts[2])] = .object(summary)
        roster["summaries"] = .object(summaries)
        if let revised = try? JSONEncoder().encode(JSON.object(roster)) {
            try? revised.write(to: file("/v1/agents"), options: .atomic)
        }
        return true
    }
    /// Apply acknowledged Todo writes to the saved projection before returning
    /// to the UI. The lock also excludes stale GET admission during the update.
    @discardableResult
    func applyTodoMutation(path: String, method: String, response: JSON, ticket: UInt64) -> Bool {
        guard method == "POST" else { return false }
        let parts = path.split(separator: "/")
        let capture = path == "/v1/todo"
        let decision = parts.count == 5 && parts[0] == "v1" && parts[1] == "todo"
            && parts[2] == "decisions" && parts[4] == "respond"
        guard capture || decision else { return false }
        // Invalid capture replies cannot form a valid projection.
        guard !capture || (try? TodoCapture(response["item"])) != nil else { return true }
        lock.lock(); defer { lock.unlock() }
        guard ticket >= lastClearGeneration else { return true }
        generation &+= 1
        let saved = (try? Data(contentsOf: file("/v1/todo"))).flatMap { try? JSONDecoder().decode(JSON.self, from: $0) }
        var snapshot: [String: JSON]
        if let saved, case .object(let value) = saved, (try? TodoSnapshot(saved)) != nil {
            snapshot = value
        } else if capture {
            snapshot = ["items": .array([]), "decisions": .array([]), "traces": .array([])]
        } else { return true }
        if capture {
            let item = response["item"], id = response["item"]["id"].string
            var items = snapshot["items"]?.array ?? []
            if let index = items.firstIndex(where: { $0["id"].string == id }) { items[index] = item }
            else { items.insert(item, at: 0) }
            snapshot["items"] = .array(items)
        } else {
            let id = String(parts[3]).removingPercentEncoding ?? String(parts[3])
            snapshot["decisions"] = .array((snapshot["decisions"]?.array ?? []).filter { $0["id"].string != id })
        }
        if let data = try? JSONEncoder().encode(JSON.object(snapshot)), data.count <= 32 * 1024 * 1024 {
            writeLocked(data, path: "/v1/todo")
        }
        return true
    }
    func ticket() -> UInt64 { lock.lock(); defer { lock.unlock() }; return generation }
    func read(path: String) -> Data? {
        guard Self.allows(path) else { return nil }
        lock.lock(); defer { lock.unlock() }
        return try? Data(contentsOf: file(path))
    }
    func save(_ data: Data, path: String, ticket: UInt64) {
        guard Self.allows(path), data.count <= 32 * 1024 * 1024 else { return }
        lock.lock(); defer { lock.unlock() }
        guard ticket == generation else { return }
        if path.hasSuffix("/events/history?limit=128"),
           let previousData = try? Data(contentsOf: file(path)),
           let previous = try? JSONDecoder().decode(JSON.self, from: previousData),
           let next = try? JSONDecoder().decode(JSON.self, from: data),
           let previousCursor = Cursor(rawValue: previous["latest_cursor"].string),
           let nextCursor = Cursor(rawValue: next["latest_cursor"].string), previousCursor > nextCursor { return }
        writeLocked(data, path: path)
    }
    /// Caller holds lock; shared admission keeps mutation writes bounded too.
    private func writeLocked(_ data: Data, path: String) {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var excluded = URLResourceValues(); excluded.isExcludedFromBackup = true
            var folder = directory; try folder.setResourceValues(excluded)
            let destination = file(path)
            try data.write(to: destination, options: .atomic)
            #if os(iOS)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: destination.path)
            #endif
            let files = try FileManager.default.contentsOfDirectory(at: directory,
                includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey])
            let entries = files.compactMap { file -> (URL, Int, Date)? in
                guard let values = try? file.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey]) else { return nil }
                return (file, values.fileSize ?? 0, values.contentModificationDate ?? .distantPast)
            }.sorted { $0.2 < $1.2 }
            var total = entries.reduce(0) { $0 + $1.1 }
            var count = entries.count
            for entry in entries where (total > 64 * 1024 * 1024 || count > 512) && entry.0.lastPathComponent != file("/v1/agents").lastPathComponent {
                try FileManager.default.removeItem(at: entry.0); total -= entry.1; count -= 1
            }
        } catch { /* Cache failures never fail the successful server operation. */ }
    }
    func clear() {
        lock.lock(); defer { lock.unlock() }
        generation &+= 1
        lastClearGeneration = generation
        try? FileManager.default.removeItem(at: directory)
    }
}
