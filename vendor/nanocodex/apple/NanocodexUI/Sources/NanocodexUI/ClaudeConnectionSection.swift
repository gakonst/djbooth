import SwiftUI

/// Manual provider-registered callback flow. Sensitive input is local form state only.
public struct ClaudeConnectionSection: View {
    private let read: () async throws -> (connected: Bool, pending: Bool)
    private let start: () async throws -> URL
    private let complete: (String) async throws -> Void
    private let disconnect: () async throws -> Void
    private let changed: () async -> Void
    @State private var connected = false
    @State private var signingIn = false
    @State private var loaded = false
    @State private var pending = false
    @State private var destination: URL?
    @State private var privateCode = ""
    @State private var failure: String?
    public init(read: @escaping () async throws -> (connected: Bool, pending: Bool),
                start: @escaping () async throws -> URL, complete: @escaping (String) async throws -> Void,
                disconnect: @escaping () async throws -> Void, changed: @escaping () async -> Void) {
        self.read = read; self.start = start; self.complete = complete
        self.disconnect = disconnect; self.changed = changed
    }
    public var body: some View {
        Section("Claude subscription") {
            if !loaded { ProgressView("Checking Claude connection") }
            else if connected { Label("Subscription connected", systemImage: "checkmark.circle") }
            else { Text("Use your Claude Pro or Max subscription for managed chats.") }
            Button(connected ? "Disconnect Claude" : signingIn ? "Restart Claude sign-in" : "Connect Claude") {
                Task { await run {
                    privateCode = ""
                    if connected { try await disconnect(); destination = nil; await changed(); try await refresh() }
                    else { destination = try await start(); signingIn = true }
                } }
            }.disabled(pending || !loaded)
            if signingIn && !connected {
                Text("Open Claude sign-in, approve access, and paste the returned code privately below. Never send the code in a chat.")
                    .font(.caption).foregroundStyle(.secondary)
                if let destination { Link("Open Claude sign-in page", destination: destination) }
                SecureField("Claude authorization code (code#state)", text: $privateCode)
                    .textContentType(nil).disabled(pending).accessibilityIdentifier("claude-private-code")
                Button("Complete Claude sign-in") {
                    let code = privateCode.trimmingCharacters(in: .whitespacesAndNewlines)
                    privateCode = ""
                    Task { await run {
                        try await complete(code); destination = nil; await changed(); try await refresh()
                    } }
                }.disabled(pending || privateCode.isEmpty).accessibilityIdentifier("claude-complete")
            }
            if let failure {
                Text(failure).font(.caption).foregroundStyle(.secondary)
                Button("Refresh Claude status") { Task { await run { try await refresh(); await changed() } } }.disabled(pending)
            }
        }
        .task { await run { try await refresh() } }
        .onDisappear { privateCode = ""; destination = nil }
    }
    @MainActor private func refresh() async throws {
        let status = try await read()
        connected = status.connected; signingIn = status.pending && !status.connected; loaded = true
        if connected { privateCode = ""; destination = nil }
    }
    @MainActor private func run(_ operation: () async throws -> Void) async {
        guard !pending else { return }
        pending = true; failure = nil
        defer { pending = false }
        do { try await operation() }
        catch { failure = "Claude connection was not confirmed. Refresh status before retrying. Authorization codes expire and are single-use." }
    }
}
