#![allow(dead_code)]

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::Ipv4Addr;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use tokio::sync::{broadcast, mpsc, oneshot};

use crate::djlink::{
    CdjBeatSnapshot, CdjPositionSnapshot, CdjStatusSnapshot, DjLinkMonitorSnapshot,
    DjLinkTelemetryEvent, DjLinkTelemetryKind, LinkDevice,
};
use crate::load::{
    BrowseContextSnapshot, LoadConfirmContext, LoadConfirmSession, LoadProgressSnapshot,
    context_is_visual_load_data, context_suppresses_load_confirm,
};
use crate::nfs::NfsState;
use crate::playhead::{BeatPlayhead, TrackTiming};

pub(crate) const SERVER_ACTOR_QUEUE_CAPACITY: usize = 256;
const BROWSE_CONTEXT_HISTORY_MAX: usize = 16;
const RECENT_BROWSE_CONTEXT_FOR: Duration = Duration::from_secs(300);
const RECENT_OLD_AUDIO_READ_FOR_SWITCH: Duration = Duration::from_millis(450);
pub(crate) const DEVICE_MAX_AGE: Duration = Duration::from_secs(10);
const DEVICE_RELINK_GAP: Duration = Duration::from_secs(5);

pub(crate) type ServerActorSender = mpsc::Sender<ServerMsg>;

pub(crate) enum ServerMsg {
    RecordDevice {
        device: LinkDevice,
        reply: oneshot::Sender<bool>,
    },
    DeviceCount {
        reply: oneshot::Sender<u8>,
    },
    Devices {
        reply: oneshot::Sender<Vec<LinkDevice>>,
    },
    DeviceForIp {
        ip: Ipv4Addr,
        reply: oneshot::Sender<Option<LinkDevice>>,
    },
    UnlinkedTargets {
        reply: oneshot::Sender<(Vec<Ipv4Addr>, bool)>,
    },
    MarkLinked {
        ip: Ipv4Addr,
    },
    ShouldSendLinkInit {
        ip: Ipv4Addr,
        reply: oneshot::Sender<bool>,
    },
    ShouldRetryLinkInitBroadcast {
        min_interval: Duration,
        reply: oneshot::Sender<bool>,
    },
    MarkLinkInitBroadcast,
    NextDbQueryResponse {
        ip: Ipv4Addr,
        db_server_port: u16,
        reply: oneshot::Sender<(u32, u16)>,
    },
    ShouldSendDbAutoLoad {
        target_ip: Ipv4Addr,
        track_id: u32,
        request_type: u16,
        throttle: Duration,
        now: Instant,
        reply: oneshot::Sender<bool>,
    },
    RecordLoadAck {
        ip: Ipv4Addr,
        now: Instant,
        log_throttle: Duration,
        reply: oneshot::Sender<bool>,
    },
    LoadAckHappenedAfter {
        ip: Ipv4Addr,
        after: Instant,
        reply: oneshot::Sender<bool>,
    },
    WaitLoadAckAfter {
        ip: Ipv4Addr,
        after: Instant,
        reply: oneshot::Sender<bool>,
    },
    RegisterTrackTiming {
        track_id: u32,
        timing: TrackTiming,
    },
    RecordStatus {
        status: CdjStatusSnapshot,
        seen_at: Instant,
        reply: oneshot::Sender<bool>,
    },
    RecordBeat {
        beat: CdjBeatSnapshot,
        seen_at: Instant,
        reply: oneshot::Sender<bool>,
    },
    RecentBeatSeen {
        target_player: u8,
        reply: oneshot::Sender<Option<Instant>>,
    },
    RecordPosition {
        position: CdjPositionSnapshot,
        reply: oneshot::Sender<bool>,
    },
    MonitorSnapshot {
        player: u8,
        reply: oneshot::Sender<DjLinkMonitorSnapshot>,
    },
    StatusSnapshot {
        player: u8,
        reply: oneshot::Sender<Option<CdjStatusSnapshot>>,
    },
    WaitStatusTrack {
        target_player: u8,
        source_player: u8,
        track_id: u32,
        track_type: u8,
        require_playing: bool,
        observed_after: Instant,
        expires_at: Instant,
        reply: oneshot::Sender<bool>,
    },
    RememberBrowseContext {
        target_player: u8,
        context: LoadConfirmContext,
        track_ids: HashSet<u32>,
    },
    RecentBrowseContexts {
        target_player: u8,
        track_id: u32,
        reply: oneshot::Sender<Vec<LoadConfirmContext>>,
    },
    RecordLoadProgress {
        target_player: u8,
        track_id: u32,
        context: &'static str,
        reply: oneshot::Sender<LoadProgressRecordResult>,
    },
    LoadProgressSince {
        target_player: u8,
        track_id: u32,
        since: Instant,
        reply: oneshot::Sender<Option<LoadProgressSnapshot>>,
    },
    RecentPreviousAudioRead {
        target_player: u8,
        track_id: u32,
        now: Instant,
        reply: oneshot::Sender<Option<LoadProgressSnapshot>>,
    },
    BeginLoadConfirm {
        target_player: u8,
        track_id: u32,
        require_playing: bool,
        reply: oneshot::Sender<u64>,
    },
    BeginMountInfoLoadConfirm {
        target_player: u8,
        target_ip: Ipv4Addr,
        track_id: u32,
        require_playing: bool,
        active_for: Duration,
        reply: oneshot::Sender<Option<u64>>,
    },
    CurrentLoadConfirm {
        target_player: u8,
        track_id: u32,
        generation: u64,
        reply: oneshot::Sender<Option<LoadConfirmSession>>,
    },
    ActiveLoadConfirm {
        target_player: u8,
        active_for: Duration,
        reply: oneshot::Sender<Option<LoadConfirmSession>>,
    },
    RefreshLoadConfirmRequirePlaying {
        target_player: u8,
        target_ip: Ipv4Addr,
        track_id: u32,
        generation: u64,
        observed_require_playing: bool,
        status_summary: String,
        reply: oneshot::Sender<Option<bool>>,
    },
    ReserveProgressFollowup {
        target_player: u8,
        track_id: u32,
        generation: Option<u64>,
        reply: oneshot::Sender<Option<LoadConfirmSession>>,
    },
    ClearLoadConfirmIfCurrent {
        target_player: u8,
        track_id: u32,
        generation: u64,
    },
    CachedArtwork {
        artwork_id: u32,
        reply: oneshot::Sender<Option<Option<Vec<u8>>>>,
    },
    StoreArtwork {
        artwork_id: u32,
        bytes: Option<Vec<u8>>,
    },
    CachedWaveformPreview {
        track_id: u32,
        reply: oneshot::Sender<Option<Vec<u8>>>,
    },
    StoreWaveformPreview {
        track_id: u32,
        blob: Vec<u8>,
    },
    LogUnknownPacketOnce {
        key: String,
        reply: oneshot::Sender<bool>,
    },
    NfsHandleForPath {
        path: PathBuf,
        parent_fh: Option<Vec<u8>>,
        reply: oneshot::Sender<Vec<u8>>,
    },
    NfsPathForHandle {
        fh: Vec<u8>,
        reply: oneshot::Sender<Option<PathBuf>>,
    },
    ExtendNfsExports {
        exports: NfsState,
        reply: oneshot::Sender<()>,
    },
    Shutdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LoadProgressRecordResult {
    Recorded,
    Kept { previous_context: &'static str },
}

#[derive(Default)]
pub(crate) struct ServerActor {
    devices: HashMap<Ipv4Addr, LinkDevice>,
    linked_devices: HashSet<Ipv4Addr>,
    last_link_init_broadcast: Option<Instant>,
    db_auto_load_last_sent: HashMap<Ipv4Addr, (u32, u16, Instant)>,
    load_ack_by_ip: HashMap<Ipv4Addr, Instant>,
    load_ack_waiters: Vec<LoadAckWaiter>,
    status_waiters: Vec<StatusWaiter>,
    load_confirm_generation: u64,
    load_confirm_by_player: HashMap<u8, LoadConfirmSession>,
    browse_context_by_player: HashMap<u8, VecDeque<BrowseContextSnapshot>>,
    last_status_by_player: HashMap<u8, CdjStatusSnapshot>,
    last_status_seen_by_player: HashMap<u8, Instant>,
    last_key_status_by_player: HashMap<u8, (CdjStatusSnapshot, Instant)>,
    load_progress_by_player: HashMap<(u8, u32), LoadProgressSnapshot>,
    last_beat_by_player: HashMap<u8, CdjBeatSnapshot>,
    last_beat_seen_by_player: HashMap<u8, Instant>,
    last_position_by_player: HashMap<u8, CdjPositionSnapshot>,
    last_position_seen_by_player: HashMap<u8, Instant>,
    track_timings: HashMap<u32, TrackTiming>,
    beat_playheads: HashMap<u8, BeatPlayhead>,
    db_query_counts: HashMap<Ipv4Addr, u32>,
    artwork_cache: HashMap<u32, Option<Vec<u8>>>,
    waveform_preview_cache: HashMap<u32, Vec<u8>>,
    seen_unknown_packets: HashSet<String>,
    nfs: NfsState,
    telemetry: Option<broadcast::Sender<DjLinkTelemetryEvent>>,
}

struct LoadAckWaiter {
    ip: Ipv4Addr,
    after: Instant,
    reply: oneshot::Sender<bool>,
}

struct StatusWaiter {
    target_player: u8,
    source_player: u8,
    track_id: u32,
    track_type: u8,
    require_playing: bool,
    observed_after: Instant,
    expires_at: Instant,
    reply: oneshot::Sender<bool>,
}

impl ServerActor {
    pub(crate) fn channel() -> (ServerActorSender, mpsc::Receiver<ServerMsg>) {
        mpsc::channel(SERVER_ACTOR_QUEUE_CAPACITY)
    }

    pub(crate) fn with_telemetry(telemetry: broadcast::Sender<DjLinkTelemetryEvent>) -> Self {
        Self {
            telemetry: Some(telemetry),
            ..Self::default()
        }
    }

    pub(crate) fn with_nfs_exports(mut self, paths: &HashSet<PathBuf>) -> Self {
        self.nfs = NfsState::from_exports(paths);
        self
    }

    pub(crate) async fn run(mut self, mut rx: mpsc::Receiver<ServerMsg>) {
        loop {
            let expiry = self.next_device_expiry();
            tokio::select! {
                msg = rx.recv() => {
                    let Some(msg) = msg else { break };
                    if matches!(msg, ServerMsg::Shutdown) {
                        break;
                    }
                    self.handle(msg);
                }
                _ = wait_until(expiry) => {
                    self.expire_devices(Instant::now());
                }
            }
        }
    }

    fn handle(&mut self, msg: ServerMsg) {
        match msg {
            ServerMsg::RecordDevice { device, reply } => {
                let player = device.player_number;
                let changed = self.record_device(device);
                if changed {
                    self.emit_telemetry(DjLinkTelemetryKind::Device, player);
                }
                let _ = reply.send(changed);
            }
            ServerMsg::DeviceCount { reply } => {
                let _ = reply.send(self.device_count());
            }
            ServerMsg::Devices { reply } => {
                let _ = reply.send(self.devices_sorted());
            }
            ServerMsg::DeviceForIp { ip, reply } => {
                let _ = reply.send(self.device_for_ip(ip));
            }
            ServerMsg::UnlinkedTargets { reply } => {
                let _ = reply.send(self.unlinked_targets());
            }
            ServerMsg::MarkLinked { ip } => {
                self.linked_devices.insert(ip);
            }
            ServerMsg::ShouldSendLinkInit { ip, reply } => {
                let _ = reply.send(self.should_send_link_init(ip));
            }
            ServerMsg::ShouldRetryLinkInitBroadcast {
                min_interval,
                reply,
            } => {
                let _ = reply.send(self.should_retry_link_init_broadcast(min_interval));
            }
            ServerMsg::MarkLinkInitBroadcast => {
                self.last_link_init_broadcast = Some(Instant::now());
            }
            ServerMsg::NextDbQueryResponse {
                ip,
                db_server_port,
                reply,
            } => {
                let _ = reply.send(self.next_db_query_response(ip, db_server_port));
            }
            ServerMsg::ShouldSendDbAutoLoad {
                target_ip,
                track_id,
                request_type,
                throttle,
                now,
                reply,
            } => {
                let _ = reply.send(self.should_send_db_auto_load(
                    target_ip,
                    track_id,
                    request_type,
                    throttle,
                    now,
                ));
            }
            ServerMsg::RecordLoadAck {
                ip,
                now,
                log_throttle,
                reply,
            } => {
                let _ = reply.send(self.record_load_ack(ip, now, log_throttle));
            }
            ServerMsg::LoadAckHappenedAfter { ip, after, reply } => {
                let _ = reply.send(self.load_ack_happened_after(ip, after));
            }
            ServerMsg::WaitLoadAckAfter { ip, after, reply } => {
                self.wait_load_ack_after(ip, after, reply);
            }
            ServerMsg::RegisterTrackTiming { track_id, timing } => {
                self.track_timings.insert(track_id, timing);
            }
            ServerMsg::RecordStatus {
                status,
                seen_at,
                reply,
            } => {
                let should_log = self.record_status(status.clone(), seen_at);
                self.notify_status_waiters(&status, seen_at);
                self.emit_telemetry(DjLinkTelemetryKind::Status, status.player());
                let _ = reply.send(should_log);
            }
            ServerMsg::RecordBeat {
                beat,
                seen_at,
                reply,
            } => {
                let player = beat.player();
                let changed = self.record_beat(beat, seen_at);
                self.emit_telemetry(DjLinkTelemetryKind::Beat, player);
                let _ = reply.send(changed);
            }
            ServerMsg::RecentBeatSeen {
                target_player,
                reply,
            } => {
                let _ = reply.send(self.last_beat_seen_by_player.get(&target_player).copied());
            }
            ServerMsg::RecordPosition { position, reply } => {
                let player = position.player();
                let changed = self.record_position(position);
                self.emit_telemetry(DjLinkTelemetryKind::Position, player);
                let _ = reply.send(changed);
            }
            ServerMsg::MonitorSnapshot { player, reply } => {
                let _ = reply.send(self.monitor_snapshot(player));
            }
            ServerMsg::StatusSnapshot { player, reply } => {
                let _ = reply.send(self.last_status_by_player.get(&player).cloned());
            }
            ServerMsg::WaitStatusTrack {
                target_player,
                source_player,
                track_id,
                track_type,
                require_playing,
                observed_after,
                expires_at,
                reply,
            } => {
                self.wait_status_track(StatusWaiter {
                    target_player,
                    source_player,
                    track_id,
                    track_type,
                    require_playing,
                    observed_after,
                    expires_at,
                    reply,
                });
            }
            ServerMsg::RememberBrowseContext {
                target_player,
                context,
                track_ids,
            } => self.remember_browse_context(target_player, context, track_ids),
            ServerMsg::RecentBrowseContexts {
                target_player,
                track_id,
                reply,
            } => {
                let _ = reply.send(self.recent_browse_contexts_for_track(target_player, track_id));
            }
            ServerMsg::RecordLoadProgress {
                target_player,
                track_id,
                context,
                reply,
            } => {
                let _ = reply.send(self.record_load_progress(target_player, track_id, context));
            }
            ServerMsg::LoadProgressSince {
                target_player,
                track_id,
                since,
                reply,
            } => {
                let _ = reply.send(self.load_progress_since(target_player, track_id, since));
            }
            ServerMsg::RecentPreviousAudioRead {
                target_player,
                track_id,
                now,
                reply,
            } => {
                let _ = reply.send(self.recent_previous_audio_read(target_player, track_id, now));
            }
            ServerMsg::BeginLoadConfirm {
                target_player,
                track_id,
                require_playing,
                reply,
            } => {
                let _ =
                    reply.send(self.begin_load_confirm(target_player, track_id, require_playing));
            }
            ServerMsg::BeginMountInfoLoadConfirm {
                target_player,
                target_ip,
                track_id,
                require_playing,
                active_for,
                reply,
            } => {
                let _ = reply.send(self.begin_mount_info_load_confirm(
                    target_player,
                    target_ip,
                    track_id,
                    require_playing,
                    active_for,
                ));
            }
            ServerMsg::CurrentLoadConfirm {
                target_player,
                track_id,
                generation,
                reply,
            } => {
                let _ = reply.send(self.current_load_confirm(target_player, track_id, generation));
            }
            ServerMsg::ActiveLoadConfirm {
                target_player,
                active_for,
                reply,
            } => {
                let _ = reply.send(self.active_load_confirm(target_player, active_for));
            }
            ServerMsg::RefreshLoadConfirmRequirePlaying {
                target_player,
                target_ip,
                track_id,
                generation,
                observed_require_playing,
                status_summary,
                reply,
            } => {
                let _ = reply.send(self.refresh_load_confirm_require_playing(
                    target_player,
                    target_ip,
                    track_id,
                    generation,
                    observed_require_playing,
                    status_summary,
                ));
            }
            ServerMsg::ReserveProgressFollowup {
                target_player,
                track_id,
                generation,
                reply,
            } => {
                let _ =
                    reply.send(self.reserve_progress_followup(target_player, track_id, generation));
            }
            ServerMsg::ClearLoadConfirmIfCurrent {
                target_player,
                track_id,
                generation,
            } => self.clear_load_confirm_if_current(target_player, track_id, generation),
            ServerMsg::CachedArtwork { artwork_id, reply } => {
                let _ = reply.send(self.artwork_cache.get(&artwork_id).cloned());
            }
            ServerMsg::StoreArtwork { artwork_id, bytes } => {
                self.artwork_cache.insert(artwork_id, bytes);
            }
            ServerMsg::CachedWaveformPreview { track_id, reply } => {
                let _ = reply.send(self.waveform_preview_cache.get(&track_id).cloned());
            }
            ServerMsg::StoreWaveformPreview { track_id, blob } => {
                self.waveform_preview_cache.insert(track_id, blob);
            }
            ServerMsg::LogUnknownPacketOnce { key, reply } => {
                let _ = reply.send(self.seen_unknown_packets.insert(key));
            }
            ServerMsg::NfsHandleForPath {
                path,
                parent_fh,
                reply,
            } => {
                let fh = self.nfs.handle_for_path(&path, parent_fh.as_deref());
                let _ = reply.send(fh);
            }
            ServerMsg::NfsPathForHandle { fh, reply } => {
                let _ = reply.send(self.nfs.path_for_handle(&fh));
            }
            ServerMsg::ExtendNfsExports { exports, reply } => {
                self.nfs.extend_exports(exports);
                let _ = reply.send(());
            }
            ServerMsg::Shutdown => {}
        }
    }

    fn device_count(&mut self) -> u8 {
        self.expire_devices(Instant::now());
        self.devices.len().saturating_add(1).min(255) as u8
    }

    fn devices_sorted(&mut self) -> Vec<LinkDevice> {
        self.expire_devices(Instant::now());
        let mut devices = self.devices.values().cloned().collect::<Vec<_>>();
        devices.sort_by(|a, b| {
            a.player_number
                .cmp(&b.player_number)
                .then(a.ip_addr.cmp(&b.ip_addr))
        });
        devices
    }

    fn record_device(&mut self, device: LinkDevice) -> bool {
        self.expire_devices(Instant::now());

        let conflicting_ips = self
            .devices
            .iter()
            .filter(|(ip, existing)| {
                **ip != device.ip_addr
                    && (existing.player_number == device.player_number
                        || (!device.mac_addr.is_empty() && existing.mac_addr == device.mac_addr))
            })
            .map(|(ip, _)| *ip)
            .collect::<Vec<_>>();
        let mut requires_link_init = false;
        for ip in conflicting_ips {
            if let Some(replaced) = self.remove_device(ip) {
                tracing::info!(
                    player = replaced.player_number,
                    old_ip = %replaced.ip_addr,
                    new_ip = %device.ip_addr,
                    "device_address_changed"
                );
                requires_link_init = true;
            }
        }

        if let Some(existing) = self.devices.get(&device.ip_addr).cloned() {
            let identity_changed = existing.player_number != device.player_number
                || existing.mac_addr != device.mac_addr
                || existing.model != device.model;
            let announcement_gap = device
                .last_seen
                .saturating_duration_since(existing.last_seen);
            if identity_changed || announcement_gap >= DEVICE_RELINK_GAP {
                self.remove_device(device.ip_addr);
                tracing::info!(
                    player = device.player_number,
                    %device.ip_addr,
                    gap_ms = announcement_gap.as_millis(),
                    identity_changed,
                    "device_restarted"
                );
                requires_link_init = true;
            } else if device.last_seen < existing.last_seen {
                return false;
            }
        } else {
            requires_link_init = true;
        }

        self.devices.insert(device.ip_addr, device);
        requires_link_init
    }

    fn device_for_ip(&mut self, ip: Ipv4Addr) -> Option<LinkDevice> {
        self.expire_devices(Instant::now());
        self.devices.get(&ip).cloned()
    }

    fn unlinked_targets(&mut self) -> (Vec<Ipv4Addr>, bool) {
        self.expire_devices(Instant::now());
        let targets = self
            .devices
            .keys()
            .filter(|ip| !self.linked_devices.contains(ip))
            .copied()
            .collect::<Vec<_>>();
        (targets, self.devices.is_empty())
    }

    fn next_device_expiry(&self) -> Option<Instant> {
        self.devices
            .values()
            .filter_map(|device| device.last_seen.checked_add(DEVICE_MAX_AGE))
            .min()
    }

    fn expire_devices(&mut self, now: Instant) -> Vec<u8> {
        let expired = self
            .devices
            .iter()
            .filter(|(_, device)| now.saturating_duration_since(device.last_seen) >= DEVICE_MAX_AGE)
            .map(|(ip, device)| (*ip, device.player_number, device.last_seen))
            .collect::<Vec<_>>();
        for &(ip, player, last_seen) in &expired {
            self.remove_device(ip);
            tracing::info!(
                player,
                %ip,
                age_ms = now.saturating_duration_since(last_seen).as_millis(),
                "device_expired"
            );
            self.emit_telemetry(DjLinkTelemetryKind::Device, player);
        }
        expired.into_iter().map(|(_, player, _)| player).collect()
    }

    fn remove_device(&mut self, ip: Ipv4Addr) -> Option<LinkDevice> {
        let device = self.devices.remove(&ip)?;
        let player = device.player_number;
        self.linked_devices.remove(&ip);
        self.db_auto_load_last_sent.remove(&ip);
        self.load_ack_by_ip.remove(&ip);
        self.db_query_counts.remove(&ip);
        self.load_confirm_by_player.remove(&player);
        self.browse_context_by_player.remove(&player);
        self.last_status_by_player.remove(&player);
        self.last_status_seen_by_player.remove(&player);
        self.last_key_status_by_player.remove(&player);
        self.last_beat_by_player.remove(&player);
        self.last_beat_seen_by_player.remove(&player);
        self.last_position_by_player.remove(&player);
        self.last_position_seen_by_player.remove(&player);
        self.beat_playheads.remove(&player);
        self.load_progress_by_player
            .retain(|(target_player, _), _| *target_player != player);

        let mut remaining_load_ack_waiters = Vec::with_capacity(self.load_ack_waiters.len());
        for waiter in self.load_ack_waiters.drain(..) {
            if waiter.ip == ip {
                let _ = waiter.reply.send(false);
            } else {
                remaining_load_ack_waiters.push(waiter);
            }
        }
        self.load_ack_waiters = remaining_load_ack_waiters;

        let mut remaining_status_waiters = Vec::with_capacity(self.status_waiters.len());
        for waiter in self.status_waiters.drain(..) {
            if waiter.target_player == player {
                let _ = waiter.reply.send(false);
            } else {
                remaining_status_waiters.push(waiter);
            }
        }
        self.status_waiters = remaining_status_waiters;
        Some(device)
    }

    fn should_send_link_init(&mut self, ip: Ipv4Addr) -> bool {
        !self.linked_devices.contains(&ip)
    }

    fn should_retry_link_init_broadcast(&mut self, min_interval: Duration) -> bool {
        if self
            .last_link_init_broadcast
            .map(|last| last.elapsed() < min_interval)
            .unwrap_or(false)
        {
            return false;
        }
        self.last_link_init_broadcast = Some(Instant::now());
        true
    }

    fn next_db_query_response(&mut self, ip: Ipv4Addr, db_server_port: u16) -> (u32, u16) {
        let count = self.db_query_counts.entry(ip).or_insert(0);
        *count += 1;
        (*count, db_server_port)
    }

    fn should_send_db_auto_load(
        &mut self,
        target_ip: Ipv4Addr,
        track_id: u32,
        request_type: u16,
        throttle: Duration,
        now: Instant,
    ) -> bool {
        let should_send = self
            .db_auto_load_last_sent
            .get(&target_ip)
            .map(|(last_track, last_request, last)| {
                *last_track != track_id
                    || now.duration_since(*last) >= throttle
                    || *last_request != request_type
            })
            .unwrap_or(true);
        if should_send {
            self.db_auto_load_last_sent
                .insert(target_ip, (track_id, request_type, now));
        }
        should_send
    }

    fn record_load_ack(&mut self, ip: Ipv4Addr, now: Instant, log_throttle: Duration) -> bool {
        let previous = self.load_ack_by_ip.insert(ip, now);
        let mut pending = Vec::new();
        for waiter in self.load_ack_waiters.drain(..) {
            if waiter.ip == ip && now >= waiter.after {
                let _ = waiter.reply.send(true);
            } else {
                pending.push(waiter);
            }
        }
        self.load_ack_waiters = pending;
        previous
            .map(|previous| now.saturating_duration_since(previous))
            .is_none_or(|elapsed| elapsed >= log_throttle)
    }

    fn load_ack_happened_after(&self, ip: Ipv4Addr, after: Instant) -> bool {
        self.load_ack_by_ip
            .get(&ip)
            .copied()
            .is_some_and(|ack| ack >= after)
    }

    fn wait_load_ack_after(&mut self, ip: Ipv4Addr, after: Instant, reply: oneshot::Sender<bool>) {
        if self.load_ack_happened_after(ip, after) {
            let _ = reply.send(true);
            return;
        }
        self.load_ack_waiters
            .push(LoadAckWaiter { ip, after, reply });
    }

    fn record_status(&mut self, status: CdjStatusSnapshot, seen_at: Instant) -> bool {
        let player = status.player();
        let track_changed = self
            .last_status_by_player
            .get(&player)
            .is_some_and(|previous| !previous.same_track_as(&status));
        if track_changed {
            self.last_key_status_by_player.remove(&player);
            self.beat_playheads.remove(&player);
            self.last_position_seen_by_player.remove(&player);
            self.last_position_by_player.remove(&player);
            self.last_beat_by_player.remove(&player);
            self.last_beat_seen_by_player.remove(&player);
        }
        if status.has_key_telemetry() {
            self.last_key_status_by_player
                .insert(player, (status.clone(), seen_at));
        }
        let clock = self
            .track_timings
            .get(&status.track_id())
            .and_then(|timing| {
                let (beat, rate, ended, reset) = status.timing_input();
                BeatPlayhead::update(
                    self.beat_playheads.get(&player),
                    timing,
                    beat,
                    rate,
                    ended,
                    reset,
                    seen_at,
                )
            });
        if let Some(clock) = clock {
            self.beat_playheads.insert(player, clock);
        } else {
            self.beat_playheads.remove(&player);
        }
        self.last_status_seen_by_player.insert(player, seen_at);
        self.last_status_by_player
            .insert(player, status.clone())
            .map(|previous| status.log_worthy_change_from(&previous))
            .unwrap_or(true)
    }

    fn wait_status_track(&mut self, waiter: StatusWaiter) {
        let now = Instant::now();
        self.status_waiters
            .retain(|pending| pending.expires_at > now && !pending.reply.is_closed());
        if self
            .last_status_by_player
            .get(&waiter.target_player)
            .is_some_and(|status| {
                self.last_status_seen_by_player
                    .get(&waiter.target_player)
                    .is_some_and(|seen_at| *seen_at >= waiter.observed_after)
                    && status_satisfies_waiter(status, &waiter)
            })
        {
            let _ = waiter.reply.send(true);
            return;
        }
        self.status_waiters.push(waiter);
    }

    fn notify_status_waiters(&mut self, status: &CdjStatusSnapshot, now: Instant) {
        let mut pending = Vec::with_capacity(self.status_waiters.len());
        for waiter in self.status_waiters.drain(..) {
            if waiter.reply.is_closed() || waiter.expires_at <= now {
                continue;
            }
            if now >= waiter.observed_after && status_satisfies_waiter(status, &waiter) {
                let _ = waiter.reply.send(true);
            } else {
                pending.push(waiter);
            }
        }
        self.status_waiters = pending;
    }

    fn record_beat(&mut self, beat: CdjBeatSnapshot, seen_at: Instant) -> bool {
        let changed = self.last_beat_by_player.get(&beat.player()) != Some(&beat);
        self.last_beat_seen_by_player.insert(beat.player(), seen_at);
        self.last_beat_by_player.insert(beat.player(), beat);
        changed
    }

    fn record_position(&mut self, position: CdjPositionSnapshot) -> bool {
        self.last_position_seen_by_player
            .insert(position.player(), Instant::now());
        let should_log = self
            .last_position_by_player
            .get(&position.player())
            .is_none_or(|previous| previous.summary() != position.summary());
        self.last_position_by_player
            .insert(position.player(), position);
        should_log
    }

    fn monitor_snapshot(&self, player: u8) -> DjLinkMonitorSnapshot {
        let status = self.last_status_by_player.get(&player);
        let beat = self.last_beat_by_player.get(&player);
        let now = Instant::now();
        let position = self.last_position_by_player.get(&player).filter(|_| {
            self.last_position_seen_by_player
                .get(&player)
                .is_some_and(|seen| now.saturating_duration_since(*seen) < Duration::from_secs(1))
        });
        // A stopped deck sends no beat packets. Its old beat must not override
        // newer status packets when the DJ changes pitch or loads another track.
        let current_beat = beat.filter(|_| {
            self.last_beat_seen_by_player.get(&player)
                >= self.last_status_seen_by_player.get(&player)
        });
        DjLinkMonitorSnapshot {
            status: status.map(CdjStatusSnapshot::summary),
            beat: beat.map(CdjBeatSnapshot::summary),
            position: position.map(CdjPositionSnapshot::summary),
            deck: status.map(|status| {
                let mut deck = status.deck_state(position, current_beat);
                if let Some((key_status, seen)) = self.last_key_status_by_player.get(&player)
                    && now.saturating_duration_since(*seen) < Duration::from_secs(1)
                {
                    status.apply_key_telemetry(key_status, &mut deck);
                }
                if position.is_none() {
                    if let (Some(clock), Some(timing)) = (
                        self.beat_playheads.get(&player),
                        self.track_timings.get(&status.track_id()),
                    ) {
                        let playhead = clock.position(now);
                        deck.playhead_ms = Some(playhead);
                        deck.playhead_source = Some("beat_grid");
                        deck.track_length_sec = Some(timing.duration_ms / 1000);
                        deck.track_progress_milli = (timing.duration_ms > 0).then(|| {
                            ((u64::from(playhead) * 1000) / u64::from(timing.duration_ms)).min(1000)
                                as u16
                        });
                    }
                }
                deck
            }),
        }
    }

    fn emit_telemetry(&self, kind: DjLinkTelemetryKind, player: u8) {
        let Some(telemetry) = &self.telemetry else {
            return;
        };
        let _ = telemetry.send(DjLinkTelemetryEvent {
            kind,
            player,
            deck: self.monitor_snapshot(player).deck,
        });
    }

    fn remember_browse_context(
        &mut self,
        target_player: u8,
        context: LoadConfirmContext,
        track_ids: HashSet<u32>,
    ) {
        let queue = self
            .browse_context_by_player
            .entry(target_player)
            .or_default();
        queue.push_back(BrowseContextSnapshot {
            context,
            track_ids,
            seen_at: Instant::now(),
        });
        while queue.len() > BROWSE_CONTEXT_HISTORY_MAX {
            queue.pop_front();
        }
    }

    fn recent_browse_contexts_for_track(
        &self,
        target_player: u8,
        track_id: u32,
    ) -> Vec<LoadConfirmContext> {
        let cutoff = Instant::now()
            .checked_sub(RECENT_BROWSE_CONTEXT_FOR)
            .unwrap_or_else(Instant::now);
        let Some(queue) = self.browse_context_by_player.get(&target_player) else {
            return Vec::new();
        };
        let mut contexts = Vec::new();
        for snapshot in queue.iter().rev() {
            if snapshot.seen_at < cutoff || !snapshot.track_ids.contains(&track_id) {
                continue;
            }
            push_unique_context(&mut contexts, snapshot.context);
        }
        contexts
    }

    fn record_load_progress(
        &mut self,
        target_player: u8,
        track_id: u32,
        context: &'static str,
    ) -> LoadProgressRecordResult {
        let key = (target_player, track_id);
        if let Some(previous) = self.load_progress_by_player.get(&key) {
            if (previous.suppresses_load_confirm() && !context_suppresses_load_confirm(context))
                || (previous.is_visual_data()
                    && !context_is_visual_load_data(context)
                    && !context_suppresses_load_confirm(context))
            {
                return LoadProgressRecordResult::Kept {
                    previous_context: previous.context,
                };
            }
        }
        self.load_progress_by_player.insert(
            key,
            LoadProgressSnapshot {
                track_id,
                seen_at: Instant::now(),
                context,
            },
        );
        LoadProgressRecordResult::Recorded
    }

    fn next_load_confirm_generation(&mut self) -> u64 {
        self.load_confirm_generation = self.load_confirm_generation.saturating_add(1);
        self.load_confirm_generation
    }

    fn begin_load_confirm(
        &mut self,
        target_player: u8,
        track_id: u32,
        require_playing: bool,
    ) -> u64 {
        let generation = self.next_load_confirm_generation();
        self.load_confirm_by_player.insert(
            target_player,
            LoadConfirmSession {
                generation,
                track_id,
                started_at: Instant::now(),
                require_playing,
                progress_followup_sent: false,
            },
        );
        generation
    }

    fn begin_mount_info_load_confirm(
        &mut self,
        target_player: u8,
        target_ip: Ipv4Addr,
        track_id: u32,
        require_playing: bool,
        active_for: Duration,
    ) -> Option<u64> {
        let now = Instant::now();
        if let Some(session) = self
            .load_confirm_by_player
            .get(&target_player)
            .copied()
            .filter(|session| now.saturating_duration_since(session.started_at) <= active_for)
        {
            if session.track_id == track_id {
                let effective_require_playing = session.require_playing || require_playing;
                if let Some(session) = self.load_confirm_by_player.get_mut(&target_player) {
                    session.require_playing = effective_require_playing;
                }
                tracing::debug!(
                    target: "djtools_link::load",
                    target_player,
                    %target_ip,
                    track_id,
                    generation = session.generation,
                    require_playing,
                    effective_require_playing,
                    "mount-info load confirm reused active same-track intent"
                );
                return None;
            }
            tracing::debug!(
                target: "djtools_link::load",
                target_player,
                %target_ip,
                previous_track_id = session.track_id,
                track_id,
                previous_generation = session.generation,
                require_playing,
                effective_require_playing = require_playing,
                "mount-info load confirm superseded active different-track intent"
            );
        }

        let generation = self.next_load_confirm_generation();
        self.load_confirm_by_player.insert(
            target_player,
            LoadConfirmSession {
                generation,
                track_id,
                started_at: now,
                require_playing,
                progress_followup_sent: false,
            },
        );
        Some(generation)
    }

    fn current_load_confirm(
        &self,
        target_player: u8,
        track_id: u32,
        generation: u64,
    ) -> Option<LoadConfirmSession> {
        self.load_confirm_by_player
            .get(&target_player)
            .copied()
            .filter(|session| session.generation == generation && session.track_id == track_id)
    }

    fn active_load_confirm(
        &self,
        target_player: u8,
        active_for: Duration,
    ) -> Option<LoadConfirmSession> {
        let now = Instant::now();
        self.load_confirm_by_player
            .get(&target_player)
            .copied()
            .filter(|session| now.saturating_duration_since(session.started_at) <= active_for)
    }

    fn refresh_load_confirm_require_playing(
        &mut self,
        target_player: u8,
        target_ip: Ipv4Addr,
        track_id: u32,
        generation: u64,
        observed_require_playing: bool,
        status_summary: String,
    ) -> Option<bool> {
        let session = self
            .load_confirm_by_player
            .get_mut(&target_player)
            .filter(|session| session.generation == generation && session.track_id == track_id)?;
        if observed_require_playing && !session.require_playing {
            session.require_playing = true;
            tracing::debug!(
                target: "djtools_link::load",
                target_player,
                %target_ip,
                track_id,
                generation,
                status = status_summary,
                "mount-info load confirm upgraded to require playback"
            );
        }
        Some(session.require_playing)
    }

    fn reserve_progress_followup(
        &mut self,
        target_player: u8,
        track_id: u32,
        generation: Option<u64>,
    ) -> Option<LoadConfirmSession> {
        let session = self.load_confirm_by_player.get_mut(&target_player)?;
        if session.track_id != track_id
            || !session.require_playing
            || session.progress_followup_sent
        {
            return None;
        }
        if generation.is_some_and(|generation| session.generation != generation) {
            return None;
        }
        session.progress_followup_sent = true;
        Some(*session)
    }

    fn clear_load_confirm_if_current(&mut self, target_player: u8, track_id: u32, generation: u64) {
        if self
            .load_confirm_by_player
            .get(&target_player)
            .is_some_and(|session| session.generation == generation && session.track_id == track_id)
        {
            self.load_confirm_by_player.remove(&target_player);
        }
    }

    fn load_progress_since(
        &self,
        target_player: u8,
        track_id: u32,
        since: Instant,
    ) -> Option<LoadProgressSnapshot> {
        self.load_progress_by_player
            .get(&(target_player, track_id))
            .cloned()
            .filter(|progress| progress.track_id == track_id && progress.seen_at >= since)
    }

    fn recent_previous_audio_read(
        &self,
        target_player: u8,
        track_id: u32,
        now: Instant,
    ) -> Option<LoadProgressSnapshot> {
        self.load_progress_by_player
            .iter()
            .filter(|((player, progress_track_id), progress)| {
                *player == target_player
                    && *progress_track_id != track_id
                    && progress.context == "nfs-audio"
                    && now
                        .checked_duration_since(progress.seen_at)
                        .unwrap_or_default()
                        <= RECENT_OLD_AUDIO_READ_FOR_SWITCH
            })
            .map(|(_, progress)| progress)
            .max_by_key(|progress| progress.seen_at)
            .cloned()
    }
}

async fn wait_until(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await,
        None => std::future::pending().await,
    }
}

fn status_satisfies_waiter(status: &CdjStatusSnapshot, waiter: &StatusWaiter) -> bool {
    status.player() == waiter.target_player
        && status.matches_track_from_source(
            waiter.source_player,
            waiter.track_id,
            waiter.track_type,
        )
        && (!waiter.require_playing || status.is_playing())
}

fn push_unique_context(contexts: &mut Vec<LoadConfirmContext>, context: LoadConfirmContext) {
    if context.source_menu != 0 && !contexts.contains(&context) {
        contexts.push(context);
    }
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use super::*;

    #[tokio::test]
    async fn actor_serializes_device_updates() {
        let (tx, rx) = ServerActor::channel();
        let actor = tokio::spawn(ServerActor::default().run(rx));

        let (reply, received) = oneshot::channel();
        tx.send(ServerMsg::RecordDevice {
            device: test_device(3, Ipv4Addr::new(169, 254, 7, 4)),
            reply,
        })
        .await
        .unwrap();
        assert!(received.await.unwrap());

        let (reply, received) = oneshot::channel();
        tx.send(ServerMsg::RecordDevice {
            device: test_device(3, Ipv4Addr::new(169, 254, 7, 4)),
            reply,
        })
        .await
        .unwrap();
        assert!(!received.await.unwrap());

        let (reply, received) = oneshot::channel();
        tx.send(ServerMsg::Devices { reply }).await.unwrap();
        let devices = received.await.unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].player_number, 3);

        tx.send(ServerMsg::Shutdown).await.unwrap();
        actor.await.unwrap();
    }

    #[test]
    fn actor_expires_stale_devices_and_treats_their_return_as_new() {
        let mut actor = ServerActor::default();
        let ip = Ipv4Addr::new(169, 254, 7, 4);
        let mut stale = test_device(3, ip);
        stale.last_seen = Instant::now() - DEVICE_MAX_AGE - Duration::from_secs(1);
        actor.devices.insert(ip, stale);
        actor.linked_devices.insert(ip);
        actor.db_query_counts.insert(ip, 4);

        assert!(actor.devices_sorted().is_empty());
        assert_eq!(actor.device_count(), 1);
        assert!(!actor.linked_devices.contains(&ip));
        assert!(!actor.db_query_counts.contains_key(&ip));

        assert!(actor.record_device(test_device(3, ip)));
        assert_eq!(actor.devices_sorted().len(), 1);
    }

    #[test]
    fn actor_relinks_a_deck_after_a_short_restart_gap() {
        let mut actor = ServerActor::default();
        let ip = Ipv4Addr::new(169, 254, 7, 4);
        let mut before_restart = test_device(3, ip);
        before_restart.last_seen = Instant::now() - DEVICE_RELINK_GAP - Duration::from_millis(1);
        actor.devices.insert(ip, before_restart);
        actor.linked_devices.insert(ip);

        assert!(actor.record_device(test_device(3, ip)));
        assert!(!actor.linked_devices.contains(&ip));
        assert_eq!(actor.devices_sorted().len(), 1);
    }

    #[test]
    fn actor_replaces_a_deck_that_reappears_at_a_new_ip() {
        let mut actor = ServerActor::default();
        let old_ip = Ipv4Addr::new(169, 254, 7, 4);
        let new_ip = Ipv4Addr::new(169, 254, 9, 8);
        assert!(actor.record_device(test_device(3, old_ip)));
        actor.linked_devices.insert(old_ip);

        assert!(actor.record_device(test_device(3, new_ip)));
        assert!(!actor.linked_devices.contains(&old_ip));
        assert!(!actor.linked_devices.contains(&new_ip));
        let devices = actor.devices_sorted();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].ip_addr, new_ip);
    }

    #[test]
    fn actor_retries_link_init_until_deck_acknowledges() {
        let mut actor = ServerActor::default();
        let ip = Ipv4Addr::new(169, 254, 7, 4);

        assert!(actor.should_send_link_init(ip));
        assert!(actor.should_send_link_init(ip));

        actor.linked_devices.insert(ip);
        assert!(!actor.should_send_link_init(ip));
    }

    #[tokio::test]
    async fn actor_keeps_visual_load_progress_until_stronger_progress() {
        let (tx, rx) = ServerActor::channel();
        let actor = tokio::spawn(ServerActor::default().run(rx));

        let (reply, received) = oneshot::channel();
        tx.send(ServerMsg::RecordLoadProgress {
            target_player: 3,
            track_id: 42,
            context: "waveform-preview",
            reply,
        })
        .await
        .unwrap();
        assert_eq!(received.await.unwrap(), LoadProgressRecordResult::Recorded);

        let (reply, received) = oneshot::channel();
        tx.send(ServerMsg::RecordLoadProgress {
            target_player: 3,
            track_id: 42,
            context: "metadata",
            reply,
        })
        .await
        .unwrap();
        assert_eq!(
            received.await.unwrap(),
            LoadProgressRecordResult::Kept {
                previous_context: "waveform-preview",
            }
        );

        let (reply, received) = oneshot::channel();
        tx.send(ServerMsg::RecordLoadProgress {
            target_player: 3,
            track_id: 42,
            context: "nfs-audio",
            reply,
        })
        .await
        .unwrap();
        assert_eq!(received.await.unwrap(), LoadProgressRecordResult::Recorded);

        let (reply, received) = oneshot::channel();
        tx.send(ServerMsg::LoadProgressSince {
            target_player: 3,
            track_id: 42,
            since: Instant::now() - Duration::from_secs(1),
            reply,
        })
        .await
        .unwrap();
        assert_eq!(received.await.unwrap().unwrap().context, "nfs-audio");

        tx.send(ServerMsg::Shutdown).await.unwrap();
        actor.await.unwrap();
    }

    fn test_device(player_number: u8, ip_addr: Ipv4Addr) -> LinkDevice {
        LinkDevice {
            player_number,
            ip_addr,
            mac_addr: "00:11:22:33:44:55".to_string(),
            model: "CDJ-3000".to_string(),
            last_seen: Instant::now(),
        }
    }
}
