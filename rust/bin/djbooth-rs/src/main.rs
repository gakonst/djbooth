mod ableton;
mod ableton_graph;
mod analyzer;
mod link;
mod plugin;
mod produce;
mod serum;
mod taste;
mod usb;
mod usb_cli;

use anyhow::{Result, bail};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("analyzer") => analyzer::run(args),
        Some("ableton") => ableton::run(args),
        Some("plugin") => plugin::run(args),
        Some("produce") => produce::run(args),
        Some("usb") => usb_cli::run(args),
        Some("link") => link::run(args).await,
        Some("-V" | "--version") => {
            println!("djbooth-rs {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("-h" | "--help" | "help") | None => {
            println!(
                "Native runtime for djbooth.ai\n\n\
                 Usage:\n  djbooth-rs <COMMAND> [OPTIONS]\n\n\
                 Commands:\n  analyzer  Analyze audio and produce Rekordbox-compatible artifacts\n  \
                 ableton   Inspect and import Ableton Core Library assets\n  \
                 plugin   Host and render VST2 instruments directly\n  \
                 produce  Render declarative multitrack productions\n  \
                 usb       Publish CDJ-compatible USB gadget images\n  \
                 link      Serve libraries over DJ Link"
            );
            Ok(())
        }
        Some(command) => bail!("unknown command '{command}'; run 'djbooth-rs --help'"),
    }
}
