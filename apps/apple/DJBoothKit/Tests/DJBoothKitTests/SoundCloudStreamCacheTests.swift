import Foundation
import Testing
@testable import DJBoothKit

private actor StreamLoadGate {
    var continuation: CheckedContinuation<URL, Never>?
    var loads = 0
    var validations = 0
    func load() async -> URL { loads += 1; return await withCheckedContinuation { continuation = $0 } }
    func ready() async { while continuation == nil { await Task.yield() } }
    func validate() { validations += 1 }
    func validated() async { while validations == 0 { await Task.yield() } }
    func finish() { continuation?.resume(returning: URL(string: "https://media.sndcdn.com/audio")!); continuation = nil }
}
private final class StreamClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval = 100
    func now() -> TimeInterval { lock.withLock { value } }
    func advance(_ seconds: TimeInterval) { lock.withLock { value += seconds } }
}
struct SoundCloudStreamCacheTests {
    private let key = SoundCloudStreamCache.Key(sourceID: "source", accountID: "account", trackID: "track")
    @Test func pendingPrewarmIsSharedButPlaybackStillValidates() async throws {
        let cache = SoundCloudStreamCache(), gate = StreamLoadGate()
        let warm = Task { try await cache.value(for: key, load: { await gate.load() }, validate: { await gate.validate() }) }
        await gate.ready()
        let play = Task { try await cache.value(for: key, load: { await gate.load() }, validate: { await gate.validate() }) }
        await gate.validated(); await gate.finish()
        #expect(try await warm.value == play.value)
        #expect(await gate.loads == 1); #expect(await gate.validations == 1)
    }
    @Test func expiryCapacityAndAccountIdentityRequireFreshResolution() async throws {
        let clock = StreamClock(), cache = SoundCloudStreamCache(capacity: 1, now: { clock.now() })
        let first = URL(string: "https://media.sndcdn.com/first")!, fresh = URL(string: "https://media.sndcdn.com/fresh")!
        _ = try await cache.value(for: key, load: { first }, validate: {})
        clock.advance(14)
        #expect(try await cache.value(for: key, load: { Issue.record("URL expired early"); return fresh }, validate: {}) == first)
        clock.advance(1)
        #expect(try await cache.value(for: key, load: { fresh }, validate: {}) == fresh)
        let other = SoundCloudStreamCache.Key(sourceID: "source", accountID: "other-account", trackID: "track")
        #expect(try await cache.value(for: other, load: { first }, validate: {}) == first)
        #expect(try await cache.value(for: key, load: { first }, validate: {}) == first)
    }
    @Test func canceledLoaderIsEvictedAndCanceledWaiterKeepsSuccessfulResolution() async throws {
        let cache = SoundCloudStreamCache(), gate = StreamLoadGate()
        await #expect(throws: CancellationError.self) {
            try await cache.value(for: key, load: { throw CancellationError() }, validate: {})
        }
        let warm = Task { try await cache.value(for: key, load: { await gate.load() }, validate: {}) }
        await gate.ready(); warm.cancel(); await gate.finish()
        await #expect(throws: CancellationError.self) { try await warm.value }
        let cached = try await cache.value(for: key, load: { Issue.record("Canceled waiter evicted successful URL"); throw CancellationError() }, validate: {})
        #expect(cached.host == "media.sndcdn.com")
    }
    @Test func authorizationFailureFencesOtherPendingResolutions() async throws {
        let cache = SoundCloudStreamCache(), gate = StreamLoadGate()
        let warm = Task { try await cache.value(for: key, load: { await gate.load() }, validate: {}) }
        await gate.ready()
        await #expect(throws: ClientError.self) {
            try await cache.value(for: key, load: { Issue.record("Duplicate load"); return URL(string: "https://media.sndcdn.com/unused")! },
                                  validate: { throw ClientError.http(403, "Revoked") })
        }
        await gate.finish()
        await #expect(throws: CancellationError.self) { try await warm.value }
    }
}
