import CoreGraphics
import CryptoKit
import Foundation
import Nuke

/// Shared, bounded thumbnails. Callers retain ownership of source files and
/// continue to use their original-file preview/share paths.
public enum ChatImagePipeline {
    public enum Failure: Error { case unavailable }

    private static let pipeline: ImagePipeline = {
        let session = URLSessionConfiguration.ephemeral
        session.httpShouldSetCookies = false
        session.httpCookieStorage = nil
        session.urlCredentialStorage = nil
        session.urlCache = nil
        session.timeoutIntervalForRequest = 30
        var configuration = ImagePipeline.Configuration(dataLoader: DataLoader(configuration: session))
        configuration.imageCache = ImageCache(costLimit: 32 * 1024 * 1024, countLimit: 32)
        configuration.dataCache = nil
        return ImagePipeline(configuration: configuration)
    }()

    /// File URLs are read without moving or deleting the caller's original.
    public static func thumbnail(url: URL, maxPixelSize: Float = 1600) async throws -> CGImage {
        guard url.isFileURL || ["https", "http"].contains(url.scheme?.lowercased() ?? "") else {
            throw Failure.unavailable
        }
        return try await thumbnail(request: ImageRequest(url: url), maxPixelSize: maxPixelSize)
    }

    /// Content-derived identity lets independently displayed copies share work.
    public static func thumbnail(data: Data, maxPixelSize: Float = 960) async throws -> CGImage {
        try Task.checkCancellation()
        let identifier = "chat-data:" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return try await thumbnail(request: ImageRequest(id: identifier, data: { data }), maxPixelSize: maxPixelSize)
    }

    private static func thumbnail(request: ImageRequest, maxPixelSize: Float) async throws -> CGImage {
        try Task.checkCancellation()
        guard maxPixelSize.isFinite, maxPixelSize > 0 else { throw Failure.unavailable }
        var request = request
        request.thumbnail = ImageRequest.ThumbnailOptions(maxPixelSize: maxPixelSize)
        let image = try await pipeline.image(for: request)
        try Task.checkCancellation()
        #if canImport(UIKit)
        guard let result = image.cgImage else { throw Failure.unavailable }
        #elseif canImport(AppKit)
        guard let result = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { throw Failure.unavailable }
        #endif
        return result
    }
}
