import Foundation
import XCTest
@testable import InboxCore

final class PublishedOutputDownloadTests: XCTestCase {
    func testAuthenticatedDownloadPreservesVideoExtensionAndBytes() async throws {
        let path = "/brain/outputs/frontiers-next/launch & drop 1.mp4"
        let payload = "private video bytes"
        let fixture = try HTTPFixture { request in
            XCTAssertEqual(request.path, "/v1/agents/agent-1/files")
            XCTAssertEqual(URLComponents(string: "https://fixture.invalid/?" + (request.query ?? ""))?.queryItems?.first?.value, path)
            XCTAssertEqual(request.headers["authorization"], "Bearer " + fixtureKey)
            XCTAssertEqual(request.headers["accept"], "application/octet-stream")
            return FixtureReply(headers: ["Content-Type": "application/octet-stream", "Content-Length": String(payload.utf8.count)], body: payload)
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try .init(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
        defer { client.close() }
        let file = try await client.downloadOutput(agentID: "agent-1", path: path)
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        XCTAssertEqual(file.pathExtension, "mp4")
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), payload)
    }

    func testFilenameContainingTwoDotsSurvivesRequestGuard() async throws {
        let path = "/brain/outputs/run/clip..final.mp4"
        let fixture = try HTTPFixture { request in
            XCTAssertEqual(URLComponents(string: "https://fixture.invalid/?" + (request.query ?? ""))?.queryItems?.first?.value, path)
            return FixtureReply(headers: ["Content-Type": "application/octet-stream", "Content-Length": "2"], body: "ok")
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try .init(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
        defer { client.close() }
        let file = try await client.downloadOutput(agentID: "agent-1", path: path)
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "ok")
    }

    func testRejectsOversizedAdvertisedOutput() async throws {
        let fixture = try HTTPFixture { _ in
            FixtureReply(headers: ["Content-Type": "application/octet-stream",
                                   "Content-Length": String(ManagedClient.maximumOutputDownloadSize + 1)], body: "x")
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try .init(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
        defer { client.close() }
        do {
            let file = try await client.downloadOutput(agentID: "agent-1", path: "/brain/outputs/huge.mp4")
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
            XCTFail("Accepted oversized output")
        } catch APIError.invalidResponse { }
    }

    func testOutputDownloadDoesNotFollowRedirects() async throws {
        let fixture = try HTTPFixture { request in
            XCTAssertEqual(request.path, "/v1/agents/agent-1/files")
            return FixtureReply(status: 302, headers: ["Location": "/v1/private", "Content-Type": "text/plain"], body: "redirect")
        }
        defer { fixture.close() }
        let client = ManagedClient(credential: try .init(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
        defer { client.close() }
        do {
            _ = try await client.downloadOutput(agentID: "agent-1", path: "/brain/outputs/clip.mp4")
            XCTFail("Accepted redirect")
        } catch APIError.http(302) { }
    }

    func testRejectsUnrelatedPrivatePathsBeforeSendingARequest() async throws {
        let fixture = try HTTPFixture { _ in XCTFail("Invalid link caused a network request"); return FixtureReply() }
        defer { fixture.close() }
        let client = ManagedClient(credential: try .init(origin: fixture.origin, apiKey: fixtureKey), configuration: fixture.configuration)
        defer { client.close() }
        for path in ["/brain/tmp/key", "/brain/outputs/../key", "/brain/outputs//file.mp4"] {
            do { _ = try await client.downloadOutput(agentID: "agent-1", path: path); XCTFail(path) }
            catch APIError.invalidResponse { }
        }
    }
}
