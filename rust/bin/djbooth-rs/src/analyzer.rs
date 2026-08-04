use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result, bail};
use djbooth_analyzer::{
    AnalysisOptions, AnalysisSampleRateConverter, AnlzFile, DatAnalysis, ExtAnalysis, RhythmMode,
    ThreeBandAnalysis, analyze_beat_sensor_events, analyze_linked_rhythm_with_reader_padding,
    analyze_to_directory_with_options, compare_beat_grids, compare_output_directories,
    compare_waveforms, decode_audio_file, decode_audio_file_with_channels,
    extract_native_phrase_features, extract_unit_envelope_feature, score_unit_envelope_feature,
};
use serde::Serialize;

const ANALYZER_THREADS_ENV: &str = "REKORDBOX_ANALYZER_THREADS";
const ANALYZER_RHYTHM_MODE_ENV: &str = "REKORDBOX_ANALYZER_RHYTHM_MODE";
const PCM_PROBE_MAX_FRAMES: usize = 262_144;
const DIAGNOSTIC_PREVIEW_ITEMS: usize = 16;
static TEMPORARY_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn run(args: impl IntoIterator<Item = String>) -> Result<()> {
    let mut args = args.into_iter();
    match args.next().as_deref() {
        Some("-h" | "--help" | "help") => {
            ensure_exhausted(args, "help")?;
            println!(
                "Clean-room audio-to-Rekordbox analyzer\n\n\
                 Usage:\n  \
                   djbooth-rs analyzer analyze AUDIO OUTPUT_DIR [LOG] [--threads N] [--rhythm-mode normal|dynamic|auto]\n  \
                   djbooth-rs analyzer beat-sensor-events AUDIO [--sample-rate HZ]\n  \
                   djbooth-rs analyzer beat-grid-diff REFERENCE_DIR CANDIDATE_DIR\n  \
                   djbooth-rs analyzer doctor\n  \
                   djbooth-rs analyzer diff REFERENCE_DIR CANDIDATE_DIR\n  \
                   djbooth-rs analyzer pcm-probe AUDIO [--start N] [--frames N]\n  \
                   djbooth-rs analyzer phrase-features AUDIO REFERENCE_DAT [--offset N] [--limit N]\n  \
                   djbooth-rs analyzer unit-envelope AUDIO [--stages] [--values]\n  \
                   djbooth-rs analyzer waveform-diff REFERENCE_DIR CANDIDATE_DIR\n  \
                   djbooth-rs analyzer rebuild-anlz INPUT OUTPUT\n\n\
                 Commands:\n  \
                   analyze       Emit beat grids, key, waveforms, seek maps, and song structure\n  \
                   beat-sensor-events  Emit the causal six-band peak-event stream as JSON\n  \
                   beat-grid-diff  Align PQTZ/PQT2 grids and report semantic timing errors\n  \
                   doctor        Report codec, DSP, and proprietary-dependency status\n  \
                   diff          Compare reference and candidate ANLZ directories exactly\n  \
                   pcm-probe     Emit bounded raw/native-reader mono PCM bit patterns\n  \
                   phrase-features  Page native-shaped beat features using a reference grid\n  \
                   unit-envelope Trace linked bar-phase scores and selected numbering\n  \
                   waveform-diff  Compare decoded waveform components semantically\n  \
                   rebuild-anlz  Byte-exactly rebuild one supported Rekordbox 6.8.2 ANLZ shape\n\n\
                 Rhythm modes:\n  \
                   normal        Static grid for relatively consistent tempo (default)\n  \
                   dynamic       Per-beat grid for live, rubato, or changing tempo\n  \
                   auto          Conservative p05-p95 local-tempo selection"
            );
            Ok(())
        }
        Some("-V" | "--version") => {
            ensure_exhausted(args, "version")?;
            println!("djbooth-rs analyzer {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("analyze") => {
            let (audio, output, log, options) = analyze_arguments(args)?;
            let result =
                analyze_to_directory_with_options(&audio, &output, log.as_deref(), options)?;
            println!("{}", serde_json::to_string(&result)?);
            Ok(())
        }
        Some("beat-sensor-events") => {
            let audio = required_path(args.next(), "audio path")?;
            let mut sample_rate = None;
            while let Some(argument) = args.next() {
                let value = if argument == "--sample-rate" {
                    args.next()
                        .context("--sample-rate requires an integer value")?
                } else if let Some(value) = argument.strip_prefix("--sample-rate=") {
                    value.to_string()
                } else {
                    bail!("beat-sensor-events received unknown option '{argument}'");
                };
                if sample_rate.is_some() {
                    bail!("beat-sensor-events received --sample-rate more than once");
                }
                sample_rate = Some(
                    value
                        .parse::<u32>()
                        .with_context(|| format!("invalid sample rate '{value}'"))?,
                );
            }
            let decoded = decode_audio_file(&audio)?;
            let resampled;
            let pcm = if let Some(sample_rate) = sample_rate {
                resampled = decoded.rhythm_mono().resample_linear(sample_rate)?;
                &resampled
            } else {
                decoded.rhythm_mono()
            };
            let analysis = analyze_beat_sensor_events(pcm.samples(), pcm.sample_rate())?;
            println!("{}", serde_json::to_string(&analysis)?);
            Ok(())
        }
        Some("pcm-probe") => {
            let audio = required_path(args.next(), "audio path")?;
            let mut start = None;
            let mut frames = None;
            while let Some(argument) = args.next() {
                let (name, value) = if matches!(argument.as_str(), "--start" | "--frames") {
                    let value = args
                        .next()
                        .with_context(|| format!("{argument} requires an integer value"))?;
                    (argument, value)
                } else if let Some(value) = argument.strip_prefix("--start=") {
                    ("--start".to_string(), value.to_string())
                } else if let Some(value) = argument.strip_prefix("--frames=") {
                    ("--frames".to_string(), value.to_string())
                } else {
                    bail!("pcm-probe received unknown option '{argument}'");
                };
                let parsed = value
                    .parse::<usize>()
                    .with_context(|| format!("{name} must be an integer"))?;
                match name.as_str() {
                    "--start" if start.replace(parsed).is_some() => {
                        bail!("pcm-probe received --start more than once")
                    }
                    "--frames" if frames.replace(parsed).is_some() => {
                        bail!("pcm-probe received --frames more than once")
                    }
                    "--start" | "--frames" => {}
                    _ => unreachable!("validated pcm-probe option"),
                }
            }
            let start = start.unwrap_or_default();
            let frames = frames.unwrap_or(1_024);
            if frames == 0 || frames > PCM_PROBE_MAX_FRAMES {
                bail!("--frames must be between 1 and {PCM_PROBE_MAX_FRAMES}");
            }
            let decoded = decode_audio_file_with_channels(&audio)?;
            let [left, right] = decoded
                .stereo()
                .context("pcm-probe decoder did not retain source channels")?;
            let end = start
                .checked_add(frames)
                .context("pcm-probe frame range overflow")?
                .min(decoded.mono().len());
            if start >= decoded.mono().len() {
                bail!(
                    "--start {start} is outside decoded PCM with {} frames",
                    decoded.mono().len()
                );
            }
            println!(
                "{}",
                serde_json::to_string(&serde_json::json!({
                    "audioPath": audio,
                    "sampleRate": decoded.mono().sample_rate(),
                    "startFrame": start,
                    "requestedFrames": frames,
                    "returnedFrames": end - start,
                    "rawMonoBits": decoded.mono().samples()[start..end]
                        .iter()
                        .map(|sample| sample.to_bits())
                        .collect::<Vec<_>>(),
                    "rhythmMonoBits": decoded.rhythm_mono().samples()[start..end]
                        .iter()
                        .map(|sample| sample.to_bits())
                        .collect::<Vec<_>>(),
                    "leftBits": left.samples()[start..end]
                        .iter()
                        .map(|sample| sample.to_bits())
                        .collect::<Vec<_>>(),
                    "rightBits": right.samples()[start..end]
                        .iter()
                        .map(|sample| sample.to_bits())
                        .collect::<Vec<_>>(),
                }))?
            );
            Ok(())
        }
        Some("doctor") => {
            ensure_exhausted(args, "doctor")?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "backend": "clean-room-rust-dsp",
                    "cleanRoom": true,
                    "proprietaryDependencies": false,
                    "analysisSampleRate": 44_100,
                    "formats": ["WAV", "AIFF", "CAF", "MP3", "AAC/MP4", "ALAC", "FLAC", "Vorbis/OGG"],
                    "rhythmModes": ["normal", "dynamic", "auto"],
                    "defaultRhythmMode": "normal",
                    "dsp": ["beat-grid", "musical-key", "waveforms", "seek-table", "song-structure"],
                    "songStructure": "beat-synchronous-clean-room-baseline",
                    "dspCompatibility": "protocol-compatible-baseline",
                }))?
            );
            Ok(())
        }
        Some("unit-envelope") => {
            let audio = required_path(args.next(), "audio path")?;
            let mut include_values = false;
            let mut include_stages = false;
            for argument in args {
                match argument.as_str() {
                    "--values" if include_values => {
                        bail!("unit-envelope received --values more than once")
                    }
                    "--values" => include_values = true,
                    "--stages" if include_stages => {
                        bail!("unit-envelope received --stages more than once")
                    }
                    "--stages" => include_stages = true,
                    _ => bail!("unit-envelope received unknown option '{argument}'"),
                }
            }
            let decoded = decode_audio_file(&audio)?;
            let analysis = analyze_linked_rhythm_with_reader_padding(
                decoded.rhythm_mono().samples(),
                decoded.rhythm_mono().sample_rate(),
                4,
                decoded.source().reader_padding_frames(),
            )?;
            let converter = AnalysisSampleRateConverter::new(
                decoded.rhythm_mono().sample_rate(),
                analysis.sample_rate,
            )?;
            let prepared = converter.resample_mono_for_reader(
                decoded.rhythm_mono().samples(),
                decoded.source().reader_padding_frames(),
            )?;
            let feature = extract_unit_envelope_feature(&prepared, analysis.sample_rate)?;
            if include_values && feature.envelope_len() > PCM_PROBE_MAX_FRAMES {
                bail!(
                    "unit-envelope value count {} exceeds output bound {PCM_PROBE_MAX_FRAMES}",
                    feature.envelope_len()
                );
            }
            let scoring = score_unit_envelope_feature(&feature, &analysis.beats)?;
            let strong_peaks = feature
                .strong_peaks()
                .iter()
                .take(DIAGNOSTIC_PREVIEW_ITEMS)
                .map(|index| {
                    serde_json::json!({
                        "index": index,
                        "value": feature.envelope()[*index],
                    })
                })
                .collect::<Vec<_>>();
            let first = analysis.beats.first().context("linked grid is empty")?;
            let mut output = serde_json::json!({
                "audioPath": audio,
                "sampleRate": analysis.sample_rate,
                "totalFrames": analysis.total_frames,
                "beatCount": analysis.beats.len(),
                "firstBeat": {
                    "positionFrame": first.position_frame,
                    "periodMs": first.period_ms,
                    "beatNumber": first.beat_number,
                },
                "scoring": scoring,
                "strongPeakCount": feature.strong_peak_count(),
                "strongPeaks": strong_peaks,
            });
            if include_values {
                output
                    .as_object_mut()
                    .expect("unit-envelope output is an object")
                    .insert(
                        "envelope".to_string(),
                        serde_json::json!(feature.envelope()),
                    );
            }
            if include_stages {
                output
                    .as_object_mut()
                    .expect("unit-envelope output is an object")
                    .insert(
                        "stages".to_string(),
                        serde_json::json!({
                            "counts": {
                                "events": analysis.beat_sensor.events.len(),
                                "candidates": analysis.beat_sensor.candidates.len(),
                                "selectedCandidates":
                                    analysis.beat_sensor.selected_candidates.len(),
                                "hypotheses": analysis.beat_sensor.beat_hypotheses.len(),
                                "continuousHypotheses": analysis.continuous_hypotheses.len(),
                                "shortRunHypotheses": analysis.short_run_hypotheses.len(),
                                "provisionalSections": analysis.provisional_sections.len(),
                                "refinedSections": analysis.refined_sections.len(),
                                "suppressedHypotheses": analysis.suppressed_hypotheses.len(),
                                "adjustedSections": analysis.adjusted_sections.len(),
                                "expandedBeats": analysis.expanded_beats.len(),
                                "finalBeats": analysis.beats.len(),
                            },
                            "refinedSections": analysis
                                .refined_sections
                                .iter()
                                .take(DIAGNOSTIC_PREVIEW_ITEMS)
                                .collect::<Vec<_>>(),
                            "adjustedSections": analysis
                                .adjusted_sections
                                .iter()
                                .take(DIAGNOSTIC_PREVIEW_ITEMS)
                                .collect::<Vec<_>>(),
                            "firstExpandedBeats":
                                analysis.expanded_beats
                                    .iter()
                                    .take(DIAGNOSTIC_PREVIEW_ITEMS)
                                    .collect::<Vec<_>>(),
                            "firstFinalBeats":
                                analysis.beats
                                    .iter()
                                    .take(DIAGNOSTIC_PREVIEW_ITEMS)
                                    .collect::<Vec<_>>(),
                        }),
                    );
            }
            println!("{}", serde_json::to_string_pretty(&output)?);
            Ok(())
        }
        Some("beat-grid-diff") => {
            let reference = required_path(args.next(), "reference output directory")?;
            let candidate = required_path(args.next(), "candidate output directory")?;
            ensure_exhausted(args, "beat-grid-diff")?;
            let report = compare_beat_grids(&reference, &candidate)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        Some("diff") => {
            let reference = required_path(args.next(), "reference output directory")?;
            let candidate = required_path(args.next(), "candidate output directory")?;
            ensure_exhausted(args, "diff")?;
            let report = compare_output_directories(&reference, &candidate)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.exact {
                bail!("candidate DAT/EXT/2EX output is not byte-for-byte compatible");
            }
            Ok(())
        }
        Some("phrase-features") => {
            let audio = required_path(args.next(), "audio path")?;
            let reference_dat = required_path(args.next(), "reference DAT path")?;
            let mut offset = 0;
            let mut limit = 128;
            let mut saw_offset = false;
            let mut saw_limit = false;
            while let Some(argument) = args.next() {
                let (name, value) = if matches!(argument.as_str(), "--offset" | "--limit") {
                    let value = args
                        .next()
                        .with_context(|| format!("{argument} requires an integer value"))?;
                    (argument, value)
                } else if let Some(value) = argument.strip_prefix("--offset=") {
                    ("--offset".to_string(), value.to_string())
                } else if let Some(value) = argument.strip_prefix("--limit=") {
                    ("--limit".to_string(), value.to_string())
                } else {
                    bail!("phrase-features received unknown option '{argument}'");
                };
                let parsed = value
                    .parse::<usize>()
                    .with_context(|| format!("{name} must be a non-negative integer"))?;
                match name.as_str() {
                    "--offset" if !saw_offset => {
                        saw_offset = true;
                        offset = parsed;
                    }
                    "--offset" => bail!("phrase-features received --offset more than once"),
                    "--limit" if saw_limit => {
                        bail!("phrase-features received --limit more than once")
                    }
                    "--limit" if (1..=4_096).contains(&parsed) => {
                        saw_limit = true;
                        limit = parsed;
                    }
                    "--limit" => bail!("--limit must be between 1 and 4096"),
                    _ => unreachable!("validated phrase-features option"),
                }
            }

            let dat_bytes = std::fs::read(&reference_dat).with_context(|| {
                format!("failed to read reference DAT {}", reference_dat.display())
            })?;
            let dat_file = AnlzFile::parse(&dat_bytes).context("failed to parse reference DAT")?;
            let dat = DatAnalysis::parse(&dat_file).context("failed to decode reference DAT")?;
            let first = dat
                .beat_grid
                .first()
                .context("reference DAT contains no beat-grid entries")?;
            if first.bpm_hundredths == 0 {
                bail!("reference DAT starts with a zero BPM");
            }
            let bpm = f64::from(first.bpm_hundredths) * 0.01;
            let first_beat_ms = f64::from(first.time_ms);
            let decoded = decode_audio_file(&audio)?;
            let phrase_pcm = decoded.phrase_analysis_pcm()?;
            let trace = extract_native_phrase_features(
                phrase_pcm.samples(),
                phrase_pcm.sample_rate(),
                bpm,
                first_beat_ms,
            )?;
            let total = trace.low_level.len();
            let start = offset.min(total);
            let end = start.saturating_add(limit).min(total);
            let beats = (start..end)
                .map(|index| PhraseFeatureBeat {
                    all_level: trace.all_level[index],
                    all_power_quarter_energy: trace.all_power_quarter_energy[index],
                    all_power_quarter_peak: trace.all_power_quarter_peak[index],
                    beat: index + 1,
                    divided_low_level: trace.divided_low_level[index],
                    divided_middle_level: trace.divided_middle_level[index],
                    high_peak_eighths: trace.high_peak_eighths[index],
                    high_start: trace.boundaries.high_pass_2[index],
                    low_level: trace.low_level[index],
                    low_peak: trace.low_peak[index],
                    low_peak_quarters: trace.low_peak_quarters[index],
                    low_start: trace.boundaries.low_pass_32[index],
                    middle_level: trace.middle_level[index],
                    middle_peak: trace.middle_peak[index],
                    middle_start: trace.boundaries.low_pass_8[index],
                })
                .collect();
            let output = PhraseFeatureOutput {
                audio_path: audio.display().to_string(),
                bpm,
                first_beat_ms,
                page: PhraseFeaturePage {
                    has_more: end < total,
                    limit,
                    offset: start,
                    returned: end - start,
                    total,
                },
                reader_rate: phrase_pcm.sample_rate(),
                reference_dat: reference_dat.display().to_string(),
                beats,
            };
            println!("{}", serde_json::to_string(&output)?);
            Ok(())
        }
        Some("waveform-diff") => {
            let reference = required_path(args.next(), "reference output directory")?;
            let candidate = required_path(args.next(), "candidate output directory")?;
            ensure_exhausted(args, "waveform-diff")?;
            let report = compare_waveforms(&reference, &candidate)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            Ok(())
        }
        Some("rebuild-anlz") => {
            let input = required_path(args.next(), "input ANLZ path")?;
            let output = required_path(args.next(), "output ANLZ path")?;
            ensure_exhausted(args, "rebuild-anlz")?;
            let input = input
                .canonicalize()
                .with_context(|| format!("failed to resolve {}", input.display()))?;
            let source = std::fs::read(&input)
                .with_context(|| format!("failed to read {}", input.display()))?;
            let rebuilt = rebuild(&input, &source)?;
            if rebuilt != source {
                bail!("semantic ANLZ rebuild is not byte-for-byte compatible; output not written");
            }
            if let Some(parent) = output
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
            {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("failed to create {}", parent.display()))?;
            }
            reject_non_file_target(&output)?;
            if resolve_write_target(&output)? == input {
                bail!("rebuild input and output must be distinct; input was not overwritten");
            }
            write_atomically(&output, &rebuilt)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "byteExact": true,
                    "input": input,
                    "output": output,
                    "size": rebuilt.len(),
                }))?
            );
            Ok(())
        }
        Some(command) => bail!("unknown command '{command}'"),
        None => bail!(
            "usage: djbooth-rs analyzer <analyze AUDIO OUTPUT_DIR [LOG] [--threads N] [--rhythm-mode normal|dynamic|auto]|beat-sensor-events AUDIO [--sample-rate HZ]|beat-grid-diff REFERENCE_DIR CANDIDATE_DIR|doctor|diff REFERENCE_DIR CANDIDATE_DIR|pcm-probe AUDIO [--start N] [--frames N]|phrase-features AUDIO REFERENCE_DAT [--offset N] [--limit N]|unit-envelope AUDIO [--stages] [--values]|waveform-diff REFERENCE_DIR CANDIDATE_DIR|rebuild-anlz INPUT OUTPUT>"
        ),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhraseFeatureOutput {
    audio_path: String,
    reference_dat: String,
    reader_rate: u32,
    bpm: f64,
    first_beat_ms: f64,
    page: PhraseFeaturePage,
    beats: Vec<PhraseFeatureBeat>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhraseFeaturePage {
    total: usize,
    offset: usize,
    limit: usize,
    returned: usize,
    has_more: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhraseFeatureBeat {
    beat: usize,
    high_start: i32,
    middle_start: i32,
    low_start: i32,
    low_level: f64,
    middle_level: f64,
    divided_low_level: f64,
    divided_middle_level: f64,
    low_peak: f64,
    low_peak_quarters: [f64; 4],
    middle_peak: f64,
    all_level: f64,
    all_power_quarter_energy: [f64; 4],
    all_power_quarter_peak: [f64; 4],
    high_peak_eighths: [f64; 8],
}

fn analyze_arguments(
    mut args: impl Iterator<Item = String>,
) -> Result<(PathBuf, PathBuf, Option<PathBuf>, AnalysisOptions)> {
    let audio = required_path(args.next(), "audio path")?;
    let output = required_path(args.next(), "output directory")?;
    let mut log = None;
    let mut threads = None;
    let mut rhythm_mode = None;
    while let Some(argument) = args.next() {
        if argument == "--threads" {
            if threads.is_some() {
                bail!("analyze received --threads more than once");
            }
            let value = args.next().context("--threads requires an integer value")?;
            threads = Some(parse_analyzer_threads(&value, "--threads")?);
        } else if let Some(value) = argument.strip_prefix("--threads=") {
            if threads.is_some() {
                bail!("analyze received --threads more than once");
            }
            threads = Some(parse_analyzer_threads(value, "--threads")?);
        } else if argument == "--rhythm-mode" {
            if rhythm_mode.is_some() {
                bail!("analyze received --rhythm-mode more than once");
            }
            let value = args
                .next()
                .context("--rhythm-mode requires normal, dynamic, or auto")?;
            rhythm_mode = Some(parse_rhythm_mode(&value, "--rhythm-mode")?);
        } else if let Some(value) = argument.strip_prefix("--rhythm-mode=") {
            if rhythm_mode.is_some() {
                bail!("analyze received --rhythm-mode more than once");
            }
            rhythm_mode = Some(parse_rhythm_mode(value, "--rhythm-mode")?);
        } else if argument.starts_with('-') {
            bail!("analyze received unknown option '{argument}'");
        } else if log.is_none() {
            log = Some(PathBuf::from(argument));
        } else {
            bail!("analyze received unexpected extra argument '{argument}'");
        }
    }

    let options = match threads {
        Some(options) => options,
        None => match std::env::var(ANALYZER_THREADS_ENV) {
            Ok(value) => parse_analyzer_threads(&value, ANALYZER_THREADS_ENV)?,
            Err(std::env::VarError::NotPresent) => AnalysisOptions::automatic(),
            Err(std::env::VarError::NotUnicode(_)) => {
                bail!("{ANALYZER_THREADS_ENV} must contain a UTF-8 integer")
            }
        },
    };
    let rhythm_mode = match rhythm_mode {
        Some(mode) => mode,
        None => match std::env::var(ANALYZER_RHYTHM_MODE_ENV) {
            Ok(value) => parse_rhythm_mode(&value, ANALYZER_RHYTHM_MODE_ENV)?,
            Err(std::env::VarError::NotPresent) => options.rhythm_mode(),
            Err(std::env::VarError::NotUnicode(_)) => {
                bail!("{ANALYZER_RHYTHM_MODE_ENV} must contain normal, dynamic, or auto")
            }
        },
    };
    Ok((audio, output, log, options.with_rhythm_mode(rhythm_mode)))
}

fn parse_analyzer_threads(value: &str, source: &str) -> Result<AnalysisOptions> {
    let threads = value
        .parse::<usize>()
        .with_context(|| format!("{source} must be an integer"))?;
    AnalysisOptions::new(threads)
}

fn parse_rhythm_mode(value: &str, source: &str) -> Result<RhythmMode> {
    match value {
        "normal" => Ok(RhythmMode::Normal),
        "dynamic" => Ok(RhythmMode::Dynamic),
        "auto" => Ok(RhythmMode::Auto),
        _ => bail!("{source} must be normal, dynamic, or auto; received '{value}'"),
    }
}

fn rebuild(input: &Path, source: &[u8]) -> Result<Vec<u8>> {
    let parsed = AnlzFile::parse(source)?;
    match input
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_uppercase()
        .as_str()
    {
        "DAT" => DatAnalysis::parse(&parsed)?.to_file()?.to_bytes(),
        "EXT" => ExtAnalysis::parse(&parsed)?.to_file()?.to_bytes(),
        "2EX" => ThreeBandAnalysis::parse(&parsed)?.to_file()?.to_bytes(),
        _ => bail!("input must end in DAT, EXT, or 2EX"),
    }
}

fn required_path(value: Option<String>, name: &str) -> Result<PathBuf> {
    value
        .map(PathBuf::from)
        .with_context(|| format!("missing {name}"))
}

fn ensure_exhausted(mut args: impl Iterator<Item = String>, command: &str) -> Result<()> {
    if args.next().is_some() {
        bail!("{command} received unexpected extra arguments");
    }
    Ok(())
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

fn reject_non_file_target(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            bail!(
                "rebuild output '{}' exists but is not a regular file",
                path.display()
            )
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("failed to inspect {}", path.display())),
    }
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
