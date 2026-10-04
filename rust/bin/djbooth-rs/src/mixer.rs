use djtools_link::mixer::usb_midi_message_length;
pub(crate) use djtools_link::mixer::{DecodedEvent, Decoder, RawMidiEvent};
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
use tokio::sync::mpsc;

// AlphaTheta DJM-A9 MIDI Message List v1.0:
// https://www.pioneerdj.com/-/media/pioneerdj/downloads/midi-mapping/djm-a9/djm-a9_midi_message_list_e_10.pdf
const DEFAULT_DEVICE: &str = "DJM-A9";
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
        .map_err(|error| {
            anyhow::anyhow!("failed to connect to MIDI input '{device_name}': {error}")
        })?;
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
