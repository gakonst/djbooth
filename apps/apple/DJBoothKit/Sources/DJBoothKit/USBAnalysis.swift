import Foundation

/// Bounded decoding of the same PQTZ/PWAV/PWV3/PWV5 tags used by the Rekordbox engine.
public enum USBAnalysis {
    public static func parse(_ data: Data, duration: Double) throws -> Waveform? {
        let bytes = [UInt8](data)
        func check(_ offset: Int, _ length: Int) throws {
            guard offset >= 0, length >= 0, offset <= bytes.count, length <= bytes.count - offset else { throw USBLibraryError.invalidDatabase }
        }
        func u16(_ p: Int) throws -> Int { try check(p, 2); return Int(bytes[p]) << 8 | Int(bytes[p + 1]) }
        func u32(_ p: Int) throws -> Int {
            try check(p, 4)
            return (0..<4).reduce(0) { ($0 << 8) | Int(bytes[p + $1]) }
        }
        guard bytes.count >= 28, bytes.count <= 32 * 1_024 * 1_024,
              String(bytes: bytes.prefix(4), encoding: .ascii) == "PMAI", try u32(8) == bytes.count else { throw USBLibraryError.invalidDatabase }
        var offset = try u32(4), peaks: [Double] = [], colors: [[Int]]?, times: [Double] = [], beats: [Int] = []
        guard offset >= 28, offset <= bytes.count else { throw USBLibraryError.invalidDatabase }
        while offset < bytes.count {
            try Task.checkCancellation(); try check(offset, 12)
            let type = String(bytes: bytes[offset..<(offset + 4)], encoding: .ascii)
            let header = try u32(offset + 4), length = try u32(offset + 8)
            guard header >= 12, length >= header else { throw USBLibraryError.invalidDatabase }
            try check(offset, length)
            func count(_ at: Int, start: Int, stride: Int) throws -> Int {
                guard at + 4 <= header, start <= length else { throw USBLibraryError.invalidDatabase }
                let n = try u32(offset + at)
                guard n <= 1_000_000, n <= (length - start) / stride else { throw USBLibraryError.invalidDatabase }
                return n
            }
            switch type {
            case "PQTZ":
                let n = try count(20, start: 24, stride: 8)
                if n <= 20_000 {
                    beats = try (0..<n).map { try u16(offset + 24 + $0 * 8) }
                    times = try (0..<n).map { Double(try u32(offset + 28 + $0 * 8)) / 1000 }
                }
            case "PWAV", "PWV3":
                let start = type == "PWV3" ? 24 : 20
                let n = try count(type == "PWV3" ? 16 : 12, start: start, stride: 1)
                if colors == nil, n > peaks.count { peaks = (0..<n).map { Double(bytes[offset + start + $0] & 0x1f) / 31 } }
            case "PWV5":
                let n = try count(16, start: 24, stride: 2)
                var rgb: [[Int]] = [], values: [Double] = []
                for i in 0..<n {
                    let value = try u16(offset + 24 + i * 2)
                    values.append(Double((value >> 2) & 31) / 31)
                    rgb.append([13, 10, 7].map { ((value >> $0) & 7) * 255 / 7 })
                }
                if !values.isEmpty { peaks = values; colors = rgb }
            default: break
            }
            offset += length
        }
        guard !peaks.isEmpty || !times.isEmpty else { return nil }
        // Bound the portable waveform payload while retaining peak transients.
        let stride = max(1, (peaks.count + 19_999) / 20_000)
        if stride > 1 {
            var reduced: [Double] = [], rgb: [[Int]] = []
            for start in Swift.stride(from: 0, to: peaks.count, by: stride) {
                let end = min(peaks.count, start + stride)
                let index = (start..<end).max { peaks[$0] < peaks[$1] }!
                reduced.append(peaks[index]); if let colors { rgb.append(colors[index]) }
            }
            peaks = reduced; if colors != nil { colors = rgb }
        }
        return Waveform(peaks: peaks, colors: colors, durationSeconds: duration, beatGrid: BeatGrid(times: times, beats: beats))
    }

    public static func read(_ location: USBFileLocation, access: USBDeviceAccess, duration: Double) throws -> Waveform? {
        guard access.id == location.deviceID, !location.analysisPath.isEmpty else { return nil }
        let root = try USBDeviceFiles.resolve(access)
        let scope = root.startAccessingSecurityScopedResource()
        defer { if scope { root.stopAccessingSecurityScopedResource() } }
        var result: Waveform?
        for path in [location.analysisPath, (location.analysisPath as NSString).deletingPathExtension + ".EXT"] {
            let file = try USBDeviceFiles.containedURL(path, root: root)
            guard FileManager.default.fileExists(atPath: file.path) else { continue }
            var error: NSError?, parsed: Result<Waveform?, Error>?
            NSFileCoordinator().coordinate(readingItemAt: file, options: [], error: &error) { url in
                parsed = Result {
                    guard let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 32 * 1_024 * 1_024 else { throw USBLibraryError.tooLarge }
                    let handle = try FileHandle(forReadingFrom: url)
                    defer { try? handle.close() }
                    return try parse(handle.read(upToCount: 32 * 1_024 * 1_024 + 1) ?? Data(), duration: duration)
                }
            }
            if let error { throw error }
            if var waveform = try parsed?.get() {
                if waveform.beatGrid?.times.isEmpty != false { waveform.beatGrid = result?.beatGrid }
                result = waveform
            }
        }
        return result?.peaks.isEmpty == false ? result : nil
    }
}

/// Serialize removable-media analysis reads so scrolling does not launch one
/// competing disk read per visible row. The actor runs away from the UI executor.
public actor USBAnalysisReader {
    public init() {}
    public func read(_ location: USBFileLocation, access: USBDeviceAccess, duration: Double) throws -> Waveform? {
        try Task.checkCancellation()
        return try USBAnalysis.read(location, access: access, duration: duration)
    }
}
