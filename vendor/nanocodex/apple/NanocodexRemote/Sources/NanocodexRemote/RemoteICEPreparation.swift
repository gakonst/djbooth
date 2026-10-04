import Foundation

/// Publication-scoped prefetch. Never outlives its host/account or the five-minute
/// reuse window; peer ICE restarts still fetch fresh credentials independently.
@MainActor final class RemoteICEPreparation {
    private var load: (@Sendable () async throws -> [RemoteICE])?
    private var pending: (id: UUID, started: ContinuousClock.Instant, task: Task<[RemoteICE], Error>)?
    private var generation = UUID()
    var now: () -> ContinuousClock.Instant = { ContinuousClock.now }
    private let maxAge: Duration = .seconds(5 * 60)

    func start(_ load: @escaping @Sendable () async throws -> [RemoteICE]) {
        reset(); self.load = load; prepare()
    }

    func reset() {
        generation = UUID(); pending?.task.cancel(); pending = nil; load = nil
    }

    private func prepare() {
        guard let load else { return }
        let id = UUID()
        let task = Task { [weak self] in
            do {
                try Task.checkCancellation()
                return try await load()
            }
            catch {
                if self?.pending?.id == id { self?.pending = nil }
                throw error
            }
        }
        pending = (id, now(), task)
    }

    func value() async throws -> [RemoteICE] {
        if let pending, pending.started.duration(to: now()) >= maxAge {
            pending.task.cancel(); self.pending = nil
        }
        if pending == nil { prepare() }
        guard let pending else { throw RemoteError.closed }
        let attempt = generation
        let value = try await pending.task.value
        try Task.checkCancellation()
        guard generation == attempt else { throw CancellationError() }
        return value
    }
}
