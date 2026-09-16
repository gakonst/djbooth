use std::path::PathBuf;
use std::sync::OnceLock;

use tracing_subscriber::{EnvFilter, fmt::writer::MakeWriterExt};

use crate::{LinkError, LinkResult};

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

impl LogLevel {
    pub fn parse(value: &str) -> LinkResult<Self> {
        match value.to_ascii_lowercase().as_str() {
            "error" => Ok(Self::Error),
            "warn" | "warning" => Ok(Self::Warn),
            "info" => Ok(Self::Info),
            "debug" => Ok(Self::Debug),
            "trace" => Ok(Self::Trace),
            _ => Err(LinkError::InvalidLogLevel(value.to_string())),
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warn => "warn",
            Self::Info => "info",
            Self::Debug => "debug",
            Self::Trace => "trace",
        }
    }
}

pub(crate) async fn init_djlink_tracing(
    log_path: Option<PathBuf>,
    level: LogLevel,
) -> LinkResult<()> {
    let Some(path) = log_path.as_ref() else {
        return Ok(());
    };
    // iOS starts a new server on cable changes. The global subscriber and its
    // writer outlive each server: never truncate the file they still write to.
    if LOG_PATH.get() == Some(path) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let file = tokio::fs::File::create(path).await?.into_std().await;
    let (file_writer, guard) = tracing_appender::non_blocking(file);
    let writer = file_writer.and(std::io::stderr);
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        // Browse transactions are low volume and essential to diagnosing a
        // stalled deck. Keep packet/audio tracing off at the debug level.
        let directive = if level == LogLevel::Debug {
            "debug,djtools_link::db=trace"
        } else {
            level.as_str()
        };
        EnvFilter::new(directive)
    });
    let subscriber = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_thread_ids(true)
        .with_thread_names(true)
        .with_target(true)
        .with_ansi(false)
        .with_writer(writer)
        .compact()
        .finish();

    match tracing::subscriber::set_global_default(subscriber) {
        Ok(()) => {
            let _ = LOG_PATH.set(path.clone());
            let _ = Box::leak(Box::new(guard));
        }
        Err(_) => {
            eprintln!(
                "tracing subscriber already initialized; DJ Link log file '{}' will not receive tracing events",
                path.display()
            );
        }
    }
    Ok(())
}
