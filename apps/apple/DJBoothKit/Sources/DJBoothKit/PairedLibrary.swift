import Foundation
import CryptoKit
import Security
import ImageIO

public enum PairedLibraryError: Error, LocalizedError, Sendable {
    case invalidDescriptor, invalidCatalog, wrongLibrary, staleRevision, invalidTrack
    public var errorDescription: String? {
        switch self {
        case .invalidDescriptor: "Invalid Mac library pairing. Scan a new pairing code from your Mac."
        case .invalidCatalog: "The Mac returned an invalid library catalog."
        case .wrongLibrary: "This response belongs to a different Mac library. Pair again."
        case .staleRevision: "This recording changed on your Mac. Refresh the library and retry."
        case .invalidTrack: "The Mac did not provide valid audio and analysis hashes for this recording."
        }
    }
}

private func pairedHash(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}
private func pairedIdentity(_ value: String) -> Bool {
    !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && value.utf8.count <= 4096 &&
        !value.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
}
private func pairedComponent(_ value: String) -> String {
    // Encode separators too, so opaque library/track IDs cannot alias each other.
    value.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"))!
}

/// Pairing credentials belong in the app's Keychain, never in the library cache.
public struct PairedLibrary: Codable, Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
    public let version: Int
    public let url: URL
    public let certificateSHA256: String
    public let token: String
    public let libraryID: String
    public let name: String

    public init(version: Int = 1, url: URL, certificateSHA256: String, token: String, libraryID: String, name: String) throws {
        guard version == 1, url.scheme == "https", let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/", url.baseURL == nil,
              url.port.map({ (1...65535).contains($0) }) ?? true,
              pairedHash(certificateSHA256), pairedHash(token.lowercased()),
              pairedIdentity(libraryID), pairedIdentity(name),
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            throw PairedLibraryError.invalidDescriptor
        }
        components.host = host.lowercased(); components.path = ""
        if components.port == 443 { components.port = nil }
        guard let canonical = components.url else { throw PairedLibraryError.invalidDescriptor }
        self.version = version; self.url = canonical; self.certificateSHA256 = certificateSHA256
        self.token = token; self.libraryID = libraryID; self.name = name
    }
    public init(json: Data) throws {
        do { self = try JSONDecoder().decode(Self.self, from: json) }
        catch { throw PairedLibraryError.invalidDescriptor }
    }
    private enum CodingKeys: String, CodingKey { case version, url, certificateSHA256, token, libraryID, name }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(version: values.decode(Int.self, forKey: .version), url: values.decode(URL.self, forKey: .url),
                      certificateSHA256: values.decode(String.self, forKey: .certificateSHA256),
                      token: values.decode(String.self, forKey: .token), libraryID: values.decode(String.self, forKey: .libraryID),
                      name: values.decode(String.self, forKey: .name))
    }
    public var description: String { "PairedLibrary(\(libraryID), \(url.absoluteString), credentials redacted)" }
    public var debugDescription: String { description }
}

public struct PairedLibraryPlaylist: Codable, Sendable, Equatable, Identifiable {
    public let id, name, parentId, type: String
    public let seq: Int
    public let trackIDs: [String]
    public init(id: String, name: String, parentId: String = "root", type: String = "playlist", seq: Int = 0, trackIDs: [String] = []) {
        self.id = id; self.name = name; self.parentId = parentId; self.type = type; self.seq = seq; self.trackIDs = trackIDs
    }
}

/// Read-only local replica. Raw IDs and empty folders survive refresh and persistence.
public struct PairedLibrarySnapshot: Codable, Sendable, Equatable {
    public let libraryID, name: String
    public let tracks: [Track]
    public let playlists: [PairedLibraryPlaylist]

    public init(libraryID: String, name: String, tracks: [Track], playlists: [PairedLibraryPlaylist]) throws {
        self.libraryID = libraryID; self.name = name; self.tracks = tracks; self.playlists = playlists
        try validate()
    }
    private enum CodingKeys: String, CodingKey { case libraryID, name, tracks, playlists }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(libraryID: values.decode(String.self, forKey: .libraryID), name: values.decode(String.self, forKey: .name),
                      tracks: values.decode([Track].self, forKey: .tracks), playlists: values.decode([PairedLibraryPlaylist].self, forKey: .playlists))
    }
    private func validate() throws {
        let trackIDs = Set(tracks.map(\.id)), playlistIDs = Set(playlists.map(\.id))
        guard pairedIdentity(libraryID), pairedIdentity(name), trackIDs.count == tracks.count,
              playlistIDs.count == playlists.count, !playlistIDs.contains("root"),
              tracks.allSatisfy({ pairedIdentity($0.id) && $0.sourceRevision.map(pairedIdentity) == true }),
              playlists.allSatisfy({ pairedIdentity($0.id) && pairedIdentity($0.name) &&
                  ["folder", "playlist", "smart"].contains($0.type) && $0.trackIDs.allSatisfy(trackIDs.contains) &&
                  ($0.type != "folder" || $0.trackIDs.isEmpty) }) else { throw PairedLibraryError.invalidCatalog }
        let folders = Dictionary(uniqueKeysWithValues: playlists.filter { $0.type == "folder" }.map { ($0.id, $0) })
        for playlist in playlists {
            var parent = playlist.parentId, visited: Set<String> = [playlist.id]
            while parent != "root" {
                guard visited.insert(parent).inserted, let folder = folders[parent] else { throw PairedLibraryError.invalidCatalog }
                parent = folder.parentId
            }
        }
    }
    public func projectedTrackID(_ rawID: String) -> String { "paired:\(pairedComponent(libraryID)):track:\(pairedComponent(rawID))" }
    public func rawTrackID(for projectedID: String) -> String? {
        let prefix = "paired:\(pairedComponent(libraryID)):track:"
        guard projectedID.hasPrefix(prefix), let raw = String(projectedID.dropFirst(prefix.count)).removingPercentEncoding,
              projectedTrackID(raw) == projectedID, tracks.contains(where: { $0.id == raw }) else { return nil }
        return raw
    }
    public var projectedTracks: [Track] {
        tracks.map { raw in var track = raw; track.id = projectedTrackID(raw.id); return track }
    }
    private var orderedPlaylists: [PairedLibraryPlaylist] {
        let children = Dictionary(grouping: playlists.enumerated(), by: { $0.element.parentId })
        func descend(_ parent: String) -> [PairedLibraryPlaylist] {
            (children[parent] ?? []).sorted {
                $0.element.seq == $1.element.seq ? $0.offset < $1.offset : $0.element.seq < $1.element.seq
            }.flatMap { [$0.element] + descend($0.element.id) }
        }
        return descend("root")
    }
    private func playlistID(_ rawID: String) -> String { "paired:\(pairedComponent(libraryID)):playlist:\(pairedComponent(rawID))" }
    public var folderRootID: String { "paired:\(pairedComponent(libraryID)):root" }
    public func folderName(for projectedFolderID: String) -> String? {
        if projectedFolderID == folderRootID { return name }
        return playlists.first { $0.type == "folder" && playlistID($0.id) == projectedFolderID }?.name
    }
    private func path(to parentID: String, usingIDs: Bool = false) -> [String] {
        let folders = Dictionary(uniqueKeysWithValues: playlists.filter { $0.type == "folder" }.map { ($0.id, $0) })
        var parent = parentID, path: [String] = []
        while let folder = folders[parent] {
            path.insert(usingIDs ? playlistID(folder.id) : folder.name, at: 0); parent = folder.parentId
        }
        return [usingIDs ? folderRootID : name] + path
    }
    /// Includes empty folders, which have no Collection row to infer their path from.
    public var folderPaths: [[String]] { [[name]] + orderedPlaylists.filter { $0.type == "folder" }.map { path(to: $0.id) } }
    /// ID-based alternatives distinguish same-name sibling folders. Resolve labels with folderName.
    public var folderIDPaths: [[String]] { [[folderRootID]] + orderedPlaylists.filter { $0.type == "folder" }.map { path(to: $0.id, usingIDs: true) } }
    public var collections: [Collection] { collections(usingIDs: false) }
    public var collectionsWithFolderIDs: [Collection] { collections(usingIDs: true) }
    private func collections(usingIDs: Bool) -> [Collection] {
        orderedPlaylists.filter { $0.type != "folder" }.map {
            Collection(id: playlistID($0.id), name: $0.name,
                       trackIDs: $0.trackIDs.map(projectedTrackID), folderPath: path(to: $0.parentId, usingIDs: usingIDs))
        }
    }
    /// A full catalog replaces membership/deletions, not local download ownership.
    public func merging(_ catalog: Self) throws -> Self {
        guard catalog.libraryID == libraryID else { throw PairedLibraryError.wrongLibrary }
        let previous = Dictionary(uniqueKeysWithValues: tracks.map { ($0.id, $0) })
        let refreshed = catalog.tracks.map { remote in
            var track = Self.metadataOnly(remote)
            if let old = previous[remote.id], old.sourceRevision == remote.sourceRevision {
                if old.fileExists { track = Self.copyDownloads(from: old, to: track) }
                track.artworkHash = old.artworkHash
            }
            return track
        }
        return try Self(libraryID: libraryID, name: catalog.name, tracks: refreshed, playlists: catalog.playlists)
    }
    /// Call only with the verified result of PairedLibraryClient.download.
    public func updating(_ downloadedTrack: Track) throws -> Self {
        guard let index = tracks.firstIndex(where: { $0.id == downloadedTrack.id }),
              tracks[index].sourceRevision == downloadedTrack.sourceRevision else { throw PairedLibraryError.staleRevision }
        guard downloadedTrack.fileExists else { throw PairedLibraryError.invalidTrack }
        try PairedLibraryClient.validateMedia(downloadedTrack)
        var updated = tracks
        updated[index] = Self.copyDownloads(from: downloadedTrack, to: updated[index])
        return try Self(libraryID: libraryID, name: name, tracks: updated, playlists: playlists)
    }
    /// Artwork can be backfilled without changing audio ownership or readiness.
    public func updatingArtwork(_ verified: Track) throws -> Self {
        guard let index = tracks.firstIndex(where: { $0.id == verified.id }),
              tracks[index].sourceRevision == verified.sourceRevision else { throw PairedLibraryError.staleRevision }
        guard verified.artworkHash.map(pairedHash) ?? true else { throw PairedLibraryError.invalidTrack }
        var updated = tracks
        updated[index].artworkHash = verified.artworkHash
        updated[index].artworkAvailable = verified.artworkHash != nil
        return try Self(libraryID: libraryID, name: name, tracks: updated, playlists: playlists)
    }
    fileprivate static func metadataOnly(_ value: Track) -> Track {
        var track = value
        track.fileExists = false; track.analyzed = false; track.mediaHash = nil; track.mediaExtension = nil
        track.analysis = nil; track.waveform = nil; track.artworkHash = nil
        return track
    }
    private static func copyDownloads(from source: Track, to value: Track) -> Track {
        var track = value
        track.mediaHash = source.mediaHash; track.mediaExtension = source.mediaExtension
        track.analysis = source.analysis; track.waveform = source.waveform
        track.fileExists = source.fileExists; track.analyzed = source.analysis != nil
        return track
    }
}

/// A private session: its sole server-trust exception is the paired origin's exact DER certificate.
private final class PairedLibraryTrust: NSObject, URLSessionDelegate, URLSessionTaskDelegate, Sendable {
    let origin: URL
    let pin: String
    init(origin: URL, pin: String) { self.origin = origin; self.pin = pin }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let space = challenge.protectionSpace
        guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              space.protocol == "https", space.host.lowercased() == origin.host?.lowercased(),
              space.port == (origin.port ?? 443),
              let trust = space.serverTrust, let certificates = SecTrustCopyCertificateChain(trust) as? [SecCertificate],
              let certificate = certificates.first,
              SHA256.hash(data: SecCertificateCopyData(certificate) as Data).map({ String(format: "%02x", $0) }).joined() == pin else {
            completionHandler(.cancelAuthenticationChallenge, nil); return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// All client instances share three download slots, leaving the server's
/// fourth request slot available for a catalog refresh. Waiters are FIFO.
private actor PairedDownloadLimit {
    static let shared = PairedDownloadLimit()
    private var active = 0
    private var waiters: [(UUID, CheckedContinuation<Void, any Error>)] = []

    func run<Value: Sendable>(_ operation: @Sendable () async throws -> Value) async throws -> Value {
        try Task.checkCancellation()
        if active < 3 { active += 1 }
        else {
            let id = UUID()
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { continuation in
                    waiters.append((id, continuation))
                }
            } onCancel: {
                Task { await self.cancel(id) }
            }
        }
        // A waiter may be granted its slot just before cancellation arrives.
        // Always release that grant, even when the operation never starts.
        defer {
            if waiters.isEmpty { active -= 1 }
            else { waiters.removeFirst().1.resume() }
        }
        try Task.checkCancellation()
        return try await operation()
    }

    private func cancel(_ id: UUID) {
        guard let index = waiters.firstIndex(where: { $0.0 == id }) else { return }
        waiters.remove(at: index).1.resume(throwing: CancellationError())
    }
}

public final class PairedLibraryClient: Sendable {
    private let pairing: PairedLibrary
    private let session: URLSession
    public init(_ pairing: PairedLibrary) {
        self.pairing = pairing
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil; configuration.httpCookieStorage = nil; configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        session = URLSession(configuration: configuration,
                             delegate: PairedLibraryTrust(origin: pairing.url, pin: pairing.certificateSHA256), delegateQueue: nil)
    }
    deinit { session.invalidateAndCancel() }

    private func request(_ parts: [String], hash: String? = nil, mediaHash: String? = nil) throws -> URLRequest {
        guard parts.allSatisfy({ pairedIdentity($0) && $0 != "." && $0 != ".." }),
              hash.map(pairedHash) ?? true, mediaHash.map(pairedHash) ?? true,
              var components = URLComponents(url: pairing.url, resolvingAgainstBaseURL: false) else { throw PairedLibraryError.invalidTrack }
        components.percentEncodedPath = "/pair/v1/" + parts.map(pairedComponent).joined(separator: "/")
        if let hash { components.queryItems = [URLQueryItem(name: "hash", value: hash)] }
        if let mediaHash { components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "mediaHash", value: mediaHash)] }
        guard let url = components.url else { throw PairedLibraryError.invalidTrack }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(pairing.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }
    private func get<Value: Decodable>(_ type: Value.Type, parts: [String]) async throws -> Value {
        let data = try await retryBusy {
            let (data, response) = try await self.session.data(for: self.request(parts))
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw ClientError.http((response as? HTTPURLResponse)?.statusCode ?? 0, "Paired library request failed")
            }
            return data
        }
        return try JSONDecoder().decode(type, from: data)
    }
    private func retryBusy<Value: Sendable>(_ operation: @Sendable () async throws -> Value) async throws -> Value {
        // Only a transient service-capacity response retries. Authentication,
        // redirects, changed revisions and hash failures retain their errors.
        var attempt = 0
        while true {
            try Task.checkCancellation()
            do { return try await operation() }
            catch ClientError.http(503, _) where attempt < 3 {
                try await Task.sleep(for: .milliseconds(500 * (1 << attempt)))
                attempt += 1
            }
        }
    }
    public func catalog() async throws -> PairedLibrarySnapshot {
        let catalog = try await get(PairedLibrarySnapshot.self, parts: ["catalog"])
        guard catalog.libraryID == pairing.libraryID else { throw PairedLibraryError.wrongLibrary }
        return try PairedLibrarySnapshot(libraryID: catalog.libraryID, name: catalog.name,
                                        tracks: catalog.tracks.map(PairedLibrarySnapshot.metadataOnly), playlists: catalog.playlists)
    }
    /// Remote detail is not proof of phone-local availability. Use download before caching it.
    public func track(id: String) async throws -> Track {
        struct Detail: Decodable { let track: Track }
        var track = try await get(Detail.self, parts: ["tracks", id]).track
        guard track.id == id, track.sourceRevision.map(pairedIdentity) == true else { throw PairedLibraryError.invalidTrack }
        try Self.validateMedia(track)
        track.fileExists = false; track.analyzed = false
        if track.artworkHash.map(pairedHash) != true { track.artworkHash = nil }
        return track
    }
    private static let maximumArtworkBytes = 5 * 1024 * 1024

    /// A bounded thumbnail, decoded off the UI actor, never an unbounded full-size bitmap.
    private static func artworkImage(_ data: Data) throws -> CGImage {
        guard data.count <= maximumArtworkBytes,
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let type = CGImageSourceGetType(source) as String?, ["public.jpeg", "public.png"].contains(type),
              CGImageSourceGetStatus(source) == .statusComplete,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 16384, height <= 16384, width * height <= 40_000_000,
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1024, kCGImageSourceShouldCacheImmediately: true,
              ] as CFDictionary) else { throw ClientError.invalidMedia }
        return image
    }

    /// No network: usable after relaunch, with the server stopped. Corrupt files remain placeholders.
    public static func cachedArtwork(hash: String, files: AudioFiles) async throws -> CGImage? {
        guard pairedHash(hash), let file = await files.existing(hash: hash) else { return nil }
        let job = Task.detached(priority: .utility) {
            let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
            let data = try handle.read(upToCount: maximumArtworkBytes + 1) ?? Data()
            try Task.checkCancellation()
            guard SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == hash else { throw ClientError.invalidMedia }
            return try artworkImage(data)
        }
        return try await withTaskCancellationHandler { try await job.value } onCancel: { job.cancel() }
    }

    /// Optional artwork is a separate operation: it cannot block or invalidate a music download.
    public func artwork(trackID: String, to files: AudioFiles) async throws -> Track {
        try await PairedDownloadLimit.shared.run {
            let detail = try await self.track(id: trackID)
            guard let hash = detail.artworkHash else { return detail }
            if (try? await Self.cachedArtwork(hash: hash, files: files)) != nil { return detail }
            let data = try await self.retryBusy {
                let (bytes, response) = try await self.session.bytes(for: self.request(["tracks", trackID, "artwork"], hash: hash))
                defer { bytes.task.cancel() }
                _ = try checked(Data(), response)
                guard response.expectedContentLength <= Self.maximumArtworkBytes,
                      ["image/jpeg", "image/png"].contains(response.mimeType ?? "") else { throw ClientError.invalidMedia }
                var data = Data()
                for try await byte in bytes {
                    guard data.count < Self.maximumArtworkBytes else { throw ClientError.invalidMedia }
                    data.append(byte)
                }
                try Task.checkCancellation()
                _ = try Self.artworkImage(data)
                return data
            }
            _ = try await files.store(data, expectedHash: hash)
            return detail
        }
    }
    fileprivate static func validateMedia(_ track: Track) throws {
        guard let hash = track.mediaHash, pairedHash(hash), let ext = track.mediaExtension,
              !ext.isEmpty, ext.utf8.count <= 16,
              ext.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) }) else {
            throw PairedLibraryError.invalidTrack
        }
        if let analysis = track.analysis {
            guard analysis.mediaHash == hash, analysis.hashes.allSatisfy(pairedHash) else { throw PairedLibraryError.invalidTrack }
        }
    }
    /// Returns a raw-ID track only after every advertised object passes its SHA-256 check.
    /// Partial downloads remain harmless content-addressed files, not ready library rows.
    public func download(trackID: String, to files: AudioFiles) async throws -> Track {
        try await PairedDownloadLimit.shared.run {
            try await self.downloadAdmitted(trackID: trackID, to: files)
        }
    }
    private func downloadAdmitted(trackID: String, to files: AudioFiles) async throws -> Track {
        var detail = try await track(id: trackID)
        let hash = detail.mediaHash!
        _ = try await retryBusy {
            try await files.download(self.request(["tracks", trackID, "audio"], hash: hash), expectedHash: hash, session: self.session)
        }
        if let analysis = detail.analysis {
            for (kind, hash) in [("dat", analysis.dat), ("ext", analysis.ext), ("twoEx", analysis.twoEx)] {
                _ = try await retryBusy {
                    try await files.download(self.request(["tracks", trackID, "analysis", kind], hash: hash, mediaHash: analysis.mediaHash),
                                             expectedHash: hash, session: self.session)
                }
            }
        }
        let current = try await track(id: trackID)
        guard detail.sourceRevision == current.sourceRevision, detail.mediaHash == current.mediaHash,
              detail.analysis == current.analysis else { throw PairedLibraryError.staleRevision }
        if detail.waveform == nil, let analysis = detail.analysis {
            // Display decoding is optional; verified audio remains playable
            // even when an analysis tag is unsupported or malformed.
            detail.waveform = try? await USBAnalysis.read(analysis, files: files, duration: detail.durationSeconds ?? 0)
        }
        try Task.checkCancellation()
        detail.fileExists = true; detail.analyzed = detail.analysis != nil
        return detail
    }
}
