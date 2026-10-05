use std::collections::{HashMap, HashSet};
use std::f64::consts::FRAC_PI_4;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, ensure};
use djbooth_analyzer::decode_audio_file_with_channels;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::plugin::{Sequence, SequenceNote, validate_sequence};

const SAMPLE_VOICE_COUNT: usize = 8;
const OFFLINE_BLOCK_FRAMES: usize = 65_536;

fn sample_voice_index(event_index: usize) -> usize {
    event_index % SAMPLE_VOICE_COUNT
}

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
        #[serde(default)]
        notes: Vec<SequenceNote>,
        #[serde(default)]
        clips: Vec<GraphMidiClip>,
    },
    Sample {
        sample: PathBuf,
        triggers: Vec<GraphTrigger>,
        #[serde(default, rename = "loopBeats")]
        loop_beats: Option<f64>,
        #[serde(default)]
        placements: Vec<GraphClipPlacement>,
        #[serde(default = "default_velocity_amount", rename = "velocityAmount")]
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
    Native {
        device: String,
        preset: PathBuf,
        #[serde(default)]
        sidechain: Option<PathBuf>,
    },
    Max {
        amxd: PathBuf,
    },
    Object {
        object: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphTrigger {
    beat: f64,
    velocity: u8,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphClipPlacement {
    start_beat: f64,
    end_beat: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GraphMidiClip {
    id: String,
    loop_beats: f64,
    placements: Vec<GraphClipPlacement>,
    notes: Vec<SequenceNote>,
}

enum RenderedNativeSource {
    Arrangement(PathBuf),
    Clips(Vec<RenderedNativeClip>),
}

struct RenderedNativeClip {
    path: PathBuf,
    loop_beats: f64,
    placements: Vec<GraphClipPlacement>,
}

struct OfflineVoice {
    audio: Arc<Vec<[f32; 2]>>,
    start: usize,
    end: usize,
    left_gain: f32,
    right_gain: f32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphRenderReport {
    manifest: PathBuf,
    title: String,
    output: PathBuf,
    cache_dir: PathBuf,
    stems_dir: Option<PathBuf>,
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

#[allow(clippy::too_many_arguments)]
fn render_native_sequence_cached(
    executable: &Path,
    cache_id: &str,
    sequence: &Sequence,
    device: &str,
    preset: &Path,
    devices_root: &Path,
    sample_rate: u32,
    tail_seconds: f64,
    stems_dir: &Path,
) -> Result<PathBuf> {
    validate_sequence(sequence)?;
    let sequence_path = stems_dir.join(format!("{cache_id}-sequence.json"));
    let metadata_path = stems_dir.join(format!("{cache_id}-source.json"));
    let sequence_json = serde_json::to_vec_pretty(sequence)?;
    let sequence_matches = fs::read(&sequence_path).is_ok_and(|bytes| bytes == sequence_json);
    let source_path = stems_dir.join(format!("{cache_id}-source.wav"));
    let preset_metadata = fs::metadata(preset)?;
    let preset_modified_nanos = preset_metadata
        .modified()?
        .duration_since(UNIX_EPOCH)?
        .as_nanos()
        .to_string();
    let metadata_json = serde_json::to_vec_pretty(&json!({
        "device": device,
        "preset": preset.to_string_lossy(),
        "presetBytes": preset_metadata.len(),
        "presetModifiedNanos": preset_modified_nanos,
        "sampleRate": sample_rate,
        "tailSeconds": tail_seconds,
    }))?;
    let metadata_matches = fs::read(&metadata_path).is_ok_and(|bytes| bytes == metadata_json);
    let legacy_metadata = !metadata_path.exists();
    let expected_duration =
        f64::from(sequence.bars * sequence.beats_per_bar) * 60.0 / sequence.bpm + tail_seconds;
    let source_matches = sequence_matches
        && (metadata_matches || legacy_metadata)
        && cached_wav_matches(&source_path, sample_rate, expected_duration);
    fs::write(&sequence_path, sequence_json)?;
    if source_matches {
        if legacy_metadata {
            fs::write(&metadata_path, &metadata_json)?;
        }
        eprintln!(
            "render-graph: reusing cached Ableton source {}",
            source_path.display()
        );
    } else {
        run_native(
            executable,
            &source_path,
            device,
            devices_root,
            sample_rate,
            Some(&sequence_path),
            None,
            Some(preset),
            tail_seconds,
        )?;
        fs::write(metadata_path, metadata_json)?;
    }
    Ok(source_path)
}

#[allow(clippy::too_many_arguments)]
fn render_native_effect_cached(
    executable: &Path,
    cache_id: &str,
    input: &Path,
    device: &str,
    preset: &Path,
    sidechain: Option<&Path>,
    devices_root: &Path,
    max_contents: &Path,
    sample_rate: u32,
    cache_dir: &Path,
    tail_seconds: f64,
) -> Result<PathBuf> {
    let output = cache_dir.join(format!("{cache_id}.wav"));
    let metadata_path = cache_dir.join(format!("{cache_id}.json"));
    let input_metadata = fs::metadata(input)?;
    let preset_metadata = fs::metadata(preset)?;
    let modified_nanos = |metadata: &fs::Metadata| -> Result<String> {
        Ok(metadata
            .modified()?
            .duration_since(UNIX_EPOCH)?
            .as_nanos()
            .to_string())
    };
    let sidechain_metadata = sidechain
        .map(|path| -> Result<Value> {
            let metadata = fs::metadata(path)?;
            Ok(json!({
                "path": path.to_string_lossy(),
                "bytes": metadata.len(),
                "modifiedNanos": modified_nanos(&metadata)?,
            }))
        })
        .transpose()?;
    let metadata_json = serde_json::to_vec_pretty(&json!({
        "device": device,
        "input": input.to_string_lossy(),
        "inputBytes": input_metadata.len(),
        "inputModifiedNanos": modified_nanos(&input_metadata)?,
        "preset": preset.to_string_lossy(),
        "presetBytes": preset_metadata.len(),
        "presetModifiedNanos": modified_nanos(&preset_metadata)?,
        "sidechain": sidechain_metadata,
        "sampleRate": sample_rate,
        "tailSeconds": tail_seconds,
    }))?;
    let cached = fs::read(&metadata_path).is_ok_and(|bytes| bytes == metadata_json)
        && hound::WavReader::open(&output)
            .is_ok_and(|reader| reader.spec().sample_rate == sample_rate && reader.duration() > 0);
    if cached {
        eprintln!(
            "render-graph: reusing cached Ableton effect {}",
            output.display()
        );
        return Ok(output);
    }
    let effect_input = if tail_seconds > 0.0 {
        let padded = cache_dir.join(format!("{cache_id}-tail-input.wav"));
        let mut audio = read_stereo_wav(input, sample_rate)?;
        audio.resize(
            audio.len() + (tail_seconds * f64::from(sample_rate)).ceil() as usize,
            [0.0; 2],
        );
        write_stereo_wav(&padded, sample_rate, &audio)?;
        padded
    } else {
        input.to_owned()
    };
    let effect_sidechain = sidechain
        .map(|sidechain| -> Result<PathBuf> {
            if tail_seconds <= 0.0 {
                return Ok(sidechain.to_owned());
            }
            let padded = cache_dir.join(format!("{cache_id}-tail-sidechain.wav"));
            let mut audio = read_stereo_wav(sidechain, sample_rate)?;
            audio.resize(
                audio.len() + (tail_seconds * f64::from(sample_rate)).ceil() as usize,
                [0.0; 2],
            );
            write_stereo_wav(&padded, sample_rate, &audio)?;
            Ok(padded)
        })
        .transpose()?;
    run_native_effect(
        executable,
        &output,
        device,
        devices_root,
        max_contents,
        sample_rate,
        &effect_input,
        effect_sidechain.as_deref(),
        preset,
    )?;
    fs::write(metadata_path, metadata_json)?;
    Ok(output)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn render(
    manifest_path: &Path,
    output: &Path,
    cache_dir: Option<&Path>,
    device_host: Option<&Path>,
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
    let cache_dir = cache_dir
        .map(absolute_path)
        .transpose()?
        .unwrap_or_else(|| output.with_extension("cache"));
    fs::create_dir_all(&cache_dir)?;
    let stems_dir = stems_dir.map(absolute_path).transpose()?;
    if let Some(stems_dir) = &stems_dir {
        fs::create_dir_all(stems_dir)?;
    }

    let executable = device_host
        .map(absolute_path)
        .transpose()?
        .unwrap_or(std::env::current_exe()?);
    ensure!(
        executable.is_file(),
        "Ableton native device host does not exist: {}",
        executable.display()
    );
    let mut native_sources = HashMap::new();
    for track in &graph.tracks {
        let GraphSource::Native {
            device,
            preset,
            notes,
            clips,
        } = &track.source
        else {
            continue;
        };
        let preset = resolve_path(manifest_directory, preset);
        if clips.is_empty() {
            let sequence = Sequence {
                bpm: graph.bpm,
                bars: graph.bars,
                beats_per_bar: graph.beats_per_bar,
                notes: notes.clone(),
            };
            let source_path = render_native_sequence_cached(
                &executable,
                &track.id,
                &sequence,
                device,
                &preset,
                devices_root,
                graph.sample_rate,
                graph.tail_seconds,
                &cache_dir,
            )?;
            let mut current = source_path;
            for (index, effect) in track.effects.iter().enumerate() {
                let GraphEffect::Native {
                    device,
                    preset,
                    sidechain,
                } = effect
                else {
                    continue;
                };
                current = render_native_effect_cached(
                    &executable,
                    &format!("{}-native-effect-{index}", track.id),
                    &current,
                    device,
                    &resolve_path(manifest_directory, preset),
                    sidechain
                        .as_ref()
                        .map(|path| resolve_path(manifest_directory, path))
                        .as_deref(),
                    devices_root,
                    max_contents,
                    graph.sample_rate,
                    &cache_dir,
                    0.0,
                )?;
            }
            native_sources.insert(track.id.clone(), RenderedNativeSource::Arrangement(current));
        } else {
            let mut rendered_clips = Vec::with_capacity(clips.len());
            for clip in clips {
                let sequence = Sequence {
                    bpm: graph.bpm,
                    bars: (clip.loop_beats / f64::from(graph.beats_per_bar)).ceil() as u32,
                    beats_per_bar: graph.beats_per_bar,
                    notes: clip.notes.clone(),
                };
                let source_path = render_native_sequence_cached(
                    &executable,
                    &format!("{}-clip-{}", track.id, clip.id),
                    &sequence,
                    device,
                    &preset,
                    devices_root,
                    graph.sample_rate,
                    graph.tail_seconds,
                    &cache_dir,
                )?;
                let mut current = source_path;
                for (index, effect) in track.effects.iter().enumerate() {
                    let GraphEffect::Native {
                        device,
                        preset,
                        sidechain,
                    } = effect
                    else {
                        continue;
                    };
                    current = render_native_effect_cached(
                        &executable,
                        &format!("{}-clip-{}-native-effect-{index}", track.id, clip.id),
                        &current,
                        device,
                        &resolve_path(manifest_directory, preset),
                        sidechain
                            .as_ref()
                            .map(|path| resolve_path(manifest_directory, path))
                            .as_deref(),
                        devices_root,
                        max_contents,
                        graph.sample_rate,
                        &cache_dir,
                        0.0,
                    )?;
                }
                rendered_clips.push(RenderedNativeClip {
                    path: current,
                    loop_beats: clip.loop_beats,
                    placements: clip.placements.clone(),
                });
            }
            native_sources.insert(
                track.id.clone(),
                RenderedNativeSource::Clips(rendered_clips),
            );
        }
    }

    let normalized_samples =
        prepare_offline_samples(&graph, manifest_directory, &cache_dir, max_contents)?;
    let sample_sources = render_sample_effects_cached(
        &graph,
        manifest_directory,
        &normalized_samples,
        &executable,
        devices_root,
        max_contents,
        &cache_dir,
    )?;

    let offline_assembly = graph.master.effects.is_empty()
        && graph.tracks.iter().all(|track| {
            !matches!(track.source, GraphSource::MaxObject { .. })
                && track
                    .effects
                    .iter()
                    .all(|effect| matches!(effect, GraphEffect::Native { .. }))
        });
    if offline_assembly {
        eprintln!("render-graph: offline arrangement assembly (placement, gain, pan and sum only)");
        render_offline_arrangement(
            &graph,
            manifest_directory,
            &native_sources,
            &sample_sources,
            &output,
            stems_dir.as_deref(),
        )?;
    } else {
        let patch = build_mix_patch(
            &graph,
            manifest_directory,
            &native_sources,
            &sample_sources,
            &output,
            stems_dir.as_deref(),
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
        ensure!(output.is_file(), "Max did not create {}", output.display());
        if !status.success() {
            eprintln!(
                "render-graph: Max exited with {status} after finalizing {}; accepting the rendered WAV",
                output.display()
            );
        }
    }
    if let Some(stems_dir) = &stems_dir {
        for track in &graph.tracks {
            let stem = stems_dir.join(format!("{}.wav", track.id));
            ensure!(stem.is_file(), "Max did not create stem {}", stem.display());
            ensure!(
                wav_peak(&stem)? > 1.0e-7,
                "Ableton graph rendered silent stem '{}'",
                track.id
            );
        }
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
        cache_dir,
        stems_dir,
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

fn prepare_offline_samples(
    graph: &AbletonGraph,
    base: &Path,
    stems_dir: &Path,
    max_contents: &Path,
) -> Result<HashMap<PathBuf, PathBuf>> {
    struct Conversion {
        source: PathBuf,
        output: PathBuf,
        channels: u16,
        duration_ms: f64,
        metadata_path: PathBuf,
        metadata_json: Vec<u8>,
    }

    let mut sources = Vec::new();
    let mut seen = HashSet::new();
    for track in &graph.tracks {
        let GraphSource::Sample { sample, .. } = &track.source else {
            continue;
        };
        let source = resolve_path(base, sample);
        if seen.insert(source.clone()) {
            sources.push(source);
        }
    }

    let mut prepared = HashMap::new();
    let mut conversions = Vec::new();
    for (source_index, source) in sources.into_iter().enumerate() {
        let decoded = decode_audio_file_with_channels(&source)
            .with_context(|| format!("failed to inspect {}", source.display()))?;
        let source_info = decoded.source();
        ensure!(
            matches!(source_info.channels(), 1 | 2),
            "{} must be mono or stereo",
            source.display()
        );
        let directly_readable = hound::WavReader::open(&source)
            .is_ok_and(|reader| reader.spec().sample_rate == graph.sample_rate);
        if directly_readable {
            prepared.insert(source.clone(), source);
            continue;
        }
        let output = stems_dir.join(format!(".offline-sample-{source_index}.wav"));
        let metadata_path = stems_dir.join(format!(".offline-sample-{source_index}.json"));
        let duration_ms =
            source_info.decoded_frames() as f64 * 1_000.0 / f64::from(source_info.sample_rate());
        let source_metadata = fs::metadata(&source)?;
        let modified_nanos = source_metadata
            .modified()?
            .duration_since(UNIX_EPOCH)?
            .as_nanos()
            .to_string();
        let metadata_json = serde_json::to_vec_pretty(&json!({
            "source": source.to_string_lossy(),
            "sourceBytes": source_metadata.len(),
            "sourceModifiedNanos": modified_nanos,
            "targetSampleRate": graph.sample_rate,
        }))?;
        prepared.insert(source.clone(), output.clone());
        if fs::read(&metadata_path).is_ok_and(|bytes| bytes == metadata_json)
            && hound::WavReader::open(&output).is_ok_and(|reader| {
                reader.spec().sample_rate == graph.sample_rate && reader.duration() > 0
            })
        {
            continue;
        }
        conversions.push(Conversion {
            source,
            output,
            channels: u16::try_from(source_info.channels())?,
            duration_ms,
            metadata_path,
            metadata_json,
        });
    }
    if conversions.is_empty() {
        return Ok(prepared);
    }

    eprintln!(
        "render-graph: normalizing {} factory samples through Ableton Max",
        conversions.len()
    );
    let max_binary = max_contents.join("MacOS/Max");
    ensure!(
        max_binary.is_file(),
        "Ableton bundled Max runtime is missing"
    );
    let mut boxes = Vec::new();
    let mut lines = Vec::new();
    add_box(&mut boxes, "load", "newobj", "loadbang");
    add_realtime_dsp_start(&mut boxes, &mut lines);
    add_box(&mut boxes, "start-delay", "newobj", "delay 1500");
    add_box(&mut boxes, "start", "newobj", "t b b");
    add_line(&mut lines, "load", 0, "start-delay", 0);
    add_line(&mut lines, "start-delay", 0, "start", 0);
    add_box(&mut boxes, "record-start", "message", "1");
    add_box(&mut boxes, "play", "message", "1");
    add_line(&mut lines, "start", 1, "record-start", 0);
    add_line(&mut lines, "start", 0, "play", 0);
    let duration_ms = conversions
        .iter()
        .map(|conversion| conversion.duration_ms)
        .fold(0.0_f64, f64::max)
        + 100.0;
    add_audio_timed_stop(&mut boxes, &mut lines, duration_ms, 500);
    for (index, conversion) in conversions.iter().enumerate() {
        let player = format!("normalize-player-{index}");
        let open = format!("normalize-open-{index}");
        add_box(&mut boxes, &player, "newobj", "sfplay~ 2");
        add_box(
            &mut boxes,
            &open,
            "message",
            &format!("open \"{}\"", max_path(&conversion.source)),
        );
        add_line(&mut lines, "load", 0, &open, 0);
        add_line(&mut lines, &open, 0, &player, 0);
        add_line(&mut lines, "play", 0, &player, 0);
        let recorder = format!("normalize-{index}");
        add_recorder(
            &mut boxes,
            &mut lines,
            &recorder,
            &conversion.output,
            "record-start",
            "record-stop",
        );
        add_line(&mut lines, &player, 0, &format!("{recorder}-recorder"), 0);
        add_line(
            &mut lines,
            &player,
            if conversion.channels > 1 { 1 } else { 0 },
            &format!("{recorder}-recorder"),
            1,
        );
    }
    let patch = json!({
        "patcher": {
            "fileversion": 1,
            "appversion": {"major": 9, "minor": 0, "revision": 5, "architecture": "x64", "modernui": 1},
            "classnamespace": "box",
            "rect": [0.0, 0.0, 1400.0, 900.0],
            "boxes": boxes,
            "lines": lines
        }
    });
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let patch_path = std::env::temp_dir().join(format!(
        "djbooth-ableton-normalize-{}-{nonce}.maxpat",
        std::process::id()
    ));
    fs::write(&patch_path, serde_json::to_vec_pretty(&patch)?)?;
    let _max_lock = crate::ableton::acquire_max_runtime_lock()?;
    let status = Command::new(&max_binary)
        .arg("--nocef")
        .arg(&patch_path)
        .status()?;
    let _ = fs::remove_file(&patch_path);
    for conversion in &conversions {
        let reader = hound::WavReader::open(&conversion.output).with_context(|| {
            format!(
                "Ableton Max did not finalize {}",
                conversion.output.display()
            )
        })?;
        ensure!(
            reader.spec().sample_rate == graph.sample_rate && reader.duration() > 0,
            "Ableton Max created an invalid normalized sample {}",
            conversion.output.display()
        );
        fs::write(&conversion.metadata_path, &conversion.metadata_json)?;
    }
    if !status.success() {
        eprintln!("render-graph: Max exited with {status} after finalizing normalized samples");
    }
    Ok(prepared)
}

#[allow(clippy::too_many_arguments)]
fn render_sample_effects_cached(
    graph: &AbletonGraph,
    base: &Path,
    normalized_samples: &HashMap<PathBuf, PathBuf>,
    executable: &Path,
    devices_root: &Path,
    max_contents: &Path,
    cache_dir: &Path,
) -> Result<HashMap<String, PathBuf>> {
    let mut rendered = HashMap::new();
    for track in &graph.tracks {
        let GraphSource::Sample { sample, .. } = &track.source else {
            continue;
        };
        let source = resolve_path(base, sample);
        let mut current = normalized_samples
            .get(&source)
            .with_context(|| format!("normalized sample missing for {}", source.display()))?
            .clone();
        let last_native_effect = track
            .effects
            .iter()
            .rposition(|effect| matches!(effect, GraphEffect::Native { .. }));
        for (index, effect) in track.effects.iter().enumerate() {
            let GraphEffect::Native {
                device,
                preset,
                sidechain,
            } = effect
            else {
                continue;
            };
            current = render_native_effect_cached(
                executable,
                &format!("{}-sample-native-effect-{index}", track.id),
                &current,
                device,
                &resolve_path(base, preset),
                sidechain
                    .as_ref()
                    .map(|path| resolve_path(base, path))
                    .as_deref(),
                devices_root,
                max_contents,
                graph.sample_rate,
                cache_dir,
                if Some(index) == last_native_effect {
                    graph.tail_seconds
                } else {
                    0.0
                },
            )?;
        }
        rendered.insert(track.id.clone(), current);
    }
    Ok(rendered)
}

fn beat_to_frame(beat: f64, bpm: f64, sample_rate: u32) -> usize {
    (beat * 60.0 / bpm * f64::from(sample_rate)).round() as usize
}

fn read_native_stereo_wav(path: &Path, sample_rate: u32) -> Result<Vec<[f32; 2]>> {
    let mut audio = read_stereo_wav(path, sample_rate)?;
    if !audio.iter().any(|frame| frame[1].abs() > 1.0e-7) {
        for frame in &mut audio {
            frame[1] = frame[0];
        }
    }
    Ok(audio)
}

fn render_streamed_master(
    graph: &AbletonGraph,
    _base: &Path,
    native_sources: &HashMap<String, RenderedNativeSource>,
    sample_sources: &HashMap<String, PathBuf>,
    output: &Path,
) -> Result<()> {
    let duration_seconds =
        f64::from(graph.bars * graph.beats_per_bar) * 60.0 / graph.bpm + graph.tail_seconds;
    let total_frames = (duration_seconds * f64::from(graph.sample_rate)).ceil() as usize;
    let mut track_voices = Vec::with_capacity(graph.tracks.len());
    let mut sample_audio = HashMap::<PathBuf, Arc<Vec<[f32; 2]>>>::new();

    for track in &graph.tracks {
        let mut voices = Vec::new();
        let gain = 10.0_f64.powf(track.gain_db / 20.0);
        let angle = (track.pan + 1.0) * FRAC_PI_4;
        let left_gain = (gain * angle.cos()) as f32;
        let right_gain = (gain * angle.sin()) as f32;
        match &track.source {
            GraphSource::Native { .. } => {
                let source = native_sources
                    .get(&track.id)
                    .with_context(|| format!("native source missing for {}", track.id))?;
                match source {
                    RenderedNativeSource::Arrangement(source_path) => {
                        let audio =
                            Arc::new(read_native_stereo_wav(source_path, graph.sample_rate)?);
                        voices.push(OfflineVoice {
                            end: total_frames.min(audio.len()),
                            audio,
                            start: 0,
                            left_gain,
                            right_gain,
                        });
                    }
                    RenderedNativeSource::Clips(clips) => {
                        for clip in clips {
                            let audio =
                                Arc::new(read_native_stereo_wav(&clip.path, graph.sample_rate)?);
                            for placement in &clip.placements {
                                let cycles = ((placement.end_beat - placement.start_beat)
                                    / clip.loop_beats)
                                    .ceil() as usize;
                                for cycle in 0..cycles {
                                    let start_beat =
                                        placement.start_beat + cycle as f64 * clip.loop_beats;
                                    if start_beat >= placement.end_beat {
                                        continue;
                                    }
                                    let start =
                                        beat_to_frame(start_beat, graph.bpm, graph.sample_rate);
                                    if start >= total_frames {
                                        continue;
                                    }
                                    voices.push(OfflineVoice {
                                        end: total_frames.min(start.saturating_add(audio.len())),
                                        audio: Arc::clone(&audio),
                                        start,
                                        left_gain,
                                        right_gain,
                                    });
                                }
                            }
                        }
                    }
                }
            }
            GraphSource::Sample {
                sample: _,
                triggers,
                loop_beats,
                placements,
                velocity_amount,
            } => {
                let prepared_path = sample_sources
                    .get(&track.id)
                    .with_context(|| format!("sample source missing for {}", track.id))?;
                let audio = if let Some(audio) = sample_audio.get(prepared_path) {
                    Arc::clone(audio)
                } else {
                    let audio = Arc::new(read_stereo_wav(prepared_path, graph.sample_rate)?);
                    sample_audio.insert(prepared_path.clone(), Arc::clone(&audio));
                    audio
                };
                let scheduled = if let Some(loop_beats) = loop_beats {
                    placements
                        .iter()
                        .flat_map(|placement| {
                            let cycles = ((placement.end_beat - placement.start_beat) / loop_beats)
                                .ceil() as usize;
                            (0..cycles).flat_map(move |cycle| {
                                let cycle_start = placement.start_beat + cycle as f64 * loop_beats;
                                triggers.iter().filter_map(move |trigger| {
                                    let beat = cycle_start + trigger.beat;
                                    (beat < placement.end_beat).then_some(GraphTrigger {
                                        beat,
                                        velocity: trigger.velocity,
                                    })
                                })
                            })
                        })
                        .collect::<Vec<_>>()
                } else {
                    triggers.clone()
                };
                let starts = scheduled
                    .iter()
                    .map(|trigger| beat_to_frame(trigger.beat, graph.bpm, graph.sample_rate))
                    .collect::<Vec<_>>();
                let mut next_voice_start = [total_frames; SAMPLE_VOICE_COUNT];
                let mut voice_ends = vec![total_frames; scheduled.len()];
                for index in (0..scheduled.len()).rev() {
                    let voice = sample_voice_index(index);
                    voice_ends[index] = next_voice_start[voice];
                    next_voice_start[voice] = starts[index];
                }
                for (index, trigger) in scheduled.iter().enumerate() {
                    let start = starts[index];
                    if start >= total_frames {
                        continue;
                    }
                    let velocity_gain = ((1.0 - velocity_amount)
                        + velocity_amount * f64::from(trigger.velocity) / 127.0)
                        as f32;
                    voices.push(OfflineVoice {
                        end: total_frames
                            .min(voice_ends[index])
                            .min(start.saturating_add(audio.len())),
                        audio: Arc::clone(&audio),
                        start,
                        left_gain: left_gain * velocity_gain,
                        right_gain: right_gain * velocity_gain,
                    });
                }
            }
            GraphSource::MaxObject { .. } => {
                anyhow::bail!("Max instrument cannot use offline arrangement assembly")
            }
        }
        track_voices.push(voices);
    }

    let mut writer = hound::WavWriter::create(
        output,
        hound::WavSpec {
            channels: 2,
            sample_rate: graph.sample_rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        },
    )
    .with_context(|| format!("failed to create {}", output.display()))?;
    let master_gain =
        10.0_f32.powf(((graph.master.input_gain_db + graph.master.output_gain_db) / 20.0) as f32);
    for block_start in (0..total_frames).step_by(OFFLINE_BLOCK_FRAMES) {
        let block_end = total_frames.min(block_start + OFFLINE_BLOCK_FRAMES);
        let mut block = vec![[0.0_f32; 2]; block_end - block_start];
        for voices in &track_voices {
            for voice in voices {
                if voice.start >= block_end || voice.end <= block_start {
                    continue;
                }
                let overlap_start = block_start.max(voice.start);
                let overlap_end = block_end.min(voice.end);
                for destination in overlap_start..overlap_end {
                    let source = voice.audio[destination - voice.start];
                    let block_frame = &mut block[destination - block_start];
                    block_frame[0] += source[0] * voice.left_gain;
                    block_frame[1] += source[1] * voice.right_gain;
                }
            }
        }
        for frame in block {
            writer.write_sample(frame[0] * master_gain)?;
            writer.write_sample(frame[1] * master_gain)?;
        }
    }
    writer.finalize()?;
    Ok(())
}

fn render_offline_arrangement(
    graph: &AbletonGraph,
    base: &Path,
    native_sources: &HashMap<String, RenderedNativeSource>,
    sample_sources: &HashMap<String, PathBuf>,
    output: &Path,
    stems_dir: Option<&Path>,
) -> Result<()> {
    if stems_dir.is_none() {
        return render_streamed_master(graph, base, native_sources, sample_sources, output);
    }
    let duration_seconds =
        f64::from(graph.bars * graph.beats_per_bar) * 60.0 / graph.bpm + graph.tail_seconds;
    let total_frames = (duration_seconds * f64::from(graph.sample_rate)).ceil() as usize;
    let mut master = vec![[0.0_f32; 2]; total_frames];

    for track in &graph.tracks {
        let gain = 10.0_f64.powf(track.gain_db / 20.0);
        let angle = (track.pan + 1.0) * FRAC_PI_4;
        let left_gain = (gain * angle.cos()) as f32;
        let right_gain = (gain * angle.sin()) as f32;
        let mut frames = vec![[0.0_f32; 2]; total_frames];
        match &track.source {
            GraphSource::Native { .. } => {
                let source = native_sources
                    .get(&track.id)
                    .with_context(|| format!("native source missing for {}", track.id))?;
                match source {
                    RenderedNativeSource::Arrangement(source_path) => {
                        let mut source = read_stereo_wav(source_path, graph.sample_rate)?;
                        if !source.iter().any(|frame| frame[1].abs() > 1.0e-7) {
                            for frame in &mut source {
                                frame[1] = frame[0];
                            }
                        }
                        for (destination, source) in frames.iter_mut().zip(source) {
                            destination[0] = source[0] * left_gain;
                            destination[1] = source[1] * right_gain;
                        }
                    }
                    RenderedNativeSource::Clips(clips) => {
                        for clip in clips {
                            let mut source = read_stereo_wav(&clip.path, graph.sample_rate)?;
                            if !source.iter().any(|frame| frame[1].abs() > 1.0e-7) {
                                for frame in &mut source {
                                    frame[1] = frame[0];
                                }
                            }
                            for placement in &clip.placements {
                                let cycles = ((placement.end_beat - placement.start_beat)
                                    / clip.loop_beats)
                                    .ceil() as usize;
                                for cycle in 0..cycles {
                                    let start_beat =
                                        placement.start_beat + cycle as f64 * clip.loop_beats;
                                    if start_beat >= placement.end_beat {
                                        continue;
                                    }
                                    let start = (start_beat * 60.0 / graph.bpm
                                        * f64::from(graph.sample_rate))
                                    .round()
                                        as usize;
                                    let end = total_frames.min(start.saturating_add(source.len()));
                                    for destination in start..end {
                                        let source = source[destination - start];
                                        frames[destination][0] += source[0] * left_gain;
                                        frames[destination][1] += source[1] * right_gain;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            GraphSource::Sample {
                sample: _,
                triggers,
                loop_beats,
                placements,
                velocity_amount,
            } => {
                let prepared_path = sample_sources
                    .get(&track.id)
                    .with_context(|| format!("sample source missing for {}", track.id))?;
                let sample = read_stereo_wav(prepared_path, graph.sample_rate)?;
                let scheduled = if let Some(loop_beats) = loop_beats {
                    placements
                        .iter()
                        .flat_map(|placement| {
                            let cycles = ((placement.end_beat - placement.start_beat) / loop_beats)
                                .ceil() as usize;
                            (0..cycles).flat_map(move |cycle| {
                                let cycle_start = placement.start_beat + cycle as f64 * loop_beats;
                                triggers.iter().filter_map(move |trigger| {
                                    let beat = cycle_start + trigger.beat;
                                    (beat < placement.end_beat).then_some(GraphTrigger {
                                        beat,
                                        velocity: trigger.velocity,
                                    })
                                })
                            })
                        })
                        .collect::<Vec<_>>()
                } else {
                    triggers.clone()
                };
                let starts = scheduled
                    .iter()
                    .map(|trigger| {
                        (trigger.beat * 60.0 / graph.bpm * f64::from(graph.sample_rate)).round()
                            as usize
                    })
                    .collect::<Vec<_>>();
                let mut next_voice_start = [total_frames; SAMPLE_VOICE_COUNT];
                let mut voice_ends = vec![total_frames; scheduled.len()];
                for index in (0..scheduled.len()).rev() {
                    let voice = sample_voice_index(index);
                    voice_ends[index] = next_voice_start[voice];
                    next_voice_start[voice] = starts[index];
                }
                for (index, trigger) in scheduled.iter().enumerate() {
                    let start = starts[index];
                    if start >= total_frames {
                        continue;
                    }
                    let end = total_frames
                        .min(voice_ends[index])
                        .min(start.saturating_add(sample.len()));
                    let velocity_gain = ((1.0 - velocity_amount)
                        + velocity_amount * f64::from(trigger.velocity) / 127.0)
                        as f32;
                    for destination_frame in start..end {
                        let source = sample[destination_frame - start];
                        frames[destination_frame][0] += source[0] * velocity_gain * left_gain;
                        frames[destination_frame][1] += source[1] * velocity_gain * right_gain;
                    }
                }
            }
            GraphSource::MaxObject { .. } => {
                anyhow::bail!("Max instrument cannot use offline arrangement assembly")
            }
        }
        for (master, track) in master.iter_mut().zip(&frames) {
            master[0] += track[0];
            master[1] += track[1];
        }
        if let Some(stems_dir) = stems_dir {
            write_stereo_wav(
                &stems_dir.join(format!("{}.wav", track.id)),
                graph.sample_rate,
                &frames,
            )?;
        }
    }

    let master_gain =
        10.0_f32.powf(((graph.master.input_gain_db + graph.master.output_gain_db) / 20.0) as f32);
    for frame in &mut master {
        frame[0] *= master_gain;
        frame[1] *= master_gain;
    }
    write_stereo_wav(output, graph.sample_rate, &master)
}

fn read_stereo_wav(path: &Path, sample_rate: u32) -> Result<Vec<[f32; 2]>> {
    let mut reader = hound::WavReader::open(path)
        .with_context(|| format!("failed to read {}", path.display()))?;
    let spec = reader.spec();
    ensure!(
        spec.sample_rate == sample_rate,
        "{} is {} Hz; expected {sample_rate} Hz",
        path.display(),
        spec.sample_rate
    );
    ensure!(
        matches!(spec.channels, 1 | 2),
        "{} must be mono or stereo",
        path.display()
    );
    let samples = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<std::result::Result<Vec<_>, _>>()?,
        hound::SampleFormat::Int => {
            let scale = (1_i64 << (u32::from(spec.bits_per_sample) - 1)) as f32;
            reader
                .samples::<i32>()
                .map(|sample| sample.map(|value| value as f32 / scale))
                .collect::<std::result::Result<Vec<_>, _>>()?
        }
    };
    let channels = usize::from(spec.channels);
    Ok(samples
        .chunks_exact(channels)
        .map(|frame| {
            if channels == 1 {
                [frame[0], frame[0]]
            } else {
                [frame[0], frame[1]]
            }
        })
        .collect())
}

fn write_stereo_wav(path: &Path, sample_rate: u32, frames: &[[f32; 2]]) -> Result<()> {
    let mut writer = hound::WavWriter::create(
        path,
        hound::WavSpec {
            channels: 2,
            sample_rate,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        },
    )
    .with_context(|| format!("failed to create {}", path.display()))?;
    for frame in frames {
        writer.write_sample(frame[0])?;
        writer.write_sample(frame[1])?;
    }
    writer.finalize()?;
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
    add_realtime_dsp_start(&mut boxes, &mut lines);
    add_box(&mut boxes, "start-delay", "newobj", "delay 1500");
    add_box(&mut boxes, "start", "newobj", "t b b");
    add_line(&mut lines, "load", 0, "start-delay", 0);
    add_line(&mut lines, "start-delay", 0, "start", 0);
    add_box(&mut boxes, "record-start", "message", "1");
    add_box(&mut boxes, "play", "message", "1");
    add_line(&mut lines, "start", 1, "record-start", 0);
    add_line(&mut lines, "start", 0, "play", 0);
    add_audio_timed_stop(&mut boxes, &mut lines, duration_ms, 500);
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
        output.is_file(),
        "Ableton Max branch mixer created no output"
    );
    let reader = hound::WavReader::open(output).with_context(|| {
        format!(
            "Ableton Max branch mixer did not finalize {}",
            output.display()
        )
    })?;
    ensure!(
        reader.duration() > 0,
        "Ableton Max branch mixer created an empty WAV"
    );
    if !status.success() {
        eprintln!(
            "sum-audio: Max exited with {status} after finalizing {}; accepting the rendered WAV",
            output.display()
        );
    }
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
            GraphSource::Native {
                preset,
                notes,
                clips,
                ..
            } => {
                ensure!(
                    resolve_path(base, preset).is_file(),
                    "missing preset {}",
                    preset.display()
                );
                ensure!(
                    notes.is_empty() != clips.is_empty(),
                    "track '{}' must provide either arrangement notes or MIDI clips",
                    track.id
                );
                if clips.is_empty() {
                    validate_sequence(&Sequence {
                        bpm: graph.bpm,
                        bars: graph.bars,
                        beats_per_bar: graph.beats_per_bar,
                        notes: notes.clone(),
                    })?;
                } else {
                    ensure!(
                        track
                            .effects
                            .iter()
                            .all(|effect| matches!(effect, GraphEffect::Native { .. })),
                        "track '{}' MIDI clips require cacheable standalone native effects",
                        track.id
                    );
                    let mut clip_ids = HashSet::new();
                    for clip in clips {
                        ensure!(
                            !clip.id.is_empty()
                                && clip
                                    .id
                                    .chars()
                                    .all(|character| character.is_ascii_alphanumeric()
                                        || "-_".contains(character)),
                            "track '{}' has an invalid MIDI clip ID",
                            track.id
                        );
                        ensure!(
                            clip_ids.insert(&clip.id),
                            "track '{}' has duplicate MIDI clip '{}'",
                            track.id,
                            clip.id
                        );
                        ensure!(
                            clip.loop_beats.is_finite() && clip.loop_beats > 0.0,
                            "track '{}' clip '{}' loopBeats must be positive",
                            track.id,
                            clip.id
                        );
                        let bars = (clip.loop_beats / f64::from(graph.beats_per_bar)).ceil() as u32;
                        validate_sequence(&Sequence {
                            bpm: graph.bpm,
                            bars,
                            beats_per_bar: graph.beats_per_bar,
                            notes: clip.notes.clone(),
                        })?;
                        for placement in &clip.placements {
                            ensure!(
                                placement.start_beat.is_finite()
                                    && placement.end_beat.is_finite()
                                    && placement.start_beat >= 0.0
                                    && placement.end_beat > placement.start_beat
                                    && placement.end_beat <= total_beats,
                                "track '{}' clip '{}' has an invalid placement",
                                track.id,
                                clip.id
                            );
                        }
                    }
                }
            }
            GraphSource::Sample {
                sample,
                triggers,
                loop_beats,
                placements,
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
                ensure!(
                    loop_beats.is_some() != placements.is_empty(),
                    "track '{}' must provide loopBeats and placements together",
                    track.id
                );
                let trigger_limit = loop_beats.unwrap_or(total_beats);
                if let Some(loop_beats) = loop_beats {
                    ensure!(
                        loop_beats.is_finite() && *loop_beats > 0.0,
                        "track '{}' loopBeats must be positive",
                        track.id
                    );
                }
                for trigger in triggers {
                    ensure!(
                        trigger.beat.is_finite()
                            && trigger.beat >= 0.0
                            && trigger.beat < trigger_limit,
                        "track '{}' has a trigger outside its {}",
                        track.id,
                        if loop_beats.is_some() {
                            "clip loop"
                        } else {
                            "arrangement"
                        }
                    );
                    ensure!(
                        trigger.velocity > 0 && trigger.velocity <= 127,
                        "invalid trigger velocity"
                    );
                }
                for placement in placements {
                    ensure!(
                        placement.start_beat.is_finite()
                            && placement.end_beat.is_finite()
                            && placement.start_beat >= 0.0
                            && placement.end_beat > placement.start_beat
                            && placement.end_beat <= total_beats,
                        "track '{}' has an invalid clip placement",
                        track.id
                    );
                }
                if let Some(loop_beats) = loop_beats {
                    let anchor = placements[0].start_beat;
                    for placement in placements.iter().skip(1) {
                        let phase = (placement.start_beat - anchor).rem_euclid(*loop_beats);
                        ensure!(
                            phase < 1.0e-6 || (*loop_beats - phase) < 1.0e-6,
                            "track '{}' clip placements must share one loop phase",
                            track.id
                        );
                    }
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
        let standalone_audio_source = matches!(
            track.source,
            GraphSource::Native { .. } | GraphSource::Sample { .. }
        );
        let mut entered_max_chain = false;
        for effect in &track.effects {
            match effect {
                GraphEffect::Native {
                    device,
                    preset,
                    sidechain,
                } => {
                    ensure!(
                        standalone_audio_source,
                        "track '{}' can use standalone native effects only after a native or sample source",
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
                    if let Some(sidechain) = sidechain {
                        ensure!(
                            resolve_path(base, sidechain).is_file(),
                            "missing effect sidechain {}",
                            sidechain.display()
                        );
                        ensure!(
                            crate::ableton::live_engine_processor_for_family(device).is_some(),
                            "effect '{}' does not expose a recovered Live Engine sidechain path",
                            device
                        );
                    }
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

#[allow(clippy::too_many_arguments)]
fn run_native_effect(
    executable: &Path,
    output: &Path,
    device: &str,
    devices_root: &Path,
    max_contents: &Path,
    sample_rate: u32,
    input: &Path,
    sidechain: Option<&Path>,
    preset: &Path,
) -> Result<()> {
    if let Some(sidechain) = sidechain {
        ensure!(
            sample_rate == 44_100,
            "Ableton Live Engine sidechains currently require 44.1 kHz audio"
        );
        let processor = crate::ableton::live_engine_processor_for_family(device)
            .with_context(|| format!("Ableton {device} has no recovered Live Engine processor"))?;
        let status = Command::new(executable)
            .args(["ableton", "probe-live-engine", "--bootstrap", "--processor"])
            .arg(processor)
            .arg("--construct")
            .arg("--input")
            .arg(input)
            .arg("--sidechain")
            .arg(sidechain)
            .arg("--preset")
            .arg(preset)
            .arg("--output")
            .arg(output)
            .status()
            .context("failed to start Ableton Live Engine sidechain renderer")?;
        ensure!(
            status.success(),
            "Ableton Live Engine sidechain renderer exited with {status}"
        );
        return Ok(());
    }
    if matches!(device, "Amp" | "Cabinet" | "Corpus") {
        return run_native(
            executable,
            output,
            device,
            devices_root,
            sample_rate,
            None,
            Some(input),
            Some(preset),
            0.0,
        );
    }

    ensure!(
        sample_rate == 44_100,
        "Ableton Live Engine effects currently require 44.1 kHz audio"
    );
    let status = Command::new(executable)
        .arg("ableton")
        .arg("render-audio-rack")
        .arg(preset)
        .arg(input)
        .arg(output)
        .arg("--devices-root")
        .arg(devices_root)
        .arg("--max-contents")
        .arg(max_contents)
        .status()
        .context("failed to start Ableton Live Engine effect renderer")?;
    ensure!(
        status.success(),
        "Ableton Live Engine effect renderer exited with {status}"
    );
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn add_sample_trigger(
    boxes: &mut Vec<Value>,
    lines: &mut Vec<Value>,
    prefix: &str,
    source: &str,
    index: usize,
    trigger: &GraphTrigger,
    velocity_amount: f64,
    beat_signal: &str,
    active_signal: Option<&str>,
) {
    let event_at = format!("{prefix}-event-{index}-at");
    let event_before_end = format!("{prefix}-event-{index}-before-end");
    let event_window = format!("{prefix}-event-{index}-window");
    let event_gated = format!("{prefix}-event-{index}-gated");
    let event_edge = format!("{prefix}-event-{index}-edge");
    let fire = format!("{prefix}-fire-{index}");
    let amplitude = format!("{prefix}-amplitude-{index}");
    let start = format!("{prefix}-sample-start-{index}");
    let voice = sample_voice_index(index);
    let player = format!("{source}-voice-{voice}");
    let velocity_left = format!("{prefix}-voice-{voice}-velocity-left");
    let velocity_right = format!("{prefix}-voice-{voice}-velocity-right");
    add_box(
        boxes,
        &event_at,
        "newobj",
        &format!(">=~ {:.9}", trigger.beat),
    );
    add_box(
        boxes,
        &event_before_end,
        "newobj",
        &format!("<~ {:.9}", trigger.beat + 0.005),
    );
    add_box(boxes, &event_window, "newobj", "*~");
    add_line(lines, beat_signal, 0, &event_at, 0);
    add_line(lines, beat_signal, 0, &event_before_end, 0);
    add_line(lines, &event_at, 0, &event_window, 0);
    add_line(lines, &event_before_end, 0, &event_window, 1);
    let edge_input = if let Some(active_signal) = active_signal {
        add_box(boxes, &event_gated, "newobj", "*~");
        add_line(lines, &event_window, 0, &event_gated, 0);
        add_line(lines, active_signal, 0, &event_gated, 1);
        event_gated.as_str()
    } else {
        event_window.as_str()
    };
    add_box(boxes, &event_edge, "newobj", "edge~");
    add_line(lines, edge_input, 0, &event_edge, 0);
    add_box(boxes, &fire, "newobj", "t b b");
    let velocity_gain =
        (1.0 - velocity_amount) + velocity_amount * f64::from(trigger.velocity) / 127.0;
    add_box(boxes, &amplitude, "message", &format!("{velocity_gain:.8}"));
    add_box(boxes, &start, "message", "1");
    add_line(lines, &event_edge, 0, &fire, 0);
    add_line(lines, &fire, 1, &amplitude, 0);
    add_line(lines, &fire, 0, &start, 0);
    add_line(lines, &start, 0, &player, 0);
    add_line(lines, &amplitude, 0, &velocity_left, 1);
    add_line(lines, &amplitude, 0, &velocity_right, 1);
}

fn build_mix_patch(
    graph: &AbletonGraph,
    base: &Path,
    native_sources: &HashMap<String, RenderedNativeSource>,
    sample_sources: &HashMap<String, PathBuf>,
    output: &Path,
    stems_dir: Option<&Path>,
    max_contents: &Path,
) -> Result<Value> {
    let mut boxes = Vec::new();
    let mut lines = Vec::new();
    add_box(&mut boxes, "load", "newobj", "loadbang");
    add_realtime_dsp_start(&mut boxes, &mut lines);
    add_box(&mut boxes, "start-delay", "newobj", "delay 1500");
    add_box(&mut boxes, "start", "newobj", "t b b");
    add_line(&mut lines, "load", 0, "start-delay", 0);
    add_line(&mut lines, "start-delay", 0, "start", 0);
    add_box(&mut boxes, "record-start", "message", "1");
    add_line(&mut lines, "start", 1, "record-start", 0);

    let duration_ms = f64::from(graph.bars * graph.beats_per_bar) * 60_000.0 / graph.bpm
        + graph.tail_seconds * 1_000.0;
    add_audio_timed_stop(&mut boxes, &mut lines, duration_ms, 750);

    let arrangement_beats = f64::from(graph.bars * graph.beats_per_bar);
    let arrangement_duration_ms = arrangement_beats * 60_000.0 / graph.bpm;
    add_box(&mut boxes, "arrangement-reset", "message", "-1.");
    add_box(
        &mut boxes,
        "arrangement-run",
        "message",
        &format!("0., {arrangement_beats:.9} {arrangement_duration_ms:.3}"),
    );
    add_box(&mut boxes, "arrangement-beat", "newobj", "line~");
    add_line(&mut lines, "load", 0, "arrangement-reset", 0);
    add_line(&mut lines, "arrangement-reset", 0, "arrangement-beat", 0);
    add_line(&mut lines, "start", 0, "arrangement-run", 0);
    add_line(&mut lines, "arrangement-run", 0, "arrangement-beat", 0);

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
                let rendered = native_sources
                    .get(prefix)
                    .with_context(|| format!("native source missing for {prefix}"))?;
                let RenderedNativeSource::Arrangement(path) = rendered else {
                    anyhow::bail!(
                        "native MIDI clips currently require offline arrangement assembly"
                    )
                };
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
                sample: _,
                triggers,
                loop_beats,
                placements,
                velocity_amount,
            } => {
                let sample = sample_sources
                    .get(prefix)
                    .with_context(|| format!("sample source missing for {prefix}"))?;
                let source_right_outlet = if audio_channels(sample)? > 1 { 1 } else { 0 };
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
                        &format!("open \"{}\"", max_path(sample)),
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
                let timing = if let Some(loop_beats) = loop_beats {
                    let anchor = placements[0].start_beat;
                    let local_beat = format!("{prefix}-clip-local-beat");
                    let loop_phase = format!("{prefix}-clip-loop-phase");
                    let active_sum = format!("{prefix}-clip-active-sum");
                    let active = format!("{prefix}-clip-active");
                    add_box(
                        &mut boxes,
                        &local_beat,
                        "newobj",
                        &format!("-~ {anchor:.9}"),
                    );
                    add_box(
                        &mut boxes,
                        &loop_phase,
                        "newobj",
                        &format!("%~ {loop_beats:.9}"),
                    );
                    add_box(&mut boxes, &active_sum, "newobj", "+~ 0.");
                    add_box(&mut boxes, &active, "newobj", ">~ 0.");
                    add_line(&mut lines, "arrangement-beat", 0, &local_beat, 0);
                    add_line(&mut lines, &local_beat, 0, &loop_phase, 0);
                    add_line(&mut lines, &active_sum, 0, &active, 0);
                    for (placement_index, placement) in placements.iter().enumerate() {
                        let after_start =
                            format!("{prefix}-placement-{placement_index}-after-start");
                        let before_end = format!("{prefix}-placement-{placement_index}-before-end");
                        let window = format!("{prefix}-placement-{placement_index}-window");
                        add_box(
                            &mut boxes,
                            &after_start,
                            "newobj",
                            &format!(">=~ {:.9}", placement.start_beat),
                        );
                        add_box(
                            &mut boxes,
                            &before_end,
                            "newobj",
                            &format!("<~ {:.9}", placement.end_beat),
                        );
                        add_box(&mut boxes, &window, "newobj", "*~");
                        add_line(&mut lines, "arrangement-beat", 0, &after_start, 0);
                        add_line(&mut lines, "arrangement-beat", 0, &before_end, 0);
                        add_line(&mut lines, &after_start, 0, &window, 0);
                        add_line(&mut lines, &before_end, 0, &window, 1);
                        add_line(&mut lines, &window, 0, &active_sum, 0);
                    }
                    (loop_phase, Some(active))
                } else {
                    ("arrangement-beat".to_owned(), None)
                };
                for (index, trigger) in triggers.iter().enumerate() {
                    add_sample_trigger(
                        &mut boxes,
                        &mut lines,
                        prefix,
                        &source,
                        index,
                        trigger,
                        *velocity_amount,
                        &timing.0,
                        timing.1.as_deref(),
                    );
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

        if let Some(stems_dir) = stems_dir {
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
        }
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

fn add_realtime_dsp_start(boxes: &mut Vec<Value>, lines: &mut Vec<Value>) {
    // Max's timing objects only preserve their scheduler timestamps at audio
    // rate when Overdrive and Scheduler in Audio Interrupt are both enabled.
    // `trigger` fires right-to-left, so configure both before starting DSP.
    add_box(boxes, "dsp-configure", "newobj", "t b b b");
    add_box(boxes, "dsp-overdrive", "message", "; max preempt 1");
    add_box(boxes, "dsp-takeover", "message", "; dsp takeover 1");
    add_box(boxes, "dsp", "message", "; dsp start");
    add_line(lines, "load", 0, "dsp-configure", 0);
    add_line(lines, "dsp-configure", 2, "dsp-overdrive", 0);
    add_line(lines, "dsp-configure", 1, "dsp-takeover", 0);
    add_line(lines, "dsp-configure", 0, "dsp", 0);
}

fn add_audio_timed_stop(
    boxes: &mut Vec<Value>,
    lines: &mut Vec<Value>,
    duration_ms: f64,
    quit_delay_ms: u64,
) {
    // A scheduler `delay` measures elapsed wall time and can truncate a graph
    // that is processing below real time. This ramp advances in audio time, so
    // the recorder always receives exactly the requested processed duration.
    add_box(
        boxes,
        "audio-duration",
        "message",
        &format!("0., 1. {duration_ms:.3}"),
    );
    add_box(boxes, "audio-timer", "newobj", "line~");
    // `line~` can finish one float ULP below its target after a long ramp.
    // Crossing just below one preserves the requested duration while ensuring
    // the completion edge fires deterministically.
    add_box(boxes, "audio-timer-done", "newobj", ">=~ 0.999999");
    add_box(boxes, "audio-timer-edge", "newobj", "edge~");
    add_box(boxes, "record-stop", "message", "0");
    add_box(
        boxes,
        "quit-delay",
        "newobj",
        &format!("delay {quit_delay_ms}"),
    );
    add_box(boxes, "quit", "message", "; max quit");
    add_line(lines, "start", 0, "audio-duration", 0);
    add_line(lines, "audio-duration", 0, "audio-timer", 0);
    add_line(lines, "audio-timer", 0, "audio-timer-done", 0);
    add_line(lines, "audio-timer-done", 0, "audio-timer-edge", 0);
    add_line(lines, "audio-timer-edge", 0, "record-stop", 0);
    add_line(lines, "audio-timer-edge", 0, "quit-delay", 0);
    add_line(lines, "quit-delay", 0, "quit", 0);
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

fn cached_wav_matches(path: &Path, sample_rate: u32, expected_duration: f64) -> bool {
    hound::WavReader::open(path).is_ok_and(|reader| {
        let duration = f64::from(reader.duration()) / f64::from(reader.spec().sample_rate);
        reader.spec().sample_rate == sample_rate && (duration - expected_duration).abs() < 0.01
    })
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
    fn round_robins_dense_sample_hits_across_independent_voices() {
        let voices = (0..=SAMPLE_VOICE_COUNT)
            .map(sample_voice_index)
            .collect::<Vec<_>>();
        assert_eq!(
            voices[..SAMPLE_VOICE_COUNT],
            (0..SAMPLE_VOICE_COUNT).collect::<Vec<_>>()
        );
        assert_eq!(voices[SAMPLE_VOICE_COUNT], 0);
    }

    #[test]
    fn stops_recording_from_processed_audio_time() {
        let mut boxes = Vec::new();
        let mut lines = Vec::new();
        add_audio_timed_stop(&mut boxes, &mut lines, 12_345.678, 750);
        let patch = serde_json::to_string(&json!({ "boxes": boxes, "lines": lines }))
            .expect("serialize timer patch");
        assert!(patch.contains("line~"));
        assert!(patch.contains("edge~"));
        assert!(patch.contains("0., 1. 12345.678"));
        assert!(!patch.contains("stop-delay"));
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

    #[test]
    fn accepts_native_ableton_effects_after_sample_sources() {
        let directory = tempfile::tempdir().expect("temporary graph directory");
        let sample = directory.path().join("clip.wav");
        let mut writer = hound::WavWriter::create(
            &sample,
            hound::WavSpec {
                channels: 2,
                sample_rate: 44_100,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            },
        )
        .expect("sample writer");
        writer.write_sample(0.25_f32).expect("left sample");
        writer.write_sample(0.25_f32).expect("right sample");
        writer.finalize().expect("finalize sample");
        let preset = directory.path().join("Chorus Classic.adv");
        fs::write(&preset, b"preset").expect("effect preset");
        let graph = AbletonGraph {
            schema_version: 1,
            title: "sample effect validation".to_owned(),
            bpm: 120.0,
            bars: 1,
            beats_per_bar: 4,
            sample_rate: 44_100,
            tail_seconds: 1.0,
            master: GraphMaster::default(),
            tracks: vec![GraphTrack {
                id: "serum-clip".to_owned(),
                gain_db: 0.0,
                pan: 0.0,
                effects: vec![GraphEffect::Native {
                    device: "Chorus2".to_owned(),
                    preset,
                    sidechain: Some(sample.clone()),
                }],
                source: GraphSource::Sample {
                    sample,
                    triggers: vec![GraphTrigger {
                        beat: 0.0,
                        velocity: 127,
                    }],
                    loop_beats: None,
                    placements: vec![],
                    velocity_amount: 0.0,
                },
            }],
        };
        validate_graph(&graph, directory.path(), directory.path())
            .expect("sample sources should accept standalone native effects");
    }
}
