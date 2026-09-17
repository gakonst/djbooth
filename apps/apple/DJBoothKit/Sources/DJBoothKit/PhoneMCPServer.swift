import Foundation
import CoreFoundation

/// App-owned MCP endpoint. JSON-RPC travels over the authenticated outbound
/// phone connection; no listening socket or network protocol logic lives here.
@MainActor public enum PhoneMCPServer {
    public static func tools() throws -> [[String: Any]] {
        guard let url = Bundle.module.url(forResource: "app-mcp", withExtension: "json"),
              let value = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]] else {
            throw ClientError.http(500, "MCP catalog unavailable")
        }
        return value
    }
    public static func handle(_ request: [String: Any], invoke: (String, [String: Any]) throws -> String) -> [String: Any] {
        let id = request["id"] ?? NSNull()
        func response(_ result: [String: Any]) -> [String: Any] { ["jsonrpc": "2.0", "id": id, "result": result] }
        func failure(_ code: Int, _ message: String) -> [String: Any] {
            ["jsonrpc": "2.0", "id": id, "error": ["code": code, "message": message]]
        }
        guard request["jsonrpc"] as? String == "2.0", let method = request["method"] as? String else { return failure(-32600, "Invalid JSON-RPC request") }
        do {
            switch method {
            case "initialize":
                return response(["protocolVersion": "2025-06-18", "capabilities": ["tools": ["listChanged": false]],
                                 "serverInfo": ["name": "djbooth", "version": "1.0.0"]])
            case "ping": return response([:])
            case "tools/list": return response(["tools": try tools()])
            case "tools/call":
                guard let params = request["params"] as? [String: Any], let name = params["name"] as? String,
                      let tool = try tools().first(where: { $0["name"] as? String == name }),
                      let schema = tool["inputSchema"] as? [String: Any] else { return failure(-32602, "Unknown MCP tool") }
                if let arguments = params["arguments"], !(arguments is [String: Any]) { return failure(-32602, "Arguments must be an object") }
                let arguments = params["arguments"] as? [String: Any] ?? [:]
                try validate(arguments, schema: schema)
                do {
                    let output = try invoke(name, arguments)
                    return response(["content": [["type": "text", "text": output]], "isError": false])
                } catch {
                    return response(["content": [["type": "text", "text": error.localizedDescription]], "isError": true])
                }
            default: return failure(-32601, "Method not found")
            }
        } catch { return failure(-32602, error.localizedDescription) }
    }
    /// Validate the deliberately small schema vocabulary used by our app catalog.
    /// Reject unknown properties and Boolean/number coercion before any side effect.
    public static func validate(_ value: Any, schema: [String: Any]) throws {
        func invalid() -> ClientError { .http(400, "Arguments do not match the MCP tool schema") }
        if let choices = schema["enum"] as? [String], let text = value as? String, !choices.contains(text) { throw invalid() }
        switch schema["type"] as? String {
        case "object":
            guard let object = value as? [String: Any], let properties = schema["properties"] as? [String: [String: Any]],
                  Set(object.keys).isSubset(of: Set(properties.keys)),
                  (schema["required"] as? [String] ?? []).allSatisfy({ object[$0] != nil }) else { throw invalid() }
            for (key, field) in object { try validate(field, schema: properties[key]!) }
        case "string":
            guard let text = value as? String, text.count <= (schema["maxLength"] as? Int ?? 16384) else { throw invalid() }
            if schema["format"] as? String == "uuid", UUID(uuidString: text) == nil { throw invalid() }
        case "boolean":
            guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { throw invalid() }
        case "integer", "number":
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { throw invalid() }
            let n = number.doubleValue
            guard n.isFinite, n >= (schema["minimum"] as? Double ?? 0), n <= (schema["maximum"] as? Double ?? Double.greatestFiniteMagnitude),
                  schema["type"] as? String != "integer" || n.rounded() == n else { throw invalid() }
        case "array":
            guard let items = value as? [Any], items.count <= (schema["maxItems"] as? Int ?? 50), let itemSchema = schema["items"] as? [String: Any] else { throw invalid() }
            for item in items { try validate(item, schema: itemSchema) }
        default: throw invalid()
        }
    }
}

public struct PhoneActionReceipt: Codable, Sendable {
    public var requestID: String
    public var fingerprint: String
    public var status: String
    public var output: String
    public init(requestID: String, fingerprint: String, status: String = "running", output: String = "") {
        self.requestID = requestID; self.fingerprint = fingerprint; self.status = status; self.output = output
    }
}
