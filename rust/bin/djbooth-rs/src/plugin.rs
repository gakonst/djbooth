#![allow(deprecated)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, bail, ensure};
use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use vst::api::{TimeInfo, TimeInfoFlags};
use vst::buffer::SendEventBuffer;
use vst::event::MidiEvent;
use vst::host::{Host, HostBuffer, PluginLoader};
use vst::plugin::Plugin;

const DEFAULT_SERUM_BINARY: &str = "/Library/Audio/Plug-Ins/VST/Serum.vst/Contents/MacOS/Serum";
const DEFAULT_SERUM_PRESET: &str =
    "/Library/Audio/Presets/Xfer Records/Serum Presets/Presets/Bass/BA Analog Pluck [SN].fxp";
const DEFAULT_SAMPLE_RATE: u32 = 44_100;
const DEFAULT_BLOCK_SIZE: usize = 512;

#[derive(Debug, Parser)]
#[command(
    name = "djbooth-rs plugin",
    about = "Host and render VST2 instruments directly"
)]
struct Args {
    #[command(subcommand)]
    command: PluginCommand,
}

#[derive(Debug, Subcommand)]
enum PluginCommand {
    /// Report native plug-in host and Serum compatibility.
    Doctor {
        #[arg(long, default_value = DEFAULT_SERUM_BINARY)]
        plugin: PathBuf,
    },
    /// Load a VST2 instrument and print its metadata and parameters.
    Inspect {
        #[arg(long, default_value = DEFAULT_SERUM_BINARY)]
        plugin: PathBuf,
        /// Load an FXP before reporting its parameter state.
        #[arg(long)]
        preset: Option<PathBuf>,
    },
    /// Render a MIDI sequence through a VST2 instrument to a WAV file.
    Render {
        output: PathBuf,
        #[arg(long, default_value = DEFAULT_SERUM_BINARY)]
        plugin: PathBuf,
        #[arg(long, default_value = DEFAULT_SERUM_PRESET)]
        preset: PathBuf,
        /// JSON sequence. Omit for the built-in 128-BPM F# bass study.
        #[arg(long)]
        sequence: Option<PathBuf>,
        /// Override a normalized VST parameter as INDEX=VALUE; repeat as needed.
        #[arg(long = "parameter", value_parser = parse_parameter_override)]
        parameters: Vec<ParameterOverride>,
        #[arg(long, default_value_t = DEFAULT_SAMPLE_RATE)]
        sample_rate: u32,
        #[arg(long, default_value_t = DEFAULT_BLOCK_SIZE)]
        block_size: usize,
        #[arg(long, default_value_t = 1.0)]
        tail_seconds: f64,
        /// Play the completed WAV with the macOS system player.
        #[arg(long)]
        play: bool,
    },
}

#[derive(Clone, Debug)]
struct ParameterOverride {
    index: i32,
    value: f32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Sequence {
    pub(crate) bpm: f64,
    pub(crate) bars: u32,
    #[serde(default = "default_beats_per_bar")]
    pub(crate) beats_per_bar: u32,
    pub(crate) notes: Vec<SequenceNote>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SequenceNote {
    pub(crate) beat: f64,
    pub(crate) duration_beats: f64,
    pub(crate) note: u8,
    pub(crate) velocity: u8,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorReport {
    current_architecture: &'static str,
    plugin_path: PathBuf,
    plugin_exists: bool,
    serum_architectures: [&'static str; 2],
    compatible_process: bool,
    required_rust_target: &'static str,
    render_example: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectReport {
    name: String,
    vendor: String,
    version: i32,
    unique_id: i32,
    inputs: i32,
    outputs: i32,
    presets: i32,
    parameters: Vec<ParameterReport>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ParameterReport {
    index: i32,
    name: String,
    value: f32,
    display: String,
    label: String,
    automatable: bool,
}

#[derive(Debug)]
struct RenderHost {
    sample_rate: f64,
    bpm: f64,
    sample_position: u64,
    block_size: usize,
}

impl Host for RenderHost {
    fn get_info(&self) -> (isize, String, String) {
        (1, "djbooth.ai".to_owned(), "djbooth-rs".to_owned())
    }

    fn get_block_size(&self) -> isize {
        self.block_size as isize
    }

    fn get_time_info(&self, _mask: i32) -> Option<TimeInfo> {
        let ppq_position = self.sample_position as f64 / self.sample_rate * self.bpm / 60.0;
        let bar_start = (ppq_position / 4.0).floor() * 4.0;
        Some(TimeInfo {
            sample_pos: self.sample_position as f64,
            sample_rate: self.sample_rate,
            ppq_pos: ppq_position,
            tempo: self.bpm,
            bar_start_pos: bar_start,
            time_sig_numerator: 4,
            time_sig_denominator: 4,
            flags: (TimeInfoFlags::TRANSPORT_PLAYING
                | TimeInfoFlags::PPQ_POS_VALID
                | TimeInfoFlags::TEMPO_VALID
                | TimeInfoFlags::BARS_VALID
                | TimeInfoFlags::TIME_SIG_VALID)
                .bits(),
            ..TimeInfo::default()
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ScheduledMidi {
    sample: u64,
    data: [u8; 3],
}

pub(crate) fn run(args: impl Iterator<Item = String>) -> Result<()> {
    let arguments = Args::parse_from(std::iter::once("djbooth-rs plugin".to_owned()).chain(args));
    match arguments.command {
        PluginCommand::Doctor { plugin } => doctor(plugin),
        PluginCommand::Inspect { plugin, preset } => inspect(&plugin, preset.as_deref()),
        PluginCommand::Render {
            output,
            plugin,
            preset,
            sequence,
            parameters,
            sample_rate,
            block_size,
            tail_seconds,
            play,
        } => render(RenderRequest {
            output,
            plugin,
            preset,
            sequence,
            parameters,
            sample_rate,
            block_size,
            tail_seconds,
            play,
        }),
    }
}

fn doctor(plugin: PathBuf) -> Result<()> {
    let report = DoctorReport {
        current_architecture: std::env::consts::ARCH,
        plugin_exists: plugin.is_file(),
        plugin_path: plugin,
        serum_architectures: ["x86_64", "i386"],
        compatible_process: cfg!(target_arch = "x86_64"),
        required_rust_target: "x86_64-apple-darwin",
        render_example: "cargo run --manifest-path rust/Cargo.toml --target x86_64-apple-darwin -p djbooth-rs -- plugin render /tmp/serum-bass.wav --play".to_owned(),
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn inspect(plugin_path: &Path, preset_path: Option<&Path>) -> Result<()> {
    require_compatible_plugin(plugin_path)?;
    let host = Arc::new(Mutex::new(RenderHost {
        sample_rate: f64::from(DEFAULT_SAMPLE_RATE),
        bpm: 120.0,
        sample_position: 0,
        block_size: DEFAULT_BLOCK_SIZE,
    }));
    let (loader, mut plugin) = load_plugin(plugin_path, host)?;
    plugin.init();
    let info = plugin.get_info();
    let parameter_object = plugin.get_parameter_object();
    if let Some(preset_path) = preset_path {
        let preset = read_fxp(preset_path)?;
        ensure!(
            preset.plugin_id == u32::from_be_bytes(info.unique_id.to_be_bytes()),
            "preset plug-in ID does not match loaded plug-in"
        );
        parameter_object.load_preset_data(&preset.chunk);
    }
    let parameters = (0..info.parameters)
        .map(|index| ParameterReport {
            index,
            name: parameter_object.get_parameter_name(index),
            value: parameter_object.get_parameter(index),
            display: parameter_object.get_parameter_text(index),
            label: parameter_object.get_parameter_label(index),
            automatable: parameter_object.can_be_automated(index),
        })
        .collect();
    let report = InspectReport {
        name: info.name,
        vendor: info.vendor,
        version: info.version,
        unique_id: info.unique_id,
        inputs: info.inputs,
        outputs: info.outputs,
        presets: info.presets,
        parameters,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    drop(plugin);
    drop(loader);
    Ok(())
}

struct RenderRequest {
    output: PathBuf,
    plugin: PathBuf,
    preset: PathBuf,
    sequence: Option<PathBuf>,
    parameters: Vec<ParameterOverride>,
    sample_rate: u32,
    block_size: usize,
    tail_seconds: f64,
    play: bool,
}

#[derive(Clone, Debug)]
pub(crate) enum ParameterTarget {
    /// A raw VST value. Reserved for controls whose public Serum scale is already 0..1.
    Normalized(f32),
    /// Match the numeric value Serum itself displays, converting its unit where necessary.
    Display { value: f32, unit: DisplayUnit },
    /// Match a named Serum choice such as `MG Low 24` or `Tube`.
    Choice(String),
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum DisplayUnit {
    Milliseconds,
    Hertz,
    Decibels,
    Semitones,
}

pub(crate) struct NamedParameterOverride {
    pub(crate) name: String,
    pub(crate) target: ParameterTarget,
}

#[derive(Clone, Debug)]
pub(crate) struct AutomationEnvelope {
    pub(crate) duration_seconds: f64,
    pub(crate) points: Vec<AutomationPoint>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct AutomationPoint {
    pub(crate) position: f32,
    pub(crate) value: f32,
}

#[derive(Clone, Debug)]
pub(crate) enum ControlAutomation {
    Parameter {
        name: String,
        minimum: ParameterTarget,
        maximum: ParameterTarget,
        envelope: AutomationEnvelope,
    },
    PitchBend {
        semitones: f32,
        envelope: AutomationEnvelope,
    },
}

pub(crate) struct OfflineInstrumentRequest<'a> {
    pub(crate) plugin: &'a Path,
    pub(crate) preset: &'a Path,
    pub(crate) sequence: &'a Sequence,
    pub(crate) parameters: &'a [NamedParameterOverride],
    pub(crate) automations: &'a [ControlAutomation],
    pub(crate) sample_rate: u32,
    pub(crate) block_size: usize,
    pub(crate) tail_seconds: f64,
}

pub(crate) struct OfflineInstrumentRender {
    pub(crate) frames: Vec<[f32; 2]>,
    pub(crate) plugin_name: String,
}

pub(crate) fn render_instrument_offline(
    request: OfflineInstrumentRequest<'_>,
) -> Result<OfflineInstrumentRender> {
    require_compatible_plugin(request.plugin)?;
    ensure!(request.sample_rate > 0, "sample rate must be positive");
    ensure!(request.block_size > 0, "block size must be positive");
    ensure!(
        request.tail_seconds.is_finite() && request.tail_seconds >= 0.0,
        "tail seconds must be finite and non-negative"
    );
    validate_sequence(request.sequence)?;

    let host = Arc::new(Mutex::new(RenderHost {
        sample_rate: f64::from(request.sample_rate),
        bpm: request.sequence.bpm,
        sample_position: 0,
        block_size: request.block_size,
    }));
    let (_loader, mut plugin) = load_plugin(request.plugin, Arc::clone(&host))?;
    plugin.init();
    plugin.set_sample_rate(request.sample_rate as f32);
    plugin.set_block_size(request.block_size as i64);

    let preset = read_fxp(request.preset)?;
    let info = plugin.get_info();
    ensure!(
        preset.plugin_id == u32::from_be_bytes(info.unique_id.to_be_bytes()),
        "preset plug-in ID 0x{:08x} does not match loaded plug-in ID 0x{:08x}",
        preset.plugin_id,
        u32::from_be_bytes(info.unique_id.to_be_bytes())
    );
    let parameter_object = plugin.get_parameter_object();
    parameter_object.load_preset_data(&preset.chunk);
    for parameter in request.parameters {
        let index = (0..info.parameters)
            .find(|index| {
                parameter_object
                    .get_parameter_name(*index)
                    .eq_ignore_ascii_case(&parameter.name)
            })
            .with_context(|| {
                format!(
                    "plug-in '{}' does not expose parameter '{}'",
                    info.name, parameter.name
                )
            })?;
        let value = resolve_parameter_target(&*parameter_object, index, &parameter.target)
            .with_context(|| format!("failed to resolve Serum control '{}'", parameter.name))?;
        parameter_object.set_parameter(index, value);
    }
    let automations =
        resolve_automations(&*parameter_object, info.parameters, request.automations)?;

    plugin.resume();
    let total_beats = f64::from(request.sequence.bars * request.sequence.beats_per_bar);
    let musical_seconds = total_beats * 60.0 / request.sequence.bpm;
    let total_frames =
        ((musical_seconds + request.tail_seconds) * f64::from(request.sample_rate)).ceil() as u64;
    let events = schedule_midi(request.sequence, request.sample_rate);
    let frames = render_blocks(
        &mut plugin,
        &host,
        &events,
        info.inputs.max(0) as usize,
        info.outputs.max(0) as usize,
        request.block_size,
        total_frames,
        &*parameter_object,
        &automations,
        request.sample_rate,
    )?;
    plugin.suspend();
    Ok(OfflineInstrumentRender {
        frames,
        plugin_name: info.name,
    })
}

fn resolve_parameter_target(
    parameters: &dyn vst::plugin::PluginParameters,
    index: i32,
    target: &ParameterTarget,
) -> Result<f32> {
    match target {
        ParameterTarget::Normalized(value) => {
            ensure!(
                value.is_finite() && (0.0..=1.0).contains(value),
                "normalized value must be between 0 and 1"
            );
            Ok(*value)
        }
        ParameterTarget::Choice(wanted) => {
            let wanted = wanted.trim();
            let mut matches = Vec::new();
            for step in 0..=2_048 {
                let value = step as f32 / 2_048.0;
                parameters.set_parameter(index, value);
                if parameters.get_parameter_text(index).trim() == wanted {
                    matches.push(value);
                }
            }
            ensure!(!matches.is_empty(), "Serum has no choice named '{wanted}'");
            Ok((matches[0] + matches[matches.len() - 1]) * 0.5)
        }
        ParameterTarget::Display { value, unit } => {
            ensure!(value.is_finite(), "display value must be finite");
            let mut best = None::<(f32, f32, String)>;
            for step in 0..=4_096 {
                let normalized = step as f32 / 4_096.0;
                parameters.set_parameter(index, normalized);
                let display = parameters.get_parameter_text(index);
                let label = parameters.get_parameter_label(index);
                let Some(actual) = parse_display_value(&display, &label, *unit) else {
                    continue;
                };
                let error = (actual - value).abs();
                if best.as_ref().is_none_or(|candidate| error < candidate.0) {
                    best = Some((
                        error,
                        normalized,
                        format!("{} {}", display.trim(), label.trim()),
                    ));
                }
            }
            let (error, normalized, matched) = best.context("Serum returned no numeric values")?;
            let tolerance = match unit {
                DisplayUnit::Milliseconds => value.abs().mul_add(0.02, 0.55),
                DisplayUnit::Hertz => value.abs().mul_add(0.015, 1.0),
                DisplayUnit::Decibels => 0.15,
                DisplayUnit::Semitones => 0.1,
            };
            ensure!(
                error <= tolerance,
                "closest available value is {matched}, not {value:?} {unit:?}"
            );
            Ok(normalized)
        }
    }
}

fn parse_display_value(display: &str, label: &str, unit: DisplayUnit) -> Option<f32> {
    let value = display.trim().parse::<f32>().ok()?;
    let label = label.trim();
    match unit {
        DisplayUnit::Milliseconds => match label {
            "ms" => Some(value),
            "s" => Some(value * 1_000.0),
            _ => None,
        },
        DisplayUnit::Hertz => match label {
            "Hz" => Some(value),
            "kHz" => Some(value * 1_000.0),
            _ => None,
        },
        DisplayUnit::Decibels => (label == "dB").then_some(value),
        DisplayUnit::Semitones => (label == "semitones").then_some(value),
    }
}

#[derive(Clone, Debug)]
enum ResolvedAutomation {
    Parameter {
        index: i32,
        minimum: f32,
        maximum: f32,
        envelope: AutomationEnvelope,
    },
    PitchBend {
        envelope: AutomationEnvelope,
    },
}

fn resolve_automations(
    parameters: &dyn vst::plugin::PluginParameters,
    parameter_count: i32,
    automations: &[ControlAutomation],
) -> Result<Vec<ResolvedAutomation>> {
    automations
        .iter()
        .map(|automation| {
            validate_automation_envelope(automation.envelope())?;
            match automation {
                ControlAutomation::Parameter {
                    name,
                    minimum,
                    maximum,
                    envelope,
                } => {
                    let index = (0..parameter_count)
                        .find(|index| {
                            parameters
                                .get_parameter_name(*index)
                                .eq_ignore_ascii_case(name)
                        })
                        .with_context(|| {
                            format!("Serum does not expose automation target '{name}'")
                        })?;
                    let minimum = resolve_parameter_target(parameters, index, minimum)?;
                    let maximum = resolve_parameter_target(parameters, index, maximum)?;
                    Ok(ResolvedAutomation::Parameter {
                        index,
                        minimum,
                        maximum,
                        envelope: envelope.clone(),
                    })
                }
                ControlAutomation::PitchBend {
                    semitones,
                    envelope,
                } => {
                    ensure!(
                        semitones.is_finite() && *semitones > 0.0 && *semitones <= 24.0,
                        "pitch-bend automation must be 0..24 semitones"
                    );
                    let bend_index = (0..parameter_count)
                        .find(|index| parameters.get_parameter_name(*index) == "Bend U")
                        .context("Serum does not expose Bend U")?;
                    let bend_range = resolve_parameter_target(
                        parameters,
                        bend_index,
                        &ParameterTarget::Display {
                            value: *semitones,
                            unit: DisplayUnit::Semitones,
                        },
                    )?;
                    parameters.set_parameter(bend_index, bend_range);
                    Ok(ResolvedAutomation::PitchBend {
                        envelope: envelope.clone(),
                    })
                }
            }
        })
        .collect()
}

impl ControlAutomation {
    fn envelope(&self) -> &AutomationEnvelope {
        match self {
            Self::Parameter { envelope, .. } | Self::PitchBend { envelope, .. } => envelope,
        }
    }
}

fn validate_automation_envelope(envelope: &AutomationEnvelope) -> Result<()> {
    ensure!(
        envelope.duration_seconds.is_finite() && envelope.duration_seconds > 0.0,
        "automation duration must be positive"
    );
    ensure!(
        envelope.points.len() >= 2,
        "automation needs at least two points"
    );
    ensure!(
        envelope
            .points
            .first()
            .is_some_and(|point| point.position == 0.0)
            && envelope
                .points
                .last()
                .is_some_and(|point| point.position == 1.0),
        "automation points must span 0..1"
    );
    for pair in envelope.points.windows(2) {
        ensure!(
            pair[0].position < pair[1].position,
            "automation points must be ordered"
        );
    }
    for point in &envelope.points {
        ensure!(
            point.position.is_finite()
                && (0.0..=1.0).contains(&point.position)
                && point.value.is_finite()
                && (0.0..=1.0).contains(&point.value),
            "automation points must use normalized positions and values"
        );
    }
    Ok(())
}

fn render(request: RenderRequest) -> Result<()> {
    require_compatible_plugin(&request.plugin)?;
    ensure!(request.sample_rate > 0, "sample rate must be positive");
    ensure!(request.block_size > 0, "block size must be positive");
    ensure!(
        request.tail_seconds.is_finite() && request.tail_seconds >= 0.0,
        "tail seconds must be finite and non-negative"
    );
    let sequence = match request.sequence.as_deref() {
        Some(path) => serde_json::from_slice::<Sequence>(
            &fs::read(path).with_context(|| format!("failed to read {}", path.display()))?,
        )
        .with_context(|| format!("invalid sequence JSON in {}", path.display()))?,
        None => bass_study_sequence(),
    };
    validate_sequence(&sequence)?;

    let host = Arc::new(Mutex::new(RenderHost {
        sample_rate: f64::from(request.sample_rate),
        bpm: sequence.bpm,
        sample_position: 0,
        block_size: request.block_size,
    }));
    let (_loader, mut plugin) = load_plugin(&request.plugin, Arc::clone(&host))?;
    plugin.init();
    plugin.set_sample_rate(request.sample_rate as f32);
    plugin.set_block_size(request.block_size as i64);

    let preset = read_fxp(&request.preset)?;
    let info = plugin.get_info();
    ensure!(
        preset.plugin_id == u32::from_be_bytes(info.unique_id.to_be_bytes()),
        "preset plug-in ID 0x{:08x} does not match loaded plug-in ID 0x{:08x}",
        preset.plugin_id,
        u32::from_be_bytes(info.unique_id.to_be_bytes())
    );
    let parameter_object = plugin.get_parameter_object();
    parameter_object.load_preset_data(&preset.chunk);
    for override_value in &request.parameters {
        ensure!(
            override_value.index >= 0 && override_value.index < info.parameters,
            "parameter index {} is outside 0..{}",
            override_value.index,
            info.parameters
        );
        parameter_object.set_parameter(override_value.index, override_value.value);
    }

    plugin.resume();
    let total_beats = f64::from(sequence.bars * sequence.beats_per_bar);
    let musical_seconds = total_beats * 60.0 / sequence.bpm;
    let total_frames =
        ((musical_seconds + request.tail_seconds) * f64::from(request.sample_rate)).ceil() as u64;
    let events = schedule_midi(&sequence, request.sample_rate);
    let rendered = render_blocks(
        &mut plugin,
        &host,
        &events,
        info.inputs.max(0) as usize,
        info.outputs.max(0) as usize,
        request.block_size,
        total_frames,
        &*parameter_object,
        &[],
        request.sample_rate,
    )?;
    plugin.suspend();
    write_wav(&request.output, request.sample_rate, &rendered)?;

    let report = serde_json::json!({
        "output": request.output,
        "plugin": info.name,
        "vendor": info.vendor,
        "preset": preset.name,
        "bpm": sequence.bpm,
        "bars": sequence.bars,
        "notes": sequence.notes.len(),
        "sampleRate": request.sample_rate,
        "frames": total_frames,
        "durationSeconds": total_frames as f64 / f64::from(request.sample_rate),
    });
    println!("{}", serde_json::to_string_pretty(&report)?);

    if request.play {
        let status = Command::new("/usr/bin/afplay")
            .arg(&request.output)
            .status()
            .context("failed to start /usr/bin/afplay")?;
        ensure!(status.success(), "afplay exited with {status}");
    }
    Ok(())
}

fn load_plugin(
    plugin_path: &Path,
    host: Arc<Mutex<RenderHost>>,
) -> Result<(PluginLoader<RenderHost>, vst::host::PluginInstance)> {
    let mut loader = PluginLoader::load(plugin_path, host)
        .map_err(|error| anyhow::anyhow!("failed to load {}: {error}", plugin_path.display()))?;
    let plugin = loader.instance().map_err(|error| {
        anyhow::anyhow!("failed to instantiate {}: {error}", plugin_path.display())
    })?;
    Ok((loader, plugin))
}

fn require_compatible_plugin(plugin_path: &Path) -> Result<()> {
    ensure!(
        plugin_path.is_file(),
        "VST2 binary does not exist: {}",
        plugin_path.display()
    );
    if !cfg!(target_arch = "x86_64") {
        bail!(
            "{} is x86_64-only; rebuild and run djbooth-rs with --target x86_64-apple-darwin",
            plugin_path.display()
        );
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn render_blocks(
    plugin: &mut vst::host::PluginInstance,
    host: &Arc<Mutex<RenderHost>>,
    events: &[ScheduledMidi],
    input_count: usize,
    output_count: usize,
    block_size: usize,
    total_frames: u64,
    parameters: &dyn vst::plugin::PluginParameters,
    automations: &[ResolvedAutomation],
    sample_rate: u32,
) -> Result<Vec<[f32; 2]>> {
    ensure!(output_count > 0, "instrument exposes no audio outputs");
    let inputs = vec![vec![0.0_f32; block_size]; input_count];
    let mut outputs = vec![vec![0.0_f32; block_size]; output_count];
    let mut host_buffer = HostBuffer::<f32>::new(input_count, output_count);
    let mut event_buffer = SendEventBuffer::new(256);
    let mut rendered = Vec::with_capacity(total_frames as usize);
    let mut position = 0_u64;
    let mut event_index = 0_usize;
    let note_starts = events
        .iter()
        .filter(|event| event.data[0] & 0xf0 == 0x90 && event.data[2] > 0)
        .map(|event| event.sample)
        .collect::<Vec<_>>();

    while position < total_frames {
        let mut frames = usize::try_from((total_frames - position).min(block_size as u64))?;
        if let Some(next_event) = events[event_index..]
            .iter()
            .find(|event| event.sample > position)
            .filter(|event| event.sample < position + frames as u64)
        {
            frames = usize::try_from(next_event.sample - position)?;
        }
        host.lock()
            .expect("render host lock poisoned")
            .sample_position = position;
        let block_end = position + frames as u64;
        let mut block_events = Vec::new();
        for automation in automations {
            let value =
                automation_value(automation.envelope(), position, &note_starts, sample_rate);
            match automation {
                ResolvedAutomation::Parameter {
                    index,
                    minimum,
                    maximum,
                    ..
                } => parameters.set_parameter(*index, minimum + (maximum - minimum) * value),
                ResolvedAutomation::PitchBend { .. } => {
                    let bend = (8192.0 + value * 8191.0).round().clamp(0.0, 16383.0) as u16;
                    block_events.push(MidiEvent {
                        data: [0xe0, (bend & 0x7f) as u8, ((bend >> 7) & 0x7f) as u8],
                        delta_frames: 0,
                        live: false,
                        note_length: None,
                        note_offset: None,
                        detune: 0,
                        note_off_velocity: 0,
                    });
                }
            }
        }
        while let Some(event) = events
            .get(event_index)
            .filter(|event| event.sample < block_end)
        {
            if event.sample >= position {
                block_events.push(MidiEvent {
                    data: event.data,
                    delta_frames: i32::try_from(event.sample - position)?,
                    live: false,
                    note_length: None,
                    note_offset: None,
                    detune: 0,
                    note_off_velocity: 0,
                });
            }
            event_index += 1;
        }
        event_buffer.store_events(block_events);
        plugin.process_events(event_buffer.events());
        for channel in &mut outputs {
            channel[..frames].fill(0.0);
        }
        let input_slices = inputs
            .iter()
            .map(|channel| &channel[..frames])
            .collect::<Vec<_>>();
        let mut output_slices = outputs
            .iter_mut()
            .map(|channel| &mut channel[..frames])
            .collect::<Vec<_>>();
        let mut audio_buffer = host_buffer.bind(&input_slices, &mut output_slices);
        plugin.process(&mut audio_buffer);
        for frame in 0..frames {
            let left = outputs[0][frame];
            let right = outputs.get(1).map_or(left, |channel| channel[frame]);
            rendered.push([left, right]);
        }
        position = block_end;
    }
    Ok(rendered)
}

impl ResolvedAutomation {
    fn envelope(&self) -> &AutomationEnvelope {
        match self {
            Self::Parameter { envelope, .. } | Self::PitchBend { envelope } => envelope,
        }
    }
}

fn automation_value(
    envelope: &AutomationEnvelope,
    sample: u64,
    note_starts: &[u64],
    sample_rate: u32,
) -> f32 {
    let Some(start_index) = note_starts
        .partition_point(|start| *start <= sample)
        .checked_sub(1)
    else {
        return envelope.points.last().map_or(0.0, |point| point.value);
    };
    let elapsed = (sample - note_starts[start_index]) as f64 / f64::from(sample_rate);
    let position = (elapsed / envelope.duration_seconds).clamp(0.0, 1.0) as f32;
    let Some(pair) = envelope
        .points
        .windows(2)
        .find(|pair| position >= pair[0].position && position <= pair[1].position)
    else {
        return envelope.points.last().map_or(0.0, |point| point.value);
    };
    let progress = (position - pair[0].position) / (pair[1].position - pair[0].position);
    pair[0].value + (pair[1].value - pair[0].value) * progress
}

fn schedule_midi(sequence: &Sequence, sample_rate: u32) -> Vec<ScheduledMidi> {
    let frames_per_beat = f64::from(sample_rate) * 60.0 / sequence.bpm;
    let mut events = Vec::with_capacity(sequence.notes.len() * 2);
    for note in &sequence.notes {
        events.push(ScheduledMidi {
            sample: (note.beat * frames_per_beat).round() as u64,
            data: [0x90, note.note, note.velocity],
        });
        events.push(ScheduledMidi {
            sample: ((note.beat + note.duration_beats) * frames_per_beat).round() as u64,
            data: [0x80, note.note, 0],
        });
    }
    events.sort_by_key(|event| (event.sample, event.data[0] == 0x90));
    events
}

pub(crate) fn validate_sequence(sequence: &Sequence) -> Result<()> {
    ensure!(
        sequence.bpm.is_finite() && sequence.bpm > 0.0,
        "sequence BPM must be positive and finite"
    );
    ensure!(sequence.bars > 0, "sequence must contain at least one bar");
    ensure!(sequence.beats_per_bar > 0, "beats per bar must be positive");
    let total_beats = f64::from(sequence.bars * sequence.beats_per_bar);
    for (index, note) in sequence.notes.iter().enumerate() {
        ensure!(
            note.beat.is_finite() && note.beat >= 0.0,
            "note {index} has an invalid beat"
        );
        ensure!(
            note.duration_beats.is_finite() && note.duration_beats > 0.0,
            "note {index} has an invalid duration"
        );
        ensure!(
            note.beat + note.duration_beats <= total_beats,
            "note {index} ends after the sequence"
        );
        ensure!(note.note <= 127, "note {index} has an invalid MIDI pitch");
        ensure!(
            note.velocity > 0 && note.velocity <= 127,
            "note {index} has an invalid velocity"
        );
    }
    Ok(())
}

fn bass_study_sequence() -> Sequence {
    let two_bar_pattern = [
        (0.50, 0.38, 30, 110),
        (1.25, 0.24, 30, 96),
        (1.75, 0.20, 30, 104),
        (2.50, 0.38, 30, 112),
        (3.25, 0.22, 42, 90),
        (3.75, 0.20, 30, 108),
        (4.50, 0.36, 30, 112),
        (5.25, 0.22, 30, 98),
        (5.75, 0.20, 30, 106),
        (6.50, 0.38, 30, 114),
        (7.10, 0.18, 30, 92),
        (7.50, 0.18, 42, 96),
        (7.75, 0.18, 30, 110),
    ];
    let notes = (0..2)
        .flat_map(|repeat| {
            two_bar_pattern.map(move |(beat, duration_beats, note, velocity)| SequenceNote {
                beat: beat + f64::from(repeat * 8),
                duration_beats,
                note,
                velocity,
            })
        })
        .collect();
    Sequence {
        bpm: 128.0,
        bars: 4,
        beats_per_bar: 4,
        notes,
    }
}

struct FxpPreset {
    plugin_id: u32,
    name: String,
    chunk: Vec<u8>,
}

fn read_fxp(path: &Path) -> Result<FxpPreset> {
    let data = fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    parse_fxp(&data).with_context(|| format!("invalid FXP preset {}", path.display()))
}

fn parse_fxp(data: &[u8]) -> Result<FxpPreset> {
    ensure!(data.len() >= 60, "FXP is shorter than its 60-byte header");
    ensure!(&data[0..4] == b"CcnK", "missing FXP container magic");
    ensure!(
        &data[8..12] == b"FPCh",
        "only chunk-based FPCh presets are supported"
    );
    let declared_size = read_be_u32(data, 4)? as usize;
    ensure!(
        declared_size == data.len() || declared_size + 8 == data.len(),
        "FXP declared size does not match file size"
    );
    let plugin_id = read_be_u32(data, 16)?;
    let name = String::from_utf8_lossy(&data[28..56])
        .trim_end_matches('\0')
        .to_owned();
    let chunk_size = read_be_u32(data, 56)? as usize;
    ensure!(
        60 + chunk_size == data.len(),
        "FXP chunk size does not match file size"
    );
    Ok(FxpPreset {
        plugin_id,
        name,
        chunk: data[60..].to_vec(),
    })
}

fn read_be_u32(data: &[u8], offset: usize) -> Result<u32> {
    let bytes: [u8; 4] = data
        .get(offset..offset + 4)
        .context("FXP integer lies outside the file")?
        .try_into()?;
    Ok(u32::from_be_bytes(bytes))
}

pub(crate) fn write_wav(path: &Path, sample_rate: u32, frames: &[[f32; 2]]) -> Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let specification = hound::WavSpec {
        channels: 2,
        sample_rate,
        bits_per_sample: 24,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, specification)
        .with_context(|| format!("failed to create {}", path.display()))?;
    let scale = ((1_i32 << 23) - 1) as f32;
    for frame in frames {
        for sample in frame {
            writer.write_sample((sample.clamp(-1.0, 1.0) * scale).round() as i32)?;
        }
    }
    writer.finalize()?;
    Ok(())
}

fn parse_parameter_override(value: &str) -> std::result::Result<ParameterOverride, String> {
    let (index, normalized) = value
        .split_once('=')
        .ok_or_else(|| "expected INDEX=VALUE".to_owned())?;
    let index = index
        .parse::<i32>()
        .map_err(|error| format!("invalid parameter index: {error}"))?;
    let value = normalized
        .parse::<f32>()
        .map_err(|error| format!("invalid parameter value: {error}"))?;
    if index < 0 {
        return Err("parameter index must be non-negative".to_owned());
    }
    if !value.is_finite() || !(0.0..=1.0).contains(&value) {
        return Err("parameter value must be between 0 and 1".to_owned());
    }
    Ok(ParameterOverride { index, value })
}

const fn default_beats_per_bar() -> u32 {
    4
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_chunk_fxp() {
        let chunk = [1_u8, 2, 3, 4];
        let mut data = Vec::new();
        data.extend_from_slice(b"CcnK");
        data.extend_from_slice(&(52_u32 + chunk.len() as u32).to_be_bytes());
        data.extend_from_slice(b"FPCh");
        data.extend_from_slice(&1_u32.to_be_bytes());
        data.extend_from_slice(b"XfsX");
        data.extend_from_slice(&1_u32.to_be_bytes());
        data.extend_from_slice(&1_u32.to_be_bytes());
        let mut name = [0_u8; 28];
        name[..4].copy_from_slice(b"Bass");
        data.extend_from_slice(&name);
        data.extend_from_slice(&(chunk.len() as u32).to_be_bytes());
        data.extend_from_slice(&chunk);

        let preset = parse_fxp(&data).expect("valid FXP");
        assert_eq!(preset.plugin_id, u32::from_be_bytes(*b"XfsX"));
        assert_eq!(preset.name, "Bass");
        assert_eq!(preset.chunk, chunk);
    }

    #[test]
    fn schedules_note_on_and_off_at_sample_offsets() {
        let sequence = Sequence {
            bpm: 120.0,
            bars: 1,
            beats_per_bar: 4,
            notes: vec![SequenceNote {
                beat: 0.5,
                duration_beats: 0.25,
                note: 30,
                velocity: 100,
            }],
        };
        let events = schedule_midi(&sequence, 48_000);
        assert_eq!(
            events,
            [
                ScheduledMidi {
                    sample: 12_000,
                    data: [0x90, 30, 100]
                },
                ScheduledMidi {
                    sample: 18_000,
                    data: [0x80, 30, 0]
                }
            ]
        );
    }

    #[test]
    fn built_in_bass_study_fits_four_bars() {
        let sequence = bass_study_sequence();
        validate_sequence(&sequence).expect("built-in sequence");
        assert_eq!(sequence.bpm, 128.0);
        assert_eq!(sequence.bars, 4);
        assert!(
            sequence
                .notes
                .iter()
                .all(|note| note.note == 30 || note.note == 42)
        );
    }

    #[test]
    fn automation_interpolates_and_holds_its_final_value() {
        let envelope = AutomationEnvelope {
            duration_seconds: 0.1,
            points: vec![
                AutomationPoint {
                    position: 0.0,
                    value: 1.0,
                },
                AutomationPoint {
                    position: 0.5,
                    value: 0.25,
                },
                AutomationPoint {
                    position: 1.0,
                    value: 0.0,
                },
            ],
        };

        assert_eq!(automation_value(&envelope, 0, &[0], 1_000), 1.0);
        assert!((automation_value(&envelope, 25, &[0], 1_000) - 0.625).abs() < 1e-6);
        assert_eq!(automation_value(&envelope, 150, &[0], 1_000), 0.0);
    }

    #[test]
    fn automation_retriggers_from_each_note_start() {
        let envelope = AutomationEnvelope {
            duration_seconds: 0.1,
            points: vec![
                AutomationPoint {
                    position: 0.0,
                    value: 1.0,
                },
                AutomationPoint {
                    position: 1.0,
                    value: 0.0,
                },
            ],
        };

        assert!((automation_value(&envelope, 99, &[0, 100], 1_000) - 0.01).abs() < 1e-6);
        assert_eq!(automation_value(&envelope, 100, &[0, 100], 1_000), 1.0);
        assert_eq!(automation_value(&envelope, 150, &[0, 100], 1_000), 0.5);
    }
}
