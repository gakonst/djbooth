import Foundation

/// Queries only the active library supplied by the app, never another account's
/// store, credentials, file URLs or audio bytes. Construct afresh for every call.
@MainActor public struct PhoneLibraryQuery {
    public var tracks: [Track] = []
    public var collections: [Collection] = []
    public var favorites: Set<String> = []
    public var offlineIDs: Set<String> = []
    public var downloading: Set<String> = []
    public var annotations: [String: TrackAnnotation] = [:]
    public var queue: [Track] = []
    public var imports: [CloudImportJob] = []
    public var conflicts: [[String: Any]] = []
    public var state: [String: Any] = [:]
    public init() {}

    public func execute(_ arguments: [String: Any], byteBudget: Int = 65536) throws -> String {
        let allowed: Set<String> = ["resource", "query", "id", "favoritesOnly", "offlineOnly", "offset", "limit"]
        guard Set(arguments.keys).isSubset(of: allowed), let resource = arguments["resource"] as? String else { throw invalid() }
        for key in ["query", "id"] {
            if let value = arguments[key], !(value is String) || (value as? String)?.count ?? 0 > 256 { throw invalid() }
        }
        for key in ["favoritesOnly", "offlineOnly"] {
            if let value = arguments[key], CFGetTypeID(value as CFTypeRef) != CFBooleanGetTypeID() { throw invalid() }
        }
        let offset = try integer(arguments["offset"], default: 0, range: 0...Int.max)
        let limit = try integer(arguments["limit"], default: 25, range: 1...50)
        let query = (arguments["query"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let id = arguments["id"] as? String
        let observedAt = ISO8601DateFormatter().string(from: Date())
        func encoded(_ value: [String: Any]) throws -> String {
            let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed])
            guard data.count <= min(byteBudget, 65536) else { throw ClientError.http(413, "Result exceeds the tool output budget. Query a smaller page or a specific track.") }
            return String(decoding: data, as: UTF8.self)
        }
        func envelope(_ value: [String: Any]) -> [String: Any] {
            value.merging(["observedAt": observedAt, "source": "live DJ Booth on this device", "readOnly": true]) { _, new in new }
        }
        if resource == "state" { return try encoded(envelope(state)) }
        if resource == "track" {
            guard let id, let track = tracks.first(where: { $0.id == id }) else { throw ClientError.http(404, "Track is not in the active library") }
            return try encoded(envelope(["track": item(track, details: true)]))
        }
        let rows: [[String: Any]]
        switch resource {
        case "tracks", "queue":
            var source = resource == "queue" ? queue : tracks.sorted { $0.id < $1.id }
            if let id {
                guard let collection = collections.first(where: { $0.id == id }) else { throw ClientError.http(404, "Playlist is not in the active library") }
                let byID = Dictionary(source.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
                source = collection.trackIDs.compactMap { byID[$0] }
            }
            rows = source.filter { track in
                (arguments["favoritesOnly"] as? Bool != true || favorites.contains(track.id)) &&
                (arguments["offlineOnly"] as? Bool != true || offlineIDs.contains(track.id)) &&
                (query.isEmpty || [track.title, track.artist, track.album, track.genre, track.key, annotations[track.id]?.note].compactMap { $0 }.joined(separator: " ").localizedCaseInsensitiveContains(query))
            }.map { item($0) }
        case "playlists":
            rows = collections.sorted { $0.id < $1.id }.filter {
                (id == nil || $0.id == id) && (query.isEmpty || $0.name.localizedCaseInsensitiveContains(query))
            }.map { collection in
                ["id": collection.id, "name": collection.name, "trackCount": collection.trackIDs.count,
                 "folderPath": collection.folderPath ?? [], "pinned": collection.isPinned ?? false,
                 "mood": collection.mood ?? "", "offlineTrackCount": collection.trackIDs.filter { offlineIDs.contains($0) }.count]
            }
        case "imports":
            rows = imports.map { job in
                ["id": job.id, "source": job.source, "status": job.status, "phase": job.phase,
                 "current": job.current, "total": job.total, "message": job.message, "collectionID": job.collectionID ?? ""]
            }
        case "conflicts": rows = conflicts
        default: throw invalid()
        }
        let page = Array(rows.dropFirst(min(offset, rows.count)).prefix(limit))
        // Shrink pages to the caller's budget without silently dropping results.
        for count in stride(from: page.count, through: page.isEmpty ? 0 : 1, by: -1) {
            let end = min(offset, rows.count) + count
            let value = envelope(["items": Array(page.prefix(count)), "total": rows.count,
                                  "offset": offset, "nextOffset": end < rows.count ? end as Any : NSNull()])
            if let result = try? encoded(value) { return result }
        }
        throw ClientError.http(413, "Result exceeds the output budget; narrow the query or request a larger output budget.")
    }

    private func item(_ track: Track, details: Bool = false) -> [String: Any] {
        var value: [String: Any] = ["id": track.id, "title": track.title, "artist": track.artist ?? "",
            "album": track.album ?? "", "genre": track.genre ?? "", "key": track.key ?? "",
            "bpm": track.bpm.flatMap { $0.isFinite ? $0 : nil } as Any? ?? NSNull(),
            "durationSeconds": track.durationSeconds.flatMap { $0.isFinite ? $0 : nil } as Any? ?? NSNull(),
            "favorite": favorites.contains(track.id), "offline": offlineIDs.contains(track.id),
            "downloading": downloading.contains(track.id), "analyzed": track.analyzed,
            "provider": track.source, "color": annotations[track.id]?.color?.rawValue ?? ""]
        if details {
            value["note"] = annotations[track.id]?.note ?? ""
            value["playlistIDs"] = collections.filter { $0.trackIDs.contains(track.id) }.map(\.id)
            value["waveformAvailable"] = track.waveform != nil
            value["analyzedBeatCount"] = track.waveform?.beatGrid?.times.count ?? 0
        }
        return value
    }
    private func integer(_ value: Any?, default fallback: Int, range: ClosedRange<Int>) throws -> Int {
        guard let value else { return fallback }
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue >= Double(range.lowerBound), number.doubleValue < Double(Int.max),
              range.contains(number.intValue) else { throw invalid() }
        return number.intValue
    }
    private func invalid() -> ClientError { .http(400, "Invalid DJ Booth query. Use the published read-only tool schema.") }
}
