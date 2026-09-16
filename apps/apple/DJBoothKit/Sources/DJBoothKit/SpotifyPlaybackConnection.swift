import Foundation

/// Shares the saved-credential handshake between browsing and an actual play tap.
@MainActor public final class SpotifyPlaybackConnection {
    public private(set) var connectedKey: String?
    public private(set) var pendingKey: String?
    private var pending: Task<Void, Error>?
    private var generation = UUID()
    public init() {}

    public func reset() {
        generation = UUID(); pending?.cancel(); pending = nil
        pendingKey = nil; connectedKey = nil
    }

    /// An explicit interactive authorization has already checked cancellation
    /// and committed its credentials; subsequent playback can reuse that session.
    public func adopt(key: String) { reset(); connectedKey = key }

    public func connect(key: String, operation: @escaping @MainActor () async throws -> String,
                        save: @escaping @MainActor (String) throws -> Void) async throws {
        if connectedKey == key { return }
        if pendingKey == key, let pending { try await pending.value; return }
        reset()
        let request = generation
        pendingKey = key
        let task = Task { @MainActor in
            let credentials = try await operation()
            try Task.checkCancellation()
            guard generation == request else { throw CancellationError() }
            try save(credentials)
            connectedKey = key
        }
        pending = task
        defer { if generation == request { pending = nil; pendingKey = nil } }
        try await task.value
    }
}
