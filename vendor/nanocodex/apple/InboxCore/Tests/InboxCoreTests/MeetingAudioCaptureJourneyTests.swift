import AVFoundation
import Foundation
import InboxCore
import XCTest
#if os(macOS)
import Darwin
#endif

/// Real PCM -> shipped capture writer -> CAF -> fresh store -> decoder journeys.
/// No microphone, Speech recognizer, filesystem or audio codec is mocked.
/// These checks require an Apple runtime. macOS additionally kills an actual
/// writer subprocess before finalization. None establishes locked microphone capture.
final class MeetingAudioCaptureJourneyTests: XCTestCase {
    private let scope = "synthetic-meeting-audio-owner"
    private let otherScope = "synthetic-meeting-audio-other-owner"

    func testRecordingFlushReopenPlaybackAndDownloadedCopyStayAccountScoped() throws {
        let root = try evidenceDirectory("flush-reopen")
        let store = MeetingAudioStore(directory: root.appendingPathComponent("device-a"))
        let id = UUID()
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2))
        let capture = try MeetingAudioCapture(format: format, scope: scope, id: id, store: store)
        let buffer = try makeBuffer(format: format, frames: 512, amplitude: 0)
        var expected: [Float] = []
        // Reuse the microphone buffer immediately. Eight queued buffers fit the
        // bounded writer without relying on disk speed or synthetic sleeps.
        for block in 0..<8 {
            let amplitude = Float(block + 1) / 16
            fill(buffer, amplitude: amplitude)
            expected += Array(repeating: amplitude, count: Int(buffer.frameLength))
            capture.append(buffer)
            fill(buffer, amplitude: 0)
        }
        XCTAssertNil(store.url(scope: scope, id: id), "Active capture must not be eligible for playback or upload")
        // No wait before finish: it must drain every admitted buffer itself.
        XCTAssertNil(capture.finish())
        XCTAssertNil(capture.error)
        let reopened = MeetingAudioStore(directory: root.appendingPathComponent("device-a"))
        let audio = try XCTUnwrap(reopened.url(scope: scope, id: id))
        XCTAssertNil(reopened.url(scope: otherScope, id: id))
        XCTAssertFalse(reopened.hasUploaded(scope: scope, id: id))
        let decoded = try assertPCM(audio, expected: expected, sampleRate: 48_000, channels: 2)
        XCTAssertThrowsError(try MeetingAudioCapture(format: format, scope: scope, id: id, store: reopened),
                             "Starting the same UUID must not truncate its original")
        _ = try assertPCM(audio, expected: expected, sampleRate: 48_000, channels: 2)

        let otherDevice = MeetingAudioStore(directory: root.appendingPathComponent("device-b"))
        try otherDevice.install(download: audio, scope: scope, id: id)
        let installed = try XCTUnwrap(otherDevice.url(scope: scope, id: id))
        XCTAssertEqual(try Data(contentsOf: installed), try Data(contentsOf: audio))
        XCTAssertTrue(otherDevice.hasUploaded(scope: scope, id: id))
        XCTAssertFalse(otherDevice.hasUploaded(scope: otherScope, id: id))
        XCTAssertNil(otherDevice.url(scope: otherScope, id: id))
        _ = try assertPCM(installed, expected: expected, sampleRate: 48_000, channels: 2)
        try otherDevice.remove(scope: otherScope, id: id)
        XCTAssertNotNil(otherDevice.url(scope: scope, id: id))
        try otherDevice.remove(scope: scope, id: id)
        XCTAssertNil(otherDevice.url(scope: scope, id: id))
        XCTAssertFalse(otherDevice.hasUploaded(scope: scope, id: id))
        XCTAssertNotNil(reopened.url(scope: scope, id: id), "Deleting the downloaded copy must leave the original intact")
        try recordEvidence(root, values: ["journey": "capture, immediate finish, reopen, decode, install and delete",
            "expected_frames": expected.count, "observed_frames": decoded, "channels": 2,
            "sample_rate": 48_000, "audio": audio.path, "other_account_audio_hidden": reopened.url(scope: otherScope, id: id) == nil,
            "source_buffer_reuse": true])
    }

    func testRecoveryReopensOrphanedAudioButKeepsActiveAndDamagedFilesUnavailable() throws {
        let root = try evidenceDirectory("recovery")
        let storeRoot = root.appendingPathComponent("device")
        let store = MeetingAudioStore(directory: storeRoot)
        let id = UUID(), damagedID = UUID()
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1))
        let audio = try store.recordingURL(scope: scope, id: id)
        // The codec really writes and closes a CAF; the public store has not
        // received finish. This models a closed file with an orphaned capture.
        try writeOrphanedAudio(audio, buffer: makeBuffer(format: format, frames: 1024, amplitude: 0.25))
        let damaged = try store.recordingURL(scope: scope, id: damagedID)
        let damagedBytes = Data("incomplete CAF fixture".utf8)
        try damagedBytes.write(to: damaged)
        let reopened = MeetingAudioStore(directory: storeRoot)
        XCTAssertNil(reopened.url(scope: scope, id: id))
        try reopened.recover(scope: otherScope)
        XCTAssertNil(reopened.url(scope: scope, id: id))
        try reopened.recover(scope: scope, excluding: id)
        XCTAssertNil(reopened.url(scope: scope, id: id), "Recovery must not publish the active capture")
        try reopened.recover(scope: scope)
        let recovered = try XCTUnwrap(reopened.url(scope: scope, id: id))
        let frames = try assertPCM(recovered, expected: Array(repeating: 0.25, count: 1024), sampleRate: 44_100, channels: 1)
        XCTAssertNil(reopened.url(scope: otherScope, id: id))
        XCTAssertNil(reopened.url(scope: scope, id: damagedID))
        XCTAssertEqual(try Data(contentsOf: damaged), damagedBytes, "Failed recovery must retain the damaged original")
        try reopened.recover(scope: scope)
        XCTAssertEqual(reopened.url(scope: scope, id: id), recovered)
        try recordEvidence(root, values: ["journey": "reopen and recover orphaned CAF; exclude active capture; preserve damaged original",
            "expected_frames": 1024, "observed_frames": frames, "audio": recovered.path,
            "hard_process_kill_tested": false, "other_account_audio_hidden": reopened.url(scope: otherScope, id: id) == nil])
    }

    func testFormatFailureIsVisibleAndFinishesWithReadableOriginalPrefix() throws {
        let root = try evidenceDirectory("failed-capture")
        let store = MeetingAudioStore(directory: root.appendingPathComponent("device"))
        let id = UUID()
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
        let capture = try MeetingAudioCapture(format: format, scope: scope, id: id, store: store)
        capture.append(try makeBuffer(format: format, frames: 512, amplitude: 0.375))
        // A microphone channel-format change exercises the public writer's
        // failure path. Previously admitted audio must still flush and decode.
        let changedFormat = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2))
        capture.append(try makeBuffer(format: changedFormat, frames: 512, amplitude: 0.5))
        XCTAssertNotNil(capture.error)
        XCTAssertNotNil(capture.finish())
        let audio = try XCTUnwrap(store.url(scope: scope, id: id))
        let frames = try assertPCM(audio, expected: Array(repeating: 0.375, count: 512), sampleRate: 48_000, channels: 1)
        try recordEvidence(root, values: ["journey": "channel-format failure retains decodable admitted prefix",
            "expected_frames": 512, "observed_frames": frames, "audio": audio.path,
            "reported_error": capture.error ?? ""])
    }

    #if os(macOS)
    func testKilledWriterRecoversReadableCAFWithoutCallingFinish() throws {
        let root = try evidenceDirectory("process-kill")
        let id = UUID()
        let storage = root.appendingPathComponent("device")
        let ready = root.appendingPathComponent("writer-ready")
        let executable = root.appendingPathComponent("capture-writer")
        let helper = root.appendingPathComponent("main.swift")
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/InboxCore/MeetingAudioStore.swift")
        // Compile the shipped writer itself into a real subprocess. Its control
        // file signals that buffers were submitted; it never calls finish or
        // exposes a fake filesystem/audio implementation.
        try """
        import AVFoundation
        import Foundation
        let arguments = CommandLine.arguments
        let store = MeetingAudioStore(directory: URL(fileURLWithPath: arguments[1]))
        let id = UUID(uuidString: arguments[2])!
        let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
        let capture = try MeetingAudioCapture(format: format, scope: arguments[3], id: id, store: store)
        for _ in 0..<64 {
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1024)!
            buffer.frameLength = 1024
            for frame in 0..<1024 { buffer.floatChannelData![0][frame] = 0.25 }
            capture.append(buffer)
            if let error = capture.error { fatalError(error) }
            Thread.sleep(forTimeInterval: 0.025)
        }
        try Data("buffers submitted without finish".utf8).write(to: URL(fileURLWithPath: arguments[4]), options: .atomic)
        withExtendedLifetime(capture) {
            while true { Thread.sleep(forTimeInterval: 1) }
        }
        """.write(to: helper, atomically: true, encoding: .utf8)
        let compileLog = root.appendingPathComponent("compile.log")
        FileManager.default.createFile(atPath: compileLog.path, contents: nil)
        let compilationOutput = try FileHandle(forWritingTo: compileLog)
        defer { try? compilationOutput.close() }
        let compiler = Process()
        compiler.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
        compiler.arguments = ["swiftc", "-module-cache-path", root.appendingPathComponent("module-cache").path,
                              source.path, helper.path, "-o", executable.path]
        compiler.standardOutput = compilationOutput; compiler.standardError = compilationOutput
        try compiler.run(); compiler.waitUntilExit()
        XCTAssertEqual(compiler.terminationStatus, 0, "Compile log: \(compileLog.path)")
        guard compiler.terminationStatus == 0 else { return }
        let writerLog = root.appendingPathComponent("writer.log")
        FileManager.default.createFile(atPath: writerLog.path, contents: nil)
        let writerOutput = try FileHandle(forWritingTo: writerLog)
        defer { try? writerOutput.close() }
        let child = Process()
        child.executableURL = executable
        child.arguments = [storage.path, id.uuidString, scope, ready.path]
        child.standardOutput = writerOutput; child.standardError = writerOutput
        try child.run()
        defer {
            if child.isRunning { _ = Darwin.kill(child.processIdentifier, SIGKILL); child.waitUntilExit() }
        }
        let deadline = Date().addingTimeInterval(15)
        while !FileManager.default.fileExists(atPath: ready.path), child.isRunning, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.02)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: ready.path), "Writer did not reach capture checkpoint; see \(writerLog.path)")
        guard FileManager.default.fileExists(atPath: ready.path) else { return }
        let reopened = MeetingAudioStore(directory: storage)
        XCTAssertNil(reopened.url(scope: scope, id: id))
        XCTAssertEqual(Darwin.kill(child.processIdentifier, SIGKILL), 0)
        child.waitUntilExit()
        XCTAssertEqual(child.terminationReason, .uncaughtSignal)
        XCTAssertEqual(child.terminationStatus, SIGKILL)
        try reopened.recover(scope: scope)
        let recovered = try XCTUnwrap(reopened.url(scope: scope, id: id), "An unfinalized CAF must recover its written prefix after SIGKILL")
        let file = try AVAudioFile(forReading: recovered)
        XCTAssertGreaterThanOrEqual(file.length, 1024)
        XCTAssertLessThanOrEqual(file.length, 64 * 1024)
        _ = try assertPCM(recovered, expected: Array(repeating: 0.25, count: Int(file.length)), sampleRate: 48_000, channels: 1)
        XCTAssertNil(reopened.url(scope: otherScope, id: id))
        try recordEvidence(root, values: ["journey": "SIGKILL actual writer before finish; reopen CAF and decode retained prefix",
            "submitted_frames": 64 * 1024, "observed_frames": file.length,
            "audio": recovered.path, "hard_process_kill_tested": true])
    }
    #endif

    private func makeBuffer(format: AVAudioFormat, frames: AVAudioFrameCount, amplitude: Float) throws -> AVAudioPCMBuffer {
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
        buffer.frameLength = frames
        fill(buffer, amplitude: amplitude)
        return buffer
    }

    private func fill(_ buffer: AVAudioPCMBuffer, amplitude: Float) {
        guard let channels = buffer.floatChannelData else { return XCTFail("Expected float PCM fixture") }
        for channel in 0..<Int(buffer.format.channelCount) {
            for frame in 0..<Int(buffer.frameLength) {
                channels[channel][frame] = channel == 0 ? amplitude : -amplitude
            }
        }
    }

    private func writeOrphanedAudio(_ url: URL, buffer: AVAudioPCMBuffer) throws {
        let file = try AVAudioFile(forWriting: url, settings: buffer.format.settings)
        try file.write(from: buffer)
    }

    @discardableResult
    private func assertPCM(_ url: URL, expected: [Float], sampleRate: Double, channels: AVAudioChannelCount) throws -> Int {
        let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
        XCTAssertEqual(file.processingFormat.sampleRate, sampleRate)
        XCTAssertEqual(file.processingFormat.channelCount, channels)
        XCTAssertEqual(file.length, AVAudioFramePosition(expected.count))
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(expected.count + 1)))
        try file.read(into: buffer)
        XCTAssertEqual(Int(buffer.frameLength), expected.count)
        let samples = try XCTUnwrap(buffer.floatChannelData)
        var maximumError: Float = 0
        for channel in 0..<min(Int(channels), Int(buffer.format.channelCount)) {
            for frame in 0..<min(Int(buffer.frameLength), expected.count) {
                let target = channel == 0 ? expected[frame] : -expected[frame]
                maximumError = max(maximumError, abs(samples[channel][frame] - target))
            }
        }
        XCTAssertLessThanOrEqual(maximumError, 2.0 / 32768.0, "Decoded PCM must retain every channel and queued block within 16-bit quantization")
        return Int(buffer.frameLength)
    }

    private func evidenceDirectory(_ journey: String) throws -> URL {
        let base = ProcessInfo.processInfo.environment["NANOCODEX_MEETING_AUDIO_EVIDENCE_DIR"]
            .map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? FileManager.default.temporaryDirectory.appendingPathComponent("nanocodex-meeting-audio-evidence", isDirectory: true)
        let directory = base.appendingPathComponent(journey + "-" + UUID().uuidString.lowercased(), isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        print("MEETING AUDIO JOURNEY evidence retained at \(directory.path)")
        return directory
    }

    private func recordEvidence(_ root: URL, values: [String: Any]) throws {
        var report = values
        report["command"] = "NANOCODEX_MEETING_AUDIO_EVIDENCE_DIR=output/meeting-audio swift test --package-path apple/InboxCore --filter MeetingAudioCaptureJourneyTests"
        report["runtime"] = "Real AVFoundation PCM/CAF and filesystem; no microphone or Speech service"
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            .write(to: root.appendingPathComponent("evidence.json"), options: .atomic)
        print("MEETING AUDIO JOURNEY \(values["journey"] ?? "") evidence=\(root.appendingPathComponent("evidence.json").path)")
    }
}
