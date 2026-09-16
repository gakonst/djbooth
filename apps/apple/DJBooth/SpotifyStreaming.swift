import SwiftUI
import AVFoundation
import DJBoothKit
#if os(iOS)
import SafariServices
#endif

#if os(iOS)
private actor SpotifyBridge {
    struct Status: Decodable, Sendable { let track: String; let playing: Bool; let position: Double; let ended: Bool; let error: String? }
    struct Connected: Decodable, Sendable { let credentials: String }
    private struct Empty: Decodable, Sendable {}
    private struct Envelope<T: Decodable>: Decodable { let ok: Bool; let value: T?; let error: String? }
    private func call<T: Decodable>(_ operation: String, input: Data, as: T.Type) throws -> T {
        let input = String(decoding: input, as: UTF8.self)
        let pointer = ("spotify." + operation).withCString { op in input.withCString { djbooth_link_request(op, $0) } }
        guard let pointer else { throw ClientError.http(500, "Streaming engine unavailable") }
        defer { djbooth_link_free(pointer) }
        let result = try JSONDecoder().decode(Envelope<T>.self, from: Data(String(cString: pointer).utf8))
        guard result.ok, let value = result.value else { throw ClientError.http(400, result.error ?? "Spotify streaming failed") }
        return value
    }
    func connect(account: String, device: String, credentials: String?, token: String?) throws -> String {
        struct Input: Encodable { let expectedAccount, deviceId: String; let credentials, accessToken: String? }
        return try call("connect", input: JSONEncoder().encode(Input(expectedAccount: account, deviceId: device, credentials: credentials, accessToken: token)), as: Connected.self).credentials
    }
    func command(_ name: String, uri: String = "", position: Double = 0, requestID: String = "") throws {
        struct Input: Encodable { let uri: String; let position: UInt32; let requestID: String }
        let milliseconds = UInt32(min(Double(UInt32.max), max(0, position.isFinite ? position * 1000 : 0)))
        _ = try call(name, input: JSONEncoder().encode(Input(uri: uri, position: milliseconds, requestID: requestID)), as: Empty.self)
    }
    func status() throws -> Status { try call("status", input: Data("{}".utf8), as: Status.self) }
}
#endif

@MainActor final class SpotifyStreaming {
    #if os(iOS)
    private let bridge = SpotifyBridge()
    private let audio = AVAudioEngine()
    private var node: AVAudioSourceNode?
    private var polling: Task<Void, Never>?
    private var connectionKey: String?
    private var generation = UUID()
    #endif
    func authorize(_ source: MusicSource, key: String, token: String) async throws {
        #if os(iOS)
        let request = UUID(); generation = request
        let credential = try await bridge.connect(account: source.accountID, device: deviceID(key), credentials: nil, token: token)
        try Task.checkCancellation()
        guard generation == request else { throw CancellationError() }
        try Keychain.save(credential, key: key); connectionKey = key
        #else
        throw ClientError.http(501, "Spotify streaming is available in the iPhone app")
        #endif
    }
    func play(_ track: DJBoothKit.MusicTrack, source: MusicSource, key: String, player: BoothPlayer) async throws {
        #if os(iOS)
        let request = UUID(); generation = request
        if connectionKey != key {
            guard let credential = try Keychain.read(key) else { throw ClientError.http(401, "Enable Spotify streaming") }
            let refreshed = try await bridge.connect(account: source.accountID, device: deviceID(key), credentials: credential, token: nil)
            guard generation == request else { return }
            try Keychain.save(refreshed, key: key); connectionKey = key
        }
        try await PlaybackAudioSession.shared.activate()
        guard generation == request, player.track?.id == track.id else { return }
        if node == nil {
            guard let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 2) else { throw ClientError.invalidMedia }
            let node = AVAudioSourceNode(format: format, renderBlock: Self.renderAudio)
            audio.attach(node); audio.connect(node, to: audio.mainMixerNode, format: format); self.node = node
        }
        if !audio.isRunning { try audio.start() }
        player.attachStream { [weak self] command, position in
            guard let self else { return }
            if command == "stop" { self.polling?.cancel(); self.polling = nil; self.generation = UUID() }
            Task { try? await self.bridge.command(command, position: position, requestID: request.uuidString) }
        }
        try await bridge.command("load", uri: "spotify:track:" + track.remoteID, position: player.elapsed, requestID: request.uuidString)
        guard generation == request, player.track?.id == track.id else { return }
        polling?.cancel()
        polling = Task { [weak self, weak player] in
            while let self, let player, !Task.isCancelled, self.generation == request, player.track?.id == track.id {
                do {
                    let state = try await self.bridge.status()
                    guard !Task.isCancelled, self.generation == request, state.track == "spotify:track:" + track.remoteID else { return }
                    player.updateStream(playing: state.playing, elapsed: state.position / 1000, error: state.error)
                    if state.ended { player.advance(1); return }
                    if state.error != nil { return }
                    try await Task.sleep(for: .milliseconds(500))
                } catch { if !Task.isCancelled { player.error = error.localizedDescription }; return }
            }
        }
        #else
        throw ClientError.http(501, "Spotify streaming is available in the iPhone app")
        #endif
    }
    func disconnect() async {
        #if os(iOS)
        generation = UUID(); polling?.cancel(); polling = nil
        try? await bridge.command("disconnect"); connectionKey = nil; audio.stop()
        #endif
    }
    #if os(iOS)
    // Core Audio invokes this on its real-time thread. A closure created in
    // play() inherits MainActor isolation and traps as soon as rendering starts.
    nonisolated private static func renderAudio(
        _ silence: UnsafeMutablePointer<ObjCBool>, _ time: UnsafePointer<AudioTimeStamp>,
        _ frames: AVAudioFrameCount, _ output: UnsafeMutablePointer<AudioBufferList>
    ) -> OSStatus {
        let buffers = UnsafeMutableAudioBufferListPointer(output)
        guard buffers.count == 2, let left = buffers[0].mData, let right = buffers[1].mData else { return noErr }
        djbooth_spotify_read(left.assumingMemoryBound(to: Float.self), right.assumingMemoryBound(to: Float.self), Int(frames))
        return noErr
    }

    private func deviceID(_ key: String) throws -> String {
        if let value = try Keychain.read(key + ":device") { return value }
        let value = UUID().uuidString; try Keychain.save(value, key: key + ":device"); return value
    }
    #endif
}

struct SpotifyStreamingSignIn: View {
    let source: MusicSource
    let complete: (String) async throws -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var pairing: SpotifyPairing?
    @State private var error: String?
    @State private var attempt = UUID()
    @State private var connecting = false
    @State private var showBrowser = false
    @State private var copied = false
    private let client = SpotifyPairingClient()
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    Image(systemName: "music.note").font(.system(size: 44)).foregroundStyle(BoothStyle.accent)
                    Text("Connect Spotify playback").font(.title2.bold())
                    Text("Use Spotify account **\(source.accountID)**, the account connected to Nanocodex. Spotify Premium is required to stream.")
                        .multilineTextAlignment(.center).foregroundStyle(.secondary)
                    if let error {
                        Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red)
                            .accessibilityIdentifier("spotify.signin.error")
                        Button("Try again") { self.error = nil; pairing = nil; connecting = false; copied = false; attempt = UUID() }
                            .buttonStyle(.borderedProminent).accessibilityIdentifier("spotify.signin.retry")
                    } else if connecting {
                        ProgressView("Connecting playback…").accessibilityIdentifier("spotify.signin.connecting")
                    } else if let pairing {
                        VStack(spacing: 12) {
                            Text("Your sign-in code").font(.subheadline).foregroundStyle(.secondary)
                            Text(pairing.userCode).font(.largeTitle.monospaced().bold()).textSelection(.enabled)
                            #if os(iOS)
                            Button(copied ? "Code copied" : "Copy code", systemImage: "doc.on.doc") {
                                UIPasteboard.general.string = pairing.userCode; copied = true
                            }.accessibilityIdentifier("spotify.signin.copy")
                            #endif
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                let remaining = max(0, Int(pairing.expiresAt.timeIntervalSince(context.date)))
                                Text(remaining > 0 ? "Code expires in \(String(format: "%d:%02d", remaining / 60, remaining % 60))" : "Code expired")
                                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            }
                        }.padding(20).frame(maxWidth: .infinity).background(BoothStyle.surface, in: RoundedRectangle(cornerRadius: 16))
                        Button("Continue to Spotify") {
                            #if os(iOS)
                            showBrowser = true
                            #else
                            openURL(pairing.url)
                            #endif
                        }.buttonStyle(.borderedProminent).controlSize(.large).accessibilityIdentifier("spotify.signin.continue")
                        Text("Approve access on Spotify. If asked, enter the code above. Playback connects automatically after approval.")
                            .font(.subheadline).multilineTextAlignment(.center).foregroundStyle(.secondary)
                        ProgressView("Waiting for approval…").accessibilityIdentifier("spotify.signin.waiting")
                    } else { ProgressView("Preparing secure sign-in…") }
                }.padding(24).frame(maxWidth: 520).frame(maxWidth: .infinity)
            }
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.accessibilityIdentifier("spotify.signin.cancel") } }
        }
        #if os(iOS)
        .sheet(isPresented: $showBrowser) {
            if let pairing { SpotifyApprovalBrowser(url: pairing.url).ignoresSafeArea() }
        }
        #endif
        .task(id: attempt) {
            do {
                let value = try await client.begin()
                try Task.checkCancellation(); pairing = value
                let token = try await client.token(value)
                try Task.checkCancellation(); showBrowser = false; connecting = true
                try await complete(token)
                try Task.checkCancellation(); dismiss()
            } catch {
                if !Task.isCancelled { showBrowser = false; connecting = false; pairing = nil; self.error = error.localizedDescription }
            }
        }
    }
}
#if os(iOS)
private struct SpotifyApprovalBrowser: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: url) }
    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
#endif
