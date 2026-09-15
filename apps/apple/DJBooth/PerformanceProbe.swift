import Foundation
import Darwin
import OSLog
import SwiftUI

/// Opt-in diagnostics only. Never records credentials, paths, notes, or media contents.
@MainActor enum PerformanceProbe {
    static var enabled: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("--performance-probe")
        #else
        false
        #endif
    }
    static var offline: Bool { enabled && ProcessInfo.processInfo.arguments.contains("--performance-offline") }
    /// Injected only into the normal clients for an opt-in offline regression; keeps their real endpoint scope.
    static let serverUnavailableSession: URLSession? = {
        #if DEBUG
        guard ProcessInfo.processInfo.arguments.contains("--ui-test-server-unavailable") else { return nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [UnavailableServerProtocol.self]
        return URLSession(configuration: configuration)
        #else
        return nil
        #endif
    }()
    private static let log = Logger(subsystem: "xyz.gakonst.djbooth.performance", category: "measurement")
    private static let signposter = OSSignposter(subsystem: "xyz.gakonst.djbooth.performance", category: "measurement")
    private static var appStart: Double?
    private static var libraryStart: Double?
    private static var playbackStart: (trackID: String, time: Double)?
    private static var output: FileHandle?
    private static var initialized = false

    static func applicationBegan() {
        guard enabled else { return }
        appStart = ProcessInfo.processInfo.systemUptime
        event("app_begin")
        Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                event("memory")
            }
        }
    }
    static func libraryBegan() {
        guard enabled else { return }
        libraryStart = ProcessInfo.processInfo.systemUptime
        event("library_begin")
    }
    static func libraryReady(trackCount: Int) {
        guard enabled else { return }
        event("library_ready", milliseconds: libraryStart.map { (ProcessInfo.processInfo.systemUptime - $0) * 1000 }, count: trackCount)
    }
    static func libraryRendered() {
        event("library_rendered", milliseconds: appStart.map { (ProcessInfo.processInfo.systemUptime - $0) * 1000 })
    }
    static func playRequested(trackID: String?) {
        guard enabled, let trackID else { return }
        playbackStart = (trackID, ProcessInfo.processInfo.systemUptime)
        event("play_requested", trackID: trackID)
    }
    static func playbackState(playing: Bool, trackID: String?) {
        guard enabled else { return }
        if playing, let request = playbackStart, request.trackID == trackID {
            playbackStart = nil
            event("playing", milliseconds: (ProcessInfo.processInfo.systemUptime - request.time) * 1000, trackID: trackID)
        } else if !playing { event("not_playing", trackID: trackID) }
    }
    static func event(_ name: String, milliseconds: Double? = nil, trackID: String? = nil, count: Int? = nil) {
        guard enabled else { return }
        let memory = memoryBytes()
        var value: [String: Any] = ["event": name, "uptime": ProcessInfo.processInfo.systemUptime,
                                    "pid": ProcessInfo.processInfo.processIdentifier,
                                    "footprintBytes": memory.footprint, "residentBytes": memory.resident]
        if let milliseconds { value["milliseconds"] = milliseconds }
        if let trackID { value["trackID"] = trackID }
        if let count { value["trackCount"] = count }
        guard var data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else { return }
        signposter.emitEvent("Measurement", "\(name, privacy: .public)")
        log.info("\(text, privacy: .public)")
        if !initialized {
            initialized = true
            let args = ProcessInfo.processInfo.arguments
            if let index = args.firstIndex(of: "--performance-run"), args.indices.contains(index + 1),
               let id = UUID(uuidString: args[index + 1]) {
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent("DJBoothPerformance", isDirectory: true)
                try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let url = directory.appendingPathComponent(id.uuidString + ".jsonl")
                if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
                output = try? FileHandle(forWritingTo: url)
                _ = try? output?.seekToEnd()
            }
        }
        data.append(0x0A)
        try? output?.write(contentsOf: data)
    }
    private static func memoryBytes() -> (footprint: UInt64, resident: UInt64) {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let capacity = Int(count)
        let status = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: capacity) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return status == KERN_SUCCESS ? (info.phys_footprint, info.resident_size) : (0, 0)
    }
}

#if DEBUG
private final class UnavailableServerProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
    }
    override func stopLoading() {}
}
#endif

#if DEBUG
/// Exercises async player boundaries in one MainActor turn, which UI-driver taps cannot reliably race.
@MainActor struct PlaybackRaceProbeView: View {
    let model: BoothModel
    @State private var result = "Running playback races"
    static var enabled: Bool { ProcessInfo.processInfo.arguments.contains("--ui-test-playback-races") }
    var body: some View {
        Text(result).font(.caption).padding(8).background(.black.opacity(0.9))
            .accessibilityIdentifier("playback.race.result")
            .task {
                do { try await run(); result = "Passed 3 playback races" }
                catch { model.player.pause(); result = "Failed: \(error.localizedDescription)" }
            }
    }
    private func run() async throws {
        guard let a = model.tracksByID["65582957"], let b = model.tracksByID["6861975"],
              let ah = a.mediaHash, let bh = b.mediaHash,
              let au = await model.audio.existing(hash: ah), let bu = await model.audio.existing(hash: bh) else {
            throw ProbeFailure("Two cached Brunello tracks are required")
        }
        let player = model.player
        let original = player.track, originalQueue = player.queue, originalElapsed = player.elapsed
        let originalURL = if let hash = original?.mediaHash { await model.audio.existing(hash: hash) } else { nil as URL? }
        defer {
            player.pause()
            if let original { player.prepare(original, url: originalURL, queue: originalQueue, elapsed: originalElapsed) }
        }
        let queue = [a, b]
        // Pause happens before async MIME detection and audio-session activation can return.
        player.prepare(a, url: au, queue: queue, autoplay: true)
        player.pause()
        try await Task.sleep(for: .milliseconds(500))
        try require(!player.playing && player.track?.id == a.id, "Early pause was lost")
        player.resume()
        try await waitUntil { player.playing && player.elapsed > 0.2 }
        player.pause()

        // Preserve a user seek issued before the AVPlayerItem is even installed.
        player.prepare(a, url: au, queue: queue, autoplay: true)
        player.seek(17)
        player.pause()
        try await Task.sleep(for: .milliseconds(500))
        try require(!player.playing, "Seek re-enabled playback after pause")
        player.resume()
        try await waitUntil { player.playing && player.elapsed > 17.2 }
        try require(player.elapsed < 22, "Early seek did not retain its target")
        player.pause()

        // The superseded track must never reappear after its async work completes.
        player.prepare(a, url: au, queue: queue, autoplay: true)
        player.prepare(b, url: bu, queue: queue, autoplay: true)
        try await waitUntil { player.playing && player.track?.id == b.id && player.elapsed > 0.2 }
        try await Task.sleep(for: .milliseconds(500))
        try require(player.track?.id == b.id && player.queue.map(\.id) == [a.id, b.id], "Superseded preparation changed track or queue")
        try require(player.error == nil, player.error ?? "Playback failed")
        player.pause()
    }
    private func waitUntil(_ condition: @MainActor () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(8))
        while !condition() {
            if ContinuousClock.now >= deadline { throw ProbeFailure("Actual playback did not reach the expected state") }
            try await Task.sleep(for: .milliseconds(50))
        }
    }
    private func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw ProbeFailure(message) }
    }
    private struct ProbeFailure: LocalizedError { let message: String; init(_ message: String) { self.message = message }; var errorDescription: String? { message } }
}
#endif
