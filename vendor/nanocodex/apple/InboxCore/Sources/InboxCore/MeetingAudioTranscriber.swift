import AVFoundation
import Foundation
import Speech

/// Rebuild a transcript from its retained recording. Work is bounded to 25-second
/// requests to stay below Speech's per-request duration limit. The caller replaces
/// a saved transcript only after the entire recording succeeds.
@MainActor
public final class MeetingAudioTranscriber {
    public enum Failure: LocalizedError {
        case permission, unavailable, timedOut, empty
        public var errorDescription: String? {
            switch self {
            case .permission: return "Allow Speech Recognition in Settings to transcribe this recording."
            case .unavailable: return "Speech Recognition is unavailable for this language. The recording is preserved."
            case .timedOut: return "Transcription timed out. Your existing transcript and recording are unchanged."
            case .empty: return "No speech was recognized. Your existing transcript is unchanged."
            }
        }
    }

    public static func transcribe(url: URL, locale: String) async throws -> String {
        let permission = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard permission == .authorized else { throw Failure.permission }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)), recognizer.isAvailable else { throw Failure.unavailable }
        let file = try AVAudioFile(forReading: url)
        let capacity = AVAudioFrameCount(file.processingFormat.sampleRate * MeetingSegmentPolicy.segmentSeconds)
        guard capacity > 0 else { throw Failure.empty }
        var text: [String] = []
        while file.framePosition < file.length {
            try Task.checkCancellation()
            guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: capacity) else { throw Failure.empty }
            try file.read(into: buffer, frameCount: capacity)
            guard buffer.frameLength > 0 else { break }
            let segment = Segment()
            let result = try await segment.recognize(buffer, using: recognizer)
            if !result.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { text.append(result) }
        }
        guard !text.isEmpty else { throw Failure.empty }
        return text.joined(separator: "\n")
    }

    @MainActor private final class Segment {
        private var continuation: CheckedContinuation<String, Error>?
        private var task: SFSpeechRecognitionTask?
        private var timeout: Task<Void, Never>?

        func recognize(_ buffer: AVAudioPCMBuffer, using recognizer: SFSpeechRecognizer) async throws -> String {
            try await withTaskCancellationHandler {
                try Task.checkCancellation()
                return try await withCheckedThrowingContinuation { continuation in
                    self.continuation = continuation
                    let request = SFSpeechAudioBufferRecognitionRequest()
                    request.shouldReportPartialResults = false
                    request.taskHint = .dictation
                    self.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                        let text = result?.isFinal == true ? result?.bestTranscription.formattedString : nil
                        Task { @MainActor in
                            if let text { self?.finish(.success(text)) }
                            else if let error {
                                let failure = error as NSError
                                // Apple's documented no-speech result is normal
                                // for a silent 25-second section of a long call.
                                if failure.domain == "kAFAssistantErrorDomain", failure.code == 1110 { self?.finish(.success("")) }
                                else { self?.finish(.failure(error)) }
                            }
                        }
                    }
                    timeout = Task { [weak self] in
                        do { try await Task.sleep(for: .seconds(60)) } catch { return }
                        self?.finish(.failure(Failure.timedOut))
                    }
                    // The immutable buffer belongs only to this segment. Feed
                    // Speech off-main so timeout/cancellation and typing stay live.
                    DispatchQueue.global(qos: .userInitiated).async {
                        request.append(buffer)
                        request.endAudio()
                    }
                }
            } onCancel: {
                Task { @MainActor [weak self] in self?.finish(.failure(CancellationError())) }
            }
        }

        private func finish(_ result: Result<String, Error>) {
            guard let continuation else { return }
            self.continuation = nil
            timeout?.cancel(); timeout = nil
            task?.cancel(); task = nil
            continuation.resume(with: result)
        }
    }
}
