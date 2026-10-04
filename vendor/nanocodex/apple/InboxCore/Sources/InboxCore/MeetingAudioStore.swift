import AVFoundation
import CryptoKit
import Foundation

/// Original microphone audio lives alongside (not inside) the transcript journal.
/// CAF keeps already-written PCM recoverable if the process is terminated before
/// Stop. Account hashes and capture UUIDs are the only path components.
public final class MeetingAudioStore: @unchecked Sendable {
    public static let shared = MeetingAudioStore()
    private let root: URL?

    public init(directory: URL? = nil) {
        root = directory ?? (try? FileManager.default.url(for: .applicationSupportDirectory,
            in: .userDomainMask, appropriateFor: nil, create: true))?
            .appendingPathComponent("MeetingRecordings/Audio", isDirectory: true)
    }

    private func directory(scope: String) throws -> URL {
        guard !scope.isEmpty, let root else { throw CocoaError(.fileWriteInvalidFileName) }
        let hash = SHA256.hash(data: Data(scope.utf8)).map { String(format: "%02x", $0) }.joined()
        return root.appendingPathComponent(hash, isDirectory: true)
    }

    private func path(scope: String, id: UUID, extension suffix: String) throws -> URL {
        try directory(scope: scope).appendingPathComponent(id.uuidString.lowercased()).appendingPathExtension(suffix)
    }

    private func protect(_ url: URL) throws {
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: url.path)
        #endif
        var resource = url
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try resource.setResourceValues(values)
    }

    public func exists(scope: String, id: UUID) -> Bool {
        guard let url = try? path(scope: scope, id: id, extension: "caf") else { return false }
        return FileManager.default.fileExists(atPath: url.path)
    }

    public func recordingURL(scope: String, id: UUID) throws -> URL {
        let directory = try directory(scope: scope)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try protect(directory)
        let url = try path(scope: scope, id: id, extension: "caf")
        guard !FileManager.default.fileExists(atPath: url.path) else { throw CocoaError(.fileWriteFileExists) }
        try Data().write(to: path(scope: scope, id: id, extension: "capturing"), options: .atomic)
        return url
    }

    public func finish(scope: String, id: UUID) throws {
        let url = try path(scope: scope, id: id, extension: "caf")
        try protect(url)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.synchronize()
        let marker = try path(scope: scope, id: id, extension: "capturing")
        if FileManager.default.fileExists(atPath: marker.path) { try FileManager.default.removeItem(at: marker) }
    }

    /// Only closed or explicitly recovered audio is eligible for playback/upload.
    public func url(scope: String, id: UUID) -> URL? {
        guard let url = try? path(scope: scope, id: id, extension: "caf"),
              let marker = try? path(scope: scope, id: id, extension: "capturing"),
              FileManager.default.fileExists(atPath: url.path),
              !FileManager.default.fileExists(atPath: marker.path) else { return nil }
        return url
    }

    public func recover(scope: String, excluding activeID: UUID? = nil) throws {
        let directory = try directory(scope: scope)
        guard FileManager.default.fileExists(atPath: directory.path) else { return }
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        for staged in files where staged.pathExtension == "download" { try FileManager.default.removeItem(at: staged) }
        for marker in files where marker.pathExtension == "capturing" {
            guard let id = UUID(uuidString: marker.deletingPathExtension().lastPathComponent), id != activeID else { continue }
            let url = try path(scope: scope, id: id, extension: "caf")
            // Do not delete a damaged original. A subsequent recovery may still
            // succeed; absent/invalid audio never masquerades as a saved recording.
            guard let file = try? AVAudioFile(forReading: url), file.length > 0 else { continue }
            try finish(scope: scope, id: id)
        }
    }

    public func install(download: URL, scope: String, id: UUID) throws {
        let directory = try directory(scope: scope)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try protect(directory)
        let target = try path(scope: scope, id: id, extension: "caf")
        guard !FileManager.default.fileExists(atPath: target.path) else { return }
        // Never expose a half-copied download as the canonical original. A crash
        // leaves only disposable staging bytes; rename publishes the closed CAF.
        let staged = directory.appendingPathComponent(id.uuidString.lowercased() + "." + UUID().uuidString + ".download")
        defer { try? FileManager.default.removeItem(at: staged) }
        try FileManager.default.copyItem(at: download, to: staged)
        let file = try AVAudioFile(forReading: staged)
        guard file.length > 0 else { throw CocoaError(.fileReadCorruptFile) }
        try protect(staged)
        let handle = try FileHandle(forWritingTo: staged)
        try handle.synchronize(); try handle.close()
        try FileManager.default.moveItem(at: staged, to: target)
        try markUploaded(scope: scope, id: id)
    }

    public func hasUploaded(scope: String, id: UUID) -> Bool {
        guard let marker = try? path(scope: scope, id: id, extension: "uploaded") else { return false }
        return FileManager.default.fileExists(atPath: marker.path)
    }

    public func markUploaded(scope: String, id: UUID) throws {
        try Data().write(to: path(scope: scope, id: id, extension: "uploaded"), options: .atomic)
    }

    public func remove(scope: String, id: UUID) throws {
        let directory = try directory(scope: scope)
        if FileManager.default.fileExists(atPath: directory.path) {
            for staged in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
                where staged.pathExtension == "download" && staged.lastPathComponent.hasPrefix(id.uuidString.lowercased() + ".") {
                try FileManager.default.removeItem(at: staged)
            }
        }
        for suffix in ["caf", "capturing", "uploaded"] {
            let url = try path(scope: scope, id: id, extension: suffix)
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
        }
    }
}

/// A bounded pool keeps filesystem/encoding work off the microphone callback.
/// Exhausting it is a visible recording failure, never an unbounded audio queue
/// or silent gap. The writer retains the original sample rate and channel count.
public final class MeetingAudioCapture: @unchecked Sendable {
    private let queue = DispatchQueue(label: "xyz.paradigm.nanocodex.meeting-audio", qos: .userInitiated)
    private let lock = NSLock()
    private let pending = DispatchGroup()
    private var pool: [AVAudioPCMBuffer] = []
    private var accepting = true
    private var failure: String?
    private var file: AVAudioFile?
    private let store: MeetingAudioStore
    private let scope: String
    private let id: UUID
    public var error: String? { lock.withLock { failure } }

    public init(format: AVAudioFormat, scope: String, id: UUID, store: MeetingAudioStore = .shared) throws {
        self.store = store; self.scope = scope; self.id = id
        for _ in 0..<16 {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8192) else { throw CocoaError(.fileWriteUnknown) }
            pool.append(buffer)
        }
        let url = try store.recordingURL(scope: scope, id: id)
        file = try AVAudioFile(forWriting: url, settings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: format.channelCount, AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false
        ], commonFormat: format.commonFormat, interleaved: format.isInterleaved)
    }

    private func fail(_ message: String) {
        lock.withLock { if failure == nil { failure = message }; accepting = false }
    }

    public func append(_ source: AVAudioPCMBuffer) {
        let buffer: AVAudioPCMBuffer? = lock.withLock {
            guard accepting else { return nil }
            guard let buffer = pool.popLast() else {
                failure = "Audio storage is falling behind. Recording stopped; saved audio is retained."
                accepting = false; return nil
            }
            pending.enter()
            return buffer
        }
        guard let buffer else { return }
        var submitted = false
        defer { if !submitted { pending.leave() } }
        guard source.frameLength <= buffer.frameCapacity else {
            fail("Microphone format changed. Recording stopped; saved audio is retained."); return
        }
        buffer.frameLength = source.frameLength
        let inputs = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: source.audioBufferList))
        let outputs = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        guard inputs.count == outputs.count else {
            fail("Microphone format changed. Recording stopped; saved audio is retained."); return
        }
        for index in inputs.indices {
            guard let src = inputs[index].mData, let dst = outputs[index].mData,
                  inputs[index].mDataByteSize <= outputs[index].mDataByteSize else {
                fail("Microphone buffer could not be saved. Recording stopped; saved audio is retained."); return
            }
            memcpy(dst, src, Int(inputs[index].mDataByteSize))
        }
        submitted = true
        queue.async { [self, buffer] in
            defer { pending.leave() }
            do { try file?.write(from: buffer) }
            catch { fail("Audio could not be saved: " + error.localizedDescription) }
            lock.withLock { pool.append(buffer) }
        }
    }

    /// Call after detaching the microphone tap. Drains at most the bounded pool.
    @discardableResult public func finish() -> String? {
        lock.withLock { accepting = false }
        pending.wait()
        queue.sync { file = nil }
        do { try store.finish(scope: scope, id: id) }
        catch { fail("Audio could not be finalized: " + error.localizedDescription) }
        return self.error
    }
}
