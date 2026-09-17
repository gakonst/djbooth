import Foundation
import Testing
@testable import DJBoothKit

@MainActor struct CrewTests {
    @Test func crewCacheSurvivesAStoreRestart() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let crew = CrewSummary(id: "crew-one", name: "No Static", role: .owner,
                               memberCount: 2, crateCount: 1, updatedAt: nil)
        let crate = CrewCrate(id: "crate-one", crewID: crew.id, name: "Late night",
                              note: nil, itemCount: 1, updatedAt: nil)
        let item = CrewCrateItem(id: "item-one", crateID: crate.id, recordingID: "recording-one",
                                 assetHash: nil, localTrackID: "local-one", title: "Apathy",
                                 artist: "Bontan", bpm: 123, musicalKey: "8A", durationSeconds: 300,
                                 note: "Closer", sortKey: 1024, addedBy: "georgios",
                                 createdAt: "now", updatedAt: "now")
        var store: LibraryStore? = try LibraryStore(directory: directory)
        try store!.saveCrewCache(CrewCache(crews: [crew], crates: [crate.id: CrewCrateDetail(crate: crate, items: [item])]))
        store = nil
        let restored = try LibraryStore(directory: directory).crewCache()
        #expect(restored.crews == [crew])
        #expect(restored.crates[crate.id]?.items.first?.note == "Closer")
    }

    @Test func trackReferenceCarriesPortableIdentityWithoutWaveform() throws {
        let track = Track(id: "local", title: "Apathy", artist: "Bontan", key: "8A", bpm: 123,
                          durationSeconds: 300, mediaHash: String(repeating: "a", count: 64),
                          waveform: Waveform(peaks: [0.1, 0.9]))
        let encoded = try JSONEncoder().encode(CrewTrackReference(track))
        let payload = try JSONDecoder().decode(CrewTrackReference.self, from: encoded)
        #expect(payload.recordingID == "local")
        #expect(payload.assetHash == String(repeating: "a", count: 64))
        #expect(String(decoding: encoded, as: UTF8.self).contains("peaks") == false)
    }
}
