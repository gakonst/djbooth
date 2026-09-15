import AVFoundation
import Foundation
import UniformTypeIdentifiers

extension AudioFiles {
    public static func detectPlaybackMIMEType(url: URL, mediaExtension: String? = nil) async -> String? {
        guard url.isFileURL else { return nil }
        return await Task.detached(priority: .userInitiated) { playbackMIMEType(url: url, mediaExtension: mediaExtension) }.value
    }
    public static func playbackAsset(url: URL, mimeType: String?) -> AVURLAsset {
        var options: [String: Any] = [:]
        if let mimeType { options[AVURLAssetOverrideMIMETypeKey] = mimeType }
        return AVURLAsset(url: url, options: options)
    }
    /// Content-addressed cache files deliberately have no codec in their name.
    /// AVFoundation needs an explicit container type for these `.audio` URLs.
    public static func playbackAsset(url: URL, mediaExtension: String? = nil) -> AVURLAsset {
        var options: [String: Any] = [:]
        if url.isFileURL, let mime = playbackMIMEType(url: url, mediaExtension: mediaExtension) {
            options[AVURLAssetOverrideMIMETypeKey] = mime
        }
        return AVURLAsset(url: url, options: options)
    }

    static func playbackMIMEType(url: URL, mediaExtension: String? = nil) -> String? {
        if let handle = try? FileHandle(forReadingFrom: url) {
            defer { try? handle.close() }
            let bytes = [UInt8]((try? handle.read(upToCount: 16)) ?? Data())
            func matches(_ text: String, at offset: Int = 0) -> Bool {
                let signature = Array(text.utf8)
                return bytes.count >= offset + signature.count && Array(bytes[offset..<(offset + signature.count)]) == signature
            }
            if matches("ftyp", at: 4) { return "audio/mp4" }
            if (matches("RIFF") || matches("RF64")), matches("WAVE", at: 8) { return "audio/wav" }
            if matches("FORM"), matches("AIFF", at: 8) || matches("AIFC", at: 8) { return "audio/aiff" }
            if matches("fLaC") { return "audio/flac" }
            if matches("OggS") { return "audio/ogg" }
            if matches("ID3") { return "audio/mpeg" }
            if bytes.count >= 2, bytes[0] == 0xff {
                if bytes[1] & 0xf6 == 0xf0 { return "audio/aac" }
                if bytes[1] & 0xe0 == 0xe0, bytes[1] & 0x06 != 0 { return "audio/mpeg" }
            }
        }
        return UTType(filenameExtension: mediaExtension ?? url.pathExtension)?.preferredMIMEType
    }
}
