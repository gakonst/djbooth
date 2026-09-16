import Foundation
import CryptoKit

/// Device-local access credentials. Never included in cloud track payloads or the sync outbox.
public struct USBDeviceAccess: Codable, Sendable, Equatable {
    public let id: String
    public let name: String
    public let bookmark: Data
    public var folderName: String { "USB · \(name)" }
}

public struct USBFileLocation: Codable, Sendable, Equatable {
    public let trackID: String
    public let deviceID: String
    public let path: String
    public let analysisPath: String
    public var sourceSignature: String? = nil
}

public enum USBDeviceFiles {
    public static func authorize(_ root: URL, previous: USBDeviceAccess? = nil) throws -> (USBDeviceAccess, USBRekordboxLibrary) {
        let scope = root.startAccessingSecurityScopedResource()
        defer { if scope { root.stopAccessingSecurityScopedResource() } }
        let library = try USBRekordboxLibrary.read(root: root)
        var identity: String?
        let marker = try containedURL(".music-cdj-export.json", root: root)
        if let size = try? marker.resourceValues(forKeys: [.fileSizeKey]).fileSize, size < 65_536,
           let data = try? Data(contentsOf: marker),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let id = object["mediaId"] as? String, let uuid = UUID(uuidString: id) {
            identity = uuid.uuidString.lowercased()
        }
        if identity == nil { identity = try? root.resourceValues(forKeys: [.volumeUUIDStringKey]).volumeUUIDString }
        if identity == nil, let previous, (try? resolve(previous)) == root { identity = previous.id }
        #if os(macOS)
        let options: URL.BookmarkCreationOptions = [.withSecurityScope]
        #else
        let options: URL.BookmarkCreationOptions = []
        #endif
        let bookmark = try root.bookmarkData(options: options, includingResourceValuesForKeys: nil, relativeTo: nil)
        return (USBDeviceAccess(id: identity ?? UUID().uuidString, name: root.lastPathComponent, bookmark: bookmark), library)
    }

    public static func resolve(_ access: USBDeviceAccess) throws -> URL {
        var stale = false
        #if os(macOS)
        let options: URL.BookmarkResolutionOptions = [.withSecurityScope, .withoutUI]
        #else
        let options: URL.BookmarkResolutionOptions = [.withoutUI]
        #endif
        return try URL(resolvingBookmarkData: access.bookmark, options: options, relativeTo: nil, bookmarkDataIsStale: &stale)
    }

    /// Poll only the granted catalog while the app is foregrounded. No volume enumeration or permission prompts.
    public static func signature(_ access: USBDeviceAccess) throws -> String {
        let root = try resolve(access)
        let scope = root.startAccessingSecurityScopedResource()
        defer { if scope { root.stopAccessingSecurityScopedResource() } }
        let file = try containedURL("PIONEER/rekordbox/export.pdb", root: root)
        let values = try file.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey])
        guard values.isRegularFile == true else { throw USBLibraryError.libraryNotFound }
        return "\(values.fileSize ?? 0):\(values.contentModificationDate?.timeIntervalSince1970 ?? 0)"
    }

    public static func containedURL(_ path: String, root: URL) throws -> URL {
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        guard !parts.isEmpty, !parts.contains(".."), !parts.contains("."), !path.contains("\0") else { throw USBLibraryError.invalidDatabase }
        let base = root.resolvingSymlinksInPath().standardizedFileURL
        let prefix = base.path.hasSuffix("/") ? base.path : base.path + "/"
        var file = base
        // Resolve each ancestor even when the final media file does not exist.
        for part in parts {
            file = file.appendingPathComponent(String(part)).resolvingSymlinksInPath().standardizedFileURL
            guard file.path.hasPrefix(prefix) else { throw USBLibraryError.invalidDatabase }
        }
        return file
    }

    public static func cacheAudio(_ location: USBFileLocation, access: USBDeviceAccess, directory: URL) throws -> (URL, String) {
        guard location.deviceID == access.id else { throw USBLibraryError.disconnected }
        let root = try resolve(access)
        let scope = root.startAccessingSecurityScopedResource()
        defer { if scope { root.stopAccessingSecurityScopedResource() } }
        let source = try containedURL(location.path, root: root)
        var coordinationError: NSError?
        var result: Result<(URL, String), Error>?
        NSFileCoordinator().coordinate(readingItemAt: source, options: [], error: &coordinationError) { coordinated in
            result = Result {
                try Task.checkCancellation()
                guard try coordinated.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else { throw ClientError.invalidMedia }
                let temporary = directory.appendingPathComponent(".usb-\(UUID().uuidString)")
                defer { try? FileManager.default.removeItem(at: temporary) }
                guard FileManager.default.createFile(atPath: temporary.path, contents: nil) else { throw ClientError.invalidMedia }
                let input = try FileHandle(forReadingFrom: coordinated)
                defer { try? input.close() }
                let output = try FileHandle(forWritingTo: temporary)
                defer { try? output.close() }
                var digest = SHA256(), size = 0
                while let chunk = try input.read(upToCount: 1_048_576), !chunk.isEmpty {
                    try Task.checkCancellation()
                    try output.write(contentsOf: chunk); digest.update(data: chunk); size += chunk.count
                }
                guard size > 0 else { throw ClientError.invalidMedia }
                try output.synchronize()
                let hash = digest.finalize().map { String(format: "%02x", $0) }.joined()
                let destination = directory.appendingPathComponent(hash).appendingPathExtension("audio")
                if !FileManager.default.fileExists(atPath: destination.path) {
                    try FileManager.default.moveItem(at: temporary, to: destination)
                    var values = URLResourceValues(); values.isExcludedFromBackup = true
                    var file = destination; try file.setResourceValues(values)
                }
                return (destination, hash)
            }
        }
        if let coordinationError { throw coordinationError }
        guard let result else { throw USBLibraryError.disconnected }
        return try result.get()
    }
}

extension AudioFiles {
    public func readUSB(_ location: USBFileLocation, access: USBDeviceAccess) async throws -> (URL, String) {
        let directory = directory
        let task = Task.detached(priority: .userInitiated) { try USBDeviceFiles.cacheAudio(location, access: access, directory: directory) }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }
}
