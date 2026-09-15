import AuthenticationServices
import CryptoKit
import DJBoothKit
import SwiftUI

/// Nanocodex owns SMS sign-in and provider authorization screens. Only a
/// single-use, proof-bound code returns through the app's URL scheme.
@MainActor final class ConnectLogin: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    func signIn(endpoint: Endpoint) async throws -> String {
        let verifier = UUID().uuidString.replacingOccurrences(of: "-", with: "") + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let state = UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let challenge = SHA256.hash(data: Data(verifier.utf8)).map { String(format: "%02x", $0) }.joined()
        var url = URLComponents(url: endpoint.url, resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "native", value: "1"), URLQueryItem(name: "challenge", value: challenge), URLQueryItem(name: "state", value: state)]
        defer { session = nil }
        let callback: URL = try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url.url!, callbackURLScheme: "djbooth") { callback, error in
                if let error { continuation.resume(throwing: error) }
                else if let callback { continuation.resume(returning: callback) }
                else { continuation.resume(throwing: ClientError.http(401, "Login did not finish")) }
            }
            session.presentationContextProvider = self
            self.session = session
            if !session.start() { continuation.resume(throwing: ClientError.http(401, "Could not open Nanocodex login")) }
        }
        let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false)
        guard callback.scheme == "djbooth", callback.host == "connect",
              parts?.queryItems?.first(where: { $0.name == "state" })?.value == state,
              let code = parts?.queryItems?.first(where: { $0.name == "code" })?.value else {
            throw ClientError.http(401, "Login callback did not match this request")
        }
        return try await CloudClient.exchangeLogin(endpoint: endpoint, code: code, verifier: verifier)
    }
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        #if os(macOS)
        NSApplication.shared.keyWindow ?? NSApplication.shared.windows.first ?? ASPresentationAnchor()
        #else
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows).first(where: \.isKeyWindow) ?? ASPresentationAnchor()
        #endif
    }
}

#if os(iOS)
struct MobileSignInView: View {
    @Bindable var model: BoothModel
    @State private var login = ConnectLogin()
    @State private var connecting = false
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Spacer()
            Image(systemName: "waveform").font(.system(size: 48)).foregroundStyle(BoothStyle.accent)
            Text("Your music.\nYour DJ Booth.").font(.largeTitle.bold())
            Text("Sign in with your phone number through Nanocodex. Your library stays yours across devices.").foregroundStyle(.secondary)
            Label("An agent that knows your library", systemImage: "bubble.left.and.bubble.right")
            Text("Ask about playlists, tracks, playback and downloads on this phone. Connect Spotify or SoundCloud to explore your saved music too.").font(.subheadline).foregroundStyle(.secondary)
            if let error { Text(error).font(.caption).foregroundStyle(.red).accessibilityIdentifier("connect.error") }
            Button {
                connecting = true; error = nil
                Task {
                    defer { connecting = false }
                    do {
                        let url = model.cloudURL.isEmpty ? "https://djbooth-library.gakonst.workers.dev" : model.cloudURL
                        let token = try await login.signIn(endpoint: Endpoint(url))
                        try await model.configureCloud(url: url, token: token)
                    } catch let failure as ASWebAuthenticationSessionError where failure.code == .canceledLogin {
                        // Cancellation leaves the welcome screen ready to retry.
                    } catch { self.error = error.localizedDescription }
                }
            } label: {
                HStack { if connecting { ProgressView() }; Text(connecting ? "Signing in…" : "Continue with Nanocodex").fontWeight(.semibold) }
                    .frame(maxWidth: .infinity).padding(.vertical, 8)
            }.buttonStyle(.borderedProminent).disabled(connecting).accessibilityIdentifier("connect.login")
            Text("Nanocodex handles SMS verification and connection approval.").font(.caption).foregroundStyle(.secondary)
            Spacer()
        }.padding(28).frame(maxWidth: 540).frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(BoothStyle.background)
    }
}
#endif
