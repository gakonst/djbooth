use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result};
use axum::Router;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use djtools_link::{
    DjLinkDeckState, DjLinkMixerTelemetryEvent, DjLinkServer, DjLinkTelemetryEvent,
    DjLinkTelemetryKind, DjLinkTrackMetadata,
};
use serde::Serialize;
use serde_json::json;
use tokio::sync::{RwLock, broadcast};
use tokio::task::JoinHandle;

use crate::audio_meter::MeterFrame;
use crate::mixer::DecodedEvent;

const SCHEMA_VERSION: u32 = 1;

pub(crate) struct StateApiConfig {
    pub(crate) bind: SocketAddr,
    pub(crate) mixer_device: String,
    pub(crate) mixer_connected: bool,
    pub(crate) audio_meter_device: Option<String>,
    pub(crate) audio_meter_connected: bool,
    pub(crate) djlink: Arc<DjLinkServer>,
}

pub(crate) struct StateApiServer {
    publisher: StatePublisher,
    task: JoinHandle<()>,
    pub(crate) address: SocketAddr,
}

#[derive(Clone)]
pub(crate) struct StatePublisher {
    state: ApiState,
}

#[derive(Clone)]
struct ApiState {
    booth: Arc<RwLock<BoothState>>,
    messages: broadcast::Sender<String>,
    started: Instant,
    djlink: Option<Arc<DjLinkServer>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BoothState {
    schema_version: u32,
    sequence: u64,
    observed_at_us: u64,
    mixer: MixerState,
    decks: Vec<DeckState>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MixerState {
    device: String,
    connected: bool,
    audio_meter_device: Option<String>,
    audio_meter_connected: bool,
    bpm: Option<f64>,
    controls: BTreeMap<String, ControlState>,
    meters: BTreeMap<String, MeterState>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MeterState {
    pair: u8,
    channels: [u8; 2],
    peak_dbfs: f64,
    rms_dbfs: f64,
    left_peak_dbfs: f64,
    right_peak_dbfs: f64,
    left_rms_dbfs: f64,
    right_rms_dbfs: f64,
    changed_at_us: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlState {
    label: String,
    value: Option<u16>,
    percent: Option<f64>,
    state: Option<String>,
    raw: String,
    changed_at_us: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeckState {
    player: u8,
    connected: bool,
    source: &'static str,
    model: Option<String>,
    ip: Option<String>,
    active: bool,
    source_player: Option<u8>,
    source_slot: Option<u8>,
    track_type: Option<u8>,
    track_id: Option<u32>,
    track_title: Option<String>,
    track_artist: Option<String>,
    track_album: Option<String>,
    track_artwork_url: Option<String>,
    playing: bool,
    play_state: Option<&'static str>,
    synced: bool,
    tempo_master: bool,
    bpm: Option<f64>,
    effective_bpm: Option<f64>,
    pitch_percent: Option<f64>,
    beat_in_bar: Option<u8>,
    beat_number: Option<u32>,
    track_progress_percent: Option<f64>,
    track_length_sec: Option<u32>,
    playhead_ms: Option<u32>,
}

#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum StreamMessage<'a> {
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

impl StateApiServer {
    pub(crate) async fn start(config: StateApiConfig) -> Result<Self> {
        let (messages, _) = broadcast::channel(1_024);
        let state = ApiState {
            booth: Arc::new(RwLock::new(BoothState {
                schema_version: SCHEMA_VERSION,
                sequence: 0,
                observed_at_us: 0,
                mixer: MixerState {
                    device: config.mixer_device,
                    connected: config.mixer_connected,
                    audio_meter_device: config.audio_meter_device,
                    audio_meter_connected: config.audio_meter_connected,
                    bpm: None,
                    controls: BTreeMap::new(),
                    meters: BTreeMap::new(),
                },
                decks: vec![disconnected_deck(1), disconnected_deck(2)],
            })),
            messages,
            started: Instant::now(),
            djlink: Some(config.djlink),
        };
        let app = Router::new()
            .route("/", get(discovery))
            .route("/health", get(health))
            .route("/v1/state", get(current_state))
            .route("/v1/tracks/{track_id}/waveform", get(track_waveform))
            .route("/v1/events", any(websocket))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind(config.bind)
            .await
            .with_context(|| format!("failed to bind state API to {}", config.bind))?;
        let address = listener.local_addr()?;
        let task = tokio::spawn(async move {
            if let Err(error) = axum::serve(listener, app).await {
                tracing::error!(%error, "state_api_server_failed");
            }
        });
        Ok(Self {
            publisher: StatePublisher { state },
            task,
            address,
        })
    }

    pub(crate) fn publisher(&self) -> StatePublisher {
        self.publisher.clone()
    }

    pub(crate) async fn stop(self) {
        self.task.abort();
        let _ = self.task.await;
    }
}

impl StatePublisher {
    pub(crate) async fn publish_djlink_mixer_event(
        &self,
        event: DjLinkMixerTelemetryEvent,
    ) -> Result<()> {
        let observed_at_us = elapsed_us(self.state.started);
        {
            let mut booth = self.state.booth.write().await;
            booth.sequence += 1;
            booth.observed_at_us = observed_at_us;
            booth.mixer.connected = true;
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

    pub(crate) async fn publish_meter_frame(&self, frame: &MeterFrame) -> Result<()> {
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

    pub(crate) async fn publish_mixer_event(&self, event: &DecodedEvent) -> Result<()> {
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

    pub(crate) async fn set_mixer_connected(&self, connected: bool) -> Result<()> {
        self.set_mixer_connection(None, connected).await
    }

    pub(crate) async fn set_mixer_connection(
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

    pub(crate) async fn set_audio_meter_connection(
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

    pub(crate) async fn refresh_decks(&self, server: &DjLinkServer) -> Result<()> {
        let devices = server.list_devices().await;
        let mut decks = Vec::new();
        for device in devices
            .into_iter()
            .filter(|device| device.player_number <= 6)
        {
            let snapshot = server.monitor_snapshot(device.player_number).await;
            let mut deck = deck_state(
                device.player_number,
                device.model,
                device.ip_addr.to_string(),
                snapshot.deck.as_ref(),
            );
            hydrate_track_metadata(&mut deck, server);
            decks.push(deck);
        }
        if decks.is_empty() {
            decks.extend([disconnected_deck(1), disconnected_deck(2)]);
        }

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

    pub(crate) async fn publish_djlink_event(
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

async fn discovery() -> impl IntoResponse {
    axum::Json(json!({
        "name": "djbooth state API",
        "schemaVersion": SCHEMA_VERSION,
        "state": "/v1/state",
        "waveform": "/v1/tracks/{trackId}/waveform",
        "events": "/v1/events",
        "health": "/health",
    }))
}

async fn track_waveform(Path(track_id): Path<u32>, State(state): State<ApiState>) -> Response {
    let Some(djlink) = state.djlink.as_ref() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let Some(waveform) = djlink.library_waveform(track_id).await else {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(json!({"error": format!("track {track_id} is not in the served library")})),
        )
            .into_response();
    };
    let source = if waveform.peaks.is_empty() {
        "placeholder"
    } else {
        "rekordbox"
    };
    axum::Json(json!({
        "durationSeconds": waveform.duration_seconds,
        "peaks": waveform.peaks,
        "colors": waveform.colors,
        "beatGrid": waveform.beat_grid.into_iter().map(|entry| json!({
            "beat": entry.beat,
            "timeSeconds": entry.time_seconds,
        })).collect::<Vec<_>>(),
        "source": source,
    }))
    .into_response()
}

async fn health(State(state): State<ApiState>) -> impl IntoResponse {
    let booth = state.booth.read().await;
    axum::Json(json!({
        "ok": true,
        "schemaVersion": SCHEMA_VERSION,
        "sequence": booth.sequence,
        "mixerConnected": booth.mixer.connected,
        "connectedDecks": booth.decks.iter().filter(|deck| deck.connected).count(),
    }))
}

async fn current_state(State(state): State<ApiState>) -> impl IntoResponse {
    axum::Json(state.booth.read().await.clone())
}

async fn websocket(ws: WebSocketUpgrade, State(state): State<ApiState>) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(mut socket: WebSocket, state: ApiState) {
    if send_snapshot(&mut socket, &state).await.is_err() {
        return;
    }
    let mut messages = state.messages.subscribe();
    loop {
        tokio::select! {
            outgoing = messages.recv() => match outgoing {
                Ok(text) => {
                    if socket.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if send_snapshot(&mut socket, &state).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
        }
    }
}

async fn send_snapshot(socket: &mut WebSocket, state: &ApiState) -> Result<(), axum::Error> {
    let booth = state.booth.read().await;
    let text = serde_json::to_string(&StreamMessage::Snapshot {
        schema_version: SCHEMA_VERSION,
        snapshot: &booth,
    })
    .expect("booth state is serializable");
    socket.send(Message::Text(text.into())).await
}

fn disconnected_deck(player: u8) -> DeckState {
    DeckState {
        player,
        connected: false,
        source: "djLink",
        model: None,
        ip: None,
        active: false,
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
    deck.active = telemetry.active;
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
    use djtools_link::{DjLinkMixerChannelState, DjLinkMixerState};
    use std::net::Ipv4Addr;

    fn test_publisher() -> StatePublisher {
        let (messages, _) = broadcast::channel(32);
        StatePublisher {
            state: ApiState {
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
                })),
                messages,
                started: Instant::now(),
                djlink: None,
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
        };
        let deck = deck_state(
            3,
            "CDJ-3000".to_string(),
            "169.254.1.3".to_string(),
            Some(&telemetry),
        );

        assert!(deck.connected);
        assert!(deck.playing);
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
}
