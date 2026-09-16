import Foundation

public struct SpotifyPairing: Sendable {
    public let userCode: String
    public let url: URL
    public let expiresAt: Date
    let deviceCode: String
    let interval: Double
}

public enum SpotifyPairingError: Error, LocalizedError, Sendable {
    case expired, declined, invalidResponse, unavailable
    public var errorDescription: String? {
        switch self {
        case .expired: "This Spotify code expired. Get a new code to continue."
        case .declined: "Spotify sign-in was declined. Try again when you’re ready."
        case .invalidResponse: "Spotify returned an invalid sign-in response. Please try again."
        case .unavailable: "Spotify sign-in is unavailable right now. Please try again."
        }
    }
}

/// Matches librespot oauth/src/lib.rs DeviceAuthClient and docs/device-authorization.md.
/// Device codes/tokens stay in memory. Polling follows RFC 8628, including slow_down
/// and transport backoff, without extending the original code's lifetime.
public struct SpotifyPairingClient: Sendable {
    typealias Response = (data: Data, status: Int, retryAfter: Double?)
    private let post: @Sendable (String, [String: String]) async throws -> Response
    private let now: @Sendable () -> Date
    private let sleep: @Sendable (Double) async throws -> Void
    private static let clientID = "65b708073fc0480ea92a077233ca87bd"

    public init(session: URLSession = .shared) {
        self.init(post: { path, values in
            var request = URLRequest(url: URL(string: "https://accounts.spotify.com/" + path)!)
            request.httpMethod = "POST"; request.timeoutInterval = 30
            request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
            let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
            request.httpBody = Data(values.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed)!)" }.joined(separator: "&").utf8)
            let (data, response) = try await session.data(for: request)
            let http = response as? HTTPURLResponse
            return (data, http?.statusCode ?? 0, http?.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init))
        }, now: { Date() }, sleep: { try await Task.sleep(for: .seconds($0)) })
    }
    init(post: @escaping @Sendable (String, [String: String]) async throws -> Response,
         now: @escaping @Sendable () -> Date, sleep: @escaping @Sendable (Double) async throws -> Void) {
        self.post = post; self.now = now; self.sleep = sleep
    }
    public func begin() async throws -> SpotifyPairing {
        let issuedAt = now()
        let response = try await post("oauth2/device/authorize", ["client_id": Self.clientID, "scope": "streaming"])
        try Task.checkCancellation()
        guard response.status == 200 else { throw SpotifyPairingError.unavailable }
        struct Wire: Decodable {
            let device_code, user_code, verification_uri: String
            let verification_uri_complete: String?
            let expires_in: Double
            let interval: Double?
        }
        guard let wire = try? JSONDecoder().decode(Wire.self, from: response.data),
              !wire.device_code.isEmpty, !wire.user_code.isEmpty,
              (1...3600).contains(wire.expires_in), (1...60).contains(wire.interval ?? 5),
              let url = URL(string: wire.verification_uri_complete ?? wire.verification_uri),
              url.scheme == "https", ["spotify.com", "www.spotify.com"].contains(url.host ?? ""),
              url.path == "/pair", url.user == nil, url.password == nil, url.port == nil else {
            throw SpotifyPairingError.invalidResponse
        }
        return SpotifyPairing(userCode: wire.user_code, url: url,
                              expiresAt: issuedAt.addingTimeInterval(wire.expires_in),
                              deviceCode: wire.device_code, interval: wire.interval ?? 5)
    }
    public func token(_ pairing: SpotifyPairing) async throws -> String {
        var interval = pairing.interval
        while now() < pairing.expiresAt {
            try await sleep(min(interval, pairing.expiresAt.timeIntervalSince(now())))
            try Task.checkCancellation()
            guard now() < pairing.expiresAt else { break }
            let response: Response
            do {
                response = try await post("api/token", ["client_id": Self.clientID, "device_code": pairing.deviceCode,
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code"])
            } catch let error as URLError where [.timedOut, .networkConnectionLost, .notConnectedToInternet, .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .cancelled].contains(error.code) {
                try Task.checkCancellation()
                interval = max(interval, min(60, interval * 2)); continue
            }
            try Task.checkCancellation()
            if response.status == 200 {
                struct Token: Decodable { let access_token: String }
                guard let token = try? JSONDecoder().decode(Token.self, from: response.data), !token.access_token.isEmpty else {
                    throw SpotifyPairingError.invalidResponse
                }
                return token.access_token
            }
            if response.status == 429 || (500...599).contains(response.status) {
                interval = max(interval, min(60, interval * 2), min(3600, response.retryAfter ?? 0)); continue
            }
            struct Failure: Decodable { let error: String }
            switch (try? JSONDecoder().decode(Failure.self, from: response.data))?.error {
            case "authorization_pending": continue
            case "slow_down": interval += 5
            case "access_denied": throw SpotifyPairingError.declined
            case "expired_token": throw SpotifyPairingError.expired
            default: throw SpotifyPairingError.unavailable
            }
        }
        throw SpotifyPairingError.expired
    }
}
