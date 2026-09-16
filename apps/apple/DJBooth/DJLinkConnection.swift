#if os(iOS)
import SwiftUI
import DJBoothKit
import Network

struct DJLinkInterface: Decodable, Identifiable, Sendable, Equatable {
    let name, ip, broadcast, netmask: String
    let index: UInt32
    var id: String { "\(name):\(index):\(ip):\(netmask)" }
}
struct DJLinkStatus: Decodable, Sendable {
    struct Device: Decodable, Identifiable, Sendable {
        let player: Int
        let ip, model: String
        var id: String { ip }
    }
    var running: Bool
    var ip: String?
    var trackCount: Int?
    var playlistCount: Int?
    var devices: [Device]?
}
private struct LinkError: LocalizedError { let message: String; var errorDescription: String? { message } }

/// Serializes C ABI calls and disk preparation away from the UI actor.
private actor DJLinkEngine {
    private var bindingsVerified = false
    private var directory: URL?
    private var preparation = UUID()
    private func request<T: Decodable>(_ operation: String, input: String = "{}", as type: T.Type) throws -> T {
        try DJLinkBindings.decode(operation, input: input, as: type)
    }
    func interfaces() async throws -> [DJLinkInterface] {
        await AppDiagnostics.shared.ready()
        if !bindingsVerified { try DJLinkBindings.verifyInventory(); bindingsVerified = true }
        return try request("interfaces", as: [DJLinkInterface].self)
    }
    func status() throws -> DJLinkStatus { try request("status", as: DJLinkStatus.self) }
    private struct Prepared {
        let source: [Track]
        let collections: [Collection]
        let annotations: [String: TrackAnnotation]
        let audio: URL
        let availableArtifacts: Set<String>
        let tracks: [DJLinkLibrary.TrackRow]
        let playlists: [DJLinkLibrary.PlaylistRow]
        let omitted: Int
    }
    private var cached: Prepared?
    private var folder: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DJBooth-DJLink/v1", isDirectory: true)
    }
    func warm(tracks: [Track], collections: [Collection], annotations: [String: TrackAnnotation], audio: URL) async throws {
        await AppDiagnostics.shared.ready()
        _ = try prepare(tracks: tracks, collections: collections, annotations: annotations, audio: audio)
    }
    private func prepare(tracks: [Track], collections: [Collection], annotations: [String: TrackAnnotation], audio: URL) throws -> Prepared {
        // UI waveform hydration does not change the ANLZ-backed CDJ library.
        let source = tracks.map { track in var row = track; row.waveform = nil; return row }
        // Detect downloads/evictions even when their library metadata is unchanged.
        let availableArtifacts = Set(try FileManager.default.contentsOfDirectory(atPath: audio.path)
            .filter { $0.hasSuffix(".audio") })
        if let cached, cached.source == source, cached.collections == collections,
           cached.availableArtifacts == availableArtifacts,
           cached.annotations == annotations, cached.audio == audio,
           cached.tracks.allSatisfy({ row in
               [row.mountPath, row.analysisDatPath, row.analysisExtPath, row.analysisTwoexPath]
                   .compactMap { $0 }.allSatisfy { FileManager.default.fileExists(atPath: $0) }
           }) {
            AppDiagnostics.shared.event("cdj_library_cache_hit", ["tracks": String(cached.tracks.count)])
            return cached
        }
        let began = ProcessInfo.processInfo.systemUptime
        let library = try DJLinkLibrary.prepare(tracks: tracks, collections: collections, annotations: annotations,
                                               audioDirectory: audio, sessionDirectory: folder, idForIdentity: { identity in
            let input = try JSONEncoder().encode(["value": identity])
            return try self.request("function.stable_text_id", input: String(decoding: input, as: UTF8.self), as: UInt32.self)
        })
        guard !library.tracks.isEmpty else { throw LinkError(message: "Download a playlist and its CDJ analysis files before connecting. Sync the phone after publishing analyzed tracks from your Mac.") }
        struct Prepare: Encodable { let audioPath, outputDirectory: String }
        struct Analysis: Decodable { let dat, ext, twoEx: String }
        var ready = library.tracks
        for index in ready.indices {
            try Task.checkCancellation()
            let audio = URL(fileURLWithPath: ready[index].mountPath)
            let output = URL(fileURLWithPath: ready[index].analysisDatPath!).deletingLastPathComponent()
            let input = try JSONEncoder().encode(Prepare(audioPath: audio.path, outputDirectory: output.path))
            let analysis = try request("relocateAnalysis", input: String(decoding: input, as: UTF8.self), as: Analysis.self)
            ready[index].analysisDatPath = analysis.dat
            ready[index].analysisExtPath = analysis.ext
            ready[index].analysisTwoexPath = analysis.twoEx
        }

        let prepared = Prepared(source: source, collections: collections, annotations: annotations, audio: audio,
                                availableArtifacts: availableArtifacts,
                                tracks: ready, playlists: library.playlists, omitted: library.omittedTracks)
        cached = prepared
        AppDiagnostics.shared.event("cdj_library_ready", ["tracks": String(ready.count), "duration_ms": String(Int((ProcessInfo.processInfo.systemUptime - began) * 1000))])
        return prepared
    }
    func start(interface: DJLinkInterface, unicastDiscovery: Bool, tracks: [Track], collections: [Collection], annotations: [String: TrackAnnotation], audio: URL) async throws -> (DJLinkStatus, Int) {
        await AppDiagnostics.shared.ready()
        guard directory == nil else { throw LinkError(message: "Disconnect before reconnecting.") }
        let generation = UUID(); preparation = generation
        let library = try prepare(tracks: tracks, collections: collections, annotations: annotations, audio: audio)
        guard generation == preparation, !Task.isCancelled else { throw CancellationError() }
        struct Start: Encodable {
            let bindIp, broadcastIp: String
            let unicastDiscovery: Bool
            let diagnostics: Bool
            let discoveryCachePath: String
            let tracks: [DJLinkLibrary.TrackRow]
            let playlists: [DJLinkLibrary.PlaylistRow]
        }
        #if DEBUG
        let diagnostics = true
        #else
        let diagnostics = false
        #endif
        let data = try JSONEncoder().encode(Start(bindIp: interface.ip, broadcastIp: interface.broadcast,
                                                 unicastDiscovery: unicastDiscovery,
                                                 diagnostics: diagnostics,
                                                 discoveryCachePath: folder.appendingPathComponent("discovery-peers.json").path,
                                                 tracks: library.tracks, playlists: library.playlists))
        let status = try request("start", input: String(decoding: data, as: UTF8.self), as: DJLinkStatus.self)
        directory = folder
        return (status, library.omitted)
    }
    func stop() throws {
        preparation = UUID()
        _ = try request("stop", as: DJLinkStatus.self)
        directory = nil
    }
}

@MainActor @Observable final class DJLinkConnection {
    // Explicit development-only unattended hardware run. Keep the phone awake
    // before IPv4 assignment too, so auto-lock cannot end the discovery test.
    private var unattendedHardwareTest: Bool {
        #if DEBUG
        ProcessInfo.processInfo.arguments.contains("--dj-link-hardware-test")
        #else
        false
        #endif
    }
    var broadcastEnabled: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return Bundle.main.object(forInfoDictionaryKey: "DJBoothLinkEnabled") as? String == "YES"
        #endif
    }
    var interfaces: [DJLinkInterface] = []
    var selectedIP = ""
    var status = DJLinkStatus(running: false)
    var busy = false
    var error: String?
    var omittedTracks = 0
    private var wiredNames: Set<String> = []
    private var usbWiredNames: Set<String> = []
    private let wiredMonitor = NWPathMonitor()
    private let usbMonitor = NWPathMonitor(requiredInterfaceType: .other)
    private weak var monitoredModel: BoothModel?
    private var lifecycle = DJLinkLifecycle()
    private var activeInterfaceID: String?
    private var monitorGeneration = UUID()
    private var checking = false
    private var checkAgain = false
    private var nextStatusAt: TimeInterval = 0
    private var reportedInterfaces = ""
    private var reportedAutomaticState = ""
    private var generation = UUID()
    private let engine = DJLinkEngine()

    init() {
        let changed: @Sendable (NWPath, Bool) -> Void = { [weak self] path, usb in
            let names = Set(path.availableInterfaces.filter { $0.type == .wiredEthernet }.map(\.name))
            AppDiagnostics.shared.event("cdj_network_path", [
                "status": String(describing: path.status),
                "interfaces": path.availableInterfaces.map { "\($0.name):\($0.type)" }.joined(separator: ", ")
            ])
            Task { @MainActor [weak self] in
                if usb { self?.usbWiredNames = names } else { self?.wiredNames = names }
                if let self, let model = self.monitoredModel {
                    await self.autoConnect(model: model)
                }
                #if DEBUG
                NSLog("[DJLink] wired interfaces: %@", names.sorted().joined(separator: ", "))
                #endif
            }
        }
        wiredMonitor.pathUpdateHandler = { changed($0, false) }
        usbMonitor.pathUpdateHandler = { changed($0, true) }
        let queue = DispatchQueue(label: "xyz.gakonst.djbooth.djlink.network")
        wiredMonitor.start(queue: queue)
        usbMonitor.start(queue: queue)
    }
    deinit { wiredMonitor.cancel(); usbMonitor.cancel() }

    /// Network notifications trigger immediate checks. A cheap interface-only
    /// fallback covers USB adapters that iOS does not classify as Ethernet.
    /// Independent of USB storage enumeration, sheets, and library navigation.
    func monitor(model: BoothModel) async {
        AppDiagnostics.shared.event("cdj_monitor_started")
        if unattendedHardwareTest {
            UIApplication.shared.isIdleTimerDisabled = true
            AppDiagnostics.shared.event("cdj_unattended_test_awake")
        }
        let run = UUID(); monitorGeneration = run
        monitoredModel = model
        let warmup = Task { [engine] in
            try? await engine.warm(tracks: model.tracks, collections: model.collections,
                                   annotations: model.annotations, audio: model.audio.directory)
        }
        defer {
            warmup.cancel()
            if monitorGeneration == run { monitoredModel = nil }
            AppDiagnostics.shared.event("cdj_monitor_stopped")
        }
        while !Task.isCancelled {
            await autoConnect(model: model)
            do { try await Task.sleep(for: .milliseconds(125)) } catch { return }
        }
    }

    /// Called while foregrounded, even with the connection sheet closed.
    func autoConnect(model: BoothModel) async {
        guard !model.demo, UIApplication.shared.applicationState != .background else { return }
        guard !checking else { checkAgain = true; return }
        guard !busy else { return }
        checking = true
        defer {
            checking = false
            if checkAgain {
                checkAgain = false
                Task { [weak self, weak model] in
                    guard let self, let model else { return }
                    await self.autoConnect(model: model)
                }
            }
        }
        let request = generation
        await refresh()
        guard generation == request, !Task.isCancelled, !busy, UIApplication.shared.applicationState != .background else { return }
        let wired = interfaces.first(where: {
            wiredNames.contains($0.name) || usbWiredNames.contains($0.name) || ($0.name != "en0" && $0.ip.hasPrefix("169.254."))
        })
        let changed = lifecycle.observe(wired?.id)
        if changed {
            AppDiagnostics.shared.event("cdj_attachment_changed", ["interface": wired?.id ?? "detached"])
        }
        guard let wired else {
            if status.running { await disconnect() }
            reportAutomaticState("waiting_for_wired_interface")
            return
        }
        reportAutomaticState("wired_interface_ready:\(wired.id)")
        if status.running && activeInterfaceID != wired.id { await disconnect() }
        guard !Task.isCancelled, !busy, UIApplication.shared.applicationState != .background else { return }
        if status.running {
            let now = ProcessInfo.processInfo.systemUptime
            if now >= nextStatusAt {
                let request = generation
                do {
                    let next = try await engine.status()
                    guard generation == request, !Task.isCancelled, !busy,
                          UIApplication.shared.applicationState != .background else { return }
                    let previousDevices = status.devices?.map { "\($0.player):\($0.ip)" } ?? []
                    let nextDevices = next.devices?.map { "\($0.player):\($0.ip)" } ?? []
                    if previousDevices != nextDevices {
                        NSLog("[DJLink] discovered decks: %@", nextDevices.joined(separator: ", "))
                        AppDiagnostics.shared.event("cdj_devices_changed", ["devices": nextDevices.joined(separator: ",")])
                    }
                    status = next
                    nextStatusAt = now + (nextDevices.isEmpty ? 0.125 : 0.5)
                } catch {
                    guard generation == request, !Task.isCancelled, !busy, UIApplication.shared.applicationState != .background else { return }
                    await disconnect(message: error.localizedDescription)
                }
            }
            return
        }
        guard lifecycle.mayStart(at: ProcessInfo.processInfo.systemUptime) else { return }
        selectedIP = wired.ip
        await connect(model: model)
    }

    private func reportAutomaticState(_ state: String) {
        guard reportedAutomaticState != state else { return }
        reportedAutomaticState = state
        AppDiagnostics.shared.event("cdj_automatic_state", ["state": state])
    }

    func refresh() async {
        let request = generation
        do {
            let available = try await engine.interfaces()
            guard generation == request, !Task.isCancelled else { return }
            if interfaces != available { interfaces = available }
            let description = interfaces.map { "\($0.name)=\($0.ip)/\($0.netmask)" }.joined(separator: ", ")
            if description != reportedInterfaces {
                reportedInterfaces = description
                AppDiagnostics.shared.event("cdj_interfaces", ["interfaces": description])
                NSLog("[DJLink] available interfaces: %@", description)
            }
            if !interfaces.contains(where: { $0.ip == selectedIP }) {
                selectedIP = interfaces.count == 1 ? interfaces[0].ip : ""
            }
        } catch {
            self.error = error.localizedDescription
            reportAutomaticState("interface_scan_failed:\(error.localizedDescription)")
        }
    }
    func connect(model: BoothModel) async {
        guard !Task.isCancelled, UIApplication.shared.applicationState != .background,
              !busy, !status.running, let interface = interfaces.first(where: { $0.ip == selectedIP }) else { return }
        let request = UUID(); generation = request
        AppDiagnostics.shared.event("cdj_connect_started", ["connection": request.uuidString, "interface": interface.name, "ip": interface.ip])
        busy = true; error = nil
        UIApplication.shared.isIdleTimerDisabled = true
        defer {
            if generation == request {
                busy = false
                if !status.running { UIApplication.shared.isIdleTimerDisabled = unattendedHardwareTest && UIApplication.shared.applicationState != .background }
            }
        }
        do {
            let result = try await engine.start(interface: interface, unicastDiscovery: !broadcastEnabled,
                                                tracks: model.tracks, collections: model.collections,
                                                annotations: model.annotations, audio: model.audio.directory)
            guard generation == request else { return }
            status = result.0; omittedTracks = result.1
            AppDiagnostics.shared.event("cdj_serving", ["connection": request.uuidString, "tracks": String(status.trackCount ?? 0), "playlists": String(status.playlistCount ?? 0), "omitted": String(omittedTracks)])
            #if DEBUG
            NSLog("[DJLink] sharing %d tracks at %@; unicast discovery: %@", status.trackCount ?? 0, interface.ip, String(!broadcastEnabled))
            #endif
            UIApplication.shared.isIdleTimerDisabled = true
            activeInterfaceID = interface.id
            lifecycle.resetRetry()
            nextStatusAt = 0
        } catch {
            guard generation == request else { return }
            lifecycle.failed(at: ProcessInfo.processInfo.systemUptime)
            self.error = error.localizedDescription
            AppDiagnostics.shared.event("cdj_connect_failed", ["connection": request.uuidString, "error": error.localizedDescription])
            #if DEBUG
            NSLog("[DJLink] connection failed: %@", error.localizedDescription)
            #endif
        }
    }
    func disconnect(message: String? = nil) async {
        AppDiagnostics.shared.event("cdj_disconnect", ["connection": generation.uuidString, "reason": message ?? "lifecycle_or_interface_change"])
        lifecycle.resetRetry()
        activeInterfaceID = nil
        let request = UUID(); generation = request
        busy = true
        UIApplication.shared.isIdleTimerDisabled = unattendedHardwareTest && UIApplication.shared.applicationState != .background
        do {
            try await engine.stop()
            guard generation == request else { return }
            status = DJLinkStatus(running: false); error = message
        } catch {
            guard generation == request else { return }
            self.error = error.localizedDescription
        }
        busy = false
    }
}

struct DJLinkConnectionView: View {
    @Bindable var model: BoothModel
    @Environment(\.dismiss) private var dismiss
    private var link: DJLinkConnection { model.djLink }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Play from your iPhone").font(.title2.bold())
                    Text("Keep DJBooth open and connect the phone to the CDJ’s rear USB port. Sharing starts automatically when the wired network is ready. Choose DJ Booth iPhone on the CDJ’s LINK/source screen.")
                    Text("An Ethernet adapter connected to the CDJ network also works.").font(.caption).foregroundStyle(.secondary)
                }
                Section("Connection") {
                    if let download = model.cdjDownloadStatus {
                        ProgressView(download).font(.caption)
                    }
                    if link.status.running {
                        Label(link.status.devices?.isEmpty == false ? "DJ equipment found" : "Looking for CDJs…", systemImage: "network")
                            .accessibilityIdentifier("djlink.status")
                        ForEach(link.status.devices ?? []) { device in
                            LabeledContent(device.model, value: "Player \(device.player) · \(device.ip)")
                        }
                        if link.status.devices?.isEmpty != false {
                            Text("Allow Local Network access in iPhone Settings. Check the cable and that the CDJs are connected to the same DJ Link network.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        if !link.broadcastEnabled, link.status.devices?.isEmpty != false {
                            Text("Discovering decks automatically. Large networks with 169.254 addresses can take several minutes to search.")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    } else {
                        Label("Waiting for a CDJ", systemImage: "cable.connector")
                        Text("Plug in the cable. Connection starts automatically.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let error = link.error { Text(error).foregroundStyle(.red).accessibilityIdentifier("djlink.error") }
                }
                Section("While connected") {
                    Text("Keep DJBooth open. The screen stays awake while sharing. Switching apps or locking the phone disconnects DJ Link.")
                    Text("Only audio already downloaded to this phone is shared. Reconnect after downloading more tracks or changing playlists.")
                    Text("CDJ waveforms, beat grids, seek tables, and cues download with your tracks. Connecting never analyzes audio.")
                        .font(.caption).foregroundStyle(.secondary)
                    if link.status.running, link.omittedTracks > 0 {
                        Text("\(link.omittedTracks) tracks need audio or CDJ analysis downloads, or use an unsupported file type.").font(.caption)
                    }
                }
            }.navigationTitle("CDJs")
                .toolbar { Button("Done") { dismiss() } }
                .task { await link.refresh() }
        }
    }
}
#endif
