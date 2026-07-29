use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context, Result, bail};
use rekordbox_analyzer_core::{
    AnalysisOptions, AnlzFile, DatAnalysis, ExtAnalysis, RhythmMode, ThreeBandAnalysis,
    analyze_beat_sensor_events, analyze_to_directory_with_options, compare_beat_grids,
    compare_output_directories, compare_waveforms, decode_audio_file,
};

const ANALYZER_THREADS_ENV: &str = "REKORDBOX_ANALYZER_THREADS";
const ANALYZER_RHYTHM_MODE_ENV: &str = "REKORDBOX_ANALYZER_RHYTHM_MODE";
static TEMPORARY_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("-h" | "--help" | "help") => {
            ensure_exhausted(args, "help")?;
            println!(
                "Clean-room audio-to-Rekordbox analyzer\n\n\
                 Usage:\n  \
                   rekordbox-analyzer analyze AUDIO OUTPUT_DIR [LOG] [--threads N] [--rhythm-mode normal|dynamic|auto]\n  \
                   rekordbox-analyzer beat-sensor-events AUDIO [--sample-rate HZ]\n  \
                   rekordbox-analyzer beat-grid-diff REFERENCE_DIR CANDIDATE_DIR\n  \
                   rekordbox-analyzer doctor\n  \
                   rekordbox-analyzer diff REFERENCE_DIR CANDIDATE_DIR\n  \
                   rekordbox-analyzer waveform-diff REFERENCE_DIR CANDIDATE_DIR\n  \
                   rekordbox-analyzer rebuild-anlz INPUT OUTPUT\n\n\
                 Commands:\n  \
                   analyze       Decode audio; Normal is static, Dynamic follows tempo changes\n  \
                   beat-sensor-events  Emit the causal six-band peak-event stream as JSON\n  \
                   beat-grid-diff  Align PQTZ/PQT2 grids and report semantic timing errors\n  \
                   doctor        Report codec, DSP, and proprietary-dependency status\n  \
                   diff          Compare reference and candidate ANLZ directories exactly\n  \
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
            println!("rekordbox-analyzer {}", env!("CARGO_PKG_VERSION"));
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
                resampled = decoded.mono().resample_linear(sample_rate)?;
                &resampled
            } else {
                decoded.mono()
            };
            let analysis = analyze_beat_sensor_events(pcm.samples(), pcm.sample_rate())?;
            println!("{}", serde_json::to_string(&analysis)?);
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
                    "dspCompatibility": "protocol-compatible-baseline",
                }))?
            );
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
            "usage: rekordbox-analyzer <analyze AUDIO OUTPUT_DIR [LOG] [--threads N] [--rhythm-mode normal|dynamic|auto]|beat-sensor-events AUDIO [--sample-rate HZ]|beat-grid-diff REFERENCE_DIR CANDIDATE_DIR|doctor|diff REFERENCE_DIR CANDIDATE_DIR|waveform-diff REFERENCE_DIR CANDIDATE_DIR|rebuild-anlz INPUT OUTPUT>"
        ),
    }
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
