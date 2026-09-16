//! Premium playback, following ncspot's separate Web API / librespot sessions.
//! No audio cache, file export, analysis, provider tokens, or network listener in this bridge.
use anyhow::{Context, Result, bail, ensure};
use librespot_core::{
    SpotifyUri, authentication::Credentials, config::SessionConfig, session::Session,
};
use librespot_playback::{
    audio_backend::{Sink, SinkError, SinkResult},
    config::{Bitrate, PlayerConfig},
    convert::Converter,
    decoder::AudioPacket,
    mixer::NoOpVolume,
    player::{Player, PlayerEvent},
};
use librespot_protocol::authentication::AuthenticationType;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::runtime::Runtime;

static ENGINE: Mutex<Option<Engine>> = Mutex::new(None);
static RUNTIME: OnceLock<Runtime> = OnceLock::new();
const CLIENT_ID: &str = "65b708073fc0480ea92a077233ca87bd";
struct Engine {
    session: Session,
    player: Arc<Player>,
    state: Arc<Mutex<Value>>,
}
impl Drop for Engine {
    fn drop(&mut self) {
        self.player.stop();
        self.session.shutdown();
    }
}
fn runtime() -> Result<&'static Runtime> {
    if RUNTIME.get().is_none() {
        let value = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        let _ = RUNTIME.set(value);
    }
    RUNTIME.get().context("Streaming runtime unavailable")
}

// Bounded PCM buffer consumed by AVAudioSourceNode. Apple's mixer handles device sample
// rates and route changes; no second desktop audio backend or process is embedded.
static PCM: OnceLock<Mutex<std::collections::VecDeque<f32>>> = OnceLock::new();
static AUDIBLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
fn pcm() -> &'static Mutex<std::collections::VecDeque<f32>> {
    PCM.get_or_init(|| Mutex::new(std::collections::VecDeque::with_capacity(22050)))
}
fn clear_pcm() {
    if let Ok(mut buffer) = pcm().lock() {
        buffer.clear();
    }
}
struct PhoneSink;
impl Sink for PhoneSink {
    fn start(&mut self) -> SinkResult<()> {
        Ok(())
    }
    fn stop(&mut self) -> SinkResult<()> {
        clear_pcm();
        Ok(())
    }
    fn write(&mut self, packet: AudioPacket, converter: &mut Converter) -> SinkResult<()> {
        let samples = packet
            .samples()
            .map_err(|_| SinkError::OnWrite("Invalid audio packet".into()))?;
        let converted = converter.f64_to_f32(samples);
        for chunk in converted.chunks(4096) {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                if !AUDIBLE.load(std::sync::atomic::Ordering::Relaxed) {
                    return Ok(());
                }
                {
                    let mut buffer = pcm()
                        .lock()
                        .map_err(|_| SinkError::OnWrite("Audio buffer unavailable".into()))?;
                    if buffer.len() + chunk.len() <= 22050 {
                        buffer.extend(chunk);
                        break;
                    }
                }
                if std::time::Instant::now() > deadline {
                    return Err(SinkError::OnWrite("Audio output stalled".into()));
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        Ok(())
    }
}
/// Nonblocking, allocation-free audio render callback. Missing samples are silence.
/// # Safety
/// Both output pointers must have space for `frames` floats and must not overlap.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn djbooth_spotify_read(left: *mut f32, right: *mut f32, frames: usize) {
    if left.is_null() || right.is_null() {
        return;
    }
    let left = unsafe { std::slice::from_raw_parts_mut(left, frames) };
    let right = unsafe { std::slice::from_raw_parts_mut(right, frames) };
    left.fill(0.0);
    right.fill(0.0);
    if !AUDIBLE.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    let Some(buffer) = PCM.get() else { return };
    if let Ok(mut buffer) = buffer.try_lock() {
        for (left, right) in left.iter_mut().zip(right.iter_mut()) {
            *left = buffer.pop_front().unwrap_or(0.0);
            *right = buffer.pop_front().unwrap_or(0.0);
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connect {
    expected_account: String,
    device_id: String,
    credentials: Option<String>,
    access_token: Option<String>,
}

pub fn request(operation: &str, input: &str) -> Result<Value> {
    let mut engine = ENGINE
        .lock()
        .map_err(|_| anyhow::anyhow!("Streaming state unavailable"))?;
    if operation == "disconnect" {
        AUDIBLE.store(false, std::sync::atomic::Ordering::Relaxed);
        clear_pcm();
        *engine = None;
        return Ok(json!({}));
    }
    if operation == "connect" {
        let input: Connect = serde_json::from_str(input)?;
        ensure!(
            !input.expected_account.is_empty(),
            "Reconnect Spotify to verify its account identity."
        );
        let credentials = match input.credentials {
            Some(value) => serde_json::from_str::<Credentials>(&value)?,
            None => Credentials::with_access_token(
                input
                    .access_token
                    .context("Enable Spotify streaming first")?,
            ),
        };
        let rt = runtime()?;
        let session = rt.block_on(async {
            let session = Session::new(
                SessionConfig {
                    client_id: CLIENT_ID.into(),
                    device_id: input.device_id,
                    ..Default::default()
                },
                None,
            );
            tokio::time::timeout(Duration::from_secs(25), session.connect(credentials, false))
                .await
                .context("Spotify connection timed out")?
                .map_err(|_| anyhow::anyhow!("Spotify streaming login expired. Sign in again."))?;
            Ok::<_, anyhow::Error>(session)
        })?;
        if session.username() != input.expected_account {
            session.shutdown();
            bail!("Sign in to the same Spotify account connected through Nanocodex.");
        }
        let reusable = Credentials {
            username: Some(session.username()),
            auth_type: AuthenticationType::AUTHENTICATION_STORED_SPOTIFY_CREDENTIALS,
            auth_data: session.auth_data(),
        };
        let state = Arc::new(Mutex::new(
            json!({"track": "", "playing": false, "position": 0, "ended": false}),
        ));
        let player = {
            let _entered = rt.enter();
            Player::new(
                PlayerConfig {
                    bitrate: Bitrate::Bitrate160,
                    gapless: false,
                    position_update_interval: Some(Duration::from_millis(500)),
                    ..Default::default()
                },
                session.clone(),
                Box::new(NoOpVolume),
                move || Box::new(PhoneSink),
            )
        };
        let mut events = player.get_player_event_channel();
        let observed = state.clone();
        rt.spawn(async move {
            while let Some(event) = events.recv().await {
                let Ok(mut state) = observed.lock() else { break };
                if let PlayerEvent::PlayRequestIdChanged { play_request_id } = &event {
                    let next = state["pendingLoads"].as_array_mut().and_then(|pending| {
                        if pending.is_empty() { None } else { Some(pending.remove(0)) }
                    });
                    if next.as_ref() == Some(&state["requestID"]) {
                        state["playerRequestID"] = json!(play_request_id);
                    }
                    continue;
                }
                if let Some(id) = event.get_play_request_id() {
                    if state["playerRequestID"].as_u64() != Some(id) { continue; }
                }
                match event {
                    PlayerEvent::Playing { track_id, position_ms, .. } | PlayerEvent::PositionChanged { track_id, position_ms, .. } => {
                        if state["track"].as_str() == track_id.to_uri().ok().as_deref() { state["position"] = json!(position_ms); state["playing"] = json!(true); }
                    }
                    PlayerEvent::Paused { track_id, position_ms, .. } => {
                        if state["track"].as_str() == track_id.to_uri().ok().as_deref() { state["position"] = json!(position_ms); state["playing"] = json!(false); }
                    }
                    PlayerEvent::EndOfTrack { track_id, .. } => { if state["track"].as_str() == track_id.to_uri().ok().as_deref() { state["playing"] = json!(false); state["ended"] = json!(true); } }
                    PlayerEvent::Unavailable { track_id, .. } => { if state["track"].as_str() == track_id.to_uri().ok().as_deref() { state["playing"] = json!(false); state["error"] = json!("Spotify could not play this track. Check Premium and regional availability."); } }
                    _ => {}
                }
            }
        });
        *engine = Some(Engine {
            session,
            player,
            state,
        });
        return Ok(json!({"credentials": serde_json::to_string(&reusable)?}));
    }
    let engine = engine.as_ref().context("Enable Spotify streaming first")?;
    let input: Value = serde_json::from_str(input)?;
    if !["load", "status"].contains(&operation)
        && engine
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("Streaming state unavailable"))?["requestID"]
            != input["requestID"]
    {
        return Ok(json!({}));
    }
    match operation {
        "load" => {
            let uri = input["uri"].as_str().context("Missing track")?;
            let track = SpotifyUri::from_uri(uri)?;
            ensure!(
                matches!(track, SpotifyUri::Track { .. }),
                "Only tracks can be streamed"
            );
            let mut state = engine
                .state
                .lock()
                .map_err(|_| anyhow::anyhow!("Streaming state unavailable"))?;
            let mut pending = state["pendingLoads"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            pending.push(input["requestID"].clone());
            *state = json!({"track": uri, "requestID": input["requestID"], "pendingLoads": pending,
                "playing": false, "position": 0, "ended": false});
            drop(state);
            clear_pcm();
            AUDIBLE.store(true, std::sync::atomic::Ordering::Relaxed);
            engine.player.load(track, true, position(&input)?);
        }
        "play" => {
            AUDIBLE.store(true, std::sync::atomic::Ordering::Relaxed);
            engine.player.play();
        }
        "pause" => {
            AUDIBLE.store(false, std::sync::atomic::Ordering::Relaxed);
            clear_pcm();
            engine.player.pause();
        }
        "stop" => {
            AUDIBLE.store(false, std::sync::atomic::Ordering::Relaxed);
            clear_pcm();
            engine.player.stop();
        }
        "seek" => {
            clear_pcm();
            engine.player.seek(position(&input)?);
        }
        "status" => {
            return Ok(engine
                .state
                .lock()
                .map_err(|_| anyhow::anyhow!("Streaming state unavailable"))?
                .clone());
        }
        _ => bail!("Unknown streaming operation"),
    }
    Ok(json!({}))
}
fn position(input: &Value) -> Result<u32> {
    let value = input["position"].as_u64().unwrap_or(0);
    ensure!(value <= u32::MAX as u64, "Invalid playback position");
    Ok(value as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stereo_pcm_is_planar_silent_when_paused_and_silent_on_underrun() {
        clear_pcm();
        pcm().lock().unwrap().extend([0.1, 0.2, 0.3, 0.4]);
        let mut left = [9.0; 3];
        let mut right = [9.0; 3];
        AUDIBLE.store(false, std::sync::atomic::Ordering::Relaxed);
        unsafe { djbooth_spotify_read(left.as_mut_ptr(), right.as_mut_ptr(), 3) };
        assert_eq!(left, [0.0; 3]);
        assert_eq!(right, [0.0; 3]);
        AUDIBLE.store(true, std::sync::atomic::Ordering::Relaxed);
        unsafe { djbooth_spotify_read(left.as_mut_ptr(), right.as_mut_ptr(), 3) };
        assert_eq!(left, [0.1, 0.3, 0.0]);
        assert_eq!(right, [0.2, 0.4, 0.0]);
        AUDIBLE.store(false, std::sync::atomic::Ordering::Relaxed);
    }
    #[test]
    fn seek_position_rejects_overflow() {
        assert!(position(&json!({"position": 4294967296_u64})).is_err());
        assert_eq!(position(&json!({"position": 1234})).unwrap(), 1234);
    }
}
