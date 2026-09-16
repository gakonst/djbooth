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
    private func signedURL(_ fields: [URLQueryItem]) -> URL {
        var url = URLComponents(string: "https://playback.media-streaming.soundcloud.cloud/audio.m3u8")!
        url.queryItems = fields; return url.url!
    }
    private func policy(_ expiries: [Double]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: ["Statement": expiries.map {
            ["Condition": ["DateLessThan": ["AWS:EpochTime": $0]]]
        }])
        return data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "=", with: "_").replacingOccurrences(of: "/", with: "~")
    }
    @Test func signedExpiryBoundsReuseAndUnknownURLsUseShortFallback() throws {
        let ttl: (URL) -> Double = { SoundCloudStreamCache.lifetime(for: $0, wallTime: 1000) }
        #expect(ttl(signedURL([])) == 60)
        #expect(ttl(signedURL([.init(name: "Expires", value: "2000")])) == 120)
        #expect(ttl(signedURL([.init(name: "Expires", value: "1100")])) == 40)
        #expect(ttl(signedURL([.init(name: "Expires", value: "1059")])) == 0)
        #expect(ttl(signedURL([.init(name: "Expires", value: "999")])) == 0)
        #expect(ttl(signedURL([.init(name: "Policy", value: try policy([2000]))])) == 120)
        #expect(ttl(signedURL([.init(name: "Policy", value: try policy([2000, 1090]))])) == 30)
        #expect(ttl(signedURL([.init(name: "Policy", value: try policy([2000])), .init(name: "Expires", value: "1100")])) == 40)
    }
    @Test func malformedRecognizedPoliciesNeverGainFallbackLifetime() {
        for value in ["", "broken", "NaN", "-100"] {
            #expect(SoundCloudStreamCache.lifetime(for: signedURL([.init(name: "Expires", value: value)]), wallTime: 1000) == 0)
        }
        for value in ["broken", Data("{}".utf8).base64EncodedString(), String(repeating: "A", count: 8193)] {
            #expect(SoundCloudStreamCache.lifetime(for: signedURL([.init(name: "Policy", value: value)]), wallTime: 1000) == 0)
        }
        #expect(SoundCloudStreamCache.lifetime(for: signedURL([.init(name: "Expires", value: "2000"), .init(name: "Expires", value: "3000")]), wallTime: 1000) == 0)
    }
    @Test func longEnoughBrowsingStillRechecksApprovalAndNearExpiryIsNotRetained() async throws {
        let clock = StreamClock(), cache = SoundCloudStreamCache(now: { clock.now() }, wallTime: { 1000 })
        let url = signedURL([.init(name: "Expires", value: "2000")])
        _ = try await cache.value(for: key, load: { url }, validate: {})
        clock.advance(30)
        await #expect(throws: ClientError.self) {
            try await cache.value(for: key, load: { Issue.record("Premature expiry"); return url }, validate: { throw ClientError.http(403, "Revoked") })
        }
        let near = signedURL([.init(name: "Expires", value: "1050")])
        _ = try await cache.value(for: key, load: { near }, validate: {})
        #expect(try await cache.value(for: key, load: { url }, validate: {}) == url)
    }
    @Test func explicitInvalidationFencesEvenUncancellablePendingLoad() async throws {
        let cache = SoundCloudStreamCache(), gate = StreamLoadGate()
        let old = Task { try await cache.value(for: key, load: { await gate.load() }, validate: {}) }
        await gate.ready(); await cache.invalidate(key); await gate.finish()
        await #expect(throws: CancellationError.self) { try await old.value }
        let fresh = signedURL([])
        #expect(try await cache.value(for: key, load: { fresh }, validate: {}) == fresh)
    }
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
        let clock = StreamClock(), cache = SoundCloudStreamCache(lifetime: 15, capacity: 1, now: { clock.now() })
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
