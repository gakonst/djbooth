import Foundation

/// Only signed URLs live here; media bytes never enter this cache. Each CloudClient
/// owns its own instance, so credentials and endpoints cannot share cached results.
actor SoundCloudStreamCache {
    struct Key: Hashable, Sendable {
        let sourceID: String
        let accountID: String
        let trackID: String
    }
    private struct Entry {
        let id: UUID
        let task: Task<URL, Error>
        let createdAt: TimeInterval
        var expiresAt: TimeInterval?
    }
    private var entries: [Key: Entry] = [:]
    private var generation = UUID()
    private let lifetime: TimeInterval
    private let capacity: Int
    private let now: @Sendable () -> TimeInterval
    private let wallTime: @Sendable () -> TimeInterval
    init(lifetime: TimeInterval = 120, capacity: Int = 32,
         now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
         wallTime: @escaping @Sendable () -> TimeInterval = { Date().timeIntervalSince1970 }) {
        self.lifetime = lifetime; self.capacity = max(1, capacity); self.now = now; self.wallTime = wallTime
    }
    func invalidate(_ key: Key) { entries.removeValue(forKey: key)?.task.cancel() }
    func clear() {
        generation = UUID()
        for entry in entries.values { entry.task.cancel() }
        entries.removeAll()
    }
    func value(for key: Key, load: @escaping @Sendable () async throws -> URL,
               validate: @escaping @Sendable () async throws -> Void) async throws -> URL {
        let time = now(), request = generation
        entries = entries.filter { $0.value.expiresAt.map { $0 > time } ?? true }
        if let entry = entries[key] {
            // Includes callers joining an in-flight prewarm: they do not inherit
            // an earlier caller's authorization decision.
            do { try await validate() }
            catch {
                if !Task.isCancelled { reject(error, key: key, id: entry.id) }
                throw error
            }
            let value: URL
            do { value = try await entry.task.value }
            catch { reject(error, key: key, id: entry.id); throw error }
            try Task.checkCancellation()
            guard request == generation, !entry.task.isCancelled else { throw CancellationError() }
            return value
        }
        if entries.count >= capacity, let oldest = entries.min(by: { $0.value.createdAt < $1.value.createdAt })?.key {
            entries.removeValue(forKey: oldest)?.task.cancel()
        }
        let id = UUID(), task = Task { try await load() }
        entries[key] = Entry(id: id, task: task, createdAt: time)
        let value: URL
        do { value = try await task.value }
        catch { reject(error, key: key, id: id); throw error }
        guard request == generation, !task.isCancelled else { throw CancellationError() }
        if entries[key]?.id == id {
            let ttl = Self.lifetime(for: value, wallTime: wallTime(), maximum: lifetime)
            if ttl > 0 { entries[key]?.expiresAt = now() + ttl }
            else { entries.removeValue(forKey: key) }
        }
        // A canceled waiter must not discard a successful shared resolution.
        try Task.checkCancellation()
        return value
    }
    /// CloudFront policy metadata only limits reuse; it never grants access.
    /// URL allowlisting and fresh connector authorization remain separate checks.
    static func lifetime(for url: URL, wallTime: TimeInterval, maximum: TimeInterval = 120) -> TimeInterval {
        let fields = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let expires = fields.filter { $0.name == "Expires" }
        let policies = fields.filter { $0.name == "Policy" }
        guard expires.count <= 1, policies.count <= 1 else { return 0 }
        var deadlines: [TimeInterval] = []
        if let field = expires.first {
            guard let text = field.value, let value = TimeInterval(text), value.isFinite, value > 0 else { return 0 }
            deadlines.append(value)
        }
        if let field = policies.first {
            guard let text = field.value, !text.isEmpty, text.utf8.count <= 8192 else { return 0 }
            // CloudFront's URL-safe alphabet differs from standard base64url.
            var encoded = text.replacingOccurrences(of: "-", with: "+")
                .replacingOccurrences(of: "_", with: "=").replacingOccurrences(of: "~", with: "/")
            if encoded.count % 4 != 0 { encoded += String(repeating: "=", count: 4 - encoded.count % 4) }
            guard let data = Data(base64Encoded: encoded), let policy = try? JSONDecoder().decode(SignedPolicy.self, from: data),
                  !policy.statements.isEmpty else { return 0 }
            for statement in policy.statements {
                let expiration = statement.condition.expiry.epoch
                guard expiration.isFinite, expiration > 0 else { return 0 }
                deadlines.append(expiration)
            }
        }
        guard let expiration = deadlines.min() else { return max(0, min(maximum, 60)) }
        return max(0, min(maximum, expiration - wallTime - 60))
    }
    private struct SignedPolicy: Decodable {
        let statements: [Statement]
        enum CodingKeys: String, CodingKey { case statements = "Statement" }
        struct Statement: Decodable {
            let condition: Condition
            enum CodingKeys: String, CodingKey { case condition = "Condition" }
        }
        struct Condition: Decodable {
            let expiry: Expiry
            enum CodingKeys: String, CodingKey { case expiry = "DateLessThan" }
        }
        struct Expiry: Decodable {
            let epoch: TimeInterval
            enum CodingKeys: String, CodingKey { case epoch = "AWS:EpochTime" }
        }
    }
    private func reject(_ error: Error, key: Key, id: UUID) {
        if case ClientError.http(let status, _) = error, status == 401 || status == 403 {
            clear()
        } else if entries[key]?.id == id { entries.removeValue(forKey: key) }
    }
}
