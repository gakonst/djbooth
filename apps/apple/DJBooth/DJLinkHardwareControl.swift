#if os(iOS) && DEBUG
import Foundation
import AVFoundation
import CoreMIDI
import UIKit

/// Paired-device development transport only. All operations go through the
/// same Rust bindings and native recording controller as the app; no network listener.
final class DJLinkHardwareControl: @unchecked Sendable {
    static let shared = DJLinkHardwareControl()
    private let queue = DispatchQueue(label: "xyz.gakonst.djbooth.hardware-control", qos: .utility)
    private var timer: DispatchSourceTimer?
    private var recordingCommandPending = false
    private var midiClient: MIDIClientRef = 0
    @MainActor weak var model: BoothModel?

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
        guard !recordingCommandPending else { return }
        let request = root.appendingPathComponent("request.json")
        guard let data = try? Data(contentsOf: request), data.count <= 1024 * 1024,
              let input = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = input["id"] as? String, UUID(uuidString: id) != nil,
              let operation = input["operation"] as? String,
              let expires = input["expires_ms"] as? Double else { return }
        // Claim before execution. A client timeout must never retry a mutation.
        do { try FileManager.default.removeItem(at: request) } catch { return }
        if operation.hasPrefix("phone.recording.") {
            recordingCommandPending = true
            Task {
                let response = await self.controlRecording(data)
                self.queue.async {
                    defer { self.recordingCommandPending = false }
                    do { try response.write(to: root.appendingPathComponent("response.json"), options: .atomic) }
                    catch { NSLog("[DJLink] recording response failed: %@", error.localizedDescription) }
                }
            }
            return
        }
        var response: [String: Any] = ["id": id]
        do {
            guard expires > Date().timeIntervalSince1970 * 1000 else {
                throw DJLinkBindingError(message: "Hardware command expired before execution")
            }
            guard operation.hasPrefix("server.") || operation.hasPrefix("function.") ||
                    ["status", "interfaces", "api", "diagnostics.status", "diagnostics.flush", "diagnostics.snapshot", "recording.status", "midi.snapshot", "audio.inputs"].contains(operation) else {
                throw DJLinkBindingError(message: "Operation is not a DJ Link hardware control")
            }
            let args = try JSONSerialization.data(withJSONObject: input["arguments"] ?? [:], options: [.fragmentsAllowed])
            AppDiagnostics.shared.event("hardware_command_started", ["id": id, "operation": operation])
            let result: Data
            if operation == "audio.inputs" {
                let session = AVAudioSession.sharedInstance()
                func port(_ input: AVAudioSessionPortDescription) -> [String: Any] {
                    ["name": input.portName, "uid": input.uid, "type": input.portType.rawValue,
                     "channels": input.channels?.count ?? 0]
                }
                // CoreMIDI discourages disposing the app's last client: doing
                // so can make subsequent client creation fail until relaunch.
                let midiResult = midiClient == 0 ? MIDIClientCreateWithBlock("DJ Booth diagnostics" as CFString, &midiClient) { _ in } : noErr
                func endpoint(_ source: MIDIEndpointRef) -> [String: Any] {
                    var name: Unmanaged<CFString>?
                    var uniqueID: Int32 = 0
                    MIDIObjectGetStringProperty(source, kMIDIPropertyDisplayName, &name)
                    MIDIObjectGetIntegerProperty(source, kMIDIPropertyUniqueID, &uniqueID)
                    return ["name": name?.takeRetainedValue() as String? ?? "MIDI", "id": uniqueID]
                }
                result = try JSONSerialization.data(withJSONObject: ["available": (session.availableInputs ?? []).map(port),
                    "current": session.currentRoute.inputs.map(port), "outputs": session.currentRoute.outputs.map(port), "sampleRate": session.sampleRate,
                    "category": session.category.rawValue, "permission": AVAudioApplication.shared.recordPermission.rawValue,
                    "midiStatus": midiResult,
                    "midiSources": (0..<MIDIGetNumberOfSources()).map { endpoint(MIDIGetSource($0)) },
                    "midiDestinations": (0..<MIDIGetNumberOfDestinations()).map { endpoint(MIDIGetDestination($0)) }])
            } else { result = try DJLinkBindings.request(operation, arguments: args) }
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

    @MainActor private func controlRecording(_ data: Data) async -> Data {
        var response: [String: Any] = [:]
        do {
            guard let input = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let operation = input["operation"] as? String, let expires = input["expires_ms"] as? Double else {
                throw DJLinkBindingError(message: "Invalid recording request")
            }
            response["id"] = input["id"]
            guard expires > Date().timeIntervalSince1970 * 1000 else { throw DJLinkBindingError(message: "Recording command expired") }
            guard let model else { throw DJLinkBindingError(message: "The library is still opening") }
            let recording = model.djLink.recording
            guard !recording.busy else { throw DJLinkBindingError(message: "Recording is changing state") }
            switch operation {
            case "phone.recording.start":
                let arguments = input["arguments"] as? [String: Any] ?? [:]
                await recording.start(model: model, includeAudio: arguments["audio"] as? Bool ?? false)
                guard recording.isRecording else { throw DJLinkBindingError(message: recording.error ?? "Recording did not start") }
            case "phone.recording.stop": await recording.stop()
            default: throw DJLinkBindingError(message: "Unknown recording command")
            }
            let result = try await Task.detached { try DJLinkBindings.request("recording.status") }.value
            response["value"] = try JSONSerialization.jsonObject(with: result)
            response["ok"] = true
        } catch { response["ok"] = false; response["error"] = error.localizedDescription }
        return (try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])) ?? Data("{}".utf8)
    }
}
#endif
