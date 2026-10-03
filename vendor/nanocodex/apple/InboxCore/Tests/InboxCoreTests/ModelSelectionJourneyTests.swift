import Foundation
import XCTest
import InboxCore

/// Exercise the native picker's shipped client against a real local managed API.
/// Authentication/provider catalog may be synthetic; do not stub /routing or state.
final class ModelSelectionJourneyTests: XCTestCase {
    func testClaudeSelectionReloadAndRejectedUpdatePreservesSelection() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let origin = environment["NANOCODEX_MODEL_SELECTION_JOURNEY_URL"],
              let url = URL(string: origin), url.scheme == "http",
              ["127.0.0.1", "localhost"].contains(url.host ?? "") else {
            throw XCTSkip("Set NANOCODEX_MODEL_SELECTION_JOURNEY_URL to a real local managed service with a synthetic Claude catalog")
        }
        let key = try XCTUnwrap(environment["NANOCODEX_MODEL_SELECTION_JOURNEY_KEY"], "Supply the local fixture's synthetic account credential")
        let credential = try JSONDecoder().decode(AccountCredential.self,
            from: JSONSerialization.data(withJSONObject: ["origin": origin, "apiKey": key]))
        let client = ManagedClient(credential: credential, configuration: .ephemeral)
        defer { client.close() }
        let catalog = try await client.modelCatalog()
        let choice = try XCTUnwrap(catalog.models.first { $0.provider == "claude" }, "The fixture must advertise a connected Claude model")
        let effort = try XCTUnwrap(choice.efforts.first)
        let id = try await client.create(requestID: "native-model-journey-" + UUID().uuidString)
        addTeardownBlock {
            let cleanup = ManagedClient(credential: credential, configuration: .ephemeral)
            defer { cleanup.close() }
            _ = try await cleanup.json(path: ManagedClient.agentPath(id), method: "DELETE")
        }

        // This is the same typed operation invoked by InboxModel.chooseModel.
        try await client.updateModelSelection(id, selection: .manual(model: choice.id, thinking: effort))
        var card = AgentCard(id: id, title: "Synthetic model selection")
        try card.apply(state: await client.state(id))
        XCTAssertEqual(card.model, choice.id)
        XCTAssertEqual(card.thinking, effort)
        XCTAssertEqual(card.provider, "Claude")
        XCTAssertFalse(card.modelLocked, "Selection alone must not begin execution")
        client.close()

        let reopened = ManagedClient(credential: credential, configuration: .ephemeral)
        defer { reopened.close() }
        try card.apply(state: await reopened.state(id))
        XCTAssertEqual(card.model, choice.id)
        XCTAssertEqual(card.thinking, effort)
        XCTAssertEqual(card.provider, "Claude")
        do {
            try await reopened.updateModelSelection(id, selection: .manual(model: "unsupported-model", thinking: effort))
            XCTFail("The real managed API must reject an unsupported model")
        } catch APIError.http(400) { }
        try card.apply(state: await reopened.state(id))
        XCTAssertEqual(card.model, choice.id, "Rejected updates must preserve the retained selection")
        XCTAssertEqual(card.thinking, effort)
        XCTAssertEqual(card.provider, "Claude")
        print("MODEL_SELECTION_JOURNEY selected=\(choice.id) effort=\(effort) provider=Claude reload=retained invalid_update=400 retained_after_rejection=true")
    }
}
