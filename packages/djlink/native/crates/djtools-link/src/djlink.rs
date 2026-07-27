use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io;
#[cfg(test)]
use std::io::Read;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{mpsc, oneshot};
use tokio::task::{AbortHandle, JoinHandle as TokioJoinHandle, JoinSet};
use tracing::{debug, trace, warn};

#[cfg(test)]
use djtools_core::paths::DjPaths;

use crate::actor::{
    LoadProgressRecordResult as ActorLoadProgressRecordResult, ServerActor, ServerActorSender,
    ServerMsg,
};
use crate::db::*;
#[cfg(test)]
use crate::ids::stable_id;
use crate::ids::stable_text_id;
#[cfg(test)]
use crate::library::PlaylistRecord;
use crate::library::{LibrarySnapshot, TrackRecord, compatible_camelot_keys, parse_camelot_key};
#[cfg(test)]
use crate::library::{
    duration_ms_to_seconds_ceil, estimate_track_bitrate_kbps, local_artwork_path,
    rekordbox_db_comment,
};
use crate::load::{
    LOAD_CONTEXT_ARTIST_MENU, LOAD_CONTEXT_CATEGORY_1_OFFSET, LOAD_CONTEXT_CATEGORY_2_OFFSET,
    LOAD_CONTEXT_MENU_COUNT_OFFSET, LOAD_CONTEXT_OFFSET, LoadConfirmContext, LoadProgressSnapshot,
};
use crate::network::{RawUdpDatagram, RawUdpTx, bind_udp, connect_tcp, parse_mac};
pub use crate::nfs::NFS_PORT;
use crate::nfs::{
    NFS_READ_CHUNK_MAX, NfsContext, PORTMAP_GETPORT, RPC_PORTMAP_PROG, handle_mount_packet,
    handle_nfs_datagram, portmap_getport, read_file_chunk as read_nfs_file_chunk,
};
#[cfg(test)]
use crate::nfs::{NFS_ROOT_FH, NfsState, RPC_MOUNT_PROG, RPC_NFS_PROG};
#[cfg(test)]
use crate::protocol::decode_nfs_name;
use crate::protocol::keepalive::{self, KeepaliveBody, KeepaliveKind};
use crate::protocol::status;
use crate::protocol::{be_u24, be_u32, decode_hex, rpc_parse_call, rpc_reply_header};
use crate::search::{
    SearchIndex, normalize_search_text, search_entries_indexed, search_query_from_args,
    search_sort_from_args,
};
#[cfg(test)]
use crate::search::{decode_search_binary, search_entries};
use crate::telemetry::{LogLevel, init_djlink_tracing};
use crate::{LinkError, LinkResult};

pub use crate::protocol::DJLINK_MAGIC;
pub const KEEPALIVE_PORT: u16 = 50000;
pub const BEAT_PORT: u16 = 50001;
pub const STATUS_PORT: u16 = 50002;
pub const DBSERVER_QUERY_PORT: u16 = 12523;
pub const DEFAULT_DBSERVER_PORT: u16 = 1051;
pub const DEFAULT_MOUNT_PORT: u16 = 42039;
const DECK_ARTWORK_EDGE_PX: u32 = 240;
const DECK_ARTWORK_JPEG_QUALITY: u8 = 80;

// Rekordbox does not use privileged rpcbind/111 in the observed CDJ-3000 flow.
// Captures show Portmap on UDP/50111, then Mount v1 on an ephemeral UDP port.
pub const PORTMAP_PORT: u16 = 50111;

pub const REKORDBOX_PLAYER_NUMBER: u8 = 0x11;
pub const SLOT_REKORDBOX: u8 = 0x04;
pub const TRACK_TYPE_REKORDBOX: u8 = 0x01;

const STATUS_TYPE_LINK_QUERY: u8 = 0x05;
const STATUS_TYPE_HOT_CUE_BANK_REQ: u8 = 0x17;
const STATUS_TYPE_LOAD_CMD: u8 = 0x19;
const STATUS_TYPE_LOAD_ACK: u8 = 0x1a;
const STATUS_TYPE_CDJ_RENEW: u8 = 0x1b;
const STATUS_TYPE_CUE_RENEW: u8 = 0x1d;
const STATUS_TYPE_LOAD_SETTINGS: u8 = 0x34;
const STATUS_TYPE_MULTI_WAVE_VIEW_REQ: u8 = 0x55;
const BEAT_TYPE_FADER_START: u8 = 0x02;
const BEAT_TYPE_ON_AIR: u8 = 0x03;
const BEAT_TYPE_PRECISE_POSITION: u8 = 0x0b;
const BEAT_TYPE_MASTER_HANDOFF_REQUEST: u8 = 0x26;
const BEAT_TYPE_MASTER_HANDOFF_RESPONSE: u8 = 0x27;
const BEAT_TYPE_BEAT: u8 = 0x28;
const BEAT_TYPE_SYNC_CONTROL: u8 = 0x2a;
const TCP_MODEL_REKORDBOX: &str = "rekordbox";
const TCP_TYPE_DEVICE_CONNECT: u8 = 0x00;
const TCP_TYPE_MOBILE_CONNECT_REQ2: u8 = 0x14;

const MAX_ARTWORK_BYTES: usize = 2 * 1024 * 1024;
#[cfg(test)]
const RAW_IPV4_MTU: usize = 1500;
const CDJ_STATUS_PLAYING_FLAG: u8 = 0x40;
const LOAD_ACK_LOG_THROTTLE: Duration = Duration::from_secs(1);
const LOAD_COMMAND_QUEUE_CAPACITY: usize = 16;
const LOAD_COMMAND_FINAL_CONFIRM_TIMEOUT: Duration = Duration::from_secs(4);
const LOAD_COMMAND_SAME_TRACK_SETTLE: Duration = Duration::from_millis(500);
const DB_AUTO_LOAD_THROTTLE: Duration = Duration::from_secs(2);
const DB_AUTO_LOAD_ACK_TIMEOUT: Duration = Duration::from_millis(500);
const DB_AUTO_LOAD_FIRST_CONFIRM_TIMEOUT: Duration = Duration::from_millis(450);
const DB_AUTO_LOAD_RETRY_CONFIRM_TIMEOUT: Duration = Duration::from_millis(1200);
const TRACK_FILE_TCP_CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const TRACK_FILE_TCP_CHUNK_SIZE: usize = 1024 * 1024;
const FAST_ANNOUNCE_INTERVAL: Duration = Duration::from_millis(500);
const FAST_LINK_INIT_INTERVAL: Duration = Duration::from_millis(300);

const LOAD_TRACK_PAYLOAD_TEMPLATE: [u8; 57] = [
    0x01, 0x00, 0x0d, 0x00, 0x34, 0x0d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x32, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

const BEAT_STATUS_TEMPLATE_HEX: &str = "5173707431576d4a4f4c2872656b6f7264626f780000000000000000000000010111003c000001cd0000039a000001cd000007350000090200000e6affffffffffffffffffffffffffffffffffffffffffffffff00100000000032cd04000011";

#[derive(Debug, Clone)]
pub struct LinkDevice {
    pub player_number: u8,
    pub ip_addr: Ipv4Addr,
    pub mac_addr: String,
    pub model: String,
    pub last_seen: Instant,
}

#[derive(Debug)]
pub struct DjLinkConfig {
    pub source_name: String,
    pub model_name: String,
    pub player_number: u8,
    pub bind_ip: Option<Ipv4Addr>,
    pub broadcast_ip: Option<Ipv4Addr>,
    pub db_server_port: u16,
    pub mount_port: Option<u16>,
    pub announce_interval: Duration,
    pub log_level: LogLevel,
    pub log_path: Option<PathBuf>,
    pub wire_capture_path: Option<PathBuf>,
    pub serve_extended_anlz_tags: bool,
    pub emit_beat_clock: bool,
    pub tcp_track_file_side_channel: bool,
    pub db_auto_load: bool,
    pub auto_load_confirm: bool,
    pub auto_unlock_load_lock: bool,
    pub load_rekordbox_command_variant: bool,
    pub load_payload_byte_overrides: Vec<(usize, u8)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncControlCommand {
    TempoMaster,
    SyncOn,
    SyncOff,
}

impl SyncControlCommand {
    fn packet_byte(self) -> u8 {
        match self {
            Self::TempoMaster => 0x01,
            Self::SyncOn => 0x10,
            Self::SyncOff => 0x20,
        }
    }

    fn from_packet_byte(value: u8) -> Option<Self> {
        match value {
            0x01 => Some(Self::TempoMaster),
            0x10 => Some(Self::SyncOn),
            0x20 => Some(Self::SyncOff),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::TempoMaster => "tempo-master",
            Self::SyncOn => "sync-on",
            Self::SyncOff => "sync-off",
        }
    }
}

impl Default for DjLinkConfig {
    fn default() -> Self {
        Self {
            source_name: "djtools".to_string(),
            model_name: "rekordbox".to_string(),
            player_number: REKORDBOX_PLAYER_NUMBER,
            bind_ip: None,
            broadcast_ip: None,
            db_server_port: DEFAULT_DBSERVER_PORT,
            mount_port: Some(DEFAULT_MOUNT_PORT),
            announce_interval: FAST_ANNOUNCE_INTERVAL,
            log_level: LogLevel::Info,
            log_path: None,
            wire_capture_path: None,
            serve_extended_anlz_tags: true,
            emit_beat_clock: false,
            tcp_track_file_side_channel: false,
            db_auto_load: false,
            auto_load_confirm: false,
            auto_unlock_load_lock: false,
            load_rekordbox_command_variant: false,
            load_payload_byte_overrides: Vec::new(),
        }
    }
}

pub struct DjLinkServer {
    state: Arc<ServerState>,
    tasks: Vec<TokioJoinHandle<()>>,
    actor_rx: Option<mpsc::Receiver<ServerMsg>>,
    load_tx: Option<mpsc::Sender<LoadCommand>>,
    status_tx: Option<Arc<UdpSocket>>,
    beat_tx: Option<Arc<UdpSocket>>,
}

struct LoadCommand {
    spec: LoadCommandSpec,
    reply: oneshot::Sender<Result<usize>>,
}

#[derive(Clone)]
struct LoadCommandSpec {
    target_player: u8,
    target_ip: Ipv4Addr,
    track_id: u32,
    source_player: u8,
    source_slot: u8,
    source_track_type: u8,
    attempts: usize,
    retry_interval: Duration,
}

struct ActiveLoadCommand {
    generation: u64,
    track_id: u32,
    abort: AbortHandle,
    reply: oneshot::Sender<Result<usize>>,
}

#[derive(Debug, Clone)]
pub struct DjLinkLoadProfile {
    pub track_id: u32,
    pub label: String,
    pub file_size: u64,
    pub total_ms: u128,
    pub waveform_preview_bytes: Option<usize>,
    pub waveform_preview_ms: u128,
    pub waveform_detail_bytes: Option<usize>,
    pub waveform_detail_ms: u128,
    pub beat_grid_bytes: Option<usize>,
    pub beat_grid_ms: u128,
    pub extended_tags: Vec<DjLinkAnlzProfile>,
    pub nfs_bytes: u64,
    pub nfs_chunks: usize,
    pub nfs_ms: u128,
}

#[derive(Debug, Clone)]
pub struct DjLinkAnlzProfile {
    pub tag: String,
    pub ext: String,
    pub bytes: Option<usize>,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone)]
pub struct DjLinkKeyBrowseProfile {
    pub total_tracks: usize,
    pub keyed_tracks: usize,
    pub camelot_tracks: usize,
    pub key_count: usize,
    pub total_us: u128,
    pub missing_key_tracks: Vec<DjLinkTrackProfileItem>,
    pub non_camelot_key_tracks: Vec<DjLinkTrackProfileItem>,
    pub distances: Vec<DjLinkKeyDistanceProfile>,
    pub buckets: Vec<DjLinkKeyBucketProfile>,
}

#[derive(Debug, Clone)]
pub struct DjLinkTrackProfileItem {
    pub track_id: u32,
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct DjLinkKeyDistanceProfile {
    pub distance: u32,
    pub bucket_count: usize,
    pub track_hits: usize,
    pub unique_track_count: usize,
    pub elapsed_us: u128,
}

#[derive(Debug, Clone)]
pub struct DjLinkKeyBucketProfile {
    pub key_id: u32,
    pub key_label: String,
    pub distance: u32,
    pub track_count: usize,
    pub elapsed_us: u128,
}

#[derive(Debug, Clone)]
pub struct DjLinkSearchProfile {
    pub query: String,
    pub mode: DjLinkSearchMode,
    pub normalized_query: String,
    pub result_count: usize,
    pub elapsed_us: u128,
    pub items: Vec<DjLinkSearchProfileItem>,
}

#[derive(Debug, Clone)]
pub struct DjLinkSearchProfileItem {
    pub entry_id: u32,
    pub entry_type: u32,
    pub label: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DjLinkMonitorSnapshot {
    pub status: Option<String>,
    pub beat: Option<String>,
    pub position: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DjLinkSearchMode {
    Track,
    Artist,
    Album,
}

impl DjLinkSearchMode {
    fn rmst(self) -> u32 {
        let menu = match self {
            Self::Track => 0x12,
            Self::Artist => 0x1f,
            Self::Album => 0x20,
        };
        (3 << 24) | (menu << 16) | (4 << 8) | 1
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Track => "track",
            Self::Artist => "artist",
            Self::Album => "album",
        }
    }
}

fn track_profile_item(track: &TrackRecord) -> DjLinkTrackProfileItem {
    DjLinkTrackProfileItem {
        track_id: track.track_id,
        label: track.display_label(),
    }
}

fn search_profile_item(entry: &MenuEntry) -> DjLinkSearchProfileItem {
    let label = if entry.text2.is_empty() {
        entry.text1.clone()
    } else {
        format!("{} - {}", entry.text1, entry.text2)
    };
    DjLinkSearchProfileItem {
        entry_id: entry.entry_id2,
        entry_type: entry.entry_type,
        label,
    }
}

impl DjLinkServer {
    pub async fn new(config: DjLinkConfig, library: LibrarySnapshot) -> Result<Self> {
        init_djlink_tracing(config.log_path.clone(), config.log_level).await?;
        let bind_ip = match config.bind_ip {
            Some(ip) => ip,
            None => default_ip().context("failed to choose DJ Link bind IP")?,
        };
        let broadcast_ip = config
            .broadcast_ip
            .unwrap_or_else(|| default_broadcast_ip(bind_ip));
        let interface_name = default_interface_name(bind_ip);
        let log_path = config.log_path.clone();
        let raw_udp = RawUdpTx::spawn(interface_name.clone(), config.wire_capture_path.clone())
            .context("failed to initialize raw wire capture")?;
        let search_index = SearchIndex::new(&library);
        let (actor_tx, actor_rx) = ServerActor::channel();
        let state = Arc::new(ServerState {
            config,
            bind_ip,
            broadcast_ip,
            mac_addr: default_mac(bind_ip),
            raw_udp,
            interface_name,
            library: Arc::new(library),
            search_index,
            actor_tx,
            log_path,
        });
        Ok(Self {
            state,
            tasks: Vec::new(),
            actor_rx: Some(actor_rx),
            load_tx: None,
            status_tx: None,
            beat_tx: None,
        })
    }

    pub fn bind_ip(&self) -> Ipv4Addr {
        self.state.bind_ip
    }

    pub fn broadcast_ip(&self) -> Ipv4Addr {
        self.state.broadcast_ip
    }

    pub fn player_number(&self) -> u8 {
        self.state.config.player_number
    }

    pub fn library_track_count(&self) -> usize {
        self.state.library.track_count()
    }

    pub fn library_playlist_count(&self) -> usize {
        self.state.library.playlist_count()
    }

    pub fn resolve_library_track(&self, selector: &str) -> LinkResult<(usize, &TrackRecord)> {
        let track = self.state.library.resolve_track_selector(selector)?;
        let order = self
            .state
            .library
            .all_tracks
            .iter()
            .position(|candidate| candidate.track_id == track.track_id)
            .map(|index| index + 1)
            .unwrap_or(1);
        Ok((order, track))
    }

    pub fn first_track_id(&self) -> Option<u32> {
        self.state
            .library
            .all_tracks
            .first()
            .map(|track| track.track_id)
    }

    pub fn log_path(&self) -> Option<PathBuf> {
        self.state.log_path.clone()
    }

    pub async fn profile_track_load(&self, track_id: u32) -> Result<DjLinkLoadProfile> {
        let track = self
            .state
            .library
            .tracks_by_id
            .get(&track_id)
            .cloned()
            .with_context(|| format!("unknown track id {track_id}"))?;
        let total_start = Instant::now();

        let args = vec![DbValue::Int32(track.track_id)];
        let preview_args = vec![DbValue::Int32(0), DbValue::Int32(track.track_id)];

        let started = Instant::now();
        let waveform_preview = load_waveform_preview(&self.state.library, &preview_args).await;
        let waveform_preview_ms = started.elapsed().as_millis();

        let started = Instant::now();
        let waveform_detail = load_waveform_detail(&self.state.library, &args).await;
        let waveform_detail_ms = started.elapsed().as_millis();

        let started = Instant::now();
        let beat_grid = load_beat_grid(&self.state.library, &args).await;
        let beat_grid_ms = started.elapsed().as_millis();

        let mut extended_tags = Vec::new();
        for (tag, ext) in [
            ("PQT2", "EXT\0"),
            ("PSSI", "EXT\0"),
            ("PWV4", "EXT\0"),
            ("PWV5", "EXT\0"),
            ("PWV6", "2EX\0"),
            ("PWV7", "2EX\0"),
        ] {
            let tag_args = vec![
                DbValue::Int32(track.track_id),
                DbValue::Int32(fourcc_le_padded(tag)?),
                DbValue::Int32(fourcc_le_padded(ext)?),
            ];
            let started = Instant::now();
            let blob = load_anlz_tag(
                &self.state.library,
                &tag_args,
                self.state.config.serve_extended_anlz_tags,
            )
            .await;
            extended_tags.push(DjLinkAnlzProfile {
                tag: tag.trim_end_matches('\0').to_string(),
                ext: ext.trim_end_matches('\0').to_string(),
                bytes: blob.as_ref().map(Vec::len),
                elapsed_ms: started.elapsed().as_millis(),
            });
        }

        let file_size = tokio::fs::metadata(&track.mount_path)
            .await
            .map(|meta| meta.len())
            .unwrap_or(0);
        let started = Instant::now();
        let mut offset = 0u64;
        let mut nfs_bytes = 0u64;
        let mut nfs_chunks = 0usize;
        let file_bytes = tokio::fs::read(&track.mount_path)
            .await
            .with_context(|| format!("read '{}'", track.mount_path.display()))?;
        while offset < file_size {
            let count = (file_size - offset).min(NFS_READ_CHUNK_MAX as u64) as usize;
            let start = offset as usize;
            let end = start.saturating_add(count).min(file_bytes.len());
            let chunk = &file_bytes[start..end];
            if chunk.is_empty() {
                break;
            }
            offset = offset.saturating_add(chunk.len() as u64);
            nfs_bytes = nfs_bytes.saturating_add(chunk.len() as u64);
            nfs_chunks = nfs_chunks.saturating_add(1);
        }
        let nfs_ms = started.elapsed().as_millis();

        Ok(DjLinkLoadProfile {
            track_id,
            label: track.display_label(),
            file_size,
            total_ms: total_start.elapsed().as_millis(),
            waveform_preview_bytes: waveform_preview.as_ref().map(Vec::len),
            waveform_preview_ms,
            waveform_detail_bytes: waveform_detail.as_ref().map(Vec::len),
            waveform_detail_ms,
            beat_grid_bytes: beat_grid.as_ref().map(Vec::len),
            beat_grid_ms,
            extended_tags,
            nfs_bytes,
            nfs_chunks,
            nfs_ms,
        })
    }

    pub fn profile_key_browse(&self) -> DjLinkKeyBrowseProfile {
        let total_start = Instant::now();
        let library = &self.state.library;
        let total_tracks = library.all_tracks.len();
        let keyed_tracks = library
            .all_tracks
            .iter()
            .filter(|track| track.key_id != 0 && !track.key_identity().is_empty())
            .count();
        let camelot_tracks = library
            .all_tracks
            .iter()
            .filter(|track| track.camelot_key().is_some())
            .count();
        let missing_key_tracks = library
            .all_tracks
            .iter()
            .filter(|track| track.key_id == 0 || track.key_identity().is_empty())
            .map(track_profile_item)
            .collect::<Vec<_>>();
        let non_camelot_key_tracks = library
            .all_tracks
            .iter()
            .filter(|track| {
                track.key_id != 0
                    && !track.key_identity().is_empty()
                    && track.camelot_key().is_none()
            })
            .map(track_profile_item)
            .collect::<Vec<_>>();
        let keys = key_entries(library);
        let mut distances = Vec::new();
        let mut buckets = Vec::new();
        for distance in 0..=2 {
            let distance_start = Instant::now();
            let mut track_hits = 0usize;
            let mut unique_tracks = HashSet::new();
            for key in &keys {
                let bucket_start = Instant::now();
                let tracks = tracks_for_key_distance_entries(
                    library,
                    &[
                        DbValue::Int32(0),
                        DbValue::Int32(key.entry_id2),
                        DbValue::Int32(distance),
                    ],
                );
                let elapsed_us = bucket_start.elapsed().as_micros();
                track_hits = track_hits.saturating_add(tracks.len());
                unique_tracks.extend(tracks.iter().map(|track| track.entry_id2));
                buckets.push(DjLinkKeyBucketProfile {
                    key_id: key.entry_id2,
                    key_label: key.text1.clone(),
                    distance,
                    track_count: tracks.len(),
                    elapsed_us,
                });
            }
            distances.push(DjLinkKeyDistanceProfile {
                distance,
                bucket_count: keys.len(),
                track_hits,
                unique_track_count: unique_tracks.len(),
                elapsed_us: distance_start.elapsed().as_micros(),
            });
        }

        DjLinkKeyBrowseProfile {
            total_tracks,
            keyed_tracks,
            camelot_tracks,
            key_count: keys.len(),
            total_us: total_start.elapsed().as_micros(),
            missing_key_tracks,
            non_camelot_key_tracks,
            distances,
            buckets,
        }
    }

    pub fn profile_search(&self, query: &str, mode: DjLinkSearchMode) -> DjLinkSearchProfile {
        let started = Instant::now();
        let query_wire = query.to_ascii_uppercase();
        let query_bytes = utf16be_z_bytes(&query_wire);
        let args = vec![
            DbValue::Int32(mode.rmst()),
            DbValue::Int32(SORT_DEFAULT),
            DbValue::Int32(query_bytes.len() as u32),
            DbValue::Binary(query_bytes),
            DbValue::Int32(0),
        ];
        let entries = search_entries_indexed(&self.state.library, &self.state.search_index, &args);
        let items = entries.iter().map(search_profile_item).collect::<Vec<_>>();
        DjLinkSearchProfile {
            query: query.to_string(),
            mode,
            normalized_query: normalize_search_text(query),
            result_count: items.len(),
            elapsed_us: started.elapsed().as_micros(),
            items,
        }
    }

    pub async fn list_devices(&self) -> Vec<LinkDevice> {
        self.state.devices_sorted().await
    }

    /// Safely test whether one IPv4 address answers ARP on the selected DJ Link interface.
    pub async fn probe_arp_device(
        &self,
        target_ip: Ipv4Addr,
        timeout: Duration,
    ) -> Result<Option<String>> {
        let mac = self
            .state
            .raw_udp
            .probe_arp(
                parse_mac(&self.state.mac_addr)?,
                self.state.bind_ip,
                target_ip,
                timeout,
            )
            .await
            .with_context(|| format!("ARP probe {target_ip}"))?;
        Ok(mac.map(format_mac))
    }

    pub async fn monitor_snapshot(&self, player: u8) -> DjLinkMonitorSnapshot {
        self.state.monitor_snapshot(player).await
    }

    pub async fn start(&mut self) -> Result<()> {
        if !self.tasks.is_empty() {
            return Ok(());
        }

        let keepalive_sock = bind_udp(
            SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, KEEPALIVE_PORT),
            self.state.interface_name.as_deref(),
            true,
        )
        .context("failed to bind UDP/50000 keepalive")?;

        let status_sock = bind_udp(
            SocketAddrV4::new(self.state.bind_ip, STATUS_PORT),
            self.state.interface_name.as_deref(),
            true,
        )
        .context("failed to bind UDP/50002 status")?;

        let (beat_tx_sock, beat_rx_sock) = match bind_udp(
            SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, BEAT_PORT),
            self.state.interface_name.as_deref(),
            true,
        ) {
            Ok(sock) => {
                let sock = Arc::new(sock);
                (sock.clone(), Some(sock))
            }
            Err(err) => {
                tracing::warn!(
                    port = BEAT_PORT,
                    error = %err,
                    "beat listener bind failed; using send-only beat announcements"
                );
                let sock = bind_udp(
                    SocketAddrV4::new(self.state.bind_ip, 0),
                    self.state.interface_name.as_deref(),
                    true,
                )
                .context("failed to bind UDP beat sender")?;
                (Arc::new(sock), None)
            }
        };

        let db_query = TcpListener::bind((self.state.bind_ip, DBSERVER_QUERY_PORT))
            .await
            .context("failed to bind TCP/12523 RemoteDBServer discovery")?;

        let db_server = TcpListener::bind((self.state.bind_ip, self.state.config.db_server_port))
            .await
            .with_context(|| {
                format!(
                    "failed to bind TCP/{} DB server",
                    self.state.config.db_server_port
                )
            })?;

        let nfs_sock = bind_udp(
            SocketAddrV4::new(self.state.bind_ip, NFS_PORT),
            self.state.interface_name.as_deref(),
            false,
        )
        .context("failed to bind UDP/2049 NFS")?;

        let requested_mount_port = self.state.config.mount_port.unwrap_or(DEFAULT_MOUNT_PORT);
        let mount_sock = match bind_udp(
            SocketAddrV4::new(self.state.bind_ip, requested_mount_port),
            self.state.interface_name.as_deref(),
            false,
        ) {
            Ok(sock) => sock,
            Err(err) if requested_mount_port != 0 => {
                tracing::warn!(
                    requested_mount_port,
                    error = %err,
                    "mount server bind failed; using ephemeral mount port"
                );
                bind_udp(
                    SocketAddrV4::new(self.state.bind_ip, 0),
                    self.state.interface_name.as_deref(),
                    false,
                )
                .context("failed to bind UDP mount server")?
            }
            Err(err) => return Err(err).context("failed to bind UDP mount server"),
        };
        let mount_port = mount_sock.local_addr()?.port();

        let portmap_sock = bind_udp(
            SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, PORTMAP_PORT),
            self.state.interface_name.as_deref(),
            false,
        )
        .context("failed to bind UDP/50111 Portmap")?;

        tracing::info!(
            source = %self.state.config.source_name,
            player = self.state.config.player_number,
            ip = %self.state.bind_ip,
            interface = self.state.interface_name.as_deref().unwrap_or("-"),
            broadcast = %self.state.broadcast_ip,
            db_port = self.state.config.db_server_port,
            tracks = self.state.library.track_count(),
            playlists = self.state.library.playlist_count(),
            mount_port,
            portmap_port = PORTMAP_PORT,
            "DJ Link up"
        );

        let status_sock = Arc::new(status_sock);
        let keepalive_sock = Arc::new(keepalive_sock);
        let portmap_sock = Arc::new(portmap_sock);
        let mount_sock = Arc::new(mount_sock);
        let nfs_sock = Arc::new(nfs_sock);

        self.status_tx = Some(status_sock.clone());
        self.beat_tx = Some(beat_tx_sock.clone());

        let actor_rx = self.actor_rx.take().ok_or(LinkError::RuntimeStopped)?;
        self.tasks
            .push(tokio::spawn(ServerActor::default().run(actor_rx)));
        let (load_tx, load_rx) = mpsc::channel(LOAD_COMMAND_QUEUE_CAPACITY);
        self.load_tx = Some(load_tx);
        self.tasks.push(tokio::spawn(run_load_command_actor(
            self.state.clone(),
            status_sock.clone(),
            load_rx,
        )));

        self.tasks.push(spawn_keepalive_rx(
            self.state.clone(),
            keepalive_sock.clone(),
            status_sock.clone(),
        ));
        self.tasks
            .push(spawn_announce(self.state.clone(), keepalive_sock.clone()));
        self.tasks
            .push(spawn_link_init(self.state.clone(), status_sock.clone()));
        self.tasks
            .push(spawn_status(self.state.clone(), status_sock.clone()));
        self.tasks
            .push(spawn_mixer_status(self.state.clone(), status_sock.clone()));
        if self.state.config.emit_beat_clock {
            self.tasks
                .push(spawn_beat_status(self.state.clone(), beat_tx_sock.clone()));
        }
        if let Some(beat_rx_sock) = beat_rx_sock {
            self.tasks
                .push(spawn_beat_rx(self.state.clone(), beat_rx_sock));
        }
        self.tasks
            .push(spawn_db_query(self.state.clone(), db_query));
        self.tasks.push(spawn_db_server(
            self.state.clone(),
            db_server,
            status_sock.clone(),
        ));
        self.tasks
            .push(spawn_portmap(self.state.clone(), portmap_sock, mount_port));
        self.tasks.push(spawn_mount(self.state.clone(), mount_sock));
        self.tasks.push(spawn_nfs(self.state.clone(), nfs_sock));

        send_startup_link_init(&self.state, &status_sock).await;
        self.tasks
            .push(spawn_startup_hello(self.state.clone(), keepalive_sock));
        Ok(())
    }

    pub async fn send_load_track(
        &self,
        target_player: u8,
        track_id: u32,
        source_player: Option<u8>,
        source_slot: u8,
        source_track_type: u8,
        repeat: usize,
        interval: Duration,
    ) -> Result<usize> {
        let target = self
            .list_devices()
            .await
            .into_iter()
            .find(|device| device.player_number == target_player)
            .ok_or(LinkError::TargetPlayerNotFound { target_player })?;
        let source_player = source_player.unwrap_or(self.state.config.player_number);
        self.enqueue_load_track(LoadCommandSpec {
            target_player,
            target_ip: target.ip_addr,
            track_id,
            source_player,
            source_slot,
            source_track_type,
            attempts: repeat.max(1),
            retry_interval: interval,
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn send_load_track_to_ip(
        &self,
        target_player: u8,
        target_ip: Ipv4Addr,
        track_id: u32,
        source_player: Option<u8>,
        source_slot: u8,
        source_track_type: u8,
        repeat: usize,
        interval: Duration,
    ) -> Result<usize> {
        let source_player = source_player.unwrap_or(self.state.config.player_number);
        self.enqueue_load_track(LoadCommandSpec {
            target_player,
            target_ip,
            track_id,
            source_player,
            source_slot,
            source_track_type,
            attempts: repeat.max(1),
            retry_interval: interval,
        })
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn send_load_track_control_datagrams(
        &self,
        target_player: u8,
        target_ip: Option<Ipv4Addr>,
        target_mac: Option<&str>,
        track_id: u32,
        source_player: Option<u8>,
        source_slot: u8,
        source_track_type: u8,
        count: usize,
        interval: Duration,
    ) -> Result<usize> {
        let source_player = source_player.unwrap_or(self.state.config.player_number);
        let payload_overrides = load_payload_overrides_for_track(&self.state, track_id);
        let packet = build_status_load_track_command(
            &self.state.config.model_name,
            self.state.config.player_number,
            target_player,
            source_player,
            source_slot,
            source_track_type,
            track_id,
            self.state.config.load_rekordbox_command_variant,
            &payload_overrides,
        );
        let target_ip = target_ip.unwrap_or(self.state.broadcast_ip);
        let count = count.max(1);
        if self.state.config.auto_unlock_load_lock && (1..=6).contains(&target_player) {
            let settings = build_status_load_settings_command(
                &self.state.config.model_name,
                self.state.config.player_number,
                target_player,
                &[],
            );
            send_status_control_packet(
                &self.state,
                &settings,
                target_ip,
                target_mac,
                "load-settings before load-track control",
            )
            .await?;
            tracing::info!(
                target_player,
                %target_ip,
                "sent load-settings before load-track control"
            );
        }
        let mut retry_interval = tokio::time::interval(interval);
        retry_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        retry_interval.tick().await;
        for index in 0..count {
            send_status_control_packet(
                &self.state,
                &packet,
                target_ip,
                target_mac,
                "load-track control",
            )
            .await?;
            tracing::info!(
                attempt = index + 1,
                target_player,
                %target_ip,
                track_id,
                source_player,
                source_slot,
                source_track_type,
                variant = if self.state.config.load_rekordbox_command_variant {
                    "rekordbox"
                } else {
                    "standard"
                },
                fixed_byte_0x33 = packet[0x1f + 0x14],
                payload_overrides = self.state.config.load_payload_byte_overrides.len(),
                "sent load-track control"
            );
            if index + 1 < count {
                retry_interval.tick().await;
            }
        }
        Ok(count)
    }

    async fn enqueue_load_track(&self, spec: LoadCommandSpec) -> Result<usize> {
        let target_player = spec.target_player;
        let track_id = spec.track_id;
        let tx = self.load_tx.as_ref().ok_or(LinkError::ServerNotRunning)?;
        let (reply, received) = oneshot::channel();
        tx.send(LoadCommand { spec, reply })
            .await
            .map_err(|_| LinkError::LoadCommandActorStopped)?;
        received
            .await
            .map_err(|_| LinkError::LoadCommandSuperseded {
                target_player,
                track_id,
            })?
    }

    pub async fn send_fader_start_command(
        &self,
        target_player: u8,
        target_ip: Option<Ipv4Addr>,
        start: bool,
        idle_byte: u8,
    ) -> Result<()> {
        let target_ip = match target_ip {
            Some(ip) => ip,
            None => {
                self.list_devices()
                    .await
                    .into_iter()
                    .find(|device| device.player_number == target_player)
                    .ok_or(LinkError::TargetPlayerNotFound { target_player })?
                    .ip_addr
            }
        };
        let packet = build_fader_start_command(
            &self.state.config.model_name,
            self.state.config.player_number,
            target_player,
            start,
            idle_byte,
        )?;
        let sock = self.beat_tx.as_ref().ok_or(LinkError::ServerNotRunning)?;
        send_udp_packet(
            &self.state,
            sock,
            &packet,
            SocketAddrV4::new(target_ip, BEAT_PORT),
            "fader-start command",
        )
        .await?;
        tracing::info!(
            "{}",
            format!(
                "sent fader-start {} command to player={target_player} ip={target_ip}",
                if start { "start" } else { "stop" }
            ),
        );
        Ok(())
    }

    pub async fn send_fader_start_control_datagram(
        &self,
        target_player: u8,
        target_ip: Option<Ipv4Addr>,
        start: bool,
        idle_byte: u8,
    ) -> Result<()> {
        let packet = build_fader_start_command(
            &self.state.config.model_name,
            self.state.config.player_number,
            target_player,
            start,
            idle_byte,
        )?;
        let target_ip = target_ip.unwrap_or(self.state.broadcast_ip);
        send_control_udp_packet(
            &self.state,
            BEAT_PORT,
            &packet,
            target_ip,
            "fader-start control",
        )
        .await?;
        tracing::info!(
            "{}",
            format!(
                "sent fader-start control {} to player={target_player} ip={target_ip}",
                if start { "start" } else { "stop" }
            ),
        );
        Ok(())
    }

    pub async fn send_sync_control_command(
        &self,
        target_player: u8,
        target_ip: Option<Ipv4Addr>,
        command: SyncControlCommand,
    ) -> Result<()> {
        let target_ip = match target_ip {
            Some(ip) => ip,
            None => {
                self.list_devices()
                    .await
                    .into_iter()
                    .find(|device| device.player_number == target_player)
                    .ok_or(LinkError::TargetPlayerNotFound { target_player })?
                    .ip_addr
            }
        };
        let packet = build_sync_control_command(
            &self.state.config.model_name,
            self.state.config.player_number,
            command,
        );
        let sock = self.beat_tx.as_ref().ok_or(LinkError::ServerNotRunning)?;
        send_udp_packet(
            &self.state,
            sock,
            &packet,
            SocketAddrV4::new(target_ip, BEAT_PORT),
            "sync-control command",
        )
        .await?;
        tracing::info!(
            "{}",
            format!(
                "sent sync-control {} command to player={target_player} ip={target_ip}",
                command.label()
            ),
        );
        Ok(())
    }

    pub async fn send_sync_control_datagram(
        &self,
        target_player: u8,
        target_ip: Option<Ipv4Addr>,
        command: SyncControlCommand,
    ) -> Result<()> {
        let packet = build_sync_control_command(
            &self.state.config.model_name,
            self.state.config.player_number,
            command,
        );
        let target_ip = target_ip.unwrap_or(self.state.broadcast_ip);
        send_control_udp_packet(
            &self.state,
            BEAT_PORT,
            &packet,
            target_ip,
            "sync-control control",
        )
        .await?;
        tracing::info!(
            "{}",
            format!(
                "sent sync-control {} control to player={target_player} ip={target_ip}",
                command.label()
            ),
        );
        Ok(())
    }

    pub async fn send_master_handoff_request_command(
        &self,
        current_master_player: u8,
        target_ip: Option<Ipv4Addr>,
    ) -> Result<()> {
        let target_ip = match target_ip {
            Some(ip) => ip,
            None => {
                self.list_devices()
                    .await
                    .into_iter()
                    .find(|device| device.player_number == current_master_player)
                    .ok_or(LinkError::TargetPlayerNotFound {
                        target_player: current_master_player,
                    })?
                    .ip_addr
            }
        };
        let packet = build_master_handoff_request_command(
            &self.state.config.model_name,
            self.state.config.player_number,
        );
        let sock = self.beat_tx.as_ref().ok_or(LinkError::ServerNotRunning)?;
        send_udp_packet(
            &self.state,
            sock,
            &packet,
            SocketAddrV4::new(target_ip, BEAT_PORT),
            "master-handoff request command",
        )
        .await?;
        tracing::info!(
            "{}",
            format!(
                "sent master-handoff request command to current_master={current_master_player} ip={target_ip}"
            ),
        );
        Ok(())
    }

    pub async fn send_master_handoff_request_datagram(
        &self,
        current_master_player: u8,
        target_ip: Option<Ipv4Addr>,
    ) -> Result<()> {
        let packet = build_master_handoff_request_command(
            &self.state.config.model_name,
            self.state.config.player_number,
        );
        let target_ip = target_ip.unwrap_or(self.state.broadcast_ip);
        send_control_udp_packet(
            &self.state,
            BEAT_PORT,
            &packet,
            target_ip,
            "master-handoff request control",
        )
        .await?;
        tracing::info!(
            "{}",
            format!(
                "sent master-handoff request control to current_master={current_master_player} ip={target_ip}"
            ),
        );
        Ok(())
    }

    pub async fn send_master_handoff_response_command(
        &self,
        requesting_player: u8,
        target_ip: Option<Ipv4Addr>,
    ) -> Result<()> {
        let target_ip = match target_ip {
            Some(ip) => ip,
            None => {
                self.list_devices()
                    .await
                    .into_iter()
                    .find(|device| device.player_number == requesting_player)
                    .ok_or(LinkError::TargetPlayerNotFound {
                        target_player: requesting_player,
                    })?
                    .ip_addr
            }
        };
        let packet = build_master_handoff_response_command(
            &self.state.config.model_name,
            self.state.config.player_number,
            true,
        );
        let sock = self.beat_tx.as_ref().ok_or(LinkError::ServerNotRunning)?;
        send_udp_packet(
            &self.state,
            sock,
            &packet,
            SocketAddrV4::new(target_ip, BEAT_PORT),
            "master-handoff response command",
        )
        .await?;
        tracing::info!(
            "{}",
            format!(
                "sent master-handoff response command to requesting_player={requesting_player} ip={target_ip}"
            ),
        );
        Ok(())
    }

    pub async fn send_master_handoff_response_datagram(
        &self,
        requesting_player: u8,
        target_ip: Option<Ipv4Addr>,
    ) -> Result<()> {
        let packet = build_master_handoff_response_command(
            &self.state.config.model_name,
            self.state.config.player_number,
            true,
        );
        let target_ip = target_ip.unwrap_or(self.state.broadcast_ip);
        send_control_udp_packet(
            &self.state,
            BEAT_PORT,
            &packet,
            target_ip,
            "master-handoff response control",
        )
        .await?;
        tracing::info!(
            "{}",
            format!(
                "sent master-handoff response control to requesting_player={requesting_player} ip={target_ip}"
            ),
        );
        Ok(())
    }

    pub async fn send_on_air_command(&self, players: &[u8], extended: bool) -> Result<()> {
        let packet = build_on_air_command(
            &self.state.config.model_name,
            self.state.config.player_number,
            players,
            extended,
        )?;
        let sock = self.beat_tx.as_ref().ok_or(LinkError::ServerNotRunning)?;
        let target = SocketAddrV4::new(self.state.broadcast_ip, BEAT_PORT);
        send_udp_packet(&self.state, sock, &packet, target, "on-air command").await?;
        tracing::info!(
            "{}",
            format!(
                "sent on-air command players={players:?} extended={} broadcast={}",
                extended, self.state.broadcast_ip
            ),
        );
        Ok(())
    }

    pub async fn send_on_air_datagram(&self, players: &[u8], extended: bool) -> Result<()> {
        let packet = build_on_air_command(
            &self.state.config.model_name,
            self.state.config.player_number,
            players,
            extended,
        )?;
        send_control_udp_packet(
            &self.state,
            BEAT_PORT,
            &packet,
            self.state.broadcast_ip,
            "on-air control",
        )
        .await?;
        tracing::info!(
            "{}",
            format!(
                "sent on-air control players={players:?} extended={} broadcast={}",
                extended, self.state.broadcast_ip
            ),
        );
        Ok(())
    }

    pub async fn send_load_settings_command(
        &self,
        target_player: u8,
        target_ip: Option<Ipv4Addr>,
        payload_overrides: &[(usize, u8)],
    ) -> Result<()> {
        let target_ip = match target_ip {
            Some(ip) => ip,
            None => {
                self.list_devices()
                    .await
                    .into_iter()
                    .find(|device| device.player_number == target_player)
                    .ok_or(LinkError::TargetPlayerNotFound { target_player })?
                    .ip_addr
            }
        };
        let packet = build_status_load_settings_command(
            &self.state.config.model_name,
            self.state.config.player_number,
            target_player,
            payload_overrides,
        );
        let sock = self.status_tx.as_ref().ok_or(LinkError::ServerNotRunning)?;
        send_udp_packet(
            &self.state,
            sock,
            &packet,
            SocketAddrV4::new(target_ip, STATUS_PORT),
            "load-settings command",
        )
        .await?;
        tracing::info!(
            "{}",
            format!(
                "sent load-settings command to player={target_player} ip={target_ip} payload_overrides={}",
                payload_overrides.len()
            ),
        );
        Ok(())
    }

    pub async fn send_load_settings_datagram(
        &self,
        target_player: u8,
        target_ip: Option<Ipv4Addr>,
        payload_overrides: &[(usize, u8)],
    ) -> Result<()> {
        let packet = build_status_load_settings_command(
            &self.state.config.model_name,
            self.state.config.player_number,
            target_player,
            payload_overrides,
        );
        let target_ip = target_ip.unwrap_or(self.state.broadcast_ip);
        send_control_udp_packet(
            &self.state,
            STATUS_PORT,
            &packet,
            target_ip,
            "load-settings control",
        )
        .await?;
        tracing::info!(
            "{}",
            format!(
                "sent load-settings control to player={target_player} ip={target_ip} payload_overrides={}",
                payload_overrides.len()
            ),
        );
        Ok(())
    }

    pub async fn send_hot_cue_bank_command(
        &self,
        target_player: u8,
        target_ip: Option<Ipv4Addr>,
        bank_list_id: u32,
    ) -> Result<()> {
        let target_ip = self
            .resolve_target_player_ip(target_player, target_ip)
            .await?;
        let packet = build_hot_cue_bank_req_command(
            &self.state.config.model_name,
            self.state.config.player_number,
            bank_list_id,
        );
        let sock = self.status_tx.as_ref().ok_or(LinkError::ServerNotRunning)?;
        send_udp_packet(
            &self.state,
            sock,
            &packet,
            SocketAddrV4::new(target_ip, STATUS_PORT),
            "hot-cue-bank command",
        )
        .await?;
        tracing::info!(
            "{}",
            format!(
                "sent hot-cue-bank command to player={target_player} ip={target_ip} bank_list_id={bank_list_id}"
            ),
        );
        Ok(())
    }

    pub async fn send_hot_cue_bank_datagram(
        &self,
        target_player: u8,
        target_ip: Option<Ipv4Addr>,
        bank_list_id: u32,
    ) -> Result<()> {
        let packet = build_hot_cue_bank_req_command(
            &self.state.config.model_name,
            self.state.config.player_number,
            bank_list_id,
        );
        let target_ip = target_ip.unwrap_or(self.state.broadcast_ip);
        send_control_udp_packet(
            &self.state,
            STATUS_PORT,
            &packet,
            target_ip,
            "hot-cue-bank control",
        )
        .await?;
        tracing::info!(
            "{}",
            format!(
                "sent hot-cue-bank control to player={target_player} ip={target_ip} bank_list_id={bank_list_id}"
            ),
        );
        Ok(())
    }

    pub async fn send_cdj_renew_command(
        &self,
        target_ip: Option<Ipv4Addr>,
        renew_states: u8,
        song_number: u32,
        playlist_number: u32,
    ) -> Result<()> {
        let target_ip = target_ip.unwrap_or(self.state.broadcast_ip);
        let packet = build_cdj_renew_command(
            &self.state.config.model_name,
            self.state.config.player_number,
            renew_states,
            song_number,
            playlist_number,
        );
        let sock = self.status_tx.as_ref().ok_or(LinkError::ServerNotRunning)?;
        send_udp_packet(
            &self.state,
            sock,
            &packet,
            SocketAddrV4::new(target_ip, STATUS_PORT),
            "cdj-renew command",
        )
        .await?;
        tracing::info!(
            "{}",
            format!(
                "sent cdj-renew command to ip={target_ip} renew_states=0x{renew_states:02x} song_number={song_number} playlist_number={playlist_number}"
            ),
        );
        Ok(())
    }

    pub async fn send_cdj_renew_datagram(
        &self,
        target_ip: Option<Ipv4Addr>,
        renew_states: u8,
        song_number: u32,
        playlist_number: u32,
    ) -> Result<()> {
        let packet = build_cdj_renew_command(
            &self.state.config.model_name,
            self.state.config.player_number,
            renew_states,
            song_number,
            playlist_number,
        );
        let target_ip = target_ip.unwrap_or(self.state.broadcast_ip);
        send_control_udp_packet(
            &self.state,
            STATUS_PORT,
            &packet,
            target_ip,
            "cdj-renew control",
        )
        .await?;
        tracing::info!(
            "{}",
            format!(
                "sent cdj-renew control to ip={target_ip} renew_states=0x{renew_states:02x} song_number={song_number} playlist_number={playlist_number}"
            ),
        );
        Ok(())
    }

    pub async fn send_cue_renew_command(
        &self,
        target_player: u8,
        target_ip: Option<Ipv4Addr>,
        contents_id: u32,
    ) -> Result<()> {
        let target_ip = self
            .resolve_target_player_ip(target_player, target_ip)
            .await?;
        let packet = build_cue_renew_command(
            &self.state.config.model_name,
            self.state.config.player_number,
            target_player,
            contents_id,
        );
        let sock = self.status_tx.as_ref().ok_or(LinkError::ServerNotRunning)?;
        send_udp_packet(
            &self.state,
            sock,
            &packet,
            SocketAddrV4::new(target_ip, STATUS_PORT),
            "cue-renew command",
        )
        .await?;
        tracing::info!(
            "{}",
            format!(
                "sent cue-renew command to player={target_player} ip={target_ip} contents_id={contents_id}"
            ),
        );
        Ok(())
    }

    pub async fn send_cue_renew_datagram(
        &self,
        target_player: u8,
        target_ip: Option<Ipv4Addr>,
        contents_id: u32,
    ) -> Result<()> {
        let packet = build_cue_renew_command(
            &self.state.config.model_name,
            self.state.config.player_number,
            target_player,
            contents_id,
        );
        let target_ip = target_ip.unwrap_or(self.state.broadcast_ip);
        send_control_udp_packet(
            &self.state,
            STATUS_PORT,
            &packet,
            target_ip,
            "cue-renew control",
        )
        .await?;
        tracing::info!(
            "{}",
            format!(
                "sent cue-renew control to player={target_player} ip={target_ip} contents_id={contents_id}"
            ),
        );
        Ok(())
    }

    pub async fn send_multi_wave_view_command(
        &self,
        target_player: u8,
        target_ip: Option<Ipv4Addr>,
        contents_id: u32,
        data_kind: u8,
        device_kind: u8,
        browser_kind: u8,
    ) -> Result<()> {
        let target_ip = self
            .resolve_target_player_ip(target_player, target_ip)
            .await?;
        let packet = build_multi_wave_view_req_command(
            &self.state.config.model_name,
            self.state.config.player_number,
            contents_id,
            data_kind,
            target_player,
            device_kind,
            browser_kind,
        );
        let sock = self.status_tx.as_ref().ok_or(LinkError::ServerNotRunning)?;
        send_udp_packet(
            &self.state,
            sock,
            &packet,
            SocketAddrV4::new(target_ip, STATUS_PORT),
            "multi-wave-view command",
        )
        .await?;
        tracing::info!(
            "{}",
            format!(
                "sent multi-wave-view command to player={target_player} ip={target_ip} contents_id={contents_id} data_kind=0x{data_kind:02x} device_kind=0x{device_kind:02x} browser_kind=0x{browser_kind:02x}"
            ),
        );
        Ok(())
    }

    pub async fn send_multi_wave_view_datagram(
        &self,
        target_player: u8,
        target_ip: Option<Ipv4Addr>,
        contents_id: u32,
        data_kind: u8,
        device_kind: u8,
        browser_kind: u8,
    ) -> Result<()> {
        let packet = build_multi_wave_view_req_command(
            &self.state.config.model_name,
            self.state.config.player_number,
            contents_id,
            data_kind,
            target_player,
            device_kind,
            browser_kind,
        );
        let target_ip = target_ip.unwrap_or(self.state.broadcast_ip);
        send_control_udp_packet(
            &self.state,
            STATUS_PORT,
            &packet,
            target_ip,
            "multi-wave-view control",
        )
        .await?;
        tracing::info!(
            "{}",
            format!(
                "sent multi-wave-view control to player={target_player} ip={target_ip} contents_id={contents_id} data_kind=0x{data_kind:02x} device_kind=0x{device_kind:02x} browser_kind=0x{browser_kind:02x}"
            ),
        );
        Ok(())
    }

    pub async fn send_raw_udp_payload_datagram(
        &self,
        target_ip: Ipv4Addr,
        target_port: u16,
        payload: &[u8],
        context: &str,
    ) -> Result<usize> {
        self.send_raw_udp_payload_datagram_with_options(
            target_ip,
            target_port,
            None,
            None,
            payload,
            context,
        )
        .await
    }

    pub async fn send_raw_udp_payload_datagram_with_options(
        &self,
        target_ip: Ipv4Addr,
        target_port: u16,
        source_port: Option<u16>,
        target_mac: Option<&str>,
        payload: &[u8],
        context: &str,
    ) -> Result<usize> {
        if payload.is_empty() {
            return Err(LinkError::RawUdpPayloadEmpty.into());
        }
        let sent = if let Some(target_mac) = target_mac {
            let raw_source_port = match source_port {
                Some(port) => port,
                None => bind_udp(
                    SocketAddrV4::new(self.state.bind_ip, 0),
                    self.state.interface_name.as_deref(),
                    false,
                )?
                .local_addr()?
                .port(),
            };
            send_raw_udp_packet_to_mac(
                &self.state,
                raw_source_port,
                target_ip,
                target_port,
                target_mac,
                payload,
                context,
            )
            .await
            .with_context(|| {
                format!("send raw UDP payload to {target_ip}:{target_port} mac={target_mac}")
            })?;
            payload.len()
        } else {
            let sock = bind_udp(
                SocketAddrV4::new(self.state.bind_ip, source_port.unwrap_or(0)),
                self.state.interface_name.as_deref(),
                true,
            )?;
            send_udp_packet(
                &self.state,
                &sock,
                payload,
                SocketAddrV4::new(target_ip, target_port),
                context,
            )
            .await
            .with_context(|| format!("send raw UDP payload to {target_ip}:{target_port}"))?
        };
        tracing::info!(
            "{}",
            format!(
                "sent raw UDP payload to {target_ip}:{target_port} source_port={} target_mac={} bytes={sent}",
                source_port
                    .map(|port| port.to_string())
                    .unwrap_or_else(|| "-".to_string()),
                target_mac.unwrap_or("-"),
            ),
        );
        Ok(sent)
    }

    async fn resolve_target_player_ip(
        &self,
        target_player: u8,
        target_ip: Option<Ipv4Addr>,
    ) -> Result<Ipv4Addr> {
        match target_ip {
            Some(ip) => Ok(ip),
            None => self
                .list_devices()
                .await
                .into_iter()
                .find(|device| device.player_number == target_player)
                .map(|device| device.ip_addr)
                .ok_or(LinkError::TargetPlayerNotFound { target_player })
                .map_err(Into::into),
        }
    }

    pub fn stop(&mut self) {
        self.load_tx = None;
        self.state.clear_actor();
        self.status_tx = None;
        self.beat_tx = None;
        for task in self.tasks.drain(..) {
            task.abort();
        }
    }
}

async fn run_load_command_actor(
    state: Arc<ServerState>,
    sock: Arc<UdpSocket>,
    mut rx: mpsc::Receiver<LoadCommand>,
) {
    let mut active = HashMap::<u8, ActiveLoadCommand>::new();
    let mut tasks = JoinSet::new();
    let mut next_generation = 0u64;

    loop {
        tokio::select! {
            biased;
            command = rx.recv() => {
                let Some(command) = command else {
                    break;
                };
                let target_player = command.spec.target_player;
                if let Some(previous) = active.remove(&target_player) {
                    previous.abort.abort();
                    let _ = previous.reply.send(Err(LinkError::LoadCommandSuperseded {
                        target_player,
                        track_id: previous.track_id,
                    }.into()));
                    tracing::debug!(
                        target: "djtools_link::load",
                        target_player,
                        previous_track_id = previous.track_id,
                        previous_generation = previous.generation,
                        track_id = command.spec.track_id,
                        "load_command_superseded"
                    );
                }

                next_generation = next_generation.saturating_add(1);
                let generation = next_generation;
                let task_state = state.clone();
                let task_sock = sock.clone();
                let task_spec = command.spec.clone();
                let abort = tasks.spawn(async move {
                    let result = execute_load_command(task_state, task_sock, task_spec.clone()).await;
                    (task_spec.target_player, generation, result)
                });
                active.insert(target_player, ActiveLoadCommand {
                    generation,
                    track_id: command.spec.track_id,
                    abort,
                    reply: command.reply,
                });
                tracing::debug!(
                    target: "djtools_link::load",
                    target_player,
                    track_id = command.spec.track_id,
                    generation,
                    attempts = command.spec.attempts,
                    "load_command_started"
                );
            }
            completed = tasks.join_next(), if !tasks.is_empty() => {
                match completed {
                    Some(Ok((target_player, generation, result))) => {
                        if active
                            .get(&target_player)
                            .is_some_and(|current| current.generation == generation)
                        {
                            if let Some(current) = active.remove(&target_player) {
                                let _ = current.reply.send(result);
                            }
                        }
                    }
                    Some(Err(error)) => {
                        let task_id = error.id();
                        let target_player = active
                            .iter()
                            .find_map(|(player, command)| (command.abort.id() == task_id).then_some(*player));
                        if let Some(target_player) = target_player
                            && let Some(command) = active.remove(&target_player)
                        {
                            let _ = command.reply.send(Err(error.into()));
                        }
                    }
                    None => {}
                }
            }
        }
    }

    for (target_player, command) in active {
        command.abort.abort();
        let _ = command
            .reply
            .send(Err(LinkError::LoadCommandActorStopped.into()));
        tracing::debug!(
            target: "djtools_link::load",
            target_player,
            track_id = command.track_id,
            generation = command.generation,
            "load_command_stopped"
        );
    }
    tasks.abort_all();
}

async fn execute_load_command(
    state: Arc<ServerState>,
    sock: Arc<UdpSocket>,
    spec: LoadCommandSpec,
) -> Result<usize> {
    if state.config.tcp_track_file_side_channel {
        if let Some(track) = state.library.tracks_by_id.get(&spec.track_id) {
            let master_db_id = state.library.master_db_id;
            match send_track_file_tcp_side_channel(&state, spec.target_ip, track).await {
                Ok(bytes) => tracing::info!(
                    target_player = spec.target_player,
                    target_ip = %spec.target_ip,
                    track_id = spec.track_id,
                    master_db_id,
                    bytes,
                    "sent TCP track-file side channel"
                ),
                Err(error) => tracing::warn!(
                    target_player = spec.target_player,
                    target_ip = %spec.target_ip,
                    track_id = spec.track_id,
                    master_db_id,
                    %error,
                    "TCP track-file side channel failed"
                ),
            }
        }
    } else if state.library.tracks_by_id.contains_key(&spec.track_id) {
        tracing::debug!(
            target_player = spec.target_player,
            target_ip = %spec.target_ip,
            track_id = spec.track_id,
            master_db_id = state.library.master_db_id,
            "skipped TCP track-file side channel for CDJ load; experimental mobile side channel disabled"
        );
    }

    let _ = send_load_settings_packet(
        &state,
        &sock,
        spec.target_player,
        spec.target_ip,
        "load-settings before load-track command",
    )
    .await;

    let attempts = spec.attempts.max(1);
    let retry_contexts =
        load_command_retry_contexts(&state, spec.target_player, spec.track_id).await;
    for index in 0..attempts {
        let target_was_loaded = requested_track_is_loaded(&state, &spec).await;
        let context = (index > 0)
            .then(|| {
                retry_contexts
                    .get(index - 1)
                    .copied()
                    .or_else(|| retry_contexts.last().copied())
            })
            .flatten();
        let payload_overrides = match context {
            Some(context) => load_payload_overrides_for_track_with_extra(
                &state,
                spec.track_id,
                &context.payload_overrides(),
            ),
            None => load_payload_overrides_for_track(&state, spec.track_id),
        };
        let packet = build_status_load_track_command(
            &state.config.model_name,
            state.config.player_number,
            spec.target_player,
            spec.source_player,
            spec.source_slot,
            spec.source_track_type,
            spec.track_id,
            state.config.load_rekordbox_command_variant,
            &payload_overrides,
        );
        let sent_at = Instant::now();
        send_udp_packet(
            &state,
            &sock,
            &packet,
            SocketAddrV4::new(spec.target_ip, STATUS_PORT),
            "load-track command",
        )
        .await?;

        let confirm_timeout = if index + 1 < attempts {
            spec.retry_interval
                .clamp(Duration::from_millis(150), Duration::from_millis(750))
        } else {
            LOAD_COMMAND_FINAL_CONFIRM_TIMEOUT
        };
        let observed_after = if target_was_loaded {
            sent_at + LOAD_COMMAND_SAME_TRACK_SETTLE
        } else {
            sent_at
        };
        let confirmed =
            wait_for_requested_track_loaded(&state, &spec, observed_after, confirm_timeout).await;
        let acknowledged = state.load_ack_happened_after(spec.target_ip, sent_at).await;
        tracing::info!(
            attempt = index + 1,
            attempts,
            target_player = spec.target_player,
            target_ip = %spec.target_ip,
            track_id = spec.track_id,
            source_player = spec.source_player,
            source_slot = spec.source_slot,
            source_track_type = spec.source_track_type,
            context = context.map(LoadConfirmContext::summary).unwrap_or_else(|| "0x32(default)".to_string()),
            acknowledged,
            confirmed,
            "load_command_attempt"
        );
        if confirmed {
            tracing::info!(
                attempts = index + 1,
                target_player = spec.target_player,
                target_ip = %spec.target_ip,
                track_id = spec.track_id,
                "load_track_confirmed"
            );
            return Ok(index + 1);
        }
    }

    Err(LinkError::LoadNotConfirmed {
        target_player: spec.target_player,
        track_id: spec.track_id,
        attempts,
    }
    .into())
}

async fn load_command_retry_contexts(
    state: &ServerState,
    target_player: u8,
    track_id: u32,
) -> Vec<LoadConfirmContext> {
    let mut contexts = state.recent_browse_contexts(target_player, track_id).await;
    if let Some(artist_context) = artist_load_context_for_track(state, track_id)
        && !contexts.contains(&artist_context)
    {
        contexts.push(artist_context);
    }
    contexts
}

async fn wait_for_requested_track_loaded(
    state: &ServerState,
    spec: &LoadCommandSpec,
    observed_after: Instant,
    timeout: Duration,
) -> bool {
    state
        .wait_status_track(
            spec.target_player,
            spec.source_player,
            spec.track_id,
            spec.source_track_type,
            false,
            observed_after,
            timeout,
        )
        .await
}

async fn requested_track_is_loaded(state: &ServerState, spec: &LoadCommandSpec) -> bool {
    state
        .status_snapshot(spec.target_player)
        .await
        .as_ref()
        .is_some_and(|status| {
            status.matches_track_from_source(
                spec.source_player,
                spec.track_id,
                spec.source_track_type,
            )
        })
}

async fn wait_for_load_ack_after(
    state: &ServerState,
    target_ip: Ipv4Addr,
    after: Instant,
    timeout: Duration,
) -> bool {
    if state
        .actor_reply(|reply| ServerMsg::LoadAckHappenedAfter {
            ip: target_ip,
            after,
            reply,
        })
        .await
        .unwrap_or(false)
    {
        return true;
    }
    let (reply, received) = oneshot::channel();
    if state
        .actor_tx
        .send(ServerMsg::WaitLoadAckAfter {
            ip: target_ip,
            after,
            reply,
        })
        .await
        .is_err()
    {
        return false;
    }
    matches!(tokio::time::timeout(timeout, received).await, Ok(Ok(true)))
}

impl Drop for DjLinkServer {
    fn drop(&mut self) {
        self.stop();
    }
}

struct ServerState {
    config: DjLinkConfig,
    bind_ip: Ipv4Addr,
    broadcast_ip: Ipv4Addr,
    mac_addr: String,
    interface_name: Option<String>,
    raw_udp: RawUdpTx,
    library: Arc<LibrarySnapshot>,
    search_index: SearchIndex,
    actor_tx: ServerActorSender,
    log_path: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LoadProgressRecordResult {
    Recorded,
    Kept { previous_context: &'static str },
}

impl ServerState {
    fn clear_actor(&self) {
        let _ = self.actor_tx.try_send(ServerMsg::Shutdown);
    }

    async fn actor_reply<T>(&self, msg: impl FnOnce(oneshot::Sender<T>) -> ServerMsg) -> Option<T> {
        let (reply, received) = oneshot::channel();
        self.actor_tx.send(msg(reply)).await.ok()?;
        received.await.ok()
    }

    async fn actor_send(&self, msg: ServerMsg) -> bool {
        self.actor_tx.send(msg).await.is_ok()
    }

    async fn device_count(&self) -> u8 {
        self.actor_reply(|reply| ServerMsg::DeviceCount { reply })
            .await
            .unwrap_or(1)
    }

    async fn devices_sorted(&self) -> Vec<LinkDevice> {
        self.actor_reply(|reply| ServerMsg::Devices { reply })
            .await
            .unwrap_or_default()
    }

    async fn record_device(&self, dev: LinkDevice) -> bool {
        self.actor_reply(|reply| ServerMsg::RecordDevice { device: dev, reply })
            .await
            .unwrap_or(false)
    }

    async fn device_for_ip(&self, ip: Ipv4Addr) -> Option<LinkDevice> {
        self.actor_reply(|reply| ServerMsg::DeviceForIp { ip, reply })
            .await
            .flatten()
    }

    async fn player_for_ip(&self, ip: Ipv4Addr) -> Option<(u8, Ipv4Addr)> {
        self.device_for_ip(ip)
            .await
            .map(|device| (device.player_number, ip))
    }

    async fn unlinked_targets(&self) -> (Vec<Ipv4Addr>, bool) {
        self.actor_reply(|reply| ServerMsg::UnlinkedTargets { reply })
            .await
            .unwrap_or_default()
    }

    async fn mark_linked(&self, ip: Ipv4Addr) {
        let _ = self.actor_send(ServerMsg::MarkLinked { ip }).await;
    }

    async fn should_send_link_init(&self, ip: Ipv4Addr) -> bool {
        self.actor_reply(|reply| ServerMsg::ShouldSendLinkInit { ip, reply })
            .await
            .unwrap_or(false)
    }

    async fn mark_link_init_broadcast(&self) {
        let _ = self.actor_send(ServerMsg::MarkLinkInitBroadcast).await;
    }

    async fn next_db_query_response(&self, ip: Ipv4Addr) -> (u32, u16) {
        self.actor_reply(|reply| ServerMsg::NextDbQueryResponse {
            ip,
            db_server_port: self.config.db_server_port,
            reply,
        })
        .await
        .unwrap_or((0, self.config.db_server_port))
    }

    async fn remember_browse_context(
        &self,
        target_player: u8,
        context: LoadConfirmContext,
        track_ids: HashSet<u32>,
    ) {
        let _ = self
            .actor_send(ServerMsg::RememberBrowseContext {
                target_player,
                context,
                track_ids,
            })
            .await;
    }

    async fn recent_browse_contexts(
        &self,
        target_player: u8,
        track_id: u32,
    ) -> Vec<LoadConfirmContext> {
        self.actor_reply(|reply| ServerMsg::RecentBrowseContexts {
            target_player,
            track_id,
            reply,
        })
        .await
        .unwrap_or_default()
    }

    async fn load_ack_happened_after(&self, ip: Ipv4Addr, after: Instant) -> bool {
        self.actor_reply(|reply| ServerMsg::LoadAckHappenedAfter { ip, after, reply })
            .await
            .unwrap_or(false)
    }

    async fn record_load_progress(
        &self,
        target_player: u8,
        track_id: u32,
        context: &'static str,
    ) -> Option<LoadProgressRecordResult> {
        self.actor_reply(|reply| ServerMsg::RecordLoadProgress {
            target_player,
            track_id,
            context,
            reply,
        })
        .await
        .and_then(|result| match result {
            ActorLoadProgressRecordResult::Recorded => Some(LoadProgressRecordResult::Recorded),
            ActorLoadProgressRecordResult::Kept { previous_context } => {
                Some(LoadProgressRecordResult::Kept { previous_context })
            }
        })
    }

    async fn recent_previous_audio_read(
        &self,
        target_player: u8,
        track_id: u32,
        now: Instant,
    ) -> Option<LoadProgressSnapshot> {
        self.actor_reply(|reply| ServerMsg::RecentPreviousAudioRead {
            target_player,
            track_id,
            now,
            reply,
        })
        .await
        .flatten()
    }

    async fn cached_artwork(&self, artwork_id: u32) -> Option<Option<Vec<u8>>> {
        self.actor_reply(|reply| ServerMsg::CachedArtwork { artwork_id, reply })
            .await
            .flatten()
    }

    async fn store_artwork(&self, artwork_id: u32, bytes: Option<Vec<u8>>) {
        let _ = self
            .actor_send(ServerMsg::StoreArtwork { artwork_id, bytes })
            .await;
    }

    async fn cached_waveform_preview(&self, track_id: u32) -> Option<Vec<u8>> {
        self.actor_reply(|reply| ServerMsg::CachedWaveformPreview { track_id, reply })
            .await
            .flatten()
    }

    async fn store_waveform_preview(&self, track_id: u32, blob: Vec<u8>) {
        let _ = self
            .actor_send(ServerMsg::StoreWaveformPreview { track_id, blob })
            .await;
    }

    async fn monitor_snapshot(&self, player: u8) -> DjLinkMonitorSnapshot {
        self.actor_reply(|reply| ServerMsg::MonitorSnapshot { player, reply })
            .await
            .unwrap_or_default()
    }

    async fn status_snapshot(&self, player: u8) -> Option<CdjStatusSnapshot> {
        self.actor_reply(|reply| ServerMsg::StatusSnapshot { player, reply })
            .await
            .flatten()
    }

    async fn wait_status_track(
        &self,
        target_player: u8,
        source_player: u8,
        track_id: u32,
        track_type: u8,
        require_playing: bool,
        observed_after: Instant,
        timeout: Duration,
    ) -> bool {
        let timeout = timeout.max(Duration::from_millis(1));
        let expires_at = Instant::now() + timeout;
        tokio::time::timeout(timeout, async {
            self.actor_reply(|reply| ServerMsg::WaitStatusTrack {
                target_player,
                source_player,
                track_id,
                track_type,
                require_playing,
                observed_after,
                expires_at,
                reply,
            })
            .await
            .unwrap_or(false)
        })
        .await
        .unwrap_or(false)
    }

    async fn record_status(&self, status: CdjStatusSnapshot) -> bool {
        self.actor_reply(|reply| ServerMsg::RecordStatus { status, reply })
            .await
            .unwrap_or(false)
    }

    async fn record_beat(&self, beat: CdjBeatSnapshot, seen_at: Instant) -> bool {
        self.actor_reply(|reply| ServerMsg::RecordBeat {
            beat,
            seen_at,
            reply,
        })
        .await
        .unwrap_or(false)
    }

    async fn record_position(&self, position: CdjPositionSnapshot) -> bool {
        self.actor_reply(|reply| ServerMsg::RecordPosition { position, reply })
            .await
            .unwrap_or(false)
    }
}

impl NfsContext for ServerState {
    fn bind_ip(&self) -> Ipv4Addr {
        self.bind_ip
    }

    async fn nfs_handle_for_path(&self, path: &Path, parent_fh: Option<&[u8]>) -> Option<Vec<u8>> {
        self.actor_reply(|reply| ServerMsg::NfsHandleForPath {
            path: path.to_path_buf(),
            parent_fh: parent_fh.map(<[u8]>::to_vec),
            reply,
        })
        .await
    }

    async fn nfs_path_for_handle(&self, fh: &[u8]) -> Option<PathBuf> {
        self.actor_reply(|reply| ServerMsg::NfsPathForHandle {
            fh: fh.to_vec(),
            reply,
        })
        .await
        .flatten()
    }

    async fn nfs_read_chunk(
        &self,
        path: &Path,
        offset: u64,
        count: usize,
    ) -> std::io::Result<Vec<u8>> {
        read_nfs_file_chunk(path, offset, count).await
    }

    async fn note_nfs_audio_progress(&self, addr: SocketAddr, path: &Path, offset: u64) {
        maybe_note_nfs_audio_progress(self, addr, path, offset).await;
    }
}

async fn maybe_note_nfs_audio_progress(
    state: &ServerState,
    addr: SocketAddr,
    path: &Path,
    offset: u64,
) {
    let track_id = state
        .library
        .all_tracks
        .iter()
        .find(|track| track.mount_path == path)
        .map(|track| track.track_id);
    note_load_progress_with_logging(state, None, addr, track_id, "nfs-audio", offset == 0).await;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CdjStatusSnapshot {
    player: u8,
    active: u8,
    source_player: u8,
    source_slot: u8,
    track_type: u8,
    track_id: u32,
    track_position: u16,
    sort_state: u8,
    source_menu: u8,
    source_category_1: u32,
    source_category_2: u32,
    menu_track_count: u16,
    flags: u8,
    play_state_1: u8,
    play_state_2: u8,
    play_state_3: u8,
    pitch_1: u32,
    pitch_2: u32,
    bpm_hundreds: u16,
    beat_in_bar: u8,
    master_meaningful: u8,
    master_handoff: u8,
    master_tempo: Option<u8>,
    key: Option<[u8; 3]>,
    key_shift_cents: Option<i64>,
    p4: Option<u8>,
    bar_steps: Option<u16>,
    bar_position: Option<u16>,
    buffer_forward: Option<u8>,
    buffer_back: Option<u8>,
    loop_start_raw: Option<u32>,
    loop_end_raw: Option<u32>,
    loop_beats: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CdjBeatSnapshot {
    player: u8,
    len_rest: u16,
    next_beat_ms: u32,
    second_beat_ms: u32,
    next_bar_ms: u32,
    fourth_beat_ms: u32,
    second_bar_ms: u32,
    eighth_beat_ms: u32,
    pitch: u32,
    bpm_hundreds: u16,
    beat_in_bar: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FaderStartSnapshot {
    player: u8,
    len_rest: u16,
    commands: [u8; 4],
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct OnAirSnapshot {
    player: u8,
    subtype: u8,
    len_rest: u16,
    channels: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SyncControlSnapshot {
    player: u8,
    len_rest: u16,
    player_marker: u8,
    command: u8,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MasterHandoffSnapshot {
    response: bool,
    player: u8,
    len_rest: u16,
    player_marker: u8,
    yielded: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CdjPositionSnapshot {
    player: u8,
    len_rest: u16,
    track_length_sec: u32,
    playhead_ms: u32,
    pitch_centi_percent: i32,
    effective_bpm_tenths: u32,
}

impl CdjStatusSnapshot {
    pub(crate) fn player(&self) -> u8 {
        self.player
    }

    pub(crate) fn matches_track_from_source(
        &self,
        source_player: u8,
        track_id: u32,
        track_type: u8,
    ) -> bool {
        self.source_player == source_player
            && self.track_id == track_id
            && self.track_type == track_type
    }

    pub(crate) fn is_playing(&self) -> bool {
        self.flags & CDJ_STATUS_PLAYING_FLAG != 0
            || matches!(self.play_state_1, 0x03 | 0x04 | 0x07 | 0x10)
    }

    pub(crate) fn log_worthy_change_from(&self, previous: &Self) -> bool {
        self.player != previous.player
            || self.active != previous.active
            || self.source_player != previous.source_player
            || self.source_slot != previous.source_slot
            || self.track_type != previous.track_type
            || self.track_id != previous.track_id
            || self.track_position != previous.track_position
            || self.sort_state != previous.sort_state
            || self.source_menu != previous.source_menu
            || self.source_category_1 != previous.source_category_1
            || self.source_category_2 != previous.source_category_2
            || self.menu_track_count != previous.menu_track_count
            || self.flags != previous.flags
            || self.play_state_1 != previous.play_state_1
            || self.play_state_2 != previous.play_state_2
            || self.play_state_3 != previous.play_state_3
            || self.pitch_1 != previous.pitch_1
            || self.pitch_2 != previous.pitch_2
            || self.master_meaningful != previous.master_meaningful
            || self.master_handoff != previous.master_handoff
            || self.master_tempo != previous.master_tempo
            || self.key != previous.key
            || self.key_shift_cents != previous.key_shift_cents
            || self.p4 != previous.p4
            || self.loop_start_raw != previous.loop_start_raw
            || self.loop_end_raw != previous.loop_end_raw
            || self.loop_beats != previous.loop_beats
    }

    pub(crate) fn summary(&self) -> String {
        let pitch = pitch_percent(self.pitch_1);
        let base_bpm = bpm_hundreds_to_f64(self.bpm_hundreds);
        let effective_bpm = effective_bpm_hundreds(self.bpm_hundreds, self.pitch_1)
            .map(|bpm| format!("{:.2}", bpm as f64 / 100.0))
            .unwrap_or_else(|| "none".to_string());
        format!(
            "cdj status player={} active={} src_player={} slot={} type={} track_id={} track_pos={} sort=0x{:02x} source_menu=0x{:02x}({}) cat1={} cat2={} menu_count={} flags=0x{:02x}({}) play1=0x{:02x}({}) play2=0x{:02x}({}) play3=0x{:02x}({}) pitch={pitch:.3}% bpm={} effective_bpm={effective_bpm} beat_in_bar={} master={} handoff=0x{:02x} master_tempo={} key={} key_shift_cents={} p4={} bar={} buf={}/{} loop={}",
            self.player,
            self.active,
            self.source_player,
            self.source_slot,
            self.track_type,
            self.track_id,
            self.track_position,
            self.sort_state,
            self.source_menu,
            cdj_source_menu_label(self.source_menu),
            self.source_category_1,
            self.source_category_2,
            self.menu_track_count,
            self.flags,
            cdj_status_flags_label(self.flags),
            self.play_state_1,
            cdj_play_state_1_label(self.play_state_1),
            self.play_state_2,
            cdj_play_state_2_label(self.play_state_2),
            self.play_state_3,
            cdj_play_state_3_label(self.play_state_3),
            base_bpm
                .map(|bpm| format!("{bpm:.2}"))
                .unwrap_or_else(|| "none".to_string()),
            self.beat_in_bar,
            self.master_meaningful,
            self.master_handoff,
            option_u8_hex(self.master_tempo),
            option_key_hex(self.key),
            self.key_shift_cents
                .map(|value| value.to_string())
                .unwrap_or_else(|| "none".to_string()),
            option_u8_hex(self.p4),
            option_bar_summary(self.bar_steps, self.bar_position),
            option_u8_hex(self.buffer_forward),
            option_u8_hex(self.buffer_back),
            self.loop_summary(),
        )
    }

    fn loop_summary(&self) -> String {
        let Some(start) = self.loop_start_raw else {
            return "none".to_string();
        };
        let Some(end) = self.loop_end_raw else {
            return "none".to_string();
        };
        if start == 0 && end == 0 {
            return "none".to_string();
        }
        format!(
            "{}ms..{}ms beats={}",
            cdj3000_loop_time_ms(start),
            cdj3000_loop_time_ms(end),
            self.loop_beats.unwrap_or(0)
        )
    }
}

impl CdjBeatSnapshot {
    pub(crate) fn player(&self) -> u8 {
        self.player
    }

    pub(crate) fn summary(&self) -> String {
        let pitch = pitch_percent(self.pitch);
        let base_bpm = bpm_hundreds_to_f64(self.bpm_hundreds);
        let effective_bpm = effective_bpm_hundreds(self.bpm_hundreds, self.pitch)
            .map(|bpm| format!("{:.2}", bpm as f64 / 100.0))
            .unwrap_or_else(|| "none".to_string());
        format!(
            "cdj beat player={} len={} next={}ms second={}ms next_bar={}ms fourth={}ms second_bar={}ms eighth={}ms pitch={pitch:.3}% bpm={} effective_bpm={effective_bpm} beat_in_bar={}",
            self.player,
            self.len_rest,
            self.next_beat_ms,
            self.second_beat_ms,
            self.next_bar_ms,
            self.fourth_beat_ms,
            self.second_bar_ms,
            self.eighth_beat_ms,
            base_bpm
                .map(|bpm| format!("{bpm:.2}"))
                .unwrap_or_else(|| "none".to_string()),
            self.beat_in_bar,
        )
    }
}

#[cfg(test)]
impl FaderStartSnapshot {
    fn summary(&self) -> String {
        format!(
            "djlink fader-start player={} len={} commands={:?}",
            self.player, self.len_rest, self.commands
        )
    }
}

#[cfg(test)]
impl OnAirSnapshot {
    fn summary(&self) -> String {
        format!(
            "djlink on-air player={} subtype=0x{:02x} len={} channels={:?}",
            self.player, self.subtype, self.len_rest, self.channels
        )
    }
}

#[cfg(test)]
impl SyncControlSnapshot {
    fn summary(&self) -> String {
        let command = SyncControlCommand::from_packet_byte(self.command)
            .map(SyncControlCommand::label)
            .unwrap_or("unknown");
        format!(
            "djlink sync-control player={} marker={} len={} command=0x{:02x}({command})",
            self.player, self.player_marker, self.len_rest, self.command
        )
    }
}

impl CdjPositionSnapshot {
    pub(crate) fn player(&self) -> u8 {
        self.player
    }

    pub(crate) fn summary(&self) -> String {
        let pitch = self.pitch_centi_percent as f64 / 100.0;
        let bpm = if self.effective_bpm_tenths == u32::MAX {
            "none".to_string()
        } else {
            format!("{:.1}", self.effective_bpm_tenths as f64 / 10.0)
        };
        format!(
            "cdj position player={} len={} track_length={}s playhead={}ms pitch={pitch:.2}% effective_bpm={bpm}",
            self.player, self.len_rest, self.track_length_sec, self.playhead_ms,
        )
    }
}

async fn send_udp_packet(
    state: &ServerState,
    sock: &UdpSocket,
    packet: &[u8],
    target: SocketAddrV4,
    context: &str,
) -> std::io::Result<usize> {
    let started = Instant::now();
    let is_broadcast = *target.ip() == state.broadcast_ip || *target.ip() == Ipv4Addr::BROADCAST;
    #[cfg(target_os = "macos")]
    if is_broadcast && state.interface_name.is_some() {
        match send_raw_udp_packet_to_mac(
            state,
            sock.local_addr()?.port(),
            *target.ip(),
            target.port(),
            "ff:ff:ff:ff:ff:ff",
            packet,
            context,
        )
        .await
        {
            Ok(()) => {
                trace!(
                    target: "djtools_link::udp",
                    context,
                    %target,
                    bytes = packet.len(),
                    transport = "raw-bpf",
                    elapsed_us = started.elapsed().as_micros(),
                    "udp_send"
                );
                return Ok(packet.len());
            }
            Err(err) => {
                debug!(
                    target: "djtools_link::udp",
                    context,
                    %target,
                    %err,
                    "raw_broadcast_failed_trying_kernel"
                );
            }
        }
    }
    if !is_broadcast && crate::network::udp_payload_needs_raw_fragmentation(packet) {
        match send_raw_udp_packet(state, sock, packet, target, context).await {
            Ok(()) => return Ok(packet.len()),
            Err(err) => {
                debug!(
                    target: "djtools_link::udp",
                    context,
                    %target,
                    %err,
                    "raw_fragmented_udp_failed_trying_kernel"
                );
            }
        }
    }

    match sock.send_to(packet, target).await {
        Ok(sent) => {
            trace!(
                target: "djtools_link::udp",
                context,
                %target,
                bytes = sent,
                elapsed_us = started.elapsed().as_micros(),
                "udp_send"
            );
            Ok(sent)
        }
        Err(err) if !is_broadcast && udp_unicast_needs_raw_fallback(&err) => {
            match send_raw_udp_packet(state, sock, packet, target, context).await {
                Ok(()) => {
                    trace!(
                        target: "djtools_link::udp",
                        context,
                        %target,
                        bytes = packet.len(),
                        fallback = "raw",
                        elapsed_us = started.elapsed().as_micros(),
                        "udp_send"
                    );
                    return Ok(packet.len());
                }
                Err(raw_err) => {
                    debug!(
                        target: "djtools_link::udp",
                        context,
                        %target,
                        %raw_err,
                        "raw_udp_fallback_failed"
                    );
                }
            }
            if !udp_unicast_needs_broadcast_fallback(&err) {
                return Err(err);
            }
            let broadcast_target = SocketAddrV4::new(state.broadcast_ip, target.port());
            tracing::warn!(
                "{}",
                format!(
                    "{context} unicast to {target} failed: {err}; retrying broadcast {broadcast_target}"
                ),
            );
            let sent = match sock.send_to(packet, broadcast_target).await {
                Ok(sent) => sent,
                Err(broadcast_err) => {
                    send_raw_udp_packet_to_mac(
                        state,
                        sock.local_addr()?.port(),
                        state.broadcast_ip,
                        target.port(),
                        "ff:ff:ff:ff:ff:ff",
                        packet,
                        context,
                    )
                    .await
                    .map_err(|_| broadcast_err)?;
                    packet.len()
                }
            };
            trace!(
                target: "djtools_link::udp",
                context,
                %target,
                %broadcast_target,
                bytes = sent,
                fallback = "broadcast",
                elapsed_us = started.elapsed().as_micros(),
                "udp_send"
            );
            Ok(sent)
        }
        Err(err) if is_broadcast => {
            send_raw_udp_packet_to_mac(
                state,
                sock.local_addr()?.port(),
                *target.ip(),
                target.port(),
                "ff:ff:ff:ff:ff:ff",
                packet,
                context,
            )
            .await
            .map_err(|raw_err| {
                debug!(
                    target: "djtools_link::udp",
                    context,
                    %target,
                    kernel_error = %err,
                    %raw_err,
                    "broadcast_kernel_and_raw_send_failed"
                );
                err
            })?;
            Ok(packet.len())
        }
        Err(err) => Err(err),
    }
}

async fn send_control_udp_packet(
    state: &ServerState,
    port: u16,
    packet: &[u8],
    target_ip: Ipv4Addr,
    context: &str,
) -> std::io::Result<usize> {
    let sock = bind_udp(
        SocketAddrV4::new(state.bind_ip, 0),
        state.interface_name.as_deref(),
        true,
    )?;
    let target = SocketAddrV4::new(target_ip, port);
    send_udp_packet(state, &sock, packet, target, context).await
}

async fn send_status_control_packet(
    state: &ServerState,
    packet: &[u8],
    target_ip: Ipv4Addr,
    target_mac: Option<&str>,
    context: &str,
) -> std::io::Result<usize> {
    if let Some(target_mac) = target_mac {
        send_raw_udp_packet_to_mac(
            state,
            STATUS_PORT,
            target_ip,
            STATUS_PORT,
            target_mac,
            packet,
            context,
        )
        .await?;
        return Ok(packet.len());
    }
    send_control_udp_packet(state, STATUS_PORT, packet, target_ip, context).await
}

async fn send_raw_udp_packet(
    state: &ServerState,
    sock: &UdpSocket,
    packet: &[u8],
    target: SocketAddrV4,
    context: &str,
) -> std::io::Result<()> {
    let target_ip = *target.ip();
    let device = state
        .device_for_ip(target_ip)
        .await
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "unknown target MAC"))?;
    send_raw_udp_packet_to_mac(
        state,
        sock.local_addr()?.port(),
        target_ip,
        target.port(),
        &device.mac_addr,
        packet,
        context,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn send_raw_udp_packet_to_mac(
    state: &ServerState,
    source_port: u16,
    target_ip: Ipv4Addr,
    target_port: u16,
    target_mac: &str,
    payload: &[u8],
    context: &str,
) -> std::io::Result<()> {
    state
        .raw_udp
        .send(RawUdpDatagram {
            src_mac: parse_mac(&state.mac_addr)?,
            dst_mac: parse_mac(target_mac)?,
            src_ip: state.bind_ip,
            src_port: source_port,
            dst_ip: target_ip,
            dst_port: target_port,
            payload: payload.to_vec(),
        })
        .await?;
    if context != "nfs reply" {
        debug!(
            target: "djtools_link::udp",
            context,
            %target_ip,
            target_port,
            source_port,
            mac = target_mac,
            "raw_udp_sent"
        );
    }
    Ok(())
}

#[cfg(test)]
fn udp_payload_needs_raw_fragmentation(packet: &[u8]) -> bool {
    20 + 8 + packet.len() > RAW_IPV4_MTU
}

fn udp_unicast_needs_broadcast_fallback(err: &std::io::Error) -> bool {
    matches!(
        err.raw_os_error(),
        Some(50 | 51 | 64 | 65) // ENETDOWN, ENETUNREACH, EHOSTDOWN, EHOSTUNREACH on macOS/BSD.
    )
}

fn udp_unicast_needs_raw_fallback(err: &std::io::Error) -> bool {
    udp_unicast_needs_broadcast_fallback(err)
        || matches!(
            err.raw_os_error(),
            Some(40 | 49) // EMSGSIZE/EADDRNOTAVAIL on macOS/BSD; raw BPF bypasses both.
        )
}

#[cfg(test)]
const TCP_FLAG_PSH: u8 = 0x08;
#[cfg(test)]
const TCP_FLAG_ACK: u8 = 0x10;

#[cfg(test)]
fn build_ethernet_ipv4_udp_frame(
    src_mac: [u8; 6],
    dst_mac: [u8; 6],
    src_ip: Ipv4Addr,
    src_port: u16,
    dst_ip: Ipv4Addr,
    dst_port: u16,
    payload: &[u8],
) -> std::io::Result<Vec<u8>> {
    let mut frames = build_ethernet_ipv4_udp_frames(
        src_mac,
        dst_mac,
        src_ip,
        src_port,
        dst_ip,
        dst_port,
        payload,
        0,
        usize::MAX,
    )?;
    frames
        .pop()
        .ok_or_else(|| std::io::Error::other("empty raw UDP frame"))
}

#[cfg(test)]
fn build_ethernet_ipv4_udp_frames(
    src_mac: [u8; 6],
    dst_mac: [u8; 6],
    src_ip: Ipv4Addr,
    src_port: u16,
    dst_ip: Ipv4Addr,
    dst_port: u16,
    payload: &[u8],
    ip_id: u16,
    mtu: usize,
) -> std::io::Result<Vec<Vec<u8>>> {
    let udp_len = 8usize
        .checked_add(payload.len())
        .ok_or_else(|| std::io::Error::other("UDP payload length overflow"))?;
    let ip_len = 20usize
        .checked_add(udp_len)
        .ok_or_else(|| std::io::Error::other("IP payload length overflow"))?;
    if ip_len > u16::MAX as usize {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "raw UDP payload too large",
        ));
    }

    let mut udp_datagram = Vec::with_capacity(udp_len);
    udp_datagram.extend_from_slice(&src_port.to_be_bytes());
    udp_datagram.extend_from_slice(&dst_port.to_be_bytes());
    udp_datagram.extend_from_slice(&(udp_len as u16).to_be_bytes());
    udp_datagram.extend_from_slice(&0u16.to_be_bytes());
    udp_datagram.extend_from_slice(payload);

    if ip_len <= mtu {
        return Ok(vec![build_ethernet_ipv4_payload_frame(
            src_mac,
            dst_mac,
            src_ip,
            dst_ip,
            ip_id,
            0,
            &udp_datagram,
        )?]);
    }

    if mtu <= 20 + 8 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "raw UDP MTU too small",
        ));
    }
    let max_fragment_payload = ((mtu - 20) / 8) * 8;
    let mut offset = 0usize;
    let mut frames = Vec::new();
    while offset < udp_datagram.len() {
        let remaining = udp_datagram.len() - offset;
        let chunk_len = remaining.min(max_fragment_payload);
        let more_fragments = offset + chunk_len < udp_datagram.len();
        let fragment_offset = (offset / 8) as u16;
        let flags_fragment_offset = fragment_offset | if more_fragments { 0x2000 } else { 0 };
        frames.push(build_ethernet_ipv4_payload_frame(
            src_mac,
            dst_mac,
            src_ip,
            dst_ip,
            ip_id,
            flags_fragment_offset,
            &udp_datagram[offset..offset + chunk_len],
        )?);
        offset += chunk_len;
    }
    Ok(frames)
}

#[cfg(test)]
fn build_ethernet_ipv4_payload_frame(
    src_mac: [u8; 6],
    dst_mac: [u8; 6],
    src_ip: Ipv4Addr,
    dst_ip: Ipv4Addr,
    ip_id: u16,
    flags_fragment_offset: u16,
    ip_payload: &[u8],
) -> std::io::Result<Vec<u8>> {
    build_ethernet_ipv4_payload_frame_with_protocol(
        src_mac,
        dst_mac,
        src_ip,
        dst_ip,
        ip_id,
        flags_fragment_offset,
        17,
        ip_payload,
    )
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn build_ethernet_ipv4_payload_frame_with_protocol(
    src_mac: [u8; 6],
    dst_mac: [u8; 6],
    src_ip: Ipv4Addr,
    dst_ip: Ipv4Addr,
    ip_id: u16,
    flags_fragment_offset: u16,
    protocol: u8,
    ip_payload: &[u8],
) -> std::io::Result<Vec<u8>> {
    let ip_len = 20usize
        .checked_add(ip_payload.len())
        .ok_or_else(|| std::io::Error::other("IP payload length overflow"))?;
    if ip_len > u16::MAX as usize {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "raw IPv4 payload too large",
        ));
    }

    let mut frame = Vec::with_capacity(14 + ip_len);
    frame.extend_from_slice(&dst_mac);
    frame.extend_from_slice(&src_mac);
    frame.extend_from_slice(&0x0800u16.to_be_bytes());

    let ip_start = frame.len();
    frame.push(0x45);
    frame.push(0);
    frame.extend_from_slice(&(ip_len as u16).to_be_bytes());
    frame.extend_from_slice(&ip_id.to_be_bytes());
    frame.extend_from_slice(&flags_fragment_offset.to_be_bytes());
    frame.push(64);
    frame.push(protocol);
    frame.extend_from_slice(&0u16.to_be_bytes());
    frame.extend_from_slice(&src_ip.octets());
    frame.extend_from_slice(&dst_ip.octets());
    let ip_checksum = internet_checksum(&frame[ip_start..ip_start + 20]);
    frame[ip_start + 10..ip_start + 12].copy_from_slice(&ip_checksum.to_be_bytes());

    frame.extend_from_slice(ip_payload);
    pad_ethernet_min_frame(&mut frame);
    Ok(frame)
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn build_ethernet_ipv4_tcp_frame(
    src_mac: [u8; 6],
    dst_mac: [u8; 6],
    src_ip: Ipv4Addr,
    src_port: u16,
    dst_ip: Ipv4Addr,
    dst_port: u16,
    seq: u32,
    ack: u32,
    flags: u8,
    payload: &[u8],
    ip_id: u16,
) -> std::io::Result<Vec<u8>> {
    let tcp_len = 20usize
        .checked_add(payload.len())
        .ok_or_else(|| std::io::Error::other("TCP payload length overflow"))?;
    if tcp_len > u16::MAX as usize {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "raw TCP payload too large",
        ));
    }
    let mut tcp = Vec::with_capacity(tcp_len);
    tcp.extend_from_slice(&src_port.to_be_bytes());
    tcp.extend_from_slice(&dst_port.to_be_bytes());
    tcp.extend_from_slice(&seq.to_be_bytes());
    tcp.extend_from_slice(&ack.to_be_bytes());
    tcp.push(5u8 << 4);
    tcp.push(flags);
    tcp.extend_from_slice(&64_240u16.to_be_bytes());
    tcp.extend_from_slice(&0u16.to_be_bytes());
    tcp.extend_from_slice(&0u16.to_be_bytes());
    tcp.extend_from_slice(payload);
    let checksum = tcp_checksum(src_ip, dst_ip, &tcp);
    tcp[16..18].copy_from_slice(&checksum.to_be_bytes());

    build_ethernet_ipv4_payload_frame_with_protocol(
        src_mac, dst_mac, src_ip, dst_ip, ip_id, 0, 6, &tcp,
    )
}

#[cfg(test)]
fn build_ethernet_arp_reply_frame(
    src_mac: [u8; 6],
    dst_mac: [u8; 6],
    src_ip: Ipv4Addr,
    dst_ip: Ipv4Addr,
) -> Vec<u8> {
    let mut frame = Vec::with_capacity(42);
    frame.extend_from_slice(&dst_mac);
    frame.extend_from_slice(&src_mac);
    frame.extend_from_slice(&0x0806u16.to_be_bytes());
    frame.extend_from_slice(&1u16.to_be_bytes());
    frame.extend_from_slice(&0x0800u16.to_be_bytes());
    frame.push(6);
    frame.push(4);
    frame.extend_from_slice(&2u16.to_be_bytes());
    frame.extend_from_slice(&src_mac);
    frame.extend_from_slice(&src_ip.octets());
    frame.extend_from_slice(&dst_mac);
    frame.extend_from_slice(&dst_ip.octets());
    pad_ethernet_min_frame(&mut frame);
    frame
}

#[cfg(test)]
fn pad_ethernet_min_frame(frame: &mut Vec<u8>) {
    if frame.len() < 60 {
        frame.resize(60, 0);
    }
}

#[cfg(test)]
fn tcp_checksum(src_ip: Ipv4Addr, dst_ip: Ipv4Addr, tcp_segment: &[u8]) -> u16 {
    let mut pseudo = Vec::with_capacity(12 + tcp_segment.len());
    pseudo.extend_from_slice(&src_ip.octets());
    pseudo.extend_from_slice(&dst_ip.octets());
    pseudo.push(0);
    pseudo.push(6);
    pseudo.extend_from_slice(&(tcp_segment.len() as u16).to_be_bytes());
    pseudo.extend_from_slice(tcp_segment);
    internet_checksum(&pseudo)
}

#[cfg(test)]
fn internet_checksum(data: &[u8]) -> u16 {
    let mut sum = 0u32;
    for chunk in data.chunks(2) {
        let word = if chunk.len() == 2 {
            u16::from_be_bytes([chunk[0], chunk[1]]) as u32
        } else {
            (chunk[0] as u32) << 8
        };
        sum = sum.wrapping_add(word);
        while sum > 0xffff {
            sum = (sum & 0xffff) + (sum >> 16);
        }
    }
    !(sum as u16)
}

fn default_ip() -> LinkResult<Ipv4Addr> {
    for entry in ifconfig_ipv4_entries() {
        if entry.active && entry.ip.is_link_local() {
            return Ok(entry.ip);
        }
    }
    let sock = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))?;
    sock.connect((Ipv4Addr::new(8, 8, 8, 8), 80))?;
    match sock.local_addr()? {
        SocketAddr::V4(addr) => Ok(*addr.ip()),
        SocketAddr::V6(_) => Err(LinkError::RouteProbeIpv6),
    }
}

fn default_broadcast_ip(ip: Ipv4Addr) -> Ipv4Addr {
    for entry in ifconfig_ipv4_entries() {
        if entry.ip == ip {
            if let Some(broadcast) = entry.broadcast {
                return broadcast;
            }
        }
    }
    let octets = ip.octets();
    Ipv4Addr::new(octets[0], octets[1], octets[2], 255)
}

fn default_mac(ip: Ipv4Addr) -> String {
    for entry in ifconfig_ipv4_entries() {
        if entry.ip == ip {
            if let Some(mac) = entry.mac {
                return mac;
            }
        }
    }
    let o = ip.octets();
    format!("02:00:{:02x}:{:02x}:{:02x}:{:02x}", o[0], o[1], o[2], o[3])
}

fn default_interface_name(ip: Ipv4Addr) -> Option<String> {
    ifconfig_ipv4_entries()
        .into_iter()
        .find(|entry| entry.ip == ip)
        .map(|entry| entry.name)
}

#[derive(Debug)]
struct IfconfigIpv4 {
    name: String,
    ip: Ipv4Addr,
    broadcast: Option<Ipv4Addr>,
    mac: Option<String>,
    active: bool,
}

fn ifconfig_ipv4_entries() -> Vec<IfconfigIpv4> {
    let Ok(output) = Command::new("ifconfig").output() else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut entries = Vec::new();
    let mut name = String::new();
    let mut active = true;
    let mut mac = None::<String>;
    for line in text.lines() {
        if !line.starts_with('\t') && line.contains(": flags=") {
            name = line
                .split_once(':')
                .map(|(name, _)| name.to_string())
                .unwrap_or_default();
            active = !line.contains("status: inactive");
            mac = None;
            continue;
        }
        let s = line.trim();
        if let Some(rest) = s.strip_prefix("ether ") {
            mac = rest.split_whitespace().next().map(|v| v.to_string());
            continue;
        }
        if let Some(rest) = s.strip_prefix("status: ") {
            active = rest == "active";
            continue;
        }
        if let Some(rest) = s.strip_prefix("inet ") {
            let parts = rest.split_whitespace().collect::<Vec<_>>();
            let Some(ip) = parts.first().and_then(|v| v.parse().ok()) else {
                continue;
            };
            if ip == Ipv4Addr::LOCALHOST {
                continue;
            }
            let mut broadcast = None;
            for pair in parts.windows(2) {
                if pair[0] == "broadcast" {
                    broadcast = pair[1].parse().ok();
                }
            }
            entries.push(IfconfigIpv4 {
                name: name.clone(),
                ip,
                broadcast,
                mac: mac.clone(),
                active,
            });
        }
    }
    entries
}

fn cstr_padded_ascii(value: &str, size: usize) -> Vec<u8> {
    let mut out = vec![0; size];
    let raw = value.as_bytes();
    let len = raw.len().min(size.saturating_sub(1));
    out[..len].copy_from_slice(&raw[..len]);
    out
}

fn ascii_lossy(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii() && !ch.is_ascii_control() {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn mac_bytes(mac: &str) -> [u8; 6] {
    let mut out = [0u8; 6];
    for (i, part) in mac.split(':').take(6).enumerate() {
        out[i] = u8::from_str_radix(part, 16).unwrap_or(0);
    }
    out
}

fn format_mac(mac: [u8; 6]) -> String {
    format!(
        "{:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x}",
        mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]
    )
}

fn bytes_to_mac(raw: &[u8]) -> String {
    raw.iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(":")
}

pub fn build_keepalive_status_packet(
    model: &str,
    player_number: u8,
    ip_addr: Ipv4Addr,
    mac_addr: &str,
    device_count: u8,
) -> Vec<u8> {
    keepalive::build_status_announcement(
        model,
        player_number,
        ip_addr,
        mac_bytes(mac_addr),
        device_count,
    )
}

fn build_keepalive_discovery_packet(model: &str, ip_addr: Ipv4Addr, iteration: u8) -> Vec<u8> {
    keepalive::build_discovery(model, ip_addr, iteration)
}

fn build_keepalive_ip_packet(
    model: &str,
    ip_addr: Ipv4Addr,
    mac_addr: &str,
    marker: u8,
    frame_type: KeepaliveKind,
) -> Vec<u8> {
    keepalive::build_ip_claim(model, ip_addr, mac_bytes(mac_addr), marker, frame_type)
}

fn build_keepalive_compat_response_packet(model: &str) -> Vec<u8> {
    keepalive::build_compatibility_reply(model)
}

fn build_keepalive_id_use_response_packet(
    model: &str,
    request_frame_type: KeepaliveKind,
) -> Vec<u8> {
    keepalive::build_id_use_reply(model, request_frame_type)
}

fn keepalive_frame_type(packet: &[u8]) -> Option<KeepaliveKind> {
    keepalive::decode_header(packet)
        .ok()
        .map(|header| header.kind)
}

pub fn parse_keepalive_device(packet: &[u8]) -> Option<LinkDevice> {
    let decoded = keepalive::decode(packet).ok()?;
    let model = decoded.header.model;
    match decoded.body {
        KeepaliveBody::DeviceAnnouncement(announcement) => Some(LinkDevice {
            player_number: announcement.player_number,
            mac_addr: bytes_to_mac(&announcement.mac),
            ip_addr: announcement.advertised_ip,
            model,
            last_seen: Instant::now(),
        }),
        KeepaliveBody::AddressClaim(claim) => Some(LinkDevice {
            player_number: if (1..=6).contains(&claim.player_marker) {
                claim.player_marker
            } else {
                0
            },
            mac_addr: bytes_to_mac(&claim.mac),
            ip_addr: claim.advertised_ip,
            model,
            last_seen: Instant::now(),
        }),
        KeepaliveBody::Other { .. } => None,
    }
}

pub fn build_status_rekordbox_reply(model: &str, player_number: u8, name: &str) -> Vec<u8> {
    status::build_source_name_reply(model, player_number, name)
}

pub fn build_status_link_init(model: &str, player_number: u8) -> Vec<u8> {
    status::build_link_init(model, player_number)
}

pub fn build_status_link_reply(
    model: &str,
    player_number: u8,
    slot: u8,
    source_name: &str,
    track_count: usize,
    playlist_count: usize,
) -> Vec<u8> {
    status::build_link_reply(
        model,
        player_number,
        slot,
        source_name,
        track_count,
        playlist_count,
    )
}

fn build_status_mystery_47(model: &str, player_number: u8) -> Vec<u8> {
    status::build_extension_47(model, player_number)
}

fn build_status_mixer_status(model: &str, player_number: u8) -> Vec<u8> {
    status::build_mixer_status(model, player_number)
}

fn build_status_beat_status(model: &str, player_number: u8) -> Vec<u8> {
    let mut packet = decode_hex(BEAT_STATUS_TEMPLATE_HEX);
    packet[11..31].copy_from_slice(&cstr_padded_ascii(model, 20));
    packet[33] = player_number;
    if let Some(last) = packet.last_mut() {
        *last = player_number;
    }
    packet
}

fn build_fader_start_command(
    model: &str,
    player_number: u8,
    target_player: u8,
    start: bool,
    idle_byte: u8,
) -> LinkResult<Vec<u8>> {
    if !(1..=4).contains(&target_player) {
        return Err(LinkError::InvalidFaderStartTarget { target_player });
    }
    let mut packet = Vec::new();
    packet.extend_from_slice(DJLINK_MAGIC);
    packet.push(BEAT_TYPE_FADER_START);
    packet.extend_from_slice(&cstr_padded_ascii(model, 20));
    packet.push(0x01);
    packet.push(0x00);
    packet.push(player_number);
    packet.extend_from_slice(&4u16.to_be_bytes());
    let mut commands = [idle_byte; 4];
    commands[target_player as usize - 1] = if start { 0x00 } else { 0x01 };
    packet.extend_from_slice(&commands);
    Ok(packet)
}

fn build_sync_control_command(
    model: &str,
    player_number: u8,
    command: SyncControlCommand,
) -> Vec<u8> {
    let mut packet = Vec::new();
    packet.extend_from_slice(DJLINK_MAGIC);
    packet.push(BEAT_TYPE_SYNC_CONTROL);
    packet.extend_from_slice(&cstr_padded_ascii(model, 20));
    packet.extend_from_slice(&[
        0x01,
        0x00,
        player_number,
        0x00,
        0x08,
        0x00,
        0x00,
        0x00,
        player_number,
        0x00,
        0x00,
        0x00,
        command.packet_byte(),
    ]);
    packet
}

fn build_master_handoff_request_command(model: &str, player_number: u8) -> Vec<u8> {
    let mut packet = Vec::new();
    packet.extend_from_slice(DJLINK_MAGIC);
    packet.push(BEAT_TYPE_MASTER_HANDOFF_REQUEST);
    packet.extend_from_slice(&cstr_padded_ascii(model, 20));
    packet.extend_from_slice(&[
        0x01,
        0x00,
        player_number,
        0x00,
        0x04,
        0x00,
        0x00,
        0x00,
        player_number,
    ]);
    packet
}

fn build_master_handoff_response_command(model: &str, player_number: u8, yielded: bool) -> Vec<u8> {
    let mut packet = Vec::new();
    packet.extend_from_slice(DJLINK_MAGIC);
    packet.push(BEAT_TYPE_MASTER_HANDOFF_RESPONSE);
    packet.extend_from_slice(&cstr_padded_ascii(model, 20));
    packet.extend_from_slice(&[
        0x01,
        0x00,
        player_number,
        0x00,
        0x08,
        0x00,
        0x00,
        0x00,
        player_number,
        0x00,
        0x00,
        0x00,
        u8::from(yielded),
    ]);
    packet
}

fn build_on_air_command(
    model: &str,
    player_number: u8,
    players: &[u8],
    extended: bool,
) -> LinkResult<Vec<u8>> {
    for player in players {
        if !(1..=6).contains(player) {
            return Err(LinkError::InvalidOnAirPlayer { player: *player });
        }
        if !extended && *player > 4 {
            return Err(LinkError::InvalidNonExtendedOnAirPlayer { player: *player });
        }
    }

    let mut packet = Vec::new();
    packet.extend_from_slice(DJLINK_MAGIC);
    packet.push(BEAT_TYPE_ON_AIR);
    packet.extend_from_slice(&cstr_padded_ascii(model, 20));

    if extended {
        let mut payload = [
            0x01,
            0x03,
            player_number,
            0x00,
            0x11,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
        ];
        for player in players {
            match *player {
                1..=4 => payload[*player as usize + 4] = 1,
                5..=6 => payload[*player as usize + 9] = 1,
                _ => {}
            }
        }
        packet.extend_from_slice(&payload);
    } else {
        let mut payload = [
            0x01,
            0x00,
            player_number,
            0x00,
            0x09,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
            0x00,
        ];
        for player in players {
            payload[*player as usize + 4] = 1;
        }
        packet.extend_from_slice(&payload);
    }

    Ok(packet)
}

fn parse_status_link_query_detail(packet: &[u8]) -> Option<(u8, u8, u8)> {
    if packet.len() < 48 || &packet[..10] != DJLINK_MAGIC || packet[10] != STATUS_TYPE_LINK_QUERY {
        return None;
    }
    Some((packet[43], packet[47], packet[32]))
}

pub fn parse_status_link_query(packet: &[u8]) -> Option<(u8, u8)> {
    let (player, slot, _) = parse_status_link_query_detail(packet)?;
    Some((player, slot))
}

fn parse_cdj_status(packet: &[u8]) -> Option<CdjStatusSnapshot> {
    if packet.len() < 0xa7 || &packet[..10] != DJLINK_MAGIC || packet[10] != 0x0a {
        return None;
    }
    Some(CdjStatusSnapshot {
        player: packet[0x21],
        active: packet[0x27],
        source_player: packet[0x28],
        source_slot: packet[0x29],
        track_type: packet[0x2a],
        track_id: be_u32(packet.get(0x2c..0x30)?),
        track_position: u16::from_be_bytes(packet.get(0x32..0x34)?.try_into().ok()?),
        sort_state: packet[0x35],
        source_menu: packet[0x37],
        source_category_1: be_u32(packet.get(0x38..0x3c)?),
        source_category_2: be_u32(packet.get(0x3c..0x40)?),
        menu_track_count: u16::from_be_bytes(packet.get(0x46..0x48)?.try_into().ok()?),
        flags: packet[0x89],
        play_state_1: packet[0x7b],
        play_state_2: packet[0x8b],
        play_state_3: packet[0x9d],
        pitch_1: be_u32(packet.get(0x8c..0x90)?),
        pitch_2: be_u32(packet.get(0x98..0x9c)?),
        bpm_hundreds: u16::from_be_bytes(packet.get(0x92..0x94)?.try_into().ok()?),
        beat_in_bar: packet[0xa6],
        master_meaningful: packet[0x9e],
        master_handoff: packet[0x9f],
        master_tempo: packet.get(0x158).copied(),
        key: packet.get(0x15c..0x15f).map(|raw| [raw[0], raw[1], raw[2]]),
        key_shift_cents: packet
            .get(0x164..0x16c)
            .and_then(|raw| raw.try_into().ok())
            .map(i64::from_be_bytes),
        p4: packet.get(0x113).copied(),
        bar_steps: packet
            .get(0x116..0x118)
            .map(|raw| u16::from_be_bytes([raw[0], raw[1]])),
        bar_position: packet
            .get(0x11a..0x11c)
            .map(|raw| u16::from_be_bytes([raw[0], raw[1]])),
        buffer_forward: packet.get(0x11d).copied(),
        buffer_back: packet.get(0x11e).copied(),
        loop_start_raw: packet.get(0x1b6..0x1ba).map(be_u32),
        loop_end_raw: packet.get(0x1be..0x1c2).map(be_u32),
        loop_beats: packet
            .get(0x1c8..0x1ca)
            .map(|raw| u16::from_be_bytes([raw[0], raw[1]])),
    })
}

fn parse_cdj_beat(packet: &[u8]) -> Option<CdjBeatSnapshot> {
    if packet.len() < 0x60 || &packet[..10] != DJLINK_MAGIC || packet[10] != BEAT_TYPE_BEAT {
        return None;
    }
    Some(CdjBeatSnapshot {
        player: packet[0x21],
        len_rest: u16::from_be_bytes(packet.get(0x22..0x24)?.try_into().ok()?),
        next_beat_ms: be_u32(packet.get(0x24..0x28)?),
        second_beat_ms: be_u32(packet.get(0x28..0x2c)?),
        next_bar_ms: be_u32(packet.get(0x2c..0x30)?),
        fourth_beat_ms: be_u32(packet.get(0x30..0x34)?),
        second_bar_ms: be_u32(packet.get(0x34..0x38)?),
        eighth_beat_ms: be_u32(packet.get(0x38..0x3c)?),
        pitch: be_u24(packet.get(0x55..0x58)?),
        bpm_hundreds: u16::from_be_bytes(packet.get(0x5a..0x5c)?.try_into().ok()?),
        beat_in_bar: packet[0x5c],
    })
}

fn parse_fader_start(packet: &[u8]) -> Option<FaderStartSnapshot> {
    if packet.len() < 0x28 || &packet[..10] != DJLINK_MAGIC || packet[10] != BEAT_TYPE_FADER_START {
        return None;
    }
    Some(FaderStartSnapshot {
        player: packet[0x21],
        len_rest: u16::from_be_bytes(packet.get(0x22..0x24)?.try_into().ok()?),
        commands: packet.get(0x24..0x28)?.try_into().ok()?,
    })
}

fn parse_on_air(packet: &[u8]) -> Option<OnAirSnapshot> {
    if packet.len() < 0x2d || &packet[..10] != DJLINK_MAGIC || packet[10] != BEAT_TYPE_ON_AIR {
        return None;
    }
    let subtype = packet[0x20];
    let len_rest = u16::from_be_bytes(packet.get(0x22..0x24)?.try_into().ok()?);
    let mut channels = packet.get(0x24..0x28)?.to_vec();
    if subtype == 0x03 && packet.len() >= 0x2f && len_rest >= 0x11 {
        channels.extend_from_slice(packet.get(0x2d..0x2f)?);
    }
    Some(OnAirSnapshot {
        player: packet[0x21],
        subtype,
        len_rest,
        channels,
    })
}

fn parse_sync_control(packet: &[u8]) -> Option<SyncControlSnapshot> {
    if packet.len() < 0x2c || &packet[..10] != DJLINK_MAGIC || packet[10] != BEAT_TYPE_SYNC_CONTROL
    {
        return None;
    }
    Some(SyncControlSnapshot {
        player: packet[0x21],
        len_rest: u16::from_be_bytes(packet.get(0x22..0x24)?.try_into().ok()?),
        player_marker: packet[0x27],
        command: packet[0x2b],
    })
}

fn parse_master_handoff(packet: &[u8]) -> Option<MasterHandoffSnapshot> {
    if packet.len() < 0x28 || &packet[..10] != DJLINK_MAGIC {
        return None;
    }
    match packet[10] {
        BEAT_TYPE_MASTER_HANDOFF_REQUEST => Some(MasterHandoffSnapshot {
            response: false,
            player: packet[0x21],
            len_rest: u16::from_be_bytes(packet.get(0x22..0x24)?.try_into().ok()?),
            player_marker: packet[0x27],
            yielded: None,
        }),
        BEAT_TYPE_MASTER_HANDOFF_RESPONSE if packet.len() >= 0x2c => Some(MasterHandoffSnapshot {
            response: true,
            player: packet[0x21],
            len_rest: u16::from_be_bytes(packet.get(0x22..0x24)?.try_into().ok()?),
            player_marker: packet[0x27],
            yielded: Some(packet[0x2b] == 1),
        }),
        _ => None,
    }
}

fn parse_cdj_position(packet: &[u8]) -> Option<CdjPositionSnapshot> {
    if packet.len() < 0x3c
        || &packet[..10] != DJLINK_MAGIC
        || packet[10] != BEAT_TYPE_PRECISE_POSITION
    {
        return None;
    }
    Some(CdjPositionSnapshot {
        player: packet[0x21],
        len_rest: u16::from_be_bytes(packet.get(0x22..0x24)?.try_into().ok()?),
        track_length_sec: be_u32(packet.get(0x24..0x28)?),
        playhead_ms: be_u32(packet.get(0x28..0x2c)?),
        pitch_centi_percent: i32::from_be_bytes(packet.get(0x2c..0x30)?.try_into().ok()?),
        effective_bpm_tenths: be_u32(packet.get(0x38..0x3c)?),
    })
}

fn pitch_percent(raw: u32) -> f64 {
    ((raw as f64 / 0x100000 as f64) - 1.0) * 100.0
}

fn bpm_hundreds_to_f64(raw: u16) -> Option<f64> {
    (raw != u16::MAX).then_some(raw as f64 / 100.0)
}

fn cdj_status_flags_label(value: u8) -> &'static str {
    match value {
        0x80 => "idle",
        0x84 => "loaded-cued",
        0xa0 => "loading",
        0xa4 => "active",
        0xe4 => "active-loop",
        _ => "unknown",
    }
}

fn cdj_play_state_1_label(value: u8) -> &'static str {
    match value {
        0x00 => "empty",
        0x02 => "loading",
        0x03 => "playing",
        0x04 => "looping",
        0x05 => "paused",
        0x06 => "cued",
        0x07 => "cue-playing",
        0x08 => "cue-scratching",
        0x09 => "searching",
        0x10 => "moving-alt",
        0x11 => "ended",
        _ => "unknown",
    }
}

fn cdj_play_state_2_label(value: u8) -> &'static str {
    match value {
        0x7a => "moving",
        0x7e => "stopped",
        0xfa => "opus-moving",
        0xfe => "stopped-alt",
        _ => "unknown",
    }
}

fn cdj_play_state_3_label(value: u8) -> &'static str {
    match value {
        0x00 => "empty",
        0x01 => "paused-or-reverse",
        0x09 => "forward-vinyl",
        0x0d => "forward-cdj",
        _ => "unknown",
    }
}

fn cdj_source_menu_label(value: u8) -> &'static str {
    match value {
        0x00 => "none",
        0x02 => "artist-menu",
        0x03 => "album-menu",
        0x04 => "track-menu",
        0x05 => "playlist",
        0x06 => "bpm-menu",
        0x0c => "key-menu",
        0x11 => "folder-menu",
        0x12 => "search-song",
        0x16 => "history",
        0x1f => "search-artist",
        0x20 => "search-album",
        0x28 => "tag-list",
        0x32 => "instant-double-or-previous-track",
        _ => "unknown",
    }
}

fn effective_bpm_hundreds(bpm_hundreds: u16, pitch_raw: u32) -> Option<u32> {
    if bpm_hundreds == u16::MAX {
        return None;
    }
    Some(((bpm_hundreds as u64 * pitch_raw as u64) / 0x100000) as u32)
}

fn cdj3000_loop_time_ms(raw: u32) -> u64 {
    (raw as u64 * 65_536) / 1_000
}

fn option_u8_hex(value: Option<u8>) -> String {
    value
        .map(|value| format!("0x{value:02x}"))
        .unwrap_or_else(|| "none".to_string())
}

fn option_key_hex(value: Option<[u8; 3]>) -> String {
    value
        .map(|value| format!("{:02x}{:02x}{:02x}", value[0], value[1], value[2]))
        .unwrap_or_else(|| "none".to_string())
}

fn option_bar_summary(steps: Option<u16>, position: Option<u16>) -> String {
    match (steps, position) {
        (Some(steps), Some(position)) => format!("{position}/{steps}"),
        _ => "none".to_string(),
    }
}

pub fn build_status_load_track_command(
    model: &str,
    own_player_number: u8,
    target_player_number: u8,
    source_player_number: u8,
    source_slot: u8,
    source_track_type: u8,
    track_id: u32,
    rekordbox_variant: bool,
    payload_byte_overrides: &[(usize, u8)],
) -> Vec<u8> {
    let mut payload = LOAD_TRACK_PAYLOAD_TEMPLATE.to_vec();
    payload[0x02] = own_player_number;
    payload[0x05] = own_player_number;
    payload[0x09] = source_player_number;
    payload[0x0a] = source_slot;
    payload[0x0b] = source_track_type;
    payload[0x21] = target_player_number.saturating_sub(1);
    payload[0x0d..0x11].copy_from_slice(&track_id.to_be_bytes());
    if rekordbox_variant {
        payload[0x01] = 0x01;
        payload[0x2c] = 0x32;
    }
    for &(offset, value) in payload_byte_overrides {
        if offset < payload.len() {
            payload[offset] = value;
        }
    }

    let mut packet = Vec::new();
    packet.extend_from_slice(DJLINK_MAGIC);
    packet.push(STATUS_TYPE_LOAD_CMD);
    packet.extend_from_slice(&cstr_padded_ascii(model, 20));
    packet.extend_from_slice(&payload);
    packet
}

fn build_status_load_settings_command(
    model: &str,
    own_player_number: u8,
    target_player_number: u8,
    payload_overrides: &[(usize, u8)],
) -> Vec<u8> {
    let mut packet = vec![0u8; 0x74];
    packet[..10].copy_from_slice(DJLINK_MAGIC);
    packet[10] = STATUS_TYPE_LOAD_SETTINGS;
    packet[11..31].copy_from_slice(&cstr_padded_ascii(model, 20));
    packet[0x1f] = 0x02;
    packet[0x20] = own_player_number;
    packet[0x21] = target_player_number;
    packet[0x22..0x24].copy_from_slice(&0x0050u16.to_be_bytes());
    packet[0x24..0x2c].copy_from_slice(&[0x12, 0x34, 0x56, 0x78, 0x00, 0x00, 0x00, 0x03]);

    // Conservative capture preset: Auto Cue off, autoplay/continue, no sync.
    packet[0x2c] = 0x80; // On Air Display off.
    packet[0x2d] = 0x85; // LCD brightness max.
    packet[0x2e] = 0x81; // Quantize on.
    packet[0x2f] = 0x80; // Auto Cue level: -36 dB.
    packet[0x30] = 0x81; // English.
    packet[0x31] = 0x01;
    packet[0x32] = 0x82; // Jog ring bright.
    packet[0x33] = 0x81; // Jog ring indicator on.
    packet[0x34] = 0x81; // Slip flashing on.
    packet[0x35] = 0x01;
    packet[0x36] = 0x01;
    packet[0x37] = 0x01;
    packet[0x38] = 0x82; // Disc slot illumination bright.
    packet[0x39] = 0x80; // Eject/load lock off.
    packet[0x3a] = 0x80; // Sync off.
    packet[0x3b] = 0x80; // Autoplay/continue.
    packet[0x3c] = 0x80; // Quantize full-beat value.
    packet[0x3d] = 0x82; // Hot Cue Auto Load: track setting.
    packet[0x3e] = 0x81; // Hot Cue Color on.
    packet[0x41] = 0x80; // Needle Lock off.
    packet[0x44] = 0x80; // Elapsed time.
    packet[0x45] = 0x81; // Vinyl jog mode.
    packet[0x46] = 0x80; // Auto Cue off.
    packet[0x47] = 0x80; // Master Tempo off.
    packet[0x48] = 0x81; // Tempo range +/- 10.
    packet[0x49] = 0x80; // Phase meter type 1.
    packet[0x4c] = 0x80; // Vinyl speed adjust touch/release.
    packet[0x4d] = 0x81; // Jog display info.
    packet[0x4e] = 0x84; // Pad brightness max.
    packet[0x4f] = 0x85; // Jog display brightness max.
    for &(offset, value) in payload_overrides {
        if offset < packet.len() {
            packet[offset] = value;
        }
    }
    packet
}

fn build_status_private_frame(
    model: &str,
    packet_type: u8,
    len: usize,
    subtype: u8,
    rest_len: u16,
) -> Vec<u8> {
    let mut packet = vec![0u8; len];
    packet[..10].copy_from_slice(DJLINK_MAGIC);
    packet[10] = packet_type;
    packet[11..31].copy_from_slice(&cstr_padded_ascii(model, 20));
    packet[0x1f] = 0x01;
    packet[0x20] = subtype;
    packet[0x22..0x24].copy_from_slice(&rest_len.to_be_bytes());
    packet
}

fn build_hot_cue_bank_req_command(model: &str, source_id: u8, bank_list_id: u32) -> Vec<u8> {
    let mut packet =
        build_status_private_frame(model, STATUS_TYPE_HOT_CUE_BANK_REQ, 0x2c, 0x01, 0x0008);
    packet[0x21] = source_id;
    packet[0x24] = source_id;
    packet[0x28..0x2c].copy_from_slice(&bank_list_id.to_be_bytes());
    packet
}

fn build_cdj_renew_command(
    model: &str,
    source_id: u8,
    renew_states: u8,
    song_number: u32,
    playlist_number: u32,
) -> Vec<u8> {
    let mut packet = build_status_private_frame(model, STATUS_TYPE_CDJ_RENEW, 0x30, 0x01, 0x000c);
    packet[0x21] = source_id;
    packet[0x24] = source_id;
    packet[0x25] = renew_states;
    packet[0x28..0x2c].copy_from_slice(&song_number.to_be_bytes());
    packet[0x2c..0x30].copy_from_slice(&playlist_number.to_be_bytes());
    packet
}

fn build_cue_renew_command(model: &str, source_id: u8, player_no: u8, contents_id: u32) -> Vec<u8> {
    let mut packet = build_status_private_frame(model, STATUS_TYPE_CUE_RENEW, 0x30, 0x01, 0x000c);
    packet[0x21] = source_id;
    packet[0x24] = source_id;
    packet[0x28] = player_no;
    packet[0x29] = 0x04;
    packet[0x2a] = 0x01;
    packet[0x2c..0x30].copy_from_slice(&contents_id.to_be_bytes());
    packet
}

fn build_multi_wave_view_req_command(
    model: &str,
    source_id: u8,
    contents_id: u32,
    data_kind: u8,
    destination_id: u8,
    device_kind: u8,
    browser_kind: u8,
) -> Vec<u8> {
    let mut packet =
        build_status_private_frame(model, STATUS_TYPE_MULTI_WAVE_VIEW_REQ, 0x2c, 0x00, 0x0008);
    packet[0x21] = source_id;
    packet[0x24..0x28].copy_from_slice(&contents_id.to_le_bytes());
    packet[0x28] = data_kind;
    packet[0x29] = destination_id;
    packet[0x2a] = device_kind;
    packet[0x2b] = browser_kind;
    packet
}

async fn send_track_file_tcp_side_channel(
    state: &ServerState,
    target_ip: Ipv4Addr,
    track: &TrackRecord,
) -> Result<u64> {
    send_track_file_kernel_tcp_side_channel(state, target_ip, track).await
}

async fn send_track_file_kernel_tcp_side_channel(
    state: &ServerState,
    target_ip: Ipv4Addr,
    track: &TrackRecord,
) -> Result<u64> {
    let identity = tcp_device_identity(state);

    let mut device_stream = connect_track_file_tcp(state, target_ip).await?;
    let device_connect = build_tcp_device_connect_packet(state.config.player_number, &identity);
    device_stream
        .write_all(&device_connect)
        .await
        .context("send TCP device-connect side channel")?;

    let mut file = tokio::fs::File::open(&track.mount_path)
        .await
        .with_context(|| format!("open track file '{}'", track.mount_path.display()))?;
    let file_size = file
        .metadata()
        .await
        .with_context(|| format!("stat track file '{}'", track.mount_path.display()))?
        .len();
    let mut stream = connect_track_file_tcp(state, target_ip).await?;
    let mobile_connect = build_tcp_mobile_connect_req2_packet(&identity);
    stream
        .write_all(&mobile_connect)
        .await
        .context("send TCP mobile-connect-req2 side channel")?;

    let header = build_tcp_send_track_file_path_packet(
        TCP_MODEL_REKORDBOX,
        track.track_id,
        state.library.master_db_id,
        file_size,
    );
    stream
        .write_all(&header)
        .await
        .context("send TCP track-file header")?;

    let mut buffer = vec![0u8; TRACK_FILE_TCP_CHUNK_SIZE];
    let mut total = (device_connect.len() + mobile_connect.len() + header.len()) as u64;
    loop {
        let count = file.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        stream
            .write_all(&buffer[..count])
            .await
            .context("send TCP track-file bytes")?;
        total += count as u64;
    }
    Ok(total)
}

fn tcp_device_identity(state: &ServerState) -> String {
    format!("{}@{}", state.config.model_name, state.bind_ip)
}

async fn connect_track_file_tcp(state: &ServerState, target_ip: Ipv4Addr) -> Result<TcpStream> {
    tokio::time::timeout(
        TRACK_FILE_TCP_CONNECT_TIMEOUT,
        connect_tcp(
            state.bind_ip,
            SocketAddrV4::new(target_ip, STATUS_PORT),
            state.interface_name.as_deref(),
        ),
    )
    .await
    .context("TCP track-file connect timed out")?
    .with_context(|| {
        format!(
            "connect TCP/{STATUS_PORT} via {} to {target_ip}",
            state.interface_name.as_deref().unwrap_or("default route")
        )
    })
}

fn build_tcp_device_connect_packet(device_id: u8, identity: &str) -> Vec<u8> {
    let mut packet = vec![0u8; 0x68];
    packet[0..10].copy_from_slice(DJLINK_MAGIC);
    packet[10] = TCP_TYPE_DEVICE_CONNECT;
    packet[0x0b..0x1f].copy_from_slice(&cstr_padded_ascii(TCP_MODEL_REKORDBOX, 20));
    packet[0x1f] = 0x01;
    packet[0x20] = 0x01;
    packet[0x22..0x24].copy_from_slice(&0x0044u16.to_be_bytes());
    packet[0x24..0x28].copy_from_slice(&(device_id as u32).to_be_bytes());
    packet[0x28..0x68].copy_from_slice(&cstr_padded_ascii(identity, 64));
    packet
}

fn build_tcp_mobile_connect_req2_packet(identity: &str) -> Vec<u8> {
    let identity = ascii_lossy(identity);
    let identity = identity.as_bytes();
    let body_len = identity.len().saturating_add(4).min(u16::MAX as usize);
    let identity_len = body_len.saturating_sub(4);
    let mut packet = vec![0u8; 0x24 + body_len];
    packet[0..10].copy_from_slice(DJLINK_MAGIC);
    packet[10] = TCP_TYPE_MOBILE_CONNECT_REQ2;
    packet[0x0b..0x1f].copy_from_slice(&cstr_padded_ascii(TCP_MODEL_REKORDBOX, 20));
    packet[0x1f] = 0x01;
    packet[0x22..0x24].copy_from_slice(&(body_len as u16).to_be_bytes());
    packet[0x24..0x28].copy_from_slice(&(identity_len as u32).to_be_bytes());
    packet[0x28..0x28 + identity_len].copy_from_slice(&identity[..identity_len]);
    packet
}

fn build_tcp_send_track_file_path_packet(
    model: &str,
    first_id: u32,
    second_id: u32,
    file_size: u64,
) -> Vec<u8> {
    let mut packet = vec![0u8; 0x34];
    packet[0..10].copy_from_slice(DJLINK_MAGIC);
    packet[10] = STATUS_TYPE_LOAD_CMD;
    packet[0x0b..0x1f].copy_from_slice(&cstr_padded_ascii(model, 20));
    packet[0x1f] = 0x01;
    packet[0x22..0x24].copy_from_slice(&0x0010u16.to_be_bytes());
    packet[0x24..0x28].copy_from_slice(&first_id.to_be_bytes());
    packet[0x28..0x2c].copy_from_slice(&second_id.to_be_bytes());
    packet[0x2c..0x34].copy_from_slice(&file_size.to_be_bytes());
    packet
}

#[allow(dead_code)]
fn build_tcp_get_track_file_req_packet(model: &str, first_id: u32, second_id: u32) -> Vec<u8> {
    let mut packet = vec![0u8; 0x2c];
    packet[0..10].copy_from_slice(DJLINK_MAGIC);
    packet[10] = STATUS_TYPE_LOAD_ACK;
    packet[0x0b..0x1f].copy_from_slice(&cstr_padded_ascii(model, 20));
    packet[0x1f] = 0x01;
    packet[0x22..0x24].copy_from_slice(&0x0008u16.to_be_bytes());
    packet[0x24..0x28].copy_from_slice(&first_id.to_be_bytes());
    packet[0x28..0x2c].copy_from_slice(&second_id.to_be_bytes());
    packet
}

fn spawn_keepalive_rx(
    state: Arc<ServerState>,
    sock: Arc<UdpSocket>,
    status_sock: Arc<UdpSocket>,
) -> TokioJoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = [0u8; 1024];
        loop {
            let Ok((len, addr)) = sock.recv_from(&mut buf).await else {
                continue;
            };
            let SocketAddr::V4(addr) = addr else {
                continue;
            };
            let src_ip = *addr.ip();
            if src_ip == state.bind_ip {
                continue;
            }
            let packet = &buf[..len];
            if let Some(frame_type) = keepalive_frame_type(packet) {
                if frame_type == KeepaliveKind::CompatibilityRequest {
                    let reply = build_keepalive_compat_response_packet(&state.config.model_name);
                    let _ = send_udp_packet(
                        &state,
                        &sock,
                        &reply,
                        SocketAddrV4::new(src_ip, KEEPALIVE_PORT),
                        "keepalive compat reply",
                    )
                    .await;
                } else if matches!(frame_type, KeepaliveKind::IdUse | KeepaliveKind::IdSet) {
                    let reply = build_keepalive_id_use_response_packet(
                        &state.config.model_name,
                        frame_type,
                    );
                    let _ = send_udp_packet(
                        &state,
                        &sock,
                        &reply,
                        SocketAddrV4::new(src_ip, KEEPALIVE_PORT),
                        "keepalive id-use reply",
                    )
                    .await;
                    let status = build_keepalive_status_packet(
                        &state.config.model_name,
                        state.config.player_number,
                        state.bind_ip,
                        &state.mac_addr,
                        state.device_count().await,
                    );
                    let _ = send_udp_packet(
                        &state,
                        &sock,
                        &status,
                        SocketAddrV4::new(src_ip, KEEPALIVE_PORT),
                        "keepalive status reply",
                    )
                    .await;
                }
            }
            let Some(mut dev) = parse_keepalive_device(packet) else {
                continue;
            };
            if dev.ip_addr == state.bind_ip {
                continue;
            }
            dev.last_seen = Instant::now();
            let is_new = state.record_device(dev.clone()).await;
            if is_new {
                tracing::info!(
                    player = dev.player_number,
                    ip = %dev.ip_addr,
                    model = %dev.model,
                    "device_found"
                );
                send_link_init_once(&state, &status_sock, dev.ip_addr, "status link-init").await;
                let _ = send_load_settings_packet(
                    &state,
                    &status_sock,
                    dev.player_number,
                    dev.ip_addr,
                    "load-settings on device discovery",
                )
                .await;
            }
        }
    })
}

fn spawn_announce(state: Arc<ServerState>, sock: Arc<UdpSocket>) -> TokioJoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(state.config.announce_interval);
        loop {
            interval.tick().await;
            let packet = build_keepalive_status_packet(
                &state.config.model_name,
                state.config.player_number,
                state.bind_ip,
                &state.mac_addr,
                state.device_count().await,
            );
            let target = SocketAddrV4::new(state.broadcast_ip, KEEPALIVE_PORT);
            if let Err(err) =
                send_udp_packet(&state, &sock, &packet, target, "keepalive announce").await
            {
                debug!(target: "djtools_link::udp", %target, %err, "keepalive_announce_failed");
            }
        }
    })
}

fn spawn_link_init(state: Arc<ServerState>, sock: Arc<UdpSocket>) -> TokioJoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(FAST_LINK_INIT_INTERVAL);
        loop {
            interval.tick().await;
            let (targets, should_broadcast) = state.unlinked_targets().await;
            if should_broadcast {
                send_link_init_broadcast(&state, &sock, "status link-init discovery").await;
            }
            for ip in targets {
                send_link_init_once(&state, &sock, ip, "status link-init retry").await;
            }
        }
    })
}

fn spawn_mixer_status(state: Arc<ServerState>, sock: Arc<UdpSocket>) -> TokioJoinHandle<()> {
    tokio::spawn(async move {
        let packet =
            build_status_mixer_status(&state.config.model_name, state.config.player_number);
        let mut interval = tokio::time::interval(Duration::from_millis(100));
        loop {
            interval.tick().await;
            let target = SocketAddrV4::new(state.broadcast_ip, STATUS_PORT);
            if let Err(err) = send_udp_packet(&state, &sock, &packet, target, "mixer status").await
            {
                debug!(target: "djtools_link::udp", %target, %err, "mixer_status_send_failed");
            }
        }
    })
}

async fn load_settings_target_for_db_peer(
    state: &ServerState,
    addr: SocketAddr,
) -> Option<(u8, Ipv4Addr)> {
    let SocketAddr::V4(addr) = addr else {
        return None;
    };
    let ip = *addr.ip();
    state.player_for_ip(ip).await
}

async fn maybe_send_db_auto_load(
    state: &Arc<ServerState>,
    sock: Option<&Arc<UdpSocket>>,
    addr: SocketAddr,
    request_type: u16,
    args: &[DbValue],
) {
    let Some(sock) = sock else {
        return;
    };
    let Some((target_player, target_ip)) = load_settings_target_for_db_peer(state, addr).await
    else {
        return;
    };
    let Some(track_id) = track_id_from_request_args(&state.library, args) else {
        trace!(
            target: "djtools_link::db",
            %addr,
            request = db_request_name(request_type),
            args = %db_args_summary(args),
            "db_auto_load_skip_no_track_id"
        );
        return;
    };
    if !should_db_auto_load(state, target_player, target_ip, track_id, request_type).await {
        return;
    }
    let should_send = state
        .actor_reply(|reply| ServerMsg::ShouldSendDbAutoLoad {
            target_ip,
            track_id,
            request_type,
            throttle: DB_AUTO_LOAD_THROTTLE,
            now: Instant::now(),
            reply,
        })
        .await
        .unwrap_or(false);
    if !should_send {
        return;
    }

    let state = state.clone();
    let sock = sock.clone();
    tokio::spawn(async move {
        let request_name = db_request_name(request_type);
        if track_is_loaded_on_player(&state, target_player, track_id).await {
            tracing::debug!(
                target: "djtools_link::load",
                target_player,
                %target_ip,
                track_id,
                request = %request_name,
                "db_auto_load_skipped_already_loaded"
            );
            return;
        }
        let first_acked = send_db_auto_load_once(
            &state,
            &sock,
            target_player,
            target_ip,
            track_id,
            &request_name,
            "db auto load-track command",
            &[],
        )
        .await;
        if wait_for_track_loaded(
            &state,
            target_player,
            track_id,
            DB_AUTO_LOAD_FIRST_CONFIRM_TIMEOUT,
        )
        .await
        {
            tracing::info!(
                target: "djtools_link::load",
                target_player,
                %target_ip,
                track_id,
                request = %request_name,
                "db_auto_load_confirmed"
            );
            return;
        }
        let artist_context = artist_load_context_for_track(&state, track_id)
            .unwrap_or_else(|| LoadConfirmContext::new(LOAD_CONTEXT_ARTIST_MENU));
        let artist_overrides = artist_context.payload_overrides();
        let fallback_acked = send_db_auto_load_once(
            &state,
            &sock,
            target_player,
            target_ip,
            track_id,
            &request_name,
            "db auto load-track artist-context fallback",
            &artist_overrides,
        )
        .await;
        if wait_for_track_loaded(
            &state,
            target_player,
            track_id,
            DB_AUTO_LOAD_RETRY_CONFIRM_TIMEOUT,
        )
        .await
        {
            tracing::info!(
                target: "djtools_link::load",
                target_player,
                %target_ip,
                track_id,
                request = %request_name,
                first_acked,
                fallback_acked,
                "db_auto_load_confirmed_after_artist_fallback"
            );
            return;
        }
        tracing::warn!(
            target: "djtools_link::load",
            target_player,
            %target_ip,
            track_id,
            request = %request_name,
            first_acked,
            fallback_acked,
            "db_auto_load_not_confirmed_after_artist_fallback"
        );
    });
}

async fn maybe_send_mount_info_load_confirm(
    state: &Arc<ServerState>,
    sock: Option<&Arc<UdpSocket>>,
    addr: SocketAddr,
    args: &[DbValue],
) {
    let Some(sock) = sock else {
        return;
    };
    let Some((target_player, target_ip)) = load_settings_target_for_db_peer(state, addr).await
    else {
        return;
    };
    let Some(track_id) = track_id_from_request_args(&state.library, args) else {
        return;
    };
    if !should_mount_info_load_confirm(state, target_player, track_id) {
        return;
    }
    let context = rmst_menu_from_args(args)
        .filter(|context| load_confirm_context_is_browse(*context))
        .map(LoadConfirmContext::new)
        .or_else(|| artist_load_context_for_track(state, track_id))
        .unwrap_or_else(|| LoadConfirmContext::new(LOAD_CONTEXT_ARTIST_MENU));
    let request_name = db_request_name(DB_REQ_MOUNT_INFO);
    let _ = send_mount_info_load_confirm_once(
        state,
        sock,
        target_player,
        target_ip,
        track_id,
        1,
        &request_name,
        &context,
    )
    .await;
}

async fn send_db_auto_load_once(
    state: &ServerState,
    sock: &UdpSocket,
    target_player: u8,
    target_ip: Ipv4Addr,
    track_id: u32,
    request_name: &str,
    context: &str,
    payload_extra_overrides: &[(usize, u8)],
) -> bool {
    let packet = build_load_confirm_packet(state, target_player, track_id, payload_extra_overrides);
    let context_byte = packet[0x1f + 0x14];
    let context_category_1 = u32::from_be_bytes([
        packet[0x1f + LOAD_CONTEXT_CATEGORY_1_OFFSET],
        packet[0x1f + LOAD_CONTEXT_CATEGORY_1_OFFSET + 1],
        packet[0x1f + LOAD_CONTEXT_CATEGORY_1_OFFSET + 2],
        packet[0x1f + LOAD_CONTEXT_CATEGORY_1_OFFSET + 3],
    ]);
    let context_category_2 = u32::from_be_bytes([
        packet[0x1f + LOAD_CONTEXT_CATEGORY_2_OFFSET],
        packet[0x1f + LOAD_CONTEXT_CATEGORY_2_OFFSET + 1],
        packet[0x1f + LOAD_CONTEXT_CATEGORY_2_OFFSET + 2],
        packet[0x1f + LOAD_CONTEXT_CATEGORY_2_OFFSET + 3],
    ]);
    let context_menu_count = u16::from_be_bytes([
        packet[0x1f + LOAD_CONTEXT_MENU_COUNT_OFFSET],
        packet[0x1f + LOAD_CONTEXT_MENU_COUNT_OFFSET + 1],
    ]);
    let sent_at = Instant::now();
    match send_udp_packet(
        state,
        sock,
        &packet,
        SocketAddrV4::new(target_ip, STATUS_PORT),
        context,
    )
    .await
    {
        Ok(_) => {
            let acked =
                wait_for_load_ack_after(state, target_ip, sent_at, DB_AUTO_LOAD_ACK_TIMEOUT).await;
            if acked {
                tracing::info!(
                    target: "djtools_link::load",
                    target_player,
                    %target_ip,
                    track_id,
                    request = request_name,
                    context,
                    context_byte,
                    context_label = cdj_source_menu_label(context_byte),
                    context_category_1,
                    context_category_2,
                    context_menu_count,
                    "db_auto_load_sent"
                );
            } else {
                tracing::warn!(
                    target: "djtools_link::load",
                    target_player,
                    %target_ip,
                    track_id,
                    request = request_name,
                    context,
                    context_byte,
                    context_label = cdj_source_menu_label(context_byte),
                    context_category_1,
                    context_category_2,
                    context_menu_count,
                    "db_auto_load_sent_without_ack"
                );
            }
            acked
        }
        Err(err) => {
            tracing::warn!(
                target: "djtools_link::load",
                target_player,
                %target_ip,
                track_id,
                context,
                %err,
                "db_auto_load_send_failed"
            );
            false
        }
    }
}

async fn send_mount_info_load_confirm_once(
    state: &ServerState,
    sock: &UdpSocket,
    target_player: u8,
    target_ip: Ipv4Addr,
    track_id: u32,
    attempt: usize,
    request_name: &str,
    context: &LoadConfirmContext,
) -> bool {
    let context_label = format!(
        "mount-info load confirm {}-context",
        cdj_source_menu_label(context.source_menu)
    );
    let context_overrides = context.payload_overrides();
    let packet = build_load_confirm_packet(state, target_player, track_id, &context_overrides);
    let context_byte = packet[0x1f + LOAD_CONTEXT_OFFSET];
    let context_category_1 = u32::from_be_bytes([
        packet[0x1f + LOAD_CONTEXT_CATEGORY_1_OFFSET],
        packet[0x1f + LOAD_CONTEXT_CATEGORY_1_OFFSET + 1],
        packet[0x1f + LOAD_CONTEXT_CATEGORY_1_OFFSET + 2],
        packet[0x1f + LOAD_CONTEXT_CATEGORY_1_OFFSET + 3],
    ]);
    let context_category_2 = u32::from_be_bytes([
        packet[0x1f + LOAD_CONTEXT_CATEGORY_2_OFFSET],
        packet[0x1f + LOAD_CONTEXT_CATEGORY_2_OFFSET + 1],
        packet[0x1f + LOAD_CONTEXT_CATEGORY_2_OFFSET + 2],
        packet[0x1f + LOAD_CONTEXT_CATEGORY_2_OFFSET + 3],
    ]);
    let context_menu_count = u16::from_be_bytes([
        packet[0x1f + LOAD_CONTEXT_MENU_COUNT_OFFSET],
        packet[0x1f + LOAD_CONTEXT_MENU_COUNT_OFFSET + 1],
    ]);
    match send_udp_packet(
        state,
        sock,
        &packet,
        SocketAddrV4::new(target_ip, STATUS_PORT),
        &context_label,
    )
    .await
    {
        Ok(_) => {
            tracing::trace!(
                target: "djtools_link::load",
                target_player,
                %target_ip,
                track_id,
                attempt,
                request = request_name,
                context_byte,
                context_category_1,
                context_category_2,
                context_menu_count,
                "mount_info_load_confirm_sent"
            );
            if attempt == 1 {
                tracing::debug!(
                    target: "djtools_link::load",
                    target_player,
                    %target_ip,
                    track_id,
                    attempt,
                    request = request_name,
                    context_byte,
                    context_label = cdj_source_menu_label(context_byte),
                    context_category_1,
                    context_category_2,
                    context_menu_count,
                    "mount_info_load_confirm_sent_first"
                );
            }
            true
        }
        Err(err) => {
            tracing::warn!(
                target: "djtools_link::load",
                target_player,
                %target_ip,
                track_id,
                attempt,
                context = %context_label,
                %err,
                "mount_info_load_confirm_send_failed"
            );
            false
        }
    }
}

fn build_load_confirm_packet(
    state: &ServerState,
    target_player: u8,
    track_id: u32,
    payload_extra_overrides: &[(usize, u8)],
) -> Vec<u8> {
    let payload_overrides =
        load_payload_overrides_for_track_with_extra(state, track_id, payload_extra_overrides);
    build_status_load_track_command(
        &state.config.model_name,
        state.config.player_number,
        target_player,
        state.config.player_number,
        SLOT_REKORDBOX,
        TRACK_TYPE_REKORDBOX,
        track_id,
        state.config.load_rekordbox_command_variant,
        &payload_overrides,
    )
}

async fn should_db_auto_load(
    state: &ServerState,
    target_player: u8,
    _target_ip: Ipv4Addr,
    track_id: u32,
    _request_type: u16,
) -> bool {
    if !state.config.db_auto_load || !(1..=6).contains(&target_player) {
        return false;
    }
    if !state.library.tracks_by_id.contains_key(&track_id) {
        return false;
    }
    !track_is_loaded_on_player(state, target_player, track_id).await
}

fn should_mount_info_load_confirm(state: &ServerState, target_player: u8, track_id: u32) -> bool {
    state.config.auto_load_confirm
        && (1..=6).contains(&target_player)
        && state.library.tracks_by_id.contains_key(&track_id)
}

async fn track_is_loaded_on_player(state: &ServerState, target_player: u8, track_id: u32) -> bool {
    player_status_snapshot(state, target_player)
        .await
        .as_ref()
        .is_some_and(|status| status_matches_track(state, status, track_id))
}

async fn track_is_playing_on_player(state: &ServerState, target_player: u8, track_id: u32) -> bool {
    let now = Instant::now();
    let status = player_status_snapshot(state, target_player).await;
    let recent_previous_audio =
        player_has_recent_previous_audio_read(state, target_player, track_id, now).await;
    status.as_ref().is_some_and(|status| {
        status_matches_track(state, status, track_id)
            && status_is_playing(status)
            && !recent_previous_audio
    })
}

async fn player_has_recent_previous_audio_read(
    state: &ServerState,
    target_player: u8,
    track_id: u32,
    now: Instant,
) -> bool {
    state
        .recent_previous_audio_read(target_player, track_id, now)
        .await
        .is_some()
}

async fn note_load_progress(
    state: &ServerState,
    sock: Option<&Arc<UdpSocket>>,
    addr: SocketAddr,
    track_id: Option<u32>,
    context: &'static str,
) {
    note_load_progress_with_logging(state, sock, addr, track_id, context, true).await;
}

async fn note_load_progress_with_logging(
    state: &ServerState,
    sock: Option<&Arc<UdpSocket>>,
    addr: SocketAddr,
    track_id: Option<u32>,
    context: &'static str,
    emit_log: bool,
) {
    let Some(track_id) = track_id else {
        return;
    };
    if !state.library.tracks_by_id.contains_key(&track_id) {
        return;
    }
    let Some((target_player, _)) = load_settings_target_for_db_peer(state, addr).await else {
        return;
    };
    match state
        .record_load_progress(target_player, track_id, context)
        .await
    {
        Some(LoadProgressRecordResult::Kept { previous_context }) if emit_log => tracing::trace!(
            target: "djtools_link::load",
            %addr,
            target_player,
            track_id,
            kept_context = previous_context,
            ignored_context = context,
            "load_progress_kept_visual_context"
        ),
        Some(LoadProgressRecordResult::Recorded) if emit_log => tracing::trace!(
            target: "djtools_link::load",
            %addr,
            target_player,
            track_id,
            context,
            "load_progress"
        ),
        _ => {}
    }
    maybe_send_progress_load_confirm(state, sock, addr, target_player, track_id, context).await;
}

async fn maybe_send_progress_load_confirm(
    state: &ServerState,
    sock: Option<&Arc<UdpSocket>>,
    addr: SocketAddr,
    target_player: u8,
    track_id: u32,
    progress_context: &'static str,
) {
    if !should_mount_info_load_confirm(state, target_player, track_id) {
        return;
    }
    let Some(sock) = sock else {
        return;
    };
    if progress_context == "nfs-audio" {
        return;
    }
    let Some((_, target_ip)) = load_settings_target_for_db_peer(state, addr).await else {
        return;
    };
    let context = artist_load_context_for_track(state, track_id)
        .unwrap_or_else(|| LoadConfirmContext::new(LOAD_CONTEXT_ARTIST_MENU));
    let request_name = db_request_name(DB_REQ_MOUNT_INFO);
    tracing::debug!(
        target: "djtools_link::load",
        target_player,
        %target_ip,
        track_id,
        progress_context,
        context = %context.summary(),
        "mount_info_load_confirm_followup_on_progress"
    );
    let _ = send_mount_info_load_confirm_once(
        state,
        sock,
        target_player,
        target_ip,
        track_id,
        2,
        &request_name,
        &context,
    )
    .await;
}

async fn player_status_snapshot(
    state: &ServerState,
    target_player: u8,
) -> Option<CdjStatusSnapshot> {
    state.status_snapshot(target_player).await
}

fn status_matches_track(state: &ServerState, status: &CdjStatusSnapshot, track_id: u32) -> bool {
    status.matches_track_from_source(state.config.player_number, track_id, TRACK_TYPE_REKORDBOX)
}

fn status_is_playing(status: &CdjStatusSnapshot) -> bool {
    status.is_playing()
}

fn load_confirm_context_is_browse(source_menu: u8) -> bool {
    matches!(
        source_menu,
        LOAD_CONTEXT_ARTIST_MENU
            | 0x03
            | 0x04
            | 0x05
            | 0x06
            | 0x0c
            | 0x11
            | 0x12
            | 0x16
            | 0x1f
            | 0x20
            | 0x28
    )
}

fn artist_load_context_for_track(state: &ServerState, track_id: u32) -> Option<LoadConfirmContext> {
    let track = state.library.tracks_by_id.get(&track_id)?;
    let mut count = 0u16;
    for candidate in &state.library.all_tracks {
        if !matches_filter_id(candidate.artist_id, track.artist_id) {
            continue;
        }
        count = count.saturating_add(1);
    }
    Some(LoadConfirmContext {
        source_menu: LOAD_CONTEXT_ARTIST_MENU,
        category_1: track.artist_id,
        category_2: u32::MAX,
        menu_count: count,
    })
}

fn load_payload_overrides_for_track(state: &ServerState, _track_id: u32) -> Vec<(usize, u8)> {
    state.config.load_payload_byte_overrides.clone()
}

fn load_payload_overrides_for_track_with_extra(
    state: &ServerState,
    track_id: u32,
    extra_overrides: &[(usize, u8)],
) -> Vec<(usize, u8)> {
    let mut overrides = load_payload_overrides_for_track(state, track_id);
    for (offset, byte) in extra_overrides {
        if !overrides.iter().any(|(existing, _)| existing == offset) {
            overrides.push((*offset, *byte));
        }
    }
    apply_payload_overrides(&mut overrides, &state.config.load_payload_byte_overrides);
    overrides
}

fn apply_payload_overrides(overrides: &mut Vec<(usize, u8)>, updates: &[(usize, u8)]) {
    for (offset, byte) in updates {
        match overrides
            .iter_mut()
            .find(|(existing, _)| existing == offset)
        {
            Some((_, existing_byte)) => *existing_byte = *byte,
            None => overrides.push((*offset, *byte)),
        }
    }
}

async fn wait_for_track_loaded(
    state: &ServerState,
    target_player: u8,
    track_id: u32,
    timeout: Duration,
) -> bool {
    wait_for_track_confirmation(state, target_player, track_id, false, timeout).await
}

async fn wait_for_track_confirmation(
    state: &ServerState,
    target_player: u8,
    track_id: u32,
    require_playing: bool,
    timeout: Duration,
) -> bool {
    let confirmed_now = if require_playing {
        track_is_playing_on_player(state, target_player, track_id).await
    } else {
        track_is_loaded_on_player(state, target_player, track_id).await
    };
    if confirmed_now {
        return true;
    }
    state
        .wait_status_track(
            target_player,
            state.config.player_number,
            track_id,
            TRACK_TYPE_REKORDBOX,
            require_playing,
            Instant::now(),
            timeout,
        )
        .await
}

fn spawn_beat_status(state: Arc<ServerState>, sock: Arc<UdpSocket>) -> TokioJoinHandle<()> {
    tokio::spawn(async move {
        let packet = build_status_beat_status(&state.config.model_name, state.config.player_number);
        let mut interval = tokio::time::interval(Duration::from_millis(500));
        loop {
            interval.tick().await;
            let target = SocketAddrV4::new(state.broadcast_ip, BEAT_PORT);
            if let Err(err) = send_udp_packet(&state, &sock, &packet, target, "beat status").await {
                debug!(target: "djtools_link::udp", %target, %err, "beat_status_send_failed");
            }
        }
    })
}

fn spawn_beat_rx(state: Arc<ServerState>, sock: Arc<UdpSocket>) -> TokioJoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        loop {
            let Ok((len, addr)) = sock.recv_from(&mut buf).await else {
                continue;
            };
            let SocketAddr::V4(addr) = addr else {
                continue;
            };
            if *addr.ip() == state.bind_ip {
                continue;
            }
            let packet = &buf[..len];
            if let Some(beat) = parse_cdj_beat(packet) {
                let changed = state.record_beat(beat.clone(), Instant::now()).await;
                if changed {
                    tracing::debug!(
                        target: "djtools_link::beat",
                        player = beat.player,
                        len = beat.len_rest,
                        next_beat_ms = beat.next_beat_ms,
                        second_beat_ms = beat.second_beat_ms,
                        next_bar_ms = beat.next_bar_ms,
                        fourth_beat_ms = beat.fourth_beat_ms,
                        second_bar_ms = beat.second_bar_ms,
                        eighth_beat_ms = beat.eighth_beat_ms,
                        pitch_percent = pitch_percent(beat.pitch),
                        bpm_hundreds = beat.bpm_hundreds,
                        effective_bpm_hundreds = ?effective_bpm_hundreds(beat.bpm_hundreds, beat.pitch),
                        beat_in_bar = beat.beat_in_bar,
                        "cdj_beat"
                    );
                }
                continue;
            }
            if let Some(position) = parse_cdj_position(packet) {
                let should_log = state.record_position(position.clone()).await;
                if should_log {
                    tracing::info!(
                        target: "djtools_link::beat",
                        player = position.player,
                        len = position.len_rest,
                        track_length_sec = position.track_length_sec,
                        playhead_ms = position.playhead_ms,
                        pitch_centi_percent = position.pitch_centi_percent,
                        effective_bpm_tenths = position.effective_bpm_tenths,
                        "cdj_position"
                    );
                }
                continue;
            }
            if let Some(fader) = parse_fader_start(packet) {
                tracing::debug!(
                    target: "djtools_link::beat",
                    player = fader.player,
                    len = fader.len_rest,
                    commands = ?fader.commands,
                    "fader_start"
                );
                continue;
            }
            if let Some(on_air) = parse_on_air(packet) {
                tracing::trace!(
                    target: "djtools_link::beat",
                    player = on_air.player,
                    subtype = on_air.subtype,
                    len = on_air.len_rest,
                    channels = ?on_air.channels,
                    "on_air"
                );
                continue;
            }
            if let Some(sync_control) = parse_sync_control(packet) {
                tracing::debug!(
                    target: "djtools_link::beat",
                    player = sync_control.player,
                    len = sync_control.len_rest,
                    player_marker = sync_control.player_marker,
                    command = sync_control.command,
                    command_label = SyncControlCommand::from_packet_byte(sync_control.command)
                        .map(SyncControlCommand::label)
                        .unwrap_or("unknown"),
                    "sync_control"
                );
                continue;
            }
            if let Some(handoff) = parse_master_handoff(packet) {
                tracing::debug!(
                    target: "djtools_link::beat",
                    response = handoff.response,
                    player = handoff.player,
                    len = handoff.len_rest,
                    player_marker = handoff.player_marker,
                    yielded = ?handoff.yielded,
                    "master_handoff"
                );
                continue;
            }
            log_unknown_dj_packet(&state, "beat", addr, packet).await;
        }
    })
}

fn spawn_status(state: Arc<ServerState>, sock: Arc<UdpSocket>) -> TokioJoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        loop {
            let Ok((len, addr)) = sock.recv_from(&mut buf).await else {
                continue;
            };
            let SocketAddr::V4(addr) = addr else {
                continue;
            };
            let ip = *addr.ip();
            if ip == state.bind_ip {
                continue;
            }
            let packet = &buf[..len];
            let status_header = status::decode_header(packet).ok();
            if let Some((remote_player, slot, _unknown)) = parse_status_link_query_detail(packet) {
                let reply = build_status_link_reply(
                    &state.config.model_name,
                    state.config.player_number,
                    slot,
                    &state.config.source_name,
                    state.library.track_count(),
                    state.library.playlist_count(),
                );
                let _ = send_udp_packet(
                    &state,
                    &sock,
                    &reply,
                    SocketAddrV4::new(ip, STATUS_PORT),
                    "status link reply",
                )
                .await;
                state.mark_linked(ip).await;
                tracing::debug!(
                    target: "djtools_link::status",
                    %ip,
                    remote_player,
                    slot,
                    "status_link_query"
                );
                continue;
            }
            if let Some(reply) = build_status_extension_reply(
                packet,
                &state.config.model_name,
                state.config.player_number,
            ) {
                let _ = send_udp_packet(
                    &state,
                    &sock,
                    &reply,
                    SocketAddrV4::new(ip, STATUS_PORT),
                    "status 0x47 reply",
                )
                .await;
                continue;
            }
            if packet.len() >= 36
                && matches!(
                    status_header.as_ref().map(|header| header.kind),
                    Some(status::StatusKind::SourceHello)
                )
            {
                let reply = build_status_rekordbox_reply(
                    &state.config.model_name,
                    state.config.player_number,
                    &state.config.source_name,
                );
                let _ = send_udp_packet(
                    &state,
                    &sock,
                    &reply,
                    SocketAddrV4::new(ip, STATUS_PORT),
                    "status rekordbox hello reply",
                )
                .await;
                send_link_init_once(&state, &sock, ip, "status link init after hello").await;
                continue;
            }
            if let Some(status) = parse_cdj_status(packet) {
                let should_log = state.record_status(status.clone()).await;
                if should_log {
                    tracing::info!(
                        target: "djtools_link::status",
                        player = status.player,
                        active = status.active,
                        source_player = status.source_player,
                        source_slot = status.source_slot,
                        track_type = status.track_type,
                        track_id = status.track_id,
                        track_position = status.track_position,
                        sort_state = status.sort_state,
                        source_menu = status.source_menu,
                        source_menu_label = cdj_source_menu_label(status.source_menu),
                        source_category_1 = status.source_category_1,
                        source_category_2 = status.source_category_2,
                        menu_track_count = status.menu_track_count,
                        flags = status.flags,
                        flags_label = cdj_status_flags_label(status.flags),
                        play_state_1 = status.play_state_1,
                        play_state_1_label = cdj_play_state_1_label(status.play_state_1),
                        play_state_2 = status.play_state_2,
                        play_state_2_label = cdj_play_state_2_label(status.play_state_2),
                        play_state_3 = status.play_state_3,
                        play_state_3_label = cdj_play_state_3_label(status.play_state_3),
                        pitch_percent = pitch_percent(status.pitch_1),
                        bpm_hundreds = status.bpm_hundreds,
                        effective_bpm_hundreds = ?effective_bpm_hundreds(status.bpm_hundreds, status.pitch_1),
                        beat_in_bar = status.beat_in_bar,
                        master = status.master_meaningful,
                        master_handoff = status.master_handoff,
                        master_tempo = ?status.master_tempo,
                        key = ?status.key,
                        key_shift_cents = ?status.key_shift_cents,
                        p4 = ?status.p4,
                        bar_steps = ?status.bar_steps,
                        bar_position = ?status.bar_position,
                        buffer_forward = ?status.buffer_forward,
                        buffer_back = ?status.buffer_back,
                        loop_start_raw = ?status.loop_start_raw,
                        loop_end_raw = ?status.loop_end_raw,
                        loop_beats = ?status.loop_beats,
                        "cdj_status"
                    );
                }
                continue;
            }
            if packet.len() >= 0x22
                && &packet[..10] == DJLINK_MAGIC
                && packet[10] == STATUS_TYPE_LOAD_ACK
            {
                let now = Instant::now();
                let should_log = state
                    .actor_reply(|reply| ServerMsg::RecordLoadAck {
                        ip,
                        now,
                        log_throttle: LOAD_ACK_LOG_THROTTLE,
                        reply,
                    })
                    .await
                    .unwrap_or(false);
                if should_log {
                    tracing::debug!(
                        target: "djtools_link::load",
                        %ip,
                        "load_track_ack"
                    );
                }
                continue;
            }
            log_unknown_dj_packet(&state, "status", addr, packet).await;
        }
    })
}

fn build_status_extension_reply(request: &[u8], model: &str, player_number: u8) -> Option<Vec<u8>> {
    matches!(
        status::decode_header(request).ok()?.kind,
        status::StatusKind::Extension46
    )
    .then(|| build_status_mystery_47(model, player_number))
}

async fn log_unknown_dj_packet(
    state: &ServerState,
    channel: &str,
    addr: SocketAddrV4,
    packet: &[u8],
) {
    if packet.len() < 11 || &packet[..10] != DJLINK_MAGIC {
        return;
    }
    let packet_type = packet[10];
    let player = packet.get(0x21).copied().unwrap_or(0);
    let key = format!("{channel}:0x{packet_type:02x}:{}:{player}", packet.len());
    let first_seen = state
        .actor_reply(|reply| ServerMsg::LogUnknownPacketOnce { key, reply })
        .await
        .unwrap_or(false);
    if first_seen {
        tracing::trace!(
            target: "djtools_link::protocol",
            channel,
            %addr,
            packet_type,
            len = packet.len(),
            player,
            prefix = %hex_prefix(packet, 64),
            "unknown_dj_packet"
        );
    }
}

fn spawn_db_query(state: Arc<ServerState>, listener: TcpListener) -> TokioJoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let Ok((stream, addr)) = listener.accept().await else {
                continue;
            };
            let state = state.clone();
            tokio::spawn(handle_db_query_conn(state, stream, addr));
        }
    })
}

async fn handle_db_query_conn(state: Arc<ServerState>, mut stream: TcpStream, addr: SocketAddr) {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 128];
    while buf.len() < 64 {
        let Ok(Ok(n)) = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut tmp)).await
        else {
            return;
        };
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
        if buf
            .windows(b"RemoteDBServer".len())
            .any(|w| w == b"RemoteDBServer")
        {
            break;
        }
    }
    if !buf
        .windows(b"RemoteDBServer".len())
        .any(|w| w == b"RemoteDBServer")
    {
        return;
    }
    let ip = match addr {
        SocketAddr::V4(addr) => *addr.ip(),
        SocketAddr::V6(_) => return,
    };
    let (count, port) = db_query_response_port(&state, ip).await;
    tracing::debug!(
        target: "djtools_link::db",
        %ip,
        count,
        port,
        "remote_db_query"
    );
    let _ = stream.write_all(&port.to_be_bytes()).await;
}

async fn db_query_response_port(state: &ServerState, ip: Ipv4Addr) -> (u32, u16) {
    state.next_db_query_response(ip).await
}

fn spawn_db_server(
    state: Arc<ServerState>,
    listener: TcpListener,
    status_sock: Arc<UdpSocket>,
) -> TokioJoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let Ok((stream, addr)) = listener.accept().await else {
                continue;
            };
            tracing::info!(target: "djtools_link::db", %addr, "db_client_connected");
            let state = state.clone();
            let status_sock = status_sock.clone();
            tokio::spawn(handle_db_client(state, stream, addr, Some(status_sock)));
        }
    })
}

async fn write_db_response(stream: &mut TcpStream, response: &[u8]) -> io::Result<()> {
    stream.write_all(response).await?;
    stream.flush().await
}

async fn handle_db_client(
    state: Arc<ServerState>,
    mut stream: TcpStream,
    addr: SocketAddr,
    status_sock: Option<Arc<UdpSocket>>,
) {
    let SocketAddr::V4(_) = addr else {
        return;
    };
    if let Err(err) = stream.set_nodelay(true) {
        warn!(target: "djtools_link::db", %addr, %err, "db_tcp_nodelay_failed");
    }
    let mut pending = PendingRenderSession::default();
    if matches!(recv_db_field(&mut stream).await, Ok(DbValue::Int32(_))) {
        let response = encode_db_field(&DbValue::Int32(1));
        if let Err(err) = write_db_response(&mut stream, &response).await {
            warn!(
                target: "djtools_link::db",
                %addr,
                %err,
                "db_context_response_failed"
            );
            return;
        }
    }

    loop {
        let msg = match recv_db_message(&mut stream).await {
            Ok(msg) => msg,
            Err(err) => {
                trace!(target: "djtools_link::db", %addr, %err, "db_client_closed");
                return;
            }
        };
        let tx = msg.tx_id;
        let request_started = Instant::now();
        let request_name = db_request_name(msg.msg_type);
        let request_args = db_args_summary(&msg.args);
        macro_rules! send_response {
            ($response:expr) => {{
                let response = $response;
                let response_bytes = response.len();
                if let Err(err) = write_db_response(&mut stream, &response).await {
                    warn!(
                        target: "djtools_link::db",
                        %addr,
                        tx,
                        request = request_name,
                        response_bytes,
                        %err,
                        "db_response_failed"
                    );
                    return;
                }
                trace!(
                    target: "djtools_link::db",
                    %addr,
                    tx,
                    request = request_name,
                    response_bytes,
                    "db_response_written"
                );
            }};
        }
        trace!(
            target: "djtools_link::db",
            %addr,
            tx,
            request = request_name,
            request_type = format_args!("0x{:04x}", msg.msg_type),
            args = %request_args,
            "db_request_start"
        );
        match msg.msg_type {
            0x0001 | DB_REQ_TEARDOWN => {
                trace!(
                    target: "djtools_link::db",
                    %addr,
                    tx,
                    request = request_name,
                    "db_client_teardown"
                );
                return;
            }
            DB_REQ_SETUP => {
                let reply = encode_db_message(
                    tx,
                    DB_REQ_SETUP,
                    &[
                        DbValue::Int32(state.config.player_number as u32),
                        DbValue::Int32(0x14),
                    ],
                );
                send_response!(reply);
            }
            DB_REQ_INTRODUCE => {
                send_response!(success_with_count(tx, msg.msg_type, 0));
            }
            DB_REQ_ROOT_MENU => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    root_menu_entries(),
                )
                .await;
            }
            DB_REQ_SORT_MENU => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    sort_menu_entries(),
                )
                .await;
            }
            DB_REQ_TITLE => {
                write_pending_browse_success(
                    &state,
                    addr,
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    title_entries_for_request(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_ARTIST => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    artist_entries(&state.library),
                )
                .await;
            }
            DB_REQ_ARTISTS_FOR_GENRE => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    artists_for_genre_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_ALBUM => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    album_entries(&state.library),
                )
                .await;
            }
            DB_REQ_GENRE => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    genre_entries(&state.library),
                )
                .await;
            }
            DB_REQ_BPM_MENU => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    bpm_entries(&state.library),
                )
                .await;
            }
            DB_REQ_RATING_MENU => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    rating_entries(),
                )
                .await;
            }
            DB_REQ_YEAR_MENU => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    decade_entries(&state.library),
                )
                .await;
            }
            DB_REQ_LABEL_MENU => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    label_entries(&state.library),
                )
                .await;
            }
            DB_REQ_COLOR_MENU => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    color_entries(&state.library),
                )
                .await;
            }
            DB_REQ_TIME_MENU => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    time_entries(&state.library),
                )
                .await;
            }
            DB_REQ_BITRATE => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    bitrate_entries(&state.library),
                )
                .await;
            }
            DB_REQ_HISTORY_MENU => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    history_entries(),
                )
                .await;
            }
            DB_REQ_DATE_ADDED_MENU => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    date_added_entries(&state.library),
                )
                .await;
            }
            DB_REQ_FILENAME_MENU => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    filename_entries(&state.library),
                )
                .await;
            }
            DB_REQ_KEY_MENU => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    key_entries(&state.library),
                )
                .await;
            }
            DB_REQ_BPM_RANGE => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    bpm_range_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_TRACKS_FOR_RATING => {
                write_pending_browse_success(
                    &state,
                    addr,
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    tracks_for_rating_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_YEARS_FOR_DECADE => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    years_for_decade_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_ARTISTS_FOR_LABEL => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    artists_for_label_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_TRACKS_FOR_COLOR => {
                write_pending_browse_success(
                    &state,
                    addr,
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    tracks_for_color_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_TRACKS_FOR_TIME => {
                write_pending_browse_success(
                    &state,
                    addr,
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    tracks_for_time_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_TRACKS_FOR_BITRATE => {
                write_pending_browse_success(
                    &state,
                    addr,
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    tracks_for_bitrate_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_TRACKS_FOR_HISTORY => {
                write_pending_browse_success(
                    &state,
                    addr,
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    Vec::new(),
                )
                .await;
            }
            DB_REQ_KEY_NEIGHBOR => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    key_neighbor_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_TRACKS_FOR_KEY_DISTANCE => {
                write_pending_browse_success(
                    &state,
                    addr,
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    tracks_for_key_distance_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_ALBUMS_FOR_ARTIST => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    albums_for_artist_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_TRACKS_FOR_ALBUM => {
                write_pending_browse_success(
                    &state,
                    addr,
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    tracks_for_album_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_ALBUMS_FOR_GENRE_ARTIST => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    albums_for_genre_artist_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_TRACKS_FOR_ARTIST_ALBUM => {
                write_pending_browse_success(
                    &state,
                    addr,
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    tracks_for_artist_album_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_TRACKS_FOR_BPM_DISTANCE => {
                write_pending_browse_success(
                    &state,
                    addr,
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    tracks_for_bpm_distance_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_TRACKS_FOR_DECADE_YEAR => {
                write_pending_browse_success(
                    &state,
                    addr,
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    tracks_for_decade_year_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_ALBUMS_FOR_LABEL_ARTIST => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    albums_for_label_artist_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_PLAYLIST => {
                write_pending_browse_success(
                    &state,
                    addr,
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    playlist_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_SEARCH => {
                let entries =
                    search_entries_indexed(&state.library, &state.search_index, &msg.args);
                let search_query = search_query_from_args(&msg.args).unwrap_or_default();
                let normalized_query = normalize_search_text(&search_query);
                let search_sort = search_sort_from_args(&msg.args);
                let search_menu = rmst_menu_from_args(&msg.args).unwrap_or(0);
                tracing::info!(
                    target: "djtools_link::db",
                    %addr,
                    tx,
                    query = %search_query,
                    normalized = %normalized_query,
                    sort = %sort_label(search_sort),
                    menu = %cdj_source_menu_label(search_menu),
                    results = entries.len(),
                    args = %request_args,
                    "db_search"
                );
                write_pending_browse_success(
                    &state,
                    addr,
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    entries,
                )
                .await;
            }
            DB_REQ_TRACKS_FOR_GENRE_ARTIST_ALBUM => {
                write_pending_browse_success(
                    &state,
                    addr,
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    tracks_for_genre_artist_album_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_TRACKS_FOR_DATE_ADDED => {
                write_pending_browse_success(
                    &state,
                    addr,
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    tracks_for_date_added_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_ORIGINAL_ARTIST_MENU
            | DB_REQ_ALBUMS_FOR_ORIGINAL_ARTIST
            | DB_REQ_TRACKS_FOR_ORIGINAL_ARTIST_ALBUM
            | DB_REQ_REMIXER_MENU
            | DB_REQ_ALBUMS_FOR_REMIXER
            | DB_REQ_TRACKS_FOR_REMIXER_ALBUM
            | DB_REQ_HOT_CUE_BANK
            | DB_REQ_FOLDER_MENU => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    Vec::new(),
                )
                .await;
            }
            DB_REQ_TRACKS_FOR_LABEL_ARTIST_ALBUM => {
                write_pending_browse_success(
                    &state,
                    addr,
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    tracks_for_label_artist_album_entries(&state.library, &msg.args),
                )
                .await;
            }
            DB_REQ_METADATA | DB_REQ_TRACK_INFO => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    metadata_entries(&state.library, &msg.args),
                )
                .await;
                maybe_send_db_auto_load(
                    &state,
                    status_sock.as_ref(),
                    addr,
                    msg.msg_type,
                    &msg.args,
                )
                .await;
            }
            DB_REQ_MOUNT_INFO => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    mount_info_entries(&state.library, &msg.args),
                )
                .await;
                maybe_send_mount_info_load_confirm(&state, status_sock.as_ref(), addr, &msg.args)
                    .await;
            }
            DB_REQ_ARTWORK => {
                let blob = load_artwork(&state, &msg.args).await;
                send_response!(blob_response(
                    tx,
                    msg.msg_type,
                    DB_RES_ARTWORK,
                    blob.as_deref(),
                ));
            }
            DB_REQ_WAVEFORM_PREVIEW => {
                let track_id = track_id_from_request_at(&state.library, &msg.args, 1);
                let blob = load_cached_waveform_preview(&state, &msg.args).await;
                if blob.as_ref().is_some_and(|blob| !blob.is_empty()) {
                    note_load_progress(
                        &state,
                        status_sock.as_ref(),
                        addr,
                        track_id,
                        "waveform-preview",
                    )
                    .await;
                }
                trace!(
                    target: "djtools_link::db",
                    %addr,
                    tx,
                    track_id,
                    bytes = blob.as_ref().map_or(0, Vec::len),
                    args = %db_args_summary(&msg.args),
                    "db_waveform_preview"
                );
                send_response!(blob_response(
                    tx,
                    msg.msg_type,
                    DB_RES_WAVEFORM_PREVIEW,
                    blob.as_deref(),
                ));
            }
            DB_REQ_WAVEFORM_PREVIEW_UPLOAD => {
                if let Some((track_id, preview)) =
                    waveform_preview_upload(&state.library, &msg.args)
                {
                    let bytes = preview.len();
                    state.store_waveform_preview(track_id, preview).await;
                    trace!(
                        target: "djtools_link::db",
                        %addr,
                        tx,
                        track_id,
                        bytes,
                        "db_waveform_preview_cached_from_deck"
                    );
                }
                send_response!(success_with_count(tx, msg.msg_type, 0));
            }
            DB_REQ_EXT_2705 => {
                trace!(
                    target: "djtools_link::db",
                    %addr,
                    tx,
                    args = msg.args.len(),
                    "db_extension_2705_ack"
                );
                send_response!(success_with_count(tx, msg.msg_type, 0));
            }
            DB_REQ_EXT_3001 => {
                trace!(
                    target: "djtools_link::db",
                    %addr,
                    tx,
                    args = msg.args.len(),
                    "db_extension_3001_ack"
                );
                send_response!(success_with_count(tx, msg.msg_type, 0));
            }
            DB_REQ_WAVEFORM_DETAIL => {
                let track_id = track_id_from_request_at(&state.library, &msg.args, 0);
                let blob = load_waveform_detail(&state.library, &msg.args).await;
                if blob.as_ref().is_some_and(|blob| !blob.is_empty()) {
                    note_load_progress(
                        &state,
                        status_sock.as_ref(),
                        addr,
                        track_id,
                        "waveform-detail",
                    )
                    .await;
                }
                trace!(
                    target: "djtools_link::db",
                    %addr,
                    tx,
                    track_id,
                    bytes = blob.as_ref().map_or(0, Vec::len),
                    args = %db_args_summary(&msg.args),
                    "db_waveform_detail"
                );
                send_response!(blob_response(
                    tx,
                    msg.msg_type,
                    DB_RES_WAVEFORM_DETAIL,
                    blob.as_deref(),
                ));
            }
            DB_REQ_BEAT_GRID => {
                let track_id = track_id_from_request_at(&state.library, &msg.args, 0);
                let blob = load_beat_grid(&state.library, &msg.args).await;
                if blob.as_ref().is_some_and(|blob| !blob.is_empty()) {
                    note_load_progress(&state, status_sock.as_ref(), addr, track_id, "beat-grid")
                        .await;
                }
                trace!(
                    target: "djtools_link::db",
                    %addr,
                    tx,
                    track_id,
                    bytes = blob.as_ref().map_or(0, Vec::len),
                    args = %db_args_summary(&msg.args),
                    "db_beat_grid"
                );
                send_response!(blob_response(
                    tx,
                    msg.msg_type,
                    DB_RES_BEAT_GRID,
                    blob.as_deref(),
                ));
            }
            DB_REQ_CUE_POINTS => {
                let cues = load_cue_points(&state.library, &msg.args)
                    .await
                    .unwrap_or_default();
                send_response!(cue_points_response(
                    tx,
                    msg.msg_type,
                    Some(cues.first.as_slice()),
                    Some(cues.second.as_slice()),
                    cues.hot_count,
                    cues.memory_count,
                ));
            }
            DB_REQ_CUE_POINTS_EXT => {
                let cues = load_cue_points_ext(&state.library, &msg.args)
                    .await
                    .unwrap_or_else(default_extended_cue_points);
                send_response!(cue_points_ext_response(
                    tx,
                    msg.msg_type,
                    cues.entries.as_slice(),
                    cues.entry_count,
                ));
            }
            DB_REQ_ANLZ_TAG | 0x2d04 => {
                let (track_id, tag_name, ext_name) = anlz_tag_request_summary(&msg.args);
                let blob = load_anlz_tag(
                    &state.library,
                    &msg.args,
                    state.config.serve_extended_anlz_tags,
                )
                .await;
                if blob.as_ref().is_some_and(|blob| !blob.is_empty()) {
                    note_load_progress(
                        &state,
                        status_sock.as_ref(),
                        addr,
                        track_id,
                        anlz_progress_context(&tag_name),
                    )
                    .await;
                }
                trace!(
                    target: "djtools_link::db",
                    %addr,
                    tx,
                    request = db_request_name(msg.msg_type),
                    track_id,
                    tag = %tag_name,
                    ext = %ext_name,
                    bytes = blob.as_ref().map_or(0, Vec::len),
                    serve_extended = state.config.serve_extended_anlz_tags,
                    args = %db_args_summary(&msg.args),
                    "db_anlz_tag"
                );
                send_response!(blob_response(
                    tx,
                    msg.msg_type,
                    DB_RES_ANLZ_TAG,
                    blob.as_deref(),
                ));
            }
            0x2504 => {
                let blob = load_vbr_payload(&state.library, &msg.args).await;
                send_response!(blob_response(
                    tx,
                    msg.msg_type,
                    DB_RES_EXT_2504,
                    blob.as_deref(),
                ));
            }
            0x3100 => {
                send_response!(success_with_count(tx, 0x3100, 0));
            }
            DB_REQ_RENDER => {
                let render_started = Instant::now();
                let window = parse_render_window(&msg.args);
                let render_key = pending_key_from_args(&msg.args);
                let prepared_key = pending.key();
                let pending_len = pending.len();
                let entries = pending.entries_for_render(render_key, window);
                let render_miss = entries.is_none();
                let end = window.offset.saturating_add(window.count).min(pending_len);
                let chunk = if let Some(entries) = entries {
                    if window.offset < pending_len {
                        &entries[window.offset..end]
                    } else {
                        &[]
                    }
                } else {
                    &[]
                };
                let reply = render_messages(tx, window.offset, chunk);
                let reply_bytes = reply.len();
                let rows = chunk.len();
                send_response!(reply);
                if render_miss {
                    trace!(
                        target: "djtools_link::db",
                        %addr,
                        tx,
                        offset = window.offset,
                        count = window.count,
                        total = window.total,
                        requested_key = render_key
                            .map(|key| format_args!("0x{key:08x}").to_string())
                            .unwrap_or_else(|| "none".to_string()),
                        prepared_key = prepared_key
                            .map(|key| format_args!("0x{key:08x}").to_string())
                            .unwrap_or_else(|| "none".to_string()),
                        prepared_rows = pending_len,
                        "db_render_miss"
                    );
                }
                trace!(
                    target: "djtools_link::db",
                    %addr,
                    tx,
                    offset = window.offset,
                    count = window.count,
                    total = window.total,
                    rows,
                    pending = pending_len,
                    requested_key = render_key
                        .map(|key| format_args!("0x{key:08x}").to_string())
                        .unwrap_or_else(|| "none".to_string()),
                    prepared_key = prepared_key
                        .map(|key| format_args!("0x{key:08x}").to_string())
                        .unwrap_or_else(|| "none".to_string()),
                    header_offset = window.offset,
                    bytes = reply_bytes,
                    elapsed_us = render_started.elapsed().as_micros(),
                    "db_render"
                );
            }
            other => {
                debug!(
                    target: "djtools_link::db",
                    request_type = format_args!("0x{other:04x}").to_string(),
                    "db_unhandled_request"
                );
                let reply = encode_db_message(tx, DB_RES_INVALID_REQUEST, &[DbValue::Int32(0)]);
                send_response!(reply);
            }
        }
        trace!(
            target: "djtools_link::db",
            %addr,
            tx,
            request = request_name,
            elapsed_us = request_started.elapsed().as_micros(),
            "db_request_done"
        );
    }
}

async fn write_pending_success(
    stream: &mut TcpStream,
    tx: u32,
    request_type: u16,
    request_args: &[DbValue],
    pending: &mut PendingRenderSession,
    entries: Vec<MenuEntry>,
) {
    let count = entries.len() as u32;
    trace!(
        target: "djtools_link::db",
        tx,
        request = db_request_name(request_type),
        count,
        args = %db_args_summary(request_args),
        rows = %menu_entries_preview(&entries),
        "db_menu_ready"
    );
    pending.prepare(pending_key_from_args(request_args), entries);
    let _ = stream
        .write_all(&success_with_count(tx, request_type, count))
        .await;
}

async fn write_pending_browse_success(
    state: &ServerState,
    addr: SocketAddr,
    stream: &mut TcpStream,
    tx: u32,
    request_type: u16,
    request_args: &[DbValue],
    pending: &mut PendingRenderSession,
    entries: Vec<MenuEntry>,
) {
    remember_browse_context(state, addr, request_type, request_args, &entries).await;
    write_pending_success(stream, tx, request_type, request_args, pending, entries).await;
}

async fn remember_browse_context(
    state: &ServerState,
    addr: SocketAddr,
    request_type: u16,
    args: &[DbValue],
    entries: &[MenuEntry],
) {
    let Some((target_player, _)) = load_settings_target_for_db_peer(state, addr).await else {
        return;
    };
    let Some(context) = LoadConfirmContext::for_browse_request(request_type, args, entries) else {
        return;
    };
    let track_ids = entries
        .iter()
        .filter(|entry| entry.is_track())
        .filter_map(MenuEntry::track_id)
        .collect::<HashSet<_>>();
    if track_ids.is_empty() {
        return;
    }
    state
        .remember_browse_context(target_player, context, track_ids)
        .await;
    trace!(
        target: "djtools_link::browse",
        %addr,
        target_player,
        request = db_request_name(request_type),
        context = %context.summary(),
        args = %db_args_summary(args),
        "browse_context_remembered"
    );
}

fn root_menu_entries() -> Vec<MenuEntry> {
    vec![
        MenuEntry::label(0, 2, "ARTIST", 0x0081),
        MenuEntry::label(0, 3, "ALBUM", 0x0082),
        MenuEntry::label(0, 4, "TRACK", META_ROOT_TRACK),
        MenuEntry::label(0, 12, "KEY", 0x008b),
        MenuEntry::label(0, 5, "PLAYLIST", META_ROOT_PLAYLIST),
        MenuEntry::label(0, ROOT_HISTORY_ID, "HISTORY", 0x0095),
        MenuEntry::label(0, ROOT_SEARCH_ID, "SEARCH", 0x0091),
        MenuEntry::label(0, ROOT_MATCHING_ID, "MATCHING", 0x00aa),
        MenuEntry::label(0, ROOT_DATE_ADDED_ID, "DATE ADDED", 0x008c),
        MenuEntry::label(0, ROOT_COLOR_ID, "COLOR", 0x008e),
    ]
}

fn sort_menu_entries() -> Vec<MenuEntry> {
    vec![
        MenuEntry::label(0, 0, "DEFAULT", 0x00a1),
        MenuEntry::label(0, 1, "ALPHABET", 0x00a2),
        MenuEntry::label(0, 2, "ARTIST", 0x0081),
        MenuEntry::label(0, 3, "ALBUM", 0x0082),
        MenuEntry::label(0, 4, "BPM", 0x0085),
        MenuEntry::label(0, 5, "RATING", 0x0086),
        MenuEntry::label(0, 12, "KEY", 0x008b),
        MenuEntry::label(0, 15, "COLOR", 0x008e),
        MenuEntry::label(0, SORT_DATE_ADDED, "DATE ADDED", 0x008c),
    ]
}

fn artist_entries(library: &LibrarySnapshot) -> Vec<MenuEntry> {
    let mut artists = BTreeMap::<String, u32>::new();
    for track in &library.all_tracks {
        if track.artist_id != 0 && !track.artist.trim().is_empty() {
            artists
                .entry(track.artist.clone())
                .or_insert(track.artist_id);
        }
    }
    artists
        .into_iter()
        .map(|(artist, artist_id)| MenuEntry::plain(0, artist_id, &artist, "", META_ARTIST))
        .collect()
}

fn artists_for_genre_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let genre_id = menu_arg(args, 1).unwrap_or(0);
    let mut artists = BTreeMap::<String, u32>::new();
    for track in &library.all_tracks {
        if !matches_filter_id(track.genre_id, genre_id) {
            continue;
        }
        if track.artist_id != 0 && !track.artist.trim().is_empty() {
            artists
                .entry(track.artist.clone())
                .or_insert(track.artist_id);
        }
    }
    artists
        .into_iter()
        .map(|(artist, artist_id)| MenuEntry::plain(genre_id, artist_id, &artist, "", META_ARTIST))
        .collect()
}

fn album_entries(library: &LibrarySnapshot) -> Vec<MenuEntry> {
    let mut albums = BTreeMap::<String, (u32, String, u32)>::new();
    for track in &library.all_tracks {
        if track.album_id != 0 && !track.album.trim().is_empty() {
            albums.entry(track.album.clone()).or_insert((
                track.album_id,
                track.artist.clone(),
                track.artist_id,
            ));
        }
    }
    albums
        .into_iter()
        .map(|(album, (album_id, artist, artist_id))| {
            MenuEntry::plain(artist_id, album_id, &album, &artist, META_ALBUM)
        })
        .collect()
}

fn genre_entries(library: &LibrarySnapshot) -> Vec<MenuEntry> {
    let mut genres = BTreeMap::<String, u32>::new();
    for track in &library.all_tracks {
        if track.genre_id != 0 && !track.genre.trim().is_empty() {
            genres.entry(track.genre.clone()).or_insert(track.genre_id);
        }
    }
    genres
        .into_iter()
        .map(|(genre, genre_id)| MenuEntry::plain(0, genre_id, &genre, "", META_GENRE))
        .collect()
}

fn key_entries(library: &LibrarySnapshot) -> Vec<MenuEntry> {
    let mut keys = HashMap::<u32, String>::new();
    for track in &library.all_tracks {
        if track.key_id != 0 && !track.key_identity().is_empty() {
            keys.entry(track.key_id)
                .or_insert_with(|| track.key_label());
        }
    }
    let mut entries = keys
        .into_iter()
        .map(|(key_id, key)| MenuEntry::plain(0, key_id, &key, "", META_KEY))
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        parse_camelot_key(&a.text1)
            .cmp(&parse_camelot_key(&b.text1))
            .then_with(|| {
                a.text1
                    .to_ascii_lowercase()
                    .cmp(&b.text1.to_ascii_lowercase())
            })
    });
    entries
}

fn bpm_entries(library: &LibrarySnapshot) -> Vec<MenuEntry> {
    let bpms = library
        .all_tracks
        .iter()
        .filter_map(track_bpm_whole)
        .collect::<BTreeSet<_>>();
    bpms.into_iter()
        .map(|bpm| MenuEntry::plain(0, bpm, &bpm.to_string(), "", META_BPM))
        .collect()
}

fn bpm_range_entries(_library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let bpm = menu_arg(args, 1).unwrap_or(0);
    if bpm == 0 {
        return Vec::new();
    }
    (0..=6)
        .map(|distance| MenuEntry::plain(bpm, distance, &format!("+/- {distance}%"), "", META_BPM))
        .collect()
}

fn rating_entries() -> Vec<MenuEntry> {
    Vec::new()
}

fn decade_entries(library: &LibrarySnapshot) -> Vec<MenuEntry> {
    let decades = library
        .all_tracks
        .iter()
        .filter_map(|track| (track.year > 0).then_some(track.year / 10 * 10))
        .collect::<BTreeSet<_>>();
    decades
        .into_iter()
        .map(|decade| MenuEntry::plain(0, decade, &format!("{decade}s"), "", META_YEAR))
        .collect()
}

fn date_added_entries(library: &LibrarySnapshot) -> Vec<MenuEntry> {
    let dates = library
        .all_tracks
        .iter()
        .filter_map(|track| {
            (!track.date_added.trim().is_empty())
                .then_some((track.date_added.clone(), track.date_added_id))
        })
        .collect::<BTreeMap<_, _>>();
    dates
        .into_iter()
        .rev()
        .map(|(date, date_id)| MenuEntry::plain(0, date_id, &date, "", META_DATE_ADDED))
        .collect()
}

fn label_entries(library: &LibrarySnapshot) -> Vec<MenuEntry> {
    let mut labels = BTreeMap::<String, u32>::new();
    for track in &library.all_tracks {
        let label = track.label.trim();
        let label_id = stable_text_id(label);
        if label_id != 0 {
            labels.entry(label.to_string()).or_insert(label_id);
        }
    }
    labels
        .into_iter()
        .map(|(label, label_id)| MenuEntry::plain(0, label_id, &label, "", META_LABEL))
        .collect()
}

fn color_entries(library: &LibrarySnapshot) -> Vec<MenuEntry> {
    if library.all_tracks.is_empty() {
        return Vec::new();
    }
    vec![MenuEntry::plain(0, 0, "None", "", META_COLOR_NONE)]
}

fn time_entries(library: &LibrarySnapshot) -> Vec<MenuEntry> {
    let minutes = library
        .all_tracks
        .iter()
        .filter_map(track_minutes)
        .collect::<BTreeSet<_>>();
    minutes
        .into_iter()
        .map(|minutes| MenuEntry::plain(0, minutes, &format!("{minutes} min"), "", META_DURATION))
        .collect()
}

fn bitrate_entries(library: &LibrarySnapshot) -> Vec<MenuEntry> {
    let bitrates = library
        .all_tracks
        .iter()
        .filter_map(|track| (track.bitrate_kbps > 0).then_some(track.bitrate_kbps))
        .collect::<BTreeSet<_>>();
    bitrates
        .into_iter()
        .map(|bitrate| MenuEntry::plain(0, bitrate, &format!("{bitrate} kbps"), "", META_BITRATE))
        .collect()
}

fn history_entries() -> Vec<MenuEntry> {
    Vec::new()
}

fn filename_entries(library: &LibrarySnapshot) -> Vec<MenuEntry> {
    let mut tracks = library.all_tracks.clone();
    tracks.sort_by_key(|track| {
        track
            .mount_path
            .file_name()
            .map(|name| name.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_else(|| track.title.to_ascii_lowercase())
    });
    title_entries(&tracks, true)
}

fn title_entries_for_request(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let args = strip_rmst_arg(args);
    let sort = db_int(args.first()).unwrap_or(SORT_DEFAULT);
    if args
        .iter()
        .filter_map(|arg| db_int(Some(arg)))
        .any(|value| value == ROOT_MATCHING_ID || value == 19 || value == 0x00aa)
    {
        return title_entries_for_sort(&library.all_tracks, SORT_DEFAULT, true);
    }
    if args
        .iter()
        .filter_map(|arg| db_int(Some(arg)))
        .any(|value| value == ROOT_DATE_ADDED_ID || value == 20 || value == META_DATE_ADDED)
    {
        return title_entries_for_sort(&library.all_tracks, SORT_DATE_ADDED, true);
    }
    title_entries_for_sort(&library.all_tracks, sort, true)
}

fn title_entries(tracks: &[TrackRecord], include_position: bool) -> Vec<MenuEntry> {
    tracks
        .iter()
        .enumerate()
        .map(|(idx, track)| MenuEntry {
            entry_id1: 0,
            entry_id2: track.track_id,
            text1: track.title.clone(),
            text2: String::new(),
            entry_type: META_TITLE,
            entry_id3: track.track_id,
            position: if include_position {
                (idx + 1) as u32
            } else {
                0
            },
            flags: 0x0100_0000,
            label: false,
            tail1: 0x0000_0100,
            tail2: 3,
            tail3: track.album_id,
            tail_text: track.key_label(),
            tail4: track.bpm_hundreds,
        })
        .collect()
}

fn title_entries_for_sort(
    tracks: &[TrackRecord],
    sort: u32,
    include_position: bool,
) -> Vec<MenuEntry> {
    if sort == SORT_DEFAULT {
        return title_entries(tracks, include_position);
    }

    let mut tracks = tracks.to_vec();
    match sort {
        SORT_TITLE => tracks.sort_by(track_title_cmp),
        SORT_ARTIST => tracks.sort_by(|a, b| {
            a.artist
                .to_ascii_lowercase()
                .cmp(&b.artist.to_ascii_lowercase())
                .then_with(|| track_title_cmp(a, b))
        }),
        SORT_ALBUM => tracks.sort_by(|a, b| {
            a.album
                .to_ascii_lowercase()
                .cmp(&b.album.to_ascii_lowercase())
                .then_with(|| track_title_cmp(a, b))
        }),
        SORT_BPM => tracks.sort_by(|a, b| {
            a.bpm_hundreds
                .cmp(&b.bpm_hundreds)
                .then_with(|| track_title_cmp(a, b))
        }),
        SORT_GENRE => tracks.sort_by(|a, b| {
            a.genre
                .to_ascii_lowercase()
                .cmp(&b.genre.to_ascii_lowercase())
                .then_with(|| track_title_cmp(a, b))
        }),
        SORT_COMMENT => tracks.sort_by(|a, b| {
            a.comment
                .to_ascii_lowercase()
                .cmp(&b.comment.to_ascii_lowercase())
                .then_with(|| track_title_cmp(a, b))
        }),
        SORT_TIME => tracks.sort_by(|a, b| {
            a.duration_sec
                .cmp(&b.duration_sec)
                .then_with(|| track_title_cmp(a, b))
        }),
        SORT_LABEL => tracks.sort_by(|a, b| {
            a.label
                .to_ascii_lowercase()
                .cmp(&b.label.to_ascii_lowercase())
                .then_with(|| track_title_cmp(a, b))
        }),
        SORT_KEY => tracks.sort_by(|a, b| {
            a.camelot_key()
                .cmp(&b.camelot_key())
                .then_with(|| {
                    a.key_label()
                        .to_ascii_lowercase()
                        .cmp(&b.key_label().to_ascii_lowercase())
                })
                .then_with(|| track_title_cmp(a, b))
        }),
        SORT_BITRATE => tracks.sort_by(|a, b| {
            a.bitrate_kbps
                .cmp(&b.bitrate_kbps)
                .then_with(|| track_title_cmp(a, b))
        }),
        SORT_COLOR => tracks.sort_by(track_title_cmp),
        SORT_DATE_ADDED => tracks.sort_by(|a, b| {
            b.date_added
                .cmp(&a.date_added)
                .then_with(|| track_title_cmp(a, b))
        }),
        _ => tracks.sort_by(track_title_cmp),
    }

    tracks
        .iter()
        .enumerate()
        .map(|(idx, track)| sorted_title_entry(track, sort, include_position, idx + 1))
        .collect()
}

fn sorted_title_entry(
    track: &TrackRecord,
    sort: u32,
    include_position: bool,
    position: usize,
) -> MenuEntry {
    let (entry_id1, text2, entry_type) = match sort {
        SORT_ALBUM => (
            track.album_id,
            track.album.clone(),
            META_TRACK_TITLE_AND_ALBUM,
        ),
        SORT_BPM => (track.bpm_hundreds, String::new(), META_TRACK_TITLE_AND_BPM),
        SORT_RATING => (0, String::new(), META_TRACK_TITLE_AND_RATING),
        SORT_GENRE => (
            track.genre_id,
            track.genre.clone(),
            META_TRACK_TITLE_AND_GENRE,
        ),
        SORT_COMMENT => (
            stable_text_id(&track.comment),
            track.comment.clone(),
            META_TRACK_TITLE_AND_COMMENT,
        ),
        SORT_TIME => (track.duration_sec, String::new(), META_TRACK_TITLE_AND_TIME),
        SORT_LABEL => (
            stable_text_id(&track.label),
            track.label.clone(),
            META_TRACK_TITLE_AND_LABEL,
        ),
        SORT_KEY => (track.key_id, track.key_label(), META_TRACK_TITLE_AND_KEY),
        SORT_BITRATE => (
            track.bitrate_kbps,
            String::new(),
            META_TRACK_TITLE_AND_BITRATE,
        ),
        SORT_COLOR => (0, "None".to_string(), META_TRACK_TITLE_AND_COLOR),
        SORT_DATE_ADDED => (
            track.date_added_id,
            track.date_added.clone(),
            META_TRACK_TITLE_AND_DATE_ADDED,
        ),
        SORT_TITLE | SORT_ARTIST | _ => (
            track.artist_id,
            track.artist.clone(),
            META_TRACK_TITLE_AND_ARTIST,
        ),
    };
    MenuEntry {
        entry_id1,
        entry_id2: track.track_id,
        text1: track.title.clone(),
        text2,
        entry_type,
        entry_id3: track.track_id,
        position: if include_position { position as u32 } else { 0 },
        flags: 0x0100_0000,
        label: false,
        tail1: 0x0000_0100,
        tail2: 3,
        tail3: track.album_id,
        tail_text: track.key_label(),
        tail4: track.bpm_hundreds,
    }
}

fn track_title_cmp(a: &TrackRecord, b: &TrackRecord) -> std::cmp::Ordering {
    a.title
        .to_ascii_lowercase()
        .cmp(&b.title.to_ascii_lowercase())
        .then_with(|| a.track_id.cmp(&b.track_id))
}

fn albums_for_artist_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let args = strip_rmst_arg(args);
    let artist_id = db_int(args.get(1)).unwrap_or(0);
    let mut albums = BTreeMap::<String, u32>::new();
    let mut has_tracks = false;
    for track in &library.all_tracks {
        if !matches_filter_id(track.artist_id, artist_id) {
            continue;
        }
        has_tracks = true;
        if track.album_id != 0 && !track.album.trim().is_empty() {
            albums.entry(track.album.clone()).or_insert(track.album_id);
        }
    }
    let mut entries = Vec::new();
    if has_tracks {
        entries.push(MenuEntry::plain(
            artist_id,
            u32::MAX,
            "All Tracks",
            "",
            META_ALBUM,
        ));
    }
    entries.extend(
        albums
            .into_iter()
            .map(|(album, album_id)| MenuEntry::plain(artist_id, album_id, &album, "", META_ALBUM)),
    );
    entries
}

fn tracks_for_album_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let args = strip_rmst_arg(args);
    let album_id = db_int(args.get(1)).unwrap_or(0);
    let tracks = library
        .all_tracks
        .iter()
        .filter(|track| matches_filter_id(track.album_id, album_id))
        .cloned()
        .collect::<Vec<_>>();
    title_entries(&tracks, true)
}

fn tracks_for_artist_album_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let args = strip_rmst_arg(args);
    let artist_id = db_int(args.get(1)).unwrap_or(0);
    let album_id = db_int(args.get(2)).unwrap_or(0);
    let tracks = library
        .all_tracks
        .iter()
        .filter(|track| {
            matches_filter_id(track.artist_id, artist_id)
                && matches_filter_id(track.album_id, album_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    title_entries(&tracks, true)
}

fn key_neighbor_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let args = strip_rmst_arg(args);
    let key_id = db_int(args.get(1)).unwrap_or(0);
    let Some(track) = library
        .all_tracks
        .iter()
        .find(|track| track.key_id == key_id)
    else {
        return Vec::new();
    };
    let key_text = track.key_label();

    (0..=2)
        .map(|distance| {
            let label = if distance == 0 {
                key_text.clone()
            } else {
                format!("{key_text} +/- {distance}")
            };
            MenuEntry::plain(key_id, distance, &label, "", META_KEY)
        })
        .collect()
}

fn tracks_for_key_distance_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let args = strip_rmst_arg(args);
    let key_id = db_int(args.get(1)).unwrap_or(0);
    let distance = db_int(args.get(2)).unwrap_or(0);
    let center = library
        .all_tracks
        .iter()
        .find(|track| track.key_id == key_id)
        .and_then(TrackRecord::camelot_key);
    let compatible = center.map(|key| compatible_camelot_keys(key, distance));
    let tracks = library
        .all_tracks
        .iter()
        .filter(|track| {
            if let Some(compatible) = compatible.as_ref() {
                track
                    .camelot_key()
                    .is_some_and(|key| compatible.contains(&key))
            } else {
                track.key_id == key_id
            }
        })
        .cloned()
        .collect::<Vec<_>>();
    title_entries(&tracks, true)
}

fn years_for_decade_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let decade = menu_arg(args, 1).unwrap_or(0);
    let years = library
        .all_tracks
        .iter()
        .filter_map(|track| {
            (track.year > 0 && matches_decade(track.year, decade)).then_some(track.year)
        })
        .collect::<BTreeSet<_>>();
    years
        .into_iter()
        .map(|year| MenuEntry::plain(decade, year, &year.to_string(), "", META_YEAR))
        .collect()
}

fn artists_for_label_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let label_id = menu_arg(args, 1).unwrap_or(0);
    let mut artists = BTreeMap::<String, u32>::new();
    for track in &library.all_tracks {
        if !matches_filter_id(stable_text_id(&track.label), label_id) {
            continue;
        }
        if track.artist_id != 0 && !track.artist.trim().is_empty() {
            artists
                .entry(track.artist.clone())
                .or_insert(track.artist_id);
        }
    }
    artists
        .into_iter()
        .map(|(artist, artist_id)| MenuEntry::plain(label_id, artist_id, &artist, "", META_ARTIST))
        .collect()
}

fn albums_for_genre_artist_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let genre_id = menu_arg(args, 1).unwrap_or(0);
    let artist_id = menu_arg(args, 2).unwrap_or(u32::MAX);
    album_entries_for_tracks(
        library.all_tracks.iter().filter(|track| {
            matches_filter_id(track.genre_id, genre_id)
                && matches_filter_id(track.artist_id, artist_id)
        }),
        genre_id,
    )
}

fn albums_for_label_artist_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let label_id = menu_arg(args, 1).unwrap_or(0);
    let artist_id = menu_arg(args, 2).unwrap_or(u32::MAX);
    album_entries_for_tracks(
        library.all_tracks.iter().filter(|track| {
            matches_filter_id(stable_text_id(&track.label), label_id)
                && matches_filter_id(track.artist_id, artist_id)
        }),
        label_id,
    )
}

fn tracks_for_rating_entries(_library: &LibrarySnapshot, _args: &[DbValue]) -> Vec<MenuEntry> {
    Vec::new()
}

fn tracks_for_color_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let color_id = menu_arg(args, 1).unwrap_or(0);
    if color_id == 0 || is_all_filter_id(color_id) {
        return title_entries(&library.all_tracks, true);
    }
    Vec::new()
}

fn tracks_for_time_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let minutes = menu_arg(args, 1).unwrap_or(0);
    let tracks = library
        .all_tracks
        .iter()
        .filter(|track| track_minutes(track) == Some(minutes))
        .cloned()
        .collect::<Vec<_>>();
    title_entries(&tracks, true)
}

fn tracks_for_bitrate_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let bitrate = menu_arg(args, 1).unwrap_or(0);
    let tracks = library
        .all_tracks
        .iter()
        .filter(|track| matches_filter_id(track.bitrate_kbps, bitrate))
        .cloned()
        .collect::<Vec<_>>();
    title_entries(&tracks, true)
}

fn tracks_for_bpm_distance_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let bpm = menu_arg(args, 1).unwrap_or(0);
    let distance = menu_arg(args, 2).unwrap_or(0);
    if bpm == 0 {
        return Vec::new();
    }
    let tolerance = bpm.saturating_mul(distance.min(6)) / 100;
    let tracks = library
        .all_tracks
        .iter()
        .filter(|track| {
            let Some(track_bpm) = track_bpm_whole(track) else {
                return false;
            };
            let delta = track_bpm.abs_diff(bpm);
            delta <= tolerance
        })
        .cloned()
        .collect::<Vec<_>>();
    title_entries(&tracks, true)
}

fn tracks_for_decade_year_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let decade = menu_arg(args, 1).unwrap_or(0);
    let year = menu_arg(args, 2).unwrap_or(u32::MAX);
    let tracks = library
        .all_tracks
        .iter()
        .filter(|track| {
            track.year > 0
                && matches_decade(track.year, decade)
                && (is_all_filter_id(year) || track.year == year)
        })
        .cloned()
        .collect::<Vec<_>>();
    title_entries(&tracks, true)
}

fn tracks_for_date_added_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let date_id = menu_arg(args, 1).unwrap_or(0);
    let tracks = library
        .all_tracks
        .iter()
        .filter(|track| {
            !track.date_added.trim().is_empty()
                && (date_id == 0 || is_all_filter_id(date_id) || track.date_added_id == date_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    title_entries_for_sort(&tracks, SORT_DATE_ADDED, true)
}

fn tracks_for_genre_artist_album_entries(
    library: &LibrarySnapshot,
    args: &[DbValue],
) -> Vec<MenuEntry> {
    let genre_id = menu_arg(args, 1).unwrap_or(0);
    let artist_id = menu_arg(args, 2).unwrap_or(u32::MAX);
    let album_id = menu_arg(args, 3).unwrap_or(u32::MAX);
    let tracks = library
        .all_tracks
        .iter()
        .filter(|track| {
            matches_filter_id(track.genre_id, genre_id)
                && matches_filter_id(track.artist_id, artist_id)
                && matches_filter_id(track.album_id, album_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    title_entries(&tracks, true)
}

fn tracks_for_label_artist_album_entries(
    library: &LibrarySnapshot,
    args: &[DbValue],
) -> Vec<MenuEntry> {
    let label_id = menu_arg(args, 1).unwrap_or(0);
    let artist_id = menu_arg(args, 2).unwrap_or(u32::MAX);
    let album_id = menu_arg(args, 3).unwrap_or(u32::MAX);
    let tracks = library
        .all_tracks
        .iter()
        .filter(|track| {
            matches_filter_id(stable_text_id(&track.label), label_id)
                && matches_filter_id(track.artist_id, artist_id)
                && matches_filter_id(track.album_id, album_id)
        })
        .cloned()
        .collect::<Vec<_>>();
    title_entries(&tracks, true)
}

fn album_entries_for_tracks<'a>(
    tracks: impl Iterator<Item = &'a TrackRecord>,
    id1: u32,
) -> Vec<MenuEntry> {
    let mut albums = BTreeMap::<String, u32>::new();
    for track in tracks {
        if track.album_id != 0 && !track.album.trim().is_empty() {
            albums.entry(track.album.clone()).or_insert(track.album_id);
        }
    }
    albums
        .into_iter()
        .map(|(album, album_id)| MenuEntry::plain(id1, album_id, &album, "", META_ALBUM))
        .collect()
}

fn menu_arg(args: &[DbValue], index: usize) -> Option<u32> {
    db_int(strip_rmst_arg(args).get(index))
}

fn is_all_filter_id(value: u32) -> bool {
    value == u32::MAX
}

fn matches_filter_id(actual: u32, requested: u32) -> bool {
    is_all_filter_id(requested) || actual == requested
}

fn matches_decade(year: u32, decade: u32) -> bool {
    is_all_filter_id(decade) || decade == 0 || year / 10 * 10 == decade
}

fn track_bpm_whole(track: &TrackRecord) -> Option<u32> {
    (track.bpm_hundreds > 0).then_some((track.bpm_hundreds + 50) / 100)
}

fn track_minutes(track: &TrackRecord) -> Option<u32> {
    (track.duration_sec > 0).then_some(track.duration_sec.div_ceil(60))
}

fn playlist_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let args = strip_rmst_arg(args);
    if args.len() < 3 {
        return Vec::new();
    }
    let is_folder = db_int(args.get(2)).unwrap_or(1) == 1;
    let mut target = db_int(args.get(1))
        .filter(|value| *value != 0)
        .or_else(|| (!is_folder).then(|| db_int(args.first())).flatten())
        .unwrap_or(0);
    if target == u32::MAX {
        target = 0;
    }
    if is_folder {
        let mut children = library
            .playlists
            .iter()
            .filter(|playlist| playlist.parent_id == target)
            .collect::<Vec<_>>();
        children.sort_by(|a, b| {
            a.sequence.cmp(&b.sequence).then_with(|| {
                a.name
                    .to_ascii_lowercase()
                    .cmp(&b.name.to_ascii_lowercase())
            })
        });
        return children
            .into_iter()
            .map(|playlist| MenuEntry {
                entry_id1: playlist.parent_id,
                entry_id2: playlist.playlist_id,
                text1: playlist.name.clone(),
                text2: String::new(),
                entry_type: if playlist.is_folder {
                    META_FOLDER
                } else {
                    META_PLAYLIST
                },
                entry_id3: 0,
                position: 0,
                flags: 0,
                label: false,
                tail1: 0,
                tail2: 0,
                tail3: 0,
                tail_text: String::new(),
                tail4: 0,
            })
            .collect();
    }
    let Some(playlist) = library
        .playlists
        .iter()
        .find(|playlist| playlist.playlist_id == target)
    else {
        return Vec::new();
    };
    let tracks = playlist
        .tracks
        .iter()
        .filter_map(|id| library.tracks_by_id.get(id).cloned())
        .collect::<Vec<_>>();
    title_entries(&tracks, true)
}

fn sort_label(sort: u32) -> &'static str {
    match sort {
        SORT_DEFAULT => "default",
        SORT_TITLE => "title",
        SORT_ARTIST => "artist",
        SORT_ALBUM => "album",
        SORT_BPM => "bpm",
        SORT_RATING => "rating",
        SORT_GENRE => "genre",
        SORT_COMMENT => "comment",
        SORT_TIME => "time",
        SORT_LABEL => "label",
        SORT_KEY => "key",
        SORT_BITRATE => "bitrate",
        SORT_COLOR => "color",
        SORT_DATE_ADDED => "date-added",
        _ => "unknown",
    }
}

fn metadata_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let Some(track) = track_from_request(library, args) else {
        return Vec::new();
    };
    vec![
        MenuEntry::plain(
            track.artist_id,
            track.track_id,
            &track.title,
            "",
            META_TITLE,
        )
        .with_entry_id3(track.artwork_id),
        MenuEntry::plain(0, track.artist_id, &track.artist, "", META_ARTIST),
        MenuEntry::plain(0, track.album_id, &track.album, "", META_ALBUM),
        MenuEntry::plain(0, track.duration_sec, "", "", META_DURATION),
        MenuEntry::plain(0, track.bpm_hundreds, "", "", META_BPM),
        MenuEntry::plain(0, track.key_id, &track.key_label(), "", META_KEY),
        MenuEntry::plain(0, 0, "", "", META_RATING),
        MenuEntry::plain(0, 0, "", "", META_COLOR_NONE),
        MenuEntry::plain(0, track.genre_id, &track.genre, "", META_GENRE),
        MenuEntry::plain(
            0,
            track.date_added_id,
            &track.date_added,
            "",
            META_DATE_ADDED,
        ),
        MenuEntry::plain(0, track.track_id, &track.comment, "", META_COMMENT),
        MenuEntry::plain(0, track.bitrate_kbps, "", "", META_BITRATE),
        MenuEntry::plain(0, track.year, "", "", 0x0011),
        MenuEntry::plain(
            0,
            stable_text_id(&track.label),
            &track.label,
            "",
            META_LABEL,
        ),
        MenuEntry::plain(0, 0, "", "", META_ORIGINAL_ARTIST),
        MenuEntry::plain(0, 0, "", "", META_REMIXER),
    ]
}

fn mount_info_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let Some(track) = track_from_request(library, args) else {
        return Vec::new();
    };
    let mount_path_id = nonzero_artwork_id(track);
    vec![
        MenuEntry::plain(0, 1, "", "", META_TITLE),
        MenuEntry::plain(0, track.duration_sec, "", "", META_DURATION),
        MenuEntry::plain(0, track.bpm_hundreds, "", "", META_BPM),
        MenuEntry::plain(0, track.track_id, &track.comment, "", META_COMMENT),
        MenuEntry::plain(
            mount_path_id,
            track.track_id,
            &track.mount_path.to_string_lossy(),
            "",
            META_MOUNT_PATH,
        ),
        MenuEntry::plain(0, 1, "", "", 0x002f),
        MenuEntry::plain(0, track.key_id, &track.key_label(), "", META_KEY),
    ]
}

fn nonzero_artwork_id(track: &TrackRecord) -> u32 {
    if track.artwork_id == 0 {
        track.track_id
    } else {
        track.artwork_id
    }
}

fn default_extended_cue_points_payload() -> Vec<u8> {
    // Native Rekordbox returns this 56-byte high-level CUE_POINTS_EXT payload
    // for a track with no user cue list; returning an empty PCO2 header stalls.
    vec![
        0x38, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0xe8, 0x03, 0x4d, 0x00, 0x00,
        0x00, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff,
        0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]
}

fn default_extended_cue_points() -> CuePointsExt {
    CuePointsExt {
        entries: default_extended_cue_points_payload(),
        entry_count: 1,
    }
}

fn default_vbr_payload() -> Vec<u8> {
    vec![0; 1604]
}

fn track_from_request<'a>(
    library: &'a LibrarySnapshot,
    args: &[DbValue],
) -> Option<&'a TrackRecord> {
    track_from_request_at(library, args, 0)
}

fn track_from_request_at<'a>(
    library: &'a LibrarySnapshot,
    args: &[DbValue],
    track_id_index: usize,
) -> Option<&'a TrackRecord> {
    let args = strip_rmst_arg(args);
    let id = track_id_from_request_at(library, args, track_id_index)?;
    library.tracks_by_id.get(&id)
}

fn track_id_from_request_at(
    library: &LibrarySnapshot,
    args: &[DbValue],
    track_id_index: usize,
) -> Option<u32> {
    let args = strip_rmst_arg(args);
    let id = db_int(args.get(track_id_index))?;
    library.tracks_by_id.contains_key(&id).then_some(id)
}

fn track_id_from_request_args(library: &LibrarySnapshot, args: &[DbValue]) -> Option<u32> {
    strip_rmst_arg(args)
        .iter()
        .filter_map(|arg| db_int(Some(arg)))
        .find(|id| library.tracks_by_id.contains_key(id))
}

fn anlz_tag_request_summary(args: &[DbValue]) -> (Option<u32>, String, String) {
    let args = strip_rmst_arg(args);
    let track_id = db_int(args.first());
    let tag_name = args
        .get(1)
        .and_then(|arg| db_int(Some(arg)))
        .map(fourcc_from_le_u32)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    let ext_name = args
        .get(2)
        .and_then(|arg| db_int(Some(arg)))
        .map(fourcc_from_le_u32)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string());
    (track_id, tag_name, ext_name)
}

fn anlz_progress_context(tag_name: &str) -> &'static str {
    match tag_name {
        "PWV4" | "PWV5" | "PWV6" | "PWV7" => "anlz-visual",
        _ => "anlz-tag",
    }
}

fn waveform_preview_upload(library: &LibrarySnapshot, args: &[DbValue]) -> Option<(u32, Vec<u8>)> {
    let args = strip_rmst_arg(args);
    let track_id = db_int(args.get(1))?;
    if !library.tracks_by_id.contains_key(&track_id) {
        return None;
    }
    let (preview_index, preview) = args.iter().enumerate().find_map(|(index, arg)| {
        if let DbValue::Binary(raw) = arg {
            (!raw.is_empty()).then_some((index, raw))
        } else {
            None
        }
    })?;
    let declared_len = db_int(args.get(preview_index.saturating_sub(1)))? as usize;
    if declared_len != preview.len() {
        return None;
    }
    Some((track_id, preview.clone()))
}

fn track_from_artwork_request<'a>(
    library: &'a LibrarySnapshot,
    args: &[DbValue],
) -> Option<&'a TrackRecord> {
    let args = strip_rmst_arg(args);
    for id in args.iter().filter_map(|arg| db_int(Some(arg))) {
        if let Some(track) = library
            .all_tracks
            .iter()
            .find(|track| track.artwork_id != 0 && track.artwork_id == id)
        {
            return Some(track);
        }
    }
    for id in args.iter().filter_map(|arg| db_int(Some(arg))) {
        if let Some(track) = library.tracks_by_id.get(&id) {
            return Some(track);
        }
    }
    None
}

async fn load_artwork(state: &ServerState, args: &[DbValue]) -> Option<Vec<u8>> {
    let track = track_from_artwork_request(&state.library, args)?;
    if track.artwork_id == 0 {
        return None;
    }
    if let Some(cached) = state.cached_artwork(track.artwork_id).await {
        return cached;
    }

    let fetched = load_local_artwork(track).await.inspect(|bytes| {
        trace!(
            target: "djtools_link::db",
            track_id = track.track_id,
            artwork_id = track.artwork_id,
            bytes = bytes.len(),
            path = track.artwork_url.as_deref().unwrap_or(""),
            "artwork_local_loaded"
        );
    });
    state.store_artwork(track.artwork_id, fetched.clone()).await;
    fetched
}

async fn load_local_artwork(track: &TrackRecord) -> Option<Vec<u8>> {
    let path = Path::new(track.artwork_url.as_deref()?);
    let bytes = tokio::fs::read(path).await.ok()?;
    if bytes.is_empty() {
        return None;
    }
    if bytes.len() > MAX_ARTWORK_BYTES {
        return None;
    }
    tokio::task::spawn_blocking(move || normalize_deck_artwork(&bytes))
        .await
        .ok()
        .flatten()
}

fn normalize_deck_artwork(bytes: &[u8]) -> Option<Vec<u8>> {
    let decoded = image::load_from_memory(bytes).ok()?;
    let resized = decoded.resize_to_fill(
        DECK_ARTWORK_EDGE_PX,
        DECK_ARTWORK_EDGE_PX,
        FilterType::Triangle,
    );
    let mut encoded = Vec::new();
    JpegEncoder::new_with_quality(&mut encoded, DECK_ARTWORK_JPEG_QUALITY)
        .encode_image(&resized)
        .ok()?;
    (!encoded.is_empty() && encoded.len() <= MAX_ARTWORK_BYTES).then_some(encoded)
}

async fn load_beat_grid(library: &LibrarySnapshot, args: &[DbValue]) -> Option<Vec<u8>> {
    let track = track_from_request(library, args)?;
    let tag = read_anlz_tag(track, "PQTZ", None).await?;
    beat_grid_from_pqtz_tag(&tag)
}

async fn load_waveform_preview(library: &LibrarySnapshot, args: &[DbValue]) -> Option<Vec<u8>> {
    let track = track_from_request_at(library, args, 1)?;
    load_waveform_preview_for_track(track).await
}

async fn load_waveform_preview_for_track(track: &TrackRecord) -> Option<Vec<u8>> {
    let pwav = read_anlz_tag(track, "PWAV", None).await?;
    let pwv2 = read_anlz_tag(track, "PWV2", None).await;
    waveform_preview_from_pwav_tag(&pwav, pwv2.as_deref())
}

async fn load_cached_waveform_preview(state: &ServerState, args: &[DbValue]) -> Option<Vec<u8>> {
    let Some(track_id) = track_id_from_request_at(&state.library, args, 1) else {
        return load_waveform_preview(&state.library, args).await;
    };

    if let Some(blob) = state.cached_waveform_preview(track_id).await {
        return Some(blob);
    }

    let blob = load_waveform_preview(&state.library, args).await;
    if let Some(blob) = blob.as_ref() {
        state.store_waveform_preview(track_id, blob.clone()).await;
    }
    blob
}

async fn load_waveform_detail(library: &LibrarySnapshot, args: &[DbValue]) -> Option<Vec<u8>> {
    let track = track_from_request(library, args)?;
    let tag = read_anlz_tag(track, "PWV3", None).await?;
    waveform_detail_from_pwv3_tag(&tag)
}

#[derive(Default)]
struct CuePoints {
    first: Vec<u8>,
    second: Vec<u8>,
    hot_count: u32,
    memory_count: u32,
}

struct CuePointsExt {
    entries: Vec<u8>,
    entry_count: u32,
}

async fn load_cue_points(library: &LibrarySnapshot, args: &[DbValue]) -> Option<CuePoints> {
    let track = track_from_request(library, args)?;
    let dat_path = track.analysis_dat_path.as_ref()?;
    let mut fallback = None;
    for path in analysis_candidate_paths(track, dat_path) {
        let tags = read_anlz_tags_from_file(&path, "PCOB").await;
        if tags.is_empty() {
            continue;
        }
        let cues = cue_points_from_pcob_tags(tags);
        if cues.hot_count > 0 || cues.memory_count > 0 {
            return Some(cues);
        }
        fallback.get_or_insert(cues);
    }
    Some(fallback.unwrap_or_default())
}

fn cue_points_from_pcob_tags(tags: Vec<Vec<u8>>) -> CuePoints {
    let mut cues = CuePoints::default();
    for tag in tags {
        let Some((cue_type, entries, count)) = nexus_cue_entries_from_pcob_tag(&tag) else {
            continue;
        };
        match cue_type {
            0 => {
                cues.memory_count = cues.memory_count.saturating_add(count);
                cues.first.extend_from_slice(&entries);
            }
            1 => {
                cues.hot_count = cues.hot_count.saturating_add(count);
                cues.second.extend_from_slice(&entries);
            }
            _ => {}
        }
    }
    cues
}

async fn load_cue_points_ext(library: &LibrarySnapshot, args: &[DbValue]) -> Option<CuePointsExt> {
    let track = track_from_request(library, args)?;
    let tag = read_anlz_tag(track, "PCO2", None).await?;
    cue_points_ext_from_pco2_tag(&tag)
        .filter(|cues| cues.entry_count > 0 && !cues.entries.is_empty())
}

async fn load_vbr_payload(library: &LibrarySnapshot, args: &[DbValue]) -> Option<Vec<u8>> {
    let track = track_from_request(library, args)?;
    read_anlz_tag(track, "PVBR", None)
        .await
        .and_then(|tag| vbr_payload_from_pvbr_tag(&tag))
        .or_else(|| Some(default_vbr_payload()))
}

async fn load_anlz_tag(
    library: &LibrarySnapshot,
    args: &[DbValue],
    serve_extended_tags: bool,
) -> Option<Vec<u8>> {
    let args = strip_rmst_arg(args);
    if args.len() < 3 {
        return None;
    }
    let track_id = db_int(args.first())?;
    let track = library.tracks_by_id.get(&track_id)?;
    let tag_name = fourcc_from_le_u32(db_int(args.get(1))?);
    let ext_name = fourcc_from_le_u32(db_int(args.get(2))?);
    if !serve_extended_tags && native_returns_not_found_for_anlz_tag(&tag_name, &ext_name) {
        return None;
    }
    let tag = read_anlz_tag(track, &tag_name, Some(&ext_name)).await?;
    if tag_name == "PQT2"
        && matches!(ext_name.as_str(), "EXT" | "TXE")
        && !pqt2_tag_matches_primary_grid(track, &tag).await
    {
        return None;
    }
    Some(tag)
}

fn native_returns_not_found_for_anlz_tag(tag_name: &str, ext_name: &str) -> bool {
    matches!(
        (tag_name, ext_name),
        ("PQT2", "EXT" | "TXE")
            | ("PSSI", "EXT" | "TXE")
            | ("PWV4", "EXT" | "TXE")
            | ("PWV5", "EXT" | "TXE")
            | ("PWV6", "2EX" | "XE2")
            | ("PWV7", "2EX" | "XE2")
    )
}

async fn read_anlz_tag(
    track: &TrackRecord,
    tag_type: &str,
    ext_name: Option<&str>,
) -> Option<Vec<u8>> {
    read_anlz_tags(track, tag_type, ext_name)
        .await
        .into_iter()
        .next()
}

async fn read_anlz_tags(
    track: &TrackRecord,
    tag_type: &str,
    ext_name: Option<&str>,
) -> Vec<Vec<u8>> {
    let Some(dat_path) = track.analysis_dat_path.as_ref() else {
        return Vec::new();
    };
    if let Some(ext_name) = ext_name {
        return read_anlz_tags_from_explicit_file(track, dat_path, ext_name, tag_type).await;
    }
    for path in analysis_candidate_paths(track, dat_path) {
        let tags = read_anlz_tags_from_file(&path, tag_type).await;
        if !tags.is_empty() {
            return tags;
        }
    }
    Vec::new()
}

async fn read_anlz_tags_from_explicit_file(
    track: &TrackRecord,
    dat_path: &Path,
    ext_name: &str,
    tag_type: &str,
) -> Vec<Vec<u8>> {
    let path = match ext_name {
        "EXT" | "TXE" => track
            .analysis_ext_path
            .clone()
            .unwrap_or_else(|| dat_path.with_extension("EXT")),
        "2EX" | "XE2" => track
            .analysis_twoex_path
            .clone()
            .unwrap_or_else(|| dat_path.with_extension("2EX")),
        "DAT" | "TAD" => dat_path.to_path_buf(),
        _ => dat_path.to_path_buf(),
    };
    read_anlz_tags_from_file(&path, tag_type).await
}

fn analysis_candidate_paths(track: &TrackRecord, dat_path: &Path) -> Vec<PathBuf> {
    let mut paths = vec![dat_path.to_path_buf()];
    paths.push(
        track
            .analysis_ext_path
            .clone()
            .unwrap_or_else(|| dat_path.with_extension("EXT")),
    );
    paths.push(
        track
            .analysis_twoex_path
            .clone()
            .unwrap_or_else(|| dat_path.with_extension("2EX")),
    );
    paths
}

async fn read_anlz_tags_from_file(path: &Path, tag_type: &str) -> Vec<Vec<u8>> {
    let tags = parse_anlz_tags_from_file(path).await;
    tags.get(tag_type).cloned().unwrap_or_default()
}

async fn parse_anlz_tags_from_file(path: &Path) -> HashMap<String, Vec<Vec<u8>>> {
    let Ok(data) = tokio::fs::read(path).await else {
        return HashMap::new();
    };
    if data.len() < 28 || data.get(0..4) != Some(b"PMAI".as_slice()) {
        return HashMap::new();
    }
    let Some(header) = data.get(4..12) else {
        return HashMap::new();
    };
    let header_len = be_u32(&header[0..4]) as usize;
    let file_len = be_u32(&header[4..8]) as usize;
    let file_len = file_len.min(data.len());
    let mut tags = HashMap::<String, Vec<Vec<u8>>>::new();
    let mut offset = header_len;
    while offset + 12 <= file_len {
        let Some(name_bytes) = data.get(offset..offset + 4) else {
            return HashMap::new();
        };
        let Ok(name) = std::str::from_utf8(name_bytes) else {
            return HashMap::new();
        };
        let Some(tag_len_bytes) = data.get(offset + 8..offset + 12) else {
            return HashMap::new();
        };
        let tag_len = be_u32(tag_len_bytes) as usize;
        if tag_len < 12 || offset + tag_len > file_len {
            return HashMap::new();
        }
        tags.entry(name.to_string())
            .or_default()
            .push(data[offset..offset + tag_len].to_vec());
        offset += tag_len;
    }
    tags
}

#[cfg(test)]
fn anlz_tag_payload(tag: &[u8]) -> Option<Vec<u8>> {
    if tag.len() < 12 {
        return None;
    }
    let header_len = be_u32(tag.get(4..8)?) as usize;
    let tag_len = be_u32(tag.get(8..12)?) as usize;
    if header_len < 12 || header_len > tag_len || tag_len > tag.len() {
        return None;
    }
    Some(tag[12..tag_len].to_vec())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PqtzGridStats {
    count: usize,
    last_beat_ms: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Pqt2GridStats {
    count: usize,
    last_beat_ms: u32,
}

fn pqtz_grid_stats(tag: &[u8]) -> Option<PqtzGridStats> {
    if tag.len() < 24 || tag.get(0..4)? != b"PQTZ" {
        return None;
    }
    let tag_len = (be_u32(tag.get(8..12)?) as usize).min(tag.len());
    if tag_len < 24 {
        return None;
    }
    let declared_count = be_u32(tag.get(20..24)?) as usize;
    let available_count = (tag_len - 24) / 8;
    let beat_count = declared_count.min(available_count);
    if beat_count == 0 {
        return None;
    }

    let mut previous_time = None;
    let mut last_beat_ms = 0;
    for beat_index in 0..beat_count {
        let entry = 24 + beat_index * 8;
        let beat = u16::from_be_bytes(tag.get(entry..entry + 2)?.try_into().ok()?);
        let time_ms = be_u32(tag.get(entry + 4..entry + 8)?);
        if !matches!(beat, 1..=4) {
            return None;
        }
        if previous_time.is_some_and(|previous| time_ms <= previous) {
            return None;
        }
        previous_time = Some(time_ms);
        last_beat_ms = time_ms;
    }

    Some(PqtzGridStats {
        count: beat_count,
        last_beat_ms,
    })
}

fn beat_grid_from_pqtz_tag(tag: &[u8]) -> Option<Vec<u8>> {
    let stats = pqtz_grid_stats(tag)?;
    let beat_count = stats.count;

    let mut payload = Vec::with_capacity(20 + beat_count * 16);
    payload.extend_from_slice(&0x0008_0000u32.to_le_bytes());
    payload.extend_from_slice(&(beat_count as u32).to_le_bytes());
    payload.extend_from_slice(&((beat_count * 16) as u32).to_le_bytes());
    payload.extend_from_slice(&1u32.to_le_bytes());
    payload.extend_from_slice(&1u32.to_le_bytes());

    for beat_index in 0..beat_count {
        let entry = 24 + beat_index * 8;
        let beat = u16::from_be_bytes(tag.get(entry..entry + 2)?.try_into().ok()?);
        let tempo = u16::from_be_bytes(tag.get(entry + 2..entry + 4)?.try_into().ok()?);
        let time_ms = be_u32(tag.get(entry + 4..entry + 8)?);
        payload.extend_from_slice(&beat.to_le_bytes());
        payload.extend_from_slice(&tempo.to_le_bytes());
        payload.extend_from_slice(&time_ms.to_le_bytes());
        payload.extend_from_slice(&[0xff; 8]);
    }

    Some(payload)
}

fn pqt2_grid_stats(tag: &[u8]) -> Option<Pqt2GridStats> {
    if tag.len() < 56 || tag.get(0..4)? != b"PQT2" {
        return None;
    }
    let header_len = be_u32(tag.get(4..8)?) as usize;
    let tag_len = be_u32(tag.get(8..12)?) as usize;
    if header_len != 56 || tag_len > tag.len() || tag_len < header_len {
        return None;
    }
    if be_u32(tag.get(12..16)?) != 0 {
        return None;
    }
    let count = be_u32(tag.get(40..44)?) as usize;
    if count == 0 || tag_len - header_len != count.checked_mul(2)? {
        return None;
    }
    Some(Pqt2GridStats {
        count,
        last_beat_ms: be_u32(tag.get(36..40)?),
    })
}

async fn pqt2_tag_matches_primary_grid(track: &TrackRecord, tag: &[u8]) -> bool {
    let Some(pqt2) = pqt2_grid_stats(tag) else {
        return false;
    };
    let Some(pqtz) = read_anlz_tag(track, "PQTZ", Some("DAT"))
        .await
        .and_then(|tag| pqtz_grid_stats(&tag))
    else {
        return true;
    };
    pqt2.count == pqtz.count && pqt2.last_beat_ms.abs_diff(pqtz.last_beat_ms) <= 1
}

fn vbr_payload_from_pvbr_tag(tag: &[u8]) -> Option<Vec<u8>> {
    if tag.len() < 16 || tag.get(0..4)? != b"PVBR" {
        return None;
    }
    let header_len = be_u32(tag.get(4..8)?) as usize;
    let tag_len = (be_u32(tag.get(8..12)?) as usize).min(tag.len());
    if header_len < 16 || header_len > tag_len {
        return None;
    }
    Some(tag[header_len..tag_len].to_vec())
}

fn anlz_tag_body(tag: &[u8]) -> Option<Vec<u8>> {
    if tag.len() < 12 {
        return None;
    }
    let header_len = be_u32(tag.get(4..8)?) as usize;
    let tag_len = be_u32(tag.get(8..12)?) as usize;
    if header_len < 12 || header_len > tag_len || tag_len > tag.len() {
        return None;
    }
    Some(tag[header_len..tag_len].to_vec())
}

fn cue_points_ext_from_pco2_tag(tag: &[u8]) -> Option<CuePointsExt> {
    if tag.len() < 20 || tag.get(0..4)? != b"PCO2" {
        return None;
    }
    let header_len = be_u32(tag.get(4..8)?) as usize;
    let tag_len = (be_u32(tag.get(8..12)?) as usize).min(tag.len());
    if header_len < 20 || header_len > tag_len {
        return None;
    }
    let declared_count = u16::from_be_bytes(tag.get(16..18)?.try_into().ok()?) as usize;
    let mut entries = Vec::new();
    let mut offset = header_len;
    let mut count = 0usize;
    while offset + 16 <= tag_len && count < declared_count {
        if tag.get(offset..offset + 4)? != b"PCP2" {
            return None;
        }
        let entry_len = be_u32(tag.get(offset + 8..offset + 12)?) as usize;
        if entry_len < 32 || offset + entry_len > tag_len {
            return None;
        }
        if let Some(entry) = cue_points_ext_wire_entry_from_pcp2(&tag[offset..offset + entry_len]) {
            entries.extend_from_slice(&entry);
            count += 1;
        }
        offset += entry_len;
    }
    Some(CuePointsExt {
        entries,
        entry_count: count as u32,
    })
}

fn cue_points_ext_wire_entry_from_pcp2(entry: &[u8]) -> Option<Vec<u8>> {
    let hot_cue = be_u32(entry.get(12..16)?) as u8;
    let cue_type = *entry.get(16)?;
    if cue_type != 1 && cue_type != 2 {
        return None;
    }
    let time_ms = be_u32(entry.get(20..24)?);
    let loop_ms = if cue_type == 2 {
        be_u32(entry.get(24..28)?)
    } else {
        u32::MAX
    };
    let color_id = entry.get(28).copied().unwrap_or_default();
    let mut out = vec![0u8; 56];
    let out_len = out.len() as u32;
    out[0..4].copy_from_slice(&out_len.to_le_bytes());
    out[4] = hot_cue;
    out[6] = cue_type;
    out[8..12].copy_from_slice(&[0x00, 0x00, 0xe8, 0x03]);
    out[12..16].copy_from_slice(&time_ms.to_le_bytes());
    out[16..20].copy_from_slice(&loop_ms.to_le_bytes());
    out[0x22] = color_id;
    Some(out)
}

fn nexus_cue_entries_from_pcob_tag(tag: &[u8]) -> Option<(u32, Vec<u8>, u32)> {
    if tag.len() < 24 || tag.get(0..4)? != b"PCOB" {
        return None;
    }
    let tag_len = (be_u32(tag.get(8..12)?) as usize).min(tag.len());
    if tag_len < 24 {
        return None;
    }
    let cue_type = be_u32(tag.get(12..16)?);
    let declared_count = u16::from_be_bytes(tag.get(18..20)?.try_into().ok()?) as usize;
    let mut entries = Vec::new();
    let mut offset = 24usize;
    let mut count = 0usize;
    while offset + 40 <= tag_len && count < declared_count {
        if tag.get(offset..offset + 4)? != b"PCPT" {
            return None;
        }
        let entry_len = be_u32(tag.get(offset + 8..offset + 12)?) as usize;
        if entry_len < 40 || offset + entry_len > tag_len {
            return None;
        }
        if let Some(entry) = nexus_cue_wire_entry_from_pcpt(&tag[offset..offset + entry_len]) {
            entries.extend_from_slice(&entry);
            count += 1;
        }
        offset += entry_len;
    }
    Some((cue_type, entries, count as u32))
}

fn nexus_cue_wire_entry_from_pcpt(entry: &[u8]) -> Option<[u8; 36]> {
    let hot_cue = be_u32(entry.get(12..16)?) as u8;
    let cue_type = *entry.get(28)?;
    if cue_type != 1 && cue_type != 2 {
        return None;
    }
    let time_ms = be_u32(entry.get(32..36)?);
    let loop_ms = if cue_type == 2 {
        be_u32(entry.get(36..40)?)
    } else {
        0
    };
    let mut out = [0u8; 36];
    out[0] = u8::from(cue_type == 2);
    out[1] = 1;
    out[2] = hot_cue;
    out[12..16].copy_from_slice(&time_ms_to_half_frames(time_ms).to_le_bytes());
    out[16..20].copy_from_slice(&time_ms_to_half_frames(loop_ms).to_le_bytes());
    Some(out)
}

fn time_ms_to_half_frames(ms: u32) -> u32 {
    ((u64::from(ms) * 150 + 500) / 1000).min(u64::from(u32::MAX)) as u32
}

fn waveform_preview_from_pwav_tag(tag: &[u8], pwv2_tag: Option<&[u8]>) -> Option<Vec<u8>> {
    if tag.get(0..4)? != b"PWAV" {
        return None;
    }
    let body = anlz_tag_body(tag)?;
    if body.len() != 400 {
        return None;
    }
    let tiny = pwv2_tag.and_then(tiny_waveform_from_pwv2_tag);
    let tiny_len = tiny.as_ref().map_or(100, Vec::len);
    let mut out = Vec::with_capacity(800 + tiny_len.max(104));
    for value in &body {
        out.push(value & 0x1f);
        out.push(value >> 5);
    }
    if let Some(tiny) = tiny {
        out.extend_from_slice(&tiny);
    } else {
        for chunk in body.chunks_exact(4) {
            let height = chunk.iter().map(|value| value & 0x1f).max().unwrap_or(0);
            let whiteness = chunk.iter().map(|value| value >> 5).max().unwrap_or(0);
            out.push((whiteness << 4) | (height >> 1));
        }
    }
    if out.len() == 900 {
        out.extend_from_slice(&[0, 0, 0, 0]);
    }
    Some(out)
}

fn waveform_detail_from_pwv3_tag(tag: &[u8]) -> Option<Vec<u8>> {
    if tag.len() < 24 || tag.get(0..4)? != b"PWV3" {
        return None;
    }
    let tag_len = (be_u32(tag.get(8..12)?) as usize).min(tag.len());
    if tag_len < 24 {
        return None;
    }
    let entry_bytes = be_u32(tag.get(12..16)?) as usize;
    if entry_bytes == 0 {
        return None;
    }
    let declared_entries = be_u32(tag.get(16..20)?) as usize;
    let available_entries = (tag_len - 24) / entry_bytes;
    let entry_count = declared_entries.min(available_entries);
    let entry_len = entry_count.checked_mul(entry_bytes)?;
    let entries = tag.get(24..24 + entry_len)?;
    let mut native_unknown = be_u32(tag.get(20..24)?);
    if native_unknown & 0x0000_ffff == 0 {
        native_unknown >>= 16;
    }

    let mut out = Vec::with_capacity(20 + entries.len());
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    out.extend_from_slice(&(entry_bytes as u32).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u32).to_le_bytes());
    out.extend_from_slice(&native_unknown.to_le_bytes());
    out.extend_from_slice(&1u32.to_le_bytes());
    out.extend_from_slice(entries);
    Some(out)
}

fn tiny_waveform_from_pwv2_tag(tag: &[u8]) -> Option<Vec<u8>> {
    if tag.get(0..4)? != b"PWV2" {
        return None;
    }
    let header_len = be_u32(tag.get(4..8)?) as usize;
    let tag_len = (be_u32(tag.get(8..12)?) as usize).min(tag.len());
    let entries_len = be_u32(tag.get(12..16)?) as usize;
    if header_len < 20 || header_len > tag_len || tag_len - header_len < entries_len {
        return None;
    }
    Some(tag[header_len..tag_len].to_vec())
}

fn fourcc_from_le_u32(value: u32) -> String {
    value
        .to_le_bytes()
        .into_iter()
        .take_while(|byte| *byte != 0)
        .map(char::from)
        .collect()
}

fn fourcc_le_padded(value: &str) -> LinkResult<u32> {
    let bytes = value.as_bytes();
    if bytes.len() > 4 {
        return Err(LinkError::FourccTooLong {
            value: value.to_string(),
        });
    }
    let mut padded = [0u8; 4];
    padded[..bytes.len()].copy_from_slice(bytes);
    Ok(u32::from_le_bytes(padded))
}

fn spawn_portmap(
    state: Arc<ServerState>,
    sock: Arc<UdpSocket>,
    mount_port: u16,
) -> TokioJoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        loop {
            let Ok((len, addr)) = sock.recv_from(&mut buf).await else {
                continue;
            };
            let Some(call) = rpc_parse_call(&buf[..len]) else {
                continue;
            };
            if call.prog != RPC_PORTMAP_PROG || call.proc != PORTMAP_GETPORT {
                continue;
            }
            if call.payload_off + 16 > len {
                continue;
            }
            let req_prog = be_u32(&buf[call.payload_off..call.payload_off + 4]);
            let req_vers = be_u32(&buf[call.payload_off + 4..call.payload_off + 8]);
            let req_prot = be_u32(&buf[call.payload_off + 8..call.payload_off + 12]);
            let port = portmap_getport(req_prog, req_vers, req_prot, mount_port);
            trace!(
                target: "djtools_link::rpc",
                %addr,
                xid = call.xid,
                prog = req_prog,
                vers = req_vers,
                prot = req_prot,
                port,
                "portmap_getport"
            );
            let mut reply = rpc_reply_header(call.xid);
            reply.extend_from_slice(&(port as u32).to_be_bytes());
            if let SocketAddr::V4(addr) = addr {
                let _ = send_udp_packet(&state, &sock, &reply, addr, "portmap reply").await;
            }
        }
    })
}

fn spawn_mount(state: Arc<ServerState>, sock: Arc<UdpSocket>) -> TokioJoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        loop {
            let Ok((len, addr)) = sock.recv_from(&mut buf).await else {
                continue;
            };
            let call = rpc_parse_call(&buf[..len]);
            if let Some(call) = &call {
                trace!(
                    target: "djtools_link::rpc",
                    %addr,
                    xid = call.xid,
                    prog = call.prog,
                    vers = call.vers,
                    proc = call.proc,
                    bytes = len,
                    "mount_request"
                );
            }
            if let Some(reply) = handle_mount_packet(&state, &buf[..len]).await {
                if let SocketAddr::V4(addr) = addr {
                    let _ = send_udp_packet(&state, &sock, &reply, addr, "mount reply").await;
                }
            }
        }
    })
}

fn spawn_nfs(state: Arc<ServerState>, sock: Arc<UdpSocket>) -> TokioJoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = [0u8; 65536];
        loop {
            let Ok((len, addr)) = sock.recv_from(&mut buf).await else {
                continue;
            };
            handle_nfs_datagram_reply(&state, &sock, &buf[..len], addr).await;
        }
    })
}

async fn handle_nfs_datagram_reply(
    state: &ServerState,
    sock: &UdpSocket,
    data: &[u8],
    addr: SocketAddr,
) {
    let Some(reply) = handle_nfs_datagram(state, data, addr).await else {
        return;
    };
    let SocketAddr::V4(addr) = addr else {
        return;
    };
    if let Err(err) = send_udp_packet(state, sock, &reply, addr, "nfs reply").await {
        debug!(target: "djtools_link::nfs", %addr, %err, "nfs_reply_failed");
    }
}

fn hex_prefix(input: &[u8], max_len: usize) -> String {
    let mut out = String::with_capacity(max_len.min(input.len()) * 2);
    for byte in input.iter().take(max_len) {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

fn spawn_startup_hello(state: Arc<ServerState>, sock: Arc<UdpSocket>) -> TokioJoinHandle<()> {
    tokio::spawn(async move { send_startup_hello(&state, &sock).await })
}

async fn send_startup_hello(state: &ServerState, sock: &UdpSocket) {
    let target = SocketAddrV4::new(state.broadcast_ip, KEEPALIVE_PORT);
    for sequence in 1..=3 {
        let packet =
            build_keepalive_discovery_packet(&state.config.model_name, state.bind_ip, sequence);
        if let Err(err) = send_udp_packet(state, sock, &packet, target, "startup discovery").await {
            debug!(target: "djtools_link::udp", %target, %err, "startup_discovery_failed");
        }
    }
    for marker in [0x11, 0x12, 0x29, 0x2a, 0x2b, 0x2c] {
        let packet = build_keepalive_ip_packet(
            &state.config.model_name,
            state.bind_ip,
            &state.mac_addr,
            marker,
            KeepaliveKind::IdUse,
        );
        if let Err(err) = send_udp_packet(state, sock, &packet, target, "startup id-use").await {
            debug!(target: "djtools_link::udp", %target, %err, "startup_id_use_failed");
        }
    }
    let packet = build_keepalive_status_packet(
        &state.config.model_name,
        state.config.player_number,
        state.bind_ip,
        &state.mac_addr,
        state.device_count().await,
    );
    if let Err(err) = send_udp_packet(state, sock, &packet, target, "startup keepalive").await {
        debug!(target: "djtools_link::udp", %target, %err, "startup_keepalive_failed");
    }
}

async fn send_startup_link_init(state: &ServerState, sock: &UdpSocket) {
    send_link_init_broadcast(state, sock, "status startup link-init").await;
}

async fn send_load_settings_packet(
    state: &ServerState,
    sock: &UdpSocket,
    target_player: u8,
    target_ip: Ipv4Addr,
    context: &'static str,
) -> bool {
    if !state.config.auto_unlock_load_lock || !(1..=6).contains(&target_player) {
        return false;
    }
    let packet = build_status_load_settings_command(
        &state.config.model_name,
        state.config.player_number,
        target_player,
        &[],
    );
    let target = SocketAddrV4::new(target_ip, STATUS_PORT);
    match send_udp_packet(state, sock, &packet, target, context).await {
        Ok(_) => {
            if context.contains("refresh") {
                tracing::debug!(
                    target: "djtools_link::load",
                    target_player,
                    %target_ip,
                    context,
                    "load_settings_sent"
                );
            } else {
                tracing::info!(
                    target: "djtools_link::load",
                    target_player,
                    %target_ip,
                    context,
                    "load_settings_sent"
                );
            }
            true
        }
        Err(err) => {
            tracing::warn!(
                target: "djtools_link::load",
                target_player,
                %target_ip,
                context,
                %err,
                "load_settings_send_failed"
            );
            false
        }
    }
}

async fn send_link_init_once(state: &ServerState, sock: &UdpSocket, ip: Ipv4Addr, context: &str) {
    if !state.should_send_link_init(ip).await {
        return;
    }

    let packet = build_status_link_init(&state.config.model_name, state.config.player_number);
    let target = SocketAddrV4::new(ip, STATUS_PORT);
    match send_udp_packet(state, sock, &packet, target, context).await {
        Ok(_) => {}
        Err(err) => {
            debug!(
                target: "djtools_link::udp",
                context,
                %target,
                %err,
                "udp_unicast_failed"
            );
        }
    }
}

async fn send_link_init_broadcast(state: &ServerState, sock: &UdpSocket, context: &str) {
    let packet = build_status_link_init(&state.config.model_name, state.config.player_number);
    let target = SocketAddrV4::new(state.broadcast_ip, STATUS_PORT);
    let _ = send_udp_packet(state, sock, &packet, target, context).await;
    state.mark_link_init_broadcast().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, thiserror::Error)]
    enum TestDbParseError {
        #[error(transparent)]
        Io(#[from] std::io::Error),
        #[error("expected DB {expected} field")]
        ExpectedField { expected: &'static str },
        #[error("unsupported test DB field 0x{field:02x}")]
        UnsupportedField { field: u8 },
    }

    type TestDbResult<T> = std::result::Result<T, TestDbParseError>;

    #[test]
    fn config_defaults_to_deck_owned_beat_clock() {
        let config = DjLinkConfig::default();
        assert!(!config.emit_beat_clock);
        assert!(!config.tcp_track_file_side_channel);
        assert!(config.serve_extended_anlz_tags);
        assert_eq!(config.announce_interval, FAST_ANNOUNCE_INTERVAL);
    }

    #[test]
    fn keepalive_status_roundtrip_parse() {
        let packet = build_keepalive_status_packet(
            "rekordbox",
            17,
            Ipv4Addr::new(192, 168, 10, 55),
            "aa:bb:cc:dd:ee:ff",
            1,
        );
        let device = parse_keepalive_device(&packet).expect("device");
        assert_eq!(device.player_number, 17);
        assert_eq!(device.ip_addr, Ipv4Addr::new(192, 168, 10, 55));
        assert_eq!(device.mac_addr, "aa:bb:cc:dd:ee:ff");
        assert_eq!(device.model, "rekordbox");
    }

    #[test]
    fn status_load_track_layout_matches_reference_offsets() {
        let packet = build_status_load_track_command(
            "rekordbox",
            17,
            1,
            17,
            SLOT_REKORDBOX,
            TRACK_TYPE_REKORDBOX,
            123456,
            false,
            &[],
        );
        assert_eq!(&packet[..10], DJLINK_MAGIC);
        assert_eq!(packet[10], STATUS_TYPE_LOAD_CMD);
        assert_eq!(packet[0x1f + 0x02], 17);
        assert_eq!(packet[0x1f + 0x05], 17);
        assert_eq!(packet[0x1f + 0x09], 17);
        assert_eq!(packet[0x1f + 0x0a], SLOT_REKORDBOX);
        assert_eq!(packet[0x1f + 0x0b], TRACK_TYPE_REKORDBOX);
        assert_eq!(packet[0x1f + 0x21], 0);
        assert_eq!(packet[0x1f + 0x01], 0);
        assert_eq!(packet[0x1f + 0x14], 0x32);
        assert_eq!(packet[0x1f + 0x2c], 0);
        assert_eq!(&packet[0x1f + 0x0d..0x1f + 0x11], &123456u32.to_be_bytes());

        let override_variant = build_status_load_track_command(
            "rekordbox",
            17,
            1,
            17,
            SLOT_REKORDBOX,
            TRACK_TYPE_REKORDBOX,
            123456,
            false,
            &[(0x14, 0x02)],
        );
        assert_eq!(override_variant[0x1f + 0x14], 0x02);

        let rekordbox_variant = build_status_load_track_command(
            "rekordbox",
            17,
            1,
            17,
            SLOT_REKORDBOX,
            TRACK_TYPE_REKORDBOX,
            123456,
            true,
            &[],
        );
        assert_eq!(rekordbox_variant[0x1f + 0x01], 1);
        assert_eq!(rekordbox_variant[0x1f + 0x2c], 0x32);
        assert_eq!(
            &rekordbox_variant[0x1f + 0x0d..0x1f + 0x11],
            &123456u32.to_be_bytes()
        );
    }

    #[test]
    fn load_payload_overrides_are_explicit_only() {
        let mut state = test_state_with_sample_library(123);
        let track_id = state.library.all_tracks[0].track_id;

        let overrides = load_payload_overrides_for_track(&state, track_id);
        assert!(overrides.is_empty());

        let overrides = load_payload_overrides_for_track_with_extra(
            &state,
            track_id,
            &[(LOAD_CONTEXT_OFFSET, LOAD_CONTEXT_ARTIST_MENU)],
        );
        assert_eq!(
            overrides,
            vec![(LOAD_CONTEXT_OFFSET, LOAD_CONTEXT_ARTIST_MENU)]
        );

        state.config.load_payload_byte_overrides = vec![(0x14, 0x02)];
        let overrides = load_payload_overrides_for_track(&state, track_id);
        assert_eq!(overrides, vec![(0x14, 0x02)]);

        let overrides =
            load_payload_overrides_for_track_with_extra(&state, track_id, &[(0x14, 0x05)]);
        assert_eq!(overrides, vec![(0x14, 0x02)]);
    }

    #[test]
    fn pending_render_session_uses_only_the_last_menu_prepared_on_its_connection() {
        let key = 0x0302_0401;
        let mut session = PendingRenderSession::default();
        let playlist_rows = (1..=19)
            .map(|idx| MenuEntry::plain(0, idx, &format!("Track {idx}"), "", META_TITLE))
            .collect::<Vec<_>>();
        let metadata_rows = (1..=16)
            .map(|idx| MenuEntry::plain(0, idx, &format!("Metadata {idx}"), "", META_TITLE))
            .collect::<Vec<_>>();

        session.prepare(Some(key), playlist_rows);
        session.prepare(Some(key), metadata_rows);

        let stale_playlist = session.entries_for_render(
            Some(key),
            RenderWindow {
                offset: 0,
                count: 16,
                total: 19,
            },
        );
        assert!(
            stale_playlist.is_none(),
            "a later setup request replaces the prior menu on this DB connection"
        );

        let metadata = session
            .entries_for_render(
                Some(key),
                RenderWindow {
                    offset: 0,
                    count: 16,
                    total: 16,
                },
            )
            .expect("latest prepared metadata rows");
        assert_eq!(metadata.len(), 16);
        assert_eq!(metadata[0].text1, "Metadata 1");
    }

    #[test]
    fn pending_render_session_requires_the_prepared_rmst_context() {
        let prepared_key = 0x0302_0401;
        let requested_key = 0x0303_0401;
        let mut session = PendingRenderSession::default();
        session.prepare(
            Some(prepared_key),
            (1..=17)
                .map(|idx| MenuEntry::plain(0, idx, &format!("Track {idx}"), "", META_TITLE))
                .collect(),
        );

        let changed_context = session.entries_for_render(
            Some(requested_key),
            RenderWindow {
                offset: 1,
                count: 1,
                total: 17,
            },
        );
        assert!(
            changed_context.is_none(),
            "RENDER must use the r:m:s:t context of the preceding menu request"
        );

        let same_context = session
            .entries_for_render(
                Some(prepared_key),
                RenderWindow {
                    offset: 1,
                    count: 1,
                    total: 17,
                },
            )
            .expect("same-session render rows");
        assert_eq!(same_context[1].text1, "Track 2");
    }

    #[test]
    fn pending_render_sessions_isolate_parallel_connections_from_one_deck() {
        let key = 0x0302_0401;
        let mut browse = PendingRenderSession::default();
        let mut metadata = PendingRenderSession::default();
        browse.prepare(
            Some(key),
            (1..=17)
                .map(|idx| MenuEntry::plain(0, idx, &format!("Track {idx}"), "", META_TITLE))
                .collect(),
        );
        metadata.prepare(
            Some(key),
            (1..=16)
                .map(|idx| MenuEntry::plain(0, idx, &format!("Metadata {idx}"), "", META_TITLE))
                .collect(),
        );

        let browse_rows = browse
            .entries_for_render(
                Some(key),
                RenderWindow {
                    offset: 1,
                    count: 1,
                    total: 17,
                },
            )
            .expect("browse connection rows");
        let metadata_rows = metadata
            .entries_for_render(
                Some(key),
                RenderWindow {
                    offset: 0,
                    count: 16,
                    total: 16,
                },
            )
            .expect("metadata connection rows");
        assert_eq!(browse_rows[1].text1, "Track 2");
        assert_eq!(metadata_rows[0].text1, "Metadata 1");
    }

    #[test]
    fn render_menu_header_echoes_nonzero_offset_like_native_rekordbox() {
        let bytes = render_messages(
            0x1883,
            2,
            &[MenuEntry::plain(
                0,
                35_667_088,
                "Abandonment Issues",
                "",
                META_TITLE,
            )],
        );
        let mut cursor = std::io::Cursor::new(bytes);
        let header = recv_db_message_from_read(&mut cursor).expect("menu header");
        assert_eq!(header.tx_id, 0x1883);
        assert_eq!(header.msg_type, DB_RES_MENU_HEADER);
        assert_eq!(header.args, vec![DbValue::Int32(1), DbValue::Int32(2)]);
        let item = recv_db_message_from_read(&mut cursor).expect("menu item");
        assert_eq!(item.msg_type, DB_RES_MENU_ITEM);
        assert_eq!(db_int(item.args.get(1)), Some(35_667_088));
        let footer = recv_db_message_from_read(&mut cursor).expect("menu footer");
        assert_eq!(footer.msg_type, DB_RES_MENU_FOOTER);
    }

    #[test]
    fn pending_render_session_rejects_a_total_from_another_menu() {
        let key = 0x0302_0401;
        let mut session = PendingRenderSession::default();
        session.prepare(
            Some(key),
            (1..=17)
                .map(|idx| MenuEntry::plain(0, idx, &format!("Track {idx}"), "", META_TITLE))
                .collect(),
        );
        let wrong_total = session.entries_for_render(
            Some(key),
            RenderWindow {
                offset: 0,
                count: 16,
                total: 19,
            },
        );
        assert!(wrong_total.is_none());
    }

    #[test]
    fn status_load_settings_layout_matches_documented_offsets() {
        let packet = build_status_load_settings_command("rekordbox", 17, 3, &[]);
        assert_eq!(packet.len(), 0x74);
        assert_eq!(&packet[..10], DJLINK_MAGIC);
        assert_eq!(packet[10], STATUS_TYPE_LOAD_SETTINGS);
        assert_eq!(&packet[0x0b..0x14], b"rekordbox");
        assert_eq!(packet[0x1f], 0x02);
        assert_eq!(packet[0x20], 17);
        assert_eq!(packet[0x21], 3);
        assert_eq!(&packet[0x22..0x24], &0x0050u16.to_be_bytes());
        assert_eq!(
            &packet[0x24..0x2c],
            &[0x12, 0x34, 0x56, 0x78, 0x00, 0x00, 0x00, 0x03]
        );
        assert_eq!(packet[0x38], 0x82); // Disc slot illumination bright.
        assert_eq!(packet[0x39], 0x80); // Eject/load lock off.
        assert_eq!(packet[0x3a], 0x80); // Sync off.
        assert_eq!(packet[0x3b], 0x80); // Autoplay/continue.
        assert_eq!(packet[0x3c], 0x80); // Quantize full beat.
        assert_eq!(packet[0x3d], 0x82); // Hot Cue Auto Load: track setting.
        assert_eq!(packet[0x3e], 0x81); // Hot Cue Color on.
        assert_eq!(packet[0x46], 0x80); // Auto Cue off.
        assert_eq!(packet[0x48], 0x81); // Tempo range +/- 10.
    }

    #[test]
    fn status_load_settings_payload_overrides_are_explicit() {
        let packet =
            build_status_load_settings_command("rekordbox", 17, 3, &[(0x47, 0x81), (0xff, 0x01)]);

        assert_eq!(packet[0x47], 0x81); // Master Tempo on.
        assert_eq!(packet[0x48], 0x81); // Neighboring tempo range unchanged.
        assert_eq!(packet.len(), 0x74);
    }

    #[test]
    fn private_status_command_builders_match_rekordbox_offsets() {
        let hot_cue = build_hot_cue_bank_req_command("rekordbox", 17, 0x1122_3344);
        assert_eq!(hot_cue.len(), 0x2c);
        assert_eq!(&hot_cue[..10], DJLINK_MAGIC);
        assert_eq!(hot_cue[10], STATUS_TYPE_HOT_CUE_BANK_REQ);
        assert_eq!(&hot_cue[0x0b..0x14], b"rekordbox");
        assert_eq!(&hot_cue[0x1f..0x24], &[0x01, 0x01, 17, 0x00, 0x08]);
        assert_eq!(hot_cue[0x24], 17);
        assert_eq!(&hot_cue[0x28..0x2c], &0x1122_3344u32.to_be_bytes());

        let cdj = build_cdj_renew_command("rekordbox", 17, 0x03, 0x1122_3344, 0x5566_7788);
        assert_eq!(cdj.len(), 0x30);
        assert_eq!(cdj[10], STATUS_TYPE_CDJ_RENEW);
        assert_eq!(&cdj[0x1f..0x24], &[0x01, 0x01, 17, 0x00, 0x0c]);
        assert_eq!(cdj[0x24], 17);
        assert_eq!(cdj[0x25], 0x03);
        assert_eq!(&cdj[0x28..0x2c], &0x1122_3344u32.to_be_bytes());
        assert_eq!(&cdj[0x2c..0x30], &0x5566_7788u32.to_be_bytes());

        let cue = build_cue_renew_command("rekordbox", 17, 3, 0x1122_3344);
        assert_eq!(cue.len(), 0x30);
        assert_eq!(cue[10], STATUS_TYPE_CUE_RENEW);
        assert_eq!(&cue[0x1f..0x24], &[0x01, 0x01, 17, 0x00, 0x0c]);
        assert_eq!(cue[0x24], 17);
        assert_eq!(cue[0x28], 3);
        assert_eq!(&cue[0x29..0x2b], &[0x04, 0x01]);
        assert_eq!(&cue[0x2c..0x30], &0x1122_3344u32.to_be_bytes());

        let wave = build_multi_wave_view_req_command("rekordbox", 17, 0x1122_3344, 2, 3, 4, 5);
        assert_eq!(wave.len(), 0x2c);
        assert_eq!(wave[10], STATUS_TYPE_MULTI_WAVE_VIEW_REQ);
        assert_eq!(&wave[0x1f..0x24], &[0x01, 0x00, 17, 0x00, 0x08]);
        assert_eq!(&wave[0x24..0x28], &0x1122_3344u32.to_le_bytes());
        assert_eq!(&wave[0x28..0x2c], &[2, 3, 4, 5]);
    }

    #[test]
    fn tcp_track_file_side_channel_packets_match_rekordbox_constructors() {
        let connect = build_tcp_device_connect_packet(17, "djtools-link@169.254.1.2");
        assert_eq!(connect.len(), 0x68);
        assert_eq!(&connect[..10], DJLINK_MAGIC);
        assert_eq!(connect[10], TCP_TYPE_DEVICE_CONNECT);
        assert_eq!(&connect[0x0b..0x14], b"rekordbox");
        assert_eq!(connect[0x1f], 0x01);
        assert_eq!(connect[0x20], 0x01);
        assert_eq!(&connect[0x22..0x24], &0x0044u16.to_be_bytes());
        assert_eq!(&connect[0x24..0x28], &17u32.to_be_bytes());
        assert_eq!(&connect[0x28..0x40], b"djtools-link@169.254.1.2");

        let mobile = build_tcp_mobile_connect_req2_packet("djtools-link@169.254.1.2");
        assert_eq!(&mobile[..10], DJLINK_MAGIC);
        assert_eq!(mobile[10], TCP_TYPE_MOBILE_CONNECT_REQ2);
        assert_eq!(&mobile[0x0b..0x14], b"rekordbox");
        assert_eq!(mobile[0x1f], 0x01);
        assert_eq!(&mobile[0x22..0x24], &0x001c_u16.to_be_bytes());
        assert_eq!(&mobile[0x24..0x28], &0x0018_u32.to_be_bytes());
        assert_eq!(&mobile[0x28..], b"djtools-link@169.254.1.2");

        let send = build_tcp_send_track_file_path_packet(
            "rekordbox",
            0x1122_3344,
            0x5566_7788,
            0x99aa_bbcc_ddee_ff00,
        );
        assert_eq!(send.len(), 0x34);
        assert_eq!(&send[..10], DJLINK_MAGIC);
        assert_eq!(send[10], STATUS_TYPE_LOAD_CMD);
        assert_eq!(send[0x1f], 0x01);
        assert_eq!(&send[0x22..0x24], &0x0010u16.to_be_bytes());
        assert_eq!(&send[0x24..0x28], &0x1122_3344u32.to_be_bytes());
        assert_eq!(&send[0x28..0x2c], &0x5566_7788u32.to_be_bytes());
        assert_eq!(&send[0x2c..0x34], &0x99aa_bbcc_ddee_ff00u64.to_be_bytes());

        let get = build_tcp_get_track_file_req_packet("rekordbox", 0x0102_0304, 0x0506_0708);
        assert_eq!(get.len(), 0x2c);
        assert_eq!(&get[..10], DJLINK_MAGIC);
        assert_eq!(get[10], STATUS_TYPE_LOAD_ACK);
        assert_eq!(get[0x1f], 0x01);
        assert_eq!(&get[0x22..0x24], &0x0008u16.to_be_bytes());
        assert_eq!(&get[0x24..0x28], &0x0102_0304u32.to_be_bytes());
        assert_eq!(&get[0x28..0x2c], &0x0506_0708u32.to_be_bytes());
    }

    #[test]
    fn status_link_reply_matches_reference_shape() {
        let packet =
            build_status_link_reply("rekordbox", 17, SLOT_REKORDBOX, "rekordbox", 15227, 3);
        assert_eq!(packet.len(), 192);
        assert_eq!(&packet[..10], DJLINK_MAGIC);
        assert_eq!(packet[10], status::StatusKind::LinkReply.raw());
        assert_eq!(packet[33], 17);
        assert_eq!(&packet[36..40], &17u32.to_be_bytes());
        assert_eq!(packet[43], SLOT_REKORDBOX);
        assert_eq!(&packet[166..168], &15227u16.to_be_bytes());
        assert_eq!(packet[0xaa], TRACK_TYPE_REKORDBOX);
        assert_eq!(&packet[174..176], &3u16.to_be_bytes());
        assert_eq!(
            &packet[168..],
            &decode_hex("000001010000000300000000000000000000000000000000")
        );
    }

    #[test]
    fn real_cdj_extension_query_produces_exact_rekordbox_reply() {
        let request =
            decode_hex(include_str!("../tests/fixtures/cdj3000-extension-query-46.hex").trim());
        let expected =
            decode_hex(include_str!("../tests/fixtures/rekordbox-mystery-47.hex").trim());
        assert_eq!(
            build_status_extension_reply(&request, "rekordbox", 17),
            Some(expected)
        );
        assert_eq!(
            build_status_extension_reply(
                &decode_hex(include_str!("../tests/fixtures/rekordbox-link-init.hex").trim()),
                "rekordbox",
                17,
            ),
            None
        );
    }

    #[test]
    fn raw_udp_frame_has_valid_ipv4_header() {
        let frame = build_ethernet_ipv4_udp_frame(
            [0x02, 0x00, 0x00, 0x00, 0x00, 0x01],
            [0x24, 0x97, 0xed, 0x24, 0x4a, 0x55],
            Ipv4Addr::new(169, 254, 92, 233),
            STATUS_PORT,
            Ipv4Addr::new(169, 254, 6, 175),
            STATUS_PORT,
            b"abc",
        )
        .expect("frame");
        assert_eq!(&frame[..6], &[0x24, 0x97, 0xed, 0x24, 0x4a, 0x55]);
        assert_eq!(&frame[6..12], &[0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);
        assert_eq!(&frame[12..14], &0x0800u16.to_be_bytes());
        assert_eq!(frame[14], 0x45);
        assert_eq!(frame[23], 17);
        assert_eq!(internet_checksum(&frame[14..34]), 0);
        assert_eq!(u16::from_be_bytes([frame[34], frame[35]]), STATUS_PORT);
        assert_eq!(u16::from_be_bytes([frame[36], frame[37]]), STATUS_PORT);
        assert_eq!(&frame[42..45], b"abc");
    }

    #[test]
    fn raw_udp_frames_fragment_oversized_payload_for_mtu() {
        let payload = vec![0x5a; 5000];
        let frames = build_ethernet_ipv4_udp_frames(
            [0x02, 0x00, 0x00, 0x00, 0x00, 0x01],
            [0x24, 0x97, 0xed, 0x24, 0x4a, 0x55],
            Ipv4Addr::new(169, 254, 92, 233),
            NFS_PORT,
            Ipv4Addr::new(169, 254, 6, 175),
            NFS_PORT,
            &payload,
            0x1234,
            1500,
        )
        .expect("frames");
        assert!(frames.len() > 1);

        let mut reassembled = Vec::new();
        for (index, frame) in frames.iter().enumerate() {
            let ip_len = u16::from_be_bytes([frame[16], frame[17]]) as usize;
            assert!(ip_len <= 1500);
            assert_eq!(u16::from_be_bytes([frame[18], frame[19]]), 0x1234);
            assert_eq!(internet_checksum(&frame[14..34]), 0);
            let flags_offset = u16::from_be_bytes([frame[20], frame[21]]);
            if index + 1 < frames.len() {
                assert_ne!(flags_offset & 0x2000, 0);
            } else {
                assert_eq!(flags_offset & 0x2000, 0);
            }
            assert_eq!(((flags_offset & 0x1fff) as usize) * 8, reassembled.len());
            reassembled.extend_from_slice(&frame[34..]);
        }

        assert_eq!(
            u16::from_be_bytes([reassembled[0], reassembled[1]]),
            NFS_PORT
        );
        assert_eq!(
            u16::from_be_bytes([reassembled[2], reassembled[3]]),
            NFS_PORT
        );
        assert_eq!(
            u16::from_be_bytes([reassembled[4], reassembled[5]]) as usize,
            8 + payload.len()
        );
        assert_eq!(&reassembled[8..], payload.as_slice());
    }

    #[test]
    fn oversized_udp_payloads_use_direct_raw_fragmentation() {
        assert!(!udp_payload_needs_raw_fragmentation(&vec![
            0;
            RAW_IPV4_MTU - 28
        ]));
        assert!(udp_payload_needs_raw_fragmentation(&vec![
            0;
            RAW_IPV4_MTU - 27
        ]));
    }

    #[test]
    fn address_unavailable_unicast_uses_raw_mac_fallback() {
        let err = std::io::Error::from_raw_os_error(49);
        assert!(udp_unicast_needs_raw_fallback(&err));
        assert!(!udp_unicast_needs_broadcast_fallback(&err));
    }

    #[test]
    fn raw_tcp_frame_has_valid_ipv4_and_tcp_checksums() {
        let src_ip = Ipv4Addr::new(169, 254, 196, 252);
        let dst_ip = Ipv4Addr::new(169, 254, 7, 4);
        let frame = build_ethernet_ipv4_tcp_frame(
            [0xc8, 0x3d, 0xfc, 0x15, 0x71, 0xed],
            [0x24, 0x97, 0xed, 0x24, 0x4a, 0x66],
            src_ip,
            45_123,
            dst_ip,
            STATUS_PORT,
            0x1122_3344,
            0x5566_7788,
            TCP_FLAG_ACK | TCP_FLAG_PSH,
            b"hello",
            0x2345,
        )
        .expect("tcp frame");
        assert_eq!(&frame[..6], &[0x24, 0x97, 0xed, 0x24, 0x4a, 0x66]);
        assert_eq!(&frame[6..12], &[0xc8, 0x3d, 0xfc, 0x15, 0x71, 0xed]);
        assert_eq!(&frame[12..14], &0x0800u16.to_be_bytes());
        assert_eq!(frame[23], 6);
        assert_eq!(internet_checksum(&frame[14..34]), 0);
        assert_eq!(u16::from_be_bytes([frame[34], frame[35]]), 45_123);
        assert_eq!(u16::from_be_bytes([frame[36], frame[37]]), STATUS_PORT);
        assert_eq!(&frame[54..59], b"hello");
        let ip_len = u16::from_be_bytes([frame[16], frame[17]]) as usize;
        assert_eq!(tcp_checksum(src_ip, dst_ip, &frame[34..14 + ip_len]), 0);
    }

    #[test]
    fn raw_arp_reply_advertises_spoof_source_ip() {
        let frame = build_ethernet_arp_reply_frame(
            [0xc8, 0x3d, 0xfc, 0x15, 0x71, 0xed],
            [0x24, 0x97, 0xed, 0x24, 0x4a, 0x66],
            Ipv4Addr::new(169, 254, 196, 252),
            Ipv4Addr::new(169, 254, 7, 4),
        );
        assert_eq!(frame.len(), 60);
        assert_eq!(&frame[12..14], &0x0806u16.to_be_bytes());
        assert_eq!(&frame[20..22], &2u16.to_be_bytes());
        assert_eq!(&frame[22..28], &[0xc8, 0x3d, 0xfc, 0x15, 0x71, 0xed]);
        assert_eq!(&frame[28..32], &[169, 254, 196, 252]);
        assert_eq!(&frame[38..42], &[169, 254, 7, 4]);
    }

    #[test]
    fn db_message_roundtrip_body_shape() {
        let msg = encode_db_message(
            7,
            DB_REQ_PLAYLIST,
            &[
                DbValue::Int32(0x1122_3344),
                DbValue::Int32(0),
                DbValue::Int32(42),
                DbValue::Int32(1),
            ],
        );
        let mut cursor = std::io::Cursor::new(msg);
        let parsed = recv_db_message_from_read(&mut cursor).expect("parse");
        assert_eq!(parsed.tx_id, 7);
        assert_eq!(parsed.msg_type, DB_REQ_PLAYLIST);
        assert_eq!(parsed.args.len(), 4);
        assert_eq!(db_int(parsed.args.first()), Some(0x1122_3344));
    }

    #[test]
    fn db_root_and_sort_menu_shapes_match_reference_capture() {
        let root = root_menu_entries();
        assert_eq!(root.len(), 10);
        assert_eq!(
            root.iter()
                .map(|entry| (entry.entry_id2, entry.text1.as_str(), entry.entry_type))
                .collect::<Vec<_>>(),
            vec![
                (2, "ARTIST", 0x0081),
                (3, "ALBUM", 0x0082),
                (4, "TRACK", META_ROOT_TRACK),
                (12, "KEY", 0x008b),
                (5, "PLAYLIST", META_ROOT_PLAYLIST),
                (ROOT_HISTORY_ID, "HISTORY", 0x0095),
                (ROOT_SEARCH_ID, "SEARCH", 0x0091),
                (ROOT_MATCHING_ID, "MATCHING", 0x00aa),
                (ROOT_DATE_ADDED_ID, "DATE ADDED", 0x008c),
                (ROOT_COLOR_ID, "COLOR", 0x008e),
            ]
        );
        let root_preview = menu_entries_preview(&root);
        for watched in ["HISTORY", "SEARCH", "MATCHING", "DATE ADDED", "COLOR"] {
            assert!(
                root_preview.contains(watched),
                "root preview should include watched row {watched}"
            );
        }

        let sort = sort_menu_entries();
        assert_eq!(sort.len(), 9);
        assert_eq!(
            sort.iter()
                .map(|entry| (entry.entry_id2, entry.text1.as_str(), entry.entry_type))
                .collect::<Vec<_>>(),
            vec![
                (0, "DEFAULT", 0x00a1),
                (1, "ALPHABET", 0x00a2),
                (2, "ARTIST", 0x0081),
                (3, "ALBUM", 0x0082),
                (4, "BPM", 0x0085),
                (5, "RATING", 0x0086),
                (12, "KEY", 0x008b),
                (15, "COLOR", 0x008e),
                (SORT_DATE_ADDED, "DATE ADDED", 0x008c),
            ]
        );
    }

    #[test]
    fn db_metadata_and_mount_info_keep_rekordbox_row_counts() {
        let track = sample_track_record();
        let library = LibrarySnapshot {
            master_db_id: 0x0102_0304,
            tracks_by_id: [(track.track_id, track.clone())].into_iter().collect(),
            all_tracks: vec![track.clone()],
            playlists: Vec::new(),
        };

        let metadata = metadata_entries(&library, &[DbValue::Int32(track.track_id)]);
        assert_eq!(metadata.len(), 16);
        assert_eq!(metadata[0].text1, track.title);
        assert_eq!(metadata[0].entry_type, META_TITLE);
        assert_eq!(metadata[1].text1, track.artist);
        assert_eq!(metadata[1].entry_type, META_ARTIST);
        assert_eq!(metadata[2].text1, track.album);
        assert_eq!(metadata[2].entry_type, META_ALBUM);
        assert_eq!(metadata[4].entry_id2, track.bpm_hundreds);
        assert_eq!(metadata[4].entry_type, META_BPM);
        assert_eq!(metadata[8].entry_type, META_GENRE);
        assert_eq!(metadata[10].text1, track.comment);
        assert_eq!(metadata[10].entry_type, META_COMMENT);

        let mount_info = mount_info_entries(&library, &[DbValue::Int32(track.track_id)]);
        assert_eq!(mount_info.len(), 7);
        assert_eq!(mount_info[4].entry_id1, track.artwork_id);
        assert_eq!(mount_info[4].text1, track.mount_path.to_string_lossy());
        assert_eq!(mount_info[4].entry_type, META_MOUNT_PATH);
        assert_eq!(mount_info[6].text1, track.key);
        assert_eq!(mount_info[6].entry_type, META_KEY);
    }

    #[test]
    fn db_mount_path_row_falls_back_to_track_id_when_artwork_id_is_zero() {
        let mut track = sample_track_record();
        track.artwork_id = 0;
        track.artwork_url = None;
        let library = LibrarySnapshot {
            master_db_id: 0x0102_0304,
            tracks_by_id: [(track.track_id, track.clone())].into_iter().collect(),
            all_tracks: vec![track.clone()],
            playlists: Vec::new(),
        };

        let mount_info = mount_info_entries(&library, &[DbValue::Int32(track.track_id)]);
        assert_eq!(mount_info[4].entry_id1, track.track_id);
        assert_eq!(mount_info[4].entry_id2, track.track_id);
    }

    #[test]
    fn db_artwork_request_resolves_artwork_id_after_rmst_arg() {
        let track = sample_track_record();
        let library = LibrarySnapshot {
            master_db_id: 0x0102_0304,
            tracks_by_id: [(track.track_id, track.clone())].into_iter().collect(),
            all_tracks: vec![track.clone()],
            playlists: Vec::new(),
        };

        let resolved = track_from_artwork_request(
            &library,
            &[
                DbValue::Int32(0x1104_0401),
                DbValue::Int32(track.artwork_id),
            ],
        )
        .expect("artwork track");
        assert_eq!(resolved.track_id, track.track_id);
    }

    #[tokio::test]
    async fn local_artwork_path_finds_track_sidecar() {
        let temp = tempfile::tempdir().expect("tempdir");
        let track_doc = temp.path().join("Artist - Track.md");
        let audio = temp.path().join("Artist - Track.mp3");
        let artwork = temp.path().join("Artist - Track.jpg");
        std::fs::write(&track_doc, b"doc").expect("doc");
        std::fs::write(&audio, b"audio").expect("audio");
        std::fs::write(&artwork, b"jpeg").expect("artwork");

        assert_eq!(
            local_artwork_path(&track_doc, &audio, None)
                .await
                .as_deref(),
            Some(artwork.as_path())
        );
    }

    #[test]
    fn deck_artwork_is_a_native_sized_jpeg() {
        let source = image::DynamicImage::new_rgb8(640, 480);
        let mut source_jpeg = Vec::new();
        JpegEncoder::new_with_quality(&mut source_jpeg, 95)
            .encode_image(&source)
            .expect("source jpeg");

        let normalized = normalize_deck_artwork(&source_jpeg).expect("normalized artwork");
        let decoded = image::load_from_memory(&normalized).expect("decode normalized artwork");

        assert_eq!(decoded.width(), DECK_ARTWORK_EDGE_PX);
        assert_eq!(decoded.height(), DECK_ARTWORK_EDGE_PX);
        assert!(normalized.starts_with(&[0xff, 0xd8]));
        assert!(normalize_deck_artwork(b"not an image").is_none());
    }

    #[test]
    fn db_empty_artwork_response_omits_binary_field_like_native() {
        let msg = blob_response(0x77, DB_REQ_ARTWORK, DB_RES_ARTWORK, None);
        assert_eq!(msg.len(), 39);
        assert_eq!(
            msg,
            decode_hex(
                "11872349ae11000000771040020f04140000000406060603110000200311000000001100000000"
            )
        );
    }

    #[test]
    fn db_default_extended_cue_points_payload_matches_native_empty_shape() {
        let payload = default_extended_cue_points_payload();
        assert_eq!(payload.len(), 56);
        assert_eq!(
            payload,
            [
                0x38, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0xe8, 0x03, 0x4d, 0x00,
                0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            ]
        );
    }

    #[test]
    fn db_extended_cue_points_blob_uses_native_entry_count() {
        let payload = default_extended_cue_points_payload();
        let msg = cue_points_ext_response(0x1d59, DB_REQ_CUE_POINTS_EXT, payload.as_slice(), 1);
        let mut cursor = std::io::Cursor::new(msg);
        let parsed = recv_db_message_from_read(&mut cursor).expect("parse");
        assert_eq!(parsed.tx_id, 0x1d59);
        assert_eq!(parsed.msg_type, DB_RES_CUE_POINTS_EXT);
        assert_eq!(
            parsed.args,
            vec![
                DbValue::Int32(DB_REQ_CUE_POINTS_EXT as u32),
                DbValue::Int32(0),
                DbValue::Int32(56),
                DbValue::Binary(payload),
                DbValue::Int32(1),
            ]
        );
    }

    #[test]
    fn cue_points_ext_converts_pco2_entries_to_db_wire_shape() {
        let first = test_pcp2_entry(3, 2, 1_000, 2_000, 5);
        let second = test_pcp2_entry(0, 1, 5_000, 0, 7);
        let mut tag = Vec::new();
        tag.extend_from_slice(b"PCO2");
        tag.extend_from_slice(&20u32.to_be_bytes());
        tag.extend_from_slice(&((20 + first.len() + second.len()) as u32).to_be_bytes());
        tag.extend_from_slice(&0u32.to_be_bytes());
        tag.extend_from_slice(&2u16.to_be_bytes());
        tag.extend_from_slice(&0u16.to_be_bytes());
        tag.extend_from_slice(&first);
        tag.extend_from_slice(&second);

        let converted = cue_points_ext_from_pco2_tag(&tag).expect("converted");
        assert_eq!(converted.entry_count, 2);
        assert_eq!(converted.entries.len(), 112);
        assert_eq!(
            u32::from_le_bytes(converted.entries[0..4].try_into().unwrap()),
            56
        );
        assert_eq!(converted.entries[4], 3);
        assert_eq!(converted.entries[6], 2);
        assert_eq!(
            u32::from_le_bytes(converted.entries[12..16].try_into().unwrap()),
            1_000
        );
        assert_eq!(
            u32::from_le_bytes(converted.entries[16..20].try_into().unwrap()),
            2_000
        );
        assert_eq!(converted.entries[0x22], 5);
        assert_eq!(converted.entries[56 + 4], 0);
        assert_eq!(converted.entries[56 + 6], 1);
        assert_eq!(
            u32::from_le_bytes(converted.entries[56 + 12..56 + 16].try_into().unwrap()),
            5_000
        );
        assert_eq!(
            u32::from_le_bytes(converted.entries[56 + 16..56 + 20].try_into().unwrap()),
            u32::MAX
        );
        assert_eq!(converted.entries[56 + 0x22], 7);
    }

    #[test]
    fn db_cue_points_response_uses_native_nexus_two_blob_shape() {
        let first = vec![0x11; 36];
        let second = vec![0x22; 72];
        let msg = cue_points_response(0x1d58, DB_REQ_CUE_POINTS, Some(&first), Some(&second), 2, 1);
        let parsed = recv_db_message_from_read(&mut msg.as_slice()).expect("parse");
        assert_eq!(parsed.tx_id, 0x1d58);
        assert_eq!(parsed.msg_type, DB_RES_CUE_POINTS);
        assert_eq!(
            parsed.args,
            vec![
                DbValue::Int32(DB_REQ_CUE_POINTS as u32),
                DbValue::Int32(0),
                DbValue::Int32(first.len() as u32),
                DbValue::Binary(first),
                DbValue::Int32(0x24),
                DbValue::Int32(2),
                DbValue::Int32(1),
                DbValue::Int32(second.len() as u32),
                DbValue::Binary(second),
            ]
        );
    }

    #[test]
    fn cue_points_converts_pcob_entries_to_nexus_wire_shape() {
        let tag = test_pcob_tag(1, &[test_pcpt_entry(2, 2, 1_000, 3_000)]);

        let (cue_type, converted, count) =
            nexus_cue_entries_from_pcob_tag(&tag).expect("converted");
        assert_eq!(cue_type, 1);
        assert_eq!(count, 1);
        assert_eq!(converted.len(), 36);
        assert_eq!(converted[0], 1);
        assert_eq!(converted[1], 1);
        assert_eq!(converted[2], 2);
        assert_eq!(
            u32::from_le_bytes(converted[12..16].try_into().unwrap()),
            150
        );
        assert_eq!(
            u32::from_le_bytes(converted[16..20].try_into().unwrap()),
            450
        );
    }

    #[tokio::test]
    async fn cue_points_prefers_nonempty_ext_pcob_when_dat_pcob_is_empty() {
        let temp = tempfile::tempdir().expect("tempdir");
        let dat_path = temp.path().join("ANLZ0000.DAT");
        let ext_path = temp.path().join("ANLZ0000.EXT");
        write_test_anlz_sections(&dat_path, &[test_pcob_tag(1, &[]), test_pcob_tag(0, &[])]);
        write_test_anlz_sections(
            &ext_path,
            &[test_pcob_tag(1, &[test_pcpt_entry(4, 1, 2_000, 0)])],
        );
        let track = TrackRecord {
            track_id: 42,
            title: "Track One".to_string(),
            artist: "Artist One".to_string(),
            artist_id: stable_text_id("Artist One"),
            canonical_name: "Artist One - Track One".to_string(),
            album: String::new(),
            album_id: 0,
            duration_sec: 0,
            bpm_hundreds: 0,
            key: String::new(),
            camelot: String::new(),
            key_id: 0,
            bitrate_kbps: 0,
            comment: String::new(),
            mount_path: PathBuf::from("/tmp/Track One.mp3"),
            analysis_dat_path: Some(dat_path),
            analysis_ext_path: Some(ext_path),
            analysis_twoex_path: None,
            artwork_id: 0,
            artwork_url: None,
            genre: String::new(),
            genre_id: 0,
            label: String::new(),
            year: 0,
            date_added_id: 0,
            date_added: String::new(),
        };
        let library = LibrarySnapshot {
            master_db_id: 0x0102_0304,
            tracks_by_id: [(track.track_id, track.clone())].into_iter().collect(),
            all_tracks: vec![track],
            playlists: Vec::new(),
        };

        let cues = load_cue_points(&library, &[DbValue::Int32(42)])
            .await
            .expect("cues");
        assert_eq!(cues.hot_count, 1);
        assert_eq!(cues.memory_count, 0);
        assert_eq!(cues.second.len(), 36);
        assert_eq!(cues.second[2], 4);
    }

    #[test]
    fn db_vbr_payload_uses_native_2504_shape() {
        let mut tag = Vec::new();
        tag.extend_from_slice(b"PVBR");
        tag.extend_from_slice(&16u32.to_be_bytes());
        tag.extend_from_slice(&28u32.to_be_bytes());
        tag.extend_from_slice(&[1, 2, 3, 4]);
        tag.extend_from_slice(&[5, 6, 7, 8, 9, 10, 11, 12]);

        assert_eq!(
            vbr_payload_from_pvbr_tag(&tag).expect("payload"),
            vec![5, 6, 7, 8, 9, 10, 11, 12]
        );
        let fallback = default_vbr_payload();
        assert_eq!(fallback.len(), 1604);
        assert!(fallback.iter().all(|byte| *byte == 0));

        let msg = blob_response(
            0x1d5d,
            0x2504,
            DB_RES_EXT_2504,
            Some(default_vbr_payload().as_slice()),
        );
        let mut cursor = std::io::Cursor::new(msg);
        let parsed = recv_db_message_from_read(&mut cursor).expect("parse");
        assert_eq!(parsed.tx_id, 0x1d5d);
        assert_eq!(parsed.msg_type, DB_RES_EXT_2504);
        assert_eq!(parsed.args.len(), 4);
        assert_eq!(parsed.args[0], DbValue::Int32(0x2504));
        assert_eq!(parsed.args[2], DbValue::Int32(1604));
    }

    #[test]
    fn db_waveform_preview_upload_extracts_deck_preview_cache() {
        let track = sample_track_record();
        let library = LibrarySnapshot {
            master_db_id: 0x0102_0304,
            tracks_by_id: [(track.track_id, track.clone())].into_iter().collect(),
            all_tracks: vec![track.clone()],
            playlists: Vec::new(),
        };
        let preview = vec![0x1f; 900];
        let parsed = waveform_preview_upload(
            &library,
            &[
                DbValue::Int32(0x0308_0401),
                DbValue::Int32(0),
                DbValue::Int32(track.track_id),
                DbValue::Int32(0),
                DbValue::Int32(preview.len() as u32),
                DbValue::Binary(preview.clone()),
            ],
        )
        .expect("upload");

        assert_eq!(parsed, (track.track_id, preview));
        assert_eq!(
            success_with_count(0x3d, DB_REQ_WAVEFORM_PREVIEW_UPLOAD, 0),
            encode_db_message(
                0x3d,
                DB_RES_SUCCESS,
                &[
                    DbValue::Int32(DB_REQ_WAVEFORM_PREVIEW_UPLOAD as u32),
                    DbValue::Int32(0),
                ],
            )
        );
    }

    #[test]
    fn db_beat_grid_payload_converts_pqtz_to_wire_grid() {
        let mut tag = Vec::new();
        tag.extend_from_slice(b"PQTZ");
        tag.extend_from_slice(&24u32.to_be_bytes());
        tag.extend_from_slice(&48u32.to_be_bytes());
        tag.extend_from_slice(&0u32.to_be_bytes());
        tag.extend_from_slice(&0x0008_0000u32.to_be_bytes());
        tag.extend_from_slice(&2u32.to_be_bytes());
        tag.extend_from_slice(&[0x00, 0x01, 0x31, 0xa3]);
        tag.extend_from_slice(&432u32.to_be_bytes());
        tag.extend_from_slice(&[0x00, 0x02, 0x31, 0xa4]);
        tag.extend_from_slice(&912u32.to_be_bytes());

        let payload = beat_grid_from_pqtz_tag(&tag).expect("payload");
        assert_eq!(payload.len(), 52);
        assert_eq!(&payload[0..4], &0x0008_0000u32.to_le_bytes());
        assert_eq!(&payload[4..8], &2u32.to_le_bytes());
        assert_eq!(&payload[8..12], &32u32.to_le_bytes());
        assert_eq!(&payload[12..16], &1u32.to_le_bytes());
        assert_eq!(&payload[16..20], &1u32.to_le_bytes());
        assert_eq!(&payload[20..22], &1u16.to_le_bytes());
        assert_eq!(&payload[22..24], &0x31a3u16.to_le_bytes());
        assert_eq!(&payload[24..28], &432u32.to_le_bytes());
        assert_eq!(&payload[28..36], &[0xff; 8]);
        assert_eq!(&payload[36..38], &2u16.to_le_bytes());
        assert_eq!(&payload[38..40], &0x31a4u16.to_le_bytes());
        assert_eq!(&payload[40..44], &912u32.to_le_bytes());
        assert_eq!(&payload[44..52], &[0xff; 8]);
    }

    #[test]
    fn db_beat_grid_response_uses_native_four_arg_blob_shape() {
        let payload = vec![0x11; 52];
        let msg = blob_response(0x5a, DB_REQ_BEAT_GRID, DB_RES_BEAT_GRID, Some(&payload));
        let parsed = recv_db_message_from_read(&mut msg.as_slice()).expect("response");

        assert_eq!(parsed.tx_id, 0x5a);
        assert_eq!(parsed.msg_type, DB_RES_BEAT_GRID);
        assert_eq!(
            parsed.args,
            vec![
                DbValue::Int32(DB_REQ_BEAT_GRID as u32),
                DbValue::Int32(0),
                DbValue::Int32(payload.len() as u32),
                DbValue::Binary(payload),
            ]
        );
    }

    #[test]
    fn db_empty_beat_grid_response_omits_binary_field() {
        assert_eq!(
            blob_response(0x5b, DB_REQ_BEAT_GRID, DB_RES_BEAT_GRID, None),
            empty_blob_response(0x5b, DB_REQ_BEAT_GRID, DB_RES_BEAT_GRID, false)
        );
    }

    #[test]
    fn db_waveform_preview_converts_pwav_to_904_byte_wire_shape() {
        let mut tag = Vec::new();
        tag.extend_from_slice(b"PWAV");
        tag.extend_from_slice(&20u32.to_be_bytes());
        tag.extend_from_slice(&420u32.to_be_bytes());
        tag.extend_from_slice(&400u32.to_be_bytes());
        tag.extend_from_slice(&0x0010_0000u32.to_be_bytes());
        tag.extend((0..400).map(|idx| ((idx % 8) << 5 | (idx % 32)) as u8));

        let payload = waveform_preview_from_pwav_tag(&tag, None).expect("payload");
        assert_eq!(payload.len(), 904);
        assert_eq!(payload[0], 0);
        assert_eq!(payload[1], 0);
        assert_eq!(payload[2], 1);
        assert_eq!(payload[3], 1);
        assert_eq!(payload[800], 0x31);
        assert_eq!(payload[899] >> 4, 7);
        assert_eq!(&payload[900..904], &[0, 0, 0, 0]);
    }

    #[test]
    fn db_waveform_preview_uses_pwv2_tiny_tail_when_present() {
        let mut pwav = Vec::new();
        pwav.extend_from_slice(b"PWAV");
        pwav.extend_from_slice(&20u32.to_be_bytes());
        pwav.extend_from_slice(&420u32.to_be_bytes());
        pwav.extend_from_slice(&400u32.to_be_bytes());
        pwav.extend_from_slice(&0x0010_0000u32.to_be_bytes());
        pwav.extend((0..400).map(|idx| ((idx % 8) << 5 | (idx % 32)) as u8));

        let mut pwv2 = Vec::new();
        pwv2.extend_from_slice(b"PWV2");
        pwv2.extend_from_slice(&20u32.to_be_bytes());
        pwv2.extend_from_slice(&124u32.to_be_bytes());
        pwv2.extend_from_slice(&100u32.to_be_bytes());
        pwv2.extend_from_slice(&0x0010_0000u32.to_be_bytes());
        let tiny = (0..100).map(|idx| idx as u8).collect::<Vec<_>>();
        pwv2.extend_from_slice(&tiny);
        pwv2.extend_from_slice(&[0xaa, 0xbb, 0xcc, 0xdd]);

        let payload = waveform_preview_from_pwav_tag(&pwav, Some(&pwv2)).expect("payload");
        assert_eq!(payload.len(), 904);
        assert_eq!(&payload[800..900], tiny.as_slice());
        assert_eq!(&payload[900..904], &[0xaa, 0xbb, 0xcc, 0xdd]);
    }

    #[tokio::test]
    async fn server_new_keeps_render_and_audio_paths_lazy() {
        let temp = tempfile::tempdir().expect("tempdir");
        let dat_path = temp.path().join("ANLZ0000.DAT");
        let audio_path = temp.path().join("track.mp3");
        std::fs::write(&audio_path, [0x55; 4096]).expect("audio");
        let mut pwav = Vec::new();
        pwav.extend_from_slice(b"PWAV");
        pwav.extend_from_slice(&20u32.to_be_bytes());
        pwav.extend_from_slice(&420u32.to_be_bytes());
        pwav.extend_from_slice(&400u32.to_be_bytes());
        pwav.extend_from_slice(&0x0010_0000u32.to_be_bytes());
        pwav.extend_from_slice(&[0x21; 400]);
        write_test_anlz_sections(&dat_path, &[pwav]);
        let mut track = sample_track_record();
        track.mount_path = audio_path.clone();
        track.analysis_dat_path = Some(dat_path.clone());
        track.analysis_ext_path = None;
        track.analysis_twoex_path = None;
        let library = LibrarySnapshot {
            master_db_id: 0x0102_0304,
            tracks_by_id: [(track.track_id, track.clone())].into_iter().collect(),
            all_tracks: vec![track.clone()],
            playlists: Vec::new(),
        };

        let server = DjLinkServer::new(DjLinkConfig::default(), library)
            .await
            .expect("server");
        assert_eq!(server.library_track_count(), 1);
        assert_eq!(server.first_track_id(), Some(track.track_id));
    }

    #[tokio::test]
    async fn load_profile_measures_warmed_render_and_audio_paths() {
        let temp = tempfile::tempdir().expect("tempdir");
        let audio_path = temp.path().join("track.mp3");
        let dat_path = temp.path().join("ANLZ0000.DAT");
        let ext_path = temp.path().join("ANLZ0000.EXT");
        let twoex_path = temp.path().join("ANLZ0000.2EX");
        std::fs::write(&audio_path, [0x55; 4096]).expect("audio");

        let mut pwav = Vec::new();
        pwav.extend_from_slice(b"PWAV");
        pwav.extend_from_slice(&20u32.to_be_bytes());
        pwav.extend_from_slice(&420u32.to_be_bytes());
        pwav.extend_from_slice(&400u32.to_be_bytes());
        pwav.extend_from_slice(&0x0010_0000u32.to_be_bytes());
        pwav.extend_from_slice(&[0x21; 400]);
        let mut pwv3 = Vec::new();
        pwv3.extend_from_slice(b"PWV3");
        pwv3.extend_from_slice(&24u32.to_be_bytes());
        pwv3.extend_from_slice(&30u32.to_be_bytes());
        pwv3.extend_from_slice(&1u32.to_be_bytes());
        pwv3.extend_from_slice(&6u32.to_be_bytes());
        pwv3.extend_from_slice(&0x0096_0000u32.to_be_bytes());
        pwv3.extend_from_slice(&[0xac, 0x74, 0x0a, 0x6e, 0x37, 0x39]);
        write_test_anlz_sections(
            &dat_path,
            &[
                pwav,
                pwv3,
                test_pqtz_tag(&[(1, 12_700, 2), (2, 12_700, 474)]),
            ],
        );
        write_test_anlz_sections(
            &ext_path,
            &[
                test_pqt2_tag(2, 474),
                test_simple_anlz_tag(b"PSSI", &[5, 6, 7, 8]),
                test_simple_anlz_tag(b"PWV4", &[9, 10, 11, 12]),
                test_simple_anlz_tag(b"PWV5", &[13, 14, 15, 16]),
            ],
        );
        write_test_anlz_tags(
            &twoex_path,
            &[(b"PWV6", &[17, 18, 19, 20]), (b"PWV7", &[21, 22, 23, 24])],
        );

        let mut track = sample_track_record();
        track.mount_path = audio_path;
        track.analysis_dat_path = Some(dat_path);
        track.analysis_ext_path = Some(ext_path);
        track.analysis_twoex_path = Some(twoex_path);
        let library = LibrarySnapshot {
            master_db_id: 0x0102_0304,
            tracks_by_id: [(track.track_id, track.clone())].into_iter().collect(),
            all_tracks: vec![track.clone()],
            playlists: Vec::new(),
        };
        let config = DjLinkConfig {
            serve_extended_anlz_tags: true,
            ..DjLinkConfig::default()
        };
        let server = DjLinkServer::new(config, library).await.expect("server");
        let profile = server
            .profile_track_load(track.track_id)
            .await
            .expect("profile");

        assert_eq!(profile.waveform_preview_bytes, Some(904));
        assert_eq!(profile.waveform_detail_bytes, Some(26));
        assert_eq!(profile.beat_grid_bytes, Some(52));
        assert_eq!(profile.nfs_bytes, 4096);
        assert_eq!(profile.nfs_chunks, 1);
        assert!(
            profile
                .extended_tags
                .iter()
                .any(|tag| tag.tag == "PWV4" && tag.bytes.is_some())
        );
        assert!(
            profile
                .extended_tags
                .iter()
                .any(|tag| tag.tag == "PWV5" && tag.bytes.is_some())
        );
        assert!(
            profile
                .extended_tags
                .iter()
                .any(|tag| tag.tag == "PWV6" && tag.bytes.is_some())
        );
        assert!(
            profile
                .extended_tags
                .iter()
                .any(|tag| tag.tag == "PWV7" && tag.bytes.is_some())
        );
        assert!(
            profile
                .extended_tags
                .iter()
                .any(|tag| tag.tag == "PSSI" && tag.bytes.is_some())
        );
    }

    #[test]
    fn db_waveform_detail_converts_pwv3_to_native_header_shape() {
        let mut tag = Vec::new();
        tag.extend_from_slice(b"PWV3");
        tag.extend_from_slice(&24u32.to_be_bytes());
        tag.extend_from_slice(&30u32.to_be_bytes());
        tag.extend_from_slice(&1u32.to_be_bytes());
        tag.extend_from_slice(&6u32.to_be_bytes());
        tag.extend_from_slice(&0x0096_0000u32.to_be_bytes());
        tag.extend_from_slice(&[0xac, 0x74, 0x0a, 0x6e, 0x37, 0x39]);

        let payload = waveform_detail_from_pwv3_tag(&tag).expect("payload");
        assert_eq!(payload.len(), 26);
        assert_eq!(&payload[0..4], &6u32.to_le_bytes());
        assert_eq!(&payload[4..8], &1u32.to_le_bytes());
        assert_eq!(&payload[8..12], &6u32.to_le_bytes());
        assert_eq!(&payload[12..16], &0x96u32.to_le_bytes());
        assert_eq!(&payload[16..20], &1u32.to_le_bytes());
        assert_eq!(&payload[20..26], &[0xac, 0x74, 0x0a, 0x6e, 0x37, 0x39]);
    }

    #[test]
    fn cdj_status_snapshot_decodes_tempo_and_loop_fields() {
        let mut packet = vec![0u8; 0x200];
        packet[..10].copy_from_slice(DJLINK_MAGIC);
        packet[10] = 0x0a;
        packet[0x21] = 3;
        packet[0x27] = 1;
        packet[0x28] = 17;
        packet[0x29] = SLOT_REKORDBOX;
        packet[0x2a] = TRACK_TYPE_REKORDBOX;
        packet[0x2c..0x30].copy_from_slice(&482230066u32.to_be_bytes());
        packet[0x32..0x34].copy_from_slice(&17u16.to_be_bytes());
        packet[0x35] = SORT_DATE_ADDED as u8;
        packet[0x37] = 0x05;
        packet[0x38..0x3c].copy_from_slice(&123u32.to_be_bytes());
        packet[0x3c..0x40].copy_from_slice(&456u32.to_be_bytes());
        packet[0x46..0x48].copy_from_slice(&68u16.to_be_bytes());
        packet[0x7b] = 3;
        packet[0x89] = 0x78;
        packet[0x8b] = 0x7a;
        packet[0x8c..0x90].copy_from_slice(&0x0010_8000u32.to_be_bytes());
        packet[0x92..0x94].copy_from_slice(&12_200u16.to_be_bytes());
        packet[0x98..0x9c].copy_from_slice(&0x0010_8000u32.to_be_bytes());
        packet[0x9d] = 0x09;
        packet[0x9e] = 1;
        packet[0x9f] = 0xff;
        packet[0xa6] = 4;
        packet[0x158] = 1;
        packet[0x15c..0x15f].copy_from_slice(&[9, 0, 0]);
        packet[0x164..0x16c].copy_from_slice(&100i64.to_be_bytes());
        packet[0x113] = 0x80;
        packet[0x116..0x118].copy_from_slice(&512u16.to_be_bytes());
        packet[0x11a..0x11c].copy_from_slice(&128u16.to_be_bytes());
        packet[0x11d] = 0x44;
        packet[0x11e] = 0x11;
        packet[0x1b6..0x1ba].copy_from_slice(&1_000u32.to_be_bytes());
        packet[0x1be..0x1c2].copy_from_slice(&2_000u32.to_be_bytes());
        packet[0x1c8..0x1ca].copy_from_slice(&8u16.to_be_bytes());

        let status = parse_cdj_status(&packet).expect("status");
        assert_eq!(status.player, 3);
        assert_eq!(status.track_id, 482230066);
        assert_eq!(status.track_position, 17);
        assert_eq!(status.sort_state, SORT_DATE_ADDED as u8);
        assert_eq!(status.source_menu, 0x05);
        assert_eq!(status.source_category_1, 123);
        assert_eq!(status.source_category_2, 456);
        assert_eq!(status.menu_track_count, 68);
        assert_eq!(status.p4, Some(0x80));
        assert_eq!(status.bar_steps, Some(512));
        assert_eq!(status.bar_position, Some(128));
        assert_eq!(status.buffer_forward, Some(0x44));
        assert_eq!(status.buffer_back, Some(0x11));
        assert_eq!(pitch_percent(status.pitch_1), 3.125);
        assert_eq!(
            effective_bpm_hundreds(status.bpm_hundreds, status.pitch_1),
            Some(12_581)
        );
        assert_eq!(status.loop_beats, Some(8));
        assert_eq!(status.loop_summary(), "65536ms..131072ms beats=8");
    }

    #[tokio::test]
    async fn monitor_snapshot_returns_latest_deck_telemetry_summaries() {
        let state = test_state();
        assert!(
            state
                .record_status(test_cdj_status(REKORDBOX_PLAYER_NUMBER, 42, 0x03))
                .await
        );
        assert!(
            state
                .record_beat(
                    CdjBeatSnapshot {
                        player: 3,
                        len_rest: 0x003c,
                        next_beat_ms: 461,
                        second_beat_ms: 922,
                        next_bar_ms: 461,
                        fourth_beat_ms: 1845,
                        second_bar_ms: 2306,
                        eighth_beat_ms: 3689,
                        pitch: 0x100000,
                        bpm_hundreds: 12_300,
                        beat_in_bar: 1,
                    },
                    Instant::now(),
                )
                .await
        );
        assert!(
            state
                .record_position(CdjPositionSnapshot {
                    player: 3,
                    len_rest: 0x18,
                    track_length_sec: 367,
                    playhead_ms: 123_456,
                    pitch_centi_percent: 326,
                    effective_bpm_tenths: 1_202,
                },)
                .await
        );

        let snapshot = state.monitor_snapshot(3).await;
        assert!(snapshot.status.expect("status").contains("track_id=42"));
        assert!(snapshot.beat.expect("beat").contains("bpm=123.00"));
        assert!(
            snapshot
                .position
                .expect("position")
                .contains("playhead=123456ms")
        );
        assert_eq!(
            state.monitor_snapshot(4).await,
            DjLinkMonitorSnapshot::default()
        );
    }

    #[tokio::test]
    async fn server_state_actor_path_records_live_telemetry() {
        let state = test_state();

        assert!(
            state
                .record_device(LinkDevice {
                    player_number: 3,
                    ip_addr: Ipv4Addr::new(169, 254, 7, 4),
                    mac_addr: "24:97:ed:24:4a:66".to_string(),
                    model: "CDJ-3000".to_string(),
                    last_seen: Instant::now(),
                })
                .await
        );
        assert_eq!(state.devices_sorted().await[0].player_number, 3);
        assert!(
            state
                .record_status(test_cdj_status(REKORDBOX_PLAYER_NUMBER, 42, 0x03))
                .await
        );
        assert!(
            state
                .record_beat(
                    CdjBeatSnapshot {
                        player: 3,
                        len_rest: 0x003c,
                        next_beat_ms: 461,
                        second_beat_ms: 922,
                        next_bar_ms: 461,
                        fourth_beat_ms: 1845,
                        second_bar_ms: 2306,
                        eighth_beat_ms: 3689,
                        pitch: 0x100000,
                        bpm_hundreds: 12_300,
                        beat_in_bar: 1,
                    },
                    Instant::now()
                )
                .await
        );
        assert!(
            state
                .record_position(CdjPositionSnapshot {
                    player: 3,
                    len_rest: 0x18,
                    track_length_sec: 367,
                    playhead_ms: 123_456,
                    pitch_centi_percent: 326,
                    effective_bpm_tenths: 1_202,
                })
                .await
        );

        let snapshot = state.monitor_snapshot(3).await;
        assert!(snapshot.status.expect("status").contains("track_id=42"));
        assert!(snapshot.beat.expect("beat").contains("bpm=123.00"));
        assert!(
            snapshot
                .position
                .expect("position")
                .contains("playhead=123456ms")
        );
        assert!(player_status_snapshot(&state, 3).await.is_some());
    }

    #[test]
    fn cdj_status_log_worthy_change_ignores_render_jitter() {
        let previous = CdjStatusSnapshot {
            player: 3,
            active: 0,
            source_player: REKORDBOX_PLAYER_NUMBER,
            source_slot: SLOT_REKORDBOX,
            track_type: TRACK_TYPE_REKORDBOX,
            track_id: 482230066,
            track_position: 17,
            sort_state: SORT_DATE_ADDED as u8,
            source_menu: 0x05,
            source_category_1: 123,
            source_category_2: 456,
            menu_track_count: 68,
            flags: 0xa4,
            play_state_1: 3,
            play_state_2: 0xfa,
            play_state_3: 0x09,
            pitch_1: 0x0010_8000,
            pitch_2: 0x0010_8000,
            bpm_hundreds: 12_200,
            beat_in_bar: 1,
            master_meaningful: 1,
            master_handoff: 0xff,
            master_tempo: Some(1),
            key: Some([9, 0, 0]),
            key_shift_cents: Some(100),
            p4: Some(0x80),
            bar_steps: Some(512),
            bar_position: Some(128),
            buffer_forward: Some(0x44),
            buffer_back: Some(0x11),
            loop_start_raw: Some(0),
            loop_end_raw: Some(0),
            loop_beats: Some(0),
        };

        let mut jitter = previous.clone();
        jitter.bpm_hundreds += 1;
        jitter.beat_in_bar = 4;
        jitter.bar_position = Some(129);
        jitter.buffer_forward = Some(0x45);
        jitter.buffer_back = Some(0x12);
        assert!(!jitter.log_worthy_change_from(&previous));

        let mut tempo = previous.clone();
        tempo.pitch_1 += 1;
        assert!(tempo.log_worthy_change_from(&previous));

        let mut looped = previous.clone();
        looped.loop_start_raw = Some(1_000);
        looped.loop_end_raw = Some(2_000);
        looped.loop_beats = Some(8);
        assert!(looped.log_worthy_change_from(&previous));
    }

    #[test]
    fn cdj_status_labels_cover_playing_and_looping_states() {
        assert_eq!(cdj_play_state_1_label(0x02), "loading");
        assert_eq!(cdj_play_state_1_label(0x03), "playing");
        assert_eq!(cdj_play_state_1_label(0x04), "looping");
        assert_eq!(cdj_play_state_1_label(0x05), "paused");
        assert_eq!(cdj_play_state_1_label(0x06), "cued");
        assert_eq!(cdj_play_state_1_label(0x10), "moving-alt");
        assert_eq!(cdj_play_state_2_label(0x7a), "moving");
        assert_eq!(cdj_play_state_2_label(0x7e), "stopped");
        assert_eq!(cdj_play_state_2_label(0xfe), "stopped-alt");
        assert_eq!(cdj_play_state_3_label(0x09), "forward-vinyl");
        assert_eq!(cdj_play_state_3_label(0x0d), "forward-cdj");
        assert_eq!(cdj_source_menu_label(0x02), "artist-menu");
        assert_eq!(cdj_source_menu_label(0x05), "playlist");
        assert_eq!(
            cdj_source_menu_label(0x32),
            "instant-double-or-previous-track"
        );
    }

    #[test]
    fn cdj_status_playing_accepts_cdj3000_alt_moving_state() {
        let mut paused = test_cdj_status(REKORDBOX_PLAYER_NUMBER, 42, 0x05);
        paused.play_state_2 = 0xfe;
        paused.play_state_3 = 0x01;
        assert!(!status_is_playing(&paused));

        let mut alt_moving = paused.clone();
        alt_moving.play_state_1 = 0x10;
        alt_moving.play_state_2 = 0xfa;
        alt_moving.play_state_3 = 0x00;
        assert!(status_is_playing(&alt_moving));

        let mut flag_playing = paused;
        flag_playing.flags |= CDJ_STATUS_PLAYING_FLAG;
        assert!(status_is_playing(&flag_playing));
    }

    #[test]
    fn load_confirm_and_load_settings_are_opt_in_by_default() {
        let config = DjLinkConfig::default();

        assert!(!config.auto_load_confirm);
        assert!(!config.auto_unlock_load_lock);
    }

    #[test]
    fn progress_load_confirm_requires_opt_in_and_a_library_track() {
        let mut state = test_state_with_sample_library(0x1020_3040);
        let track_id = state.library.all_tracks[0].track_id;

        assert!(!should_mount_info_load_confirm(&state, 3, track_id));

        state.config.auto_load_confirm = true;
        assert!(should_mount_info_load_confirm(&state, 3, track_id));
        assert!(!should_mount_info_load_confirm(&state, 0, track_id));
        assert!(!should_mount_info_load_confirm(&state, 3, 0xdead_beef));
    }

    #[tokio::test]
    async fn load_command_actor_makes_latest_same_player_intent_win() {
        let state = Arc::new(test_state());
        let sock = Arc::new(
            UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))
                .await
                .expect("bind sender"),
        );
        let (tx, rx) = mpsc::channel(LOAD_COMMAND_QUEUE_CAPACITY);
        let actor = tokio::spawn(run_load_command_actor(state.clone(), sock, rx));

        let command = |track_id| {
            let (reply, received) = oneshot::channel();
            (
                LoadCommand {
                    spec: LoadCommandSpec {
                        target_player: 3,
                        target_ip: Ipv4Addr::LOCALHOST,
                        track_id,
                        source_player: REKORDBOX_PLAYER_NUMBER,
                        source_slot: SLOT_REKORDBOX,
                        source_track_type: TRACK_TYPE_REKORDBOX,
                        attempts: 1,
                        retry_interval: Duration::from_millis(10),
                    },
                    reply,
                },
                received,
            )
        };
        let (first, first_reply) = command(101);
        let (second, second_reply) = command(202);
        let (latest, latest_reply) = command(303);
        tx.send(first).await.expect("first");
        tx.send(second).await.expect("second");
        tx.send(latest).await.expect("latest");

        let first_error = first_reply
            .await
            .expect("first reply")
            .expect_err("first superseded");
        let second_error = second_reply
            .await
            .expect("second reply")
            .expect_err("second superseded");
        assert!(matches!(
            first_error.downcast_ref::<LinkError>(),
            Some(LinkError::LoadCommandSuperseded { track_id: 101, .. })
        ));
        assert!(matches!(
            second_error.downcast_ref::<LinkError>(),
            Some(LinkError::LoadCommandSuperseded { track_id: 202, .. })
        ));

        state
            .record_status(test_cdj_status(REKORDBOX_PLAYER_NUMBER, 303, 0x05))
            .await;
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(1), latest_reply)
                .await
                .expect("latest timeout")
                .expect("latest reply")
                .expect("latest result"),
            1
        );

        drop(tx);
        actor.await.expect("load actor");
    }

    #[tokio::test]
    async fn load_confirmation_rejects_status_cached_before_command() {
        let state = test_state();
        let status = test_cdj_status(REKORDBOX_PLAYER_NUMBER, 303, 0x05);
        state.record_status(status.clone()).await;

        assert!(
            !state
                .wait_status_track(
                    3,
                    REKORDBOX_PLAYER_NUMBER,
                    303,
                    TRACK_TYPE_REKORDBOX,
                    false,
                    Instant::now() + Duration::from_millis(50),
                    Duration::from_millis(10),
                )
                .await
        );

        let observed_after = Instant::now() + Duration::from_millis(20);
        let wait = state.wait_status_track(
            3,
            REKORDBOX_PLAYER_NUMBER,
            303,
            TRACK_TYPE_REKORDBOX,
            false,
            observed_after,
            Duration::from_millis(200),
        );
        let record = async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            state.record_status(status).await;
        };
        let (confirmed, _) = tokio::join!(wait, record);
        assert!(confirmed);
    }

    #[tokio::test]
    async fn load_command_retries_with_target_browse_then_artist_context() {
        let state = test_state_with_sample_library(0x1020_3040);
        let track = &state.library.all_tracks[0];
        let playlist_context = LoadConfirmContext {
            source_menu: 0x05,
            category_1: 0x1020_3040,
            category_2: 0,
            menu_count: 1,
        };
        state
            .remember_browse_context(3, playlist_context, HashSet::from([track.track_id]))
            .await;

        let contexts = load_command_retry_contexts(&state, 3, track.track_id).await;
        assert_eq!(contexts.first(), Some(&playlist_context));
        assert_eq!(
            contexts.last(),
            Some(&LoadConfirmContext {
                source_menu: LOAD_CONTEXT_ARTIST_MENU,
                category_1: track.artist_id,
                category_2: u32::MAX,
                menu_count: 1,
            })
        );
    }

    #[test]
    fn only_waveform_anlz_tags_count_as_visual_progress() {
        assert_eq!(anlz_progress_context("PQT2"), "anlz-tag");
        assert_eq!(anlz_progress_context("PSSI"), "anlz-tag");
        assert_eq!(anlz_progress_context("PWV6"), "anlz-visual");
        assert_eq!(anlz_progress_context("PWV7"), "anlz-visual");
    }

    #[test]
    fn cdj_beat_snapshot_decodes_timing_and_tempo_fields() {
        let packet = build_status_beat_status("rekordbox", 17);
        let beat = parse_cdj_beat(&packet).expect("beat");

        assert_eq!(beat.player, 17);
        assert_eq!(beat.len_rest, 0x003c);
        assert_eq!(beat.next_beat_ms, 461);
        assert_eq!(beat.second_beat_ms, 922);
        assert_eq!(beat.next_bar_ms, 461);
        assert_eq!(beat.fourth_beat_ms, 1845);
        assert_eq!(beat.second_bar_ms, 2306);
        assert_eq!(beat.pitch, 0x100000);
        assert_eq!(pitch_percent(beat.pitch), 0.0);
        assert_eq!(beat.bpm_hundreds, 0x32cd);
        assert_eq!(beat.beat_in_bar, 4);
    }

    #[test]
    fn beat_port_short_packets_decode_fader_start_and_on_air() {
        let fader =
            build_fader_start_command("rekordbox", 33, 3, true, 0x02).expect("fader command");
        let fader = parse_fader_start(&fader).expect("fader");
        assert_eq!(fader.player, 33);
        assert_eq!(fader.commands, [2, 2, 0, 2]);
        assert!(fader.summary().contains("fader-start"));

        let fader_stop =
            build_fader_start_command("rekordbox", 33, 3, false, 0x02).expect("fader stop");
        let fader_stop = parse_fader_start(&fader_stop).expect("fader stop");
        assert_eq!(fader_stop.commands, [2, 2, 1, 2]);
        let prolink_connect_variant =
            build_fader_start_command("rekordbox", 33, 3, false, 0x00).expect("zero-idle fader");
        let prolink_connect_variant =
            parse_fader_start(&prolink_connect_variant).expect("zero-idle fader");
        assert_eq!(prolink_connect_variant.commands, [0, 0, 1, 0]);
        assert!(build_fader_start_command("rekordbox", 33, 5, true, 0x02).is_err());

        let on_air = build_on_air_command("rekordbox", 33, &[1, 3], false).expect("on-air command");
        assert_eq!(
            &on_air[0x1f..],
            &[1, 0, 33, 0, 9, 1, 0, 1, 0, 0, 0, 0, 0, 0]
        );
        let on_air = parse_on_air(&on_air).expect("on air");
        assert_eq!(on_air.player, 33);
        assert_eq!(on_air.subtype, 0x00);
        assert_eq!(on_air.channels, vec![1, 0, 1, 0]);
        assert!(on_air.summary().contains("on-air"));

        let on_air = build_on_air_command("rekordbox", 33, &[1, 3, 5, 6], true)
            .expect("extended on-air command");
        let on_air = parse_on_air(&on_air).expect("extended on air");
        assert_eq!(on_air.player, 33);
        assert_eq!(on_air.subtype, 0x03);
        assert_eq!(on_air.channels, vec![1, 0, 1, 0, 1, 1]);
        assert!(on_air.summary().contains("on-air"));
        assert!(build_on_air_command("rekordbox", 33, &[5], false).is_err());
    }

    #[test]
    fn sync_control_command_matches_beat_link_layout() {
        let packet = build_sync_control_command("rekordbox", 33, SyncControlCommand::SyncOn);
        assert_eq!(packet[10], BEAT_TYPE_SYNC_CONTROL);
        assert_eq!(
            &packet[0x1f..],
            &[1, 0, 33, 0, 8, 0, 0, 0, 33, 0, 0, 0, 0x10]
        );

        let sync = parse_sync_control(&packet).expect("sync control");
        assert_eq!(sync.player, 33);
        assert_eq!(sync.len_rest, 8);
        assert_eq!(sync.player_marker, 33);
        assert_eq!(sync.command, 0x10);
        assert!(sync.summary().contains("sync-on"));

        let master = parse_sync_control(&build_sync_control_command(
            "rekordbox",
            33,
            SyncControlCommand::TempoMaster,
        ))
        .expect("tempo master");
        assert_eq!(master.command, 0x01);
    }

    #[test]
    fn master_handoff_commands_match_beat_link_layout() {
        let request = build_master_handoff_request_command("rekordbox", 17);
        assert_eq!(request[10], BEAT_TYPE_MASTER_HANDOFF_REQUEST);
        assert_eq!(
            &request[0x1f..],
            &[0x01, 0x00, 17, 0x00, 0x04, 0x00, 0x00, 0x00, 17]
        );
        let request = parse_master_handoff(&request).expect("handoff request");
        assert!(!request.response);
        assert_eq!(request.player, 17);
        assert_eq!(request.len_rest, 4);
        assert_eq!(request.player_marker, 17);
        assert_eq!(request.yielded, None);

        let response = build_master_handoff_response_command("rekordbox", 17, true);
        assert_eq!(response[10], BEAT_TYPE_MASTER_HANDOFF_RESPONSE);
        assert_eq!(
            &response[0x1f..],
            &[
                0x01, 0x00, 17, 0x00, 0x08, 0x00, 0x00, 0x00, 17, 0x00, 0x00, 0x00, 0x01,
            ]
        );
        let response = parse_master_handoff(&response).expect("handoff response");
        assert!(response.response);
        assert_eq!(response.player, 17);
        assert_eq!(response.len_rest, 8);
        assert_eq!(response.player_marker, 17);
        assert_eq!(response.yielded, Some(true));
    }

    #[test]
    fn cdj_position_snapshot_decodes_playhead_and_effective_bpm() {
        let mut packet = vec![0u8; 0x3c];
        packet[..10].copy_from_slice(DJLINK_MAGIC);
        packet[10] = BEAT_TYPE_PRECISE_POSITION;
        packet[0x21] = 3;
        packet[0x22..0x24].copy_from_slice(&0x18u16.to_be_bytes());
        packet[0x24..0x28].copy_from_slice(&367u32.to_be_bytes());
        packet[0x28..0x2c].copy_from_slice(&123_456u32.to_be_bytes());
        packet[0x2c..0x30].copy_from_slice(&326i32.to_be_bytes());
        packet[0x38..0x3c].copy_from_slice(&1_202u32.to_be_bytes());

        let position = parse_cdj_position(&packet).expect("position");
        assert_eq!(position.player, 3);
        assert_eq!(position.len_rest, 0x18);
        assert_eq!(position.track_length_sec, 367);
        assert_eq!(position.playhead_ms, 123_456);
        assert_eq!(position.pitch_centi_percent, 326);
        assert_eq!(position.effective_bpm_tenths, 1_202);
        assert!(position.summary().contains("pitch=3.26%"));
        assert!(position.summary().contains("effective_bpm=120.2"));
    }

    #[test]
    fn db_artist_album_key_filters_return_track_rows() {
        let track = sample_track_record();
        let library = LibrarySnapshot {
            master_db_id: 0x0102_0304,
            tracks_by_id: [(track.track_id, track.clone())].into_iter().collect(),
            all_tracks: vec![track.clone()],
            playlists: Vec::new(),
        };

        let artists = artist_entries(&library);
        assert_eq!(artists.len(), 1);
        assert_eq!(artists[0].entry_id2, track.artist_id);
        assert_eq!(artists[0].text1, track.artist);

        let albums = albums_for_artist_entries(
            &library,
            &[
                DbValue::Int32(0),
                DbValue::Int32(track.artist_id),
                DbValue::Int32(0),
            ],
        );
        assert_eq!(albums.len(), 2);
        assert_eq!(albums[0].entry_id2, u32::MAX);
        assert_eq!(albums[0].text1, "All Tracks");
        assert_eq!(albums[1].entry_id2, track.album_id);
        assert_eq!(albums[1].text1, track.album);

        let tracks = tracks_for_artist_album_entries(
            &library,
            &[
                DbValue::Int32(0),
                DbValue::Int32(track.artist_id),
                DbValue::Int32(track.album_id),
            ],
        );
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].entry_id2, track.track_id);
        assert_eq!(tracks[0].text1, track.title);
        assert_eq!(tracks[0].text2, "");
        assert_eq!(tracks[0].entry_type, META_TITLE);
        assert_eq!(tracks[0].flags, 0x0100_0000);
        assert_eq!(tracks[0].entry_id3, track.track_id);
        assert_eq!(tracks[0].tail1, 0x0000_0100);
        assert_eq!(tracks[0].tail2, 3);
        assert_eq!(tracks[0].tail3, track.album_id);
        assert_eq!(tracks[0].tail_text, track.key);
        assert_eq!(tracks[0].tail4, track.bpm_hundreds);

        let key_neighbors =
            key_neighbor_entries(&library, &[DbValue::Int32(0), DbValue::Int32(track.key_id)]);
        assert_eq!(key_neighbors.len(), 3);
        assert_eq!(key_neighbors[0].entry_id1, track.key_id);
        assert_eq!(key_neighbors[0].entry_id2, 0);
        assert_eq!(key_neighbors[0].text1, track.key);
        assert_eq!(key_neighbors[0].entry_type, META_KEY);

        let key_tracks = tracks_for_key_distance_entries(
            &library,
            &[
                DbValue::Int32(0),
                DbValue::Int32(track.key_id),
                DbValue::Int32(0),
            ],
        );
        assert_eq!(key_tracks.len(), 1);
        assert_eq!(key_tracks[0].entry_id2, track.track_id);
    }

    #[test]
    fn key_distance_uses_camelot_compatible_tracks() {
        fn keyed_track(track_id: u32, title: &str, key: &str, camelot: &str) -> TrackRecord {
            let mut track = sample_track_record();
            track.track_id = track_id;
            track.title = title.to_string();
            track.canonical_name = format!("Brunello - {title}");
            track.key = key.to_string();
            track.camelot = camelot.to_string();
            track.key_id = stable_text_id(camelot);
            track
        }

        let exact = keyed_track(1, "Exact", "D", "10B");
        let relative = keyed_track(2, "Relative Minor", "Bm", "10A");
        let up = keyed_track(3, "Energy Up", "A", "11B");
        let down = keyed_track(4, "Energy Down", "G", "9B");
        let far = keyed_track(5, "Far Away", "Abm", "1A");
        let all_tracks = vec![
            exact.clone(),
            relative.clone(),
            up.clone(),
            down.clone(),
            far.clone(),
        ];
        let library = LibrarySnapshot {
            master_db_id: 0x0102_0304,
            tracks_by_id: all_tracks
                .iter()
                .map(|track| (track.track_id, track.clone()))
                .collect(),
            all_tracks,
            playlists: Vec::new(),
        };

        let keys = key_entries(&library);
        assert!(keys.iter().any(|entry| entry.text1 == "D (10B)"));

        let exact_tracks = tracks_for_key_distance_entries(
            &library,
            &[
                DbValue::Int32(0),
                DbValue::Int32(exact.key_id),
                DbValue::Int32(0),
            ],
        );
        assert_eq!(entry_ids(&exact_tracks), BTreeSet::from([exact.track_id]));

        let compatible_tracks = tracks_for_key_distance_entries(
            &library,
            &[
                DbValue::Int32(0),
                DbValue::Int32(exact.key_id),
                DbValue::Int32(1),
            ],
        );
        assert_eq!(
            entry_ids(&compatible_tracks),
            BTreeSet::from([
                exact.track_id,
                relative.track_id,
                up.track_id,
                down.track_id
            ])
        );
        assert!(!entry_ids(&compatible_tracks).contains(&far.track_id));
    }

    #[tokio::test]
    async fn key_browse_profile_reports_key_coverage_and_bucket_sizes() {
        fn keyed_track(track_id: u32, title: &str, key: &str, camelot: &str) -> TrackRecord {
            let mut track = sample_track_record();
            track.track_id = track_id;
            track.title = title.to_string();
            track.canonical_name = format!("Brunello - {title}");
            track.key = key.to_string();
            track.camelot = camelot.to_string();
            track.key_id = stable_text_id(track.key_identity());
            track
        }

        let exact = keyed_track(1, "Exact", "D", "10B");
        let relative = keyed_track(2, "Relative Minor", "Bm", "10A");
        let up = keyed_track(3, "Energy Up", "A", "11B");
        let textual = keyed_track(4, "Textual Key", "F#m", "F sharp minor");
        let mut missing = keyed_track(5, "Missing Key", "", "");
        missing.key_id = 0;
        let all_tracks = vec![
            exact.clone(),
            relative.clone(),
            up.clone(),
            textual.clone(),
            missing.clone(),
        ];
        let library = LibrarySnapshot {
            master_db_id: 0x0102_0304,
            tracks_by_id: all_tracks
                .iter()
                .map(|track| (track.track_id, track.clone()))
                .collect(),
            all_tracks,
            playlists: Vec::new(),
        };
        let server = DjLinkServer::new(DjLinkConfig::default(), library)
            .await
            .expect("server");
        let profile = server.profile_key_browse();

        assert_eq!(profile.total_tracks, 5);
        assert_eq!(profile.keyed_tracks, 4);
        assert_eq!(profile.camelot_tracks, 3);
        assert_eq!(profile.missing_key_tracks.len(), 1);
        assert_eq!(profile.missing_key_tracks[0].track_id, missing.track_id);
        assert_eq!(profile.non_camelot_key_tracks.len(), 1);
        assert_eq!(profile.non_camelot_key_tracks[0].track_id, textual.track_id);
        assert_eq!(profile.key_count, 4);
        assert_eq!(profile.distances.len(), 3);
        assert_eq!(profile.distances[0].distance, 0);
        assert_eq!(profile.distances[0].unique_track_count, 4);

        let exact_distance_one = profile
            .buckets
            .iter()
            .find(|bucket| bucket.key_id == exact.key_id && bucket.distance == 1)
            .expect("10B distance 1 bucket");
        assert_eq!(exact_distance_one.track_count, 3);
    }

    #[tokio::test]
    async fn search_entries_accept_cdj_utf16_and_token_queries() {
        fn track(track_id: u32, artist: &str, title: &str, album: &str) -> TrackRecord {
            let mut track = sample_track_record();
            track.track_id = track_id;
            track.artist = artist.to_string();
            track.artist_id = stable_text_id(artist);
            track.title = title.to_string();
            track.canonical_name = format!("{artist} - {title}");
            track.album = album.to_string();
            track.album_id = stable_text_id(album);
            track
        }

        let science = track(1, "Brunello", "Science Fiction", "Raw Cuts");
        let rufus = track(2, "RÜFÜS DU SOL", "Lately", "Inhale / Exhale");
        let unrelated = track(3, "The xx", "Crystalised", "xx");
        let library = LibrarySnapshot {
            master_db_id: 0x0102_0304,
            tracks_by_id: [science.clone(), rufus.clone(), unrelated.clone()]
                .into_iter()
                .map(|track| (track.track_id, track))
                .collect(),
            all_tracks: vec![science.clone(), rufus.clone(), unrelated],
            playlists: Vec::new(),
        };

        let token_query = search_entries(
            &library,
            &[
                DbValue::Int32(0x0301_0401),
                DbValue::Int32(SORT_DEFAULT),
                DbValue::Int32(0),
                DbValue::String("BRUNELLO SCIENCE".to_string()),
                DbValue::Int32(0),
            ],
        );
        assert_eq!(entry_ids(&token_query), BTreeSet::from([science.track_id]));

        let mut utf16 = Vec::new();
        for unit in "RUFUS LATELY\0".encode_utf16() {
            utf16.extend_from_slice(&unit.to_be_bytes());
        }
        assert_eq!(
            decode_search_binary(&utf16).as_deref(),
            Some("RUFUS LATELY")
        );
        let utf16_query = search_entries(
            &library,
            &[
                DbValue::Int32(0x0301_0401),
                DbValue::Int32(SORT_DEFAULT),
                DbValue::Int32(utf16.len() as u32),
                DbValue::Binary(utf16),
                DbValue::Int32(0),
            ],
        );
        assert_eq!(entry_ids(&utf16_query), BTreeSet::from([rufus.track_id]));

        let server = DjLinkServer::new(DjLinkConfig::default(), library.clone())
            .await
            .expect("server");
        let profile = server.profile_search("RUFUS LATELY", DjLinkSearchMode::Track);
        assert_eq!(profile.result_count, 1);
        assert_eq!(profile.items[0].entry_id, rufus.track_id);
        assert_eq!(profile.items[0].entry_type, META_TRACK_TITLE_AND_ARTIST);

        let mixed_query = search_entries(
            &library,
            &[
                DbValue::Int32(0x0301_0401),
                DbValue::Int32(SORT_DEFAULT),
                DbValue::Int32(0),
                DbValue::String("RUFUS".to_string()),
                DbValue::Int32(0),
            ],
        );
        assert_eq!(
            entry_types(&mixed_query),
            BTreeSet::from([META_TRACK_TITLE_AND_ARTIST, META_ARTIST])
        );

        let profile = server.profile_search("RUFUS", DjLinkSearchMode::Artist);
        assert_eq!(profile.result_count, 1);
        assert_eq!(profile.items[0].entry_id, rufus.artist_id);
        assert_eq!(profile.items[0].entry_type, META_ARTIST);

        let profile = server.profile_search("RAW CUTS", DjLinkSearchMode::Album);
        assert_eq!(profile.result_count, 1);
        assert_eq!(profile.items[0].entry_id, science.album_id);
        assert_eq!(profile.items[0].entry_type, META_ALBUM);

        let artist_sorted_query = search_entries(
            &library,
            &[
                DbValue::Int32(0x0301_0401),
                DbValue::Int32(SORT_ARTIST),
                DbValue::Int32(0),
                DbValue::String("RUFUS".to_string()),
                DbValue::Int32(0),
            ],
        );
        assert_eq!(
            entry_types(&artist_sorted_query),
            BTreeSet::from([META_TRACK_TITLE_AND_ARTIST, META_ARTIST])
        );

        let album_sorted_query = search_entries(
            &library,
            &[
                DbValue::Int32(0x0301_0401),
                DbValue::Int32(SORT_ALBUM),
                DbValue::Int32(0),
                DbValue::String("RAW CUTS".to_string()),
                DbValue::Int32(0),
            ],
        );
        assert_eq!(
            entry_types(&album_sorted_query),
            BTreeSet::from([META_TRACK_TITLE_AND_ARTIST, META_ALBUM])
        );

        let separate_context_track_query = search_entries(
            &library,
            &[
                DbValue::Int32(SORT_ARTIST),
                DbValue::Int32(0),
                DbValue::Int32(4),
                DbValue::Int32(1),
                DbValue::Int32(SORT_DEFAULT),
                DbValue::Int32(0),
                DbValue::String("SCIENCE".to_string()),
                DbValue::Int32(0),
            ],
        );
        assert_eq!(
            entry_ids(&separate_context_track_query),
            BTreeSet::from([science.track_id])
        );
        assert_eq!(
            separate_context_track_query[0].entry_type,
            META_TRACK_TITLE_AND_ARTIST
        );

        let separate_context_artist_query = search_entries(
            &library,
            &[
                DbValue::Int32(3),
                DbValue::Int32(0x1f),
                DbValue::Int32(4),
                DbValue::Int32(1),
                DbValue::Int32(SORT_ARTIST),
                DbValue::Int32(0),
                DbValue::String("RUFUS".to_string()),
                DbValue::Int32(0),
            ],
        );
        assert_eq!(separate_context_artist_query.len(), 1);
        assert_eq!(separate_context_artist_query[0].entry_type, META_ARTIST);
        assert_eq!(separate_context_artist_query[0].entry_id2, rufus.artist_id);

        let rmst_artist_tab_query = search_entries(
            &library,
            &[
                DbValue::Int32(0x031f_0401),
                DbValue::Int32(SORT_DEFAULT),
                DbValue::Int32(0),
                DbValue::String("RUFUS".to_string()),
                DbValue::Int32(0),
            ],
        );
        assert_eq!(rmst_artist_tab_query.len(), 1);
        assert_eq!(rmst_artist_tab_query[0].entry_type, META_ARTIST);
        assert_eq!(rmst_artist_tab_query[0].entry_id2, rufus.artist_id);

        let rmst_album_tab_query = search_entries(
            &library,
            &[
                DbValue::Int32(0x0320_0401),
                DbValue::Int32(SORT_DEFAULT),
                DbValue::Int32(0),
                DbValue::String("RAW CUTS".to_string()),
                DbValue::Int32(0),
            ],
        );
        assert_eq!(rmst_album_tab_query.len(), 1);
        assert_eq!(rmst_album_tab_query[0].entry_type, META_ALBUM);
        assert_eq!(rmst_album_tab_query[0].entry_id2, science.album_id);
    }

    #[tokio::test]
    async fn db_handler_roundtrips_split_context_search_to_packed_render() {
        let state = Arc::new(test_state_with_sample_library(0x5293_8822));
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("listener");
        let listener_addr = listener.local_addr().expect("listener addr");
        let (client, accepted) = tokio::join!(TcpStream::connect(listener_addr), listener.accept());
        let mut client = client.expect("client");
        let (server, peer_addr) = accepted.expect("server");
        let handle = tokio::spawn(handle_db_client(state, server, peer_addr, None));

        client
            .write_all(&encode_db_field(&DbValue::Int32(DB_MAGIC)))
            .await
            .expect("handshake write");
        assert_eq!(
            tokio::time::timeout(Duration::from_millis(100), recv_db_field(&mut client))
                .await
                .expect("handshake deadline")
                .expect("handshake response"),
            DbValue::Int32(1)
        );

        let tx = 0xbeef_0001;
        let search = encode_db_message(
            tx,
            DB_REQ_SEARCH,
            &[
                DbValue::Int32(3),
                DbValue::Int32(0x12),
                DbValue::Int32(SLOT_REKORDBOX as u32),
                DbValue::Int32(TRACK_TYPE_REKORDBOX as u32),
                DbValue::Int32(SORT_DEFAULT),
                DbValue::Int32(("SCIENCE".encode_utf16().count() * 2 + 2) as u32),
                DbValue::String("SCIENCE".to_string()),
                DbValue::Int32(0),
            ],
        );
        for chunk in search.chunks(3) {
            client.write_all(chunk).await.expect("search request write");
            tokio::task::yield_now().await;
        }
        let success =
            tokio::time::timeout(Duration::from_millis(100), recv_db_message(&mut client))
                .await
                .expect("search response deadline")
                .expect("search response");
        assert_eq!(success.tx_id, tx);
        assert_eq!(success.msg_type, DB_RES_SUCCESS);
        assert_eq!(db_int(success.args.first()), Some(DB_REQ_SEARCH as u32));
        assert_eq!(db_int(success.args.get(1)), Some(1));

        let render_tx = tx + 1;
        let render = encode_db_message(
            render_tx,
            DB_REQ_RENDER,
            &[
                DbValue::Int32(0x0312_0401),
                DbValue::Int32(0),
                DbValue::Int32(1),
                DbValue::Int32(0),
                DbValue::Int32(1),
                DbValue::Int32(12),
                DbValue::Int32(1),
                DbValue::Int32(0),
            ],
        );
        for chunk in render.chunks(2) {
            client.write_all(chunk).await.expect("render request write");
            tokio::task::yield_now().await;
        }
        let header = tokio::time::timeout(Duration::from_millis(100), recv_db_message(&mut client))
            .await
            .expect("render header deadline")
            .expect("render header");
        assert_eq!(header.tx_id, render_tx);
        assert_eq!(header.msg_type, DB_RES_MENU_HEADER);
        assert_eq!(db_int(header.args.first()), Some(1));
        assert_eq!(db_int(header.args.get(1)), Some(0));

        let row = tokio::time::timeout(Duration::from_millis(100), recv_db_message(&mut client))
            .await
            .expect("render row deadline")
            .expect("render row");
        assert_eq!(row.msg_type, DB_RES_MENU_ITEM);
        assert_eq!(db_int(row.args.get(1)), Some(42));
        assert_eq!(
            row.args.get(3),
            Some(&DbValue::String("Science Fiction".to_string()))
        );
        assert_eq!(
            row.args.get(5),
            Some(&DbValue::String("Brunello".to_string()))
        );
        assert_eq!(db_int(row.args.get(6)), Some(META_TRACK_TITLE_AND_ARTIST));
        assert_eq!(db_int(row.args.get(8)), Some(42));
        assert_eq!(db_int(row.args.get(9)), Some(1));

        let footer = tokio::time::timeout(Duration::from_millis(100), recv_db_message(&mut client))
            .await
            .expect("render footer deadline")
            .expect("render footer");
        assert_eq!(footer.msg_type, DB_RES_MENU_FOOTER);

        client.shutdown().await.expect("client shutdown");
        tokio::time::timeout(Duration::from_millis(100), handle)
            .await
            .expect("server shutdown deadline")
            .expect("server task");
    }

    #[test]
    fn db_metadata_backed_category_menus_filter_tracks() {
        let track = sample_track_record();
        let library = LibrarySnapshot {
            master_db_id: 0x0102_0304,
            tracks_by_id: [(track.track_id, track.clone())].into_iter().collect(),
            all_tracks: vec![track.clone()],
            playlists: Vec::new(),
        };

        let genres = genre_entries(&library);
        assert_eq!(genres.len(), 1);
        assert_eq!(genres[0].entry_id2, track.genre_id);
        assert_eq!(genres[0].text1, track.genre);
        let genre_artists = artists_for_genre_entries(
            &library,
            &[DbValue::Int32(0), DbValue::Int32(track.genre_id)],
        );
        assert_eq!(genre_artists.len(), 1);
        let genre_tracks = tracks_for_genre_artist_album_entries(
            &library,
            &[
                DbValue::Int32(0),
                DbValue::Int32(track.genre_id),
                DbValue::Int32(track.artist_id),
                DbValue::Int32(track.album_id),
            ],
        );
        assert_eq!(genre_tracks[0].entry_id2, track.track_id);

        let labels = label_entries(&library);
        let label_id = stable_text_id(&track.label);
        assert_eq!(labels[0].entry_id2, label_id);
        let label_tracks = tracks_for_label_artist_album_entries(
            &library,
            &[
                DbValue::Int32(0),
                DbValue::Int32(label_id),
                DbValue::Int32(track.artist_id),
                DbValue::Int32(track.album_id),
            ],
        );
        assert_eq!(label_tracks[0].entry_id2, track.track_id);

        assert_eq!(decade_entries(&library)[0].entry_id2, 2020);
        assert_eq!(
            years_for_decade_entries(&library, &[DbValue::Int32(0), DbValue::Int32(2020)])[0]
                .entry_id2,
            track.year
        );
        assert_eq!(
            tracks_for_decade_year_entries(
                &library,
                &[
                    DbValue::Int32(0),
                    DbValue::Int32(2020),
                    DbValue::Int32(track.year),
                ],
            )[0]
            .entry_id2,
            track.track_id
        );

        let bpm = track_bpm_whole(&track).expect("bpm");
        assert_eq!(bpm_entries(&library)[0].entry_id2, bpm);
        assert_eq!(
            bpm_range_entries(&library, &[DbValue::Int32(0), DbValue::Int32(bpm)]).len(),
            7
        );
        assert_eq!(
            tracks_for_bpm_distance_entries(
                &library,
                &[DbValue::Int32(0), DbValue::Int32(bpm), DbValue::Int32(0),],
            )[0]
            .entry_id2,
            track.track_id
        );

        let minutes = track_minutes(&track).expect("minutes");
        assert_eq!(time_entries(&library)[0].entry_id2, minutes);
        assert_eq!(
            tracks_for_time_entries(&library, &[DbValue::Int32(0), DbValue::Int32(minutes)])[0]
                .entry_id2,
            track.track_id
        );
        assert_eq!(bitrate_entries(&library)[0].entry_id2, track.bitrate_kbps);
        assert_eq!(
            tracks_for_bitrate_entries(
                &library,
                &[DbValue::Int32(0), DbValue::Int32(track.bitrate_kbps)],
            )[0]
            .entry_id2,
            track.track_id
        );
        assert_eq!(color_entries(&library)[0].text1, "None");
        assert_eq!(
            tracks_for_color_entries(&library, &[DbValue::Int32(0), DbValue::Int32(0)])[0]
                .entry_id2,
            track.track_id
        );
        assert_eq!(filename_entries(&library)[0].entry_id2, track.track_id);
        let date_sorted = title_entries_for_request(
            &library,
            &[DbValue::Int32(0), DbValue::Int32(ROOT_DATE_ADDED_ID)],
        );
        assert_eq!(date_sorted[0].entry_id2, track.track_id);
        assert_eq!(date_sorted[0].entry_type, META_TRACK_TITLE_AND_DATE_ADDED);
        assert_eq!(date_sorted[0].text2, track.date_added);
        assert_eq!(date_sorted[0].entry_id1, track.date_added_id);
        let date_legacy_root =
            title_entries_for_request(&library, &[DbValue::Int32(0), DbValue::Int32(20)]);
        assert_eq!(
            date_legacy_root[0].entry_type,
            META_TRACK_TITLE_AND_DATE_ADDED
        );

        let date_sort = title_entries_for_request(&library, &[DbValue::Int32(SORT_DATE_ADDED)]);
        assert_eq!(date_sort[0].entry_type, META_TRACK_TITLE_AND_DATE_ADDED);
        assert_eq!(date_sort[0].entry_id1, track.date_added_id);
        assert_eq!(date_sort[0].text2, track.date_added);
        let date_menu = date_added_entries(&library);
        assert_eq!(date_menu[0].entry_type, META_DATE_ADDED);
        assert_eq!(date_menu[0].entry_id2, track.date_added_id);
        assert_eq!(date_menu[0].text1, track.date_added);
        let tracks_for_date = tracks_for_date_added_entries(
            &library,
            &[DbValue::Int32(0), DbValue::Int32(track.date_added_id)],
        );
        assert_eq!(
            tracks_for_date[0].entry_type,
            META_TRACK_TITLE_AND_DATE_ADDED
        );
        assert_eq!(tracks_for_date[0].entry_id1, track.date_added_id);
        assert_eq!(tracks_for_date[0].entry_id2, track.track_id);
        assert_eq!(tracks_for_date[0].text2, track.date_added);
        let matching_by_root_id = title_entries_for_request(
            &library,
            &[DbValue::Int32(0), DbValue::Int32(ROOT_MATCHING_ID)],
        );
        assert_eq!(matching_by_root_id[0].entry_type, META_TITLE);
        assert_eq!(matching_by_root_id[0].entry_id2, track.track_id);
        let matching_by_legacy_root =
            title_entries_for_request(&library, &[DbValue::Int32(0), DbValue::Int32(19)]);
        assert_eq!(matching_by_legacy_root[0].entry_type, META_TITLE);
        let matching_by_item_type =
            title_entries_for_request(&library, &[DbValue::Int32(0), DbValue::Int32(0x00aa)]);
        assert_eq!(matching_by_item_type[0].entry_type, META_TITLE);
        assert_eq!(matching_by_item_type[0].entry_id2, track.track_id);
        let album_sort = title_entries_for_request(&library, &[DbValue::Int32(SORT_ALBUM)]);
        assert_eq!(album_sort[0].entry_type, META_TRACK_TITLE_AND_ALBUM);
        assert_eq!(album_sort[0].entry_id1, track.album_id);
        assert_eq!(album_sort[0].text2, track.album);
        let bpm_sort = title_entries_for_request(&library, &[DbValue::Int32(SORT_BPM)]);
        assert_eq!(bpm_sort[0].entry_type, META_TRACK_TITLE_AND_BPM);
        assert_eq!(bpm_sort[0].entry_id1, track.bpm_hundreds);
        let key_sort = title_entries_for_request(&library, &[DbValue::Int32(SORT_KEY)]);
        assert_eq!(key_sort[0].entry_type, META_TRACK_TITLE_AND_KEY);
        assert_eq!(key_sort[0].entry_id1, track.key_id);
        assert_eq!(key_sort[0].text2, track.key);
        let color_sort = title_entries_for_request(&library, &[DbValue::Int32(SORT_COLOR)]);
        assert_eq!(color_sort[0].entry_type, META_TRACK_TITLE_AND_COLOR);
        assert_eq!(color_sort[0].text2, "None");

        let metadata = metadata_entries(&library, &[DbValue::Int32(track.track_id)]);
        let date = metadata
            .iter()
            .find(|entry| entry.entry_type == META_DATE_ADDED)
            .expect("date added metadata");
        assert_eq!(date.entry_id2, track.date_added_id);
        assert_eq!(date.text1, track.date_added);
    }

    #[test]
    fn db_known_browse_request_names_are_not_unknown() {
        for request in [
            DB_REQ_BPM_MENU,
            DB_REQ_RATING_MENU,
            DB_REQ_YEAR_MENU,
            DB_REQ_LABEL_MENU,
            DB_REQ_COLOR_MENU,
            DB_REQ_TIME_MENU,
            DB_REQ_HISTORY_MENU,
            DB_REQ_FILENAME_MENU,
            DB_REQ_BPM_RANGE,
            DB_REQ_TRACKS_FOR_RATING,
            DB_REQ_YEARS_FOR_DECADE,
            DB_REQ_ARTISTS_FOR_LABEL,
            DB_REQ_TRACKS_FOR_COLOR,
            DB_REQ_TRACKS_FOR_TIME,
            DB_REQ_TRACKS_FOR_BITRATE,
            DB_REQ_TRACKS_FOR_HISTORY,
            DB_REQ_ALBUMS_FOR_GENRE_ARTIST,
            DB_REQ_TRACKS_FOR_BPM_DISTANCE,
            DB_REQ_TRACKS_FOR_DECADE_YEAR,
            DB_REQ_ALBUMS_FOR_LABEL_ARTIST,
            DB_REQ_KEY_NEIGHBOR,
            DB_REQ_TRACKS_FOR_KEY_DISTANCE,
            DB_REQ_TRACKS_FOR_GENRE_ARTIST_ALBUM,
            DB_REQ_ORIGINAL_ARTIST_MENU,
            DB_REQ_TRACKS_FOR_LABEL_ARTIST_ALBUM,
            DB_REQ_ALBUMS_FOR_ORIGINAL_ARTIST,
            DB_REQ_TRACKS_FOR_ORIGINAL_ARTIST_ALBUM,
            DB_REQ_REMIXER_MENU,
            DB_REQ_ALBUMS_FOR_REMIXER,
            DB_REQ_DATE_ADDED_MENU,
            DB_REQ_TRACKS_FOR_REMIXER_ALBUM,
            DB_REQ_TRACKS_FOR_DATE_ADDED,
            DB_REQ_FOLDER_MENU,
        ] {
            assert!(!db_request_name(request).starts_with("UNKNOWN"));
        }
    }

    #[test]
    fn db_playlist_rows_keep_parent_and_selection_ids() {
        let track = sample_track_record();
        let playlist = PlaylistRecord {
            playlist_id: 0x5293_8822,
            name: "Maccabi Test".to_string(),
            parent_id: 0,
            is_folder: false,
            sequence: 1,
            tracks: vec![track.track_id],
        };
        let library = LibrarySnapshot {
            master_db_id: 0x0102_0304,
            tracks_by_id: [(track.track_id, track.clone())].into_iter().collect(),
            all_tracks: vec![track.clone()],
            playlists: vec![playlist.clone()],
        };

        let folders = playlist_entries(
            &library,
            &[
                DbValue::Int32(0x0101_0401),
                DbValue::Int32(0),
                DbValue::Int32(0),
                DbValue::Int32(1),
            ],
        );
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].entry_id1, playlist.parent_id);
        assert_eq!(folders[0].entry_id2, playlist.playlist_id);
        assert_eq!(folders[0].entry_type, META_PLAYLIST);

        let tracks = playlist_entries(
            &library,
            &[
                DbValue::Int32(0x0102_0401),
                DbValue::Int32(0),
                DbValue::Int32(playlist.playlist_id),
                DbValue::Int32(0),
            ],
        );
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].entry_id2, track.track_id);
        assert_eq!(tracks[0].position, 1);

        let tracks_by_first_id = playlist_entries(
            &library,
            &[
                DbValue::Int32(0x0102_0401),
                DbValue::Int32(playlist.playlist_id),
                DbValue::Int32(0),
                DbValue::Int32(0),
            ],
        );
        assert_eq!(tracks_by_first_id.len(), 1);
        assert_eq!(tracks_by_first_id[0].entry_id2, track.track_id);
    }

    #[test]
    fn browsed_track_rows_carry_positions_for_back_navigation() {
        let state = test_state_with_sample_library(0x5293_8822);
        let root_tracks = title_entries_for_request(
            &state.library,
            &[DbValue::Int32(0x0301_0401), DbValue::Int32(SORT_DEFAULT)],
        );
        assert_eq!(root_tracks[0].position, 1);

        let album_tracks = tracks_for_album_entries(
            &state.library,
            &[
                DbValue::Int32(0x0301_0401),
                DbValue::Int32(SORT_DEFAULT),
                DbValue::Int32(state.library.all_tracks[0].album_id),
            ],
        );
        assert_eq!(album_tracks[0].position, 1);

        let search_tracks = search_entries(
            &state.library,
            &[DbValue::String("BRUNELLO SCIENCE".to_string())],
        );
        assert_eq!(search_tracks[0].position, 1);
    }

    #[test]
    fn db_title_row_args_match_rekordbox_loadable_capture_shape() {
        let track = TrackRecord {
            track_id: 160_648_812,
            title: "Feelin This (Original Mix)".to_string(),
            artist: "unused in loadable row".to_string(),
            artist_id: 1,
            canonical_name: "Test - Feelin This".to_string(),
            album: "Captured Album".to_string(),
            album_id: 76_618_283,
            duration_sec: 0,
            bpm_hundreds: 12_200,
            key: "2A".to_string(),
            camelot: "2A".to_string(),
            key_id: 2,
            bitrate_kbps: 0,
            comment: String::new(),
            mount_path: PathBuf::from("/tmp/test.mp3"),
            analysis_dat_path: None,
            analysis_ext_path: None,
            analysis_twoex_path: None,
            artwork_id: 0,
            artwork_url: None,
            genre: String::new(),
            genre_id: 0,
            label: String::new(),
            year: 0,
            date_added_id: 0,
            date_added: String::new(),
        };

        let rows = title_entries(&[track.clone()], false);
        assert_eq!(
            menu_entry_args(&rows[0]),
            vec![
                DbValue::Int32(0),
                DbValue::Int32(track.track_id),
                DbValue::Int32(54),
                DbValue::String(track.title.clone()),
                DbValue::Int32(2),
                DbValue::String(String::new()),
                DbValue::Int32(META_TITLE),
                DbValue::Int32(0x0100_0000),
                DbValue::Int32(track.track_id),
                DbValue::Int32(0),
                DbValue::Int32(0x0000_0100),
                DbValue::Int32(3),
                DbValue::Int32(track.album_id),
                DbValue::Int32(6),
                DbValue::String(track.key.clone()),
                DbValue::Int32(track.bpm_hundreds),
            ]
        );
    }

    #[test]
    fn rekordbox_db_comment_uses_key_bpm_summary_not_markdown_notes() {
        assert_eq!(rekordbox_db_comment(12_200, "2A"), "2A - 122.0");
        assert_eq!(rekordbox_db_comment(12_698, ""), "127.0");
        assert_eq!(rekordbox_db_comment(0, "8A"), "8A");
        assert_eq!(rekordbox_db_comment(0, ""), "");
    }

    #[test]
    fn anlz_tag_not_found_matches_rekordbox_capture() {
        let msg = blob_response(0x1d5c, DB_REQ_ANLZ_TAG, DB_RES_ANLZ_TAG, None);
        assert_eq!(msg.len(), 45);
        assert_eq!(
            msg,
            decode_hex(
                "11872349ae1100001d5c104f020f05140000000506060603061100002c04110000003211000000001100000000"
            )
        );
    }

    #[test]
    fn library_selector_resolves_id_and_text() {
        let track = TrackRecord {
            track_id: 42,
            title: "Track One".to_string(),
            artist: "Artist One".to_string(),
            artist_id: stable_text_id("Artist One"),
            canonical_name: "Artist One - Track One".to_string(),
            album: String::new(),
            album_id: 0,
            duration_sec: 0,
            bpm_hundreds: 0,
            key: String::new(),
            camelot: String::new(),
            key_id: 0,
            bitrate_kbps: 0,
            comment: String::new(),
            mount_path: PathBuf::from("/tmp/Track One.mp3"),
            analysis_dat_path: None,
            analysis_ext_path: None,
            analysis_twoex_path: None,
            artwork_id: 0,
            artwork_url: None,
            genre: String::new(),
            genre_id: 0,
            label: String::new(),
            year: 0,
            date_added_id: 0,
            date_added: String::new(),
        };
        let library = LibrarySnapshot {
            master_db_id: 0x0102_0304,
            tracks_by_id: [(track.track_id, track.clone())].into_iter().collect(),
            all_tracks: vec![track],
            playlists: Vec::new(),
        };
        assert_eq!(
            library
                .resolve_track_selector("42")
                .expect("by id")
                .track_id,
            42
        );
        assert_eq!(
            library
                .resolve_track_selector("artist one - track one")
                .expect("by label")
                .track_id,
            42
        );
        assert_eq!(
            library
                .resolve_track_selector("track one")
                .expect("by title")
                .track_id,
            42
        );
    }

    #[test]
    fn portmap_advertises_rekordbox_rpc_versions() {
        assert_eq!(portmap_getport(RPC_MOUNT_PROG, 1, 17, 42039), 42039);
        assert_eq!(portmap_getport(RPC_MOUNT_PROG, 3, 17, 42039), 42039);
        assert_eq!(portmap_getport(RPC_NFS_PROG, 2, 17, 42039), NFS_PORT);
        assert_eq!(portmap_getport(RPC_NFS_PROG, 3, 17, 42039), NFS_PORT);
        assert_eq!(portmap_getport(RPC_NFS_PROG, 4, 17, 42039), 0);
        assert_eq!(portmap_getport(RPC_NFS_PROG, 2, 6, 42039), 0);
    }

    fn recv_db_message_from_read<R: Read>(reader: &mut R) -> TestDbResult<DbMessage> {
        fn field<R: Read>(reader: &mut R) -> TestDbResult<DbValue> {
            let mut ty = [0u8; 1];
            reader.read_exact(&mut ty)?;
            match ty[0] {
                DB_FIELD_INT8 => {
                    let mut raw = [0u8; 1];
                    reader.read_exact(&mut raw)?;
                    Ok(DbValue::Int8(raw[0]))
                }
                DB_FIELD_INT16 => {
                    let mut raw = [0u8; 2];
                    reader.read_exact(&mut raw)?;
                    Ok(DbValue::Int16(u16::from_be_bytes(raw)))
                }
                DB_FIELD_INT32 => {
                    let mut raw = [0u8; 4];
                    reader.read_exact(&mut raw)?;
                    Ok(DbValue::Int32(u32::from_be_bytes(raw)))
                }
                DB_FIELD_BINARY => {
                    let mut len = [0u8; 4];
                    reader.read_exact(&mut len)?;
                    let mut raw = vec![0u8; u32::from_be_bytes(len) as usize];
                    reader.read_exact(&mut raw)?;
                    Ok(DbValue::Binary(raw))
                }
                DB_FIELD_STRING => {
                    let mut units = [0u8; 4];
                    reader.read_exact(&mut units)?;
                    let units = u32::from_be_bytes(units).saturating_sub(1) as usize;
                    let mut raw = vec![0u8; units * 2];
                    reader.read_exact(&mut raw)?;
                    let mut pad = [0u8; 2];
                    reader.read_exact(&mut pad)?;
                    let units = raw
                        .chunks_exact(2)
                        .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
                        .collect::<Vec<_>>();
                    Ok(DbValue::String(String::from_utf16_lossy(&units)))
                }
                field => Err(TestDbParseError::UnsupportedField { field }),
            }
        }
        let DbValue::Int32(magic) = field(reader)? else {
            return Err(TestDbParseError::ExpectedField { expected: "magic" });
        };
        assert_eq!(magic, DB_MAGIC);
        let DbValue::Int32(tx_id) = field(reader)? else {
            return Err(TestDbParseError::ExpectedField { expected: "tx" });
        };
        let DbValue::Int16(msg_type) = field(reader)? else {
            return Err(TestDbParseError::ExpectedField { expected: "type" });
        };
        let DbValue::Int8(argc) = field(reader)? else {
            return Err(TestDbParseError::ExpectedField { expected: "argc" });
        };
        let DbValue::Binary(_) = field(reader)? else {
            return Err(TestDbParseError::ExpectedField {
                expected: "argtypes",
            });
        };
        let mut args = Vec::new();
        for _ in 0..argc {
            args.push(field(reader)?);
        }
        Ok(DbMessage {
            tx_id,
            msg_type,
            args,
        })
    }

    #[test]
    fn nfs_auto_decodes_utf16le_names() {
        let raw = [b'U', 0, b's', 0, b'e', 0, b'r', 0, b's', 0];
        assert_eq!(decode_nfs_name(&raw), "Users");
    }

    #[test]
    fn nfs_file_handles_are_stable_across_state_restarts() {
        let path = PathBuf::from("/Users/gakonst/.djtools/tracks/Track.mp3");
        let mut first = NfsState::default();
        let mut second = NfsState::default();

        let first_fh = first.handle_for_path(&path, Some(&NFS_ROOT_FH));
        let second_fh = second.handle_for_path(&path, Some(&NFS_ROOT_FH));

        assert_eq!(first_fh, second_fh);
    }

    #[tokio::test]
    async fn anlz_tag_reader_extracts_raw_tag_section() {
        let temp = tempfile::tempdir().expect("tempdir");
        let dat_path = temp.path().join("ANLZ0000.DAT");
        write_test_anlz_tag(&dat_path, b"PQTZ", &[1, 2, 3, 4, 5, 6, 7, 8]);

        let track = TrackRecord {
            track_id: 42,
            title: "Track One".to_string(),
            artist: "Artist One".to_string(),
            artist_id: stable_text_id("Artist One"),
            canonical_name: "Artist One - Track One".to_string(),
            album: String::new(),
            album_id: 0,
            duration_sec: 0,
            bpm_hundreds: 0,
            key: String::new(),
            camelot: String::new(),
            key_id: 0,
            bitrate_kbps: 0,
            comment: String::new(),
            mount_path: PathBuf::from("/tmp/Track One.mp3"),
            analysis_dat_path: Some(dat_path),
            analysis_ext_path: None,
            analysis_twoex_path: None,
            artwork_id: 0,
            artwork_url: None,
            genre: String::new(),
            genre_id: 0,
            label: String::new(),
            year: 0,
            date_added_id: 0,
            date_added: String::new(),
        };
        let tag = read_anlz_tag(&track, "PQTZ", None).await.expect("tag");
        assert_eq!(&tag[..4], b"PQTZ");
        assert_eq!(tag.len(), 20);
        assert_eq!(
            anlz_tag_payload(&tag).expect("payload"),
            vec![1, 2, 3, 4, 5, 6, 7, 8]
        );
        assert_eq!(fourcc_from_le_u32(0x3456_5750), "PWV4");
    }

    #[tokio::test]
    async fn anlz_tag_reader_uses_explicit_ext_and_twoex_paths() {
        let temp = tempfile::tempdir().expect("tempdir");
        let dat_path = temp.path().join("ANLZ0000.DAT");
        let ext_path = temp.path().join("analysis-cache").join("custom.EXT");
        let twoex_path = temp.path().join("analysis-cache").join("custom.2EX");
        std::fs::create_dir_all(ext_path.parent().expect("parent")).expect("dir");
        write_test_anlz_tag(&dat_path, b"PWAV", &[1, 2, 3, 4]);
        write_test_anlz_tag(&ext_path, b"PWV4", &[5, 6, 7, 8]);
        write_test_anlz_tag(&twoex_path, b"PWV6", &[9, 10, 11, 12]);

        let track = TrackRecord {
            track_id: 42,
            title: "Track One".to_string(),
            artist: "Artist One".to_string(),
            artist_id: stable_text_id("Artist One"),
            canonical_name: "Artist One - Track One".to_string(),
            album: String::new(),
            album_id: 0,
            duration_sec: 0,
            bpm_hundreds: 0,
            key: String::new(),
            camelot: String::new(),
            key_id: 0,
            bitrate_kbps: 0,
            comment: String::new(),
            mount_path: PathBuf::from("/tmp/Track One.mp3"),
            analysis_dat_path: Some(dat_path),
            analysis_ext_path: Some(ext_path),
            analysis_twoex_path: Some(twoex_path),
            artwork_id: 0,
            artwork_url: None,
            genre: String::new(),
            genre_id: 0,
            label: String::new(),
            year: 0,
            date_added_id: 0,
            date_added: String::new(),
        };

        assert_eq!(
            anlz_tag_payload(
                &read_anlz_tag(&track, "PWV4", Some("EXT"))
                    .await
                    .expect("ext"),
            )
            .expect("payload"),
            vec![5, 6, 7, 8]
        );
        assert_eq!(
            anlz_tag_payload(
                &read_anlz_tag(&track, "PWV6", Some("2EX"))
                    .await
                    .expect("2ex"),
            )
            .expect("payload"),
            vec![9, 10, 11, 12]
        );
    }

    #[tokio::test]
    async fn anlz_tag_reader_preserves_duplicate_pcob_sections_for_nexus_cues() {
        let temp = tempfile::tempdir().expect("tempdir");
        let dat_path = temp.path().join("ANLZ0000.DAT");
        write_test_anlz_tags(
            &dat_path,
            &[
                (b"PCOB", &[0, 0, 0, 0, 1, 2, 3]),
                (b"PCOB", &[0, 0, 0, 0, 4, 5, 6, 7]),
            ],
        );
        let track = TrackRecord {
            track_id: 42,
            title: "Track One".to_string(),
            artist: "Artist One".to_string(),
            artist_id: stable_text_id("Artist One"),
            canonical_name: "Artist One - Track One".to_string(),
            album: String::new(),
            album_id: 0,
            duration_sec: 0,
            bpm_hundreds: 0,
            key: String::new(),
            camelot: String::new(),
            key_id: 0,
            bitrate_kbps: 0,
            comment: String::new(),
            mount_path: PathBuf::from("/tmp/Track One.mp3"),
            analysis_dat_path: Some(dat_path),
            analysis_ext_path: None,
            analysis_twoex_path: None,
            artwork_id: 0,
            artwork_url: None,
            genre: String::new(),
            genre_id: 0,
            label: String::new(),
            year: 0,
            date_added_id: 0,
            date_added: String::new(),
        };

        let tags = read_anlz_tags(&track, "PCOB", None).await;
        assert_eq!(tags.len(), 2);
        assert_eq!(anlz_tag_body(&tags[0]).expect("first"), vec![1, 2, 3]);
        assert_eq!(anlz_tag_body(&tags[1]).expect("second"), vec![4, 5, 6, 7]);
    }

    #[tokio::test]
    async fn anlz_tag_request_serves_extended_tags_when_opted_in() {
        let temp = tempfile::tempdir().expect("tempdir");
        let dat_path = temp.path().join("ANLZ0000.DAT");
        let ext_path = temp.path().join("ANLZ0000.EXT");
        let twoex_path = temp.path().join("ANLZ0000.2EX");
        write_test_anlz_sections(
            &dat_path,
            &[test_pqtz_tag(&[(1, 12_700, 2), (2, 12_700, 474)])],
        );
        write_test_anlz_sections(
            &ext_path,
            &[
                test_pqt2_tag(2, 474),
                test_simple_anlz_tag(b"PSSI", &[5, 6, 7, 8]),
                test_simple_anlz_tag(b"PWV4", &[21, 22, 23, 24]),
                test_simple_anlz_tag(b"PWV5", &[25, 26, 27, 28]),
            ],
        );
        write_test_anlz_tags(
            &twoex_path,
            &[(b"PWV6", &[9, 10, 11, 12]), (b"PWV7", &[13, 14, 15, 16])],
        );

        let track = TrackRecord {
            track_id: 42,
            title: "Track One".to_string(),
            artist: "Artist One".to_string(),
            artist_id: stable_text_id("Artist One"),
            canonical_name: "Artist One - Track One".to_string(),
            album: String::new(),
            album_id: 0,
            duration_sec: 0,
            bpm_hundreds: 0,
            key: String::new(),
            camelot: String::new(),
            key_id: 0,
            bitrate_kbps: 0,
            comment: String::new(),
            mount_path: PathBuf::from("/tmp/Track One.mp3"),
            analysis_dat_path: Some(dat_path),
            analysis_ext_path: Some(ext_path),
            analysis_twoex_path: Some(twoex_path),
            artwork_id: 0,
            artwork_url: None,
            genre: String::new(),
            genre_id: 0,
            label: String::new(),
            year: 0,
            date_added_id: 0,
            date_added: String::new(),
        };
        let library = LibrarySnapshot {
            master_db_id: 0x0102_0304,
            tracks_by_id: [(track.track_id, track)].into_iter().collect(),
            all_tracks: Vec::new(),
            playlists: Vec::new(),
        };
        let ext_arg = u32::from_le_bytes([b'E', b'X', b'T', 0]);
        let twoex_arg = u32::from_le_bytes([b'2', b'E', b'X', 0]);
        let pqt2_args = [
            DbValue::Int32(42),
            DbValue::Int32(u32::from_le_bytes(*b"PQT2")),
            DbValue::Int32(ext_arg),
        ];
        let pssi_args = [
            DbValue::Int32(42),
            DbValue::Int32(u32::from_le_bytes(*b"PSSI")),
            DbValue::Int32(ext_arg),
        ];
        let pwv6_args = [
            DbValue::Int32(42),
            DbValue::Int32(u32::from_le_bytes(*b"PWV6")),
            DbValue::Int32(twoex_arg),
        ];
        let pwv4_args = [
            DbValue::Int32(42),
            DbValue::Int32(u32::from_le_bytes(*b"PWV4")),
            DbValue::Int32(ext_arg),
        ];
        let pwv5_args = [
            DbValue::Int32(42),
            DbValue::Int32(u32::from_le_bytes(*b"PWV5")),
            DbValue::Int32(ext_arg),
        ];
        let pwv7_args = [
            DbValue::Int32(42),
            DbValue::Int32(u32::from_le_bytes(*b"PWV7")),
            DbValue::Int32(twoex_arg),
        ];

        let pqt2_default = load_anlz_tag(&library, &pqt2_args, true)
            .await
            .expect("pqt2 default");
        assert_eq!(&pqt2_default[..4], b"PQT2");
        assert!(load_anlz_tag(&library, &pqt2_args, false).await.is_none());
        assert!(load_anlz_tag(&library, &pssi_args, false).await.is_none());
        assert!(load_anlz_tag(&library, &pwv4_args, false).await.is_none());
        assert!(load_anlz_tag(&library, &pwv5_args, false).await.is_none());
        assert!(load_anlz_tag(&library, &pwv6_args, false).await.is_none());
        assert!(load_anlz_tag(&library, &pwv7_args, false).await.is_none());

        let pqt2 = load_anlz_tag(&library, &pqt2_args, true)
            .await
            .expect("pqt2");
        assert_eq!(&pqt2[..4], b"PQT2");
        assert_eq!(pqt2_grid_stats(&pqt2).expect("stats").count, 2);

        let pssi = load_anlz_tag(&library, &pssi_args, true)
            .await
            .expect("pssi");
        assert_eq!(&pssi[..4], b"PSSI");
        assert_eq!(anlz_tag_payload(&pssi).expect("payload"), vec![5, 6, 7, 8]);

        let pwv6 = load_anlz_tag(&library, &pwv6_args, true)
            .await
            .expect("pwv6");
        assert_eq!(&pwv6[..4], b"PWV6");
        assert_eq!(
            anlz_tag_payload(&pwv6).expect("payload"),
            vec![9, 10, 11, 12]
        );

        let pwv4 = load_anlz_tag(&library, &pwv4_args, true)
            .await
            .expect("pwv4");
        assert_eq!(&pwv4[..4], b"PWV4");
        assert_eq!(
            anlz_tag_payload(&pwv4).expect("payload"),
            vec![21, 22, 23, 24]
        );
    }

    #[tokio::test]
    async fn pqt2_extended_grid_must_match_primary_pqtz_grid() {
        let temp = tempfile::tempdir().expect("tempdir");
        let dat_path = temp.path().join("ANLZ0000.DAT");
        let ext_path = temp.path().join("ANLZ0000.EXT");
        write_test_anlz_sections(
            &dat_path,
            &[test_pqtz_tag(&[(1, 12_700, 2), (2, 12_700, 474)])],
        );
        write_test_anlz_sections(&ext_path, &[test_pqt2_tag(3, 999)]);

        let track = TrackRecord {
            track_id: 42,
            title: "Track One".to_string(),
            artist: "Artist One".to_string(),
            artist_id: stable_text_id("Artist One"),
            canonical_name: "Artist One - Track One".to_string(),
            album: String::new(),
            album_id: 0,
            duration_sec: 0,
            bpm_hundreds: 0,
            key: String::new(),
            camelot: String::new(),
            key_id: 0,
            bitrate_kbps: 0,
            comment: String::new(),
            mount_path: PathBuf::from("/tmp/Track One.mp3"),
            analysis_dat_path: Some(dat_path),
            analysis_ext_path: Some(ext_path),
            analysis_twoex_path: None,
            artwork_id: 0,
            artwork_url: None,
            genre: String::new(),
            genre_id: 0,
            label: String::new(),
            year: 0,
            date_added_id: 0,
            date_added: String::new(),
        };
        let library = LibrarySnapshot {
            master_db_id: 0x0102_0304,
            tracks_by_id: [(track.track_id, track)].into_iter().collect(),
            all_tracks: Vec::new(),
            playlists: Vec::new(),
        };
        let args = [
            DbValue::Int32(42),
            DbValue::Int32(u32::from_le_bytes(*b"PQT2")),
            DbValue::Int32(u32::from_le_bytes([b'E', b'X', b'T', 0])),
        ];

        assert!(load_anlz_tag(&library, &args, true).await.is_none());
    }

    #[test]
    fn high_level_anlz_payload_strips_only_section_envelope() {
        let mut tag = Vec::new();
        tag.extend_from_slice(b"PWAV");
        tag.extend_from_slice(&20u32.to_be_bytes());
        tag.extend_from_slice(&24u32.to_be_bytes());
        tag.extend_from_slice(&[0x00, 0x00, 0x01, 0x90]);
        tag.extend_from_slice(&[0x00, 0x10, 0x00, 0x00]);
        tag.extend_from_slice(&[0x15, 0x00, 0x16, 0x00]);

        assert_eq!(
            anlz_tag_payload(&tag).expect("payload"),
            vec![
                0x00, 0x00, 0x01, 0x90, 0x00, 0x10, 0x00, 0x00, 0x15, 0x00, 0x16, 0x00
            ]
        );
    }

    #[tokio::test]
    async fn library_snapshot_loads_playable_markdown_tracks() {
        let temp = tempfile::tempdir().expect("tempdir");
        let paths = DjPaths::new(temp.path().to_path_buf());
        paths.ensure_base_dirs().expect("dirs");
        let artist_dir = paths.tracks_dir().join("Artist One");
        std::fs::create_dir_all(&artist_dir).expect("artist dir");
        let track_doc = artist_dir.join("Artist One - Track One.md");
        let audio = artist_dir.join("Artist One - Track One.mp3");
        let analysis_dir = artist_dir.join("test.rekordbox");
        std::fs::create_dir_all(&analysis_dir).expect("analysis dir");
        std::fs::write(analysis_dir.join("ANLZ0000.DAT"), b"dat").expect("dat");
        std::fs::write(analysis_dir.join("ANLZ0000.EXT"), b"ext").expect("ext");
        std::fs::write(analysis_dir.join("ANLZ0000.2EX"), b"2ex").expect("2ex");
        std::fs::write(&audio, b"audio").expect("audio");
        std::fs::write(
            &track_doc,
            r#"---
canonical_artist: Artist One
canonical_artists:
- Artist One
canonical_title: Track One
version: null
canonical_name: Artist One - Track One
spotify_url: null
spotify_id: null
spotify_uri: null
spotify_href: null
spotify_popularity: null
spotify_preview_url: null
spotify_explicit: null
spotify_isrc: null
spotify_disc_number: null
spotify_track_number: null
spotify_audio_features_error: null
audio_danceability: null
audio_energy: null
audio_key: null
audio_loudness: null
audio_mode: null
audio_speechiness: null
audio_acousticness: null
audio_instrumentalness: null
audio_liveness: null
audio_valence: null
audio_tempo_bpm: null
audio_time_signature: null
rekordbox_analysis:
  state: analyzed
  analyzer: test
  analyzed_at: 2026-05-13T00:00:00Z
  source_path: test.mp3
  output_dir: test.rekordbox
  summary_path: test.rekordbox/analysis.json
  dat_path: test.rekordbox/ANLZ0000.DAT
  ext_path: test.rekordbox/ANLZ0000.EXT
  twoex_path: test.rekordbox/ANLZ0000.2EX
  tempo_bpm: 123.0
  beat_count: 100
  duration_match: false
  first_downbeat_ms: 0
  last_beat_ms: 119000
  backend: test
duration_ms: 364000
release: null
album: null
first_seen_source: test
enrichment_state: resolved
acquisition_state: downloaded
local_file_path: null
notes: []
---

## Seen In Sets
- none

## In Albums
- none

## In Playlists
- none

## Notes
- none

## Spotify Metadata

### Spotify Track Object JSON
```json
{ not valid json }
```
"#,
        )
        .expect("track doc");

        let library = LibrarySnapshot::from_djtools(&paths, false)
            .await
            .expect("library");
        assert_eq!(library.track_count(), 1);
        assert_eq!(library.master_db_id, stable_id(paths.root()));
        let track = library.all_tracks.first().expect("track");
        assert_eq!(track.title, "Track One");
        assert_eq!(track.artist, "Artist One");
        assert_eq!(track.artwork_url.as_deref(), None);
        assert_eq!(track.artwork_id, 0);
        assert_eq!(track.bpm_hundreds, 12300);
        assert_eq!(track.duration_sec, 119);
        assert_eq!(track.bitrate_kbps, 0);
        assert!(!track.date_added.is_empty());
        assert_eq!(track.date_added_id, stable_text_id(&track.date_added));
        assert_eq!(track.mount_path, audio);
        assert_eq!(
            track.analysis_dat_path.as_deref(),
            Some(analysis_dir.join("ANLZ0000.DAT").as_path())
        );
        assert_eq!(
            track.analysis_ext_path.as_deref(),
            Some(analysis_dir.join("ANLZ0000.EXT").as_path())
        );
        assert_eq!(
            track.analysis_twoex_path.as_deref(),
            Some(analysis_dir.join("ANLZ0000.2EX").as_path())
        );
        let validation = library.validate_for_serving(true).await;
        assert!(validation.is_ok(true));
        assert_eq!(validation.track_count, 1);
        assert_eq!(validation.playlist_count, 0);
        assert_eq!(validation.analyzed_dat_count, 1);
        assert_eq!(validation.analyzed_ext_count, 1);
        assert_eq!(validation.analyzed_twoex_count, 1);
    }

    #[tokio::test]
    async fn duration_and_bitrate_fallback_helpers_match_deck_metadata_units() {
        let temp = tempfile::tempdir().expect("tempdir");
        let audio = temp.path().join("test.mp3");
        std::fs::write(&audio, vec![0u8; 320_000]).expect("audio");

        assert_eq!(duration_ms_to_seconds_ceil(119_001), 120);
        assert_eq!(duration_ms_to_seconds_ceil(120_000), 120);
        assert_eq!(estimate_track_bitrate_kbps(&audio, 8).await, 320);
        assert_eq!(estimate_track_bitrate_kbps(&audio, 0).await, 0);
    }

    fn sample_track_record() -> TrackRecord {
        TrackRecord {
            track_id: 42,
            title: "Science Fiction".to_string(),
            artist: "Brunello".to_string(),
            artist_id: stable_text_id("Brunello"),
            canonical_name: "Brunello - Science Fiction".to_string(),
            album: "Science Fiction".to_string(),
            album_id: stable_text_id("Science Fiction"),
            duration_sec: 367,
            bpm_hundreds: 12250,
            key: "8A".to_string(),
            camelot: "8A".to_string(),
            key_id: stable_text_id("8A"),
            bitrate_kbps: 320,
            comment: "test comment".to_string(),
            mount_path: PathBuf::from("/Users/gakonst/Music/Brunello - Science Fiction.mp3"),
            analysis_dat_path: None,
            analysis_ext_path: None,
            analysis_twoex_path: None,
            artwork_id: 123,
            artwork_url: Some("https://i.scdn.co/image/test-artwork".to_string()),
            genre: "House".to_string(),
            genre_id: stable_text_id("House"),
            label: "Test Label".to_string(),
            year: 2026,
            date_added_id: stable_text_id("2026-05-13"),
            date_added: "2026-05-13".to_string(),
        }
    }

    fn entry_ids(entries: &[MenuEntry]) -> BTreeSet<u32> {
        entries.iter().map(|entry| entry.entry_id2).collect()
    }

    fn entry_types(entries: &[MenuEntry]) -> BTreeSet<u32> {
        entries.iter().map(|entry| entry.entry_type).collect()
    }

    fn test_cdj_status(source_player: u8, track_id: u32, play_state_1: u8) -> CdjStatusSnapshot {
        CdjStatusSnapshot {
            player: 3,
            active: 0,
            source_player,
            source_slot: SLOT_REKORDBOX,
            track_type: if track_id == 0 {
                0
            } else {
                TRACK_TYPE_REKORDBOX
            },
            track_id,
            track_position: 1,
            sort_state: 0,
            source_menu: 0,
            source_category_1: 0,
            source_category_2: 0,
            menu_track_count: 0,
            flags: 0xa4,
            play_state_1,
            play_state_2: 0xfa,
            play_state_3: 0x09,
            pitch_1: 0x0010_0000,
            pitch_2: 0x0010_0000,
            bpm_hundreds: 12_200,
            beat_in_bar: 1,
            master_meaningful: 1,
            master_handoff: 0xff,
            master_tempo: None,
            key: None,
            key_shift_cents: None,
            p4: None,
            bar_steps: None,
            bar_position: None,
            buffer_forward: None,
            buffer_back: None,
            loop_start_raw: None,
            loop_end_raw: None,
            loop_beats: None,
        }
    }

    fn test_state_with_sample_library(playlist_id: u32) -> ServerState {
        let mut track = sample_track_record();
        track.artwork_id = 0;
        track.artwork_url = None;
        let playlist = PlaylistRecord {
            playlist_id,
            name: "Maccabi Test".to_string(),
            parent_id: 0,
            is_folder: false,
            sequence: 1,
            tracks: vec![track.track_id],
        };
        let mut state = test_state();
        state.library = Arc::new(LibrarySnapshot {
            master_db_id: 0x0102_0304,
            tracks_by_id: [(track.track_id, track.clone())].into_iter().collect(),
            all_tracks: vec![track],
            playlists: vec![playlist],
        });
        state.search_index = SearchIndex::new(&state.library);
        state
    }

    fn write_test_anlz_tag(path: &Path, tag_name: &[u8; 4], payload: &[u8]) {
        write_test_anlz_tags(path, &[(tag_name, payload)]);
    }

    fn test_pqtz_tag(entries: &[(u16, u16, u32)]) -> Vec<u8> {
        let mut tag = Vec::with_capacity(24 + entries.len() * 8);
        tag.extend_from_slice(b"PQTZ");
        tag.extend_from_slice(&24u32.to_be_bytes());
        tag.extend_from_slice(&((24 + entries.len() * 8) as u32).to_be_bytes());
        tag.extend_from_slice(&0u32.to_be_bytes());
        tag.extend_from_slice(&0x0008_0000u32.to_be_bytes());
        tag.extend_from_slice(&(entries.len() as u32).to_be_bytes());
        for (beat, tempo, time_ms) in entries {
            tag.extend_from_slice(&beat.to_be_bytes());
            tag.extend_from_slice(&tempo.to_be_bytes());
            tag.extend_from_slice(&time_ms.to_be_bytes());
        }
        tag
    }

    fn test_simple_anlz_tag(tag_name: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut tag = Vec::with_capacity(12 + payload.len());
        tag.extend_from_slice(tag_name);
        tag.extend_from_slice(&12u32.to_be_bytes());
        tag.extend_from_slice(&((12 + payload.len()) as u32).to_be_bytes());
        tag.extend_from_slice(payload);
        tag
    }

    fn test_pqt2_tag(count: u32, last_beat_ms: u32) -> Vec<u8> {
        let mut payload = Vec::with_capacity(44 + count as usize * 2);
        payload.extend_from_slice(&0u32.to_be_bytes());
        payload.extend_from_slice(&0x0200_0002u32.to_be_bytes());
        payload.extend_from_slice(&0u32.to_be_bytes());
        payload.extend_from_slice(&0x0001_319cu32.to_be_bytes());
        payload.extend_from_slice(&0u32.to_be_bytes());
        payload.extend_from_slice(&0x0001_319cu32.to_be_bytes());
        payload.extend_from_slice(&last_beat_ms.to_be_bytes());
        payload.extend_from_slice(&count.to_be_bytes());
        payload.extend_from_slice(&0u32.to_be_bytes());
        payload.extend_from_slice(&0u32.to_be_bytes());
        payload.extend_from_slice(&0u32.to_be_bytes());
        payload.resize(44 + count as usize * 2, 0);
        let mut tag = Vec::with_capacity(12 + payload.len());
        tag.extend_from_slice(b"PQT2");
        tag.extend_from_slice(&56u32.to_be_bytes());
        tag.extend_from_slice(&((12 + payload.len()) as u32).to_be_bytes());
        tag.extend_from_slice(&payload);
        tag
    }

    fn write_test_anlz_tags(path: &Path, tags: &[(&[u8; 4], &[u8])]) {
        let file_len = 28
            + tags
                .iter()
                .map(|(_, payload)| 12 + payload.len())
                .sum::<usize>();
        let mut data = Vec::new();
        data.extend_from_slice(b"PMAI");
        data.extend_from_slice(&28u32.to_be_bytes());
        data.extend_from_slice(&(file_len as u32).to_be_bytes());
        data.extend_from_slice(&[0u8; 16]);
        for (tag_name, payload) in tags {
            let tag_len = 12 + payload.len();
            data.extend_from_slice(*tag_name);
            data.extend_from_slice(&16u32.to_be_bytes());
            data.extend_from_slice(&(tag_len as u32).to_be_bytes());
            data.extend_from_slice(payload);
        }
        std::fs::write(path, data).expect("write anlz");
    }

    fn write_test_anlz_sections(path: &Path, sections: &[Vec<u8>]) {
        let file_len = 28 + sections.iter().map(Vec::len).sum::<usize>();
        let mut data = Vec::new();
        data.extend_from_slice(b"PMAI");
        data.extend_from_slice(&28u32.to_be_bytes());
        data.extend_from_slice(&(file_len as u32).to_be_bytes());
        data.extend_from_slice(&[0u8; 16]);
        for section in sections {
            data.extend_from_slice(section);
        }
        std::fs::write(path, data).expect("write anlz");
    }

    fn test_pcp2_entry(
        hot_cue: u32,
        cue_type: u8,
        time_ms: u32,
        loop_ms: u32,
        color: u8,
    ) -> Vec<u8> {
        let mut entry = Vec::new();
        entry.extend_from_slice(b"PCP2");
        entry.extend_from_slice(&16u32.to_be_bytes());
        entry.extend_from_slice(&32u32.to_be_bytes());
        entry.extend_from_slice(&hot_cue.to_be_bytes());
        entry.push(cue_type);
        entry.extend_from_slice(&[0, 0x03, 0xe8]);
        entry.extend_from_slice(&time_ms.to_be_bytes());
        entry.extend_from_slice(&loop_ms.to_be_bytes());
        entry.push(color);
        entry.extend_from_slice(&[0; 3]);
        entry
    }

    fn test_pcob_tag(cue_type: u32, entries: &[Vec<u8>]) -> Vec<u8> {
        let tag_len = 24 + entries.iter().map(Vec::len).sum::<usize>();
        let mut tag = Vec::new();
        tag.extend_from_slice(b"PCOB");
        tag.extend_from_slice(&24u32.to_be_bytes());
        tag.extend_from_slice(&(tag_len as u32).to_be_bytes());
        tag.extend_from_slice(&cue_type.to_be_bytes());
        tag.extend_from_slice(&0u16.to_be_bytes());
        tag.extend_from_slice(&(entries.len() as u16).to_be_bytes());
        tag.extend_from_slice(&u32::MAX.to_be_bytes());
        for entry in entries {
            tag.extend_from_slice(entry);
        }
        tag
    }

    fn test_pcpt_entry(hot_cue: u32, cue_type: u8, time_ms: u32, loop_ms: u32) -> Vec<u8> {
        let mut entry = vec![0u8; 56];
        entry[0..4].copy_from_slice(b"PCPT");
        entry[4..8].copy_from_slice(&28u32.to_be_bytes());
        entry[8..12].copy_from_slice(&56u32.to_be_bytes());
        entry[12..16].copy_from_slice(&hot_cue.to_be_bytes());
        entry[28] = cue_type;
        entry[29..32].copy_from_slice(&[0, 0x03, 0xe8]);
        entry[32..36].copy_from_slice(&time_ms.to_be_bytes());
        entry[36..40].copy_from_slice(&loop_ms.to_be_bytes());
        entry
    }

    fn test_state() -> ServerState {
        let (actor_tx, actor_rx) = ServerActor::channel();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(ServerActor::default().run(actor_rx));
        }
        let library = Arc::new(LibrarySnapshot {
            master_db_id: 0x0102_0304,
            tracks_by_id: BTreeMap::new(),
            all_tracks: Vec::new(),
            playlists: Vec::new(),
        });
        let search_index = SearchIndex::new(&library);
        ServerState {
            config: DjLinkConfig::default(),
            bind_ip: Ipv4Addr::LOCALHOST,
            broadcast_ip: Ipv4Addr::LOCALHOST,
            mac_addr: "02:00:00:00:00:01".to_string(),
            interface_name: None,
            raw_udp: RawUdpTx::disabled(),
            library,
            search_index,
            actor_tx,
            log_path: None,
        }
    }
}
