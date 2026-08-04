use std::env;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use deunicode::deunicode;

#[derive(Clone, Debug)]
pub struct DjPaths {
    root: PathBuf,
}

impl DjPaths {
    pub fn from_env_or_default() -> Result<Self> {
        if let Ok(root) = env::var("DJTOOLS_ROOT") {
            return Ok(Self {
                root: PathBuf::from(root),
            });
        }

        let home = dirs::home_dir().context("failed to resolve home directory for ~/.djtools")?;
        Ok(Self {
            root: home.join(".djtools"),
        })
    }

    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn tracks_dir(&self) -> PathBuf {
        self.root.join("tracks")
    }

    pub fn sets_dir(&self) -> PathBuf {
        self.root.join("sets")
    }

    pub fn albums_dir(&self) -> PathBuf {
        self.root.join("albums")
    }

    pub fn playlists_dir(&self) -> PathBuf {
        self.root.join("playlists")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    pub fn cli_logs_dir(&self, cli: &str) -> PathBuf {
        self.logs_dir().join(cli)
    }

    pub fn ensure_base_dirs(&self) -> Result<()> {
        for path in [
            self.tracks_dir(),
            self.sets_dir(),
            self.albums_dir(),
            self.playlists_dir(),
            self.logs_dir(),
        ] {
            std::fs::create_dir_all(&path)
                .with_context(|| format!("failed to create '{}'", path.display()))?;
        }
        Ok(())
    }

    pub fn track_doc_path(&self, primary_artist: &str, canonical_name: &str) -> PathBuf {
        self.tracks_dir()
            .join(sanitize_path_component(primary_artist))
            .join(format!("{}.md", sanitize_path_component(canonical_name)))
    }

    pub fn set_doc_path(&self, title: &str) -> PathBuf {
        self.sets_dir()
            .join(format!("{}.md", sanitize_path_component(title)))
    }

    pub fn album_doc_path(&self, artist: &str, album_name: &str) -> PathBuf {
        self.albums_dir()
            .join(sanitize_path_component(artist))
            .join(format!("{}.md", sanitize_path_component(album_name)))
    }

    pub fn playlist_doc_path(&self, folder: Option<&str>, name: &str) -> PathBuf {
        let base = match folder {
            Some(folder) if !folder.trim().is_empty() => {
                self.playlists_dir().join(sanitize_path_component(folder))
            }
            _ => self.playlists_dir(),
        };
        base.join(format!("{}.md", sanitize_path_component(name)))
    }
}

pub fn sanitize_path_component(input: &str) -> String {
    let ascii = deunicode(input);
    let mut out = String::with_capacity(ascii.len());

    for ch in ascii.chars() {
        let mapped = match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => ' ',
            '\n' | '\r' | '\t' => ' ',
            c if c.is_ascii() => c,
            _ => ' ',
        };
        out.push(mapped);
    }

    let collapsed = out
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches('.')
        .trim()
        .to_string();

    if collapsed.is_empty() {
        "Untitled".to_string()
    } else {
        collapsed
    }
}

pub fn ensure_parent_dir(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("'{}' does not have a parent directory", path.display()))?;
    std::fs::create_dir_all(parent)
        .with_context(|| format!("failed to create '{}'", parent.display()))?;
    Ok(())
}

pub fn assert_markdown_file(path: &Path) -> Result<()> {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("md") => Ok(()),
        _ => bail!("'{}' is not a markdown file", path.display()),
    }
}
