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

actor BoothMIDIInput {
    private var client: MIDIClientRef = 0
    private var ports: [MIDIEndpointRef: MIDIPortRef] = [:]
    private var identities: [MIDIEndpointRef: String] = [:]
    private let queue = RecordingMIDIQueue()
    private var failure: String?
    private let operation: String
    init(live: Bool = false) { operation = live ? "midi.packet" : "recording.midi" }
    private func connection(_ identity: String, connected: Bool) {
        guard operation == "midi.packet" else { return }
        queue.enqueue {
            do {
                _ = try DJLinkBindings.request(connected ? "midi.connect" : "midi.disconnect",
                    arguments: JSONSerialization.data(withJSONObject: ["source": identity]))
            } catch { AppDiagnostics.shared.event("midi_connection_failed", ["source": identity, "error": error.localizedDescription]) }
        }
    }
    func start() throws {
        guard client == 0 else { return }
        AppDiagnostics.shared.event("midi_client_starting", ["operation": operation])
        let result = MIDIClientCreateWithBlock("DJ Booth MIDI" as CFString, &client) { [weak self] _ in
            Task { [weak self] in await self?.refresh() }
        }
        AppDiagnostics.shared.event("midi_client_started", ["operation": operation, "status": String(result)])
        guard result == noErr else { throw RecordingFailure(message: "CoreMIDI could not start (\(result)).") }
        refresh()
    }
    private func refresh() {
        guard client != 0 else { return }
        let sources = Set((0..<MIDIGetNumberOfSources()).map { MIDIGetSource($0) }.filter { source in
            var offline: Int32 = 0
            MIDIObjectGetIntegerProperty(source, kMIDIPropertyOffline, &offline)
            return offline == 0
        })
        for source in Array(ports.keys) where !sources.contains(source) {
            if let port = ports.removeValue(forKey: source) { MIDIPortDispose(port) }
            if let identity = identities.removeValue(forKey: source) { connection(identity, connected: false) }
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
            let operation = self.operation
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
                                _ = try DJLinkBindings.request(operation, arguments: JSONSerialization.data(withJSONObject:
                                    ["source": identity, "timestampUs": timestamp, "bytes": bytes]))
                            } catch { AppDiagnostics.shared.event("midi_packet_failed", ["operation": operation, "error": error.localizedDescription]) }
                        }
                        packet = UnsafePointer(MIDIPacketNext(packet))
                    }
                }
            }
            guard result == noErr else { failure = "MIDI input could not open (\(result))."; continue }
            // Register before connecting: CoreMIDI may deliver the first packet
            // synchronously. The serial queue preserves this ordering in Rust.
            connection(identity, connected: true)
            let connected = MIDIPortConnectSource(port, source, nil)
            if connected == noErr { ports[source] = port; identities[source] = identity }
            else {
                MIDIPortDispose(port); connection(identity, connected: false)
                failure = "MIDI source could not connect (\(connected))."
            }
        }
        let count = ports.count
        let error = failure
        let operation = self.operation
        queue.enqueue {
            AppDiagnostics.shared.event("midi_sources", ["operation": operation, "connected": String(count), "error": error ?? ""])
            if operation == "recording.midi" {
                try? RecordingBridge.event("midiSources", ["connected": count, "error": error.map { $0 as Any } ?? NSNull()])
            }
        }
    }
    func stop() async {
        for port in ports.values { MIDIPortDispose(port) }
        ports = [:]
        for identity in identities.values { connection(identity, connected: false) }
        identities = [:]
        if client != 0 { MIDIClientDispose(client); client = 0 }
        await queue.finish()
    }
}

@Observable @MainActor final class BoothRecordingController {
    var isRecording = false
    private(set) var capturingAudio = false
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
    func start(model: BoothModel, includeAudio: Bool = false) async {
        guard !busy, !isRecording else { return }
        busy = true; error = nil; sourceName = nil; link = model.djLink
        defer { busy = false }
        var timelineStarted = false
        do {
            guard model.djLink.status.running else { throw RecordingFailure(message: "Connect your CDJs before recording.") }
            if includeAudio {
                let allowed = await AVAudioApplication.requestRecordPermission()
                guard allowed else { throw RecordingFailure(message: "Allow audio recording in Settings to capture the mixer.") }
                model.player.pause()
            }
            let folder = root.appendingPathComponent(ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-") + "-" + UUID().uuidString.prefix(8), isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: folder.path)
            if includeAudio {
                let input = try await PlaybackAudioSession.shared.prepareRecording()
                inputUID = input.uid
                sourceName = input.name
            }
            let tracks: [[String: Any]] = model.tracks.map { track in
                ["id": track.id, "title": track.title, "artist": track.artist ?? "", "mediaHash": track.mediaHash ?? "",
                 "durationSeconds": track.durationSeconds ?? 0, "key": track.key ?? "", "bpm": track.bpm ?? 0]
            }
            let served = try JSONSerialization.jsonObject(with: await model.djLink.recordingLibrary())
            let arguments = try JSONSerialization.data(withJSONObject: ["directory": folder.path, "audio": includeAudio, "tracks": ["library": tracks, "served": served]])
            progress = try await Task.detached { try JSONDecoder().decode(RecordingProgress.self, from: DJLinkBindings.request("recording.start", arguments: arguments)) }.value
            timelineStarted = true
            if includeAudio { try await PlaybackAudioSession.shared.startRecording(at: folder) }
            let midi = BoothMIDIInput(); self.midi = midi
            do { try await midi.start() } catch {
                try await Task.detached { try RecordingBridge.event("midiUnavailable", ["error": error.localizedDescription]) }.value
            }
            isRecording = true; capturingAudio = includeAudio
            link?.recordingChanged(true)
            if includeAudio { observeAudio() }
            AppDiagnostics.shared.event("booth_recording_started", ["audio": String(includeAudio), "directory": folder.path])
            monitor = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(1))
                    guard !Task.isCancelled, let self else { return }
                    do {
                        if self.capturingAudio, let failure = await PlaybackAudioSession.shared.recordingHealth() {
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
            if includeAudio { _ = await PlaybackAudioSession.shared.stopRecording() }
            if timelineStarted { _ = try? await Task.detached { try DJLinkBindings.request("recording.stop") }.value }
            inputUID = nil; capturingAudio = false
            AppDiagnostics.shared.event("booth_recording_failed", ["audio": String(includeAudio), "error": error.localizedDescription])
        }
        refreshRecordings()
    }
    func stop(reason: String? = nil) async {
        guard isRecording, !busy else { return }
        busy = true; monitor?.cancel(); monitor = nil
        for observer in observers { NotificationCenter.default.removeObserver(observer) }; observers = []
        await midi?.stop(); midi = nil
        let audioError = capturingAudio ? await PlaybackAudioSession.shared.stopRecording() : nil
        do {
            if let reason { try await Task.detached { try RecordingBridge.event("interrupted", ["reason": reason]) }.value }
            progress = try await Task.detached { try DJLinkBindings.decode("recording.stop", as: RecordingProgress.self) }.value
        } catch { self.error = error.localizedDescription }
        error = reason ?? audioError ?? error
        isRecording = false; capturingAudio = false; busy = false; inputUID = nil
        AppDiagnostics.shared.event("booth_recording_stopped", ["reason": reason ?? "user", "error": error ?? ""])
        link?.recordingChanged(false)
        if let directory = progress?.directory {
            do {
                _ = try await Task.detached {
                    try DJLinkBindings.request("recording.prepare", arguments: JSONSerialization.data(withJSONObject: ["directory": directory]))
                }.value
            } catch { AppDiagnostics.shared.event("recording_tracklist_failed", ["error": error.localizedDescription]) }
        }
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

/// Apple file/codec adapter; track identity and timing come exclusively from Rust.
private enum RecordedSetExport {
    static func prepare(_ directory: URL) throws -> URL? {
        _ = try DJLinkBindings.request("recording.prepare", arguments: JSONSerialization.data(withJSONObject: ["directory": directory.path]))
        let source = directory.appendingPathComponent("master.caf")
        guard FileManager.default.fileExists(atPath: source.path) else { return nil }
        let destination = directory.appendingPathComponent("master.wav")
        if FileManager.default.fileExists(atPath: destination.path) { return destination }
        let input = try AVAudioFile(forReading: source)
        guard input.length > 0 else { throw RecordingFailure(message: "The recording contains no mixer audio.") }
        guard input.processingFormat.channelCount == 2 else {
            throw RecordingFailure(message: "This recording contains multiple USB channels. Publishing needs a verified stereo mix pair; the raw channels are preserved.")
        }
        guard input.length < 650_000_000 else { throw RecordingFailure(message: "This recording exceeds the WAV export size limit.") }
        let temporary = directory.appendingPathComponent("exporting.wav")
        defer { try? FileManager.default.removeItem(at: temporary) }
        do {
            let output = try AVAudioFile(forWriting: temporary, settings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: input.processingFormat.sampleRate,
                AVNumberOfChannelsKey: 2, AVLinearPCMBitDepthKey: 24,
                AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false
            ], commonFormat: input.processingFormat.commonFormat, interleaved: input.processingFormat.isInterleaved)
            guard let buffer = AVAudioPCMBuffer(pcmFormat: input.processingFormat, frameCapacity: 32768) else {
                throw RecordingFailure(message: "Could not allocate the audio export buffer.")
            }
            while input.framePosition < input.length {
                try input.read(into: buffer)
                guard buffer.frameLength > 0 else { throw RecordingFailure(message: "The audio recording ended unexpectedly.") }
                try output.write(from: buffer)
            }
        } // Finalize the WAV header before making it available to the uploader.
        try FileManager.default.moveItem(at: temporary, to: destination)
        return destination
    }
}

private struct RecordedSetRow: View {
    let directory: URL
    let model: BoothModel
    @State private var preparing = false
    @State private var prepared = false
    @State private var failure: String?
    @State private var uploaded: URL?
    @State private var uploadPhase: String?
    private var files: [URL] {
        [FileManager.default.fileExists(atPath: directory.appendingPathComponent("master.wav").path) ? "master.wav" : "master.caf", "tracklist.txt", "tracklist.json", "events.jsonl"]
            .map { directory.appendingPathComponent($0) }.filter { FileManager.default.fileExists(atPath: $0.path) }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(directory.lastPathComponent).font(.caption)
            Button(preparing ? "Preparing set…" : "Prepare audio + full tracklist") {
                preparing = true; failure = nil
                Task {
                    do { _ = try await Task.detached { try RecordedSetExport.prepare(directory) }.value; prepared = true }
                    catch { failure = error.localizedDescription }
                    preparing = false
                }
            }.disabled(preparing)
            if FileManager.default.fileExists(atPath: directory.appendingPathComponent("master.caf").path) {
                Menu("Upload privately to SoundCloud") {
                    ForEach(model.musicCatalog.sources.filter { $0.provider == "soundcloud" }) { source in
                        Button(source.label) { publish(source) }
                    }
                    if !model.musicCatalog.sources.contains(where: { $0.provider == "soundcloud" }) {
                        Text("Connect SoundCloud in Settings first")
                    }
                }.disabled(preparing)
            }
            if let uploadPhase { ProgressView(uploadPhase).font(.caption) }
            if let uploaded { Link("Open recording on SoundCloud", destination: uploaded) }
            if prepared { Text("Tracklist includes playback from every deck; headphone previews may also appear.").font(.caption).foregroundStyle(.secondary) }
            ShareLink(items: files) { Label("Export set", systemImage: "square.and.arrow.up") }
            if let failure { Text(failure).font(.caption).foregroundStyle(.red) }
        }
    }
    private func publish(_ source: MusicSource) {
        preparing = true; failure = nil
        Task {
            defer { preparing = false; uploadPhase = nil }
            do {
                uploadPhase = "Checking SoundCloud connection…"
                let capability = try await model.recordingUploadAvailability(source)
                guard capability.available else { throw RecordingFailure(message: capability.reason ?? "SoundCloud recording uploads are unavailable.") }
                uploadPhase = "Preparing audio and tracklist…"
                guard let audio = try await Task.detached(operation: { try RecordedSetExport.prepare(directory) }).value else {
                    throw RecordingFailure(message: "This recording has a deck timeline only. Connect USB mixer audio to record a mix for SoundCloud.")
                }
                let description = try String(contentsOf: directory.appendingPathComponent("tracklist.txt"), encoding: .utf8)
                prepared = true
                let result = try await model.uploadRecording(file: audio, source: source,
                    title: "DJ set " + directory.lastPathComponent, description: description) { phase in
                        Task { @MainActor in uploadPhase = phase }
                    }
                uploaded = result.url
            } catch { failure = error.localizedDescription }
        }
    }
}

struct BoothRecordingView: View {
    @Bindable var model: BoothModel
    @State private var includeAudio = false
    private var recorder: BoothRecordingController { model.djLink.recording }
    var body: some View {
        List {
            Section("Record your set") {
                Toggle("Include USB mixer audio", isOn: $includeAudio)
                    .disabled(recorder.isRecording || recorder.busy).accessibilityIdentifier("recording.audio")
                Text(includeAudio ? "Records USB mixer audio alongside the timestamped deck and mixer timeline." : "Records track changes, positions, tempo, key and available mixer controls from every detected deck. Keep DJBooth open while recording the timeline.")
                Button(recorder.isRecording ? "Stop recording" : (includeAudio ? "Record audio + timeline" : "Record deck timeline"), systemImage: recorder.isRecording ? "stop.circle.fill" : "record.circle") {
                    Task { if recorder.isRecording { await recorder.stop() } else { await recorder.start(model: model, includeAudio: includeAudio) } }
                }.disabled(recorder.busy || (!recorder.isRecording && !model.djLink.status.running))
                    .accessibilityIdentifier("recording.toggle")
                if let progress = recorder.progress {
                    Text("\(timeLabel(progress.elapsedSeconds ?? 0)) · \(progress.rows ?? 0) events · \(progress.gaps ?? 0) gaps")
                        .font(.caption.monospacedDigit())
                        .accessibilityIdentifier("recording.elapsed")
                    Text("Deck events: \(progress.deckEvents ?? 0) · Mixer: \(progress.mixerEvents ?? 0) · MIDI: \(progress.midiPackets ?? 0)")
                        .font(.caption.monospacedDigit())
                }
                if let source = recorder.sourceName { Text("Audio input: \(source)").font(.caption) }
                if let error = recorder.error { Text(error).foregroundStyle(.red) }
            }
            Section("Saved recordings") {
                ForEach(recorder.recordings, id: \.self) { directory in
                    if !(recorder.isRecording && recorder.progress?.directory == directory.path) {
                        RecordedSetRow(directory: directory, model: model)
                    }
                }
                if recorder.recordings.isEmpty { Text("Your sets will appear here.").foregroundStyle(.secondary) }
            }
        }.navigationTitle("Recordings").onAppear { recorder.refreshRecordings() }
    }
}
#endif
