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
private struct LinkResponse<T: Decodable>: Decodable { let ok: Bool; let value: T?; let error: String? }
private struct LinkError: LocalizedError { let message: String; var errorDescription: String? { message } }

/// Serializes C ABI calls and disk preparation away from the UI actor.
private actor DJLinkEngine {
    private var directory: URL?
    private var preparation = UUID()
    private func request<T: Decodable>(_ operation: String, input: String = "{}", as type: T.Type) throws -> T {
        let pointer = operation.withCString { op in input.withCString { djbooth_link_request(op, $0) } }
        guard let pointer else { throw LinkError(message: "DJ Link returned no response.") }
        defer { djbooth_link_free(pointer) }
        let result = try JSONDecoder().decode(LinkResponse<T>.self, from: Data(String(cString: pointer).utf8))
        guard result.ok, let value = result.value else { throw LinkError(message: result.error ?? "DJ Link could not connect.") }
        return value
    }
    func interfaces() throws -> [DJLinkInterface] { try request("interfaces", as: [DJLinkInterface].self) }
    func status() throws -> DJLinkStatus { try request("status", as: DJLinkStatus.self) }
    func start(interface: DJLinkInterface, unicastDiscovery: Bool, tracks: [Track], collections: [Collection], annotations: [String: TrackAnnotation], audio: URL) async throws -> (DJLinkStatus, Int) {
        guard directory == nil else { throw LinkError(message: "Disconnect before reconnecting.") }
        let generation = UUID(); preparation = generation
        // Immutable artifacts are reusable across connections. Stable paths also
        // prevent a deck's cached metadata from pointing into a deleted session.
        let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DJBooth-DJLink/v1", isDirectory: true)
        do {
            let library = try DJLinkLibrary.prepare(tracks: tracks, collections: collections, annotations: annotations,
                                                   audioDirectory: audio, sessionDirectory: folder)
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
                let tracks: [DJLinkLibrary.TrackRow]
                let playlists: [DJLinkLibrary.PlaylistRow]
            }
            let data = try JSONEncoder().encode(Start(bindIp: interface.ip, broadcastIp: interface.broadcast,
                                                     unicastDiscovery: unicastDiscovery,
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
    private var pausedIP: String?
    private var lastAutomaticAttempt = Date.distantPast
    private var reportedInterfaces = ""
    private var generation = UUID()
    private var updates: Task<Void, Never>?
    private let engine = DJLinkEngine()

    init() {
        wiredMonitor.pathUpdateHandler = { [weak self] path in
            let names = Set(path.availableInterfaces.filter { $0.type == .wiredEthernet }.map(\.name))
            Task { @MainActor [weak self] in
                self?.wiredNames = names
                #if DEBUG
                NSLog("[DJLink] wired interfaces: %@", names.sorted().joined(separator: ", "))
                #endif
            }
        }
        wiredMonitor.start(queue: DispatchQueue(label: "xyz.gakonst.djbooth.djlink.network"))
    }
    deinit { wiredMonitor.cancel() }

    /// Called while foregrounded, even with the connection sheet closed.
    func autoConnect(model: BoothModel) async {
        guard !model.demo, !busy else { return }
        await refresh()
        guard !Task.isCancelled, UIApplication.shared.applicationState != .background else { return }
        if let pausedIP, !interfaces.contains(where: { $0.ip == pausedIP }) { self.pausedIP = nil }
        // CDJ USB networking can appear as en5/link-local without being
        // classified as wiredEthernet by NWPathMonitor on a physical iPhone.
        guard let wired = interfaces.first(where: {
            wiredNames.contains($0.name) || ($0.name != "en0" && $0.ip.hasPrefix("169.254."))
        }),
              wired.ip != pausedIP else { return }
        if status.running {
            guard status.ip != wired.ip else { return }
            await disconnect()
        }
        guard Date().timeIntervalSince(lastAutomaticAttempt) >= 10 else { return }
        lastAutomaticAttempt = Date()
        selectedIP = wired.ip
        await connect(model: model)
    }

    func refresh() async {
        do {
            interfaces = try await engine.interfaces()
            #if DEBUG
            let description = interfaces.map { "\($0.name)=\($0.ip)/\($0.netmask)" }.joined(separator: ", ")
            if description != reportedInterfaces {
                reportedInterfaces = description
                NSLog("[DJLink] available interfaces: %@", description)
            }
            #endif
            if !interfaces.contains(where: { $0.ip == selectedIP }) {
                selectedIP = interfaces.count == 1 ? interfaces[0].ip : ""
            }
        } catch { self.error = error.localizedDescription }
    }
    func connect(model: BoothModel) async {
        guard !Task.isCancelled, UIApplication.shared.applicationState != .background,
              !busy, !status.running, let interface = interfaces.first(where: { $0.ip == selectedIP }) else { return }
        pausedIP = nil
        let request = UUID(); generation = request
        busy = true; error = nil
        UIApplication.shared.isIdleTimerDisabled = true
        defer {
            if generation == request {
                busy = false
                if !status.running { UIApplication.shared.isIdleTimerDisabled = false }
            }
        }
        do {
            let result = try await engine.start(interface: interface, unicastDiscovery: !broadcastEnabled,
                                                tracks: model.tracks, collections: model.collections,
                                                annotations: model.annotations, audio: model.audio.directory)
            guard generation == request else { return }
            status = result.0; omittedTracks = result.1
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
                            await self.disconnect(message: "Connection lost. Reconnect the cable, refresh connections, and connect again.")
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
            #if DEBUG
            NSLog("[DJLink] connection failed: %@", error.localizedDescription)
            #endif
        }
    }
    func disconnect(message: String? = nil, pauseAutomatic: Bool = false) async {
        if pauseAutomatic { pausedIP = status.ip ?? selectedIP }
        generation = UUID(); updates?.cancel(); updates = nil
        busy = true
        UIApplication.shared.isIdleTimerDisabled = false
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
                    Text("You can also use an Ethernet adapter or the same local network as the CDJs.").font(.caption).foregroundStyle(.secondary)
                }
                Section("Connection") {
                    if let download = model.cdjDownloadStatus {
                        ProgressView(download).font(.caption)
                    }
                    if link.status.running {
                        Label(link.status.devices?.isEmpty == false ? "DJ equipment found" : "Looking for CDJs…", systemImage: "network")
                            .accessibilityIdentifier("djlink.status")
                        Text("Sharing \(link.status.trackCount ?? 0) downloaded tracks").font(.subheadline)
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
                        Button("Disconnect", role: .destructive) { Task { await link.disconnect(pauseAutomatic: true) } }
                            .disabled(link.busy).accessibilityIdentifier("djlink.disconnect")
                    } else {
                        if link.interfaces.isEmpty {
                            Text("No local connection found. Connect the cable, wait, then refresh.")
                        } else {
                            Picker("Connection", selection: Binding(get: { link.selectedIP }, set: { link.selectedIP = $0 })) {
                                Text("Choose connection").tag("")
                                ForEach(link.interfaces) { item in Text("\(item.ip) (\(item.name))").tag(item.ip) }
                            }.disabled(link.busy)
                        }
                        Button("Refresh connections") { Task { await link.refresh() } }.disabled(link.busy)
                        Button("Connect to CDJ") { Task { await link.connect(model: model) } }
                            .disabled(link.selectedIP.isEmpty || link.busy || model.demo)
                            .accessibilityIdentifier("djlink.connect")
                    }
                    if link.busy { ProgressView("Connecting DJ Link…") }
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
            }.navigationTitle("Connect to CDJ")
                .toolbar { Button("Done") { dismiss() } }
                .task { await link.refresh() }
        }
    }
}
#endif
