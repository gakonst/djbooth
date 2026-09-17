//! Session orchestration shared by native hosts. Queue mutations are serialized;
//! status and transport controls never wait behind a background queue append.
use super::{Client, OwnershipReadPending, Room, Status, Track};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicU64, AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex as AsyncMutex, Notify, RwLock};

/// An obsolete/background poll is intentionally discarded, not a network failure.
#[derive(Debug)]
pub struct StatusPollSkipped;
impl std::fmt::Display for StatusPollSkipped {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Sonos status superseded by a control")
    }
}
impl std::error::Error for StatusPollSkipped {}

const TRANSPORT: usize = 0;
const VOLUME: usize = 1;
const SEEK: usize = 2;
const SELECTION: usize = 3;
#[derive(Clone)]
struct DeferredCommand {
    command: String,
    value: f64,
    revision: u64,
}
#[derive(Clone, Default)]
struct RetryState {
    revisions: [u64; 4],
    pending: [Option<DeferredCommand>; 4],
    error: Option<String>,
    active: [bool; 4],
}
#[derive(Clone)]
struct RegisteredCommand {
    generation: u64,
    group: usize,
    sequence: u64,
    command: DeferredCommand,
}
#[derive(Default)]
struct SubmittedCommands {
    pending: [Option<RegisteredCommand>; 4],
    running: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Session {
    pub request_id: String,
    pub room: Room,
    pub tracks: Vec<Track>,
    #[serde(default)]
    pub queued_count: usize,
    #[serde(default)]
    pub fill_error: Option<String>,
    #[serde(skip)]
    pub filling: bool,
    #[serde(skip)]
    generation: u64,
    #[serde(skip)]
    pending_track: Option<usize>,
    #[serde(skip)]
    pending_autoplay: bool,
    #[serde(skip)]
    intent_revision: u64,
    #[serde(skip)]
    wait_for_play: bool,
    #[serde(skip)]
    retry: RetryState,
}
/// Play acceptance is a successful transport command, not a measurement of
/// audible output. `status`, when present, is an observed renderer state.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadReceipt {
    pub loaded: bool,
    pub request_id: String,
    pub room: Room,
    pub queue_index: usize,
    pub position: f64,
    pub play_accepted: bool,
    pub queued_count: usize,
    pub total_count: usize,
    pub filling: bool,
    pub status: Option<Status>,
    pub volume: Option<u8>,
}
#[derive(Default)]
struct Observation {
    generation: u64,
    epoch: u64,
    status: Option<(Status, Instant)>,
    volume: Option<(u8, Instant)>,
    error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub active: bool,
    pub request_id: String,
    pub room: Room,
    pub status: Status,
    pub queued_count: usize,
    pub total_count: usize,
    pub filling: bool,
    pub fill_error: Option<String>,
    pub pending_queue_index: Option<usize>,
    pub requested_playing: Option<bool>,
    pub control_error: Option<String>,
}
#[derive(Clone)]
pub struct Controller(Arc<Inner>);
struct Inner {
    client: Client,
    state: Mutex<Option<Session>>,
    generation: AtomicU64,
    queue_edit: AsyncMutex<()>,
    // Replacement waits for existing transport commands, while append and
    // ordinary controls can overlap. Always acquire queue_edit before control.
    control: RwLock<()>,
    transport: AsyncMutex<()>,
    control_epoch: AtomicU64,
    active_controls: AtomicUsize,
    observation: Mutex<Observation>,
    submitted: Mutex<SubmittedCommands>,
    command_sequence: AtomicU64,
    lifecycle_changed: Notify,
    observer_wake: Mutex<Arc<Notify>>,
    observer_wake_pending: std::sync::atomic::AtomicBool,
}
struct ControlActivity<'a>(&'a Inner);
impl Inner {
    fn activity(&self) -> ControlActivity<'_> {
        self.active_controls.fetch_add(1, Ordering::SeqCst);
        self.control_epoch.fetch_add(1, Ordering::SeqCst);
        ControlActivity(self)
    }
}
impl Drop for ControlActivity<'_> {
    fn drop(&mut self) {
        self.0.control_epoch.fetch_add(1, Ordering::SeqCst);
        if self.0.active_controls.fetch_sub(1, Ordering::SeqCst) == 1
            && self.0.observer_wake_pending.swap(false, Ordering::SeqCst)
        {
            self.0.observer_wake.lock().unwrap().notify_one();
        }
    }
}
impl Controller {
    pub fn new(client: Client) -> Self {
        Self(Arc::new(Inner {
            client,
            state: Mutex::new(None),
            generation: AtomicU64::new(0),
            queue_edit: AsyncMutex::new(()),
            control: RwLock::new(()),
            transport: AsyncMutex::new(()),
            control_epoch: AtomicU64::new(0),
            active_controls: AtomicUsize::new(0),
            observation: Mutex::new(Observation::default()),
            submitted: Mutex::new(SubmittedCommands::default()),
            command_sequence: AtomicU64::new(0),
            lifecycle_changed: Notify::new(),
            observer_wake: Mutex::new(Arc::new(Notify::new())),
            observer_wake_pending: std::sync::atomic::AtomicBool::new(false),
        }))
    }
    pub fn checkpoint(&self) -> Result<Session> {
        self.0
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("Sonos session lock"))?
            .clone()
            .context("No Sonos session to save")
    }
    fn active(&self, generation: u64) -> bool {
        self.0.generation.load(Ordering::SeqCst) == generation
    }
    fn update(&self, generation: u64, apply: impl FnOnce(&mut Session)) {
        if let Ok(mut state) = self.0.state.lock() {
            if let Some(state) = state
                .as_mut()
                .filter(|s| s.generation == generation && self.active(generation))
            {
                apply(state);
            }
        }
    }
    fn install(&self, session: Option<Session>) -> Result<()> {
        *self
            .0
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("Sonos session lock"))? = session;
        Ok(())
    }
    pub async fn load(
        &self,
        request_id: String,
        room: &Room,
        tracks: Vec<Track>,
        index: usize,
        position: f64,
        autoplay: bool,
    ) -> Result<LoadReceipt> {
        ensure!(
            !request_id.is_empty()
                && !tracks.is_empty()
                && tracks.len() <= 2000
                && index < tracks.len(),
            "Invalid Sonos queue"
        );
        ensure!(
            position.is_finite() && position >= 0.0,
            "Invalid Sonos position"
        );
        let position = position.min(86400.0 * 7.0).floor();
        for track in &tracks {
            let url = reqwest::Url::parse(&track.url)?;
            ensure!(
                ["http", "https"].contains(&url.scheme())
                    && !track.url.chars().any(char::is_whitespace),
                "Invalid Sonos media URL"
            );
        }
        let generation = self.0.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.0.lifecycle_changed.notify_waiters();
        let _queue = self.0.queue_edit.lock().await;
        let _control = self.0.control.write().await;
        ensure!(self.active(generation), "Sonos load superseded");
        self.install(None)?;
        // Read RenderingControl before starting media, independently of any
        // later AVTransport stall. Missing volume is never a zero baseline.
        let volume = self.0.client.volume(room).await.ok();
        let queued_count = (((index / 16) + 1) * 16).min(tracks.len());
        let room = self
            .0
            .client
            .load(room, &tracks[..queued_count], index, position, autoplay)
            .await?;
        if !self.active(generation) {
            let _ = self
                .0
                .client
                .command(&room, &tracks[..queued_count], "stop", 0.0)
                .await;
            anyhow::bail!("Sonos load superseded");
        }
        let receipt = LoadReceipt {
            loaded: true,
            request_id: request_id.clone(),
            room: room.clone(),
            queue_index: index,
            position,
            play_accepted: autoplay,
            queued_count,
            total_count: tracks.len(),
            filling: queued_count < tracks.len(),
            status: None,
            volume,
        };
        self.install(Some(Session {
            request_id,
            room,
            tracks,
            queued_count,
            fill_error: None,
            filling: false,
            generation,
            pending_track: None,
            pending_autoplay: autoplay,
            intent_revision: 0,
            wait_for_play: true,
            retry: RetryState::default(),
        }))?;
        self.start_observer(generation, None, volume);
        self.start_fill(generation);
        Ok(receipt)
    }
    pub async fn restore(
        &self,
        saved: Session,
        interfaces: &[crate::DjLinkInterface],
    ) -> Result<Option<Snapshot>> {
        let generation = self.0.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.0.lifecycle_changed.notify_waiters();
        let _queue = self.0.queue_edit.lock().await;
        let _control = self.0.control.write().await;
        ensure!(self.active(generation), "Sonos restore superseded");
        let (room, status) = self
            .0
            .client
            .reconnect(&saved.room, &saved.tracks, interfaces)
            .await?;
        if !status.owned {
            self.install(None)?;
            return Ok(None);
        }
        // Saved counts are advisory. A request may have been applied just before
        // iOS killed the process, so inspect the entire native prefix first.
        let queued_count = self.0.client.queue_prefix_len(&room, &saved.tracks).await?;
        ensure!(
            queued_count > status.queue_index,
            "Sonos queue changed during restore"
        );
        ensure!(self.active(generation), "Sonos restore superseded");
        self.install(Some(Session {
            room,
            queued_count,
            generation,
            filling: false,
            fill_error: None,
            pending_track: None,
            pending_autoplay: false,
            intent_revision: 0,
            wait_for_play: false,
            retry: RetryState::default(),
            ..saved
        }))?;
        self.start_observer(generation, Some(status.clone()), Some(status.volume));
        self.start_fill(generation);
        Ok(Some(self.snapshot_value(self.checkpoint()?, status)))
    }
    fn snapshot_value(&self, session: Session, status: Status) -> Snapshot {
        Snapshot {
            active: true,
            request_id: session.request_id,
            room: session.room,
            status,
            queued_count: session.queued_count,
            total_count: session.tracks.len(),
            filling: session.filling || session.retry.pending[SELECTION].is_some(),
            fill_error: session.fill_error,
            pending_queue_index: session.pending_track,
            requested_playing: (session.pending_track.is_some() || session.retry.active[TRANSPORT])
                .then_some(session.pending_autoplay),
            control_error: session.retry.error,
        }
    }
    pub async fn status(&self) -> Result<Option<Snapshot>> {
        let epoch = self.0.control_epoch.load(Ordering::SeqCst);
        let Ok(session) = self.checkpoint() else {
            return Ok(None);
        };
        if !self.active(session.generation) {
            return Ok(None);
        }
        let observation = self
            .0
            .observation
            .lock()
            .map_err(|_| anyhow::anyhow!("Sonos observation lock"))?;
        if observation.generation != session.generation
            || observation.epoch != epoch
            || self.0.control_epoch.load(Ordering::SeqCst) != epoch
            || self.0.active_controls.load(Ordering::SeqCst) != 0
        {
            return Err(StatusPollSkipped.into());
        }
        if let Some(error) = &observation.error {
            anyhow::bail!("{error}");
        }
        let Some((mut status, sampled)) = observation.status.clone() else {
            return Err(StatusPollSkipped.into());
        };
        if status.playing {
            status.position += sampled.elapsed().as_secs_f64();
            if status.duration > 0.0 {
                status.position = status.position.min(status.duration);
            }
        }
        if let Some((volume, _)) = observation.volume {
            status.volume = volume;
        }
        if !self.active(session.generation) || self.0.control_epoch.load(Ordering::SeqCst) != epoch
        {
            return Err(StatusPollSkipped.into());
        }
        Ok(Some(self.snapshot_value(session, status)))
    }
    fn start_observer(&self, generation: u64, status: Option<Status>, volume: Option<u8>) {
        let now = Instant::now();
        *self.0.observation.lock().expect("Sonos observation lock") = Observation {
            generation,
            epoch: self.0.control_epoch.load(Ordering::SeqCst),
            status: status.map(|status| (status, now)),
            volume: volume.map(|volume| (volume, now)),
            error: None,
        };
        let weak = Arc::downgrade(&self.0);
        // Keep only the notification alive while sleeping, not the controller.
        // Notify retains at most one permit when controls finish during a read.
        // A replaced observer must not consume the new session's wake permit.
        let wake = Arc::new(Notify::new());
        *self.0.observer_wake.lock().unwrap() = wake.clone();
        tokio::spawn(async move {
            let mut delay = Duration::ZERO;
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(delay) => {},
                    _ = wake.notified() => {},
                }
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let controller = Controller(inner);
                if !controller.active(generation) {
                    return;
                }
                // Queue work and observation share a background lane. Explicit
                // controls remain independent and invalidate stale observations.
                let _queue = controller.0.queue_edit.lock().await;
                let _control = controller.0.control.read().await;
                if !controller.active(generation) {
                    return;
                }
                if controller.0.active_controls.load(Ordering::SeqCst) != 0 {
                    delay = Duration::from_millis(250);
                    continue;
                }
                let epoch = controller.0.control_epoch.load(Ordering::SeqCst);
                let Ok(session) = controller.checkpoint() else {
                    return;
                };
                let cached_volume = controller.0.observation.lock().unwrap().volume;
                let changed = controller.0.lifecycle_changed.notified();
                tokio::pin!(changed);
                changed.as_mut().enable();
                if !controller.active(generation) {
                    return;
                }
                let read = async {
                    let volume = if cached_volume
                        .is_some_and(|(_, at)| at.elapsed() < Duration::from_secs(10))
                    {
                        cached_volume
                    } else {
                        match controller.0.client.volume(&session.room).await {
                            Ok(value) => Some((value, Instant::now())),
                            Err(_) => cached_volume,
                        }
                    };
                    let result = match volume {
                        Some((volume, _)) => {
                            controller
                                .0
                                .client
                                .transport_observation(&session.room, &session.tracks, volume)
                                .await
                        }
                        None => Err(anyhow::anyhow!("Sonos volume has not been observed")),
                    };
                    (volume, result)
                };
                // Only explicit replacement/teardown cancels an observation.
                // Routine UI polling never cancels or starts a wire request.
                let (volume, result) = tokio::select! {
                    _ = &mut changed => return,
                    result = read => result,
                };
                if !controller.active(generation) {
                    return;
                }
                if controller.0.active_controls.load(Ordering::SeqCst) != 0
                    || controller.0.control_epoch.load(Ordering::SeqCst) != epoch
                {
                    delay = Duration::from_millis(250);
                    continue;
                }
                let mut observation = controller.0.observation.lock().unwrap();
                if controller.0.control_epoch.load(Ordering::SeqCst) != epoch {
                    delay = Duration::from_millis(250);
                    continue;
                }
                let preceding_epoch = observation.epoch;
                observation.epoch = epoch;
                observation.volume = volume;
                match result {
                    Ok((status, sampled_at)) => {
                        // A first PLAYING reply can follow a position sampled
                        // during buffering. Do not count that unconfirmed gap
                        // as elapsed audio. Only steady playback of the same
                        // owned queue occurrence retains the earlier timestamp.
                        let continuous = preceding_epoch == epoch
                            && observation.error.is_none()
                            && status.playing
                            && status.owned
                            && observation.status.as_ref().is_some_and(|(prior, _)| {
                                prior.playing
                                    && prior.owned
                                    && prior.queue_index == status.queue_index
                            });
                        let sampled_at = if continuous {
                            sampled_at
                        } else {
                            Instant::now()
                        };
                        if observation.status.as_ref().is_none_or(|(prior, _)| {
                            prior.state != status.state
                                || prior.queue_index != status.queue_index
                                || prior.owned != status.owned
                        }) {
                            tracing::info!(generation, state = %status.state, queue_index = status.queue_index, owned = status.owned, position = status.position, "Sonos observed playback changed");
                        }
                        delay = if status.state == "TRANSITIONING" {
                            Duration::from_millis(250)
                        } else {
                            Duration::from_secs(1)
                        };
                        observation.status = Some((status, sampled_at));
                        observation.error = None;
                    }
                    Err(error) => {
                        tracing::warn!(error = %error, "Sonos observer backing off after read failure");
                        observation.error = Some(format!("{error:#}"));
                        delay = Duration::from_secs(3);
                    }
                }
            }
        });
    }
    /// Reconcile a suspended or failed tail on foreground without resetting
    /// session identity or any pending transport/volume intent.
    pub async fn resume_queue(&self) -> Result<()> {
        let session = self.checkpoint()?;
        if self.active(session.generation) && session.queued_count < session.tracks.len() {
            self.start_fill(session.generation);
        }
        Ok(())
    }
    pub async fn disconnect(&self) -> Result<()> {
        let generation = self.0.generation.fetch_add(1, Ordering::SeqCst) + 1;
        self.0.lifecycle_changed.notify_waiters();
        let _queue = self.0.queue_edit.lock().await;
        let _control = self.0.control.write().await;
        if !self.active(generation) {
            return Ok(());
        }
        if let Ok(session) = self.checkpoint() {
            let _ = self
                .0
                .client
                .command(&session.room, &session.tracks, "stop", 0.0)
                .await;
        }
        self.install(None)
    }
    /// Register intent immediately. One drain owns at most four latest grouped
    /// commands; a slow renderer cannot prevent a newer Pause/Next from being
    /// recorded, and volume gestures cannot create an unbounded task backlog.
    pub fn submit(&self, request_id: &str, command: &str, value: f64) -> Result<()> {
        let runtime =
            tokio::runtime::Handle::try_current().context("Sonos runtime is not active")?;
        let start = {
            let mut queue = self
                .0
                .submitted
                .lock()
                .map_err(|_| anyhow::anyhow!("Sonos submitted commands lock"))?;
            // Serialize registration with insertion so concurrent callers cannot
            // drain a newer intent before an older one has entered the queue.
            // The drain releases this lock before inspecting session state.
            let Some(registered) = self.register_command(request_id, command, value)? else {
                return Ok(());
            };
            tracing::info!(
                generation = registered.generation,
                group = registered.group,
                sequence = registered.sequence,
                action = command,
                "Sonos control intent submitted"
            );
            let slot = &mut queue.pending[registered.group];
            if slot
                .as_ref()
                .is_none_or(|pending| pending.sequence < registered.sequence)
            {
                *slot = Some(registered);
            }
            let start = !queue.running;
            queue.running = true;
            start
        };
        if start {
            let controller = self.clone();
            runtime.spawn(async move {
                controller.drain_submitted().await;
            });
        }
        Ok(())
    }
    async fn drain_submitted(&self) {
        loop {
            let next = {
                let mut queue = self
                    .0
                    .submitted
                    .lock()
                    .expect("Sonos submitted commands lock");
                let group = queue
                    .pending
                    .iter()
                    .enumerate()
                    .filter_map(|(group, command)| command.as_ref().map(|c| (group, c.sequence)))
                    .min_by_key(|(_, sequence)| *sequence)
                    .map(|(group, _)| group);
                match group {
                    Some(group) => queue.pending[group].take(),
                    None => {
                        queue.running = false;
                        None
                    }
                }
            };
            let Some(next) = next else {
                return;
            };
            let result = self.run_command(&next).await;
            if let Err(error) = &result {
                self.finish_command(
                    next.generation,
                    next.group,
                    next.command.revision,
                    Some(format!("{error:#}")),
                );
            }
            tracing::info!(generation = next.generation, sequence = next.sequence,
                action = %next.command.command, ok = result.is_ok(), "Sonos submitted control execution finished");
        }
    }
    pub async fn command(&self, request_id: &str, command: &str, value: f64) -> Result<()> {
        let Some(registered) = self.register_command(request_id, command, value)? else {
            return Ok(());
        };
        self.run_command(&registered).await
    }
    fn register_command(
        &self,
        request_id: &str,
        command: &str,
        value: f64,
    ) -> Result<Option<RegisteredCommand>> {
        let _activity = self.0.activity();
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("Sonos session lock"))?;
        let session = state.as_mut().context("No Sonos session")?;
        if session.request_id != request_id || !self.active(session.generation) {
            return Ok(None);
        }
        ensure!(value.is_finite(), "Invalid Sonos control value");
        let group = match command {
            "track" => {
                ensure!(
                    value >= 0.0 && value.fract() == 0.0 && value < session.tracks.len() as f64,
                    "Invalid queue position"
                );
                SELECTION
            }
            "volume" => {
                ensure!((0.0..=100.0).contains(&value), "Invalid Sonos volume");
                VOLUME
            }
            "seek" => {
                ensure!(value >= 0.0, "Invalid seek time");
                SEEK
            }
            "play" | "pause" | "stop" => TRANSPORT,
            _ => anyhow::bail!("Unsupported Sonos command"),
        };
        session.retry.revisions[group] += 1;
        session.retry.pending[group] = None;
        session.retry.active[group] = true;
        session.retry.error = None;
        if group == TRANSPORT || group == SELECTION {
            session.intent_revision += 1;
            session.pending_autoplay = command == "play" || command == "track";
        }
        if group == SELECTION {
            session.pending_track = Some(value as usize);
            session.retry.revisions[TRANSPORT] += 1;
            session.retry.pending[TRANSPORT] = None;
            session.retry.active[TRANSPORT] = false;
        }
        if command == "stop" {
            session.pending_track = None;
            session.retry.revisions[SELECTION] += 1;
            session.retry.pending[SELECTION] = None;
            session.retry.active[SELECTION] = false;
        }
        if group == SELECTION || command == "stop" {
            session.retry.revisions[SEEK] += 1;
            session.retry.pending[SEEK] = None;
            session.retry.active[SEEK] = false;
        }
        Ok(Some(RegisteredCommand {
            generation: session.generation,
            group,
            sequence: self.0.command_sequence.fetch_add(1, Ordering::SeqCst),
            command: DeferredCommand {
                command: command.into(),
                value,
                revision: session.retry.revisions[group],
            },
        }))
    }
    async fn run_command(&self, registered: &RegisteredCommand) -> Result<()> {
        let _control = self.0.control.read().await;
        let _activity = self.0.activity();
        let session = self.checkpoint()?;
        let group = registered.group;
        let command = registered.command.command.as_str();
        let value = registered.command.value;
        let revision = registered.command.revision;
        if session.generation != registered.generation
            || !self.active(registered.generation)
            || session.retry.revisions[group] != revision
        {
            return Ok(());
        }
        if group == SELECTION && value as usize >= session.queued_count {
            self.start_fill(session.generation);
            return Ok(());
        }
        let _transport = self.0.transport.lock().await;
        let latest = self.checkpoint()?;
        if !self.active(session.generation) || latest.retry.revisions[group] != revision {
            return Ok(());
        }
        if group == SELECTION && latest.pending_track != Some(value as usize) {
            return Ok(());
        }
        let wire_command = if group == SELECTION && !latest.pending_autoplay {
            "track-paused"
        } else {
            command
        };
        let result = self.execute_command(&latest, wire_command, value).await;
        match result {
            Err(error) if error.downcast_ref::<OwnershipReadPending>().is_some() => {
                self.defer_command(
                    session.generation,
                    group,
                    DeferredCommand {
                        command: command.into(),
                        value,
                        revision,
                    },
                );
                Ok(())
            }
            result => {
                self.finish_command(
                    session.generation,
                    group,
                    revision,
                    result.as_ref().err().map(|error| format!("{error:#}")),
                );
                result
            }
        }
    }
    async fn execute_command(&self, session: &Session, command: &str, value: f64) -> Result<()> {
        if ["play", "pause", "volume"].contains(&command) {
            self.0
                .client
                .room_control(&session.room, command, value)
                .await?;
            if command == "volume" {
                let applied = self
                    .0
                    .client
                    .group_state()
                    .room_volumes
                    .get(&session.room.id)
                    .copied()
                    .unwrap_or(value.round().clamp(0.0, 100.0) as u8);
                let mut observation = self.0.observation.lock().unwrap();
                if observation.generation == session.generation {
                    observation.volume = Some((applied, Instant::now()));
                }
            }
            Ok(())
        } else {
            self.0
                .client
                .command_with_selection_intent(
                    &session.room,
                    &session.tracks,
                    command,
                    value,
                    || {
                        self.checkpoint()
                            .ok()
                            .filter(|latest| {
                                self.active(session.generation)
                                    && latest.generation == session.generation
                                    && latest.retry.revisions[SELECTION]
                                        == session.retry.revisions[SELECTION]
                                    && latest.pending_track == Some(value as usize)
                            })
                            .map(|latest| latest.pending_autoplay)
                    },
                )
                .await
        }
    }
    fn finish_command(&self, generation: u64, group: usize, revision: u64, error: Option<String>) {
        let _activity = self.0.activity();
        if group != VOLUME && self.active(generation) {
            self.0.observer_wake_pending.store(true, Ordering::SeqCst);
        }
        self.update(generation, |state| {
            if state.retry.revisions[group] != revision {
                return;
            }
            state.retry.pending[group] = None;
            state.retry.active[group] = false;
            if group == SELECTION {
                state.pending_track = None;
            }
            if let Some(error) = error {
                state.retry.error = Some(error);
            }
        });
    }
    fn defer_command(&self, generation: u64, group: usize, command: DeferredCommand) {
        let mut start = false;
        self.update(generation, |state| {
            if state.retry.revisions[group] == command.revision
                && state.retry.pending[group].is_none()
            {
                state.retry.pending[group] = Some(command.clone());
                start = true;
            }
        });
        if start {
            tracing::info!(generation, group, action = %command.command, revision = command.revision, "Sonos control deferred before mutation");
            let controller = self.clone();
            tokio::spawn(async move {
                controller.retry_command(generation, group, command).await;
            });
        }
    }
    async fn retry_command(&self, generation: u64, group: usize, command: DeferredCommand) {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            // Only the ownership read is retryable: no mutation has been sent.
            // Never wrap the mutation future in a timeout or replay its errors.
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let result = {
                let _control = self.0.control.read().await;
                let _transport = self.0.transport.lock().await;
                let Ok(session) = self.checkpoint() else {
                    return;
                };
                if !self.active(generation)
                    || session.generation != generation
                    || session.retry.revisions[group] != command.revision
                    || session.retry.pending[group]
                        .as_ref()
                        .map(|pending| pending.revision)
                        != Some(command.revision)
                {
                    return;
                }
                if group == SELECTION && session.pending_track != Some(command.value as usize) {
                    self.finish_command(generation, group, command.revision, None);
                    return;
                }
                if tokio::time::Instant::now() >= deadline {
                    tracing::warn!(generation, group, action = %command.command, "Sonos deferred control deadline reached without mutation");
                    self.finish_command(
                        generation,
                        group,
                        command.revision,
                        Some(format!(
                            "Sonos {} could not be sent while the speaker was busy",
                            command.command
                        )),
                    );
                    return;
                }
                let _activity = self.0.activity();
                let wire_command = if group == SELECTION && !session.pending_autoplay {
                    "track-paused"
                } else {
                    &command.command
                };
                self.execute_command(&session, wire_command, command.value)
                    .await
            };
            match result {
                Err(error) if error.downcast_ref::<OwnershipReadPending>().is_some() => continue,
                result => {
                    tracing::info!(generation, group, action = %command.command, ok = result.is_ok(), "Sonos deferred control completed");
                    self.finish_command(
                        generation,
                        group,
                        command.revision,
                        result.err().map(|error| format!("{error:#}")),
                    );
                    return;
                }
            }
        }
    }
    fn start_fill(&self, generation: u64) {
        let mut start = false;
        self.update(generation, |state| {
            if !state.filling
                && (state.queued_count < state.tracks.len()
                    || (state.pending_track.is_some() && state.retry.pending[SELECTION].is_none()))
            {
                state.filling = true;
                state.fill_error = None;
                start = true;
            }
        });
        if start {
            let controller = self.clone();
            tokio::spawn(async move {
                controller.wait_for_initial_play(generation).await;
                if let Err(error) = controller.fill(generation).await {
                    controller.update(generation, |state| {
                        state.filling = false;
                        state.fill_error = Some(format!("{error:#}"));
                    });
                }
            });
        }
    }
    async fn wait_for_initial_play(&self, generation: u64) {
        if !self.checkpoint().is_ok_and(|s| s.wait_for_play) {
            return;
        }
        while self.active(generation) {
            if let Ok(Some(snapshot)) = self.status().await {
                if snapshot.status.owned && snapshot.status.state != "TRANSITIONING" {
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        self.update(generation, |state| state.wait_for_play = false);
    }
    // Only start new background reads/writes after user controls have settled.
    // Never hold lifecycle/queue locks while waiting, and never cancel a queue
    // mutation that has already reached the speaker.
    async fn background_access<'a>(
        &'a self,
        generation: u64,
        quiet_epoch: &mut Option<u64>,
    ) -> Option<(
        tokio::sync::MutexGuard<'a, ()>,
        tokio::sync::RwLockReadGuard<'a, ()>,
    )> {
        loop {
            if !self.active(generation) {
                return None;
            }
            let epoch = self.0.control_epoch.load(Ordering::SeqCst);
            if self.0.active_controls.load(Ordering::SeqCst) != 0 {
                *quiet_epoch = None;
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                continue;
            }
            if *quiet_epoch != Some(epoch) {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
            let queue = self.0.queue_edit.lock().await;
            let control = self.0.control.read().await;
            if !self.active(generation) {
                return None;
            }
            if self.0.active_controls.load(Ordering::SeqCst) == 0
                && self.0.control_epoch.load(Ordering::SeqCst) == epoch
            {
                *quiet_epoch = Some(epoch);
                return Some((queue, control));
            }
            *quiet_epoch = None;
        }
    }
    async fn fill(&self, generation: u64) -> Result<()> {
        let mut quiet_epoch = None;
        // Reconcile once per worker (including restore/resume after uncertainty).
        // Successful append receipts then advance the known native revision.
        let mut native_queue = None;
        loop {
            let queue = self.0.queue_edit.lock().await;
            let control = self.0.control.read().await;
            if !self.active(generation) {
                return Ok(());
            }
            let session = self.checkpoint()?;
            if let Some(index) = session.pending_track.filter(|index| {
                *index < session.queued_count && session.retry.pending[SELECTION].is_none()
            }) {
                // Serialize deferred Seek/Play with transport intents without
                // blocking status or unrelated queue writes.
                let _transport = self.0.transport.lock().await;
                if !self.active(generation) {
                    return Ok(());
                }
                let latest = self.checkpoint()?;
                if latest.intent_revision != session.intent_revision
                    || latest.pending_track != Some(index)
                    || latest.retry.pending[SELECTION].is_some()
                {
                    continue;
                }
                let _activity = self.0.activity();
                let result = self.execute_command(&latest, "track", index as f64).await;
                let revision = latest.retry.revisions[SELECTION];
                if result
                    .as_ref()
                    .err()
                    .is_some_and(|error| error.downcast_ref::<OwnershipReadPending>().is_some())
                {
                    self.defer_command(
                        generation,
                        SELECTION,
                        DeferredCommand {
                            command: "track".into(),
                            value: index as f64,
                            revision,
                        },
                    );
                } else {
                    self.finish_command(
                        generation,
                        SELECTION,
                        revision,
                        result.as_ref().err().map(|error| format!("{error:#}")),
                    );
                    result?;
                }
                continue;
            }
            if session.queued_count == session.tracks.len() {
                let mut done = false;
                self.update(generation, |state| {
                    if state.pending_track.is_none() || state.retry.pending[SELECTION].is_some() {
                        state.filling = false;
                        done = true;
                    }
                });
                if done {
                    return Ok(());
                }
                continue;
            }
            drop(control);
            drop(queue);
            if native_queue.is_none() {
                let Some((_queue, _control)) =
                    self.background_access(generation, &mut quiet_epoch).await
                else {
                    return Ok(());
                };
                let actual = self
                    .0
                    .client
                    .queue_prefix(&session.room, &session.tracks)
                    .await?;
                ensure!(
                    actual.count >= session.queued_count,
                    "Sonos queue was shortened by another controller"
                );
                if !self.active(generation) {
                    return Ok(());
                }
                self.update(generation, |state| state.queued_count = actual.count);
                native_queue = Some(actual);
                // Re-read pending selection after reconciliation, including any
                // intent that arrived while the native queue was being read.
                continue;
            }
            let actual = native_queue.expect("queue reconciled").count;
            if actual < session.tracks.len() {
                let Some((_queue, _control)) =
                    self.background_access(generation, &mut quiet_epoch).await
                else {
                    return Ok(());
                };
                let end = (actual + 8).min(session.tracks.len());
                // Keep the edit lock until the wire operation resolves, even if
                // replacement invalidates this generation while it is in flight.
                let receipt = self
                    .0
                    .client
                    .append_at(&session.room, &session.tracks[actual..end], native_queue)
                    .await?;
                native_queue = Some(receipt);
                self.update(generation, |state| state.queued_count = receipt.count);
            }
            tokio::task::yield_now().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sonos::{element, xml};
    use std::{net::Ipv4Addr, time::Duration};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::Notify,
    };
    #[derive(Default)]
    struct State {
        queue: Vec<String>,
        queue_revision: u32,
        index: usize,
        playing: bool,
        transitioning: bool,
        selected_indices: Vec<usize>,
        actions: Vec<String>,
        hold_at: Option<usize>,
        hold_action: Option<String>,
        pause_delay_ms: u64,
        fail_at: Option<usize>,
        bad_receipt_at: Option<usize>,
        stall_status: bool,
        stall_position: bool,
        incomplete_position: bool,
        status_delay_ms: u64,
        drop_action: Option<String>,
        volume: f64,
    }
    struct Speaker {
        state: Arc<Mutex<State>>,
        entered: Arc<Notify>,
        release: Arc<Notify>,
        task: tokio::task::JoinHandle<()>,
        controller: Controller,
        room: Room,
    }
    impl Drop for Speaker {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    impl Speaker {
        async fn new(hold_at: Option<usize>, fail_at: Option<usize>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let state = Arc::new(Mutex::new(State {
                hold_at,
                fail_at,
                ..State::default()
            }));
            let entered = Arc::new(Notify::new());
            let release = Arc::new(Notify::new());
            let state2 = state.clone();
            let entered2 = entered.clone();
            let release2 = release.clone();
            let task = tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        break;
                    };
                    let state = state2.clone();
                    let entered = entered2.clone();
                    let release = release2.clone();
                    tokio::spawn(async move {
                        let mut bytes = Vec::new();
                        loop {
                            let mut buffer = [0; 8192];
                            let n = socket.read(&mut buffer).await.unwrap();
                            assert!(n > 0);
                            bytes.extend_from_slice(&buffer[..n]);
                            if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                                let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                                let size: usize = headers
                                    .lines()
                                    .find_map(|line| {
                                        line.strip_prefix("content-length:").map(str::trim)
                                    })
                                    .unwrap()
                                    .parse()
                                    .unwrap();
                                if bytes.len() >= end + 4 + size {
                                    break;
                                }
                            }
                        }
                        let request = String::from_utf8(bytes).unwrap();
                        let action = request
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .starts_with("soapaction:")
                                    .then(|| line.split('#').nth(1).unwrap().trim_end_matches('"'))
                            })
                            .unwrap();
                        let (body, hold, fail, stall, status_delay_ms) = {
                            let mut state = state.lock().unwrap();
                            state.actions.push(action.into());
                            let mut hold = state.hold_action.as_deref() == Some(action);
                            if hold {
                                state.hold_action = None;
                            }
                            let mut fail = false;
                            let body = match action {
                                "GetZoneGroupState" => format!(
                                    "<ZoneGroupState>{}</ZoneGroupState>",
                                    xml(&format!(
                                        r#"<ZoneGroups><ZoneGroup Coordinator="A"><ZoneGroupMember UUID="A" ZoneName="Office" Location="http://127.0.0.1:{port}/xml/device_description.xml"/></ZoneGroup></ZoneGroups>"#
                                    ))
                                ),
                                "Stop" | "Pause" => {
                                    state.playing = false;
                                    state.transitioning = false;
                                    String::new()
                                }
                                "Play" => {
                                    state.playing = true;
                                    String::new()
                                }
                                "RemoveAllTracksFromQueue" => {
                                    state.queue.clear();
                                    state.queue_revision += 1;
                                    state.index = 0;
                                    String::new()
                                }
                                "AddMultipleURIsToQueue" => {
                                    let count = state.queue.len();
                                    let update: u32 =
                                        element(&request, "UpdateID").unwrap().parse().unwrap();
                                    assert!(
                                        update == 0 || update == state.queue_revision,
                                        "stale append revision"
                                    );
                                    if state.hold_at == Some(count) {
                                        hold = true;
                                        state.hold_at = None;
                                    }
                                    if state.fail_at == Some(count) {
                                        fail = true;
                                        state.fail_at = None;
                                    }
                                    state.queue.extend(
                                        element(&request, "EnqueuedURIs")
                                            .unwrap()
                                            .split_whitespace()
                                            .map(str::to_owned),
                                    );
                                    state.queue_revision += 1;
                                    let reported_count = if state.bad_receipt_at == Some(count) {
                                        state.bad_receipt_at = None;
                                        state.queue.len() + 1
                                    } else {
                                        state.queue.len()
                                    };
                                    format!(
                                        "<FirstTrackNumberEnqueued>{}</FirstTrackNumberEnqueued><NumTracksAdded>{}</NumTracksAdded><NewQueueLength>{}</NewQueueLength><NewUpdateID>{}</NewUpdateID>",
                                        count + 1,
                                        state.queue.len() - count,
                                        reported_count,
                                        state.queue_revision
                                    )
                                }
                                "Browse" => {
                                    let offset: usize = element(&request, "StartingIndex")
                                        .unwrap()
                                        .parse()
                                        .unwrap();
                                    let urls: Vec<_> =
                                        state.queue.iter().skip(offset).take(7).collect();
                                    let items = urls
                                        .iter()
                                        .map(|url| format!("<item><res>{}</res></item>", xml(url)))
                                        .collect::<String>();
                                    format!(
                                        "<Result>{}</Result><NumberReturned>{}</NumberReturned><TotalMatches>{}</TotalMatches><UpdateID>{}</UpdateID>",
                                        xml(&format!("<DIDL-Lite>{items}</DIDL-Lite>")),
                                        urls.len(),
                                        state.queue.len(),
                                        state.queue_revision
                                    )
                                }
                                "Seek" => {
                                    if element(&request, "Unit").as_deref() == Some("TRACK_NR") {
                                        state.index = element(&request, "Target")
                                            .unwrap()
                                            .parse::<usize>()
                                            .unwrap()
                                            - 1;
                                        assert!(state.index < state.queue.len());
                                        let index = state.index;
                                        state.selected_indices.push(index);
                                    }
                                    String::new()
                                }
                                "GetPositionInfo" if state.incomplete_position => "<Track>0</Track><TrackURI></TrackURI><RelTime>0:00:00</RelTime>".into(),
                                "GetPositionInfo" => format!(
                                    "<Track>{}</Track><TrackURI>{}</TrackURI><RelTime>0:00:02</RelTime><TrackDuration>0:05:00</TrackDuration>",
                                    state.index + 1,
                                    xml(state
                                        .queue
                                        .get(state.index)
                                        .map(String::as_str)
                                        .unwrap_or(""))
                                ),
                                "GetTransportInfo" => format!(
                                    "<CurrentTransportState>{}</CurrentTransportState>",
                                    if state.transitioning {
                                        "TRANSITIONING"
                                    } else if state.playing {
                                        "PLAYING"
                                    } else {
                                        "PAUSED_PLAYBACK"
                                    }
                                ),
                                "GetVolume" => {
                                    format!("<CurrentVolume>{}</CurrentVolume>", state.volume)
                                }
                                "SetVolume" => {
                                    state.volume = element(&request, "DesiredVolume")
                                        .unwrap()
                                        .parse()
                                        .unwrap();
                                    String::new()
                                }
                                "SetPlayMode" | "SetAVTransportURI" => String::new(),
                                _ => panic!("Unexpected {action}"),
                            };
                            let stall = (action == "GetTransportInfo" && state.stall_status)
                                || (action == "GetPositionInfo" && state.stall_position);
                            if state.drop_action.as_deref() == Some(action) {
                                state.drop_action = None;
                                fail = true;
                            }
                            let status_delay_ms = if action == "GetTransportInfo" {
                                state.status_delay_ms
                            } else if action == "Pause" {
                                state.pause_delay_ms
                            } else {
                                0
                            };
                            (body, hold, fail, stall, status_delay_ms)
                        };
                        if status_delay_ms > 0 {
                            tokio::time::sleep(Duration::from_millis(status_delay_ms)).await;
                        }
                        if stall {
                            tokio::time::sleep(Duration::from_secs(2)).await;
                        }
                        if hold {
                            entered.notify_one();
                            release.notified().await;
                        }
                        // Simulate a mutation applied but its response lost. The
                        // client must reconcile before resuming, not replay it.
                        if fail {
                            return;
                        }
                        let _ = socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
                    });
                }
            });
            let room = Room {
                id: "A".into(),
                name: "Office".into(),
                ip: Ipv4Addr::LOCALHOST,
                coordinator: Ipv4Addr::LOCALHOST,
                coordinator_id: "A".into(),
            };
            Self {
                state,
                entered,
                release,
                task,
                controller: Controller::new(Client {
                    port,
                    ..Client::new().unwrap()
                }),
                room,
            }
        }
        async fn observed(&self) -> Snapshot {
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    if let Ok(Some(snapshot)) = self.controller.status().await {
                        return snapshot;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap()
        }
        async fn finished(&self) -> Session {
            tokio::time::timeout(Duration::from_secs(9), async {
                loop {
                    let session = self.controller.checkpoint().unwrap();
                    if !session.filling {
                        return session;
                    }
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap()
        }
        async fn submissions_finished(&self) -> Session {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let session = self.controller.checkpoint().unwrap();
                    if !self.controller.0.submitted.lock().unwrap().running
                        && session.retry.active.iter().all(|active| !active)
                    {
                        return session;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap()
        }
        async fn commands_finished(&self) -> Session {
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let session = self.controller.checkpoint().unwrap();
                    if session.retry.pending.iter().all(Option::is_none) {
                        return session;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap()
        }
    }
    fn tracks(name: &str, count: usize) -> Vec<Track> {
        (0..count)
            .map(|i| Track {
                url: format!("https://media.test/{name}/{i}.mp3"),
                title: i.to_string(),
                artist: String::new(),
                mime: "audio/mpeg".into(),
            })
            .collect()
    }
    fn interfaces() -> Vec<crate::DjLinkInterface> {
        vec![crate::DjLinkInterface {
            name: "lo".into(),
            index: 1,
            ip: Ipv4Addr::new(127, 0, 0, 2),
            broadcast: Ipv4Addr::new(127, 255, 255, 255),
            netmask: Ipv4Addr::new(255, 0, 0, 0),
        }]
    }
    #[tokio::test]
    async fn starts_before_delayed_tail_and_controls_remain_responsive() {
        let speaker = Speaker::new(Some(32), None).await;
        let receipt = speaker
            .controller
            .load(
                "one".into(),
                &speaker.room,
                tracks("one", 40),
                17,
                3.75,
                true,
            )
            .await
            .unwrap();
        assert!(receipt.play_accepted && receipt.filling);
        assert_eq!(receipt.queue_index, 17);
        assert_eq!(receipt.position, 3.0);
        assert_eq!(receipt.queued_count, 32);
        assert_eq!(receipt.total_count, 40);
        assert!(receipt.status.is_none());
        assert_eq!(receipt.volume, Some(0));
        tokio::time::timeout(Duration::from_secs(1), speaker.entered.notified())
            .await
            .unwrap();
        let snapshot =
            tokio::time::timeout(Duration::from_millis(500), speaker.controller.status())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        assert!(snapshot.status.playing && snapshot.filling);
        assert_eq!(snapshot.queued_count, 32);
        assert_eq!(snapshot.status.queue_index, 17);
        tokio::time::timeout(
            Duration::from_millis(500),
            speaker.controller.command("one", "pause", 0.0),
        )
        .await
        .unwrap()
        .unwrap();
        tokio::time::timeout(
            Duration::from_millis(500),
            speaker.controller.command("one", "volume", 20.0),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!speaker.state.lock().unwrap().playing);
        speaker.release.notify_one();
        let session = speaker.finished().await;
        assert_eq!(session.queued_count, 40);
        assert!(session.fill_error.is_none());
    }
    #[tokio::test]
    async fn fill_chains_receipts_without_rebrowsing_and_preserves_duplicate_entries() {
        let speaker = Speaker::new(None, None).await;
        let items: Vec<_> = tracks("duplicates", 2)
            .into_iter()
            .cycle()
            .take(40)
            .collect();
        speaker
            .controller
            .load("one".into(), &speaker.room, items.clone(), 0, 0.0, true)
            .await
            .unwrap();
        let session = speaker.finished().await;
        assert_eq!(session.queued_count, 40);
        assert!(session.fill_error.is_none());
        let state = speaker.state.lock().unwrap();
        assert_eq!(
            state.queue,
            items
                .iter()
                .map(|track| track.url.clone())
                .collect::<Vec<_>>()
        );
        // Server deliberately caps pages at seven entries. Reconciliation of
        // the initial sixteen happens once, not before each subsequent batch.
        assert_eq!(
            state
                .actions
                .iter()
                .filter(|a| a.as_str() == "Browse")
                .count(),
            3
        );
        assert_eq!(
            state
                .actions
                .iter()
                .filter(|a| a.as_str() == "AddMultipleURIsToQueue")
                .count(),
            4
        );
    }
    #[tokio::test]
    async fn inconsistent_append_receipt_stops_fill_and_resume_reconciles_without_replay() {
        let speaker = Speaker::new(None, None).await;
        speaker.state.lock().unwrap().bad_receipt_at = Some(16);
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 40), 0, 0.0, true)
            .await
            .unwrap();
        let failed = speaker.finished().await;
        assert_eq!(failed.queued_count, 16);
        assert!(failed.fill_error.unwrap().contains("receipt"));
        assert_eq!(speaker.state.lock().unwrap().queue.len(), 24);
        speaker.controller.resume_queue().await.unwrap();
        let resumed = speaker.finished().await;
        assert_eq!(resumed.queued_count, 40);
        assert!(resumed.fill_error.is_none());
        assert_eq!(
            speaker.state.lock().unwrap().queue,
            tracks("one", 40)
                .iter()
                .map(|track| track.url.clone())
                .collect::<Vec<_>>()
        );
    }
    #[tokio::test]
    async fn background_append_waits_for_pause_ack_and_then_resumes_in_small_chunks() {
        let speaker = Speaker::new(None, None).await;
        {
            let mut state = speaker.state.lock().unwrap();
            state.hold_action = Some("Browse".into());
            state.pause_delay_ms = 600;
        }
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 40), 0, 0.0, true)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), speaker.entered.notified())
            .await
            .unwrap();
        let controller = speaker.controller.clone();
        let pause = tokio::spawn(async move { controller.command("one", "pause", 0.0).await });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !speaker
                .state
                .lock()
                .unwrap()
                .actions
                .iter()
                .any(|action| action == "Pause")
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        speaker.release.notify_one();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!pause.is_finished());
        assert_eq!(speaker.state.lock().unwrap().queue.len(), 16);
        pause.await.unwrap().unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(speaker.state.lock().unwrap().queue.len(), 16);
        let session = speaker.finished().await;
        assert_eq!(session.queued_count, 40);
        assert!(session.fill_error.is_none());
        let state = speaker.state.lock().unwrap();
        assert!(!state.playing);
        assert_eq!(
            state
                .actions
                .iter()
                .filter(|action| *action == "AddMultipleURIsToQueue")
                .count(),
            4
        );
    }
    #[tokio::test]
    async fn slow_readonly_status_releases_transport_for_controls() {
        let speaker = Speaker::new(None, None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, true)
            .await
            .unwrap();
        speaker.state.lock().unwrap().stall_status = true;
        let started = std::time::Instant::now();
        assert!(speaker.controller.status().await.is_err());
        assert!(started.elapsed() < Duration::from_millis(1100));
        // The timed-out poll released transport serialization; Pause need not
        // wait for the server's abandoned read response.
        tokio::time::timeout(
            Duration::from_millis(500),
            speaker.controller.command("one", "pause", 0.0),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!speaker.state.lock().unwrap().playing);
    }
    #[tokio::test]
    async fn explicit_room_controls_do_not_wait_for_ownership_reads() {
        let speaker = Speaker::new(None, None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, true)
            .await
            .unwrap();
        {
            let mut state = speaker.state.lock().unwrap();
            state.stall_position = true;
            state.actions.clear();
        }
        for (command, value) in [
            ("pause", 0.0),
            ("volume", 37.0),
            ("play", 0.0),
            ("volume", 29.0),
        ] {
            tokio::time::timeout(
                Duration::from_millis(300),
                speaker.controller.command("one", command, value),
            )
            .await
            .unwrap()
            .unwrap();
        }
        let state = speaker.state.lock().unwrap();
        assert!(state.playing);
        assert_eq!(state.volume, 29.0);
        assert_eq!(state.actions, ["Pause", "SetVolume", "Play", "SetVolume"]);
    }
    #[tokio::test]
    async fn volume_cache_uses_acknowledged_room_ceiling() {
        let speaker = Speaker::new(None, None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, true)
            .await
            .unwrap();
        speaker
            .controller
            .0
            .client
            .set_volume_limits(super::super::groups::VolumeLimits {
                master: 20,
                rooms: [(speaker.room.id.clone(), 7)].into(),
            })
            .await
            .unwrap();
        speaker
            .controller
            .command("one", "volume", 50.0)
            .await
            .unwrap();
        assert_eq!(speaker.state.lock().unwrap().volume, 7.0);
        assert_eq!(
            speaker
                .controller
                .0
                .observation
                .lock()
                .unwrap()
                .volume
                .unwrap()
                .0,
            7
        );
    }
    #[tokio::test]
    async fn explicit_pause_does_not_wait_for_an_inflight_status_read() {
        let speaker = Speaker::new(None, None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, true)
            .await
            .unwrap();
        {
            let mut state = speaker.state.lock().unwrap();
            state.stall_position = true;
            state.actions.clear();
        }
        let controller = speaker.controller.clone();
        let status = tokio::spawn(async move { controller.status().await });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !speaker
                .state
                .lock()
                .unwrap()
                .actions
                .iter()
                .any(|action| action == "GetPositionInfo")
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        tokio::time::timeout(
            Duration::from_millis(300),
            speaker.controller.command("one", "pause", 0.0),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!speaker.state.lock().unwrap().playing);
        assert!(
            status.is_finished(),
            "UI reads only the cache even while SOAP is stalled"
        );
        for _ in 0..100 {
            assert!(speaker.controller.status().await.is_err());
        }
        tokio::time::sleep(Duration::from_millis(900)).await;
        assert_eq!(
            speaker
                .state
                .lock()
                .unwrap()
                .actions
                .iter()
                .filter(|action| *action == "GetPositionInfo")
                .count(),
            1,
            "Polling clients cannot cancel and reissue the single in-flight read"
        );
        assert!(status.await.unwrap().is_err());
    }
    #[tokio::test]
    async fn status_discards_a_pre_pause_response_instead_of_reverting_transport() {
        let speaker = Speaker::new(None, None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, true)
            .await
            .unwrap();
        {
            let mut state = speaker.state.lock().unwrap();
            state.status_delay_ms = 200;
            state.actions.clear();
        }
        let controller = speaker.controller.clone();
        let status = tokio::spawn(async move { controller.status().await });
        tokio::time::timeout(Duration::from_secs(1), async {
            while !speaker
                .state
                .lock()
                .unwrap()
                .actions
                .iter()
                .any(|action| action == "GetTransportInfo")
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        speaker
            .controller
            .command("one", "pause", 0.0)
            .await
            .unwrap();
        let error = match status.await.unwrap() {
            Err(error) => error,
            Ok(_) => panic!("Stale playing state was accepted after Pause"),
        };
        assert!(error.downcast_ref::<StatusPollSkipped>().is_some());
        assert!(!speaker.state.lock().unwrap().playing);
    }
    #[tokio::test]
    async fn automatic_disconnect_never_stops_a_foreign_source() {
        let speaker = Speaker::new(None, None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, true)
            .await
            .unwrap();
        {
            let mut state = speaker.state.lock().unwrap();
            state.queue[0] = "https://another.test/music.mp3".into();
            state.actions.clear();
        }
        speaker.controller.disconnect().await.unwrap();
        let state = speaker.state.lock().unwrap();
        assert!(state.playing);
        assert_eq!(state.actions, ["GetPositionInfo"]);
    }
    #[tokio::test]
    async fn explicit_pause_never_replays_a_lost_mutation_response() {
        let speaker = Speaker::new(None, None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, true)
            .await
            .unwrap();
        {
            let mut state = speaker.state.lock().unwrap();
            state.actions.clear();
            state.drop_action = Some("Pause".into());
        }
        assert!(
            speaker
                .controller
                .command("one", "pause", 0.0)
                .await
                .is_err()
        );
        tokio::time::sleep(Duration::from_millis(400)).await;
        let state = speaker.state.lock().unwrap();
        assert!(!state.playing);
        assert_eq!(
            state
                .actions
                .iter()
                .filter(|action| *action == "Pause")
                .count(),
            1
        );
        assert!(!state.actions.iter().any(|action| action == "Play"));
    }
    #[tokio::test]
    async fn submitted_pause_and_stop_supersede_autoplay_while_seek_is_in_flight() {
        for command in ["pause", "stop"] {
            let speaker = Speaker::new(None, None).await;
            speaker
                .controller
                .load("one".into(), &speaker.room, tracks("one", 4), 0, 0.0, false)
                .await
                .unwrap();
            {
                let mut state = speaker.state.lock().unwrap();
                state.actions.clear();
                state.hold_action = Some("Seek".into());
            }
            speaker.controller.submit("one", "track", 1.0).unwrap();
            tokio::time::timeout(Duration::from_secs(2), speaker.entered.notified())
                .await
                .unwrap();
            speaker.controller.submit("one", command, 0.0).unwrap();
            assert!(!speaker.controller.checkpoint().unwrap().pending_autoplay);
            speaker.release.notify_one();
            let session = speaker.submissions_finished().await;
            assert!(session.pending_track.is_none());
            let state = speaker.state.lock().unwrap();
            assert_eq!(state.index, 1);
            assert!(!state.playing);
            assert!(!state.actions.iter().any(|action| action == "Play"));
            assert_eq!(
                state
                    .actions
                    .iter()
                    .filter(|action| action.as_str()
                        == if command == "pause" { "Pause" } else { "Stop" })
                    .count(),
                1
            );
        }
    }
    #[tokio::test]
    async fn submitted_next_coalesces_while_seek_is_in_flight_with_bounded_work() {
        let speaker = Speaker::new(None, None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 4), 0, 0.0, false)
            .await
            .unwrap();
        {
            let mut state = speaker.state.lock().unwrap();
            state.actions.clear();
            state.selected_indices.clear();
            state.hold_action = Some("Seek".into());
        }
        speaker.controller.submit("one", "track", 1.0).unwrap();
        tokio::time::timeout(Duration::from_secs(2), speaker.entered.notified())
            .await
            .unwrap();
        speaker.controller.submit("one", "track", 2.0).unwrap();
        speaker.controller.submit("one", "track", 3.0).unwrap();
        for value in 0..=100 {
            speaker
                .controller
                .submit("one", "volume", value as f64)
                .unwrap();
        }
        assert_eq!(
            speaker
                .controller
                .0
                .submitted
                .lock()
                .unwrap()
                .pending
                .iter()
                .flatten()
                .count(),
            2
        );
        assert_eq!(
            speaker.controller.checkpoint().unwrap().pending_track,
            Some(3)
        );
        speaker.release.notify_one();
        speaker.submissions_finished().await;
        let state = speaker.state.lock().unwrap();
        assert_eq!(state.selected_indices, [1, 3]);
        assert_eq!(state.index, 3);
        assert!(state.playing);
        assert_eq!(state.volume, 100.0);
        assert_eq!(
            state
                .actions
                .iter()
                .filter(|action| action.as_str() == "Play")
                .count(),
            1
        );
        assert_eq!(
            state
                .actions
                .iter()
                .filter(|action| action.as_str() == "SetVolume")
                .count(),
            1
        );
    }
    #[tokio::test]
    async fn transitioning_selection_defers_before_mutation_and_pause_remains_effective() {
        let speaker = Speaker::new(None, None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 4), 0, 0.0, true)
            .await
            .unwrap();
        {
            let mut state = speaker.state.lock().unwrap();
            state.actions.clear();
            state.transitioning = true;
        }
        speaker.controller.submit("one", "track", 1.0).unwrap();
        tokio::time::timeout(Duration::from_secs(2), async {
            while speaker.controller.checkpoint().unwrap().retry.pending[SELECTION].is_none() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            !speaker
                .state
                .lock()
                .unwrap()
                .actions
                .iter()
                .any(|a| ["Seek", "Play"].contains(&a.as_str()))
        );
        speaker.controller.submit("one", "pause", 0.0).unwrap();
        speaker.submissions_finished().await;
        let state = speaker.state.lock().unwrap();
        assert_eq!(state.index, 1);
        assert!(!state.playing);
        assert!(!state.actions.iter().any(|a| a == "Play"));
    }
    #[tokio::test]
    async fn submitted_selection_does_not_replay_uncertain_seek_and_surfaces_error() {
        let speaker = Speaker::new(None, None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, false)
            .await
            .unwrap();
        {
            let mut state = speaker.state.lock().unwrap();
            state.actions.clear();
            state.drop_action = Some("Seek".into());
        }
        speaker.controller.submit("one", "track", 1.0).unwrap();
        let session = speaker.submissions_finished().await;
        assert!(session.retry.error.is_some());
        assert!(session.pending_track.is_none());
        tokio::time::sleep(Duration::from_millis(300)).await;
        let state = speaker.state.lock().unwrap();
        assert_eq!(
            state
                .actions
                .iter()
                .filter(|action| action.as_str() == "Seek")
                .count(),
            1
        );
        assert!(!state.actions.iter().any(|a| a == "Play"));
    }
    #[tokio::test]
    async fn submitted_controls_validate_before_registering_intent() {
        let speaker = Speaker::new(None, None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, false)
            .await
            .unwrap();
        let before = speaker.controller.checkpoint().unwrap();
        for (command, value) in [
            ("track", 0.5),
            ("track", 2.0),
            ("volume", 101.0),
            ("volume", f64::NAN),
            ("seek", -1.0),
            ("seek", f64::INFINITY),
        ] {
            assert!(speaker.controller.submit("one", command, value).is_err());
        }
        let after = speaker.controller.checkpoint().unwrap();
        assert_eq!(after.intent_revision, before.intent_revision);
        assert_eq!(after.retry.revisions, before.retry.revisions);
        assert!(after.retry.active.iter().all(|active| !active));
        assert!(!speaker.controller.0.submitted.lock().unwrap().running);
    }
    #[tokio::test]
    async fn deferred_selection_and_pause_do_not_double_seek_or_lose_pause() {
        let speaker = Speaker::new(None, None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, true)
            .await
            .unwrap();
        speaker.state.lock().unwrap().stall_position = true;
        speaker
            .controller
            .command("one", "track", 1.0)
            .await
            .unwrap();
        speaker
            .controller
            .command("one", "pause", 0.0)
            .await
            .unwrap();
        speaker.state.lock().unwrap().stall_position = false;
        let done = speaker.commands_finished().await;
        assert!(done.pending_track.is_none());
        assert!(done.retry.error.is_none());
        let snapshot = speaker.observed().await;
        assert!(snapshot.requested_playing.is_none());
        let state = speaker.state.lock().unwrap();
        assert_eq!(state.index, 1);
        assert!(!state.playing);
        assert_eq!(
            state
                .actions
                .iter()
                .filter(|action| *action == "Seek")
                .count(),
            2
        );
        assert_eq!(
            state
                .actions
                .iter()
                .filter(|action| *action == "Pause")
                .count(),
            1
        );
    }
    #[tokio::test]
    async fn deferred_control_does_not_replay_an_uncertain_mutation() {
        let speaker = Speaker::new(None, None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, true)
            .await
            .unwrap();
        speaker.state.lock().unwrap().actions.clear();
        speaker.state.lock().unwrap().stall_position = true;
        speaker
            .controller
            .command("one", "seek", 20.0)
            .await
            .unwrap();
        {
            let mut state = speaker.state.lock().unwrap();
            state.drop_action = Some("Seek".into());
            state.stall_position = false;
        }
        let done = speaker.commands_finished().await;
        assert!(done.retry.error.is_some());
        tokio::time::sleep(Duration::from_millis(400)).await;
        let state = speaker.state.lock().unwrap();
        assert!(state.playing);
        assert_eq!(
            state
                .actions
                .iter()
                .filter(|action| *action == "Seek")
                .count(),
            1
        );
    }
    #[tokio::test]
    async fn deferred_control_cannot_affect_a_replacement_session() {
        let speaker = Speaker::new(None, None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, true)
            .await
            .unwrap();
        speaker.state.lock().unwrap().actions.clear();
        speaker.state.lock().unwrap().stall_position = true;
        speaker
            .controller
            .command("one", "seek", 20.0)
            .await
            .unwrap();
        speaker.state.lock().unwrap().stall_position = false;
        speaker
            .controller
            .load("two".into(), &speaker.room, tracks("two", 2), 0, 0.0, true)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(400)).await;
        let state = speaker.state.lock().unwrap();
        assert!(state.playing);
        assert_eq!(
            state
                .actions
                .iter()
                .filter(|action| action.as_str() == "Seek")
                .count(),
            1,
            "Only the replacement load may seek"
        );
        assert_eq!(speaker.controller.checkpoint().unwrap().request_id, "two");
    }
    #[tokio::test]
    async fn queue_worker_hands_busy_selection_to_retry_without_stopping_tail() {
        let speaker = Speaker::new(Some(16), None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 40), 0, 0.0, true)
            .await
            .unwrap();
        speaker.entered.notified().await;
        speaker
            .controller
            .command("one", "track", 35.0)
            .await
            .unwrap();
        speaker.state.lock().unwrap().stall_position = true;
        speaker.release.notify_one();
        let filled = speaker.finished().await;
        assert_eq!(filled.queued_count, 40);
        assert!(filled.fill_error.is_none());
        assert!(filled.retry.pending[SELECTION].is_some());
        speaker
            .controller
            .command("one", "pause", 0.0)
            .await
            .unwrap();
        speaker.state.lock().unwrap().stall_position = false;
        let done = speaker.commands_finished().await;
        assert!(done.pending_track.is_none());
        assert!(done.retry.error.is_none());
        let state = speaker.state.lock().unwrap();
        assert_eq!(state.index, 35);
        assert!(!state.playing);
        assert_eq!(
            state
                .actions
                .iter()
                .filter(|action| *action == "Seek")
                .count(),
            2
        );
    }
    #[tokio::test]
    async fn deferred_control_deadline_clears_intent_and_surfaces_error() {
        let speaker = Speaker::new(None, None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, true)
            .await
            .unwrap();
        speaker.state.lock().unwrap().actions.clear();
        speaker.state.lock().unwrap().stall_position = true;
        speaker
            .controller
            .command("one", "seek", 20.0)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(18), async {
            while speaker.controller.checkpoint().unwrap().retry.pending[SEEK].is_some() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        speaker.state.lock().unwrap().stall_position = false;
        let snapshot = speaker.observed().await;
        assert!(snapshot.requested_playing.is_none());
        assert!(
            snapshot
                .control_error
                .as_deref()
                .unwrap()
                .contains("could not be sent")
        );
        assert!(
            !speaker
                .state
                .lock()
                .unwrap()
                .actions
                .iter()
                .any(|action| action == "Seek")
        );
    }
    #[tokio::test]
    async fn selecting_while_playing_preserves_transport_without_redundant_play() {
        let speaker = Speaker::new(None, None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, true)
            .await
            .unwrap();
        speaker.state.lock().unwrap().actions.clear();
        speaker
            .controller
            .command("one", "track", 1.0)
            .await
            .unwrap();
        {
            let state = speaker.state.lock().unwrap();
            assert_eq!(state.index, 1);
            assert!(state.playing);
            assert!(!state.actions.iter().any(|action| action == "Play"));
        }
        speaker
            .controller
            .command("one", "pause", 0.0)
            .await
            .unwrap();
        speaker
            .controller
            .command("one", "track", 0.0)
            .await
            .unwrap();
        let state = speaker.state.lock().unwrap();
        assert_eq!(state.index, 0);
        assert!(state.playing);
        assert_eq!(
            state
                .actions
                .iter()
                .filter(|action| *action == "Play")
                .count(),
            1,
            "A selection from paused still needs Play"
        );
    }
    #[tokio::test]
    async fn incomplete_position_is_transient_and_does_not_abandon_or_mutate_session() {
        let speaker = Speaker::new(None, None).await;
        let tracks = tracks("one", 2);
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks.clone(), 0, 0.0, true)
            .await
            .unwrap();
        speaker.state.lock().unwrap().incomplete_position = true;
        let status = speaker
            .controller
            .0
            .client
            .status(&speaker.room, &tracks)
            .await
            .unwrap();
        assert!(!status.owned);
        assert_eq!(
            status.state, "TRANSITIONING",
            "Missing current URI is not evidence of a foreign source"
        );
        assert!(
            speaker
                .controller
                .0
                .client
                .reconnect(&speaker.room, &tracks, &interfaces())
                .await
                .is_err(),
            "Restore must remain retryable while the track is unknown"
        );
        speaker.state.lock().unwrap().actions.clear();
        speaker
            .controller
            .command("one", "track", 1.0)
            .await
            .unwrap();
        assert!(speaker.controller.checkpoint().unwrap().retry.pending[SELECTION].is_some());
        assert!(
            !speaker
                .state
                .lock()
                .unwrap()
                .actions
                .iter()
                .any(|a| ["Seek", "Play", "Pause"].contains(&a.as_str()))
        );
        speaker.state.lock().unwrap().incomplete_position = false;
        let done = speaker.commands_finished().await;
        assert!(done.retry.error.is_none());
        let state = speaker.state.lock().unwrap();
        assert_eq!(state.index, 1);
        assert_eq!(state.actions.iter().filter(|a| *a == "Seek").count(), 1);
    }
    #[tokio::test]
    async fn observer_reads_fresh_transport_after_position_held_during_buffering() {
        let speaker = Speaker::new(None, None).await;
        {
            let mut state = speaker.state.lock().unwrap();
            state.transitioning = true;
            state.hold_action = Some("GetPositionInfo".into());
        }
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, true)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), speaker.entered.notified())
            .await
            .unwrap();
        // Audio starts while the position reply is held. A state read taken
        // before it would remain TRANSITIONING for an unnecessary whole cycle.
        speaker.state.lock().unwrap().transitioning = false;
        assert!(
            speaker.controller.status().await.is_err(),
            "No Play ACK is a position observation"
        );
        speaker.release.notify_one();
        let snapshot = tokio::time::timeout(Duration::from_millis(350), speaker.observed())
            .await
            .unwrap();
        assert_eq!(snapshot.status.state, "PLAYING");
        assert!(snapshot.status.owned);
        let state = speaker.state.lock().unwrap();
        let reads: Vec<_> = state
            .actions
            .iter()
            .filter(|a| *a == "GetPositionInfo" || *a == "GetTransportInfo")
            .map(String::as_str)
            .collect();
        assert_eq!(reads, ["GetPositionInfo", "GetTransportInfo"]);
    }

    #[tokio::test]
    async fn position_timestamp_is_not_reset_by_slow_transport_state_read() {
        let speaker = Speaker::new(None, None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, true)
            .await
            .unwrap();
        assert!(speaker.observed().await.status.playing);
        let prior_sample = speaker
            .controller
            .0
            .observation
            .lock()
            .unwrap()
            .status
            .as_ref()
            .unwrap()
            .1;
        speaker.state.lock().unwrap().hold_action = Some("GetTransportInfo".into());
        speaker
            .controller
            .0
            .observer_wake
            .lock()
            .unwrap()
            .notify_one();
        tokio::time::timeout(Duration::from_secs(1), speaker.entered.notified())
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(180)).await;
        speaker.release.notify_one();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if speaker
                    .controller
                    .0
                    .observation
                    .lock()
                    .unwrap()
                    .status
                    .as_ref()
                    .unwrap()
                    .1
                    > prior_sample
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let snapshot = speaker.observed().await;
        assert!(
            snapshot.status.position >= 2.18,
            "Position receipt age must include the trailing state read: {}",
            snapshot.status.position
        );
        assert!(snapshot.status.position < 3.0);
        let observation = speaker.controller.0.observation.lock().unwrap();
        assert!(observation.status.as_ref().unwrap().1.elapsed() >= Duration::from_millis(180));
    }

    #[tokio::test]
    async fn first_playing_does_not_count_slow_state_read_as_buffered_audio() {
        let speaker = Speaker::new(None, None).await;
        speaker.state.lock().unwrap().hold_action = Some("GetPositionInfo".into());
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, true)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), speaker.entered.notified())
            .await
            .unwrap();
        speaker.state.lock().unwrap().transitioning = true;
        speaker.release.notify_one();
        assert_eq!(speaker.observed().await.status.state, "TRANSITIONING");
        {
            let mut state = speaker.state.lock().unwrap();
            state.transitioning = false;
            state.hold_action = Some("GetTransportInfo".into());
        }
        speaker
            .controller
            .0
            .observer_wake
            .lock()
            .unwrap()
            .notify_one();
        tokio::time::timeout(Duration::from_secs(1), speaker.entered.notified())
            .await
            .unwrap();
        // The old position alone cannot establish how much of this delay was
        // buffering. A newly confirmed PLAYING reply must not add all of it.
        tokio::time::sleep(Duration::from_millis(300)).await;
        speaker.release.notify_one();
        let snapshot = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let snapshot = speaker.observed().await;
                if snapshot.status.playing {
                    break snapshot;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(snapshot.status.position >= 2.0);
        assert!(
            snapshot.status.position < 2.15,
            "Unconfirmed buffering counted as playback: {}",
            snapshot.status.position
        );
        assert!(
            speaker
                .controller
                .0
                .observation
                .lock()
                .unwrap()
                .status
                .as_ref()
                .unwrap()
                .1
                .elapsed()
                < Duration::from_millis(150)
        );
    }

    #[tokio::test]
    async fn paused_position_does_not_extrapolate_during_slow_transport_state_read() {
        let speaker = Speaker::new(None, None).await;
        speaker.state.lock().unwrap().hold_action = Some("GetTransportInfo".into());
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, false)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), speaker.entered.notified())
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(180)).await;
        speaker.release.notify_one();
        let snapshot = speaker.observed().await;
        assert_eq!(snapshot.status.state, "PAUSED_PLAYBACK");
        assert_eq!(snapshot.status.position, 2.0);
    }

    #[tokio::test]
    async fn observer_wakes_after_pause_ack_without_waiting_for_stable_poll() {
        let speaker = Speaker::new(None, None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, true)
            .await
            .unwrap();
        assert_eq!(speaker.observed().await.status.state, "PLAYING");
        speaker.state.lock().unwrap().actions.clear();
        speaker
            .controller
            .command("one", "pause", 0.0)
            .await
            .unwrap();
        let snapshot = tokio::time::timeout(Duration::from_millis(350), speaker.observed())
            .await
            .unwrap();
        assert_eq!(snapshot.status.state, "PAUSED_PLAYBACK");
        let state = speaker.state.lock().unwrap();
        assert_eq!(state.actions.iter().filter(|a| *a == "Pause").count(), 1);
        assert_eq!(
            state
                .actions
                .iter()
                .filter(|a| *a == "GetTransportInfo")
                .count(),
            1
        );
    }
    #[tokio::test]
    async fn observer_coalesces_control_wakes_without_canceling_in_flight_read() {
        let speaker = Speaker::new(None, None).await;
        speaker.state.lock().unwrap().hold_action = Some("GetTransportInfo".into());
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, true)
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), speaker.entered.notified())
            .await
            .unwrap();
        for command in ["pause", "play", "pause"] {
            speaker
                .controller
                .command("one", command, 0.0)
                .await
                .unwrap();
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            speaker
                .state
                .lock()
                .unwrap()
                .actions
                .iter()
                .filter(|a| *a == "GetTransportInfo")
                .count(),
            1
        );
        speaker.release.notify_one();
        let snapshot = tokio::time::timeout(Duration::from_millis(350), speaker.observed())
            .await
            .unwrap();
        assert_eq!(snapshot.status.state, "PAUSED_PLAYBACK");
        tokio::time::sleep(Duration::from_millis(300)).await;
        let state = speaker.state.lock().unwrap();
        assert_eq!(
            state
                .actions
                .iter()
                .filter(|a| *a == "GetTransportInfo")
                .count(),
            2
        );
        assert_eq!(state.actions.iter().filter(|a| *a == "Pause").count(), 2);
        assert_eq!(state.actions.iter().filter(|a| *a == "Play").count(), 2);
    }
    #[tokio::test]
    async fn observer_polls_transitioning_faster_then_returns_to_stable_cadence() {
        let speaker = Speaker::new(None, None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 0.0, true)
            .await
            .unwrap();
        speaker.observed().await;
        speaker.state.lock().unwrap().transitioning = true;
        speaker
            .controller
            .0
            .observer_wake
            .lock()
            .unwrap()
            .notify_one();
        tokio::time::timeout(Duration::from_millis(350), async {
            loop {
                if speaker.observed().await.status.state == "TRANSITIONING" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        speaker.state.lock().unwrap().transitioning = false;
        tokio::time::timeout(Duration::from_millis(500), async {
            loop {
                if speaker.observed().await.status.state == "PLAYING" {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        speaker.state.lock().unwrap().actions.clear();
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(
            !speaker
                .state
                .lock()
                .unwrap()
                .actions
                .iter()
                .any(|a| a == "GetTransportInfo")
        );
    }
    #[tokio::test]
    async fn stalled_observer_does_not_fan_out_or_force_tail_after_two_seconds() {
        let speaker = Speaker::new(None, None).await;
        speaker.state.lock().unwrap().hold_action = Some("GetTransportInfo".into());
        speaker.state.lock().unwrap().volume = 27.0;
        let receipt = speaker
            .controller
            .load(
                "one".into(),
                &speaker.room,
                tracks("one", 40),
                3,
                25.0,
                true,
            )
            .await
            .unwrap();
        assert_eq!(receipt.volume, Some(27));
        for _ in 0..30 {
            let _ = speaker.controller.status().await;
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        {
            let state = speaker.state.lock().unwrap();
            assert_eq!(
                state.queue.len(),
                16,
                "An unresponsive renderer must not receive forced tail writes"
            );
            assert_eq!(
                state
                    .actions
                    .iter()
                    .filter(|a| *a == "GetTransportInfo")
                    .count(),
                1
            );
            assert_eq!(
                state.actions.iter().filter(|a| *a == "GetVolume").count(),
                1
            );
            assert!(!state.actions.iter().any(|a| a == "Browse"));
        }
        tokio::time::timeout(
            Duration::from_millis(300),
            speaker.controller.command("one", "pause", 0.0),
        )
        .await
        .unwrap()
        .unwrap();
        // Replacement cancels only this obsolete read; it need not wait for its
        // five-second HTTP deadline, and the old observer cannot overwrite it.
        tokio::time::timeout(
            Duration::from_millis(500),
            speaker
                .controller
                .load("two".into(), &speaker.room, tracks("two", 2), 0, 0.0, false),
        )
        .await
        .unwrap()
        .unwrap();
        speaker.release.notify_one();
        let state = speaker.state.lock().unwrap();
        assert!(!state.playing);
        assert_eq!(
            state.actions.iter().filter(|a| *a == "Play").count(),
            1,
            "Paused output transfer must not briefly play"
        );
    }
    #[tokio::test]
    async fn startup_receipt_returns_ack_when_initial_status_is_slow() {
        let speaker = Speaker::new(None, None).await;
        speaker.state.lock().unwrap().stall_status = true;
        let started = std::time::Instant::now();
        let receipt = speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 2), 0, 7.9, true)
            .await
            .unwrap();
        assert!(started.elapsed() < Duration::from_millis(1100));
        assert!(receipt.play_accepted);
        assert!(receipt.status.is_none());
        assert_eq!(receipt.position, 7.0);
        assert!(!receipt.filling);
    }
    #[tokio::test]
    async fn replacement_and_disconnect_drain_old_append_before_mutating_queue() {
        for replace in [true, false] {
            let speaker = Speaker::new(Some(16), None).await;
            speaker
                .controller
                .load("old".into(), &speaker.room, tracks("old", 40), 0, 0.0, true)
                .await
                .unwrap();
            speaker.entered.notified().await;
            let controller = speaker.controller.clone();
            let room = speaker.room.clone();
            let task = tokio::spawn(async move {
                if replace {
                    controller
                        .load("new".into(), &room, tracks("new", 2), 0, 0.0, true)
                        .await
                        .map(|_| ())
                } else {
                    controller.disconnect().await
                }
            });
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert!(!task.is_finished());
            assert_eq!(speaker.state.lock().unwrap().queue.len(), 24);
            speaker.release.notify_one();
            task.await.unwrap().unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
            let state = speaker.state.lock().unwrap();
            if replace {
                assert_eq!(
                    state.queue,
                    tracks("new", 2)
                        .iter()
                        .map(|t| t.url.clone())
                        .collect::<Vec<_>>()
                );
            } else {
                assert_eq!(state.queue.len(), 24);
                assert!(!state.playing);
                assert!(speaker.controller.checkpoint().is_err());
            }
        }
    }
    #[tokio::test]
    async fn uncertain_append_restore_reconciles_native_prefix_without_duplicates_or_play() {
        let speaker = Speaker::new(None, Some(16)).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 40), 0, 0.0, true)
            .await
            .unwrap();
        let failed = speaker.finished().await;
        assert!(failed.fill_error.is_some());
        assert_eq!(failed.queued_count, 16);
        assert_eq!(speaker.state.lock().unwrap().queue.len(), 24);
        assert!(speaker.state.lock().unwrap().playing);
        speaker.state.lock().unwrap().playing = false;
        speaker.state.lock().unwrap().actions.clear();
        let snapshot = speaker
            .controller
            .restore(failed, &interfaces())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(snapshot.queued_count, 24);
        assert!(!snapshot.status.playing);
        let restored = speaker.finished().await;
        assert_eq!(restored.queued_count, 40);
        assert!(restored.fill_error.is_none());
        let state = speaker.state.lock().unwrap();
        assert_eq!(
            state.queue,
            tracks("one", 40)
                .iter()
                .map(|t| t.url.clone())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            state
                .actions
                .iter()
                .filter(|a| a.as_str() == "AddMultipleURIsToQueue")
                .count(),
            2
        );
        assert!(!state.actions.iter().any(|a|["Stop","Play","Seek","RemoveAllTracksFromQueue"].contains(&a.as_str())));
    }
    #[tokio::test]
    async fn foreground_resume_reconciles_without_resetting_session_or_paused_intent() {
        let speaker = Speaker::new(None, Some(16)).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 40), 0, 0.0, true)
            .await
            .unwrap();
        let failed = speaker.finished().await;
        assert!(failed.fill_error.is_some());
        speaker
            .controller
            .command("one", "pause", 0.0)
            .await
            .unwrap();
        speaker.state.lock().unwrap().actions.clear();
        speaker.controller.resume_queue().await.unwrap();
        let resumed = speaker.finished().await;
        assert_eq!(resumed.request_id, "one");
        assert_eq!(resumed.queued_count, 40);
        assert!(!resumed.pending_autoplay);
        assert!(resumed.fill_error.is_none());
        let state = speaker.state.lock().unwrap();
        assert!(!state.playing);
        assert_eq!(state.queue.len(), 40);
        assert!(!state.actions.iter().any(|a| ["Stop", "Play", "Seek", "RemoveAllTracksFromQueue"].contains(&a.as_str())));
    }
    #[tokio::test]
    async fn restore_refuses_a_foreign_tail_even_when_current_track_is_owned() {
        let speaker = Speaker::new(None, Some(16)).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 40), 0, 0.0, true)
            .await
            .unwrap();
        let saved = speaker.finished().await;
        {
            let mut state = speaker.state.lock().unwrap();
            *state.queue.last_mut().unwrap() = "https://other.test/music.mp3".into();
            state.actions.clear();
        }
        assert!(
            speaker
                .controller
                .restore(saved, &interfaces())
                .await
                .is_err()
        );
        let state = speaker.state.lock().unwrap();
        assert!(!state.actions.iter().any(|a| {
            [
                "Stop",
                "Play",
                "Seek",
                "AddMultipleURIsToQueue",
                "RemoveAllTracksFromQueue",
            ]
            .contains(&a.as_str())
        }));
    }
    #[tokio::test]
    async fn deferred_selection_coalesces_and_pause_prevents_late_autoplay() {
        let speaker = Speaker::new(Some(16), None).await;
        speaker
            .controller
            .load("one".into(), &speaker.room, tracks("one", 40), 0, 0.0, true)
            .await
            .unwrap();
        speaker.entered.notified().await;
        for index in [33.0, 35.0] {
            tokio::time::timeout(
                Duration::from_millis(500),
                speaker.controller.command("one", "track", index),
            )
            .await
            .unwrap()
            .unwrap();
        }
        tokio::time::timeout(
            Duration::from_millis(500),
            speaker.controller.command("one", "pause", 0.0),
        )
        .await
        .unwrap()
        .unwrap();
        speaker.release.notify_one();
        speaker.finished().await;
        let snapshot = speaker.observed().await;
        assert_eq!(snapshot.status.queue_index, 35);
        assert!(!snapshot.status.playing);
        assert!(snapshot.pending_queue_index.is_none());
        let state = speaker.state.lock().unwrap();
        assert_eq!(
            state
                .actions
                .iter()
                .filter(|a| a.as_str() == "Seek")
                .count(),
            2
        );
    }
}
