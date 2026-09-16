import Foundation
import Testing
@testable import DJBoothKit

struct USBDeviceTests {
    private func fixture() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("USB-\(UUID().uuidString)")
        let directory = root.appendingPathComponent("PIONEER/rekordbox")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let source = try #require(Bundle.module.url(forResource: "usb-export", withExtension: "pdb", subdirectory: "Fixtures"))
        try FileManager.default.copyItem(at: source, to: directory.appendingPathComponent("export.pdb"))
        return root
    }

    @Test @MainActor func importedTracksUseNormalLibraryEditsAndKeepBookmarksLocal() throws {
        let root = try fixture(), state = root.appendingPathComponent("app-state")
        defer { try? FileManager.default.removeItem(at: root) }
        let (access, library) = try USBDeviceFiles.authorize(root)
        let store = try LibraryStore(directory: state)
        try store.ingestUSB(library, access: access)
        let tracks = try store.values(.track, as: Track.self)
        #expect(tracks.count == 40)
        let id = "usb:\(access.id):track:1"
        #expect(tracks.first { $0.id == id }?.key == "Am")
        let playlistID = "usb:\(access.id):playlist:3"
        #expect(try store.collection(playlistID)?.folderPath == [access.folderName, "Weekend", "Warmup"])
        #expect(try store.collection(playlistID)?.trackIDs == [id, "usb:\(access.id):track:2", "usb:\(access.id):track:2"])
        try store.setColor(.red, trackID: id)
        try store.setNote("Play at sunrise", trackID: id)
        try store.updateCollection(playlistID, name: "My opening", mood: "", folderPath: [access.folderName])
        try store.ingestUSB(library, access: access)
        #expect(try store.annotation(for: id) == TrackAnnotation(note: "Play at sunrise", color: .red))
        #expect(try store.collection(playlistID)?.name == "My opening")
        #expect(try store.usbDevice() == access)
        #expect(try store.usbFile(id)?.path == "/Contents/Artist/Track 1.mp3")
        let reopened = try LibraryStore(directory: state)
        #expect(try reopened.usbDevice() == access)
        #expect(try reopened.annotation(for: id).color == .red)
        let cloud = try LibraryStore(inMemory: true)
        try store.copyUSBAccess(to: cloud)
        #expect(try cloud.usbDevice() == access)
        #expect(try cloud.usbFile(id) == store.usbFile(id))
        #expect(try cloud.pendingCount() == 0)
        try store.delete(kind: .collection, id: playlistID)
        try store.ingestUSB(library, access: access)
        #expect(try store.collection(playlistID) == nil)
        var sequence = 1
        while let operation = try store.nextOperation() {
            #expect(!(operation.payload ?? "").contains(root.path))
            #expect(!(operation.payload ?? "").contains("bookmark"))
            #expect(!(operation.payload ?? "").contains("/Contents/Artist"))
            try store.acknowledge(SyncChange(sequence: sequence, operationID: operation.operationID, kind: operation.kind,
                                            entityID: operation.entityID, payload: operation.payload, deleted: operation.deleted))
            sequence += 1
        }
    }

    @Test @MainActor func reExportedMediaDoesNotReuseThePreviousAudioCache() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let (access, library) = try USBDeviceFiles.authorize(root)
        let store = try LibraryStore(inMemory: true)
        try store.ingestUSB(library, access: access)
        var track = try #require(store.values(.track, as: Track.self).first)
        track.mediaHash = String(repeating: "a", count: 64)
        try store.save(track, kind: .track, id: track.id)
        var items = library.tracks
        let index = try #require(items.firstIndex { "usb:\(access.id):track:\($0.id)" == track.id })
        items[index].fileSize += 1
        let changed = USBRekordboxLibrary(name: library.name, tracks: items, playlists: library.playlists,
            histories: library.histories, tracksByID: Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) }))
        try store.ingestUSB(changed, access: access)
        #expect(try store.values(.track, as: Track.self).first { $0.id == track.id }?.mediaHash == nil)
    }

    @Test func savedFolderGrantDetectsDisconnectAndReconnectWithoutNewSelection() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let (access, _) = try USBDeviceFiles.authorize(root)
        let signature = try USBDeviceFiles.signature(access)
        let source = root.appendingPathComponent("PIONEER"), removed = root.appendingPathComponent("ejected")
        try FileManager.default.moveItem(at: source, to: removed)
        #expect(throws: (any Error).self) { try USBDeviceFiles.signature(access) }
        try FileManager.default.moveItem(at: removed, to: source)
        #expect(try USBDeviceFiles.signature(access) == signature)
        #expect(try USBDeviceFiles.authorize(USBDeviceFiles.resolve(access), previous: access).0.id == access.id)
    }

    @Test func audioUsesVerifiedCacheAndNeverChangesTheUSB() async throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        let (access, _) = try USBDeviceFiles.authorize(root)
        let source = root.appendingPathComponent("Contents/test.wav")
        try FileManager.default.createDirectory(at: source.deletingLastPathComponent(), withIntermediateDirectories: true)
        let bytes = Data((0..<100_000).map { UInt8(truncatingIfNeeded: $0) })
        try bytes.write(to: source)
        let audio = try AudioFiles(directory: root.appendingPathComponent("cache"))
        let location = USBFileLocation(trackID: "test", deviceID: access.id, path: "/Contents/test.wav", analysisPath: "")
        let (cached, hash) = try await audio.readUSB(location, access: access)
        #expect(try AudioFiles.hash(cached) == hash)
        #expect(try Data(contentsOf: source) == bytes)
        try FileManager.default.removeItem(at: source)
        #expect(await audio.existing(hash: hash) == cached)
        #expect(try Data(contentsOf: cached) == bytes)
    }

    @Test func rejectsMediaTraversalAndSymlinksOutsideTheGrantedFolder() throws {
        let root = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        #expect(throws: USBLibraryError.invalidDatabase) { try USBDeviceFiles.containedURL("../private.mp3", root: root) }
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("escape"), withDestinationURL: root.deletingLastPathComponent())
        #expect(throws: USBLibraryError.invalidDatabase) { try USBDeviceFiles.containedURL("escape/private.mp3", root: root) }
    }

    @Test func decodesWaveformsAndExactBeatGridAndRejectsTruncatedTags() throws {
        var beats = Data(repeating: 0, count: 40)
        beats.replaceSubrange(0..<4, with: "PQTZ".utf8)
        put(&beats, 4, 24); put(&beats, 8, 40); put(&beats, 20, 2)
        beats[25] = 1; beats[33] = 2; put(&beats, 28, 100); put(&beats, 36, 600)
        var wave = Data(repeating: 0, count: 23)
        wave.replaceSubrange(0..<4, with: "PWAV".utf8)
        put(&wave, 4, 20); put(&wave, 8, 23); put(&wave, 12, 3)
        wave[20] = 31; wave[21] = 15; wave[22] = 0
        var data = Data(repeating: 0, count: 28)
        data.replaceSubrange(0..<4, with: "PMAI".utf8)
        put(&data, 4, 28); put(&data, 8, 28 + beats.count + wave.count)
        data.append(beats); data.append(wave)
        let result = try #require(try USBAnalysis.parse(data, duration: 2))
        #expect(result.peaks == [1, 15.0 / 31, 0])
        #expect(result.beatGrid?.times == [0.1, 0.6])
        #expect(result.beatGrid?.beats == [1, 2])
        data.removeLast()
        #expect(throws: USBLibraryError.invalidDatabase) { try USBAnalysis.parse(data, duration: 2) }
    }
    private func put(_ data: inout Data, _ offset: Int, _ value: Int) {
        for i in 0..<4 { data[offset + i] = UInt8(truncatingIfNeeded: value >> (24 - i * 8)) }
    }
}
