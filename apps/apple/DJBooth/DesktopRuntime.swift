import Foundation
import Observation

/// Native intent adapter: the public umbrella CLI remains the only acquisition executor.
@MainActor @Observable final class DesktopRuntime {
    struct CommandResult: Sendable {
        let exitCode: Int32
        let stdout: Data

        /// Public commands emit their result directly with --format json.
        func decode<Value: Decodable>(_ type: Value.Type) throws -> Value {
            try JSONDecoder().decode(type, from: stdout)
        }
    }

    var running = false
    var progress = ""
    var error: String?
    var succeeded = false
    private(set) var result: CommandResult?
    @discardableResult
    func run(_ arguments: [String], environment: [String: String] = [:]) async -> CommandResult? {
        #if os(macOS)
        guard !running else { return nil }
        running = true; error = nil; result = nil; succeeded = false; progress = "Starting…"
        defer { running = false }
        let root = ProcessInfo.processInfo.environment["DJBOOTH_REPOSITORY"]
            ?? Bundle.main.object(forInfoDictionaryKey: "DJBoothRepository") as? String
        do {
            let completion = try await Task.detached(priority: .userInitiated) { [weak self] in
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
                let output = Pipe(); process.standardOutput = output
                try process.run()
                // Drain both pipes concurrently: a large result must not block stderr or exit.
                let stdout = Task.detached(priority: .utility) {
                    try output.fileHandleForReading.readToEnd() ?? Data()
                }
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
                return (CommandResult(exitCode: process.terminationStatus, stdout: try await stdout.value), last)
            }.value
            result = completion.0
            if completion.0.exitCode != 0 { error = completion.1.isEmpty ? "djbooth exited with status \(completion.0.exitCode). Check your Mac’s configuration." : completion.1 }
            else { succeeded = true; progress = "Complete" }
        } catch { self.error = error.localizedDescription }
        return result
        #else
        error = "Acquisition runs on your Mac."
        return nil
        #endif
    }
}
