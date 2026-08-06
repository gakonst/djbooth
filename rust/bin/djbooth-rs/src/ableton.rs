use std::collections::BTreeMap;
use std::ffi::{CStr, CString, c_void};
use std::fs;
use std::io::{Read, Write};
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail, ensure};
use clap::{Parser, Subcommand};
use flate2::read::GzDecoder;
use roxmltree::{Document, Node};
use serde::Serialize;
use sha2::{Digest, Sha256};
use walkdir::WalkDir;

use crate::plugin::{Sequence, validate_sequence, write_wav};

const DEFAULT_SAMPLE_RATE: u32 = 44_100;
const DRUM_RACK_BASE_NOTE: u8 = 36;
const DEFAULT_CORE_LIBRARY: &str =
    "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Core Library";
const DEFAULT_MAX_CONTENTS: &str =
    "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Max/Max.app/Contents";
const DEFAULT_NATIVE_DEVICES: &str =
    "/Applications/Ableton Live 12 Suite.app/Contents/App-Resources/Devices/Mac";
const DEFAULT_LIVE_ENGINE: &str = "/Applications/Ableton Live 12 Suite.app/Contents/Resources/Ableton Live Engine.bundle/Contents/MacOS/Ableton Live Engine";
const LIVE_ENGINE_12_3_1_SHA256: &str =
    "858547f8bd32931aa9e2b25b2a4fde5ade16e0ea45a0b039cad82b99b431c86e";
const LIVE_ENGINE_DEVICE_NAMES: &[&str] = &[
    "AutoFilter",
    "OAutoFilter2Processor",
    "OAutoPanProcessor",
    "OAutoPan2Processor",
    "OAutoShiftProcessor",
    "BeatRepeatControl",
    "BeatRepeatMixer",
    "BeatRepeatRingBuffer",
    "Chorus",
    "OChorus2Processor",
    "Compressor2",
    "OChannelEqProcessor",
    "ODriftProcessor",
    "DrumBussProcessor",
    "ODrumSamplerProcessor",
    "OEchoProcessor",
    "Eq8",
    "Erosion",
    "FilterDelay",
    "FilterEQ3",
    "Flanger",
    "FrequencyShifter",
    "Gate",
    "OGlueCompressorProcessor",
    "GrainDelay",
    "OHybridProcessor",
    "InstrumentImpulse",
    "InstrumentOperator",
    "OInstrumentWavetableProcessor",
    "OLimiterBufferProcessor",
    "OLimiterSampleProcessor",
    "Looper",
    "OMeldProcessor",
    "MidiArpeggiator",
    "MidiChord",
    "MidiNoteLength",
    "MidiPitcher",
    "MidiRandom",
    "MidiScale",
    "MidiVelocity",
    "MultibandDynamics",
    "Overdrive",
    "PedalProcessor",
    "Phaser",
    "OPhaserNewProcessor",
    "Redux",
    "ORedux2Processor",
    "Resonator",
    "OReverbProcessor",
    "ORoarProcessor",
    "Saturator",
    "OShifterProcessor",
    "OSpectralProcessor",
    "SpectrumAnalyzer",
    "OTransmuteProcessor",
    "Tube",
    "TunerProcessor",
    "Vinyl",
    "Vocoder",
];
const MAX_AMXD_RENDER_TEMPLATE: &str =
    include_str!("../fixtures/max/ableton-bassline-render.maxpat");
const MAX_DSP_EFFECT_RENDER_TEMPLATE: &str =
    include_str!("../fixtures/max/ableton-dsp-effect-render.maxpat");
const MAX_DSP_INSTRUMENT_RENDER_TEMPLATE: &str =
    include_str!("../fixtures/max/ableton-dsp-instrument-render.maxpat");

#[derive(Debug, Parser)]
#[command(
    name = "djbooth-rs ableton",
    about = "Inspect and import Ableton rack and clip assets"
)]
struct Args {
    #[command(subcommand)]
    command: AbletonCommand,
}

#[derive(Debug, Subcommand)]
enum AbletonCommand {
    /// Render MIDI through one of Ableton's native device bundles in-process.
    RenderNativeDevice {
        output: PathBuf,
        #[arg(long, default_value = "Analog")]
        device: String,
        #[arg(long, default_value = DEFAULT_NATIVE_DEVICES)]
        devices_root: PathBuf,
        #[arg(long, default_value_t = 36)]
        note: u8,
        #[arg(long, default_value_t = 110)]
        velocity: u8,
        /// JSON MIDI sequence. When omitted, render the single-note audition.
        #[arg(long)]
        sequence: Option<PathBuf>,
        #[arg(long, default_value_t = DEFAULT_SAMPLE_RATE)]
        sample_rate: u32,
        /// Audio retained after the end of a sequence or input file.
        #[arg(long, default_value_t = 1.0)]
        tail_seconds: f64,
        /// Optional stereo WAV fed into audio-effect devices.
        #[arg(long)]
        input: Option<PathBuf>,
        /// Ableton ADV preset applied to the native engine.
        #[arg(long)]
        preset: Option<PathBuf>,
        /// Native Ableton parameter assignment in ID=VALUE form. Repeatable.
        #[arg(long = "parameter", value_name = "ID=VALUE")]
        parameters: Vec<String>,
    },
    /// Render an AMXD with Ableton's bundled Max engine and no custom DSP.
    RenderMaxAmxd {
        amxd: PathBuf,
        output: PathBuf,
        /// Optional WAV routed into Max audio-effect devices.
        #[arg(long)]
        input: Option<PathBuf>,
        #[arg(long, default_value = DEFAULT_MAX_CONTENTS)]
        max_contents: PathBuf,
        #[arg(long, default_value_t = 36)]
        note_one: u8,
        #[arg(long, default_value_t = 39)]
        note_two: u8,
        #[arg(long, default_value_t = 110)]
        velocity: u8,
    },
    /// Render audio through an Ableton `ableton-dsp` Max external.
    RenderMaxObject {
        object: String,
        input: PathBuf,
        output: PathBuf,
        #[arg(long, default_value = DEFAULT_MAX_CONTENTS)]
        max_contents: PathBuf,
        #[arg(long, default_value_t = 1.0)]
        tail_seconds: f64,
    },
    /// Render MIDI through an Ableton `ableton-dsp` Max instrument external.
    RenderMaxInstrument {
        object: String,
        output: PathBuf,
        #[arg(long, default_value = DEFAULT_MAX_CONTENTS)]
        max_contents: PathBuf,
        #[arg(long, default_value_t = 48)]
        note: u8,
        #[arg(long, default_value_t = 110)]
        velocity: u8,
    },
    /// Inventory Ableton's shipped `ableton-dsp` Max objects and attributes.
    MaxObjects {
        #[arg(long, default_value = DEFAULT_MAX_CONTENTS)]
        max_contents: PathBuf,
        #[arg(long)]
        query: Option<String>,
    },
    /// Report exhaustive headless support for every installed Ableton device family.
    Capabilities {
        #[arg(long, default_value = DEFAULT_CORE_LIBRARY)]
        core_library: PathBuf,
        #[arg(long, default_value = DEFAULT_MAX_CONTENTS)]
        max_contents: PathBuf,
        #[arg(long, default_value = DEFAULT_NATIVE_DEVICES)]
        devices_root: PathBuf,
    },
    /// Render a complete declarative track with Ableton native devices and Max.
    RenderGraph {
        manifest: PathBuf,
        output: PathBuf,
        #[arg(long)]
        stems_dir: Option<PathBuf>,
        #[arg(long, default_value = DEFAULT_NATIVE_DEVICES)]
        devices_root: PathBuf,
        #[arg(long, default_value = DEFAULT_MAX_CONTENTS)]
        max_contents: PathBuf,
        /// Start macOS playback after a successful render.
        #[arg(long)]
        play: bool,
    },
    /// Load Ableton's embedded Max runtime and create a native plug-interface object.
    ProbeMax {
        #[arg(long, default_value = DEFAULT_MAX_CONTENTS)]
        max_contents: PathBuf,
    },
    /// Load Ableton's standalone Live Engine bundle and report its mapped image.
    ProbeLiveEngine {
        #[arg(long, default_value = DEFAULT_LIVE_ENGINE)]
        engine: PathBuf,
        /// Initialize Ableton's processor registry and construct its engine singleton.
        #[arg(long)]
        bootstrap: bool,
        /// Look up a processor by its Ableton engine registry name.
        #[arg(long)]
        processor: Option<String>,
        /// Construct the selected processor through Ableton's own registered factory.
        #[arg(long)]
        construct: bool,
        /// Optional stereo WAV to process through the constructed processor.
        #[arg(long)]
        input: Option<PathBuf>,
        /// Sample WAV to bind to Ableton Drum Sampler's native sample holder.
        #[arg(long)]
        sample: Option<PathBuf>,
        /// Ableton ADV preset whose native parameter values should be applied.
        #[arg(long)]
        preset: Option<PathBuf>,
        /// Byte offset of a nested ADG device whose preset values should be applied.
        #[arg(long)]
        preset_device_offset: Option<usize>,
        /// Optional destination for audio rendered by the constructed processor.
        #[arg(long)]
        output: Option<PathBuf>,
        /// Float event input as NAME=VALUE; repeat to set multiple native parameters.
        #[arg(long = "parameter")]
        parameters: Vec<String>,
        /// MIDI note to send through a native InMidi port while rendering.
        #[arg(long)]
        note: Option<u8>,
        /// JSON note sequence to schedule through the native InMidi port.
        #[arg(long)]
        sequence: Option<PathBuf>,
        /// MIDI note velocity in the range 1..127.
        #[arg(long, default_value_t = 100)]
        velocity: u8,
        /// Note duration before a native note-off event is sent.
        #[arg(long, default_value_t = 0.5)]
        gate_seconds: f32,
        /// Limit processor rendering to this many frames (primarily for audits).
        #[arg(long)]
        render_frames: Option<usize>,
    },
    /// Construct every registered Live Engine processor in a crash-isolated subprocess.
    AuditLiveEngine {
        #[arg(long, default_value = DEFAULT_LIVE_ENGINE)]
        engine: PathBuf,
        #[arg(long, default_value_t = 8)]
        jobs: usize,
        /// Render a native signal through every processor with an audio input/output topology.
        #[arg(long)]
        render: bool,
    },
    /// Search every ADG, ALC, ADV and AGR asset in an Ableton Core Library.
    Library {
        #[arg(long, default_value = DEFAULT_CORE_LIBRARY)]
        core_library: PathBuf,
        #[arg(long)]
        query: Option<String>,
        #[arg(long)]
        kind: Option<String>,
        #[arg(long, default_value_t = 100)]
        limit: usize,
    },
    /// Inspect the devices, references and headless compatibility of any Ableton asset.
    InspectAsset { asset: PathBuf },
    /// Report the voices, sample zones and default selections in an ADG drum rack.
    InspectRack {
        rack: PathBuf,
        #[arg(long)]
        core_library: Option<PathBuf>,
    },
    /// Inspect the complete serial/parallel device graph of an ADV or ADG asset.
    InspectDeviceGraph { asset: PathBuf },
    /// Parse every installed ADV and ADG and report graph coverage and failures.
    AuditDeviceGraphs {
        #[arg(long, default_value = DEFAULT_CORE_LIBRARY)]
        core_library: PathBuf,
    },
    /// Apply installed ADV presets to their native Live Engine processors in isolation.
    AuditPresets {
        #[arg(long, default_value = DEFAULT_CORE_LIBRARY)]
        core_library: PathBuf,
        #[arg(long, default_value = DEFAULT_LIVE_ENGINE)]
        engine: PathBuf,
        #[arg(long, default_value_t = 8)]
        jobs: usize,
        /// Test every eligible preset instead of one representative per family.
        #[arg(long)]
        all: bool,
    },
    /// Report tempo, loop bounds and MIDI notes in an ALC clip.
    InspectClip { clip: PathBuf },
    /// Report the timing and velocity template in an XML AGR groove.
    InspectGroove { groove: PathBuf },
    /// Report sample layers and zones in an ADG instrument rack.
    InspectInstrument {
        instrument: PathBuf,
        #[arg(long)]
        core_library: Option<PathBuf>,
    },
    /// Convert an Ableton drum clip and rack into a renderable djbooth song JSON.
    ImportDrumClip {
        clip: PathBuf,
        output: PathBuf,
        /// Optional external ADG rack. By default, use the rack embedded in the ALC.
        #[arg(long)]
        rack: Option<PathBuf>,
        #[arg(long)]
        core_library: Option<PathBuf>,
        #[arg(long)]
        groove: Option<PathBuf>,
        #[arg(long, default_value_t = 1)]
        repeats: u32,
        #[arg(long, default_value_t = DEFAULT_SAMPLE_RATE)]
        sample_rate: u32,
    },
    /// Convert a tonal ALC clip and sample-based ADG instrument into song JSON.
    ImportMidiClip {
        clip: PathBuf,
        output: PathBuf,
        #[arg(long)]
        instrument: Option<PathBuf>,
        #[arg(long)]
        core_library: Option<PathBuf>,
        #[arg(long)]
        groove: Option<PathBuf>,
        #[arg(long, default_value_t = 1)]
        repeats: u32,
        #[arg(long, default_value_t = DEFAULT_SAMPLE_RATE)]
        sample_rate: u32,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RackReport {
    source: PathBuf,
    core_library: PathBuf,
    name: String,
    voices: Vec<DrumVoice>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AbletonDeviceGraphReport {
    source: PathBuf,
    name: String,
    format: String,
    roots: Vec<AbletonGraphDevice>,
    devices: usize,
    racks: usize,
    chains: usize,
    parameters: usize,
    macro_mappings: usize,
    custom_dsp: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AbletonGraphDevice {
    id: Option<String>,
    source_offset: usize,
    family: String,
    name: String,
    enabled: Option<bool>,
    parameters: Vec<AbletonGraphParameter>,
    rack: Option<Box<AbletonRackGraph>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AbletonRackGraph {
    kind: String,
    visible_macros: usize,
    chain_selector: Option<AbletonGraphParameter>,
    macros: Vec<AbletonRackMacro>,
    chains: Vec<AbletonRackChain>,
    return_chains: Vec<AbletonRackChain>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AbletonRackMacro {
    index: usize,
    name: String,
    value: String,
    numeric_value: Option<f64>,
    default_value: Option<f64>,
    minimum: Option<f64>,
    maximum: Option<f64>,
    color: Option<i32>,
    annotation: String,
    automation_target_id: Option<String>,
    modulation_target_id: Option<String>,
    excluded_from_randomization: bool,
    excluded_from_snapshots: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AbletonRackChain {
    id: Option<String>,
    name: String,
    soloed: bool,
    selector: Option<AbletonChainSelectorRange>,
    receiving_note: Option<i32>,
    sending_note: Option<i32>,
    choke_group: Option<i32>,
    devices: Vec<AbletonGraphDevice>,
    mixer: Option<AbletonGraphDevice>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AbletonChainSelectorRange {
    minimum: f64,
    maximum: f64,
    crossfade_minimum: f64,
    crossfade_maximum: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AbletonGraphParameter {
    name: String,
    value: String,
    numeric_value: Option<f64>,
    minimum: Option<f64>,
    maximum: Option<f64>,
    automation_target_id: Option<String>,
    modulation_target_id: Option<String>,
    midi_mapping: Option<AbletonMidiMapping>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AbletonMidiMapping {
    persistent_key: String,
    is_note: bool,
    channel: i32,
    note_or_controller: i32,
    lower_note: i32,
    upper_note: i32,
    map_mode: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AbletonDeviceGraphAuditReport {
    core_library: PathBuf,
    assets: usize,
    parsed_assets: usize,
    failed_assets: Vec<AbletonGraphAuditFailure>,
    devices: usize,
    racks: usize,
    chains: usize,
    parameters: usize,
    macro_mappings: usize,
    complete_families: usize,
    partial_families: usize,
    blocked_families: usize,
    device_families: Vec<AbletonGraphFamilyCount>,
    custom_dsp: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AbletonGraphAuditFailure {
    asset: PathBuf,
    error: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AbletonGraphFamilyCount {
    family: String,
    instances: usize,
    mechanism: String,
    engine_status: String,
    preset_status: String,
    headless_status: String,
    implementation: Option<String>,
    blocker: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AbletonPresetAuditReport {
    core_library: PathBuf,
    engine: PathBuf,
    installed_presets: usize,
    eligible_presets: usize,
    tested_presets: usize,
    rendered_presets: usize,
    audible_presets: usize,
    silent_presets: Vec<AbletonPresetAuditSilent>,
    failed_presets: Vec<AbletonPresetAuditFailure>,
    skipped_families: Vec<AbletonPresetAuditSkippedFamily>,
    family_results: Vec<AbletonPresetAuditFamilyResult>,
    exhaustive: bool,
    jobs: usize,
    custom_dsp: bool,
}

#[derive(Clone, Debug)]
struct AbletonPresetAuditJob {
    index: usize,
    asset: PathBuf,
    family: String,
    processor: String,
    midi: bool,
    sample: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AbletonPresetAuditFailure {
    asset: PathBuf,
    family: String,
    processor: String,
    exit_code: Option<i32>,
    error: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AbletonPresetAuditSilent {
    asset: PathBuf,
    family: String,
    processor: String,
    peak: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AbletonPresetAuditSkippedFamily {
    family: String,
    presets: usize,
    reason: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AbletonPresetAuditFamilyResult {
    family: String,
    processor: String,
    tested: usize,
    rendered: usize,
    audible: usize,
    silent: usize,
    failed: usize,
    minimum_parameters_applied: usize,
    maximum_parameters_applied: usize,
    maximum_peak: f32,
    maximum_delta: f32,
}

#[derive(Debug)]
struct AbletonPresetAuditSuccess {
    asset: PathBuf,
    family: String,
    processor: String,
    parameters_applied: usize,
    peak: f32,
    delta: f32,
    audible: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DrumVoice {
    midi_note: u8,
    name: String,
    receiving_note: u8,
    sending_note: u8,
    choke_group: u8,
    sample_selector: u8,
    gain_db: f32,
    volume_velocity_scale: f32,
    one_shot_fade_out_seconds: f64,
    samples: Vec<SampleZone>,
    selected_samples: Vec<PathBuf>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SampleZone {
    name: String,
    relative_path: PathBuf,
    resolved_path: PathBuf,
    key_min: u8,
    key_max: u8,
    velocity_min: u8,
    velocity_max: u8,
    selector_min: u8,
    selector_max: u8,
    root_key: u8,
    detune_cents: f32,
    volume: f32,
    panorama: f32,
    sample_start_frame: usize,
    sample_end_frame: Option<usize>,
    source_sample_rate: u32,
    sustain_loop: Option<SampleLoop>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SampleLoop {
    start_frame: usize,
    end_frame: usize,
    crossfade_frames: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstrumentReport {
    source: PathBuf,
    core_library: PathBuf,
    name: String,
    layers: Vec<SamplerLayer>,
    unsupported_devices: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SamplerLayer {
    name: String,
    device: String,
    gain_db: f32,
    pan: f32,
    velocity_amount: f32,
    attack_seconds: f64,
    decay_seconds: f64,
    sustain_level: f32,
    release_seconds: f64,
    zones: Vec<SampleZone>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipReport {
    source: PathBuf,
    name: String,
    bpm: f64,
    loop_start: f64,
    loop_end: f64,
    notes: Vec<ClipNote>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipNote {
    beat: f64,
    duration_beats: f64,
    note: u8,
    velocity: u8,
    off_velocity: u8,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GrooveReport {
    source: PathBuf,
    name: String,
    loop_start: f64,
    loop_end: f64,
    grid: u8,
    quantization_amount: f64,
    timing_amount: f64,
    random_amount: f64,
    velocity_amount: f64,
    events: Vec<GrooveEvent>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GrooveEvent {
    beat: f64,
    velocity: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedSong {
    schema_version: u32,
    title: String,
    bpm: f64,
    bars: u32,
    beats_per_bar: u32,
    sample_rate: u32,
    master: ImportedMaster,
    tracks: Vec<ImportedTrack>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedMaster {
    input_gain_db: f32,
    tail_seconds: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedSampleTrack {
    id: String,
    kind: &'static str,
    sample: PathBuf,
    one_shot: bool,
    velocity_amount: f32,
    fade_out_seconds: f64,
    gain_db: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    choke_group: Option<u8>,
    triggers: Vec<ImportedTrigger>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedSamplerTrack {
    id: String,
    kind: &'static str,
    gain_db: f32,
    zones: Vec<ImportedSamplerZone>,
    notes: Vec<ImportedNote>,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
enum ImportedTrack {
    Sample(ImportedSampleTrack),
    Sampler(ImportedSamplerTrack),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedSamplerZone {
    sample: PathBuf,
    key_min: u8,
    key_max: u8,
    velocity_min: u8,
    velocity_max: u8,
    root_key: u8,
    detune_cents: f32,
    gain_db: f32,
    pan: f32,
    sample_start_frame: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    sample_end_frame: Option<usize>,
    source_sample_rate: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    sustain_loop: Option<SampleLoop>,
    attack_seconds: f64,
    decay_seconds: f64,
    sustain_level: f32,
    release_seconds: f64,
    velocity_amount: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedNote {
    beat: f64,
    duration_beats: f64,
    note: u8,
    velocity: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportedTrigger {
    beat: f64,
    duration_beats: f64,
    velocity: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportReport {
    output: PathBuf,
    rack: String,
    clip: String,
    tracks: usize,
    events: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetSummary {
    path: PathBuf,
    relative_path: PathBuf,
    kind: String,
    name: String,
    devices: Vec<String>,
    references: Vec<String>,
    sample_files: usize,
    midi_notes: usize,
    renderability: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryReport {
    core_library: PathBuf,
    scanned: usize,
    matched: usize,
    assets: Vec<AssetSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MaxProbeReport {
    max_contents: PathBuf,
    max_plug_lib: PathBuf,
    max_audio_api: PathBuf,
    plug_interface_created: bool,
    plug_host_created: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveEngineProbeReport {
    engine: PathBuf,
    engine_sha256: String,
    abi_profile: Option<&'static str>,
    loaded_image: PathBuf,
    host_architecture: &'static str,
    vmaddr_slide: i64,
    loadable: bool,
    registry_initialized: bool,
    init_exit_functions: usize,
    registry_entries: usize,
    engine_created: bool,
    sample_rate: u32,
    buffer_size: usize,
    audio_cycle_driven: bool,
    audio_peak: f32,
    processor: Option<String>,
    processor_registered: bool,
    processor_constructed: bool,
    processor_factory_function: Option<String>,
    processor_calc_function: Option<String>,
    processor_graph: Option<String>,
    processor_graph_attached: bool,
    processor_graph_entries: usize,
    processor_graph_execution_function: Option<String>,
    processor_preset: Option<PathBuf>,
    preset_parameters_applied: usize,
    applied_parameters: Vec<LiveEngineAppliedParameter>,
    applied_midi_events: Vec<LiveEngineAppliedMidiEvent>,
    processor_render_peak: f32,
    processor_render_delta: f32,
    processor_render_frames: usize,
    processor_render_output: Option<PathBuf>,
    registered_processors: Vec<String>,
    registered_ports: usize,
    processor_schemas: Vec<LiveEngineProcessorSchema>,
    recovered_devices: Vec<String>,
    custom_dsp: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveEngineAppliedParameter {
    name: String,
    value: f32,
    callback: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveEngineAppliedMidiEvent {
    kind: &'static str,
    note: u8,
    velocity: u8,
    note_id: u64,
    sample_offset: usize,
    callback: String,
}

#[repr(C, align(8))]
struct LiveEngineMidiEvent([u8; 0x30]);

struct LiveEngineProbeRequest<'a> {
    engine: &'a Path,
    bootstrap: bool,
    processor: Option<&'a str>,
    construct: bool,
    input: Option<&'a Path>,
    sample: Option<&'a Path>,
    preset: Option<&'a Path>,
    preset_device_offset: Option<usize>,
    output: Option<&'a Path>,
    parameters: &'a [String],
    note: Option<u8>,
    sequence: Option<&'a Path>,
    velocity: u8,
    gate_seconds: f32,
    render_frames: Option<usize>,
}

#[derive(Clone, Copy, Debug)]
struct LiveEngineScheduledMidi {
    frame: usize,
    note_on: bool,
    note: u8,
    velocity: u8,
    note_id: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveEngineAuditReport {
    engine: PathBuf,
    engine_sha256: String,
    registered_processors: usize,
    constructed_processors: usize,
    failed_processors: Vec<LiveEngineAuditFailure>,
    render_attempted: bool,
    renderable_processors: usize,
    rendered_processors: usize,
    rendered_processor_names: Vec<String>,
    failed_renders: Vec<LiveEngineAuditFailure>,
    jobs: usize,
    custom_dsp: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveEngineAuditFailure {
    processor: String,
    exit_code: Option<i32>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveEngineProcessorSchema {
    name: String,
    create_message_id: u32,
    create_message_data: String,
    factory_function: Option<String>,
    create_members: Vec<LiveEngineMessageMemberSchema>,
    header_words: Vec<String>,
    initial_calc_function: Option<String>,
    change_audio_data_offset: i32,
    audio_processor: bool,
    processor_type: u8,
    processor_rate: u8,
    ports: Vec<LiveEnginePortSchema>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveEngineMessageMemberSchema {
    name: String,
    type_id: u32,
    array_count: u32,
    byte_offset: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LiveEnginePortSchema {
    name: String,
    kind: &'static str,
    kind_id: u32,
    raw_u32_a: u32,
    raw_u32_b: u32,
    raw_u64_a: String,
    raw_u64_b: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MaxRenderReport {
    engine: PathBuf,
    amxd: PathBuf,
    input: Option<PathBuf>,
    output: PathBuf,
    note_one: u8,
    note_two: u8,
    velocity: u8,
    channels: u16,
    sample_rate: u32,
    frames: u32,
    duration_seconds: f64,
    peak: f32,
    custom_dsp: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MaxObjectRenderReport {
    engine: PathBuf,
    object: String,
    input: PathBuf,
    output: PathBuf,
    channels: u16,
    sample_rate: u32,
    frames: u32,
    duration_seconds: f64,
    peak: f32,
    custom_dsp: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MaxInstrumentRenderReport {
    engine: PathBuf,
    object: String,
    output: PathBuf,
    note: u8,
    velocity: u8,
    channels: u16,
    sample_rate: u32,
    frames: u32,
    duration_seconds: f64,
    peak: f32,
    custom_dsp: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MaxObjectInventoryReport {
    package: PathBuf,
    count: usize,
    objects: Vec<MaxObjectSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MaxObjectSummary {
    class: String,
    binary: PathBuf,
    help: Option<PathBuf>,
    attributes: Vec<String>,
    inlets: Option<u64>,
    outlets: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityReport {
    core_library: PathBuf,
    library_assets: usize,
    device_families: usize,
    compiled_max_objects: usize,
    standalone_native_bundles: usize,
    complete_families: usize,
    partial_families: usize,
    blocked_families: usize,
    families: Vec<DeviceCapability>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceCapability {
    family: String,
    library_assets: usize,
    mechanism: &'static str,
    engine_status: &'static str,
    preset_status: &'static str,
    headless_status: &'static str,
    implementation: Option<String>,
    blocker: Option<&'static str>,
    custom_dsp: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeDeviceRenderReport {
    device: String,
    binary: PathBuf,
    input: Option<PathBuf>,
    preset: Option<PathBuf>,
    output: PathBuf,
    note: u8,
    velocity: u8,
    sequence: Option<PathBuf>,
    bpm: f64,
    midi_events: usize,
    channels: u16,
    sample_rate: u32,
    frames: u32,
    peak: f32,
    parameters: Vec<NativeParameter>,
    custom_dsp: bool,
}

#[derive(Clone, Copy, Debug, Serialize)]
struct NativeParameter {
    id: u64,
    value: f32,
}

pub(crate) fn run(args: impl Iterator<Item = String>) -> Result<()> {
    let arguments = Args::parse_from(std::iter::once("djbooth-rs ableton".to_owned()).chain(args));
    match arguments.command {
        AbletonCommand::RenderNativeDevice {
            output,
            device,
            devices_root,
            note,
            sequence,
            velocity,
            sample_rate,
            tail_seconds,
            input,
            preset,
            parameters,
        } => render_native_device(NativeDeviceRenderRequest {
            devices_root: &devices_root,
            device: &device,
            output: &output,
            note,
            velocity,
            sequence: sequence.as_deref(),
            sample_rate,
            tail_seconds,
            input: input.as_deref(),
            preset: preset.as_deref(),
            parameter_arguments: &parameters,
        }),
        AbletonCommand::RenderMaxAmxd {
            amxd,
            output,
            input,
            max_contents,
            note_one,
            note_two,
            velocity,
        } => render_max_amxd(
            &max_contents,
            &amxd,
            &output,
            input.as_deref(),
            note_one,
            note_two,
            velocity,
        ),
        AbletonCommand::RenderMaxObject {
            object,
            input,
            output,
            max_contents,
            tail_seconds,
        } => render_max_object(&max_contents, &object, &input, &output, tail_seconds),
        AbletonCommand::RenderMaxInstrument {
            object,
            output,
            max_contents,
            note,
            velocity,
        } => render_max_instrument(&max_contents, &object, &output, note, velocity),
        AbletonCommand::MaxObjects {
            max_contents,
            query,
        } => inventory_max_objects(&max_contents, query.as_deref()),
        AbletonCommand::Capabilities {
            core_library,
            max_contents,
            devices_root,
        } => report_capabilities(&core_library, &max_contents, &devices_root),
        AbletonCommand::RenderGraph {
            manifest,
            output,
            stems_dir,
            devices_root,
            max_contents,
            play,
        } => crate::ableton_graph::render(
            &manifest,
            &output,
            stems_dir.as_deref(),
            &devices_root,
            &max_contents,
            play,
        ),
        AbletonCommand::ProbeMax { max_contents } => probe_max_runtime(&max_contents),
        AbletonCommand::ProbeLiveEngine {
            engine,
            bootstrap,
            processor,
            construct,
            input,
            sample,
            preset,
            preset_device_offset,
            output,
            parameters,
            note,
            sequence,
            velocity,
            gate_seconds,
            render_frames,
        } => probe_live_engine(LiveEngineProbeRequest {
            engine: &engine,
            bootstrap,
            processor: processor.as_deref(),
            construct,
            input: input.as_deref(),
            sample: sample.as_deref(),
            preset: preset.as_deref(),
            preset_device_offset,
            output: output.as_deref(),
            parameters: &parameters,
            note,
            sequence: sequence.as_deref(),
            velocity,
            gate_seconds,
            render_frames,
        }),
        AbletonCommand::AuditLiveEngine {
            engine,
            jobs,
            render,
        } => audit_live_engine(&engine, jobs, render),
        AbletonCommand::Library {
            core_library,
            query,
            kind,
            limit,
        } => scan_library(&core_library, query.as_deref(), kind.as_deref(), limit),
        AbletonCommand::InspectAsset { asset } => {
            let summary = inspect_asset(&asset, asset.parent().unwrap_or_else(|| Path::new("")))?;
            println!("{}", serde_json::to_string_pretty(&summary)?);
            Ok(())
        }
        AbletonCommand::InspectRack { rack, core_library } => {
            let xml = read_ableton_xml(&rack)?;
            let report = parse_rack(&rack, &xml, core_library.as_deref())?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        AbletonCommand::InspectDeviceGraph { asset } => {
            let xml = read_ableton_xml(&asset)?;
            let report = parse_device_graph(&asset, &xml)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        AbletonCommand::AuditDeviceGraphs { core_library } => audit_device_graphs(&core_library),
        AbletonCommand::AuditPresets {
            core_library,
            engine,
            jobs,
            all,
        } => audit_presets(&core_library, &engine, jobs, all),
        AbletonCommand::InspectClip { clip } => {
            let xml = read_ableton_xml(&clip)?;
            let report = parse_clip(&clip, &xml)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        AbletonCommand::InspectGroove { groove } => {
            let xml = read_ableton_xml(&groove)?;
            let report = parse_groove(&groove, &xml)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        AbletonCommand::InspectInstrument {
            instrument,
            core_library,
        } => {
            let xml = read_ableton_xml(&instrument)?;
            let report = parse_instrument(&instrument, &xml, core_library.as_deref())?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        AbletonCommand::ImportDrumClip {
            clip,
            output,
            rack,
            core_library,
            groove,
            repeats,
            sample_rate,
        } => import_drum_clip(
            &clip,
            rack.as_deref(),
            &output,
            core_library.as_deref(),
            groove.as_deref(),
            repeats,
            sample_rate,
        ),
        AbletonCommand::ImportMidiClip {
            clip,
            output,
            instrument,
            core_library,
            groove,
            repeats,
            sample_rate,
        } => import_midi_clip(
            &clip,
            instrument.as_deref(),
            &output,
            core_library.as_deref(),
            groove.as_deref(),
            repeats,
            sample_rate,
        ),
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct NativeMidiEvent {
    sample_offset: u32,
    reserved: u32,
    status: u8,
    data_one: u8,
    data_two: u8,
    padding: [u8; 5],
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct NativeTransport {
    is_playing: u32,
    padding: u32,
    beat_time: f64,
    tempo: f64,
}

struct NativeDeviceInstance {
    pointer: *mut c_void,
    destroy: unsafe extern "C" fn(*mut c_void),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum NativeDeviceAbi {
    AbletonStereoInstrument,
    SoftubeMonoEffect,
}

struct NativeDeviceRenderRequest<'a> {
    devices_root: &'a Path,
    device: &'a str,
    output: &'a Path,
    note: u8,
    velocity: u8,
    sequence: Option<&'a Path>,
    sample_rate: u32,
    tail_seconds: f64,
    input: Option<&'a Path>,
    preset: Option<&'a Path>,
    parameter_arguments: &'a [String],
}

impl Drop for NativeDeviceInstance {
    fn drop(&mut self) {
        unsafe { (self.destroy)(self.pointer) };
    }
}

fn render_native_device(request: NativeDeviceRenderRequest<'_>) -> Result<()> {
    ensure!(
        request.note <= 127,
        "note must be a MIDI pitch from 0 to 127"
    );
    ensure!(request.velocity <= 127, "velocity must be from 0 to 127");
    ensure!(request.sample_rate > 0, "sample-rate must be positive");
    ensure!(
        request.tail_seconds.is_finite() && request.tail_seconds >= 0.0,
        "tail-seconds must be finite and non-negative"
    );
    let explicit_parameters = parse_native_parameters(request.parameter_arguments)?;
    ensure!(
        std::mem::size_of::<NativeMidiEvent>() == 16,
        "native MIDI event ABI changed"
    );
    ensure!(
        std::mem::size_of::<NativeTransport>() == 24,
        "native transport ABI changed"
    );

    let (canonical_name, executable, abi) = native_device_executable(request.device)?;
    if abi == NativeDeviceAbi::SoftubeMonoEffect && !running_in_ableton_bundle_host() {
        return render_native_device_in_ableton_bundle(canonical_name, &request);
    }
    let NativeDeviceRenderRequest {
        devices_root,
        output,
        note,
        velocity,
        sequence,
        sample_rate,
        tail_seconds,
        input,
        preset,
        ..
    } = request;
    let preset = preset.map(fs::canonicalize).transpose().with_context(|| {
        format!(
            "Ableton preset does not exist: {}",
            preset.unwrap_or_else(|| Path::new("")).display()
        )
    })?;
    let (sequence_path, sequence) = if let Some(path) = sequence {
        let path = fs::canonicalize(path)
            .with_context(|| format!("MIDI sequence does not exist: {}", path.display()))?;
        let sequence: Sequence = serde_json::from_slice(
            &fs::read(&path)
                .with_context(|| format!("failed to read MIDI sequence {}", path.display()))?,
        )
        .with_context(|| format!("failed to parse MIDI sequence {}", path.display()))?;
        validate_sequence(&sequence)?;
        (Some(path), Some(sequence))
    } else {
        (None, None)
    };
    let mut parameters = if let Some(preset) = &preset {
        native_preset_parameters(canonical_name, preset)?
    } else {
        Vec::new()
    };
    parameters.extend(explicit_parameters);
    let binary = devices_root
        .join(format!("{canonical_name}.bundle"))
        .join("Contents/MacOS")
        .join(executable);
    ensure!(
        binary.is_file(),
        "Ableton native device does not exist: {}",
        binary.display()
    );
    let library = open_library_global(&binary)?;

    type CreateInstance = unsafe extern "C" fn() -> *mut c_void;
    type DestroyInstance = unsafe extern "C" fn(*mut c_void);
    type GetPlugInfo = unsafe extern "C" fn(u32, *mut c_void, usize) -> bool;
    type SetSampleRate = unsafe extern "C" fn(*mut c_void, u64) -> bool;
    type Reset = unsafe extern "C" fn(*mut c_void);
    type SetParameter = unsafe extern "C" fn(*mut c_void, u64, f32);
    type CalcInstrument = unsafe extern "C" fn(
        *mut c_void,
        usize,
        *mut f32,
        *mut f32,
        usize,
        *const NativeMidiEvent,
        *const NativeTransport,
        *mut u32,
    ) -> u8;
    // Amp and Cabinet expose Softube's mono, in-place callback. The final
    // argument remains Ableton's stopped flag; the intervening host fields are
    // ignored by this wrapper but retained so the stack ABI exactly matches.
    type CalcSoftube = unsafe extern "C" fn(
        *mut c_void,
        usize,
        *mut f32,
        *mut c_void,
        usize,
        *const c_void,
        *const c_void,
        *mut u32,
    ) -> u8;

    let create: CreateInstance = unsafe { load_symbol(library, c"CreateInstanceU")? };
    let destroy: DestroyInstance = unsafe { load_symbol(library, c"DestroyInstanceU")? };
    let get_plug_info: GetPlugInfo = unsafe { load_symbol(library, c"GetPlugInfoU")? };
    let set_sample_rate: SetSampleRate = unsafe { load_symbol(library, c"SetSampleRateU")? };
    let reset: Reset = unsafe { load_symbol(library, c"ResetA")? };
    let set_parameter: SetParameter = unsafe { load_symbol(library, c"SetParameterA")? };
    let calc_instrument: Option<CalcInstrument> = match abi {
        NativeDeviceAbi::AbletonStereoInstrument => {
            Some(unsafe { load_symbol(library, c"CalcA")? })
        }
        NativeDeviceAbi::SoftubeMonoEffect => None,
    };
    let calc_softube: Option<CalcSoftube> = match abi {
        NativeDeviceAbi::AbletonStereoInstrument => None,
        NativeDeviceAbi::SoftubeMonoEffect => Some(unsafe { load_symbol(library, c"CalcA")? }),
    };

    let mut max_block_frames = 0_u64;
    ensure!(
        unsafe {
            get_plug_info(
                5,
                std::ptr::from_mut(&mut max_block_frames).cast(),
                std::mem::size_of_val(&max_block_frames),
            )
        },
        "Ableton native device did not report its maximum block size"
    );
    ensure!(
        max_block_frames > 0 && max_block_frames <= 1_048_576,
        "Ableton native device reported invalid block size {max_block_frames}"
    );

    let instance_count = match abi {
        NativeDeviceAbi::AbletonStereoInstrument => 1,
        NativeDeviceAbi::SoftubeMonoEffect => 2,
    };
    let mut instances = Vec::with_capacity(instance_count);
    for _ in 0..instance_count {
        let pointer = unsafe { create() };
        ensure!(
            !pointer.is_null(),
            "Ableton native device failed to create an instance"
        );
        let instance = NativeDeviceInstance { pointer, destroy };
        ensure!(
            unsafe { set_sample_rate(instance.pointer, u64::from(sample_rate)) },
            "Ableton native device rejected sample rate {sample_rate}"
        );
        unsafe { reset(instance.pointer) };
        for parameter in &parameters {
            unsafe { set_parameter(instance.pointer, parameter.id, parameter.value) };
        }
        instances.push(instance);
    }

    let output = if output.is_absolute() {
        output.to_path_buf()
    } else {
        std::env::current_dir()?.join(output)
    };
    let output_parent = output
        .parent()
        .context("output path has no parent directory")?;
    fs::create_dir_all(output_parent).with_context(|| {
        format!(
            "failed to create output directory {}",
            output_parent.display()
        )
    })?;
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(&output, spec)
        .with_context(|| format!("failed to create {}", output.display()))?;

    let (input_path, input_frames) = if let Some(input) = input {
        let input_path = fs::canonicalize(input)
            .with_context(|| format!("input WAV does not exist: {}", input.display()))?;
        let frames = read_wav_stereo(&input_path, sample_rate)?;
        (Some(input_path), frames)
    } else {
        (None, Vec::new())
    };
    let tail_frames = (tail_seconds * f64::from(sample_rate)).ceil() as u64;
    let input_total_frames = u64::try_from(input_frames.len())?.saturating_add(tail_frames);
    let (bpm, scheduled_events, sequence_total_frames) = if let Some(sequence) = &sequence {
        let total_beats = f64::from(sequence.bars * sequence.beats_per_bar);
        let musical_frames =
            (total_beats * 60.0 / sequence.bpm * f64::from(sample_rate)).ceil() as u64;
        (
            sequence.bpm,
            schedule_native_midi(sequence, sample_rate)?,
            musical_frames.saturating_add(tail_frames),
        )
    } else if input_frames.is_empty() {
        (
            120.0,
            vec![
                ScheduledNativeMidi {
                    frame: 0,
                    status: 0x90,
                    note,
                    velocity,
                },
                ScheduledNativeMidi {
                    frame: u64::from(sample_rate.saturating_mul(3) / 2),
                    status: 0x80,
                    note,
                    velocity: 0,
                },
            ],
            u64::from(sample_rate.saturating_mul(3)),
        )
    } else {
        (120.0, Vec::new(), 0)
    };
    let total_frames = u32::try_from(input_total_frames.max(sequence_total_frames))
        .context("native device render is too long")?;
    let block_size = max_block_frames as usize;
    let mut left = vec![0.0_f32; block_size];
    let mut right = vec![0.0_f32; block_size];
    let mut frame = 0_u32;
    let mut peak = 0.0_f32;
    let mut next_event = 0_usize;
    // AAS CalcA treats this as an in/out audio-active flag. Effects such as
    // Corpus replace their input with silence when the incoming value is zero,
    // then update it to report whether their tail remains active.
    let mut ableton_audio_active = u32::from(!input_frames.is_empty());
    while frame < total_frames {
        let frames = usize::try_from((total_frames - frame).min(max_block_frames as u32))?;
        if (frame as usize) < input_frames.len() {
            ableton_audio_active = 1;
        }
        for index in 0..frames {
            let input = input_frames
                .get(frame as usize + index)
                .copied()
                .unwrap_or([0.0, 0.0]);
            left[index] = input[0];
            right[index] = input[1];
        }
        let block_end = frame + frames as u32;
        let mut events = Vec::new();
        while let Some(event) = scheduled_events.get(next_event) {
            if event.frame >= u64::from(block_end) {
                break;
            }
            ensure!(
                event.frame >= u64::from(frame),
                "native MIDI scheduler produced an event behind the render cursor"
            );
            events.push(NativeMidiEvent {
                sample_offset: u32::try_from(event.frame - u64::from(frame))?,
                status: event.status,
                data_one: event.note,
                data_two: event.velocity,
                ..NativeMidiEvent::default()
            });
            next_event += 1;
        }
        let transport = NativeTransport {
            is_playing: 1,
            beat_time: f64::from(frame) * bpm / (60.0 * f64::from(sample_rate)),
            tempo: bpm,
            ..NativeTransport::default()
        };
        match abi {
            NativeDeviceAbi::AbletonStereoInstrument => unsafe {
                calc_instrument.expect("instrument callback")(
                    instances[0].pointer,
                    frames,
                    left.as_mut_ptr(),
                    right.as_mut_ptr(),
                    events.len(),
                    events.as_ptr(),
                    &transport,
                    &mut ableton_audio_active,
                );
            },
            NativeDeviceAbi::SoftubeMonoEffect => unsafe {
                let calc = calc_softube.expect("Softube callback");
                let mut stopped = 0_u32;
                calc(
                    instances[0].pointer,
                    frames,
                    left.as_mut_ptr(),
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null(),
                    std::ptr::null(),
                    &mut stopped,
                );
                calc(
                    instances[1].pointer,
                    frames,
                    right.as_mut_ptr(),
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null(),
                    std::ptr::null(),
                    &mut stopped,
                );
            },
        }
        for index in 0..frames {
            peak = peak.max(left[index].abs()).max(right[index].abs());
            writer.write_sample(left[index])?;
            writer.write_sample(right[index])?;
        }
        frame = block_end;
    }
    writer.finalize()?;
    ensure!(
        peak > 1.0e-7,
        "Ableton {canonical_name} rendered silence with its default state"
    );

    let report = NativeDeviceRenderReport {
        device: canonical_name.to_owned(),
        binary,
        input: input_path,
        preset,
        output,
        note,
        velocity,
        sequence: sequence_path,
        bpm,
        midi_events: scheduled_events.len(),
        channels: 2,
        sample_rate,
        frames: total_frames,
        peak,
        parameters,
        custom_dsp: false,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ScheduledNativeMidi {
    frame: u64,
    status: u8,
    note: u8,
    velocity: u8,
}

fn schedule_native_midi(sequence: &Sequence, sample_rate: u32) -> Result<Vec<ScheduledNativeMidi>> {
    validate_sequence(sequence)?;
    ensure!(sample_rate > 0, "sample-rate must be positive");
    let frames_per_beat = f64::from(sample_rate) * 60.0 / sequence.bpm;
    let mut events = Vec::with_capacity(sequence.notes.len() * 2);
    for note in &sequence.notes {
        events.push(ScheduledNativeMidi {
            frame: (note.beat * frames_per_beat).round() as u64,
            status: 0x90,
            note: note.note,
            velocity: note.velocity,
        });
        events.push(ScheduledNativeMidi {
            frame: ((note.beat + note.duration_beats) * frames_per_beat).round() as u64,
            status: 0x80,
            note: note.note,
            velocity: 0,
        });
    }
    events.sort_by_key(|event| (event.frame, event.status == 0x90));
    Ok(events)
}

fn read_wav_stereo(path: &Path, expected_sample_rate: u32) -> Result<Vec<[f32; 2]>> {
    let mut reader = hound::WavReader::open(path)
        .with_context(|| format!("failed to open input WAV {}", path.display()))?;
    let spec = reader.spec();
    ensure!(spec.channels > 0, "input WAV has no channels");
    ensure!(
        spec.sample_rate == expected_sample_rate,
        "input WAV sample rate {} does not match requested sample rate {expected_sample_rate}",
        spec.sample_rate
    );
    let interleaved = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<std::result::Result<Vec<_>, _>>()?,
        hound::SampleFormat::Int => {
            let scale = 2.0_f32.powi(i32::from(spec.bits_per_sample) - 1);
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<std::result::Result<Vec<_>, _>>()?
        }
    };
    let channels = usize::from(spec.channels);
    let mut frames = Vec::with_capacity(interleaved.len() / channels);
    for frame in interleaved.chunks_exact(channels) {
        frames.push(if channels == 1 {
            [frame[0], frame[0]]
        } else {
            [frame[0], frame[1]]
        });
    }
    Ok(frames)
}

fn native_device_executable(device: &str) -> Result<(&'static str, &'static str, NativeDeviceAbi)> {
    let resolved = match device.to_ascii_lowercase().as_str() {
        "amp" | "amplifier" => ("Amp", "Amplifier", NativeDeviceAbi::SoftubeMonoEffect),
        "analog" => ("Analog", "Analog", NativeDeviceAbi::AbletonStereoInstrument),
        "cabinet" => ("Cabinet", "Cabinet", NativeDeviceAbi::SoftubeMonoEffect),
        "collision" => (
            "Collision",
            "Collision",
            NativeDeviceAbi::AbletonStereoInstrument,
        ),
        "corpus" => ("Corpus", "Corpus", NativeDeviceAbi::AbletonStereoInstrument),
        "electric" => (
            "Electric",
            "Electric",
            NativeDeviceAbi::AbletonStereoInstrument,
        ),
        "tension" => (
            "Tension",
            "Tension",
            NativeDeviceAbi::AbletonStereoInstrument,
        ),
        _ => anyhow::bail!(
            "unknown native Ableton device '{device}'; expected Amp, Analog, Cabinet, Collision, Corpus, Electric, or Tension"
        ),
    };
    Ok(resolved)
}

fn running_in_ableton_bundle_host() -> bool {
    let Ok(executable) = std::env::current_exe() else {
        return false;
    };
    let Some(contents) = executable.parent().and_then(Path::parent) else {
        return false;
    };
    if contents.file_name().and_then(|name| name.to_str()) != Some("Contents") {
        return false;
    }
    fs::read_to_string(contents.join("Info.plist"))
        .is_ok_and(|plist| plist.contains("com.ableton.live"))
}

fn render_native_device_in_ableton_bundle(
    device: &str,
    request: &NativeDeviceRenderRequest<'_>,
) -> Result<()> {
    let temporary = tempfile::Builder::new()
        .prefix("djbooth-ableton-host-")
        .tempdir()
        .context("failed to create temporary Ableton-compatible host bundle")?;
    let app = temporary.path().join("AbletonHeadless.app");
    let contents = app.join("Contents");
    let macos = contents.join("MacOS");
    fs::create_dir_all(&macos)?;
    let hosted_executable = macos.join("djbooth-rs");
    fs::copy(std::env::current_exe()?, &hosted_executable)
        .context("failed to install the Rust host in its temporary app bundle")?;
    fs::write(
        contents.join("Info.plist"),
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>djbooth-rs</string>
<key>CFBundleIdentifier</key><string>com.ableton.live</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
"#,
    )?;

    let mut command = Command::new(hosted_executable);
    command
        .arg("ableton")
        .arg("render-native-device")
        .arg(request.output)
        .arg("--device")
        .arg(device)
        .arg("--devices-root")
        .arg(request.devices_root)
        .arg("--note")
        .arg(request.note.to_string())
        .arg("--velocity")
        .arg(request.velocity.to_string())
        .arg("--sample-rate")
        .arg(request.sample_rate.to_string())
        .arg("--tail-seconds")
        .arg(request.tail_seconds.to_string());
    if let Some(sequence) = request.sequence {
        command.arg("--sequence").arg(sequence);
    }
    if let Some(input) = request.input {
        command.arg("--input").arg(input);
    }
    if let Some(preset) = request.preset {
        command.arg("--preset").arg(preset);
    }
    for parameter in request.parameter_arguments {
        command.arg("--parameter").arg(parameter);
    }
    let status = command
        .status()
        .context("failed to launch the bundled Rust Ableton host")?;
    ensure!(
        status.success(),
        "bundled Rust Ableton host exited with {status}"
    );
    Ok(())
}

fn parse_native_parameters(arguments: &[String]) -> Result<Vec<NativeParameter>> {
    arguments
        .iter()
        .map(|argument| {
            let (id, value) = argument
                .split_once('=')
                .with_context(|| format!("invalid parameter '{argument}'; expected ID=VALUE"))?;
            let id = id
                .parse::<u64>()
                .with_context(|| format!("invalid native parameter ID '{id}'"))?;
            let value = value
                .parse::<f32>()
                .with_context(|| format!("invalid native parameter value '{value}'"))?;
            ensure!(
                value.is_finite(),
                "native parameter {id} must have a finite value"
            );
            Ok(NativeParameter { id, value })
        })
        .collect()
}

// Electric's ADV document order is not its native parameter order. This table
// follows the registration sequence recovered from the Lounge Lizard wrapper
// constructor (sub_1a70 in Electric 12.3.1).
const ELECTRIC_ADV_PARAMETER_MAP: &[(u64, &str)] = &[
    (0, "Polyphony"),
    (1, "PitchBendRange"),
    (2, "KeyboardStretch"),
    (3, "KeyboardTranspose"),
    (4, "MalletStiffness"),
    (5, "MalletStiffnessKeyboard"),
    (6, "MalletStiffnessVelocity"),
    (7, "MalletForceStrength"),
    (8, "MalletForceKeyboard"),
    (9, "MalletForceVelocity"),
    (10, "MalletNoisePitch"),
    (11, "MalletNoiseDecay"),
    (12, "MalletNoiseAmount"),
    (13, "MalletNoiseKeyboardScaling"),
    (14, "ForkReleaseTime"),
    (15, "ForkTineDecay"),
    (16, "ForkTineVolume"),
    (17, "ForkTineKeyboardScaling"),
    (18, "ForkTineColor"),
    (19, "ForkToneBarDecay"),
    (20, "ForkToneBarVolume"),
    (21, "PickupSymmetry"),
    (22, "PickupDistance"),
    (23, "PickupModel"),
    (24, "PickupAmpIn"),
    (25, "PickupAmpOut"),
    (26, "PickupAmpKeyboardScaling"),
    (27, "DamperTone"),
    (28, "DamperAmount"),
    (29, "DamperBalance"),
    (30, "KeyboardFineTune"),
    (31, "Volume"),
    (32, "PerNotePitchBendRange"),
];

fn native_preset_parameters(device: &str, preset: &Path) -> Result<Vec<NativeParameter>> {
    let xml = read_ableton_xml(preset)?;
    let document = Document::parse(&xml)
        .with_context(|| format!("failed to parse Ableton preset {}", preset.display()))?;
    let root = document
        .root_element()
        .children()
        .find(Node::is_element)
        .context("Ableton preset has no device")?;
    let expected_root = match device {
        "Analog" => "UltraAnalog",
        "Electric" => "LoungeLizard",
        "Tension" => "StringStudio",
        device => device,
    };
    ensure!(
        root.tag_name().name() == expected_root,
        "preset contains {}, not {expected_root}",
        root.tag_name().name()
    );
    if matches!(device, "Analog" | "Collision" | "Corpus") {
        return ordered_native_preset_parameters(root);
    }
    let parameters: &[(u64, &str)] = match device {
        "Amp" => &[
            (0, "AmpType"),
            (1, "Bass"),
            (2, "Middle"),
            (3, "Treble"),
            (4, "Presence"),
            (5, "Gain"),
            (6, "Volume"),
        ],
        "Cabinet" => &[
            (0, "CabinetType"),
            (1, "MicrophoneTypeSwitch"),
            (2, "MicrophonePosition"),
        ],
        "Electric" => ELECTRIC_ADV_PARAMETER_MAP,
        _ => anyhow::bail!(
            "direct ADV preset mapping is not recovered for {device} yet; use --parameter ID=VALUE"
        ),
    };
    parameters
        .iter()
        .map(|&(id, name)| {
            let parameter = root
                .children()
                .find(|child| child.has_tag_name(name))
                .with_context(|| format!("{device} preset is missing {name}"))?;
            let manual = parameter
                .children()
                .find(|child| child.has_tag_name("Manual"))
                .and_then(|node| node.attribute("Value"))
                .with_context(|| format!("{device} preset {name} has no Manual value"))?;
            let value = match manual {
                "true" => 1.0,
                "false" => 0.0,
                value => value
                    .parse::<f32>()
                    .with_context(|| format!("invalid {device} preset value {name}={value}"))?,
            };
            Ok(NativeParameter { id, value })
        })
        .collect()
}

fn ordered_native_preset_parameters(root: Node<'_, '_>) -> Result<Vec<NativeParameter>> {
    root.descendants()
        .filter(Node::is_element)
        .filter(|node| !node.has_tag_name("On"))
        .filter_map(|node| {
            direct_child(node, "Manual")
                .and_then(|manual| manual.attribute("Value"))
                .map(|value| (node.tag_name().name().to_owned(), value.to_owned()))
        })
        .enumerate()
        .map(|(id, (name, value))| {
            let value = match value.as_str() {
                "true" => 1.0,
                "false" => 0.0,
                value => value
                    .parse::<f32>()
                    .with_context(|| format!("invalid native preset value {name}={value}"))?,
            };
            Ok(NativeParameter {
                id: id as u64,
                value,
            })
        })
        .collect()
}

fn render_max_amxd(
    max_contents: &Path,
    amxd: &Path,
    output: &Path,
    input: Option<&Path>,
    note_one: u8,
    note_two: u8,
    velocity: u8,
) -> Result<()> {
    ensure!(
        note_one <= 127,
        "note-one must be a MIDI pitch from 0 to 127"
    );
    ensure!(
        note_two <= 127,
        "note-two must be a MIDI pitch from 0 to 127"
    );
    ensure!(velocity <= 127, "velocity must be from 0 to 127");

    let amxd = fs::canonicalize(amxd)
        .with_context(|| format!("AMXD does not exist: {}", amxd.display()))?;
    let input = input
        .map(fs::canonicalize)
        .transpose()
        .with_context(|| format!("input WAV does not exist: {}", input.unwrap().display()))?;
    let max_binary = max_contents.join("MacOS/Max");
    ensure!(
        max_binary.is_file(),
        "Ableton's bundled Max executable does not exist: {}",
        max_binary.display()
    );

    let output = if output.is_absolute() {
        output.to_path_buf()
    } else {
        std::env::current_dir()?.join(output)
    };
    let output_parent = output
        .parent()
        .context("output path has no parent directory")?;
    fs::create_dir_all(output_parent).with_context(|| {
        format!(
            "failed to create output directory {}",
            output_parent.display()
        )
    })?;

    let patch_text = build_max_amxd_render_patch(
        &amxd.to_string_lossy(),
        &output.to_string_lossy(),
        input.as_deref(),
        note_one,
        note_two,
        velocity,
    )?;
    let _: serde_json::Value = serde_json::from_str(&patch_text)
        .context("generated Max render graph is not valid JSON")?;

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before the Unix epoch")?
        .as_nanos();
    let patch_path = std::env::temp_dir().join(format!(
        "djbooth-max-amxd-render-{}-{nonce}.maxpat",
        std::process::id()
    ));
    fs::write(&patch_path, patch_text)
        .with_context(|| format!("failed to write {}", patch_path.display()))?;

    eprintln!("render-max-amxd: engine {}", max_binary.display());
    eprintln!("render-max-amxd: device {}", amxd.display());
    eprintln!("render-max-amxd: output {}", output.display());
    let status = Command::new(&max_binary)
        .arg("--nocef")
        .arg(&patch_path)
        .status()
        .with_context(|| format!("failed to launch {}", max_binary.display()))?;
    ensure!(
        status.success(),
        "Ableton's Max engine exited with {status}"
    );
    let _ = fs::remove_file(&patch_path);

    ensure!(
        output.is_file(),
        "Ableton's Max engine exited successfully but did not create {}",
        output.display()
    );
    let reader = hound::WavReader::open(&output)
        .with_context(|| format!("failed to inspect rendered WAV {}", output.display()))?;
    let spec = reader.spec();
    let frames = reader.duration();
    ensure!(frames > 0, "Ableton's Max engine produced an empty WAV");
    drop(reader);
    let peak = read_wav_stereo(&output, spec.sample_rate)?
        .into_iter()
        .fold(0.0_f32, |peak, frame| {
            peak.max(frame[0].abs()).max(frame[1].abs())
        });
    ensure!(peak > 1.0e-7, "Ableton's Max engine rendered silence");
    let report = MaxRenderReport {
        engine: max_binary,
        amxd,
        input,
        output,
        note_one,
        note_two,
        velocity,
        channels: spec.channels,
        sample_rate: spec.sample_rate,
        frames,
        duration_seconds: f64::from(frames) / f64::from(spec.sample_rate),
        peak,
        custom_dsp: false,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn render_max_object(
    max_contents: &Path,
    object: &str,
    input: &Path,
    output: &Path,
    tail_seconds: f64,
) -> Result<()> {
    ensure!(
        tail_seconds.is_finite() && tail_seconds >= 0.0,
        "tail-seconds must be finite and non-negative"
    );
    let object = object.trim();
    let class = object
        .split_ascii_whitespace()
        .next()
        .context("Max object cannot be empty")?;
    ensure!(
        class.starts_with("abl.") && class.ends_with('~'),
        "only Ableton's shipped abl.*~ DSP objects are accepted"
    );
    let external = max_contents
        .join("Resources/C74/packages/ableton-dsp/externals")
        .join(format!("{class}.mxo"))
        .join("Contents/MacOS")
        .join(class);
    ensure!(
        external.is_file(),
        "Ableton DSP external does not exist: {}",
        external.display()
    );
    let (inlets, outlets) = max_object_io(max_contents, class)?;
    let input = fs::canonicalize(input)
        .with_context(|| format!("input WAV does not exist: {}", input.display()))?;
    let reader = hound::WavReader::open(&input)
        .with_context(|| format!("failed to inspect input WAV {}", input.display()))?;
    let input_duration_ms =
        u64::from(reader.duration()) * 1_000 / u64::from(reader.spec().sample_rate);
    drop(reader);
    let max_binary = max_contents.join("MacOS/Max");
    ensure!(
        max_binary.is_file(),
        "Ableton's bundled Max executable does not exist: {}",
        max_binary.display()
    );
    let output = if output.is_absolute() {
        output.to_path_buf()
    } else {
        std::env::current_dir()?.join(output)
    };
    fs::create_dir_all(
        output
            .parent()
            .context("output path has no parent directory")?,
    )?;
    let tail_ms = (tail_seconds * 1_000.0).ceil() as u64;
    let stop_delay = 1_500_u64
        .saturating_add(input_duration_ms)
        .saturating_add(tail_ms);
    let patch_text = build_max_object_render_patch(
        object,
        &input.to_string_lossy(),
        &output.to_string_lossy(),
        stop_delay,
        inlets,
        outlets,
    )?;
    let _: serde_json::Value = serde_json::from_str(&patch_text)
        .context("generated Ableton DSP Max graph is not valid JSON")?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before the Unix epoch")?
        .as_nanos();
    let patch_path = std::env::temp_dir().join(format!(
        "djbooth-max-ableton-dsp-render-{}-{nonce}.maxpat",
        std::process::id()
    ));
    fs::write(&patch_path, patch_text)
        .with_context(|| format!("failed to write {}", patch_path.display()))?;

    eprintln!("render-max-object: engine {}", max_binary.display());
    eprintln!("render-max-object: object {object}");
    eprintln!("render-max-object: output {}", output.display());
    let status = Command::new(&max_binary)
        .arg("--nocef")
        .arg(&patch_path)
        .status()
        .with_context(|| format!("failed to launch {}", max_binary.display()))?;
    let _ = fs::remove_file(&patch_path);
    ensure!(
        status.success(),
        "Ableton's Max engine exited with {status}"
    );
    ensure!(
        output.is_file(),
        "Ableton's Max engine did not create {}",
        output.display()
    );
    let reader = hound::WavReader::open(&output)
        .with_context(|| format!("failed to inspect rendered WAV {}", output.display()))?;
    let spec = reader.spec();
    let frames = reader.duration();
    ensure!(frames > 0, "Ableton's Max engine produced an empty WAV");
    drop(reader);
    let peak = read_wav_stereo(&output, spec.sample_rate)?
        .into_iter()
        .fold(0.0_f32, |peak, frame| {
            peak.max(frame[0].abs()).max(frame[1].abs())
        });
    ensure!(peak > 1.0e-7, "Ableton's Max engine rendered silence");
    let report = MaxObjectRenderReport {
        engine: max_binary,
        object: object.to_owned(),
        input,
        output,
        channels: spec.channels,
        sample_rate: spec.sample_rate,
        frames,
        duration_seconds: f64::from(frames) / f64::from(spec.sample_rate),
        peak,
        custom_dsp: false,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn render_max_instrument(
    max_contents: &Path,
    object: &str,
    output: &Path,
    note: u8,
    velocity: u8,
) -> Result<()> {
    ensure!(note <= 127, "note must be in MIDI range 0..127");
    ensure!(velocity <= 127, "velocity must be in MIDI range 0..127");
    let object = object.trim();
    let class = object
        .split_ascii_whitespace()
        .next()
        .context("Max object cannot be empty")?;
    ensure!(
        class.starts_with("abl.") && class.ends_with('~'),
        "only Ableton's shipped abl.*~ DSP objects are accepted"
    );
    let external = max_contents
        .join("Resources/C74/packages/ableton-dsp/externals")
        .join(format!("{class}.mxo"))
        .join("Contents/MacOS")
        .join(class);
    ensure!(
        external.is_file(),
        "Ableton DSP external does not exist: {}",
        external.display()
    );
    let (inlets, outlets) = max_object_io(max_contents, class)?;
    ensure!(
        inlets == 1 && outlets >= 2,
        "{class} has {inlets} inputs and {outlets} outputs; the MIDI instrument adapter requires one MIDI input and at least two audio outputs"
    );
    let max_binary = max_contents.join("MacOS/Max");
    ensure!(
        max_binary.is_file(),
        "Ableton's bundled Max executable does not exist: {}",
        max_binary.display()
    );
    let output = if output.is_absolute() {
        output.to_path_buf()
    } else {
        std::env::current_dir()?.join(output)
    };
    fs::create_dir_all(
        output
            .parent()
            .context("output path has no parent directory")?,
    )?;
    let patch_text =
        build_max_instrument_render_patch(object, &output.to_string_lossy(), note, velocity)?;
    let _: serde_json::Value = serde_json::from_str(&patch_text)
        .context("generated Ableton DSP instrument graph is not valid JSON")?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before the Unix epoch")?
        .as_nanos();
    let patch_path = std::env::temp_dir().join(format!(
        "djbooth-max-ableton-instrument-render-{}-{nonce}.maxpat",
        std::process::id()
    ));
    fs::write(&patch_path, patch_text)
        .with_context(|| format!("failed to write {}", patch_path.display()))?;

    eprintln!("render-max-instrument: engine {}", max_binary.display());
    eprintln!("render-max-instrument: object {object}");
    eprintln!("render-max-instrument: output {}", output.display());
    let status = Command::new(&max_binary)
        .arg("--nocef")
        .arg(&patch_path)
        .status()
        .with_context(|| format!("failed to launch {}", max_binary.display()))?;
    let _ = fs::remove_file(&patch_path);
    ensure!(
        status.success(),
        "Ableton's Max engine exited with {status}"
    );
    ensure!(
        output.is_file(),
        "Ableton's Max engine did not create {}",
        output.display()
    );
    let reader = hound::WavReader::open(&output)
        .with_context(|| format!("failed to inspect rendered WAV {}", output.display()))?;
    let spec = reader.spec();
    let frames = reader.duration();
    ensure!(frames > 0, "Ableton's Max engine produced an empty WAV");
    drop(reader);
    let peak = read_wav_stereo(&output, spec.sample_rate)?
        .into_iter()
        .fold(0.0_f32, |peak, frame| {
            peak.max(frame[0].abs()).max(frame[1].abs())
        });
    ensure!(peak > 1.0e-7, "Ableton's Max instrument rendered silence");
    let report = MaxInstrumentRenderReport {
        engine: max_binary,
        object: object.to_owned(),
        output,
        note,
        velocity,
        channels: spec.channels,
        sample_rate: spec.sample_rate,
        frames,
        duration_seconds: f64::from(frames) / f64::from(spec.sample_rate),
        peak,
        custom_dsp: false,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn inventory_max_objects(max_contents: &Path, query: Option<&str>) -> Result<()> {
    let package = max_contents.join("Resources/C74/packages/ableton-dsp");
    let externals = package.join("externals");
    ensure!(
        externals.is_dir(),
        "Ableton DSP package does not exist: {}",
        package.display()
    );
    let query = query.map(str::to_ascii_lowercase);
    let mut objects = Vec::new();
    for entry in WalkDir::new(&externals)
        .min_depth(4)
        .max_depth(4)
        .into_iter()
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.file_type().is_file())
    {
        let class = entry.file_name().to_string_lossy().into_owned();
        if !class.starts_with("abl.") || !class.ends_with('~') {
            continue;
        }
        let help_path = package.join("help").join(format!("{class}.maxhelp"));
        let (help, attributes, inlets, outlets) = if help_path.is_file() {
            let document: serde_json::Value = serde_json::from_slice(&fs::read(&help_path)?)
                .with_context(|| format!("failed to parse {}", help_path.display()))?;
            let mut attributes = Vec::new();
            let mut inlets = None;
            let mut outlets = None;
            collect_max_help_metadata(
                &document,
                &class,
                &mut attributes,
                &mut inlets,
                &mut outlets,
            );
            attributes.sort();
            attributes.dedup();
            (Some(help_path), attributes, inlets, outlets)
        } else {
            (None, Vec::new(), None, None)
        };
        if query.as_ref().is_some_and(|query| {
            !class.to_ascii_lowercase().contains(query)
                && !attributes
                    .iter()
                    .any(|attribute| attribute.to_ascii_lowercase().contains(query))
        }) {
            continue;
        }
        objects.push(MaxObjectSummary {
            class,
            binary: entry.into_path(),
            help,
            attributes,
            inlets,
            outlets,
        });
    }
    objects.sort_by(|left, right| left.class.cmp(&right.class));
    let report = MaxObjectInventoryReport {
        package,
        count: objects.len(),
        objects,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn report_capabilities(
    core_library: &Path,
    max_contents: &Path,
    devices_root: &Path,
) -> Result<()> {
    ensure!(
        core_library.is_dir(),
        "Ableton Core Library does not exist: {}",
        core_library.display()
    );
    let mut asset_paths = WalkDir::new(core_library)
        .follow_links(false)
        .into_iter()
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| matches!(extension, "adg" | "alc" | "adv"))
        })
        .collect::<Vec<_>>();
    asset_paths.sort();
    let library_assets = asset_paths.len();
    let mut family_counts = std::collections::BTreeMap::<String, usize>::new();
    for path in asset_paths {
        for family in inspect_asset(&path, core_library)?.devices {
            *family_counts.entry(family).or_default() += 1;
        }
    }

    let max_externals = max_contents.join("Resources/C74/packages/ableton-dsp/externals");
    let compiled_max_objects = if max_externals.is_dir() {
        fs::read_dir(&max_externals)?
            .filter_map(std::result::Result::ok)
            .filter(|entry| {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                name.starts_with("abl.") && name.ends_with("~.mxo")
            })
            .count()
    } else {
        0
    };
    let standalone_native_bundles = [
        "Amp",
        "Analog",
        "Cabinet",
        "Collision",
        "Corpus",
        "Electric",
        "Tension",
    ]
    .into_iter()
    .filter(|device| {
        native_device_executable(device).is_ok_and(|(canonical, executable, _)| {
            devices_root
                .join(format!("{canonical}.bundle"))
                .join("Contents/MacOS")
                .join(executable)
                .is_file()
        })
    })
    .count();

    let families =
        family_counts
            .into_iter()
            .map(|(family, library_assets)| {
                let (
                    mechanism,
                    engine_status,
                    preset_status,
                    headless_status,
                    implementation,
                    blocker,
                ) = device_capability(&family);
                DeviceCapability {
                    family,
                    library_assets,
                    mechanism,
                    engine_status,
                    preset_status,
                    headless_status,
                    implementation: implementation.map(str::to_owned),
                    blocker,
                    custom_dsp: false,
                }
            })
            .collect::<Vec<_>>();
    let complete_families = families
        .iter()
        .filter(|family| family.headless_status == "complete")
        .count();
    let partial_families = families
        .iter()
        .filter(|family| family.headless_status == "partial")
        .count();
    let blocked_families = families
        .iter()
        .filter(|family| family.headless_status == "blocked")
        .count();
    let report = CapabilityReport {
        core_library: core_library.to_owned(),
        library_assets,
        device_families: families.len(),
        compiled_max_objects,
        standalone_native_bundles,
        complete_families,
        partial_families,
        blocked_families,
        families,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

#[allow(clippy::type_complexity)]
fn device_capability(
    family: &str,
) -> (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    Option<&'static str>,
    Option<&'static str>,
) {
    match family {
        "Amp" => (
            "standaloneNativeBundle",
            "renderProven",
            "exact",
            "complete",
            Some("Amp"),
            None,
        ),
        "Cabinet" => (
            "standaloneNativeBundle",
            "renderProven",
            "exact",
            "complete",
            Some("Cabinet"),
            None,
        ),
        "Corpus" => (
            "standaloneNativeBundle",
            "renderProven",
            "exactHashMatched",
            "complete",
            Some("Corpus"),
            None,
        ),
        "LoungeLizard" => (
            "standaloneNativeBundle",
            "renderProven",
            "exactRecoveredPermutation",
            "complete",
            Some("Electric"),
            None,
        ),
        "UltraAnalog" => (
            "standaloneNativeBundle",
            "renderProven",
            "orderedUnverified",
            "partial",
            Some("Analog"),
            Some("factory ADV parameter order needs exact differential verification"),
        ),
        "Collision" => (
            "standaloneNativeBundle",
            "renderProven",
            "orderedUnverified",
            "partial",
            Some("Collision"),
            Some("factory ADV parameter order needs exact differential verification"),
        ),
        "StringStudio" => (
            "standaloneNativeBundle",
            "abiRecovered",
            "disabled",
            "partial",
            Some("Tension"),
            Some(
                "factory ADV mapping is not yet safe; recovered assignments can silence the engine",
            ),
        ),
        "OriginalSimpler" | "MultiSampler" => (
            "coreLibrarySamples",
            "renderProven",
            "sampleZones",
            "complete",
            Some("Ableton rack/sample importer"),
            None,
        ),
        "AutoFilter" => live_engine_device_capability("AutoFilter"),
        "AutoFilter2" => live_engine_device_capability("OAutoFilter2Processor"),
        "AutoPan" => live_engine_device_capability("OAutoPanProcessor"),
        "AutoPan2" => live_engine_device_capability("OAutoPan2Processor"),
        "AutoShift" => live_engine_device_capability("OAutoShiftProcessor"),
        "BeatRepeat" => live_engine_device_capability(
            "BeatRepeatControl + BeatRepeatMixer + BeatRepeatRingBuffer",
        ),
        "Chorus" => live_engine_device_capability("Chorus"),
        "Chorus2" => live_engine_device_capability("OChorus2Processor"),
        "DrumCell" => live_engine_device_capability("ODrumSamplerProcessor"),
        "DrumBuss" => live_engine_device_capability("DrumBussProcessor"),
        "Eq8" => live_engine_device_capability("Eq8"),
        "Erosion" => live_engine_device_capability("Erosion"),
        "FilterDelay" => live_engine_device_capability("FilterDelay"),
        "FilterEQ3" => live_engine_device_capability("FilterEQ3"),
        "Flanger" => live_engine_device_capability("Flanger"),
        "FrequencyShifter" => live_engine_device_capability("FrequencyShifter"),
        "Gate" => live_engine_device_capability("Gate"),
        "GlueCompressor" => live_engine_device_capability("OGlueCompressorProcessor"),
        "GrainDelay" => live_engine_device_capability("GrainDelay"),
        "Hybrid" => live_engine_device_capability("OHybridProcessor"),
        "InstrumentImpulse" => live_engine_device_capability("InstrumentImpulse"),
        "InstrumentMeld" => live_engine_device_capability("OMeldProcessor"),
        "InstrumentVector" => live_engine_device_capability("OInstrumentWavetableProcessor"),
        "Looper" => live_engine_device_capability("Looper"),
        "MidiArpeggiator" => live_engine_device_capability("MidiArpeggiator"),
        "MidiChord" => live_engine_device_capability("MidiChord"),
        "MidiNoteLength" => live_engine_device_capability("MidiNoteLength"),
        "MidiPitcher" => live_engine_device_capability("MidiPitcher"),
        "MidiRandom" => live_engine_device_capability("MidiRandom"),
        "MidiScale" => live_engine_device_capability("MidiScale"),
        "MidiVelocity" => live_engine_device_capability("MidiVelocity"),
        "MultibandDynamics" => live_engine_device_capability("MultibandDynamics"),
        "Operator" => live_engine_device_capability("InstrumentOperator"),
        "Overdrive" => live_engine_device_capability("Overdrive"),
        "Pedal" => live_engine_device_capability("PedalProcessor"),
        "Phaser" => live_engine_device_capability("Phaser"),
        "PhaserNew" => live_engine_device_capability("OPhaserNewProcessor"),
        "Redux" => live_engine_device_capability("Redux"),
        "Resonator" => live_engine_device_capability("Resonator"),
        "Saturator" => live_engine_device_capability("Saturator"),
        "Shifter" => live_engine_device_capability("OShifterProcessor"),
        "SpectrumAnalyzer" => live_engine_device_capability("SpectrumAnalyzer"),
        "Tube" => live_engine_device_capability("Tube"),
        "Vinyl" => live_engine_device_capability("Vinyl"),
        "Vocoder" => live_engine_device_capability("Vocoder"),
        "ChannelEq" => compiled_device_capability("abl.device.channeleq~"),
        "Compressor2" => compiled_device_capability("abl.device.compressor~"),
        "Delay" => live_engine_device_capability("ODelayProcessor"),
        "Drift" => live_engine_device_capability("ODriftProcessor"),
        "Echo" => compiled_device_capability("abl.device.echo~"),
        "Limiter" => compiled_device_capability("abl.device.limiter~"),
        "Redux2" => live_engine_device_capability("ORedux2Processor"),
        "Reverb" => compiled_device_capability("abl.device.reverb~"),
        "Roar" => live_engine_device_capability("ORoarProcessor"),
        "Spectral" => compiled_device_capability("abl.device.spectraltime~"),
        "StereoGain" => live_engine_device_capability("StereoGain"),
        "Transmute" => compiled_device_capability("abl.device.spectralresonator~"),
        "MxDeviceAudioEffect" | "MxDeviceInstrument" | "MxDeviceMidiEffect" => (
            "bundledMaxRuntime",
            "runtimeProven",
            "amxdLoadProven",
            "partial",
            Some("amxd~"),
            Some("each AMXD still requires dependency and non-UI render verification"),
        ),
        "InstrumentGroupDevice"
        | "DrumGroupDevice"
        | "AudioEffectGroupDevice"
        | "MidiEffectGroupDevice"
        | "AudioBranchMixerDevice"
        | "MidiBranchMixerDevice" => (
            "rackGraph",
            "exhaustiveParseProven",
            "valuesMappingsAndZonesRecovered",
            "partial",
            Some("ADG graph importer"),
            Some(
                "native execution of parallel chains, sends, selectors, and nested mixer routing is not complete",
            ),
        ),
        _ => (
            "unmappedAbletonRuntime",
            "notRecovered",
            "inspectOnly",
            "blocked",
            None,
            Some("no standalone or recovered headless Ableton implementation is mapped yet"),
        ),
    }
}

#[allow(clippy::type_complexity)]
fn live_engine_device_capability(
    processor: &'static str,
) -> (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    Option<&'static str>,
    Option<&'static str>,
) {
    let render_proven = [
        "AutoFilter",
        "BeatRepeatMixer + BeatRepeatRingBuffer",
        "Chorus",
        "Compressor2",
        "DrumBussProcessor",
        "Eq8",
        "FilterDelay",
        "FrequencyShifter",
        "Looper",
        "OAutoFilter2Processor",
        "OAutoPan2Processor",
        "OAutoPanProcessor",
        "OAutoShiftProcessor",
        "OChannelEqProcessor",
        "OChorus2Processor",
        "ODelayProcessor",
        "ODriftProcessor",
        "ODrumSamplerProcessor",
        "OHybridProcessor",
        "OInstrumentWavetableProcessor",
        "OMeldProcessor",
        "OPhaserNewProcessor",
        "ORedux2Processor",
        "OReverbProcessor",
        "ORoarProcessor",
        "OShifterProcessor",
        "PedalProcessor",
        "Phaser",
        "Redux",
        "Saturator",
        "StereoGain",
        "Vinyl",
    ]
    .contains(&processor);
    let preset_exhaustive = [
        "AutoFilter",
        "Chorus",
        "DrumBussProcessor",
        "Eq8",
        "FrequencyShifter",
        "Looper",
        "OAutoFilter2Processor",
        "OAutoPanProcessor",
        "OChorus2Processor",
        "ODriftProcessor",
        "OPhaserNewProcessor",
        "ORedux2Processor",
        "ORoarProcessor",
        "PedalProcessor",
        "Phaser",
        "Redux",
        "StereoGain",
        "Vinyl",
    ]
    .contains(&processor);
    let preset_partial =
        ["OAutoShiftProcessor", "ODelayProcessor", "Saturator"].contains(&processor);
    if preset_exhaustive {
        (
            "liveEngineBundle",
            "nativeAudioRenderProven",
            "exhaustiveAdvRenderProven",
            "partial",
            Some(processor),
            Some(
                "all installed ADV presets render finitely; composite rack/sidechain differentials remain",
            ),
        )
    } else if preset_partial {
        (
            "liveEngineBundle",
            "nativeAudioRenderProven",
            "installedAdvRenderPartial",
            "partial",
            Some(processor),
            Some("the exhaustive audit found specific installed presets with non-finite output"),
        )
    } else if render_proven {
        (
            "liveEngineBundle",
            "nativeAudioRenderProven",
            "nativePortApplicationUnsafe",
            "partial",
            Some(processor),
            Some(
                "representative ADV rendering is silent, non-finite, unstable, or requires a composite voice/sample graph",
            ),
        )
    } else {
        (
            "liveEngineBundle",
            "factoryConstructionProven",
            "nativePortApplicationProven",
            "partial",
            Some(processor),
            Some(
                "special companion, voice, sidechain, or graph state is still required for native audio rendering",
            ),
        )
    }
}

#[allow(clippy::type_complexity)]
fn compiled_device_capability(
    object: &'static str,
) -> (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    Option<&'static str>,
    Option<&'static str>,
) {
    (
        "compiledAbletonMaxObject",
        "renderProven",
        "attributesOnly",
        "partial",
        Some(object),
        Some("ADV-to-object attribute translation is not mapped yet"),
    )
}

fn collect_max_help_metadata(
    value: &serde_json::Value,
    class: &str,
    attributes: &mut Vec<String>,
    inlets: &mut Option<u64>,
    outlets: &mut Option<u64>,
) {
    match value {
        serde_json::Value::Object(object) => {
            if let Some(box_object) = object.get("box").and_then(serde_json::Value::as_object) {
                if let Some(attribute) = box_object.get("attr").and_then(serde_json::Value::as_str)
                {
                    attributes.push(attribute.to_owned());
                }
                if box_object
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|text| {
                        text == class
                            || text
                                .strip_prefix(class)
                                .is_some_and(|suffix| suffix.starts_with(' '))
                    })
                {
                    if let Some(value) = box_object
                        .get("numinlets")
                        .and_then(serde_json::Value::as_u64)
                    {
                        *inlets = Some(inlets.map_or(value, |current| current.max(value)));
                    }
                    if let Some(value) = box_object
                        .get("numoutlets")
                        .and_then(serde_json::Value::as_u64)
                    {
                        *outlets = Some(outlets.map_or(value, |current| current.max(value)));
                    }
                }
            }
            for child in object.values() {
                collect_max_help_metadata(child, class, attributes, inlets, outlets);
            }
        }
        serde_json::Value::Array(array) => {
            for child in array {
                collect_max_help_metadata(child, class, attributes, inlets, outlets);
            }
        }
        _ => {}
    }
}

fn build_max_object_render_patch(
    object: &str,
    input: &str,
    output: &str,
    stop_delay: u64,
    inlets: u64,
    outlets: u64,
) -> Result<String> {
    ensure!(inlets > 0, "Ableton DSP object has no input");
    ensure!(outlets > 0, "Ableton DSP object has no output");
    let object = json_string_contents(object)?;
    let (device_boxes, device_lines) = if outlets == 1 {
        (
            format!(
                r#"{{ "box": {{ "id": "device-left", "maxclass": "newobj", "text": "{object}", "patching_rect": [330.0, 225.0, 500.0, 22.0], "numinlets": {inlets}, "numoutlets": 1, "outlettype": ["signal"] }} }},
      {{ "box": {{ "id": "device-right", "maxclass": "newobj", "text": "{object}", "patching_rect": [330.0, 260.0, 500.0, 22.0], "numinlets": {inlets}, "numoutlets": 1, "outlettype": ["signal"] }} }},"#
            ),
            r#"{ "patchline": { "source": ["input-player", 0], "destination": ["device-left", 0] } },
      { "patchline": { "source": ["input-player", 1], "destination": ["device-right", 0] } },
      { "patchline": { "source": ["device-left", 0], "destination": ["record", 0] } },
      { "patchline": { "source": ["device-right", 0], "destination": ["record", 1] } },
      { "patchline": { "source": ["device-left", 0], "destination": ["dac", 0] } },
      { "patchline": { "source": ["device-right", 0], "destination": ["dac", 1] } },"#
                .to_owned(),
        )
    } else {
        (
            format!(
                r#"{{ "box": {{ "id": "device", "maxclass": "newobj", "text": "{object}", "patching_rect": [330.0, 235.0, 500.0, 22.0], "numinlets": {inlets}, "numoutlets": {outlets}, "outlettype": ["signal", "signal"] }} }},"#
            ),
            r#"{ "patchline": { "source": ["input-player", 0], "destination": ["device", 0] } },
      { "patchline": { "source": ["input-player", 1], "destination": ["device", 1] } },
      { "patchline": { "source": ["device", 0], "destination": ["record", 0] } },
      { "patchline": { "source": ["device", 1], "destination": ["record", 1] } },
      { "patchline": { "source": ["device", 0], "destination": ["dac", 0] } },
      { "patchline": { "source": ["device", 1], "destination": ["dac", 1] } },"#
                .to_owned(),
        )
    };
    Ok(MAX_DSP_EFFECT_RENDER_TEMPLATE
        .replace("__DEVICE_BOXES__", &device_boxes)
        .replace("__DEVICE_LINES__", &device_lines)
        .replace("__INPUT__", &json_string_contents(input)?)
        .replace("__OUTPUT__", &json_string_contents(output)?)
        .replace("__STOP_DELAY__", &stop_delay.to_string())
        .replace(
            "__QUIT_DELAY__",
            &stop_delay.saturating_add(500).to_string(),
        ))
}

fn build_max_instrument_render_patch(
    object: &str,
    output: &str,
    note: u8,
    velocity: u8,
) -> Result<String> {
    ensure!(note <= 127, "note must be in MIDI range 0..127");
    ensure!(velocity <= 127, "velocity must be in MIDI range 0..127");
    Ok(MAX_DSP_INSTRUMENT_RENDER_TEMPLATE
        .replace("__DEVICE__", &json_string_contents(object)?)
        .replace("__OUTPUT__", &json_string_contents(output)?)
        .replace("__NOTE__", &note.to_string())
        .replace("__VELOCITY__", &velocity.to_string()))
}

pub(crate) fn max_object_io(max_contents: &Path, class: &str) -> Result<(u64, u64)> {
    let help = max_contents
        .join("Resources/C74/packages/ableton-dsp/help")
        .join(format!("{class}.maxhelp"));
    if !help.is_file() {
        return Ok((2, 2));
    }
    let document: serde_json::Value = serde_json::from_slice(&fs::read(&help)?)
        .with_context(|| format!("failed to parse {}", help.display()))?;
    let mut attributes = Vec::new();
    let mut inlets = None;
    let mut outlets = None;
    collect_max_help_metadata(&document, class, &mut attributes, &mut inlets, &mut outlets);
    Ok((inlets.unwrap_or(2), outlets.unwrap_or(2)))
}

fn build_max_amxd_render_patch(
    amxd: &str,
    output: &str,
    input: Option<&Path>,
    note_one: u8,
    note_two: u8,
    velocity: u8,
) -> Result<String> {
    // This graph contains orchestration and routing only. `amxd~`, MIDI event
    // handling, audio rendering, and WAV recording all execute in Max's shipped
    // runtime and objects.
    let (input_boxes, input_lines, stop_delay) = if let Some(input) = input {
        let reader = hound::WavReader::open(input)
            .with_context(|| format!("failed to inspect input WAV {}", input.display()))?;
        let duration_ms =
            u64::from(reader.duration()) * 1_000 / u64::from(reader.spec().sample_rate);
        let input = json_string_contents(&input.to_string_lossy())?;
        (
            format!(
                r#"{{ "box": {{ "id": "input-open-delay", "maxclass": "newobj", "text": "delay 1500", "patching_rect": [330.0, 110.0, 75.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": ["bang"] }} }},
      {{ "box": {{ "id": "input-open", "maxclass": "message", "text": "open \"{input}\", 1", "patching_rect": [420.0, 110.0, 300.0, 22.0], "numinlets": 2, "numoutlets": 1, "outlettype": [""] }} }},
      {{ "box": {{ "id": "input-player", "maxclass": "newobj", "text": "sfplay~ 2", "patching_rect": [330.0, 160.0, 70.0, 22.0], "numinlets": 2, "numoutlets": 3, "outlettype": ["signal", "signal", "bang"] }} }},"#
            ),
            r#"{ "patchline": { "source": ["load", 0], "destination": ["input-open-delay", 0] } },
      { "patchline": { "source": ["input-open-delay", 0], "destination": ["input-open", 0] } },
      { "patchline": { "source": ["input-open", 0], "destination": ["input-player", 0] } },
      { "patchline": { "source": ["input-player", 0], "destination": ["device", 0] } },
      { "patchline": { "source": ["input-player", 1], "destination": ["device", 1] } },"#
                .to_owned(),
            1_500_u64.saturating_add(duration_ms).saturating_add(1_000),
        )
    } else {
        (String::new(), String::new(), 4_300)
    };
    Ok(MAX_AMXD_RENDER_TEMPLATE
        .replace("__AMXD__", &json_string_contents(amxd)?)
        .replace("__OUTPUT__", &json_string_contents(output)?)
        .replace("__INPUT_BOXES__", &input_boxes)
        .replace("__INPUT_LINES__", &input_lines)
        .replace("__STOP_DELAY__", &stop_delay.to_string())
        .replace(
            "__QUIT_DELAY__",
            &stop_delay.saturating_add(500).to_string(),
        )
        .replace("__NOTE1__", &note_one.to_string())
        .replace("__NOTE2__", &note_two.to_string())
        .replace("__VELOCITY__", &velocity.to_string()))
}

fn json_string_contents(value: &str) -> Result<String> {
    let encoded = serde_json::to_string(value)?;
    Ok(encoded[1..encoded.len() - 1].to_owned())
}

fn probe_max_runtime(max_contents: &Path) -> Result<()> {
    let max_plug_lib =
        max_contents.join("Resources/C74/support/MaxPlugLib.bundle/Contents/MacOS/MaxPlugLib");
    // MaxAudioAPIImpl is the implementation re-exported by MaxAudioAPI. A
    // non-Max executable cannot resolve the wrapper's executable-relative
    // rpath, so the headless host opens the implementation directly and invokes
    // its exported system initializer below.
    let max_audio_api =
        max_contents.join("Frameworks/MaxAudioAPIImpl.framework/Versions/A/MaxAudioAPIImpl");
    ensure!(
        max_plug_lib.is_file(),
        "MaxPlugLib does not exist: {}",
        max_plug_lib.display()
    );
    ensure!(
        max_audio_api.is_file(),
        "MaxAudioAPIImpl does not exist: {}",
        max_audio_api.display()
    );

    // MaxAudioAPIImpl resolves the Max object/runtime API from MaxPlugLib. It must
    // therefore be loaded globally and kept resident for the lifetime of the API.
    eprintln!("probe-max: loading MaxPlugLib");
    let _max_plug_handle = open_library_global(&max_plug_lib)?;
    type MflInit = unsafe extern "C" fn(u64);
    let mfl_init: MflInit = unsafe { load_symbol(_max_plug_handle, c"mfl_init")? };
    eprintln!("probe-max: initializing the Max-for-Live runtime");
    unsafe { mfl_init(0x10) };
    eprintln!("probe-max: loading MaxAudioAPIImpl");
    let max_audio_handle = open_library_global(&max_audio_api)?;

    type ZSysInit = unsafe extern "C" fn();
    type PlugInterfaceNew = unsafe extern "C" fn() -> *mut c_void;
    type ObjectFree = unsafe extern "C" fn(*mut c_void);
    type Gensym = unsafe extern "C" fn(*const libc::c_char) -> *mut c_void;
    type ObjectNewTyped =
        unsafe extern "C" fn(*mut c_void, *mut c_void, libc::c_long, *const c_void) -> *mut c_void;
    eprintln!("probe-max: resolving runtime symbols");
    let z_sysinit: ZSysInit = unsafe { load_symbol(max_audio_handle, c"z_sysinit")? };
    eprintln!("probe-max: initializing MaxAudioAPIImpl");
    unsafe { z_sysinit() };
    let plug_interface_new: PlugInterfaceNew =
        unsafe { load_symbol(max_audio_handle, c"pluginterface_new")? };
    let object_free: ObjectFree = unsafe { load_symbol(_max_plug_handle, c"object_free")? };
    let gensym: Gensym = unsafe { load_symbol(_max_plug_handle, c"gensym")? };
    let object_new_typed: ObjectNewTyped =
        unsafe { load_symbol(_max_plug_handle, c"object_new_typed")? };
    eprintln!("probe-max: creating bootstrap plug interface");
    let plug_interface = unsafe { plug_interface_new() };
    ensure!(
        !plug_interface.is_null(),
        "Ableton's Max runtime returned a null plug interface"
    );
    eprintln!("probe-max: creating plug host, plug interface, and DSP runner");
    let no_box = unsafe { gensym(c"nobox".as_ptr()) };
    let plug_host_class = unsafe { gensym(c"plughost".as_ptr()) };
    let plug_host = unsafe { object_new_typed(no_box, plug_host_class, 0, std::ptr::null()) };
    ensure!(
        !plug_host.is_null(),
        "Ableton's Max runtime returned a null plug host"
    );
    unsafe { object_free(plug_host) };
    unsafe { object_free(plug_interface) };
    eprintln!("probe-max: runtime probe complete");

    let report = MaxProbeReport {
        max_contents: max_contents.to_path_buf(),
        max_plug_lib,
        max_audio_api,
        plug_interface_created: true,
        plug_host_created: true,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn live_engine_port_kind(kind: u32) -> &'static str {
    match kind {
        1 => "audioIn",
        2 => "audioOut",
        3 => "inverseAudioIn",
        4 => "inverseAudioOut",
        5 => "audioBufferIn",
        6 => "audioBufferOut",
        7 => "floatEventIn",
        8 => "floatEventOut",
        9 => "pointerEventIn",
        10 => "pointerEventOut",
        _ => "unknown",
    }
}

fn audit_live_engine(engine: &Path, jobs: usize, render: bool) -> Result<()> {
    ensure!(jobs > 0, "--jobs must be greater than zero");
    ensure!(
        std::env::consts::ARCH == "x86_64",
        "Ableton Live Engine audit requires an x86_64 djbooth-rs host"
    );
    let engine = fs::canonicalize(engine)
        .with_context(|| format!("Ableton Live Engine does not exist: {}", engine.display()))?;
    let engine_sha256 = format!("{:x}", Sha256::digest(fs::read(&engine)?));
    let executable = std::env::current_exe().context("cannot resolve the djbooth-rs executable")?;
    let inventory = Command::new(&executable)
        .args(["ableton", "probe-live-engine", "--bootstrap", "--engine"])
        .arg(&engine)
        .output()
        .context("cannot start the Ableton Live Engine inventory subprocess")?;
    ensure!(
        inventory.status.success(),
        "Ableton Live Engine inventory subprocess failed: {}",
        String::from_utf8_lossy(&inventory.stderr)
    );
    let inventory: serde_json::Value = serde_json::from_slice(&inventory.stdout)
        .context("Ableton Live Engine inventory returned invalid JSON")?;
    let render_processors = inventory["processorSchemas"]
        .as_array()
        .context("Ableton Live Engine inventory omitted processorSchemas")?
        .iter()
        .filter(|schema| schema["audioProcessor"].as_bool() == Some(true))
        .filter(|schema| matches!(schema["processorRate"].as_u64(), Some(2 | 3)))
        .filter(|schema| {
            let Some(ports) = schema["ports"].as_array() else {
                return false;
            };
            let has_input = ports
                .iter()
                .any(|port| matches!(port["kind"].as_str(), Some("audioIn" | "audioBufferIn")));
            let has_output = ports
                .iter()
                .any(|port| matches!(port["kind"].as_str(), Some("audioOut" | "audioBufferOut")));
            has_input && has_output
        })
        .filter_map(|schema| schema["name"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let processors = inventory["registeredProcessors"]
        .as_array()
        .context("Ableton Live Engine inventory omitted registeredProcessors")?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .context("Ableton processor registry contains a non-string name")
        })
        .collect::<Result<std::collections::VecDeque<_>>>()?;
    let registered_processors = processors.len();
    let failed_processors =
        run_live_engine_audit_workers(&executable, &engine, processors, jobs, None)?;
    let renderable_processors = render_processors.len();
    let render_processor_names = render_processors.clone();
    let render_directory = render.then(tempfile::tempdir).transpose()?;
    let failed_renders = if let Some(directory) = &render_directory {
        run_live_engine_audit_workers(
            &executable,
            &engine,
            render_processors.into(),
            jobs,
            Some(directory.path()),
        )?
    } else {
        Vec::new()
    };
    let failed_render_names = failed_renders
        .iter()
        .map(|failure| failure.processor.as_str())
        .collect::<std::collections::HashSet<_>>();
    let rendered_processor_names = if render {
        render_processor_names
            .into_iter()
            .filter(|processor| !failed_render_names.contains(processor.as_str()))
            .collect()
    } else {
        Vec::new()
    };
    let report = LiveEngineAuditReport {
        engine,
        engine_sha256,
        registered_processors,
        constructed_processors: registered_processors - failed_processors.len(),
        failed_processors,
        render_attempted: render,
        renderable_processors,
        rendered_processors: if render {
            renderable_processors - failed_renders.len()
        } else {
            0
        },
        rendered_processor_names,
        failed_renders,
        jobs,
        custom_dsp: false,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}

fn run_live_engine_audit_workers(
    executable: &Path,
    engine: &Path,
    processors: std::collections::VecDeque<String>,
    jobs: usize,
    render_directory: Option<&Path>,
) -> Result<Vec<LiveEngineAuditFailure>> {
    let processor_count = processors.len();
    let queue = std::sync::Arc::new(std::sync::Mutex::new(processors));
    let failures = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    std::thread::scope(|scope| {
        for _ in 0..jobs.min(processor_count.max(1)) {
            let queue = std::sync::Arc::clone(&queue);
            let failures = std::sync::Arc::clone(&failures);
            scope.spawn(move || {
                loop {
                    let processor = queue.lock().expect("audit queue poisoned").pop_front();
                    let Some(processor) = processor else {
                        break;
                    };
                    let mut command = Command::new(executable);
                    command
                        .args(["ableton", "probe-live-engine", "--bootstrap", "--engine"])
                        .arg(engine)
                        .args(["--processor", &processor, "--construct"])
                        .stdout(std::process::Stdio::null());
                    if let Some(directory) = render_directory {
                        command
                            .arg("--output")
                            .arg(directory.join(format!("{}.wav", slug(&processor))))
                            .args(["--render-frames", "1024"]);
                    }
                    let result = command.output();
                    match result {
                        Ok(output) if output.status.success() => {}
                        Ok(output) => {
                            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
                            let signal = output.status.signal();
                            let error = match (stderr.is_empty(), signal) {
                                (true, Some(signal)) => {
                                    Some(format!("terminated by signal {signal}"))
                                }
                                (false, Some(signal)) => {
                                    Some(format!("{stderr}\nterminated by signal {signal}"))
                                }
                                (false, None) => Some(stderr),
                                (true, None) => None,
                            };
                            failures.lock().expect("audit failures poisoned").push(
                                LiveEngineAuditFailure {
                                    processor,
                                    exit_code: output.status.code(),
                                    error,
                                },
                            );
                        }
                        Err(error) => failures.lock().expect("audit failures poisoned").push(
                            LiveEngineAuditFailure {
                                processor,
                                exit_code: None,
                                error: Some(error.to_string()),
                            },
                        ),
                    }
                }
            });
        }
    });
    let mut failed_processors = std::sync::Arc::try_unwrap(failures)
        .map_err(|_| anyhow::anyhow!("Ableton audit workers retained their result queue"))?
        .into_inner()
        .map_err(|_| anyhow::anyhow!("Ableton audit result queue was poisoned"))?;
    failed_processors.sort_by(|left, right| left.processor.cmp(&right.processor));
    Ok(failed_processors)
}

fn probe_live_engine(request: LiveEngineProbeRequest<'_>) -> Result<()> {
    let LiveEngineProbeRequest {
        engine,
        bootstrap,
        processor,
        construct,
        input,
        sample,
        preset,
        preset_device_offset,
        output,
        parameters,
        note,
        sequence,
        velocity,
        gate_seconds,
        render_frames,
    } = request;
    ensure!(
        bootstrap || processor.is_none(),
        "--processor requires --bootstrap"
    );
    ensure!(
        !construct || processor.is_some(),
        "--construct requires --processor"
    );
    ensure!(
        construct || (input.is_none() && sample.is_none() && preset.is_none() && output.is_none()),
        "--input, --sample, --preset and --output require --construct"
    );
    ensure!(
        construct || parameters.is_empty(),
        "--parameter requires --construct"
    );
    ensure!(
        construct || (note.is_none() && sequence.is_none()),
        "--note and --sequence require --construct"
    );
    ensure!(
        note.is_none() || sequence.is_none(),
        "--note and --sequence are mutually exclusive"
    );
    ensure!(
        sample.is_none() || processor == Some("ODrumSamplerProcessor"),
        "--sample currently requires --processor ODrumSamplerProcessor"
    );
    ensure!(
        preset_device_offset.is_none() || preset.is_some(),
        "--preset-device-offset requires --preset"
    );
    ensure!(
        render_frames.is_none_or(|frames| frames > 0),
        "--render-frames must be positive"
    );
    let processor_preset = preset
        .map(|path| {
            fs::canonicalize(path)
                .with_context(|| format!("Ableton preset does not exist: {}", path.display()))
        })
        .transpose()?;
    let preset_parameters = processor_preset
        .as_deref()
        .map(|path| live_engine_preset_parameters(path, preset_device_offset))
        .transpose()?
        .unwrap_or_default();
    ensure!(note.is_none_or(|note| note <= 127), "--note must be 0..127");
    ensure!(
        note.is_none() || (1..=127).contains(&velocity),
        "--velocity must be 1..127"
    );
    ensure!(
        gate_seconds.is_finite() && gate_seconds > 0.0,
        "--gate-seconds must be positive and finite"
    );
    let sequence = sequence
        .map(|path| {
            let sequence: Sequence = serde_json::from_slice(
                &fs::read(path)
                    .with_context(|| format!("failed to read sequence {}", path.display()))?,
            )
            .with_context(|| format!("invalid sequence JSON {}", path.display()))?;
            validate_sequence(&sequence)?;
            Ok::<_, anyhow::Error>(sequence)
        })
        .transpose()?;
    let mut scheduled_midi = Vec::new();
    let mut midi_total_frames = 0_usize;
    if let Some(sequence) = &sequence {
        let frames_per_beat = f64::from(DEFAULT_SAMPLE_RATE) * 60.0 / sequence.bpm;
        for (index, sequence_note) in sequence.notes.iter().enumerate() {
            let note_id = u64::try_from(index)? + 1;
            let start = (sequence_note.beat * frames_per_beat).round() as usize;
            let end = ((sequence_note.beat + sequence_note.duration_beats) * frames_per_beat)
                .round() as usize;
            scheduled_midi.push(LiveEngineScheduledMidi {
                frame: start,
                note_on: true,
                note: sequence_note.note,
                velocity: sequence_note.velocity,
                note_id,
            });
            scheduled_midi.push(LiveEngineScheduledMidi {
                frame: end,
                note_on: false,
                note: sequence_note.note,
                velocity: 0,
                note_id,
            });
        }
        let total_beats = f64::from(sequence.bars * sequence.beats_per_bar);
        midi_total_frames =
            (total_beats * frames_per_beat).ceil() as usize + DEFAULT_SAMPLE_RATE as usize * 2;
    } else if let Some(note) = note {
        scheduled_midi.push(LiveEngineScheduledMidi {
            frame: 0,
            note_on: true,
            note,
            velocity,
            note_id: 1,
        });
        scheduled_midi.push(LiveEngineScheduledMidi {
            frame: (gate_seconds * DEFAULT_SAMPLE_RATE as f32).round() as usize,
            note_on: false,
            note,
            velocity: 0,
            note_id: 1,
        });
        midi_total_frames = DEFAULT_SAMPLE_RATE as usize * 2;
    }
    scheduled_midi.sort_by_key(|event| (event.frame, event.note_on));
    let engine = fs::canonicalize(engine)
        .with_context(|| format!("Ableton Live Engine does not exist: {}", engine.display()))?;
    let engine_sha256 = format!("{:x}", Sha256::digest(fs::read(&engine)?));
    let abi_profile = (engine_sha256 == LIVE_ENGINE_12_3_1_SHA256).then_some("Live 12.3.1");
    if bootstrap {
        ensure!(
            abi_profile.is_some(),
            "unsupported Ableton Live Engine build {engine_sha256}; recovered offsets are pinned to Live 12.3.1 ({LIVE_ENGINE_12_3_1_SHA256})"
        );
    }
    let _engine_handle = open_library_global(&engine)?;
    let mut loaded_image = None;
    let mut vmaddr_slide = 0_i64;
    unsafe {
        let count = _dyld_image_count();
        for index in 0..count {
            let name = _dyld_get_image_name(index);
            if name.is_null() {
                continue;
            }
            let path = PathBuf::from(CStr::from_ptr(name).to_string_lossy().into_owned());
            if fs::canonicalize(&path).is_ok_and(|candidate| candidate == engine) {
                vmaddr_slide = _dyld_get_image_vmaddr_slide(index) as i64;
                loaded_image = Some(path);
                break;
            }
        }
    }
    let loaded_image =
        loaded_image.context("dyld did not report the loaded Ableton Live Engine")?;
    let mut registry_initialized = false;
    let mut init_exit_functions = 0_usize;
    let mut registry_entries = 0_usize;
    let mut engine_created = false;
    let mut audio_cycle_driven = false;
    let mut audio_peak = 0.0_f32;
    let mut processor_registered = false;
    let mut processor_constructed = false;
    let mut processor_factory_function = None;
    let mut processor_calc_function = None;
    let mut processor_graph = None;
    let mut processor_graph_attached = false;
    let mut processor_graph_entries = 0_usize;
    let mut processor_graph_execution_function = None;
    let mut preset_parameters_applied = 0_usize;
    let mut applied_parameters = Vec::new();
    let mut applied_midi_events = Vec::new();
    let mut processor_render_peak = 0.0_f32;
    let mut processor_render_delta = 0.0_f32;
    let mut processor_render_frames = 0_usize;
    let mut processor_render_output = None;
    let mut drum_sample_storage: Option<Vec<f32>> = None;
    let mut registered_processors = Vec::new();
    let mut registered_ports = 0_usize;
    let mut processor_schemas = Vec::new();
    let mut recovered_devices = Vec::new();
    if bootstrap {
        ensure!(
            std::env::consts::ARCH == "x86_64",
            "Ableton Live Engine's DSP implementation requires an x86_64 Rust host"
        );
        ensure!(
            vmaddr_slide >= 0,
            "Ableton Live Engine has a negative image slide"
        );
        let image_base = vmaddr_slide as usize;
        type NoArgs = unsafe extern "C" fn();
        type RuntimeInit = unsafe extern "C" fn(u8) -> u8;
        type EngineNew = unsafe extern "C" fn() -> *mut c_void;
        type ConfigureEngine = unsafe extern "C" fn(*mut c_void, i32, u32);
        type DriveAudio = unsafe extern "C" fn(
            *mut c_void,
            *const *const f32,
            *const *mut f32,
            i32,
            *const c_void,
        );
        type ProcessorByName = unsafe extern "C" fn(*const libc::c_char) -> *mut c_void;
        type RegisterProcessor = unsafe extern "C" fn(i32);
        type AllocateHandle = unsafe extern "C" fn() -> u64;
        type AllocateObject = unsafe extern "C" fn(usize) -> *mut u8;
        type ConstructScheduler = unsafe extern "C" fn(*mut u8);
        type InitializeScheduler = unsafe extern "C" fn(*mut u8, u8, u32);
        type ConstructEngineDomain = unsafe extern "C" fn(*mut u8, *mut u8);
        type InitializeEngineDomain = unsafe extern "C" fn(*mut u8, u8);
        type ConstructEventBufferingManager = unsafe extern "C" fn(*mut u8, u64);
        type CreateBuffer = unsafe extern "C" fn(i32) -> *mut u8;
        type ConstructAudioBufferAllocator = unsafe extern "C" fn(*mut u8, u64, i32, i32, i32);
        type SetAudioBufferAllocator = unsafe extern "C" fn(*mut c_void, u64);
        type ProcessorFactory = unsafe extern "C" fn(*mut u8);
        let register_gui_thread: NoArgs = unsafe { std::mem::transmute(image_base + 0x62190) };
        let runtime_init: RuntimeInit = unsafe { std::mem::transmute(image_base + 0xcae00) };
        let ocean_processor_init: NoArgs = unsafe { std::mem::transmute(image_base + 0x873150) };
        let init_a: NoArgs = unsafe { std::mem::transmute(image_base + 0x90f70) };
        let init_o: NoArgs = unsafe { std::mem::transmute(image_base + 0x90fb0) };
        let engine_new: EngineNew = unsafe { std::mem::transmute(image_base + 0x866a0) };
        let configure_engine: ConfigureEngine =
            unsafe { std::mem::transmute(image_base + 0x87a60) };
        let drive_audio: DriveAudio = unsafe { std::mem::transmute(image_base + 0x8da20) };
        let processor_by_name: ProcessorByName =
            unsafe { std::mem::transmute(image_base + 0xb0a90) };
        let allocate_processor_handle: AllocateHandle =
            unsafe { std::mem::transmute(image_base + 0xae3b0) };
        let allocate_handle: AllocateHandle = unsafe { std::mem::transmute(image_base + 0x9cf00) };
        let allocate_object: AllocateObject = unsafe { std::mem::transmute(image_base + 0xa7740) };
        let allocate_object2: AllocateObject = unsafe { std::mem::transmute(image_base + 0xa82a0) };
        let construct_scheduler: ConstructScheduler =
            unsafe { std::mem::transmute(image_base + 0xb99e0) };
        let initialize_scheduler: InitializeScheduler =
            unsafe { std::mem::transmute(image_base + 0xbde20) };
        let construct_engine_domain: ConstructEngineDomain =
            unsafe { std::mem::transmute(image_base + 0x94160) };
        let initialize_engine_domain: InitializeEngineDomain =
            unsafe { std::mem::transmute(image_base + 0x93f80) };
        let construct_event_buffering_manager: ConstructEventBufferingManager =
            unsafe { std::mem::transmute(image_base + 0x99d70) };
        let construct_midi_delay_manager: ConstructEventBufferingManager =
            unsafe { std::mem::transmute(image_base + 0x5defd0) };
        let create_buffer: CreateBuffer = unsafe { std::mem::transmute(image_base + 0xa7860) };
        let construct_audio_buffer_allocator: ConstructAudioBufferAllocator =
            unsafe { std::mem::transmute(image_base + 0x96510) };
        let set_audio_buffer_allocator: SetAudioBufferAllocator =
            unsafe { std::mem::transmute(image_base + 0x87520) };
        unsafe {
            eprintln!("probe-live-engine: registering Ableton GUI thread");
            register_gui_thread();
            eprintln!("probe-live-engine: initializing Ableton Ocean engine runtime");
            let object_memory_ready = runtime_init(0);
            ensure!(
                object_memory_ready != 0,
                "Ableton Live Engine object-memory bootstrap failed"
            );
            eprintln!("probe-live-engine: installing Ableton Ocean processor module");
            ocean_processor_init();
            eprintln!("probe-live-engine: opening Ableton processor registry");
            let mut init_node = *(image_base.wrapping_add(0x16ffdf0) as *const *const usize);
            while !init_node.is_null() && init_exit_functions < 10_000 {
                init_exit_functions += 1;
                init_node = *init_node.add(4) as *const usize;
            }
            init_a();
            eprintln!("probe-live-engine: installing Ableton Drum Sampler processor");
            let register_drum_sampler: RegisterProcessor =
                std::mem::transmute(image_base + 0xa398a0);
            register_drum_sampler(1);
            eprintln!("probe-live-engine: committing Ableton processor registry");
            init_o();
            registry_initialized = true;
            let registry = *(image_base.wrapping_add(0x175e6d0) as *const *const usize);
            let message_factory = *(image_base.wrapping_add(0x16ffe00) as *const *const u8);
            ensure!(
                !message_factory.is_null(),
                "Ableton message-factory table is null"
            );
            let message_factory_entries = *(message_factory.add(4) as *const u32) as usize;
            let message_factory_table_offset = *(message_factory as *const u32) as usize;
            if !registry.is_null() {
                registry_entries = *registry;
                let shared_memory_segments =
                    *(image_base.wrapping_add(0x16f6690) as *const *const usize);
                ensure!(
                    !shared_memory_segments.is_null(),
                    "Ableton shared-memory segment table is null"
                );
                for index in 0..registry_entries {
                    let location = *((registry as *const u8).add(8 + index * 4) as *const u32);
                    let segment = location >> 20;
                    let offset = usize::try_from(location & 0x000f_ffff)? << 4;
                    let segment_base = *shared_memory_segments.add(segment as usize);
                    ensure!(segment_base != 0, "Ableton shared-memory segment is null");
                    let record = segment_base + offset;
                    let name = CStr::from_ptr(record as *const libc::c_char)
                        .to_string_lossy()
                        .into_owned();
                    let create_message_id = *(record.wrapping_add(0x100) as *const u32);
                    let create_message_data = *(record.wrapping_add(0x108) as *const u64);
                    let factory_entry = ((create_message_id as usize) < message_factory_entries)
                        .then(|| {
                            message_factory.add(
                                message_factory_table_offset + create_message_id as usize * 0x18,
                            )
                        });
                    let factory_function = factory_entry.and_then(|entry| {
                        let callback = *(entry.add(0x10) as *const usize);
                        (callback != 0).then(|| {
                            if (image_base..image_base + 0x0200_0000).contains(&callback) {
                                format!("image+0x{:x}", callback - image_base)
                            } else {
                                format!("0x{callback:016x}")
                            }
                        })
                    });
                    let create_members = factory_entry
                        .map(|entry| {
                            let member_count = *(entry.add(4) as *const u32) as usize;
                            let member_table_offset = *(entry.add(8) as *const u32) as usize;
                            (0..member_count)
                                .map(|member_index| {
                                    let member = message_factory
                                        .add(member_table_offset + member_index * 0x10);
                                    let name_offset =
                                        std::ptr::read_unaligned(member as *const u32) as usize;
                                    LiveEngineMessageMemberSchema {
                                        name: CStr::from_ptr(
                                            message_factory.add(name_offset) as *const libc::c_char
                                        )
                                        .to_string_lossy()
                                        .into_owned(),
                                        type_id: std::ptr::read_unaligned(
                                            member.add(4) as *const u32
                                        ),
                                        array_count: std::ptr::read_unaligned(
                                            member.add(8) as *const u32
                                        ),
                                        byte_offset: std::ptr::read_unaligned(
                                            member.add(0xc) as *const u32
                                        ),
                                    }
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    let header_words = (0..9)
                        .map(|word| {
                            let value = *(record.wrapping_add(0x110 + word * 8) as *const u64);
                            if (image_base..image_base + 0x0200_0000).contains(&(value as usize)) {
                                format!("image+0x{:x}", value as usize - image_base)
                            } else {
                                format!("0x{value:016x}")
                            }
                        })
                        .collect();
                    let port_count = *(record.wrapping_add(0x17c) as *const u32) as usize;
                    let mut ports = Vec::with_capacity(port_count);
                    for port_index in 0..port_count {
                        let port = record + 0x180 + port_index * 0x120;
                        let port_name = CStr::from_ptr(port as *const libc::c_char)
                            .to_string_lossy()
                            .into_owned();
                        let kind_id = *(port.wrapping_add(0x100) as *const u32);
                        ports.push(LiveEnginePortSchema {
                            name: port_name,
                            kind: live_engine_port_kind(kind_id),
                            kind_id,
                            raw_u32_a: *(port.wrapping_add(0x104) as *const u32),
                            raw_u32_b: *(port.wrapping_add(0x108) as *const u32),
                            raw_u64_a: format!(
                                "0x{:016x}",
                                *(port.wrapping_add(0x110) as *const u64)
                            ),
                            raw_u64_b: format!(
                                "0x{:016x}",
                                *(port.wrapping_add(0x118) as *const u64)
                            ),
                        });
                    }
                    registered_ports += ports.len();
                    registered_processors.push(name.clone());
                    processor_schemas.push(LiveEngineProcessorSchema {
                        name,
                        create_message_id,
                        create_message_data: format!("0x{create_message_data:016x}"),
                        factory_function,
                        create_members,
                        header_words,
                        initial_calc_function: {
                            let function = std::ptr::read_unaligned(
                                record.wrapping_add(0x158) as *const usize
                            );
                            (function != 0).then(|| {
                                if (image_base..image_base + 0x0200_0000).contains(&function) {
                                    format!("image+0x{:x}", function - image_base)
                                } else {
                                    format!("0x{function:016x}")
                                }
                            })
                        },
                        change_audio_data_offset: std::ptr::read_unaligned(
                            record.wrapping_add(0x168) as *const i32,
                        ),
                        // OProcessorRegisterFiller is embedded eight bytes before
                        // the shared processor record returned by the registry.
                        audio_processor: *(record.wrapping_add(0x16c) as *const u8) != 0,
                        processor_type: *(record.wrapping_add(0x16d) as *const u8),
                        processor_rate: *(record.wrapping_add(0x16e) as *const u8),
                        ports,
                    });
                }
            }
            eprintln!("probe-live-engine: creating Ableton engine singleton");
            let engine_instance = engine_new();
            ensure!(
                !engine_instance.is_null(),
                "Ableton Live Engine singleton creation returned null"
            );
            engine_created = true;
            eprintln!("probe-live-engine: configuring and driving one Ableton audio cycle");
            configure_engine(engine_instance, DEFAULT_SAMPLE_RATE as i32, 512);
            let mut audio_buffer_allocator =
                *((engine_instance as *mut u8).add(0x28) as *const *mut u8);
            if audio_buffer_allocator.is_null() {
                let allocator = allocate_object2(0x30);
                ensure!(
                    !allocator.is_null(),
                    "Ableton audio-buffer allocator allocation failed"
                );
                let allocator_handle = allocate_handle();
                ensure!(
                    allocator_handle != 0,
                    "Ableton audio-buffer allocator handle allocation failed"
                );
                // Live normally receives this object from its controller. The
                // standalone engine has no controller, so install the exact
                // native allocator with pools for mono and stereo buffers.
                construct_audio_buffer_allocator(allocator, allocator_handle, 512, 64, 64);
                let handle = *(allocator.add(0x10) as *const u64);
                ensure!(handle != 0, "Ableton audio-buffer allocator has no handle");
                set_audio_buffer_allocator(engine_instance, handle);
                audio_buffer_allocator =
                    *((engine_instance as *mut u8).add(0x28) as *const *mut u8);
            }
            ensure!(
                !audio_buffer_allocator.is_null(),
                "Ableton engine returned no audio-buffer allocator"
            );
            *(image_base.wrapping_add(0x16ffaf0) as *mut *mut u8) = audio_buffer_allocator;
            let input_left = vec![0.0_f32; 512];
            let input_right = vec![0.0_f32; 512];
            let mut output_left = vec![0.0_f32; 512];
            let mut output_right = vec![0.0_f32; 512];
            let inputs = [input_left.as_ptr(), input_right.as_ptr()];
            let outputs = [output_left.as_mut_ptr(), output_right.as_mut_ptr()];
            drive_audio(
                engine_instance,
                inputs.as_ptr(),
                outputs.as_ptr(),
                512,
                std::ptr::null(),
            );
            audio_peak = output_left
                .iter()
                .chain(&output_right)
                .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
            audio_cycle_driven = true;
            for candidate in LIVE_ENGINE_DEVICE_NAMES {
                let name = CString::new(*candidate).expect("static processor name has no NUL");
                if !processor_by_name(name.as_ptr()).is_null() {
                    recovered_devices.push((*candidate).to_owned());
                }
            }
            if let Some(processor) = processor {
                let processor_name = CString::new(processor)
                    .context("processor registry name contains a NUL byte")?;
                eprintln!("probe-live-engine: resolving Ableton processor {processor}");
                processor_registered = !processor_by_name(processor_name.as_ptr()).is_null();
                if construct {
                    ensure!(processor_registered, "Ableton processor is not registered");
                    eprintln!("probe-live-engine: constructing Ableton {processor} processor");
                    let processor_record = processor_by_name(processor_name.as_ptr()) as *const u8;
                    let create_message_id = *(processor_record.add(0x100) as *const u32) as usize;
                    ensure!(
                        create_message_id < message_factory_entries,
                        "Ableton processor create-message ID is outside the factory table"
                    );
                    let factory_entry = message_factory
                        .add(message_factory_table_offset + create_message_id * 0x18);
                    let factory_address = *(factory_entry.add(0x10) as *const usize);
                    ensure!(
                        factory_address >= image_base,
                        "Ableton processor factory callback is null or outside the engine image"
                    );
                    processor_factory_function =
                        Some(format!("image+0x{:x}", factory_address - image_base));
                    let scheduler = allocate_object(0x458);
                    ensure!(!scheduler.is_null(), "Ableton scheduler allocation failed");
                    construct_scheduler(scheduler);
                    initialize_scheduler(scheduler, 0, DEFAULT_SAMPLE_RATE);
                    let engine_domain = allocate_object(0xa8);
                    ensure!(
                        !engine_domain.is_null(),
                        "Ableton engine-domain allocation failed"
                    );
                    construct_engine_domain(engine_domain, scheduler);
                    initialize_engine_domain(engine_domain, 0);
                    let event_buffering_manager_handle = allocate_handle();
                    ensure!(
                        event_buffering_manager_handle != 0,
                        "Ableton event-buffering manager handle allocation failed"
                    );
                    let event_buffering_manager = allocate_object2(0x48);
                    ensure!(
                        !event_buffering_manager.is_null(),
                        "Ableton event-buffering manager allocation failed"
                    );
                    construct_event_buffering_manager(
                        event_buffering_manager,
                        event_buffering_manager_handle,
                    );
                    let processor_handle = allocate_processor_handle();
                    ensure!(
                        processor_handle != 0,
                        "Ableton processor handle allocation failed"
                    );
                    let member_count = *(factory_entry.add(4) as *const u32) as usize;
                    let member_table_offset = *(factory_entry.add(8) as *const u32) as usize;
                    let mut message = [0_u8; 4096];
                    ensure!(
                        create_message_id <= u16::MAX as usize,
                        "Ableton create-message ID exceeds its serialized header"
                    );
                    message[..2].copy_from_slice(&(create_message_id as u16).to_ne_bytes());
                    let mut midi_delay_manager_handle = 0_u64;
                    let mut stream_offset = 0_usize;
                    for member_index in 0..member_count {
                        let member = message_factory.add(member_table_offset + member_index * 0x10);
                        let name_offset = std::ptr::read_unaligned(member as *const u32) as usize;
                        let member_name =
                            CStr::from_ptr(message_factory.add(name_offset) as *const libc::c_char)
                                .to_string_lossy();
                        let type_id = std::ptr::read_unaligned(member.add(4) as *const u32);
                        let array_count =
                            std::ptr::read_unaligned(member.add(8) as *const u32) as usize;
                        if type_id == 14 && stream_offset & 3 != 0 {
                            stream_offset = (stream_offset & !3) + 4;
                        }
                        let destination = message.as_mut_ptr().add(4 + stream_offset);
                        match member_name.as_ref() {
                            "CurrentSampleRate" => std::ptr::write_unaligned(
                                destination as *mut i32,
                                DEFAULT_SAMPLE_RATE as i32,
                            ),
                            "CurrentNumVoices" => {
                                std::ptr::write_unaligned(destination as *mut i32, 1)
                            }
                            "Scheduler" => {
                                std::ptr::write_unaligned(destination as *mut u64, scheduler as u64)
                            }
                            "EventBufferingManagerHandle" => std::ptr::write_unaligned(
                                destination as *mut u64,
                                event_buffering_manager_handle,
                            ),
                            "ProcessorHandle" => {
                                std::ptr::write_unaligned(destination as *mut u64, processor_handle)
                            }
                            // This is an instance-placement decision made by Live's
                            // graph planner, not the registry's audio-capability bit.
                            // The neutral standalone domain uses the default false.
                            "ProcessorAudioRate" => std::ptr::write_unaligned(destination, 0_u8),
                            name if name.starts_with("NoiseAddress")
                                || name.starts_with("WobbleAddress") =>
                            {
                                let buffer = create_buffer(0);
                                ensure!(!buffer.is_null(), "Ableton buffer allocation failed");
                                std::ptr::write_unaligned(destination as *mut *mut u8, buffer);
                            }
                            name if name.starts_with("NoiseSampleRate")
                                || name.starts_with("WobbleSampleRate") =>
                            {
                                std::ptr::write_unaligned(
                                    destination as *mut f32,
                                    DEFAULT_SAMPLE_RATE as f32,
                                );
                            }
                            "MidiDelayManager" => {
                                if midi_delay_manager_handle == 0 {
                                    midi_delay_manager_handle = allocate_handle();
                                    ensure!(
                                        midi_delay_manager_handle != 0,
                                        "Ableton MIDI-delay manager handle allocation failed"
                                    );
                                    let midi_delay_manager = allocate_object2(0x28);
                                    ensure!(
                                        !midi_delay_manager.is_null(),
                                        "Ableton MIDI-delay manager allocation failed"
                                    );
                                    construct_midi_delay_manager(
                                        midi_delay_manager,
                                        midi_delay_manager_handle,
                                    );
                                }
                                std::ptr::write_unaligned(
                                    destination as *mut u64,
                                    midi_delay_manager_handle,
                                );
                            }
                            _ => {}
                        }
                        let element_size = match type_id {
                            0 | 1 => 1,
                            2 | 5 | 14 => 4,
                            4 | 6 | 11 | 13 => 8,
                            _ => bail!("unsupported Ableton create-message member type {type_id}"),
                        };
                        stream_offset += element_size * array_count;
                    }
                    let factory: ProcessorFactory = std::mem::transmute(factory_address);
                    factory(message.as_mut_ptr());
                    let holder = *(processor_handle as *const *mut u8);
                    ensure!(
                        !holder.is_null(),
                        "Ableton {processor} factory returned no holder"
                    );
                    let processor_object = *(holder.add(0x18) as *const *mut u8);
                    ensure!(
                        !processor_object.is_null(),
                        "Ableton {processor} holder returned no processor"
                    );
                    if let Some(sample) = sample {
                        let frames = read_wav_stereo(sample, DEFAULT_SAMPLE_RATE)?;
                        ensure!(!frames.is_empty(), "Ableton Drum Sampler sample is empty");
                        let mut interleaved = Vec::with_capacity(frames.len() * 2);
                        for frame in frames {
                            interleaved.extend_from_slice(&frame);
                        }
                        type ConstructDrumSampleHolder =
                            unsafe extern "C" fn(*mut u8, *mut u8, *mut u8);
                        type SetDrumSampleHolder = unsafe extern "C" fn(*mut u8, *mut *mut u8);
                        let construct_sample_holder: ConstructDrumSampleHolder =
                            std::mem::transmute(image_base + 0x9a7b50);
                        let set_sample_holder: SetDrumSampleHolder =
                            std::mem::transmute(image_base + 0x94f6f0);
                        let sample_holder = allocate_object2(0x48);
                        ensure!(
                            !sample_holder.is_null(),
                            "Ableton Drum Sampler sample-holder allocation failed"
                        );
                        construct_sample_holder(
                            sample_holder,
                            std::ptr::null_mut(),
                            std::ptr::null_mut(),
                        );
                        *(sample_holder.add(0x28) as *mut *const f32) = interleaved.as_ptr();
                        *(sample_holder.add(0x30) as *mut u64) = 2;
                        *(sample_holder.add(0x38) as *mut u64) =
                            u64::try_from(interleaved.len() / 2)?;
                        *(sample_holder.add(0x40) as *mut u64) = u64::from(DEFAULT_SAMPLE_RATE);
                        let mut sample_holder_pointer = sample_holder;
                        set_sample_holder(processor_object, &mut sample_holder_pointer);
                        drum_sample_storage = Some(interleaved);
                    }
                    processor_constructed = true;
                    type SampleCalc = unsafe extern "C" fn(*mut u8);
                    type BufferCalc = unsafe extern "C" fn(*mut u8, i32);
                    type ConstructCalcChain = unsafe extern "C" fn(*mut u8, u64, i32, u8);
                    type AddSampleChainEntry = unsafe extern "C" fn(*mut u8, *mut u8, SampleCalc);
                    type AddBufferChainEntry = unsafe extern "C" fn(*mut u8, *mut u8, BufferCalc);
                    type ChainOperation = unsafe extern "C" fn(*mut u8);
                    type UpdateEngineDomain =
                        unsafe extern "C" fn(*mut u8, i32, u64, u64, u64, u64);
                    type EnterEngineDomain = unsafe extern "C" fn(*mut u8, *const u8);
                    type CalcEngineDomain = unsafe extern "C" fn(*mut u8, i32, i32);
                    let update_engine_domain: UpdateEngineDomain =
                        std::mem::transmute(image_base + 0x940d0);
                    let enter_engine_domain: EnterEngineDomain =
                        std::mem::transmute(image_base + 0x943c0);
                    let calc_engine_domain: CalcEngineDomain =
                        std::mem::transmute(image_base + 0x945c0);
                    let audio_processor = *processor_record.add(0x16c) != 0;
                    let processor_rate = *processor_record.add(0x16e);
                    let change_audio_data_offset =
                        std::ptr::read_unaligned(processor_record.add(0x168) as *const i32);
                    let mut calc_function =
                        std::ptr::read_unaligned(processor_record.add(0x158) as *const usize);
                    if processor == "AutoFilter" {
                        *processor_object.add(0x4114) = 1;
                        *processor_object.add(0x4115) = 1;
                        *(processor_object.add(0x40f4) as *mut f32) = 72.0;
                        *(processor_object.add(0x40f8) as *mut f32) = 127.0;
                        *(processor_object.add(0x4160) as *mut f32) = 0.25;
                        type AutoFilterCalcSelector = unsafe extern "C" fn(*mut u8) -> u64;
                        let calc_selector: AutoFilterCalcSelector =
                            std::mem::transmute(image_base + 0x1cbf20);
                        let calc_index = calc_selector(processor_object.add(0x430)) as usize + 5;
                        ensure!(
                            calc_index <= 0x24,
                            "Ableton AutoFilter calc index is invalid"
                        );
                        calc_function = *((image_base + 0x17c2780) as *const usize).add(calc_index);
                    }
                    if audio_processor && processor_rate == 3 && calc_function != 0 {
                        ensure!(
                            calc_function >= image_base,
                            "Ableton sample-rate calc is invalid"
                        );
                        let construct_chain: ConstructCalcChain =
                            std::mem::transmute(image_base + 0x7a510);
                        let add_entry: AddSampleChainEntry =
                            std::mem::transmute(image_base + 0x82e70);
                        let end_chain: ChainOperation = std::mem::transmute(image_base + 0x82fc0);
                        let enter_chain: ChainOperation = std::mem::transmute(image_base + 0x830c0);
                        let chain_handle = allocate_handle();
                        ensure!(
                            chain_handle != 0,
                            "Ableton audio-chain handle allocation failed"
                        );
                        let chain = allocate_object2(0x40);
                        ensure!(!chain.is_null(), "Ableton audio-chain allocation failed");
                        construct_chain(chain, chain_handle, 1, 1);
                        let working_chain = *(chain.add(0x28) as *const *mut u8);
                        ensure!(
                            !working_chain.is_null(),
                            "Ableton audio-chain constructor returned no working chain"
                        );
                        let calc: SampleCalc = std::mem::transmute(calc_function);
                        add_entry(working_chain, processor_object, calc);
                        end_chain(working_chain);
                        let no_op = *(image_base.wrapping_add(0x16a98e0) as *const usize);
                        let active_calc = (calc_function != no_op).then_some(calc_function);
                        let raw_entry = *(chain.add(0x18) as *const *mut u8);
                        ensure!(
                            !raw_entry.is_null(),
                            "Ableton audio-chain entry array is null"
                        );
                        *(raw_entry as *mut *mut u8) = processor_object;
                        *(raw_entry.add(8) as *mut usize) = active_calc.unwrap_or(0);
                        *(raw_entry.add(0x10) as *mut i32) = 0;
                        *(chain.add(0x34) as *mut i32) = i32::from(active_calc.is_some());
                        *(chain.add(0x38) as *mut i32) = 1;
                        if change_audio_data_offset >= 0 {
                            let change_data = allocate_object(0x18);
                            ensure!(
                                !change_data.is_null(),
                                "Ableton change-audio-function data allocation failed"
                            );
                            *(change_data as *mut usize) = active_calc.unwrap_or(0);
                            *(change_data.add(8) as *mut *mut u8) = chain;
                            *(change_data.add(0x10) as *mut i32) = 0;
                            *(processor_object.add(change_audio_data_offset as usize)
                                as *mut *mut u8) = change_data;
                        }
                        enter_chain(working_chain);
                        update_engine_domain(engine_domain, 0, 0, chain_handle, 0, 0);
                        processor_graph = Some("OAudioChain/OChain".to_owned());
                        processor_graph_attached = true;
                        processor_graph_entries = 1;
                        let execution_function = *(working_chain.add(0x18) as *const usize);
                        ensure!(
                            execution_function != 0,
                            "Ableton generated audio-chain entry point is null"
                        );
                        processor_graph_execution_function =
                            Some(format!("0x{execution_function:016x}"));
                    } else if audio_processor && processor_rate == 2 && calc_function != 0 {
                        ensure!(
                            calc_function >= image_base,
                            "Ableton buffer-rate calc is invalid"
                        );
                        let construct_chain: ConstructCalcChain =
                            std::mem::transmute(image_base + 0x75280);
                        let add_entry: AddBufferChainEntry =
                            std::mem::transmute(image_base + 0x74aa0);
                        let end_chain: ChainOperation = std::mem::transmute(image_base + 0x74ad0);
                        let enter_chain: ChainOperation = std::mem::transmute(image_base + 0x74ae0);
                        let chain_handle = allocate_handle();
                        ensure!(
                            chain_handle != 0,
                            "Ableton audio-buffer-chain handle allocation failed"
                        );
                        let chain = allocate_object2(0x40);
                        ensure!(
                            !chain.is_null(),
                            "Ableton audio-buffer-chain allocation failed"
                        );
                        construct_chain(chain, chain_handle, 1, 0);
                        let working_chain = *(chain.add(0x28) as *const *mut u8);
                        ensure!(
                            !working_chain.is_null(),
                            "Ableton audio-buffer-chain constructor returned no working chain"
                        );
                        let calc: BufferCalc = std::mem::transmute(calc_function);
                        add_entry(working_chain, processor_object, calc);
                        end_chain(working_chain);
                        enter_chain(working_chain);
                        let no_op = *(image_base.wrapping_add(0x16a98e8) as *const usize);
                        let active_calc = (calc_function != no_op).then_some(calc_function);
                        let raw_entry = *(chain.add(0x18) as *const *mut u8);
                        ensure!(
                            !raw_entry.is_null(),
                            "Ableton audio-buffer-chain entry array is null"
                        );
                        *(raw_entry as *mut *mut u8) = processor_object;
                        *(raw_entry.add(8) as *mut usize) = active_calc.unwrap_or(0);
                        *(raw_entry.add(0x10) as *mut i32) = 0;
                        *(chain.add(0x34) as *mut i32) = i32::from(active_calc.is_some());
                        *(chain.add(0x38) as *mut i32) = 1;
                        update_engine_domain(engine_domain, 0, chain_handle, 0, 0, 0);
                        processor_graph =
                            Some("OAudioBufferChain/OAudioBufferWorkingChain".to_owned());
                        processor_graph_attached = true;
                        processor_graph_entries = 1;
                        processor_graph_execution_function = Some("image+0x752b0".to_owned());
                    }
                    if processor_graph_attached {
                        processor_calc_function =
                            Some(format!("image+0x{:x}", calc_function - image_base));
                        enter_engine_domain(engine_domain, std::ptr::null());
                    }
                    let port_count = *(processor_record.add(0x17c) as *const u32) as usize;
                    let has_float_port = |parameter_name: &str| {
                        (0..port_count).any(|port_index| {
                            let port = processor_record.add(0x180 + port_index * 0x120);
                            let port_name =
                                CStr::from_ptr(port as *const libc::c_char).to_string_lossy();
                            let kind_id = *(port.add(0x100) as *const u32);
                            matches!(kind_id, 7 | 9) && port_name == parameter_name
                        })
                    };
                    let mut parameter_values = preset_parameters
                        .iter()
                        .filter(|(name, _)| has_float_port(name))
                        .cloned()
                        .collect::<Vec<_>>();
                    preset_parameters_applied = parameter_values.len();
                    for assignment in parameters {
                        let (parameter_name, value) =
                            assignment.split_once('=').with_context(|| {
                                format!("Ableton parameter must use NAME=VALUE: {assignment}")
                            })?;
                        let value = value.parse::<f32>().with_context(|| {
                            format!("invalid Ableton parameter value: {assignment}")
                        })?;
                        ensure!(value.is_finite(), "Ableton parameter must be finite");
                        ensure!(
                            has_float_port(parameter_name),
                            "Ableton {processor} has no float-compatible event input named {parameter_name}"
                        );
                        parameter_values.retain(|(name, _)| name != parameter_name);
                        parameter_values.push((parameter_name.to_owned(), value));
                    }
                    for (parameter_name, value) in &parameter_values {
                        let mut callback = None;
                        for port_index in 0..port_count {
                            let port = processor_record.add(0x180 + port_index * 0x120);
                            let port_name =
                                CStr::from_ptr(port as *const libc::c_char).to_string_lossy();
                            let kind_id = *(port.add(0x100) as *const u32);
                            if matches!(kind_id, 7 | 9) && port_name == parameter_name.as_str() {
                                callback = Some((*(port.add(0x110) as *const usize), kind_id));
                                break;
                            }
                        }
                        let (callback_address, kind_id) =
                            callback.context("validated Ableton parameter port disappeared")?;
                        ensure!(
                            callback_address >= image_base,
                            "Ableton parameter callback is outside the engine image"
                        );
                        if kind_id == 7 {
                            type FloatEventCallback = unsafe extern "C" fn(*mut u8, f32);
                            let callback: FloatEventCallback =
                                std::mem::transmute(callback_address);
                            callback(processor_object, *value);
                        } else {
                            type PointerFloatEventCallback =
                                unsafe extern "C" fn(*mut u8, *const u32);
                            let callback: PointerFloatEventCallback =
                                std::mem::transmute(callback_address);
                            // Device Kit pointer-float inputs carry a scalar
                            // followed by a scheduler/ramp offset. A zero
                            // offset applies the value at the current buffer.
                            let event = [value.to_bits(), 0];
                            callback(processor_object, event.as_ptr());
                        }
                        applied_parameters.push(LiveEngineAppliedParameter {
                            name: parameter_name.clone(),
                            value: *value,
                            callback: format!("image+0x{:x}", callback_address - image_base),
                        });
                    }
                    let render_requested = processor == "AutoFilter"
                        || input.is_some()
                        || output.is_some()
                        || !scheduled_midi.is_empty();
                    if render_requested {
                        for (activation_name, activation_value) in
                            [("InX", 1.0_f32), ("On/Off", 1.0_f32)]
                        {
                            if parameter_values
                                .iter()
                                .any(|(name, _)| name == activation_name)
                            {
                                continue;
                            }
                            let port_count = *(processor_record.add(0x17c) as *const u32) as usize;
                            let callback_address = (0..port_count).find_map(|port_index| {
                                let port = processor_record.add(0x180 + port_index * 0x120);
                                let port_name =
                                    CStr::from_ptr(port as *const libc::c_char).to_string_lossy();
                                let kind_id = *(port.add(0x100) as *const u32);
                                (kind_id == 7 && port_name == activation_name)
                                    .then(|| *(port.add(0x110) as *const usize))
                            });
                            if let Some(callback_address) = callback_address {
                                ensure!(
                                    callback_address >= image_base,
                                    "Ableton activation callback is outside the engine image"
                                );
                                type FloatEventCallback = unsafe extern "C" fn(*mut u8, f32);
                                let callback: FloatEventCallback =
                                    std::mem::transmute(callback_address);
                                callback(processor_object, activation_value);
                                applied_parameters.push(LiveEngineAppliedParameter {
                                    name: activation_name.to_owned(),
                                    value: activation_value,
                                    callback: format!(
                                        "image+0x{:x}",
                                        callback_address - image_base
                                    ),
                                });
                            }
                        }
                    }
                    let midi_callback_address = if scheduled_midi.is_empty() {
                        None
                    } else {
                        let port_count = *(processor_record.add(0x17c) as *const u32) as usize;
                        Some(
                            (0..port_count)
                                .find_map(|port_index| {
                                    let port = processor_record.add(0x180 + port_index * 0x120);
                                    let port_name = CStr::from_ptr(port as *const libc::c_char)
                                        .to_string_lossy();
                                    let kind_id = *(port.add(0x100) as *const u32);
                                    (kind_id == 9 && port_name == "InMidi")
                                        .then(|| *(port.add(0x110) as *const usize))
                                })
                                .with_context(|| {
                                    format!("Ableton {processor} has no native InMidi port")
                                })?,
                        )
                    };
                    if render_requested {
                        ensure!(
                            audio_processor
                                && matches!(processor_rate, 2 | 3)
                                && processor_graph_attached,
                            "audio rendering is not available for {processor}"
                        );
                        let port_count = *(processor_record.add(0x17c) as *const u32) as usize;
                        let mut source_frames = if let Some(input) = input {
                            read_wav_stereo(input, DEFAULT_SAMPLE_RATE)?
                        } else if !scheduled_midi.is_empty() {
                            vec![[0.0, 0.0]; midi_total_frames]
                        } else {
                            (0..DEFAULT_SAMPLE_RATE as usize * 2)
                                .map(|frame| {
                                    let sample = (std::f32::consts::TAU * 4_000.0 * frame as f32
                                        / DEFAULT_SAMPLE_RATE as f32)
                                        .sin()
                                        * 0.25;
                                    [sample, sample]
                                })
                                .collect()
                        };
                        if let Some(render_frames) = render_frames {
                            source_frames.truncate(render_frames);
                            ensure!(
                                scheduled_midi
                                    .last()
                                    .is_none_or(|event| event.frame < source_frames.len()),
                                "--render-frames truncates scheduled MIDI events"
                            );
                        }
                        let mut rendered_frames = Vec::with_capacity(source_frames.len());
                        if processor_rate == 3 {
                            let mut audio_input_offsets = Vec::new();
                            let mut audio_output_offsets = Vec::new();
                            for port_index in 0..port_count {
                                let port = processor_record.add(0x180 + port_index * 0x120);
                                let kind_id = *(port.add(0x100) as *const u32);
                                let offset = *(port.add(0x104) as *const u32);
                                if offset == u32::MAX {
                                    continue;
                                }
                                match kind_id {
                                    1 => audio_input_offsets.push(offset as usize),
                                    2 => audio_output_offsets.push(offset as usize),
                                    _ => {}
                                }
                            }
                            ensure!(
                                !audio_input_offsets.is_empty(),
                                "Ableton {processor} has no sample-rate audio input"
                            );
                            ensure!(
                                !audio_output_offsets.is_empty(),
                                "Ableton {processor} has no sample-rate audio output"
                            );
                            type SampleUpdate = unsafe extern "C" fn(*mut u8);
                            let update_before_calc: Option<SampleUpdate> =
                                (processor == "AutoFilter").then(|| {
                                    std::mem::transmute::<usize, SampleUpdate>(
                                        image_base + 0x1cb8d0,
                                    )
                                });
                            for source in &source_frames {
                                let input_samples = [source[0], source[1], source[0], source[1]];
                                for (index, offset) in audio_input_offsets.iter().enumerate() {
                                    let sample = &input_samples[index & 3];
                                    *(processor_object.add(*offset) as *mut *const f32) = sample;
                                }
                                if let Some(update) = update_before_calc {
                                    update(processor_object);
                                }
                                calc_engine_domain(engine_domain, 0, 1);
                                let output_left =
                                    *(processor_object.add(audio_output_offsets[0]) as *const f32);
                                let output_right = if audio_output_offsets.len() > 1 {
                                    *(processor_object.add(audio_output_offsets[1]) as *const f32)
                                } else {
                                    output_left
                                };
                                ensure!(
                                    output_left.is_finite() && output_right.is_finite(),
                                    "Ableton {processor} produced non-finite audio"
                                );
                                processor_render_peak = processor_render_peak
                                    .max(output_left.abs())
                                    .max(output_right.abs());
                                processor_render_delta = processor_render_delta
                                    .max((output_left - source[0]).abs())
                                    .max((output_right - source[1]).abs());
                                rendered_frames.push([output_left, output_right]);
                            }
                        } else {
                            let mut buffer_input_offsets = Vec::new();
                            let mut buffer_output_offsets = Vec::new();
                            for port_index in 0..port_count {
                                let port = processor_record.add(0x180 + port_index * 0x120);
                                let kind_id = *(port.add(0x100) as *const u32);
                                let offset = *(port.add(0x104) as *const u32);
                                if offset == u32::MAX {
                                    continue;
                                }
                                match kind_id {
                                    5 => buffer_input_offsets.push(offset as usize),
                                    6 => buffer_output_offsets.push(offset as usize),
                                    _ => {}
                                }
                            }
                            ensure!(
                                !buffer_input_offsets.is_empty(),
                                "Ableton {processor} has no buffer-rate audio input"
                            );
                            ensure!(
                                !buffer_output_offsets.is_empty(),
                                "Ableton {processor} has no buffer-rate audio output"
                            );
                            type AllocateAudioBuffer = unsafe extern "C" fn(i32, u32) -> *mut u8;
                            type FreeAudioBuffer = unsafe extern "C" fn(*mut u8);
                            let allocate_audio_buffer: AllocateAudioBuffer =
                                std::mem::transmute(image_base + 0x71d70);
                            let free_audio_buffer: FreeAudioBuffer =
                                std::mem::transmute(image_base + 0x72240);
                            let silent_output =
                                *(image_base.wrapping_add(0x168f008) as *const *mut u8);
                            let mut next_midi_event = 0_usize;
                            for chunk in source_frames.chunks(512) {
                                let sample_offset = rendered_frames.len();
                                let chunk_end = sample_offset + chunk.len();
                                if let Some(callback_address) = midi_callback_address {
                                    type MidiCallback = unsafe extern "C" fn(*mut u8, *mut u8);
                                    type ConstructNoteOn =
                                        unsafe extern "C" fn(*mut u8, i32, f32, i32, u64, i32);
                                    type ConstructNoteOff =
                                        unsafe extern "C" fn(*mut u8, i32, f32, i32, u64);
                                    let callback: MidiCallback =
                                        std::mem::transmute(callback_address);
                                    while let Some(scheduled) =
                                        scheduled_midi.get(next_midi_event).copied()
                                    {
                                        if scheduled.frame >= chunk_end {
                                            break;
                                        }
                                        ensure!(
                                            scheduled.frame >= sample_offset,
                                            "native MIDI event is behind the render cursor"
                                        );
                                        let event_offset = scheduled.frame - sample_offset;
                                        *(engine_domain.add(0x48) as *mut i32) =
                                            i32::try_from(event_offset)?;
                                        let mut event = LiveEngineMidiEvent([0; 0x30]);
                                        if scheduled.note_on {
                                            let construct: ConstructNoteOn =
                                                std::mem::transmute(image_base + 0x1772a0);
                                            construct(
                                                event.0.as_mut_ptr(),
                                                i32::from(scheduled.note),
                                                f32::from(scheduled.velocity) / 127.0,
                                                0,
                                                scheduled.note_id,
                                                0,
                                            );
                                        } else {
                                            let construct: ConstructNoteOff =
                                                std::mem::transmute(image_base + 0x177340);
                                            construct(
                                                event.0.as_mut_ptr(),
                                                i32::from(scheduled.note),
                                                0.0,
                                                0,
                                                scheduled.note_id,
                                            );
                                        }
                                        callback(processor_object, event.0.as_mut_ptr());
                                        applied_midi_events.push(LiveEngineAppliedMidiEvent {
                                            kind: if scheduled.note_on {
                                                "noteOn"
                                            } else {
                                                "noteOff"
                                            },
                                            note: scheduled.note,
                                            velocity: scheduled.velocity,
                                            note_id: scheduled.note_id,
                                            sample_offset: scheduled.frame,
                                            callback: format!(
                                                "image+0x{:x}",
                                                callback_address - image_base
                                            ),
                                        });
                                        next_midi_event += 1;
                                    }
                                    *(engine_domain.add(0x48) as *mut i32) = 0;
                                }
                                let mut input_slots =
                                    Vec::with_capacity(buffer_input_offsets.len());
                                for (input_index, offset) in buffer_input_offsets.iter().enumerate()
                                {
                                    let buffer =
                                        allocate_audio_buffer(2, u32::try_from(chunk.len())?);
                                    ensure!(
                                        !buffer.is_null(),
                                        "Ableton audio-buffer allocation failed"
                                    );
                                    ensure!(
                                        *(buffer.add(4) as *const u16) >= 2
                                            && usize::from(*(buffer.add(6) as *const u16))
                                                >= chunk.len(),
                                        "Ableton returned an invalid input audio buffer"
                                    );
                                    let right = *(buffer.add(8) as *const *mut u8);
                                    ensure!(
                                        !right.is_null(),
                                        "Ableton returned a mono buffer for stereo input"
                                    );
                                    let left_samples = buffer.add(0x10) as *mut f32;
                                    let right_samples = right.add(0x10) as *mut f32;
                                    for (frame, source) in chunk.iter().enumerate() {
                                        *left_samples.add(frame) =
                                            if input_index == 0 { source[0] } else { 0.0 };
                                        *right_samples.add(frame) =
                                            if input_index == 0 { source[1] } else { 0.0 };
                                    }
                                    let mut slot = Box::new(buffer);
                                    *(processor_object.add(*offset) as *mut *mut *mut u8) =
                                        slot.as_mut();
                                    *(processor_object.add(*offset + 8) as *mut i32) = 1;
                                    input_slots.push(slot);
                                }
                                for offset in &buffer_output_offsets {
                                    *(processor_object.add(*offset) as *mut *mut u8) =
                                        std::ptr::null_mut();
                                    *(processor_object.add(*offset + 8) as *mut i32) = 1;
                                }
                                calc_engine_domain(engine_domain, 0, chunk.len() as i32);
                                let output_buffer = *(processor_object.add(buffer_output_offsets[0])
                                    as *const *mut u8);
                                if output_buffer.is_null() || output_buffer == silent_output {
                                    rendered_frames.extend((0..chunk.len()).map(|_| [0.0, 0.0]));
                                    continue;
                                }
                                let channels = *(output_buffer.add(4) as *const u16);
                                let samples = usize::from(*(output_buffer.add(6) as *const u16));
                                ensure!(
                                    channels >= 1 && samples >= chunk.len(),
                                    "Ableton returned an invalid output audio buffer"
                                );
                                let left_samples = output_buffer.add(0x10) as *const f32;
                                let right_buffer = *(output_buffer.add(8) as *const *mut u8);
                                let right_samples = if channels >= 2 {
                                    ensure!(
                                        !right_buffer.is_null(),
                                        "Ableton returned an invalid stereo output buffer"
                                    );
                                    right_buffer.add(0x10) as *const f32
                                } else {
                                    left_samples
                                };
                                for (frame, source) in chunk.iter().enumerate() {
                                    let output_left = *left_samples.add(frame);
                                    let output_right = *right_samples.add(frame);
                                    ensure!(
                                        output_left.is_finite() && output_right.is_finite(),
                                        "Ableton {processor} produced non-finite audio"
                                    );
                                    processor_render_peak = processor_render_peak
                                        .max(output_left.abs())
                                        .max(output_right.abs());
                                    processor_render_delta = processor_render_delta
                                        .max((output_left - source[0]).abs())
                                        .max((output_right - source[1]).abs());
                                    rendered_frames.push([output_left, output_right]);
                                }
                                free_audio_buffer(output_buffer);
                            }
                            ensure!(
                                next_midi_event == scheduled_midi.len(),
                                "native MIDI scheduler did not dispatch every event"
                            );
                        }
                        processor_render_frames = rendered_frames.len();
                        if let Some(output) = output {
                            write_wav(output, DEFAULT_SAMPLE_RATE, &rendered_frames)?;
                            processor_render_output = Some(output.to_owned());
                        }
                    }
                }
            }
        }
        ensure!(
            engine_created,
            "Ableton Live Engine constructor returned null"
        );
    }
    let report = serde_json::to_string_pretty(&LiveEngineProbeReport {
        engine,
        engine_sha256,
        abi_profile,
        loaded_image,
        host_architecture: std::env::consts::ARCH,
        vmaddr_slide,
        loadable: true,
        registry_initialized,
        init_exit_functions,
        registry_entries,
        engine_created,
        sample_rate: DEFAULT_SAMPLE_RATE,
        buffer_size: 512,
        audio_cycle_driven,
        audio_peak,
        processor: processor.map(str::to_owned),
        processor_registered,
        processor_constructed,
        processor_factory_function,
        processor_calc_function,
        processor_graph,
        processor_graph_attached,
        processor_graph_entries,
        processor_graph_execution_function,
        processor_preset,
        preset_parameters_applied,
        applied_parameters,
        applied_midi_events,
        processor_render_peak,
        processor_render_delta,
        processor_render_frames,
        processor_render_output,
        registered_processors,
        registered_ports,
        processor_schemas,
        recovered_devices,
        custom_dsp: false,
    })?;
    std::hint::black_box(&drum_sample_storage);
    println!("{report}");
    if bootstrap {
        // This private MH_BUNDLE assumes Live owns its process-wide teardown.
        // The probe intentionally leaves the recovered singleton resident and
        // exits without invoking incompatible application-global destructors.
        std::io::stdout().flush()?;
        unsafe { libc::_exit(0) };
    }
    Ok(())
}

unsafe extern "C" {
    fn _dyld_image_count() -> u32;
    fn _dyld_get_image_name(image_index: u32) -> *const libc::c_char;
    fn _dyld_get_image_vmaddr_slide(image_index: u32) -> isize;
}

fn open_library_global(path: &Path) -> Result<*mut c_void> {
    let path_string = CString::new(path.as_os_str().as_encoded_bytes())
        .with_context(|| format!("library path contains a NUL byte: {}", path.display()))?;
    unsafe {
        libc::dlerror();
        let handle = libc::dlopen(path_string.as_ptr(), libc::RTLD_NOW | libc::RTLD_GLOBAL);
        if handle.is_null() {
            let message = dlerror_message();
            anyhow::bail!("failed to load {}: {message}", path.display());
        }
        Ok(handle)
    }
}

unsafe fn load_symbol<T: Copy>(handle: *mut c_void, name: &CStr) -> Result<T> {
    unsafe {
        libc::dlerror();
        let symbol = libc::dlsym(handle, name.as_ptr());
        if symbol.is_null() {
            let message = dlerror_message();
            anyhow::bail!(
                "failed to load symbol {}: {message}",
                name.to_string_lossy()
            );
        }
        Ok(std::mem::transmute_copy(&symbol))
    }
}

unsafe fn dlerror_message() -> String {
    unsafe {
        let error = libc::dlerror();
        if error.is_null() {
            "unknown dynamic-loader error".to_owned()
        } else {
            CStr::from_ptr(error).to_string_lossy().into_owned()
        }
    }
}

fn read_ableton_xml(path: &Path) -> Result<String> {
    let data = fs::read(path).with_context(|| format!("failed to read {}", path.display()))?;
    let mut xml = Vec::new();
    if data.starts_with(&[0x1f, 0x8b]) {
        GzDecoder::new(&data[..])
            .read_to_end(&mut xml)
            .with_context(|| format!("failed to decompress {}", path.display()))?;
    } else {
        xml = data;
    }
    String::from_utf8(xml).with_context(|| format!("{} is not UTF-8 Ableton XML", path.display()))
}

fn live_engine_preset_parameters(
    path: &Path,
    preset_device_offset: Option<usize>,
) -> Result<Vec<(String, f32)>> {
    let xml = read_ableton_xml(path)?;
    let document = Document::parse(&xml)
        .with_context(|| format!("failed to parse Ableton preset {}", path.display()))?;
    let device = if let Some(offset) = preset_device_offset {
        document
            .descendants()
            .find(|node| node.is_element() && node.range().start == offset)
            .with_context(|| {
                format!(
                    "Ableton preset has no device at byte offset {offset}: {}",
                    path.display()
                )
            })?
    } else {
        document
            .root_element()
            .children()
            .find(Node::is_element)
            .with_context(|| format!("Ableton preset has no device: {}", path.display()))?
    };
    let mut parameters = Vec::new();
    for parameter in device.children().filter(Node::is_element) {
        let Some(manual) = parameter
            .children()
            .find(|child| child.is_element() && child.has_tag_name("Manual"))
        else {
            continue;
        };
        let Some(raw_value) = manual.attribute("Value") else {
            continue;
        };
        let value = match raw_value {
            "true" => 1.0,
            "false" => 0.0,
            value => match value.parse::<f32>() {
                Ok(value) if value.is_finite() => value,
                _ => continue,
            },
        };
        let name = match parameter.tag_name().name() {
            "On" => "On/Off".to_owned(),
            name => name.to_owned(),
        };
        parameters.push((name, value));
    }
    ensure!(
        !parameters.is_empty(),
        "Ableton preset has no direct manual parameters: {}",
        path.display()
    );
    Ok(parameters)
}

fn scan_library(
    core_library: &Path,
    query: Option<&str>,
    kind: Option<&str>,
    limit: usize,
) -> Result<()> {
    ensure!(
        core_library.is_dir(),
        "Ableton Core Library does not exist: {}",
        core_library.display()
    );
    ensure!(limit > 0, "limit must be positive");
    let query = query.map(str::to_lowercase);
    let kind = kind.map(|value| value.trim_start_matches('.').to_lowercase());
    let mut paths = WalkDir::new(core_library)
        .follow_links(false)
        .into_iter()
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| matches!(extension, "adg" | "alc" | "adv" | "agr"))
        })
        .collect::<Vec<_>>();
    paths.sort();
    let scanned = paths.len();
    let mut assets = Vec::new();
    for path in paths {
        if kind.as_ref().is_some_and(|kind| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_none_or(|extension| extension != kind)
        }) {
            continue;
        }
        if query.as_ref().is_some_and(|query| {
            !path
                .strip_prefix(core_library)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_lowercase()
                .contains(query)
        }) {
            continue;
        }
        let asset = inspect_asset(&path, core_library)?;
        assets.push(asset);
    }
    let matched = assets.len();
    assets.truncate(limit);
    println!(
        "{}",
        serde_json::to_string_pretty(&LibraryReport {
            core_library: core_library.to_owned(),
            scanned,
            matched,
            assets,
        })?
    );
    Ok(())
}

fn inspect_asset(path: &Path, core_library: &Path) -> Result<AssetSummary> {
    let kind = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("unknown")
        .to_lowercase();
    if kind == "agr" {
        return Ok(AssetSummary {
            path: path.to_owned(),
            relative_path: path.strip_prefix(core_library).unwrap_or(path).to_owned(),
            kind,
            name: path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            devices: Vec::new(),
            references: Vec::new(),
            sample_files: 0,
            midi_notes: 0,
            renderability: "groove".to_owned(),
        });
    }
    let xml = read_ableton_xml(path)?;
    let document = Document::parse(&xml)
        .with_context(|| format!("failed to parse Ableton XML in {}", path.display()))?;
    let name = document
        .descendants()
        .find(|node| node.has_tag_name("MidiClip"))
        .and_then(|clip| child_value_string(clip, "Name"))
        .or_else(|| {
            document
                .descendants()
                .filter(|node| node.has_tag_name("UserName"))
                .filter_map(|node| node.attribute("Value"))
                .find(|value| !value.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    let mut devices = document
        .descendants()
        .filter(|node| {
            node.is_element()
                && node
                    .parent()
                    .is_some_and(|parent| parent.has_tag_name("Device"))
        })
        .map(|node| node.tag_name().name().to_owned())
        .collect::<Vec<_>>();
    if kind == "adv"
        && let Some(device) = document.root_element().children().find(Node::is_element)
    {
        devices.push(device.tag_name().name().to_owned());
    }
    devices.sort();
    devices.dedup();
    let all_references = document
        .descendants()
        .filter(|node| node.has_tag_name("RelativePath"))
        .filter_map(|node| node.attribute("Value"))
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let sample_files = all_references
        .iter()
        .filter(|reference| reference.starts_with("Samples/"))
        .count();
    let mut references = all_references
        .into_iter()
        .filter(|reference| !reference.starts_with("Samples/"))
        .collect::<Vec<_>>();
    references.sort();
    references.dedup();
    let midi_notes = document
        .descendants()
        .filter(|node| node.has_tag_name("MidiNoteEvent"))
        .count();
    let has_sample_device = devices
        .iter()
        .any(|device| matches!(device.as_str(), "OriginalSimpler" | "MultiSampler"));
    let has_unrendered_device = devices.iter().any(|device| {
        !matches!(
            device.as_str(),
            "InstrumentGroupDevice"
                | "DrumGroupDevice"
                | "OriginalSimpler"
                | "MultiSampler"
                | "AudioBranchMixerDevice"
                | "MidiBranchMixerDevice"
        )
    });
    let renderability =
        if devices.iter().any(|device| device == "DrumGroupDevice") && has_sample_device {
            if has_unrendered_device {
                "sampleDrumRackPartialEffects"
            } else {
                "sampleDrumRack"
            }
        } else if has_sample_device {
            if has_unrendered_device {
                "sampleInstrumentPartialEffects"
            } else {
                "sampleInstrument"
            }
        } else if midi_notes > 0
            && references
                .iter()
                .any(|reference| reference.contains("Drum Racks/") && reference.ends_with(".adg"))
        {
            "drumClip"
        } else if midi_notes > 0
            && references.iter().any(|reference| {
                reference.contains("Instrument Racks/") && reference.ends_with(".adg")
            })
        {
            "midiClip"
        } else if kind == "agr" {
            "groove"
        } else {
            "inspectOnly"
        }
        .to_owned();
    Ok(AssetSummary {
        path: path.to_owned(),
        relative_path: path.strip_prefix(core_library).unwrap_or(path).to_owned(),
        kind,
        name,
        devices,
        references,
        sample_files,
        midi_notes,
        renderability,
    })
}

fn parse_device_graph(path: &Path, xml: &str) -> Result<AbletonDeviceGraphReport> {
    let document = Document::parse(xml)
        .with_context(|| format!("failed to parse Ableton XML in {}", path.display()))?;
    let ableton = document.root_element();
    let mut roots = Vec::new();
    for child in ableton.children().filter(Node::is_element) {
        match child.tag_name().name() {
            "GroupDevicePreset" => roots.push(parse_group_device_preset(child)?),
            "AbletonDevicePreset" => roots.extend(parse_device_preset(child)?),
            _ if direct_child(child, "On").is_some() => {
                roots.push(parse_graph_device(child, None)?);
            }
            _ => {}
        }
    }
    ensure!(
        !roots.is_empty(),
        "Ableton asset contains no inspectable device graph: {}",
        path.display()
    );
    let mut counts = AbletonGraphCounts::default();
    for root in &roots {
        count_graph_device(root, &mut counts);
    }
    let name = roots
        .first()
        .map(|device| device.name.clone())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    Ok(AbletonDeviceGraphReport {
        source: path.to_owned(),
        name,
        format: path
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("xml")
            .to_ascii_lowercase(),
        roots,
        devices: counts.devices,
        racks: counts.racks,
        chains: counts.chains,
        parameters: counts.parameters,
        macro_mappings: counts.macro_mappings,
        custom_dsp: false,
    })
}

fn audit_device_graphs(core_library: &Path) -> Result<()> {
    ensure!(
        core_library.is_dir(),
        "Ableton Core Library does not exist: {}",
        core_library.display()
    );
    let mut assets = WalkDir::new(core_library)
        .follow_links(false)
        .into_iter()
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| matches!(extension, "adv" | "adg"))
        })
        .collect::<Vec<_>>();
    assets.sort();
    let asset_count = assets.len();
    let mut parsed_assets = 0;
    let mut failed_assets = Vec::new();
    let mut counts = AbletonGraphCounts::default();
    let mut families = BTreeMap::<String, usize>::new();
    for asset in assets {
        let result = read_ableton_xml(&asset).and_then(|xml| parse_device_graph(&asset, &xml));
        match result {
            Ok(report) => {
                parsed_assets += 1;
                counts.devices += report.devices;
                counts.racks += report.racks;
                counts.chains += report.chains;
                counts.parameters += report.parameters;
                counts.macro_mappings += report.macro_mappings;
                for root in &report.roots {
                    collect_graph_families(root, &mut families);
                }
            }
            Err(error) => failed_assets.push(AbletonGraphAuditFailure {
                asset,
                error: format!("{error:#}"),
            }),
        }
    }
    let device_families =
        families
            .into_iter()
            .map(|(family, instances)| {
                let (
                    mechanism,
                    engine_status,
                    preset_status,
                    headless_status,
                    implementation,
                    blocker,
                ) = device_capability(&family);
                AbletonGraphFamilyCount {
                    family,
                    instances,
                    mechanism: mechanism.to_owned(),
                    engine_status: engine_status.to_owned(),
                    preset_status: preset_status.to_owned(),
                    headless_status: headless_status.to_owned(),
                    implementation: implementation.map(str::to_owned),
                    blocker: blocker.map(str::to_owned),
                }
            })
            .collect::<Vec<_>>();
    let complete_families = device_families
        .iter()
        .filter(|family| family.headless_status == "complete")
        .count();
    let partial_families = device_families
        .iter()
        .filter(|family| family.headless_status == "partial")
        .count();
    let blocked_families = device_families
        .iter()
        .filter(|family| family.headless_status == "blocked")
        .count();
    println!(
        "{}",
        serde_json::to_string_pretty(&AbletonDeviceGraphAuditReport {
            core_library: core_library.to_owned(),
            assets: asset_count,
            parsed_assets,
            failed_assets,
            devices: counts.devices,
            racks: counts.racks,
            chains: counts.chains,
            parameters: counts.parameters,
            macro_mappings: counts.macro_mappings,
            complete_families,
            partial_families,
            blocked_families,
            device_families,
            custom_dsp: false,
        })?
    );
    Ok(())
}

fn audit_presets(core_library: &Path, engine: &Path, jobs: usize, all: bool) -> Result<()> {
    ensure!(jobs > 0, "--jobs must be greater than zero");
    ensure!(
        std::env::consts::ARCH == "x86_64",
        "Ableton preset audit requires an x86_64 djbooth-rs host"
    );
    ensure!(
        core_library.is_dir(),
        "Ableton Core Library does not exist: {}",
        core_library.display()
    );
    let engine = fs::canonicalize(engine)
        .with_context(|| format!("Ableton Live Engine does not exist: {}", engine.display()))?;
    let executable = std::env::current_exe().context("cannot resolve the djbooth-rs executable")?;
    let mut presets = WalkDir::new(core_library)
        .follow_links(false)
        .into_iter()
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("adv"))
        .collect::<Vec<_>>();
    presets.sort();
    let installed_presets = presets.len();
    let mut by_family = BTreeMap::<String, Vec<PathBuf>>::new();
    for preset in presets {
        let xml = read_ableton_xml(&preset)?;
        let document = Document::parse(&xml)
            .with_context(|| format!("failed to parse Ableton preset {}", preset.display()))?;
        let family = document
            .root_element()
            .children()
            .find(Node::is_element)
            .with_context(|| format!("Ableton preset has no device: {}", preset.display()))?
            .tag_name()
            .name()
            .to_owned();
        by_family.entry(family).or_default().push(preset);
    }
    let mut eligible_presets = 0;
    let mut skipped_families = Vec::new();
    let mut audit_jobs = Vec::new();
    let drum_sample = WalkDir::new(core_library)
        .follow_links(false)
        .into_iter()
        .filter_map(std::result::Result::ok)
        .find(|entry| entry.file_type().is_file() && entry.file_name() == "Kick 808 Hard.wav")
        .map(|entry| entry.into_path());
    for (family, presets) in by_family {
        let (mechanism, engine_status, preset_status, _, implementation, blocker) =
            device_capability(&family);
        let processor = (mechanism == "liveEngineBundle"
            && engine_status == "nativeAudioRenderProven"
            && matches!(
                preset_status,
                "representativeAdvRenderProven"
                    | "exhaustiveAdvRenderProven"
                    | "installedAdvRenderPartial"
            ))
        .then_some(implementation)
        .flatten()
        .filter(|processor| !processor.contains(" + "));
        let Some(processor) = processor else {
            skipped_families.push(AbletonPresetAuditSkippedFamily {
                family,
                presets: presets.len(),
                reason: blocker
                    .unwrap_or("family uses a different native Ableton runtime")
                    .to_owned(),
            });
            continue;
        };
        eligible_presets += presets.len();
        let selected: Box<dyn Iterator<Item = PathBuf>> = if all {
            Box::new(presets.into_iter())
        } else {
            Box::new(presets.into_iter().take(1))
        };
        for asset in selected {
            audit_jobs.push(AbletonPresetAuditJob {
                index: audit_jobs.len(),
                asset,
                family: family.clone(),
                processor: processor.to_owned(),
                midi: matches!(
                    family.as_str(),
                    "Drift" | "Hybrid" | "InstrumentMeld" | "InstrumentVector" | "DrumCell"
                ),
                sample: (family == "DrumCell")
                    .then(|| drum_sample.clone())
                    .flatten(),
            });
        }
    }
    let tested_presets = audit_jobs.len();
    let queue = std::sync::Arc::new(std::sync::Mutex::new(
        audit_jobs
            .into_iter()
            .collect::<std::collections::VecDeque<_>>(),
    ));
    let successes = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let failures = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let directory = tempfile::tempdir()?;
    std::thread::scope(|scope| {
        for _ in 0..jobs.min(tested_presets.max(1)) {
            let queue = std::sync::Arc::clone(&queue);
            let successes = std::sync::Arc::clone(&successes);
            let failures = std::sync::Arc::clone(&failures);
            let directory = directory.path();
            let executable = &executable;
            let engine = &engine;
            scope.spawn(move || loop {
                let job = queue.lock().expect("preset audit queue poisoned").pop_front();
                let Some(job) = job else {
                    break;
                };
                let output_path = directory.join(format!("{}.wav", job.index));
                let expected_frames = if job.midi { 8192 } else { 44_100 };
                let mut command = Command::new(executable);
                command
                    .args(["ableton", "probe-live-engine", "--bootstrap", "--engine"])
                    .arg(engine)
                    .args(["--processor", &job.processor, "--construct", "--preset"])
                    .arg(&job.asset)
                    .arg("--output")
                    .arg(&output_path)
                    .arg("--render-frames")
                    .arg(expected_frames.to_string());
                if job.midi {
                    command.args(["--note", "48", "--gate-seconds", "0.05"]);
                }
                if let Some(sample) = &job.sample {
                    command.arg("--sample").arg(sample);
                }
                let result = command.output();
                match result {
                    Ok(output) if output.status.success() => {
                        let report = serde_json::from_slice::<serde_json::Value>(&output.stdout);
                        match report {
                            Ok(report) => {
                                let parameters_applied = report["presetParametersApplied"]
                                    .as_u64()
                                    .and_then(|value| usize::try_from(value).ok());
                                let peak = report["processorRenderPeak"]
                                    .as_f64()
                                    .map(|value| value as f32);
                                let delta = report["processorRenderDelta"]
                                    .as_f64()
                                    .map(|value| value as f32);
                                if let (Some(parameters_applied), Some(peak), Some(delta)) =
                                    (parameters_applied, peak, delta)
                                    && parameters_applied > 0
                                    && report["processorRenderFrames"].as_u64()
                                        == Some(expected_frames)
                                    && peak <= 8.0
                                {
                                    successes.lock().expect("preset successes poisoned").push(
                                        AbletonPresetAuditSuccess {
                                            asset: job.asset,
                                            family: job.family,
                                            processor: job.processor,
                                            parameters_applied,
                                            peak,
                                            delta,
                                            audible: peak > 1.0e-7,
                                        },
                                    );
                                    continue;
                                }
                                failures.lock().expect("preset failures poisoned").push(
                                    AbletonPresetAuditFailure {
                                        asset: job.asset,
                                        family: job.family,
                                        processor: job.processor,
                                        exit_code: output.status.code(),
                                        error: format!(
                                            "native render failed validation: parameters={parameters_applied:?}, frames={}, peak={peak:?}",
                                            report["processorRenderFrames"]
                                        ),
                                    },
                                );
                            }
                            Err(error) => failures.lock().expect("preset failures poisoned").push(
                                AbletonPresetAuditFailure {
                                    asset: job.asset,
                                    family: job.family,
                                    processor: job.processor,
                                    exit_code: output.status.code(),
                                    error: format!("invalid native render report: {error}"),
                                },
                            ),
                        }
                    }
                    Ok(output) => {
                        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
                        failures.lock().expect("preset failures poisoned").push(
                            AbletonPresetAuditFailure {
                                asset: job.asset,
                                family: job.family,
                                processor: job.processor,
                                exit_code: output.status.code(),
                                error: if stderr.is_empty() {
                                    output
                                        .status
                                        .signal()
                                        .map(|signal| format!("terminated by signal {signal}"))
                                        .unwrap_or_else(|| "native render failed".to_owned())
                                } else {
                                    output
                                        .status
                                        .signal()
                                        .map(|signal| {
                                            format!("{stderr}\nterminated by signal {signal}")
                                        })
                                        .unwrap_or(stderr)
                                },
                            },
                        );
                    }
                    Err(error) => failures.lock().expect("preset failures poisoned").push(
                        AbletonPresetAuditFailure {
                            asset: job.asset,
                            family: job.family,
                            processor: job.processor,
                            exit_code: None,
                            error: error.to_string(),
                        },
                    ),
                }
            });
        }
    });
    let successes = std::sync::Arc::try_unwrap(successes)
        .map_err(|_| anyhow::anyhow!("preset audit workers retained successes"))?
        .into_inner()
        .map_err(|_| anyhow::anyhow!("preset audit successes were poisoned"))?;
    let mut failed_presets = std::sync::Arc::try_unwrap(failures)
        .map_err(|_| anyhow::anyhow!("preset audit workers retained failures"))?
        .into_inner()
        .map_err(|_| anyhow::anyhow!("preset audit failures were poisoned"))?;
    failed_presets.sort_by(|left, right| left.asset.cmp(&right.asset));
    let mut family_results = BTreeMap::<(String, String), AbletonPresetAuditFamilyResult>::new();
    for success in &successes {
        let result = family_results
            .entry((success.family.clone(), success.processor.clone()))
            .or_insert_with(|| AbletonPresetAuditFamilyResult {
                family: success.family.clone(),
                processor: success.processor.clone(),
                tested: 0,
                rendered: 0,
                audible: 0,
                silent: 0,
                failed: 0,
                minimum_parameters_applied: usize::MAX,
                maximum_parameters_applied: 0,
                maximum_peak: 0.0,
                maximum_delta: 0.0,
            });
        result.tested += 1;
        result.rendered += 1;
        if success.audible {
            result.audible += 1;
        } else {
            result.silent += 1;
        }
        result.minimum_parameters_applied = result
            .minimum_parameters_applied
            .min(success.parameters_applied);
        result.maximum_parameters_applied = result
            .maximum_parameters_applied
            .max(success.parameters_applied);
        result.maximum_peak = result.maximum_peak.max(success.peak);
        result.maximum_delta = result.maximum_delta.max(success.delta);
    }
    for failure in &failed_presets {
        let result = family_results
            .entry((failure.family.clone(), failure.processor.clone()))
            .or_insert_with(|| AbletonPresetAuditFamilyResult {
                family: failure.family.clone(),
                processor: failure.processor.clone(),
                tested: 0,
                rendered: 0,
                audible: 0,
                silent: 0,
                failed: 0,
                minimum_parameters_applied: 0,
                maximum_parameters_applied: 0,
                maximum_peak: 0.0,
                maximum_delta: 0.0,
            });
        result.tested += 1;
        result.failed += 1;
    }
    let family_results = family_results.into_values().collect();
    let audible_presets = successes.iter().filter(|success| success.audible).count();
    let mut silent_presets = successes
        .iter()
        .filter(|success| !success.audible)
        .map(|success| AbletonPresetAuditSilent {
            asset: success.asset.clone(),
            family: success.family.clone(),
            processor: success.processor.clone(),
            peak: success.peak,
        })
        .collect::<Vec<_>>();
    silent_presets.sort_by(|left, right| left.asset.cmp(&right.asset));
    println!(
        "{}",
        serde_json::to_string_pretty(&AbletonPresetAuditReport {
            core_library: core_library.to_owned(),
            engine,
            installed_presets,
            eligible_presets,
            tested_presets,
            rendered_presets: successes.len(),
            audible_presets,
            silent_presets,
            failed_presets,
            skipped_families,
            family_results,
            exhaustive: all,
            jobs,
            custom_dsp: false,
        })?
    );
    Ok(())
}

fn collect_graph_families(device: &AbletonGraphDevice, families: &mut BTreeMap<String, usize>) {
    *families.entry(device.family.clone()).or_default() += 1;
    let Some(rack) = &device.rack else {
        return;
    };
    for chain in rack.chains.iter().chain(&rack.return_chains) {
        for child in &chain.devices {
            collect_graph_families(child, families);
        }
        if let Some(mixer) = &chain.mixer {
            collect_graph_families(mixer, families);
        }
    }
}

#[derive(Default)]
struct AbletonGraphCounts {
    devices: usize,
    racks: usize,
    chains: usize,
    parameters: usize,
    macro_mappings: usize,
}

fn count_graph_device(device: &AbletonGraphDevice, counts: &mut AbletonGraphCounts) {
    counts.devices += 1;
    counts.parameters += device.parameters.len();
    counts.macro_mappings += device
        .parameters
        .iter()
        .filter(|parameter| parameter.midi_mapping.is_some())
        .count();
    let Some(rack) = &device.rack else {
        return;
    };
    counts.racks += 1;
    counts.chains += rack.chains.len() + rack.return_chains.len();
    for chain in rack.chains.iter().chain(&rack.return_chains) {
        for child in &chain.devices {
            count_graph_device(child, counts);
        }
        if let Some(mixer) = &chain.mixer {
            count_graph_device(mixer, counts);
        }
    }
}

fn parse_group_device_preset(preset: Node<'_, '_>) -> Result<AbletonGraphDevice> {
    let device_wrapper = direct_child(preset, "Device").context("group preset has no Device")?;
    let device = device_wrapper
        .children()
        .find(Node::is_element)
        .context("group preset Device is empty")?;
    let rack = parse_rack_graph(preset, device)?;
    parse_graph_device(device, Some(rack))
}

fn parse_device_preset(preset: Node<'_, '_>) -> Result<Vec<AbletonGraphDevice>> {
    if preset.has_tag_name("GroupDevicePreset") {
        return Ok(vec![parse_group_device_preset(preset)?]);
    }
    let Some(device_wrapper) = direct_child(preset, "Device") else {
        return Ok(Vec::new());
    };
    let Some(device) = device_wrapper.children().find(Node::is_element) else {
        return Ok(Vec::new());
    };
    let rack = is_group_device(device.tag_name().name())
        .then(|| parse_rack_graph(preset, device))
        .transpose()?;
    Ok(vec![parse_graph_device(device, rack)?])
}

fn is_group_device(name: &str) -> bool {
    matches!(
        name,
        "AudioEffectGroupDevice"
            | "InstrumentGroupDevice"
            | "DrumGroupDevice"
            | "MidiEffectGroupDevice"
    )
}

fn parse_graph_device(
    device: Node<'_, '_>,
    rack: Option<AbletonRackGraph>,
) -> Result<AbletonGraphDevice> {
    let family = device.tag_name().name().to_owned();
    let name = child_value_string(device, "UserName")
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| family.clone());
    let enabled = direct_child(device, "On")
        .and_then(|control| direct_child(control, "Manual"))
        .and_then(|manual| manual.attribute("Value"))
        .and_then(parse_ableton_bool);
    let mut parameters = Vec::new();
    collect_graph_parameters(device, "", &mut parameters)?;
    Ok(AbletonGraphDevice {
        id: device.attribute("Id").map(str::to_owned),
        source_offset: device.range().start,
        family,
        name,
        enabled,
        parameters,
        rack: rack.map(Box::new),
    })
}

fn collect_graph_parameters(
    node: Node<'_, '_>,
    prefix: &str,
    parameters: &mut Vec<AbletonGraphParameter>,
) -> Result<()> {
    for child in node.children().filter(Node::is_element) {
        let leaf = child.tag_name().name();
        if matches!(
            leaf,
            "Device" | "DevicePresets" | "BranchPresets" | "ReturnBranchPresets"
        ) || leaf.starts_with("MacroControls.")
            || leaf == "ChainSelector"
        {
            continue;
        }
        let name = if prefix.is_empty() {
            leaf.to_owned()
        } else {
            format!("{prefix}/{leaf}")
        };
        if direct_child(child, "Manual").is_some() {
            parameters.push(parse_graph_parameter(child, name)?);
        } else if !matches!(
            leaf,
            "LastPresetRef"
                | "PresetRef"
                | "FileRef"
                | "SourceContext"
                | "ParametersListWrapper"
                | "Pointee"
                | "LockedScripts"
                | "ViewData"
        ) {
            collect_graph_parameters(child, &name, parameters)?;
        }
    }
    Ok(())
}

fn parse_graph_parameter(control: Node<'_, '_>, name: String) -> Result<AbletonGraphParameter> {
    let manual = direct_child(control, "Manual")
        .with_context(|| format!("parameter {name} has no Manual value"))?;
    let value = manual
        .attribute("Value")
        .with_context(|| format!("parameter {name} Manual has no Value"))?
        .to_owned();
    let range = direct_child(control, "MidiControllerRange");
    Ok(AbletonGraphParameter {
        name,
        numeric_value: parse_ableton_number(&value),
        value,
        minimum: range.and_then(|range| optional_child_number(range, "Min")),
        maximum: range.and_then(|range| optional_child_number(range, "Max")),
        automation_target_id: direct_child(control, "AutomationTarget")
            .and_then(|target| target.attribute("Id"))
            .map(str::to_owned),
        modulation_target_id: direct_child(control, "ModulationTarget")
            .and_then(|target| target.attribute("Id"))
            .map(str::to_owned),
        midi_mapping: direct_child(control, "KeyMidi").map(parse_midi_mapping),
    })
}

fn parse_midi_mapping(mapping: Node<'_, '_>) -> AbletonMidiMapping {
    AbletonMidiMapping {
        persistent_key: direct_child(mapping, "PersistentKeyString")
            .and_then(|node| node.attribute("Value"))
            .unwrap_or_default()
            .to_owned(),
        is_note: optional_child_bool(mapping, "IsNote").unwrap_or(false),
        channel: optional_child_i32(mapping, "Channel").unwrap_or(0),
        note_or_controller: optional_child_i32(mapping, "NoteOrController").unwrap_or(0),
        lower_note: optional_child_i32(mapping, "LowerRangeNote").unwrap_or(-1),
        upper_note: optional_child_i32(mapping, "UpperRangeNote").unwrap_or(-1),
        map_mode: optional_child_i32(mapping, "ControllerMapMode").unwrap_or(0),
    }
}

fn parse_rack_graph(preset: Node<'_, '_>, group_device: Node<'_, '_>) -> Result<AbletonRackGraph> {
    let visible_macros = optional_child_i32(group_device, "NumVisibleMacroControls")
        .unwrap_or(0)
        .max(0) as usize;
    let mut macros = Vec::new();
    for index in 0..16 {
        let control_name = format!("MacroControls.{index}");
        let Some(control) = direct_child(group_device, &control_name) else {
            continue;
        };
        let value = direct_child(control, "Manual")
            .and_then(|manual| manual.attribute("Value"))
            .unwrap_or("0")
            .to_owned();
        let range = direct_child(control, "MidiControllerRange");
        macros.push(AbletonRackMacro {
            index,
            name: indexed_child_value(group_device, "MacroDisplayNames", index)
                .unwrap_or_else(|| format!("Macro {}", index + 1)),
            numeric_value: parse_ableton_number(&value),
            value,
            default_value: indexed_child_number(group_device, "MacroDefaults", index),
            minimum: range.and_then(|range| optional_child_number(range, "Min")),
            maximum: range.and_then(|range| optional_child_number(range, "Max")),
            color: indexed_child_i32(group_device, "MacroColor", index),
            annotation: indexed_child_value(group_device, "MacroAnnotations", index)
                .unwrap_or_default(),
            automation_target_id: direct_child(control, "AutomationTarget")
                .and_then(|target| target.attribute("Id"))
                .map(str::to_owned),
            modulation_target_id: direct_child(control, "ModulationTarget")
                .and_then(|target| target.attribute("Id"))
                .map(str::to_owned),
            excluded_from_randomization: indexed_child_bool(
                group_device,
                "ExcludeMacroFromRandomization",
                index,
            )
            .unwrap_or(false),
            excluded_from_snapshots: indexed_child_bool(
                group_device,
                "ExcludeMacroFromSnapshots",
                index,
            )
            .unwrap_or(false),
        });
    }
    let chain_selector = direct_child(group_device, "ChainSelector")
        .map(|control| parse_graph_parameter(control, "ChainSelector".to_owned()))
        .transpose()?;
    let chains = direct_child(preset, "BranchPresets")
        .map(parse_rack_chains)
        .transpose()?
        .unwrap_or_default();
    let return_chains = direct_child(preset, "ReturnBranchPresets")
        .map(parse_rack_chains)
        .transpose()?
        .unwrap_or_default();
    Ok(AbletonRackGraph {
        kind: group_device.tag_name().name().to_owned(),
        visible_macros,
        chain_selector,
        macros,
        chains,
        return_chains,
    })
}

fn parse_rack_chains(container: Node<'_, '_>) -> Result<Vec<AbletonRackChain>> {
    container
        .children()
        .filter(Node::is_element)
        .map(parse_rack_chain)
        .collect()
}

fn parse_rack_chain(branch: Node<'_, '_>) -> Result<AbletonRackChain> {
    let devices = direct_child(branch, "DevicePresets")
        .map(parse_preset_list)
        .transpose()?
        .unwrap_or_default();
    let mixer = direct_child(branch, "MixerPreset")
        .map(parse_preset_list)
        .transpose()?
        .unwrap_or_default()
        .into_iter()
        .next();
    let selector = direct_child(branch, "BranchSelectorRange")
        .map(|range| -> Result<AbletonChainSelectorRange> {
            Ok(AbletonChainSelectorRange {
                minimum: child_value(range, "Min")?,
                maximum: child_value(range, "Max")?,
                crossfade_minimum: child_value(range, "CrossfadeMin")?,
                crossfade_maximum: child_value(range, "CrossfadeMax")?,
            })
        })
        .transpose()?;
    Ok(AbletonRackChain {
        id: branch.attribute("Id").map(str::to_owned),
        name: child_value_string(branch, "Name").unwrap_or_default(),
        soloed: optional_child_bool(branch, "IsSoloed").unwrap_or(false),
        selector,
        receiving_note: optional_child_i32(branch, "ReceivingNote"),
        sending_note: optional_child_i32(branch, "SendingNote"),
        choke_group: optional_child_i32(branch, "ChokeGroup"),
        devices,
        mixer,
    })
}

fn parse_preset_list(container: Node<'_, '_>) -> Result<Vec<AbletonGraphDevice>> {
    let mut devices = Vec::new();
    for preset in container.children().filter(Node::is_element) {
        match preset.tag_name().name() {
            "GroupDevicePreset" | "AbletonDevicePreset" => {
                devices.extend(parse_device_preset(preset)?);
            }
            _ => {
                if let Some(wrapper) = direct_child(preset, "Device")
                    && let Some(device) = wrapper.children().find(Node::is_element)
                {
                    devices.push(parse_graph_device(device, None)?);
                }
            }
        }
    }
    Ok(devices)
}

fn parse_ableton_number(value: &str) -> Option<f64> {
    match value {
        "true" => Some(1.0),
        "false" => Some(0.0),
        value => value.parse::<f64>().ok().filter(|value| value.is_finite()),
    }
}

fn parse_ableton_bool(value: &str) -> Option<bool> {
    match value {
        "true" | "1" => Some(true),
        "false" | "0" => Some(false),
        _ => None,
    }
}

fn optional_child_number(node: Node<'_, '_>, name: &str) -> Option<f64> {
    direct_child(node, name)
        .and_then(|child| child.attribute("Value"))
        .and_then(parse_ableton_number)
}

fn optional_child_i32(node: Node<'_, '_>, name: &str) -> Option<i32> {
    direct_child(node, name)
        .and_then(|child| child.attribute("Value"))
        .and_then(|value| value.parse().ok())
}

fn optional_child_bool(node: Node<'_, '_>, name: &str) -> Option<bool> {
    direct_child(node, name)
        .and_then(|child| child.attribute("Value"))
        .and_then(parse_ableton_bool)
}

fn indexed_child_value(node: Node<'_, '_>, prefix: &str, index: usize) -> Option<String> {
    child_value_string(node, &format!("{prefix}.{index}"))
}

fn indexed_child_number(node: Node<'_, '_>, prefix: &str, index: usize) -> Option<f64> {
    indexed_child_value(node, prefix, index).and_then(|value| parse_ableton_number(&value))
}

fn indexed_child_i32(node: Node<'_, '_>, prefix: &str, index: usize) -> Option<i32> {
    indexed_child_value(node, prefix, index).and_then(|value| value.parse().ok())
}

fn indexed_child_bool(node: Node<'_, '_>, prefix: &str, index: usize) -> Option<bool> {
    indexed_child_value(node, prefix, index).and_then(|value| parse_ableton_bool(&value))
}

fn parse_rack(path: &Path, xml: &str, core_library: Option<&Path>) -> Result<RackReport> {
    let document = Document::parse(xml)
        .with_context(|| format!("failed to parse Ableton XML in {}", path.display()))?;
    let core_library = match core_library {
        Some(root) => root.to_owned(),
        None => discover_core_library(path)?,
    };
    ensure!(
        core_library.is_dir(),
        "Ableton Core Library does not exist: {}",
        core_library.display()
    );
    let rack = document
        .descendants()
        .find(|node| node.has_tag_name("DrumGroupDevice"))
        .context("Ableton asset contains no DrumGroupDevice")?;
    let name = first_nonempty_value(rack, "UserName").unwrap_or_else(|| {
        path.file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    });
    let mut voices = Vec::new();
    // Ableton stores DrumBranchPreset siblings after DrumGroupDevice rather than
    // nesting them inside the device node, both in ADG files and embedded ALC racks.
    for (index, branch) in document
        .descendants()
        .filter(|node| node.has_tag_name("DrumBranchPreset"))
        .enumerate()
    {
        let midi_note = DRUM_RACK_BASE_NOTE
            .checked_add(u8::try_from(index)?)
            .context("drum rack has more than 92 pads")?;
        let receiving_note = descendant_value(branch, "ReceivingNote")?;
        let sending_note = descendant_value(branch, "SendingNote")?;
        let choke_group = descendant_value(branch, "ChokeGroup")?;
        let sample_selector = descendant_manual_value(branch, "SampleSelector")?;
        let transpose_key = descendant_manual_value::<i16>(branch, "TransposeKey")?;
        let played_key = i16::from(sending_note) + transpose_key;
        ensure!(
            (0..=127).contains(&played_key),
            "rack voice {midi_note} transposes outside MIDI range"
        );
        let played_key = played_key as u8;
        let gain_db = descendant_path_value::<f32>(
            branch,
            &["OriginalSimpler", "VolumeAndPan", "Volume", "Manual"],
        )
        .unwrap_or(0.0);
        let volume_velocity_scale = descendant_path_value::<f32>(
            branch,
            &[
                "OriginalSimpler",
                "VolumeAndPan",
                "VolumeVelScale",
                "Manual",
            ],
        )
        .unwrap_or(1.0);
        let one_shot_fade_out_seconds = descendant_path_value::<f64>(
            branch,
            &[
                "OriginalSimpler",
                "VolumeAndPan",
                "OneShotEnvelope",
                "FadeOutTime",
                "Manual",
            ],
        )
        .unwrap_or(0.0)
            / 1000.0;
        let name = branch
            .descendants()
            .filter(|node| node.has_tag_name("UserName"))
            .filter_map(|node| node.attribute("Value"))
            .find(|value| !value.is_empty() && *value != "AudioBranchMixerDevice")
            .unwrap_or("Drum Voice")
            .to_owned();
        let samples = branch
            .descendants()
            .filter(|node| node.has_tag_name("MultiSamplePart"))
            .map(|zone| parse_sample_zone(zone, &core_library))
            .collect::<Result<Vec<_>>>()?;
        ensure!(
            !samples.is_empty(),
            "rack voice '{name}' has no sample zones"
        );
        let selected_samples = samples
            .iter()
            .filter(|zone| {
                (zone.key_min..=zone.key_max).contains(&played_key)
                    && (zone.selector_min..=zone.selector_max).contains(&sample_selector)
                    && (zone.velocity_min..=zone.velocity_max).contains(&100)
            })
            .map(|zone| zone.resolved_path.clone())
            .collect::<Vec<_>>();
        ensure!(
            !selected_samples.is_empty(),
            "rack voice '{name}' has no zone for key {played_key}, selector {sample_selector}"
        );
        for sample in &selected_samples {
            ensure!(
                sample.is_file(),
                "rack sample does not exist: {}",
                sample.display()
            );
        }
        voices.push(DrumVoice {
            midi_note,
            name,
            receiving_note,
            sending_note,
            choke_group,
            sample_selector,
            gain_db,
            volume_velocity_scale,
            one_shot_fade_out_seconds,
            samples,
            selected_samples,
        });
    }
    ensure!(!voices.is_empty(), "Ableton drum rack has no pad branches");
    Ok(RackReport {
        source: path.to_owned(),
        core_library,
        name,
        voices,
    })
}

fn parse_sample_zone(zone: Node<'_, '_>, core_library: &Path) -> Result<SampleZone> {
    let relative = zone
        .descendants()
        .find(|node| {
            node.has_tag_name("RelativePath")
                && node
                    .attribute("Value")
                    .is_some_and(|value| value.starts_with("Samples/"))
        })
        .and_then(|node| node.attribute("Value"))
        .context("sample zone has no Core Library relative path")?;
    let loop_mode = descendant_path_value::<u8>(zone, &["SustainLoop", "Mode"]).unwrap_or(0);
    let sustain_loop = if loop_mode == 0 {
        None
    } else {
        Some(SampleLoop {
            start_frame: descendant_path_value(zone, &["SustainLoop", "Start"])?,
            end_frame: descendant_path_value(zone, &["SustainLoop", "End"])?,
            crossfade_frames: descendant_path_value(zone, &["SustainLoop", "Crossfade"])
                .unwrap_or(0),
        })
    };
    let source_sample_rate = zone
        .descendants()
        .find(|node| node.has_tag_name("DefaultSampleRate"))
        .map(parse_node_value)
        .transpose()?
        .unwrap_or(DEFAULT_SAMPLE_RATE);
    Ok(SampleZone {
        name: child_value_string(zone, "Name").unwrap_or_else(|| "Unnamed Sample".to_owned()),
        relative_path: PathBuf::from(relative),
        resolved_path: core_library.join(relative),
        key_min: descendant_path_value(zone, &["KeyRange", "Min"])?,
        key_max: descendant_path_value(zone, &["KeyRange", "Max"])?,
        velocity_min: descendant_path_value(zone, &["VelocityRange", "Min"])?,
        velocity_max: descendant_path_value(zone, &["VelocityRange", "Max"])?,
        selector_min: descendant_path_value(zone, &["SelectorRange", "Min"])?,
        selector_max: descendant_path_value(zone, &["SelectorRange", "Max"])?,
        root_key: child_value(zone, "RootKey")?,
        detune_cents: child_value(zone, "Detune")?,
        volume: child_value(zone, "Volume")?,
        panorama: child_value(zone, "Panorama").unwrap_or(0.0),
        sample_start_frame: child_value(zone, "SampleStart").unwrap_or(0),
        sample_end_frame: child_value(zone, "SampleEnd").ok(),
        source_sample_rate,
        sustain_loop,
    })
}

fn parse_instrument(
    path: &Path,
    xml: &str,
    core_library: Option<&Path>,
) -> Result<InstrumentReport> {
    let document = Document::parse(xml)
        .with_context(|| format!("failed to parse Ableton XML in {}", path.display()))?;
    let core_library = match core_library {
        Some(root) => root.to_owned(),
        None => discover_core_library(path)?,
    };
    ensure!(
        core_library.is_dir(),
        "Ableton Core Library does not exist: {}",
        core_library.display()
    );
    let rack = document
        .descendants()
        .find(|node| {
            node.has_tag_name("InstrumentGroupDevice")
                || node.has_tag_name("OriginalSimpler")
                || node.has_tag_name("MultiSampler")
        })
        .context("Ableton asset contains no sample instrument")?;
    let name = first_nonempty_value(rack, "UserName").unwrap_or_else(|| {
        path.file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    });
    let mut layers = Vec::new();
    for device in document
        .descendants()
        .filter(|node| node.has_tag_name("OriginalSimpler") || node.has_tag_name("MultiSampler"))
    {
        let enabled = descendant_path_value::<bool>(device, &["On", "Manual"]).unwrap_or(true);
        if !enabled {
            continue;
        }
        let zones = device
            .descendants()
            .filter(|node| node.has_tag_name("MultiSamplePart"))
            .map(|zone| parse_sample_zone(zone, &core_library))
            .collect::<Result<Vec<_>>>()?;
        if zones.is_empty() {
            continue;
        }
        for zone in &zones {
            ensure!(
                zone.resolved_path.is_file(),
                "instrument sample does not exist: {}",
                zone.resolved_path.display()
            );
        }
        let envelope = device
            .descendants()
            .find(|node| node.has_tag_name("VolumeAndPan"))
            .and_then(|volume_and_pan| direct_child(volume_and_pan, "Envelope"));
        let envelope_value = |name: &str, fallback: f64| {
            envelope
                .and_then(|envelope| direct_child(envelope, name))
                .and_then(|control| direct_child(control, "Manual"))
                .and_then(|manual| manual.attribute("Value"))
                .and_then(|value| value.parse::<f64>().ok())
                .unwrap_or(fallback)
        };
        layers.push(SamplerLayer {
            name: first_nonempty_value(device, "UserName")
                .unwrap_or_else(|| device.tag_name().name().to_owned()),
            device: device.tag_name().name().to_owned(),
            gain_db: descendant_path_value(device, &["VolumeAndPan", "Volume", "Manual"])
                .unwrap_or(0.0),
            pan: descendant_path_value(device, &["VolumeAndPan", "Panorama", "Manual"])
                .unwrap_or(0.0),
            velocity_amount: descendant_path_value(
                device,
                &["VolumeAndPan", "VolumeVelScale", "Manual"],
            )
            .unwrap_or(1.0),
            attack_seconds: envelope_value("AttackTime", 0.0) / 1000.0,
            decay_seconds: envelope_value("DecayTime", 0.0) / 1000.0,
            sustain_level: envelope_value("SustainLevel", 1.0) as f32,
            release_seconds: envelope_value("ReleaseTime", 0.0) / 1000.0,
            zones,
        });
    }
    ensure!(
        !layers.is_empty(),
        "instrument rack contains no enabled Simpler or Sampler sample layers"
    );
    let mut unsupported_devices = document
        .descendants()
        .filter(|node| {
            node.is_element()
                && node
                    .parent()
                    .is_some_and(|parent| parent.has_tag_name("Device"))
                && !matches!(
                    node.tag_name().name(),
                    "InstrumentGroupDevice"
                        | "OriginalSimpler"
                        | "MultiSampler"
                        | "AudioBranchMixerDevice"
                        | "MidiBranchMixerDevice"
                )
        })
        .map(|node| node.tag_name().name().to_owned())
        .collect::<Vec<_>>();
    unsupported_devices.sort();
    unsupported_devices.dedup();
    Ok(InstrumentReport {
        source: path.to_owned(),
        core_library,
        name,
        layers,
        unsupported_devices,
    })
}

fn parse_clip(path: &Path, xml: &str) -> Result<ClipReport> {
    let document = Document::parse(xml)
        .with_context(|| format!("failed to parse Ableton XML in {}", path.display()))?;
    let clip = document
        .descendants()
        .find(|node| node.has_tag_name("MidiClip"))
        .context("Ableton asset contains no MidiClip")?;
    let name = child_value_string(clip, "Name").unwrap_or_else(|| {
        path.file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    });
    let loop_start: f64 = descendant_path_value(clip, &["Loop", "LoopStart"])?;
    let loop_end: f64 = descendant_path_value(clip, &["Loop", "LoopEnd"])?;
    ensure!(
        loop_start.is_finite() && loop_end.is_finite() && loop_end > loop_start,
        "MIDI clip has invalid loop bounds"
    );
    let bpm = document
        .descendants()
        .filter(|node| node.has_tag_name("Tempo"))
        .find_map(|tempo| direct_child(tempo, "Manual"))
        .and_then(|manual| manual.attribute("Value"))
        .context("Ableton clip has no main tempo")?
        .parse::<f64>()
        .context("Ableton clip tempo is not numeric")?;
    ensure!(
        bpm.is_finite() && bpm > 0.0,
        "Ableton clip has invalid tempo"
    );
    let mut notes = Vec::new();
    for key_track in clip
        .descendants()
        .filter(|node| node.has_tag_name("KeyTrack"))
    {
        let note = child_value(key_track, "MidiKey")?;
        for event in key_track
            .descendants()
            .filter(|node| node.has_tag_name("MidiNoteEvent"))
        {
            notes.push(ClipNote {
                beat: attribute_value(event, "Time")?,
                duration_beats: attribute_value(event, "Duration")?,
                note,
                velocity: rounded_attribute_u8(event, "Velocity")?,
                off_velocity: rounded_attribute_u8(event, "OffVelocity")?,
            });
        }
    }
    notes.sort_by(|left, right| {
        left.beat
            .total_cmp(&right.beat)
            .then(left.note.cmp(&right.note))
    });
    ensure!(!notes.is_empty(), "Ableton MIDI clip contains no notes");
    Ok(ClipReport {
        source: path.to_owned(),
        name,
        bpm,
        loop_start,
        loop_end,
        notes,
    })
}

fn parse_groove(path: &Path, xml: &str) -> Result<GrooveReport> {
    let document = Document::parse(xml)
        .with_context(|| format!("failed to parse Ableton groove XML in {}", path.display()))?;
    let groove = document
        .descendants()
        .find(|node| node.has_tag_name("Groove"))
        .context("Ableton AGR contains no XML Groove")?;
    let clip = groove
        .descendants()
        .find(|node| node.has_tag_name("MidiClip"))
        .context("Ableton groove contains no MIDI template")?;
    let loop_start = descendant_path_value(clip, &["Loop", "LoopStart"])?;
    let loop_end = descendant_path_value(clip, &["Loop", "LoopEnd"])?;
    let mut events = clip
        .descendants()
        .filter(|node| node.has_tag_name("MidiNoteEvent"))
        .map(|event| {
            Ok(GrooveEvent {
                beat: attribute_value(event, "Time")?,
                velocity: rounded_attribute_u8(event, "Velocity")?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    events.sort_by(|left, right| left.beat.total_cmp(&right.beat));
    ensure!(!events.is_empty(), "Ableton groove has no timing events");
    ensure!(
        loop_end > loop_start,
        "Ableton groove has invalid loop bounds"
    );
    Ok(GrooveReport {
        source: path.to_owned(),
        name: child_value_string(groove, "Name").unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        }),
        loop_start,
        loop_end,
        grid: child_value(groove, "Grid").unwrap_or(0),
        quantization_amount: child_value(groove, "QuantizationAmount").unwrap_or(0.0),
        timing_amount: child_value(groove, "TimingAmount").unwrap_or(100.0),
        random_amount: child_value(groove, "RandomAmount").unwrap_or(0.0),
        velocity_amount: child_value(groove, "VelocityAmount").unwrap_or(0.0),
        events,
    })
}

fn apply_groove(beat: f64, velocity: u8, groove: Option<&GrooveReport>) -> (f64, u8) {
    let Some(groove) = groove else {
        return (beat, velocity);
    };
    let loop_beats = groove.loop_end - groove.loop_start;
    let spacing = loop_beats / groove.events.len() as f64;
    if spacing <= 0.0 {
        return (beat, velocity);
    }
    let phase = (beat - groove.loop_start).rem_euclid(loop_beats);
    let index = ((phase / spacing).round() as usize) % groove.events.len();
    let regular = groove.loop_start + index as f64 * spacing;
    let timing = (groove.timing_amount / 100.0).clamp(0.0, 1.0);
    let adjusted_beat = beat + (groove.events[index].beat - regular) * timing;
    let velocity_mix = (groove.velocity_amount / 100.0).clamp(0.0, 1.0);
    let adjusted_velocity = f64::from(velocity)
        + (f64::from(groove.events[index].velocity) - f64::from(velocity)) * velocity_mix;
    (
        adjusted_beat.max(0.0),
        adjusted_velocity.round().clamp(1.0, 127.0) as u8,
    )
}

fn import_drum_clip(
    clip_path: &Path,
    rack_path: Option<&Path>,
    output: &Path,
    core_library: Option<&Path>,
    groove_path: Option<&Path>,
    repeats: u32,
    sample_rate: u32,
) -> Result<()> {
    ensure!(repeats > 0, "repeats must be positive");
    ensure!(sample_rate > 0, "sample rate must be positive");
    let clip_xml = read_ableton_xml(clip_path)?;
    let clip = parse_clip(clip_path, &clip_xml)?;
    let groove = match groove_path {
        Some(path) => Some(parse_groove(path, &read_ableton_xml(path)?)?),
        None => None,
    };
    let groove = groove.as_ref();
    let rack_source = match rack_path {
        Some(rack_path) => rack_path.to_owned(),
        None if clip_xml.contains("<DrumBranchPreset") => clip_path.to_owned(),
        None => referenced_drum_rack(clip_path, &clip_xml, core_library)?,
    };
    let rack_xml = if rack_source == clip_path {
        clip_xml.clone()
    } else {
        read_ableton_xml(&rack_source)?
    };
    let rack = parse_rack(&rack_source, &rack_xml, core_library)?;
    let loop_beats = clip.loop_end - clip.loop_start;
    let total_beats = loop_beats * f64::from(repeats);
    let bars = (total_beats / 4.0).ceil() as u32;
    let mut tracks = Vec::new();
    for voice in &rack.voices {
        let source_notes = clip
            .notes
            .iter()
            .filter(|note| note.note == voice.midi_note)
            .collect::<Vec<_>>();
        if source_notes.is_empty() {
            continue;
        }
        ensure!(
            voice.selected_samples.len() == 1,
            "rack voice '{}' selects {} simultaneous zones; layered imports are not yet supported",
            voice.name,
            voice.selected_samples.len()
        );
        let triggers = (0..repeats)
            .flat_map(|repeat| {
                let offset = f64::from(repeat) * loop_beats;
                let repeat_end = offset + loop_beats;
                source_notes.iter().map(move |note| {
                    let beat = note.beat - clip.loop_start + offset;
                    let (beat, velocity) = apply_groove(beat, note.velocity, groove);
                    ImportedTrigger {
                        beat,
                        duration_beats: note.duration_beats.min((repeat_end - beat).max(0.001)),
                        velocity,
                    }
                })
            })
            .collect::<Vec<_>>();
        let selected_zone = voice
            .samples
            .iter()
            .find(|zone| zone.resolved_path == voice.selected_samples[0])
            .context("selected rack sample zone disappeared")?;
        ensure!(
            selected_zone.volume.is_finite() && selected_zone.volume > 0.0,
            "rack voice '{}' has invalid sample-zone volume",
            voice.name
        );
        tracks.push(ImportedTrack::Sample(ImportedSampleTrack {
            id: format!("{}-{}", voice.midi_note, slug(&voice.name)),
            kind: "sample",
            sample: voice.selected_samples[0].clone(),
            one_shot: true,
            velocity_amount: voice.volume_velocity_scale,
            fade_out_seconds: voice.one_shot_fade_out_seconds,
            gain_db: voice.gain_db + 20.0 * selected_zone.volume.log10(),
            choke_group: (voice.choke_group > 0).then_some(voice.choke_group),
            triggers,
        }));
    }
    ensure!(!tracks.is_empty(), "clip does not trigger any rack voices");
    let events = tracks
        .iter()
        .map(|track| match track {
            ImportedTrack::Sample(track) => track.triggers.len(),
            ImportedTrack::Sampler(track) => track.notes.len(),
        })
        .sum();
    let song = ImportedSong {
        schema_version: 1,
        title: format!("{} — {}", rack.name, clip.name),
        bpm: clip.bpm,
        bars,
        beats_per_bar: 4,
        sample_rate,
        master: ImportedMaster {
            input_gain_db: 0.0,
            tail_seconds: 1.0,
        },
        tracks,
    };
    if let Some(parent) = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let mut json = serde_json::to_string_pretty(&song)?;
    json.push('\n');
    fs::write(output, json).with_context(|| format!("failed to write {}", output.display()))?;
    println!(
        "{}",
        serde_json::to_string_pretty(&ImportReport {
            output: output.to_owned(),
            rack: rack.name,
            clip: clip.name,
            tracks: song.tracks.len(),
            events,
        })?
    );
    Ok(())
}

fn import_midi_clip(
    clip_path: &Path,
    instrument_path: Option<&Path>,
    output: &Path,
    core_library: Option<&Path>,
    groove_path: Option<&Path>,
    repeats: u32,
    sample_rate: u32,
) -> Result<()> {
    ensure!(repeats > 0, "repeats must be positive");
    ensure!(sample_rate > 0, "sample rate must be positive");
    let clip_xml = read_ableton_xml(clip_path)?;
    let clip = parse_clip(clip_path, &clip_xml)?;
    let groove = match groove_path {
        Some(path) => Some(parse_groove(path, &read_ableton_xml(path)?)?),
        None => None,
    };
    let groove = groove.as_ref();
    let instrument_source = match instrument_path {
        Some(path) => path.to_owned(),
        None => referenced_instrument_rack(clip_path, &clip_xml, core_library)?,
    };
    let instrument_xml = read_ableton_xml(&instrument_source)?;
    let instrument = parse_instrument(&instrument_source, &instrument_xml, core_library)?;
    let loop_beats = clip.loop_end - clip.loop_start;
    let total_beats = loop_beats * f64::from(repeats);
    let bars = (total_beats / 4.0).ceil() as u32;
    let notes = (0..repeats)
        .flat_map(|repeat| {
            let offset = f64::from(repeat) * loop_beats;
            let repeat_end = offset + loop_beats;
            clip.notes.iter().map(move |note| {
                let beat = note.beat - clip.loop_start + offset;
                let (beat, velocity) = apply_groove(beat, note.velocity, groove);
                ImportedNote {
                    beat,
                    duration_beats: note.duration_beats.min((repeat_end - beat).max(0.001)),
                    note: note.note,
                    velocity,
                }
            })
        })
        .collect::<Vec<_>>();
    let mut zones = Vec::new();
    for layer in &instrument.layers {
        for zone in &layer.zones {
            ensure!(
                zone.volume.is_finite() && zone.volume > 0.0,
                "instrument layer '{}' has invalid sample-zone volume",
                layer.name
            );
            zones.push(ImportedSamplerZone {
                sample: zone.resolved_path.clone(),
                key_min: zone.key_min,
                key_max: zone.key_max,
                velocity_min: zone.velocity_min,
                velocity_max: zone.velocity_max,
                root_key: zone.root_key,
                detune_cents: zone.detune_cents,
                gain_db: layer.gain_db + 20.0 * zone.volume.log10(),
                pan: (layer.pan + zone.panorama).clamp(-1.0, 1.0),
                sample_start_frame: zone.sample_start_frame,
                sample_end_frame: zone.sample_end_frame,
                source_sample_rate: zone.source_sample_rate,
                sustain_loop: zone.sustain_loop.clone(),
                attack_seconds: layer.attack_seconds,
                decay_seconds: layer.decay_seconds,
                sustain_level: layer.sustain_level,
                release_seconds: layer.release_seconds,
                velocity_amount: layer.velocity_amount,
            });
        }
    }
    ensure!(
        !zones.is_empty(),
        "instrument has no renderable sample zones"
    );
    let tail_seconds = instrument
        .layers
        .iter()
        .map(|layer| layer.release_seconds)
        .fold(1.0_f64, f64::max);
    let song = ImportedSong {
        schema_version: 1,
        title: format!("{} — {}", instrument.name, clip.name),
        bpm: clip.bpm,
        bars,
        beats_per_bar: 4,
        sample_rate,
        master: ImportedMaster {
            input_gain_db: 0.0,
            tail_seconds,
        },
        tracks: vec![ImportedTrack::Sampler(ImportedSamplerTrack {
            id: slug(&instrument.name),
            kind: "sampler",
            gain_db: 0.0,
            zones,
            notes,
        })],
    };
    if let Some(parent) = output
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let mut json = serde_json::to_string_pretty(&song)?;
    json.push('\n');
    fs::write(output, json).with_context(|| format!("failed to write {}", output.display()))?;
    println!(
        "{}",
        serde_json::to_string_pretty(&ImportReport {
            output: output.to_owned(),
            rack: instrument.name,
            clip: clip.name,
            tracks: song.tracks.len(),
            events: clip.notes.len() * repeats as usize,
        })?
    );
    Ok(())
}

fn referenced_instrument_rack(
    clip_path: &Path,
    clip_xml: &str,
    core_library: Option<&Path>,
) -> Result<PathBuf> {
    let document = Document::parse(clip_xml)
        .with_context(|| format!("failed to parse Ableton XML in {}", clip_path.display()))?;
    let relatives = document
        .descendants()
        .filter(|node| node.has_tag_name("RelativePath"))
        .filter_map(|node| node.attribute("Value"))
        .filter(|value| value.ends_with(".adg"))
        .collect::<Vec<_>>();
    let core_library = match core_library {
        Some(root) => root.to_owned(),
        None => discover_core_library(clip_path)?,
    };
    resolve_core_reference(
        &core_library,
        &relatives,
        Path::new("Racks/Instrument Racks"),
    )
    .context("Ableton clip has no installed referenced instrument ADG preset")
}

fn referenced_drum_rack(
    clip_path: &Path,
    clip_xml: &str,
    core_library: Option<&Path>,
) -> Result<PathBuf> {
    let document = Document::parse(clip_xml)
        .with_context(|| format!("failed to parse Ableton XML in {}", clip_path.display()))?;
    let drum_rack = document
        .descendants()
        .find(|node| node.has_tag_name("DrumGroupDevice"))
        .context("Ableton clip contains no drum rack")?;
    let relatives = drum_rack
        .descendants()
        .filter(|node| node.has_tag_name("RelativePath"))
        .filter_map(|node| node.attribute("Value"))
        .filter(|value| value.ends_with(".adg"))
        .collect::<Vec<_>>();
    let core_library = match core_library {
        Some(root) => root.to_owned(),
        None => discover_core_library(clip_path)?,
    };
    resolve_core_reference(&core_library, &relatives, Path::new("Racks/Drum Racks"))
        .context("Ableton clip drum rack has no installed referenced ADG preset")
}

fn resolve_core_reference(
    core_library: &Path,
    relatives: &[&str],
    fallback_directory: &Path,
) -> Option<PathBuf> {
    for relative in relatives {
        let relative = Path::new(relative);
        if relative
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
        {
            let candidate = core_library.join(relative);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let names = relatives
        .iter()
        .filter_map(|relative| Path::new(relative).file_name())
        .collect::<Vec<_>>();
    WalkDir::new(core_library.join(fallback_directory))
        .follow_links(false)
        .into_iter()
        .filter_map(std::result::Result::ok)
        .find(|entry| entry.file_type().is_file() && names.contains(&entry.file_name()))
        .map(|entry| entry.into_path())
}

fn discover_core_library(path: &Path) -> Result<PathBuf> {
    path.ancestors()
        .find(|ancestor| {
            ancestor
                .file_name()
                .is_some_and(|name| name == "Core Library")
        })
        .map(Path::to_owned)
        .with_context(|| {
            format!(
                "could not discover Core Library from {}; pass --core-library",
                path.display()
            )
        })
}

fn first_nonempty_value(node: Node<'_, '_>, name: &str) -> Option<String> {
    node.descendants()
        .filter(|child| child.has_tag_name(name))
        .filter_map(|child| child.attribute("Value"))
        .find(|value| !value.is_empty())
        .map(str::to_owned)
}

fn direct_child<'a, 'input>(node: Node<'a, 'input>, name: &str) -> Option<Node<'a, 'input>> {
    node.children().find(|child| child.has_tag_name(name))
}

fn child_value_string(node: Node<'_, '_>, name: &str) -> Option<String> {
    direct_child(node, name)
        .and_then(|child| child.attribute("Value"))
        .map(str::to_owned)
}

fn child_value<T>(node: Node<'_, '_>, name: &str) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display + Send + Sync + 'static,
{
    let child = direct_child(node, name).with_context(|| format!("missing <{name}>"))?;
    parse_node_value(child)
}

fn descendant_value<T>(node: Node<'_, '_>, name: &str) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display + Send + Sync + 'static,
{
    let child = node
        .descendants()
        .find(|child| child.has_tag_name(name))
        .with_context(|| format!("missing descendant <{name}>"))?;
    parse_node_value(child)
}

fn descendant_manual_value<T>(node: Node<'_, '_>, name: &str) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display + Send + Sync + 'static,
{
    let control = node
        .descendants()
        .find(|child| child.has_tag_name(name))
        .with_context(|| format!("missing descendant <{name}>"))?;
    let manual = direct_child(control, "Manual")
        .with_context(|| format!("<{name}> has no <Manual> value"))?;
    parse_node_value(manual)
}

fn descendant_path_value<T>(node: Node<'_, '_>, path: &[&str]) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display + Send + Sync + 'static,
{
    let (first, rest) = path.split_first().context("empty XML path")?;
    let mut current = node
        .descendants()
        .find(|child| child.has_tag_name(*first))
        .with_context(|| format!("missing descendant <{first}>"))?;
    for name in rest {
        current = direct_child(current, name)
            .with_context(|| format!("missing <{name}> in XML path {}", path.join("/")))?;
    }
    parse_node_value(current)
}

fn parse_node_value<T>(node: Node<'_, '_>) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display + Send + Sync + 'static,
{
    let value = node
        .attribute("Value")
        .with_context(|| format!("<{}> has no Value attribute", node.tag_name().name()))?;
    value.parse::<T>().map_err(|error| {
        anyhow::anyhow!(
            "invalid {} value '{value}': {error}",
            node.tag_name().name()
        )
    })
}

fn attribute_value<T>(node: Node<'_, '_>, name: &str) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display + Send + Sync + 'static,
{
    let value = node
        .attribute(name)
        .with_context(|| format!("<{}> has no {name} attribute", node.tag_name().name()))?;
    value.parse::<T>().map_err(|error| {
        anyhow::anyhow!(
            "invalid {} {name} value '{value}': {error}",
            node.tag_name().name()
        )
    })
}

fn rounded_attribute_u8(node: Node<'_, '_>, name: &str) -> Result<u8> {
    let value = attribute_value::<f64>(node, name)?;
    ensure!(
        value.is_finite() && (0.0..=127.0).contains(&value),
        "{} {name} must be 0..127",
        node.tag_name().name()
    );
    Ok(value.round() as u8)
}

fn slug(value: &str) -> String {
    let mut output = String::new();
    let mut separator = false;
    for character in value.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() {
            if separator && !output.is_empty() {
                output.push('-');
            }
            output.push(character);
            separator = false;
        } else {
            separator = true;
        }
    }
    if output.is_empty() {
        "voice".to_owned()
    } else {
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_midi_clip_notes_and_tempo() {
        let xml = r#"
            <Ableton><LiveSet><MainTrack><DeviceChain><Mixer><Tempo><Manual Value="130"/></Tempo></Mixer></DeviceChain></MainTrack>
            <MidiClip><Name Value="House"/><Loop><LoopStart Value="0"/><LoopEnd Value="2"/></Loop><Notes><KeyTracks>
              <KeyTrack><MidiKey Value="36"/><Notes><MidiNoteEvent Time="0" Duration="0.125" Velocity="99.6" OffVelocity="64"/></Notes></KeyTrack>
            </KeyTracks></Notes></MidiClip></LiveSet></Ableton>
        "#;
        let clip = parse_clip(Path::new("House.alc"), xml).expect("clip");
        assert_eq!(clip.name, "House");
        assert_eq!(clip.bpm, 130.0);
        assert_eq!(clip.notes.len(), 1);
        assert_eq!(clip.notes[0].note, 36);
        assert_eq!(clip.notes[0].velocity, 100);
    }

    #[test]
    fn creates_stable_ascii_track_slugs() {
        assert_eq!(slug("Closed Hi Hat"), "closed-hi-hat");
        assert_eq!(slug("  Cow Bell 808 "), "cow-bell-808");
    }

    #[test]
    fn builds_control_only_max_amxd_render_graph() {
        let patch = build_max_amxd_render_patch(
            "/tmp/Ableton Device \"Bass\".amxd",
            "/tmp/render with spaces.wav",
            None,
            36,
            43,
            118,
        )
        .expect("Max graph");
        let graph: serde_json::Value = serde_json::from_str(&patch).expect("valid Max JSON");
        let serialized = graph.to_string();
        assert!(serialized.contains("amxd~"));
        assert!(serialized.contains("sfrecord~ 2"));
        assert!(serialized.contains("midievent 144 36 118"));
        assert!(serialized.contains("midievent 144 43 118"));
        assert!(!serialized.contains("__AMXD__"));
        assert!(!serialized.contains("sfplay~"));
    }

    #[test]
    fn builds_shipped_ableton_dsp_effect_graph() {
        let patch = build_max_object_render_patch(
            "abl.device.delay~ @feedback 0.55 @mix 0.35",
            "/tmp/input with spaces.wav",
            "/tmp/output.wav",
            5_000,
            3,
            2,
        )
        .expect("Ableton DSP graph");
        let graph: serde_json::Value = serde_json::from_str(&patch).expect("valid Max JSON");
        let serialized = graph.to_string();
        assert!(serialized.contains("abl.device.delay~ @feedback 0.55 @mix 0.35"));
        assert!(serialized.contains("sfplay~ 2"));
        assert!(serialized.contains("sfrecord~ 2"));
        assert!(serialized.contains("delay 5000"));
        assert!(serialized.contains("delay 5500"));
        assert!(!serialized.contains("__DEVICE__"));
    }

    #[test]
    fn duplicates_mono_ableton_objects_for_stereo_rendering() {
        let patch = build_max_object_render_patch(
            "abl.device.compressor~ @threshold -18",
            "/tmp/input.wav",
            "/tmp/output.wav",
            5_000,
            6,
            1,
        )
        .expect("dual-mono Ableton DSP graph");
        let graph: serde_json::Value = serde_json::from_str(&patch).expect("valid Max JSON");
        let serialized = graph.to_string();
        assert!(serialized.contains("device-left"));
        assert!(serialized.contains("device-right"));
        assert!(!serialized.contains("__DEVICE_BOXES__"));
        assert!(!serialized.contains("__DEVICE_LINES__"));
    }

    #[test]
    fn builds_midi_driven_ableton_dsp_instrument_graph() {
        let patch = build_max_instrument_render_patch(
            "abl.device.drift~ @osc1shape 0.25",
            "/tmp/drift render.wav",
            48,
            112,
        )
        .expect("Ableton DSP instrument graph");
        let graph: serde_json::Value = serde_json::from_str(&patch).expect("valid Max JSON");
        let serialized = graph.to_string();
        assert!(serialized.contains("abl.device.drift~ @osc1shape 0.25"));
        assert!(serialized.contains("midiformat"));
        assert!(serialized.contains("48 112"));
        assert!(serialized.contains("48 0"));
        assert!(serialized.contains("sfrecord~ 2"));
        assert!(!serialized.contains("__DEVICE__"));
        assert!(!serialized.contains("__NOTE__"));
    }

    #[test]
    fn builds_max_amxd_audio_effect_graph_from_real_wav_metadata() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let input = directory.path().join("input.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 48_000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(&input, spec).expect("input WAV");
        writer.write_sample(0.25_f32).expect("left sample");
        writer.write_sample(-0.25_f32).expect("right sample");
        writer.finalize().expect("finalized input WAV");
        let patch = build_max_amxd_render_patch(
            "/tmp/effect.amxd",
            "/tmp/effect.wav",
            Some(&input),
            36,
            39,
            100,
        )
        .expect("Max effect graph");
        let graph: serde_json::Value = serde_json::from_str(&patch).expect("valid Max JSON");
        let serialized = graph.to_string();
        assert!(serialized.contains("sfplay~ 2"));
        assert!(serialized.contains("input-player"));
        assert!(serialized.contains("effect.amxd"));
    }

    #[test]
    fn parses_native_parameter_assignments() {
        let parameters = parse_native_parameters(&["0=2".to_owned(), "5=6.90476179".to_owned()])
            .expect("native parameters");
        assert_eq!(parameters.len(), 2);
        assert_eq!(parameters[0].id, 0);
        assert_eq!(parameters[0].value, 2.0);
        assert_eq!(parameters[1].id, 5);
        assert!((parameters[1].value - 6.904_762).abs() < 1.0e-6);
        assert!(parse_native_parameters(&["gain".to_owned()]).is_err());
        assert!(parse_native_parameters(&["1=NaN".to_owned()]).is_err());
    }

    #[test]
    fn maps_amp_adv_controls_to_native_parameter_ids() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let preset = directory.path().join("Blues Drive.adv");
        fs::write(
            &preset,
            r#"<Ableton><Amp>
              <AmpType><Manual Value="2"/></AmpType>
              <Bass><Manual Value="6.25"/></Bass>
              <Middle><Manual Value="5.75"/></Middle>
              <Treble><Manual Value="4.5"/></Treble>
              <Presence><Manual Value="2.5"/></Presence>
              <Gain><Manual Value="7"/></Gain>
              <Volume><Manual Value="8.25"/></Volume>
            </Amp></Ableton>"#,
        )
        .expect("preset fixture");
        let parameters = native_preset_parameters("Amp", &preset).expect("Amp preset");
        assert_eq!(parameters.len(), 7);
        assert_eq!(parameters[0].id, 0);
        assert_eq!(parameters[0].value, 2.0);
        assert_eq!(parameters[6].id, 6);
        assert_eq!(parameters[6].value, 8.25);
    }

    #[test]
    fn maps_electric_adv_controls_in_recovered_native_order() {
        assert_eq!(ELECTRIC_ADV_PARAMETER_MAP.len(), 33);
        assert_eq!(ELECTRIC_ADV_PARAMETER_MAP[2], (2, "KeyboardStretch"));
        assert_eq!(ELECTRIC_ADV_PARAMETER_MAP[25], (25, "PickupAmpOut"));
        assert_eq!(
            ELECTRIC_ADV_PARAMETER_MAP[30..],
            [
                (30, "KeyboardFineTune"),
                (31, "Volume"),
                (32, "PerNotePitchBendRange"),
            ]
        );
    }

    #[test]
    fn parses_and_applies_xml_groove_timing() {
        let xml = r#"
          <Ableton><Groove><Name Value="Swing 16ths 68"/><Clip><Value><MidiClip>
            <Loop><LoopStart Value="0"/><LoopEnd Value="1"/></Loop><Notes><KeyTracks><KeyTrack><Notes>
              <MidiNoteEvent Time="0" Velocity="127"/><MidiNoteEvent Time="0.34" Velocity="127"/>
              <MidiNoteEvent Time="0.5" Velocity="127"/><MidiNoteEvent Time="0.84" Velocity="127"/>
            </Notes><MidiKey Value="36"/></KeyTrack></KeyTracks></Notes>
          </MidiClip></Value></Clip><Grid Value="3"/><QuantizationAmount Value="0"/>
          <TimingAmount Value="100"/><RandomAmount Value="0"/><VelocityAmount Value="0"/></Groove></Ableton>
        "#;
        let groove = parse_groove(Path::new("swing.agr"), xml).expect("groove");
        let (beat, velocity) = apply_groove(0.25, 90, Some(&groove));
        assert!((beat - 0.34).abs() < 1e-9);
        assert_eq!(velocity, 90);
    }

    #[test]
    fn parses_complete_serial_parallel_rack_graph() {
        let xml = r#"
          <Ableton><GroupDevicePreset><Device><AudioEffectGroupDevice Id="rack">
            <On><Manual Value="true"/></On><UserName Value="Parallel Space"/>
            <NumVisibleMacroControls Value="1"/>
            <MacroControls.0><Manual Value="64"/><MidiControllerRange><Min Value="0"/><Max Value="127"/></MidiControllerRange><AutomationTarget Id="100"/><ModulationTarget Id="200"/></MacroControls.0>
            <MacroDisplayNames.0 Value="Character"/><MacroDefaults.0 Value="32"/><MacroAnnotations.0 Value="Tone"/><MacroColor.0 Value="7"/>
            <ExcludeMacroFromRandomization.0 Value="true"/><ExcludeMacroFromSnapshots.0 Value="false"/>
            <ChainSelector><Manual Value="12"/><MidiControllerRange><Min Value="0"/><Max Value="127"/></MidiControllerRange></ChainSelector>
          </AudioEffectGroupDevice></Device><BranchPresets>
            <AudioEffectBranchPreset Id="wet"><Name Value="Wet"/><IsSoloed Value="false"/><DevicePresets>
              <AbletonDevicePreset Id="0"><Device><AutoFilter2 Id="filter"><On><Manual Value="true"/></On><UserName Value="Cut"/><Frequency><KeyMidi><PersistentKeyString Value=""/><IsNote Value="false"/><Channel Value="16"/><NoteOrController Value="0"/><LowerRangeNote Value="-1"/><UpperRangeNote Value="-1"/><ControllerMapMode Value="0"/></KeyMidi><Manual Value="1200"/><MidiControllerRange><Min Value="20"/><Max Value="20000"/></MidiControllerRange><AutomationTarget Id="1"/><ModulationTarget Id="2"/></Frequency></AutoFilter2></Device></AbletonDevicePreset>
              <AbletonDevicePreset Id="1"><Device><Saturator Id="sat"><On><Manual Value="true"/></On><Drive><Manual Value="3"/></Drive></Saturator></Device></AbletonDevicePreset>
            </DevicePresets><MixerPreset><AbletonDevicePreset Id="0"><Device><AudioBranchMixerDevice><On><Manual Value="true"/></On><Volume><Manual Value="0.8"/></Volume></AudioBranchMixerDevice></Device></AbletonDevicePreset></MixerPreset>
            <BranchSelectorRange><Min Value="0"/><Max Value="63"/><CrossfadeMin Value="56"/><CrossfadeMax Value="63"/></BranchSelectorRange>
            </AudioEffectBranchPreset>
            <AudioEffectBranchPreset Id="dry"><Name Value="Dry"/><IsSoloed Value="true"/><DevicePresets/><BranchSelectorRange><Min Value="64"/><Max Value="127"/><CrossfadeMin Value="64"/><CrossfadeMax Value="72"/></BranchSelectorRange></AudioEffectBranchPreset>
          </BranchPresets><ReturnBranchPresets/></GroupDevicePreset></Ableton>
        "#;
        let graph = parse_device_graph(Path::new("Parallel Space.adg"), xml).expect("rack graph");
        assert_eq!(graph.name, "Parallel Space");
        assert_eq!(graph.devices, 4);
        assert_eq!(graph.racks, 1);
        assert_eq!(graph.chains, 2);
        assert_eq!(graph.macro_mappings, 1);
        let rack = graph.roots[0].rack.as_ref().expect("rack");
        assert_eq!(rack.macros[0].name, "Character");
        assert_eq!(rack.macros[0].automation_target_id.as_deref(), Some("100"));
        assert_eq!(rack.chains[0].devices.len(), 2);
        assert_eq!(rack.chains[0].devices[0].parameters[1].name, "Frequency");
        assert_eq!(
            rack.chains[0].devices[0].parameters[1]
                .midi_mapping
                .as_ref()
                .map(|mapping| mapping.channel),
            Some(16)
        );
        assert_eq!(
            rack.chains[0].selector.as_ref().expect("selector").maximum,
            63.0
        );
        assert!(rack.chains[1].soloed);
    }

    #[test]
    fn selects_nested_adg_device_parameters_by_source_offset() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let preset = directory.path().join("nested.adg");
        let xml = r#"<Ableton><GroupDevicePreset><Device><AudioEffectGroupDevice><On><Manual Value="true"/></On></AudioEffectGroupDevice></Device><BranchPresets><AudioEffectBranchPreset><DevicePresets><AbletonDevicePreset><Device><Chorus><On><Manual Value="true"/></On><DelayTime1><Manual Value="3.5"/></DelayTime1></Chorus></Device></AbletonDevicePreset></DevicePresets></AudioEffectBranchPreset></BranchPresets></GroupDevicePreset></Ableton>"#;
        fs::write(&preset, xml).expect("nested preset fixture");
        let offset = xml.find("<Chorus>").expect("Chorus offset");
        let parameters =
            live_engine_preset_parameters(&preset, Some(offset)).expect("nested parameters");
        assert_eq!(
            parameters,
            vec![("On/Off".to_owned(), 1.0), ("DelayTime1".to_owned(), 3.5)]
        );
    }
}
