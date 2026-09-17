use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::Router;
use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use djtools_link::DjLinkServer;
pub(crate) use djtools_link::booth::StatePublisher;
use djtools_link::booth::{BoothStateSource, SCHEMA_VERSION, StreamMessage};
use serde_json::json;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::audio_stream::{AudioStreamSource, open_live_mp3};

pub(crate) struct StateApiConfig {
    pub(crate) bind: SocketAddr,
    pub(crate) mixer_device: String,
    pub(crate) mixer_connected: bool,
    pub(crate) audio_meter_device: Option<String>,
    pub(crate) audio_meter_connected: bool,
    pub(crate) audio_stream: AudioStreamSource,
    pub(crate) djlink: Arc<DjLinkServer>,
}

pub(crate) struct StateApiServer {
    publisher: StatePublisher,
    task: JoinHandle<()>,
    pub(crate) address: SocketAddr,
}

#[derive(Clone)]
struct ApiState {
    shared: BoothStateSource,
    djlink: Option<Arc<DjLinkServer>>,
    audio_stream: AudioStreamSource,
}
impl std::ops::Deref for ApiState {
    type Target = BoothStateSource;
    fn deref(&self) -> &Self::Target {
        &self.shared
    }
}

impl StateApiServer {
    pub(crate) async fn start(config: StateApiConfig) -> Result<Self> {
        let publisher = StatePublisher::new(
            config.mixer_device,
            config.mixer_connected,
            config.audio_meter_device,
            config.audio_meter_connected,
        );
        let state = ApiState {
            shared: publisher.state.clone(),
            djlink: Some(config.djlink),
            audio_stream: config.audio_stream,
        };
        let app = Router::new()
            .route("/", get(discovery))
            .route("/health", get(health))
            .route("/v1/state", get(current_state))
            .route("/v1/debug/mixer-frame", get(current_mixer_frame))
            .route("/v1/tracks/{track_id}/waveform", get(track_waveform))
            .route("/v1/audio/master.mp3", get(live_master_audio))
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
            publisher,
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

async fn discovery() -> impl IntoResponse {
    axum::Json(json!({
        "name": "djbooth state API",
        "schemaVersion": SCHEMA_VERSION,
        "state": "/v1/state",
        "waveform": "/v1/tracks/{trackId}/waveform",
        "masterAudio": "/v1/audio/master.mp3",
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

async fn live_master_audio(State(state): State<ApiState>) -> Response {
    let stream = match open_live_mp3(&state.audio_stream) {
        Ok(stream) => stream,
        Err(error) => {
            return (StatusCode::SERVICE_UNAVAILABLE, format!("{error}\n")).into_response();
        }
    };
    Response::builder()
        .header(header::CONTENT_TYPE, "audio/mpeg")
        .header(header::CACHE_CONTROL, "no-store")
        .header("icy-name", "djbooth master")
        .body(Body::from_stream(stream))
        .expect("live audio response headers are valid")
}

async fn health(State(state): State<ApiState>) -> impl IntoResponse {
    let booth = state.booth.read().await;
    axum::Json(json!({
        "ok": true,
        "schemaVersion": SCHEMA_VERSION,
        "sequence": booth.sequence,
        "mixerConnected": booth.mixer.connected,
        "masterAudioConnected": state.audio_stream.is_connected(),
        "connectedDecks": booth.decks.iter().filter(|deck| deck.connected).count(),
    }))
}

async fn current_state(State(state): State<ApiState>) -> impl IntoResponse {
    axum::Json(state.booth.read().await.clone())
}

async fn current_mixer_frame(State(state): State<ApiState>) -> Response {
    match state.booth.read().await.latest_mixer_frame.clone() {
        Some(frame) => axum::Json(frame).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
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
