//! In-process C ABI for the Apple app. Requests are ephemeral projections of its
//! library, not another durable workflow database. All calls run off MainActor.
use std::collections::{BTreeMap, HashSet};
use std::ffi::{CStr, CString, c_char};
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use djtools_link::{
    DEFAULT_DBSERVER_PORT, DEFAULT_MOUNT_PORT, DjLinkConfig, DjLinkServer, LibrarySnapshot,
    LogLevel, PlaylistRecord, TrackRecord, djlink_interfaces, normalize_camelot_key,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::runtime::Runtime;

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

struct Session {
    server: DjLinkServer,
    runtime: Runtime,
}

impl Session {
    fn status(&self) -> Value {
        let devices = self.runtime.block_on(self.server.list_devices());
        json!({"running": true, "ip": self.server.bind_ip(),
            "trackCount": self.server.library_track_count(),
            "playlistCount": self.server.library_playlist_count(),
            "devices": devices.iter().map(|device| json!({
                "player": device.player_number, "ip": device.ip_addr, "model": device.model
            })).collect::<Vec<_>>()})
    }
    fn stop(mut self) {
        self.server.stop();
        // Includes accepted RemoteDB connections and the raw fallback worker.
        drop(self.server);
        self.runtime.shutdown_timeout(Duration::from_secs(2));
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartRequest {
    bind_ip: Ipv4Addr,
    broadcast_ip: Ipv4Addr,
    unicast_discovery: bool,
    tracks: Vec<TrackRecord>,
    playlists: Vec<PlaylistRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RelocateAnalysisRequest {
    audio_path: PathBuf,
    output_directory: PathBuf,
}

/// Only relocate existing ANLZ paths. Never decode or analyze audio on the phone.
fn relocate_analysis(input: RelocateAnalysisRequest) -> Result<Value> {
    use djbooth_analyzer::{AnlzFile, build_path_tag};
    let audio = input
        .audio_path
        .canonicalize()
        .context("Downloaded audio is missing")?;
    let directory = input.output_directory;
    anyhow::ensure!(
        directory.is_absolute(),
        "Analysis cache must be an absolute path"
    );
    let paths = ["DAT", "EXT", "2EX"].map(|ext| directory.join(format!("ANLZ0000.{ext}")));
    let cached = paths
        .iter()
        .map(|path| AnlzFile::read(path))
        .collect::<Result<Vec<_>>>();
    let required: [&[[u8; 4]]; 3] = [
        &[*b"PPTH", *b"PVBR", *b"PWAV", *b"PQTZ"],
        &[*b"PPTH", *b"PWV3", *b"PWV4", *b"PWV5", *b"PQT2"],
        &[*b"PPTH", *b"PWV6", *b"PWV7"],
    ];
    let valid = cached.as_ref().is_ok_and(|files| {
        files.iter().zip(required).all(|(file, kinds)| {
            kinds
                .iter()
                .all(|kind| file.tags().iter().any(|tag| tag.kind() == *kind))
        })
    });
    anyhow::ensure!(
        valid,
        "Download the desktop analysis files before connecting to a CDJ"
    );
    let files = cached?;
    // iOS may relocate an app's container across installs. Retain all DSP
    // bytes and update only PPTH through the shared Rust ANLZ writer.
    let path_tag = build_path_tag(audio.to_str().context("Audio path is not UTF-8")?)?;
    for (file, path) in files.into_iter().zip(&paths) {
        if file
            .tags()
            .iter()
            .any(|tag| tag.kind() == *b"PPTH" && tag.raw() != path_tag.raw())
        {
            let tags = file
                .tags()
                .iter()
                .map(|tag| {
                    if tag.kind() == *b"PPTH" {
                        path_tag.clone()
                    } else {
                        tag.clone()
                    }
                })
                .collect();
            let pending = path.with_extension("pending");
            std::fs::write(&pending, AnlzFile::from_tags(tags)?.to_bytes()?)?;
            std::fs::rename(pending, path)?;
        }
    }
    Ok(json!({"dat": paths[0], "ext": paths[1], "twoEx": paths[2], "cached": valid}))
}

impl StartRequest {
    fn library(mut self) -> Result<LibrarySnapshot> {
        if self.tracks.is_empty() {
            bail!("Download a playlist to this phone before connecting.");
        }
        let mut ids = HashSet::new();
        for track in &mut self.tracks {
            if track.track_id == 0 || !ids.insert(track.track_id) {
                bail!("Duplicate or zero track ID");
            }
            if !track.mount_path.is_absolute() || !track.mount_path.is_file() {
                bail!("Downloaded audio is missing: {}", track.title);
            }
            track.camelot = normalize_camelot_key(&track.key);
        }
        let mut playlist_ids = HashSet::new();
        for playlist in &self.playlists {
            if playlist.playlist_id == 0 || !playlist_ids.insert(playlist.playlist_id) {
                bail!("Duplicate or zero playlist ID");
            }
            if playlist.tracks.iter().any(|id| !ids.contains(id)) {
                bail!("Playlist refers to unavailable audio");
            }
        }
        for playlist in &self.playlists {
            if playlist.parent_id != 0
                && !self
                    .playlists
                    .iter()
                    .any(|parent| parent.playlist_id == playlist.parent_id && parent.is_folder)
            {
                bail!("Playlist has no parent folder");
            }
            let mut visited = HashSet::new();
            let mut parent = playlist;
            while parent.parent_id != 0 {
                if !visited.insert(parent.playlist_id) {
                    bail!("Playlist folder cycle");
                }
                parent = self
                    .playlists
                    .iter()
                    .find(|p| p.playlist_id == parent.parent_id)
                    .context("Missing parent")?;
            }
        }
        Ok(LibrarySnapshot {
            master_db_id: 1,
            tracks_by_id: self
                .tracks
                .iter()
                .map(|track| (track.track_id, track.clone()))
                .collect::<BTreeMap<_, _>>(),
            all_tracks: self.tracks,
            playlists: self.playlists,
        })
    }
}

fn request(operation: &str, input: &str) -> Result<Value> {
    if operation == "relocateAnalysis" {
        return relocate_analysis(serde_json::from_str(input)?);
    }
    if operation == "interfaces" {
        return Ok(serde_json::to_value(djlink_interfaces())?);
    }
    let mut session = SESSION
        .lock()
        .map_err(|_| anyhow::anyhow!("DJ Link runtime lock failed"))?;
    match operation {
        "start" => {
            if session.is_some() {
                bail!("Disconnect before changing the DJ Link library.");
            }
            let input: StartRequest = serde_json::from_str(input)?;
            let bind_ip = input.bind_ip;
            let broadcast_ip = input.broadcast_ip;
            let interface = djlink_interfaces().into_iter()
                .find(|interface| interface.ip == bind_ip && interface.broadcast == broadcast_ip)
                .context(
                    "The selected connection is no longer available. Reconnect the cable and refresh."
                )?;
            let unicast_discovery_netmask = input.unicast_discovery.then_some(interface.netmask);
            let library = input.library()?;
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?;
            let server = runtime.block_on(async {
                let config = DjLinkConfig {
                    source_name: "DJ Booth iPhone".into(),
                    model_name: "rekordbox".into(),
                    player_number: djtools_link::REKORDBOX_PLAYER_NUMBER,
                    bind_ip: Some(bind_ip),
                    broadcast_ip: Some(broadcast_ip),
                    unicast_discovery_netmask,
                    db_server_port: DEFAULT_DBSERVER_PORT,
                    mount_port: Some(DEFAULT_MOUNT_PORT),
                    announce_interval: Duration::from_millis(500),
                    log_level: LogLevel::Info,
                    log_path: Some(std::env::temp_dir().join("DJBooth-DJLink.log")),
                    wire_capture_path: None,
                    serve_extended_anlz_tags: true,
                    emit_beat_clock: false,
                    stagehand_monitor: false,
                    stagehand_target_ip: None,
                    stagehand_target_mac: None,
                    stagehand_session_ip: None,
                    stagehand_session_nonce: None,
                    stagehand_protocol_nonce: None,
                    tcp_track_file_side_channel: false,
                    db_auto_load: false,
                    auto_load_confirm: false,
                    auto_unlock_load_lock: false,
                    load_rekordbox_command_variant: false,
                    load_payload_byte_overrides: Vec::new(),
                };
                let mut server = DjLinkServer::new(config, library).await?;
                server.start().await?;
                Ok::<_, anyhow::Error>(server)
            });
            match server {
                Ok(server) => {
                    let running = Session { server, runtime };
                    let status = running.status();
                    *session = Some(running);
                    Ok(status)
                }
                Err(error) => {
                    runtime.shutdown_timeout(Duration::from_secs(2));
                    Err(error)
                }
            }
        }
        "status" => Ok(session
            .as_ref()
            .map(Session::status)
            .unwrap_or_else(|| json!({"running": false}))),
        "stop" => {
            if let Some(running) = session.take() {
                running.stop();
            }
            Ok(json!({"running": false}))
        }
        _ => bail!("Unknown DJ Link operation"),
    }
}

/// Returns owned UTF-8 JSON {ok, value|error}. Free with djbooth_link_free.
/// # Safety
/// Both arguments must point to valid, NUL-terminated UTF-8 strings for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn djbooth_link_request(
    operation: *const c_char,
    input: *const c_char,
) -> *mut c_char {
    let result = std::panic::catch_unwind(|| -> Result<Value> {
        if operation.is_null() || input.is_null() {
            bail!("Missing request");
        }
        let operation = unsafe { CStr::from_ptr(operation) }.to_str()?;
        let input = unsafe { CStr::from_ptr(input) }.to_str()?;
        request(operation, input)
    });
    let response = match result {
        Ok(Ok(value)) => json!({"ok": true, "value": value}),
        Ok(Err(error)) => json!({"ok": false, "error": format!("{error:#}")}),
        Err(_) => json!({"ok": false, "error": "DJ Link runtime failed"}),
    };
    CString::new(response.to_string())
        .expect("JSON has no literal NUL")
        .into_raw()
}

/// # Safety
/// `value` must be null or a live result of djbooth_link_request, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn djbooth_link_free(value: *mut c_char) {
    if !value.is_null() {
        drop(unsafe { CString::from_raw(value) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relocation_preserves_every_non_path_tag_without_reading_audio() {
        use djbooth_analyzer::{AnlzFile, AnlzTag, build_path_tag};
        let root = tempfile::tempdir().unwrap();
        let audio = root.path().join("recording.mp3");
        std::fs::write(&audio, b"deliberately not decodable audio").unwrap();
        let directory = root.path().join("analysis");
        std::fs::create_dir(&directory).unwrap();
        let kinds: [&[[u8; 4]]; 3] = [
            &[*b"PVBR", *b"PWAV", *b"PQTZ", *b"PCOB"],
            &[*b"PWV3", *b"PWV4", *b"PWV5", *b"PQT2", *b"PSSI"],
            &[*b"PWV6", *b"PWV7"],
        ];
        let mut originals = Vec::new();
        for (extension, kinds) in ["DAT", "EXT", "2EX"].into_iter().zip(kinds) {
            let mut tags = vec![build_path_tag("/desktop/original.mp3").unwrap()];
            for kind in kinds {
                let mut bytes = kind.to_vec();
                bytes.extend_from_slice(&12u32.to_be_bytes());
                bytes.extend_from_slice(&16u32.to_be_bytes());
                bytes.extend_from_slice(&[9, 8, 7, 6]);
                tags.push(AnlzTag::parse(&bytes).unwrap());
            }
            let path = directory.join(format!("ANLZ0000.{extension}"));
            std::fs::write(
                &path,
                AnlzFile::from_tags(tags.clone())
                    .unwrap()
                    .to_bytes()
                    .unwrap(),
            )
            .unwrap();
            originals.push((path, tags));
        }
        let make = || RelocateAnalysisRequest {
            audio_path: audio.clone(),
            output_directory: directory.clone(),
        };
        relocate_analysis(make()).unwrap();
        let expected = build_path_tag(audio.canonicalize().unwrap().to_str().unwrap()).unwrap();
        for (path, tags) in originals {
            let file = AnlzFile::read(&path).unwrap();
            assert_eq!(file.tags()[0], expected);
            assert_eq!(&file.tags()[1..], &tags[1..]);
            let bytes = std::fs::read(&path).unwrap();
            relocate_analysis(make()).unwrap();
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
    }
    #[test]
    fn missing_analysis_never_decodes_audio_or_creates_artifacts() {
        let root = tempfile::tempdir().unwrap();
        let audio = root.path().join("recording.mp3");
        std::fs::write(&audio, b"not decodable audio").unwrap();
        let directory = root.path().join("analysis");
        let error = relocate_analysis(RelocateAnalysisRequest {
            audio_path: audio,
            output_directory: directory.clone(),
        })
        .unwrap_err();
        assert!(error.to_string().contains("Download the desktop analysis"));
        assert!(!directory.exists());
    }
    #[test]
    fn unavailable_and_duplicate_audio_cannot_be_advertised() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("track.mp3");
        std::fs::write(&path, b"fixture").unwrap();
        let make = || StartRequest {
            bind_ip: Ipv4Addr::LOCALHOST,
            broadcast_ip: Ipv4Addr::BROADCAST,
            unicast_discovery: true,
            tracks: vec![TrackRecord {
                track_id: 1,
                mount_path: path.clone(),
                ..Default::default()
            }],
            playlists: vec![],
        };
        assert_eq!(make().library().unwrap().track_count(), 1);
        let mut duplicate = make();
        duplicate.tracks.push(duplicate.tracks[0].clone());
        assert!(duplicate.library().is_err());
        std::fs::remove_file(&path).unwrap();
        assert!(make().library().is_err());
    }
    #[test]
    fn ffi_error_is_owned_json() {
        let op = CString::new("invalid").unwrap();
        let input = CString::new("{}").unwrap();
        unsafe {
            let response = djbooth_link_request(op.as_ptr(), input.as_ptr());
            let value: Value = serde_json::from_slice(CStr::from_ptr(response).to_bytes()).unwrap();
            assert_eq!(value["ok"], false);
            djbooth_link_free(response);
        }
    }
}
