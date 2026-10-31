use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::{Path, PathBuf};
#[cfg(not(target_os = "ios"))]
use std::process::Command;
use std::sync::atomic::{AtomicU16, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use tokio::io::{AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::task::{AbortHandle, JoinHandle as TokioJoinHandle, JoinSet};
use tracing::{debug, trace, warn};

use crate::actor::{
    LoadProgressRecordResult as ActorLoadProgressRecordResult, ServerActor, ServerActorSender,
    ServerMsg,
};
use crate::db::*;
use crate::history::HistoryRecord;
use crate::ids::stable_text_id;
use crate::library::{LibrarySnapshot, TrackRecord, compatible_camelot_keys, parse_camelot_key};
use crate::load::{
    LOAD_CONTEXT_ARTIST_MENU, LOAD_CONTEXT_CATEGORY_1_OFFSET, LOAD_CONTEXT_CATEGORY_2_OFFSET,
    LOAD_CONTEXT_MENU_COUNT_OFFSET, LOAD_CONTEXT_OFFSET, LoadConfirmContext, LoadProgressSnapshot,
};
use crate::network::{
    RawUdpDatagram, RawUdpReceived, RawUdpTx, bind_udp, connect_tcp, parse_mac,
    spawn_raw_udp_receiver,
};
pub use crate::nfs::NFS_PORT;
use crate::nfs::{
    NFS_READ_CHUNK_MAX, NfsContext, NfsState, PORTMAP_GETPORT, RPC_PORTMAP_PROG,
    handle_mount_packet, handle_nfs_datagram, nfs_export_path, portmap_getport,
    read_file_chunk as read_nfs_file_chunk, resolve_child_path,
};
use crate::protocol::keepalive::{self, KeepaliveBody, KeepaliveKind};
use crate::protocol::stagehand;
use crate::protocol::status;
use crate::protocol::{be_u24, be_u32, decode_hex, rpc_parse_call, rpc_reply_header};
use crate::search::{
    SearchIndex, normalize_search_text, search_entries_indexed, search_query_from_args,
    search_sort_from_args,
};
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
const DJLINK_INTERFACE_WAIT: Duration = Duration::from_secs(5);
const DJLINK_INTERFACE_POLL: Duration = Duration::from_millis(100);
const PREPARE_LOAD_SETTINGS_OVERRIDES: &[(usize, u8)] = &[(0x2f, 0x88), (0x46, 0x81), (0x48, 0x83)];
const PSSI_XOR_MASK: [u8; 19] = [
    0xcb, 0xe1, 0xee, 0xfa, 0xe5, 0xee, 0xad, 0xee, 0xe9, 0xd2, 0xe9, 0xeb, 0xe1, 0xe9, 0xf3, 0xe8,
    0xe9, 0xf4, 0xe1,
];

const LOAD_TRACK_PAYLOAD_TEMPLATE: [u8; 57] = [
    0x01, 0x00, 0x0d, 0x00, 0x34, 0x0d, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x32, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

const BEAT_STATUS_TEMPLATE_HEX: &str = "5173707431576d4a4f4c2872656b6f7264626f780000000000000000000000010111003c000001cd0000039a000001cd000007350000090200000e6affffffffffffffffffffffffffffffffffffffffffffffff00100000000032cd04000011";

// Instant has no portable epoch; expose its age in milliseconds at serialization.
fn serialize_last_seen<S: serde::Serializer>(
    seen: &Instant,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_u64(seen.elapsed().as_millis().min(u64::MAX as u128) as u64)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct LinkDevice {
    pub player_number: u8,
    pub ip_addr: Ipv4Addr,
    pub mac_addr: String,
    pub model: String,
    #[serde(serialize_with = "serialize_last_seen")]
    pub last_seen: Instant,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct DjLinkConfig {
    pub source_name: String,
    pub model_name: String,
    pub player_number: u8,
    pub bind_ip: Option<Ipv4Addr>,
    pub broadcast_ip: Option<Ipv4Addr>,
    /// Discover local peers with unicast probes and use kernel sockets only.
    /// The mask must be the selected interface's actual IPv4 netmask.
    pub unicast_discovery_netmask: Option<Ipv4Addr>,
    /// Optional bounded cache of verified peers, used only as discovery hints.
    pub discovery_cache_path: Option<PathBuf>,
    pub db_server_port: u16,
    pub mount_port: Option<u16>,
    pub announce_interval: Duration,
    pub log_level: LogLevel,
    pub log_path: Option<PathBuf>,
    pub wire_capture_path: Option<PathBuf>,
    pub serve_extended_anlz_tags: bool,
    pub emit_beat_clock: bool,
    pub stagehand_monitor: bool,
    pub stagehand_target_ip: Option<Ipv4Addr>,
    pub stagehand_target_mac: Option<String>,
    pub stagehand_session_ip: Option<Ipv4Addr>,
    pub stagehand_session_nonce: Option<u64>,
    pub stagehand_protocol_nonce: Option<u64>,
    pub tcp_track_file_side_channel: bool,
    pub db_auto_load: bool,
    pub auto_load_confirm: bool,
    pub auto_unlock_load_lock: bool,
    pub load_rekordbox_command_variant: bool,
    pub load_payload_byte_overrides: Vec<(usize, u8)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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
            unicast_discovery_netmask: None,
            discovery_cache_path: None,
            db_server_port: DEFAULT_DBSERVER_PORT,
            mount_port: Some(DEFAULT_MOUNT_PORT),
            announce_interval: FAST_ANNOUNCE_INTERVAL,
            log_level: LogLevel::Info,
            log_path: None,
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

#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct DjLinkWaveformBeat {
    pub beat: u8,
    pub time_seconds: f32,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct DjLinkWaveform {
    pub duration_seconds: u32,
    pub peaks: Vec<f32>,
    pub colors: Vec<[u8; 3]>,
    pub beat_grid: Vec<DjLinkWaveformBeat>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DjLinkTrackMetadata {
    pub track_id: u32,
    pub key: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_sec: u32,
    pub artwork_url: Option<String>,
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
    load_settings_overrides: Vec<(usize, u8)>,
}

struct ActiveLoadCommand {
    generation: u64,
    track_id: u32,
    abort: AbortHandle,
    reply: oneshot::Sender<Result<usize>>,
}

#[derive(Debug, Clone, serde::Serialize)]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct DjLinkPhraseCue {
    pub phrase_beat: u16,
    pub cue_beat: u16,
    pub cue_ms: u32,
    pub bars_before: u16,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DjLinkAnlzProfile {
    pub tag: String,
    pub ext: String,
    pub bytes: Option<usize>,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, serde::Serialize)]
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

#[derive(Debug, Clone, serde::Serialize)]
pub struct DjLinkTrackProfileItem {
    pub track_id: u32,
    pub label: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DjLinkKeyDistanceProfile {
    pub distance: u32,
    pub bucket_count: usize,
    pub track_hits: usize,
    pub unique_track_count: usize,
    pub elapsed_us: u128,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DjLinkKeyBucketProfile {
    pub key_id: u32,
    pub key_label: String,
    pub distance: u32,
    pub track_count: usize,
    pub elapsed_us: u128,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DjLinkSearchProfile {
    pub query: String,
    pub mode: DjLinkSearchMode,
    pub normalized_query: String,
    pub result_count: usize,
    pub elapsed_us: u128,
    pub items: Vec<DjLinkSearchProfileItem>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DjLinkSearchProfileItem {
    pub entry_id: u32,
    pub entry_type: u32,
    pub label: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct DjLinkMonitorSnapshot {
    pub status: Option<String>,
    pub beat: Option<String>,
    pub position: Option<String>,
    pub deck: Option<DjLinkDeckState>,
}

/// Stable, structured telemetry for applications monitoring one physical deck.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DjLinkDeckState {
    pub player: u8,
    pub active: bool,
    pub on_air: bool,
    pub source_player: u8,
    pub source_slot: u8,
    pub track_type: u8,
    pub track_id: Option<u32>,
    pub playing: bool,
    pub play_state: &'static str,
    pub synced: bool,
    pub tempo_master: bool,
    pub bpm_hundreds: Option<u16>,
    pub effective_bpm_hundreds: Option<u32>,
    pub pitch_centi_percent: i32,
    pub master_tempo: Option<bool>,
    pub key_shift_cents: Option<i64>,
    pub effective_key: Option<String>,
    pub beat_in_bar: u8,
    pub beat_number: Option<u32>,
    pub track_progress_milli: Option<u16>,
    pub track_length_sec: Option<u32>,
    pub playhead_ms: Option<u32>,
    pub playhead_source: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum DjLinkTelemetryKind {
    Device,
    Status,
    Beat,
    Position,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DjLinkTelemetryEvent {
    pub kind: DjLinkTelemetryKind,
    pub player: u8,
    pub deck: Option<DjLinkDeckState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct DjLinkMixerChannelState {
    pub channel: u8,
    pub input_source: u8,
    pub trim: u8,
    pub eq_high: u8,
    pub eq_mid: u8,
    pub eq_low: u8,
    pub color: u8,
    pub fader: u8,
    pub crossfader_assign: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DjLinkMixerState {
    pub channels: [DjLinkMixerChannelState; 4],
    pub crossfader: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DjLinkMixerTelemetryEvent {
    pub source_ip: Ipv4Addr,
    pub mixer: DjLinkMixerState,
    pub raw_packet: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DjLinkVuTelemetryEvent {
    pub source_ip: Ipv4Addr,
    pub channels: BTreeMap<u8, Vec<[u16; 2]>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
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
    pub async fn new(mut config: DjLinkConfig, library: LibrarySnapshot) -> Result<Self> {
        init_djlink_tracing(config.log_path.clone(), config.log_level).await?;
        let bind_ip = match config.bind_ip {
            Some(ip) => ip,
            None => default_ip().context("failed to choose DJ Link bind IP")?,
        };
        let broadcast_ip = config
            .broadcast_ip
            .unwrap_or_else(|| default_broadcast_ip(bind_ip));
        if let Some(mask) = config.unicast_discovery_netmask {
            anyhow::ensure!(
                !config.stagehand_monitor
                    || config.stagehand_session_ip.is_none_or(|ip| ip == bind_ip),
                "Unicast Stagehand must use the bound interface address"
            );
            discovery_addresses(bind_ip, mask)?;
        }
        let interface_name = default_interface_name(bind_ip);
        let log_path = config.log_path.clone();
        let raw_udp = if config.unicast_discovery_netmask.is_some() {
            RawUdpTx::disabled()
        } else {
            RawUdpTx::spawn(interface_name.clone(), config.wire_capture_path.clone())
                .context("failed to initialize raw wire capture")?
        };
        let mac_addr = default_mac(bind_ip);
        // The real Stagehand app is a separate network host. Keep that identity
        // distinct from the Rekordbox source on broadcast networks. Kernel-only
        // unicast uses the real address with distinct protocol identities for
        // Rekordbox sharing and Stagehand monitoring.
        // Kernel-only sessions must reuse their protocol identity at the same
        // real IP. Players can retain the first claim across app restarts.
        let kernel_identity = (config.unicast_discovery_netmask.is_some()
            || config.stagehand_session_ip == Some(bind_ip))
        .then_some(u64::from(u32::from(bind_ip)));
        let stagehand_session_nonce = config.stagehand_monitor.then(|| {
            config
                .stagehand_session_nonce
                .or(kernel_identity)
                .unwrap_or_else(stagehand_launch_nonce)
        });
        let stagehand_protocol_nonce = config.stagehand_monitor.then(|| {
            config
                .stagehand_protocol_nonce
                .or(kernel_identity.map(|identity| identity ^ 0x7374_6167_6568_616e))
                .unwrap_or_else(stagehand_launch_nonce)
        });
        config.stagehand_session_nonce = stagehand_session_nonce;
        config.stagehand_protocol_nonce = stagehand_protocol_nonce;
        let stagehand_ip = config.stagehand_monitor.then(|| {
            config.stagehand_session_ip.unwrap_or_else(|| {
                if config.unicast_discovery_netmask.is_some() {
                    bind_ip
                } else {
                    isolated_stagehand_ip(bind_ip, stagehand_session_nonce.unwrap())
                }
            })
        });
        config.stagehand_session_ip = stagehand_ip;
        let stagehand_link_mac = stagehand_session_nonce.map(|nonce| {
            stagehand_link_mac(
                parse_mac(&mac_addr).expect("detected interface MAC is valid"),
                nonce,
            )
        });
        let library_generation =
            tokio::task::spawn_blocking(move || LibraryGeneration::new(library))
                .await
                .context("initial library generation preparation failed")?;
        let (actor_tx, actor_rx) = ServerActor::channel();
        let (telemetry_tx, _) = broadcast::channel(1_024);
        let (mixer_telemetry_tx, _) = broadcast::channel(1_024);
        let (vu_telemetry_tx, _) = broadcast::channel(1_024);
        let initial_bpm = if config.emit_beat_clock { 13_005 } else { 0 };
        let state = Arc::new(ServerState {
            config,
            bind_ip,
            broadcast_ip,
            mac_addr,
            stagehand_ip,
            stagehand_link_mac,
            raw_udp,
            interface_name,
            library_generation: RwLock::new(Arc::new(library_generation)),
            history: RwLock::new(Vec::new()),
            library_refresh: tokio::sync::Mutex::new(()),
            actor_tx,
            telemetry_tx,
            mixer_telemetry_tx,
            vu_telemetry_tx,
            stagehand_last_a9_ms: AtomicU64::new(0),
            stagehand_rejoin_requested_ms: AtomicU64::new(0),
            log_path,
            cue_overrides_ms: RwLock::new(HashMap::new()),
            timing_loaded: tokio::sync::Mutex::new(HashSet::new()),
            master_bpm_hundreds: AtomicU16::new(initial_bpm),
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

    pub fn stagehand_session_nonce(&self) -> Option<u64> {
        self.state.config.stagehand_session_nonce
    }

    pub fn stagehand_session_ip(&self) -> Option<Ipv4Addr> {
        self.state.config.stagehand_session_ip
    }

    pub fn stagehand_protocol_nonce(&self) -> Option<u64> {
        self.state.config.stagehand_protocol_nonce
    }

    pub fn library_track_count(&self) -> usize {
        self.state.library().track_count()
    }

    pub fn library_playlist_count(&self) -> usize {
        self.state.library().playlist_count()
    }

    pub fn library_counts(&self) -> (usize, usize) {
        let library = self.state.library();
        (library.track_count(), library.playlist_count())
    }

    /// Publish committed playback history without replacing the library or reconnecting decks.
    pub fn set_history(&self, history: Vec<HistoryRecord>) {
        *self.state.history.write().expect("history lock poisoned") = history;
    }

    pub fn history(&self) -> Vec<HistoryRecord> {
        self.state
            .history
            .read()
            .expect("history lock poisoned")
            .clone()
    }

    /// Publish a complete library generation without closing any deck connection.
    /// Audio exports from earlier generations stay valid until the server stops.
    pub async fn refresh_library(&self, library: LibrarySnapshot) -> Result<DjLinkLibraryRefresh> {
        let _refresh = self.state.library_refresh.lock().await;
        let previous = self.state.library();
        let (generation, exports) = tokio::task::spawn_blocking(move || {
            let mut next = LibraryGeneration::new(library);
            let added_paths = next
                .nfs_exports
                .paths
                .difference(&previous.nfs_exports.paths)
                .cloned()
                .collect();
            let exports = NfsState::from_exports(&added_paths);
            next.nfs_exports
                .files
                .extend(previous.nfs_exports.files.iter().cloned());
            next.nfs_exports
                .paths
                .extend(previous.nfs_exports.paths.iter().cloned());
            next.nfs_exports.aliases.extend(
                previous
                    .nfs_exports
                    .aliases
                    .iter()
                    .map(|(alias, path)| (alias.clone(), path.clone())),
            );
            (next, exports)
        })
        .await
        .context("library generation preparation failed")?;
        if self.actor_rx.is_none() {
            self.state
                .actor_reply(|reply| ServerMsg::ExtendNfsExports { exports, reply })
                .await
                .context("DJ Link actor stopped during library refresh")?;
        }
        let result = DjLinkLibraryRefresh {
            tracks: generation.track_count(),
            playlists: generation.playlist_count(),
            changed: true,
        };
        let retired = {
            let mut current = self
                .state
                .library_generation
                .write()
                .expect("library generation lock poisoned");
            std::mem::replace(&mut *current, Arc::new(generation))
        };
        // Releasing a large old index/cache must not happen under the reader lock.
        let _ = tokio::task::spawn_blocking(move || drop(retired)).await;
        Ok(result)
    }

    pub fn resolve_library_track(&self, selector: &str) -> LinkResult<(usize, TrackRecord)> {
        let library = self.state.library();
        let track = library.resolve_track_selector(selector)?;
        let order = library
            .all_tracks
            .iter()
            .position(|candidate| candidate.track_id == track.track_id)
            .map(|index| index + 1)
            .unwrap_or(1);
        Ok((order, track.clone()))
    }

    pub fn library_track_metadata(&self, track_id: u32) -> Option<DjLinkTrackMetadata> {
        let library = self.state.library();
        let track = library.tracks_by_id.get(&track_id)?;
        Some(DjLinkTrackMetadata {
            track_id,
            key: track.key_label(),
            title: track.title.clone(),
            artist: track.artist.clone(),
            album: track.album.clone(),
            duration_sec: track.duration_sec,
            artwork_url: track.artwork_url.clone(),
        })
    }

    pub async fn library_waveform(&self, track_id: u32) -> Option<DjLinkWaveform> {
        let library = self.state.library();
        let track = library.tracks_by_id.get(&track_id)?;
        // A scrolling beat-grid view needs full RGB detail. PWV4/PWAV are
        // whole-track previews and look blocky when expanded to eight bars.
        let mut waveform = None;
        for name in ["PWV5", "PWV4", "PWAV"] {
            let Some(tag) = read_anlz_tag(track, name, None).await else {
                continue;
            };
            let decoded = match name {
                "PWV5" => waveform_from_pwv5_tag(&tag),
                "PWV4" => waveform_from_pwv4_tag(&tag),
                _ => waveform_from_pwav_tag(&tag),
            };
            if decoded.as_ref().is_some_and(|(peaks, _)| !peaks.is_empty()) {
                waveform = decoded;
                break;
            }
        }
        let (peaks, colors) = waveform.unwrap_or_default();
        let beat_grid = match read_anlz_tag(track, "PQTZ", None).await {
            Some(tag) => waveform_beats_from_pqtz_tag(&tag).unwrap_or_default(),
            None => Vec::new(),
        };
        Some(DjLinkWaveform {
            duration_seconds: track.duration_sec,
            peaks,
            colors,
            beat_grid,
        })
    }

    pub async fn phrase_cue_before_chorus(
        &self,
        track_id: u32,
        bars_before: u16,
    ) -> Result<DjLinkPhraseCue> {
        let library = self.state.library();
        let track = library
            .tracks_by_id
            .get(&track_id)
            .with_context(|| format!("track {track_id} is not in the served library"))?;
        let pssi = read_anlz_tag(track, "PSSI", None)
            .await
            .context("track has no Rekordbox phrase analysis (PSSI)")?;
        let phrase = first_chorus_beat_from_pssi(&pssi)
            .context("Rekordbox phrase analysis contains no chorus")?;
        let cue_beat = phrase.saturating_sub(bars_before.saturating_mul(4)).max(1);
        let pqtz = read_anlz_tag(track, "PQTZ", None)
            .await
            .context("track has no Rekordbox beat grid (PQTZ)")?;
        let cue_ms = pqtz_beat_time_ms(&pqtz, cue_beat)
            .with_context(|| format!("beat grid has no beat {cue_beat}"))?;
        Ok(DjLinkPhraseCue {
            phrase_beat: phrase,
            cue_beat,
            cue_ms,
            bars_before,
        })
    }

    pub fn set_memory_cue_override(&self, track_id: u32, cue_ms: u32) -> Result<()> {
        if !self.state.library().tracks_by_id.contains_key(&track_id) {
            bail!("track {track_id} is not in the served library");
        }
        self.state
            .cue_overrides_ms
            .write()
            .expect("cue override lock poisoned")
            .insert(track_id, cue_ms);
        Ok(())
    }

    pub async fn set_player_bpm(&self, target_player: u8, bpm_hundreds: u16) -> Result<bool> {
        if !(4_000..=30_000).contains(&bpm_hundreds) {
            bail!("BPM must be between 40.00 and 300.00");
        }
        self.state
            .master_bpm_hundreds
            .store(bpm_hundreds, Ordering::Relaxed);
        tokio::time::sleep(Duration::from_millis(120)).await;
        if let Err(error) = self
            .send_sync_control_command(target_player, None, SyncControlCommand::SyncOn)
            .await
        {
            self.state.master_bpm_hundreds.store(0, Ordering::Relaxed);
            return Err(error);
        }

        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            if self
                .state
                .status_snapshot(target_player)
                .await
                .is_some_and(|status| {
                    status.is_synced()
                        && effective_bpm_hundreds(status.bpm_hundreds, status.pitch_1).is_some_and(
                            |effective| effective.abs_diff(u32::from(bpm_hundreds)) <= 2,
                        )
                })
            {
                return Ok(true);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok(false)
    }

    pub fn first_track_id(&self) -> Option<u32> {
        self.state
            .library()
            .all_tracks
            .first()
            .map(|track| track.track_id)
    }

    pub fn log_path(&self) -> Option<PathBuf> {
        self.state.log_path.clone()
    }

    pub async fn profile_track_load(&self, track_id: u32) -> Result<DjLinkLoadProfile> {
        let library = self.state.library();
        let track = library
            .tracks_by_id
            .get(&track_id)
            .cloned()
            .with_context(|| format!("unknown track id {track_id}"))?;
        let total_start = Instant::now();

        let args = vec![DbValue::Int32(track.track_id)];
        let preview_args = vec![DbValue::Int32(0), DbValue::Int32(track.track_id)];

        let started = Instant::now();
        let waveform_preview = load_waveform_preview(&library, &preview_args).await;
        let waveform_preview_ms = started.elapsed().as_millis();

        let started = Instant::now();
        let waveform_detail = load_waveform_detail(&library, &args).await;
        let waveform_detail_ms = started.elapsed().as_millis();

        let started = Instant::now();
        let beat_grid = load_beat_grid(&library, &args).await;
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
                &library,
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
        let library = &self.state.library();
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
        let library = self.state.library();
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
        let entries = search_entries_indexed(&library, &library.search_index, &args);
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

    pub fn subscribe_telemetry(&self) -> broadcast::Receiver<DjLinkTelemetryEvent> {
        self.state.telemetry_tx.subscribe()
    }

    pub fn subscribe_mixer_telemetry(&self) -> broadcast::Receiver<DjLinkMixerTelemetryEvent> {
        self.state.mixer_telemetry_tx.subscribe()
    }

    /// Kernel-resolved IPv4 neighbours on this session's network interface.
    /// Discovery announcements alone do not establish a working return route.
    /// Preserve route-table permission failures instead of reporting an empty LAN.
    pub fn resolved_neighbours(&self) -> Result<Vec<Ipv4Addr>> {
        crate::discovery::neighbours(self.state.interface_name.as_deref())
            .context("failed to read DJ Link interface neighbours")
    }

    pub async fn network_diagnostics(&self) -> serde_json::Value {
        let devices = if self.tasks.is_empty() {
            Vec::new()
        } else {
            self.state.devices_sorted().await
        };
        self.state.network_diagnostics(devices)
    }

    pub fn subscribe_vu_telemetry(&self) -> broadcast::Receiver<DjLinkVuTelemetryEvent> {
        self.state.vu_telemetry_tx.subscribe()
    }

    pub async fn start(&mut self) -> Result<()> {
        if !self.tasks.is_empty() {
            return Ok(());
        }

        let unicast = self.state.config.unicast_discovery_netmask.is_some();
        // IP_BOUND_IF confines Apple wildcard listeners to the selected cable.
        // Directed discovery changes how we send, not which peer announcements
        // we should receive. Binding our individual IP loses every broadcast
        // keepalive, leaving additional decks dependent on the fallback scan.
        let receive_ip =
            if !unicast || (cfg!(target_vendor = "apple") && self.state.interface_name.is_some()) {
                Ipv4Addr::UNSPECIFIED
            } else {
                self.state.bind_ip
            };
        let keepalive_sock = bind_udp(
            SocketAddrV4::new(receive_ip, KEEPALIVE_PORT),
            self.state.interface_name.as_deref(),
            !unicast,
        )
        .context("failed to bind UDP/50000 keepalive")?;

        let status_sock = bind_udp(
            SocketAddrV4::new(self.state.bind_ip, STATUS_PORT),
            self.state.interface_name.as_deref(),
            !unicast,
        )
        .context("failed to bind UDP/50002 status")?;

        // Discovery can use directed packets while decks still broadcast beats
        // and precise positions. An address-specific bind drops those packets.
        // Darwin's IP_BOUND_IF keeps this listener on the chosen DJ Link cable;
        // receiving does not enable broadcast sends on the unicast transport.
        let beat_receive_ip =
            if cfg!(target_vendor = "apple") && self.state.interface_name.is_some() {
                Ipv4Addr::UNSPECIFIED
            } else {
                receive_ip
            };
        let (beat_tx_sock, beat_rx_sock) = match bind_udp(
            SocketAddrV4::new(beat_receive_ip, BEAT_PORT),
            self.state.interface_name.as_deref(),
            !unicast,
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
                    !unicast,
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
            SocketAddrV4::new(receive_ip, PORTMAP_PORT),
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
            tracks = self.state.library().track_count(),
            playlists = self.state.library().playlist_count(),
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
        self.tasks.push(tokio::spawn(
            ServerActor::with_telemetry(self.state.telemetry_tx.clone())
                .with_nfs_exports(&self.state.library().nfs_exports.paths)
                .run(actor_rx),
        ));
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
        if let Some(mask) = self.state.config.unicast_discovery_netmask {
            self.tasks.push(spawn_unicast_discovery(
                self.state.clone(),
                keepalive_sock.clone(),
                status_sock.clone(),
                mask,
            ));
        }
        if self.state.config.stagehand_monitor {
            if let Some(stagehand_ip) = self
                .state
                .stagehand_ip
                .filter(|stagehand_ip| *stagehand_ip != self.state.bind_ip)
            {
                let raw_rx = spawn_raw_udp_receiver(
                    self.state.interface_name.as_deref(),
                    self.state
                        .stagehand_link_mac
                        .unwrap_or(parse_mac(&self.state.mac_addr)?),
                    stagehand_ip,
                )
                .context("failed to start isolated Stagehand receiver")?;
                self.tasks
                    .push(spawn_stagehand_raw_rx(self.state.clone(), raw_rx));
            }
            self.tasks.push(if unicast {
                spawn_unicast_stagehand(
                    self.state.clone(),
                    keepalive_sock.clone(),
                    status_sock.clone(),
                )
            } else {
                spawn_stagehand_announce(
                    self.state.clone(),
                    keepalive_sock.clone(),
                    status_sock.clone(),
                )
            });
        }
        self.tasks
            .push(spawn_link_init(self.state.clone(), status_sock.clone()));
        self.tasks
            .push(spawn_status(self.state.clone(), status_sock.clone()));
        self.tasks
            .push(spawn_mixer_status(self.state.clone(), status_sock.clone()));
        self.tasks
            .push(spawn_beat_status(self.state.clone(), beat_tx_sock.clone()));
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

        if crate::diagnostics::initialized() {
            let state = self.state.clone();
            self.tasks.push(tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(5));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    interval.tick().await;
                    let devices = state.devices_sorted().await;
                    crate::diagnostics::event(
                        "djlink_network_context",
                        state.network_diagnostics(devices),
                    );
                }
            }));
        }

        send_startup_link_init(&self.state, &status_sock).await;
        if !self.state.config.stagehand_monitor {
            self.tasks
                .push(spawn_startup_hello(self.state.clone(), keepalive_sock));
        }
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
        let (target_player, target_ip) = self.resolve_load_target(target_player).await?;
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
            load_settings_overrides: Vec::new(),
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
            load_settings_overrides: Vec::new(),
        })
        .await
    }

    pub async fn send_prepared_track(
        &self,
        target_player: u8,
        track_id: u32,
        repeat: usize,
        interval: Duration,
    ) -> Result<usize> {
        let (target_player, target_ip) = self.resolve_load_target(target_player).await?;
        self.enqueue_load_track(LoadCommandSpec {
            target_player,
            target_ip,
            track_id,
            source_player: self.state.config.player_number,
            source_slot: SLOT_REKORDBOX,
            source_track_type: TRACK_TYPE_REKORDBOX,
            attempts: repeat.max(1),
            retry_interval: interval,
            load_settings_overrides: PREPARE_LOAD_SETTINGS_OVERRIDES.to_vec(),
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

    async fn resolve_load_target(&self, player: u8) -> Result<(u8, Ipv4Addr)> {
        let devices = self.list_devices().await;
        if let Some(device) = devices.iter().find(|device| device.player_number == player) {
            return Ok((player, device.ip_addr));
        }
        // OMNIS announces one appliance (11) but reports the two decks as 11 and 12.
        // Human deck numbers 1/2 are aliases only when no standalone player owns them.
        if matches!(player, 1 | 2 | 12)
            && let Some(device) = devices
                .iter()
                .find(|device| device.model.eq_ignore_ascii_case("OMNIS-DUO"))
        {
            return Ok((
                if player <= 2 { player + 10 } else { player },
                device.ip_addr,
            ));
        }
        Err(LinkError::TargetPlayerNotFound {
            target_player: player,
        }
        .into())
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

    pub async fn start_player(&self, target_player: u8, track_id: u32) -> Result<bool> {
        for attempt in 0..3 {
            self.send_fader_start_command(target_player, None, true, 0x02)
                .await?;
            if attempt < 2 {
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        }

        let target_ip = self
            .list_devices()
            .await
            .into_iter()
            .find(|device| device.player_number == target_player)
            .ok_or(LinkError::TargetPlayerNotFound { target_player })?
            .ip_addr;
        let sock = self.beat_tx.as_ref().ok_or(LinkError::ServerNotRunning)?;
        let correlation =
            stagehand_correlation_byte(self.state.stagehand_ip.unwrap_or(self.state.bind_ip));
        for attempt in 0..3 {
            for action in [0x0f, 0x14] {
                let packet = build_stagehand_transport_command(correlation, 0x3a, action, true);
                send_stagehand_transport_packet(&self.state, sock, &packet, target_ip).await?;
            }
            if attempt < 2 {
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        }

        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if track_is_playing_on_player(&self.state, target_player, track_id).await {
                return Ok(true);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok(false)
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

fn build_stagehand_transport_command(
    correlation: u8,
    marker: u8,
    action: u8,
    pressed: bool,
) -> Vec<u8> {
    let mut packet = Vec::with_capacity(56);
    packet.extend_from_slice(DJLINK_MAGIC);
    packet.push(0x07);
    packet.extend_from_slice(&cstr_padded_ascii("Stagehand", 20));
    packet.extend_from_slice(&[0x01, 0x03, correlation, 0x00, 0x30]);
    packet.extend_from_slice(&[0; 20]);
    packet[0x28] = marker;
    packet[0x2c] = action;
    packet[0x2e] = u8::from(pressed);
    debug_assert_eq!(packet.len(), 56);
    packet
}

fn stagehand_correlation_byte(bind_ip: Ipv4Addr) -> u8 {
    bind_ip.octets()[3] ^ (std::process::id() as u8).rotate_left(3)
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
    let omnis = state
        .device_for_ip(spec.target_ip)
        .await
        .is_some_and(|device| device.model.eq_ignore_ascii_case("OMNIS-DUO"));
    // Verified on OMNIS: the standard packet ignores the shared-IP deck selector.
    // Keep telemetry identities for confirmation, but encode physical deck 1/2 on wire.
    let wire_player = if omnis && matches!(spec.target_player, 11 | 12) {
        spec.target_player - 10
    } else {
        spec.target_player
    };
    if state.config.tcp_track_file_side_channel {
        if let Some(track) = state.library().tracks_by_id.get(&spec.track_id) {
            let master_db_id = state.library().master_db_id;
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
    } else if state.library().tracks_by_id.contains_key(&spec.track_id) {
        tracing::debug!(
            target_player = spec.target_player,
            target_ip = %spec.target_ip,
            track_id = spec.track_id,
            master_db_id = state.library().master_db_id,
            "skipped TCP track-file side channel for CDJ load; experimental mobile side channel disabled"
        );
    }

    let settings_sent = send_load_settings_packet(
        &state,
        &sock,
        spec.target_player,
        spec.target_ip,
        &spec.load_settings_overrides,
        "load-settings before load-track command",
    )
    .await;
    if !spec.load_settings_overrides.is_empty() && !settings_sent {
        bail!(
            "failed to apply prepared load settings to player {}",
            spec.target_player
        );
    }

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
            wire_player,
            spec.source_player,
            spec.source_slot,
            spec.source_track_type,
            spec.track_id,
            omnis || state.config.load_rekordbox_command_variant,
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

struct LibraryGeneration {
    library: Arc<LibrarySnapshot>,
    search_index: SearchIndex,
    nfs_exports: crate::library::NfsExports,
    artwork_cache: RwLock<HashMap<u32, Option<Vec<u8>>>>,
    waveform_cache: RwLock<HashMap<u32, Vec<u8>>>,
}

impl LibraryGeneration {
    fn new(library: LibrarySnapshot) -> Self {
        Self {
            search_index: SearchIndex::new(&library),
            nfs_exports: library.nfs_exports(),
            library: Arc::new(library),
            artwork_cache: RwLock::new(HashMap::new()),
            waveform_cache: RwLock::new(HashMap::new()),
        }
    }
}

impl std::ops::Deref for LibraryGeneration {
    type Target = LibrarySnapshot;
    fn deref(&self) -> &Self::Target {
        &self.library
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct DjLinkLibraryRefresh {
    pub tracks: usize,
    pub playlists: usize,
    pub changed: bool,
}

struct ServerState {
    config: DjLinkConfig,
    bind_ip: Ipv4Addr,
    broadcast_ip: Ipv4Addr,
    mac_addr: String,
    stagehand_ip: Option<Ipv4Addr>,
    stagehand_link_mac: Option<[u8; 6]>,
    interface_name: Option<String>,
    raw_udp: RawUdpTx,
    library_generation: RwLock<Arc<LibraryGeneration>>,
    history: RwLock<Vec<HistoryRecord>>,
    library_refresh: tokio::sync::Mutex<()>,
    actor_tx: ServerActorSender,
    telemetry_tx: broadcast::Sender<DjLinkTelemetryEvent>,
    mixer_telemetry_tx: broadcast::Sender<DjLinkMixerTelemetryEvent>,
    vu_telemetry_tx: broadcast::Sender<DjLinkVuTelemetryEvent>,
    stagehand_last_a9_ms: AtomicU64,
    stagehand_rejoin_requested_ms: AtomicU64,
    log_path: Option<PathBuf>,
    cue_overrides_ms: RwLock<HashMap<u32, u32>>,
    timing_loaded: tokio::sync::Mutex<HashSet<u32>>,
    master_bpm_hundreds: AtomicU16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LoadProgressRecordResult {
    Recorded,
    Kept { previous_context: &'static str },
}

impl ServerState {
    fn library(&self) -> Arc<LibraryGeneration> {
        self.library_generation
            .read()
            .expect("library generation lock poisoned")
            .clone()
    }

    fn network_diagnostics(&self, devices: Vec<LinkDevice>) -> serde_json::Value {
        let neighbours = match crate::discovery::neighbours(self.interface_name.as_deref()) {
            Ok(peers) => serde_json::json!({"resolved":peers}),
            Err(error) => {
                serde_json::json!({"error":error.to_string(),"os_error":error.raw_os_error()})
            }
        };
        let protocol_mac = self.config.stagehand_protocol_nonce.and_then(|nonce| {
            parse_mac(&self.mac_addr)
                .ok()
                .map(|mac| format_mac(stagehand::protocol_mac(mac, nonce)))
        });
        serde_json::json!({
            "time_ms":epoch_millis(),"interface":self.interface_name,
            "bind_ip":self.bind_ip,"broadcast_ip":self.broadcast_ip,"interface_mac":self.mac_addr,
            "transport":if self.config.unicast_discovery_netmask.is_some() {"kernel_unicast"} else if self.stagehand_ip.is_some_and(|ip| ip != self.bind_ip) {"isolated_raw_stagehand"} else {"kernel_broadcast"},
            "stagehand_enabled":self.config.stagehand_monitor,"stagehand_ip":self.stagehand_ip,
            "stagehand_protocol_mac":protocol_mac,
            "stagehand_runtime_number":self.config.stagehand_protocol_nonce.map(|nonce| 141 + (nonce.rotate_right(17) % 71) as u8),
            "last_a9_control_or_vu_ms":self.stagehand_last_a9_ms.load(Ordering::Relaxed),
            "rejoin_requested_ms":self.stagehand_rejoin_requested_ms.load(Ordering::Relaxed),
            "neighbours":neighbours,"devices":devices,
            "raw_transport_capabilities":crate::network::raw_transport_capabilities(),
        })
    }

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

    async fn record_unicast_response(&self, packet: &[u8], ip: Ipv4Addr) {
        if self.config.unicast_discovery_netmask.is_none() {
            return;
        }
        let Ok(header) = status::decode_header(packet) else {
            return;
        };
        // A configured/probed IP alone is never a discovered device.
        // Require a valid status or source query before trusting its identity.
        let Some(player) = parse_status_link_query_detail(packet)
            .map(|query| query.0)
            .or_else(|| parse_cdj_status(packet).map(|status| status.player))
        else {
            return;
        };
        let player_number = if header.model.eq_ignore_ascii_case("OMNIS-DUO")
            && matches!(header.player_number, Some(11 | 12))
        {
            // Query byte 43 names the source (17), not the sending deck.
            // Both header identities belong to one appliance; alternating them
            // in record_device would reset its link and deck telemetry.
            11
        } else if (1..=6).contains(&player)
            && (header.model.starts_with("CDJ-") || header.model.starts_with("XDJ-"))
        {
            player
        } else {
            return;
        };
        let mac_addr = self
            .device_for_ip(ip)
            .await
            .map(|device| device.mac_addr)
            .unwrap_or_default();
        self.record_device(LinkDevice {
            player_number,
            ip_addr: ip,
            mac_addr,
            model: header.model,
            last_seen: Instant::now(),
        })
        .await;
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
        let seen_at = Instant::now();
        // Read immutable prepared analysis once per loaded track, never analyze
        // audio or scan the library when a deck connects.
        if let Some(track) = self.library().tracks_by_id.get(&status.track_id) {
            let mut loaded = self.timing_loaded.lock().await;
            if loaded.insert(status.track_id) {
                if let Some(tag) = read_anlz_tag(track, "PQTZ", None).await {
                    if let Some(stats) = pqtz_grid_stats(&tag) {
                        let beats_ms = (0..stats.count)
                            .map(|i| be_u32(&tag[28 + i * 8..32 + i * 8]))
                            .collect();
                        self.actor_send(ServerMsg::RegisterTrackTiming {
                            track_id: status.track_id,
                            timing: crate::playhead::TrackTiming {
                                duration_ms: track.duration_sec.saturating_mul(1000),
                                beats_ms,
                            },
                        })
                        .await;
                    }
                }
            }
        }
        self.actor_reply(|reply| ServerMsg::RecordStatus {
            status,
            seen_at,
            reply,
        })
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

    async fn nfs_resolve_child(&self, parent: &Path, name: &str) -> PathBuf {
        if parent == Path::new("/") {
            let alias = Path::new("/").join(name.trim_start_matches('/'));
            if let Some(path) = self.library().nfs_exports.aliases.get(&alias) {
                return path.clone();
            }
        }
        resolve_child_path(parent, name).await
    }

    async fn nfs_handle_for_path(&self, path: &Path, parent_fh: Option<&[u8]>) -> Option<Vec<u8>> {
        if !self.library().nfs_exports.paths.contains(path) {
            return None;
        }
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
        if !self.library().nfs_exports.files.contains(path) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "file is not in the DJ Link library",
            ));
        }
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
        .library()
        .all_tracks
        .iter()
        .find(|track| track.mount_path == path)
        .map(|track| track.track_id);
    note_load_progress_with_logging(state, None, addr, track_id, "nfs-audio", offset == 0).await;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CdjStatusSnapshot {
    player: u8,
    omnis: bool,
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
    beat_number: Option<u32>,
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

    pub(crate) fn track_id(&self) -> u32 {
        self.track_id
    }

    pub(crate) fn same_track_as(&self, other: &Self) -> bool {
        self.source_player == other.source_player
            && self.source_slot == other.source_slot
            && self.track_type == other.track_type
            && self.track_id == other.track_id
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

    pub(crate) fn timing_input(&self) -> (Option<u32>, f64, bool, bool) {
        let rate = if !self.is_playing() {
            0.0
        } else {
            let direction = match self.play_state_3 {
                0x09 | 0x0d => 1.0,
                0x01 => -1.0,
                // OMNIS leaves this field empty during normal forward play.
                // Other moving states have not established direction semantics.
                0x00 if self.omnis && self.play_state_1 == 0x03 => 1.0,
                _ => 0.0,
            };
            direction * f64::from(self.pitch_1) / 1_048_576.0
        };
        (
            self.beat_number,
            rate,
            self.play_state_1 == 0x11,
            self.play_state_1 == 0x06,
        )
    }

    pub(crate) fn is_playing(&self) -> bool {
        // OMNIS keeps the CDJ moving flag and secondary state set while paused.
        // Its primary transport state, not those inherited bits, drives the playhead.
        if self.omnis {
            return matches!(self.play_state_1, 0x03 | 0x04 | 0x07 | 0x10);
        }
        if self.flags & CDJ_STATUS_PLAYING_FLAG != 0 {
            return true;
        }
        match self.play_state_2 {
            0x7a | 0xfa => true,
            0x7e | 0xfe => false,
            _ => matches!(self.play_state_1, 0x03 | 0x04 | 0x07 | 0x10),
        }
    }

    fn play_state_label(&self) -> &'static str {
        if !self.is_playing() && self.flags == 0x84 {
            "cued"
        } else {
            cdj_play_state_1_label(self.play_state_1)
        }
    }

    fn is_synced(&self) -> bool {
        self.flags & 0x10 != 0
    }

    pub(crate) fn deck_state(
        &self,
        position: Option<&CdjPositionSnapshot>,
        beat: Option<&CdjBeatSnapshot>,
    ) -> DjLinkDeckState {
        let bpm_hundreds = beat
            .map(|beat| beat.bpm_hundreds)
            .unwrap_or(self.bpm_hundreds);
        let pitch = beat.map(|beat| beat.pitch).unwrap_or(self.pitch_1);
        DjLinkDeckState {
            player: self.player,
            active: self.active != 0,
            on_air: self.flags & 0x08 != 0,
            source_player: self.source_player,
            source_slot: self.source_slot,
            track_type: self.track_type,
            track_id: (self.track_id != 0).then_some(self.track_id),
            playing: self.is_playing(),
            play_state: self.play_state_label(),
            synced: self.is_synced(),
            tempo_master: self.master_meaningful != 0,
            bpm_hundreds: (bpm_hundreds != u16::MAX).then_some(bpm_hundreds),
            effective_bpm_hundreds: effective_bpm_hundreds(bpm_hundreds, pitch),
            pitch_centi_percent: (pitch_percent(pitch) * 100.0).round() as i32,
            master_tempo: self.master_tempo.and_then(|value| match value {
                0 => Some(false),
                1 => Some(true),
                _ => None,
            }),
            key_shift_cents: self.key_shift_cents,
            effective_key: self.effective_key(),
            beat_in_bar: beat
                .map(|beat| beat.beat_in_bar)
                .unwrap_or(self.beat_in_bar),
            beat_number: self.beat_number,
            track_progress_milli: position.and_then(|position| {
                let duration_ms = u64::from(position.track_length_sec) * 1_000;
                (duration_ms > 0).then(|| {
                    ((u64::from(position.playhead_ms).min(duration_ms) * 1_000) / duration_ms)
                        as u16
                })
            }),
            track_length_sec: position.map(|position| position.track_length_sec),
            playhead_ms: position.map(|position| position.playhead_ms),
            playhead_source: position.map(|_| "precise"),
        }
    }

    pub(crate) fn has_key_telemetry(&self) -> bool {
        self.key.is_some() && self.key_shift_cents.is_some()
    }

    pub(crate) fn apply_key_telemetry(&self, detailed: &Self, deck: &mut DjLinkDeckState) {
        // CDJs interleave short Rekordbox status with extended monitoring status.
        // Absence in a short packet is not a key-shift reset. Never carry the
        // extension across tracks or reuse a pitch-dependent key after pitch moves.
        if self.has_key_telemetry() || !self.same_track_as(detailed) {
            return;
        }
        deck.master_tempo = detailed.master_tempo.and_then(|value| match value {
            0 => Some(false),
            1 => Some(true),
            _ => None,
        });
        deck.key_shift_cents = detailed.key_shift_cents;
        if self.pitch_1 == detailed.pitch_1 || deck.master_tempo == Some(true) {
            deck.effective_key = detailed.effective_key();
        }
    }

    fn effective_key(&self) -> Option<String> {
        // CDJ-3000 status key already includes the tempo slider / Master Tempo
        // effect, but excludes Key Shift. Do not apply the pitch ratio again.
        // https://djl-analysis.deepsymmetry.org/djl-analysis/vcdj.html#key-values
        if self.track_id == 0 {
            return None;
        }
        let [note, mode, accidental] = self.key?;
        let cents = self.key_shift_cents?;
        if note >= 12
            || mode > 1
            || !matches!(accidental, 0 | 1 | 0xff | 0x64)
            || !(-1200..=1200).contains(&cents)
            || cents % 100 != 0
        {
            return None;
        }
        const MAJOR: [&str; 12] = [
            "C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B",
        ];
        const MINOR: [&str; 12] = [
            "Am", "Bbm", "Bm", "Cm", "C#m", "Dm", "Ebm", "Em", "Fm", "F#m", "Gm", "Abm",
        ];
        let shifted = (i64::from(note) + cents / 100).rem_euclid(12) as usize;
        Some(
            if mode == 0 {
                MINOR[shifted]
            } else {
                MAJOR[shifted]
            }
            .to_owned(),
        )
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
            "cdj status player={} active={} src_player={} slot={} type={} track_id={} track_pos={} sort=0x{:02x} source_menu=0x{:02x}({}) cat1={} cat2={} menu_count={} flags=0x{:02x}({}) play1=0x{:02x}({}) play2=0x{:02x}({}) play3=0x{:02x}({}) pitch={pitch:.3}% bpm={} effective_bpm={effective_bpm} beat_number={} beat_in_bar={} master={} handoff=0x{:02x} master_tempo={} key={} key_shift_cents={} p4={} bar={} buf={}/{} loop={}",
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
            self.beat_number
                .map(|beat| beat.to_string())
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

async fn send_captured_udp(
    sock: &UdpSocket,
    packet: &[u8],
    target: SocketAddrV4,
    context: &str,
) -> std::io::Result<usize> {
    let result = sock.send_to(packet, target).await;
    match &result {
        Ok(n) => crate::diagnostics::udp("tx", sock.local_addr(), target.into(), &packet[..*n]),
        Err(error) => crate::diagnostics::event(
            "udp_send_error",
            serde_json::json!({"context":context,"local":sock.local_addr().ok().map(|address| address.to_string()),"peer":target.to_string(),"bytes":packet.len(),"kind":packet.get(10),"error":error.to_string(),"os_error":error.raw_os_error()}),
        ),
    }
    result
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
    if state.config.unicast_discovery_netmask.is_some() {
        if is_broadcast || target.ip().is_multicast() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Unicast DJ Link cannot send broadcasts",
            ));
        }
        // Match the iPhone transport on every platform, including large NFS
        // replies: no BPF, raw sockets, or broadcast fallback on failure.
        return send_captured_udp(sock, packet, target, context).await;
    }
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

    match send_captured_udp(sock, packet, target, context).await {
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
            let sent = match send_captured_udp(sock, packet, broadcast_target, context).await {
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

fn default_ip() -> LinkResult<Ipv4Addr> {
    let deadline = Instant::now() + DJLINK_INTERFACE_WAIT;
    loop {
        let entries = ifconfig_ipv4_entries();
        if let Some(ip) = preferred_link_local_ip(&entries) {
            return Ok(ip);
        }
        if Instant::now() >= deadline {
            return preferred_routed_ip(&entries).ok_or(LinkError::NoDjLinkInterface);
        }
        std::thread::sleep(DJLINK_INTERFACE_POLL);
    }
}

fn preferred_link_local_ip(entries: &[IfconfigIpv4]) -> Option<Ipv4Addr> {
    preferred_interface(entries, true).map(|entry| entry.ip)
}

fn preferred_routed_ip(entries: &[IfconfigIpv4]) -> Option<Ipv4Addr> {
    preferred_interface(entries, false).map(|entry| entry.ip)
}

fn preferred_interface(entries: &[IfconfigIpv4], link_local: bool) -> Option<&IfconfigIpv4> {
    entries
        .iter()
        .filter(|entry| {
            entry.active
                && entry.ip.is_link_local() == link_local
                && entry.broadcast.is_some()
                && !is_tunnel_interface(&entry.name)
        })
        .min_by_key(|entry| (!is_physical_interface(&entry.name), entry.name.as_str()))
}

fn is_physical_interface(name: &str) -> bool {
    name.starts_with("en") || name.starts_with("eth")
}

fn is_tunnel_interface(name: &str) -> bool {
    [
        "utun", "tun", "tap", "wg", "ipsec", "ppp", "gif", "stf", "awdl", "llw",
    ]
    .iter()
    .any(|prefix| name.starts_with(prefix))
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

fn isolated_stagehand_ip(bind_ip: Ipv4Addr, launch_nonce: u64) -> Ipv4Addr {
    let [a, b, c, d] = bind_ip.octets();
    let mut host = 2 + (launch_nonce % 252) as u8;
    if host == d {
        host = if host == 253 { 2 } else { host + 1 };
    }
    if a == 169 && b == 254 {
        // A macOS link-local address can change whenever the Ethernet peer is
        // restarted. Derive the complete /16 alias from the launch identity so
        // Stagehand remains the same network host across those changes.
        let subnet = 1 + (launch_nonce.rotate_right(8) % 253) as u8;
        Ipv4Addr::new(a, b, subnet, host)
    } else {
        Ipv4Addr::new(a, b, c, host)
    }
}

fn stagehand_link_mac(interface_mac: [u8; 6], launch_nonce: u64) -> [u8; 6] {
    let entropy = stagehand::protocol_mac(interface_mac, launch_nonce);
    [
        0x5a, entropy[1], entropy[2], entropy[3], entropy[4], entropy[5],
    ]
}

fn epoch_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct IfconfigIpv4 {
    name: String,
    ip: Ipv4Addr,
    broadcast: Option<Ipv4Addr>,
    netmask: Option<Ipv4Addr>,
    mac: Option<String>,
    active: bool,
}

#[cfg(not(target_os = "ios"))]
fn ifconfig_ipv4_entries() -> Vec<IfconfigIpv4> {
    let Ok(output) = Command::new("ifconfig").output() else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&output.stdout);
    parse_ifconfig_ipv4_entries(&text)
}

/// Network choices for embedded clients; iOS uses getifaddrs, without subprocesses.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DjLinkInterface {
    pub name: String,
    pub index: u32,
    pub ip: Ipv4Addr,
    pub broadcast: Ipv4Addr,
    pub netmask: Ipv4Addr,
}

/// Select an already-assigned address with the desktop preference policy.
/// Embedded clients can exclude Wi-Fi/cellular interfaces without duplicating
/// IP selection or requiring a link-local address. This never assigns an IP.
pub fn select_djlink_interface(
    interfaces: &[DjLinkInterface],
    excluded_names: &[String],
) -> Option<DjLinkInterface> {
    let candidates = interfaces
        .iter()
        .filter(|interface| {
            !excluded_names.contains(&interface.name)
                && is_physical_interface(&interface.name)
                && !interface.ip.is_unspecified()
                && !interface.ip.is_loopback()
                && !interface.ip.is_multicast()
                && !interface.ip.is_broadcast()
        })
        .map(|interface| IfconfigIpv4 {
            name: interface.name.clone(),
            ip: interface.ip,
            broadcast: Some(interface.broadcast),
            netmask: Some(interface.netmask),
            mac: None,
            active: true,
        })
        .collect::<Vec<_>>();
    let selected = preferred_interface(&candidates, true)
        .or_else(|| preferred_interface(&candidates, false))?;
    interfaces
        .iter()
        .find(|interface| interface.name == selected.name && interface.ip == selected.ip)
        .cloned()
}

pub fn djlink_interfaces() -> Vec<DjLinkInterface> {
    ifconfig_ipv4_entries()
        .into_iter()
        .filter_map(|entry| {
            if !entry.active
                || is_tunnel_interface(&entry.name)
                || !is_physical_interface(&entry.name)
            {
                return None;
            }
            Some(DjLinkInterface {
                index: interface_index(&entry.name),
                name: entry.name,
                ip: entry.ip,
                broadcast: entry.broadcast?,
                netmask: entry.netmask?,
            })
        })
        .collect()
}

fn interface_index(name: &str) -> u32 {
    #[cfg(target_vendor = "apple")]
    {
        std::ffi::CString::new(name)
            .ok()
            .map(|name| unsafe { libc::if_nametoindex(name.as_ptr()) })
            .unwrap_or(0)
    }
    #[cfg(not(target_vendor = "apple"))]
    {
        let _ = name;
        0
    }
}

#[cfg(target_os = "ios")]
fn ifconfig_ipv4_entries() -> Vec<IfconfigIpv4> {
    use std::ffi::CStr;
    let mut head = std::ptr::null_mut();
    // getifaddrs owns the linked list until freeifaddrs. Preserve a wired
    // adapter's MAC when the OS exposes it; ignore iOS's Wi-Fi privacy sentinel.
    unsafe {
        if libc::getifaddrs(&mut head) != 0 {
            crate::diagnostics::event(
                "interface_scan_failed",
                serde_json::json!({"error": io::Error::last_os_error().to_string()}),
            );
            return Vec::new();
        }
        let mut entries = Vec::new();
        let mut observed = BTreeSet::new();
        let mut cursor = head;
        let mut macs = HashMap::new();
        while let Some(entry) = cursor.as_ref() {
            cursor = entry.ifa_next;
            let name = CStr::from_ptr(entry.ifa_name).to_string_lossy();
            let family = entry.ifa_addr.as_ref().map(|address| address.sa_family);
            let ip = if family == Some(libc::AF_INET as u8) {
                let address = &*(entry.ifa_addr as *const libc::sockaddr_in);
                Some(Ipv4Addr::from(address.sin_addr.s_addr.to_ne_bytes()).to_string())
            } else {
                None
            };
            observed.insert(format!(
                "{name}:family={family:?},flags={:#x},ip={ip:?},netmask={}",
                entry.ifa_flags,
                !entry.ifa_netmask.is_null()
            ));
            if entry.ifa_addr.is_null()
                || (*entry.ifa_addr).sa_family as i32 != libc::AF_LINK
                || ((*entry.ifa_addr).sa_len as usize) < std::mem::size_of::<libc::sockaddr_dl>()
            {
                continue;
            }
            let link = &*(entry.ifa_addr as *const libc::sockaddr_dl);
            let offset = link.sdl_nlen as usize;
            if link.sdl_alen != 6 || offset + 6 > link.sdl_data.len() {
                continue;
            }
            let bytes: [u8; 6] = std::array::from_fn(|i| link.sdl_data[offset + i] as u8);
            if bytes == [0; 6] || bytes == [2, 0, 0, 0, 0, 0] {
                continue;
            }
            let name = CStr::from_ptr(entry.ifa_name)
                .to_string_lossy()
                .into_owned();
            macs.insert(name, format_mac(bytes));
        }
        cursor = head;
        while let Some(entry) = cursor.as_ref() {
            cursor = entry.ifa_next;
            if entry.ifa_addr.is_null()
                || entry.ifa_netmask.is_null()
                || (*entry.ifa_addr).sa_family as i32 != libc::AF_INET
            {
                continue;
            }
            let flags = entry.ifa_flags as i32;
            if flags & libc::IFF_LOOPBACK != 0 || flags & libc::IFF_BROADCAST == 0 {
                continue;
            }
            let address = &*(entry.ifa_addr as *const libc::sockaddr_in);
            let mask = &*(entry.ifa_netmask as *const libc::sockaddr_in);
            let ip = Ipv4Addr::from(address.sin_addr.s_addr.to_ne_bytes());
            let netmask = u32::from_be_bytes(mask.sin_addr.s_addr.to_ne_bytes());
            let name = CStr::from_ptr(entry.ifa_name)
                .to_string_lossy()
                .into_owned();
            entries.push(IfconfigIpv4 {
                mac: macs.get(&name).cloned(),
                name,
                ip,
                broadcast: Some(Ipv4Addr::from(u32::from(ip) | !netmask)),
                netmask: Some(Ipv4Addr::from(netmask)),
                active: flags & libc::IFF_UP != 0 && flags & libc::IFF_RUNNING != 0,
            });
        }
        libc::freeifaddrs(head);
        // Record only changes, including interfaces rejected above. Otherwise
        // a missing USB adapter and a filtered adapter look identical on phone.
        static LAST_SCAN: std::sync::Mutex<BTreeSet<String>> =
            std::sync::Mutex::new(BTreeSet::new());
        if let Ok(mut previous) = LAST_SCAN.lock()
            && *previous != observed
        {
            crate::diagnostics::event(
                "interface_scan_changed",
                serde_json::json!({"raw": observed, "eligible": entries.iter().map(|entry| format!("{}={},active={}", entry.name, entry.ip, entry.active)).collect::<Vec<_>>() }),
            );
            *previous = observed;
        }
        entries
    }
}

#[cfg(not(target_os = "ios"))]
fn parse_ifconfig_ipv4_entries(text: &str) -> Vec<IfconfigIpv4> {
    let mut entries = Vec::new();
    let mut block = Vec::new();
    for line in text.lines() {
        if !line.starts_with('\t') && line.contains(": flags=") {
            append_ifconfig_block(&mut entries, &block);
            block.clear();
        }
        block.push(line);
    }
    append_ifconfig_block(&mut entries, &block);
    entries
}

#[cfg(not(target_os = "ios"))]
fn append_ifconfig_block(entries: &mut Vec<IfconfigIpv4>, lines: &[&str]) {
    let Some(header) = lines.first() else {
        return;
    };
    let Some((name, _)) = header.split_once(": flags=") else {
        return;
    };
    let flags = header
        .split_once('<')
        .and_then(|(_, rest)| rest.split_once('>'))
        .map(|(flags, _)| flags.split(',').collect::<HashSet<_>>())
        .unwrap_or_default();
    let mut active = flags.contains("UP") && flags.contains("RUNNING");
    let mut mac = None;
    for line in lines.iter().skip(1) {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("ether ") {
            mac = rest.split_whitespace().next().map(str::to_string);
        } else if let Some(status) = line.strip_prefix("status: ") {
            active = status == "active";
        }
    }
    for line in lines.iter().skip(1) {
        let s = line.trim();
        if let Some(rest) = s.strip_prefix("inet ") {
            let parts = rest.split_whitespace().collect::<Vec<_>>();
            let Some(ip) = parts.first().and_then(|v| v.parse().ok()) else {
                continue;
            };
            if ip == Ipv4Addr::LOCALHOST {
                continue;
            }
            let mut broadcast = None;
            let mut netmask = None;
            for pair in parts.windows(2) {
                if pair[0] == "broadcast" {
                    broadcast = pair[1].parse().ok();
                }
                if pair[0] == "netmask" {
                    netmask = if let Some(hex) = pair[1].strip_prefix("0x") {
                        u32::from_str_radix(hex, 16).ok().map(Ipv4Addr::from)
                    } else {
                        pair[1].parse().ok()
                    };
                }
            }
            entries.push(IfconfigIpv4 {
                name: name.to_string(),
                ip,
                broadcast,
                netmask,
                mac: mac.clone(),
                active,
            });
        }
    }
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

fn build_tempo_mixer_status(model: &str, player_number: u8, bpm_hundreds: u16) -> Vec<u8> {
    let mut packet = build_status_mixer_status(model, player_number);
    packet[0x27] = 0xf0; // Playing, synced, and tempo master.
    packet[0x2e..0x30].copy_from_slice(&bpm_hundreds.to_be_bytes());
    packet
}

fn build_tempo_beat_status(
    model: &str,
    player_number: u8,
    bpm_hundreds: u16,
    beat_in_bar: u8,
) -> Vec<u8> {
    let mut packet = decode_hex(BEAT_STATUS_TEMPLATE_HEX);
    packet[11..31].copy_from_slice(&cstr_padded_ascii(model, 20));
    packet[33] = player_number;
    let beat_in_bar = beat_in_bar.clamp(1, 4);
    let next_bar_beats = u32::from(5 - beat_in_bar);
    for (offset, beats) in [
        (0x24, 1),
        (0x28, 2),
        (0x2c, next_bar_beats),
        (0x30, 4),
        (0x34, next_bar_beats + 4),
        (0x38, 8),
    ] {
        let elapsed_ms = 6_000_000u32 * beats / u32::from(bpm_hundreds);
        packet[offset..offset + 4].copy_from_slice(&elapsed_ms.to_be_bytes());
    }
    packet[0x5a..0x5c].copy_from_slice(&bpm_hundreds.to_be_bytes());
    packet[0x5c] = beat_in_bar;
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
        omnis: packet[11..31]
            .split(|byte| *byte == 0)
            .next()?
            .eq_ignore_ascii_case(b"OMNIS-DUO"),
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
        beat_number: match be_u32(packet.get(0xa0..0xa4)?) {
            u32::MAX => None,
            beat => Some(beat),
        },
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
        // Stagehand reuses 0x0b for a different multiplexed telemetry layout.
        || stagehand::peer_marker(packet).is_some()
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
        state.library().master_db_id,
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
            crate::diagnostics::udp("rx", sock.local_addr(), addr, &buf[..len]);
            let SocketAddr::V4(addr) = addr else {
                continue;
            };
            let src_ip = *addr.ip();
            if src_ip == state.bind_ip {
                continue;
            }
            let packet = &buf[..len];
            let keepalive_header = keepalive::decode_header(packet).ok();
            let is_stagehand_target = state.config.stagehand_monitor
                && (state.config.stagehand_target_ip == Some(src_ip)
                    || keepalive_header
                        .as_ref()
                        .is_some_and(|header| header.model.eq_ignore_ascii_case("DJM-A9")));
            if is_stagehand_target && let Some(mut device) = parse_keepalive_device(packet) {
                device.ip_addr = src_ip;
                state.record_device(device).await;
            }
            // A9 Stagehand endpoints are sensitive to the normal virtual-CDJ
            // collision protocol. They must see only the abbreviated Stagehand
            // handshake, never our Rekordbox source's compatibility replies.
            if is_stagehand_target {
                if keepalive_header
                    .as_ref()
                    .is_some_and(|header| header.kind == KeepaliveKind::CompatibilityRequest)
                {
                    state
                        .stagehand_rejoin_requested_ms
                        .store(epoch_millis(), Ordering::Relaxed);
                }
                continue;
            }
            // OMNIS negotiates its own identity during cold startup. The reference
            // source sends neither compatibility nor ID-use replies to it, but
            // still processes its ordinary announcements below.
            if let Some(frame_type) = keepalive_frame_type(packet)
                && !keepalive_header
                    .as_ref()
                    .is_some_and(|header| header.model.eq_ignore_ascii_case("OMNIS-DUO"))
            {
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
                    &[],
                    "load-settings on device discovery",
                )
                .await;
            }
        }
    })
}

/// Probe only the attached IPv4 subnet. Large networks are deliberately rejected
/// rather than silently scanning unrelated address space. Interleave the local
/// /24 with low host addresses across the subnet, then check remaining hosts.
/// USB link-local assignment need not put the phone in the deck's /24.
fn discovery_addresses(ip: Ipv4Addr, netmask: Ipv4Addr) -> Result<Vec<Ipv4Addr>> {
    let mask = u32::from(netmask);
    let host_bits = (!mask).trailing_ones();
    anyhow::ensure!(
        mask.leading_ones() + host_bits == 32 && (16..=30).contains(&mask.leading_ones()),
        "Automatic unicast DJ Link discovery requires an IPv4 subnet between /16 and /30"
    );
    let local = u32::from(ip);
    let network = local & mask;
    let broadcast = network | !mask;
    let mut nearby = Vec::new();
    let mut low_hosts = Vec::new();
    let mut remaining = Vec::new();
    for candidate in (network + 1..broadcast).filter(|candidate| *candidate != local) {
        if candidate & 0xffffff00 == local & 0xffffff00 {
            nearby.push(candidate);
        } else if candidate & 0xff <= 8 {
            low_hosts.push(candidate);
        } else {
            remaining.push(candidate);
        }
    }
    let mut addresses = Vec::with_capacity((broadcast - network - 2) as usize);
    for index in 0..nearby.len().max(low_hosts.len()) {
        if let Some(ip) = nearby.get(index) {
            addresses.push(Ipv4Addr::from(*ip));
        }
        if let Some(ip) = low_hosts.get(index) {
            addresses.push(Ipv4Addr::from(*ip));
        }
    }
    addresses.extend(remaining.into_iter().map(Ipv4Addr::from));
    Ok(addresses)
}

fn spawn_unicast_discovery(
    state: Arc<ServerState>,
    keepalive: Arc<UdpSocket>,
    status: Arc<UdpSocket>,
    mask: Ipv4Addr,
) -> TokioJoinHandle<()> {
    tokio::spawn(async move {
        let addresses =
            discovery_addresses(state.bind_ip, mask).expect("validated discovery subnet");
        let hello = build_keepalive_status_packet(
            &state.config.model_name,
            state.config.player_number,
            state.bind_ip,
            &state.mac_addr,
            1,
        );
        let init = build_status_link_init(&state.config.model_name, state.config.player_number);
        let started = Instant::now();
        let cache_path = state.config.discovery_cache_path.as_deref();
        let mut cached = crate::discovery::cached_peers(cache_path).await;
        let mut neighbours = Vec::new();
        let mut known_players = BTreeMap::new();
        let mut cursor = 0;
        let mut swept = false;
        let mut tick = 0u64;
        let mut first_response = false;
        let mut reported_send_error = false;
        let mut reported_neighbour_error = false;
        let mut interval = tokio::time::interval(Duration::from_millis(125));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let devices = state.devices_sorted().await;
            if !devices.is_empty() && !first_response {
                first_response = true;
                tracing::info!(
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    peers = devices.len(),
                    "unicast_discovery_first_response"
                );
            }
            let recovery = unicast_recovery_targets(&mut known_players, &devices);
            let mut changed = false;
            for device in &devices {
                if is_unicast_deck(device)
                    && crate::discovery::usable_peer(state.bind_ip, mask, device.ip_addr)
                    && !cached.contains(&device.ip_addr)
                {
                    cached.insert(0, device.ip_addr);
                    cached.truncate(crate::discovery::MAX_PEERS);
                    changed = true;
                }
            }
            if changed && let Err(error) = crate::discovery::save_peers(cache_path, &cached).await {
                tracing::warn!(%error, "unicast_discovery_cache_failed");
            }
            // Watch the neighbour arriving just after IPv4 assignment, then
            // reduce kernel reads once the attachment has settled.
            if crate::discovery::neighbours_due(tick, started.elapsed()) {
                match crate::discovery::neighbours(state.interface_name.as_deref()) {
                    Ok(peers) => neighbours = peers,
                    Err(error) if !reported_neighbour_error => {
                        reported_neighbour_error = true;
                        tracing::debug!(%error, "unicast_discovery_neighbours_unavailable");
                    }
                    Err(_) => {}
                }
            }
            let mut targets = Vec::new();
            if crate::discovery::priority_due(tick) {
                targets = discovery_priority_targets(
                    state.bind_ip,
                    mask,
                    &cached,
                    &neighbours,
                    &recovery,
                    &devices,
                );
                if !targets.is_empty() {
                    tracing::debug!(
                        ?targets,
                        cached = cached.len(),
                        neighbours = neighbours.len(),
                        elapsed_ms = started.elapsed().as_millis() as u64,
                        "unicast_discovery_priority"
                    );
                }
            }
            let has_deck = devices.iter().any(is_unicast_deck);
            let batch = crate::discovery::sweep_batch(tick, swept, has_deck);
            if batch > 0 {
                let end = (cursor + batch).min(addresses.len());
                for ip in &addresses[cursor..end] {
                    if !targets.contains(ip) && !devices.iter().any(|device| device.ip_addr == *ip)
                    {
                        targets.push(*ip);
                    }
                }
                if end == addresses.len() && !swept {
                    swept = true;
                    tracing::info!(
                        elapsed_ms = started.elapsed().as_millis() as u64,
                        addresses = addresses.len(),
                        peers = devices.len(),
                        "unicast_discovery_first_sweep_complete"
                    );
                }
                cursor = if end == addresses.len() { 0 } else { end };
            }
            for ip in targets {
                if state.config.stagehand_monitor
                    && devices
                        .iter()
                        .any(|device| device.ip_addr == ip && is_stagehand_mixer(device))
                {
                    continue;
                }
                // A neighbour/cache hint is not yet a CDJ. Advertising our
                // Rekordbox identity here can bind an A9 to the wrong persona
                // before its first announcement arrives. Probe with link-init;
                // spawn_announce sends keepalives only after identification.
                if !state.config.stagehand_monitor {
                    let _ = send_udp_packet(
                        &state,
                        &keepalive,
                        &hello,
                        SocketAddrV4::new(ip, KEEPALIVE_PORT),
                        "unicast discovery hello",
                    )
                    .await;
                }
                if let Err(error) = send_udp_packet(
                    &state,
                    &status,
                    &init,
                    SocketAddrV4::new(ip, STATUS_PORT),
                    "unicast discovery link-init",
                )
                .await
                    && !reported_send_error
                {
                    reported_send_error = true;
                    tracing::warn!(%ip, %error, "unicast_discovery_send_failed");
                }
            }
            tick = tick.wrapping_add(1);
        }
    })
}

fn discovery_priority_targets(
    local: Ipv4Addr,
    mask: Ipv4Addr,
    cached: &[Ipv4Addr],
    neighbours: &[Ipv4Addr],
    recovery: &[Ipv4Addr],
    devices: &[LinkDevice],
) -> Vec<Ipv4Addr> {
    let mut targets = Vec::new();
    for ip in recovery.iter().chain(cached).chain(neighbours) {
        if crate::discovery::usable_peer(local, mask, *ip)
            && !targets.contains(ip)
            && !devices.iter().any(|device| device.ip_addr == *ip)
        {
            targets.push(*ip);
            if targets.len() == crate::discovery::MAX_PEERS {
                break;
            }
        }
    }
    targets
}

fn is_unicast_deck(device: &LinkDevice) -> bool {
    (1..=6).contains(&device.player_number)
        || (device.player_number == 11 && device.model.eq_ignore_ascii_case("OMNIS-DUO"))
}

fn unicast_recovery_targets(
    known_players: &mut BTreeMap<u8, Ipv4Addr>,
    devices: &[LinkDevice],
) -> Vec<Ipv4Addr> {
    for device in devices.iter().filter(|device| is_unicast_deck(device)) {
        known_players.insert(device.player_number, device.ip_addr);
    }
    known_players
        .values()
        .copied()
        .filter(|ip| !devices.iter().any(|device| device.ip_addr == *ip))
        .collect()
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
            let targets = if state.config.unicast_discovery_netmask.is_some() {
                state
                    .devices_sorted()
                    .await
                    .into_iter()
                    .filter(|device| !state.config.stagehand_monitor || !is_stagehand_mixer(device))
                    .map(|device| SocketAddrV4::new(device.ip_addr, KEEPALIVE_PORT))
                    .collect()
            } else if state.config.stagehand_monitor {
                state
                    .devices_sorted()
                    .await
                    .into_iter()
                    .filter(|device| !device.model.eq_ignore_ascii_case("DJM-A9"))
                    .map(|device| SocketAddrV4::new(device.ip_addr, KEEPALIVE_PORT))
                    .collect::<Vec<_>>()
            } else {
                vec![SocketAddrV4::new(state.broadcast_ip, KEEPALIVE_PORT)]
            };
            for target in targets {
                if let Err(err) =
                    send_udp_packet(&state, &sock, &packet, target, "keepalive announce").await
                {
                    debug!(target: "djtools_link::udp", %target, %err, "keepalive_announce_failed");
                }
            }
        }
    })
}

fn is_stagehand_mixer(device: &LinkDevice) -> bool {
    device.model.eq_ignore_ascii_case("DJM-A9")
}

fn stagehand_heartbeat_for_device(state: &ServerState, device: &LinkDevice) -> Option<Vec<u8>> {
    if device.ip_addr == state.bind_ip || Some(device.ip_addr) == state.stagehand_ip {
        return None;
    }
    if is_stagehand_mixer(device) {
        return Some(stagehand::build_mixer_heartbeat());
    }
    // Request detailed player telemetry alongside the library source.
    if (1..=6).contains(&device.player_number) && device.model.eq_ignore_ascii_case("CDJ-3000") {
        return Some(stagehand::build_player_heartbeat());
    }
    None
}

async fn send_stagehand_heartbeats(state: &ServerState, sock: &UdpSocket, target: Ipv4Addr) {
    for device in state.devices_sorted().await {
        if state.config.unicast_discovery_netmask.is_some() && device.ip_addr != target {
            continue;
        }
        let Some(packet) = stagehand_heartbeat_for_device(state, &device) else {
            continue;
        };
        let result = if let Some(ip) = state.stagehand_ip.filter(|ip| *ip != state.bind_ip) {
            match parse_mac(&device.mac_addr) {
                Ok(mac) => {
                    state
                        .raw_udp
                        .send(RawUdpDatagram {
                            src_mac: state.stagehand_link_mac.expect("isolated Stagehand MAC"),
                            dst_mac: mac,
                            src_ip: ip,
                            src_port: STATUS_PORT,
                            dst_ip: device.ip_addr,
                            dst_port: STATUS_PORT,
                            payload: packet,
                        })
                        .await
                }
                Err(error) => Err(error),
            }
        } else {
            send_udp_packet(
                state,
                sock,
                &packet,
                SocketAddrV4::new(device.ip_addr, STATUS_PORT),
                "stagehand heartbeat",
            )
            .await
            .map(|_| ())
        };
        if let Err(error) = result {
            debug!(target: "djtools_link::stagehand", ip = %device.ip_addr, %error, "stagehand_heartbeat_failed");
        }
    }
}

// Each supported device gets the shared Rust monitoring session over UDP.
// Presence must remain isolated from the library identity: a phone has only
// one assigned IP, whereas desktop Stagehand has its own raw-transport IP.
fn spawn_unicast_stagehand(
    state: Arc<ServerState>,
    sock: Arc<UdpSocket>,
    status_sock: Arc<UdpSocket>,
) -> TokioJoinHandle<()> {
    tokio::spawn(async move {
        let mut sessions = tokio::task::JoinSet::new();
        let mut joined = BTreeMap::<Ipv4Addr, tokio::task::AbortHandle>::new();
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let peers = state
                .devices_sorted()
                .await
                .into_iter()
                .filter(|device| {
                    is_stagehand_mixer(device)
                        || ((1..=6).contains(&device.player_number)
                            && device.model.eq_ignore_ascii_case("CDJ-3000"))
                })
                .map(|device| device.ip_addr)
                .collect::<BTreeSet<_>>();
            joined.retain(|ip, task| {
                if peers.contains(ip) && !task.is_finished() {
                    true
                } else {
                    task.abort();
                    false
                }
            });
            while sessions.try_join_next().is_some() {}
            for ip in peers {
                joined.entry(ip).or_insert_with(|| {
                    sessions.spawn(run_stagehand_announce(
                        state.clone(),
                        sock.clone(),
                        status_sock.clone(),
                        SocketAddrV4::new(ip, KEEPALIVE_PORT),
                    ))
                });
            }
        }
    })
}

fn spawn_stagehand_announce(
    state: Arc<ServerState>,
    sock: Arc<UdpSocket>,
    status_sock: Arc<UdpSocket>,
) -> TokioJoinHandle<()> {
    let target = SocketAddrV4::new(state.broadcast_ip, KEEPALIVE_PORT);
    tokio::spawn(run_stagehand_announce(state, sock, status_sock, target))
}

async fn run_stagehand_announce(
    state: Arc<ServerState>,
    sock: Arc<UdpSocket>,
    status_sock: Arc<UdpSocket>,
    target: SocketAddrV4,
) {
    const MODEL: &str = "Stagehand";
    const REJOIN_AFTER_MS: u64 = 10_000;
    const QUIET_BEFORE_REJOIN_MS: u64 = 10_000;
    let device = state.device_for_ip(*target.ip()).await;
    let mixer_target = device.as_ref().is_none_or(is_stagehand_mixer);
    if !stagehand_can_claim(&state, device.as_ref()) {
        // Advertising two identities from one IP makes CDJs repeatedly
        // introduce the Rekordbox source again. Keep status requests, but do
        // not replace the source with a Stagehand announcement/claim/keepalive.
        crate::diagnostics::event(
            "stagehand_presence_suppressed",
            serde_json::json!({"target":target.to_string(),"reason":"shared_library_ip"}),
        );
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            send_stagehand_heartbeats(&state, &status_sock, *target.ip()).await;
        }
    }
    let stagehand_ip = state.stagehand_ip.unwrap_or(state.bind_ip);
    let link_mac = match parse_mac(&state.mac_addr) {
        Ok(mac) => mac,
        Err(err) => {
            warn!(target: "djtools_link::stagehand", %err, "stagehand_invalid_mac");
            return;
        }
    };
    // AlphaTheta Connect generates both values once per Stagehand app
    // launch. The supervising process may restart this native worker, so
    // keep using the parent-owned launch identity across worker lifetimes.
    let launch_nonce = state
        .config
        .stagehand_protocol_nonce
        .unwrap_or_else(stagehand_launch_nonce);
    let mac = stagehand::protocol_mac(link_mac, launch_nonce);
    let runtime_number = 141 + (launch_nonce.rotate_right(17) % 71) as u8;

    crate::diagnostics::event(
        "stagehand_join_started",
        serde_json::json!({
            "target":target.to_string(),"source_ip":stagehand_ip,"protocol_mac":format_mac(mac),"runtime_number":runtime_number,
        }),
    );

    send_stagehand_join_sequence(&state, &sock, target, stagehand_ip, mac).await;

    tracing::info!(
        target: "djtools_link::stagehand",
        runtime_number,
        ip = %stagehand_ip,
        link_mac = %format_mac(state.stagehand_link_mac.unwrap_or(link_mac)),
        protocol_mac = %format_mac(mac),
        "stagehand_join_sequence_finished"
    );
    let mut interval = tokio::time::interval(Duration::from_millis(250));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut next_keepalive = tokio::time::Instant::now();
    let mut handled_rejoin_ms = state.stagehand_rejoin_requested_ms.load(Ordering::Relaxed);
    let mut last_join_ms = epoch_millis();
    let mut quiet_since_ms = None;
    loop {
        interval.tick().await;
        let requested_rejoin_ms = state.stagehand_rejoin_requested_ms.load(Ordering::Relaxed);
        let now_ms = epoch_millis();
        let last_a9_ms = state.stagehand_last_a9_ms.load(Ordering::Relaxed);
        if mixer_target
            && let Some(reason) = stagehand_rejoin_reason(
                now_ms,
                last_a9_ms,
                last_join_ms,
                requested_rejoin_ms,
                handled_rejoin_ms,
                REJOIN_AFTER_MS,
            )
        {
            if reason == "peer-request" {
                crate::diagnostics::event(
                    "stagehand_rejoin",
                    serde_json::json!({"target":target.to_string(),"reason":reason}),
                );
                tracing::info!(target: "djtools_link::stagehand", reason, "stagehand_rejoining");
                send_stagehand_join_sequence(&state, &sock, target, stagehand_ip, mac).await;
                last_join_ms = epoch_millis();
                handled_rejoin_ms = requested_rejoin_ms;
                quiet_since_ms = None;
                next_keepalive = tokio::time::Instant::now();
                continue;
            }
            if quiet_since_ms.is_none() {
                crate::diagnostics::event(
                    "stagehand_rejoin_quiet",
                    serde_json::json!({"target":target.to_string(),"quiet_ms":QUIET_BEFORE_REJOIN_MS,"last_a9_ms":last_a9_ms}),
                );
                tracing::info!(
                    target: "djtools_link::stagehand",
                    quiet_ms = QUIET_BEFORE_REJOIN_MS,
                    "stagehand_rejoin_quiet"
                );
                quiet_since_ms = Some(now_ms);
            }
        }
        if let Some(quiet_started_ms) = quiet_since_ms {
            if now_ms.saturating_sub(quiet_started_ms) >= QUIET_BEFORE_REJOIN_MS {
                crate::diagnostics::event(
                    "stagehand_rejoin",
                    serde_json::json!({"target":target.to_string(),"reason":"peer-silent"}),
                );
                tracing::info!(
                    target: "djtools_link::stagehand",
                    reason = "peer-silent",
                    "stagehand_rejoining"
                );
                send_stagehand_join_sequence(&state, &sock, target, stagehand_ip, mac).await;
                last_join_ms = epoch_millis();
                quiet_since_ms = None;
                next_keepalive = tokio::time::Instant::now();
            }
            continue;
        }
        // Pause both status heartbeats and presence during peer expiry. Sending
        // either from a separate task would keep the stale session alive.
        send_stagehand_heartbeats(&state, &status_sock, *target.ip()).await;
        if tokio::time::Instant::now() < next_keepalive {
            continue;
        }
        next_keepalive = tokio::time::Instant::now() + Duration::from_secs(2);
        let packet = stagehand::build_keepalive(MODEL, runtime_number, stagehand_ip, mac, 1);
        if let Err(err) =
            send_stagehand_packet(&state, &sock, &packet, target, "stagehand keepalive").await
        {
            debug!(target: "djtools_link::stagehand", %target, %err, "stagehand_keepalive_failed");
        }
    }
}

fn stagehand_can_claim(state: &ServerState, device: Option<&LinkDevice>) -> bool {
    state.stagehand_ip.is_some_and(|ip| ip != state.bind_ip)
        || device.is_some_and(is_stagehand_mixer)
}

fn stagehand_rejoin_reason(
    now_ms: u64,
    last_a9_ms: u64,
    last_join_ms: u64,
    requested_rejoin_ms: u64,
    handled_rejoin_ms: u64,
    rejoin_after_ms: u64,
) -> Option<&'static str> {
    if requested_rejoin_ms > handled_rejoin_ms
        && now_ms.saturating_sub(requested_rejoin_ms) >= 4_000
    {
        return Some("peer-request");
    }
    let last_contact_ms = last_a9_ms.max(last_join_ms);
    (now_ms.saturating_sub(last_contact_ms) >= rejoin_after_ms
        && now_ms.saturating_sub(last_join_ms) >= rejoin_after_ms)
        .then_some("peer-silent")
}

fn stagehand_launch_nonce() -> u64 {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    (elapsed as u64)
        ^ ((elapsed >> 64) as u64).rotate_left(23)
        ^ u64::from(std::process::id()).rotate_left(41)
}

async fn send_stagehand_join_sequence(
    state: &ServerState,
    sock: &UdpSocket,
    target: SocketAddrV4,
    stagehand_ip: Ipv4Addr,
    mac: [u8; 6],
) {
    for _ in 0..3 {
        let packet = stagehand::build_announcement("Stagehand");
        if let Err(err) =
            send_stagehand_packet(state, sock, &packet, target, "stagehand announcement").await
        {
            debug!(target: "djtools_link::stagehand", %target, %err, "stagehand_announcement_failed");
        }
        tokio::time::sleep(Duration::from_millis(305)).await;
    }
    for iteration in 1..=3 {
        let packet = stagehand::build_claim("Stagehand", stagehand_ip, mac, iteration);
        if let Err(err) =
            send_stagehand_packet(state, sock, &packet, target, "stagehand claim").await
        {
            debug!(target: "djtools_link::stagehand", %target, %err, "stagehand_claim_failed");
        }
        tokio::time::sleep(Duration::from_millis(305)).await;
    }
}

fn spawn_stagehand_raw_rx(
    state: Arc<ServerState>,
    mut receiver: mpsc::Receiver<RawUdpReceived>,
) -> TokioJoinHandle<()> {
    tokio::spawn(async move {
        while let Some(datagram) = receiver.recv().await {
            let packet = datagram.payload.as_slice();
            if let Some(channels) = parse_a9_vu(packet) {
                state
                    .stagehand_last_a9_ms
                    .store(epoch_millis(), Ordering::Relaxed);
                let _ = state.vu_telemetry_tx.send(DjLinkVuTelemetryEvent {
                    source_ip: datagram.src_ip,
                    channels,
                });
                tracing::trace!(
                    target: "djtools_link::stagehand",
                    source_ip = %datagram.src_ip,
                    source_port = datagram.src_port,
                    destination_port = datagram.dst_port,
                    "a9_vu"
                );
                continue;
            }
            if let Some(mixer) = parse_a9_mixer_state(packet) {
                state
                    .stagehand_last_a9_ms
                    .store(epoch_millis(), Ordering::Relaxed);
                let _ = state.mixer_telemetry_tx.send(DjLinkMixerTelemetryEvent {
                    source_ip: datagram.src_ip,
                    mixer,
                    raw_packet: packet.to_vec(),
                });
                tracing::trace!(
                    target: "djtools_link::stagehand",
                    source_ip = %datagram.src_ip,
                    source_port = datagram.src_port,
                    destination_port = datagram.dst_port,
                    "a9_mixer_state"
                );
                continue;
            }
            if stagehand::is_peer_packet(packet) {
                tracing::trace!(
                    target: "djtools_link::stagehand",
                    source_ip = %datagram.src_ip,
                    source_port = datagram.src_port,
                    destination_port = datagram.dst_port,
                    packet_type = packet.get(0x0a).copied().unwrap_or_default(),
                    len = packet.len(),
                    "stagehand_raw_peer_packet"
                );
            }
        }
        tracing::warn!(target: "djtools_link::stagehand", "stagehand_raw_receiver_stopped");
    })
}

async fn send_stagehand_packet(
    state: &ServerState,
    sock: &UdpSocket,
    packet: &[u8],
    broadcast_target: SocketAddrV4,
    context: &str,
) -> std::io::Result<usize> {
    if let Some(stagehand_ip) = state.stagehand_ip.filter(|ip| *ip != state.bind_ip) {
        let src_mac = state
            .stagehand_link_mac
            .unwrap_or(parse_mac(&state.mac_addr)?);
        state
            .raw_udp
            .send(RawUdpDatagram {
                src_mac,
                dst_mac: [0xff; 6],
                src_ip: stagehand_ip,
                src_port: KEEPALIVE_PORT,
                dst_ip: *broadcast_target.ip(),
                dst_port: broadcast_target.port(),
                payload: packet.to_vec(),
            })
            .await?;
        debug!(
            target: "djtools_link::stagehand",
            context,
            source_ip = %stagehand_ip,
            target = %broadcast_target,
            "stagehand_raw_udp_sent"
        );
        return Ok(packet.len());
    }
    // Use the selected transport once per frame. Do not duplicate broadcast
    // presence by unicast; mobile's directed-only session selects its peer here.
    send_udp_packet(state, sock, packet, broadcast_target, context).await
}

async fn send_stagehand_transport_packet(
    state: &ServerState,
    sock: &UdpSocket,
    packet: &[u8],
    target_ip: Ipv4Addr,
) -> std::io::Result<usize> {
    if let Some(stagehand_ip) = state.stagehand_ip.filter(|ip| *ip != state.bind_ip) {
        let device = state.device_for_ip(target_ip).await.ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "unknown target player MAC")
        })?;
        state
            .raw_udp
            .send(RawUdpDatagram {
                src_mac: state
                    .stagehand_link_mac
                    .unwrap_or(parse_mac(&state.mac_addr)?),
                dst_mac: parse_mac(&device.mac_addr)?,
                src_ip: stagehand_ip,
                src_port: BEAT_PORT,
                dst_ip: target_ip,
                dst_port: BEAT_PORT,
                payload: packet.to_vec(),
            })
            .await?;
        return Ok(packet.len());
    }
    send_udp_packet(
        state,
        sock,
        packet,
        SocketAddrV4::new(target_ip, BEAT_PORT),
        "stagehand transport command",
    )
    .await
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
        let mut interval = tokio::time::interval(Duration::from_millis(100));
        loop {
            interval.tick().await;
            let bpm_hundreds = state.master_bpm_hundreds.load(Ordering::Relaxed);
            let packet = if bpm_hundreds == 0 {
                build_status_mixer_status(&state.config.model_name, state.config.player_number)
            } else {
                build_tempo_mixer_status(
                    &state.config.model_name,
                    state.config.player_number,
                    bpm_hundreds,
                )
            };
            send_regular_djlink_packet(&state, &sock, &packet, STATUS_PORT, "mixer status").await;
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
    let Some(track_id) = track_id_from_request_args(&state.library(), args) else {
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
    let Some(track_id) = track_id_from_request_args(&state.library(), args) else {
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
    if !state.library().tracks_by_id.contains_key(&track_id) {
        return false;
    }
    !track_is_loaded_on_player(state, target_player, track_id).await
}

fn should_mount_info_load_confirm(state: &ServerState, target_player: u8, track_id: u32) -> bool {
    state.config.auto_load_confirm
        && (1..=6).contains(&target_player)
        && state.library().tracks_by_id.contains_key(&track_id)
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
    if !state.library().tracks_by_id.contains_key(&track_id) {
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
    let library = state.library();
    let track = library.tracks_by_id.get(&track_id)?;
    let mut count = 0u16;
    for candidate in &library.all_tracks {
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
        let mut beat_in_bar = 1u8;
        loop {
            let bpm_hundreds = state.master_bpm_hundreds.load(Ordering::Relaxed);
            if bpm_hundreds == 0 {
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
            let packet = build_tempo_beat_status(
                &state.config.model_name,
                state.config.player_number,
                bpm_hundreds,
                beat_in_bar,
            );
            send_regular_djlink_packet(&state, &sock, &packet, BEAT_PORT, "beat status").await;
            beat_in_bar = beat_in_bar % 4 + 1;
            let beat_ns = 6_000_000_000_000u64 / u64::from(bpm_hundreds);
            tokio::time::sleep(Duration::from_nanos(beat_ns)).await;
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
            crate::diagnostics::udp("rx", sock.local_addr(), addr, &buf[..len]);
            let SocketAddr::V4(addr) = addr else {
                continue;
            };
            if *addr.ip() == state.bind_ip {
                continue;
            }
            let packet = &buf[..len];
            if let Some(channels) = parse_a9_vu(packet) {
                state
                    .stagehand_last_a9_ms
                    .store(epoch_millis(), Ordering::Relaxed);
                let _ = state.vu_telemetry_tx.send(DjLinkVuTelemetryEvent {
                    source_ip: *addr.ip(),
                    channels,
                });
                tracing::trace!(
                    target: "djtools_link::stagehand",
                    %addr,
                    len,
                    "a9_vu"
                );
                continue;
            }
            if stagehand::is_peer_packet(packet) {
                trace!(
                    target: "djtools_link::stagehand",
                    %addr,
                    len,
                    packet_type = packet.get(0x0a).copied().unwrap_or_default(),
                    "stagehand_beat_packet"
                );
                continue;
            }
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
            crate::diagnostics::udp("rx", sock.local_addr(), addr, &buf[..len]);
            let SocketAddr::V4(addr) = addr else {
                continue;
            };
            let ip = *addr.ip();
            if ip == state.bind_ip {
                continue;
            }
            let packet = &buf[..len];
            if let Some(mixer) = parse_a9_mixer_state(packet) {
                state
                    .stagehand_last_a9_ms
                    .store(epoch_millis(), Ordering::Relaxed);
                let _ = state.mixer_telemetry_tx.send(DjLinkMixerTelemetryEvent {
                    source_ip: ip,
                    mixer,
                    raw_packet: packet.to_vec(),
                });
                tracing::trace!(
                    target: "djtools_link::stagehand",
                    %addr,
                    len,
                    "a9_mixer_state"
                );
                continue;
            }
            if stagehand::is_peer_packet(packet) {
                trace!(
                    target: "djtools_link::stagehand",
                    %addr,
                    len,
                    packet_type = packet.get(0x0a).copied().unwrap_or_default(),
                    "stagehand_status_packet"
                );
                continue;
            }
            state.record_unicast_response(packet, ip).await;
            let status_header = status::decode_header(packet).ok();
            if let Some((remote_player, slot, _unknown)) = parse_status_link_query_detail(packet) {
                let reply = build_status_link_reply(
                    &state.config.model_name,
                    state.config.player_number,
                    slot,
                    &state.config.source_name,
                    state.library().track_count(),
                    state.library().playlist_count(),
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
                state
                    .actor_send(ServerMsg::DeviceActivity {
                        ip,
                        seen_at: Instant::now(),
                    })
                    .await;
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

fn parse_a9_mixer_state(packet: &[u8]) -> Option<DjLinkMixerState> {
    if !stagehand::is_a9_mixer_state(packet) {
        return None;
    }
    let channels = std::array::from_fn(|index| {
        let offset = 36 + index * 24;
        DjLinkMixerChannelState {
            channel: index as u8 + 1,
            input_source: packet[offset],
            trim: packet[offset + 1],
            eq_high: packet[offset + 3],
            eq_mid: packet[offset + 4],
            eq_low: packet[offset + 6],
            color: packet[offset + 7],
            fader: packet[offset + 11],
            crossfader_assign: packet[offset + 12],
        }
    });
    Some(DjLinkMixerState {
        channels,
        crossfader: packet[0xb4],
    })
}

fn parse_a9_vu(packet: &[u8]) -> Option<BTreeMap<u8, Vec<[u16; 2]>>> {
    if !stagehand::is_a9_vu(packet) {
        return None;
    }
    let channels = (1u8..=4)
        .map(|channel| {
            let offset = 44 + usize::from(channel - 1) * 60;
            let frames = (0..15)
                .map(|frame| {
                    let frame_offset = offset + frame * 4;
                    [
                        u16::from_be_bytes([packet[frame_offset], packet[frame_offset + 1]]),
                        u16::from_be_bytes([packet[frame_offset + 2], packet[frame_offset + 3]]),
                    ]
                })
                .collect::<Vec<_>>();
            (channel, frames)
        })
        .collect();
    Some(channels)
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
        // Dropping the listener task must also close its accepted sockets.
        let mut clients = JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let Ok((stream, addr)) = accepted else { continue };
                    clients.spawn(handle_db_query_conn(state.clone(), stream, addr));
                }
                _ = clients.join_next(), if !clients.is_empty() => {}
            }
        }
    })
}

async fn handle_db_query_conn(state: Arc<ServerState>, stream: TcpStream, addr: SocketAddr) {
    let Ok(mut stream) = crate::diagnostics::CapturedTcp::new(stream) else {
        return;
    };
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
        let mut clients = JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let Ok((stream, addr)) = accepted else { continue };
                    tracing::info!(target: "djtools_link::db", %addr, "db_client_connected");
                    clients.spawn(handle_db_client(state.clone(), stream, addr, Some(status_sock.clone())));
                }
                _ = clients.join_next(), if !clients.is_empty() => {}
            }
        }
    })
}

async fn write_db_response(
    stream: &mut (impl AsyncWrite + Unpin),
    response: &[u8],
) -> io::Result<()> {
    stream.write_all(response).await?;
    stream.flush().await
}

async fn handle_db_client(
    state: Arc<ServerState>,
    stream: TcpStream,
    addr: SocketAddr,
    status_sock: Option<Arc<UdpSocket>>,
) {
    let SocketAddr::V4(_) = addr else {
        return;
    };
    if let Err(err) = stream.set_nodelay(true) {
        warn!(target: "djtools_link::db", %addr, %err, "db_tcp_nodelay_failed");
    }
    let Ok(stream) = crate::diagnostics::CapturedTcp::new(stream) else {
        return;
    };
    let mut stream = tokio::io::BufReader::new(stream);
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
        let library = state.library();
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
                    title_entries_for_request(&library, &msg.args),
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
                    artist_entries(&library),
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
                    artists_for_genre_entries(&library, &msg.args),
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
                    album_entries(&library),
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
                    genre_entries(&library),
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
                    bpm_entries(&library),
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
                    decade_entries(&library),
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
                    label_entries(&library),
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
                    color_entries(&library),
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
                    time_entries(&library),
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
                    bitrate_entries(&library),
                )
                .await;
            }
            DB_REQ_HISTORY_MENU => {
                let entries =
                    history_entries(&state.history.read().expect("history lock poisoned"));
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    entries,
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
                    date_added_entries(&library),
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
                    filename_entries(&library),
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
                    key_entries(&library),
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
                    bpm_range_entries(&library, &msg.args),
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
                    tracks_for_rating_entries(&library, &msg.args),
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
                    years_for_decade_entries(&library, &msg.args),
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
                    artists_for_label_entries(&library, &msg.args),
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
                    tracks_for_color_entries(&library, &msg.args),
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
                    tracks_for_time_entries(&library, &msg.args),
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
                    tracks_for_bitrate_entries(&library, &msg.args),
                )
                .await;
            }
            DB_REQ_TRACKS_FOR_HISTORY => {
                let entries = tracks_for_history_entries(
                    &library,
                    &state.history.read().expect("history lock poisoned"),
                    &msg.args,
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
            DB_REQ_KEY_NEIGHBOR => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    key_neighbor_entries(&library, &msg.args),
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
                    tracks_for_key_distance_entries(&library, &msg.args),
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
                    albums_for_artist_entries(&library, &msg.args),
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
                    tracks_for_album_entries(&library, &msg.args),
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
                    albums_for_genre_artist_entries(&library, &msg.args),
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
                    tracks_for_artist_album_entries(&library, &msg.args),
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
                    tracks_for_bpm_distance_entries(&library, &msg.args),
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
                    tracks_for_decade_year_entries(&library, &msg.args),
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
                    albums_for_label_artist_entries(&library, &msg.args),
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
                    playlist_entries(&library, &msg.args),
                )
                .await;
            }
            DB_REQ_SEARCH | DB_REQ_INCREMENTAL_SEARCH => {
                let entries = search_entries_indexed(&library, &library.search_index, &msg.args);
                let search_query = search_query_from_args(&msg.args).unwrap_or_default();
                let normalized_query = normalize_search_text(&search_query);
                let search_sort = search_sort_from_args(&msg.args);
                let search_menu = rmst_menu_from_args(&msg.args).unwrap_or(0);
                tracing::info!(
                    target: "djtools_link::db",
                    %addr,
                    tx,
                    request = db_request_name(msg.msg_type),
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
                    tracks_for_genre_artist_album_entries(&library, &msg.args),
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
                    tracks_for_date_added_entries(&library, &msg.args),
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
                    tracks_for_label_artist_album_entries(&library, &msg.args),
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
                    metadata_entries(&library, &msg.args),
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
            DB_REQ_DELIVERY_INFO => {
                write_pending_success(
                    &mut stream,
                    tx,
                    msg.msg_type,
                    &msg.args,
                    &mut pending,
                    delivery_info_entries(&library, &msg.args),
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
                    mount_info_entries(&library, &msg.args),
                )
                .await;
                maybe_send_mount_info_load_confirm(&state, status_sock.as_ref(), addr, &msg.args)
                    .await;
            }
            DB_REQ_ARTWORK => {
                let blob = load_artwork(&library, &msg.args).await;
                send_response!(blob_response(
                    tx,
                    msg.msg_type,
                    DB_RES_ARTWORK,
                    blob.as_deref(),
                ));
            }
            DB_REQ_WAVEFORM_PREVIEW => {
                let track_id = track_id_from_request_at(&library, &msg.args, 1);
                let blob = load_cached_waveform_preview(&library, &msg.args).await;
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
                if let Some((track_id, preview)) = waveform_preview_upload(&library, &msg.args) {
                    let bytes = preview.len();
                    library
                        .waveform_cache
                        .write()
                        .expect("waveform cache lock poisoned")
                        .insert(track_id, preview);
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
            DB_REQ_DJ_ID => {
                // Rekordbox PSvDBMain::OnUserCmd calls GetDJID and replies with
                // binary response 0x4d02, never SUCCESS(0x4000). We have no
                // Rekordbox DJ identity, so use its native no-identity branch:
                // [request, 0, length=0, omitted binary field]. See fixtures.
                trace!(
                    target: "djtools_link::db",
                    %addr,
                    tx,
                    args = msg.args.len(),
                    "db_dj_id_unavailable"
                );
                send_response!(empty_blob_response(tx, msg.msg_type, DB_RES_DJ_ID, false));
            }
            DB_REQ_WAVEFORM_DETAIL => {
                let track_id = track_id_from_request_at(&library, &msg.args, 0);
                let blob = load_waveform_detail(&library, &msg.args).await;
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
                let track_id = track_id_from_request_at(&library, &msg.args, 0);
                let blob = load_beat_grid(&library, &msg.args).await;
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
                let cues = cue_override_for_request(&state, &msg.args)
                    .map(cue_points_for_memory_override)
                    .unwrap_or_default();
                let cues = if cues.memory_count > 0 {
                    cues
                } else {
                    load_cue_points(&library, &msg.args)
                        .await
                        .unwrap_or_default()
                };
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
                let cues = match cue_override_for_request(&state, &msg.args) {
                    Some(cue_ms) => cue_points_ext_for_memory_override(cue_ms),
                    None => load_cue_points_ext(&library, &msg.args)
                        .await
                        .unwrap_or_else(default_extended_cue_points),
                };
                send_response!(cue_points_ext_response(
                    tx,
                    msg.msg_type,
                    cues.entries.as_slice(),
                    cues.entry_count,
                ));
            }
            DB_REQ_ANLZ_TAG | 0x2d04 => {
                let (track_id, tag_name, ext_name) = anlz_tag_request_summary(&msg.args);
                let blob =
                    load_anlz_tag(&library, &msg.args, state.config.serve_extended_anlz_tags).await;
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
                let blob = load_vbr_payload(&library, &msg.args).await;
                send_response!(blob_response(
                    tx,
                    msg.msg_type,
                    DB_RES_EXT_2504,
                    blob.as_deref(),
                ));
            }
            DB_REQ_MENU_OFFSET => {
                let key = pending_key_from_args(&msg.args);
                let entry_id = db_int(msg.args.get(1)).unwrap_or(u32::MAX);
                let offset = pending.menu_offset(key, entry_id);
                trace!(
                    target: "djtools_link::db",
                    %addr,
                    tx,
                    ?key,
                    entry_id,
                    offset,
                    "db_menu_offset"
                );
                send_response!(success_with_count(tx, DB_REQ_MENU_OFFSET, offset));
            }
            DB_REQ_RENDER => {
                let render_started = Instant::now();
                let window = parse_render_window(&msg.args);
                let render_key = pending_key_from_args(&msg.args);
                let prepared_key = pending.key();
                let pending_len = pending.len_for_key(render_key);
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
    stream: &mut (impl AsyncWrite + Unpin),
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
    if let Err(error) = stream
        .write_all(&success_with_count(tx, request_type, count))
        .await
    {
        warn!(target: "djtools_link::db", tx, %error, "db_menu_response_failed");
    }
}

async fn write_pending_browse_success(
    state: &ServerState,
    addr: SocketAddr,
    stream: &mut (impl AsyncWrite + Unpin),
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

fn history_entries(histories: &[HistoryRecord]) -> Vec<MenuEntry> {
    histories
        .iter()
        .map(|history| {
            // 0x0024 is HISTORY_PLAYLIST, not the ordinary playlist type (0x0008).
            MenuEntry::plain(0, history.history_id, &history.name, "", 0x0024)
        })
        .collect()
}

fn tracks_for_history_entries(
    library: &LibrarySnapshot,
    histories: &[HistoryRecord],
    args: &[DbValue],
) -> Vec<MenuEntry> {
    let args = strip_rmst_arg(args);
    let Some(history) = histories
        .iter()
        .find(|history| Some(history.history_id) == db_int(args.get(1)))
    else {
        return Vec::new();
    };
    let tracks = history
        .tracks
        .iter()
        .filter_map(|id| library.tracks_by_id.get(id).cloned())
        .collect::<Vec<_>>();
    let sort = db_int(args.first()).unwrap_or(SORT_DEFAULT);
    if sort == SORT_DEFAULT {
        title_entries(&tracks, true)
    } else {
        title_entries_for_sort(&tracks, sort, true)
    }
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
        // Matching needs Rekordbox's relationship data, which we do not serve.
        // A deck can retain the old menu across a server update; answer that
        // stale selection with an empty menu rather than the complete library.
        return Vec::new();
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
                position: playlist.sequence,
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

fn delivery_info_entries(library: &LibrarySnapshot, args: &[DbValue]) -> Vec<MenuEntry> {
    let Some(track) = track_from_request(library, args) else {
        return Vec::new();
    };
    // Rekordbox GetDeliveryInfDB / PSvAppSyncDBIF::getDeliveryInf: 13 rows,
    // followed by the usual RENDER exchange. This is a separate menu context
    // (0x09 on the CDJ-3000), not ordinary display metadata or a binary blob.
    // The snapshot has no KUVO delivery opt-in, ISRC, delivery comment,
    // composer or lyricist. Return their native unset values, not made-up IDs.
    let file_type = match track.mount_path.extension().and_then(|ext| ext.to_str()) {
        Some(ext) => match ext.to_ascii_lowercase().as_str() {
            "mp3" => 1,
            "m4a" | "aac" => 4,
            "flac" => 5,
            "wav" => 11,
            "aif" | "aiff" => 12,
            _ => 0,
        },
        None => 0,
    };
    vec![
        MenuEntry::plain(track.track_id, library.master_db_id, "", "", 0x004f),
        MenuEntry::plain(track.track_id, track.track_id, &track.title, "", META_TITLE)
            .with_entry_id3(track.artwork_id),
        MenuEntry::plain(0, track.artist_id, &track.artist, "", META_ARTIST),
        MenuEntry::plain(0, track.album_id, &track.album, "", META_ALBUM),
        MenuEntry::plain(0, track.genre_id, &track.genre, "", META_GENRE),
        MenuEntry::plain(0, track.track_id, "", "", META_COMMENT),
        MenuEntry::plain(track.key_id, track.key_id, "", &track.key_label(), META_KEY),
        MenuEntry::plain(0, track.duration_sec, "", "", META_DURATION),
        MenuEntry::plain(0, file_type, "", "", 0x0012),
        MenuEntry::plain(0, track.bpm_hundreds, "", "", META_BPM),
        MenuEntry::plain(
            0,
            stable_text_id(&track.label),
            &track.label,
            "",
            META_LABEL,
        ),
        MenuEntry::plain(0, 0, "", "", 0x0036),
        MenuEntry::plain(0, track.track_id, "", "", 0x0037),
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
            &nfs_export_path(&track.mount_path).to_string_lossy(),
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

async fn load_artwork(library: &LibraryGeneration, args: &[DbValue]) -> Option<Vec<u8>> {
    let track = track_from_artwork_request(&library, args)?;
    if track.artwork_id == 0 {
        return None;
    }
    if let Some(cached) = library
        .artwork_cache
        .read()
        .expect("artwork cache lock poisoned")
        .get(&track.artwork_id)
        .cloned()
    {
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
    library
        .artwork_cache
        .write()
        .expect("artwork cache lock poisoned")
        .insert(track.artwork_id, fetched.clone());
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

async fn load_cached_waveform_preview(
    library: &LibraryGeneration,
    args: &[DbValue],
) -> Option<Vec<u8>> {
    let Some(track_id) = track_id_from_request_at(&library, args, 1) else {
        return load_waveform_preview(&library, args).await;
    };

    if let Some(blob) = library
        .waveform_cache
        .read()
        .expect("waveform cache lock poisoned")
        .get(&track_id)
        .cloned()
    {
        return Some(blob);
    }

    let blob = load_waveform_preview(&library, args).await;
    if let Some(blob) = blob.as_ref() {
        library
            .waveform_cache
            .write()
            .expect("waveform cache lock poisoned")
            .insert(track_id, blob.clone());
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

fn cue_override_for_request(state: &ServerState, args: &[DbValue]) -> Option<u32> {
    let track_id = track_id_from_request_at(&state.library(), args, 0)?;
    state
        .cue_overrides_ms
        .read()
        .expect("cue override lock poisoned")
        .get(&track_id)
        .copied()
}

fn cue_points_for_memory_override(cue_ms: u32) -> CuePoints {
    let mut entry = [0u8; 36];
    entry[1] = 1;
    entry[12..16].copy_from_slice(&time_ms_to_half_frames(cue_ms).to_le_bytes());
    CuePoints {
        first: entry.to_vec(),
        second: Vec::new(),
        hot_count: 0,
        memory_count: 1,
    }
}

fn cue_points_ext_for_memory_override(cue_ms: u32) -> CuePointsExt {
    let mut entry = vec![0u8; 56];
    entry[0..4].copy_from_slice(&56u32.to_le_bytes());
    entry[6] = 1;
    entry[8..12].copy_from_slice(&[0x00, 0x00, 0xe8, 0x03]);
    entry[12..16].copy_from_slice(&cue_ms.to_le_bytes());
    entry[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
    CuePointsExt {
        entries: entry,
        entry_count: 1,
    }
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

fn first_chorus_beat_from_pssi(tag: &[u8]) -> Option<u16> {
    if tag.len() < 32 || tag.get(0..4)? != b"PSSI" {
        return None;
    }
    let tag_len = (be_u32(tag.get(8..12)?) as usize).min(tag.len());
    let count = u16::from_be_bytes(tag.get(16..18)?.try_into().ok()?) as usize;
    if tag_len < 32 + count.checked_mul(24)? {
        return None;
    }
    let mut decoded = tag[..tag_len].to_vec();
    let mut mood = u16::from_be_bytes(decoded.get(18..20)?.try_into().ok()?);
    if !matches!(mood, 1..=3) {
        for index in 18..decoded.len() {
            decoded[index] ^=
                PSSI_XOR_MASK[(index - 18) % PSSI_XOR_MASK.len()].wrapping_add(count as u8);
        }
        mood = u16::from_be_bytes(decoded.get(18..20)?.try_into().ok()?);
    }
    let chorus_kind = match mood {
        1 => 5,
        2 | 3 => 9,
        _ => return None,
    };
    (0..count)
        .filter_map(|index| {
            let offset = 32 + index * 24;
            let kind = u16::from_be_bytes(decoded.get(offset + 4..offset + 6)?.try_into().ok()?);
            (kind == chorus_kind).then(|| {
                u16::from_be_bytes(
                    decoded
                        .get(offset + 2..offset + 4)
                        .expect("validated PSSI entry")
                        .try_into()
                        .expect("two-byte PSSI beat"),
                )
            })
        })
        .min()
}

fn pqtz_beat_time_ms(tag: &[u8], beat_number: u16) -> Option<u32> {
    let stats = pqtz_grid_stats(tag)?;
    let index = usize::from(beat_number.checked_sub(1)?);
    (index < stats.count).then(|| be_u32(&tag[24 + index * 8 + 4..24 + index * 8 + 8]))
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
    for _ in 0..declared_count {
        if offset + 16 > tag_len {
            return None;
        }
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
    for _ in 0..declared_count {
        if offset + 40 > tag_len {
            return None;
        }
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

fn waveform_from_pwv5_tag(tag: &[u8]) -> Option<(Vec<f32>, Vec<[u8; 3]>)> {
    if tag.len() < 24 || tag.get(0..4)? != b"PWV5" {
        return None;
    }
    let tag_len = (be_u32(tag.get(8..12)?) as usize).min(tag.len());
    let count = be_u32(tag.get(16..20)?) as usize;
    let entries_len = count.checked_mul(2)?;
    if tag_len < 24 || tag_len - 24 < entries_len {
        return None;
    }
    let mut peaks = Vec::with_capacity(count);
    let mut colors = Vec::with_capacity(count);
    for index in 0..count {
        let offset = 24 + index * 2;
        let value = u16::from_be_bytes(tag.get(offset..offset + 2)?.try_into().ok()?);
        peaks.push(f32::from((value & 0x007c) >> 2) / 31.0);
        colors.push([
            scale_three_bit_color((value & 0xe000) >> 13),
            scale_three_bit_color((value & 0x1c00) >> 10),
            scale_three_bit_color((value & 0x0380) >> 7),
        ]);
    }
    Some((peaks, colors))
}

fn waveform_from_pwv4_tag(tag: &[u8]) -> Option<(Vec<f32>, Vec<[u8; 3]>)> {
    if tag.len() < 24 || tag.get(0..4)? != b"PWV4" {
        return None;
    }
    let tag_len = (be_u32(tag.get(8..12)?) as usize).min(tag.len());
    let count = be_u32(tag.get(16..20)?) as usize;
    let entries_len = count.checked_mul(6)?;
    if tag_len < 24 || tag_len - 24 < entries_len {
        return None;
    }
    let mut peaks = Vec::with_capacity(count);
    let mut colors = Vec::with_capacity(count);
    for entry in tag[24..24 + entries_len].chunks_exact(6) {
        let boost = u16::from(entry[1]);
        let inverse_blue = entry[2] & 0x7f;
        let red = entry[3] & 0x7f;
        let green = entry[4] & 0x7f;
        let blue = entry[5] & 0x7f;
        peaks.push(f32::from(blue.max(inverse_blue).max(red).max(green)) / 127.0);
        colors.push([
            ((u16::from(red) * boost) / 127).min(255) as u8,
            ((u16::from(green) * boost) / 127).min(255) as u8,
            ((u16::from(blue) * boost) / 127).min(255) as u8,
        ]);
    }
    Some((peaks, colors))
}

fn waveform_from_pwav_tag(tag: &[u8]) -> Option<(Vec<f32>, Vec<[u8; 3]>)> {
    if tag.get(0..4)? != b"PWAV" {
        return None;
    }
    let body = anlz_tag_body(tag)?;
    let peaks = body
        .iter()
        .map(|value| f32::from(value & 0x1f) / 31.0)
        .collect::<Vec<_>>();
    Some((peaks, Vec::new()))
}

fn waveform_beats_from_pqtz_tag(tag: &[u8]) -> Option<Vec<DjLinkWaveformBeat>> {
    let stats = pqtz_grid_stats(tag)?;
    let mut beats = Vec::with_capacity(stats.count);
    for index in 0..stats.count {
        let offset = 24 + index * 8;
        let beat = u16::from_be_bytes(tag.get(offset..offset + 2)?.try_into().ok()?);
        let time_ms = be_u32(tag.get(offset + 4..offset + 8)?);
        beats.push(DjLinkWaveformBeat {
            beat: u8::try_from(beat).ok()?,
            time_seconds: time_ms as f32 / 1_000.0,
        });
    }
    Some(beats)
}

fn scale_three_bit_color(value: u16) -> u8 {
    ((value * 255 + 3) / 7).min(255) as u8
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
            crate::diagnostics::udp("rx", sock.local_addr(), addr, &buf[..len]);
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
            crate::diagnostics::udp("rx", sock.local_addr(), addr, &buf[..len]);
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
            crate::diagnostics::udp("rx", sock.local_addr(), addr, &buf[..len]);
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
    if state.config.unicast_discovery_netmask.is_some() {
        // Each candidate receives the unicast join in spawn_unicast_discovery.
        return;
    }
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
    payload_overrides: &[(usize, u8)],
    context: &'static str,
) -> bool {
    if (!state.config.auto_unlock_load_lock && payload_overrides.is_empty())
        || !(1..=6).contains(&target_player)
    {
        return false;
    }
    let packet = build_status_load_settings_command(
        &state.config.model_name,
        state.config.player_number,
        target_player,
        payload_overrides,
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
    if state.config.stagehand_monitor
        && state
            .device_for_ip(ip)
            .await
            .as_ref()
            .is_some_and(is_stagehand_mixer)
    {
        return;
    }
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
    send_regular_djlink_packet(state, sock, &packet, STATUS_PORT, context).await;
    state.mark_link_init_broadcast().await;
}

async fn send_regular_djlink_packet(
    state: &ServerState,
    sock: &UdpSocket,
    packet: &[u8],
    port: u16,
    context: &str,
) {
    let targets = if state.config.unicast_discovery_netmask.is_some() {
        state
            .devices_sorted()
            .await
            .into_iter()
            .filter(|device| !state.config.stagehand_monitor || !is_stagehand_mixer(device))
            .map(|device| SocketAddrV4::new(device.ip_addr, port))
            .collect()
    } else if state.config.stagehand_monitor {
        state
            .devices_sorted()
            .await
            .into_iter()
            .filter(|device| {
                (1..=6).contains(&device.player_number)
                    && !device.model.eq_ignore_ascii_case("DJM-A9")
            })
            .map(|device| SocketAddrV4::new(device.ip_addr, port))
            .collect::<Vec<_>>()
    } else {
        vec![SocketAddrV4::new(state.broadcast_ip, port)]
    };
    for target in targets {
        if let Err(err) = send_udp_packet(state, sock, packet, target, context).await {
            debug!(target: "djtools_link::udp", %target, %err, "regular_djlink_send_failed");
        }
    }
}
