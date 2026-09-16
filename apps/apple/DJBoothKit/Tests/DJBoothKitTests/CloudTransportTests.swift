import Foundation
import CryptoKit
import Testing
@testable import DJBoothKit

private final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: (@Sendable (URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, data) = try Self.handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

private final class RequestLog: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [String] = []
    func append(_ value: String) { lock.lock(); defer { lock.unlock() }; requests.append(value) }
    func values() -> [String] { lock.lock(); defer { lock.unlock() }; return requests }
}

@Suite(.serialized) struct CloudTransportTests {
    private func session() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: configuration)
    }
    private func client(_ session: URLSession) throws -> CloudClient {
        CloudClient(endpoint: try Endpoint("https://library.example"), token: "private-test-token", session: session)
    }
    private static func body(_ request: URLRequest) -> Data {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var result = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            result.append(contentsOf: buffer.prefix(count))
        }
        return result
    }
    private static func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    @Test func accountIdentityIsVerifiedBeforeChoosingAnOfflineStore() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let client = try client(session)
        let id = "nc_" + String(repeating: "a", count: 64)
        StubProtocol.handler = { request in
            #expect(request.url?.path == "/v1/auth/session")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer private-test-token")
            return (200, Data("{\"account\":{\"id\":\"\(id)\",\"grantId\":\"grant\",\"expiresAt\":2000000000,\"capabilities\":[]}}".utf8))
        }
        #expect(try await client.account().id == id)
        let endpoint = try Endpoint("https://library.example")
        #expect(endpoint.accountScope(id) != endpoint.accountScope("nc_" + String(repeating: "b", count: 64)))
        #expect(endpoint.accountScope(id) == (try Endpoint("https://LIBRARY.example:443/")).accountScope(id))
        #expect(endpoint.accountScope(id) != endpoint.scope)
        StubProtocol.handler = { _ in (401, Data("{\"error\":{\"message\":\"Sign in again\"}}".utf8)) }
        await #expect(throws: ClientError.self) { try await client.account() }
    }

    @Test func soundCloudURNIsEncodedOnceAndStreamCarriesAccountGrant() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let client = try client(session)
        let source = MusicSource(id: "soundcloud:a", provider: "soundcloud", connectionID: "a", accountID: "123", label: "SC")
        let track = MusicTrack(id: "t", remoteID: "soundcloud:tracks:123", title: "Track", artists: [], durationSeconds: 1, url: "https://soundcloud.com/a/t", available: true)
        StubProtocol.handler = { request in
            #expect(request.url?.path == "/v1/music/soundcloud/a/tracks/soundcloud:tracks:123/stream")
            #expect(request.url?.absoluteString.contains("%25") == false)
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer private-test-token")
            return (200, Data(#"{"url":"https://media.sndcdn.com/audio.m3u8?Policy=signed"}"#.utf8))
        }
        #expect(try await client.musicStream(track, source: source).host == "media.sndcdn.com")
        StubProtocol.handler = { _ in (200, Data(#"{"url":"https://evil.example/audio.m3u8"}"#.utf8)) }
        await #expect(throws: ClientError.self) { try await client.musicStream(track, source: source) }
    }

    @Test func cloudImportsPreserveRequestIdentityAndDecodeProgress() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let client = try client(session)
        let id = "12345678-1234-1234-1234-123456789abc"
        let source = "https://soundcloud.com/artist/sets/playlist"
        let payload = Data("{\"id\":\"\(id)\",\"source\":\"\(source)\",\"status\":\"running\",\"phase\":\"analyze\",\"current\":2,\"total\":8,\"message\":\"Analyzing recordings\",\"createdAt\":123,\"updatedAt\":456}".utf8)
        StubProtocol.handler = { request in
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer private-test-token")
            #expect(request.url?.path == "/v1/imports")
            let body = try JSONDecoder().decode([String: String].self, from: Self.body(request))
            #expect(body["id"] == id); #expect(body["source"] == source)
            return (200, payload)
        }
        let job = try await client.submitImport(id: id, source: source)
        #expect(job.isActive); #expect(job.current == 2); #expect(job.total == 8)
        StubProtocol.handler = { request in
            #expect(request.url?.path == "/v1/imports/\(id)/retry")
            return (200, payload)
        }
        #expect(try await client.retryImport(id: id).id == id)
        StubProtocol.handler = { _ in (200, Data("{\"jobs\":[".utf8) + payload + Data("]}".utf8)) }
        #expect(try await client.imports().count == 1)
    }

    @Test func pullCarriesAuthenticationAndCursorAndSurfacesServerErrors() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let client = try client(session)
        StubProtocol.handler = { request in
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer private-test-token")
            #expect(request.httpMethod == "GET")
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            #expect(query?.first { $0.name == "after" }?.value == "42")
            #expect(query?.first { $0.name == "kinds" }?.value == "track,collection,favorite,annotation")
            return (200, Data(#"{"changes":[],"cursor":42,"hasMore":false}"#.utf8))
        }
        #expect(try await client.pull(after: 42).cursor == 42)
        StubProtocol.handler = { _ in (401, Data(#"{"error":{"message":"Token expired"}}"#.utf8)) }
        do { _ = try await client.pull(after: 0); Issue.record("Unauthorized pull succeeded") }
        catch ClientError.http(let status, let message) { #expect(status == 401); #expect(message == "Token expired") }
    }

    @Test func pushDecodesConflictWithoutAcknowledgingIt() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let client = try client(session)
        let operation = SyncOperation(operationID: "local-op", kind: .favorite, entityID: "track", baseVersion: 0, payload: #"{"enabled":true}"#, deleted: false)
        StubProtocol.handler = { request in
            #expect(request.httpMethod == "POST")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer private-test-token")
            let sent = try JSONDecoder().decode(SyncOperation.self, from: Self.body(request))
            #expect(sent.operationID == "local-op")
            return (409, Data(#"{"current":{"sequence":7,"operationID":"other-device","kind":"favorite","entityID":"track","payload":"{\"enabled\":false}","deleted":false}}"#.utf8))
        }
        do { _ = try await client.push(operation); Issue.record("Conflict was acknowledged") }
        catch ClientError.conflict(let current) { #expect(current.sequence == 7); #expect(current.operationID == "other-device") }
    }

    @MainActor @Test func unavailableCloudPreservesOfflineLibraryAndOutboxAcrossReopenThenRetries() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let audioDirectory = directory.appendingPathComponent("Audio")
        let audio = try AudioFiles(directory: audioDirectory)
        let media = Data("Local recording stays available".utf8)
        let hash = Self.hash(media)
        let audioURL = try #require(audio.url(hash: hash))
        try media.write(to: audioURL)
        var store: LibraryStore? = try LibraryStore(directory: directory)
        try store!.ingest([Track(id: "a", title: "Offline A", mediaHash: hash,
                                waveform: Waveform(peaks: [0.2, 0.8], colors: [[1, 2, 3], [4, 5, 6]])),
                           Track(id: "b", title: "Offline B")], enqueue: false)
        let collection = try store!.createCollection(name: "Local playlist", trackIDs: ["a", "b"])
        try store!.moveTrack("b", inCollection: collection.id, by: -1)
        try store!.setNote("Works on a plane", trackID: "a")
        try store!.setColor(.pink, trackID: "a")
        try store!.toggleFavorite("a")
        let original = try store!.payloadSnapshot()
        let queued = try store!.pendingCount()
        let operationID = try #require(try store!.nextOperation()?.operationID)
        let session = session(); defer { session.invalidateAndCancel() }
        let client = try client(session)
        let engine = SyncEngine()
        for failure in 0..<4 {
            StubProtocol.handler = { request in
                if failure == 0 { throw URLError(.notConnectedToInternet) }
                if failure == 1 { return (503, Data()) }
                if failure == 2 {
                    if request.httpMethod == "GET" { return (200, Data(#"{"changes":[],"cursor":0,"hasMore":false}"#.utf8)) }
                    let sent = try JSONDecoder().decode(SyncOperation.self, from: Self.body(request))
                    #expect(sent.operationID == operationID)
                    return (503, Data())
                }
                return (401, Data())
            }
            do { try await engine.sync(store: store!, client: client); Issue.record("Unavailable cloud unexpectedly synced") }
            catch { #expect(error is URLError || error is ClientError) }
            #expect(!engine.isRunning)
            store = nil
            store = try LibraryStore(directory: directory)
            #expect(try store!.payloadSnapshot().tracks == original.tracks)
            #expect(try store!.collection(collection.id)?.trackIDs == ["b", "a"])
            #expect(try store!.annotation(for: "a") == TrackAnnotation(note: "Works on a plane", color: .pink))
            #expect(try store!.favoriteIDs() == ["a"])
            #expect(try store!.pendingCount() == queued)
            #expect(try store!.nextOperation()?.operationID == operationID)
            #expect(await audio.existing(hash: hash) == audioURL)
        }
        let sent = RequestLog()
        StubProtocol.handler = { request in
            if request.httpMethod == "GET" { return (200, Data(#"{"changes":[],"cursor":0,"hasMore":false}"#.utf8)) }
            let operation = try JSONDecoder().decode(SyncOperation.self, from: Self.body(request))
            sent.append(operation.operationID)
            let acknowledgement = SyncChange(sequence: 100 + sent.values().count, operationID: operation.operationID,
                kind: operation.kind, entityID: operation.entityID, payload: operation.payload, deleted: operation.deleted)
            return (200, try JSONEncoder().encode(acknowledgement))
        }
        try await engine.sync(store: store!, client: client)
        #expect(sent.values().count == queued && sent.values().first == operationID)
        #expect(Set(sent.values()).count == queued)
        store = nil
        let reopened = try LibraryStore(directory: directory)
        #expect(try reopened.pendingCount() == 0)
        #expect(try reopened.collection(collection.id)?.trackIDs == ["b", "a"])
        #expect(try reopened.annotation(for: "a") == TrackAnnotation(note: "Works on a plane", color: .pink))
        #expect(try reopened.favoriteIDs() == ["a"])
        #expect(try reopened.payloadSnapshot().tracks == original.tracks)
        #expect(try Data(contentsOf: audioURL) == media)
    }

    @Test func injectedOfflineAudioDownloadPreservesExistingCachedRecording() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let session = session(); defer { session.invalidateAndCancel() }
        let audio = try AudioFiles(directory: directory, session: session)
        let bytes = Data("Cached recording remains playable without a server".utf8)
        let hash = Self.hash(bytes)
        let cached = try #require(audio.url(hash: hash))
        try bytes.write(to: cached)
        let before = try FileManager.default.attributesOfItem(atPath: cached.path)
        let log = RequestLog()
        StubProtocol.handler = { request in
            log.append(request.url!.path)
            throw URLError(.notConnectedToInternet)
        }
        let request = try client(session).mediaRequest(hash: hash)
        do { _ = try await audio.download(request, expectedHash: hash); Issue.record("Offline download unexpectedly succeeded") }
        catch let error as URLError { #expect(error.code == .notConnectedToInternet) }
        #expect(log.values() == ["/v1/media/\(hash)"])
        #expect(await audio.existing(hash: hash) == cached)
        #expect(try Data(contentsOf: cached) == bytes)
        let after = try FileManager.default.attributesOfItem(atPath: cached.path)
        #expect(after[.modificationDate] as? Date == before[.modificationDate] as? Date)
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path) == [cached.lastPathComponent])
        let reopened = try AudioFiles(directory: directory, session: session)
        #expect(await reopened.existing(hash: hash) == cached)
    }

    @Test func uploadResumesExistingChunksAndComposesOrderedHashes() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let client = try client(session)
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let first = Data(repeating: 0x42, count: 16 * 1024 * 1024), second = Data("abc".utf8)
        try (first + second).write(to: file)
        let wholeHash = try AudioFiles.hash(file), firstHash = Self.hash(first), secondHash = Self.hash(second)
        let log = RequestLog()
        StubProtocol.handler = { request in
            let path = request.url!.path, method = request.httpMethod!
            log.append("\(method) \(path)")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer private-test-token")
            if method == "HEAD" { return (path.hasSuffix(firstHash) ? 200 : 404, Data()) }
            if method == "PUT" {
                #expect(path.hasSuffix(secondHash))
                #expect(request.value(forHTTPHeaderField: "Content-Length") == "3")
                return (201, Data())
            }
            #expect(path == "/v1/media/\(wholeHash)/compose")
            let value = try JSONSerialization.jsonObject(with: Self.body(request)) as! [String: Any]
            let chunks = value["chunks"] as! [[String: Any]]
            #expect(chunks.compactMap { $0["hash"] as? String } == [firstHash, secondHash])
            #expect(chunks.compactMap { $0["size"] as? Int } == [first.count, second.count])
            return (201, Data())
        }
        try await client.upload(file: file, hash: wholeHash)
        #expect(log.values().filter { $0.hasPrefix("PUT ") }.count == 1)
        #expect(log.values().last == "POST /v1/media/\(wholeHash)/compose")
    }
    @Test func nativeAgentKeepsTurnIdentityAndAuthenticationAcrossSubmissionReadAndCancel() async throws {
        let session = session(); defer { session.invalidateAndCancel() }
        let client = try client(session)
        let log = RequestLog()
        StubProtocol.handler = { request in
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer private-test-token")
            log.append("\(request.httpMethod!) \(request.url!.path)")
            if request.url!.path == "/v1/agent/turns" {
                let body = try JSONSerialization.jsonObject(with: Self.body(request)) as! [String: String]
                #expect(body == ["id": "my-turn", "input": "Find music"])
                return (200, Data(#"{"id":"my-turn","status":"running"}"#.utf8))
            }
            return (200, Data(#"{"id":"my-turn","status":"completed","finalMessage":"Music ideas"}"#.utf8))
        }
        #expect(try await client.agentTurn(id: "my-turn", input: "Find music").status == "running")
        #expect(try await client.agentTurn(id: "my-turn").finalMessage == "Music ideas")
        _ = try await client.agentTurn(id: "my-turn", cancel: true)
        #expect(log.values() == ["POST /v1/agent/turns", "GET /v1/agent/turns/my-turn", "POST /v1/agent/turns/my-turn/cancel"])
        do { _ = try await client.agentTurn(id: "../other"); Issue.record("Accepted a path outside the turn") } catch {}
        #expect(log.values().count == 3)
    }

}
