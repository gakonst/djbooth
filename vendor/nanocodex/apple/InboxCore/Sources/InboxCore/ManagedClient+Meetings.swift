import Foundation
import CryptoKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

extension ManagedClient {
    public func meetings(cursor: String? = nil, limit: Int = 50) async throws -> MeetingPage {
        var query = URLComponents(); query.queryItems = [URLQueryItem(name: "limit", value: String(max(1, min(100, limit))))]
        if let cursor { query.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try MeetingPage(await json(path: "/v1/meetings?" + (query.percentEncodedQuery ?? "")))
    }
    public func meeting(id: UUID) async throws -> MeetingRecord {
        let record = try MeetingRecord(await json(path: meetingPath(id))["meeting"])
        guard record.id == id else { throw APIError.invalidResponse }
        return record
    }
    public func saveMeeting(_ meeting: MeetingRecord, ifMatch: Int? = nil) async throws -> MeetingRecord {
        let record = try MeetingRecord(await json(path: meetingPath(meeting.id), method: "PUT", body: meeting.uploadBody, ifMatch: ifMatch)["meeting"])
        guard record.id == meeting.id, record.revision == meeting.revision else { throw APIError.invalidResponse }
        return record
    }
    public func deleteMeeting(id: UUID) async throws { _ = try await json(path: meetingPath(id), method: "DELETE") }
    public func summarizeMeeting(id: UUID, revision: Int) async throws -> MeetingRecord {
        let record = try MeetingRecord(await json(path: meetingPath(id) + "/summarize", method: "POST", body: .object(["revision": .number(Double(revision))]))["meeting"])
        guard record.id == id, record.revision == revision else { throw APIError.invalidResponse }
        return record
    }
    /// Original CAF bytes are immutable for the capture UUID. Disk-backed upload
    /// and incremental hashing keep long recordings out of process memory.
    public static let maximumMeetingAudioBytes: Int64 = 2 * 1024 * 1024 * 1024
    public func uploadMeetingAudio(id: UUID, source: URL) async throws {
        let fingerprint = try await Self.meetingAudioFingerprintAsync(source)
        let path = meetingPath(id) + "/audio"
        let admission = try await json(path: path, method: "POST", body: .object([
            "size": .number(Double(fingerprint.size)), "sha256": .string(fingerprint.digest)
        ]))
        let manifest = admission["audio"]
        guard manifest["size"].number == Double(fingerprint.size), manifest["sha256"].string == fingerprint.digest,
              manifest["part_size"].number == 8 * 1024 * 1024,
              let count = Int(exactly: manifest["count"].number), count > 0, count <= 256,
              case .array(let uploaded) = admission["uploaded_parts"] else { throw APIError.invalidResponse }
        if admission["complete"].bool { return }
        let completed = Set(uploaded.compactMap { Int(exactly: $0.number) })
        let file = try FileHandle(forReadingFrom: source)
        defer { try? file.close() }
        let partSize = 8 * 1024 * 1024
        for number in 1...count {
            try Task.checkCancellation()
            if completed.contains(number) { continue }
            let expected = min(partSize, Int(fingerprint.size) - (number - 1) * partSize)
            try file.seek(toOffset: UInt64((number - 1) * partSize))
            guard let bytes = try file.read(upToCount: expected), bytes.count == expected else { throw APIError.invalidResponse }
            let digest = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("meeting-part-" + UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: temporary) }
            try bytes.write(to: temporary)
            var outgoing = try request(path: path + "/parts/" + String(number), method: "PUT")
            outgoing.timeoutInterval = 120
            outgoing.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            outgoing.setValue(String(expected), forHTTPHeaderField: "Content-Length")
            outgoing.setValue(digest, forHTTPHeaderField: "X-Content-SHA256")
            let (data, response) = try await session.upload(for: outgoing, fromFile: temporary)
            guard let response = response as? HTTPURLResponse else { throw APIError.invalidResponse }
            guard response.statusCode == 200 else { throw APIError.http(response.statusCode) }
            let receipt = try JSONDecoder().decode(JSON.self, from: data)
            guard receipt["part"].number == Double(number), receipt["size"].number == Double(expected),
                  receipt["sha256"].string == digest else { throw APIError.invalidResponse }
        }
        // Completion hashes all stored parts before making the original readable.
        var outgoing = try request(path: path + "/complete", method: "POST")
        outgoing.timeoutInterval = 300
        let (data, response) = try await session.data(for: outgoing)
        guard let response = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard response.statusCode == 200 else { throw APIError.http(response.statusCode) }
        let receipt = try JSONDecoder().decode(JSON.self, from: data)
        guard receipt["complete"].bool, receipt["audio"]["sha256"].string == fingerprint.digest,
              receipt["audio"]["size"].number == Double(fingerprint.size) else { throw APIError.invalidResponse }
    }

    /// Caller owns this temporary file and must install or remove it. A download
    /// verifies the original digest before it can enter the account's audio store.
    public func downloadMeetingAudio(id: UUID) async throws -> URL {
        var outgoing = try request(path: meetingPath(id) + "/audio")
        outgoing.timeoutInterval = 300
        outgoing.cachePolicy = .reloadIgnoringLocalCacheData
        outgoing.setValue("application/x-caf", forHTTPHeaderField: "Accept")
        let limiter = BoundedOutputDownload(maximumBytes: Self.maximumMeetingAudioBytes)
        let download: URL
        let response: URLResponse
        do { (download, response) = try await session.download(for: outgoing, delegate: limiter) }
        catch { if limiter.sizeExceeded { throw APIError.http(413) }; throw error }
        defer { try? FileManager.default.removeItem(at: download) }
        guard !limiter.sizeExceeded, let response = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard response.statusCode == 200 else { throw APIError.http(response.statusCode) }
        guard response.mimeType == "application/x-caf" else { throw APIError.invalidResponse }
        let fingerprint = try await Self.meetingAudioFingerprintAsync(download)
        guard response.expectedContentLength == fingerprint.size,
              response.value(forHTTPHeaderField: "X-Content-SHA256") == fingerprint.digest else { throw APIError.invalidResponse }
        try Task.checkCancellation()
        let local = FileManager.default.temporaryDirectory.appendingPathComponent("meeting-" + UUID().uuidString + ".caf")
        try FileManager.default.moveItem(at: download, to: local)
        return local
    }
    private static func meetingAudioFingerprintAsync(_ source: URL) async throws -> (size: Int64, digest: String) {
        let task = Task.detached(priority: .utility) { try meetingAudioFingerprint(source) }
        return try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }
    private static func meetingAudioFingerprint(_ source: URL) throws -> (size: Int64, digest: String) {
        guard let expected = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize, expected >= 8 else { throw APIError.invalidResponse }
        guard Int64(expected) <= maximumMeetingAudioBytes else { throw APIError.http(413) }
        let file = try FileHandle(forReadingFrom: source)
        defer { try? file.close() }
        let prefix = try file.read(upToCount: 8) ?? Data()
        guard prefix.count == 8, prefix.prefix(6) == Data([99, 97, 102, 102, 0, 1]) else { throw APIError.invalidResponse }
        var hash = SHA256(); hash.update(data: prefix)
        var size: Int64 = 8
        while let chunk = try file.read(upToCount: 1024 * 1024), !chunk.isEmpty {
            try Task.checkCancellation()
            size += Int64(chunk.count)
            guard size <= maximumMeetingAudioBytes else { throw APIError.http(413) }
            hash.update(data: chunk)
        }
        guard size == Int64(expected) else { throw APIError.invalidResponse }
        return (size, hash.finalize().map { String(format: "%02x", $0) }.joined())
    }
    private func meetingPath(_ id: UUID) -> String { "/v1/meetings/" + id.uuidString.lowercased() }
}
