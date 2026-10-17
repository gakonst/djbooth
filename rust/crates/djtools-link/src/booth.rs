//! One booth state reducer and replay schema for desktop and mobile.
use crate::mixer::DecodedEvent;
use crate::{
    DjLinkDeckState, DjLinkMixerTelemetryEvent, DjLinkServer, DjLinkTelemetryEvent,
    DjLinkTelemetryKind, DjLinkTrackMetadata, DjLinkVuTelemetryEvent,
};
use anyhow::Result;
use serde::Serialize;
use std::{collections::BTreeMap, sync::Arc, time::Instant};
use tokio::sync::{RwLock, broadcast};
pub const SCHEMA_VERSION: u32 = 1;
#[derive(Clone, Debug)]
pub struct MeterFrame {
    pub pairs: Vec<StereoMeter>,
}

#[derive(Clone, Debug)]
pub struct StereoMeter {
    pub pair: u8,
    pub left_channel: u8,
    pub right_channel: u8,
    pub peak_dbfs: f64,
    pub rms_dbfs: f64,
    pub left_peak_dbfs: f64,
    pub right_peak_dbfs: f64,
    pub left_rms_dbfs: f64,
    pub right_rms_dbfs: f64,
}

#[derive(Clone)]
pub struct StatePublisher {
    pub state: BoothStateSource,
}

#[derive(Clone)]
pub struct BoothStateSource {
    pub booth: Arc<RwLock<BoothState>>,
    pub messages: broadcast::Sender<String>,
    pub started: Instant,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoothState {
    pub schema_version: u32,
    pub sequence: u64,
    pub observed_at_us: u64,
    pub mixer: MixerState,
    pub decks: Vec<DeckState>,
    #[serde(skip_serializing)]
    pub latest_mixer_frame: Option<RawMixerFrame>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawMixerFrame {
    pub source_ip: String,
    pub observed_at_us: u64,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MixerState {
    pub device: String,
    pub connected: bool,
    pub audio_meter_device: Option<String>,
    pub audio_meter_connected: bool,
    pub bpm: Option<f64>,
    pub controls: BTreeMap<String, ControlState>,
    pub meters: BTreeMap<String, MeterState>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterState {
    pub pair: u8,
    pub channels: [u8; 2],
    pub peak_dbfs: f64,
    pub rms_dbfs: f64,
    pub left_peak_dbfs: f64,
    pub right_peak_dbfs: f64,
    pub left_rms_dbfs: f64,
    pub right_rms_dbfs: f64,
    pub changed_at_us: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlState {
    pub label: String,
    pub value: Option<u16>,
    pub percent: Option<f64>,
    pub state: Option<String>,
    pub raw: String,
    pub changed_at_us: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckState {
    pub player: u8,
    pub connected: bool,
    pub source: &'static str,
    pub model: Option<String>,
    pub ip: Option<String>,
    pub active: bool,
    pub on_air: Option<bool>,
    pub source_player: Option<u8>,
    pub source_slot: Option<u8>,
    pub track_type: Option<u8>,
    pub track_id: Option<u32>,
    pub track_title: Option<String>,
    pub track_artist: Option<String>,
    pub track_album: Option<String>,
    pub track_artwork_url: Option<String>,
    pub playing: bool,
    pub play_state: Option<&'static str>,
    pub synced: bool,
    pub tempo_master: bool,
    pub bpm: Option<f64>,
    pub effective_bpm: Option<f64>,
    pub pitch_percent: Option<f64>,
    pub beat_in_bar: Option<u8>,
    pub beat_number: Option<u32>,
    pub track_progress_percent: Option<f64>,
    pub track_length_sec: Option<u32>,
    pub playhead_ms: Option<u32>,
    pub playhead_source: Option<&'static str>,
    pub master_tempo: Option<bool>,
    pub key_shift_cents: Option<i64>,
    pub effective_key: Option<String>,
}

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StreamMessage<'a> {
    Snapshot {
        schema_version: u32,
        snapshot: &'a BoothState,
    },
    Event {
        schema_version: u32,
        sequence: u64,
        observed_at_us: u64,
        source: &'static str,
        event: &'a DecodedEvent,
    },
    Deck {
        schema_version: u32,
        sequence: u64,
        observed_at_us: u64,
        source: &'static str,
        kind: &'static str,
        deck: &'a DeckState,
    },
    Meters {
        schema_version: u32,
        sequence: u64,
        observed_at_us: u64,
        source: &'static str,
        meters: &'a BTreeMap<String, MeterState>,
    },
}

impl StatePublisher {
    pub async fn publish_djlink_mixer_event(&self, event: DjLinkMixerTelemetryEvent) -> Result<()> {
        let observed_at_us = elapsed_us(self.state.started);
        {
            let mut booth = self.state.booth.write().await;
            booth.sequence += 1;
            booth.observed_at_us = observed_at_us;
            booth.mixer.connected = true;
            booth.latest_mixer_frame = Some(RawMixerFrame {
                source_ip: event.source_ip.to_string(),
                observed_at_us,
                bytes: event.raw_packet,
            });
            for channel in event.mixer.channels {
                let prefix = format!("channel.{}", channel.channel);
                set_link_control(
                    &mut booth.mixer.controls,
                    format!("{prefix}.input"),
                    format!("Channel {} input source", channel.channel),
                    channel.input_source,
                    None,
                    observed_at_us,
                );
                for (suffix, label, value) in [
                    ("trim", "trim", channel.trim),
                    ("eq.high", "EQ high", channel.eq_high),
                    ("eq.mid", "EQ mid", channel.eq_mid),
                    ("eq.low", "EQ low", channel.eq_low),
                    ("color", "Sound Color FX knob", channel.color),
                    ("fader", "fader", channel.fader),
                ] {
                    set_link_control(
                        &mut booth.mixer.controls,
                        format!("{prefix}.{suffix}"),
                        format!("Channel {} {label}", channel.channel),
                        value,
                        None,
                        observed_at_us,
                    );
                }
                set_link_control(
                    &mut booth.mixer.controls,
                    format!("{prefix}.crossfaderAssign"),
                    format!("Channel {} crossfader assign", channel.channel),
                    channel.crossfader_assign,
                    crossfader_assign_state(channel.crossfader_assign),
                    observed_at_us,
                );
            }
            set_link_control(
                &mut booth.mixer.controls,
                "crossfader.position".to_string(),
                "Crossfader".to_string(),
                event.mixer.crossfader,
                None,
                observed_at_us,
            );
        }
        self.broadcast_snapshot().await
    }

    pub async fn publish_meter_frame(&self, frame: &MeterFrame) -> Result<()> {
        let (sequence, observed_at_us, meters) = {
            let mut booth = self.state.booth.write().await;
            booth.sequence += 1;
            booth.observed_at_us = elapsed_us(self.state.started);
            let observed_at_us = booth.observed_at_us;
            for meter in &frame.pairs {
                booth.mixer.meters.insert(
                    format!("usb.{}_{}", meter.left_channel, meter.right_channel),
                    MeterState {
                        pair: meter.pair,
                        channels: [meter.left_channel, meter.right_channel],
                        peak_dbfs: meter.peak_dbfs,
                        rms_dbfs: meter.rms_dbfs,
                        left_peak_dbfs: meter.left_peak_dbfs,
                        right_peak_dbfs: meter.right_peak_dbfs,
                        left_rms_dbfs: meter.left_rms_dbfs,
                        right_rms_dbfs: meter.right_rms_dbfs,
                        changed_at_us: observed_at_us,
                    },
                );
            }
            (booth.sequence, observed_at_us, booth.mixer.meters.clone())
        };
        let text = serde_json::to_string(&StreamMessage::Meters {
            schema_version: SCHEMA_VERSION,
            sequence,
            observed_at_us,
            source: "usbAudio",
            meters: &meters,
        })?;
        let _ = self.state.messages.send(text);
        Ok(())
    }

    pub async fn publish_djlink_vu_event(&self, event: DjLinkVuTelemetryEvent) -> Result<()> {
        let (sequence, observed_at_us, meters) = {
            let mut booth = self.state.booth.write().await;
            booth.sequence += 1;
            booth.observed_at_us = elapsed_us(self.state.started);
            booth.mixer.connected = true;
            let observed_at_us = booth.observed_at_us;
            for (channel, frames) in event.channels {
                let samples = frames.len().max(1) as f64;
                let left_peak = frames
                    .iter()
                    .map(|frame| frame[0])
                    .max()
                    .unwrap_or_default();
                let right_peak = frames
                    .iter()
                    .map(|frame| frame[1])
                    .max()
                    .unwrap_or_default();
                let left_rms = (frames
                    .iter()
                    .map(|frame| f64::from(frame[0]).powi(2))
                    .sum::<f64>()
                    / samples)
                    .sqrt();
                let right_rms = (frames
                    .iter()
                    .map(|frame| f64::from(frame[1]).powi(2))
                    .sum::<f64>()
                    / samples)
                    .sqrt();
                let peak = left_peak.max(right_peak);
                let rms = ((left_rms.powi(2) + right_rms.powi(2)) / 2.0).sqrt();
                booth.mixer.meters.insert(
                    format!("ethernet.{channel}"),
                    MeterState {
                        pair: channel,
                        channels: [channel.saturating_mul(2).saturating_sub(1), channel * 2],
                        peak_dbfs: raw_level_dbfs(f64::from(peak)),
                        rms_dbfs: raw_level_dbfs(rms),
                        left_peak_dbfs: raw_level_dbfs(f64::from(left_peak)),
                        right_peak_dbfs: raw_level_dbfs(f64::from(right_peak)),
                        left_rms_dbfs: raw_level_dbfs(left_rms),
                        right_rms_dbfs: raw_level_dbfs(right_rms),
                        changed_at_us: observed_at_us,
                    },
                );
            }
            (booth.sequence, observed_at_us, booth.mixer.meters.clone())
        };
        let text = serde_json::to_string(&StreamMessage::Meters {
            schema_version: SCHEMA_VERSION,
            sequence,
            observed_at_us,
            source: "djLinkEthernet",
            meters: &meters,
        })?;
        let _ = self.state.messages.send(text);
        Ok(())
    }

    pub async fn publish_mixer_event(&self, event: &DecodedEvent) -> Result<()> {
        let (sequence, observed_at_us) = {
            let mut booth = self.state.booth.write().await;
            booth.sequence += 1;
            booth.observed_at_us = elapsed_us(self.state.started);
            if let Some(bpm) = event.bpm {
                booth.mixer.bpm = Some(bpm);
            }
            if let Some(control) = event.control {
                booth.mixer.controls.insert(
                    control.to_string(),
                    ControlState {
                        label: event.label.unwrap_or(control).to_string(),
                        value: event.value,
                        percent: event.percent,
                        state: event.state.map(str::to_string),
                        raw: event.raw.clone(),
                        changed_at_us: event.timestamp_us,
                    },
                );
            }
            (booth.sequence, booth.observed_at_us)
        };
        let text = serde_json::to_string(&StreamMessage::Event {
            schema_version: SCHEMA_VERSION,
            sequence,
            observed_at_us,
            source: "midi",
            event,
        })?;
        let _ = self.state.messages.send(text);
        Ok(())
    }

    pub async fn set_mixer_connected(&self, connected: bool) -> Result<()> {
        self.set_mixer_connection(None, connected).await
    }

    pub async fn set_mixer_connection(
        &self,
        device: Option<String>,
        connected: bool,
    ) -> Result<()> {
        let changed = {
            let mut booth = self.state.booth.write().await;
            let device_changed = device
                .as_ref()
                .is_some_and(|device| booth.mixer.device != *device);
            if booth.mixer.connected == connected && !device_changed {
                false
            } else {
                if let Some(device) = device {
                    booth.mixer.device = device;
                }
                booth.mixer.connected = connected;
                if !connected {
                    booth.mixer.bpm = None;
                }
                booth.sequence += 1;
                booth.observed_at_us = elapsed_us(self.state.started);
                true
            }
        };
        if changed {
            self.broadcast_snapshot().await?;
        }
        Ok(())
    }

    pub async fn set_audio_meter_connection(
        &self,
        device: Option<String>,
        connected: bool,
    ) -> Result<()> {
        let changed = {
            let mut booth = self.state.booth.write().await;
            let device_changed = device
                .as_ref()
                .is_some_and(|device| booth.mixer.audio_meter_device.as_ref() != Some(device));
            let had_meters = !booth.mixer.meters.is_empty();
            if booth.mixer.audio_meter_connected == connected
                && !device_changed
                && (connected || !had_meters)
            {
                false
            } else {
                if let Some(device) = device {
                    booth.mixer.audio_meter_device = Some(device);
                }
                booth.mixer.audio_meter_connected = connected;
                if !connected {
                    booth.mixer.meters.clear();
                }
                booth.sequence += 1;
                booth.observed_at_us = elapsed_us(self.state.started);
                true
            }
        };
        if changed {
            self.broadcast_snapshot().await?;
        }
        Ok(())
    }

    pub async fn refresh_decks(&self, server: &DjLinkServer) -> Result<()> {
        let devices = server.list_devices().await;
        let mut decks = Vec::new();
        for device in devices {
            // OMNIS announces one appliance, but publishes independent deck status as 11/12.
            let players = if device.model.eq_ignore_ascii_case("OMNIS-DUO") {
                vec![11, 12]
            } else if device.player_number <= 6 {
                vec![device.player_number]
            } else {
                continue;
            };
            for player in players {
                let snapshot = server.monitor_snapshot(player).await;
                let mut deck = deck_state(
                    player,
                    device.model.clone(),
                    device.ip_addr.to_string(),
                    snapshot.deck.as_ref(),
                );
                hydrate_track_metadata(&mut deck, server);
                decks.push(deck);
            }
        }
        // Keep the appliance layout after a disconnect; do not replace an OMNIS
        // with three fictional CDJs while waiting for it to return.
        for previous in &self.state.booth.read().await.decks {
            if previous
                .model
                .as_deref()
                .is_some_and(|model| model.eq_ignore_ascii_case("OMNIS-DUO"))
                && !decks.iter().any(|deck| deck.player == previous.player)
            {
                let mut offline = disconnected_deck(previous.player);
                offline.model = previous.model.clone();
                offline.ip = previous.ip.clone();
                decks.push(offline);
            }
        }
        for player in 1..=3 {
            if !decks.iter().any(|deck| deck.player == player) {
                decks.push(disconnected_deck(player));
            }
        }
        decks.sort_by_key(|deck| deck.player);

        let changed = {
            let mut booth = self.state.booth.write().await;
            if booth.decks == decks {
                false
            } else {
                booth.decks = decks;
                booth.sequence += 1;
                booth.observed_at_us = elapsed_us(self.state.started);
                true
            }
        };
        if changed {
            self.broadcast_snapshot().await?;
        }
        Ok(())
    }

    pub async fn publish_djlink_event(
        &self,
        server: &DjLinkServer,
        event: DjLinkTelemetryEvent,
    ) -> Result<()> {
        if event.kind == DjLinkTelemetryKind::Device || event.deck.is_none() {
            return self.refresh_decks(server).await;
        }
        let telemetry = event.deck.expect("checked above");
        let updated = {
            let mut booth = self.state.booth.write().await;
            let Some(deck) = booth
                .decks
                .iter_mut()
                .find(|deck| deck.player == event.player)
            else {
                drop(booth);
                return self.refresh_decks(server).await;
            };
            let track_changed = deck.track_id != telemetry.track_id;
            if track_changed {
                clear_track_metadata(deck);
            }
            apply_telemetry(deck, &telemetry);
            if track_changed || deck.track_title.is_none() {
                hydrate_track_metadata(deck, server);
            }
            let updated = deck.clone();
            booth.sequence += 1;
            booth.observed_at_us = elapsed_us(self.state.started);
            (booth.sequence, booth.observed_at_us, updated)
        };
        let text = serde_json::to_string(&StreamMessage::Deck {
            schema_version: SCHEMA_VERSION,
            sequence: updated.0,
            observed_at_us: updated.1,
            source: "djLink",
            kind: telemetry_kind(event.kind),
            deck: &updated.2,
        })?;
        let _ = self.state.messages.send(text);
        Ok(())
    }

    async fn broadcast_snapshot(&self) -> Result<()> {
        let booth = self.state.booth.read().await;
        let text = serde_json::to_string(&StreamMessage::Snapshot {
            schema_version: SCHEMA_VERSION,
            snapshot: &booth,
        })?;
        let _ = self.state.messages.send(text);
        Ok(())
    }
}

fn disconnected_deck(player: u8) -> DeckState {
    DeckState {
        player,
        connected: false,
        source: "djLink",
        model: None,
        ip: None,
        active: false,
        on_air: None,
        source_player: None,
        source_slot: None,
        track_type: None,
        track_id: None,
        track_title: None,
        track_artist: None,
        track_album: None,
        track_artwork_url: None,
        playing: false,
        play_state: None,
        synced: false,
        tempo_master: false,
        bpm: None,
        effective_bpm: None,
        pitch_percent: None,
        beat_in_bar: None,
        beat_number: None,
        track_progress_percent: None,
        track_length_sec: None,
        playhead_ms: None,
        playhead_source: None,
        master_tempo: None,
        key_shift_cents: None,
        effective_key: None,
    }
}

fn deck_state(
    player: u8,
    model: String,
    ip: String,
    telemetry: Option<&DjLinkDeckState>,
) -> DeckState {
    let mut deck = disconnected_deck(player);
    deck.connected = true;
    deck.model = Some(model);
    deck.ip = Some(ip);
    let Some(telemetry) = telemetry else {
        return deck;
    };
    apply_telemetry(&mut deck, telemetry);
    deck
}

fn apply_telemetry(deck: &mut DeckState, telemetry: &DjLinkDeckState) {
    deck.playhead_source = telemetry.playhead_source;
    deck.master_tempo = telemetry.master_tempo;
    deck.key_shift_cents = telemetry.key_shift_cents;
    deck.effective_key = telemetry.effective_key.clone();
    deck.active = telemetry.active;
    deck.on_air = Some(telemetry.on_air);
    deck.source_player = Some(telemetry.source_player);
    deck.source_slot = Some(telemetry.source_slot);
    deck.track_type = Some(telemetry.track_type);
    deck.track_id = telemetry.track_id;
    deck.playing = telemetry.playing;
    deck.play_state = Some(telemetry.play_state);
    deck.synced = telemetry.synced;
    deck.tempo_master = telemetry.tempo_master;
    deck.bpm = telemetry.bpm_hundreds.map(|bpm| f64::from(bpm) / 100.0);
    deck.effective_bpm = telemetry
        .effective_bpm_hundreds
        .map(|bpm| bpm as f64 / 100.0);
    deck.pitch_percent = Some(f64::from(telemetry.pitch_centi_percent) / 100.0);
    deck.beat_in_bar = Some(telemetry.beat_in_bar);
    deck.beat_number = telemetry.beat_number;
    if let Some(progress) = telemetry.track_progress_milli {
        deck.track_progress_percent = Some(f64::from(progress) / 10.0);
    }
    if let Some(duration) = telemetry.track_length_sec {
        deck.track_length_sec = Some(duration);
    }
    if let Some(playhead) = telemetry.playhead_ms {
        deck.playhead_ms = Some(playhead);
    }
}

fn clear_track_metadata(deck: &mut DeckState) {
    deck.track_title = None;
    deck.track_artist = None;
    deck.track_album = None;
    deck.track_artwork_url = None;
    deck.track_progress_percent = None;
    deck.track_length_sec = None;
    deck.playhead_ms = None;
    deck.playhead_source = None;
    deck.master_tempo = None;
    deck.key_shift_cents = None;
    deck.effective_key = None;
}

fn hydrate_track_metadata(deck: &mut DeckState, server: &DjLinkServer) {
    let metadata = deck
        .track_id
        .and_then(|track_id| server.library_track_metadata(track_id));
    apply_track_metadata(deck, metadata.as_ref());
}

fn apply_track_metadata(deck: &mut DeckState, metadata: Option<&DjLinkTrackMetadata>) {
    deck.track_title = metadata.map(|track| track.title.clone());
    deck.track_artist = metadata.map(|track| track.artist.clone());
    deck.track_album = metadata.map(|track| track.album.clone());
    deck.track_artwork_url = metadata.and_then(|track| track.artwork_url.clone());
    if deck.track_length_sec.is_none() {
        deck.track_length_sec = metadata.map(|track| track.duration_sec);
    }
}

fn telemetry_kind(kind: DjLinkTelemetryKind) -> &'static str {
    match kind {
        DjLinkTelemetryKind::Device => "device",
        DjLinkTelemetryKind::Status => "status",
        DjLinkTelemetryKind::Beat => "beat",
        DjLinkTelemetryKind::Position => "position",
    }
}

fn elapsed_us(started: Instant) -> u64 {
    started.elapsed().as_micros().min(u128::from(u64::MAX)) as u64
}

fn raw_level_dbfs(level: f64) -> f64 {
    if level <= 0.0 {
        -120.0
    } else {
        (20.0 * (level / f64::from(u16::MAX)).log10()).max(-120.0)
    }
}

fn set_link_control(
    controls: &mut BTreeMap<String, ControlState>,
    path: String,
    label: String,
    value: u8,
    state: Option<&str>,
    changed_at_us: u64,
) {
    controls.insert(
        path,
        ControlState {
            label,
            value: Some(u16::from(value)),
            percent: Some(f64::from(value) * 100.0 / 255.0),
            state: state.map(str::to_string),
            raw: format!("{value:02X}"),
            changed_at_us,
        },
    );
}

fn crossfader_assign_state(value: u8) -> Option<&'static str> {
    match value {
        0 => Some("thru"),
        1 => Some("a"),
        2 => Some("b"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DjLinkMixerChannelState, DjLinkMixerState};
    use std::net::Ipv4Addr;

    fn test_publisher() -> StatePublisher {
        let (messages, _) = broadcast::channel(32);
        StatePublisher {
            state: BoothStateSource {
                booth: Arc::new(RwLock::new(BoothState {
                    schema_version: SCHEMA_VERSION,
                    sequence: 0,
                    observed_at_us: 0,
                    mixer: MixerState {
                        device: "DJM-A9".to_string(),
                        connected: true,
                        audio_meter_device: Some("DJM-A9".to_string()),
                        audio_meter_connected: true,
                        bpm: None,
                        controls: BTreeMap::new(),
                        meters: BTreeMap::new(),
                    },
                    decks: Vec::new(),
                    latest_mixer_frame: None,
                })),
                messages,
                started: Instant::now(),
            },
        }
    }

    fn mixer_event(control: &'static str, value: u16, timestamp_us: u64) -> DecodedEvent {
        DecodedEvent {
            elapsed_us: timestamp_us,
            timestamp_us,
            kind: "control",
            message: "controlChange",
            channel: Some(1),
            control: Some(control),
            label: Some(control),
            value: Some(value),
            percent: Some(value as f64 * 100.0 / 127.0),
            state: None,
            bpm: None,
            raw: "B0 00 00".to_string(),
        }
    }

    #[test]
    fn structured_link_state_maps_to_api_deck() {
        let telemetry = DjLinkDeckState {
            player: 3,
            active: true,
            on_air: true,
            source_player: 17,
            source_slot: 3,
            track_type: 1,
            track_id: Some(42),
            playing: true,
            play_state: "playing",
            synced: true,
            tempo_master: false,
            bpm_hundreds: Some(12_800),
            effective_bpm_hundreds: Some(12_864),
            pitch_centi_percent: 50,
            beat_in_bar: 3,
            beat_number: Some(193),
            track_progress_milli: Some(300),
            track_length_sec: Some(300),
            playhead_ms: Some(90_000),
            playhead_source: Some("precise"),
            master_tempo: Some(true),
            key_shift_cents: Some(100),
            effective_key: Some("Bbm".into()),
        };
        let deck = deck_state(
            3,
            "CDJ-3000".to_string(),
            "169.254.1.3".to_string(),
            Some(&telemetry),
        );

        assert_eq!(deck.effective_key.as_deref(), Some("Bbm"));
        assert_eq!(deck.playhead_source, Some("precise"));
        assert!(deck.connected);
        assert!(deck.playing);
        assert_eq!(deck.on_air, Some(true));
        assert_eq!(deck.track_id, Some(42));
        assert_eq!(deck.effective_bpm, Some(128.64));
        assert_eq!(deck.beat_number, Some(193));
        assert_eq!(deck.track_progress_percent, Some(30.0));
    }

    #[tokio::test]
    async fn concurrent_mixer_events_preserve_both_controls() {
        let publisher = test_publisher();
        let left = mixer_event("channel.1.eq.low", 24, 1_000);
        let right = mixer_event("channel.2.eq.low", 96, 1_001);

        let (left_result, right_result) = tokio::join!(
            publisher.publish_mixer_event(&left),
            publisher.publish_mixer_event(&right),
        );
        left_result.unwrap();
        right_result.unwrap();

        let booth = publisher.state.booth.read().await;
        assert_eq!(booth.sequence, 2);
        assert_eq!(booth.mixer.controls["channel.1.eq.low"].value, Some(24));
        assert_eq!(booth.mixer.controls["channel.2.eq.low"].value, Some(96));
    }

    #[tokio::test]
    async fn disconnected_usb_sources_clear_transient_state() {
        let publisher = test_publisher();
        {
            let mut booth = publisher.state.booth.write().await;
            booth.mixer.bpm = Some(128.0);
            booth.mixer.meters.insert(
                "usb.1_2".to_string(),
                MeterState {
                    pair: 1,
                    channels: [1, 2],
                    peak_dbfs: -1.0,
                    rms_dbfs: -6.0,
                    left_peak_dbfs: -1.0,
                    right_peak_dbfs: -2.0,
                    left_rms_dbfs: -6.0,
                    right_rms_dbfs: -7.0,
                    changed_at_us: 1,
                },
            );
        }

        publisher.set_mixer_connected(false).await.unwrap();
        publisher
            .set_audio_meter_connection(Some("DJM-A9".to_string()), false)
            .await
            .unwrap();

        let booth = publisher.state.booth.read().await;
        assert!(!booth.mixer.connected);
        assert!(!booth.mixer.audio_meter_connected);
        assert_eq!(booth.mixer.bpm, None);
        assert!(booth.mixer.meters.is_empty());
    }

    #[tokio::test]
    async fn ethernet_a9_state_populates_mixer_controls_without_usb() {
        let publisher = test_publisher();
        publisher.set_mixer_connected(false).await.unwrap();
        let channel = |number, value, assign| DjLinkMixerChannelState {
            channel: number,
            input_source: number,
            trim: value,
            eq_high: value,
            eq_mid: value,
            eq_low: value,
            color: value,
            fader: value,
            crossfader_assign: assign,
        };
        publisher
            .publish_djlink_mixer_event(DjLinkMixerTelemetryEvent {
                source_ip: Ipv4Addr::new(169, 254, 1, 33),
                mixer: DjLinkMixerState {
                    channels: [
                        channel(1, 0, 0),
                        channel(2, 64, 1),
                        channel(3, 128, 2),
                        channel(4, 255, 0),
                    ],
                    crossfader: 120,
                },
                raw_packet: vec![0; 266],
            })
            .await
            .unwrap();

        let booth = publisher.state.booth.read().await;
        assert!(booth.mixer.connected);
        assert_eq!(booth.mixer.controls["channel.3.eq.low"].value, Some(128));
        assert_eq!(
            booth.mixer.controls["channel.3.crossfaderAssign"]
                .state
                .as_deref(),
            Some("b")
        );
        assert_eq!(
            booth.mixer.controls["crossfader.position"].percent,
            Some(120.0 * 100.0 / 255.0)
        );
    }

    #[tokio::test]
    async fn ethernet_a9_vu_populates_stereo_channel_meter() {
        let publisher = test_publisher();
        publisher
            .publish_djlink_vu_event(DjLinkVuTelemetryEvent {
                source_ip: Ipv4Addr::new(169, 254, 69, 43),
                channels: BTreeMap::from([
                    (1, vec![[u16::MAX, u16::MAX / 2]; 15]),
                    (2, vec![[0, 0]; 15]),
                ]),
            })
            .await
            .unwrap();

        let booth = publisher.state.booth.read().await;
        let channel = &booth.mixer.meters["ethernet.1"];
        assert_eq!(channel.channels, [1, 2]);
        assert_eq!(channel.left_peak_dbfs, 0.0);
        assert!((-6.1..-6.0).contains(&channel.right_peak_dbfs));
        assert_eq!(booth.mixer.meters["ethernet.2"].peak_dbfs, -120.0);
    }
}
impl StatePublisher {
    pub fn new(
        mixer_device: String,
        mixer_connected: bool,
        audio_meter_device: Option<String>,
        audio_meter_connected: bool,
    ) -> Self {
        let (messages, _) = broadcast::channel(4096);
        Self {
            state: BoothStateSource {
                booth: Arc::new(RwLock::new(BoothState {
                    schema_version: SCHEMA_VERSION,
                    sequence: 0,
                    observed_at_us: 0,
                    mixer: MixerState {
                        device: mixer_device,
                        connected: mixer_connected,
                        audio_meter_device,
                        audio_meter_connected,
                        bpm: None,
                        controls: BTreeMap::new(),
                        meters: BTreeMap::new(),
                    },
                    decks: (1..=3).map(disconnected_deck).collect(),
                    latest_mixer_frame: None,
                })),
                messages,
                started: Instant::now(),
            },
        }
    }
    pub fn subscribe(&self) -> broadcast::Receiver<String> {
        self.state.messages.subscribe()
    }
    pub async fn snapshot(&self) -> serde_json::Value {
        let booth = self.state.booth.read().await;
        serde_json::to_value(StreamMessage::Snapshot {
            schema_version: SCHEMA_VERSION,
            snapshot: &booth,
        })
        .expect("booth serialization")
    }
}
