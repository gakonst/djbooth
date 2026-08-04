use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use chrono::Utc;

use crate::paths::DjPaths;

pub struct CliLogger {
    path: PathBuf,
    file: std::fs::File,
}

impl CliLogger {
    pub fn start(paths: &DjPaths, cli_name: &str) -> Result<Self> {
        let dir = paths.cli_logs_dir(cli_name);
        std::fs::create_dir_all(&dir)
            .with_context(|| format!("failed to create '{}'", dir.display()))?;

        let timestamp = Utc::now().format("%Y%m%dT%H%M%SZ");
        let path = dir.join(format!("{timestamp}-{}.log", std::process::id()));
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .with_context(|| format!("failed to create '{}'", path.display()))?;

        Ok(Self { path, file })
    }

    pub fn log(&mut self, message: impl AsRef<str>) -> Result<()> {
        let line = format!("{} {}\n", Utc::now().to_rfc3339(), message.as_ref());
        self.file
            .write_all(line.as_bytes())
            .with_context(|| format!("failed to write '{}'", self.path.display()))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}
