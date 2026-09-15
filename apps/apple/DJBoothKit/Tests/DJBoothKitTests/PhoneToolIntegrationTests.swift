import Foundation
import Testing
@testable import DJBoothKit

/// Uses the repository's local Worker + issuer fixture and an actual native
/// URLSession WebSocket. No provider login or model spend is needed.
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["DJBOOTH_PHONE_TOOL_FIXTURE"] == "1"))
@MainActor struct PhoneToolIntegrationTests {
    @Test func agentQueriesLivePhoneAcrossAccountsAndStopsWhenPhoneDisconnects() async throws {
        let endpoint = try Endpoint("http://127.0.0.1:8791")
        for (who, character, grantCharacter) in [("Alice", "a", "1"), ("Bob", "b", "2")] {
            let client = CloudClient(endpoint: endpoint, token: "nc1.0x\(String(repeating: grantCharacter, count: 64)).\(String(repeating: character, count: 43))")
            let host = PhoneToolHost()
            var ready = false, failure: String?
            var library = PhoneLibraryQuery()
            library.collections = [Collection(id: "same-phone-id", name: "\(who) phone-only playlist")]
            var calls = 0
            let attachment = Task {
                await host.run(client: client, status: { connected, error in ready = connected; failure = error }, query: { arguments, budget in
                    calls += 1
                    return try library.execute(arguments, byteBudget: budget)
                })
            }
            defer { attachment.cancel(); host.stop() }
            for _ in 0..<200 {
                if ready || failure != nil { break }
                try await Task.sleep(for: .milliseconds(50))
            }
            try #require(ready, "Tool attachment failed: \(failure ?? "timed out")")
            for suffix in ["", " updated locally"] {
                library.collections[0].name = "\(who) phone-only playlist\(suffix)"
                let id = UUID().uuidString
                var turn = try await client.agentTurn(id: id, input: "What's in my library?")
                for _ in 0..<100 {
                    if turn.status == "completed" { break }
                    try await Task.sleep(for: .milliseconds(50))
                    turn = try await client.agentTurn(id: id)
                }
                #expect(turn.finalMessage == "On this phone: \(who) phone-only playlist\(suffix).")
            }
            #expect(calls == 2)
            attachment.cancel(); host.stop()
            await attachment.value
            try await Task.sleep(for: .milliseconds(150))
            await #expect(throws: ClientError.self) { try await client.agentTurn(id: UUID().uuidString, input: "What's in my library?") }
            #expect(calls == 2)
        }
    }
}
