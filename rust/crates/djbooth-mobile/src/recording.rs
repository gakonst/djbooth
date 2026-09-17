//! Ownership/serialization for the shared recorder; no hardware decoding here.
use anyhow::{Context, Result};
use djtools_link::recording::BoothRecording;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Mutex};
static RECORDING: Mutex<Option<BoothRecording>> = Mutex::new(None);
static LAST: Mutex<Option<Value>> = Mutex::new(None);
pub(crate) fn stop() -> Result<Value> {
    let mut slot = RECORDING
        .lock()
        .map_err(|_| anyhow::anyhow!("Recording lock"))?;
    let Some(mut recording) = slot.take() else {
        return Ok(json!({"recording":false}));
    };
    let result = recording.stop();
    *LAST.lock().unwrap() = Some(recording.status());
    result
}
pub(crate) fn request(operation: &str, input: &str) -> Result<Value> {
    if operation == "prepare" {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Args {
            directory: PathBuf,
        }
        let args: Args = serde_json::from_str(input)?;
        let slot = RECORDING
            .lock()
            .map_err(|_| anyhow::anyhow!("Recording lock"))?;
        anyhow::ensure!(slot.is_none(), "Stop recording before preparing a set");
        return djtools_link::recording::export::prepare(&args.directory);
    }
    if operation == "stop" {
        return stop();
    }
    if operation == "clock" {
        return Ok(json!(djtools_link::recording::host_time_ns().to_string()));
    }
    // Lock SESSION before RECORDING, matching session teardown.
    if operation == "start" {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Args {
            directory: PathBuf,
            tracks: Value,
            #[serde(default)]
            audio: bool,
        }
        let args: Args = serde_json::from_str(input)?;
        let session_guard = crate::SESSION
            .lock()
            .map_err(|_| anyhow::anyhow!("DJ Link lock"))?;
        let session = session_guard
            .as_ref()
            .context("Connect the CDJ network before recording")?;
        anyhow::ensure!(
            session.started.load(std::sync::atomic::Ordering::Acquire),
            "DJ Link is not running"
        );
        let mut slot = RECORDING
            .lock()
            .map_err(|_| anyhow::anyhow!("Recording lock"))?;
        anyhow::ensure!(
            session.started.load(std::sync::atomic::Ordering::Acquire),
            "DJ Link stopped before recording could start"
        );
        anyhow::ensure!(slot.is_none(), "A recording is already running");
        let recording = BoothRecording::start(
            session.server.clone(),
            &args.directory,
            args.tracks,
            args.audio,
        )?;
        let result = recording.status();
        *slot = Some(recording);
        return Ok(result);
    }
    let slot = RECORDING
        .lock()
        .map_err(|_| anyhow::anyhow!("Recording lock"))?;
    if operation == "status" {
        return Ok(slot
            .as_ref()
            .map(BoothRecording::status)
            .or_else(|| LAST.lock().unwrap().clone())
            .unwrap_or(json!({"recording":false})));
    }
    let recording = slot.as_ref().context("No recording is running")?;
    match operation {
        "event" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Args {
                kind: String,
                payload: Value,
            }
            let args: Args = serde_json::from_str(input)?;
            recording.event(args.kind, args.payload)?;
        }
        "midi" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Args {
                source: String,
                timestamp_us: u64,
                bytes: Vec<u8>,
            }
            let args: Args = serde_json::from_str(input)?;
            recording.midi(args.source, args.timestamp_us, args.bytes)?;
        }
        _ => anyhow::bail!("Unknown recording operation"),
    }
    Ok(Value::Null)
}
