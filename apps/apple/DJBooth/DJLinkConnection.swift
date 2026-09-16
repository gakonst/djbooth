#if os(iOS)
import SwiftUI
import DJBoothKit
import Network

struct DJLinkInterface: Decodable, Identifiable, Sendable {
    let name, ip, broadcast, netmask: String
    var id: String { ip }
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
    func start(interface: DJLinkInterface, unicastDiscovery: Bool, tracks: [Track], collections: [Collection], annotations: [String: TrackAnnotation], audio: URL) async throws -> (DJLinkStatus, Int) {
        await AppDiagnostics.shared.ready()
        guard directory == nil else { throw LinkError(message: "Disconnect before reconnecting.") }
        let generation = UUID(); preparation = generation
        // Immutable artifacts are reusable across connections. Stable paths also
        // prevent a deck's cached metadata from pointing into a deleted session.
        let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DJBooth-DJLink/v1", isDirectory: true)
        do {
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
                guard generation == preparation, !Task.isCancelled else { throw CancellationError() }
                let audio = URL(fileURLWithPath: ready[index].mountPath)
                let output = URL(fileURLWithPath: ready[index].analysisDatPath!).deletingLastPathComponent()
                let input = try JSONEncoder().encode(Prepare(audioPath: audio.path, outputDirectory: output.path))
                let analysis = try request("relocateAnalysis", input: String(decoding: input, as: UTF8.self), as: Analysis.self)
                ready[index].analysisDatPath = analysis.dat
                ready[index].analysisExtPath = analysis.ext
                ready[index].analysisTwoexPath = analysis.twoEx
            }
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
                                                     tracks: ready, playlists: library.playlists))
            let status = try request("start", input: String(decoding: data, as: UTF8.self), as: DJLinkStatus.self)
            directory = folder
            return (status, library.omittedTracks)
        } catch {
            throw error
        }
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
    private let wiredMonitor = NWPathMonitor(requiredInterfaceType: .wiredEthernet)
    private weak var monitoredModel: BoothModel?
    private var lastAutomaticAttempt = Date.distantPast
    private var reportedInterfaces = ""
    private var reportedAutomaticState = ""
    private var generation = UUID()
    private var updates: Task<Void, Never>?
    private let engine = DJLinkEngine()

    init() {
        wiredMonitor.pathUpdateHandler = { [weak self] path in
            let names = Set(path.availableInterfaces.filter { $0.type == .wiredEthernet }.map(\.name))
            AppDiagnostics.shared.event("cdj_network_path", [
                "status": String(describing: path.status),
                "interfaces": path.availableInterfaces.map { "\($0.name):\($0.type)" }.joined(separator: ", ")
            ])
            Task { @MainActor [weak self] in
                self?.wiredNames = names
                if let self, let model = self.monitoredModel {
                    await self.autoConnect(model: model)
                }
                #if DEBUG
                NSLog("[DJLink] wired interfaces: %@", names.sorted().joined(separator: ", "))
                #endif
            }
        }
        wiredMonitor.start(queue: DispatchQueue(label: "xyz.gakonst.djbooth.djlink.network"))
    }
    deinit { wiredMonitor.cancel() }

    /// Network notifications trigger immediate checks. A cheap interface-only
    /// fallback covers USB adapters that iOS does not classify as Ethernet.
    /// Independent of USB storage enumeration, sheets, and library navigation.
    func monitor(model: BoothModel) async {
        AppDiagnostics.shared.event("cdj_monitor_started")
        if unattendedHardwareTest {
            UIApplication.shared.isIdleTimerDisabled = true
            AppDiagnostics.shared.event("cdj_unattended_test_awake")
        }
        monitoredModel = model
        defer { monitoredModel = nil; AppDiagnostics.shared.event("cdj_monitor_stopped") }
        while !Task.isCancelled {
            await autoConnect(model: model)
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
        }
    }

    /// Called while foregrounded, even with the connection sheet closed.
    func autoConnect(model: BoothModel) async {
        guard !model.demo, !busy else { return }
        await refresh()
        guard !Task.isCancelled, !busy, UIApplication.shared.applicationState != .background else { return }
        // CDJ USB networking can appear as en5/link-local without being
        // classified as wiredEthernet by NWPathMonitor on a physical iPhone.
        guard let wired = interfaces.first(where: {
            wiredNames.contains($0.name) || ($0.name != "en0" && $0.ip.hasPrefix("169.254."))
        }) else {
            reportAutomaticState("waiting_for_wired_interface")
            return
        }
        reportAutomaticState("wired_interface_ready:\(wired.name):\(wired.ip)")
        if status.running {
            guard status.ip != wired.ip else { return }
            await disconnect()
        }
        guard Date().timeIntervalSince(lastAutomaticAttempt) >= 10 else { return }
        lastAutomaticAttempt = Date()
        selectedIP = wired.ip
        await connect(model: model)
    }

    private func reportAutomaticState(_ state: String) {
        guard reportedAutomaticState != state else { return }
        reportedAutomaticState = state
        AppDiagnostics.shared.event("cdj_automatic_state", ["state": state])
    }

    func refresh() async {
        do {
            interfaces = try await engine.interfaces()
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
            updates = Task { [weak self] in
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(1)) } catch { return }
                    guard let self else { return }
                    do {
                        let next = try await self.engine.status()
                        guard !Task.isCancelled, self.generation == request else { return }
                        let available = try await self.engine.interfaces()
                        guard !Task.isCancelled, self.generation == request else { return }
                        if !available.contains(where: { $0.ip == interface.ip && $0.broadcast == interface.broadcast }) {
                            await self.disconnect()
                            return
                        }
                        #if DEBUG
                        let previousDevices = self.status.devices?.map { "\($0.player):\($0.ip)" } ?? []
                        let nextDevices = next.devices?.map { "\($0.player):\($0.ip)" } ?? []
                        if previousDevices != nextDevices {
                            NSLog("[DJLink] discovered decks: %@", nextDevices.joined(separator: ", "))
                        }
                        #endif
                        self.status = next
                    } catch {
                        await self.disconnect(message: error.localizedDescription)
                        return
                    }
                }
            }
        } catch {
            guard generation == request else { return }
            self.error = error.localizedDescription
            AppDiagnostics.shared.event("cdj_connect_failed", ["connection": request.uuidString, "error": error.localizedDescription])
            #if DEBUG
            NSLog("[DJLink] connection failed: %@", error.localizedDescription)
            #endif
        }
    }
    func disconnect(message: String? = nil) async {
        AppDiagnostics.shared.event("cdj_disconnect", ["connection": generation.uuidString, "reason": message ?? "lifecycle_or_interface_change"])
        lastAutomaticAttempt = .distantPast
        generation = UUID(); updates?.cancel(); updates = nil
        busy = true
        UIApplication.shared.isIdleTimerDisabled = unattendedHardwareTest && UIApplication.shared.applicationState != .background
        do { try await engine.stop(); status = DJLinkStatus(running: false); error = message }
        catch { self.error = error.localizedDescription }
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
