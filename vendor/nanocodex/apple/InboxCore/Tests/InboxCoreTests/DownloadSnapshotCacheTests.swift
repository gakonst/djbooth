import Foundation
import XCTest
@testable import InboxCore

final class DownloadSnapshotCacheTests: XCTestCase {
    func testReopenAndDisposableLeasePreserveCanonicalBytes() async throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let source = root.appendingPathComponent("source")
        try Data("saved bytes".utf8).write(to: source)
        let cache = DownloadSnapshotCache(scope: "account-a", root: root)
        await cache.save(file: source, key: "agent-a/private/output")
        let reopened = DownloadSnapshotCache(scope: "account-a", root: root)
        let restored = await reopened.restore(key: "agent-a/private/output", filename: "../../clip.mp4")
        let lease = try XCTUnwrap(restored)
        XCTAssertEqual(lease.lastPathComponent, "clip.mp4")
        XCTAssertEqual(try Data(contentsOf: lease), Data("saved bytes".utf8))
        try FileManager.default.removeItem(at: lease.deletingLastPathComponent())
        let restoredAgain = await reopened.restore(key: "agent-a/private/output", filename: "clip.mp4")
        let second = try XCTUnwrap(restoredAgain)
        defer { try? FileManager.default.removeItem(at: second.deletingLastPathComponent()) }
        XCTAssertEqual(try Data(contentsOf: second), Data("saved bytes".utf8))
    }

    func testAccountIsolationAndClearDisablesLateSave() async throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let source = root.appendingPathComponent("source")
        try Data([1, 2, 3]).write(to: source)
        let first = DownloadSnapshotCache(scope: "account-a", root: root)
        let other = DownloadSnapshotCache(scope: "account-b", root: root)
        await first.save(file: source, key: "same")
        let isolated = await other.restore(key: "same", filename: "file")
        XCTAssertNil(isolated)
        await other.save(file: source, key: "same")
        await first.clear()
        await first.save(file: source, key: "same")
        let reopened = DownloadSnapshotCache(scope: "account-a", root: root)
        let cleared = await reopened.restore(key: "same", filename: "file")
        XCTAssertNil(cleared)
        let preserved = await other.restore(key: "same", filename: "file")
        let lease = try XCTUnwrap(preserved)
        defer { try? FileManager.default.removeItem(at: lease.deletingLastPathComponent()) }
        XCTAssertEqual(try Data(contentsOf: lease), Data([1, 2, 3]))
    }

    func testSizeBudgetEvictsOldestAndRejectsOversizedOrSymbolicFiles() async throws {
        let root = temporaryRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let source = root.appendingPathComponent("source")
        let cache = DownloadSnapshotCache(scope: "bounded", root: root, maximumBytes: 8)
        try Data(repeating: 1, count: 5).write(to: source)
        await cache.save(file: source, key: "old")
        try Data(repeating: 2, count: 5).write(to: source)
        await cache.save(file: source, key: "new")
        let old = await cache.restore(key: "old", filename: "old")
        XCTAssertNil(old)
        let newest = await cache.restore(key: "new", filename: "new")
        let lease = try XCTUnwrap(newest)
        defer { try? FileManager.default.removeItem(at: lease.deletingLastPathComponent()) }
        XCTAssertEqual(try Data(contentsOf: lease), Data(repeating: 2, count: 5))
        try Data(repeating: 3, count: 9).write(to: source)
        await cache.save(file: source, key: "oversize")
        let oversized = await cache.restore(key: "oversize", filename: "large")
        XCTAssertNil(oversized)
        let link = root.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: lease)
        await cache.save(file: link, key: "symlink")
        let symbolic = await cache.restore(key: "symlink", filename: "link")
        XCTAssertNil(symbolic)
    }

    private func temporaryRoot() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("DownloadSnapshotTests-" + UUID().uuidString)
    }
}
