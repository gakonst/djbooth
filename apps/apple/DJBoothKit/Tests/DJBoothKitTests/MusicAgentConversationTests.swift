import Foundation
import Testing
@testable import DJBoothKit

@MainActor struct MusicAgentConversationTests {
    @Test func missingAcceptedTurnUnblocksWithoutReplayingOrLosingDraft() {
        let original = MusicAgentMessage(id: "user:missing", role: "You", text: "Import a set")
        var conversation = MusicAgentConversation(messages: [original], draft: "Next request", pendingID: "missing")
        let recovered = conversation.recoverMissingTurn("missing")
        #expect(recovered)
        #expect(conversation.pendingID == nil)
        #expect(conversation.pendingInput == nil)
        #expect(conversation.draft == "Next request")
        #expect(conversation.messages.first == original)
        #expect(conversation.messages.last?.text.contains("outcome is unknown") == true)
        let repeated = conversation.recoverMissingTurn("missing")
        #expect(!repeated)
        #expect(conversation.messages.count == 2)
    }

    @Test func missingTurnUsesExistingTerminalHistoryAndPreservesUnsubmittedRequests() {
        let completed = MusicAgentMessage(id: "assistant:done", role: "DJ Booth", text: "Done")
        var conversation = MusicAgentConversation(messages: [completed], pendingID: "done")
        let recovered = conversation.recoverMissingTurn("done")
        #expect(recovered)
        #expect(conversation.messages == [completed])
        conversation.pendingID = "new"; conversation.pendingInput = "Not submitted"
        let unsubmitted = conversation.recoverMissingTurn("new")
        #expect(!unsubmitted)
        #expect(conversation.pendingID == "new")
        let unrelated = conversation.recoverMissingTurn("another-account-turn")
        #expect(!unrelated)
    }

    @Test func acceptedTurnUsesCanonicalIDAcrossRelaunch() throws {
        let message = MusicAgentMessage(id: "user:local", role: "You", text: "Hello")
        var conversation = MusicAgentConversation(messages: [message], pendingID: "local", pendingInput: "Hello")
        conversation.acceptTurn("server")
        let restored = try JSONDecoder().decode(MusicAgentConversation.self, from: JSONEncoder().encode(conversation))
        #expect(restored.pendingID == "server")
        #expect(restored.pendingInput == nil)
        #expect(restored.messages.first?.id == "user:server")
        #expect(restored.messages.first?.text == message.text)
        #expect(restored.messages.first?.createdAt == message.createdAt)
    }

    @Test func pendingTurnAndDraftSurviveRelaunchAndStayAccountScoped() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let accountA = directory.appendingPathComponent("account-a")
        let accountB = directory.appendingPathComponent("account-b")
        var store: LibraryStore? = try LibraryStore(directory: accountA)
        let conversation = MusicAgentConversation(messages: [.init(id: "user:turn-1", role: "You", text: "Find a track")],
            draft: "And then…", pendingID: "turn-1", pendingInput: "Find a track", agentID: "agent-a", nextBefore: "99")
        try store!.saveAgentConversation(conversation)
        #expect(try store!.pendingCount() == 0, "Agent cache must not enter library sync")
        store = nil
        let restored = try LibraryStore(directory: accountA)
        #expect(try restored.agentConversation() == conversation)
        let other = try LibraryStore(directory: accountB)
        #expect(try other.agentConversation() == MusicAgentConversation())
    }

    @Test func serverHistoryReplacesOptimisticMessagesAndMergesOlderPagesOnce() throws {
        let cached = [MusicAgentMessage(id: "user:turn-2", role: "You", text: "local", createdAt: Date(timeIntervalSince1970: 999))]
        let page = try JSONDecoder().decode(MusicAgentHistory.self, from: Data(#"{"agentID":"one","nextBefore":"12","messages":[{"id":"user:turn-1","role":"You","text":"Earlier","timestamp":1},{"id":"user:turn-2","role":"You","text":"Canonical","timestamp":2},{"id":"assistant:turn-2","role":"DJ Booth","text":"Reply","timestamp":2}]}"#.utf8))
        let merged = page.merging(cached)
        #expect(merged.map(\.id) == ["user:turn-1", "user:turn-2", "assistant:turn-2"])
        #expect(merged[1].text == "Canonical")
        #expect(page.merging(merged) == merged)
    }
}
