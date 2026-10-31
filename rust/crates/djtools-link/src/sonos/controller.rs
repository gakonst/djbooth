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
