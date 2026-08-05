use std::collections::{BTreeMap, BTreeSet};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand};
use djtools_link::{
    DEFAULT_MOUNT_PORT, DjLinkConfig, DjLinkSearchMode, DjLinkServer, LibrarySnapshot, LogLevel,
    PlaylistRecord, REKORDBOX_PLAYER_NUMBER, RekordboxLibraryLoadReport, RemoteDbCursorAudit,
    SLOT_REKORDBOX, TRACK_TYPE_REKORDBOX, TrackRecord, audit_remote_db_cursors,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;
use tokio::task::JoinSet;

use crate::a9_usb::configure_meter_routes;
use crate::audio_meter::{MeterEvent, audio_input_present, connect_audio_meter};
use crate::mixer::{Decoder, connect_midi, midi_input_present};
use crate::state_api::{StateApiConfig, StateApiServer};

const DEVICE_RECONNECT_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Parser)]
#[command(
    name = "djbooth-rs link",
    version,
    about = "Native DJ Link runtime for djbooth.ai"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Validate a compatible database or projected djbooth library without opening DJ Link ports.
    Doctor(DoctorArgs),
    /// Serve a compatible database or projected djbooth library over DJ Link.
    Serve(Box<ServeArgs>),
    /// Audit DJ Link packet shapes in a pcap/pcapng through tshark.
    AuditPcap(AuditPcapArgs),
}

#[derive(Args)]
struct DoctorArgs {
    #[command(flatten)]
    library: LibraryArgs,
    #[arg(long)]
    require_analysis: bool,
}

#[derive(Args)]
struct ServeArgs {
    #[command(flatten)]
    library: LibraryArgs,
    #[arg(long)]
    socket: PathBuf,
    #[arg(long, default_value = "djbooth")]
    name: String,
    #[arg(long, default_value = "rekordbox")]
    model: String,
    #[arg(long, default_value_t = REKORDBOX_PLAYER_NUMBER)]
    player_number: u8,
    #[arg(long)]
    bind_ip: Option<Ipv4Addr>,
    #[arg(long)]
    broadcast_ip: Option<Ipv4Addr>,
    #[arg(long, default_value_t = 1051)]
    db_port: u16,
    #[arg(long)]
    log_path: Option<PathBuf>,
    /// Write every successfully injected raw-BPF Ethernet frame to a fresh libpcap file.
    #[arg(long)]
    wire_pcap: Option<PathBuf>,
    #[arg(long, default_value = "info")]
    log_level: String,
    #[arg(long)]
    require_analysis: bool,
    /// Bind the read-only, versioned booth-state HTTP/WebSocket API.
    #[arg(long, default_value = "127.0.0.1:4182")]
    api_bind: SocketAddr,
    /// Case-insensitive MIDI input selector exposed through the state API.
    #[arg(long, default_value = "DJM-A9")]
    midi_device: String,
    /// Case-insensitive CoreAudio input selector used for live level meters.
    #[arg(long, default_value = "DJM-A9")]
    audio_device: String,
    /// Join as a Stagehand peer so compatible mixers stream controls and VU levels.
    #[arg(long)]
    stagehand_monitor: bool,
    /// Optional mixer IP for a direct Stagehand handshake in addition to broadcast discovery.
    #[arg(long, requires = "stagehand_target_mac")]
    stagehand_target_ip: Option<Ipv4Addr>,
    /// Link-layer mixer MAC paired with --stagehand-target-ip.
    #[arg(long, requires = "stagehand_target_ip")]
    stagehand_target_mac: Option<String>,
}

#[derive(Args)]
struct LibraryArgs {
    /// Projected JSON library used for an ad-hoc djbooth manifest.
    #[arg(
        long,
        conflicts_with = "rekordbox_db",
        required_unless_present = "rekordbox_db"
    )]
    snapshot: Option<PathBuf>,
    /// Rekordbox 6/7 master.db opened directly and strictly read-only.
    #[arg(long, value_name = "PATH", conflicts_with = "snapshot")]
    rekordbox_db: Option<PathBuf>,
}

#[derive(Args)]
struct AuditPcapArgs {
    #[arg(long)]
    pcap: PathBuf,
    #[arg(long)]
    reference: Option<PathBuf>,
    #[arg(long, default_value = "rekordbox")]
    source_model: String,
    #[arg(long)]
    require_core: bool,
    /// Require at least one nonzero RemoteDB render and exact same-transaction header offsets.
    #[arg(long)]
    require_remote_db_cursors: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotDocument {
    schema_version: u32,
    master_db_id: u32,
    tracks: Vec<SnapshotTrack>,
    playlists: Vec<SnapshotPlaylist>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotTrack {
    track_id: u32,
    title: String,
    artist: String,
    artist_id: u32,
    canonical_name: String,
    album: String,
    album_id: u32,
    duration_sec: u32,
    bpm_hundreds: u32,
    key: String,
    camelot: String,
    key_id: u32,
    bitrate_kbps: u32,
    comment: String,
    mount_path: PathBuf,
    analysis_dat_path: Option<PathBuf>,
    analysis_ext_path: Option<PathBuf>,
    analysis_twoex_path: Option<PathBuf>,
    artwork_id: u32,
    artwork_url: Option<String>,
    genre: String,
    genre_id: u32,
    label: String,
    year: u32,
    date_added_id: u32,
    date_added: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotPlaylist {
    playlist_id: u32,
    name: String,
    #[serde(default)]
    parent_id: u32,
    #[serde(default)]
    is_folder: bool,
    #[serde(default)]
    sequence: u32,
    tracks: Vec<u32>,
}

#[derive(Debug, Deserialize)]
struct ControlRequest {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct ControlResponse {
    id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadParams {
    player: u8,
    track_id: u32,
    #[serde(default = "default_load_repeat")]
    repeat: usize,
    #[serde(default = "default_load_interval_ms")]
    interval_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareParams {
    player: u8,
    track_id: u32,
    bpm_hundreds: u16,
    #[serde(default = "default_bars_before")]
    bars_before: u16,
    #[serde(default = "default_load_repeat")]
    repeat: usize,
    #[serde(default = "default_load_interval_ms")]
    interval_ms: u64,
}

#[derive(Debug, Deserialize)]
struct PlayerParams {
    player: u8,
}

#[derive(Debug, Deserialize)]
struct ResolveTrackParams {
    selector: String,
}

#[derive(Debug, Deserialize)]
struct SearchParams {
    query: String,
    #[serde(default = "default_search_mode")]
    mode: String,
    #[serde(default = "default_search_limit")]
    limit: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArpProbeParams {
    ip: Ipv4Addr,
    #[serde(default = "default_arp_probe_timeout_ms")]
    timeout_ms: u64,
}

#[derive(Clone)]
struct RuntimeInfo {
    started: Instant,
    bind_ip: Ipv4Addr,
    broadcast_ip: Ipv4Addr,
    player_number: u8,
    tracks: usize,
    playlists: usize,
}

#[derive(Debug)]
struct CapturedDjLinkPacket {
    frame: u64,
    source_ip: String,
    source_port: u16,
    destination_ip: String,
    destination_port: u16,
    service_port: u16,
    packet_type: u16,
    model: String,
    payload: Vec<u8>,
}

#[derive(Debug)]
struct CapturedTcpSegment {
    frame: u64,
    sequence: u64,
    payload: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct TcpDirection {
    source_ip: String,
    source_port: u16,
    destination_ip: String,
    destination_port: u16,
}

impl TcpDirection {
    fn reverse_of(&self, other: &Self) -> bool {
        self.source_ip == other.destination_ip
            && self.source_port == other.destination_port
            && self.destination_ip == other.source_ip
            && self.destination_port == other.source_port
    }

    fn source(&self) -> String {
        format!("{}:{}", self.source_ip, self.source_port)
    }

    fn destination(&self) -> String {
        format!("{}:{}", self.destination_ip, self.destination_port)
    }
}

#[derive(Debug)]
struct ReassembledTcpDirection {
    direction: TcpDirection,
    bytes: Vec<u8>,
    gaps: usize,
}

#[derive(Debug)]
struct CapturedRemoteDbAudit {
    stream: u32,
    request_direction: TcpDirection,
    request_gaps: usize,
    response_gaps: usize,
    audit: RemoteDbCursorAudit,
}

#[derive(Debug, Default)]
struct RemoteDbPcapAudit {
    streams: Vec<CapturedRemoteDbAudit>,
}

impl RemoteDbPcapAudit {
    fn render_requests(&self) -> usize {
        self.streams
            .iter()
            .map(|stream| stream.audit.exchanges.len())
            .sum()
    }

    fn nonzero_requests(&self) -> usize {
        self.streams
            .iter()
            .map(|stream| stream.audit.nonzero_requests())
            .sum()
    }

    fn matching_headers(&self) -> usize {
        self.streams
            .iter()
            .map(|stream| stream.audit.matching_headers())
            .sum()
    }

    fn mismatched_headers(&self) -> usize {
        self.streams
            .iter()
            .map(|stream| stream.audit.mismatched_headers())
            .sum()
    }

    fn missing_headers(&self) -> usize {
        self.streams
            .iter()
            .map(|stream| stream.audit.missing_headers())
            .sum()
    }

    fn complete(&self) -> bool {
        self.nonzero_requests() > 0
            && self.matching_headers() == self.render_requests()
            && self.mismatched_headers() == 0
            && self.missing_headers() == 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
struct PacketShape {
    service_port: u16,
    packet_type: String,
    bytes: usize,
}

pub async fn run(args: impl IntoIterator<Item = String>) -> Result<()> {
    let cli = Cli::parse_from(std::iter::once("djbooth-rs link".to_string()).chain(args));
    match cli.command {
        Command::Doctor(args) => doctor(args).await,
        Command::Serve(args) => serve(*args).await,
        Command::AuditPcap(args) => audit_pcap(args),
    }
}

fn audit_pcap(args: AuditPcapArgs) -> Result<()> {
    let packets = read_djlink_pcap(&args.pcap)?;
    let remote_db = read_remote_db_pcap(&args.pcap)?;
    let source_packets = packets
        .iter()
        .filter(|packet| packet.model == args.source_model)
        .collect::<Vec<_>>();
    let source_shapes = count_shapes(source_packets.iter().copied());
    let core = CoreDiscoveryGates::from_shapes(&source_shapes);

    let reference = if let Some(path) = &args.reference {
        let packets = read_djlink_pcap(path)?;
        let remote_db = read_remote_db_pcap(path)?;
        let reference_source_packets = packets
            .iter()
            .filter(|packet| packet.model == args.source_model)
            .collect::<Vec<_>>();
        let shapes = count_shapes(reference_source_packets.iter().copied());
        let candidate_keys = source_shapes.keys().cloned().collect::<BTreeSet<_>>();
        let reference_keys = shapes.keys().cloned().collect::<BTreeSet<_>>();
        let missing = reference_keys
            .difference(&candidate_keys)
            .cloned()
            .collect::<Vec<_>>();
        let extra = candidate_keys
            .difference(&reference_keys)
            .cloned()
            .collect::<Vec<_>>();
        Some(json!({
            "pcap": path,
            "packets": packets.len(),
            "sourcePackets": reference_source_packets.len(),
            "sourceShapes": shapes_to_json(&shapes),
            "missingShapes": missing,
            "extraShapes": extra,
            "responseGatedShapes": [
                {
                    "trigger": { "servicePort": 50002, "packetType": "0x05" },
                    "response": { "servicePort": 50002, "packetType": "0x06", "bytes": 192 },
                },
                {
                    "trigger": { "servicePort": 50002, "packetType": "0x46" },
                    "response": { "servicePort": 50002, "packetType": "0x47", "bytes": 72 },
                },
            ],
            "staticPayloadMatches": {
                "linkInit": has_shared_static_payload(&source_packets, &reference_source_packets, 50002, 0x16),
                "mixerStatus": has_shared_static_payload(&source_packets, &reference_source_packets, 50002, 0x29),
                "extension47": has_shared_static_payload(&source_packets, &reference_source_packets, 50002, 0x47),
            },
            "remoteDb": remote_db_audit_json(&remote_db),
        }))
    } else {
        None
    };

    let report = json!({
        "ok": (!args.require_core || core.complete())
            && (!args.require_remote_db_cursors || remote_db.complete()),
        "pcap": args.pcap,
        "packets": packets.len(),
        "sourceModel": args.source_model,
        "sourcePackets": source_packets.len(),
        "sourceShapes": shapes_to_json(&source_shapes),
        "gates": {
            "keepalive": core.keepalive,
            "linkInit": core.link_init,
            "mixerStatus": core.mixer_status,
            "complete": core.complete(),
        },
        "remoteDb": remote_db_audit_json(&remote_db),
        "firstSourcePacket": source_packets.first().map(|packet| json!({
            "frame": packet.frame,
            "source": format!("{}:{}", packet.source_ip, packet.source_port),
            "destination": format!("{}:{}", packet.destination_ip, packet.destination_port),
        })),
        "reference": reference,
    });
    println!("{}", serde_json::to_string_pretty(&report)?);
    if args.require_core && !core.complete() {
        bail!(
            "pcap is missing core Rekordbox-source discovery shapes: keepalive={} link_init={} mixer_status={}",
            core.keepalive,
            core.link_init,
            core.mixer_status
        );
    }
    if args.require_remote_db_cursors && !remote_db.complete() {
        bail!(
            "pcap failed the RemoteDB cursor gate: nonzero_renders={} matching_headers={} mismatched_headers={} missing_headers={}",
            remote_db.nonzero_requests(),
            remote_db.matching_headers(),
            remote_db.mismatched_headers(),
            remote_db.missing_headers()
        );
    }
    Ok(())
}

fn remote_db_audit_json(report: &RemoteDbPcapAudit) -> Value {
    json!({
        "complete": report.complete(),
        "streams": report.streams.iter().map(|stream| {
            json!({
                "tcpStream": stream.stream,
                "requestSource": stream.request_direction.source(),
                "requestDestination": stream.request_direction.destination(),
                "requestGaps": stream.request_gaps,
                "responseGaps": stream.response_gaps,
                "decodedRequests": stream.audit.decoded_requests,
                "decodedResponses": stream.audit.decoded_responses,
                "headersWithoutRender": stream.audit.headers_without_render,
                "exchanges": stream.audit.exchanges.iter().map(|exchange| {
                    json!({
                        "transactionId": exchange.tx_id,
                        "rmst": exchange.rmst.map(|value| format!("0x{value:08x}")),
                        "requestedOffset": exchange.requested_offset,
                        "requestedCount": exchange.requested_count,
                        "requestedTotal": exchange.requested_total,
                        "headerMarker": exchange.header_marker,
                        "headerOffset": exchange.header_offset,
                        "matches": exchange.matches(),
                    })
                }).collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>(),
        "renderRequests": report.render_requests(),
        "nonzeroRenderRequests": report.nonzero_requests(),
        "matchingHeaders": report.matching_headers(),
        "mismatchedHeaders": report.mismatched_headers(),
        "missingHeaders": report.missing_headers(),
    })
}

#[derive(Debug)]
struct CoreDiscoveryGates {
    keepalive: bool,
    link_init: bool,
    mixer_status: bool,
}

impl CoreDiscoveryGates {
    fn from_shapes(shapes: &BTreeMap<PacketShape, usize>) -> Self {
        Self {
            keepalive: has_shape(shapes, 50000, 0x06, 54),
            link_init: has_shape(shapes, 50002, 0x16, 48),
            mixer_status: has_shape(shapes, 50002, 0x29, 56),
        }
    }

    fn complete(&self) -> bool {
        self.keepalive && self.link_init && self.mixer_status
    }
}

fn read_djlink_pcap(path: &Path) -> Result<Vec<CapturedDjLinkPacket>> {
    if !path.is_file() {
        bail!("pcap '{}' does not exist or is not a file", path.display());
    }
    let output = std::process::Command::new("tshark")
        .arg("-r")
        .arg(path)
        .args([
            "-Y",
            "udp.port == 50000 || udp.port == 50001 || udp.port == 50002",
            "-T",
            "fields",
            "-E",
            "occurrence=f",
            "-e",
            "frame.number",
            "-e",
            "ip.src",
            "-e",
            "udp.srcport",
            "-e",
            "ip.dst",
            "-e",
            "udp.dstport",
            "-e",
            "data.data",
        ])
        .output()
        .with_context(|| {
            "failed to execute tshark; install Wireshark CLI tools to audit pcaps".to_string()
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        bail!(
            "tshark failed for '{}' with status {}: {}",
            path.display(),
            output.status,
            stderr
        );
    }

    let stdout = String::from_utf8(output.stdout).context("tshark output was not UTF-8")?;
    let mut packets = Vec::new();
    for line in stdout.lines() {
        let fields = line.split('\t').collect::<Vec<_>>();
        if fields.len() < 6 || fields[5].is_empty() {
            continue;
        }
        let payload = match decode_strict_hex(fields[5]) {
            Ok(payload) => payload,
            Err(_) => continue,
        };
        if payload.len() < 12 || !payload.starts_with(b"Qspt1WmJOL") {
            continue;
        }
        let source_port = fields[2].parse::<u16>().unwrap_or_default();
        let destination_port = fields[4].parse::<u16>().unwrap_or_default();
        let service_port = if is_djlink_port(destination_port) {
            destination_port
        } else if is_djlink_port(source_port) {
            source_port
        } else {
            continue;
        };
        let (packet_type, model) = if service_port == 50000 {
            if payload.len() < 32 {
                continue;
            }
            (
                u16::from_le_bytes([payload[0x0a], payload[0x0b]]),
                nul_ascii(&payload[0x0c..0x20]),
            )
        } else {
            if payload.len() < 31 {
                continue;
            }
            (payload[0x0a] as u16, nul_ascii(&payload[0x0b..0x1f]))
        };
        packets.push(CapturedDjLinkPacket {
            frame: fields[0].parse::<u64>().unwrap_or_default(),
            source_ip: fields[1].to_string(),
            source_port,
            destination_ip: fields[3].to_string(),
            destination_port,
            service_port,
            packet_type,
            model,
            payload,
        });
    }
    Ok(packets)
}

fn read_remote_db_pcap(path: &Path) -> Result<RemoteDbPcapAudit> {
    if !path.is_file() {
        bail!("pcap '{}' does not exist or is not a file", path.display());
    }
    let output = std::process::Command::new("tshark")
        .arg("-r")
        .arg(path)
        .args([
            "-Y",
            "tcp.len > 0 && ip",
            "-T",
            "fields",
            "-E",
            "occurrence=f",
            "-e",
            "frame.number",
            "-e",
            "tcp.stream",
            "-e",
            "ip.src",
            "-e",
            "tcp.srcport",
            "-e",
            "ip.dst",
            "-e",
            "tcp.dstport",
            "-e",
            "tcp.seq",
            "-e",
            "tcp.payload",
        ])
        .output()
        .with_context(|| {
            "failed to execute tshark; install Wireshark CLI tools to audit pcaps".to_string()
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        bail!(
            "tshark failed for '{}' with status {}: {}",
            path.display(),
            output.status,
            stderr
        );
    }

    let stdout = String::from_utf8(output.stdout).context("tshark output was not UTF-8")?;
    let mut segments_by_stream =
        BTreeMap::<u32, BTreeMap<TcpDirection, Vec<CapturedTcpSegment>>>::new();
    for line in stdout.lines() {
        let fields = line.split('\t').collect::<Vec<_>>();
        if fields.len() < 8 || fields[7].is_empty() {
            continue;
        }
        let Some(stream) = fields[1].parse::<u32>().ok() else {
            continue;
        };
        let source_port = fields[3].parse::<u16>().unwrap_or_default();
        let destination_port = fields[5].parse::<u16>().unwrap_or_default();
        let direction = TcpDirection {
            source_ip: fields[2].to_string(),
            source_port,
            destination_ip: fields[4].to_string(),
            destination_port,
        };
        let segment = CapturedTcpSegment {
            frame: fields[0].parse::<u64>().unwrap_or_default(),
            sequence: fields[6].parse::<u64>().unwrap_or_default(),
            payload: match decode_tshark_hex(fields[7]) {
                Ok(payload) => payload,
                Err(_) => continue,
            },
        };
        segments_by_stream
            .entry(stream)
            .or_default()
            .entry(direction)
            .or_default()
            .push(segment);
    }

    let mut report = RemoteDbPcapAudit::default();
    for (stream, directions) in segments_by_stream {
        let directions = directions
            .into_iter()
            .map(|(direction, segments)| reassemble_tcp_direction(direction, segments))
            .collect::<Vec<_>>();
        let mut best: Option<CapturedRemoteDbAudit> = None;
        for request in &directions {
            for response in &directions {
                if !request.direction.reverse_of(&response.direction) {
                    continue;
                }
                let audit = audit_remote_db_cursors(&request.bytes, &response.bytes);
                if audit.exchanges.is_empty() {
                    continue;
                }
                let candidate = CapturedRemoteDbAudit {
                    stream,
                    request_direction: request.direction.clone(),
                    request_gaps: request.gaps,
                    response_gaps: response.gaps,
                    audit,
                };
                if best.as_ref().is_none_or(|current| {
                    candidate.audit.exchanges.len() > current.audit.exchanges.len()
                }) {
                    best = Some(candidate);
                }
            }
        }
        if let Some(stream) = best {
            report.streams.push(stream);
        }
    }
    Ok(report)
}

fn reassemble_tcp_direction(
    direction: TcpDirection,
    mut segments: Vec<CapturedTcpSegment>,
) -> ReassembledTcpDirection {
    segments.sort_by_key(|segment| (segment.sequence, segment.frame));
    let mut bytes = Vec::new();
    let mut next_sequence = None::<u64>;
    let mut gaps = 0usize;
    for segment in segments {
        if segment.payload.is_empty() {
            continue;
        }
        match next_sequence {
            None => bytes.extend_from_slice(&segment.payload),
            Some(next) if segment.sequence > next => {
                // A delimiter prevents a partial message on either side of a capture gap joining.
                bytes.extend_from_slice(&[0; 5]);
                bytes.extend_from_slice(&segment.payload);
                gaps += 1;
            }
            Some(next) => {
                let overlap = next.saturating_sub(segment.sequence) as usize;
                if let Some(tail) = segment.payload.get(overlap..) {
                    bytes.extend_from_slice(tail);
                }
            }
        }
        let segment_end = segment
            .sequence
            .saturating_add(segment.payload.len() as u64);
        next_sequence = Some(next_sequence.unwrap_or_default().max(segment_end));
    }
    ReassembledTcpDirection {
        direction,
        bytes,
        gaps,
    }
}

fn count_shapes<'a>(
    packets: impl IntoIterator<Item = &'a CapturedDjLinkPacket>,
) -> BTreeMap<PacketShape, usize> {
    let mut shapes = BTreeMap::new();
    for packet in packets {
        let shape = PacketShape {
            service_port: packet.service_port,
            packet_type: format!("0x{:02x}", packet.packet_type),
            bytes: packet.payload.len(),
        };
        *shapes.entry(shape).or_insert(0) += 1;
    }
    shapes
}

fn shapes_to_json(shapes: &BTreeMap<PacketShape, usize>) -> Vec<Value> {
    shapes
        .iter()
        .map(|(shape, count)| {
            json!({
                "servicePort": shape.service_port,
                "packetType": shape.packet_type,
                "bytes": shape.bytes,
                "count": count,
            })
        })
        .collect()
}

fn has_shape(
    shapes: &BTreeMap<PacketShape, usize>,
    service_port: u16,
    packet_type: u16,
    bytes: usize,
) -> bool {
    shapes.contains_key(&PacketShape {
        service_port,
        packet_type: format!("0x{packet_type:02x}"),
        bytes,
    })
}

fn has_shared_static_payload(
    candidate: &[&CapturedDjLinkPacket],
    reference: &[&CapturedDjLinkPacket],
    service_port: u16,
    packet_type: u16,
) -> bool {
    candidate.iter().any(|candidate| {
        candidate.service_port == service_port
            && candidate.packet_type == packet_type
            && reference.iter().any(|reference| {
                reference.service_port == service_port
                    && reference.packet_type == packet_type
                    && reference.payload == candidate.payload
            })
    })
}

fn decode_strict_hex(input: &str) -> Result<Vec<u8>> {
    let input = input.trim();
    if !input.len().is_multiple_of(2) {
        bail!("odd-length hex payload");
    }
    input
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).context("non-ASCII hex payload")?;
            u8::from_str_radix(text, 16).context("invalid hex payload")
        })
        .collect()
}

fn decode_tshark_hex(input: &str) -> Result<Vec<u8>> {
    decode_strict_hex(&input.replace([':', ' '], ""))
}

fn nul_ascii(raw: &[u8]) -> String {
    raw.iter()
        .copied()
        .take_while(|byte| *byte != 0)
        .filter(u8::is_ascii)
        .map(char::from)
        .collect()
}

fn is_djlink_port(port: u16) -> bool {
    matches!(port, 50000..=50002)
}

async fn doctor(args: DoctorArgs) -> Result<()> {
    let (library, rekordbox) = load_library(&args.library).await?;
    let report = library.validate_for_serving(args.require_analysis).await;
    let ok = report.is_ok(args.require_analysis);
    println!(
        "{}",
        serde_json::to_string(&json!({
            "ok": ok,
            "snapshot": args.library.snapshot,
            "rekordboxDatabase": args.library.rekordbox_db,
            "tracks": report.track_count,
            "playlists": report.playlist_count,
            "analysis": {
                "dat": report.analyzed_dat_count,
                "ext": report.analyzed_ext_count,
                "twoEx": report.analyzed_twoex_count,
            },
            "missingAudioCount": report.missing_audio.len(),
            "missingAudio": report.missing_audio.iter().take(25).collect::<Vec<_>>(),
            "missingAnalysisCount": report.missing_analysis.len(),
            "missingAnalysis": report.missing_analysis.iter().take(25).collect::<Vec<_>>(),
            "rekordbox": rekordbox.as_ref().map(rekordbox_report_json),
        }))?
    );
    if !ok {
        bail!("DJ Link library validation failed");
    }
    Ok(())
}

async fn serve(args: ServeArgs) -> Result<()> {
    if tokio::fs::try_exists(&args.socket).await.unwrap_or(false) {
        bail!(
            "control socket '{}' already exists; stop the existing runtime or remove a confirmed stale socket",
            args.socket.display()
        );
    }
    if let Some(parent) = args.socket.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("failed to create '{}'", parent.display()))?;
    }

    let (library, rekordbox) = load_library(&args.library).await?;
    let report = library.validate_for_serving(args.require_analysis).await;
    if !report.is_ok(args.require_analysis) {
        bail!(
            "DJ Link library is not serveable: missing_audio={} missing_analysis={}",
            report.missing_audio.len(),
            report.missing_analysis.len()
        );
    }

    let config = DjLinkConfig {
        source_name: args.name,
        model_name: args.model,
        player_number: args.player_number,
        bind_ip: args.bind_ip,
        broadcast_ip: args.broadcast_ip,
        db_server_port: args.db_port,
        mount_port: Some(DEFAULT_MOUNT_PORT),
        announce_interval: Duration::from_millis(500),
        log_level: LogLevel::parse(&args.log_level)
            .with_context(|| format!("invalid log level '{}'", args.log_level))?,
        log_path: args.log_path,
        wire_capture_path: args.wire_pcap.clone(),
        serve_extended_anlz_tags: true,
        emit_beat_clock: false,
        stagehand_monitor: args.stagehand_monitor,
        stagehand_target_ip: args.stagehand_target_ip,
        stagehand_target_mac: args.stagehand_target_mac,
        tcp_track_file_side_channel: false,
        db_auto_load: false,
        auto_load_confirm: false,
        auto_unlock_load_lock: false,
        load_rekordbox_command_variant: false,
        load_payload_byte_overrides: Vec::new(),
    };
    let mut server = DjLinkServer::new(config, library).await?;
    let mut telemetry_events = server.subscribe_telemetry();
    let mut mixer_telemetry_events = server.subscribe_mixer_telemetry();
    server.start().await?;
    let listener = UnixListener::bind(&args.socket)
        .with_context(|| format!("failed to bind control socket '{}'", args.socket.display()))?;
    set_socket_permissions(&args.socket).await?;

    let server = Arc::new(server);
    let runtime = Arc::new(RuntimeInfo {
        started: Instant::now(),
        bind_ip: server.bind_ip(),
        broadcast_ip: server.broadcast_ip(),
        player_number: server.player_number(),
        tracks: server.library_track_count(),
        playlists: server.library_playlist_count(),
    });
    let (mut midi_connection, mut midi_events, mut device_name, mixer_connected) =
        match connect_midi(&args.midi_device) {
            Ok((connection, receiver, device_name)) => {
                (Some(connection), Some(receiver), device_name, true)
            }
            Err(error) => {
                tracing::warn!(%error, "state_api_midi_unavailable");
                (None, None, args.midi_device.clone(), false)
            }
        };
    let audio_meter_routing = if args.audio_device.to_ascii_lowercase().contains("djm-a9") {
        match configure_meter_routes() {
            Ok(routing) => {
                tracing::info!(
                    master_pair = routing.master_pair,
                    channel_pairs = ?routing.channel_pairs,
                    "a9_meter_routes_configured"
                );
                Some(routing)
            }
            Err(error) => {
                tracing::warn!(%error, "a9_meter_routes_unavailable");
                None
            }
        }
    } else {
        None
    };
    let (mut audio_meter_connection, mut audio_meter_events, mut audio_meter_device) =
        match connect_audio_meter(&args.audio_device) {
            Ok((connection, receiver, name)) => (Some(connection), Some(receiver), Some(name)),
            Err(error) => {
                tracing::warn!(%error, "state_api_audio_meter_unavailable");
                (None, None, None)
            }
        };
    let state_api = StateApiServer::start(StateApiConfig {
        bind: args.api_bind,
        mixer_device: device_name.clone(),
        mixer_connected,
        audio_meter_device: audio_meter_device.clone(),
        audio_meter_connected: audio_meter_connection.is_some(),
        djlink: server.clone(),
    })
    .await?;
    state_api.publisher().refresh_decks(&server).await?;
    println!(
        "{}",
        serde_json::to_string(&json!({
            "event": "ready",
            "pid": std::process::id(),
            "socket": args.socket,
            "bindIp": runtime.bind_ip,
            "broadcastIp": runtime.broadcast_ip,
            "playerNumber": runtime.player_number,
            "tracks": runtime.tracks,
            "playlists": runtime.playlists,
            "wirePcap": args.wire_pcap,
            "stateApi": format!("http://{}", state_api.address),
            "audioMeterDevice": audio_meter_device,
            "audioMeterRouting": audio_meter_routing.as_ref().map(|routing| json!({
                "master": routing.master_pair,
                "channels": routing.channel_pairs,
            })),
            "source": {
                "snapshot": args.library.snapshot,
                "rekordboxDatabase": args.library.rekordbox_db,
            },
            "rekordbox": rekordbox.as_ref().map(rekordbox_report_json),
        }))?
    );

    let (stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
    let mut control_tasks = JoinSet::new();
    let mut decoder = Decoder::default();
    let mut reconnect = tokio::time::interval(DEVICE_RECONNECT_INTERVAL);
    reconnect.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    reconnect.tick().await;
    loop {
        tokio::select! {
            biased;
            stopped = stop_rx.recv() => {
                if stopped.is_some() {
                    break;
                }
            }
            accepted = listener.accept() => {
                let (stream, _) = accepted.context("failed to accept control request")?;
                let server = server.clone();
                let runtime = runtime.clone();
                let stop_tx = stop_tx.clone();
                control_tasks.spawn(async move {
                    match handle_control(stream, &server, &runtime).await {
                        Ok(true) => {
                            let _ = stop_tx.send(()).await;
                        }
                        Ok(false) => {}
                        Err(error) => tracing::warn!(%error, "control_request_failed"),
                    }
                });
            }
            completed = control_tasks.join_next(), if !control_tasks.is_empty() => {
                if let Some(Err(error)) = completed {
                    tracing::warn!(%error, "control_task_failed");
                }
            }
            raw = async {
                match midi_events.as_mut() {
                    Some(events) => events.recv().await,
                    None => std::future::pending().await,
                }
            }, if midi_events.is_some() => {
                let Some(raw) = raw else {
                    tracing::warn!("state_api_midi_disconnected");
                    state_api.publisher().set_mixer_connected(false).await?;
                    midi_events = None;
                    midi_connection = None;
                    decoder = Decoder::default();
                    continue;
                };
                for event in decoder.decode_packet(&raw, false) {
                    state_api.publisher().publish_mixer_event(&event).await?;
                }
            }
            meter_event = async {
                match audio_meter_events.as_mut() {
                    Some(events) => events.recv().await,
                    None => std::future::pending().await,
                }
            }, if audio_meter_events.is_some() => {
                let Some(meter_event) = meter_event else {
                    tracing::warn!("state_api_audio_meter_disconnected");
                    audio_meter_events = None;
                    audio_meter_connection = None;
                    state_api.publisher().set_audio_meter_connection(audio_meter_device.clone(), false).await?;
                    continue;
                };
                match meter_event {
                    MeterEvent::Frame(frame) => {
                        state_api.publisher().publish_meter_frame(&frame).await?;
                    }
                    MeterEvent::Disconnected { device, error } => {
                        tracing::warn!(%device, %error, "state_api_audio_meter_disconnected");
                        audio_meter_events = None;
                        audio_meter_connection = None;
                        state_api.publisher().set_audio_meter_connection(Some(device), false).await?;
                    }
                }
            }
            _ = reconnect.tick() => {
                if midi_connection.is_some() {
                    match midi_input_present(&device_name) {
                        Ok(true) => {}
                        Ok(false) => {
                            tracing::warn!(device = %device_name, "state_api_midi_device_removed");
                            midi_events = None;
                            midi_connection = None;
                            decoder = Decoder::default();
                            state_api.publisher().set_mixer_connected(false).await?;
                        }
                        Err(error) => tracing::debug!(%error, "state_api_midi_probe_failed"),
                    }
                }
                if midi_connection.is_none() {
                    match connect_midi(&args.midi_device) {
                        Ok((connection, receiver, name)) => {
                            tracing::info!(device = %name, "state_api_midi_reconnected");
                            device_name = name.clone();
                            midi_connection = Some(connection);
                            midi_events = Some(receiver);
                            decoder = Decoder::default();
                            state_api.publisher().set_mixer_connection(Some(name), true).await?;
                        }
                        Err(error) => tracing::debug!(%error, "state_api_midi_reconnect_pending"),
                    }
                }

                if audio_meter_connection.is_some() {
                    let present = match audio_meter_device.as_deref() {
                        Some(device) => audio_input_present(device),
                        None => Ok(false),
                    };
                    match present {
                        Ok(true) => {}
                        Ok(false) => {
                            tracing::warn!(device = ?audio_meter_device, "state_api_audio_meter_device_removed");
                            audio_meter_events = None;
                            audio_meter_connection = None;
                            state_api.publisher().set_audio_meter_connection(audio_meter_device.clone(), false).await?;
                        }
                        Err(error) => tracing::debug!(%error, "state_api_audio_meter_probe_failed"),
                    }
                }
                if audio_meter_connection.is_none() {
                    if args.audio_device.to_ascii_lowercase().contains("djm-a9") {
                        match configure_meter_routes() {
                            Ok(routing) => tracing::debug!(
                                master_pair = routing.master_pair,
                                channel_pairs = ?routing.channel_pairs,
                                "a9_meter_routes_reconfigured"
                            ),
                            Err(error) => tracing::debug!(%error, "a9_meter_routes_reconnect_pending"),
                        }
                    }
                    match connect_audio_meter(&args.audio_device) {
                        Ok((connection, receiver, name)) => {
                            tracing::info!(device = %name, "state_api_audio_meter_reconnected");
                            audio_meter_device = Some(name.clone());
                            audio_meter_connection = Some(connection);
                            audio_meter_events = Some(receiver);
                            state_api.publisher().set_audio_meter_connection(Some(name), true).await?;
                        }
                        Err(error) => tracing::debug!(%error, "state_api_audio_meter_reconnect_pending"),
                    }
                }
            }
            telemetry = telemetry_events.recv() => {
                match telemetry {
                    Ok(event) => state_api.publisher().publish_djlink_event(&server, event).await?,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(skipped, "state_api_djlink_events_lagged");
                        state_api.publisher().refresh_decks(&server).await?;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        bail!("DJ Link telemetry stream closed");
                    }
                }
            }
            telemetry = mixer_telemetry_events.recv() => {
                match telemetry {
                    Ok(event) => state_api.publisher().publish_djlink_mixer_event(event).await?,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(skipped, "state_api_djlink_mixer_events_lagged");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        bail!("DJ Link mixer telemetry stream closed");
                    }
                }
            }
            signal = tokio::signal::ctrl_c() => {
                signal.context("failed to listen for Ctrl-C")?;
                break;
            }
        }
    }

    control_tasks.abort_all();
    while control_tasks.join_next().await.is_some() {}
    drop(stop_tx);
    drop(stop_rx);
    drop(runtime);
    state_api.stop().await;
    drop(midi_connection);
    drop(audio_meter_connection);
    let Ok(mut server) = Arc::try_unwrap(server) else {
        bail!("DJ Link control tasks retained the server during shutdown");
    };
    server.stop();
    drop(listener);
    if tokio::fs::try_exists(&args.socket).await.unwrap_or(false) {
        tokio::fs::remove_file(&args.socket)
            .await
            .with_context(|| format!("failed to remove '{}'", args.socket.display()))?;
    }
    Ok(())
}

async fn handle_control(
    stream: UnixStream,
    server: &DjLinkServer,
    runtime: &RuntimeInfo,
) -> Result<bool> {
    let (reader, mut writer) = stream.into_split();
    let mut line = String::new();
    BufReader::new(reader)
        .read_line(&mut line)
        .await
        .context("failed to read control request")?;
    let request = serde_json::from_str::<ControlRequest>(&line)
        .context("failed to decode control request")?;
    let stop = request.method == "stop";
    let response = match dispatch_control(&request, server, runtime).await {
        Ok(result) => ControlResponse {
            id: request.id,
            ok: true,
            result: Some(result),
            error: None,
        },
        Err(error) => ControlResponse {
            id: request.id,
            ok: false,
            result: None,
            error: Some(format!("{error:#}")),
        },
    };
    writer
        .write_all(format!("{}\n", serde_json::to_string(&response)?).as_bytes())
        .await
        .context("failed to write control response")?;
    writer.shutdown().await?;
    Ok(stop && response.ok)
}

async fn dispatch_control(
    request: &ControlRequest,
    server: &DjLinkServer,
    runtime: &RuntimeInfo,
) -> Result<Value> {
    match request.method.as_str() {
        "status" => Ok(json!({
            "pid": std::process::id(),
            "bindIp": runtime.bind_ip,
            "broadcastIp": runtime.broadcast_ip,
            "playerNumber": runtime.player_number,
            "tracks": runtime.tracks,
            "playlists": runtime.playlists,
            "uptimeMs": runtime.started.elapsed().as_millis(),
            "remoteTransportSupported": false,
            "remoteDeckPreparationSupported": true,
        })),
        "devices" => {
            let devices = server
                .list_devices()
                .await
                .into_iter()
                .map(|device| {
                    json!({
                        "playerNumber": device.player_number,
                        "ip": device.ip_addr,
                        "mac": device.mac_addr,
                        "model": device.model,
                        "lastSeenMsAgo": device.last_seen.elapsed().as_millis(),
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({ "devices": devices }))
        }
        "probeArp" => {
            let params = serde_json::from_value::<ArpProbeParams>(request.params.clone())
                .context("invalid ARP probe params")?;
            let timeout_ms = params.timeout_ms.clamp(50, 3_000);
            let mac = server
                .probe_arp_device(params.ip, Duration::from_millis(timeout_ms))
                .await?;
            Ok(json!({
                "ip": params.ip,
                "present": mac.is_some(),
                "mac": mac,
                "timeoutMs": timeout_ms,
            }))
        }
        "monitor" => {
            let params = serde_json::from_value::<PlayerParams>(request.params.clone())
                .context("invalid monitor params")?;
            let snapshot = server.monitor_snapshot(params.player).await;
            Ok(json!({
                "player": params.player,
                "status": snapshot.status,
                "beat": snapshot.beat,
                "position": snapshot.position,
            }))
        }
        "resolveTrack" => {
            let params = serde_json::from_value::<ResolveTrackParams>(request.params.clone())
                .context("invalid resolveTrack params")?;
            let (order, track) = server.resolve_library_track(&params.selector)?;
            Ok(json!({
                "order": order,
                "trackId": track.track_id,
                "title": track.title,
                "artist": track.artist,
                "canonicalName": track.canonical_name,
            }))
        }
        "search" => {
            let params = serde_json::from_value::<SearchParams>(request.params.clone())
                .context("invalid search params")?;
            if params.query.trim().is_empty() {
                bail!("search query must not be empty");
            }
            let mode = match params.mode.as_str() {
                "track" => DjLinkSearchMode::Track,
                "artist" => DjLinkSearchMode::Artist,
                "album" => DjLinkSearchMode::Album,
                mode => bail!("unknown search mode '{mode}'; expected track, artist, or album"),
            };
            let limit = params.limit.clamp(1, 100);
            let profile = server.profile_search(&params.query, mode);
            let items = profile
                .items
                .iter()
                .take(limit)
                .map(|item| {
                    json!({
                        "entryId": item.entry_id,
                        "entryType": item.entry_type,
                        "label": item.label,
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({
                "query": profile.query,
                "mode": profile.mode.label(),
                "normalizedQuery": profile.normalized_query,
                "resultCount": profile.result_count,
                "elapsedUs": profile.elapsed_us,
                "items": items,
                "truncated": profile.result_count > limit,
            }))
        }
        "load" => {
            let params = serde_json::from_value::<LoadParams>(request.params.clone())
                .context("invalid load params")?;
            let sent = server
                .send_load_track(
                    params.player,
                    params.track_id,
                    None,
                    SLOT_REKORDBOX,
                    TRACK_TYPE_REKORDBOX,
                    params.repeat.max(1),
                    Duration::from_millis(params.interval_ms.max(10)),
                )
                .await?;
            Ok(json!({
                "player": params.player,
                "trackId": params.track_id,
                "packetsSent": sent,
                "loaded": true,
                "playing": false,
                "transportNote": "CDJ-3000 remote play/pause is not a confirmed DJ Link command; press PLAY on the deck.",
            }))
        }
        "prepare" => {
            let params = serde_json::from_value::<PrepareParams>(request.params.clone())
                .context("invalid prepare params")?;
            let cue = server
                .phrase_cue_before_chorus(params.track_id, params.bars_before)
                .await?;
            server.set_memory_cue_override(params.track_id, cue.cue_ms)?;
            let sent = server
                .send_prepared_track(
                    params.player,
                    params.track_id,
                    params.repeat.max(1),
                    Duration::from_millis(params.interval_ms.max(10)),
                )
                .await?;
            let tempo_confirmed = server
                .set_player_bpm(params.player, params.bpm_hundreds)
                .await?;
            Ok(json!({
                "player": params.player,
                "trackId": params.track_id,
                "packetsSent": sent,
                "loaded": true,
                "playing": false,
                "cue": {
                    "kind": "before-chorus",
                    "phraseBeat": cue.phrase_beat,
                    "cueBeat": cue.cue_beat,
                    "cueMs": cue.cue_ms,
                    "barsBefore": cue.bars_before,
                },
                "tempoBpm": f64::from(params.bpm_hundreds) / 100.0,
                "tempoSyncRequested": true,
                "tempoConfirmed": tempo_confirmed,
                "transportNote": "Track loaded at a generated memory cue with deck Sync enabled; PLAY remains physical.",
            }))
        }
        "stop" => Ok(json!({ "stopping": true })),
        method => bail!("unknown control method '{method}'"),
    }
}

fn default_search_mode() -> String {
    "track".to_string()
}

fn default_search_limit() -> usize {
    20
}

async fn load_snapshot(path: &Path) -> Result<LibrarySnapshot> {
    let bytes = tokio::fs::read(path)
        .await
        .with_context(|| format!("failed to read snapshot '{}'", path.display()))?;
    let document = serde_json::from_slice::<SnapshotDocument>(&bytes)
        .with_context(|| format!("failed to decode snapshot '{}'", path.display()))?;
    if document.schema_version != 1 {
        bail!(
            "unsupported DJ Link snapshot schema {}; expected 1",
            document.schema_version
        );
    }
    if document.tracks.is_empty() {
        bail!("DJ Link snapshot contains no playable tracks");
    }

    let mut tracks_by_id = BTreeMap::new();
    let mut all_tracks = Vec::with_capacity(document.tracks.len());
    for track in document.tracks {
        if tracks_by_id.contains_key(&track.track_id) {
            bail!("duplicate DJ Link track id {}", track.track_id);
        }
        let record = TrackRecord {
            track_id: track.track_id,
            title: track.title,
            artist: track.artist,
            artist_id: track.artist_id,
            canonical_name: track.canonical_name,
            album: track.album,
            album_id: track.album_id,
            duration_sec: track.duration_sec,
            bpm_hundreds: track.bpm_hundreds,
            key: track.key,
            camelot: track.camelot,
            key_id: track.key_id,
            bitrate_kbps: track.bitrate_kbps,
            comment: track.comment,
            mount_path: track.mount_path,
            analysis_dat_path: track.analysis_dat_path,
            analysis_ext_path: track.analysis_ext_path,
            analysis_twoex_path: track.analysis_twoex_path,
            artwork_id: track.artwork_id,
            artwork_url: track.artwork_url,
            genre: track.genre,
            genre_id: track.genre_id,
            label: track.label,
            year: track.year,
            date_added_id: track.date_added_id,
            date_added: track.date_added,
        };
        tracks_by_id.insert(record.track_id, record.clone());
        all_tracks.push(record);
    }

    let playlists = document
        .playlists
        .into_iter()
        .map(|playlist| PlaylistRecord {
            playlist_id: playlist.playlist_id,
            name: playlist.name,
            parent_id: playlist.parent_id,
            is_folder: playlist.is_folder,
            sequence: playlist.sequence,
            tracks: playlist.tracks,
        })
        .collect();
    Ok(LibrarySnapshot {
        master_db_id: document.master_db_id,
        tracks_by_id,
        all_tracks,
        playlists,
    })
}

async fn load_library(
    args: &LibraryArgs,
) -> Result<(LibrarySnapshot, Option<RekordboxLibraryLoadReport>)> {
    if let Some(path) = args.snapshot.as_deref() {
        return Ok((load_snapshot(path).await?, None));
    }
    let Some(path) = args.rekordbox_db.clone() else {
        bail!("either --rekordbox-db or --snapshot is required");
    };
    let loaded = tokio::task::spawn_blocking(move || {
        LibrarySnapshot::from_rekordbox_master_db(&path, false)
    })
    .await
    .context("Rekordbox database prewarm task failed")??;
    Ok((loaded.library, Some(loaded.report)))
}

fn rekordbox_report_json(report: &RekordboxLibraryLoadReport) -> Value {
    json!({
        "databasePath": report.database_path,
        "databaseTracks": report.database_content_count,
        "servedTracks": report.served_track_count,
        "playlists": report.playlist_count,
        "folders": report.folder_count,
        "omittedMissingAudio": {
            "count": report.omitted_missing_audio_count,
            "sample": report.omitted_missing_audio_sample,
        },
        "omittedInvalidTrackIds": report.omitted_invalid_track_id_count,
    })
}

async fn set_socket_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let permissions = std::fs::Permissions::from_mode(0o600);
    tokio::fs::set_permissions(path, permissions)
        .await
        .with_context(|| format!("failed to protect control socket '{}'", path.display()))
}

fn default_load_repeat() -> usize {
    3
}

fn default_load_interval_ms() -> u64 {
    250
}

fn default_bars_before() -> u16 {
    1
}

fn default_arp_probe_timeout_ms() -> u64 {
    750
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reassembles_out_of_order_tcp_and_drops_retransmitted_overlap() {
        let direction = TcpDirection {
            source_ip: "169.254.7.4".to_string(),
            source_port: 40000,
            destination_ip: "169.254.247.163".to_string(),
            destination_port: 1051,
        };
        let reassembled = reassemble_tcp_direction(
            direction,
            vec![
                CapturedTcpSegment {
                    frame: 3,
                    sequence: 4,
                    payload: b"def".to_vec(),
                },
                CapturedTcpSegment {
                    frame: 1,
                    sequence: 1,
                    payload: b"abc".to_vec(),
                },
                CapturedTcpSegment {
                    frame: 2,
                    sequence: 2,
                    payload: b"bcde".to_vec(),
                },
            ],
        );

        assert_eq!(reassembled.bytes, b"abcdef");
        assert_eq!(reassembled.gaps, 0);
    }

    #[test]
    fn inserts_non_magic_delimiter_across_capture_gap() {
        let direction = TcpDirection {
            source_ip: "a".to_string(),
            source_port: 1,
            destination_ip: "b".to_string(),
            destination_port: 2,
        };
        let reassembled = reassemble_tcp_direction(
            direction,
            vec![
                CapturedTcpSegment {
                    frame: 1,
                    sequence: 1,
                    payload: b"abc".to_vec(),
                },
                CapturedTcpSegment {
                    frame: 2,
                    sequence: 9,
                    payload: b"xyz".to_vec(),
                },
            ],
        );

        assert_eq!(reassembled.bytes, b"abc\0\0\0\0\0xyz");
        assert_eq!(reassembled.gaps, 1);
    }

    #[test]
    fn decodes_tshark_colon_hex() {
        assert_eq!(
            decode_tshark_hex("11:87:23:49:ae").expect("hex"),
            [0x11, 0x87, 0x23, 0x49, 0xae]
        );
    }
}
