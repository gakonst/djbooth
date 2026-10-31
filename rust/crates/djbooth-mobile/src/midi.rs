//! CoreMIDI transport adapter to the same decoder and booth reducer as desktop.
use anyhow::{Context, Result, ensure};
use djtools_link::{
    booth::StatePublisher,
    mixer::{Decoder, RawMidiEvent},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{collections::BTreeMap, sync::Mutex};

static LIVE: Mutex<Option<LiveMidi>> = Mutex::new(None);
struct Source {
    decoder: Decoder,
    publisher: StatePublisher,
    packets: u64,
}
struct LiveMidi {
    runtime: tokio::runtime::Runtime,
    sources: BTreeMap<String, Source>,
}
impl LiveMidi {
    fn new() -> Result<Self> {
        Ok(Self {
            runtime: tokio::runtime::Builder::new_current_thread().build()?,
            sources: BTreeMap::new(),
        })
    }
    fn request(&mut self, operation: &str, input: &str) -> Result<Value> {
        if operation == "snapshot" {
            let sources = self.runtime.block_on(async {
                let mut sources = Vec::new();
                for (id, source) in &self.sources {
                    let booth = source.publisher.state.booth.read().await;
                    sources.push(json!({"id":id, "packets":source.packets, "mixer":booth.mixer}));
                }
                sources
            });
            return Ok(json!(sources));
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Args {
            source: String,
            #[serde(default)]
            timestamp_us: u64,
            #[serde(default)]
            bytes: Vec<u8>,
        }
        let args: Args = serde_json::from_str(input)?;
        ensure!(
            !args.source.is_empty() && args.source.len() <= 256,
            "Invalid MIDI source"
        );
        match operation {
            "connect" => {
                ensure!(
                    self.sources.len() < 16 || self.sources.contains_key(&args.source),
                    "Too many MIDI sources"
                );
                self.sources
                    .entry(args.source.clone())
                    .or_insert_with(|| Source {
                        decoder: Decoder::default(),
                        publisher: StatePublisher::new(args.source, true, None, false),
                        packets: 0,
                    });
            }
            "disconnect" => {
                self.sources.remove(&args.source);
            }
            "packet" => {
                ensure!(
                    args.bytes.len() <= 65536,
                    "MIDI packet exceeds transport limit"
                );
                // CoreMIDI can finish an in-flight callback after source removal.
                // It must not resurrect stale controls after unplug/replug.
                let Some(source) = self.sources.get_mut(&args.source) else {
                    return Ok(Value::Null);
                };
                source.packets += 1;
                let events = source.decoder.decode_packet(
                    &RawMidiEvent {
                        timestamp_us: args.timestamp_us,
                        bytes: args.bytes,
                    },
                    false,
                );
                self.runtime.block_on(async {
                    for event in events {
                        source.publisher.publish_mixer_event(&event).await?;
                    }
                    Ok::<_, anyhow::Error>(())
                })?;
            }
            _ => anyhow::bail!("Unknown MIDI operation"),
        }
        Ok(Value::Null)
    }
}
pub(crate) fn request(operation: &str, input: &str) -> Result<Value> {
    let mut live = LIVE
        .lock()
        .map_err(|_| anyhow::anyhow!("Live MIDI lock failed"))?;
    if live.is_none() {
        *live = Some(LiveMidi::new()?);
    }
    live.as_mut()
        .context("Live MIDI is unavailable")?
        .request(operation, input)
}
