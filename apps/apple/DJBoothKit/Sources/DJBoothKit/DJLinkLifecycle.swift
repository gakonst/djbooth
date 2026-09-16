import Foundation

/// App attachment/retry policy only; DJ Link discovery and protocol remain in Rust.
public struct DJLinkLifecycle: Sendable {
    public private(set) var attachment: String?
    public private(set) var retryAt: TimeInterval = 0
    private var failures = 0
    public init() {}

    /// A cable transition, including a new interface index at the same IP, must
    /// never inherit a failed attempt's cooldown from the old attachment.
    @discardableResult public mutating func observe(_ next: String?) -> Bool {
        guard next != attachment else { return false }
        attachment = next
        resetRetry()
        return true
    }
    public func mayStart(at now: TimeInterval) -> Bool { attachment != nil && now >= retryAt }
    public mutating func resetRetry() { failures = 0; retryAt = 0 }
    public mutating func failed(at now: TimeInterval) {
        failures = min(failures + 1, 4)
        retryAt = now + min(2, 0.25 * pow(2, Double(failures - 1)))
    }
}
