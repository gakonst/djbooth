import XCTest
@testable import DJBoothKit

final class DJLinkDeckTests: XCTestCase {
    private func deck(_ player: Int, playing: Bool = false, master: Bool = false, track: Int? = 42) throws -> DJLinkDeckState {
        let row: [String: Any] = ["player": player, "active": true, "source_player": 17,
            "source_slot": 4, "track_type": 1, "track_id": track.map { $0 as Any } ?? NSNull(),
            "playing": playing, "play_state": playing ? "playing" : "paused", "synced": false,
            "tempo_master": master, "bpm_hundreds": 12800, "effective_bpm_hundreds": 12900,
            "pitch_centi_percent": 78, "beat_in_bar": 2, "beat_number": 100,
            "track_progress_milli": 250, "track_length_sec": 240, "playhead_ms": 60000]
        return try JSONDecoder().decode(DJLinkDeckState.self, from: JSONSerialization.data(withJSONObject: row))
    }
    func testRustTelemetryDecodesWithoutInferringProtocolFlags() throws {
        let value = try deck(3, playing: true)
        XCTAssertEqual(value.playhead_ms, 60000)
        XCTAssertEqual(value.effective_bpm_hundreds, 12900)
        XCTAssertTrue(value.playing)
        XCTAssertNil(try deck(2, track: nil).track_id)
    }
    func testFollowsPlayingDeckInsteadOfPausedMasterAndThenHandoff() throws {
        let playing = try deck(2, playing: true)
        let pausedMaster = try deck(1, master: true)
        XCTAssertEqual(DJLinkDeckState.selected(in: [pausedMaster, playing], preferred: nil)?.player, 2)
        let newMaster = try deck(3, playing: true, master: true)
        XCTAssertEqual(DJLinkDeckState.selected(in: [playing, newMaster], preferred: nil)?.player, 3)
    }
    func testRustWaveformKeepsRGBAndNonuniformBeatTimes() throws {
        let json = #"{"duration_seconds":4,"peaks":[0.5,1],"colors":[[255,0,0],[0,128,255]],"beat_grid":[{"beat":1,"time_seconds":0.125},{"beat":2,"time_seconds":0.65}]}"#
        let waveform = try JSONDecoder().decode(DJLinkWaveform.self, from: Data(json.utf8)).waveform
        XCTAssertEqual(waveform.source, "rekordbox")
        XCTAssertEqual(waveform.peaks, [0.5, 1])
        XCTAssertEqual(waveform.beatGrid?.times, [0.125, 0.65])
        XCTAssertNotNil(waveform.colors)
    }
    func testExplicitSelectionAndDisconnectedDeckFallback() throws {
        let one = try deck(1), two = try deck(2, playing: true, master: true)
        XCTAssertEqual(DJLinkDeckState.selected(in: [one, two], preferred: 1)?.player, 1)
        XCTAssertEqual(DJLinkDeckState.selected(in: [two], preferred: 1)?.player, 2)
        XCTAssertNil(DJLinkDeckState.selected(in: [], preferred: 1))
    }
    func testAllSixDecksCanBeSelectedAndMasterCanBeLastPlayer() throws {
        let decks = try (1...6).map { try deck($0, playing: $0 == 6, master: $0 == 6) }
        XCTAssertEqual(DJLinkDeckState.selected(in: decks.reversed(), preferred: nil)?.player, 6)
        for player in 1...6 {
            XCTAssertEqual(DJLinkDeckState.selected(in: decks, preferred: player)?.player, player)
        }
        XCTAssertEqual(DJLinkDeckState.selected(in: Array(decks.dropLast()), preferred: 6)?.player, 1)
    }
    func testMixerBytePositionsRoutingAndExpiry() throws {
        let json = #"{"source_ip":"192.0.2.33","mixer":{"channels":[{"channel":3,"input_source":1,"trim":128,"eq_high":255,"eq_mid":128,"eq_low":0,"color":64,"fader":255,"crossfader_assign":1}],"crossfader":128},"raw_packet":[1,2,3]}"#
        let event = try JSONDecoder().decode(DJLinkMixerEvent.self, from: Data(json.utf8))
        let observation = DJLinkMixerObservation(event: event, receivedAt: 10)
        XCTAssertEqual(observation.channel(3, at: 11)?.eq_high, 255)
        XCTAssertEqual(observation.channel(3, at: 11)?.eq_low, 0)
        XCTAssertNil(observation.channel(1, at: 11), "Never borrow another channel's EQ")
        XCTAssertNil(observation.channel(nil, at: 11))
        XCTAssertNil(observation.channel(3, at: 14), "Old values must not look live after disconnect")
        XCTAssertFalse(observation.isFresh(at: 9))
    }
    func testLiveMIDISnapshotPreservesUnknownControls() throws {
        let json = #"[{"id":"DJM-A9 [1]","packets":2,"mixer":{"device":"DJM-A9 [1]","connected":true,"controls":{"channel.1.eq.high":{"percent":100},"crossfader.position":{"percent":0}}}}]"#
        let mixers = try JSONDecoder().decode([DJLinkMIDIMixer].self, from: Data(json.utf8))
        XCTAssertEqual(mixers.first?.mixer.controls["channel.1.eq.high"]?.percent, 100)
        XCTAssertEqual(mixers.first?.mixer.controls["crossfader.position"]?.percent, 0)
        XCTAssertNil(mixers.first?.mixer.controls["channel.2.eq.high"])
        XCTAssertTrue(mixers.first?.mixer.connected == true)
    }
}
