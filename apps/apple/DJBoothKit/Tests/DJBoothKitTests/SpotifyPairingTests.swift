import Foundation
import Testing
@testable import DJBoothKit

private final class PairingFixture: @unchecked Sendable {
    enum Reply { case json(Int, String, Double? = nil), network }
    private let lock = NSLock()
    private var time = Date(timeIntervalSince1970: 1000)
    private var replies: [Reply]
    private var delays: [Double] = []
    private var paths: [String] = []
    init(_ replies: [Reply]) { self.replies = replies }
    func now() -> Date { lock.withLock { time } }
    func advance(_ seconds: Double) { lock.withLock { time.addTimeInterval(seconds); delays.append(seconds) } }
    func waits() -> [Double] { lock.withLock { delays } }
    func requests() -> [String] { lock.withLock { paths } }
    func post(_ path: String, _ values: [String: String]) throws -> SpotifyPairingClient.Response {
        let reply = lock.withLock { paths.append(path); return replies.removeFirst() }
        #expect(values["client_id"] == "65b708073fc0480ea92a077233ca87bd")
        if path == "api/token" {
            #expect(values["grant_type"] == "urn:ietf:params:oauth:grant-type:device_code")
            #expect(values["device_code"] == "private-device-code")
        }
        switch reply {
        case .json(let status, let body, let retry): return (Data(body.utf8), status, retry)
        case .network: throw URLError(.networkConnectionLost)
        }
    }
    func client() -> SpotifyPairingClient {
        SpotifyPairingClient(post: { try self.post($0, $1) }, now: { self.now() }, sleep: { self.advance($0) })
    }
}

struct SpotifyPairingTests {
    private static let start = #"{"device_code":"private-device-code","user_code":"ABCDEF","verification_uri":"https://spotify.com/pair","verification_uri_complete":"https://spotify.com/pair?code=ABCDEF","expires_in":300}"#
    @Test func followsLibrespotPairingAndKeepsSlowerPollingAfterSlowDown() async throws {
        let fixture = PairingFixture([.json(200, Self.start), .json(400, #"{"error":"authorization_pending"}"#),
            .json(400, #"{"error":"slow_down"}"#), .json(400, #"{"error":"authorization_pending"}"#),
            .json(200, #"{"access_token":"approved-token"}"#)])
        let client = fixture.client(), pairing = try await client.begin()
        #expect(pairing.url.absoluteString == "https://spotify.com/pair?code=ABCDEF")
        #expect(try await client.token(pairing) == "approved-token")
        #expect(fixture.waits() == [5, 5, 10, 10])
    }
    @Test func networkAndServiceFailuresBackOffWithoutDiscardingApproval() async throws {
        let fixture = PairingFixture([.json(200, Self.start), .network, .json(503, "unavailable"),
            .json(429, "rate limited", 40), .json(200, #"{"access_token":"approved-token"}"#)])
        let client = fixture.client(), pairing = try await client.begin()
        #expect(try await client.token(pairing) == "approved-token")
        #expect(fixture.waits() == [5, 10, 20, 40])
    }
    @Test func returningAfterExpiryDoesNotPollOrExtendTheCodeLifetime() async throws {
        let fixture = PairingFixture([.json(200, Self.start)])
        let client = fixture.client(), pairing = try await client.begin()
        fixture.advance(301)
        await #expect(throws: SpotifyPairingError.expired) { try await client.token(pairing) }
        #expect(fixture.requests() == ["oauth2/device/authorize"])
    }
    @Test func denialIsTerminalAndDoesNotKeepSpinning() async throws {
        let fixture = PairingFixture([.json(200, Self.start), .json(400, #"{"error":"access_denied"}"#)])
        let client = fixture.client(), pairing = try await client.begin()
        await #expect(throws: SpotifyPairingError.declined) { try await client.token(pairing) }
        #expect(fixture.waits() == [5])
    }
    @Test func cancellationStopsBeforeAnyTokenRequest() async throws {
        let fixture = PairingFixture([.json(200, Self.start)])
        let client = fixture.client(), pairing = try await client.begin()
        let canceled = SpotifyPairingClient(post: { try fixture.post($0, $1) }, now: { fixture.now() }, sleep: { _ in throw CancellationError() })
        await #expect(throws: CancellationError.self) { try await canceled.token(pairing) }
        #expect(fixture.requests() == ["oauth2/device/authorize"])
    }
    @Test func rejectsUntrustedApprovalDestination() async throws {
        let fixture = PairingFixture([.json(200, Self.start.replacingOccurrences(of: "https://spotify.com/pair?code=ABCDEF", with: "https://spotify.com.evil.example/pair?code=ABCDEF"))])
        await #expect(throws: SpotifyPairingError.invalidResponse) { try await fixture.client().begin() }
    }
}
