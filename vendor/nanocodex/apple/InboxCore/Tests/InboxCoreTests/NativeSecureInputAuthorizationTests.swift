import XCTest
@testable import InboxCore

final class NativeSecureInputAuthorizationTests: XCTestCase {
    // Failures: denied local authentication reaching transport, FaceID returning
    // before scene activation, and background cancellation during that transition.
    @MainActor func testDeniedAuthenticationNeverCallsSubmission() async {
        var sends = 0
        do {
            let _: String = try await NativeSecureInputAuthorization.perform(authenticate: { false }, isActive: { true }, isCancelled: { false }) {
                sends += 1
                return "unexpected"
            }
            XCTFail("Denied authentication must not authorize transport")
        } catch {}
        XCTAssertEqual(sends, 0)
    }
    @MainActor func testSuccessfulAuthenticationWaitsForSceneActivation() async throws {
        var active = false
        var sends = 0
        let activate = Task { @MainActor in
            try await Task.sleep(for: .milliseconds(50))
            active = true
        }
        defer { activate.cancel() }
        let result = try await NativeSecureInputAuthorization.perform(authenticate: { true }, isActive: { active }, isCancelled: { false }) {
            XCTAssertTrue(active)
            sends += 1
            return "encrypted-submission"
        }
        XCTAssertEqual(result, "encrypted-submission")
        XCTAssertEqual(sends, 1)
    }
    @MainActor func testBackgroundCancellationDuringActivationNeverSends() async {
        var cancelled = false
        var sends = 0
        let cancel = Task { @MainActor in
            try await Task.sleep(for: .milliseconds(50))
            cancelled = true
        }
        defer { cancel.cancel() }
        do {
            let _: String = try await NativeSecureInputAuthorization.perform(authenticate: { true }, isActive: { false }, isCancelled: { cancelled }) {
                sends += 1
                return "unexpected"
            }
            XCTFail("Background transition must revoke approval")
        } catch {}
        XCTAssertEqual(sends, 0)
    }
}
