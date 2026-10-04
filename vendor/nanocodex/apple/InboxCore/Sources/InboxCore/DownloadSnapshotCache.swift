import CryptoKit
import Foundation
import Darwin

/// Account-scoped copies of validated downloads. Callers own disposable leases;
/// deleting a lease never deletes the retained original. Storage failures are misses.
public actor DownloadSnapshotCache {
    private let directory: URL?
    private let maximumBytes: Int64
    private var disabled = false
    private let files = FileManager.default

    public init(scope: String, root: URL? = nil) {
        directory = Self.directory(scope: scope, root: root)
        maximumBytes = 256 * 1024 * 1024
    }

    // A smaller budget exercises eviction without large test artifacts.
    init(scope: String, root: URL, maximumBytes: Int64) {
        directory = Self.directory(scope: scope, root: root)
        self.maximumBytes = max(0, maximumBytes)
    }

    public func restore(key: String, filename: String) -> URL? {
        guard !disabled, let directory else { return nil }
        let source = directory.appendingPathComponent(Self.digest(key))
        guard regularFileSize(source) != nil else { return nil }
        let name = (filename as NSString).lastPathComponent
        guard !name.isEmpty, name != ".", name != "..", name != "/",
              !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        let lease = files.temporaryDirectory.appendingPathComponent("NanocodexOutput-Offline-" + UUID().uuidString, isDirectory: true)
        do {
            try files.createDirectory(at: lease, withIntermediateDirectories: true)
            let copy = lease.appendingPathComponent(name)
            try files.copyItem(at: source, to: copy)
            guard regularFileSize(copy) != nil else {
                try? files.removeItem(at: lease)
                return nil
            }
            return copy
        } catch {
            try? files.removeItem(at: lease)
            return nil
        }
    }

    /// The caller must validate the server response before offering its file.
    /// This method copies bytes; it never takes ownership of the caller's URL.
    public func save(file: URL, key: String) {
        guard !disabled, let directory, let size = regularFileSize(file) else { return }
        let staging = directory.appendingPathComponent(".staging-" + UUID().uuidString)
        do {
            try files.createDirectory(at: directory, withIntermediateDirectories: true)
            var excluded = directory
            var attributes = URLResourceValues()
            attributes.isExcludedFromBackup = true
            try excluded.setResourceValues(attributes)
            defer { try? files.removeItem(at: staging) }
            try files.copyItem(at: file, to: staging)
            guard regularFileSize(staging) == size else { return }
            // Download source mtimes can predate this insertion.
            try files.setAttributes([.modificationDate: Date()], ofItemAtPath: staging.path)
            let target = directory.appendingPathComponent(Self.digest(key))
            let entries = try files.contentsOfDirectory(at: directory,
                includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey, .isSymbolicLinkKey],
                options: [.skipsHiddenFiles])
            var retained: [(url: URL, size: Int64, date: Date)] = []
            for entry in entries where entry != target {
                guard let count = regularFileSize(entry) else {
                    try files.removeItem(at: entry)
                    continue
                }
                let date = try entry.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate ?? .distantPast
                retained.append((entry, count, date))
            }
            var total = retained.reduce(size) { $0 + $1.size }
            for entry in retained.sorted(by: { $0.date < $1.date }) where total > maximumBytes {
                try files.removeItem(at: entry.url)
                total -= entry.size
            }
            guard total <= maximumBytes else { return }
            // Same-directory rename atomically replaces a prior snapshot without
            // loading a potentially large original into memory.
            guard Darwin.rename(staging.path, target.path) == 0 else { return }
        } catch {
            // An unavailable/full disk must not turn a successful download into
            // a failed preview. The validated caller-owned file remains intact.
        }
    }

    /// Retire this instance as well as deleting disk state: a download finishing
    /// after sign-out cannot refill the old store through this actor.
    public func clear() {
        disabled = true
        if let directory { try? files.removeItem(at: directory) }
    }

    private func regularFileSize(_ url: URL) -> Int64? {
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
              values.isRegularFile == true, values.isSymbolicLink != true,
              let count = values.fileSize, count >= 0, Int64(count) <= maximumBytes else { return nil }
        return Int64(count)
    }

    private static func directory(scope: String, root: URL?) -> URL? {
        let root = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("NanocodexDownloads", isDirectory: true)
        return root?.appendingPathComponent(digest(scope), isDirectory: true)
    }

    private static func digest(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
