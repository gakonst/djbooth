import XCTest
@testable import NanocodexRemote

final class RemoteICEPreparationTests: XCTestCase {
    @MainActor func testImmediateStopNeverStartsRequestAgainstClosedSession() async throws {
        let preparation = RemoteICEPreparation()
        preparation.start { XCTFail("Stopped publication started its queued HTTP request"); return [] }
        preparation.reset()
        await Task.yield()
        do { _ = try await preparation.value(); XCTFail("Stopped publication retained a request") }
        catch { XCTAssertEqual(error as? RemoteError, .closed) }
    }

    @MainActor func testPrefetchIsSharedAndExpiresBeforeCredentialLifetime() async throws {
        let preparation = RemoteICEPreparation()
        let started = expectation(description: "Prefetch started before viewer")
        let lock = NSLock()
        var calls = 0
        var time = ContinuousClock.now
        preparation.now = { time }
        preparation.start {
            let count = lock.withLock { calls += 1; return calls }
            if count == 1 { started.fulfill() }
            return [RemoteICE(urls: ["turn:fixture"], credential: String(count))]
        }
        await fulfillment(of: [started], timeout: 1)
        async let first = preparation.value()
        async let second = preparation.value()
        let values = try await (first, second)
        XCTAssertEqual(values.0.first?.credential, "1")
        XCTAssertEqual(values.1.first?.credential, "1")
        XCTAssertEqual(lock.withLock { calls }, 1)
        time = time.advanced(by: .seconds(300))
        let renewed = try await preparation.value()
        XCTAssertEqual(renewed.first?.credential, "2")
        preparation.reset()
        do { _ = try await preparation.value(); XCTFail("Stopped publication reused credentials") }
        catch { XCTAssertEqual(error as? RemoteError, .closed) }
    }

    @MainActor func testFailedPrefetchCanRetryAndAccountReplacementFencesLateCompletion() async throws {
        let preparation = RemoteICEPreparation()
        let failureLock = NSLock()
        var calls = 0
        preparation.start {
            let count = failureLock.withLock { calls += 1; return calls }
            if count == 1 { throw RemoteError.unauthorized }
            return [RemoteICE(urls: ["turn:retry"])]
        }
        do { _ = try await preparation.value(); XCTFail("Rejected ICE request succeeded") }
        catch { XCTAssertEqual(error as? RemoteError, .unauthorized) }
        let retried = try await preparation.value()
        XCTAssertEqual(retried.first?.urls, ["turn:retry"])
        XCTAssertEqual(failureLock.withLock { calls }, 2)

        let started = expectation(description: "Old account request pending")
        let lock = NSLock()
        var continuation: CheckedContinuation<[RemoteICE], Never>?
        preparation.start {
            await withCheckedContinuation { pending in
                lock.withLock { continuation = pending }; started.fulfill()
            }
        }
        let old = Task { try await preparation.value() }
        await fulfillment(of: [started], timeout: 1)
        preparation.start { [RemoteICE(urls: ["turn:new-account"])] }
        lock.withLock { continuation }?.resume(returning: [RemoteICE(urls: ["turn:old-account"])])
        do { _ = try await old.value; XCTFail("Old account credentials escaped") }
        catch { XCTAssertTrue(error is CancellationError) }
        let fresh = try await preparation.value()
        XCTAssertEqual(fresh.first?.urls, ["turn:new-account"])
        preparation.reset()
    }
}
