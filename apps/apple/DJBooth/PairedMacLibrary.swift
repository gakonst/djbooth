import Foundation
import Observation
import DJBoothKit
import CoreGraphics

/// A read-only projection of the paired Mac, separate from cloud accounts and their outboxes.
@MainActor @Observable final class PairedMacLibrary {
    private(set) var snapshot: PairedLibrarySnapshot?
    private(set) var connected = false
    private(set) var refreshing = false
    private(set) var offlineIDs: Set<String> = []
    var error: String?
    private var pairing: PairedLibrary?
    private var store: LibraryStore?
    private var generation = UUID()
    private var downloads: [String: Task<Track, Error>] = [:]
    private var artworkDownloads: [String: Task<Track, Error>] = [:]
    private var attemptedArtwork: Set<String> = []
    private(set) var artworkVersion = UUID()
    @ObservationIgnored private let artworkImages: NSCache<NSString, CGImage> = {
        let cache = NSCache<NSString, CGImage>(); cache.totalCostLimit = 32 * 1024 * 1024
        return cache
    }()
    private let keychainKey = "paired-mac-library-v1"

    var name: String { snapshot?.name ?? pairing?.name ?? "Mac library" }
    var isPaired: Bool { pairing != nil }
    var tracks: [Track] { snapshot?.projectedTracks ?? [] }
    var collections: [Collection] { snapshot?.collectionsWithFolderIDs ?? [] }
    var rootPath: [String] { snapshot.map { [$0.folderRootID] } ?? [] }
    var folderPaths: [[String]] { snapshot?.folderIDPaths ?? [] }
    func folderName(_ id: String) -> String { snapshot?.folderName(for: id) ?? id }
    var folderNames: [String: String] {
        Dictionary(folderPaths.compactMap { path in path.last.map { ($0, folderName($0)) } }, uniquingKeysWith: { first, _ in first })
    }

    func open(directory: URL, inMemory: Bool) async throws {
        store = try await LibraryStore.open(directory: inMemory ? nil : directory, inMemory: inMemory)
        guard !inMemory else { return }
        snapshot = try store?.pairedLibrary()
        if let saved = try Keychain.read(keychainKey) {
            pairing = try PairedLibrary(json: Data(saved.utf8))
            if snapshot?.libraryID != pairing?.libraryID { snapshot = nil }
        }
    }

    func connect(_ json: Data) async throws {
        guard !refreshing, let store else { throw ClientError.http(409, "Wait for the current library operation to finish") }
        let candidate = try PairedLibrary(json: json)
        let request = UUID(); generation = request
        refreshing = true; error = nil
        defer { refreshing = false }
        let catalog = try await PairedLibraryClient(candidate).catalog()
        guard request == generation, !Task.isCancelled else { throw CancellationError() }
        let next = snapshot?.libraryID == catalog.libraryID ? try snapshot!.merging(catalog) : catalog
        let encoded = try JSONEncoder().encode(candidate)
        try Keychain.save(String(decoding: encoded, as: UTF8.self), key: keychainKey)
        try store.savePairedLibrary(next)
        // Also invalidate downloads begun against the old pairing while the
        // candidate catalogue was in flight.
        generation = UUID()
        for download in downloads.values { download.cancel() }
        downloads.removeAll()
        resetArtwork()
        pairing = candidate; snapshot = next; connected = true
    }

    func refresh() async {
        guard let pairing, let store, !refreshing else { return }
        let request = generation
        refreshing = true
        defer { refreshing = false }
        do {
            let catalog = try await PairedLibraryClient(pairing).catalog()
            guard request == generation, !Task.isCancelled else { return }
            let next = try snapshot?.merging(catalog) ?? catalog
            try store.savePairedLibrary(next)
            snapshot = next; connected = true; error = nil
            attemptedArtwork.removeAll(); artworkVersion = UUID()
        } catch {
            guard request == generation, !(error is CancellationError) else { return }
            connected = false
            self.error = error.localizedDescription
        }
    }

    func forget() throws {
        try Keychain.remove(keychainKey)
        try store?.clearPairedLibrary()
        generation = UUID()
        for download in downloads.values { download.cancel() }
        downloads.removeAll()
        resetArtwork()
        pairing = nil; snapshot = nil; connected = false; error = nil; offlineIDs = []
    }

    private func resetArtwork() {
        for download in artworkDownloads.values { download.cancel() }
        artworkDownloads.removeAll(); attemptedArtwork.removeAll(); artworkImages.removeAllObjects()
        artworkVersion = UUID()
    }

    /// Called by a view task or after music lands, never by a frame-rendering closure.
    /// Cached covers display immediately; refresh probes only requested tracks, including embedded covers.
    func artwork(_ track: Track, from audio: AudioFiles, refresh: Bool = false) async -> CGImage? {
        guard let snapshot, let rawID = snapshot.rawTrackID(for: track.id) else { return nil }
        let request = generation
        var cached: CGImage?
        if let hash = snapshot.tracks.first(where: { $0.id == rawID })?.artworkHash {
            cached = artworkImages.object(forKey: hash as NSString)
            if cached == nil { cached = try? await PairedLibraryClient.cachedArtwork(hash: hash, files: audio) }
            if let cached { artworkImages.setObject(cached, forKey: hash as NSString, cost: cached.bytesPerRow * cached.height) }
        }
        guard request == generation, !Task.isCancelled else { return nil }
        guard refresh, connected, let pairing, let store else { return cached }
        let task: Task<Track, Error>
        if let existing = artworkDownloads[track.id] { task = existing }
        else {
            guard attemptedArtwork.insert(track.id).inserted else { return cached }
            task = Task { try await PairedLibraryClient(pairing).artwork(trackID: rawID, to: audio) }
            artworkDownloads[track.id] = task
        }
        defer { if request == generation { artworkDownloads.removeValue(forKey: track.id) } }
        do {
            let verified = try await task.value
            // Scrolling a view away cancels its display task, not the shared cache fill.
            guard request == generation, let current = self.snapshot else { return nil }
            let next = try current.updatingArtwork(verified)
            try store.savePairedLibrary(next)
            self.snapshot = next
            guard let hash = verified.artworkHash,
                  let image = try await PairedLibraryClient.cachedArtwork(hash: hash, files: audio),
                  request == generation, !Task.isCancelled else { return nil }
            artworkImages.setObject(image, forKey: hash as NSString, cost: image.bytesPerRow * image.height)
            return image
        } catch {
            // Cover failures never change playable audio, readiness, or the connection error UI.
            return request == generation && !Task.isCancelled ? cached : nil
        }
    }

    func refreshAvailability(in audio: AudioFiles) async {
        let request = generation
        let items = tracks
        let directory = await audio.directory
        let available = await Task.detached(priority: .utility) {
            let files = Set((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [])
            return Set(items.compactMap { item -> String? in
                guard let hash = item.mediaHash, files.contains(hash + ".audio") else { return nil }
                return item.id
            })
        }.value
        guard request == generation else { return }
        offlineIDs = available
    }

    func loadWaveform(_ track: Track, from audio: AudioFiles) async throws -> Track? {
        guard let snapshot, let store, let rawID = snapshot.rawTrackID(for: track.id),
              var updated = snapshot.tracks.first(where: { $0.id == rawID }),
              updated.waveform == nil, let analysis = updated.analysis,
              updated.mediaHash == analysis.mediaHash else { return nil }
        let request = generation
        guard let waveform = try await USBAnalysis.read(analysis, files: audio, duration: updated.durationSeconds ?? 0),
              request == generation, !Task.isCancelled, let current = self.snapshot else { return nil }
        updated.waveform = waveform
        let next = try current.updating(updated)
        try store.savePairedLibrary(next)
        self.snapshot = next
        updated.id = track.id
        return updated
    }

    func download(_ track: Track, to audio: AudioFiles) async throws -> URL {
        guard let pairing, let snapshot, let store else { throw ClientError.http(404, "Pair with your Mac to download this recording") }
        guard let rawID = snapshot.rawTrackID(for: track.id) else { throw ClientError.invalidMedia }
        let request = generation
        if let current = snapshot.tracks.first(where: { $0.id == rawID }),
           let hash = current.mediaHash, let file = await audio.existing(hash: hash) {
            var complete = true
            for artifact in current.analysis?.hashes ?? [] {
                if await audio.existing(hash: artifact) == nil { complete = false; break }
            }
            guard request == generation, !Task.isCancelled else { throw CancellationError() }
            if complete {
                offlineIDs.insert(track.id)
                Task { await self.artwork(track, from: audio, refresh: true) }
                return file
            }
        }
        let task: Task<Track, Error>
        if let existing = downloads[track.id] { task = existing }
        else {
            task = Task { try await PairedLibraryClient(pairing).download(trackID: rawID, to: audio) }
            downloads[track.id] = task
        }
        defer { if request == generation { downloads.removeValue(forKey: track.id) } }
        let downloaded = try await task.value
        guard request == generation, !Task.isCancelled, let current = self.snapshot else { throw CancellationError() }
        let next = try current.updating(downloaded)
        try store.savePairedLibrary(next)
        self.snapshot = next
        guard let hash = downloaded.mediaHash, let file = await audio.existing(hash: hash) else { throw ClientError.invalidMedia }
        guard request == generation else { throw CancellationError() }
        offlineIDs.insert(track.id)
        Task { await self.artwork(track, from: audio, refresh: true) }
        return file
    }
}
