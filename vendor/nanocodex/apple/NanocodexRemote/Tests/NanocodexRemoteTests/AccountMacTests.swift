#if os(macOS)
import AppKit
import XCTest
import WebRTC
@testable import NanocodexRemote

private final class MacFrameReceiver: NSObject, RTCVideoRenderer, @unchecked Sendable {
    private let lock = NSLock()
    private var dimensions: (Int32, Int32)?
    var receivedScreen: Bool {
        lock.lock(); defer { lock.unlock() }
        guard let (width, height) = dimensions else { return false }
        return width >= 320 && height >= 240
    }
    func setSize(_ size: CGSize) {}
    func renderFrame(_ frame: RTCVideoFrame?) {
        guard let frame else { return }
        lock.lock(); dimensions = (frame.width, frame.height); lock.unlock()
    }
}

final class AccountMacTests: XCTestCase {
    // Creates its own temporary publication; captures metadata only and sends no input.
    @MainActor func testLiveMacScreenLatency() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["NANOCODEX_TEST_MAC_LATENCY"] == "1",
              let address = env["NANOCODEX_MANAGED_URL"], let origin = URL(string: address),
              let token = env["NANOCODEX_API_KEY"], let output = env["NANOCODEX_TEST_MAC_LATENCY_OUTPUT"] else {
            throw XCTSkip("Requires an explicit live Mac latency fixture")
        }
        let service = try RemoteService(origin: origin) { $0.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        let host = RemoteMacHost(), viewer = RemoteViewer()
        let machine = "bench-mac-" + UUID().uuidString.lowercased()
        do {
            let surfaces = try await MacScreen.surfaces()
            let surface = try XCTUnwrap(surfaces.first)
            let began = ProcessInfo.processInfo.systemUptime
            await host.start(service: service, machineID: machine, name: "Mac latency fixture", surfaceID: surface.id)
            try await eventually { host.sharing }
            let publicationMs = (ProcessInfo.processInfo.systemUptime - began) * 1000
            let catalogAt = ProcessInfo.processInfo.systemUptime
            let hands = try await service.list()
            let hand = try XCTUnwrap(hands.first { $0.machineID == machine })
            let catalogMs = (ProcessInfo.processInfo.systemUptime - catalogAt) * 1000
            var samples: [[String: Any]] = []
            for _ in 0..<3 {
                let connectedAt = ProcessInfo.processInfo.systemUptime
                await viewer.connect(service: service, hand: hand)
                var media: [[String: Any]] = []
                let mediaTask = Task { @MainActor in
                    while !Task.isCancelled {
                        let stats = await host.diagnosticMedia()
                        if !stats.isEmpty { media.append(["elapsed_ms": (ProcessInfo.processInfo.systemUptime - connectedAt) * 1000, "stats": stats]) }
                        do { try await Task.sleep(for: .milliseconds(25)) } catch { return }
                    }
                }
                defer { mediaTask.cancel() }
                try await eventually {
                    guard viewer.connected, let data = viewer.diagnosticPresentation.data(using: .utf8),
                          let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
                    return value["first_frame"] is [String: Any]
                }
                let data = try XCTUnwrap(viewer.diagnosticPresentation.data(using: .utf8))
                var sample = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
                mediaTask.cancel(); await mediaTask.value
                sample["media"] = media
                sample["started_uptime_ms"] = connectedAt * 1000
                let controlAt = ProcessInfo.processInfo.systemUptime
                viewer.takeControl(); try await eventually { viewer.controlling }
                sample["control_ms"] = (ProcessInfo.processInfo.systemUptime - controlAt) * 1000
                sample["host_startup"] = host.diagnosticStartup
                samples.append(sample); viewer.releaseControl(); viewer.close()
            }
            try JSONSerialization.data(withJSONObject: ["publication_ms": publicationMs, "catalog_ms": catalogMs, "samples": samples], options: [.prettyPrinted, .sortedKeys])
                .write(to: URL(fileURLWithPath: output), options: .atomic)
            viewer.close(); await host.stop(); service.close()
        } catch {
            viewer.close(); await host.stop(); service.close(); throw error
        }
    }

    // Start sharing from the Mac app's real Screens UI, then focus its
    // empty composer before running this test. Inspect that composer afterwards
    // to confirm the marker arrived; this test does not claim to inspect app UI.
    @MainActor func testPublishedMacVideoAndControlSession() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let machineID = environment["NANOCODEX_TEST_MAC_MACHINE_ID"] else {
            throw XCTSkip("Requires an explicitly selected Mac shared through its native UI")
        }
        var values: [String: String] = [:]
        if let path = environment["NANOCODEX_TEST_REMOTE_ENV"] {
            for line in try String(contentsOfFile: path, encoding: .utf8).split(separator: "\n") {
                guard let split = line.firstIndex(of: "=") else { continue }
                values[String(line[..<split])] = String(line[line.index(after: split)...])
            }
        }
        let origin = try XCTUnwrap(URL(string: try XCTUnwrap(environment["NANOCODEX_MANAGED_URL"] ?? values["NANOCODEX_MANAGED_URL"])))
        let local = ["127.0.0.1", "localhost"].contains(origin.host ?? "")
        let live = environment["NANOCODEX_TEST_MAC_LIVE"] == "1" && origin.scheme == "https"
        guard local || live else {
            throw XCTSkip("A live account requires NANOCODEX_TEST_MAC_LIVE=1")
        }
        let token = try XCTUnwrap(environment["NANOCODEX_API_KEY"] ?? values["NANOCODEX_API_KEY"])
        let service = try RemoteService(origin: origin) { $0.setValue("Bearer " + token, forHTTPHeaderField: "Authorization") }
        let viewer = RemoteViewer()
        defer { viewer.close(); service.close() }
        let hands = try await service.list()
        let hand = try XCTUnwrap(hands.first { $0.machineID == machineID && $0.kind == .desktop })
        XCTAssertTrue(hand.controllable)
        await viewer.connect(service: service, hand: hand)
        try await eventually { viewer.connected && viewer.track != nil }
        let track = try XCTUnwrap(viewer.track), frames = MacFrameReceiver()
        track.add(frames)
        defer { track.remove(frames) }
        try await eventually { frames.receivedScreen }
        viewer.takeControl()
        try await eventually { viewer.controlling }

        // Never type into whichever unrelated application happens to be frontmost.
        let targetBundle = live ? "xyz.paradigm.nanocodex.macos" : "xyz.paradigm.nanocodex.macos.remote-evidence"
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == targetBundle else {
            throw XCTSkip("Focus the selected Mac app's empty composer before sending the marker")
        }
        viewer.input(kind: .text, text: "WebRTC Mac input verifiedx")
        for down in [true, false] { viewer.input(kind: .key, down: down, key: 42) }
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertTrue(viewer.connected && viewer.controlling)
        viewer.releaseControl()
        XCTAssertFalse(viewer.controlling)
    }

    @MainActor private func eventually(_ predicate: () -> Bool) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + 15
        while ProcessInfo.processInfo.systemUptime < deadline {
            if predicate() { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTFail("The published Mac did not reach the expected video/control state")
        throw RemoteError.unavailable
    }
}
#endif
