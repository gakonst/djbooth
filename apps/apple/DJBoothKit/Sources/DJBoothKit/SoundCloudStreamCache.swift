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
    init(lifetime: TimeInterval = 15, capacity: Int = 32,
         now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }) {
        self.lifetime = lifetime; self.capacity = max(1, capacity); self.now = now
    }
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
            do {
                // Includes callers joining an in-flight prewarm: they do not inherit
                // an earlier caller's authorization decision.
                try await validate()
                let value = try await entry.task.value
                try Task.checkCancellation()
                guard request == generation else { throw CancellationError() }
                return value
            } catch {
                reject(error, key: key, id: entry.id)
                throw error
            }
        }
        if entries.count >= capacity, let oldest = entries.min(by: { $0.value.createdAt < $1.value.createdAt })?.key {
            entries.removeValue(forKey: oldest)?.task.cancel()
        }
        let id = UUID(), task = Task { try await load() }
        entries[key] = Entry(id: id, task: task, createdAt: time)
        do {
            let value = try await task.value
            guard request == generation else { throw CancellationError() }
            if entries[key]?.id == id { entries[key]?.expiresAt = now() + lifetime }
            try Task.checkCancellation()
            return value
        } catch {
            reject(error, key: key, id: id)
            throw error
        }
    }
    private func reject(_ error: Error, key: Key, id: UUID) {
        if case ClientError.http(let status, _) = error, status == 401 || status == 403 {
            clear()
        } else if !(error is CancellationError), entries[key]?.id == id { entries.removeValue(forKey: key) }
    }
}
