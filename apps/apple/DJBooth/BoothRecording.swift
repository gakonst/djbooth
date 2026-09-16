#if os(iOS)
import AVFoundation
import CoreMIDI
import DJBoothKit
import SwiftUI

private struct RecordingFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Audio and CoreMIDI transport only. Rust owns decoding and the replay timeline.
private enum RecordingBridge {
    static func event(_ kind: String, _ payload: [String: Any]) throws {
        _ = try DJLinkBindings.request("recording.event", arguments: JSONSerialization.data(withJSONObject: ["kind": kind, "payload": payload]))
    }
}

struct RecordingProgress: Decodable, Sendable {
    let recording: Bool
    let directory: String?
    let elapsedSeconds: Double?
    let rows, gaps: UInt64?
    let deckEvents, mixerEvents, midiPackets, audioFrames: UInt64?
    let error: String?
}

/// The serial queue owns the file. The lock bounds queued audio and prevents
/// callbacks arriving during teardown from appending beyond the finalized tail.
final class BoothAudioWriter: @unchecked Sendable {
    private let queue = DispatchQueue(label: "DJBooth.recording.audio", qos: .userInitiated)
    private let lock = NSLock()
    private var accepting = true
    private var pending = 0
    private var dropped: UInt64 = 0
    private var file: AVAudioFile?
    private var frames: Int64 = 0
    private var failure: String?
    private var lastBufferAt = ProcessInfo.processInfo.systemUptime
    init(url: URL, format: AVAudioFormat) throws {
        file = try AVAudioFile(forWriting: url, settings: format.settings, commonFormat: format.commonFormat, interleaved: format.isInterleaved)
    }
    private struct Chunk: @unchecked Sendable { let buffer: AVAudioPCMBuffer; let hostTime: UInt64; let sampleTime: Int64? }
    func append(_ buffer: AVAudioPCMBuffer, at time: AVAudioTime) {
        lock.lock()
        guard accepting else { lock.unlock(); return }
        guard pending < 64, let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else {
            dropped += UInt64(buffer.frameLength); lock.unlock(); return
        }
        copy.frameLength = buffer.frameLength
        let src = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: buffer.audioBufferList))
        let dst = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for (source, destination) in zip(src, dst) {
            let count = Int(source.mDataByteSize)
            if let source = source.mData, let destination = destination.mData {
                memcpy(destination, source, count)
            }
        }
        let chunk = Chunk(buffer: copy, hostTime: time.isHostTimeValid ? time.hostTime : 0,
                          sampleTime: time.isSampleTimeValid ? time.sampleTime : nil)
        pending += 1
        queue.async { [self] in
            defer { lock.withLock { pending -= 1 } }
            guard failure == nil else { return }
            do {
                lastBufferAt = ProcessInfo.processInfo.systemUptime
                try file?.write(from: chunk.buffer)
                let offset = frames
                frames += Int64(chunk.buffer.frameLength)
                try RecordingBridge.event("audioBuffer", ["frameOffset": offset, "frames": chunk.buffer.frameLength,
                    "sampleRate": chunk.buffer.format.sampleRate, "channels": chunk.buffer.format.channelCount,
                    "hostTimeNs": chunk.hostTime == 0 ? NSNull() : String(UInt64(AVAudioTime.seconds(forHostTime: chunk.hostTime) * 1_000_000_000)) as Any,
                    "sampleTime": chunk.sampleTime.map { $0 as Any } ?? NSNull()])
            } catch { failure = error.localizedDescription }
        }
        lock.unlock()
    }
    func health() async -> String? {
        await withCheckedContinuation { continuation in
            queue.async { [self] in
                let stalled = ProcessInfo.processInfo.systemUptime - lastBufferAt > 5
                let lost = lock.withLock { dropped }
                continuation.resume(returning: failure ?? (lost > 0 ? "Audio writer dropped \(lost) frames." : stalled ? "The USB mixer stopped sending audio." : nil))
            }
        }
    }
    func finish() async -> String? {
        lock.withLock { accepting = false }
        return await withCheckedContinuation { continuation in
            queue.async { [self] in
                file = nil // Close/finalize CAF before marking the recording complete.
                let lost = lock.withLock { dropped }
                let error = failure ?? (lost > 0 ? "Audio writer dropped \(lost) frames." : nil)
                do {
                    try RecordingBridge.event("audioStopped", ["frames": frames, "droppedFrames": lost,
                        "error": error.map { $0 as Any } ?? NSNull()])
                    continuation.resume(returning: error)
                } catch { continuation.resume(returning: error.localizedDescription) }
            }
        }
    }
}

/// CoreMIDI packet framing is supplied by Apple; the A9 byte decoder is Rust's.
private final class RecordingMIDIQueue: @unchecked Sendable {
    private let queue = DispatchQueue(label: "DJBooth.recording.midi")
    private let lock = NSLock()
    private var accepting = true
    func enqueue(_ operation: @escaping @Sendable () -> Void) {
        lock.withLock { if accepting { queue.async(execute: operation) } }
    }
    func finish() async {
        lock.withLock { accepting = false }
        await withCheckedContinuation { continuation in queue.async { continuation.resume() } }
    }
}

@MainActor final class BoothMIDIInput {
    private var client: MIDIClientRef = 0
    private var ports: [MIDIEndpointRef: MIDIPortRef] = [:]
    private let queue = RecordingMIDIQueue()
    private var failure: String?
    func start() throws {
        let result = MIDIClientCreateWithBlock("DJ Booth recording" as CFString, &client) { [weak self] _ in
            Task { @MainActor [weak self] in self?.refresh() }
        }
        guard result == noErr else { throw RecordingFailure(message: "CoreMIDI could not start (\(result)).") }
        refresh()
    }
    private func refresh() {
        guard client != 0 else { return }
        let sources = Set((0..<MIDIGetNumberOfSources()).map { MIDIGetSource($0) })
        for source in Array(ports.keys) where !sources.contains(source) {
            if let port = ports.removeValue(forKey: source) { MIDIPortDispose(port) }
        }
        for source in sources where ports[source] == nil {
            var value: Unmanaged<CFString>?
            MIDIObjectGetStringProperty(source, kMIDIPropertyDisplayName, &value)
            let name = value?.takeRetainedValue() as String? ?? "MIDI"
            guard name.localizedCaseInsensitiveContains("DJM-A9") else { continue }
            var uniqueID: Int32 = 0
            MIDIObjectGetIntegerProperty(source, kMIDIPropertyUniqueID, &uniqueID)
            let identity = "\(name) [\(uniqueID)]"
            var port: MIDIPortRef = 0
            let queue = self.queue
            let result = MIDIInputPortCreateWithBlock(client, name as CFString, &port) { list, _ in
                do {
                    var packet = UnsafeRawPointer(list).advanced(by: MemoryLayout<MIDIPacketList>.offset(of: \.packet)!).assumingMemoryBound(to: MIDIPacket.self)
                    for _ in 0..<list.pointee.numPackets {
                        let data = UnsafeRawPointer(packet).advanced(by: MemoryLayout<MIDIPacket>.offset(of: \.data)!).assumingMemoryBound(to: UInt8.self)
                        let bytes = Array(UnsafeBufferPointer(start: data, count: Int(packet.pointee.length)))
                        let hostTime = packet.pointee.timeStamp
                        queue.enqueue {
                            do {
                                let timestamp = hostTime == 0 ? UInt64(ProcessInfo.processInfo.systemUptime * 1_000_000) : UInt64(AVAudioTime.seconds(forHostTime: hostTime) * 1_000_000)
                                _ = try DJLinkBindings.request("recording.midi", arguments: JSONSerialization.data(withJSONObject:
                                    ["source": identity, "timestampUs": timestamp, "bytes": bytes]))
                            } catch { AppDiagnostics.shared.event("recording_midi_failed", ["error": error.localizedDescription]) }
                        }
                        packet = UnsafePointer(MIDIPacketNext(packet))
                    }
                }
            }
            guard result == noErr else { failure = "MIDI input could not open (\(result))."; continue }
            let connected = MIDIPortConnectSource(port, source, nil)
            if connected == noErr { ports[source] = port }
            else { MIDIPortDispose(port); failure = "MIDI source could not connect (\(connected))." }
        }
        let count = ports.count
        let error = failure
        queue.enqueue {
            try? RecordingBridge.event("midiSources", ["connected": count, "error": error.map { $0 as Any } ?? NSNull()])
        }
    }
    func stop() async {
        for port in ports.values { MIDIPortDispose(port) }
        ports = [:]
        if client != 0 { MIDIClientDispose(client); client = 0 }
        await queue.finish()
    }
}

@Observable @MainActor final class BoothRecordingController {
    var isRecording = false
    var busy = false
    var progress: RecordingProgress?
    var error: String?
    var sourceName: String?
    var recordings: [URL] = []
    private var midi: BoothMIDIInput?
    private var monitor: Task<Void, Never>?
    private weak var link: DJLinkConnection?
    private var observers: [NSObjectProtocol] = []
    private var inputUID: String?
    var root: URL { FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Recordings", isDirectory: true) }
    func refreshRecordings() {
        recordings = ((try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [])
            .filter { FileManager.default.fileExists(atPath: $0.appendingPathComponent("events.jsonl").path) }
            .sorted { $0.lastPathComponent > $1.lastPathComponent }
    }
    func start(model: BoothModel) async {
        guard !busy, !isRecording else { return }
        busy = true; error = nil; link = model.djLink
        defer { busy = false }
        var timelineStarted = false
        do {
            guard model.djLink.status.running else { throw RecordingFailure(message: "Connect your CDJs before recording.") }
            let allowed = await AVAudioApplication.requestRecordPermission()
            guard allowed else { throw RecordingFailure(message: "Allow audio recording in Settings to capture the mixer.") }
            model.player.pause()
            let folder = root.appendingPathComponent(ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-") + "-" + UUID().uuidString.prefix(8), isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: folder.path)
            let input = try await PlaybackAudioSession.shared.prepareRecording()
            inputUID = input.uid
            sourceName = input.name
            let tracks: [[String: Any]] = model.tracks.map { track in
                ["id": track.id, "title": track.title, "artist": track.artist ?? "", "mediaHash": track.mediaHash ?? "",
                 "durationSeconds": track.durationSeconds ?? 0, "key": track.key ?? "", "bpm": track.bpm ?? 0]
            }
            let served = try JSONSerialization.jsonObject(with: await model.djLink.recordingLibrary())
            let arguments = try JSONSerialization.data(withJSONObject: ["directory": folder.path, "tracks": ["library": tracks, "served": served]])
            progress = try await Task.detached { try JSONDecoder().decode(RecordingProgress.self, from: DJLinkBindings.request("recording.start", arguments: arguments)) }.value
            timelineStarted = true
            try await PlaybackAudioSession.shared.startRecording(at: folder)
            let midi = BoothMIDIInput(); self.midi = midi
            do { try midi.start() } catch {
                try await Task.detached { try RecordingBridge.event("midiUnavailable", ["error": error.localizedDescription]) }.value
            }
            isRecording = true
            link?.recordingChanged(true)
            observeAudio()
            monitor = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(1))
                    guard !Task.isCancelled, let self else { return }
                    do {
                        if let failure = await PlaybackAudioSession.shared.recordingHealth() {
                            await self.stop(reason: failure); return
                        }
                        let status = try await Task.detached { try DJLinkBindings.decode("recording.status", as: RecordingProgress.self) }.value
                        self.progress = status
                        if !status.recording || status.error != nil { await self.stop(reason: status.error ?? "The deck timeline stopped."); return }
                    } catch { await self.stop(reason: error.localizedDescription); return }
                }
            }
        } catch {
            self.error = error.localizedDescription
            await midi?.stop(); midi = nil
            _ = await PlaybackAudioSession.shared.stopRecording()
            if timelineStarted { _ = try? await Task.detached { try DJLinkBindings.request("recording.stop") }.value }
            inputUID = nil
        }
        refreshRecordings()
    }
    func stop(reason: String? = nil) async {
        guard isRecording, !busy else { return }
        busy = true; monitor?.cancel(); monitor = nil
        for observer in observers { NotificationCenter.default.removeObserver(observer) }; observers = []
        await midi?.stop(); midi = nil
        let audioError = await PlaybackAudioSession.shared.stopRecording()
        do {
            if let reason { try await Task.detached { try RecordingBridge.event("interrupted", ["reason": reason]) }.value }
            progress = try await Task.detached { try DJLinkBindings.decode("recording.stop", as: RecordingProgress.self) }.value
        } catch { self.error = error.localizedDescription }
        error = reason ?? audioError ?? error
        isRecording = false; busy = false; inputUID = nil
        link?.recordingChanged(false)
        refreshRecordings()
    }
    private func observeAudio() {
        for name in [AVAudioSession.interruptionNotification, AVAudioSession.routeChangeNotification, AVAudioSession.mediaServicesWereResetNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                let interrupted = notification.name != AVAudioSession.routeChangeNotification
                Task { @MainActor [weak self] in
                    guard let self, self.isRecording else { return }
                    let inputs = AVAudioSession.sharedInstance().currentRoute.inputs
                    if interrupted || !inputs.contains(where: { $0.uid == self.inputUID && $0.portType == .usbAudio }) {
                        await self.stop(reason: interrupted ? "Audio recording was interrupted." : "The USB mixer disconnected. Recording saved.")
                    }
                }
            })
        }
    }
}

struct BoothRecordingView: View {
    @Bindable var model: BoothModel
    private var recorder: BoothRecordingController { model.djLink.recording }
    var body: some View {
        List {
            Section("Record your set") {
                Text("Connect the mixer's USB audio output. Records the channels supplied by the mixer alongside all detected decks and available A9 controls.")
                Button(recorder.isRecording ? "Stop recording" : "Record audio + timeline", systemImage: recorder.isRecording ? "stop.circle.fill" : "record.circle") {
                    Task { if recorder.isRecording { await recorder.stop() } else { await recorder.start(model: model) } }
                }.disabled(recorder.busy || (!recorder.isRecording && !model.djLink.status.running))
                    .accessibilityIdentifier("recording.toggle")
                if let progress = recorder.progress {
                    Text("\(Int(progress.elapsedSeconds ?? 0)) seconds · \(progress.rows ?? 0) events · \(progress.gaps ?? 0) gaps")
                        .font(.caption.monospacedDigit())
                    Text("Deck events: \(progress.deckEvents ?? 0) · Mixer: \(progress.mixerEvents ?? 0) · MIDI: \(progress.midiPackets ?? 0)")
                        .font(.caption.monospacedDigit())
                }
                if let source = recorder.sourceName { Text("Audio input: \(source)").font(.caption) }
                if let error = recorder.error { Text(error).foregroundStyle(.red) }
            }
            Section("Saved recordings") {
                ForEach(recorder.recordings, id: \.self) { directory in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(directory.lastPathComponent).font(.caption)
                        if !(recorder.isRecording && recorder.progress?.directory == directory.path) {
                            ShareLink(items: ["master.caf", "events.jsonl"].map { directory.appendingPathComponent($0) }.filter { FileManager.default.fileExists(atPath: $0.path) }) {
                                Label("Export audio and timeline", systemImage: "square.and.arrow.up")
                            }
                        }
                    }
                }
                if recorder.recordings.isEmpty { Text("Your sets will appear here.").foregroundStyle(.secondary) }
            }
        }.navigationTitle("Recordings").onAppear { recorder.refreshRecordings() }
    }
}
#endif
