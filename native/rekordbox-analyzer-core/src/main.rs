use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
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
        Some("rebuild-anlz") => {
            let input = required_path(args.next(), "input ANLZ path")?;
            let output = required_path(args.next(), "output ANLZ path")?;
            ensure_exhausted(args, "rebuild-anlz")?;
            let source = std::fs::read(&input)
                .with_context(|| format!("failed to read {}", input.display()))?;
            let rebuilt = rebuild(&input, &source)?;
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
                bail!("semantic ANLZ rebuild is not byte-for-byte compatible");
            }
            Ok(())
        }
        Some(command) => bail!("unknown command '{command}'"),
        None => bail!(
            "usage: rekordbox-analyzer-core <diff REFERENCE_DIR CANDIDATE_DIR|rebuild-anlz INPUT OUTPUT>"
        ),
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
