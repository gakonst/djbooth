import SwiftUI
import AVFoundation
import DJBoothKit

struct SpotifyPairing: Decodable, Sendable {
    let device_code, user_code, verification_uri: String
    let verification_uri_complete: String?
    let expires_in, interval: Int
    var url: URL? {
        guard let url = URL(string: verification_uri_complete ?? verification_uri), url.scheme == "https",
              ["spotify.com", "www.spotify.com"].contains(url.host ?? ""), url.path == "/pair" else { return nil }
        return url
    }
}
private struct SpotifyOAuthToken: Decodable, Sendable { let access_token: String }
/// Spotify pairing keeps the device code and access token in memory only. The reusable
/// librespot credential is stored in the device Keychain under the Nanocodex account/connection.
enum SpotifyPairingClient {
    private static let clientID = "65b708073fc0480ea92a077233ca87bd"
    static func begin() async throws -> SpotifyPairing {
        let (data, status) = try await post("oauth2/device/authorize", ["client_id": clientID, "scope": "streaming"])
        guard status == 200 else { throw ClientError.http(status, "Spotify streaming sign-in could not start") }
        let pairing = try JSONDecoder().decode(SpotifyPairing.self, from: data)
        guard pairing.url != nil, (1...3600).contains(pairing.expires_in), (1...60).contains(pairing.interval) else { throw ClientError.invalidEndpoint }
        return pairing
    }
    static func token(_ pairing: SpotifyPairing) async throws -> String {
        let expires = Date().addingTimeInterval(Double(pairing.expires_in))
        var interval = pairing.interval
        while Date() < expires {
            try await Task.sleep(for: .seconds(interval))
            let (data, status) = try await post("api/token", ["client_id": clientID, "device_code": pairing.device_code, "grant_type": "urn:ietf:params:oauth:grant-type:device_code"])
            if status == 200 { return try JSONDecoder().decode(SpotifyOAuthToken.self, from: data).access_token }
            struct Failure: Decodable { let error: String }
            let error = try JSONDecoder().decode(Failure.self, from: data).error
            if error == "slow_down" { interval += 5; continue }
            if error == "authorization_pending" { continue }
            throw ClientError.http(status, "Spotify sign-in was declined or expired. Try again.")
        }
        throw ClientError.http(401, "Spotify sign-in expired. Try again.")
    }
    private static func post(_ path: String, _ values: [String: String]) async throws -> (Data, Int) {
        var request = URLRequest(url: URL(string: "https://accounts.spotify.com/" + path)!)
        request.httpMethod = "POST"; request.timeoutInterval = 30
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        request.httpBody = Data(values.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed)!)" }.joined(separator: "&").utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }
}
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
        let credential = try await bridge.connect(account: source.accountID, device: deviceID(key), credentials: nil, token: token)
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
            let node = AVAudioSourceNode(format: format) { _, _, frames, output in
                let buffers = UnsafeMutableAudioBufferListPointer(output)
                guard buffers.count == 2, let left = buffers[0].mData, let right = buffers[1].mData else { return noErr }
                djbooth_spotify_read(left.assumingMemoryBound(to: Float.self), right.assumingMemoryBound(to: Float.self), Int(frames))
                return noErr
            }
            audio.attach(node); audio.connect(node, to: audio.mainMixerNode, format: format); self.node = node
        }
        if !audio.isRunning { try audio.start() }
        player.attachStream { [weak self] command, position in
            guard let self else { return }
            if command == "stop" { self.polling?.cancel(); self.polling = nil; self.generation = UUID() }
            Task { try? await self.bridge.command(command, position: position, requestID: request.uuidString) }
        }
        try await bridge.command("load", uri: "spotify:track:" + track.remoteID, position: player.elapsed, requestID: request.uuidString)
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
    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Image(systemName: "music.note").font(.largeTitle)
                Text("Enable Spotify streaming").font(.title2.bold())
                Text("Sign in to \(source.label) to play inside DJ Booth. Spotify Premium is required.").multilineTextAlignment(.center)
                if let pairing, let url = pairing.url {
                    Text(pairing.user_code).font(.title.monospaced()).textSelection(.enabled)
                    Button("Continue to Spotify") { openURL(url) }.buttonStyle(.borderedProminent)
                    Text("Approve on Spotify, then return to DJ Booth.").font(.caption).foregroundStyle(.secondary)
                    ProgressView("Waiting for Spotify")
                } else if error == nil { ProgressView("Preparing sign-in") }
                if let error { Text(error).foregroundStyle(.red); Button("Try again") { self.error = nil; pairing = nil; attempt = UUID() } }
            }.padding(24)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }.task(id: attempt) {
            do {
                let value = try await SpotifyPairingClient.begin(); pairing = value
                let token = try await SpotifyPairingClient.token(value)
                try Task.checkCancellation(); try await complete(token); dismiss()
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }
}
