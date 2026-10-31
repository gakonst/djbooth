import Foundation
import Darwin
import OSLog
import SwiftUI
import DJBoothKit

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
    static func event(_ name: String, milliseconds: Double? = nil, trackID: String? = nil, count: Int? = nil, fields: [String: Double] = [:]) {
        guard enabled else { return }
        let memory = memoryBytes()
        var value: [String: Any] = ["event": name, "uptime": ProcessInfo.processInfo.systemUptime,
                                    "pid": ProcessInfo.processInfo.processIdentifier,
                                    "footprintBytes": memory.footprint, "residentBytes": memory.resident]
        if let milliseconds { value["milliseconds"] = milliseconds }
        if let trackID { value["trackID"] = trackID }
        if let count { value["trackCount"] = count }
        for (key, number) in fields where number.isFinite { value[key] = number }
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
