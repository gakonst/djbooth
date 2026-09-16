import AVFoundation
import UniformTypeIdentifiers
import DJBoothKit

/// AVPlayer byte ranges go through authenticated, nonredirecting CloudClient requests.
/// Streaming never writes to AudioFiles or claims that the recording is offline.
@MainActor final class CloudPlayback: NSObject, @preconcurrency AVAssetResourceLoaderDelegate {
    let asset: AVURLAsset
    private let client: CloudClient
    private let contentHash: String
    private let mediaExtension: String?
    private var tasks: [ObjectIdentifier: Task<Void, Never>] = [:]
    init(client: CloudClient, hash: String, mediaExtension: String?) {
        self.client = client; self.contentHash = hash; self.mediaExtension = mediaExtension
        asset = AVURLAsset(url: URL(string: "djbooth-cloud://media/" + hash)!)
        super.init()
        asset.resourceLoader.setDelegate(self, queue: .main)
    }
    func resourceLoader(_ resourceLoader: AVAssetResourceLoader, shouldWaitForLoadingOfRequestedResource request: AVAssetResourceLoadingRequest) -> Bool {
        let id = ObjectIdentifier(request)
        tasks[id] = Task { [weak self] in
            guard let self else { return }
            defer { self.tasks.removeValue(forKey: id) }
            do {
                let (_, total, mime) = try await client.mediaChunk(hash: contentHash)
                try Task.checkCancellation()
                if let info = request.contentInformationRequest {
                    info.contentLength = total; info.isByteRangeAccessSupported = true
                    info.contentType = mediaExtension.flatMap { UTType(filenameExtension: $0)?.identifier }
                        ?? mime.flatMap { UTType(mimeType: $0)?.identifier } ?? UTType.mp3.identifier
                }
                if let data = request.dataRequest {
                    var offset = max(data.requestedOffset, data.currentOffset)
                    let end = data.requestsAllDataToEndOfResource ? total : min(total, data.requestedOffset + Int64(data.requestedLength))
                    while offset < end {
                        let length = Int(min(512 * 1024, end - offset))
                        let (chunk, size, _) = try await client.mediaChunk(hash: contentHash, offset: offset, length: length)
                        try Task.checkCancellation()
                        guard size == total, !chunk.isEmpty else { throw ClientError.invalidMedia }
                        data.respond(with: chunk); offset += Int64(chunk.count)
                    }
                }
                if !request.isCancelled { request.finishLoading() }
            } catch { if !request.isCancelled { request.finishLoading(with: error) } }
        }
        return true
    }
    func resourceLoader(_ resourceLoader: AVAssetResourceLoader, didCancel request: AVAssetResourceLoadingRequest) {
        tasks.removeValue(forKey: ObjectIdentifier(request))?.cancel()
    }
}
