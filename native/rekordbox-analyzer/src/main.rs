use std::path::PathBuf;

use anyhow::{Context, Result, bail};
use rekordbox_analyzer::backend::diagnose_rekordbox_backend;
use rekordbox_analyzer::rehost::{RehostOptions, run_rehost};

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
        Some(command) => bail!("unknown command '{command}'"),
        None => bail!("usage: rekordbox-analyzer <analyze AUDIO OUTPUT_DIR [NATIVE_LOG]|doctor>"),
    }
}

fn required_path(value: Option<String>, name: &str) -> Result<PathBuf> {
    value
        .map(PathBuf::from)
        .with_context(|| format!("missing {name}"))
}
