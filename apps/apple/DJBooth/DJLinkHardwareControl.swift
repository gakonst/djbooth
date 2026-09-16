#if os(iOS) && DEBUG
import Foundation
import UIKit

/// Paired-device development transport only. All operations go through the
/// same Rust bindings as the app; this opens no network listener.
final class DJLinkHardwareControl: @unchecked Sendable {
    static let shared = DJLinkHardwareControl()
    private let queue = DispatchQueue(label: "xyz.gakonst.djbooth.hardware-control", qos: .utility)
    private var timer: DispatchSourceTimer?

    @MainActor func start() {
        guard ProcessInfo.processInfo.arguments.contains("--dj-link-hardware-test") else { return }
        // Apply before the library opens, so a slow startup cannot auto-lock.
        UIApplication.shared.isIdleTimerDisabled = true
        queue.async {
            guard self.timer == nil else { return }
            let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("DJBooth/HardwareControl", isDirectory: true)
            do {
                // Never replay commands left by a previous app process.
                if FileManager.default.fileExists(atPath: root.path) { try FileManager.default.removeItem(at: root) }
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                let timer = DispatchSource.makeTimerSource(queue: self.queue)
                timer.schedule(deadline: .now(), repeating: .milliseconds(500), leeway: .milliseconds(100))
                timer.setEventHandler { self.poll(root) }
                self.timer = timer
                timer.resume()
                NSLog("[DJLink] paired-device hardware control ready")
            } catch { NSLog("[DJLink] hardware control failed: %@", error.localizedDescription) }
        }
    }

    private func poll(_ root: URL) {
        let request = root.appendingPathComponent("request.json")
        guard let data = try? Data(contentsOf: request), data.count <= 1024 * 1024,
              let input = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = input["id"] as? String, UUID(uuidString: id) != nil,
              let operation = input["operation"] as? String,
              let expires = input["expires_ms"] as? Double else { return }
        // Claim before execution. A client timeout must never retry a mutation.
        do { try FileManager.default.removeItem(at: request) } catch { return }
        var response: [String: Any] = ["id": id]
        do {
            guard expires > Date().timeIntervalSince1970 * 1000 else {
                throw DJLinkBindingError(message: "Hardware command expired before execution")
            }
            guard operation.hasPrefix("server.") || operation.hasPrefix("function.") ||
                    ["status", "interfaces", "api", "diagnostics.status", "diagnostics.flush"].contains(operation) else {
                throw DJLinkBindingError(message: "Operation is not a DJ Link hardware control")
            }
            let args = try JSONSerialization.data(withJSONObject: input["arguments"] ?? [:], options: [.fragmentsAllowed])
            AppDiagnostics.shared.event("hardware_command_started", ["id": id, "operation": operation])
            let result = try DJLinkBindings.request(operation, arguments: args)
            response["value"] = try JSONSerialization.jsonObject(with: result, options: [.fragmentsAllowed])
            response["ok"] = true
        } catch {
            response["ok"] = false
            response["error"] = error.localizedDescription
        }
        AppDiagnostics.shared.event("hardware_command_finished", ["id": id, "operation": operation, "ok": String(describing: response["ok"]!)])
        do {
            try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
                .write(to: root.appendingPathComponent("response.json"), options: .atomic)
        } catch { NSLog("[DJLink] hardware response failed: %@", error.localizedDescription) }
    }
}
#endif
