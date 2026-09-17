#if os(iOS) && DEBUG
import Foundation
import DJBoothKit
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
    @MainActor private var agentLogin: ConnectLogin?

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
        if operation.hasPrefix("phone.recording.") || operation.hasPrefix("phone.sonos.") || operation == "phone.mcp" || operation == "phone.agent.status" || operation == "phone.agent.probe" || operation == "phone.agent.connect" {
            recordingCommandPending = true
            Task {
                let response = operation.hasPrefix("phone.agent.") ? await self.controlAgentStatus(data) : operation == "phone.mcp" ? await self.controlMCP(data) : operation.hasPrefix("phone.sonos.") ? await self.controlSonos(data) : await self.controlRecording(data)
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
            guard operation.hasPrefix("server.") || operation.hasPrefix("function.") || operation.hasPrefix("sonos.") ||
                    ["status", "interfaces", "api", "diagnostics.status", "diagnostics.flush", "diagnostics.snapshot", "recording.status", "recording.prepare", "midi.snapshot", "audio.inputs"].contains(operation) else {
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
                    "category": session.category.rawValue, "routeSharingPolicy": session.routeSharingPolicy.rawValue,
                    "outputLatency": session.outputLatency, "outputVolume": session.outputVolume, "permission": AVAudioApplication.shared.recordPermission.rawValue,
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

    /// Paired debug controls; never exposes tokens or conversation contents.
    @MainActor private func controlAgentStatus(_ data: Data) async -> Data {
        var response: [String: Any] = [:]
        do {
            guard let input = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let expires = input["expires_ms"] as? Double, expires > Date().timeIntervalSince1970 * 1000, let model else {
                throw DJLinkBindingError(message: "Invalid or expired agent inspection")
            }
            response["id"] = input["id"]
            if input["operation"] as? String == "phone.agent.connect" {
                guard agentLogin == nil, model.agentPendingID == nil else {
                    throw DJLinkBindingError(message: "A login or agent request is already running")
                }
                let login = ConnectLogin(); agentLogin = login
                Task { @MainActor in
                    defer { self.agentLogin = nil }
                    do {
                        let endpoint = try Endpoint(model.cloudURL)
                        let token = try await login.signIn(endpoint: endpoint)
                        try await model.configureCloud(url: model.cloudURL, token: token)
                        await model.loadAgentHistory()
                        model.showAgent = true
                    } catch { model.agentError = error.localizedDescription }
                }
                response["ok"] = true
                response["value"] = ["connecting": true]
                return try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
            }
            if input["operation"] as? String == "phone.agent.probe" {
                guard model.beginAgentTurn("Run a read-only connection check: use tool_search to find the DJ Booth query tool, then query the phone's current library track count. Do not change playback, downloads, playlists, or any other app state. Report whether the live query succeeded.") else {
                    throw DJLinkBindingError(message: "Agent already has a pending request or is disconnected")
                }
            }
            await model.loadAgentHistory()
            response["value"] = model.agentDiagnosticState
            response["ok"] = true
        } catch { response["ok"] = false; response["error"] = error.localizedDescription }
        return (try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])) ?? Data()
    }

    @MainActor private func controlMCP(_ data: Data) -> Data {
        var response: [String: Any] = [:]
        do {
            guard let input = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let expires = input["expires_ms"] as? Double, expires > Date().timeIntervalSince1970 * 1000,
                  let request = input["arguments"] as? [String: Any], let model else {
                throw DJLinkBindingError(message: "Invalid or expired MCP hardware test")
            }
            response["id"] = input["id"]
            response["value"] = PhoneMCPServer.handle(request) { name, arguments in
                try model.mcpCall(name, arguments: arguments, budget: 32000)
            }
            response["ok"] = true
        } catch { response["ok"] = false; response["error"] = error.localizedDescription }
        return (try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])) ?? Data()
    }

    @MainActor private func controlSonos(_ data: Data) async -> Data {
        var response: [String: Any] = [:]
        do {
            guard let input = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let operation = input["operation"] as? String, let expires = input["expires_ms"] as? Double else {
                throw DJLinkBindingError(message: "Invalid Sonos request")
            }
            response["id"] = input["id"]
            guard expires > Date().timeIntervalSince1970 * 1000, let model else { throw DJLinkBindingError(message: "Sonos command expired or library unavailable") }
            let args = input["arguments"] as? [String: Any] ?? [:]
            AppDiagnostics.shared.event("sonos_hardware_request", ["operation": operation,
                "action": args["action"] as? String ?? "", "id": input["id"] as? String ?? ""])
            switch operation {
            case "phone.sonos.enabled":
                guard let enabled = args["enabled"] as? Bool else { throw DJLinkBindingError(message: "Specify enabled") }
                await model.setSonosEnabled(enabled)
            case "phone.sonos.limits":
                if let master = args["master"] as? Int {
                    guard (0...100).contains(master) else { throw DJLinkBindingError(message: "Volume limits must be 0–100") }
                    model.sonos.limits.master = master
                }
                if let room = args["roomId"] as? String, let maximum = args["maximum"] as? Int {
                    guard (0...100).contains(maximum), model.sonos.rooms.contains(where: { $0.id == room }) else {
                        throw DJLinkBindingError(message: "Choose a discovered room and volume limit from 0–100")
                    }
                    model.sonos.limits.rooms[room] = maximum
                }
                await model.sonos.saveVolumeLimits()
            case "phone.sonos.discover": await model.sonos.discover()
            case "phone.sonos.local":
                let enabled = args["enabled"] as? Bool ?? false
                try await model.testSonosLocalMedia(enabled)
            case "phone.sonos.reload":
                guard let room = model.sonos.room else { throw DJLinkBindingError(message: "Choose a Sonos room first") }
                await model.useSonos(room, reload: true)
            case "phone.sonos.play":
                guard let room = model.sonos.rooms.first(where: { $0.id == args["roomId"] as? String }),
                      let ids = args["trackIds"] as? [String], !ids.isEmpty else { throw DJLinkBindingError(message: "Choose a discovered room and library track IDs") }
                let tracks = ids.compactMap { model.tracksByID[$0] }
                let index = args["index"] as? Int ?? 0
                guard tracks.count == ids.count, tracks.indices.contains(index) else { throw DJLinkBindingError(message: "Unknown library track or queue position") }
                let track = tracks[index]
                await model.sonos.disconnect(); model.sonos.room = room
                model.player.queue = tracks; model.player.queueIndex = index
                await model.play(track, preservingQueue: true, queuePosition: index)
            case "phone.sonos.command":
                switch args["action"] as? String {
                case "pause": model.player.pause()
                case "play": await model.togglePlayback()
                case "next": model.player.advance(1)
                case "previous": model.player.advance(-1)
                case "track":
                    guard let index = args["index"] as? Int, model.player.queue.indices.contains(index) else {
                        throw DJLinkBindingError(message: "Choose a valid queue position")
                    }
                    await model.play(model.player.queue[index], preservingQueue: true, queuePosition: index)
                case "seek": model.player.seek(args["position"] as? Double ?? 0)
                case "volume": await model.sonos.setVolume(args["volume"] as? Double ?? 0)
                case "disconnect": await model.useSonos(nil)
                default: throw DJLinkBindingError(message: "Unknown player command")
                }
            case "phone.sonos.scrub":
                guard model.sonos.room != nil, let target = args["position"] as? Double,
                      target.isFinite, let scrub = model.player.beginScrubbing() else {
                    throw DJLinkBindingError(message: "Choose a Sonos track and finite scrub position")
                }
                let origin = model.player.elapsed
                for step in 1...100 {
                    model.player.updateScrubbing(scrub, to: origin + (target - origin) * Double(step) / 100)
                }
                model.player.endScrubbing(scrub, at: target)
            case "phone.sonos.status": break
            default: throw DJLinkBindingError(message: "Unknown Sonos operation")
            }
            response["value"] = ["rooms": model.sonos.rooms.map { ["id": $0.id, "name": $0.name, "ip": $0.ip] },
                "mediaSource": model.sonos.testingLocalMedia ? "phone" : "cloud",
                "enabled": model.sonos.enabled, "grouped": model.sonos.grouped,
                "roomVolumes": model.sonos.roomVolumes, "masterLimit": model.sonos.limits.master,
                "roomLimits": model.sonos.limits.rooms,
                "volume": model.sonos.volume, "phoneVolume": AVAudioSession.sharedInstance().outputVolume,
                "room": model.sonos.room?.name ?? "iPhone", "playing": model.player.playing,
                "trackId": model.player.track?.id ?? "", "elapsed": model.player.elapsed,
                "duration": model.player.duration, "queueIndex": model.player.queueIndex,
                "queuedCount": model.sonos.queuedCount, "totalCount": model.sonos.totalCount,
                "filling": model.sonos.filling, "pendingQueueIndex": model.player.pendingStreamQueueIndex ?? -1,
                "error": model.sonos.error ?? model.player.error ?? model.message ?? "",
                "tracks": model.tracks.filter { $0.mediaHash != nil }.prefix(10).map { ["id": $0.id, "title": $0.title] }]
            response["ok"] = true
        } catch { response["ok"] = false; response["error"] = error.localizedDescription }
        return (try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])) ?? Data("{}".utf8)
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
