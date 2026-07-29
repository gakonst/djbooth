use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use rekordbox_analyzer::backend::diagnose_rekordbox_backend;
use rekordbox_analyzer::rehost::{RehostOptions, bundle_rekordbox_templates, run_rehost};
use rekordbox_analyzer_core::{
    AnlzFile, DatAnalysis, ExtAnalysis, ThreeBandAnalysis, compare_output_directories,
};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("analyze") => {
            let audio_path = required_path(args.next(), "audio path")?;
            let output_dir = required_path(args.next(), "output directory")?;
            let native_log_path = args.next().map(PathBuf::from);
            if args.next().is_some() {
                bail!("unexpected extra analyzer argument");
            }
            let result = run_rehost(RehostOptions {
                audio_path,
                output_dir,
                native_log_path,
                trace_path: None,
            })?;
            println!("{}", serde_json::to_string(&result)?);
            if !result.success() {
                bail!("Rekordbox analyzer did not produce a valid EXT file");
            }
            Ok(())
        }
        Some("analyze-trace") => {
            let audio_path = required_path(args.next(), "audio path")?;
            let output_dir = required_path(args.next(), "output directory")?;
            let trace_path = required_path(args.next(), "trace path")?;
            let native_log_path = args.next().map(PathBuf::from);
            if args.next().is_some() {
                bail!("unexpected extra analyzer trace argument");
            }
            let result = run_rehost(RehostOptions {
                audio_path,
                output_dir,
                native_log_path,
                trace_path: Some(trace_path),
            })?;
            println!("{}", serde_json::to_string(&result)?);
            if !result.success() {
                bail!("Rekordbox analyzer did not produce a valid EXT file");
            }
            Ok(())
        }
        Some("doctor") => {
            if args.next().is_some() {
                bail!("doctor accepts no arguments");
            }
            println!(
                "{}",
                serde_json::to_string_pretty(&diagnose_rekordbox_backend()?)?
            );
            Ok(())
        }
        Some("bundle-templates") => {
            let output_dir = required_path(args.next(), "output directory")?;
            if args.next().is_some() {
                bail!("bundle-templates accepts one output directory");
            }
            let outputs = bundle_rekordbox_templates(&output_dir)?
                .into_iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>();
            println!("{}", serde_json::to_string_pretty(&outputs)?);
            Ok(())
        }
        Some("diff") => {
            let reference_dir = required_path(args.next(), "reference output directory")?;
            let candidate_dir = required_path(args.next(), "candidate output directory")?;
            if args.next().is_some() {
                bail!("diff accepts reference and candidate output directories");
            }
            let report = compare_output_directories(&reference_dir, &candidate_dir)?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.exact {
                bail!("candidate DAT/EXT/2EX output is not byte-for-byte compatible");
            }
            Ok(())
        }
        Some("rebuild-dat") => {
            let input = required_path(args.next(), "input DAT path")?;
            let output = required_path(args.next(), "output DAT path")?;
            if args.next().is_some() {
                bail!("rebuild-dat accepts input and output DAT paths");
            }
            let source = std::fs::read(&input)
                .with_context(|| format!("failed to read {}", input.display()))?;
            let parsed = AnlzFile::parse(&source)?;
            let rebuilt = DatAnalysis::parse(&parsed)?.to_file()?.to_bytes()?;
            if let Some(parent) = output.parent() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("failed to create {}", parent.display()))?;
            }
            std::fs::write(&output, &rebuilt)
                .with_context(|| format!("failed to write {}", output.display()))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "byteExact": rebuilt == source,
                    "input": input,
                    "output": output,
                    "size": rebuilt.len(),
                }))?
            );
            if rebuilt != source {
                bail!("semantic DAT rebuild is not byte-for-byte compatible");
            }
            Ok(())
        }
        Some("rebuild-anlz") => {
            let input = required_path(args.next(), "input ANLZ path")?;
            let output = required_path(args.next(), "output ANLZ path")?;
            if args.next().is_some() {
                bail!("rebuild-anlz accepts input and output ANLZ paths");
            }
            let source = std::fs::read(&input)
                .with_context(|| format!("failed to read {}", input.display()))?;
            let parsed = AnlzFile::parse(&source)?;
            let extension = input
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_uppercase();
            let rebuilt = match extension.as_str() {
                "DAT" => DatAnalysis::parse(&parsed)?.to_file()?.to_bytes()?,
                "EXT" => ExtAnalysis::parse(&parsed)?.to_file()?.to_bytes()?,
                "2EX" => ThreeBandAnalysis::parse(&parsed)?.to_file()?.to_bytes()?,
                _ => bail!("rebuild-anlz input must end in DAT, EXT, or 2EX"),
            };
            if let Some(parent) = output.parent() {
                std::fs::create_dir_all(parent)
                    .with_context(|| format!("failed to create {}", parent.display()))?;
            }
            std::fs::write(&output, &rebuilt)
                .with_context(|| format!("failed to write {}", output.display()))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "byteExact": rebuilt == source,
                    "format": extension,
                    "input": input,
                    "output": output,
                    "size": rebuilt.len(),
                }))?
            );
            if rebuilt != source {
                bail!("semantic ANLZ rebuild is not byte-for-byte compatible");
            }
            Ok(())
        }
        Some(command) => bail!("unknown command '{command}'"),
        None => bail!(
            "usage: rekordbox-analyzer <analyze AUDIO OUTPUT_DIR [NATIVE_LOG]|analyze-trace AUDIO OUTPUT_DIR TRACE_JSON [NATIVE_LOG]|doctor|bundle-templates OUTPUT_DIR|diff REFERENCE_DIR CANDIDATE_DIR|rebuild-anlz INPUT OUTPUT|rebuild-dat INPUT_DAT OUTPUT_DAT>"
        ),
    }
}

fn required_path(value: Option<String>, name: &str) -> Result<PathBuf> {
    value
        .map(PathBuf::from)
        .with_context(|| format!("missing {name}"))
}
