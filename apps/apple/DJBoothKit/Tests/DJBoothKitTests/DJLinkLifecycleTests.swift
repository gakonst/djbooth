import XCTest
@testable import DJBoothKit

final class DJLinkLifecycleTests: XCTestCase {
    func testOpenAppThenPlugStartsImmediately() {
        var policy = DJLinkLifecycle()
        XCTAssertFalse(policy.mayStart(at: 0))
        policy.observe("en5:12:169.254.6.2")
        XCTAssertTrue(policy.mayStart(at: 0))
    }
    func testLaunchWithCablePresentHasNoWarmupDelay() {
        var policy = DJLinkLifecycle()
        policy.observe("en5:12:169.254.6.2")
        XCTAssertTrue(policy.mayStart(at: 0))
    }
    func testSameAddressReplugClearsFailureCooldown() {
        var policy = DJLinkLifecycle()
        policy.observe("en5:12:169.254.6.2")
        policy.failed(at: 10)
        XCTAssertFalse(policy.mayStart(at: 10.1))
        XCTAssertTrue(policy.observe(nil))
        XCTAssertTrue(policy.observe("en5:12:169.254.6.2"))
        XCTAssertTrue(policy.mayStart(at: 10.1))
    }
    func testRecreatedInterfaceIsANewAttachmentEvenWithSameAddress() {
        var policy = DJLinkLifecycle()
        policy.observe("en5:12:169.254.6.2")
        policy.failed(at: 10)
        XCTAssertTrue(policy.observe("en5:13:169.254.6.2"))
        XCTAssertTrue(policy.mayStart(at: 10.1))
    }
    func testTransientFailureRetriesPromptlyWithoutSpinning() {
        var policy = DJLinkLifecycle()
        policy.observe("en5:12:169.254.6.2")
        policy.failed(at: 0)
        XCTAssertFalse(policy.mayStart(at: 0.249))
        XCTAssertTrue(policy.mayStart(at: 0.25))
        policy.failed(at: 0.25)
        XCTAssertEqual(policy.retryAt, 0.75)
        for _ in 0..<10 { policy.failed(at: 1) }
        XCTAssertEqual(policy.retryAt, 3)
        policy.resetRetry()
        XCTAssertTrue(policy.mayStart(at: 1))
    }
}
