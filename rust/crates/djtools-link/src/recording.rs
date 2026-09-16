//! Durable performance capture. Protocol reduction stays shared with the web booth.
use crate::{
    DjLinkServer,
    booth::StatePublisher,
    mixer::{Decoder, RawMidiEvent},
};
use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    fs::{File, OpenOptions},
    io::{BufWriter, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock, RwLock,
        atomic::{AtomicU64, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tokio::sync::{broadcast, mpsc, oneshot};

#[derive(Clone, Serialize)]
struct Packet {
    host_time_ns: u64,
    local: SocketAddr,
    peer: SocketAddr,
    bytes: Vec<u8>,
}
static PACKETS: OnceLock<broadcast::Sender<Packet>> = OnceLock::new();

pub(crate) fn packet(local: SocketAddr, peer: SocketAddr, bytes: &[u8]) {
    if !(50000..=50002).contains(&local.port()) {
        return;
    }
    if let Some(sender) = PACKETS.get()
        && sender.receiver_count() > 0
    {
        let _ = sender.send(Packet {
            host_time_ns: host_time_ns(),
            local,
            peer,
            bytes: bytes.to_vec(),
        });
    }
}

/// Same monotonic hardware clock as AVAudioTime/CoreMIDI, independent of wall-clock edits.
#[cfg(target_vendor = "apple")]
#[allow(deprecated)] // Existing libc Mach ABI; matches CoreMIDI and AVAudioTime clocks.
pub fn host_time_ns() -> u64 {
    let mut timebase: libc::mach_timebase_info = unsafe { std::mem::zeroed() };
    unsafe { libc::mach_timebase_info(&mut timebase) };
    ((unsafe { libc::mach_absolute_time() } as u128 * timebase.numer as u128)
        / timebase.denom.max(1) as u128) as u64
}
#[cfg(not(target_vendor = "apple"))]
pub fn host_time_ns() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_nanos() as u64
}

enum Input {
    Midi {
        source: String,
        timestamp_us: u64,
        bytes: Vec<u8>,
    },
    Event {
        kind: String,
        payload: Value,
    },
}

#[derive(Default)]
struct Progress {
    rows: AtomicU64,
    gaps: AtomicU64,
    deck_events: AtomicU64,
    mixer_events: AtomicU64,
    midi_packets: AtomicU64,
    audio_frames: AtomicU64,
    error: Mutex<Option<String>>,
}

pub struct BoothRecording {
    directory: PathBuf,
    started: Instant,
    elapsed_at_stop: Option<f64>,
    progress: Arc<Progress>,
    input: mpsc::Sender<Input>,
    stop: Option<oneshot::Sender<()>>,
    worker: Option<JoinHandle<()>>,
}
impl BoothRecording {
    pub fn start(
        server: Arc<RwLock<DjLinkServer>>,
        directory: &Path,
        tracks: Value,
    ) -> Result<Self> {
        anyhow::ensure!(
            directory.is_absolute(),
            "Recording directory must be absolute"
        );
        std::fs::create_dir_all(directory)?;
        // Never truncate an earlier performance.
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(directory.join("events.jsonl"))?;
        let (input, incoming) = mpsc::channel(2048);
        let (stop, stopped) = oneshot::channel();
        let progress = Arc::new(Progress::default());
        let report = progress.clone();
        let mut writer = Timeline::new(file, report.clone());
        writer.write(
            "recordingStarted",
            json!({"schemaVersion":1,"tracks":tracks,
            "audioFile":"master.caf", "reconstruction": {
                "mixerInitialState":"unknownUntilObserved", "mixerDsp":"notModelled",
                "sourceAudio":"referencesOnly", "masterAudio":"pending", "audioRouting":"deviceConfiguredChannels", "bitExactResynthesis":false
            }}),
        )?;
        writer.flush()?;
        let (ready, initialized) = std::sync::mpsc::sync_channel(1);
        let worker = std::thread::Builder::new()
            .name("booth-recording".into())
            .spawn(move || {
                let result = (|| -> Result<()> {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()?;
                    runtime.block_on(capture(server, &mut writer, incoming, stopped, ready))
                })();
                if let Err(error) = result {
                    *report.error.lock().unwrap() = Some(error.to_string());
                    let _ = writer.write("recorderError", json!({"error":error.to_string()}));
                }
                if let Err(error) = writer.flush() {
                    *report.error.lock().unwrap() = Some(error.to_string());
                }
            })?;
        if initialized.recv().is_err() {
            let _ = worker.join();
            anyhow::bail!(
                progress
                    .error
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| "Recorder failed to initialize".into())
            );
        }
        Ok(Self {
            directory: directory.into(),
            started: Instant::now(),
            elapsed_at_stop: None,
            progress,
            input,
            stop: Some(stop),
            worker: Some(worker),
        })
    }
    pub fn event(&self, kind: String, payload: Value) -> Result<()> {
        self.send(Input::Event { kind, payload })
    }
    pub fn midi(&self, source: String, timestamp_us: u64, bytes: Vec<u8>) -> Result<()> {
        anyhow::ensure!(bytes.len() <= 4096, "MIDI packet exceeds capture limit");
        self.send(Input::Midi {
            source,
            timestamp_us,
            bytes,
        })
    }
    fn send(&self, input: Input) -> Result<()> {
        self.input.try_send(input).map_err(|error| {
            self.progress.gaps.fetch_add(1, Ordering::Relaxed);
            anyhow::anyhow!("Recording input unavailable: {error}")
        })
    }
    pub fn status(&self) -> Value {
        json!({"recording":self.worker.as_ref().is_some_and(|worker| !worker.is_finished()),
            "directory":self.directory,"elapsedSeconds":self.elapsed_at_stop.unwrap_or_else(|| self.started.elapsed().as_secs_f64()),
            "rows":self.progress.rows.load(Ordering::Relaxed),"gaps":self.progress.gaps.load(Ordering::Relaxed),
            "deckEvents":self.progress.deck_events.load(Ordering::Relaxed),
            "mixerEvents":self.progress.mixer_events.load(Ordering::Relaxed),
            "midiPackets":self.progress.midi_packets.load(Ordering::Relaxed),
            "audioFrames":self.progress.audio_frames.load(Ordering::Relaxed),
            "error":*self.progress.error.lock().unwrap()})
    }
    pub fn stop(&mut self) -> Result<Value> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(worker) = self.worker.take() {
            worker
                .join()
                .map_err(|_| anyhow::anyhow!("Recording worker panicked"))?;
        }
        self.elapsed_at_stop
            .get_or_insert_with(|| self.started.elapsed().as_secs_f64());
        let status = self.status();
        if let Some(error) = self.progress.error.lock().unwrap().clone() {
            anyhow::bail!(error);
        }
        Ok(status)
    }
}
impl Drop for BoothRecording {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

struct Timeline {
    output: BufWriter<File>,
    progress: Arc<Progress>,
    started_ns: u64,
    started_wall: chrono::DateTime<chrono::Utc>,
}
impl Timeline {
    fn new(file: File, progress: Arc<Progress>) -> Self {
        Self {
            output: BufWriter::new(file),
            progress,
            started_ns: host_time_ns(),
            started_wall: chrono::Utc::now(),
        }
    }
    fn write(&mut self, kind: &str, payload: Value) -> Result<()> {
        let now = host_time_ns();
        let at = self.started_wall
            + chrono::Duration::microseconds((now.saturating_sub(self.started_ns) / 1000) as i64);
        let sequence = self.progress.rows.load(Ordering::Relaxed) + 1;
        serde_json::to_writer(
            &mut self.output,
            &json!({"capturedAt":at.to_rfc3339_opts(chrono::SecondsFormat::Micros,true),
            "capturedUnixUs":at.timestamp_micros(),"monotonicNs":now.to_string(),"sequence":sequence,"kind":kind,"payload":payload}),
        )?;
        self.output.write_all(b"\n")?;
        match kind {
            "deckRaw" => {
                self.progress.deck_events.fetch_add(1, Ordering::Relaxed);
            }
            "mixerRaw" => {
                self.progress.mixer_events.fetch_add(1, Ordering::Relaxed);
            }
            "midiRaw" => {
                self.progress.midi_packets.fetch_add(1, Ordering::Relaxed);
            }
            "audioBuffer" => {
                self.progress
                    .audio_frames
                    .fetch_add(payload["frames"].as_u64().unwrap_or(0), Ordering::Relaxed);
            }
            _ => {}
        }
        self.progress.rows.store(sequence, Ordering::Relaxed);
        Ok(())
    }
    fn gap(&mut self, source: &str, count: u64) -> Result<()> {
        self.progress.gaps.fetch_add(count, Ordering::Relaxed);
        self.write("captureGap", json!({"source":source,"count":count}))
    }
    fn flush(&mut self) -> Result<()> {
        self.output.flush()?;
        self.output.get_ref().sync_data()?;
        Ok(())
    }
}

async fn capture(
    server: Arc<RwLock<DjLinkServer>>,
    writer: &mut Timeline,
    mut incoming: mpsc::Receiver<Input>,
    mut stopped: oneshot::Receiver<()>,
    ready: std::sync::mpsc::SyncSender<()>,
) -> Result<()> {
    let (mut decks, mut mixer, mut vu, bind_ip) = {
        let server = server.read().map_err(|_| anyhow::anyhow!("DJ Link lock"))?;
        (
            server.subscribe_telemetry(),
            server.subscribe_mixer_telemetry(),
            server.subscribe_vu_telemetry(),
            server.bind_ip(),
        )
    };
    let mut packets = PACKETS
        .get_or_init(|| broadcast::channel(8192).0)
        .subscribe();
    let publisher = StatePublisher::new("DJM-A9".into(), false, None, false);
    let mut messages = publisher.subscribe();
    {
        let server = server.read().map_err(|_| anyhow::anyhow!("DJ Link lock"))?;
        publisher.refresh_decks(&server).await?;
    }
    writer.write("hardware", publisher.snapshot().await)?;
    writer.flush()?;
    ready.send(()).context("Recording caller disconnected")?;
    let mut decoders = std::collections::BTreeMap::<String, Decoder>::new();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(1));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            _ = &mut stopped => {
                // Audio/MIDI producers stop first. Drain their already accepted tail.
                while let Ok(input) = incoming.try_recv() { capture_input(input, writer, &publisher, &mut decoders).await?; }
                // Bound each drain to the queue at stop time; a still-playing
                // deck must not keep finalization alive indefinitely.
                for _ in 0..decks.len() {
                    match decks.try_recv() {
                        Ok(event) => {
                            writer.write("deckRaw", serde_json::to_value(&event)?)?;
                            let server = server.read().map_err(|_| anyhow::anyhow!("DJ Link lock"))?;
                            publisher.publish_djlink_event(&server, event).await?;
                        },
                        Err(broadcast::error::TryRecvError::Lagged(count)) => writer.gap("decks", count)?,
                        Err(_) => break,
                    }
                }
                for _ in 0..mixer.len() {
                    match mixer.try_recv() {
                        Ok(event) => { writer.write("mixerRaw", serde_json::to_value(&event)?)?; publisher.publish_djlink_mixer_event(event).await?; },
                        Err(broadcast::error::TryRecvError::Lagged(count)) => writer.gap("mixer", count)?,
                        Err(_) => break,
                    }
                }
                for _ in 0..packets.len() {
                    match packets.try_recv() {
                        Ok(packet) if packet.local.ip() == bind_ip || packet.local.ip().is_unspecified() => writer.write("packet", serde_json::to_value(packet)?)?,
                        Ok(_) => {},
                        Err(broadcast::error::TryRecvError::Lagged(count)) => writer.gap("packets", count)?,
                        Err(_) => break,
                    }
                }
                drain_messages(&mut messages, writer)?;
                writer.write("recordingStopped", json!({"gaps":writer.progress.gaps.load(Ordering::Relaxed)}))?;
                return writer.flush();
            },
            input = incoming.recv() => {
                if let Some(input) = input { capture_input(input, writer, &publisher, &mut decoders).await?; }
            },
            event = decks.recv() => match event {
                Ok(event) => {
                    writer.write("deckRaw", serde_json::to_value(&event)?)?;
                    let server = server.read().map_err(|_| anyhow::anyhow!("DJ Link lock"))?;
                    publisher.publish_djlink_event(&server, event).await?;
                },
                Err(broadcast::error::RecvError::Lagged(count)) => writer.gap("decks",count)?,
                Err(_) => anyhow::bail!("DJ Link deck stream disconnected"),
            },
            event = mixer.recv() => match event {
                Ok(event) => { writer.write("mixerRaw",serde_json::to_value(&event)?)?; publisher.publish_djlink_mixer_event(event).await?; },
                Err(broadcast::error::RecvError::Lagged(count)) => writer.gap("mixer",count)?,
                Err(_) => anyhow::bail!("DJ Link mixer stream disconnected"),
            },
            event = vu.recv() => match event {
                Ok(event) => publisher.publish_djlink_vu_event(event).await?,
                Err(broadcast::error::RecvError::Lagged(count)) => writer.gap("meters",count)?,
                Err(_) => anyhow::bail!("DJ Link meter stream disconnected"),
            },
            packet = packets.recv() => match packet {
                Ok(packet) if packet.local.ip() == bind_ip || packet.local.ip().is_unspecified() => writer.write("packet",serde_json::to_value(packet)?)?,
                Ok(_) => {},
                Err(broadcast::error::RecvError::Lagged(count)) => writer.gap("packets",count)?,
                Err(_) => anyhow::bail!("Packet stream disconnected"),
            },
            _ = heartbeat.tick() => {
                let server = server.read().map_err(|_| anyhow::anyhow!("DJ Link lock"))?;
                publisher.refresh_decks(&server).await?;
                writer.write("hardware",publisher.snapshot().await)?;
                writer.write("heartbeat",json!({"gaps":writer.progress.gaps.load(Ordering::Relaxed)}))?;
                writer.flush()?;
            },
        }
        drain_messages(&mut messages, writer)?;
    }
}
fn drain_messages(messages: &mut broadcast::Receiver<String>, writer: &mut Timeline) -> Result<()> {
    loop {
        match messages.try_recv() {
            Ok(message) => writer.write("hardware", serde_json::from_str(&message)?)?,
            Err(broadcast::error::TryRecvError::Lagged(count)) => writer.gap("booth", count)?,
            Err(_) => return Ok(()),
        }
    }
}
async fn capture_input(
    input: Input,
    writer: &mut Timeline,
    publisher: &StatePublisher,
    decoders: &mut std::collections::BTreeMap<String, Decoder>,
) -> Result<()> {
    match input {
        Input::Event { kind, payload } => writer.write(&kind, payload),
        Input::Midi {
            source,
            timestamp_us,
            bytes,
        } => {
            writer.write(
                "midiRaw",
                json!({"source":source,"timestampUs":timestamp_us,"bytes":bytes}),
            )?;
            for event in decoders.entry(source.clone()).or_default().decode_packet(
                &RawMidiEvent {
                    timestamp_us,
                    bytes,
                },
                true,
            ) {
                publisher.publish_mixer_event(&event).await?;
            }
            publisher.set_mixer_connection(Some(source), true).await?;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_input_is_visible_as_a_gap() {
        let (input, receiver) = mpsc::channel(1);
        drop(receiver);
        let mut recording = BoothRecording {
            directory: PathBuf::new(),
            started: Instant::now(),
            elapsed_at_stop: None,
            progress: Arc::new(Progress::default()),
            input,
            stop: None,
            worker: None,
        };
        assert!(recording.event("audioBuffer".into(), json!({})).is_err());
        assert_eq!(recording.status()["gaps"], 1);
        recording.stop().unwrap();
    }
}
