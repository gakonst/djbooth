import Foundation
import Observation

/// Native intent adapter: the public umbrella CLI remains the only acquisition executor.
@MainActor @Observable final class DesktopRuntime {
    var running = false
    var progress = ""
    var error: String?
    var succeeded = false
    func run(_ arguments: [String], environment: [String: String] = [:]) async {
        #if os(macOS)
        guard !running else { return }
        running = true; error = nil; succeeded = false; progress = "Starting…"
        defer { running = false }
        let root = ProcessInfo.processInfo.environment["DJBOOTH_REPOSITORY"]
            ?? Bundle.main.object(forInfoDictionaryKey: "DJBoothRepository") as? String
        do {
            let result = try await Task.detached(priority: .userInitiated) { [weak self] in
                let process = Process()
                var env = ProcessInfo.processInfo.environment
                let pnpmDirectory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/pnpm").path
                env["PATH"] = [pnpmDirectory, "/opt/homebrew/bin", "/usr/local/bin", env["PATH"] ?? "/usr/bin:/bin"].joined(separator: ":")
                env.merge(environment) { _, new in new }
                process.environment = env
                process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
                if let root, !root.isEmpty {
                    process.currentDirectoryURL = URL(fileURLWithPath: root)
                    process.arguments = ["pnpm", "--silent", "djbooth"] + arguments
                } else { process.arguments = ["djbooth"] + arguments }
                process.standardInput = FileHandle.nullDevice
                let diagnostics = Pipe(); process.standardError = diagnostics
                // CLI result JSON can contain provider details. It never belongs in progress UI.
                process.standardOutput = FileHandle.nullDevice
                try process.run()
                var last = ""
                while true {
                    let data = diagnostics.fileHandleForReading.availableData
                    if data.isEmpty { break }
                    let text = String(decoding: data, as: UTF8.self)
                    // OAuth URLs remain in the browser, not in retained app diagnostics.
                    let safe = text.split(separator: "\n").filter { !$0.contains("https://") && !$0.contains("http://") }.joined(separator: "\n")
                    last = String((last + safe).suffix(1600))
                    let update = last
                    await MainActor.run { self?.progress = update }
                }
                process.waitUntilExit()
                return (process.terminationStatus, last)
            }.value
            if result.0 != 0 { error = result.1.isEmpty ? "djbooth exited with status \(result.0). Check your Mac’s configuration." : result.1 }
            else { succeeded = true; progress = "Complete" }
        } catch { self.error = error.localizedDescription }
        #else
        error = "Acquisition runs on your Mac."
        #endif
    }
}
