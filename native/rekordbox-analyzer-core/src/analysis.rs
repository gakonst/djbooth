use std::io::Write;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, mpsc};
use std::time::Instant;

use anyhow::{Context, Result, bail};
use rayon::ThreadPoolBuilder;
use serde::Serialize;

use crate::anlz::{
    AnlzFile, AnlzTag, DatAnalysis, ExtendedBeatGrid, ThreeBandAnalysis, WaveformColorConfig,
    build_empty_cue_tag, build_path_tag,
};
use crate::audio::{
    ANALYSIS_SAMPLE_RATE, AudioSourceInfo, DecodedAudio, decode_audio_file,
    decode_audio_file_with_progress,
};
use crate::key::{
    FFT_SIZE as KEY_FFT_SIZE, HOP_SIZE as KEY_HOP_SIZE, KeyAnalysis, KeyFeaturePlan,
    RawChromaFeatures, analyze_key, analyze_key_from_raw,
};
use crate::rhythm::{
    BeatAnalysis, FFT_SIZE as BEAT_FFT_SIZE, HOP_SIZE as BEAT_HOP_SIZE, OnsetEnvelopes,
    SpectralFluxPlan, TimeDomainAccumulator, TimeDomainEnvelopes, analyze_beats,
    analyze_beats_from_streamed_features, normalize_spectral_flux,
};
use crate::waveform::{StreamingWaveformAccumulator, WaveformData, extract_three_band_source};

const OUTPUT_NAMES: [(&str, &str); 3] = [
    ("DAT", "ANLZ0000.DAT"),
    ("EXT", "ANLZ0000.EXT"),
    ("2EX", "ANLZ0000.2EX"),
];
const VBR_ENTRY_COUNT: usize = 400;
const STREAMING_BATCH_FRAMES: usize = ANALYSIS_SAMPLE_RATE as usize * 5;
/// Profiled single-track worker default.
pub const DEFAULT_ANALYZER_THREADS: usize = 8;
/// Hard ceiling for one analyzer process.
pub const MAX_ANALYZER_THREADS: usize = 64;
static TEMPORARY_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Bounded native CPU budget for one track analysis.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AnalysisOptions {
    threads: usize,
}

impl AnalysisOptions {
    /// Validate an explicit native worker count.
    pub fn new(threads: usize) -> Result<Self> {
        if !(1..=MAX_ANALYZER_THREADS).contains(&threads) {
            bail!(
                "analyzer threads must be between 1 and {MAX_ANALYZER_THREADS}, received {threads}"
            );
        }
        Ok(Self { threads })
    }

    /// Use the profiled default, bounded by the host's available parallelism.
    pub fn automatic() -> Self {
        Self {
            threads: std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(1)
                .clamp(1, DEFAULT_ANALYZER_THREADS),
        }
    }

    /// Native workers available to this analysis.
    pub fn threads(self) -> usize {
        self.threads
    }
}

impl Default for AnalysisOptions {
    fn default() -> Self {
        Self::automatic()
    }
}

/// Complete clean-room DAT, EXT, and 2EX result before persistence.
#[derive(Debug, Clone)]
pub struct GeneratedAnalysis {
    pub dat: AnlzFile,
    pub ext: AnlzFile,
    pub two_ex: AnlzFile,
    pub beat: BeatAnalysis,
    pub key: KeyAnalysis,
    pub source: AudioSourceInfo,
    pub duration_seconds: f64,
}

/// JSON shape accepted by the existing `@gakonst/rekordbox` analyzer wrapper.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzerOutput {
    pub analyze_path: String,
    pub audio_path: String,
    pub backend: String,
    pub binary: String,
    pub callback_error: Option<String>,
    pub callback_status: Option<i32>,
    pub content_id: i64,
    pub native_log: String,
    pub outputs: Vec<(String, u64)>,
    pub start_result: i32,
    pub summary: OutputSummary,
    pub timings: AnalyzerTimings,
}

/// Bounded semantic summary of generated analysis artifacts.
#[derive(Debug, Clone, Serialize)]
pub struct OutputSummary {
    pub beat_grid: BeatGridSummary,
    pub files: Vec<AnalysisFileSummary>,
    pub key: String,
    pub key_source: String,
    pub tempo_bpm: f64,
}

/// Bounded beat-grid summary compatible with the TypeScript wrapper.
#[derive(Debug, Clone, Serialize)]
pub struct BeatGridSummary {
    pub avg_bpm: f64,
    pub beat_count: usize,
    pub first_beats: Vec<BeatSummary>,
    pub first_downbeat_ms: u32,
    pub last_beat_ms: u32,
    pub max_bpm: f64,
    pub min_bpm: f64,
}

/// One beat in the bounded JSON summary.
#[derive(Debug, Clone, Serialize)]
pub struct BeatSummary {
    pub beat: u16,
    pub bpm: f64,
    pub time_ms: u32,
}

/// One generated PMAI file in the JSON summary.
#[derive(Debug, Clone, Serialize)]
pub struct AnalysisFileSummary {
    pub path: String,
    pub size: u64,
    pub tags: Vec<String>,
}

/// Phase timings matching the existing native helper contract.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalyzerTimings {
    pub analyze_start_ms: f64,
    pub backend_ms: f64,
    pub completion_ms: f64,
    pub load_ms: f64,
    pub output_prepare_ms: f64,
    pub summarize_ms: f64,
    pub total_ms: f64,
}

/// Decode one local recording and produce clean-room DSP analysis in memory.
pub fn analyze_audio_file(path: impl AsRef<Path>) -> Result<GeneratedAnalysis> {
    analyze_audio_file_with_options(path, AnalysisOptions::default())
}

/// Decode one local recording with an explicit bounded native CPU budget.
pub fn analyze_audio_file_with_options(
    path: impl AsRef<Path>,
    options: AnalysisOptions,
) -> Result<GeneratedAnalysis> {
    let path = path.as_ref();
    let pool = ThreadPoolBuilder::new()
        .num_threads(options.threads())
        .thread_name(|index| format!("rekordbox-analyzer-{index}"))
        .build()
        .context("failed to create analyzer worker pool")?;
    let (decoded, streamed_features) = if options.threads() > 1 {
        decode_with_streaming_features(path, &pool)?
    } else {
        (decode_audio_file(path)?, None)
    };
    let source = decoded.source();
    let source_three_band = (source.sample_rate() != ANALYSIS_SAMPLE_RATE)
        .then(|| extract_three_band_source(decoded.mono()));
    let pcm = decoded.into_analysis_pcm()?;
    if pcm.is_empty() {
        bail!("decoded audio contains no PCM frames");
    }

    let (streamed_waveforms, streamed_onset, streamed_time_domain, streamed_key) =
        streamed_features
            .map(|features| {
                (
                    Some(features.waveforms),
                    Some(features.onset),
                    Some(features.time_domain),
                    Some(features.key),
                )
            })
            .unwrap_or_default();
    let (waveforms, (beat, key)) = pool.install(|| {
        rayon::join(
            || match streamed_waveforms {
                Some(waveforms) => Ok(waveforms),
                None => WaveformData::generate_with_three_band_source(&pcm, source_three_band),
            },
            || {
                rayon::join(
                    || match (streamed_onset, streamed_time_domain) {
                        (Some(onset), Some(time_domain)) => analyze_beats_from_streamed_features(
                            pcm.samples(),
                            pcm.sample_rate(),
                            onset,
                            time_domain,
                        ),
                        _ => analyze_beats(pcm.samples(), pcm.sample_rate()),
                    },
                    || match streamed_key {
                        Some(raw) => analyze_key_from_raw(raw, pcm.sample_rate()),
                        None => analyze_key(pcm.samples(), pcm.sample_rate()),
                    },
                )
            },
        )
    });
    let waveforms = waveforms?;
    let beat = beat?;
    let key = key?;
    let anlz_path = format!(
        "?/{}",
        path.file_name()
            .and_then(|value| value.to_str())
            .context("audio filename is not valid Unicode")?
    );
    let (vbr_index, vbr_trailer_unknown) = build_vbr_index(path)?;
    let hot_cues = build_empty_cue_tag(1)?;
    let memory_cues = build_empty_cue_tag(0)?;

    let dat = DatAnalysis {
        path: anlz_path.clone(),
        vbr_header_unknown: 0,
        vbr_index,
        vbr_trailer_unknown,
        beat_grid: beat.beats.clone(),
        preview_waveform: waveforms.monochrome_preview().to_vec(),
        tiny_preview_waveform: waveforms.tiny_preview().to_vec(),
        hot_cues: hot_cues.clone(),
        memory_cues: memory_cues.clone(),
    }
    .to_file()?;

    let extended_grid = ExtendedBeatGrid {
        unknown_1: 0,
        format: 0x0200_0002,
        unknown_2: 0,
        anchors: [
            beat.beats[0],
            *beat
                .beats
                .last()
                .expect("beat analysis yields at least four beats"),
        ],
        unknown_3: beat.beats.iter().fold(0u32, |sum, entry| {
            sum.wrapping_add(
                u32::from(entry.beat)
                    .wrapping_add(u32::from(entry.bpm_hundredths))
                    .wrapping_add(entry.time_ms),
            )
        }),
        unknown_4: 0,
        unknown_5: 0,
        entries: beat
            .beat_time_residuals_us
            .iter()
            .map(|residual| residual.to_be_bytes())
            .collect(),
    };
    let ext = AnlzFile::from_tags(vec![
        build_path_tag(&anlz_path)?,
        waveforms.pwv3().to_tag()?,
        hot_cues,
        memory_cues,
        build_empty_extended_cue_tag(1)?,
        build_empty_extended_cue_tag(0)?,
        extended_grid.to_tag()?,
        waveforms.pwv5().to_tag()?,
        waveforms.pwv4().to_tag()?,
        build_empty_song_structure_tag()?,
    ])?;

    let two_ex = ThreeBandAnalysis {
        path: anlz_path,
        detail_waveform: waveforms.pwv7(),
        preview_waveform: waveforms.pwv6(),
        color_config: WaveformColorConfig {
            unknown: 0,
            data: waveforms.three_band_normalize(),
        },
    }
    .to_file()?;

    Ok(GeneratedAnalysis {
        dat,
        ext,
        two_ex,
        beat,
        key,
        source,
        duration_seconds: pcm.duration_seconds(),
    })
}

struct StreamedFeatures {
    waveforms: WaveformData,
    onset: OnsetEnvelopes,
    time_domain: TimeDomainEnvelopes,
    key: RawChromaFeatures,
}

#[derive(Clone)]
struct StreamedPcmBatch {
    samples: Arc<[f32]>,
    range: Range<usize>,
}

enum StreamedPcmMessage {
    Samples(StreamedPcmBatch),
    Complete { beat_frame_count: usize },
    Abort,
}

fn decode_with_streaming_features(
    path: &Path,
    pool: &rayon::ThreadPool,
) -> Result<(DecodedAudio, Option<StreamedFeatures>)> {
    let beat_plan = SpectralFluxPlan::new();
    let key_plan = KeyFeaturePlan::new(ANALYSIS_SAMPLE_RATE);
    let (beat_sender, beat_receiver) = mpsc::channel();
    let (key_sender, key_receiver) = mpsc::channel();
    let (waveform_sender, waveform_receiver) = mpsc::channel();
    let (waveform_result_sender, waveform_result_receiver) = mpsc::channel();
    let (time_domain_sender, time_domain_receiver) = mpsc::channel();
    let (time_domain_result_sender, time_domain_result_receiver) = mpsc::channel();

    let (decoded, beat_jobs, key_jobs, streaming_active) = pool.install(|| {
        rayon::scope(|scope| -> Result<_> {
            let mut waveform_receiver = Some(waveform_receiver);
            let mut time_domain_receiver = Some(time_domain_receiver);
            let mut next_beat_frame = 0usize;
            let mut next_key_frame = 0usize;
            let mut next_stream_sample = 0usize;
            let mut beat_jobs = 0usize;
            let mut key_jobs = 0usize;
            let mut streaming_active = false;
            let decoded = decode_audio_file_with_progress(
                path,
                STREAMING_BATCH_FRAMES,
                |sample_rate, samples, complete| {
                    if sample_rate != ANALYSIS_SAMPLE_RATE {
                        return Ok(());
                    }
                    if !complete {
                        if !streaming_active {
                            streaming_active = true;
                            let receiver = waveform_receiver
                                .take()
                                .expect("waveform receiver starts once");
                            let sender = waveform_result_sender.clone();
                            scope.spawn(move |_| {
                                consume_streamed_waveforms(receiver, sender);
                            });
                            let receiver = time_domain_receiver
                                .take()
                                .expect("time-domain receiver starts once");
                            let sender = time_domain_result_sender.clone();
                            scope.spawn(move |_| {
                                consume_streamed_time_domain(receiver, sender);
                            });
                        }
                    } else if !streaming_active {
                        return Ok(());
                    }

                    let beat_frame_count =
                        complete_frame_count(samples.len(), BEAT_FFT_SIZE, BEAT_HOP_SIZE);
                    let key_frame_count =
                        complete_frame_count(samples.len(), KEY_FFT_SIZE, KEY_HOP_SIZE);
                    let beat_range = next_beat_frame..beat_frame_count;
                    let key_range = next_key_frame..key_frame_count;
                    if beat_range.is_empty()
                        && key_range.is_empty()
                        && next_stream_sample == samples.len()
                    {
                        if complete {
                            waveform_sender
                                .send(StreamedPcmMessage::Complete { beat_frame_count })
                                .context("streaming waveform worker disconnected")?;
                            time_domain_sender
                                .send(StreamedPcmMessage::Complete { beat_frame_count })
                                .context("streaming time-domain worker disconnected")?;
                        }
                        return Ok(());
                    }

                    let beat_start = (!beat_range.is_empty())
                        .then(|| beat_range.start.saturating_sub(1) * BEAT_HOP_SIZE);
                    let key_start = (!key_range.is_empty()).then(|| key_range.start * KEY_HOP_SIZE);
                    let required_start = beat_start
                        .into_iter()
                        .chain(key_start)
                        .chain([next_stream_sample])
                        .min()
                        .unwrap_or_default();
                    let copy_start = required_start / KEY_HOP_SIZE * KEY_HOP_SIZE;
                    let beat_end = (!beat_range.is_empty())
                        .then(|| (beat_range.end - 1) * BEAT_HOP_SIZE + BEAT_FFT_SIZE);
                    let key_end = (!key_range.is_empty())
                        .then(|| (key_range.end - 1) * KEY_HOP_SIZE + KEY_FFT_SIZE);
                    let copy_end = beat_end
                        .into_iter()
                        .chain(key_end)
                        .chain([samples.len()])
                        .max()
                        .unwrap_or(copy_start);
                    let batch = Arc::<[f32]>::from(&samples[copy_start..copy_end]);

                    if !beat_range.is_empty() {
                        let sender = beat_sender.clone();
                        let batch = Arc::clone(&batch);
                        let range_start = beat_range.start;
                        let local_start =
                            (beat_range.start * BEAT_HOP_SIZE - copy_start) / BEAT_HOP_SIZE;
                        let local_range = local_start..local_start + beat_range.len();
                        let plan = &beat_plan;
                        scope.spawn(move |_| {
                            let features = plan.extract(&batch, local_range);
                            sender
                                .send((range_start, features))
                                .expect("streaming beat receiver remains connected");
                        });
                        next_beat_frame = beat_range.end;
                        beat_jobs += 1;
                    }
                    if !key_range.is_empty() {
                        let sender = key_sender.clone();
                        let batch = Arc::clone(&batch);
                        let range_start = key_range.start;
                        let local_start =
                            (key_range.start * KEY_HOP_SIZE - copy_start) / KEY_HOP_SIZE;
                        let local_range = local_start..local_start + key_range.len();
                        let plan = &key_plan;
                        scope.spawn(move |_| {
                            let features = plan.extract(&batch, local_range);
                            sender
                                .send((range_start, features))
                                .expect("streaming key receiver remains connected");
                        });
                        next_key_frame = key_range.end;
                        key_jobs += 1;
                    }
                    let stream_batch = StreamedPcmBatch {
                        samples: batch,
                        range: next_stream_sample - copy_start..samples.len() - copy_start,
                    };
                    waveform_sender
                        .send(StreamedPcmMessage::Samples(stream_batch.clone()))
                        .context("streaming waveform worker disconnected")?;
                    time_domain_sender
                        .send(StreamedPcmMessage::Samples(stream_batch))
                        .context("streaming time-domain worker disconnected")?;
                    next_stream_sample = samples.len();
                    if complete {
                        waveform_sender
                            .send(StreamedPcmMessage::Complete { beat_frame_count })
                            .context("streaming waveform worker disconnected")?;
                        time_domain_sender
                            .send(StreamedPcmMessage::Complete { beat_frame_count })
                            .context("streaming time-domain worker disconnected")?;
                    }
                    Ok(())
                },
            );
            if decoded.is_err() && streaming_active {
                let _ = waveform_sender.send(StreamedPcmMessage::Abort);
                let _ = time_domain_sender.send(StreamedPcmMessage::Abort);
            }
            let decoded = decoded?;
            Ok((decoded, beat_jobs, key_jobs, streaming_active))
        })
    })?;

    if !streaming_active {
        return Ok((decoded, None));
    }

    let mut beat_chunks = receive_feature_chunks(&beat_receiver, beat_jobs)?;
    let mut key_chunks = receive_feature_chunks(&key_receiver, key_jobs)?;
    beat_chunks.sort_by_key(|(start, _)| *start);
    key_chunks.sort_by_key(|(start, _)| *start);
    let mut onset = OnsetEnvelopes::default();
    for (_, chunk) in beat_chunks {
        onset.append(chunk);
    }
    let mut key = RawChromaFeatures::default();
    for (_, chunk) in key_chunks {
        key.append(chunk);
    }
    let waveforms = waveform_result_receiver
        .recv()
        .context("streaming waveform worker disconnected")?;
    let time_domain = time_domain_result_receiver
        .recv()
        .context("streaming time-domain worker disconnected")?;
    Ok((
        decoded,
        Some(StreamedFeatures {
            waveforms,
            onset: normalize_spectral_flux(onset),
            time_domain,
            key,
        }),
    ))
}

fn consume_streamed_waveforms(
    receiver: mpsc::Receiver<StreamedPcmMessage>,
    result: mpsc::Sender<WaveformData>,
) {
    let mut accumulator = StreamingWaveformAccumulator::new();
    while let Ok(message) = receiver.recv() {
        match message {
            StreamedPcmMessage::Samples(batch) => {
                accumulator.push(&batch.samples[batch.range]);
            }
            StreamedPcmMessage::Complete { .. } => {
                result
                    .send(accumulator.finish())
                    .expect("streaming waveform result receiver remains connected");
                return;
            }
            StreamedPcmMessage::Abort => return,
        }
    }
}

fn consume_streamed_time_domain(
    receiver: mpsc::Receiver<StreamedPcmMessage>,
    result: mpsc::Sender<TimeDomainEnvelopes>,
) {
    let mut accumulator = TimeDomainAccumulator::new(ANALYSIS_SAMPLE_RATE);
    while let Ok(message) = receiver.recv() {
        match message {
            StreamedPcmMessage::Samples(batch) => {
                accumulator.push(&batch.samples[batch.range]);
            }
            StreamedPcmMessage::Complete { beat_frame_count } => {
                result
                    .send(accumulator.finish(beat_frame_count))
                    .expect("streaming time-domain result receiver remains connected");
                return;
            }
            StreamedPcmMessage::Abort => return,
        }
    }
}

fn complete_frame_count(sample_count: usize, frame_size: usize, hop_size: usize) -> usize {
    if sample_count < frame_size {
        0
    } else {
        1 + (sample_count - frame_size) / hop_size
    }
}

fn receive_feature_chunks<T>(
    receiver: &mpsc::Receiver<(usize, T)>,
    count: usize,
) -> Result<Vec<(usize, T)>> {
    (0..count)
        .map(|_| {
            receiver
                .recv()
                .context("streaming analysis worker disconnected")
        })
        .collect()
}

/// Analyze one recording, persist all artifacts, and return helper-compatible JSON.
pub fn analyze_to_directory(
    audio_path: impl AsRef<Path>,
    output_directory: impl AsRef<Path>,
    native_log_path: Option<&Path>,
) -> Result<AnalyzerOutput> {
    analyze_to_directory_with_options(
        audio_path,
        output_directory,
        native_log_path,
        AnalysisOptions::default(),
    )
}

/// Analyze one recording with an explicit native CPU budget and persist all artifacts.
pub fn analyze_to_directory_with_options(
    audio_path: impl AsRef<Path>,
    output_directory: impl AsRef<Path>,
    native_log_path: Option<&Path>,
    options: AnalysisOptions,
) -> Result<AnalyzerOutput> {
    let started = Instant::now();
    let audio_path = audio_path
        .as_ref()
        .canonicalize()
        .with_context(|| format!("failed to resolve {}", audio_path.as_ref().display()))?;
    let output_directory = output_directory.as_ref();
    std::fs::create_dir_all(output_directory)
        .with_context(|| format!("failed to create {}", output_directory.display()))?;
    let output_paths = OUTPUT_NAMES.map(|(_, name)| output_directory.join(name));
    let log_path = native_log_path
        .map(Path::to_path_buf)
        .unwrap_or_else(|| output_directory.join("clean-room-analyzer.log"));
    validate_write_targets(
        &audio_path,
        [
            ("DAT output", output_paths[0].as_path()),
            ("EXT output", output_paths[1].as_path()),
            ("2EX output", output_paths[2].as_path()),
            ("analyzer log", log_path.as_path()),
        ],
    )?;

    let load_started = Instant::now();
    let generated = analyze_audio_file_with_options(&audio_path, options)?;
    let backend_ms = load_started.elapsed().as_secs_f64() * 1_000.0;

    let output_started = Instant::now();
    let files = [
        (&output_paths[0], &generated.dat),
        (&output_paths[1], &generated.ext),
        (&output_paths[2], &generated.two_ex),
    ]
    .into_iter()
    .map(|(path, file)| -> Result<_> {
        let bytes = file.to_bytes()?;
        write_atomically(path, &bytes)?;
        Ok((
            path.clone(),
            bytes.len() as u64,
            file.tags()
                .iter()
                .map(AnlzTag::kind_text)
                .collect::<Vec<_>>(),
        ))
    })
    .collect::<Result<Vec<_>>>()?;
    let output_prepare_ms = output_started.elapsed().as_secs_f64() * 1_000.0;

    let summarize_started = Instant::now();
    let beat_grid = summarize_beats(&generated.beat);
    let file_summaries = files
        .iter()
        .map(|(path, size, tags)| AnalysisFileSummary {
            path: path.display().to_string(),
            size: *size,
            tags: tags.clone(),
        })
        .collect::<Vec<_>>();
    let outputs = files
        .iter()
        .map(|(path, size, _)| (path.display().to_string(), *size))
        .collect::<Vec<_>>();
    let summarize_ms = summarize_started.elapsed().as_secs_f64() * 1_000.0;
    let total_ms = started.elapsed().as_secs_f64() * 1_000.0;

    let log = format!(
        "backend=clean-room-rust-dsp\nsample_rate={ANALYSIS_SAMPLE_RATE}\nsource_sample_rate={}\nchannels={}\nduration_seconds={:.6}\ntempo_bpm={:.6}\ntempo_confidence={:.6}\nkey={}\nkey_confidence={:.6}\n",
        generated.source.sample_rate(),
        generated.source.channels(),
        generated.duration_seconds,
        generated.beat.bpm,
        generated.beat.confidence,
        generated.key.key,
        generated.key.confidence,
    );
    write_atomically(&log_path, log.as_bytes())?;

    Ok(AnalyzerOutput {
        analyze_path: files[0].0.display().to_string(),
        audio_path: audio_path.display().to_string(),
        backend: "clean-room-rust-dsp".to_string(),
        binary: std::env::current_exe()
            .unwrap_or_else(|_| PathBuf::from("rekordbox-analyzer"))
            .display()
            .to_string(),
        callback_error: None,
        callback_status: Some(0),
        content_id: i64::from(std::process::id()),
        native_log: log_path.display().to_string(),
        outputs,
        start_result: 0,
        summary: OutputSummary {
            beat_grid,
            files: file_summaries,
            key: generated.key.key,
            key_source: "clean-room-chroma".to_string(),
            tempo_bpm: generated.beat.bpm,
        },
        timings: AnalyzerTimings {
            analyze_start_ms: 0.0,
            backend_ms,
            completion_ms: 0.0,
            load_ms: 0.0,
            output_prepare_ms,
            summarize_ms,
            total_ms,
        },
    })
}

fn validate_write_targets<'a>(
    source: &Path,
    targets: impl IntoIterator<Item = (&'a str, &'a Path)>,
) -> Result<()> {
    let source = source
        .canonicalize()
        .with_context(|| format!("failed to resolve source {}", source.display()))?;
    let mut resolved = Vec::<(&str, PathBuf)>::new();
    for (label, target) in targets {
        reject_non_file_target(label, target)?;
        let identity = resolve_write_target(target)?;
        if identity == source {
            bail!("{label} '{}' collides with input audio", target.display());
        }
        if let Some((other_label, _)) = resolved
            .iter()
            .find(|(_, other_identity)| *other_identity == identity)
        {
            bail!("{label} '{}' collides with {other_label}", target.display());
        }
        resolved.push((label, identity));
    }
    Ok(())
}

fn reject_non_file_target(label: &str, path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            bail!(
                "{label} '{}' exists but is not a regular file",
                path.display()
            )
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("failed to inspect {}", path.display())),
    }
}

fn resolve_write_target(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .context("failed to resolve current directory")?
            .join(path)
    };
    if absolute.exists() {
        return absolute
            .canonicalize()
            .with_context(|| format!("failed to resolve output {}", absolute.display()));
    }
    let parent = absolute
        .parent()
        .context("output path has no parent directory")?
        .canonicalize()
        .with_context(|| format!("failed to resolve output parent for {}", absolute.display()))?;
    let name = absolute
        .file_name()
        .context("output path has no filename")?;
    Ok(parent.join(name))
}

fn summarize_beats(analysis: &BeatAnalysis) -> BeatGridSummary {
    let bpms = analysis
        .beats
        .iter()
        .map(|beat| f64::from(beat.bpm_hundredths) / 100.0)
        .collect::<Vec<_>>();
    BeatGridSummary {
        avg_bpm: bpms.iter().sum::<f64>() / bpms.len().max(1) as f64,
        beat_count: analysis.beats.len(),
        first_beats: analysis
            .beats
            .iter()
            .take(8)
            .map(|beat| BeatSummary {
                beat: beat.beat,
                bpm: f64::from(beat.bpm_hundredths) / 100.0,
                time_ms: beat.time_ms,
            })
            .collect(),
        first_downbeat_ms: analysis
            .beats
            .iter()
            .find(|beat| beat.beat == 1)
            .map(|beat| beat.time_ms)
            .unwrap_or_default(),
        last_beat_ms: analysis
            .beats
            .last()
            .map(|beat| beat.time_ms)
            .unwrap_or_default(),
        max_bpm: bpms.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        min_bpm: bpms.iter().copied().fold(f64::INFINITY, f64::min),
    }
}

fn build_empty_extended_cue_tag(cue_type: u32) -> Result<AnlzTag> {
    if cue_type > 1 {
        bail!("PCO2 cue type must be 0 (memory) or 1 (hot cue)");
    }
    let mut raw = vec![0u8; 20];
    raw[..4].copy_from_slice(b"PCO2");
    raw[4..8].copy_from_slice(&20u32.to_be_bytes());
    raw[8..12].copy_from_slice(&20u32.to_be_bytes());
    raw[12..16].copy_from_slice(&cue_type.to_be_bytes());
    AnlzTag::parse(&raw)
}

fn build_empty_song_structure_tag() -> Result<AnlzTag> {
    let mut raw = vec![0u8; 32];
    raw[..4].copy_from_slice(b"PSSI");
    raw[4..8].copy_from_slice(&32u32.to_be_bytes());
    raw[8..12].copy_from_slice(&32u32.to_be_bytes());
    raw[12..16].copy_from_slice(&24u32.to_be_bytes());
    AnlzTag::parse(&raw)
}

fn build_vbr_index(path: &Path) -> Result<(Vec<u32>, u32)> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if extension != "mp3" {
        return Ok((vec![0; VBR_ENTRY_COUNT], 0));
    }

    let bytes =
        std::fs::read(path).with_context(|| format!("failed to read MP3 {}", path.display()))?;
    build_xing_vbr_index(&bytes)
}

#[derive(Debug, Clone, Copy)]
struct Mp3Frame {
    offset: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Mp3Header {
    version: u8,
    layer: u8,
    sample_rate: usize,
    channel_mode: u8,
    has_crc: bool,
    frame_len: usize,
    sample_count: u16,
}

fn build_xing_vbr_index(data: &[u8]) -> Result<(Vec<u32>, u32)> {
    let Some((first_offset, first_header, data_frame_count, stream_bytes)) = find_xing_header(data)
    else {
        // Rekordbox 6.8.2 emits the native all-zero shape for Info/CBR streams
        // and for files without a validated Xing seek header.
        return Ok((vec![0; VBR_ENTRY_COUNT], 0));
    };
    if data_frame_count == 0 {
        return Ok((vec![0; VBR_ENTRY_COUNT], 0));
    }
    let stream_end = first_offset
        .checked_add(stream_bytes)
        .context("Xing byte span overflow")?;
    if stream_end != data.len() {
        return Ok((vec![0; VBR_ENTRY_COUNT], 0));
    }
    let conservative_frame_bound = data.len() / 96 + 1;
    if data_frame_count > conservative_frame_bound {
        bail!(
            "Xing frame count {data_frame_count} exceeds the MP3 byte-length bound \
             {conservative_frame_bound}"
        );
    }

    let geometry = first_header.geometry();
    let base = first_offset
        .checked_add(first_header.frame_len)
        .context("MP3 first-frame offset overflow")?;
    let mut frames = Vec::with_capacity(data_frame_count);
    let mut offset = base;
    for index in 0..data_frame_count {
        let header_bytes = data
            .get(offset..offset.saturating_add(4))
            .with_context(|| format!("Xing MP3 ended before data frame {index}"))?;
        let header = parse_mp3_header(header_bytes)
            .with_context(|| format!("invalid MPEG header at Xing data frame {index}"))?;
        if header.geometry() != geometry {
            bail!("MPEG stream geometry changed at Xing data frame {index}");
        }
        let frame_end = offset
            .checked_add(header.frame_len)
            .context("MP3 frame offset overflow")?;
        if frame_end > data.len() {
            bail!("Xing MP3 data frame {index} exceeds the input length");
        }
        frames.push(Mp3Frame { offset });
        offset = frame_end;
    }
    if offset != stream_end {
        bail!("Xing byte span ends at {stream_end}, but its declared frames end at {offset}");
    }

    let trailer = u32::try_from(
        data_frame_count
            .checked_mul(1_152)
            .context("Xing sample-count overflow")?,
    )
    .context("Xing sample count exceeds the PVBR field")?;
    let preroll_samples = 8_u64 * 1_152;
    let mut entries = Vec::with_capacity(VBR_ENTRY_COUNT);
    for index in 1..=VBR_ENTRY_COUNT {
        let target = u64::from(trailer) * index as u64 / VBR_ENTRY_COUNT as u64;
        let seek_sample = target.saturating_sub(preroll_samples);
        let frame_index = usize::try_from(seek_sample / 1_152)
            .unwrap_or(usize::MAX)
            .min(frames.len() - 1);
        let relative = frames[frame_index]
            .offset
            .checked_sub(base)
            .context("Xing data frame precedes its seek-table base")?;
        entries.push(u32::try_from(relative).context("PVBR byte offset exceeds 32 bits")?);
    }
    Ok((entries, trailer))
}

fn find_xing_header(data: &[u8]) -> Option<(usize, Mp3Header, usize, usize)> {
    let search_start = id3v2_end(data);
    for offset in search_start..data.len().saturating_sub(3) {
        let Some(header) = parse_mp3_header(data.get(offset..offset + 4)?) else {
            continue;
        };
        if !header.is_mpeg1_layer3() {
            continue;
        }
        let marker_offset = offset.checked_add(header.xing_marker_offset())?;
        if data.get(marker_offset..marker_offset + 4) != Some(b"Xing") {
            continue;
        }
        let flags = read_be_u32_at(data, marker_offset + 4)?;
        if flags & 0x3 != 0x3 {
            continue;
        }
        let frame_count = usize::try_from(read_be_u32_at(data, marker_offset + 8)?).ok()?;
        let stream_bytes = usize::try_from(read_be_u32_at(data, marker_offset + 12)?).ok()?;
        let next_offset = offset.checked_add(header.frame_len)?;
        let next_header = parse_mp3_header(data.get(next_offset..next_offset.checked_add(4)?)?)?;
        if next_header.geometry() != header.geometry() {
            continue;
        }
        return Some((offset, header, frame_count, stream_bytes));
    }
    None
}

fn id3v2_end(data: &[u8]) -> usize {
    if data.get(..3) != Some(b"ID3") || data.len() < 10 {
        return 0;
    }
    let size = data[6..10].iter().fold(0usize, |value, byte| {
        (value << 7) | usize::from(byte & 0x7f)
    });
    let footer = usize::from(data[5] & 0x10 != 0) * 10;
    (10 + size + footer).min(data.len())
}

fn parse_mp3_header(bytes: &[u8]) -> Option<Mp3Header> {
    let header = u32::from_be_bytes(bytes.try_into().ok()?);
    if header & 0xffe0_0000 != 0xffe0_0000 {
        return None;
    }
    let version = (header >> 19) & 0x3;
    let layer = (header >> 17) & 0x3;
    let bitrate_index = ((header >> 12) & 0xf) as usize;
    let sample_rate_index = ((header >> 10) & 0x3) as usize;
    let padding = ((header >> 9) & 1) as usize;
    if version == 1
        || layer == 0
        || bitrate_index == 0
        || bitrate_index == 15
        || sample_rate_index == 3
    {
        return None;
    }

    let mpeg1 = version == 3;
    let bitrate_table = match (mpeg1, layer) {
        (true, 3) => [
            0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448,
        ],
        (true, 2) => [
            0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384,
        ],
        (true, 1) => [
            0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
        ],
        (false, 3) => [
            0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256,
        ],
        (false, 2 | 1) => [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
        _ => return None,
    };
    let bitrate = bitrate_table[bitrate_index] as usize;
    let base_rate = [44_100usize, 48_000, 32_000][sample_rate_index];
    let sample_rate = match version {
        3 => base_rate,
        2 => base_rate / 2,
        0 => base_rate / 4,
        _ => return None,
    };
    let (frame_len, samples) = match layer {
        3 => (((12_000 * bitrate / sample_rate) + padding) * 4, 384),
        2 => (144_000 * bitrate / sample_rate + padding, 1_152),
        1 if mpeg1 => (144_000 * bitrate / sample_rate + padding, 1_152),
        1 => (72_000 * bitrate / sample_rate + padding, 576),
        _ => return None,
    };
    Some(Mp3Header {
        version: version as u8,
        layer: layer as u8,
        sample_rate,
        channel_mode: ((header >> 6) & 0x3) as u8,
        has_crc: header & 0x0001_0000 == 0,
        frame_len,
        sample_count: samples,
    })
}

impl Mp3Header {
    fn is_mpeg1_layer3(self) -> bool {
        self.version == 3 && self.layer == 1 && self.sample_count == 1_152
    }

    fn geometry(self) -> (u8, u8, usize, bool) {
        (
            self.version,
            self.layer,
            self.sample_rate,
            self.channel_mode == 3,
        )
    }

    fn xing_marker_offset(self) -> usize {
        let crc_bytes = usize::from(self.has_crc) * 2;
        let side_info_bytes = match (self.version == 3, self.channel_mode == 3) {
            (true, true) => 17,
            (true, false) => 32,
            (false, true) => 9,
            (false, false) => 17,
        };
        4 + crc_bytes + side_info_bytes
    }
}

fn read_be_u32_at(data: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_be_bytes(
        data.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
    ))
}

fn write_atomically(path: &Path, bytes: &[u8]) -> Result<()> {
    let sequence = TEMPORARY_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = path.with_extension(format!(
        "{}.{}.{}.tmp",
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default(),
        std::process::id(),
        sequence,
    ));
    let result = (|| -> Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .with_context(|| format!("failed to create {}", temporary.display()))?;
        file.write_all(bytes)
            .with_context(|| format!("failed to write {}", temporary.display()))?;
        file.sync_all()
            .with_context(|| format!("failed to sync {}", temporary.display()))?;
        drop(file);
        std::fs::rename(&temporary, path)
            .with_context(|| format!("failed to install {}", path.display()))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn automatic_worker_budget_uses_the_profiled_single_track_cap() {
        let available = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1);
        assert_eq!(
            AnalysisOptions::automatic().threads(),
            available.clamp(1, DEFAULT_ANALYZER_THREADS)
        );
        assert!(AnalysisOptions::new(MAX_ANALYZER_THREADS).is_ok());
        assert!(AnalysisOptions::new(0).is_err());
        assert!(AnalysisOptions::new(MAX_ANALYZER_THREADS + 1).is_err());
    }

    #[test]
    fn mp3_header_parser_accepts_mpeg1_layer3() {
        let header = parse_mp3_header(&[0xff, 0xfb, 0x94, 0x00]).expect("MPEG-1 Layer III");
        assert!(header.frame_len > 100);
        assert_eq!(header.sample_count, 1_152);
        assert!(header.is_mpeg1_layer3());
    }

    #[test]
    fn xing_vbr_index_is_relative_and_keeps_eight_decoder_frames() {
        let data_frame_count = 420usize;
        let mut mp3 = Vec::new();
        append_fake_mp3_frame(
            &mut mp3,
            [0xff, 0xfb, 0x90, 0x00],
            Some((b"Xing", data_frame_count)),
        );
        let base = mp3.len();
        let mut offsets = Vec::with_capacity(data_frame_count);
        for index in 0..data_frame_count {
            offsets.push(mp3.len());
            let header = if index % 2 == 0 {
                [0xff, 0xfb, 0x90, 0x00]
            } else {
                [0xff, 0xfb, 0xa0, 0x00]
            };
            append_fake_mp3_frame(&mut mp3, header, None);
        }
        let first_header =
            parse_mp3_header(&mp3[..4]).expect("fake Xing MPEG header after construction");
        let byte_count_offset = first_header.xing_marker_offset() + 12;
        let byte_count = u32::try_from(mp3.len())
            .expect("small fake MP3")
            .to_be_bytes();
        mp3[byte_count_offset..byte_count_offset + 4].copy_from_slice(&byte_count);

        let (entries, trailer) = build_xing_vbr_index(&mp3).expect("Xing PVBR");
        assert_eq!(entries.len(), 400);
        assert_eq!(trailer, 420 * 1_152);
        assert_eq!(entries[0], 0);
        assert_eq!(
            entries[399],
            u32::try_from(offsets[data_frame_count - 8] - base).expect("last relative offset")
        );
        assert!(
            entries.iter().all(
                |offset| usize::try_from(*offset).is_ok_and(|offset| offset < mp3.len() - base)
            )
        );
    }

    #[test]
    fn info_and_unmarked_mp3_streams_keep_native_zero_pvbr_shape() {
        for marker in [Some((b"Info".as_slice(), 400usize)), None] {
            let mut mp3 = Vec::new();
            append_fake_mp3_frame(&mut mp3, [0xff, 0xfb, 0x90, 0x00], marker);
            let (entries, trailer) = build_xing_vbr_index(&mp3).expect("zero PVBR");
            assert_eq!(entries, vec![0; VBR_ENTRY_COUNT]);
            assert_eq!(trailer, 0);
        }
    }

    #[test]
    fn empty_optional_tags_have_native_envelopes() {
        let pco2 = build_empty_extended_cue_tag(1).expect("PCO2");
        assert_eq!(pco2.kind(), *b"PCO2");
        assert_eq!(pco2.raw().len(), 20);
        let pssi = build_empty_song_structure_tag().expect("PSSI");
        assert_eq!(pssi.kind(), *b"PSSI");
        assert_eq!(pssi.header_len(), 32);
        assert_eq!(pssi.raw().len(), 32);
    }

    #[test]
    fn rejects_log_collisions_before_decoding_or_overwriting_any_path() {
        let root = tempdir().expect("temporary directory");
        let source = root.path().join("source.wav");
        let output = root.path().join("analysis");
        std::fs::write(&source, b"not audio").expect("source fixture");

        let source_error =
            analyze_to_directory(&source, &output, Some(&source)).expect_err("source collision");
        assert!(
            source_error
                .to_string()
                .contains("collides with input audio")
        );
        assert_eq!(
            std::fs::read(&source).expect("source retained"),
            b"not audio"
        );

        let dat = output.join("ANLZ0000.DAT");
        let artifact_error =
            analyze_to_directory(&source, &output, Some(&dat)).expect_err("artifact collision");
        assert!(
            artifact_error
                .to_string()
                .contains("collides with DAT output")
        );
        assert!(!dat.exists());

        let missing_log_parent = root.path().join("missing/log.txt");
        let parent_error = analyze_to_directory(&source, &output, Some(&missing_log_parent))
            .expect_err("missing log parent");
        assert!(
            parent_error
                .to_string()
                .contains("failed to resolve output parent")
        );
        assert!(!dat.exists());

        let directory_error =
            analyze_to_directory(&source, &output, Some(&output)).expect_err("directory log");
        assert!(
            directory_error
                .to_string()
                .contains("exists but is not a regular file")
        );
        assert!(!dat.exists());

        let ext_directory = output.join("ANLZ0000.EXT");
        std::fs::create_dir(&ext_directory).expect("artifact directory");
        let artifact_directory_error =
            analyze_to_directory(&source, &output, None).expect_err("directory artifact");
        assert!(artifact_directory_error.to_string().contains("EXT output"));
        assert!(!dat.exists());
    }

    fn append_fake_mp3_frame(data: &mut Vec<u8>, bytes: [u8; 4], marker: Option<(&[u8], usize)>) {
        let header = parse_mp3_header(&bytes).expect("fake MPEG header");
        let offset = data.len();
        data.resize(offset + header.frame_len, 0);
        data[offset..offset + 4].copy_from_slice(&bytes);
        if let Some((marker, frame_count)) = marker {
            let marker_offset = offset + header.xing_marker_offset();
            data[marker_offset..marker_offset + 4].copy_from_slice(marker);
            data[marker_offset + 4..marker_offset + 8].copy_from_slice(&3u32.to_be_bytes());
            data[marker_offset + 8..marker_offset + 12].copy_from_slice(
                &u32::try_from(frame_count)
                    .expect("small fake frame count")
                    .to_be_bytes(),
            );
            data[marker_offset + 12..marker_offset + 16].copy_from_slice(&0u32.to_be_bytes());
        }
    }
}
