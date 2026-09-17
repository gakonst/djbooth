import Foundation
import Testing
@testable import DJBoothKit

@MainActor struct PhoneMCPServerTests {
    @Test func protocolCatalogAndValidation() throws {
        let tools = try PhoneMCPServer.tools()
        #expect(tools.count > 30)
        let listed = PhoneMCPServer.handle(["jsonrpc": "2.0", "id": 1, "method": "tools/list"]) { _, _ in Issue.record("Must not execute"); return "" }
        #expect((listed["result"] as? [String: Any])?["tools"] != nil)
        for bad: [String: Any] in [
            ["enabled": true],
            ["requestID": UUID().uuidString, "enabled": 1],
            ["requestID": "invalid", "enabled": true],
            ["requestID": UUID().uuidString, "enabled": true, "accountID": "other"]
        ] {
            let reply = PhoneMCPServer.handle(["jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": ["name": "sonos_enabled", "arguments": bad]]) { _, _ in
                Issue.record("Invalid input reached side effects"); return ""
            }
            #expect(reply["error"] != nil)
        }
        let good = PhoneMCPServer.handle(["jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": ["name": "sonos_enabled", "arguments": ["requestID": UUID().uuidString, "enabled": true]]]) { name, args in
            #expect(name == "sonos_enabled"); #expect(args["enabled"] as? Bool == true)
            return "accepted"
        }
        #expect((good["result"] as? [String: Any])?["isError"] as? Bool == false)
    }
    @Test func receiptsSurviveRelaunchAndStayOutOfOtherAccountsAndSync() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let id = UUID().uuidString
        var first: LibraryStore? = try LibraryStore(directory: directory.appendingPathComponent("a"))
        try first!.savePhoneAction(PhoneActionReceipt(requestID: id, fingerprint: "playlist_create:arguments"))
        #expect(try first!.pendingCount() == 0)
        first = nil
        let reopened = try LibraryStore(directory: directory.appendingPathComponent("a"))
        #expect(try reopened.phoneAction(id)?.status == "running")
        let other = try LibraryStore(directory: directory.appendingPathComponent("b"))
        #expect(try other.phoneAction(id) == nil)
    }
}
