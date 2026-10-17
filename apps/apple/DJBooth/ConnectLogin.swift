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
