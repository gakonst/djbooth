import Foundation
import CryptoKit

public enum ClientError: Error, LocalizedError, Sendable {
    case invalidEndpoint
    case http(Int, String)
    case conflict(SyncChange)
    case invalidMedia
    public var errorDescription: String? {
        switch self {
        case .invalidEndpoint: "Use an HTTPS server address, or HTTP on localhost for development."
        case let .http(status, message): "\(message) (\(status))"
        case .conflict: "This item changed on another device. Choose which version to keep."
        case .invalidMedia: "The audio download failed its integrity check. Please retry."
        }
    }
}

public struct Endpoint: Sendable {
    public let url: URL
    public init(_ string: String, loopbackOnly: Bool = false) throws {
        guard let value = URL(string: string), let host = value.host,
              value.user == nil, value.password == nil, value.query == nil, value.fragment == nil,
              value.path.isEmpty || value.path == "/" else { throw ClientError.invalidEndpoint }
        let local = ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host)
        guard (value.scheme == "https" || (value.scheme == "http" && local)), !loopbackOnly || local else {
            throw ClientError.invalidEndpoint
        }
        var canonical = URLComponents(url: value, resolvingAgainstBaseURL: false)!
        canonical.path = ""; canonical.host = host.lowercased()
        if (canonical.scheme == "https" && canonical.port == 443) || (canonical.scheme == "http" && canonical.port == 80) { canonical.port = nil }
        url = canonical.url!
    }
    public func path(_ parts: String...) -> URL {
        parts.reduce(url) { $0.appendingPathComponent($1) }
    }
    public func accountScope(_ accountID: String) -> String {
        SHA256.hash(data: Data("\(url.absoluteString)\n\(accountID)".utf8)).map { String(format: "%02x", $0) }.joined()
    }
    public var scope: String { SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined() }
}

private struct APIErrorBody: Decodable { struct Detail: Decodable { var message: String }; var error: Detail }

private final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
private enum Transport {
    static let session = URLSession(configuration: .default, delegate: NoRedirects(), delegateQueue: nil)
}

func checked(_ data: Data, _ response: URLResponse) throws -> Data {
    guard let http = response as? HTTPURLResponse else { throw ClientError.http(0, "No server response") }
    guard (200..<300).contains(http.statusCode) else {
        let message = (try? JSONDecoder().decode(APIErrorBody.self, from: data).error.message) ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
        throw ClientError.http(http.statusCode, message)
    }
    return data
}

private func decodeResponse<Value: Decodable & Sendable>(_ type: Value.Type, from data: Data) async throws -> Value {
    try await Task.detached(priority: .userInitiated) { try JSONDecoder().decode(type, from: data) }.value
}

public struct WorkstationClient: Sendable {
    public let endpoint: Endpoint
    private let session: URLSession
    public init(endpoint: Endpoint, session: URLSession? = nil) { self.endpoint = endpoint; self.session = session ?? Transport.session }
    public func get<T: Decodable & Sendable>(_ path: String, query: [URLQueryItem] = []) async throws -> T {
        var components = URLComponents(url: endpoint.url.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        components.queryItems = query.isEmpty ? nil : query
        var request = URLRequest(url: components.url!); request.timeoutInterval = 30
        let (data, response) = try await session.data(for: request)
        return try await decodeResponse(T.self, from: checked(data, response))
    }
    public func tracks(playlistID: String? = nil, offset: Int = 0) async throws -> TracksResponse {
        var query = [URLQueryItem(name: "limit", value: "500"), URLQueryItem(name: "offset", value: String(offset))]
        if let playlistID { query.append(URLQueryItem(name: "playlistId", value: playlistID)) }
        return try await get("api/tracks", query: query)
    }
    public func allTracks(playlistID: String? = nil) async throws -> [Track] {
        var result: [Track] = []
        while true {
            try Task.checkCancellation()
            let page = try await tracks(playlistID: playlistID, offset: result.count)
            result += page.items
            if result.count >= page.count { return result }
            if page.items.isEmpty { throw ClientError.http(409, "Library changed while loading; retry") }
        }
    }
    public func mutate(_ body: [String: String], token: String) async throws {
        try await post("api/mutations", body: JSONSerialization.data(withJSONObject: body), token: token)
    }
    public func setDownload(playlistID: String, enabled: Bool, token: String) async throws {
        try await post("api/hosted-mutations", body: JSONSerialization.data(withJSONObject: [
            "type": "set-hosted-playlist-download", "playlistId": playlistID, "enabled": enabled
        ]), token: token)
    }
    private func post(_ path: String, body: Data, token: String) async throws {
        var request = URLRequest(url: endpoint.url.appendingPathComponent(path))
        request.httpMethod = "POST"; request.httpBody = body; request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "x-djbooth-token")
        let (data, response) = try await session.data(for: request)
        _ = try checked(data, response)
    }
    public func audioURL(_ track: Track) -> URL? {
        if let id = track.localContentID, track.fileExists || track.hosted?.downloadState == "downloaded" {
            return endpoint.path("api", "audio", id)
        }
        if track.hosted?.provider == "soundcloud" { return endpoint.path("api", "hosted-audio", track.id) }
        return nil
    }
}

public struct CloudImportJob: Codable, Identifiable, Sendable, Equatable {
    public var id: String
    public var source: String
    public var status: String
    public var phase: String
    public var current: Int
    public var total: Int
    public var message: String
    public var collectionID: String?
    public var createdAt: Double
    public var updatedAt: Double
    public var isActive: Bool { status == "queued" || status == "running" }
}

public struct CloudAccount: Codable, Sendable {
    public let id: String
    public let grantId: String
    public let expiresAt: Int
    public let capabilities: [String]
}

public struct AgentTurn: Codable, Sendable {
    public let id: String
    public let status: String
    public let finalMessage: String?
    public let error: String?
}

public struct CloudClient: Sendable {
    public func agentTurn(id: String, input: String? = nil, cancel: Bool = false) async throws -> AgentTurn {
        guard id.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil else { throw ClientError.http(400, "Invalid agent turn") }
        var request = request(input != nil ? "v1/agent/turns" : "v1/agent/turns/\(id)\(cancel ? "/cancel" : "")", method: input != nil || cancel ? "POST" : "GET")
        if let input {
            request.httpBody = try JSONEncoder().encode(["id": id, "input": input])
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await session.data(for: request)
        return try await decodeResponse(AgentTurn.self, from: checked(data, response))
    }

    public func account() async throws -> CloudAccount {
        struct Session: Decodable, Sendable { let account: CloudAccount }
        let (data, response) = try await session.data(for: request("v1/auth/session"))
        let account = try await decodeResponse(Session.self, from: checked(data, response)).account
        guard account.id.range(of: "^nc_[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw ClientError.http(401, "Invalid account identity")
        }
        return account
    }
    public static func exchangeLogin(endpoint: Endpoint, code: String, verifier: String) async throws -> String {
        struct Login: Decodable, Sendable { let token: String }
        var request = URLRequest(url: endpoint.path("v1", "auth", "exchange"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["code": code, "verifier": verifier])
        let (data, response) = try await Transport.session.data(for: request)
        return try await decodeResponse(Login.self, from: checked(data, response)).token
    }

    public let endpoint: Endpoint
    private let token: String
    private let session: URLSession
    public init(endpoint: Endpoint, token: String, session: URLSession? = nil) {
        self.endpoint = endpoint; self.token = token; self.session = session ?? Transport.session
    }
    public func request(_ path: String, method: String = "GET") -> URLRequest {
        var request = URLRequest(url: endpoint.url.appendingPathComponent(path))
        request.httpMethod = method; request.timeoutInterval = 60
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }
    public func pull(after cursor: Int) async throws -> SyncPage {
        var request = request("v1/sync/changes")
        var components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "after", value: String(cursor)),
                                 URLQueryItem(name: "kinds", value: "track,collection,favorite,annotation")]
        request.url = components.url
        let (data, response) = try await session.data(for: request)
        return try await decodeResponse(SyncPage.self, from: checked(data, response))
    }
    public func push(_ operation: SyncOperation) async throws -> SyncChange {
        var request = request("v1/sync/changes", method: "POST")
        request.httpBody = try JSONEncoder().encode(operation)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.data(for: request)
        if (response as? HTTPURLResponse)?.statusCode == 409 {
            struct Conflict: Decodable, Sendable { var current: SyncChange }
            throw ClientError.conflict(try await decodeResponse(Conflict.self, from: data).current)
        }
        return try await decodeResponse(SyncChange.self, from: checked(data, response))
    }
    public func imports() async throws -> [CloudImportJob] {
        struct Page: Decodable, Sendable { var jobs: [CloudImportJob] }
        let (data, response) = try await session.data(for: request("v1/imports"))
        return try await decodeResponse(Page.self, from: checked(data, response)).jobs
    }
    public func submitImport(id: String, source: String) async throws -> CloudImportJob {
        try await importRequest("v1/imports", body: ["id": id, "source": source])
    }
    public func retryImport(id: String) async throws -> CloudImportJob {
        guard UUID(uuidString: id) != nil else { throw ClientError.http(400, "Invalid import ID") }
        return try await importRequest("v1/imports/\(id)/retry", body: [:])
    }
    private func importRequest(_ path: String, body: [String: String]) async throws -> CloudImportJob {
        var request = request(path, method: "POST")
        request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.data(for: request)
        return try await decodeResponse(CloudImportJob.self, from: checked(data, response))
    }
    public func upload(file: URL, hash: String) async throws {
        let job = Task.detached(priority: .utility) { try await uploadInBackground(file: file, hash: hash) }
        try await withTaskCancellationHandler { try await job.value } onCancel: { job.cancel() }
    }
    private func uploadInBackground(file: URL, hash: String) async throws {
        let length = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard hash.utf8.count == 64, hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              length > 0, length <= 4 * 1024 * 1024 * 1024 else { throw ClientError.invalidMedia }
        guard !(try await mediaExists(hash)) else { return }
        let chunkSize = 16 * 1024 * 1024
        if length <= chunkSize {
            try await uploadPart(file: file, hash: hash)
            return
        }
        struct Chunk: Encodable { var hash: String; var size: Int }
        struct Composition: Encodable { var chunks: [Chunk]; var contentType: String }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var chunks: [Chunk] = []
        while let data = try handle.read(upToCount: chunkSize), !data.isEmpty {
            try Task.checkCancellation()
            let partHash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            if !(try await mediaExists(partHash)) {
                let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
                defer { try? FileManager.default.removeItem(at: temporary) }
                try data.write(to: temporary, options: .atomic)
                try await uploadPart(file: temporary, hash: partHash)
            }
            chunks.append(Chunk(hash: partHash, size: data.count))
        }
        var compose = request("v1/media/\(hash)/compose", method: "POST")
        compose.timeoutInterval = 600
        compose.setValue("application/json", forHTTPHeaderField: "Content-Type")
        compose.httpBody = try JSONEncoder().encode(Composition(chunks: chunks, contentType: "application/octet-stream"))
        let (data, response) = try await session.data(for: compose)
        _ = try checked(data, response)
    }
    private func uploadPart(file: URL, hash: String) async throws {
        var upload = request("v1/media/\(hash)", method: "PUT")
        upload.timeoutInterval = 600
        upload.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        let size = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        upload.setValue(String(size), forHTTPHeaderField: "Content-Length")
        let (data, response) = try await session.upload(for: upload, fromFile: file)
        _ = try checked(data, response)
    }
    private func mediaExists(_ hash: String) async throws -> Bool {
        let (data, response) = try await session.data(for: request("v1/media/\(hash)", method: "HEAD"))
        if (response as? HTTPURLResponse)?.statusCode == 404 { return false }
        _ = try checked(data, response)
        return true
    }
    public func mediaRequest(hash: String) -> URLRequest { request("v1/media/\(hash)") }
}

@MainActor public final class SyncEngine {
    public private(set) var isRunning = false
    public init() {}
    public func sync(store: LibraryStore, client: CloudClient, progress: (String) -> Void = { _ in }) async throws {
        guard !isRunning else { return }
        isRunning = true; defer { isRunning = false }
        progress("Receiving library changes…")
        while true {
            try Task.checkCancellation()
            let previous = try store.cursor()
            let page = try await client.pull(after: previous)
            guard page.cursor >= previous, !page.hasMore || page.cursor > previous else {
                throw ClientError.http(409, "Cloud sync returned an invalid cursor")
            }
            try store.apply(page)
            if !page.hasMore { break }
        }
        var sent = 0
        let total = try store.pendingCount()
        while let operation = try store.nextOperation() {
            try Task.checkCancellation()
            progress("Syncing \(sent + 1) of \(total) changes…")
            do { try store.acknowledge(await client.push(operation)) }
            catch ClientError.conflict(let remote) { try store.markConflict(operation, remote: remote) }
            sent += 1
        }
        progress(try store.conflicts().isEmpty ? "Everything is up to date" : "Changes need your review")
    }
}

public actor AudioFiles {
    public let directory: URL
    private let session: URLSession
    public init(directory: URL, session: URLSession? = nil) throws {
        self.directory = directory
        self.session = session ?? Transport.session
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    public nonisolated func url(hash: String) -> URL? {
        guard hash.count == 64, hash.allSatisfy({ $0.isHexDigit && !$0.isUppercase }) else { return nil }
        return directory.appendingPathComponent(hash).appendingPathExtension("audio")
    }
    public func existing(hash: String) -> URL? {
        guard let file = url(hash: hash), FileManager.default.fileExists(atPath: file.path) else { return nil }
        return file
    }
    public func download(_ request: URLRequest, expectedHash: String? = nil) async throws -> (URL, String) {
        let (temporary, response) = try await session.download(for: request)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try Task.checkCancellation()
        _ = try checked(Data(), response)
        let hash = try await Self.hashAsync(temporary)
        if let expectedHash, hash != expectedHash { throw ClientError.invalidMedia }
        guard let destination = url(hash: hash) else { throw ClientError.invalidMedia }
        if !FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.moveItem(at: temporary, to: destination)
            var values = URLResourceValues(); values.isExcludedFromBackup = true
            var file = destination; try file.setResourceValues(values)
        }
        return (destination, hash)
    }
    public static func hash(_ file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file); defer { try? handle.close() }
        var digest = SHA256()
        while let bytes = try handle.read(upToCount: 1024 * 1024), !bytes.isEmpty {
            try Task.checkCancellation()
            digest.update(data: bytes)
        }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }
    public static func hashAsync(_ file: URL) async throws -> String {
        let job = Task.detached(priority: .utility) { try hash(file) }
        return try await withTaskCancellationHandler { try await job.value } onCancel: { job.cancel() }
    }
}
