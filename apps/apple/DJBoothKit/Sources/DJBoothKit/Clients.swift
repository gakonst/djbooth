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
    public struct SpeakerTrack: Encodable, Sendable {
        public let hash: String
        public let `extension`: String
        public init(hash: String, mediaExtension: String) { self.hash = hash; self.extension = mediaExtension }
    }
    public struct SpeakerSession: Decodable, Sendable {
        public let session: String
        public let expiresAt: Double
        public let urls: [String: URL]
    }
    public func speakerSession(tracks: [SpeakerTrack]) async throws -> SpeakerSession {
        var request = request("v1/playback", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["tracks": tracks])
        let (data, response) = try await session.data(for: request)
        return try await decodeResponse(SpeakerSession.self, from: checked(data, response))
    }
    public func revokeSpeakerSession(_ token: String) async throws {
        guard token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw ClientError.invalidMedia }
        let (data, response) = try await session.data(for: request("v1/playback/\(token)", method: "DELETE"))
        _ = try checked(data, response)
    }
    public func speakerMediaExists(hash: String) async throws -> Bool { try await mediaExists(hash) }
    public struct PhoneToolTicket: Decodable, Sendable {
        public let url: URL
        public let catalogDigest: String
    }
    public func phoneToolTicket() async throws -> PhoneToolTicket {
        let (data, response) = try await session.data(for: request("v1/agent/tool-host/ticket", method: "POST"))
        return try await decodeResponse(PhoneToolTicket.self, from: checked(data, response))
    }
    public func agentHistory(before: String? = nil) async throws -> MusicAgentHistory {
        var req = request("v1/agent/history")
        if let before {
            var url = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)!
            url.queryItems = [URLQueryItem(name: "before", value: before)]
            req.url = url.url
        }
        let (data, response) = try await session.data(for: req)
        return try await decodeResponse(MusicAgentHistory.self, from: checked(data, response))
    }
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
    private let soundCloudStreams = SoundCloudStreamCache()
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
    public func mediaChunk(hash: String, offset: Int64? = nil, length: Int = 512 * 1024) async throws -> (Data, Int64, String?) {
        guard hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              (1...512 * 1024).contains(length), offset == nil || offset! >= 0 else { throw ClientError.invalidMedia }
        var request = request("v1/media/" + hash, method: offset == nil ? "HEAD" : "GET")
        if let offset { request.setValue("bytes=\(offset)-\(offset + Int64(length) - 1)", forHTTPHeaderField: "Range") }
        let (data, response) = try await session.data(for: request)
        _ = try checked(data, response)
        guard let http = response as? HTTPURLResponse, data.count <= length else { throw ClientError.invalidMedia }
        let total: Int64?
        if let offset {
            guard http.statusCode == 206, let range = http.value(forHTTPHeaderField: "Content-Range"),
                  range.hasPrefix("bytes \(offset)-") else { throw ClientError.invalidMedia }
            total = range.split(separator: "/").last.flatMap { Int64($0) }
        } else { total = http.value(forHTTPHeaderField: "Content-Length").flatMap(Int64.init) }
        guard let total, total > 0 else { throw ClientError.invalidMedia }
        return (data, total, http.value(forHTTPHeaderField: "Content-Type"))
    }
    public func musicSources() async throws -> [MusicSource] {
        struct Page: Decodable, Sendable { let sources: [MusicSource] }
        do {
            let page: Page = try await musicGet("v1/music/sources")
            return page.sources
        } catch {
            if case ClientError.http(let status, _) = error, status == 401 || status == 403 { await soundCloudStreams.clear() }
            throw error
        }
    }
    public func recordingUploadAvailability(_ source: MusicSource) async throws -> RecordingUploadAvailability {
        guard source.provider == "soundcloud" else { throw ClientError.http(400, "Select a SoundCloud account") }
        return try await musicGet(source.route + "/recordings", forceRefresh: true)
    }
    public func uploadRecording(file: URL, source: MusicSource, title: String, description: String, uploadID: String, progress: (@Sendable (String) -> Void)? = nil) async throws -> RecordingUploadResult {
        let availability = try await recordingUploadAvailability(source)
        guard availability.available else { throw ClientError.http(503, availability.reason ?? "SoundCloud recording uploads are unavailable") }
        guard description.unicodeScalars.count <= 4000 else {
            throw ClientError.http(400, "The full tracklist exceeds SoundCloud's 4,000-character description limit. Export it intact; it has not been shortened.")
        }
        progress?("Checking recorded audio…")
        let hash = try await Task.detached(priority: .utility) {
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            var digest = SHA256()
            while let part = try handle.read(upToCount: 1024 * 1024), !part.isEmpty {
                try Task.checkCancellation(); digest.update(data: part)
            }
            return digest.finalize().map { String(format: "%02x", $0) }.joined()
        }.value
        try await upload(file: file, hash: hash) { value in
            progress?(value < 1 ? "Uploading audio \(Int(value * 100))%" : "Verifying cloud audio…")
        }
        progress?("Publishing to SoundCloud…")
        var publish = request(source.route + "/recordings", method: "POST")
        publish.timeoutInterval = 3600
        publish.setValue("application/json", forHTTPHeaderField: "Content-Type")
        publish.httpBody = try JSONEncoder().encode(["audioHash": hash, "title": title,
            "description": description, "uploadID": uploadID])
        // Never replay POST automatically: a lost response may already have created the track.
        let (data, response) = try await session.data(for: publish)
        return try await decodeResponse(RecordingUploadResult.self, from: checked(data, response))
    }
    public func musicPlaylists(_ source: MusicSource, cursor: String? = nil) async throws -> MusicPlaylistPage {
        try await musicGet(source.route + "/playlists", cursor: cursor)
    }
    public func musicPlaylist(_ playlist: MusicPlaylist, source: MusicSource) async throws -> MusicPlaylistSnapshot {
        try await musicGet(source.route + "/playlists/" + musicID(playlist.remoteID))
    }
    public func invalidateMusicStream(_ track: MusicTrack, source: MusicSource) async {
        await soundCloudStreams.invalidate(.init(sourceID: source.id, accountID: source.accountID, trackID: track.remoteID))
    }
    public func musicStream(_ track: MusicTrack, source: MusicSource, forceRefresh: Bool = false) async throws -> URL {
        guard source.provider == "soundcloud" else { throw ClientError.http(400, "This connection does not provide SoundCloud streams") }
        let key = SoundCloudStreamCache.Key(sourceID: source.id, accountID: source.accountID, trackID: track.remoteID)
        if forceRefresh { await soundCloudStreams.invalidate(key) }
        return try await soundCloudStreams.value(for: key, load: {
            try await resolveSoundCloudStream(track, source: source, forceRefresh: forceRefresh)
        }, validate: {
            guard try await musicSources().contains(where: { $0.id == source.id && $0.accountID == source.accountID }) else {
                throw ClientError.http(403, "This SoundCloud connection is no longer approved")
            }
        })
    }
    private func resolveSoundCloudStream(_ track: MusicTrack, source: MusicSource, forceRefresh: Bool) async throws -> URL {
        struct Stream: Decodable, Sendable { let url: URL }
        let stream: Stream = try await musicGet(source.route + "/tracks/" + musicID(track.remoteID) + "/stream", forceRefresh: forceRefresh)
        let host = stream.url.host?.lowercased() ?? ""
        let query = URLComponents(url: stream.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let credentialFields = ["oauth_token", "access_token", "refresh_token", "client_secret"]
        guard stream.url.scheme == "https",
              host.hasSuffix(".sndcdn.com") || host == "playback.media-streaming.soundcloud.cloud",
              stream.url.user == nil, stream.url.password == nil,
              stream.url.port == nil || stream.url.port == 443, stream.url.fragment == nil,
              !query.contains(where: { credentialFields.contains($0.name.lowercased()) }) else {
            throw ClientError.http(502, "SoundCloud did not return a playable stream. Please retry.")
        }
        return stream.url
    }
    public func downloadMusicPlaylist(_ playlist: MusicPlaylist, source: MusicSource, id: String) async throws -> CloudImportJob {
        try await importRequest(source.route + "/playlists/" + musicID(playlist.remoteID) + "/download", body: ["id": id])
    }
    private func musicID(_ id: String) throws -> String {
        guard id.range(of: "^[A-Za-z0-9:_-]+$", options: .regularExpression) != nil else {
            throw ClientError.http(400, "Invalid music identifier")
        }
        // URL.appendingPathComponent performs encoding; pre-encoding would encode '%' twice.
        return id
    }
    private func musicGet<T: Decodable & Sendable>(_ path: String, cursor: String? = nil, forceRefresh: Bool = false) async throws -> T {
        var request = request(path)
        if forceRefresh { request.setValue("no-cache", forHTTPHeaderField: "Cache-Control"); request.cachePolicy = .reloadIgnoringLocalCacheData }
        if let cursor {
            var url = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
            url.queryItems = [URLQueryItem(name: "cursor", value: cursor)]; request.url = url.url
        }
        for attempt in 0...1 {
            do {
                let (data, response) = try await session.data(for: request)
                return try await decodeResponse(T.self, from: checked(data, response))
            } catch let error as URLError where attempt == 0 && [.networkConnectionLost, .timedOut, .cannotConnectToHost].contains(error.code) {
                try Task.checkCancellation()
                try await Task.sleep(for: .milliseconds(250))
            }
        }
        throw URLError(.networkConnectionLost)
    }
    public func imports() async throws -> [CloudImportJob] {
        struct Page: Decodable, Sendable { var jobs: [CloudImportJob] }
        let (data, response) = try await session.data(for: request("v1/imports"))
        return try await decodeResponse(Page.self, from: checked(data, response)).jobs
    }
    public func submitImport(id: String, source: String) async throws -> CloudImportJob {
        try await importRequest("v1/imports", body: ["id": id, "source": source])
    }
    public func retryImport(id: String, requestID: String = UUID().uuidString, refresh: Bool = false) async throws -> CloudImportJob {
        guard UUID(uuidString: id) != nil else { throw ClientError.http(400, "Invalid import ID") }
        return try await importRequest("v1/imports/\(id)/retry", body: ["requestID": requestID, "mode": refresh ? "refresh" : "failed"])
    }
    public func importStatus(id: String, offset: Int = 0) async throws -> String {
        guard UUID(uuidString: id) != nil, offset >= 0, offset % 50 == 0 else { throw ClientError.http(400, "Invalid import ID or report offset") }
        var req = request("v1/imports/\(id)")
        var components = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "offset", value: String(offset))]; req.url = components.url
        let (data, response) = try await session.data(for: req)
        return String(decoding: try checked(data, response), as: UTF8.self)
    }
    private func importRequest(_ path: String, body: [String: String]) async throws -> CloudImportJob {
        var request = request(path, method: "POST")
        request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.data(for: request)
        return try await decodeResponse(CloudImportJob.self, from: checked(data, response))
    }
    public func upload(file: URL, hash: String, progress: (@Sendable (Double) -> Void)? = nil) async throws {
        let job = Task.detached(priority: .utility) { try await uploadInBackground(file: file, hash: hash, progress: progress) }
        try await withTaskCancellationHandler { try await job.value } onCancel: { job.cancel() }
    }
    private func uploadInBackground(file: URL, hash: String, progress: (@Sendable (Double) -> Void)?) async throws {
        progress?(0)
        let length = try file.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard hash.utf8.count == 64, hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              length > 0, length <= 4 * 1024 * 1024 * 1024 else { throw ClientError.invalidMedia }
        guard !(try await mediaExists(hash)) else { progress?(1); return }
        let chunkSize = 16 * 1024 * 1024
        if length <= chunkSize {
            try await uploadPart(file: file, hash: hash)
            progress?(1)
            return
        }
        struct Chunk: Encodable { var hash: String; var size: Int }
        struct Composition: Encodable { var chunks: [Chunk]; var contentType: String }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var chunks: [Chunk] = []
        var transferred = 0
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
            transferred += data.count; progress?(Double(transferred) / Double(length))
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

    private func crewGet<Value: Decodable & Sendable>(_ path: String, as type: Value.Type = Value.self) async throws -> Value {
        let (data, response) = try await session.data(for: request(path))
        return try await decodeResponse(type, from: checked(data, response))
    }
    private func crewSend<Value: Decodable & Sendable, Body: Encodable>(
        _ path: String, method: String = "POST", body: Body, as type: Value.Type = Value.self
    ) async throws -> Value {
        var value = request(path, method: method)
        value.setValue("application/json", forHTTPHeaderField: "Content-Type")
        value.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: value)
        return try await decodeResponse(type, from: checked(data, response))
    }
    public func crews() async throws -> [CrewSummary] {
        struct Response: Decodable, Sendable { var crews: [CrewSummary] }
        return try await crewGet("v1/crews", as: Response.self).crews
    }
    public func createCrew(name: String, displayName: String = "You") async throws -> CrewSummary {
        struct Body: Encodable { var name: String; var displayName: String }
        return try await crewSend("v1/crews", body: Body(name: name, displayName: displayName))
    }
    public func crew(_ id: String) async throws -> CrewDetail {
        try await crewGet("v1/crews/\(id)")
    }
    public func createCrewInvite(crewID: String, role: CrewRole = .dj) async throws -> CrewInvite {
        struct Body: Encodable { var role: CrewRole }
        return try await crewSend("v1/crews/\(crewID)/invites", body: Body(role: role))
    }
    public func acceptCrewInvite(token: String, displayName: String = "DJ") async throws -> CrewDetail {
        struct Body: Encodable { var displayName: String }
        return try await crewSend("v1/crew-invites/\(token)/accept", body: Body(displayName: displayName))
    }
    public func observeCrew(_ crewID: String?, onChange: @escaping @Sendable () async -> Void) async throws {
        var req = request(crewID.map { "v1/crews/\($0)/events" } ?? "v1/crews/events")
        var url = URLComponents(url: req.url!, resolvingAgainstBaseURL: false)!
        url.scheme = url.scheme == "https" ? "wss" : "ws"
        req.url = url.url
        let socket = session.webSocketTask(with: req)
        socket.resume()
        defer { socket.cancel(with: .goingAway, reason: nil) }
        try await withTaskCancellationHandler {
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask {
                    while !Task.isCancelled {
                        let message = try await socket.receive()
                        if case .string(let text) = message, text.contains("\"changed\"") { await onChange() }
                    }
                }
                group.addTask {
                    while !Task.isCancelled {
                        try await Task.sleep(for: .seconds(25))
                        try await socket.send(.string("ping"))
                    }
                }
                do { _ = try await group.next() }
                catch { socket.cancel(with: .goingAway, reason: nil); group.cancelAll(); throw error }
                group.cancelAll()
            }
        } onCancel: { socket.cancel(with: .goingAway, reason: nil) }
    }
    public static func previewCrewInvite(_ invite: CrewInviteLink) async throws -> CrewInvitePreview {
        let endpoint = invite.url.deletingLastPathComponent().deletingLastPathComponent()
        let url = endpoint.appendingPathComponent("v1/crew-invites").appendingPathComponent(invite.token)
        let (data, response) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(CrewInvitePreview.self, from: checked(data, response))
    }
    public func createCrewCrate(crewID: String, name: String, note: String? = nil) async throws -> CrewCrate {
        struct Body: Encodable { var name: String; var note: String? }
        return try await crewSend("v1/crews/\(crewID)/crates", body: Body(name: name, note: note))
    }
    public func crewCrate(crewID: String, crateID: String) async throws -> CrewCrateDetail {
        try await crewGet("v1/crews/\(crewID)/crates/\(crateID)")
    }
    public func addCrewTrack(crewID: String, crateID: String, track: Track, note: String? = nil) async throws -> CrewCrateDetail {
        struct Body: Encodable { var track: CrewTrackReference; var note: String? }
        return try await crewSend("v1/crews/\(crewID)/crates/\(crateID)/items", body: Body(track: CrewTrackReference(track), note: note))
    }
    public func removeCrewTrack(crewID: String, crateID: String, itemID: String) async throws {
        let (data, response) = try await session.data(for: request("v1/crews/\(crewID)/crates/\(crateID)/items/\(itemID)", method: "DELETE"))
        _ = try checked(data, response)
    }
    public func moveCrewTrack(crewID: String, crateID: String, itemID: String, afterItemID: String?) async throws -> CrewCrateDetail {
        struct Body: Encodable { var afterItemID: String? }
        return try await crewSend("v1/crews/\(crewID)/crates/\(crateID)/items/\(itemID)", method: "PATCH", body: Body(afterItemID: afterItemID))
    }
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
    /// Small, already bounded artifacts share the same immutable hash namespace as audio/ANLZ.
    public func store(_ data: Data, expectedHash: String) throws -> URL {
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard hash == expectedHash, var destination = url(hash: hash) else { throw ClientError.invalidMedia }
        try Task.checkCancellation()
        try data.write(to: destination, options: .atomic)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try destination.setResourceValues(values)
        return destination
    }
    public func download(_ request: URLRequest, expectedHash: String? = nil, session: URLSession? = nil) async throws -> (URL, String) {
        let (temporary, response) = try await (session ?? self.session).download(for: request)
        defer { try? FileManager.default.removeItem(at: temporary) }
        try Task.checkCancellation()
        _ = try checked(Data(), response)
        let hash = try await Self.hashAsync(temporary)
        if let expectedHash, hash != expectedHash { throw ClientError.invalidMedia }
        guard let destination = url(hash: hash) else { throw ClientError.invalidMedia }
        // The name alone does not prove an existing cache file is intact.
        // Install the verified bytes atomically, including when repairing it.
        if FileManager.default.fileExists(atPath: destination.path) {
            _ = try FileManager.default.replaceItemAt(destination, withItemAt: temporary)
        } else {
            try FileManager.default.moveItem(at: temporary, to: destination)
        }
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var file = destination; try file.setResourceValues(values)
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
