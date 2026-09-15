import Foundation
import Testing
@testable import DJBoothKit

@MainActor struct PhoneLibraryQueryTests {
    private func decode(_ text: String) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any])
    }
    @Test func searchesLiveUnsyncedLibraryAndPaginatesWithoutExportingArtifacts() throws {
        var phone = PhoneLibraryQuery()
        phone.tracks = (0..<7).map { Track(id: "t\($0)", title: "Track \($0)", artist: "Alice", mediaHash: "private-hash", waveform: Waveform(peaks: [0.1, 0.9])) }
        phone.collections = [Collection(id: "p", name: "Unsent playlist", trackIDs: ["t3", "t1", "t5"])]
        phone.favorites = ["t1", "t5"]; phone.offlineIDs = ["t5"]
        phone.annotations["t5"] = TrackAnnotation(note: "Opening set", color: .blue)
        let first = try decode(phone.execute(["resource": "tracks", "id": "p", "limit": 2]))
        #expect((first["items"] as? [[String: Any]])?.compactMap { $0["id"] as? String } == ["t3", "t1"])
        #expect(first["nextOffset"] as? Int == 2)
        let last = try decode(phone.execute(["resource": "tracks", "id": "p", "offset": 2]))
        #expect(last["nextOffset"] is NSNull)
        let match = try decode(phone.execute(["resource": "tracks", "query": "opening", "favoritesOnly": true, "offlineOnly": true]))
        #expect(match["total"] as? Int == 1)
        let detail = try phone.execute(["resource": "track", "id": "t5"])
        #expect(detail.contains("Opening set")); #expect(!detail.contains("private-hash")); #expect(!detail.contains("peaks"))
        phone.annotations["t5"] = TrackAnnotation(note: "Updated on phone")
        #expect(try phone.execute(["resource": "track", "id": "t5"]).contains("Updated on phone"))
    }
    @Test func switchingLibraryCannotQueryPriorAccountsOrInventTracks() throws {
        var alice = PhoneLibraryQuery(); alice.tracks = [Track(id: "same-id", title: "Alice private")]
        var bob = PhoneLibraryQuery(); bob.tracks = [Track(id: "same-id", title: "Bob private")]
        #expect(try alice.execute(["resource": "track", "id": "same-id"]).contains("Alice private"))
        let result = try bob.execute(["resource": "track", "id": "same-id"])
        #expect(result.contains("Bob private")); #expect(!result.contains("Alice private"))
        #expect(throws: ClientError.self) { try bob.execute(["resource": "track", "id": "unknown"]) }
        #expect(throws: ClientError.self) { try bob.execute(["resource": "tracks", "accountID": "alice"]) }
        #expect(throws: ClientError.self) { try bob.execute(["resource": "delete", "id": "same-id"]) }
        for invalid: [String: Any] in [["offset": -1], ["limit": 51], ["offset": true], ["limit": 1.2], ["offlineOnly": 1]] {
            #expect(throws: ClientError.self) { try bob.execute(invalid.merging(["resource": "tracks"]) { _, new in new }) }
        }
    }
    @Test func outputBudgetKeepsPaginationHonestAndQueueOrder() throws {
        var phone = PhoneLibraryQuery()
        phone.tracks = (0..<20).map { Track(id: "t\($0)", title: String(repeating: "a", count: 200)) }
        phone.queue = Array(phone.tracks.reversed())
        let text = try phone.execute(["resource": "tracks", "limit": 20], byteBudget: 1800)
        #expect(text.utf8.count <= 1800)
        let page = try decode(text)
        #expect(page["total"] as? Int == 20)
        #expect(page["nextOffset"] as? Int == (page["items"] as? [Any])?.count)
        let queue = try decode(phone.execute(["resource": "queue", "limit": 1]))
        #expect((queue["items"] as? [[String: Any]])?.first?["id"] as? String == "t19")
    }
    @Test func toolTicketsCannotRedirectPhoneQueriesToAnotherHost() throws {
        let endpoint = try Endpoint("https://library.example")
        let good = try PhoneToolHost.socketRequest(URL(string: "wss://nanocodex-connect-api.gakonst.workers.dev/v1/grants/test/agents/test/tool-host?ticket=one-use")!, endpoint: endpoint)
        #expect(good.value(forHTTPHeaderField: "Origin") == "https://library.example")
        #expect(good.value(forHTTPHeaderField: "Authorization") == nil)
        for bad in ["wss://evil.example/tool-host", "ws://nanocodex-connect-api.gakonst.workers.dev/tool-host", "wss://user@nanocodex-connect-api.gakonst.workers.dev/tool-host"] {
            #expect(throws: ClientError.self) { try PhoneToolHost.socketRequest(URL(string: bad)!, endpoint: endpoint) }
        }
        #expect(try PhoneToolHost.catalog().count == 1)
        #expect(try PhoneToolHost.catalogDigest().hasPrefix("0x") == true)
    }
}
