use std::collections::BTreeSet;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::markdown::{parse_document, render_document};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EnrichmentState {
    Unresolved,
    Resolved,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AcquisitionState {
    Missing,
    Wanted,
    Downloaded,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrackSourceLink {
    pub provider: String,
    pub url: String,
    pub label: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrackFrontmatter {
    pub canonical_artist: String,
    pub canonical_artists: Vec<String>,
    pub canonical_title: String,
    pub version: Option<String>,
    pub canonical_name: String,
    pub spotify_url: Option<String>,
    pub spotify_id: Option<String>,
    pub spotify_uri: Option<String>,
    pub spotify_href: Option<String>,
    pub spotify_popularity: Option<u32>,
    pub spotify_preview_url: Option<String>,
    pub spotify_explicit: Option<bool>,
    pub spotify_isrc: Option<String>,
    pub spotify_disc_number: Option<u32>,
    pub spotify_track_number: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub spotify_available_markets: Vec<String>,
    pub spotify_audio_features_error: Option<String>,
    pub audio_danceability: Option<f64>,
    pub audio_energy: Option<f64>,
    pub audio_key: Option<i32>,
    pub audio_loudness: Option<f64>,
    pub audio_mode: Option<i32>,
    pub audio_speechiness: Option<f64>,
    pub audio_acousticness: Option<f64>,
    pub audio_instrumentalness: Option<f64>,
    pub audio_liveness: Option<f64>,
    pub audio_valence: Option<f64>,
    pub audio_tempo_bpm: Option<f64>,
    pub audio_time_signature: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rekordbox_analysis: Option<RekordboxAnalysisFrontmatter>,
    pub duration_ms: Option<u64>,
    pub release: Option<String>,
    pub album: Option<String>,
    pub first_seen_source: String,
    pub enrichment_state: EnrichmentState,
    pub acquisition_state: AcquisitionState,
    pub local_file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acquisition_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acquisition_source_detail: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub source_links: Vec<TrackSourceLink>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RekordboxAnalysisFrontmatter {
    pub state: String,
    pub analyzer: String,
    pub analyzed_at: String,
    pub source_path: String,
    pub output_dir: String,
    pub summary_path: String,
    pub dat_path: String,
    pub ext_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub twoex_path: Option<String>,
    pub tempo_bpm: Option<f64>,
    pub beat_count: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference_duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_delta_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_match: Option<bool>,
    pub first_downbeat_ms: Option<u64>,
    pub last_beat_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_pitch_class: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub camelot: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_source: Option<String>,
    pub backend: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub native_log_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SetFrontmatter {
    pub title: String,
    pub source_url: String,
    pub canonical_1001_url: String,
    pub date: String,
    pub platform: String,
    pub source_query: String,
    pub extracted_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AlbumFrontmatter {
    pub artist: String,
    pub album_title: String,
    pub source_url: Option<String>,
    pub release_metadata: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlaylistFrontmatter {
    pub name: String,
    pub source: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TrackDocument {
    pub frontmatter: TrackFrontmatter,
    pub seen_in_sets: Vec<String>,
    pub in_albums: Vec<String>,
    pub in_playlists: Vec<String>,
    pub body_notes: Vec<String>,
    pub raw_spotify_track_json: Option<Value>,
    pub raw_spotify_audio_features_json: Option<Value>,
}

#[derive(Debug, Clone)]
pub struct SetDocument {
    pub frontmatter: SetFrontmatter,
    pub tracks: Vec<String>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AlbumDocument {
    pub frontmatter: AlbumFrontmatter,
    pub tracks: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PlaylistDocument {
    pub frontmatter: PlaylistFrontmatter,
    pub tracks: Vec<String>,
}

impl TrackDocument {
    pub fn render(&self) -> Result<String> {
        let mut sections = vec![
            render_bullet_section("Seen In Sets", &self.seen_in_sets),
            render_bullet_section("In Albums", &self.in_albums),
            render_bullet_section("In Playlists", &self.in_playlists),
            render_bullet_section("Notes", &self.body_notes),
        ];

        if self.raw_spotify_track_json.is_some() || self.raw_spotify_audio_features_json.is_some() {
            sections.push(render_spotify_metadata_section(
                self.raw_spotify_track_json.as_ref(),
                self.raw_spotify_audio_features_json.as_ref(),
            )?);
        }

        let body = sections.join("\n\n");

        render_document(&self.frontmatter, &body)
    }

    pub fn parse(content: &str) -> Result<Self> {
        let (frontmatter, body) = parse_document::<TrackFrontmatter>(content)?;
        let raw_spotify_track_json = parse_json_code_block(&body, "Spotify Track Object JSON")?;
        let raw_spotify_audio_features_json =
            parse_json_code_block(&body, "Spotify Audio Features JSON")?;
        Ok(Self {
            frontmatter,
            seen_in_sets: parse_bullet_section(&body, "Seen In Sets"),
            in_albums: parse_bullet_section(&body, "In Albums"),
            in_playlists: parse_bullet_section(&body, "In Playlists"),
            body_notes: parse_bullet_section(&body, "Notes"),
            raw_spotify_track_json,
            raw_spotify_audio_features_json,
        })
    }

    pub fn add_set_backlink(&mut self, set_name: &str) {
        insert_unique(&mut self.seen_in_sets, set_name);
    }

    pub fn remove_set_backlink(&mut self, set_name: &str) {
        self.seen_in_sets.retain(|entry| entry != set_name);
    }

    pub fn add_album_backlink(&mut self, album_name: &str) {
        insert_unique(&mut self.in_albums, album_name);
    }

    pub fn add_playlist_backlink(&mut self, playlist_name: &str) {
        insert_unique(&mut self.in_playlists, playlist_name);
    }
}

impl SetDocument {
    pub fn render(&self) -> Result<String> {
        let body = [
            render_numbered_section("Tracks", &self.tracks),
            render_bullet_section("Notes", &self.notes),
        ]
        .join("\n\n");

        render_document(&self.frontmatter, &body)
    }

    pub fn parse(content: &str) -> Result<Self> {
        let (frontmatter, body) = parse_document::<SetFrontmatter>(content)?;
        Ok(Self {
            frontmatter,
            tracks: parse_numbered_section(&body, "Tracks"),
            notes: parse_bullet_section(&body, "Notes"),
        })
    }
}

impl AlbumDocument {
    pub fn render(&self) -> Result<String> {
        render_document(
            &self.frontmatter,
            &render_numbered_section("Tracks", &self.tracks),
        )
    }

    pub fn parse(content: &str) -> Result<Self> {
        let (frontmatter, body) = parse_document::<AlbumFrontmatter>(content)?;
        Ok(Self {
            frontmatter,
            tracks: parse_numbered_section(&body, "Tracks"),
        })
    }
}

impl PlaylistDocument {
    pub fn render(&self) -> Result<String> {
        render_document(
            &self.frontmatter,
            &render_numbered_section("Tracks", &self.tracks),
        )
    }

    pub fn parse(content: &str) -> Result<Self> {
        let (frontmatter, body) = parse_document::<PlaylistFrontmatter>(content)?;
        Ok(Self {
            frontmatter,
            tracks: dedupe_ordered(parse_numbered_section(&body, "Tracks")),
        })
    }
}

pub fn canonical_track_name(artists: &[String], title: &str, version: Option<&str>) -> String {
    let artist_text = if artists.is_empty() {
        "Unknown Artist".to_string()
    } else {
        artists.join(" & ")
    };

    match version {
        Some(version) if !version.trim().is_empty() => {
            format!("{artist_text} - {title} ({version})")
        }
        _ => format!("{artist_text} - {title}"),
    }
}

fn render_bullet_section(title: &str, items: &[String]) -> String {
    let mut out = format!("## {title}");
    if items.is_empty() {
        out.push_str("\n- none");
        return out;
    }

    for item in items {
        out.push_str("\n- ");
        out.push_str(item);
    }
    out
}

fn render_numbered_section(title: &str, items: &[String]) -> String {
    let mut out = format!("## {title}");
    if items.is_empty() {
        out.push_str("\n1. none");
        return out;
    }

    for item in items {
        out.push_str("\n1. ");
        out.push_str(item);
    }
    out
}

fn render_spotify_metadata_section(
    track: Option<&Value>,
    audio_features: Option<&Value>,
) -> Result<String> {
    let mut out = String::from("## Spotify Metadata");

    if let Some(value) = track {
        out.push_str("\n\n### Spotify Track Object JSON\n```json\n");
        out.push_str(&serde_json::to_string_pretty(value)?);
        out.push_str("\n```");
    }

    if let Some(value) = audio_features {
        out.push_str("\n\n### Spotify Audio Features JSON\n```json\n");
        out.push_str(&serde_json::to_string_pretty(value)?);
        out.push_str("\n```");
    }

    Ok(out)
}

fn parse_json_code_block(body: &str, title: &str) -> Result<Option<Value>> {
    let header = format!("### {title}");
    let Some((_, after_header)) = body.split_once(&header) else {
        return Ok(None);
    };
    let Some((_, after_fence)) = after_header.split_once("```json") else {
        return Ok(None);
    };
    let Some((json, _)) = after_fence.split_once("```") else {
        return Ok(None);
    };
    let value = serde_json::from_str(json.trim())
        .with_context(|| format!("failed to parse {title} code block"))?;
    Ok(Some(value))
}

fn parse_bullet_section(body: &str, title: &str) -> Vec<String> {
    parse_section(body, title)
        .into_iter()
        .filter_map(|line| {
            line.strip_prefix("- ")
                .map(|value| value.trim().to_string())
        })
        .filter(|line| line != "none")
        .collect()
}

fn parse_numbered_section(body: &str, title: &str) -> Vec<String> {
    parse_section(body, title)
        .into_iter()
        .filter_map(|line| parse_ordered_list_item(&line))
        .filter(|line| line != "none")
        .collect()
}

fn parse_ordered_list_item(line: &str) -> Option<String> {
    let (marker, value) = line.split_once(". ")?;
    if marker.is_empty() || !marker.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    Some(value.trim().to_string())
}

fn parse_section(body: &str, title: &str) -> Vec<String> {
    let header = format!("## {title}");
    let mut current = None::<String>;
    let mut lines = Vec::new();

    for raw_line in body.lines() {
        let line = raw_line.trim_end();
        if let Some(name) = line.strip_prefix("## ") {
            current = Some(name.to_string());
            continue;
        }

        if current.as_deref() == Some(title) && !line.trim().is_empty() {
            lines.push(line.trim().to_string());
        }
    }

    if body.contains(&header) {
        lines
    } else {
        Vec::new()
    }
}

fn insert_unique(list: &mut Vec<String>, value: &str) {
    if !list.iter().any(|entry| entry == value) {
        list.push(value.to_string());
        list.sort();
    }
}

fn dedupe_ordered(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for value in values {
        if seen.insert(value.clone()) {
            out.push(value);
        }
    }
    out
}

pub fn read_markdown_document<T>(
    path: &std::path::Path,
    parser: impl FnOnce(&str) -> Result<T>,
) -> Result<T> {
    let content = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read '{}'", path.display()))?;
    parser(&content)
}
