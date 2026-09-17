import Foundation

/// The shared Rust DjLinkDeckState wire model. All protocol interpretation is Rust's.
public struct DJLinkDeckState: Decodable, Equatable, Sendable, Identifiable {
    public let player: Int
    public let active: Bool
    public let on_air: Bool?
    public let source_player, source_slot, track_type: Int
    public let track_id: UInt32?
    public let playing: Bool
    public let play_state: String
    public let synced, tempo_master: Bool
    public let bpm_hundreds, effective_bpm_hundreds: Int?
    public let pitch_centi_percent, beat_in_bar: Int
    public let master_tempo: Bool?
    public let key_shift_cents: Int?
    public let effective_key: String?
    public let beat_number, track_progress_milli, track_length_sec, playhead_ms: Int?
    public let playhead_source: String?
    public var id: Int { player }

    /// Presentation policy only: follow a playing master, then another playing
    /// deck, then a loaded deck. An explicit choice survives track changes.
    public static func selected(in decks: [Self], preferred: Int?) -> Self? {
        let ordered = decks.sorted { $0.player < $1.player }
        if let preferred, let deck = ordered.first(where: { $0.player == preferred }) { return deck }
        return ordered.first { $0.playing && $0.tempo_master && $0.track_id != nil }
            ?? ordered.first { $0.playing && $0.track_id != nil }
            ?? ordered.first { $0.tempo_master && $0.track_id != nil }
            ?? ordered.first { $0.track_id != nil }
            ?? ordered.first
    }
}

/// Adapts Rust's already-decoded ANLZ data to the normal player renderer.
public struct DJLinkWaveform: Decodable, Sendable {
    public struct Beat: Decodable, Sendable {
        public let beat: Int
        public let time_seconds: Double
    }
    public let duration_seconds: Double
    public let peaks: [Double]
    public let colors: [[Int]]
    public let beat_grid: [Beat]
    public var waveform: Waveform {
        Waveform(peaks: peaks, colors: colors.isEmpty ? nil : colors, source: "rekordbox",
                 durationSeconds: duration_seconds,
                 beatGrid: beat_grid.isEmpty ? nil : BeatGrid(times: beat_grid.map(\.time_seconds), beats: beat_grid.map(\.beat)))
    }
}

/// Rust's decoded A9 telemetry. Positions are unsigned 8-bit values, not MIDI
/// 7-bit values or calibrated dB. Swift never interprets the network packet.
public struct DJLinkMixerEvent: Decodable, Equatable, Sendable {
    public struct Channel: Decodable, Equatable, Sendable, Identifiable {
        public let channel, input_source, trim, eq_high, eq_mid, eq_low: UInt8
        public let color, fader, crossfader_assign: UInt8
        public var id: Int { Int(channel) }
    }
    public struct Mixer: Decodable, Equatable, Sendable {
        public let channels: [Channel]
        public let crossfader: UInt8
    }
    public let source_ip: String
    public let mixer: Mixer
}

public struct DJLinkMixerObservation: Equatable, Sendable {
    public let event: DJLinkMixerEvent
    public let receivedAt: TimeInterval
    public init(event: DJLinkMixerEvent, receivedAt: TimeInterval) {
        self.event = event
        self.receivedAt = receivedAt
    }
    public func isFresh(at now: TimeInterval) -> Bool {
        (0...3).contains(now - receivedAt)
    }
    public func channel(_ number: Int?, at now: TimeInterval) -> DJLinkMixerEvent.Channel? {
        guard isFresh(at: now), let number else { return nil }
        return event.mixer.channels.first { $0.id == number }
    }
}

/// The desktop Rust booth reducer's MIDI control snapshot. MIDI emits changes,
/// so values stay valid until CoreMIDI reports that their source disconnected.
public struct DJLinkMIDIMixer: Decodable, Equatable, Sendable, Identifiable {
    public struct Control: Decodable, Equatable, Sendable {
        public let percent: Double?
    }
    public struct Mixer: Decodable, Equatable, Sendable {
        public let device: String
        public let connected: Bool
        public let controls: [String: Control]
    }
    public let id: String
    public let packets: UInt64
    public let mixer: Mixer
}
