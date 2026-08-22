use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand, ValueEnum};
use midir::{Ignore, MidiInput, MidiInputConnection};
use nusb::MaybeFuture;
use nusb::transfer::{Bulk, In};
use serde::Serialize;
use tokio::sync::mpsc;

// AlphaTheta DJM-A9 MIDI Message List v1.0:
// https://www.pioneerdj.com/-/media/pioneerdj/downloads/midi-mapping/djm-a9/djm-a9_midi_message_list_e_10.pdf
const DEFAULT_DEVICE: &str = "DJM-A9";
const MIDI_CLOCK: u8 = 0xf8;
const MIDI_CLOCKS_PER_QUARTER: u64 = 24;
const PIONEER_VENDOR_ID: u16 = 0x2b73;
const DJM_A9_PRODUCT_ID: u16 = 0x003c;
const DJM_A9_MIDI_INTERFACE: u8 = 4;
const DJM_A9_MIDI_IN_ENDPOINT: u8 = 0x85;
const DIRECT_A9_MIDI_NAME: &str = "DJM-A9 (direct USB MIDI)";

pub(crate) enum MixerMidiConnection {
    CoreMidi {
        _connection: MidiInputConnection<()>,
    },
    DirectUsb {
        _connection: DirectUsbMidiConnection,
    },
}

pub(crate) struct DirectUsbMidiConnection {
    stopped: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Drop for DirectUsbMidiConnection {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Relaxed);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[derive(Parser)]
#[command(
    name = "djbooth-rs mixer",
    version,
    about = "Read DJ mixer controls over MIDI"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// List MIDI input devices visible to this process.
    Devices,
    /// Stream decoded DJM-A9 controls until interrupted.
    Monitor(MonitorArgs),
}

#[derive(Args)]
struct MonitorArgs {
    /// Case-insensitive substring selecting one MIDI input device.
    #[arg(long, default_value = DEFAULT_DEVICE)]
    device: String,
    /// Event output format.
    #[arg(long, value_enum, default_value_t = OutputFormat::Human)]
    format: OutputFormat,
    /// Stop automatically after this many seconds; zero waits for Ctrl-C.
    #[arg(long, default_value_t = 0)]
    duration_seconds: u64,
    /// Emit every raw F8 clock tick instead of one BPM summary per quarter note.
    #[arg(long)]
    raw_clock: bool,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum OutputFormat {
    Human,
    Jsonl,
}

#[derive(Debug)]
pub(crate) struct RawMidiEvent {
    timestamp_us: u64,
    bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MidiMessageKind {
    Note,
    ControlChange,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ValueKind {
    Continuous,
    Switch,
    Selector(&'static str),
    TwoPosition(&'static str, &'static str),
    ThreePosition(&'static str, &'static str, &'static str),
    Msb,
    Lsb,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ControlDefinition {
    path: &'static str,
    label: &'static str,
    value_kind: ValueKind,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DecodedEvent {
    pub(crate) elapsed_us: u64,
    pub(crate) timestamp_us: u64,
    pub(crate) kind: &'static str,
    pub(crate) message: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) channel: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) control: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) label: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) value: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) state: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) bpm: Option<f64>,
    pub(crate) raw: String,
}

#[derive(Default)]
pub(crate) struct Decoder {
    first_timestamp_us: Option<u64>,
    clock_ticks: u64,
    clock_window_start_us: Option<u64>,
    beat_fx_time_msb: Option<u8>,
    beat_fx_time_lsb: Option<u8>,
}

pub async fn run(args: impl IntoIterator<Item = String>) -> Result<()> {
    let cli = Cli::parse_from(std::iter::once("djbooth-rs mixer".to_string()).chain(args));
    match cli.command {
        Command::Devices => devices(),
        Command::Monitor(args) => monitor(args).await,
    }
}

fn devices() -> Result<()> {
    let midi =
        MidiInput::new("music-ts mixer device scan").context("failed to initialize MIDI input")?;
    let mut devices = midi
        .ports()
        .iter()
        .map(|port| {
            midi.port_name(port)
                .context("failed to read MIDI input name")
        })
        .collect::<Result<Vec<_>>>()?;
    if direct_a9_usb_present()? && !devices.iter().any(|name| name.contains("DJM-A9")) {
        devices.push(DIRECT_A9_MIDI_NAME.to_string());
    }
    println!("{}", serde_json::to_string_pretty(&devices)?);
    Ok(())
}

async fn monitor(args: MonitorArgs) -> Result<()> {
    let (connection, mut receiver, device_name) = connect_midi(&args.device)?;

    eprintln!("Reading {device_name}; press Ctrl-C to stop.");
    let mut decoder = Decoder::default();
    let timeout = async {
        if args.duration_seconds == 0 {
            std::future::pending::<()>().await;
        } else {
            tokio::time::sleep(Duration::from_secs(args.duration_seconds)).await;
        }
    };
    tokio::pin!(timeout);

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            _ = &mut timeout => break,
            raw = receiver.recv() => {
                let Some(raw) = raw else { bail!("MIDI input '{device_name}' disconnected") };
                for event in decoder.decode_packet(&raw, args.raw_clock) {
                    print_event(&event, args.format)?;
                }
            }
        }
    }
    drop(connection);
    Ok(())
}

pub(crate) fn connect_midi(
    device_selector: &str,
) -> Result<(
    MixerMidiConnection,
    mpsc::UnboundedReceiver<RawMidiEvent>,
    String,
)> {
    let mut midi =
        MidiInput::new("music-ts DJ mixer reader").context("failed to initialize MIDI input")?;
    midi.ignore(Ignore::None);
    let ports = midi.ports();
    let names = ports
        .iter()
        .map(|port| {
            midi.port_name(port)
                .context("failed to read MIDI input name")
        })
        .collect::<Result<Vec<_>>>()?;
    let needle = device_selector.to_ascii_lowercase();
    let matches = names
        .iter()
        .enumerate()
        .filter(|(_, name)| name.to_ascii_lowercase().contains(&needle))
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let index = match matches.as_slice() {
        [index] => *index,
        [] if needle.contains("djm-a9") => return connect_a9_usb_midi(),
        [] => bail!(
            "MIDI input '{}' not found; available inputs: {}",
            device_selector,
            display_devices(&names)
        ),
        _ => bail!(
            "MIDI input selector '{}' is ambiguous; matching inputs: {}",
            device_selector,
            matches
                .iter()
                .map(|index| names[*index].as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ),
    };
    let device_name = names[index].clone();
    let (sender, receiver) = mpsc::unbounded_channel::<RawMidiEvent>();
    let connection = midi
        .connect(
            &ports[index],
            "music-ts DJ mixer input",
            move |timestamp_us, bytes, _| {
                let _ = sender.send(RawMidiEvent {
                    timestamp_us,
                    bytes: bytes.to_vec(),
                });
            },
            (),
        )
        .with_context(|| format!("failed to connect to MIDI input '{device_name}'"))?;
    Ok((
        MixerMidiConnection::CoreMidi {
            _connection: connection,
        },
        receiver,
        device_name,
    ))
}

pub(crate) fn midi_input_present(device_name: &str) -> Result<bool> {
    if device_name == DIRECT_A9_MIDI_NAME {
        return direct_a9_usb_present();
    }
    let midi = MidiInput::new("music-ts DJ mixer probe")
        .context("failed to initialize MIDI input probe")?;
    for port in midi.ports() {
        if midi
            .port_name(&port)
            .context("failed to read MIDI input name")?
            == device_name
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn direct_a9_usb_present() -> Result<bool> {
    Ok(nusb::list_devices()
        .wait()
        .context("enumerate USB MIDI devices")?
        .any(|device| {
            device.vendor_id() == PIONEER_VENDOR_ID && device.product_id() == DJM_A9_PRODUCT_ID
        }))
}

fn connect_a9_usb_midi() -> Result<(
    MixerMidiConnection,
    mpsc::UnboundedReceiver<RawMidiEvent>,
    String,
)> {
    let info = nusb::list_devices()
        .wait()
        .context("enumerate USB MIDI devices")?
        .find(|device| {
            device.vendor_id() == PIONEER_VENDOR_ID && device.product_id() == DJM_A9_PRODUCT_ID
        })
        .context("DJM-A9 USB MIDI interface is not connected")?;
    let device = info.open().wait().context("open DJM-A9 USB MIDI device")?;
    let interface = device
        .claim_interface(DJM_A9_MIDI_INTERFACE)
        .wait()
        .context("claim DJM-A9 USB MIDI interface 4")?;
    let mut reader = interface
        .endpoint::<Bulk, In>(DJM_A9_MIDI_IN_ENDPOINT)
        .context("open DJM-A9 USB MIDI input endpoint 0x85")?
        .reader(512)
        .with_num_transfers(4)
        .with_read_timeout(Duration::from_millis(100));
    let (sender, receiver) = mpsc::unbounded_channel();
    let stopped = Arc::new(AtomicBool::new(false));
    let worker_stopped = stopped.clone();
    let worker = std::thread::Builder::new()
        .name("djm-a9-usb-midi".to_string())
        .spawn(move || {
            let started = Instant::now();
            let mut buffer = [0u8; 512];
            while !worker_stopped.load(Ordering::Relaxed) {
                let length = match reader.read(&mut buffer) {
                    Ok(length) => length,
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                        ) =>
                    {
                        continue;
                    }
                    Err(_) => break,
                };
                for packet in buffer[..length].as_chunks::<4>().0 {
                    let midi_length = usb_midi_message_length(packet[0] & 0x0f);
                    if midi_length == 0 {
                        continue;
                    }
                    let timestamp_us =
                        started.elapsed().as_micros().min(u128::from(u64::MAX)) as u64;
                    if sender
                        .send(RawMidiEvent {
                            timestamp_us,
                            bytes: packet[1..1 + midi_length].to_vec(),
                        })
                        .is_err()
                    {
                        return;
                    }
                }
            }
        })
        .context("start DJM-A9 direct USB MIDI reader")?;
    Ok((
        MixerMidiConnection::DirectUsb {
            _connection: DirectUsbMidiConnection {
                stopped,
                worker: Some(worker),
            },
        },
        receiver,
        DIRECT_A9_MIDI_NAME.to_string(),
    ))
}

fn usb_midi_message_length(cin: u8) -> usize {
    match cin {
        0x2 | 0x6 | 0xc | 0xd => 2,
        0x3 | 0x4 | 0x7..=0xb | 0xe => 3,
        0x5 | 0xf => 1,
        _ => 0,
    }
}

fn display_devices(devices: &[String]) -> String {
    if devices.is_empty() {
        "none".to_string()
    } else {
        devices.join(", ")
    }
}

fn print_event(event: &DecodedEvent, format: OutputFormat) -> Result<()> {
    match format {
        OutputFormat::Jsonl => println!("{}", serde_json::to_string(event)?),
        OutputFormat::Human => {
            let time = event.elapsed_us as f64 / 1_000_000.0;
            if let Some(bpm) = event.bpm {
                println!("{time:9.3}s  CLOCK             {bpm:7.3} BPM");
            } else if let Some(control) = event.control {
                let value = match (event.state, event.percent, event.value) {
                    (Some(state), _, _) => state.to_string(),
                    (_, Some(percent), Some(raw)) => format!("{percent:6.2}%  raw={raw}"),
                    (_, _, Some(raw)) => raw.to_string(),
                    _ => "?".to_string(),
                };
                println!("{time:9.3}s  {control:<28} {value}");
            } else {
                println!("{time:9.3}s  UNKNOWN           {}", event.raw);
            }
        }
    }
    Ok(())
}

impl Decoder {
    pub(crate) fn decode_packet(
        &mut self,
        raw: &RawMidiEvent,
        raw_clock: bool,
    ) -> Vec<DecodedEvent> {
        let baseline = *self.first_timestamp_us.get_or_insert(raw.timestamp_us);
        let elapsed_us = raw.timestamp_us.saturating_sub(baseline);
        let mut events = Vec::new();
        let mut index = 0;
        while index < raw.bytes.len() {
            let status = raw.bytes[index];
            if status == MIDI_CLOCK {
                if let Some(event) = self.decode_clock(raw.timestamp_us, elapsed_us, raw_clock) {
                    events.push(event);
                }
                index += 1;
                continue;
            }
            if status & 0x80 == 0 || index + 2 >= raw.bytes.len() {
                events.push(unknown_event(
                    raw.timestamp_us,
                    elapsed_us,
                    &raw.bytes[index..],
                ));
                break;
            }
            let bytes = &raw.bytes[index..index + 3];
            events.push(self.decode_message(raw.timestamp_us, elapsed_us, bytes));
            index += 3;
        }
        events
    }

    fn decode_clock(
        &mut self,
        timestamp_us: u64,
        elapsed_us: u64,
        raw_clock: bool,
    ) -> Option<DecodedEvent> {
        self.clock_ticks += 1;
        let boundary = self.clock_ticks.is_multiple_of(MIDI_CLOCKS_PER_QUARTER);
        if !raw_clock && !boundary {
            return None;
        }
        let bpm = if boundary {
            self.clock_window_start_us
                .replace(timestamp_us)
                .and_then(|started| {
                    let elapsed = timestamp_us.saturating_sub(started);
                    (elapsed > 0).then(|| 60_000_000.0 / elapsed as f64)
                })
        } else {
            None
        };
        if !raw_clock && bpm.is_none() {
            return None;
        }
        Some(DecodedEvent {
            elapsed_us,
            timestamp_us,
            kind: "clock",
            message: "timingClock",
            channel: None,
            control: None,
            label: None,
            value: None,
            percent: None,
            state: None,
            bpm,
            raw: "F8".to_string(),
        })
    }

    fn decode_message(&mut self, timestamp_us: u64, elapsed_us: u64, bytes: &[u8]) -> DecodedEvent {
        let status = bytes[0];
        let data1 = bytes[1];
        let data2 = bytes[2];
        let channel = status & 0x0f;
        let message_kind = match status >> 4 {
            0x8 | 0x9 => MidiMessageKind::Note,
            0xb => MidiMessageKind::ControlChange,
            _ => return unknown_event(timestamp_us, elapsed_us, bytes),
        };
        let Some(definition) = control_definition(message_kind, data1) else {
            return unknown_event(timestamp_us, elapsed_us, bytes);
        };
        let effective_value = if status >> 4 == 0x8 { 0 } else { data2 };
        let (value, percent, state) = self.semantic_value(definition, effective_value);
        DecodedEvent {
            elapsed_us,
            timestamp_us,
            kind: "control",
            message: match message_kind {
                MidiMessageKind::Note => "note",
                MidiMessageKind::ControlChange => "controlChange",
            },
            channel: Some(channel + 1),
            control: Some(definition.path),
            label: Some(definition.label),
            value: Some(value),
            percent,
            state,
            bpm: None,
            raw: hex(bytes),
        }
    }

    fn semantic_value(
        &mut self,
        definition: ControlDefinition,
        value: u8,
    ) -> (u16, Option<f64>, Option<&'static str>) {
        match definition.value_kind {
            ValueKind::Continuous => (value.into(), Some(percent(value)), None),
            ValueKind::Switch => (
                value.into(),
                None,
                Some(if value == 0 { "off" } else { "on" }),
            ),
            ValueKind::Selector(option) => (
                value.into(),
                None,
                Some(if value == 0 { "off" } else { option }),
            ),
            ValueKind::TwoPosition(low, high) => (
                value.into(),
                None,
                Some(if value < 64 { low } else { high }),
            ),
            ValueKind::ThreePosition(low, middle, high) => {
                let state = if value < 32 {
                    low
                } else if value < 96 {
                    middle
                } else {
                    high
                };
                (value.into(), None, Some(state))
            }
            ValueKind::Msb => {
                self.beat_fx_time_msb = Some(value);
                let combined =
                    u16::from(value) << 7 | u16::from(self.beat_fx_time_lsb.unwrap_or(0));
                (combined, Some(combined as f64 * 100.0 / 16_383.0), None)
            }
            ValueKind::Lsb => {
                self.beat_fx_time_lsb = Some(value);
                let combined =
                    u16::from(self.beat_fx_time_msb.unwrap_or(0)) << 7 | u16::from(value);
                (combined, Some(combined as f64 * 100.0 / 16_383.0), None)
            }
        }
    }
}

fn unknown_event(timestamp_us: u64, elapsed_us: u64, bytes: &[u8]) -> DecodedEvent {
    DecodedEvent {
        elapsed_us,
        timestamp_us,
        kind: "unknown",
        message: "unknown",
        channel: None,
        control: None,
        label: None,
        value: None,
        percent: None,
        state: None,
        bpm: None,
        raw: hex(bytes),
    }
}

fn percent(value: u8) -> f64 {
    value as f64 * 100.0 / 127.0
}

fn hex(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(" ")
}

const fn continuous(path: &'static str, label: &'static str) -> ControlDefinition {
    ControlDefinition {
        path,
        label,
        value_kind: ValueKind::Continuous,
    }
}

const fn switch(path: &'static str, label: &'static str) -> ControlDefinition {
    ControlDefinition {
        path,
        label,
        value_kind: ValueKind::Switch,
    }
}

const fn selector(
    path: &'static str,
    label: &'static str,
    option: &'static str,
) -> ControlDefinition {
    ControlDefinition {
        path,
        label,
        value_kind: ValueKind::Selector(option),
    }
}

const fn three_position(
    path: &'static str,
    label: &'static str,
    low: &'static str,
    middle: &'static str,
    high: &'static str,
) -> ControlDefinition {
    ControlDefinition {
        path,
        label,
        value_kind: ValueKind::ThreePosition(low, middle, high),
    }
}

const fn two_position(
    path: &'static str,
    label: &'static str,
    low: &'static str,
    high: &'static str,
) -> ControlDefinition {
    ControlDefinition {
        path,
        label,
        value_kind: ValueKind::TwoPosition(low, high),
    }
}

fn control_definition(kind: MidiMessageKind, data1: u8) -> Option<ControlDefinition> {
    match kind {
        MidiMessageKind::Note => note_definition(data1),
        MidiMessageKind::ControlChange => cc_definition(data1),
    }
}

fn note_definition(data1: u8) -> Option<ControlDefinition> {
    Some(match data1 {
        // Beat FX channel selector.
        0x01 => selector("beatFx.channel", "Beat FX channel", "channel1"),
        0x02 => selector("beatFx.channel", "Beat FX channel", "channel2"),
        0x03 => selector("beatFx.channel", "Beat FX channel", "channel3"),
        0x04 => selector("beatFx.channel", "Beat FX channel", "channel4"),
        0x05 => selector("beatFx.channel", "Beat FX channel", "microphone"),
        0x06 => selector("beatFx.channel", "Beat FX channel", "crossfaderA"),
        0x07 => selector("beatFx.channel", "Beat FX channel", "crossfaderB"),
        0x08 => selector("beatFx.channel", "Beat FX channel", "master"),
        // Channel cues.
        0x0a => switch("channel.1.cueA", "Channel 1 cue A"),
        0x0b => switch("channel.2.cueA", "Channel 2 cue A"),
        0x0c => switch("channel.3.cueA", "Channel 3 cue A"),
        0x0d => switch("channel.4.cueA", "Channel 4 cue A"),
        0x0e => switch("master.cueA", "Master cue A"),
        0x0f => switch("headphonesA.linkCue", "Headphones A link cue"),
        0x10 => switch("channel.1.cueB", "Channel 1 cue B"),
        0x11 => switch("channel.2.cueB", "Channel 2 cue B"),
        0x12 => switch("channel.3.cueB", "Channel 3 cue B"),
        0x13 => switch("channel.4.cueB", "Channel 4 cue B"),
        0x14 => switch("master.cueB", "Master cue B"),
        0x15 => switch("headphonesB.linkCue", "Headphones B link cue"),
        0x21 => switch("headphonesA.monoSplit", "Headphones A mono/split"),
        // Multi I/O send selector.
        0x22 => selector("multiIo.sendChannel", "Multi I/O send channel", "channel1"),
        0x23 => selector("multiIo.sendChannel", "Multi I/O send channel", "channel2"),
        0x24 => selector("multiIo.sendChannel", "Multi I/O send channel", "channel3"),
        0x25 => selector("multiIo.sendChannel", "Multi I/O send channel", "channel4"),
        0x26 => selector(
            "multiIo.sendChannel",
            "Multi I/O send channel",
            "microphone",
        ),
        0x27 => selector(
            "multiIo.sendChannel",
            "Multi I/O send channel",
            "crossfaderA",
        ),
        0x28 => selector(
            "multiIo.sendChannel",
            "Multi I/O send channel",
            "crossfaderB",
        ),
        0x29 => selector("multiIo.sendChannel", "Multi I/O send channel", "master"),
        // Channel 1 input selector.
        0x32 => selector("channel.1.input", "Channel 1 input", "digital"),
        0x33 => selector("channel.1.input", "Channel 1 input", "line"),
        0x34 => selector("channel.1.input", "Channel 1 input", "phono"),
        0x35 => selector("channel.1.input", "Channel 1 input", "a"),
        // Channel 2 input selector.
        0x36 => selector("channel.2.input", "Channel 2 input", "digital"),
        0x37 => selector("channel.2.input", "Channel 2 input", "line"),
        0x38 => selector("channel.2.input", "Channel 2 input", "phono"),
        0x39 => selector("channel.2.input", "Channel 2 input", "a"),
        // Channel 3 input selector.
        0x3a => selector("channel.3.input", "Channel 3 input", "digital"),
        0x3b => selector("channel.3.input", "Channel 3 input", "line"),
        0x3c => selector("channel.3.input", "Channel 3 input", "phono"),
        0x3d => selector("channel.3.input", "Channel 3 input", "a"),
        // Channel 4 input selector.
        0x3e => selector("channel.4.input", "Channel 4 input", "digital"),
        0x3f => selector("channel.4.input", "Channel 4 input", "line"),
        0x40 => selector("channel.4.input", "Channel 4 input", "phono"),
        0x41 => selector("channel.4.input", "Channel 4 input", "a"),
        0x42 => selector("channel.1.input", "Channel 1 input", "b"),
        0x43 => selector("channel.1.input", "Channel 1 input", "return"),
        0x44 => selector("channel.2.input", "Channel 2 input", "b"),
        0x45 => selector("channel.2.input", "Channel 2 input", "return"),
        0x46 => selector("channel.3.input", "Channel 3 input", "b"),
        0x47 => selector("channel.3.input", "Channel 3 input", "return"),
        0x48 => selector("channel.4.input", "Channel 4 input", "b"),
        0x49 => selector("channel.4.input", "Channel 4 input", "return"),
        0x4a => selector("channel.1.input", "Channel 1 input", "usb"),
        0x4b => selector("channel.2.input", "Channel 2 input", "usb"),
        0x4c => selector("channel.3.input", "Channel 3 input", "usb"),
        0x4d => selector("channel.4.input", "Channel 4 input", "usb"),
        0x51 => selector("channel.1.input", "Channel 1 input", "bluetooth"),
        0x52 => selector("channel.2.input", "Channel 2 input", "bluetooth"),
        0x53 => selector("channel.3.input", "Channel 3 input", "bluetooth"),
        0x54 => selector("channel.4.input", "Channel 4 input", "bluetooth"),
        // Sound Color FX selector.
        0x55 => selector("soundColorFx.effect", "Sound Color FX", "space"),
        0x56 => selector("soundColorFx.effect", "Sound Color FX", "noise"),
        0x57 => selector("soundColorFx.effect", "Sound Color FX", "filter"),
        0x60 => switch("microphone.reverb", "Microphone reverb"),
        0x61 => switch("microphone.talkOver", "Microphone talk over"),
        0x62 => switch("microphone.on", "Microphone on"),
        0x69 => selector("soundColorFx.effect", "Sound Color FX", "dubEcho"),
        0x6a => selector("soundColorFx.effect", "Sound Color FX", "crush"),
        0x6b => selector("soundColorFx.effect", "Sound Color FX", "sweep"),
        0x6f => two_position(
            "multiIo.insertSource",
            "Multi I/O insert source",
            "return",
            "usb",
        ),
        0x70 => switch("bluetooth.on", "Bluetooth"),
        0x76 => switch("beatFx.quantize", "Beat FX quantize"),
        _ => return None,
    })
}

fn cc_definition(data1: u8) -> Option<ControlDefinition> {
    Some(match data1 {
        // Channel 1.
        0x01 => continuous("channel.1.trim", "Channel 1 trim"),
        0x02 => continuous("channel.1.eq.high", "Channel 1 EQ high"),
        0x03 => continuous("channel.1.eq.mid", "Channel 1 EQ mid"),
        0x04 => continuous("channel.1.eq.low", "Channel 1 EQ low"),
        0x05 => continuous("channel.1.color", "Channel 1 Sound Color FX knob"),
        // Channel 2.
        0x06 => continuous("channel.2.trim", "Channel 2 trim"),
        0x07 => continuous("channel.2.eq.high", "Channel 2 EQ high"),
        0x08 => continuous("channel.2.eq.mid", "Channel 2 EQ mid"),
        0x09 => continuous("channel.2.eq.low", "Channel 2 EQ low"),
        0x0a => continuous("channel.2.color", "Channel 2 Sound Color FX knob"),
        0x0b => continuous("crossfader.position", "Crossfader"),
        // Channel 3.
        0x0c => continuous("channel.3.trim", "Channel 3 trim"),
        0x0d => ControlDefinition {
            path: "beatFx.time",
            label: "Beat FX time",
            value_kind: ValueKind::Msb,
        },
        0x0e => continuous("channel.3.eq.high", "Channel 3 EQ high"),
        0x0f => continuous("channel.3.eq.mid", "Channel 3 EQ mid"),
        0x11 => continuous("channel.1.fader", "Channel 1 fader"),
        0x12 => continuous("channel.2.fader", "Channel 2 fader"),
        0x13 => continuous("channel.3.fader", "Channel 3 fader"),
        0x14 => continuous("channel.4.fader", "Channel 4 fader"),
        0x15 => continuous("channel.3.eq.low", "Channel 3 EQ low"),
        0x16 => continuous("channel.3.color", "Channel 3 Sound Color FX knob"),
        0x18 => continuous("master.level", "Master level"),
        0x19 => continuous("booth.level", "Booth level"),
        0x1a => continuous("headphonesA.level", "Headphones A level"),
        0x1b => continuous("headphonesA.mixing", "Headphones A mixing"),
        0x1e => continuous("microphone.eq.high", "Microphone EQ high"),
        0x1f => continuous("microphone.eq.low", "Microphone EQ low"),
        0x21 => two_position("eq.curve", "EQ curve", "isolator", "eq"),
        0x22 => switch("headphonesB.monoSplit", "Headphones B mono/split"),
        0x2a => selector("beatFx.effect", "Beat FX effect", "delay"),
        0x2b => selector("beatFx.effect", "Beat FX effect", "spiral"),
        0x2d => ControlDefinition {
            path: "beatFx.time",
            label: "Beat FX time",
            value_kind: ValueKind::Lsb,
        },
        0x2e => selector("beatFx.effect", "Beat FX effect", "roll"),
        0x2f => selector("beatFx.effect", "Beat FX effect", "tripletRoll"),
        0x32 => selector("beatFx.effect", "Beat FX effect", "flanger"),
        0x33 => selector("beatFx.effect", "Beat FX effect", "pingPong"),
        0x35 => selector("beatFx.effect", "Beat FX effect", "trans"),
        0x36 => selector("beatFx.effect", "Beat FX effect", "reverb"),
        0x37 => selector("beatFx.effect", "Beat FX effect", "echo"),
        0x39 => selector("beatFx.effect", "Beat FX effect", "phaser"),
        0x3a => selector("beatFx.effect", "Beat FX effect", "tripletFilter"),
        0x3b => selector("beatFx.effect", "Beat FX effect", "filter"),
        0x3d => selector("beatFx.effect", "Beat FX effect", "mobius"),
        0x3e => selector("beatFx.effect", "Beat FX effect", "helix"),
        0x40 => switch("multiIo.insert", "Multi I/O insert"),
        0x41 => three_position(
            "channel.1.crossfaderAssign",
            "Channel 1 crossfader assign",
            "a",
            "thru",
            "b",
        ),
        0x42 => three_position(
            "channel.2.crossfaderAssign",
            "Channel 2 crossfader assign",
            "a",
            "thru",
            "b",
        ),
        0x43 => three_position(
            "channel.3.crossfaderAssign",
            "Channel 3 crossfader assign",
            "a",
            "thru",
            "b",
        ),
        0x44 => three_position(
            "channel.4.crossfaderAssign",
            "Channel 4 crossfader assign",
            "a",
            "thru",
            "b",
        ),
        0x45 => switch("beatFx.autoTap", "Beat FX auto/tap"),
        0x4c => switch("beatFx.beatLeft", "Beat FX beat left"),
        0x4d => switch("beatFx.beatRight", "Beat FX beat right"),
        0x4e => switch("beatFx.tap", "Beat FX tap"),
        // Channel 4.
        0x50 => continuous("channel.4.trim", "Channel 4 trim"),
        0x51 => continuous("channel.4.eq.high", "Channel 4 EQ high"),
        0x52 => continuous("channel.4.eq.low", "Channel 4 EQ low"),
        0x53 => continuous("channel.4.color", "Channel 4 Sound Color FX knob"),
        0x55 => continuous("headphonesB.mixing", "Headphones B mixing"),
        0x56 => continuous("headphonesB.level", "Headphones B level"),
        0x5b => continuous("beatFx.levelDepth", "Beat FX level/depth"),
        0x5c => continuous("channel.4.eq.mid", "Channel 4 EQ mid"),
        0x5e => three_position(
            "channelFader.curve",
            "Channel fader curve",
            "left",
            "center",
            "right",
        ),
        0x5f => three_position(
            "crossfader.curve",
            "Crossfader curve",
            "left",
            "center",
            "right",
        ),
        0x61 => switch("microphone.fx.echo", "Microphone FX echo"),
        0x62 => switch("microphone.fx.pitch", "Microphone FX pitch"),
        0x63 => switch("microphone.fx.megaphone", "Microphone FX megaphone"),
        0x64 => continuous("microphone.fx.parameter", "Microphone FX parameter"),
        0x65 => continuous("microphone.reverbParameter", "Microphone reverb parameter"),
        0x66 => switch("beatFx.frequency.high", "Beat FX high frequency"),
        0x67 => switch("beatFx.frequency.mid", "Beat FX mid frequency"),
        0x68 => switch("beatFx.frequency.low", "Beat FX low frequency"),
        0x6c => continuous("soundColorFx.parameter", "Sound Color FX parameter"),
        0x6d => continuous("booth.eq.high", "Booth EQ high"),
        0x6e => continuous("booth.eq.low", "Booth EQ low"),
        0x71 => continuous("multiIo.sendLevel", "Multi I/O send level"),
        // The ON/OFF button and touching the X-PAD intentionally emit the same message.
        0x72 => switch("beatFx.on", "Beat FX on/off or X-PAD touch"),
        0x74 => continuous("beatFx.xPad", "Beat FX X-PAD"),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(bytes: &[u8], timestamp_us: u64) -> RawMidiEvent {
        RawMidiEvent {
            timestamp_us,
            bytes: bytes.to_vec(),
        }
    }

    #[test]
    fn decodes_requested_channel_faders_color_eq_and_trim() {
        let mut decoder = Decoder::default();
        let cases = [
            ([0xb0, 0x11, 0x7f], "channel.1.fader"),
            ([0xb0, 0x12, 0x40], "channel.2.fader"),
            ([0xb0, 0x13, 0x20], "channel.3.fader"),
            ([0xb0, 0x14, 0x00], "channel.4.fader"),
            ([0xb0, 0x05, 0x40], "channel.1.color"),
            ([0xb0, 0x07, 0x40], "channel.2.eq.high"),
            ([0xb0, 0x0f, 0x40], "channel.3.eq.mid"),
            ([0xb0, 0x52, 0x40], "channel.4.eq.low"),
            ([0xb0, 0x01, 0x40], "channel.1.trim"),
            ([0xb0, 0x06, 0x40], "channel.2.trim"),
            ([0xb0, 0x0c, 0x40], "channel.3.trim"),
            ([0xb0, 0x50, 0x40], "channel.4.trim"),
        ];
        for (index, (bytes, expected)) in cases.into_iter().enumerate() {
            let events = decoder.decode_packet(&raw(&bytes, index as u64), false);
            assert_eq!(events[0].control, Some(expected));
        }
    }

    #[test]
    fn reports_control_travel_as_zero_to_one_hundred_percent() {
        let mut decoder = Decoder::default();
        let zero = decoder.decode_packet(&raw(&[0xb0, 0x11, 0], 1), false);
        let full = decoder.decode_packet(&raw(&[0xb0, 0x11, 127], 2), false);
        assert_eq!(zero[0].percent, Some(0.0));
        assert_eq!(full[0].percent, Some(100.0));
    }

    #[test]
    fn decodes_selector_off_then_selected_on() {
        let mut decoder = Decoder::default();
        let off = decoder.decode_packet(&raw(&[0x90, 0x55, 0], 1), false);
        let on = decoder.decode_packet(&raw(&[0x90, 0x57, 127], 2), false);
        assert_eq!(off[0].control, Some("soundColorFx.effect"));
        assert_eq!(off[0].state, Some("off"));
        assert_eq!(on[0].state, Some("filter"));
    }

    #[test]
    fn combines_beat_fx_time_msb_and_lsb() {
        let mut decoder = Decoder::default();
        decoder.decode_packet(&raw(&[0xb0, 0x0d, 0x12], 1), false);
        let event = decoder.decode_packet(&raw(&[0xb0, 0x2d, 0x34], 2), false);
        assert_eq!(event[0].value, Some(0x934));
    }

    #[test]
    fn summarizes_packed_midi_clock_once_per_quarter_note() {
        let mut decoder = Decoder::default();
        let first = decoder.decode_packet(&raw(&[MIDI_CLOCK; 24], 1_000_000), false);
        let second = decoder.decode_packet(&raw(&[MIDI_CLOCK; 24], 1_500_000), false);
        assert!(first.is_empty());
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].bpm, Some(120.0));
    }

    #[test]
    fn preserves_unknown_messages_as_raw_hex() {
        let mut decoder = Decoder::default();
        let event = decoder.decode_packet(&raw(&[0xe0, 0x01, 0x02], 1), false);
        assert_eq!(event[0].kind, "unknown");
        assert_eq!(event[0].raw, "E0 01 02");
    }

    #[test]
    fn unwraps_usb_midi_one_event_lengths() {
        assert_eq!(usb_midi_message_length(0x0b), 3);
        assert_eq!(usb_midi_message_length(0x0c), 2);
        assert_eq!(usb_midi_message_length(0x0f), 1);
        assert_eq!(usb_midi_message_length(0x00), 0);
    }
}
