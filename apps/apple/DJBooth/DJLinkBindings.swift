#if os(iOS)
import Foundation

struct DJLinkBindingError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// C ABI marshalling only. Call from an actor away from MainActor.
/// Argument names and result fields are the original Rust API's names; Duration
/// uses {secs, nanos}, byte buffers use arrays, and optional values use null.
enum DJLinkBindings {
    static func verifyInventory() throws {
        struct Operation: Decodable { let operation: String }
        let available = try JSONDecoder().decode([Operation].self, from: request("api"))
        let expected = Set(DJLinkServerMethod.allCases.map { "server." + $0.rawValue } + DJLinkFunction.allCases.map { "function." + $0.rawValue })
        guard Set(available.map(\.operation)) == expected else {
            throw DJLinkBindingError(message: "The Swift and Rust DJ Link bindings do not match. Rebuild the app.")
        }
        #if DEBUG
        NSLog("[DJLink] Rust bindings verified: %d server methods, %d functions", DJLinkServerMethod.allCases.count, DJLinkFunction.allCases.count)
        #endif
    }
    static func request(_ operation: String, arguments: Data = Data("{}".utf8)) throws -> Data {
        let record = !operation.hasPrefix("diagnostics.") && operation != "function.stable_text_id"
        let call = UUID().uuidString
        let started = ProcessInfo.processInfo.systemUptime
        var succeeded = false
        if record { AppDiagnostics.shared.event("rust_call_started", ["call": call, "operation": operation]) }
        defer {
            if record { AppDiagnostics.shared.event("rust_call_finished", ["call": call, "operation": operation, "ok": String(succeeded), "duration_ms": String(Int((ProcessInfo.processInfo.systemUptime - started) * 1000))]) }
        }
        guard let input = String(data: arguments, encoding: .utf8) else {
            throw DJLinkBindingError(message: "DJ Link arguments must be UTF-8 JSON.")
        }
        let pointer = operation.withCString { op in input.withCString { djbooth_link_request(op, $0) } }
        guard let pointer else { throw DJLinkBindingError(message: "DJ Link returned no response.") }
        defer { djbooth_link_free(pointer) }
        let data = Data(String(cString: pointer).utf8)
        guard let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ok = envelope["ok"] as? Bool else {
            throw DJLinkBindingError(message: "Invalid DJ Link response.")
        }
        guard ok else {
            let error = envelope["error"] as? String ?? "DJ Link request failed."
            if record { AppDiagnostics.shared.event("rust_call_error", ["call": call, "operation": operation, "error": error]) }
            throw DJLinkBindingError(message: error)
        }
        let result = try JSONSerialization.data(withJSONObject: envelope["value"] ?? NSNull(), options: [.fragmentsAllowed])
        succeeded = true
        return result
    }
    static func decode<T: Decodable>(_ operation: String, input: String = "{}", as: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: request(operation, arguments: Data(input.utf8)))
    }
}

/// Every public DjLinkServer method and exported protocol helper is available.
/// These operation enums are generated from the Rust signatures at build time.
/// Results and failures come directly from Rust; Swift implements no protocol.
actor DJLinkClient {
    func server(_ method: DJLinkServerMethod, arguments: Data = Data("{}".utf8)) throws -> Data {
        try DJLinkBindings.request("server." + method.rawValue, arguments: arguments)
    }
    func function(_ function: DJLinkFunction, arguments: Data = Data("{}".utf8)) throws -> Data {
        try DJLinkBindings.request("function." + function.rawValue, arguments: arguments)
    }
    func api() throws -> Data { try DJLinkBindings.request("api") }
    /// Release the embedded instance and its runtime after server.stop.
    func close() throws { _ = try DJLinkBindings.request("stop") }
    func pollEvents(subscription: UInt64, limit: Int = 128) throws -> Data {
        struct Arguments: Encodable { let subscription: UInt64; let limit: Int }
        return try DJLinkBindings.request("server.poll_events", arguments: JSONEncoder().encode(Arguments(subscription: subscription, limit: limit)))
    }
    func unsubscribe(_ subscription: UInt64) throws {
        struct Arguments: Encodable { let subscription: UInt64 }
        _ = try DJLinkBindings.request("server.unsubscribe", arguments: JSONEncoder().encode(Arguments(subscription: subscription)))
    }
}
#endif
