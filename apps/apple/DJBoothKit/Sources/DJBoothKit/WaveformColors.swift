import Foundation

/// Lossless nested-array wire format with compact storage for ordinary RGB colors.
public struct WaveformColors: RandomAccessCollection, Codable, Sendable, Equatable, ExpressibleByArrayLiteral {
    public typealias Index = Int
    public typealias Element = [Int]
    private enum Storage: Sendable, Equatable { case rgb([UInt8]), rows([[Int]]) }
    private let storage: Storage

    public init(_ rows: [[Int]]) {
        if rows.allSatisfy({ $0.count == 3 && $0.allSatisfy { (0...255).contains($0) } }) {
            var bytes: [UInt8] = []; bytes.reserveCapacity(rows.count * 3)
            for row in rows { for value in row { bytes.append(UInt8(value)) } }
            storage = .rgb(bytes)
        } else { storage = .rows(rows) }
    }
    public init(arrayLiteral elements: [Int]...) { self.init(elements) }
    public var startIndex: Int { 0 }
    public var endIndex: Int {
        switch storage { case .rgb(let bytes): bytes.count / 3; case .rows(let rows): rows.count }
    }
    public subscript(index: Int) -> [Int] {
        precondition(indices.contains(index))
        switch storage {
        case .rgb(let bytes): return [Int(bytes[index * 3]), Int(bytes[index * 3 + 1]), Int(bytes[index * 3 + 2])]
        case .rows(let rows): return rows[index]
        }
    }
    /// Allocation-free normalized components; legacy values retain their original wire data.
    public func rgb(at index: Int) -> (red: Double, green: Double, blue: Double)? {
        guard indices.contains(index) else { return nil }
        switch storage {
        case .rgb(let bytes):
            return (Double(bytes[index * 3]) / 255, Double(bytes[index * 3 + 1]) / 255, Double(bytes[index * 3 + 2]) / 255)
        case .rows(let rows):
            let row = rows[index]
            guard row.count >= 3 else { return nil }
            return (Double(Swift.min(255, Swift.max(0, row[0]))) / 255,
                    Double(Swift.min(255, Swift.max(0, row[1]))) / 255,
                    Double(Swift.min(255, Swift.max(0, row[2]))) / 255)
        }
    }
    var packedByteCount: Int? {
        if case .rgb(let bytes) = storage { return bytes.count }
        return nil
    }
    private struct Row: Decodable {
        let rgb: (UInt8, UInt8, UInt8)?
        let other: [Int]?
        init(from decoder: Decoder) throws {
            var row = try decoder.unkeyedContainer()
            if row.count == 3 {
                let red = try row.decode(Int.self), green = try row.decode(Int.self), blue = try row.decode(Int.self)
                if (0...255).contains(red), (0...255).contains(green), (0...255).contains(blue) {
                    rgb = (UInt8(red), UInt8(green), UInt8(blue)); other = nil
                } else { rgb = nil; other = [red, green, blue] }
            } else {
                var values: [Int] = []
                while !row.isAtEnd { values.append(try row.decode(Int.self)) }
                if values.count == 3, values.allSatisfy({ (0...255).contains($0) }) {
                    rgb = (UInt8(values[0]), UInt8(values[1]), UInt8(values[2])); other = nil
                } else { rgb = nil; other = values }
            }
        }
        var values: [Int] {
            if let rgb { return [Int(rgb.0), Int(rgb.1), Int(rgb.2)] }
            return other ?? []
        }
    }
    public init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var bytes: [UInt8] = []
        if let count = container.count { bytes.reserveCapacity(count * 3) }
        var legacy: [[Int]]?
        while !container.isAtEnd {
            let row = try container.decode(Row.self)
            if let rgb = row.rgb, legacy == nil {
                bytes.append(rgb.0); bytes.append(rgb.1); bytes.append(rgb.2)
            } else {
                if legacy == nil {
                    legacy = stride(from: 0, to: bytes.count, by: 3).map { [Int(bytes[$0]), Int(bytes[$0 + 1]), Int(bytes[$0 + 2])] }
                    bytes = []
                }
                legacy!.append(row.values)
            }
        }
        storage = legacy.map(Storage.rows) ?? .rgb(bytes)
    }
    public func encode(to encoder: Encoder) throws {
        switch storage {
        case .rgb(let bytes):
            var container = encoder.unkeyedContainer()
            for offset in stride(from: 0, to: bytes.count, by: 3) {
                var row = container.nestedUnkeyedContainer()
                try row.encode(bytes[offset]); try row.encode(bytes[offset + 1]); try row.encode(bytes[offset + 2])
            }
        case .rows(let rows): try rows.encode(to: encoder)
        }
    }
}
