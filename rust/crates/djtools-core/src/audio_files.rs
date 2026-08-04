use std::path::{Path, PathBuf};

use crate::documents::TrackDocument;

const AUDIO_EXTENSIONS: &[&str] = &["aiff", "aif", "flac", "m4a", "mp3", "ogg", "wav"];

pub fn resolve_audio_path(
    track_doc_path: &Path,
    track_document: &TrackDocument,
) -> Option<PathBuf> {
    if let Some(raw_path) = track_document.frontmatter.local_file_path.as_deref() {
        let path = expand_home(raw_path);
        let path = if path.is_absolute() {
            path
        } else {
            track_doc_path.parent()?.join(path)
        };
        if path.exists() {
            return Some(path);
        }
    }

    let parent = track_doc_path.parent()?;
    let stem = track_doc_path.file_stem()?.to_str()?;
    let mut candidates = std::fs::read_dir(parent)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path.file_stem().and_then(|value| value.to_str()) == Some(stem)
                && path
                    .extension()
                    .and_then(|value| value.to_str())
                    .map(is_audio_extension)
                    .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    candidates.sort();
    candidates.into_iter().next()
}

pub fn is_audio_extension(value: &str) -> bool {
    AUDIO_EXTENSIONS
        .iter()
        .any(|extension| extension.eq_ignore_ascii_case(value))
}

fn expand_home(value: &str) -> PathBuf {
    if value == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(value));
    }
    if let Some(rest) = value.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(value)
}
