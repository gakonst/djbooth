use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Utc};
use flate2::read::ZlibDecoder;
use rusqlite::{Connection, OpenFlags};

use djtools_core::documents::{PlaylistDocument, RekordboxAnalysisFrontmatter, TrackFrontmatter};
use djtools_core::markdown::parse_document;
use djtools_core::paths::DjPaths;

use crate::ids::{stable_id, stable_text_id};
use crate::{LinkError, LinkResult};

const LOCAL_ARTWORK_EXTENSIONS: &[&str] =
    &["jpg", "jpeg", "png", "webp", "JPG", "JPEG", "PNG", "WEBP"];
const LOCAL_ARTWORK_BASENAMES: &[&str] = &["cover", "folder", "artwork", "albumart", "album_art"];
const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";
const REKORDBOX_KEY_BLOB: &str =
    "PN_Pq^*N>(JYe*u^8;Yg76HuZ<mR13S?=>)b9;DpoTXV(6ItkU`}8*m6tx_I{Solh_N#dfe{v=";
const REKORDBOX_KEY_XOR: &[u8] = b"657f48f84c437cc1";
const BASE85_ALPHABET: &[u8] =
    b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";
const SPECIAL_REKORDBOX_PLAYLIST_IDS: &[u32] = &[100_000, 200_000];
const OMITTED_AUDIO_SAMPLE_LIMIT: usize = 25;

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TrackRecord {
    pub track_id: u32,
    pub title: String,
    pub artist: String,
    pub artist_id: u32,
    pub canonical_name: String,
    pub album: String,
    pub album_id: u32,
    pub duration_sec: u32,
    pub bpm_hundreds: u32,
    pub key: String,
    pub camelot: String,
    pub key_id: u32,
    pub bitrate_kbps: u32,
    pub comment: String,
    pub mount_path: PathBuf,
    pub analysis_dat_path: Option<PathBuf>,
    pub analysis_ext_path: Option<PathBuf>,
    pub analysis_twoex_path: Option<PathBuf>,
    pub artwork_id: u32,
    pub artwork_url: Option<String>,
    pub genre: String,
    pub genre_id: u32,
    pub label: String,
    pub year: u32,
    pub date_added_id: u32,
    pub date_added: String,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistRecord {
    pub playlist_id: u32,
    pub name: String,
    pub parent_id: u32,
    pub is_folder: bool,
    pub sequence: u32,
    pub tracks: Vec<u32>,
}

#[derive(Debug, Clone)]
pub struct LibrarySnapshot {
    pub master_db_id: u32,
    pub tracks_by_id: BTreeMap<u32, TrackRecord>,
    pub all_tracks: Vec<TrackRecord>,
    pub playlists: Vec<PlaylistRecord>,
}

#[derive(Debug, Clone, Default)]
pub struct RekordboxLibraryLoadReport {
    pub database_path: PathBuf,
    pub database_content_count: usize,
    pub served_track_count: usize,
    pub playlist_count: usize,
    pub folder_count: usize,
    pub omitted_missing_audio_count: usize,
    pub omitted_invalid_track_id_count: usize,
    pub omitted_missing_audio_sample: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct RekordboxLibraryLoad {
    pub library: LibrarySnapshot,
    pub report: RekordboxLibraryLoadReport,
}

#[derive(Debug, Clone, Default)]
pub struct LibraryValidationReport {
    pub track_count: usize,
    pub playlist_count: usize,
    pub missing_audio: Vec<String>,
    pub missing_analysis: Vec<String>,
    pub analyzed_dat_count: usize,
    pub analyzed_ext_count: usize,
    pub analyzed_twoex_count: usize,
}

impl LibraryValidationReport {
    pub fn is_ok(&self, require_analysis: bool) -> bool {
        self.missing_audio.is_empty() && (!require_analysis || self.missing_analysis.is_empty())
    }
}

/// Precomputed once per immutable library: never scan every track on each audio read.
#[derive(Default)]
pub(crate) struct NfsExports {
    pub files: HashSet<PathBuf>,
    pub paths: HashSet<PathBuf>,
}

impl LibrarySnapshot {
    pub(crate) fn nfs_exports(&self) -> NfsExports {
        let files: HashSet<PathBuf> = self
            .all_tracks
            .iter()
            .flat_map(|track| {
                [
                    Some(track.mount_path.clone()),
                    track.analysis_dat_path.clone(),
                    track.analysis_ext_path.clone().or_else(|| {
                        track
                            .analysis_dat_path
                            .as_ref()
                            .map(|path| path.with_extension("EXT"))
                    }),
                    track.analysis_twoex_path.clone().or_else(|| {
                        track
                            .analysis_dat_path
                            .as_ref()
                            .map(|path| path.with_extension("2EX"))
                    }),
                ]
                .into_iter()
                .flatten()
            })
            .filter(|path| {
                path.is_absolute()
                    && !path
                        .components()
                        .any(|part| matches!(part, std::path::Component::ParentDir))
            })
            .collect();
        let paths = files
            .iter()
            .flat_map(|file| file.ancestors().map(Path::to_path_buf))
            .collect();
        NfsExports { files, paths }
    }

    pub fn from_rekordbox_master_db(
        database_path: &Path,
        include_missing: bool,
    ) -> Result<RekordboxLibraryLoad> {
        if !database_path.is_file() {
            bail!(
                "Rekordbox database '{}' does not exist or is not a file",
                database_path.display()
            );
        }
        let connection = open_rekordbox_database(database_path)?;
        connection
            .execute_batch("BEGIN DEFERRED TRANSACTION")
            .context("failed to begin the read-only Rekordbox snapshot transaction")?;

        let share_directory = database_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("share");
        let mut report = RekordboxLibraryLoadReport {
            database_path: database_path.to_path_buf(),
            ..RekordboxLibraryLoadReport::default()
        };
        let mut tracks_by_id = BTreeMap::new();
        {
            let mut statement = connection
                .prepare(
                    r#"
                    SELECT
                        CAST(c."ID" AS TEXT),
                        COALESCE(c."FolderPath", ''),
                        COALESCE(c."Title", ''),
                        CAST(COALESCE(c."ArtistID", '0') AS TEXT),
                        COALESCE(ar."Name", ''),
                        CAST(COALESCE(c."AlbumID", '0') AS TEXT),
                        COALESCE(al."Name", ''),
                        CAST(COALESCE(c."GenreID", '0') AS TEXT),
                        COALESCE(ge."Name", ''),
                        CAST(COALESCE(c."BPM", 0) AS INTEGER),
                        CAST(COALESCE(c."Length", 0) AS INTEGER),
                        CAST(COALESCE(c."BitRate", 0) AS INTEGER),
                        COALESCE(c."Commnt", ''),
                        CAST(COALESCE(c."ReleaseYear", 0) AS INTEGER),
                        COALESCE(la."Name", ''),
                        CAST(COALESCE(c."KeyID", '0') AS TEXT),
                        COALESCE(ke."ScaleName", ''),
                        COALESCE(
                            NULLIF(TRIM(c."StockDate"), ''),
                            NULLIF(TRIM(c."DateCreated"), ''),
                            ''
                        ),
                        COALESCE(c."AnalysisDataPath", ''),
                        COALESCE(c."ImagePath", '')
                    FROM "djmdContent" c
                    LEFT JOIN "djmdArtist" ar ON ar."ID" = c."ArtistID"
                    LEFT JOIN "djmdAlbum" al ON al."ID" = c."AlbumID"
                    LEFT JOIN "djmdGenre" ge ON ge."ID" = c."GenreID"
                    LEFT JOIN "djmdLabel" la ON la."ID" = c."LabelID"
                    LEFT JOIN "djmdKey" ke ON ke."ID" = c."KeyID"
                    WHERE COALESCE(c."rb_local_deleted", 0) = 0
                    "#,
                )
                .context("failed to prepare the Rekordbox content prewarm query")?;
            let rows = statement
                .query_map([], |row| {
                    Ok(RawRekordboxTrack {
                        track_id: row.get(0)?,
                        mount_path: row.get(1)?,
                        title: row.get(2)?,
                        artist_id: row.get(3)?,
                        artist: row.get(4)?,
                        album_id: row.get(5)?,
                        album: row.get(6)?,
                        genre_id: row.get(7)?,
                        genre: row.get(8)?,
                        bpm_hundreds: sqlite_u32(row.get(9)?),
                        duration_sec: sqlite_u32(row.get(10)?),
                        bitrate_kbps: sqlite_u32(row.get(11)?),
                        comment: row.get(12)?,
                        year: sqlite_u32(row.get(13)?),
                        label: row.get(14)?,
                        key_id: row.get(15)?,
                        key: row.get(16)?,
                        date_added: row.get(17)?,
                        analysis_data_path: row.get(18)?,
                        artwork_path: row.get(19)?,
                    })
                })
                .context("failed to query Rekordbox content")?;

            for row in rows {
                let raw = row.context("failed to decode a Rekordbox content row")?;
                report.database_content_count += 1;
                let Some(track_id) = parse_rekordbox_id(&raw.track_id) else {
                    report.omitted_invalid_track_id_count += 1;
                    continue;
                };
                let mount_path = PathBuf::from(raw.mount_path.trim());
                if !mount_path.is_file() {
                    report.omitted_missing_audio_count += 1;
                    if report.omitted_missing_audio_sample.len() < OMITTED_AUDIO_SAMPLE_LIMIT {
                        report.omitted_missing_audio_sample.push(format!(
                            "{} - {} -> {}",
                            raw.artist.trim(),
                            raw.title.trim(),
                            mount_path.display()
                        ));
                    }
                    if !include_missing {
                        continue;
                    }
                }
                let artist = raw.artist.trim().to_string();
                let title = raw.title.trim().to_string();
                let album = raw.album.trim().to_string();
                let key = raw.key.trim().to_string();
                let camelot = normalize_camelot_key(&key);
                let date_added = raw.date_added.trim().chars().take(10).collect::<String>();
                let analysis_dat_path =
                    rekordbox_share_path(&share_directory, &raw.analysis_data_path);
                let analysis_ext_path = analysis_dat_path
                    .as_ref()
                    .map(|path| path.with_extension("EXT"));
                let analysis_twoex_path = analysis_dat_path
                    .as_ref()
                    .map(|path| path.with_extension("2EX"));
                let artwork_path = rekordbox_share_path(&share_directory, &raw.artwork_path);
                let artwork_url = artwork_path
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned());
                let artwork_id = artwork_url
                    .as_deref()
                    .map(stable_text_id)
                    .unwrap_or_default();
                let canonical_name = if artist.is_empty() {
                    title.clone()
                } else {
                    format!("{artist} - {title}")
                };
                let record = TrackRecord {
                    track_id,
                    title,
                    artist,
                    artist_id: parse_rekordbox_id(&raw.artist_id).unwrap_or_default(),
                    canonical_name,
                    album,
                    album_id: parse_rekordbox_id(&raw.album_id).unwrap_or_default(),
                    duration_sec: raw.duration_sec,
                    bpm_hundreds: raw.bpm_hundreds,
                    key,
                    camelot,
                    key_id: parse_rekordbox_id(&raw.key_id).unwrap_or_default(),
                    bitrate_kbps: raw.bitrate_kbps,
                    comment: raw.comment,
                    mount_path,
                    analysis_dat_path,
                    analysis_ext_path,
                    analysis_twoex_path,
                    artwork_id,
                    artwork_url,
                    genre: raw.genre.trim().to_string(),
                    genre_id: parse_rekordbox_id(&raw.genre_id).unwrap_or_default(),
                    label: raw.label.trim().to_string(),
                    year: raw.year,
                    date_added_id: stable_text_id(&date_added),
                    date_added,
                };
                if tracks_by_id.insert(track_id, record).is_some() {
                    bail!("duplicate numeric Rekordbox content ID {track_id}");
                }
            }
        }

        let mut all_tracks = tracks_by_id.values().cloned().collect::<Vec<_>>();
        all_tracks.sort_by(|a, b| {
            a.artist
                .to_ascii_lowercase()
                .cmp(&b.artist.to_ascii_lowercase())
                .then_with(|| {
                    a.title
                        .to_ascii_lowercase()
                        .cmp(&b.title.to_ascii_lowercase())
                })
                .then_with(|| a.track_id.cmp(&b.track_id))
        });

        let mut playlists = Vec::new();
        let mut playlist_indexes = HashMap::new();
        {
            let mut statement = connection
                .prepare(
                    r#"
                    SELECT
                        CAST(p."ID" AS TEXT),
                        COALESCE(p."Name", ''),
                        CAST(COALESCE(p."ParentID", 'root') AS TEXT),
                        CAST(COALESCE(p."Attribute", 0) AS INTEGER),
                        CAST(COALESCE(p."Seq", 0) AS INTEGER)
                    FROM "djmdPlaylist" p
                    WHERE COALESCE(p."rb_local_deleted", 0) = 0
                        AND p."Attribute" IN (0, 1, 4)
                    ORDER BY
                        CAST(COALESCE(p."ParentID", '0') AS INTEGER),
                        COALESCE(p."Seq", 0),
                        p."Name" COLLATE NOCASE,
                        CAST(p."ID" AS INTEGER)
                    "#,
                )
                .context("failed to prepare the Rekordbox playlist prewarm query")?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                })
                .context("failed to query Rekordbox playlists")?;
            for row in rows {
                let (id, name, parent_id, attribute, sequence) =
                    row.context("failed to decode a Rekordbox playlist row")?;
                let Some(playlist_id) = parse_rekordbox_id(&id) else {
                    continue;
                };
                if SPECIAL_REKORDBOX_PLAYLIST_IDS.contains(&playlist_id) {
                    continue;
                }
                let parent_id = parse_rekordbox_id(&parent_id)
                    .filter(|id| !SPECIAL_REKORDBOX_PLAYLIST_IDS.contains(id))
                    .unwrap_or_default();
                playlist_indexes.insert(playlist_id, playlists.len());
                playlists.push(PlaylistRecord {
                    playlist_id,
                    name: name.trim().to_string(),
                    parent_id,
                    is_folder: attribute == 1,
                    sequence: sqlite_u32(sequence),
                    tracks: Vec::new(),
                });
            }
        }
        {
            let mut statement = connection
                .prepare(
                    r#"
                    SELECT
                        CAST(sp."PlaylistID" AS TEXT),
                        CAST(sp."ContentID" AS TEXT)
                    FROM "djmdSongPlaylist" sp
                    WHERE COALESCE(sp."rb_local_deleted", 0) = 0
                    ORDER BY
                        CAST(sp."PlaylistID" AS INTEGER),
                        COALESCE(sp."TrackNo", 0),
                        CAST(sp."ID" AS INTEGER),
                        sp."ID"
                    "#,
                )
                .context("failed to prepare the Rekordbox playlist-membership prewarm query")?;
            let rows = statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .context("failed to query Rekordbox playlist memberships")?;
            for row in rows {
                let (playlist_id, track_id) =
                    row.context("failed to decode a Rekordbox playlist membership")?;
                let (Some(playlist_id), Some(track_id)) = (
                    parse_rekordbox_id(&playlist_id),
                    parse_rekordbox_id(&track_id),
                ) else {
                    continue;
                };
                let Some(index) = playlist_indexes.get(&playlist_id).copied() else {
                    continue;
                };
                if !playlists[index].is_folder && tracks_by_id.contains_key(&track_id) {
                    playlists[index].tracks.push(track_id);
                }
            }
        }
        connection
            .execute_batch("COMMIT")
            .context("failed to commit the read-only Rekordbox snapshot transaction")?;

        if all_tracks.is_empty() {
            bail!(
                "Rekordbox database '{}' contains no serveable tracks",
                database_path.display()
            );
        }
        report.served_track_count = all_tracks.len();
        report.folder_count = playlists
            .iter()
            .filter(|playlist| playlist.is_folder)
            .count();
        report.playlist_count = playlists.len().saturating_sub(report.folder_count);
        Ok(RekordboxLibraryLoad {
            library: Self {
                master_db_id: stable_id(database_path),
                tracks_by_id,
                all_tracks,
                playlists,
            },
            report,
        })
    }

    pub async fn from_djtools(paths: &DjPaths, include_missing: bool) -> Result<Self> {
        let master_db_id = stable_id(paths.root());
        let mut tracks_by_id = BTreeMap::new();
        let mut by_canonical = HashMap::<String, u32>::new();

        for track_doc_path in markdown_files_under(&paths.tracks_dir()).await? {
            let frontmatter = match read_track_frontmatter(&track_doc_path).await {
                Ok(frontmatter) => frontmatter,
                Err(_) => continue,
            };
            let audio_path = match resolve_track_audio_path(&track_doc_path, &frontmatter).await {
                Some(path) => path,
                None if include_missing => frontmatter
                    .local_file_path
                    .as_deref()
                    .map(PathBuf::from)
                    .unwrap_or_else(|| track_doc_path.with_extension("missing-audio")),
                None => continue,
            };
            if !include_missing && !tokio::fs::try_exists(&audio_path).await.unwrap_or(false) {
                continue;
            }
            let track_id = stable_id(&track_doc_path);
            let rekordbox = frontmatter.rekordbox_analysis.as_ref();
            let analysis_dat_path = match rekordbox {
                Some(analysis) => {
                    resolve_existing_file_path(&track_doc_path, &analysis.dat_path).await
                }
                None => None,
            };
            let analysis_ext_path =
                match rekordbox.and_then(|analysis| analysis.ext_path.as_deref()) {
                    Some(path) => resolve_existing_file_path(&track_doc_path, path).await,
                    None => None,
                };
            let analysis_twoex_path =
                match rekordbox.and_then(|analysis| analysis.twoex_path.as_deref()) {
                    Some(path) => resolve_existing_file_path(&track_doc_path, path).await,
                    None => None,
                };
            let bpm = rekordbox
                .and_then(|analysis| analysis.tempo_bpm)
                .map(|bpm| (bpm * 100.0).round().max(0.0) as u32)
                .unwrap_or(0);
            let key = rekordbox
                .and_then(|analysis| analysis.key.clone())
                .filter(|key| !key.trim().is_empty())
                .unwrap_or_default();
            let camelot = rekordbox
                .and_then(|analysis| analysis.camelot.clone())
                .filter(|key| !key.trim().is_empty())
                .unwrap_or_default();
            let key_identity = if camelot.trim().is_empty() {
                key.trim()
            } else {
                camelot.trim()
            };
            let artwork_url =
                local_artwork_path(&track_doc_path, &audio_path, analysis_dat_path.as_deref())
                    .await
                    .map(|path| path.to_string_lossy().into_owned());
            let artwork_id = artwork_url
                .as_deref()
                .map(stable_text_id)
                .unwrap_or_default();
            let duration_sec = track_duration_seconds(&frontmatter, rekordbox);
            let bitrate_kbps = estimate_track_bitrate_kbps(&audio_path, duration_sec).await;
            let artist = frontmatter.canonical_artists.join(" & ");
            let album = frontmatter.album.clone().unwrap_or_default();
            let year = frontmatter
                .release
                .as_deref()
                .and_then(|release| release.get(..4))
                .and_then(|year| year.parse::<u32>().ok())
                .unwrap_or(0);
            let comment = rekordbox_db_comment(bpm, &key);
            let date_added = track_doc_date(&track_doc_path, &frontmatter).await;
            let date_added_id = stable_text_id(&date_added);
            let record = TrackRecord {
                track_id,
                title: frontmatter.canonical_title.clone(),
                artist_id: stable_text_id(&artist),
                artist,
                canonical_name: frontmatter.canonical_name.clone(),
                album_id: stable_text_id(&album),
                album,
                duration_sec,
                bpm_hundreds: bpm,
                key_id: stable_text_id(key_identity),
                key,
                camelot,
                bitrate_kbps,
                comment,
                mount_path: audio_path,
                analysis_dat_path,
                analysis_ext_path,
                analysis_twoex_path,
                artwork_id,
                artwork_url,
                genre: String::new(),
                genre_id: 0,
                label: String::new(),
                year,
                date_added_id,
                date_added,
            };
            by_canonical.insert(record.canonical_name.to_ascii_lowercase(), track_id);
            tracks_by_id.insert(track_id, record);
        }

        let mut all_tracks: Vec<_> = tracks_by_id.values().cloned().collect();
        all_tracks.sort_by(|a, b| {
            a.artist
                .to_ascii_lowercase()
                .cmp(&b.artist.to_ascii_lowercase())
                .then_with(|| {
                    a.title
                        .to_ascii_lowercase()
                        .cmp(&b.title.to_ascii_lowercase())
                })
        });

        let mut playlists = Vec::new();
        for playlist_path in markdown_files_under(&paths.playlists_dir()).await? {
            let doc = match read_playlist_document(&playlist_path).await {
                Ok(doc) => doc,
                Err(_) => continue,
            };
            let ids = doc
                .tracks
                .iter()
                .filter_map(|name| by_canonical.get(&name.to_ascii_lowercase()).copied())
                .collect::<Vec<_>>();
            if ids.is_empty() {
                continue;
            }
            playlists.push(PlaylistRecord {
                playlist_id: stable_id(&playlist_path),
                name: doc.frontmatter.name,
                parent_id: 0,
                is_folder: false,
                sequence: playlists.len() as u32 + 1,
                tracks: ids,
            });
        }
        playlists.sort_by(|a, b| {
            a.name
                .to_ascii_lowercase()
                .cmp(&b.name.to_ascii_lowercase())
        });

        Ok(Self {
            master_db_id,
            tracks_by_id,
            all_tracks,
            playlists,
        })
    }

    pub fn track_count(&self) -> usize {
        self.tracks_by_id.len()
    }

    pub fn playlist_count(&self) -> usize {
        self.playlists.len()
    }

    pub async fn validate_for_serving(&self, require_analysis: bool) -> LibraryValidationReport {
        let mut report = LibraryValidationReport {
            track_count: self.track_count(),
            playlist_count: self.playlist_count(),
            ..LibraryValidationReport::default()
        };
        for track in &self.all_tracks {
            if !tokio::fs::try_exists(&track.mount_path)
                .await
                .unwrap_or(false)
            {
                report.missing_audio.push(format!(
                    "{} -> {}",
                    track.display_label(),
                    track.mount_path.display()
                ));
            }
            if let Some(path) = track.analysis_dat_path.as_ref()
                && tokio::fs::try_exists(path).await.unwrap_or(false)
            {
                report.analyzed_dat_count += 1;
            } else if require_analysis {
                report.missing_analysis.push(track.display_label());
            }
            if let Some(path) = track.analysis_ext_path.as_ref()
                && tokio::fs::try_exists(path).await.unwrap_or(false)
            {
                report.analyzed_ext_count += 1;
            }
            if let Some(path) = track.analysis_twoex_path.as_ref()
                && tokio::fs::try_exists(path).await.unwrap_or(false)
            {
                report.analyzed_twoex_count += 1;
            }
        }
        report
    }

    pub fn track_by_id(&self, track_id: u32) -> Option<&TrackRecord> {
        self.tracks_by_id.get(&track_id)
    }

    pub fn artist_track_count(&self, artist_id: u32) -> usize {
        self.all_tracks
            .iter()
            .filter(|track| track.artist_id == artist_id)
            .count()
    }

    pub fn first_playlist_containing_track(&self, track_id: u32) -> Option<&PlaylistRecord> {
        self.playlists
            .iter()
            .find(|playlist| playlist.tracks.contains(&track_id))
    }

    pub fn resolve_track_selector(&self, selector: &str) -> LinkResult<&TrackRecord> {
        let selector = selector.trim();
        if selector.is_empty() {
            return Err(LinkError::EmptyTrackSelector);
        }
        if let Ok(track_id) = selector.parse::<u32>() {
            if let Some(track) = self.track_by_id(track_id) {
                return Ok(track);
            }
        }

        let needle = selector.to_ascii_lowercase();
        let exact = self
            .all_tracks
            .iter()
            .filter(|track| {
                track.canonical_name.eq_ignore_ascii_case(selector)
                    || track.title.eq_ignore_ascii_case(selector)
                    || track.display_label().eq_ignore_ascii_case(selector)
            })
            .collect::<Vec<_>>();
        if exact.len() == 1 {
            return Ok(exact[0]);
        }
        if exact.len() > 1 {
            return Err(LinkError::AmbiguousTrackSelector {
                selector: selector.to_string(),
                choices: track_choices(&exact),
            });
        }

        let contains = self
            .all_tracks
            .iter()
            .filter(|track| {
                track.canonical_name.to_ascii_lowercase().contains(&needle)
                    || track.title.to_ascii_lowercase().contains(&needle)
                    || track.artist.to_ascii_lowercase().contains(&needle)
                    || track.display_label().to_ascii_lowercase().contains(&needle)
            })
            .take(6)
            .collect::<Vec<_>>();
        if contains.len() == 1 {
            return Ok(contains[0]);
        }
        if contains.len() > 1 {
            return Err(LinkError::AmbiguousTrackSelector {
                selector: selector.to_string(),
                choices: track_choices(&contains),
            });
        }
        Err(LinkError::TrackSelectorNotFound {
            selector: selector.to_string(),
        })
    }
}

#[derive(Debug)]
struct RawRekordboxTrack {
    track_id: String,
    mount_path: String,
    title: String,
    artist_id: String,
    artist: String,
    album_id: String,
    album: String,
    genre_id: String,
    genre: String,
    bpm_hundreds: u32,
    duration_sec: u32,
    bitrate_kbps: u32,
    comment: String,
    year: u32,
    label: String,
    key_id: String,
    key: String,
    date_added: String,
    analysis_data_path: String,
    artwork_path: String,
}

fn open_rekordbox_database(path: &Path) -> Result<Connection> {
    let mut header = [0u8; SQLITE_HEADER.len()];
    File::open(path)
        .with_context(|| format!("failed to open Rekordbox database '{}'", path.display()))?
        .read_exact(&mut header)
        .with_context(|| {
            format!(
                "failed to read Rekordbox database header '{}'",
                path.display()
            )
        })?;
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| {
        format!(
            "failed to open Rekordbox database '{}' read-only",
            path.display()
        )
    })?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .context("failed to configure the Rekordbox SQLite busy timeout")?;
    if &header != SQLITE_HEADER {
        let key = match std::env::var("REKORDBOX_DB_KEY") {
            Ok(key) if !key.is_empty() => key,
            _ => default_rekordbox_database_key()?,
        };
        let escaped = key.replace('\'', "''");
        connection
            .execute_batch(&format!("PRAGMA key = '{escaped}';"))
            .context("failed to configure the Rekordbox SQLCipher key")?;
    }
    connection
        .query_row("SELECT COUNT(*) FROM sqlite_master", [], |_| Ok(()))
        .with_context(|| {
            format!(
                "failed to unlock Rekordbox database '{}'; set REKORDBOX_DB_KEY if it uses a custom key",
                path.display()
            )
        })?;
    connection
        .execute_batch(
            "
            PRAGMA query_only = ON;
            PRAGMA temp_store = MEMORY;
            PRAGMA cache_size = -65536;
            ",
        )
        .context("failed to configure the read-only Rekordbox prewarm connection")?;
    Ok(connection)
}

fn default_rekordbox_database_key() -> Result<String> {
    let decoded = decode_base85(REKORDBOX_KEY_BLOB.as_bytes())?;
    let unmasked = decoded
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ REKORDBOX_KEY_XOR[index % REKORDBOX_KEY_XOR.len()])
        .collect::<Vec<_>>();
    let mut decoder = ZlibDecoder::new(unmasked.as_slice());
    let mut key = String::new();
    decoder
        .read_to_string(&mut key)
        .context("failed to inflate the built-in Rekordbox database key")?;
    Ok(key)
}

fn decode_base85(data: &[u8]) -> Result<Vec<u8>> {
    let padding = (5 - (data.len() % 5)) % 5;
    let mut padded = data.to_vec();
    padded.extend(std::iter::repeat_n(b'~', padding));
    let mut decoded = Vec::with_capacity((padded.len() / 5) * 4);
    for chunk in padded.chunks_exact(5) {
        let mut value = 0u64;
        for byte in chunk {
            let Some(digit) = BASE85_ALPHABET
                .iter()
                .position(|candidate| candidate == byte)
            else {
                bail!("invalid built-in Rekordbox key encoding");
            };
            value = value * 85 + digit as u64;
        }
        if value > u64::from(u32::MAX) {
            bail!("invalid built-in Rekordbox key encoding");
        }
        decoded.extend_from_slice(&(value as u32).to_be_bytes());
    }
    decoded.truncate(decoded.len().saturating_sub(padding));
    Ok(decoded)
}

fn parse_rekordbox_id(value: &str) -> Option<u32> {
    value
        .trim()
        .parse::<u64>()
        .ok()
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
}

fn sqlite_u32(value: i64) -> u32 {
    u32::try_from(value).unwrap_or_default()
}

fn rekordbox_share_path(share_directory: &Path, value: &str) -> Option<PathBuf> {
    let normalized = value.trim().replace('\\', "/");
    if normalized.is_empty() {
        return None;
    }
    let path = PathBuf::from(&normalized);
    if path.is_absolute() && !normalized.starts_with("/PIONEER/") {
        return Some(path);
    }
    Some(share_directory.join(normalized.trim_start_matches('/')))
}

pub fn normalize_camelot_key(value: &str) -> String {
    let normalized = value
        .trim()
        .replace('♯', "#")
        .replace('♭', "b")
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    let uppercase = normalized.to_ascii_uppercase();
    if parse_camelot_key(&uppercase).is_some() {
        return uppercase;
    }
    let mut characters = normalized.chars();
    let Some(note) = characters.next().map(|note| note.to_ascii_uppercase()) else {
        return String::new();
    };
    let mut pitch_class = match note {
        'C' => 0i8,
        'D' => 2,
        'E' => 4,
        'F' => 5,
        'G' => 7,
        'A' => 9,
        'B' => 11,
        _ => return String::new(),
    };
    let mut suffix = characters.collect::<String>();
    if suffix.starts_with('#') {
        pitch_class += 1;
        suffix.remove(0);
    } else if suffix.starts_with('b') {
        pitch_class -= 1;
        suffix.remove(0);
    }
    let minor = match suffix.to_ascii_lowercase().as_str() {
        "m" | "min" | "minor" => true,
        "" | "maj" | "major" => false,
        _ => return String::new(),
    };
    let pitch_class = pitch_class.rem_euclid(12) as usize;
    const MINOR_CAMELOT: [u8; 12] = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
    const MAJOR_CAMELOT: [u8; 12] = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
    let number = if minor {
        MINOR_CAMELOT[pitch_class]
    } else {
        MAJOR_CAMELOT[pitch_class]
    };
    format!("{number}{}", if minor { 'A' } else { 'B' })
}

impl TrackRecord {
    pub fn display_label(&self) -> String {
        if self.artist.trim().is_empty() {
            self.title.clone()
        } else {
            format!("{} - {}", self.artist, self.title)
        }
    }

    pub fn key_identity(&self) -> &str {
        if !self.camelot.trim().is_empty() {
            self.camelot.trim()
        } else {
            self.key.trim()
        }
    }

    pub fn key_label(&self) -> String {
        let key = self.key.trim();
        let camelot = self.camelot.trim();
        if key.is_empty() {
            camelot.to_string()
        } else if camelot.is_empty() || key.eq_ignore_ascii_case(camelot) {
            key.to_string()
        } else {
            format!("{key} ({camelot})")
        }
    }

    pub(crate) fn camelot_key(&self) -> Option<CamelotKey> {
        parse_camelot_key(self.key_identity()).or_else(|| parse_camelot_key(&self.key))
    }
}

fn track_choices(tracks: &[&TrackRecord]) -> String {
    tracks
        .iter()
        .map(|track| format!("{} ({})", track.display_label(), track.track_id))
        .collect::<Vec<_>>()
        .join("; ")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct CamelotKey {
    number: u8,
    mode: u8,
}

impl CamelotKey {
    fn number_add(self, delta: i8) -> Self {
        let zero_based = (i16::from(self.number) - 1 + i16::from(delta)).rem_euclid(12);
        Self {
            number: (zero_based + 1) as u8,
            mode: self.mode,
        }
    }

    fn relative_mode(self) -> Self {
        Self {
            number: self.number,
            mode: if self.mode == b'A' { b'B' } else { b'A' },
        }
    }

    fn relative_mode_number_add(self, delta: i8) -> Self {
        self.number_add(delta).relative_mode()
    }

    fn compatible(self, distance: u32) -> BTreeSet<Self> {
        let mut keys = BTreeSet::new();
        keys.insert(self);
        if distance >= 1 {
            keys.insert(self.number_add(-1));
            keys.insert(self.number_add(1));
            keys.insert(self.relative_mode());
        }
        if distance >= 2 {
            keys.insert(self.number_add(-2));
            keys.insert(self.number_add(2));
            keys.insert(self.relative_mode_number_add(-1));
            keys.insert(self.relative_mode_number_add(1));
        }
        keys
    }
}

pub(crate) fn parse_camelot_key(value: &str) -> Option<CamelotKey> {
    let trimmed = value.trim();
    if let Some(inner) = trimmed
        .strip_suffix(')')
        .and_then(|value| value.rsplit_once('(').map(|(_, inner)| inner))
    {
        return parse_camelot_key(inner);
    }
    let value = trimmed.to_ascii_uppercase();
    let mode = match value.as_bytes().last().copied()? {
        b'A' => b'A',
        b'B' => b'B',
        _ => return None,
    };
    let number = value
        .get(..value.len().saturating_sub(1))?
        .parse::<u8>()
        .ok()?;
    (1..=12)
        .contains(&number)
        .then_some(CamelotKey { number, mode })
}

pub(crate) fn compatible_camelot_keys(center: CamelotKey, distance: u32) -> BTreeSet<CamelotKey> {
    center.compatible(distance)
}

fn track_duration_seconds(
    frontmatter: &TrackFrontmatter,
    rekordbox: Option<&RekordboxAnalysisFrontmatter>,
) -> u32 {
    if rekordbox.and_then(|analysis| analysis.duration_match) == Some(false) {
        if let Some(ms) = rekordbox.and_then(|analysis| analysis.last_beat_ms) {
            return duration_ms_to_seconds_ceil(ms);
        }
    }
    frontmatter
        .duration_ms
        .map(|ms| (ms / 1000).min(u64::from(u32::MAX)) as u32)
        .or_else(|| {
            rekordbox
                .and_then(|analysis| analysis.reference_duration_ms)
                .map(duration_ms_to_seconds_ceil)
        })
        .or_else(|| {
            rekordbox
                .and_then(|analysis| analysis.last_beat_ms)
                .map(duration_ms_to_seconds_ceil)
        })
        .unwrap_or(0)
}

pub(crate) fn duration_ms_to_seconds_ceil(ms: u64) -> u32 {
    ms.div_ceil(1000).min(u64::from(u32::MAX)) as u32
}

async fn markdown_files_under(root: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut entries = match tokio::fs::read_dir(&dir).await {
            Ok(entries) => entries,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err).with_context(|| format!("read dir '{}'", dir.display())),
        };
        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            let file_type = entry.file_type().await?;
            if file_type.is_dir() {
                stack.push(path);
            } else if file_type.is_file() && path.extension().and_then(|s| s.to_str()) == Some("md")
            {
                out.push(path);
            }
        }
    }
    out.sort();
    Ok(out)
}

async fn read_track_frontmatter(path: &Path) -> Result<TrackFrontmatter> {
    let content = tokio::fs::read_to_string(path)
        .await
        .with_context(|| format!("failed to read '{}'", path.display()))?;
    parse_document::<TrackFrontmatter>(&content).map(|(frontmatter, _)| frontmatter)
}

async fn read_playlist_document(path: &Path) -> Result<PlaylistDocument> {
    let content = tokio::fs::read_to_string(path)
        .await
        .with_context(|| format!("failed to read '{}'", path.display()))?;
    PlaylistDocument::parse(&content)
}

pub(crate) async fn estimate_track_bitrate_kbps(path: &Path, duration_sec: u32) -> u32 {
    if duration_sec == 0 {
        return 0;
    }
    let Ok(metadata) = tokio::fs::metadata(path).await else {
        return 0;
    };
    let bits = metadata.len().saturating_mul(8);
    let denominator = u64::from(duration_sec).saturating_mul(1000);
    if denominator == 0 {
        return 0;
    }
    ((bits + denominator / 2) / denominator).min(u64::from(u32::MAX)) as u32
}

pub(crate) fn rekordbox_db_comment(bpm_hundreds: u32, key: &str) -> String {
    let bpm = (bpm_hundreds > 0).then(|| format!("{:.1}", bpm_hundreds as f32 / 100.0));
    let key = key.trim();
    match (!key.is_empty(), bpm) {
        (true, Some(bpm)) => format!("{key} - {bpm}"),
        (true, None) => key.to_string(),
        (false, Some(bpm)) => bpm,
        (false, None) => String::new(),
    }
}

async fn track_doc_date(track_doc_path: &Path, frontmatter: &TrackFrontmatter) -> String {
    file_date_utc(track_doc_path)
        .await
        .or_else(|| {
            frontmatter
                .rekordbox_analysis
                .as_ref()
                .and_then(|analysis| iso_date_prefix(&analysis.analyzed_at))
        })
        .or_else(|| frontmatter.release.as_deref().and_then(iso_date_prefix))
        .unwrap_or_default()
}

async fn file_date_utc(path: &Path) -> Option<String> {
    let metadata = tokio::fs::metadata(path).await.ok()?;
    let timestamp = metadata.created().or_else(|_| metadata.modified()).ok()?;
    let datetime: DateTime<Utc> = timestamp.into();
    Some(datetime.format("%Y-%m-%d").to_string())
}

fn iso_date_prefix(value: &str) -> Option<String> {
    let prefix = value.get(..10)?;
    let bytes = prefix.as_bytes();
    if bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        Some(prefix.to_string())
    } else {
        None
    }
}

async fn resolve_track_audio_path(
    track_doc_path: &Path,
    frontmatter: &TrackFrontmatter,
) -> Option<PathBuf> {
    if let Some(path) = frontmatter.local_file_path.as_deref() {
        if let Some(path) = resolve_existing_file_path(track_doc_path, path).await {
            return Some(path);
        }
    }
    let stem = track_doc_path.file_stem()?.to_string_lossy();
    let parent = track_doc_path.parent()?;
    for ext in ["mp3", "flac", "wav", "aiff", "aif", "m4a", "alac", "ogg"] {
        let candidate = parent.join(format!("{stem}.{ext}"));
        if tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
            return Some(candidate);
        }
    }
    None
}

pub(crate) async fn local_artwork_path(
    track_doc_path: &Path,
    audio_path: &Path,
    analysis_dat_path: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(path) = existing_artwork_with_stem(track_doc_path).await {
        return Some(path);
    }
    if let Some(path) = existing_artwork_with_stem(audio_path).await {
        return Some(path);
    }
    for dir in [
        track_doc_path.parent(),
        audio_path.parent(),
        analysis_dat_path.and_then(Path::parent),
    ]
    .into_iter()
    .flatten()
    {
        if let Some(path) = existing_named_artwork_in_dir(dir).await {
            return Some(path);
        }
    }
    None
}

async fn existing_artwork_with_stem(path: &Path) -> Option<PathBuf> {
    for ext in LOCAL_ARTWORK_EXTENSIONS {
        let candidate = path.with_extension(ext);
        if tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
            return Some(candidate);
        }
    }
    None
}

async fn existing_named_artwork_in_dir(dir: &Path) -> Option<PathBuf> {
    for name in LOCAL_ARTWORK_BASENAMES {
        for ext in LOCAL_ARTWORK_EXTENSIONS {
            let candidate = dir.join(format!("{name}.{ext}"));
            if tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
                return Some(candidate);
            }
        }
    }
    None
}

pub(crate) async fn resolve_existing_file_path(
    anchor_path: &Path,
    raw_path: &str,
) -> Option<PathBuf> {
    let path = PathBuf::from(raw_path);
    if path.is_absolute() {
        return tokio::fs::try_exists(&path)
            .await
            .unwrap_or(false)
            .then_some(path);
    }
    let parent = anchor_path.parent().unwrap_or_else(|| Path::new("."));
    let anchored = parent.join(&path);
    if tokio::fs::try_exists(&anchored).await.unwrap_or(false) {
        return Some(anchored);
    }
    tokio::fs::try_exists(&path)
        .await
        .unwrap_or(false)
        .then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_plain_rekordbox_database_into_protocol_cache() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("master.db");
        let audio_path = directory.path().join("track.wav");
        let missing_audio_path = directory.path().join("missing.wav");
        std::fs::write(&audio_path, b"RIFF").expect("audio fixture");
        let analysis_path = directory
            .path()
            .join("share/PIONEER/USBANLZ/001/ANLZ0000.DAT");
        let artwork_path = directory.path().join("share/PIONEER/ART/001.jpg");
        std::fs::create_dir_all(analysis_path.parent().expect("analysis parent"))
            .expect("analysis directory");
        std::fs::create_dir_all(artwork_path.parent().expect("artwork parent"))
            .expect("artwork directory");
        std::fs::write(&analysis_path, b"ANLZ").expect("analysis fixture");
        std::fs::write(&artwork_path, b"JPEG").expect("artwork fixture");

        let connection = Connection::open(&database_path).expect("plain fixture database");
        connection
            .execute_batch(
                r#"
                CREATE TABLE djmdArtist (ID TEXT PRIMARY KEY, Name TEXT);
                CREATE TABLE djmdAlbum (ID TEXT PRIMARY KEY, Name TEXT);
                CREATE TABLE djmdGenre (ID TEXT PRIMARY KEY, Name TEXT);
                CREATE TABLE djmdLabel (ID TEXT PRIMARY KEY, Name TEXT);
                CREATE TABLE djmdKey (ID TEXT PRIMARY KEY, ScaleName TEXT);
                CREATE TABLE djmdContent (
                    ID TEXT PRIMARY KEY,
                    FolderPath TEXT,
                    Title TEXT,
                    ArtistID TEXT,
                    AlbumID TEXT,
                    GenreID TEXT,
                    BPM INTEGER,
                    Length INTEGER,
                    BitRate INTEGER,
                    Commnt TEXT,
                    ReleaseYear INTEGER,
                    LabelID TEXT,
                    KeyID TEXT,
                    StockDate TEXT,
                    DateCreated TEXT,
                    AnalysisDataPath TEXT,
                    ImagePath TEXT,
                    rb_local_deleted INTEGER
                );
                CREATE TABLE djmdPlaylist (
                    ID TEXT PRIMARY KEY,
                    Name TEXT,
                    ParentID TEXT,
                    Attribute INTEGER,
                    Seq INTEGER,
                    rb_local_deleted INTEGER
                );
                CREATE TABLE djmdSongPlaylist (
                    ID TEXT PRIMARY KEY,
                    PlaylistID TEXT,
                    ContentID TEXT,
                    TrackNo INTEGER,
                    rb_local_deleted INTEGER
                );
                INSERT INTO djmdArtist VALUES ('20', 'Artist');
                INSERT INTO djmdAlbum VALUES ('30', 'Album');
                INSERT INTO djmdGenre VALUES ('40', 'House');
                INSERT INTO djmdLabel VALUES ('50', 'Label');
                INSERT INTO djmdKey VALUES ('60', 'Fm');
                INSERT INTO djmdPlaylist VALUES ('10', 'Sets', 'root', 1, 1, 0);
                INSERT INTO djmdPlaylist VALUES ('11', 'Night', '10', 0, 1, 0);
                INSERT INTO djmdPlaylist VALUES ('100000', 'Internal', 'root', 1, 1, 0);
                INSERT INTO djmdPlaylist VALUES ('12', 'Deleted', 'root', 0, 2, 1);
                "#,
            )
            .expect("fixture schema");
        connection
            .execute(
                r#"
                INSERT INTO djmdContent (
                    ID, FolderPath, Title, ArtistID, AlbumID, GenreID, BPM, Length,
                    BitRate, Commnt, ReleaseYear, LabelID, KeyID, StockDate,
                    DateCreated, AnalysisDataPath, ImagePath, rb_local_deleted
                ) VALUES (?1, ?2, 'Track', '20', '30', '40', 12345, 300, 1411,
                    'Comment', 2026, '50', '60', '2026-07-26', '',
                    '/PIONEER/USBANLZ/001/ANLZ0000.DAT',
                    '/PIONEER/ART/001.jpg', 0)
                "#,
                rusqlite::params!["1", audio_path.to_string_lossy().as_ref()],
            )
            .expect("playable content");
        connection
            .execute(
                r#"
                INSERT INTO djmdContent (
                    ID, FolderPath, Title, ArtistID, AlbumID, GenreID, BPM, Length,
                    BitRate, Commnt, ReleaseYear, LabelID, KeyID, StockDate,
                    DateCreated, AnalysisDataPath, ImagePath, rb_local_deleted
                ) VALUES (?1, ?2, 'Missing', '20', '30', '40', 12000, 200, 320,
                    '', 2025, '50', '60', '2025-01-01', '', '', '', 0)
                "#,
                rusqlite::params!["2", missing_audio_path.to_string_lossy().as_ref()],
            )
            .expect("missing content");
        connection
            .execute_batch(
                r#"
                INSERT INTO djmdSongPlaylist VALUES ('100', '11', '1', 1, 0);
                INSERT INTO djmdSongPlaylist VALUES ('101', '11', '2', 2, 0);
                INSERT INTO djmdSongPlaylist VALUES ('102', '11', '1', 3, 1);
                "#,
            )
            .expect("playlist membership");
        drop(connection);

        let loaded = LibrarySnapshot::from_rekordbox_master_db(&database_path, false)
            .expect("read-only database projection");
        assert_eq!(loaded.report.database_content_count, 2);
        assert_eq!(loaded.report.served_track_count, 1);
        assert_eq!(loaded.report.omitted_missing_audio_count, 1);
        assert_eq!(loaded.report.playlist_count, 1);
        assert_eq!(loaded.report.folder_count, 1);
        assert_eq!(loaded.library.track_count(), 1);
        assert_eq!(loaded.library.playlist_count(), 2);

        let track = loaded.library.track_by_id(1).expect("track");
        assert_eq!(track.artist, "Artist");
        assert_eq!(track.album, "Album");
        assert_eq!(track.genre, "House");
        assert_eq!(track.label, "Label");
        assert_eq!(track.camelot, "4A");
        assert_eq!(
            track.analysis_dat_path.as_deref(),
            Some(analysis_path.as_path())
        );
        assert_eq!(
            track.artwork_url.as_deref(),
            Some(artwork_path.to_string_lossy().as_ref())
        );

        let folder = loaded
            .library
            .playlists
            .iter()
            .find(|playlist| playlist.playlist_id == 10)
            .expect("folder");
        assert!(folder.is_folder);
        assert_eq!(folder.parent_id, 0);
        let playlist = loaded
            .library
            .playlists
            .iter()
            .find(|playlist| playlist.playlist_id == 11)
            .expect("playlist");
        assert_eq!(playlist.parent_id, 10);
        assert_eq!(playlist.tracks, vec![1]);
    }

    #[test]
    fn built_in_rekordbox_key_decodes() {
        let key = default_rekordbox_database_key().expect("built-in database key");
        assert!(!key.is_empty());
        assert!(key.is_ascii());
    }

    #[test]
    fn normalizes_conventional_and_camelot_keys() {
        assert_eq!(normalize_camelot_key("Fm"), "4A");
        assert_eq!(normalize_camelot_key("C"), "8B");
        assert_eq!(normalize_camelot_key("G♯m"), "1A");
        assert_eq!(normalize_camelot_key("10b"), "10B");
        assert_eq!(normalize_camelot_key("not a key"), "");
    }
}

#[cfg(test)]
mod export_boundary_tests {
    use super::*;
    #[test]
    fn nfs_exports_only_library_files_and_their_ancestors() {
        let track = TrackRecord {
            mount_path: PathBuf::from("/app/session/audio.mp3"),
            analysis_dat_path: Some(PathBuf::from("/app/session/1.DAT")),
            ..Default::default()
        };
        let library = LibrarySnapshot {
            master_db_id: 1,
            tracks_by_id: BTreeMap::new(),
            all_tracks: vec![track],
            playlists: vec![],
        };
        let exports = library.nfs_exports();
        assert!(exports.paths.contains(Path::new("/")));
        assert!(exports.paths.contains(Path::new("/app/session")));
        assert!(exports.files.contains(Path::new("/app/session/audio.mp3")));
        assert!(exports.files.contains(Path::new("/app/session/1.DAT")));
        assert!(exports.files.contains(Path::new("/app/session/1.EXT")));
        assert!(!exports.files.contains(Path::new("/app/session")));
        assert!(!exports.paths.contains(Path::new("/app/library.sqlite")));
        assert!(
            !exports
                .paths
                .contains(Path::new("/app/session/../library.sqlite"))
        );
        assert!(
            !exports
                .paths
                .contains(Path::new("/app/session/audio.mp3/child"))
        );
    }
}
