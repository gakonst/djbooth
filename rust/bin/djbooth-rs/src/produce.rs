#![allow(deprecated)]

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use djbooth_analyzer::decode_audio_file_with_channels;
use serde::{Deserialize, Serialize};

use crate::plugin::{
    OfflineInstrumentRequest, Sequence, SequenceNote, render_instrument_offline, write_wav,
};
use crate::serum::load_and_compile_patch;

const DEFAULT_SERUM_BINARY: &str = "/Library/Audio/Plug-Ins/VST/Serum.vst/Contents/MacOS/Serum";
const DEFAULT_SERUM_PRESETS: &str = "/Library/Audio/Presets/Xfer Records/Serum Presets/Presets";
const DEFAULT_SAMPLE_RATE: u32 = 44_100;
const DEFAULT_BLOCK_SIZE: usize = 512;

#[derive(Debug, Parser)]
#[command(
    name = "djbooth-rs produce",
    about = "Render declarative multitrack productions without a DAW"
)]
struct Args {
    #[command(subcommand)]
    command: ProduceCommand,
}

#[derive(Debug, Subcommand)]
enum ProduceCommand {
    /// Extract a reusable production-taste profile from a reference mix and optional stems.
    ReferenceProfile {
        audio: PathBuf,
        #[arg(long = "stem", value_name = "NAME=PATH")]
        stems: Vec<String>,
        #[arg(long)]
        output: Option<PathBuf>,
    },
    /// Score a candidate production profile against a reference and emit actionable deltas.
    ProfileCompare {
        reference: PathBuf,
        candidate: PathBuf,
        #[arg(long)]
        output: Option<PathBuf>,
    },
    /// Render a JSON song specification to a stereo WAV and optional stems.
    Render {
        spec: PathBuf,
        output: PathBuf,
        #[arg(long, default_value = DEFAULT_SERUM_BINARY)]
        serum_plugin: PathBuf,
        #[arg(long, default_value = DEFAULT_SERUM_PRESETS)]
        serum_presets: PathBuf,
        #[arg(long, default_value_t = DEFAULT_BLOCK_SIZE)]
        block_size: usize,
        #[arg(long)]
        stems: Option<PathBuf>,
        /// Play the completed WAV with the macOS system player.
        #[arg(long)]
        play: bool,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SongSpec {
    schema_version: u32,
    title: String,
    bpm: f64,
    bars: u32,
    #[serde(default = "default_beats_per_bar")]
    beats_per_bar: u32,
    #[serde(default = "default_sample_rate")]
    sample_rate: u32,
    #[serde(default)]
    master: MasterSpec,
    tracks: Vec<TrackSpec>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrackSpec {
    id: String,
    pattern: Option<PatternSpec>,
    #[serde(default)]
    gain_db: f32,
    #[serde(default)]
    pan: f32,
    high_pass_hz: Option<f32>,
    low_pass_hz: Option<f32>,
    sidechain: Option<SidechainSpec>,
    choke_group: Option<u8>,
    #[serde(default)]
    effects: Vec<TrackEffectSpec>,
    #[serde(flatten)]
    source: TrackSource,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PatternSpec {
    length_beats: f64,
    repeats: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum TrackSource {
    Serum {
        patch: PathBuf,
        notes: Vec<NoteSpec>,
    },
    NoiseDrum {
        voice: NoiseVoice,
        triggers: Vec<TriggerSpec>,
    },
    Sample {
        sample: PathBuf,
        #[serde(default)]
        one_shot: bool,
        #[serde(default = "default_sample_velocity_amount")]
        velocity_amount: f32,
        #[serde(default)]
        trim_start_seconds: f64,
        trim_end_seconds: Option<f64>,
        #[serde(default = "default_sample_fade_out_seconds")]
        fade_out_seconds: f64,
        triggers: Vec<TriggerSpec>,
    },
    Sampler {
        zones: Vec<SamplerZoneSpec>,
        notes: Vec<NoteSpec>,
    },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SamplerZoneSpec {
    sample: PathBuf,
    key_min: u8,
    key_max: u8,
    velocity_min: u8,
    velocity_max: u8,
    root_key: u8,
    #[serde(default)]
    detune_cents: f32,
    #[serde(default)]
    gain_db: f32,
    #[serde(default)]
    pan: f32,
    #[serde(default)]
    sample_start_frame: usize,
    sample_end_frame: Option<usize>,
    #[serde(default = "default_sample_source_rate")]
    source_sample_rate: u32,
    sustain_loop: Option<SamplerLoopSpec>,
    #[serde(default)]
    attack_seconds: f64,
    #[serde(default)]
    decay_seconds: f64,
    #[serde(default = "default_sampler_sustain_level")]
    sustain_level: f32,
    #[serde(default)]
    release_seconds: f64,
    #[serde(default = "default_sample_velocity_amount")]
    velocity_amount: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SamplerLoopSpec {
    start_frame: usize,
    end_frame: usize,
    #[serde(default)]
    crossfade_frames: usize,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum NoiseVoice {
    Clap,
    Hat,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NoteSpec {
    beat: f64,
    duration_beats: f64,
    note: u8,
    velocity: u8,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TriggerSpec {
    beat: f64,
    duration_beats: f64,
    velocity: u8,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SidechainSpec {
    #[serde(default = "default_sidechain_every_beats")]
    every_beats: f64,
    #[serde(default = "default_sidechain_hold_beats")]
    hold_beats: f64,
    #[serde(default = "default_sidechain_release_beats")]
    release_beats: f64,
    #[serde(default = "default_sidechain_depth_db")]
    depth_db: f32,
    #[serde(default = "default_sidechain_curve")]
    curve: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum TrackEffectSpec {
    AutoFilter {
        filter_type: FilterType,
        cutoff_hz: f32,
        #[serde(default)]
        resonance: f32,
        #[serde(default)]
        drive_db: f32,
        #[serde(default)]
        cutoff_automation: Vec<FilterAutomationPoint>,
    },
    Saturator {
        drive_db: f32,
        #[serde(default)]
        output_db: f32,
        #[serde(default = "default_effect_mix")]
        mix: f32,
        #[serde(default)]
        soft_clip: bool,
    },
    Delay {
        left_beats: f64,
        right_beats: f64,
        feedback: f32,
        #[serde(default = "default_effect_mix")]
        mix: f32,
        #[serde(default)]
        ping_pong: bool,
    },
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
enum FilterType {
    LowPass,
    HighPass,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FilterAutomationPoint {
    beat: f64,
    cutoff_hz: f32,
    #[serde(default = "default_filter_curve")]
    curve: f32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MasterSpec {
    #[serde(default)]
    input_gain_db: f32,
    soft_clip_drive: Option<f32>,
    ceiling_db: Option<f32>,
    #[serde(default = "default_tail_seconds")]
    tail_seconds: f64,
}

impl Default for MasterSpec {
    fn default() -> Self {
        Self {
            input_gain_db: 0.0,
            soft_clip_drive: None,
            ceiling_db: None,
            tail_seconds: default_tail_seconds(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderReport {
    title: String,
    output: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    stems_directory: Option<PathBuf>,
    bpm: f64,
    bars: u32,
    sample_rate: u32,
    duration_seconds: f64,
    peak_db: f32,
    rms_db: f32,
    tracks: Vec<TrackReport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrackReport {
    id: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    plugin: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preset: Option<String>,
    events: usize,
    peak_db: f32,
}

struct RenderedTrack {
    report: TrackReport,
    frames: Vec<[f32; 2]>,
}

pub(crate) fn run(args: impl Iterator<Item = String>) -> Result<()> {
    let arguments = Args::parse_from(std::iter::once("djbooth-rs produce".to_owned()).chain(args));
    match arguments.command {
        ProduceCommand::ReferenceProfile {
            audio,
            stems,
            output,
        } => crate::taste::profile_reference(&audio, &stems, output.as_deref()),
        ProduceCommand::ProfileCompare {
            reference,
            candidate,
            output,
        } => crate::taste::compare_profiles(&reference, &candidate, output.as_deref()),
        ProduceCommand::Render {
            spec,
            output,
            serum_plugin,
            serum_presets,
            block_size,
            stems,
            play,
        } => render(RenderRequest {
            spec,
            output,
            serum_plugin,
            serum_presets,
            block_size,
            stems,
            play,
        }),
    }
}

struct RenderRequest {
    spec: PathBuf,
    output: PathBuf,
    serum_plugin: PathBuf,
    serum_presets: PathBuf,
    block_size: usize,
    stems: Option<PathBuf>,
    play: bool,
}

fn render(request: RenderRequest) -> Result<()> {
    ensure!(request.block_size > 0, "block size must be positive");
    let spec = serde_json::from_slice::<SongSpec>(
        &fs::read(&request.spec)
            .with_context(|| format!("failed to read {}", request.spec.display()))?,
    )
    .with_context(|| format!("invalid song JSON in {}", request.spec.display()))?;
    validate_song(&spec)?;
    let spec_directory = request.spec.parent().unwrap_or_else(|| Path::new("."));

    let musical_seconds = song_beats(&spec) * 60.0 / spec.bpm;
    let total_frames = ((musical_seconds + spec.master.tail_seconds) * f64::from(spec.sample_rate))
        .ceil() as usize;
    let mut rendered_tracks = Vec::with_capacity(spec.tracks.len());
    for (track_index, track) in spec.tracks.iter().enumerate() {
        let mut rendered = match &track.source {
            TrackSource::Serum { patch, notes } => render_serum_track(
                &spec,
                track,
                &resolve_sample_path(patch, spec_directory),
                notes,
                &request,
            )?,
            TrackSource::NoiseDrum { voice, triggers } => {
                render_noise_track(&spec, track, *voice, triggers, total_frames, track_index)
            }
            TrackSource::Sample {
                sample,
                one_shot,
                velocity_amount,
                trim_start_seconds,
                trim_end_seconds,
                fade_out_seconds,
                triggers,
            } => render_sample_track(
                &spec,
                track,
                &resolve_sample_path(sample, spec_directory),
                *one_shot,
                *velocity_amount,
                *trim_start_seconds,
                *trim_end_seconds,
                *fade_out_seconds,
                triggers,
                total_frames,
            )?,
            TrackSource::Sampler { zones, notes } => {
                render_sampler_track(&spec, track, zones, notes, spec_directory, total_frames)?
            }
        };
        rendered.frames.resize(total_frames, [0.0, 0.0]);
        rendered.frames.truncate(total_frames);
        process_track(&mut rendered.frames, track, &spec);
        rendered.report.peak_db = peak_db(&rendered.frames);
        rendered_tracks.push(rendered);
    }

    apply_choke_groups(&spec, &mut rendered_tracks);
    for track in &mut rendered_tracks {
        track.report.peak_db = peak_db(&track.frames);
    }

    if let Some(stems) = request.stems.as_deref() {
        fs::create_dir_all(stems)
            .with_context(|| format!("failed to create {}", stems.display()))?;
        for track in &rendered_tracks {
            write_wav(
                &stems.join(format!("{}.wav", track.report.id)),
                spec.sample_rate,
                &track.frames,
            )?;
        }
    }

    let mut master = vec![[0.0_f32; 2]; total_frames];
    for track in &rendered_tracks {
        for (destination, source) in master.iter_mut().zip(&track.frames) {
            destination[0] += source[0];
            destination[1] += source[1];
        }
    }
    master_track(&mut master, &spec.master);
    write_wav(&request.output, spec.sample_rate, &master)?;

    let report = RenderReport {
        title: spec.title,
        output: request.output.clone(),
        stems_directory: request.stems,
        bpm: spec.bpm,
        bars: spec.bars,
        sample_rate: spec.sample_rate,
        duration_seconds: total_frames as f64 / f64::from(spec.sample_rate),
        peak_db: peak_db(&master),
        rms_db: rms_db(&master),
        tracks: rendered_tracks
            .into_iter()
            .map(|track| track.report)
            .collect(),
    };
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

fn apply_choke_groups(spec: &SongSpec, rendered_tracks: &mut [RenderedTrack]) {
    let frames_per_beat = f64::from(spec.sample_rate) * 60.0 / spec.bpm;
    let trigger_frames = spec
        .tracks
        .iter()
        .map(|track| {
            let mut frames = track_trigger_beats(track)
                .into_iter()
                .map(|beat| (beat * frames_per_beat).round() as usize)
                .collect::<Vec<_>>();
            frames.sort_unstable();
            frames.dedup();
            frames
        })
        .collect::<Vec<_>>();
    let fade_frames = ((f64::from(spec.sample_rate) * 0.003).round() as usize).max(1);

    for target_index in 0..spec.tracks.len() {
        let Some(group) = spec.tracks[target_index].choke_group else {
            continue;
        };
        let own_starts = &trigger_frames[target_index];
        let mut choke_starts = spec
            .tracks
            .iter()
            .enumerate()
            .filter(|(index, track)| *index != target_index && track.choke_group == Some(group))
            .flat_map(|(index, _)| trigger_frames[index].iter().copied())
            .collect::<Vec<_>>();
        choke_starts.sort_unstable();
        choke_starts.dedup();

        let destination = &mut rendered_tracks[target_index].frames;
        for start in choke_starts {
            if start >= destination.len() {
                continue;
            }
            let next_own = own_starts
                .iter()
                .copied()
                .find(|own_start| *own_start > start)
                .unwrap_or(destination.len())
                .min(destination.len());
            let fade_end = start.saturating_add(fade_frames).min(next_own);
            for (offset, frame) in destination[start..fade_end].iter_mut().enumerate() {
                let gain = 1.0 - (offset + 1) as f32 / fade_frames as f32;
                frame[0] *= gain.max(0.0);
                frame[1] *= gain.max(0.0);
            }
            for frame in &mut destination[fade_end..next_own] {
                *frame = [0.0, 0.0];
            }
        }
    }
}

fn track_trigger_beats(track: &TrackSpec) -> Vec<f64> {
    match &track.source {
        TrackSource::Serum { .. } | TrackSource::Sampler { .. } => Vec::new(),
        TrackSource::NoiseDrum { triggers, .. } | TrackSource::Sample { triggers, .. } => {
            expand_triggers(triggers, track.pattern.as_ref())
                .into_iter()
                .map(|trigger| trigger.beat)
                .collect()
        }
    }
}

fn render_sampler_track(
    spec: &SongSpec,
    track: &TrackSpec,
    zones: &[SamplerZoneSpec],
    notes: &[NoteSpec],
    spec_directory: &Path,
    total_frames: usize,
) -> Result<RenderedTrack> {
    let notes = expand_notes(notes, track.pattern.as_ref());
    let frames_per_beat = f64::from(spec.sample_rate) * 60.0 / spec.bpm;
    let mut frames = vec![[0.0_f32; 2]; total_frames];
    let mut samples = HashMap::<PathBuf, Vec<[f32; 2]>>::new();

    for note in &notes {
        let matching_zones = zones.iter().filter(|zone| {
            (zone.key_min..=zone.key_max).contains(&note.note)
                && (zone.velocity_min..=zone.velocity_max).contains(&note.velocity)
        });
        for zone in matching_zones {
            let sample_path = resolve_sample_path(&zone.sample, spec_directory);
            if !samples.contains_key(&sample_path) {
                samples.insert(
                    sample_path.clone(),
                    read_sample(&sample_path, spec.sample_rate)?,
                );
            }
            let source = samples
                .get(&sample_path)
                .context("decoded sampler source disappeared")?;
            render_sampler_voice(
                &mut frames,
                source,
                zone,
                note,
                frames_per_beat,
                spec.sample_rate,
            );
        }
    }

    Ok(RenderedTrack {
        report: TrackReport {
            id: track.id.clone(),
            kind: "sampler",
            plugin: None,
            preset: Some(format!("{} zones", zones.len())),
            events: notes.len(),
            peak_db: f32::NEG_INFINITY,
        },
        frames,
    })
}

fn render_sampler_voice(
    destination: &mut [[f32; 2]],
    source: &[[f32; 2]],
    zone: &SamplerZoneSpec,
    note: &NoteSpec,
    frames_per_beat: f64,
    sample_rate: u32,
) {
    let source_scale = f64::from(sample_rate) / f64::from(zone.source_sample_rate);
    let source_start = zone.sample_start_frame as f64 * source_scale;
    let source_end = zone
        .sample_end_frame
        .map(|frame| frame as f64 * source_scale)
        .unwrap_or(source.len() as f64)
        .min(source.len() as f64);
    if source_start >= source_end {
        return;
    }
    let sustain_loop = zone.sustain_loop.as_ref().and_then(|sample_loop| {
        let start = sample_loop.start_frame as f64 * source_scale;
        let end = sample_loop.end_frame as f64 * source_scale;
        let crossfade = sample_loop.crossfade_frames as f64 * source_scale;
        (start >= source_start && end > start && end <= source_end)
            .then_some((start, end, crossfade))
    });
    let pitch_semitones =
        f64::from(note.note) - f64::from(zone.root_key) + f64::from(zone.detune_cents) / 100.0;
    let phase_step = 2.0_f64.powf(pitch_semitones / 12.0);
    let destination_start = (note.beat * frames_per_beat).round() as usize;
    let note_frames = (note.duration_beats * frames_per_beat).round() as usize;
    let release_frames = (zone.release_seconds * f64::from(sample_rate)).round() as usize;
    let voice_frames = note_frames.saturating_add(release_frames.max(1));
    let velocity =
        (1.0 - zone.velocity_amount) + zone.velocity_amount * (f32::from(note.velocity) / 127.0);
    let gain = db_to_gain(zone.gain_db) * velocity;
    let left_pan = if zone.pan > 0.0 { 1.0 - zone.pan } else { 1.0 };
    let right_pan = if zone.pan < 0.0 { 1.0 + zone.pan } else { 1.0 };
    let mut phase = source_start;

    for voice_frame in 0..voice_frames.min(destination.len().saturating_sub(destination_start)) {
        if voice_frame < note_frames
            && let Some((loop_start, loop_end, _crossfade)) = sustain_loop
            && phase >= loop_end
        {
            phase = loop_start + (phase - loop_end) % (loop_end - loop_start);
        }
        if phase >= source_end {
            break;
        }
        let before = phase.floor() as usize;
        let after = (before + 1).min(source.len().saturating_sub(1));
        let fraction = (phase - before as f64) as f32;
        let sample = [
            source[before][0] + (source[after][0] - source[before][0]) * fraction,
            source[before][1] + (source[after][1] - source[before][1]) * fraction,
        ];
        let envelope = sampler_envelope(zone, voice_frame, note_frames, sample_rate);
        let output = &mut destination[destination_start + voice_frame];
        output[0] += sample[0] * gain * envelope * left_pan;
        output[1] += sample[1] * gain * envelope * right_pan;
        phase += phase_step;
    }
}

fn sampler_envelope(
    zone: &SamplerZoneSpec,
    frame: usize,
    note_frames: usize,
    sample_rate: u32,
) -> f32 {
    let attack = (zone.attack_seconds * f64::from(sample_rate)).round() as usize;
    let decay = (zone.decay_seconds * f64::from(sample_rate)).round() as usize;
    let held_level = if attack > 0 && frame < attack {
        frame as f32 / attack as f32
    } else if decay > 0 && frame < attack.saturating_add(decay) {
        let progress = (frame - attack) as f32 / decay as f32;
        1.0 + (zone.sustain_level - 1.0) * progress
    } else {
        zone.sustain_level
    };
    if frame < note_frames {
        return held_level;
    }
    let release = (zone.release_seconds * f64::from(sample_rate)).round() as usize;
    if release == 0 {
        return 0.0;
    }
    let note_off_level =
        sampler_envelope(zone, note_frames.saturating_sub(1), usize::MAX, sample_rate);
    let release_progress = (frame - note_frames) as f32 / release as f32;
    note_off_level * (1.0 - release_progress).max(0.0)
}

fn render_serum_track(
    spec: &SongSpec,
    track: &TrackSpec,
    patch: &Path,
    notes: &[NoteSpec],
    request: &RenderRequest,
) -> Result<RenderedTrack> {
    let patch = load_and_compile_patch(patch, &request.serum_presets)?;
    let sequence = Sequence {
        bpm: spec.bpm,
        bars: spec.bars,
        beats_per_bar: spec.beats_per_bar,
        notes: expand_notes(notes, track.pattern.as_ref())
            .into_iter()
            .map(|note| SequenceNote {
                beat: note.beat,
                duration_beats: note.duration_beats,
                note: note.note,
                velocity: note.velocity,
            })
            .collect(),
    };
    let rendered = render_instrument_offline(OfflineInstrumentRequest {
        plugin: &request.serum_plugin,
        preset: &patch.preset,
        sequence: &sequence,
        parameters: &patch.parameters,
        automations: &patch.automations,
        sample_rate: spec.sample_rate,
        block_size: request.block_size,
        tail_seconds: spec.master.tail_seconds,
    })?;
    Ok(RenderedTrack {
        report: TrackReport {
            id: track.id.clone(),
            kind: "serum",
            plugin: Some(rendered.plugin_name),
            preset: Some(patch.name),
            events: sequence.notes.len(),
            peak_db: f32::NEG_INFINITY,
        },
        frames: rendered.frames,
    })
}

fn render_noise_track(
    spec: &SongSpec,
    track: &TrackSpec,
    voice: NoiseVoice,
    triggers: &[TriggerSpec],
    total_frames: usize,
    track_index: usize,
) -> RenderedTrack {
    let frames_per_beat = f64::from(spec.sample_rate) * 60.0 / spec.bpm;
    let mut frames = vec![[0.0_f32; 2]; total_frames];
    let triggers = expand_triggers(triggers, track.pattern.as_ref());
    for (trigger_index, trigger) in triggers.iter().enumerate() {
        let start = (trigger.beat * frames_per_beat).round() as usize;
        let duration = (trigger.duration_beats * frames_per_beat).round() as usize;
        synthesize_noise_hit(
            &mut frames,
            start,
            duration,
            spec.sample_rate,
            voice,
            f32::from(trigger.velocity) / 127.0,
            ((track_index as u64 + 1) << 32) | (trigger_index as u64 + 1),
        );
    }
    RenderedTrack {
        report: TrackReport {
            id: track.id.clone(),
            kind: "noiseDrum",
            plugin: None,
            preset: None,
            events: triggers.len(),
            peak_db: f32::NEG_INFINITY,
        },
        frames,
    }
}

#[allow(clippy::too_many_arguments)]
fn render_sample_track(
    spec: &SongSpec,
    track: &TrackSpec,
    sample_path: &Path,
    one_shot: bool,
    velocity_amount: f32,
    trim_start_seconds: f64,
    trim_end_seconds: Option<f64>,
    fade_out_seconds: f64,
    triggers: &[TriggerSpec],
    total_frames: usize,
) -> Result<RenderedTrack> {
    let source = read_sample(sample_path, spec.sample_rate)?;
    let trim_start = (trim_start_seconds * f64::from(spec.sample_rate)).round() as usize;
    let trim_end = trim_end_seconds
        .map(|seconds| (seconds * f64::from(spec.sample_rate)).round() as usize)
        .unwrap_or(source.len())
        .min(source.len());
    ensure!(
        trim_start < trim_end,
        "sample trim for '{}' is empty",
        track.id
    );
    let source = &source[trim_start..trim_end];
    let fade_out_frames = (fade_out_seconds * f64::from(spec.sample_rate)).round() as usize;
    let frames_per_beat = f64::from(spec.sample_rate) * 60.0 / spec.bpm;
    let triggers = expand_triggers(triggers, track.pattern.as_ref());
    let mut frames = vec![[0.0_f32; 2]; total_frames];
    for trigger in &triggers {
        let start = (trigger.beat * frames_per_beat).round() as usize;
        let requested = (trigger.duration_beats * frames_per_beat).round() as usize;
        let playback_frames = if one_shot {
            source.len()
        } else {
            requested.min(source.len())
        };
        let fade_start = playback_frames.saturating_sub(fade_out_frames.min(playback_frames));
        let normalized_velocity = f32::from(trigger.velocity) / 127.0;
        let velocity = (1.0 - velocity_amount) + velocity_amount * normalized_velocity;
        for frame in 0..playback_frames.min(frames.len().saturating_sub(start)) {
            let fade = if frame < fade_start || playback_frames == fade_start {
                1.0
            } else {
                (playback_frames - frame) as f32 / (playback_frames - fade_start) as f32
            };
            frames[start + frame][0] += source[frame][0] * velocity * fade;
            frames[start + frame][1] += source[frame][1] * velocity * fade;
        }
    }
    Ok(RenderedTrack {
        report: TrackReport {
            id: track.id.clone(),
            kind: "sample",
            plugin: None,
            preset: sample_path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned()),
            events: triggers.len(),
            peak_db: f32::NEG_INFINITY,
        },
        frames,
    })
}

#[allow(clippy::too_many_arguments)]
fn synthesize_noise_hit(
    destination: &mut [[f32; 2]],
    start: usize,
    duration: usize,
    sample_rate: u32,
    voice: NoiseVoice,
    velocity: f32,
    seed: u64,
) {
    let frames = duration.min(destination.len().saturating_sub(start));
    let mut left_noise = Noise::new(seed);
    let mut right_noise = Noise::new(seed ^ 0x9e37_79b9_7f4a_7c15);
    let mut left_high_pass = OnePoleHighPass::new(voice.cutoff_hz(), sample_rate);
    let mut right_high_pass = OnePoleHighPass::new(voice.cutoff_hz(), sample_rate);
    for frame in 0..frames {
        let seconds = frame as f32 / sample_rate as f32;
        let envelope = match voice {
            NoiseVoice::Hat => (-seconds / 0.055).exp(),
            NoiseVoice::Clap => clap_envelope(seconds),
        };
        let metallic = match voice {
            NoiseVoice::Hat => {
                let phase = std::f32::consts::TAU * seconds;
                0.16 * ((phase * 6_431.0).sin() + (phase * 8_117.0).sin())
            }
            NoiseVoice::Clap => 0.0,
        };
        let left = left_high_pass.process(left_noise.next() + metallic);
        let right = right_high_pass.process(right_noise.next() - metallic);
        destination[start + frame][0] += left * envelope * velocity * 0.45;
        destination[start + frame][1] += right * envelope * velocity * 0.45;
    }
}

impl NoiseVoice {
    fn cutoff_hz(self) -> f32 {
        match self {
            Self::Clap => 900.0,
            Self::Hat => 5_200.0,
        }
    }
}

fn clap_envelope(seconds: f32) -> f32 {
    let mut envelope = 0.18 * (-seconds / 0.06).exp();
    for offset in [0.0_f32, 0.011, 0.023] {
        if seconds >= offset {
            envelope += (-(seconds - offset) / 0.007).exp();
        }
    }
    envelope.min(1.0)
}

fn process_track(frames: &mut [[f32; 2]], track: &TrackSpec, song: &SongSpec) {
    if let Some(cutoff) = track.high_pass_hz {
        let mut filters = [
            OnePoleHighPass::new(cutoff, song.sample_rate),
            OnePoleHighPass::new(cutoff, song.sample_rate),
        ];
        for frame in frames.iter_mut() {
            frame[0] = filters[0].process(frame[0]);
            frame[1] = filters[1].process(frame[1]);
        }
    }
    if let Some(cutoff) = track.low_pass_hz {
        let mut filters = [
            OnePoleLowPass::new(cutoff, song.sample_rate),
            OnePoleLowPass::new(cutoff, song.sample_rate),
        ];
        for frame in frames.iter_mut() {
            frame[0] = filters[0].process(frame[0]);
            frame[1] = filters[1].process(frame[1]);
        }
    }
    for effect in &track.effects {
        match effect {
            TrackEffectSpec::AutoFilter {
                filter_type,
                cutoff_hz,
                resonance,
                drive_db,
                cutoff_automation,
            } => apply_auto_filter(
                frames,
                song,
                *filter_type,
                *cutoff_hz,
                *resonance,
                *drive_db,
                cutoff_automation,
            ),
            TrackEffectSpec::Saturator {
                drive_db,
                output_db,
                mix,
                soft_clip,
            } => apply_saturator(frames, *drive_db, *output_db, *mix, *soft_clip),
            TrackEffectSpec::Delay {
                left_beats,
                right_beats,
                feedback,
                mix,
                ping_pong,
            } => apply_delay(
                frames,
                song,
                *left_beats,
                *right_beats,
                *feedback,
                *mix,
                *ping_pong,
            ),
        }
    }
    if let Some(sidechain) = &track.sidechain {
        apply_tempo_sidechain(frames, song, sidechain);
    }
    let gain = db_to_gain(track.gain_db);
    let pan = track.pan.clamp(-1.0, 1.0);
    let left_gain = if pan > 0.0 { 1.0 - pan } else { 1.0 } * gain;
    let right_gain = if pan < 0.0 { 1.0 + pan } else { 1.0 } * gain;
    for frame in frames {
        frame[0] *= left_gain;
        frame[1] *= right_gain;
    }
}

fn apply_auto_filter(
    frames: &mut [[f32; 2]],
    song: &SongSpec,
    filter_type: FilterType,
    cutoff_hz: f32,
    resonance: f32,
    drive_db: f32,
    automation: &[FilterAutomationPoint],
) {
    let samples_per_beat = f64::from(song.sample_rate) * 60.0 / song.bpm;
    let drive = db_to_gain(drive_db);
    let drive_normalization = drive.tanh().max(f32::EPSILON);
    let q = 0.707 + resonance * 5.0;
    let mut filters = [Biquad::default(), Biquad::default()];
    for (index, frame) in frames.iter_mut().enumerate() {
        let beat = index as f64 / samples_per_beat;
        let cutoff = automated_cutoff(beat, cutoff_hz, automation)
            .clamp(10.0, song.sample_rate as f32 * 0.495);
        let coefficients = BiquadCoefficients::filter(filter_type, cutoff, q, song.sample_rate);
        for channel in 0..2 {
            let driven = (frame[channel] * drive).tanh() / drive_normalization;
            frame[channel] = filters[channel].process(driven, coefficients);
        }
    }
}

fn automated_cutoff(beat: f64, fallback_hz: f32, automation: &[FilterAutomationPoint]) -> f32 {
    let Some(first) = automation.first() else {
        return fallback_hz;
    };
    if beat <= first.beat {
        return first.cutoff_hz;
    }
    for pair in automation.windows(2) {
        let [start, end] = pair else { continue };
        if beat <= end.beat {
            let progress = ((beat - start.beat) / (end.beat - start.beat)).clamp(0.0, 1.0);
            let shaped = progress.powf(f64::from(start.curve));
            let start_log = f64::from(start.cutoff_hz).ln();
            let end_log = f64::from(end.cutoff_hz).ln();
            return (start_log + (end_log - start_log) * shaped).exp() as f32;
        }
    }
    automation
        .last()
        .map_or(fallback_hz, |point| point.cutoff_hz)
}

fn apply_saturator(
    frames: &mut [[f32; 2]],
    drive_db: f32,
    output_db: f32,
    mix: f32,
    soft_clip: bool,
) {
    let drive = db_to_gain(drive_db);
    let output = db_to_gain(output_db);
    let normalization = drive.tanh().max(f32::EPSILON);
    for frame in frames {
        for sample in frame {
            let dry = *sample;
            let driven = dry * drive;
            let wet = if soft_clip {
                driven.tanh() / normalization
            } else {
                driven.clamp(-1.0, 1.0)
            };
            *sample = (dry * (1.0 - mix) + wet * mix) * output;
        }
    }
}

fn apply_delay(
    frames: &mut [[f32; 2]],
    song: &SongSpec,
    left_beats: f64,
    right_beats: f64,
    feedback: f32,
    mix: f32,
    ping_pong: bool,
) {
    let samples_per_beat = f64::from(song.sample_rate) * 60.0 / song.bpm;
    let left_samples = (left_beats * samples_per_beat).round().max(1.0) as usize;
    let right_samples = (right_beats * samples_per_beat).round().max(1.0) as usize;
    let mut left_buffer = vec![0.0_f32; left_samples];
    let mut right_buffer = vec![0.0_f32; right_samples];
    let mut left_index = 0_usize;
    let mut right_index = 0_usize;
    for frame in frames {
        let dry = *frame;
        let delayed = [left_buffer[left_index], right_buffer[right_index]];
        if ping_pong {
            left_buffer[left_index] = dry[0] + delayed[1] * feedback;
            right_buffer[right_index] = dry[1] + delayed[0] * feedback;
        } else {
            left_buffer[left_index] = dry[0] + delayed[0] * feedback;
            right_buffer[right_index] = dry[1] + delayed[1] * feedback;
        }
        frame[0] = dry[0] * (1.0 - mix) + delayed[0] * mix;
        frame[1] = dry[1] * (1.0 - mix) + delayed[1] * mix;
        left_index = (left_index + 1) % left_samples;
        right_index = (right_index + 1) % right_samples;
    }
}

fn apply_tempo_sidechain(frames: &mut [[f32; 2]], song: &SongSpec, sidechain: &SidechainSpec) {
    let samples_per_beat = f64::from(song.sample_rate) * 60.0 / song.bpm;
    let minimum = db_to_gain(sidechain.depth_db);
    for (index, frame) in frames.iter_mut().enumerate() {
        let beat = index as f64 / samples_per_beat;
        let phase = beat.rem_euclid(sidechain.every_beats);
        let gain = if phase <= sidechain.hold_beats {
            minimum
        } else if phase < sidechain.hold_beats + sidechain.release_beats {
            let progress = ((phase - sidechain.hold_beats) / sidechain.release_beats) as f32;
            minimum + (1.0 - minimum) * progress.powf(sidechain.curve)
        } else {
            1.0
        };
        frame[0] *= gain;
        frame[1] *= gain;
    }
}

fn master_track(frames: &mut [[f32; 2]], master: &MasterSpec) {
    let input_gain = db_to_gain(master.input_gain_db);
    for frame in frames.iter_mut() {
        for sample in frame {
            *sample *= input_gain;
            if let Some(drive) = master.soft_clip_drive {
                *sample = (*sample * drive).tanh();
            }
        }
    }
    if let Some(ceiling_db) = master.ceiling_db {
        let peak = peak_linear(frames);
        if peak > 0.0 {
            let gain = db_to_gain(ceiling_db) / peak;
            for frame in frames {
                frame[0] *= gain;
                frame[1] *= gain;
            }
        }
    }
}

fn validate_song(spec: &SongSpec) -> Result<()> {
    ensure!(spec.schema_version == 1, "unsupported song schema version");
    ensure!(
        !spec.title.trim().is_empty(),
        "song title must not be empty"
    );
    ensure!(
        spec.bpm.is_finite() && spec.bpm > 0.0,
        "BPM must be positive and finite"
    );
    ensure!(spec.bars > 0, "song must contain at least one bar");
    ensure!(spec.beats_per_bar > 0, "beats per bar must be positive");
    ensure!(
        spec.sample_rate >= 8_000,
        "sample rate must be at least 8000 Hz"
    );
    ensure!(
        !spec.tracks.is_empty(),
        "song must contain at least one track"
    );
    ensure!(
        spec.master.tail_seconds.is_finite() && spec.master.tail_seconds >= 0.0,
        "master tail must be finite and non-negative"
    );
    if let Some(drive) = spec.master.soft_clip_drive {
        ensure!(
            drive.is_finite() && drive > 0.0,
            "soft clip drive must be positive and finite"
        );
    }
    if let Some(ceiling) = spec.master.ceiling_db {
        ensure!(ceiling.is_finite(), "master ceiling must be finite");
    }
    let total_beats = song_beats(spec);
    let mut ids = HashSet::new();
    for track in &spec.tracks {
        ensure!(
            !track.id.is_empty()
                && track
                    .id
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || "-_".contains(character)),
            "track ID '{}' must use only letters, numbers, '-' and '_'",
            track.id
        );
        ensure!(ids.insert(&track.id), "duplicate track ID '{}'", track.id);
        ensure!(
            track.choke_group.is_none_or(|group| group > 0),
            "track '{}' choke group must be positive",
            track.id
        );
        ensure!(
            track.gain_db.is_finite(),
            "track '{}' has invalid gain",
            track.id
        );
        ensure!(
            track.pan.is_finite() && (-1.0..=1.0).contains(&track.pan),
            "track '{}' pan must be between -1 and 1",
            track.id
        );
        validate_cutoff(track.high_pass_hz, spec.sample_rate, &track.id)?;
        validate_cutoff(track.low_pass_hz, spec.sample_rate, &track.id)?;
        let event_limit = if let Some(pattern) = &track.pattern {
            ensure!(
                pattern.length_beats.is_finite() && pattern.length_beats > 0.0,
                "track '{}' has an invalid pattern length",
                track.id
            );
            ensure!(
                pattern.repeats > 0
                    && pattern.length_beats * f64::from(pattern.repeats) <= total_beats,
                "track '{}' pattern repeats beyond the song",
                track.id
            );
            pattern.length_beats
        } else {
            total_beats
        };
        if let Some(sidechain) = &track.sidechain {
            ensure!(
                sidechain.every_beats.is_finite() && sidechain.every_beats > 0.0,
                "track '{}' has invalid sidechain interval",
                track.id
            );
            ensure!(
                sidechain.hold_beats >= 0.0 && sidechain.release_beats > 0.0,
                "track '{}' has invalid sidechain timing",
                track.id
            );
            ensure!(
                sidechain.depth_db <= 0.0 && sidechain.curve > 0.0,
                "track '{}' has invalid sidechain shape",
                track.id
            );
        }
        for effect in &track.effects {
            match effect {
                TrackEffectSpec::AutoFilter {
                    cutoff_hz,
                    resonance,
                    drive_db,
                    cutoff_automation,
                    ..
                } => {
                    validate_cutoff(Some(*cutoff_hz), spec.sample_rate, &track.id)?;
                    ensure!(
                        resonance.is_finite() && (0.0..=1.0).contains(resonance),
                        "track '{}' Auto Filter resonance must be between 0 and 1",
                        track.id
                    );
                    ensure!(
                        drive_db.is_finite(),
                        "track '{}' Auto Filter drive is invalid",
                        track.id
                    );
                    let mut previous_beat = None;
                    for point in cutoff_automation {
                        ensure!(
                            point.beat.is_finite()
                                && point.beat >= 0.0
                                && point.beat <= total_beats
                                && previous_beat.is_none_or(|previous| point.beat > previous),
                            "track '{}' Auto Filter automation beats must be ordered and inside the song",
                            track.id
                        );
                        validate_cutoff(Some(point.cutoff_hz), spec.sample_rate, &track.id)?;
                        ensure!(
                            point.curve.is_finite() && point.curve > 0.0,
                            "track '{}' Auto Filter curve must be positive",
                            track.id
                        );
                        previous_beat = Some(point.beat);
                    }
                }
                TrackEffectSpec::Saturator {
                    drive_db,
                    output_db,
                    mix,
                    ..
                } => ensure!(
                    drive_db.is_finite()
                        && output_db.is_finite()
                        && mix.is_finite()
                        && (0.0..=1.0).contains(mix),
                    "track '{}' has invalid Saturator settings",
                    track.id
                ),
                TrackEffectSpec::Delay {
                    left_beats,
                    right_beats,
                    feedback,
                    mix,
                    ..
                } => ensure!(
                    left_beats.is_finite()
                        && *left_beats > 0.0
                        && right_beats.is_finite()
                        && *right_beats > 0.0
                        && feedback.is_finite()
                        && (0.0..0.98).contains(feedback)
                        && mix.is_finite()
                        && (0.0..=1.0).contains(mix),
                    "track '{}' has invalid Delay settings",
                    track.id
                ),
            }
        }
        match &track.source {
            TrackSource::Serum { patch, notes } => {
                ensure!(
                    !patch.as_os_str().is_empty(),
                    "track '{}' needs a Serum patch",
                    track.id
                );
                for (index, note) in notes.iter().enumerate() {
                    validate_event(
                        note.beat,
                        note.duration_beats,
                        note.velocity,
                        event_limit,
                        &track.id,
                        index,
                    )?;
                }
            }
            TrackSource::NoiseDrum { triggers, .. } => {
                for (index, trigger) in triggers.iter().enumerate() {
                    validate_event(
                        trigger.beat,
                        trigger.duration_beats,
                        trigger.velocity,
                        event_limit,
                        &track.id,
                        index,
                    )?;
                }
            }
            TrackSource::Sample {
                sample,
                one_shot: _,
                velocity_amount,
                trim_start_seconds,
                trim_end_seconds,
                fade_out_seconds,
                triggers,
            } => {
                ensure!(
                    !sample.as_os_str().is_empty(),
                    "track '{}' needs a sample",
                    track.id
                );
                ensure!(
                    velocity_amount.is_finite() && (0.0..=1.0).contains(velocity_amount),
                    "track '{}' sample velocity amount must be between 0 and 1",
                    track.id
                );
                ensure!(
                    trim_start_seconds.is_finite() && *trim_start_seconds >= 0.0,
                    "track '{}' has an invalid sample trim start",
                    track.id
                );
                if let Some(trim_end_seconds) = trim_end_seconds {
                    ensure!(
                        trim_end_seconds.is_finite() && *trim_end_seconds > *trim_start_seconds,
                        "track '{}' has an invalid sample trim end",
                        track.id
                    );
                }
                ensure!(
                    fade_out_seconds.is_finite() && *fade_out_seconds >= 0.0,
                    "track '{}' has an invalid sample fade",
                    track.id
                );
                for (index, trigger) in triggers.iter().enumerate() {
                    validate_event(
                        trigger.beat,
                        trigger.duration_beats,
                        trigger.velocity,
                        event_limit,
                        &track.id,
                        index,
                    )?;
                }
            }
            TrackSource::Sampler { zones, notes } => {
                ensure!(
                    !zones.is_empty(),
                    "track '{}' needs at least one sampler zone",
                    track.id
                );
                for (index, zone) in zones.iter().enumerate() {
                    ensure!(
                        !zone.sample.as_os_str().is_empty(),
                        "track '{}' sampler zone {index} needs a sample",
                        track.id
                    );
                    ensure!(
                        zone.key_min <= zone.key_max && zone.velocity_min <= zone.velocity_max,
                        "track '{}' sampler zone {index} has invalid ranges",
                        track.id
                    );
                    ensure!(
                        zone.source_sample_rate > 0,
                        "track '{}' sampler zone {index} has invalid source rate",
                        track.id
                    );
                    ensure!(
                        zone.gain_db.is_finite()
                            && zone.pan.is_finite()
                            && (-1.0..=1.0).contains(&zone.pan)
                            && zone.detune_cents.is_finite(),
                        "track '{}' sampler zone {index} has invalid mix or tuning",
                        track.id
                    );
                    ensure!(
                        zone.attack_seconds.is_finite()
                            && zone.attack_seconds >= 0.0
                            && zone.decay_seconds.is_finite()
                            && zone.decay_seconds >= 0.0
                            && zone.release_seconds.is_finite()
                            && zone.release_seconds >= 0.0
                            && zone.sustain_level.is_finite()
                            && (0.0..=1.0).contains(&zone.sustain_level)
                            && zone.velocity_amount.is_finite()
                            && (0.0..=1.0).contains(&zone.velocity_amount),
                        "track '{}' sampler zone {index} has an invalid envelope",
                        track.id
                    );
                    if let Some(end) = zone.sample_end_frame {
                        ensure!(
                            end > zone.sample_start_frame,
                            "track '{}' sampler zone {index} has invalid sample bounds",
                            track.id
                        );
                    }
                    if let Some(sample_loop) = &zone.sustain_loop {
                        ensure!(
                            sample_loop.end_frame > sample_loop.start_frame,
                            "track '{}' sampler zone {index} has invalid sustain loop",
                            track.id
                        );
                    }
                }
                for (index, note) in notes.iter().enumerate() {
                    validate_event(
                        note.beat,
                        note.duration_beats,
                        note.velocity,
                        event_limit,
                        &track.id,
                        index,
                    )?;
                }
            }
        }
    }
    Ok(())
}

fn resolve_sample_path(path: &Path, spec_directory: &Path) -> PathBuf {
    if path.is_absolute() {
        return path.to_owned();
    }
    if let Some(text) = path.to_str()
        && let Some(relative) = text.strip_prefix("~/")
        && let Some(home) = std::env::var_os("HOME")
    {
        return PathBuf::from(home).join(relative);
    }
    spec_directory.join(path)
}

fn read_sample(path: &Path, target_sample_rate: u32) -> Result<Vec<[f32; 2]>> {
    let decoded = decode_audio_file_with_channels(path)
        .with_context(|| format!("failed to decode sample {}", path.display()))?;
    let source_sample_rate = decoded.source().sample_rate();
    let source = if let Some([left, right]) = decoded.stereo() {
        left.samples()
            .iter()
            .copied()
            .zip(right.samples().iter().copied())
            .map(|(left, right)| [left, right])
            .collect::<Vec<_>>()
    } else {
        decoded
            .mono()
            .samples()
            .iter()
            .copied()
            .map(|sample| [sample, sample])
            .collect::<Vec<_>>()
    };
    ensure!(!source.is_empty(), "sample {} is empty", path.display());
    if source_sample_rate == target_sample_rate {
        return Ok(source);
    }
    let ratio = f64::from(source_sample_rate) / f64::from(target_sample_rate);
    let output_frames = (source.len() as f64 / ratio).ceil() as usize;
    Ok((0..output_frames)
        .map(|index| {
            let position = index as f64 * ratio;
            let before = position.floor() as usize;
            let after = (before + 1).min(source.len().saturating_sub(1));
            let fraction = (position - before as f64) as f32;
            [
                source[before][0] + (source[after][0] - source[before][0]) * fraction,
                source[before][1] + (source[after][1] - source[before][1]) * fraction,
            ]
        })
        .collect())
}

fn expand_notes(notes: &[NoteSpec], pattern: Option<&PatternSpec>) -> Vec<NoteSpec> {
    let Some(pattern) = pattern else {
        return notes.to_vec();
    };
    (0..pattern.repeats)
        .flat_map(|repeat| {
            let offset = pattern.length_beats * f64::from(repeat);
            notes.iter().cloned().map(move |mut note| {
                note.beat += offset;
                note
            })
        })
        .collect()
}

fn expand_triggers(triggers: &[TriggerSpec], pattern: Option<&PatternSpec>) -> Vec<TriggerSpec> {
    let Some(pattern) = pattern else {
        return triggers.to_vec();
    };
    (0..pattern.repeats)
        .flat_map(|repeat| {
            let offset = pattern.length_beats * f64::from(repeat);
            triggers.iter().cloned().map(move |mut trigger| {
                trigger.beat += offset;
                trigger
            })
        })
        .collect()
}

fn validate_event(
    beat: f64,
    duration_beats: f64,
    velocity: u8,
    total_beats: f64,
    track: &str,
    index: usize,
) -> Result<()> {
    ensure!(
        beat.is_finite() && beat >= 0.0,
        "track '{track}' event {index} has an invalid beat"
    );
    ensure!(
        duration_beats.is_finite() && duration_beats > 0.0,
        "track '{track}' event {index} has an invalid duration"
    );
    ensure!(
        beat + duration_beats <= total_beats,
        "track '{track}' event {index} ends after the song"
    );
    ensure!(
        velocity > 0,
        "track '{track}' event {index} has zero velocity"
    );
    Ok(())
}

fn validate_cutoff(cutoff: Option<f32>, sample_rate: u32, track: &str) -> Result<()> {
    if let Some(cutoff) = cutoff {
        ensure!(
            cutoff.is_finite() && cutoff > 0.0 && cutoff < sample_rate as f32 / 2.0,
            "track '{track}' has an invalid filter cutoff"
        );
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct BiquadCoefficients {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
}

impl BiquadCoefficients {
    fn filter(filter_type: FilterType, cutoff_hz: f32, q: f32, sample_rate: u32) -> Self {
        let omega = std::f32::consts::TAU * cutoff_hz / sample_rate as f32;
        let cosine = omega.cos();
        let alpha = omega.sin() / (2.0 * q.max(0.01));
        let a0 = 1.0 + alpha;
        let (b0, b1, b2) = match filter_type {
            FilterType::LowPass => ((1.0 - cosine) * 0.5, 1.0 - cosine, (1.0 - cosine) * 0.5),
            FilterType::HighPass => ((1.0 + cosine) * 0.5, -(1.0 + cosine), (1.0 + cosine) * 0.5),
        };
        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: -2.0 * cosine / a0,
            a2: (1.0 - alpha) / a0,
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Biquad {
    input_1: f32,
    input_2: f32,
    output_1: f32,
    output_2: f32,
}

impl Biquad {
    fn process(&mut self, input: f32, coefficients: BiquadCoefficients) -> f32 {
        let output = coefficients.b0 * input
            + coefficients.b1 * self.input_1
            + coefficients.b2 * self.input_2
            - coefficients.a1 * self.output_1
            - coefficients.a2 * self.output_2;
        self.input_2 = self.input_1;
        self.input_1 = input;
        self.output_2 = self.output_1;
        self.output_1 = output;
        output
    }
}

struct OnePoleLowPass {
    alpha: f32,
    previous: f32,
}

impl OnePoleLowPass {
    fn new(cutoff_hz: f32, sample_rate: u32) -> Self {
        let time = 1.0 / (std::f32::consts::TAU * cutoff_hz);
        let period = 1.0 / sample_rate as f32;
        Self {
            alpha: period / (time + period),
            previous: 0.0,
        }
    }

    fn process(&mut self, input: f32) -> f32 {
        self.previous += self.alpha * (input - self.previous);
        self.previous
    }
}

struct OnePoleHighPass {
    alpha: f32,
    previous_input: f32,
    previous_output: f32,
}

impl OnePoleHighPass {
    fn new(cutoff_hz: f32, sample_rate: u32) -> Self {
        let time = 1.0 / (std::f32::consts::TAU * cutoff_hz);
        let period = 1.0 / sample_rate as f32;
        Self {
            alpha: time / (time + period),
            previous_input: 0.0,
            previous_output: 0.0,
        }
    }

    fn process(&mut self, input: f32) -> f32 {
        let output = self.alpha * (self.previous_output + input - self.previous_input);
        self.previous_input = input;
        self.previous_output = output;
        output
    }
}

struct Noise(u64);

impl Noise {
    fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        let normalized = (self.0 >> 40) as f32 / ((1_u32 << 24) - 1) as f32;
        normalized * 2.0 - 1.0
    }
}

fn song_beats(spec: &SongSpec) -> f64 {
    f64::from(spec.bars * spec.beats_per_bar)
}

fn peak_linear(frames: &[[f32; 2]]) -> f32 {
    frames
        .iter()
        .flat_map(|frame| frame.iter())
        .fold(0.0_f32, |peak, sample| peak.max(sample.abs()))
}

fn peak_db(frames: &[[f32; 2]]) -> f32 {
    gain_to_db(peak_linear(frames))
}

fn rms_db(frames: &[[f32; 2]]) -> f32 {
    if frames.is_empty() {
        return f32::NEG_INFINITY;
    }
    let squares = frames
        .iter()
        .flat_map(|frame| frame.iter())
        .map(|sample| sample * sample)
        .sum::<f32>();
    gain_to_db((squares / (frames.len() * 2) as f32).sqrt())
}

fn db_to_gain(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

fn gain_to_db(gain: f32) -> f32 {
    if gain > 0.0 {
        20.0 * gain.log10()
    } else {
        f32::NEG_INFINITY
    }
}

const fn default_beats_per_bar() -> u32 {
    4
}

const fn default_sample_rate() -> u32 {
    DEFAULT_SAMPLE_RATE
}

const fn default_sidechain_every_beats() -> f64 {
    1.0
}

const fn default_sidechain_hold_beats() -> f64 {
    0.04
}

const fn default_sidechain_release_beats() -> f64 {
    0.48
}

const fn default_sidechain_depth_db() -> f32 {
    -18.0
}

const fn default_sidechain_curve() -> f32 {
    0.65
}

const fn default_tail_seconds() -> f64 {
    1.0
}

const fn default_sample_fade_out_seconds() -> f64 {
    0.008
}

const fn default_sample_velocity_amount() -> f32 {
    1.0
}

const fn default_sample_source_rate() -> u32 {
    DEFAULT_SAMPLE_RATE
}

const fn default_sampler_sustain_level() -> f32 {
    1.0
}

const fn default_effect_mix() -> f32 {
    1.0
}

const fn default_filter_curve() -> f32 {
    1.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_song() -> SongSpec {
        SongSpec {
            schema_version: 1,
            title: "Test".to_owned(),
            bpm: 126.0,
            bars: 1,
            beats_per_bar: 4,
            sample_rate: 48_000,
            master: MasterSpec::default(),
            tracks: vec![TrackSpec {
                id: "hat".to_owned(),
                pattern: None,
                gain_db: 0.0,
                pan: 0.0,
                high_pass_hz: None,
                low_pass_hz: None,
                sidechain: None,
                choke_group: None,
                effects: Vec::new(),
                source: TrackSource::NoiseDrum {
                    voice: NoiseVoice::Hat,
                    triggers: vec![TriggerSpec {
                        beat: 0.5,
                        duration_beats: 0.25,
                        velocity: 100,
                    }],
                },
            }],
        }
    }

    #[test]
    fn accepts_a_valid_song() {
        validate_song(&minimal_song()).expect("valid song");
    }

    #[test]
    fn rejects_duplicate_track_ids() {
        let mut song = minimal_song();
        song.tracks.push(song.tracks[0].clone());
        assert!(validate_song(&song).is_err());
    }

    #[test]
    fn tempo_sidechain_ducks_and_recovers() {
        let song = minimal_song();
        let mut frames = vec![[1.0, 1.0]; 48_000];
        apply_tempo_sidechain(
            &mut frames,
            &song,
            &SidechainSpec {
                every_beats: 1.0,
                hold_beats: 0.04,
                release_beats: 0.48,
                depth_db: -18.0,
                curve: 0.65,
            },
        );
        assert!(frames[0][0] < 0.13);
        assert!(frames[20_000][0] > 0.95);
    }

    #[test]
    fn noise_render_is_deterministic() {
        let song = minimal_song();
        let track = &song.tracks[0];
        let TrackSource::NoiseDrum { voice, triggers } = &track.source else {
            panic!("noise track")
        };
        let first = render_noise_track(&song, track, *voice, triggers, 48_000, 0);
        let second = render_noise_track(&song, track, *voice, triggers, 48_000, 0);
        assert_eq!(first.frames, second.frames);
        assert!(peak_linear(&first.frames) > 0.0);
    }

    #[test]
    fn cutoff_automation_interpolates_exponentially_and_holds() {
        let points = vec![
            FilterAutomationPoint {
                beat: 0.0,
                cutoff_hz: 100.0,
                curve: 1.0,
            },
            FilterAutomationPoint {
                beat: 4.0,
                cutoff_hz: 10_000.0,
                curve: 1.0,
            },
        ];
        assert!((automated_cutoff(2.0, 1_000.0, &points) - 1_000.0).abs() < 0.1);
        assert_eq!(automated_cutoff(8.0, 1_000.0, &points), 10_000.0);
    }

    #[test]
    fn ping_pong_delay_moves_an_impulse_between_channels() {
        let song = minimal_song();
        let mut frames = vec![[0.0, 0.0]; 48_000];
        frames[0][0] = 1.0;
        apply_delay(&mut frames, &song, 0.25, 0.25, 0.5, 1.0, true);
        let delay_frames = (48_000.0_f64 * 60.0 / 126.0 * 0.25).round() as usize;
        assert!(frames[delay_frames][0] > 0.99);
        assert!(frames[delay_frames * 2][1] > 0.49);
    }
}
