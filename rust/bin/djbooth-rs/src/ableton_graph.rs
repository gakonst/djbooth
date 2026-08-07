use std::collections::{HashMap, HashSet};
use std::f64::consts::FRAC_PI_4;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::plugin::{Sequence, SequenceNote, validate_sequence};

const SAMPLE_VOICE_COUNT: usize = 8;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AbletonGraph {
    schema_version: u32,
    title: String,
    bpm: f64,
    bars: u32,
    #[serde(default = "default_beats_per_bar")]
    beats_per_bar: u32,
    #[serde(default = "default_sample_rate")]
    sample_rate: u32,
    #[serde(default = "default_tail_seconds")]
    tail_seconds: f64,
    #[serde(default)]
    master: GraphMaster,
    tracks: Vec<GraphTrack>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphMaster {
    #[serde(default)]
    input_gain_db: f64,
    #[serde(default)]
    output_gain_db: f64,
    #[serde(default)]
    effects: Vec<GraphEffect>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphTrack {
    id: String,
    #[serde(default)]
    gain_db: f64,
    #[serde(default)]
    pan: f64,
    #[serde(default)]
    effects: Vec<GraphEffect>,
    #[serde(flatten)]
    source: GraphSource,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum GraphSource {
    Native {
        device: String,
        preset: PathBuf,
        notes: Vec<SequenceNote>,
    },
    Sample {
        sample: PathBuf,
        triggers: Vec<GraphTrigger>,
        #[serde(default = "default_velocity_amount")]
        velocity_amount: f64,
    },
    MaxObject {
        object: String,
        notes: Vec<SequenceNote>,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum GraphEffect {
    Native { device: String, preset: PathBuf },
    Max { amxd: PathBuf },
    Object { object: String },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphTrigger {
    beat: f64,
    velocity: u8,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphRenderReport {
    manifest: PathBuf,
    title: String,
    output: PathBuf,
    stems_dir: PathBuf,
    tracks: usize,
    native_tracks: usize,
    sample_tracks: usize,
    max_object_tracks: usize,
    native_effects: usize,
    max_effects: usize,
    max_object_effects: usize,
    channels: u16,
    sample_rate: u32,
    frames: u32,
    duration_seconds: f64,
    peak: f32,
    custom_dsp: bool,
}

fn default_beats_per_bar() -> u32 {
    4
}

fn default_sample_rate() -> u32 {
    44_100
}

fn default_tail_seconds() -> f64 {
    3.0
}

fn default_velocity_amount() -> f64 {
    1.0
}

pub(crate) fn render(
    manifest_path: &Path,
    output: &Path,
    stems_dir: Option<&Path>,
    devices_root: &Path,
    max_contents: &Path,
    play: bool,
) -> Result<()> {
    let manifest_path = fs::canonicalize(manifest_path)
        .with_context(|| format!("Ableton graph does not exist: {}", manifest_path.display()))?;
    let manifest_directory = manifest_path
        .parent()
        .context("Ableton graph path has no parent directory")?;
    let graph: AbletonGraph = serde_json::from_slice(&fs::read(&manifest_path)?)
        .with_context(|| format!("failed to parse {}", manifest_path.display()))?;
    validate_graph(&graph, manifest_directory, max_contents)?;

    let output = absolute_path(output)?;
    fs::create_dir_all(output.parent().context("output path has no parent")?)?;
    let stems_dir = stems_dir
        .map(absolute_path)
        .transpose()?
        .unwrap_or_else(|| output.with_extension("stems"));
    fs::create_dir_all(&stems_dir)?;

    let executable = std::env::current_exe()?;
    let mut native_sources = HashMap::new();
    for track in &graph.tracks {
        let GraphSource::Native {
            device,
            preset,
            notes,
        } = &track.source
        else {
            continue;
        };
        let sequence = Sequence {
            bpm: graph.bpm,
            bars: graph.bars,
            beats_per_bar: graph.beats_per_bar,
            notes: notes.clone(),
        };
        validate_sequence(&sequence)?;
        let sequence_path = stems_dir.join(format!("{}-sequence.json", track.id));
        fs::write(&sequence_path, serde_json::to_vec_pretty(&sequence)?)?;
        let source_path = stems_dir.join(format!("{}-source.wav", track.id));
        run_native(
            &executable,
            &source_path,
            device,
            devices_root,
            graph.sample_rate,
            Some(&sequence_path),
            None,
            Some(&resolve_path(manifest_directory, preset)),
            graph.tail_seconds,
        )?;
        let mut current = source_path;
        for (index, effect) in track.effects.iter().enumerate() {
            let GraphEffect::Native { device, preset } = effect else {
                continue;
            };
            let effected = stems_dir.join(format!("{}-native-effect-{index}.wav", track.id));
            run_native(
                &executable,
                &effected,
                device,
                devices_root,
                graph.sample_rate,
                None,
                Some(&current),
                Some(&resolve_path(manifest_directory, preset)),
                0.0,
            )?;
            current = effected;
        }
        native_sources.insert(track.id.clone(), current);
    }

    let patch = build_mix_patch(
        &graph,
        manifest_directory,
        &native_sources,
        &output,
        &stems_dir,
        max_contents,
    )?;
    let max_binary = max_contents.join("MacOS/Max");
    ensure!(
        max_binary.is_file(),
        "Ableton's bundled Max executable does not exist: {}",
        max_binary.display()
    );
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let patch_path = std::env::temp_dir().join(format!(
        "djbooth-ableton-graph-{}-{nonce}.maxpat",
        std::process::id()
    ));
    fs::write(&patch_path, serde_json::to_vec_pretty(&patch)?)?;
    eprintln!("render-graph: Max engine {}", max_binary.display());
    eprintln!("render-graph: arrangement {}", graph.title);
    eprintln!("render-graph: output {}", output.display());
    let _max_lock = crate::ableton::acquire_max_runtime_lock()?;
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
    ensure!(output.is_file(), "Max did not create {}", output.display());
    for track in &graph.tracks {
        let stem = stems_dir.join(format!("{}.wav", track.id));
        ensure!(stem.is_file(), "Max did not create stem {}", stem.display());
        ensure!(
            wav_peak(&stem)? > 1.0e-7,
            "Ableton graph rendered silent stem '{}'",
            track.id
        );
    }

    let mut reader = hound::WavReader::open(&output)?;
    let spec = reader.spec();
    let frames = reader.duration();
    let samples = match spec.sample_format {
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
    let peak = samples
        .into_iter()
        .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
    ensure!(peak > 1.0e-7, "Ableton graph rendered silence");
    let report = GraphRenderReport {
        manifest: manifest_path,
        title: graph.title,
        output: output.clone(),
        stems_dir: stems_dir.clone(),
        tracks: graph.tracks.len(),
        native_tracks: graph
            .tracks
            .iter()
            .filter(|track| matches!(track.source, GraphSource::Native { .. }))
            .count(),
        sample_tracks: graph
            .tracks
            .iter()
            .filter(|track| matches!(track.source, GraphSource::Sample { .. }))
            .count(),
        max_object_tracks: graph
            .tracks
            .iter()
            .filter(|track| matches!(track.source, GraphSource::MaxObject { .. }))
            .count(),
        native_effects: graph
            .tracks
            .iter()
            .flat_map(|track| &track.effects)
            .filter(|effect| matches!(effect, GraphEffect::Native { .. }))
            .count(),
        max_effects: graph
            .tracks
            .iter()
            .flat_map(|track| &track.effects)
            .chain(graph.master.effects.iter())
            .filter(|effect| matches!(effect, GraphEffect::Max { .. }))
            .count(),
        max_object_effects: graph
            .tracks
            .iter()
            .flat_map(|track| &track.effects)
            .chain(graph.master.effects.iter())
            .filter(|effect| matches!(effect, GraphEffect::Object { .. }))
            .count(),
        channels: spec.channels,
        sample_rate: spec.sample_rate,
        frames,
        duration_seconds: f64::from(frames) / f64::from(spec.sample_rate),
        peak,
        custom_dsp: false,
    };
    println!("{}", serde_json::to_string_pretty(&report)?);
    if play {
        Command::new("afplay")
            .arg(&output)
            .spawn()
            .context("failed to start afplay")?;
    }
    Ok(())
}

pub(crate) fn sum_audio_files(
    inputs: &[PathBuf],
    output: &Path,
    max_contents: &Path,
) -> Result<()> {
    ensure!(inputs.len() >= 2, "parallel rack sum requires two inputs");
    let mut duration_ms = 0.0_f64;
    for input in inputs {
        let reader = hound::WavReader::open(input)
            .with_context(|| format!("failed to inspect rack branch {}", input.display()))?;
        ensure!(reader.spec().channels == 2, "rack branch must be stereo");
        ensure!(
            reader.spec().sample_rate == 44_100,
            "rack branch must be 44.1 kHz"
        );
        duration_ms = duration_ms
            .max(f64::from(reader.duration()) * 1_000.0 / f64::from(reader.spec().sample_rate));
    }
    let max_binary = max_contents.join("MacOS/Max");
    ensure!(
        max_binary.is_file(),
        "Ableton bundled Max runtime is missing"
    );
    let mut boxes = Vec::new();
    let mut lines = Vec::new();
    add_box(&mut boxes, "load", "newobj", "loadbang");
    add_box(&mut boxes, "dsp", "message", "; dsp start");
    add_line(&mut lines, "load", 0, "dsp", 0);
    add_box(&mut boxes, "start-delay", "newobj", "delay 1500");
    add_box(&mut boxes, "start", "newobj", "t b b");
    add_line(&mut lines, "load", 0, "start-delay", 0);
    add_line(&mut lines, "start-delay", 0, "start", 0);
    add_box(&mut boxes, "record-start", "message", "1");
    add_box(&mut boxes, "play", "message", "1");
    add_line(&mut lines, "start", 1, "record-start", 0);
    add_line(&mut lines, "start", 0, "play", 0);
    add_box(
        &mut boxes,
        "stop-delay",
        "newobj",
        &format!("delay {duration_ms:.3}"),
    );
    add_box(&mut boxes, "record-stop", "message", "0");
    add_line(&mut lines, "start", 0, "stop-delay", 0);
    add_line(&mut lines, "stop-delay", 0, "record-stop", 0);
    add_box(&mut boxes, "quit-delay", "newobj", "delay 500");
    add_box(&mut boxes, "quit", "message", "; max quit");
    add_line(&mut lines, "stop-delay", 0, "quit-delay", 0);
    add_line(&mut lines, "quit-delay", 0, "quit", 0);
    add_recorder(
        &mut boxes,
        &mut lines,
        "rack-sum",
        output,
        "record-start",
        "record-stop",
    );
    for (index, input) in inputs.iter().enumerate() {
        let source = format!("branch-{index}");
        let open = format!("branch-open-{index}");
        add_box(&mut boxes, &source, "newobj", "sfplay~ 2");
        add_box(
            &mut boxes,
            &open,
            "message",
            &format!("open \"{}\"", max_path(input)),
        );
        add_line(&mut lines, "load", 0, &open, 0);
        add_line(&mut lines, &open, 0, &source, 0);
        add_line(&mut lines, "play", 0, &source, 0);
        add_line(&mut lines, &source, 0, "rack-sum-recorder", 0);
        add_line(&mut lines, &source, 1, "rack-sum-recorder", 1);
    }
    let patch = json!({
        "patcher": {
            "fileversion": 1,
            "appversion": {"major": 9, "minor": 0, "revision": 5, "architecture": "x64", "modernui": 1},
            "classnamespace": "box",
            "rect": [0.0, 0.0, 1200.0, 800.0],
            "boxes": boxes,
            "lines": lines
        }
    });
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let patch_path = std::env::temp_dir().join(format!(
        "djbooth-ableton-rack-sum-{}-{nonce}.maxpat",
        std::process::id()
    ));
    fs::write(&patch_path, serde_json::to_vec_pretty(&patch)?)?;
    let _max_lock = crate::ableton::acquire_max_runtime_lock()?;
    let status = Command::new(&max_binary)
        .arg("--nocef")
        .arg(&patch_path)
        .status()?;
    let _ = fs::remove_file(&patch_path);
    ensure!(
        status.success(),
        "Ableton Max branch mixer failed: {status}"
    );
    ensure!(
        output.is_file(),
        "Ableton Max branch mixer created no output"
    );
    Ok(())
}

fn validate_graph(graph: &AbletonGraph, base: &Path, max_contents: &Path) -> Result<()> {
    ensure!(
        graph.schema_version == 1,
        "unsupported Ableton graph schema"
    );
    ensure!(
        !graph.title.trim().is_empty(),
        "graph title cannot be empty"
    );
    ensure!(
        graph.bpm.is_finite() && graph.bpm > 0.0,
        "graph BPM must be positive"
    );
    ensure!(
        graph.bars > 0 && graph.beats_per_bar > 0,
        "graph length must be positive"
    );
    ensure!(graph.sample_rate > 0, "sample rate must be positive");
    ensure!(
        graph.tail_seconds.is_finite() && graph.tail_seconds >= 0.0,
        "tail seconds must be finite and non-negative"
    );
    ensure!(!graph.tracks.is_empty(), "graph has no tracks");
    ensure!(
        graph.master.input_gain_db.is_finite() && graph.master.output_gain_db.is_finite(),
        "master gains must be finite"
    );
    for effect in &graph.master.effects {
        match effect {
            GraphEffect::Max { amxd } => ensure!(
                resolve_path(base, amxd).is_file(),
                "missing master effect {}",
                amxd.display()
            ),
            GraphEffect::Object { object } => validate_max_object(max_contents, object)?,
            GraphEffect::Native { .. } => {
                anyhow::bail!("master effects must use the Max engine")
            }
        }
    }
    let total_beats = f64::from(graph.bars * graph.beats_per_bar);
    let mut ids = HashSet::new();
    for track in &graph.tracks {
        ensure!(
            !track.id.is_empty()
                && track
                    .id
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character)),
            "track ID '{}' must contain only ASCII letters, numbers, '-' or '_'",
            track.id
        );
        ensure!(ids.insert(&track.id), "duplicate track ID '{}'", track.id);
        ensure!(
            track.gain_db.is_finite(),
            "track '{}' gain is invalid",
            track.id
        );
        ensure!(
            track.pan.is_finite() && (-1.0..=1.0).contains(&track.pan),
            "track '{}' pan must be -1..1",
            track.id
        );
        match &track.source {
            GraphSource::Native { preset, notes, .. } => {
                ensure!(
                    resolve_path(base, preset).is_file(),
                    "missing preset {}",
                    preset.display()
                );
                validate_sequence(&Sequence {
                    bpm: graph.bpm,
                    bars: graph.bars,
                    beats_per_bar: graph.beats_per_bar,
                    notes: notes.clone(),
                })?;
            }
            GraphSource::Sample {
                sample,
                triggers,
                velocity_amount,
            } => {
                ensure!(
                    resolve_path(base, sample).is_file(),
                    "missing sample {}",
                    sample.display()
                );
                ensure!(
                    velocity_amount.is_finite() && (0.0..=1.0).contains(velocity_amount),
                    "track '{}' velocityAmount must be 0..1",
                    track.id
                );
                for trigger in triggers {
                    ensure!(
                        trigger.beat.is_finite()
                            && trigger.beat >= 0.0
                            && trigger.beat < total_beats,
                        "track '{}' has a trigger outside the arrangement",
                        track.id
                    );
                    ensure!(
                        trigger.velocity > 0 && trigger.velocity <= 127,
                        "invalid trigger velocity"
                    );
                }
            }
            GraphSource::MaxObject { object, notes } => {
                validate_max_object(max_contents, object)?;
                let class = max_object_class(object)?;
                let (inlets, outlets) = crate::ableton::max_object_io(max_contents, class)?;
                ensure!(
                    inlets == 1 && outlets >= 2,
                    "track '{}' object {class} has {inlets} inputs and {outlets} outputs; a Max instrument source requires one MIDI input and at least two audio outputs",
                    track.id
                );
                validate_sequence(&Sequence {
                    bpm: graph.bpm,
                    bars: graph.bars,
                    beats_per_bar: graph.beats_per_bar,
                    notes: notes.clone(),
                })?;
            }
        }
        let native_source = matches!(track.source, GraphSource::Native { .. });
        let mut entered_max_chain = false;
        for effect in &track.effects {
            match effect {
                GraphEffect::Native { preset, .. } => {
                    ensure!(
                        native_source,
                        "track '{}' can use standalone native effects only after a standalone native source",
                        track.id
                    );
                    ensure!(
                        !entered_max_chain,
                        "track '{}' cannot place a standalone native effect after a Max effect",
                        track.id
                    );
                    ensure!(
                        resolve_path(base, preset).is_file(),
                        "missing effect {}",
                        preset.display()
                    );
                }
                GraphEffect::Max { amxd } => {
                    entered_max_chain = true;
                    ensure!(
                        resolve_path(base, amxd).is_file(),
                        "missing effect {}",
                        amxd.display()
                    );
                }
                GraphEffect::Object { object } => {
                    entered_max_chain = true;
                    validate_max_object(max_contents, object)?;
                }
            }
        }
    }
    Ok(())
}

fn validate_max_object(max_contents: &Path, object: &str) -> Result<()> {
    let class = max_object_class(object)?;
    ensure!(
        class.starts_with("abl.") && class.ends_with('~'),
        "only Ableton's shipped abl.*~ DSP objects are accepted"
    );
    let binary = max_contents
        .join("Resources/C74/packages/ableton-dsp/externals")
        .join(format!("{class}.mxo"))
        .join("Contents/MacOS")
        .join(class);
    ensure!(
        binary.is_file(),
        "Ableton DSP object does not exist: {}",
        binary.display()
    );
    Ok(())
}

fn max_object_class(object: &str) -> Result<&str> {
    object
        .split_ascii_whitespace()
        .next()
        .context("Max object cannot be empty")
}

#[allow(clippy::too_many_arguments)]
fn run_native(
    executable: &Path,
    output: &Path,
    device: &str,
    devices_root: &Path,
    sample_rate: u32,
    sequence: Option<&Path>,
    input: Option<&Path>,
    preset: Option<&Path>,
    tail_seconds: f64,
) -> Result<()> {
    let mut command = Command::new(executable);
    command
        .arg("ableton")
        .arg("render-native-device")
        .arg(output)
        .arg("--device")
        .arg(device)
        .arg("--devices-root")
        .arg(devices_root)
        .arg("--sample-rate")
        .arg(sample_rate.to_string())
        .arg("--tail-seconds")
        .arg(tail_seconds.to_string());
    if let Some(sequence) = sequence {
        command.arg("--sequence").arg(sequence);
    }
    if let Some(input) = input {
        command.arg("--input").arg(input);
    }
    if let Some(preset) = preset {
        command.arg("--preset").arg(preset);
    }
    let status = command
        .status()
        .context("failed to start native Ableton renderer")?;
    ensure!(
        status.success(),
        "native Ableton renderer exited with {status}"
    );
    Ok(())
}

fn build_mix_patch(
    graph: &AbletonGraph,
    base: &Path,
    native_sources: &HashMap<String, PathBuf>,
    output: &Path,
    stems_dir: &Path,
    max_contents: &Path,
) -> Result<Value> {
    let mut boxes = Vec::new();
    let mut lines = Vec::new();
    add_box(&mut boxes, "load", "newobj", "loadbang");
    add_box(&mut boxes, "dsp", "message", "; dsp start");
    add_line(&mut lines, "load", 0, "dsp", 0);
    add_box(&mut boxes, "start-delay", "newobj", "delay 1500");
    add_box(&mut boxes, "start", "newobj", "t b b");
    add_line(&mut lines, "load", 0, "start-delay", 0);
    add_line(&mut lines, "start-delay", 0, "start", 0);
    add_box(&mut boxes, "record-start", "message", "1");
    add_line(&mut lines, "start", 1, "record-start", 0);

    let duration_ms = (f64::from(graph.bars * graph.beats_per_bar) * 60_000.0 / graph.bpm
        + graph.tail_seconds * 1_000.0)
        .ceil() as u64;
    add_box(
        &mut boxes,
        "stop-delay",
        "newobj",
        &format!("delay {duration_ms}"),
    );
    add_box(&mut boxes, "record-stop", "message", "0");
    add_line(&mut lines, "start", 0, "stop-delay", 0);
    add_line(&mut lines, "stop-delay", 0, "record-stop", 0);
    add_box(&mut boxes, "quit-delay", "newobj", "delay 750");
    add_box(&mut boxes, "quit", "message", "; max quit");
    add_line(&mut lines, "stop-delay", 0, "quit-delay", 0);
    add_line(&mut lines, "quit-delay", 0, "quit", 0);

    add_recorder(
        &mut boxes,
        &mut lines,
        "master",
        output,
        "record-start",
        "record-stop",
    );
    let master_input_gain = 10.0_f64.powf(graph.master.input_gain_db / 20.0);
    add_box(
        &mut boxes,
        "master-input-left",
        "newobj",
        &format!("*~ {master_input_gain:.8}"),
    );
    add_box(
        &mut boxes,
        "master-input-right",
        "newobj",
        &format!("*~ {master_input_gain:.8}"),
    );
    let mut master_left = ("master-input-left".to_owned(), 0_u8);
    let mut master_right = ("master-input-right".to_owned(), 0_u8);
    for (index, effect) in graph.master.effects.iter().enumerate() {
        let effect_id = format!("master-max-effect-{index}");
        (master_left, master_right) = add_max_effect(
            &mut boxes,
            &mut lines,
            effect,
            base,
            max_contents,
            &effect_id,
            master_left,
            master_right,
        )?;
    }
    let master_output_gain = 10.0_f64.powf(graph.master.output_gain_db / 20.0);
    add_box(
        &mut boxes,
        "master-output-left",
        "newobj",
        &format!("*~ {master_output_gain:.8}"),
    );
    add_box(
        &mut boxes,
        "master-output-right",
        "newobj",
        &format!("*~ {master_output_gain:.8}"),
    );
    add_line(
        &mut lines,
        &master_left.0,
        master_left.1,
        "master-output-left",
        0,
    );
    add_line(
        &mut lines,
        &master_right.0,
        master_right.1,
        "master-output-right",
        0,
    );
    add_line(&mut lines, "master-output-left", 0, "master-recorder", 0);
    add_line(&mut lines, "master-output-right", 0, "master-recorder", 1);

    for track in &graph.tracks {
        let prefix = &track.id;
        let source = format!("{prefix}-source");
        let gain = 10.0_f64.powf(track.gain_db / 20.0);
        let angle = (track.pan + 1.0) * FRAC_PI_4;
        let left_gain = gain * angle.cos();
        let right_gain = gain * angle.sin();
        let (source_left, source_right) = match &track.source {
            GraphSource::Native { .. } => {
                let path = native_sources
                    .get(prefix)
                    .with_context(|| format!("native source missing for {prefix}"))?;
                add_box(&mut boxes, &source, "newobj", "sfplay~ 2");
                let open = format!("{prefix}-open");
                add_box(
                    &mut boxes,
                    &open,
                    "message",
                    &format!("open \"{}\"", max_path(path)),
                );
                add_line(&mut lines, "load", 0, &open, 0);
                add_line(&mut lines, &open, 0, &source, 0);
                let play = format!("{prefix}-play");
                add_box(&mut boxes, &play, "message", "1");
                add_line(&mut lines, "start", 0, &play, 0);
                add_line(&mut lines, &play, 0, &source, 0);
                (
                    (source.clone(), 0),
                    (
                        source.clone(),
                        if wav_has_right_signal(path)? { 1 } else { 0 },
                    ),
                )
            }
            GraphSource::Sample {
                sample,
                triggers,
                velocity_amount,
            } => {
                let sample = resolve_path(base, sample);
                let source_right_outlet = if audio_channels(&sample)? > 1 { 1 } else { 0 };
                let mix_left = format!("{source}-mix-left");
                let mix_right = format!("{source}-mix-right");
                add_box(&mut boxes, &mix_left, "newobj", "*~ 1.");
                add_box(&mut boxes, &mix_right, "newobj", "*~ 1.");
                for voice in 0..SAMPLE_VOICE_COUNT {
                    let player = format!("{source}-voice-{voice}");
                    let open = format!("{prefix}-open-{voice}");
                    let velocity_left = format!("{prefix}-voice-{voice}-velocity-left");
                    let velocity_right = format!("{prefix}-voice-{voice}-velocity-right");
                    add_box(&mut boxes, &player, "newobj", "sfplay~ 2");
                    add_box(
                        &mut boxes,
                        &open,
                        "message",
                        &format!("open \"{}\"", max_path(&sample)),
                    );
                    add_line(&mut lines, "load", 0, &open, 0);
                    add_line(&mut lines, &open, 0, &player, 0);
                    add_box(&mut boxes, &velocity_left, "newobj", "*~ 0.");
                    add_box(&mut boxes, &velocity_right, "newobj", "*~ 0.");
                    add_line(&mut lines, &player, 0, &velocity_left, 0);
                    add_line(&mut lines, &player, source_right_outlet, &velocity_right, 0);
                    add_line(&mut lines, &velocity_left, 0, &mix_left, 0);
                    add_line(&mut lines, &velocity_right, 0, &mix_right, 0);
                }
                for (index, trigger) in triggers.iter().enumerate() {
                    let delay = format!("{prefix}-event-{index}");
                    let fire = format!("{prefix}-fire-{index}");
                    let amplitude = format!("{prefix}-amplitude-{index}");
                    let start = format!("{prefix}-sample-start-{index}");
                    let voice = index % SAMPLE_VOICE_COUNT;
                    let player = format!("{source}-voice-{voice}");
                    let velocity_left = format!("{prefix}-voice-{voice}-velocity-left");
                    let velocity_right = format!("{prefix}-voice-{voice}-velocity-right");
                    let millis = trigger.beat * 60_000.0 / graph.bpm;
                    add_box(&mut boxes, &delay, "newobj", &format!("delay {millis:.3}"));
                    add_box(&mut boxes, &fire, "newobj", "t b b");
                    let velocity_gain = (1.0 - velocity_amount)
                        + velocity_amount * f64::from(trigger.velocity) / 127.0;
                    add_box(
                        &mut boxes,
                        &amplitude,
                        "message",
                        &format!("{velocity_gain:.8}"),
                    );
                    add_box(&mut boxes, &start, "message", "1");
                    add_line(&mut lines, "start", 0, &delay, 0);
                    add_line(&mut lines, &delay, 0, &fire, 0);
                    add_line(&mut lines, &fire, 1, &amplitude, 0);
                    add_line(&mut lines, &fire, 0, &start, 0);
                    add_line(&mut lines, &start, 0, &player, 0);
                    add_line(&mut lines, &amplitude, 0, &velocity_left, 1);
                    add_line(&mut lines, &amplitude, 0, &velocity_right, 1);
                }
                ((mix_left, 0), (mix_right, 0))
            }
            GraphSource::MaxObject { object, notes } => {
                let class = max_object_class(object)?;
                let (inlets, outlets) = crate::ableton::max_object_io(max_contents, class)?;
                ensure!(
                    inlets == 1 && outlets >= 2,
                    "{class} is not a MIDI instrument"
                );
                add_box_with_io(&mut boxes, &source, "newobj", object, inlets, outlets);
                let midi = format!("{prefix}-midi");
                add_box_with_io(&mut boxes, &midi, "newobj", "midiformat", 7, 2);
                add_line(&mut lines, &midi, 0, &source, 0);
                for (index, note) in notes.iter().enumerate() {
                    let note_on_delay = format!("{prefix}-note-on-delay-{index}");
                    let note_on = format!("{prefix}-note-on-{index}");
                    let note_off_delay = format!("{prefix}-note-off-delay-{index}");
                    let note_off = format!("{prefix}-note-off-{index}");
                    let note_on_ms = note.beat * 60_000.0 / graph.bpm;
                    let note_off_ms = (note.beat + note.duration_beats) * 60_000.0 / graph.bpm;
                    add_box(
                        &mut boxes,
                        &note_on_delay,
                        "newobj",
                        &format!("delay {note_on_ms:.3}"),
                    );
                    add_box(
                        &mut boxes,
                        &note_on,
                        "message",
                        &format!("{} {}", note.note, note.velocity),
                    );
                    add_box(
                        &mut boxes,
                        &note_off_delay,
                        "newobj",
                        &format!("delay {note_off_ms:.3}"),
                    );
                    add_box(
                        &mut boxes,
                        &note_off,
                        "message",
                        &format!("{} 0", note.note),
                    );
                    add_line(&mut lines, "start", 0, &note_on_delay, 0);
                    add_line(&mut lines, &note_on_delay, 0, &note_on, 0);
                    add_line(&mut lines, &note_on, 0, &midi, 0);
                    add_line(&mut lines, "start", 0, &note_off_delay, 0);
                    add_line(&mut lines, &note_off_delay, 0, &note_off, 0);
                    add_line(&mut lines, &note_off, 0, &midi, 0);
                }
                ((source.clone(), 0), (source.clone(), 1))
            }
        };

        let gain_left = format!("{prefix}-gain-left");
        let gain_right = format!("{prefix}-gain-right");
        add_box(
            &mut boxes,
            &gain_left,
            "newobj",
            &format!("*~ {left_gain:.8}"),
        );
        add_box(
            &mut boxes,
            &gain_right,
            "newobj",
            &format!("*~ {right_gain:.8}"),
        );
        add_line(&mut lines, &source_left.0, source_left.1, &gain_left, 0);
        add_line(&mut lines, &source_right.0, source_right.1, &gain_right, 0);

        let mut chain_left = (gain_left, 0_u8);
        let mut chain_right = (gain_right, 0_u8);
        for (index, effect) in track.effects.iter().enumerate() {
            if matches!(effect, GraphEffect::Native { .. }) {
                continue;
            }
            let effect_id = format!("{prefix}-max-effect-{index}");
            (chain_left, chain_right) = add_max_effect(
                &mut boxes,
                &mut lines,
                effect,
                base,
                max_contents,
                &effect_id,
                chain_left,
                chain_right,
            )?;
        }

        let stem = stems_dir.join(format!("{prefix}.wav"));
        add_recorder(
            &mut boxes,
            &mut lines,
            &format!("stem-{prefix}"),
            &stem,
            "record-start",
            "record-stop",
        );
        add_line(
            &mut lines,
            &chain_left.0,
            chain_left.1,
            &format!("stem-{prefix}-recorder"),
            0,
        );
        add_line(
            &mut lines,
            &chain_right.0,
            chain_right.1,
            &format!("stem-{prefix}-recorder"),
            1,
        );
        add_line(
            &mut lines,
            &chain_left.0,
            chain_left.1,
            "master-input-left",
            0,
        );
        add_line(
            &mut lines,
            &chain_right.0,
            chain_right.1,
            "master-input-right",
            0,
        );
    }

    Ok(json!({
        "patcher": {
            "fileversion": 1,
            "appversion": {"major": 9, "minor": 0, "revision": 5, "architecture": "x64", "modernui": 1},
            "classnamespace": "box",
            "rect": [0.0, 0.0, 1600.0, 1000.0],
            "boxes": boxes,
            "lines": lines
        }
    }))
}

fn max_effect_object_text(effect: &GraphEffect, base: &Path) -> Option<String> {
    match effect {
        GraphEffect::Max { amxd } => {
            Some(format!("amxd~ \"{}\"", max_path(&resolve_path(base, amxd))))
        }
        GraphEffect::Object { object } => Some(object.clone()),
        GraphEffect::Native { .. } => None,
    }
}

#[allow(clippy::too_many_arguments)]
fn add_max_effect(
    boxes: &mut Vec<Value>,
    lines: &mut Vec<Value>,
    effect: &GraphEffect,
    base: &Path,
    max_contents: &Path,
    id: &str,
    input_left: (String, u8),
    input_right: (String, u8),
) -> Result<((String, u8), (String, u8))> {
    let object = max_effect_object_text(effect, base).context("native effect is not a Max node")?;
    match effect {
        GraphEffect::Max { .. } => {
            add_box_with_io(boxes, id, "newobj", &object, 2, 2);
            add_line(lines, &input_left.0, input_left.1, id, 0);
            add_line(lines, &input_right.0, input_right.1, id, 1);
            Ok(((id.to_owned(), 0), (id.to_owned(), 1)))
        }
        GraphEffect::Object { .. } => {
            let class = max_object_class(&object)?;
            let (inlets, outlets) = crate::ableton::max_object_io(max_contents, class)?;
            ensure!(inlets > 0 && outlets > 0, "{class} has no audio topology");
            if outlets == 1 {
                let left = format!("{id}-left");
                let right = format!("{id}-right");
                add_box_with_io(boxes, &left, "newobj", &object, inlets, outlets);
                add_box_with_io(boxes, &right, "newobj", &object, inlets, outlets);
                add_line(lines, &input_left.0, input_left.1, &left, 0);
                add_line(lines, &input_right.0, input_right.1, &right, 0);
                Ok(((left, 0), (right, 0)))
            } else {
                ensure!(
                    inlets >= 2,
                    "{class} has {inlets} input and cannot accept a stereo effect signal"
                );
                add_box_with_io(boxes, id, "newobj", &object, inlets, outlets);
                add_line(lines, &input_left.0, input_left.1, id, 0);
                add_line(lines, &input_right.0, input_right.1, id, 1);
                Ok(((id.to_owned(), 0), (id.to_owned(), 1)))
            }
        }
        GraphEffect::Native { .. } => anyhow::bail!("native effect is not a Max node"),
    }
}

fn add_recorder(
    boxes: &mut Vec<Value>,
    lines: &mut Vec<Value>,
    id: &str,
    path: &Path,
    start: &str,
    stop: &str,
) {
    let recorder = format!("{id}-recorder");
    let open = format!("{id}-open");
    add_box(boxes, &recorder, "newobj", "sfrecord~ 2");
    add_box(
        boxes,
        &open,
        "message",
        &format!("open \"{}\"", max_path(path)),
    );
    add_line(lines, "load", 0, &open, 0);
    add_line(lines, &open, 0, &recorder, 0);
    add_line(lines, start, 0, &recorder, 0);
    add_line(lines, stop, 0, &recorder, 0);
}

fn add_box(boxes: &mut Vec<Value>, id: &str, maxclass: &str, text: &str) {
    let (numinlets, numoutlets) = if maxclass == "message" {
        (2, 1)
    } else if text.starts_with("sfplay~") {
        (2, 3)
    } else if text.starts_with("play~") || text.starts_with("amxd~") || text.starts_with("abl.") {
        (2, 2)
    } else if text.starts_with("sfrecord~") {
        (3, 1)
    } else if text.starts_with("*~") || text.starts_with("delay ") {
        (2, 1)
    } else if text.starts_with("t ") {
        (1, text.split_ascii_whitespace().count().saturating_sub(1))
    } else {
        (1, 1)
    };
    boxes.push(json!({"box": {
        "id": id,
        "maxclass": maxclass,
        "text": text,
        "patching_rect": [20.0, 20.0, 160.0, 22.0],
        "numinlets": numinlets,
        "numoutlets": numoutlets
    }}));
}

fn add_box_with_io(
    boxes: &mut Vec<Value>,
    id: &str,
    maxclass: &str,
    text: &str,
    numinlets: u64,
    numoutlets: u64,
) {
    boxes.push(json!({"box": {
        "id": id,
        "maxclass": maxclass,
        "text": text,
        "patching_rect": [20.0, 20.0, 240.0, 22.0],
        "numinlets": numinlets,
        "numoutlets": numoutlets
    }}));
}

fn add_line(lines: &mut Vec<Value>, source: &str, outlet: u8, destination: &str, inlet: u8) {
    lines.push(json!({"patchline": {
        "source": [source, outlet],
        "destination": [destination, inlet]
    }}));
}

fn audio_channels(path: &Path) -> Result<u16> {
    if let Ok(reader) = hound::WavReader::open(path) {
        return Ok(reader.spec().channels);
    }
    let output = Command::new("afinfo")
        .arg(path)
        .output()
        .with_context(|| format!("failed to inspect sample {}", path.display()))?;
    ensure!(
        output.status.success(),
        "afinfo could not inspect {}",
        path.display()
    );
    let info = String::from_utf8_lossy(&output.stdout);
    let channels = info
        .lines()
        .find_map(|line| {
            let (_, format) = line.split_once("Data format:")?;
            let (channels, _) = format.trim().split_once(" ch,")?;
            channels.trim().parse::<u16>().ok()
        })
        .with_context(|| format!("afinfo did not report channels for {}", path.display()))?;
    ensure!(
        channels > 0,
        "sample {} has no audio channels",
        path.display()
    );
    Ok(channels)
}

fn wav_has_right_signal(path: &Path) -> Result<bool> {
    let mut reader = hound::WavReader::open(path)
        .with_context(|| format!("failed to inspect rendered source {}", path.display()))?;
    let spec = reader.spec();
    if spec.channels < 2 {
        return Ok(false);
    }
    let channels = usize::from(spec.channels);
    let samples = match spec.sample_format {
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
    let mut left_peak = 0.0_f32;
    let mut right_peak = 0.0_f32;
    for frame in samples.chunks_exact(channels) {
        left_peak = left_peak.max(frame[0].abs());
        right_peak = right_peak.max(frame[1].abs());
    }
    Ok(right_peak > (left_peak * 1.0e-4).max(1.0e-7))
}

fn wav_peak(path: &Path) -> Result<f32> {
    let mut reader = hound::WavReader::open(path)
        .with_context(|| format!("failed to meter rendered WAV {}", path.display()))?;
    let spec = reader.spec();
    let peak = match spec.sample_format {
        hound::SampleFormat::Float => {
            reader.samples::<f32>().try_fold(0.0_f32, |peak, sample| {
                sample.map(|value| peak.max(value.abs()))
            })?
        }
        hound::SampleFormat::Int => {
            let scale = 2.0_f32.powi(i32::from(spec.bits_per_sample) - 1);
            reader.samples::<i32>().try_fold(0.0_f32, |peak, sample| {
                sample.map(|value| peak.max((value as f32 / scale).abs()))
            })?
        }
    };
    Ok(peak)
}

fn resolve_path(base: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_owned()
    } else {
        base.join(path)
    }
}

fn absolute_path(path: &Path) -> Result<PathBuf> {
    if path.is_absolute() {
        Ok(path.to_owned())
    } else {
        Ok(std::env::current_dir()?.join(path))
    }
}

fn max_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_a_four_four_44100_graph() {
        assert_eq!(default_beats_per_bar(), 4);
        assert_eq!(default_sample_rate(), 44_100);
        assert_eq!(default_tail_seconds(), 3.0);
    }

    #[test]
    fn computes_center_pan_at_equal_power() {
        let angle = (0.0_f64 + 1.0) * FRAC_PI_4;
        assert!((angle.cos() - 2.0_f64.sqrt().recip()).abs() < 1.0e-12);
        assert!((angle.sin() - 2.0_f64.sqrt().recip()).abs() < 1.0e-12);
    }

    #[test]
    fn keeps_shipped_ableton_dsp_objects_in_declarative_chains() {
        let effect: GraphEffect =
            serde_json::from_str(r#"{"kind":"object","object":"abl.device.delay~ @mix 0.25"}"#)
                .expect("object effect");
        assert_eq!(
            max_effect_object_text(&effect, Path::new("/tmp")),
            Some("abl.device.delay~ @mix 0.25".to_owned())
        );
    }
}
