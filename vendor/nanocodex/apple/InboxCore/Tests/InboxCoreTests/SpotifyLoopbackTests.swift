import XCTest
@testable import InboxCore

final class SpotifyLoopbackTests: XCTestCase {
    private let state = String(repeating: "s", count: 43)
    private func request(_ query: String, host: String = "127.0.0.1:8989") -> String {
        "GET /login?\(query) HTTP/1.1\r\nHost: \(host)\r\n\r\n"
    }

    func testCallbackValidation() {
        let valid = request("code=one-time-code&state=\(state)")
        XCTAssertEqual(SpotifyLoopbackCallback.parse(valid, expectedState: state)?.body,
                       .object(["code": .string("one-time-code"), "state": .string(state)]))
        for invalid in [
            request("code=code&state=wrong"), request("code=code&state=\(state)&state=\(state)"),
            request("code=code&error=denied&state=\(state)"), request("code=&state=\(state)"),
            request("code=code&state=\(state)", host: "attacker.test"),
            request("access_token=secret&state=\(state)"), valid.replacingOccurrences(of: "GET", with: "POST"),
            valid.replacingOccurrences(of: "/login?", with: "//attacker.test/login?"),
            valid.replacingOccurrences(of: "\r\n\r\n", with: "\r\nHost: evil\r\n\r\n"),
            valid + "extra body", request("code=%0Asecret&state=\(state)")
        ] { XCTAssertNil(SpotifyLoopbackCallback.parse(invalid, expectedState: state)) }
        XCTAssertEqual(SpotifyLoopbackCallback.parse(request("error=access_denied&state=\(state)"), expectedState: state)?.error, "access_denied")
    }

    func testSoundCloudCallbackCannotCrossProviderBoundaries() {
        let request = "GET /callback?code=one-time-code&state=\(state) HTTP/1.1\r\nHost: 127.0.0.1:8788\r\n\r\n"
        XCTAssertEqual(SpotifyLoopbackCallback.parse(request, expectedState: state, provider: .soundcloud)?.code, "one-time-code")
        XCTAssertNil(SpotifyLoopbackCallback.parse(request, expectedState: state, provider: .spotify))
        XCTAssertNil(SpotifyLoopbackCallback.parse(request.replacingOccurrences(of: ":8788", with: ":8989"), expectedState: state, provider: .soundcloud))
        XCTAssertNil(SpotifyLoopbackCallback.parse(request.replacingOccurrences(of: "/callback?", with: "/login?"), expectedState: state, provider: .soundcloud))
    }

    @MainActor
    func testLiveLoopbackRejectsWrongStateThenDeliversCodeOnce() async throws {
        for provider in MusicLoopbackProvider.allCases { try await checkLiveLoopback(provider) }
    }

    @MainActor
    private func checkLiveLoopback(_ provider: MusicLoopbackProvider) async throws {
        let receiver = SpotifyLoopbackReceiver(provider: provider)
        defer { receiver.stop() }
        try await receiver.start()
        receiver.expect(state: state)
        let received = expectation(description: "one valid callback")
        received.assertForOverFulfill = true
        receiver.onCallback = { callback in
            XCTAssertEqual(callback.code, "test-code")
            received.fulfill()
        }
        let session = URLSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        let (_, wrong) = try await session.data(from: URL(string: "\(provider.redirectURI)?code=wrong&state=wrong")!)
        XCTAssertEqual((wrong as? HTTPURLResponse)?.statusCode, 400)
        let (data, valid) = try await session.data(from: URL(string: "\(provider.redirectURI)?code=test-code&state=\(state)")!)
        XCTAssertEqual((valid as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("test-code"))
        await fulfillment(of: [received], timeout: 3)
        do {
            _ = try await session.data(from: URL(string: "\(provider.redirectURI)?code=test-code&state=\(state)")!)
            XCTFail("Listener should close after one callback")
        } catch { }
    }

    @MainActor
    func testOccupiedPortFailsAndCancellationReleasesPort() async throws {
        let first = SpotifyLoopbackReceiver(), second = SpotifyLoopbackReceiver()
        defer { first.stop(); second.stop() }
        try await first.start()
        do { try await second.start(); XCTFail("Must not share a callback port") } catch { }
        first.stop()
        // NWListener cancellation closes its socket asynchronously. Assert eventual
        // release rather than racing a second listener against cancel().
        let deadline = ContinuousClock.now + .seconds(3)
        while true {
            do { try await second.start(); break }
            catch {
                guard ContinuousClock.now < deadline else { throw error }
                try await Task.sleep(for: .milliseconds(25))
            }
        }
    }
}
