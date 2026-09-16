import CryptoKit
import Foundation

/// Nanocodex Hosted Tools v1. A one-use, grant-bound ticket opens the reverse
/// connection. No phone server, public address, or copy of the library is needed.
@MainActor public final class PhoneToolHost {
    private var socket: URLSessionWebSocketTask?
    private var generation = UUID()
    public init() {}
    public static func catalog() throws -> [[String: Any]] {
        guard let url = Bundle.module.url(forResource: "phone-tools", withExtension: "json"),
              let value = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]] else {
            throw ClientError.http(500, "Phone tools are unavailable in this build")
        }
        return value
    }
    public static func catalogDigest() throws -> String {
        let data = try JSONSerialization.data(withJSONObject: catalog(), options: [.sortedKeys, .withoutEscapingSlashes])
        let bytes = Data("nanocodex-app-tool-catalog-v1\0".utf8) + data
        return "0x" + SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    public func stop() {
        generation = UUID()
        socket?.cancel(with: .goingAway, reason: nil); socket = nil
    }

    public func run(client: CloudClient,
                    status: @escaping @MainActor (Bool, String?) -> Void,
                    query: @escaping @MainActor ([String: Any], Int) throws -> String) async {
        stop()
        let current = generation
        var failures = 0
        defer { if generation == current { stop() } }
        while !Task.isCancelled, generation == current {
            do {
                let ticket = try await client.phoneToolTicket()
                guard !Task.isCancelled, generation == current else { return }
                guard ticket.catalogDigest == (try Self.catalogDigest()) else {
                    throw ClientError.http(409, "Update DJ Booth before connecting phone tools")
                }
                let request = try Self.socketRequest(ticket.url, endpoint: client.endpoint)
                let connection = URLSession.shared.webSocketTask(with: request)
                connection.maximumMessageSize = 65536
                socket = connection
                connection.resume()
                try await withTaskCancellationHandler {
                    let timeout = Task { @MainActor in
                        do { try await Task.sleep(for: .seconds(10)) } catch { return }
                        connection.cancel(with: .goingAway, reason: nil)
                    }
                    defer { timeout.cancel() }
                    try await send(["type": "catalog", "tools": Self.catalog()], to: connection)
                    let initial = try await receive(connection)
                    guard initial["type"] as? String == "ready" else { throw ClientError.http(502, "Phone tool handshake failed") }
                    timeout.cancel()
                    guard !Task.isCancelled, generation == current else { return }
                    failures = 0
                    status(true, nil)
                    var pendingPing: String?
                    let heartbeat = Task { @MainActor in
                        while !Task.isCancelled {
                            do {
                                try await Task.sleep(for: .seconds(20))
                                guard pendingPing == nil else { connection.cancel(with: .goingAway, reason: nil); return }
                                let nonce = UUID().uuidString; pendingPing = nonce
                                try await self.send(["type": "ping", "nonce": nonce], to: connection)
                            } catch { connection.cancel(with: .goingAway, reason: nil); return }
                        }
                    }
                    defer { heartbeat.cancel(); connection.cancel(with: .goingAway, reason: nil) }
                    // Read-only calls are synchronous on MainActor: switching
                    // accounts cannot interleave with building their result.
                    var receipts: [String: String] = [:]
                    while !Task.isCancelled, generation == current {
                        let frame = try await receive(connection)
                        guard !Task.isCancelled, generation == current else { return }
                        switch frame["type"] as? String {
                        case "call":
                            guard let id = frame["call_id"] as? String,
                                  id.range(of: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", options: .regularExpression) != nil else {
                                throw ClientError.http(502, "Invalid phone tool call")
                            }
                            if let receipt = receipts[id] { try await connection.send(.string(receipt)); continue }
                            let result: [String: Any]
                            do {
                                guard frame["name"] as? String == "djbooth_query",
                                      let budget = frame["output_byte_budget"] as? Int, budget > 0,
                                      let tokens = frame["output_token_budget"] as? Int, tokens > 0,
                                      let deadline = frame["deadline_at"] as? Double, deadline > Date().timeIntervalSince1970 * 1000 else {
                                    throw ClientError.http(400, "Unknown or expired phone tool call")
                                }
                                let input: [String: Any]
                                if let object = frame["input"] as? [String: Any] { input = object }
                                else if let text = frame["input"] as? String, let object = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] { input = object }
                                else { throw ClientError.http(400, "Invalid phone tool arguments") }
                                let output = try query(input, min(budget, tokens, 65536))
                                result = outputFrame(output, success: true)
                            } catch { result = outputFrame(error.localizedDescription, success: false) }
                            let receipt = try encode(["type": "result", "call_id": id, "outcome": ["status": "completed", "output": result]])
                            guard !Task.isCancelled, generation == current else { return }
                            // Bounded replay receipts; acknowledgements normally
                            // remove these immediately. Never re-execute a call.
                            guard receipts.count < 256 else { throw ClientError.http(429, "Too many unacknowledged phone queries") }
                            receipts[id] = receipt
                            try await connection.send(.string(receipt))
                        case "ack": if let id = frame["call_id"] as? String { receipts.removeValue(forKey: id) }
                        case "pong":
                            guard let nonce = frame["nonce"] as? String, nonce == pendingPing else { throw ClientError.http(502, "Invalid phone tool heartbeat") }
                            pendingPing = nil
                        case "cancel": break
                        default: throw ClientError.http(502, "Unexpected phone tool frame")
                        }
                    }
                } onCancel: { connection.cancel(with: .goingAway, reason: nil) }
            } catch {
                guard !Task.isCancelled, generation == current else { return }
                socket?.cancel(with: .goingAway, reason: nil); socket = nil
                status(false, error.localizedDescription)
                // Approval errors require an explicit new login, not retries.
                if case ClientError.http(let code, _) = error, [401, 403, 409].contains(code) { return }
                failures += 1
                do { try await Task.sleep(for: .seconds(min(30, max(1, failures * 2)))) } catch { return }
            }
        }
    }

    public static func socketRequest(_ url: URL, endpoint: Endpoint) throws -> URLRequest {
        let local = ["127.0.0.1", "localhost", "::1"].contains(endpoint.url.host ?? "")
        let trusted = url.scheme == "wss" && url.host == endpoint.url.host && url.port == endpoint.url.port && url.path.hasPrefix("/v1/agent/phone/")
        guard trusted || (local && url.scheme == "ws" && url.host == endpoint.url.host),
              url.user == nil, url.password == nil, url.fragment == nil,
              url.path.hasSuffix("/tool-host") else { throw ClientError.http(502, "Invalid phone tool destination") }
        var origin = URLComponents(url: endpoint.url, resolvingAgainstBaseURL: false)!
        origin.path = ""; origin.query = nil; origin.fragment = nil
        var request = URLRequest(url: url); request.timeoutInterval = 15
        request.setValue(origin.string!, forHTTPHeaderField: "Origin")
        return request
    }
    private func receive(_ socket: URLSessionWebSocketTask) async throws -> [String: Any] {
        let message = try await socket.receive()
        let data: Data
        switch message { case .data(let value): data = value; case .string(let value): data = Data(value.utf8); @unknown default: throw ClientError.http(502, "Invalid tool message") }
        guard let frame = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ClientError.http(502, "Invalid tool message") }
        return frame
    }
    private func encode(_ object: [String: Any]) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self) }
    private func send(_ object: [String: Any], to socket: URLSessionWebSocketTask) async throws { try await socket.send(.string(encode(object))) }
    private func outputFrame(_ text: String, success: Bool) -> [String: Any] {
        ["output": text, "success": success, "structured_result": NSNull(), "metadata": NSNull(), "process_trace": NSNull()]
    }
}
