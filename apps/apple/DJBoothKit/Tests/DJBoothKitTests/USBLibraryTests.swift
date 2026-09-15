import Foundation
import Testing
@testable import DJBoothKit

struct USBLibraryTests {
    private func fixture() throws -> Data {
        let url = try #require(Bundle.module.url(forResource: "usb-export", withExtension: "pdb", subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    @Test func readsExporterFixtureAcrossPagesAndPreservesPlaylistOrder() throws {
        let library = try USBRekordboxLibrary.parse(fixture(), name: "DJ USB")
        #expect(library.name == "DJ USB")
        #expect(library.tracks.count == 40)
        let track = try #require(library.tracksByID[1])
        #expect(track.title == "Νύχτα 🌙")
        #expect(track.artist == "Artist" && track.album == "Album" && track.genre == "House")
        #expect(track.bpm == 128.5 && track.key == "Am" && track.duration == 321)
        #expect(track.comment == String(repeating: "A", count: 140))
        #expect(track.filePath == "/Contents/Artist/Track 1.mp3")
        #expect(library.children(of: 0).map(\.name) == ["Weekend", "Empty"])
        #expect(library.children(of: 1).map(\.name) == ["Warmup"])
        #expect(library.children(of: 2).first?.trackIDs == [1, 2, 2])
        #expect(library.children(of: 0).last?.trackIDs.isEmpty == true)
    }

    @Test func ignoresDeletedSlotsAndRetainsMissingMemberships() throws {
        var data = try fixture()
        let page = dataPage(data, table: 0)
        let mask = page + 4096 - 4
        data[mask] &= 0xfe
        // Stale deleted row offsets must not be dereferenced.
        put(&data, at: page + 4096 - 6, value: 0xffff, count: 2)
        let library = try USBRekordboxLibrary.parse(data, name: "Deleted")
        #expect(library.tracks.count == 39)
        #expect(library.tracksByID[1] == nil)
        #expect(library.children(of: 2).first?.trackIDs == [1, 2, 2])
    }

    @Test func readsCDJHistoriesWithRepeatedTracksAndRejectsBrokenReferences() throws {
        let data = try fixture()
        let library = try USBRekordboxLibrary.parse(data, name: "Played USB")
        #expect(library.histories.count == 1)
        #expect(library.histories.first?.name == "HISTORY 001")
        #expect(library.histories.first?.trackIDs == [2, 1, 2])
        let page = dataPage(data, table: 12)
        let row = page + 40 + u16(data, page + 4096 - 6)
        var corrupt = data
        put(&corrupt, at: row + 4, value: 999, count: 4)
        #expect(throws: USBLibraryError.invalidDatabase) { try USBRekordboxLibrary.parse(corrupt, name: "Broken history") }
    }

    @Test func supportsFarAlbumAndArtistPointers() throws {
        var data = try fixture()
        for (table, subtype, pointer, name) in [(2, 0x64, 10, "Artist"), (3, 0x84, 22, "Album")] {
            let page = dataPage(data, table: table)
            let row = page + 40 + u16(data, page + 4096 - 6)
            put(&data, at: row, value: subtype, count: 2)
            put(&data, at: row + pointer, value: 300, count: 2)
            data[row + 300] = UInt8((name.utf8.count + 1) * 2 + 1)
            data.replaceSubrange((row + 301)..<(row + 301 + name.utf8.count), with: name.utf8)
        }
        let track = try #require(USBRekordboxLibrary.parse(data, name: "Far strings").tracksByID[1])
        #expect(track.artist == "Artist" && track.album == "Album")
    }

    @Test func readsAllThirteenRowCountBitsOnHeavilyEditedPages() throws {
        var data = try fixture()
        let page = dataPage(data, table: 1)
        let originalOffset = u16(data, page + 4096 - 6)
        let slots = 513
        let directorySize = slots * 2 + ((slots + 15) / 16) * 4
        data.replaceSubrange((page + 4096 - directorySize)..<(page + 4096), with: repeatElement(UInt8(0), count: directorySize))
        // 512 deleted slots, then one live genre, with num_rows = 1 in the high bits.
        put(&data, at: page + 0x18, value: slots | (1 << 13), count: 3)
        let lastGroup = page + 4096 - 32 * 36
        put(&data, at: lastGroup - 4, value: 1, count: 2)
        put(&data, at: lastGroup - 6, value: originalOffset, count: 2)
        let library = try USBRekordboxLibrary.parse(data, name: "Edited")
        #expect(library.tracksByID[1]?.genre == "House")
    }

    @Test func rejectsTruncationBadHeadersPageCyclesAndOutOfBoundsRows() throws {
        let data = try fixture()
        for length in [0, 27, 4095, data.count - 1] {
            #expect(throws: USBLibraryError.self) { try USBRekordboxLibrary.parse(Data(data.prefix(length)), name: "Truncated") }
        }
        let page = dataPage(data, table: 0)
        for (offset, value, count) in [(4, 0, 4), (8, 9999, 4), (page + 12, page / 4096, 4),
                                       (page + 4096 - 6, 4095, 2), (page + 8, 7, 4)] {
            var corrupt = data
            put(&corrupt, at: offset, value: value, count: count)
            #expect(throws: USBLibraryError.self) { try USBRekordboxLibrary.parse(corrupt, name: "Corrupt") }
        }
    }

    @Test func rejectsStringsOutsideRowAndDuplicateIDs() throws {
        let data = try fixture()
        let page = dataPage(data, table: 0)
        let first = page + 40 + u16(data, page + 4096 - 6)
        let second = page + 40 + u16(data, page + 4096 - 8)
        for (offset, value, count) in [(first + 0x5e + 17 * 2, 0xffff, 2), (second + 0x48, 1, 4)] {
            var corrupt = data
            put(&corrupt, at: offset, value: value, count: count)
            #expect(throws: USBLibraryError.self) { try USBRekordboxLibrary.parse(corrupt, name: "Corrupt") }
        }
    }

    @Test func rejectsPlaylistCyclesAndMissingParents() throws {
        let data = try fixture()
        let page = dataPage(data, table: 7)
        let row = page + 40 + u16(data, page + 4096 - 6)
        for parent in [1, 999] {
            var corrupt = data
            put(&corrupt, at: row, value: parent, count: 4)
            #expect(throws: USBLibraryError.self) { try USBRekordboxLibrary.parse(corrupt, name: "Corrupt") }
        }
    }

    @Test func readsOnlySelectedRootAndDoesNotChangeDatabase() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let directory = root.appendingPathComponent("PIONEER/rekordbox")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        #expect(throws: USBLibraryError.libraryNotFound) { try USBRekordboxLibrary.read(root: root) }
        try Data().write(to: directory.appendingPathComponent("exportLibrary.db"))
        #expect(throws: USBLibraryError.oneLibraryOnly) { try USBRekordboxLibrary.read(root: root) }
        let original = try fixture()
        let database = directory.appendingPathComponent("export.pdb")
        try original.write(to: database)
        #expect(try USBRekordboxLibrary.read(root: root).tracks.count == 40)
        #expect(try Data(contentsOf: database) == original)
        #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted() == ["export.pdb", "exportLibrary.db"])
        // Selecting PIONEER instead of the volume must not traverse up to siblings.
        #expect(throws: USBLibraryError.libraryNotFound) { try USBRekordboxLibrary.read(root: root.appendingPathComponent("PIONEER")) }
        try FileManager.default.removeItem(at: database)
        #expect(throws: USBLibraryError.oneLibraryOnly) { try USBRekordboxLibrary.read(root: root) }
    }

    @Test func rejectsDatabaseSymlinkOutsideGrantedRoot() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let granted = root.appendingPathComponent("USB")
        let directory = granted.appendingPathComponent("PIONEER/rekordbox")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let outside = root.appendingPathComponent("outside.pdb")
        try fixture().write(to: outside)
        try FileManager.default.createSymbolicLink(at: directory.appendingPathComponent("export.pdb"), withDestinationURL: outside)
        #expect(throws: USBLibraryError.invalidDatabase) { try USBRekordboxLibrary.read(root: granted) }
    }

    private func u16(_ data: Data, _ offset: Int) -> Int { Int(data[offset]) | Int(data[offset + 1]) << 8 }
    private func u32(_ data: Data, _ offset: Int) -> Int {
        (0..<4).reduce(0) { $0 | Int(data[offset + $1]) << ($1 * 8) }
    }
    private func put(_ data: inout Data, at offset: Int, value: Int, count: Int) {
        for index in 0..<count { data[offset + index] = UInt8(truncatingIfNeeded: value >> (index * 8)) }
    }
    private func dataPage(_ data: Data, table: Int) -> Int {
        let entry = (0..<u32(data, 8)).map { 28 + $0 * 16 }.first { u32(data, $0) == table }!
        var page = u32(data, entry + 8) * 4096
        while data[page + 0x1b] & 0x40 != 0 { page = u32(data, page + 12) * 4096 }
        return page
    }
}
