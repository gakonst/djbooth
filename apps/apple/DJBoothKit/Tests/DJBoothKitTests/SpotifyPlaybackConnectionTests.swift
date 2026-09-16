import Foundation
import Testing
@testable import DJBoothKit

@MainActor private final class ConnectionGate {
    var continuation: CheckedContinuation<String, Never>?
    var calls = 0
    func connect() async -> String {
        calls += 1
        return await withCheckedContinuation { continuation = $0 }
    }
    func ready() async { while continuation == nil { await Task.yield() } }
    func finish() { continuation?.resume(returning: "refreshed"); continuation = nil }
}

@MainActor struct SpotifyPlaybackConnectionTests {
    @Test func browseAndPlayShareHandshakeAndSaveOnce() async throws {
        let state = SpotifyPlaybackConnection(), gate = ConnectionGate()
        var saves = 0
        let warm = Task { try await state.connect(key: "account", operation: { await gate.connect() }, save: { _ in saves += 1 }) }
        await gate.ready()
        var playEntered = false
        let play = Task { playEntered = true; try await state.connect(key: "account", operation: { await gate.connect() }, save: { _ in saves += 1 }) }
        while !playEntered { await Task.yield() }; gate.finish()
        try await warm.value; try await play.value
        #expect(gate.calls == 1); #expect(saves == 1)
        #expect(state.connectedKey == "account")
        try await state.connect(key: "account", operation: { Issue.record("Cached connection repeated handshake"); return "" }, save: { _ in })
    }
    @Test func logoutDiscardsLateCredentialsEvenIfNetworkIgnoresCancellation() async {
        let state = SpotifyPlaybackConnection(), gate = ConnectionGate()
        var saved = false
        let warm = Task { try await state.connect(key: "old", operation: { await gate.connect() }, save: { _ in saved = true }) }
        await gate.ready(); state.reset(); gate.finish()
        await #expect(throws: CancellationError.self) { try await warm.value }
        #expect(!saved); #expect(state.connectedKey == nil); #expect(state.pendingKey == nil)
    }
    @Test func switchingAccountFencesOldHandshake() async throws {
        let state = SpotifyPlaybackConnection(), gate = ConnectionGate()
        var saved: [String] = []
        let old = Task { try await state.connect(key: "old", operation: { await gate.connect() }, save: { _ in saved.append("old") }) }
        await gate.ready()
        try await state.connect(key: "new", operation: { "new credential" }, save: { _ in saved.append("new") })
        gate.finish()
        await #expect(throws: CancellationError.self) { try await old.value }
        #expect(saved == ["new"]); #expect(state.connectedKey == "new")
    }
    @Test func failedWarmCanRetryOnExplicitPlay() async throws {
        let state = SpotifyPlaybackConnection()
        await #expect(throws: URLError.self) {
            try await state.connect(key: "account", operation: { throw URLError(.timedOut) }, save: { _ in })
        }
        #expect(state.pendingKey == nil)
        try await state.connect(key: "account", operation: { "ok" }, save: { _ in })
        #expect(state.connectedKey == "account")
    }
}
