//! Local Sonos control shared by embedded and desktop clients. Uses the same
//! topology/coordinator and SOAP flow as packages/djbooth/src/sonos.ts.
//! Speakers fetch scoped cloud URLs themselves; Swift implements no protocol.
use anyhow::{Context, Result, bail, ensure};
use quick_xml::{Reader, events::Event};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    net::Ipv4Addr,
    time::Duration,
};
use tokio::{net::TcpStream, task::JoinSet, time::timeout};

const STATUS_TIMEOUT: Duration = Duration::from_millis(750);
/// Only this error guarantees a command has sent no transport mutation.
#[derive(Debug)]
struct OwnershipReadPending;
impl std::fmt::Display for OwnershipReadPending {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Sonos current track is temporarily unavailable before sending the command")
    }
}
impl std::error::Error for OwnershipReadPending {}
const AV: &str = "urn:schemas-upnp-org:service:AVTransport:1";
const TOPOLOGY: &str = "urn:schemas-upnp-org:service:ZoneGroupTopology:1";
const CONTENT: &str = "urn:schemas-upnp-org:service:ContentDirectory:1";
const RENDER: &str = "urn:schemas-upnp-org:service:RenderingControl:1";

mod controller;
pub mod groups;
pub mod local_media;
pub use controller::{Controller, LoadReceipt, Session, Snapshot, StatusPollSkipped};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    pub id: String,
    pub name: String,
    pub ip: Ipv4Addr,
    pub coordinator: Ipv4Addr,
    pub coordinator_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    pub url: String,
    pub title: String,
    #[serde(default)]
    pub artist: String,
    pub mime: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub playing: bool,
    pub state: String,
    pub position: f64,
    pub duration: f64,
    pub queue_index: usize,
    pub owned: bool,
    pub volume: u8,
}
/// Authoritative queue length and revision returned by the renderer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QueueRevision {
    pub count: usize,
    pub update_id: u32,
}
fn queue_number(response: &str, field: &str) -> Result<u32> {
    element(response, field)
        .with_context(|| format!("Missing Sonos {field}"))?
        .parse()
        .with_context(|| format!("Invalid Sonos {field}"))
}
#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    port: u16,
    groups: std::sync::Arc<groups::GroupControl>,
}
async fn retry_connect<F, Fut>(
    ip: Ipv4Addr,
    action: &str,
    mut send: F,
) -> reqwest::Result<reqwest::Response>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = reqwest::Result<reqwest::Response>>,
{
    let response = send().await;
    // A connect error guarantees no SOAP request reached the renderer. Retry
    // that case once after letting the phone's local-network route settle.
    // Never replay a queue mutation after an uncertain send/response failure.
    if response.as_ref().is_err_and(reqwest::Error::is_connect) {
        tracing::warn!(%ip, action, "Sonos connection failed before request; retrying once");
        tokio::time::sleep(Duration::from_millis(100)).await;
        return send().await;
    }
    response
}
impl Client {
    pub fn new() -> Result<Self> {
        Ok(Self {
            port: 1400,
            groups: Default::default(),
            http: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(5))
                .build()?,
        })
    }
    async fn text(&self, mut response: reqwest::Response) -> Result<String> {
        let status = response.status();
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                bytes.len() + chunk.len() <= 2 * 1024 * 1024,
                "Sonos response is too large"
            );
            bytes.extend_from_slice(&chunk);
        }
        let text = String::from_utf8(bytes)?;
        ensure!(
            status.is_success(),
            "Sonos returned HTTP {status}: {}",
            element(&text, "errorCode").unwrap_or_default()
        );
        Ok(text)
    }
    async fn soap(
        &self,
        ip: Ipv4Addr,
        service: &str,
        action: &str,
        args: &[(&str, String)],
    ) -> Result<String> {
        let path = match service {
            TOPOLOGY => "/ZoneGroupTopology/Control",
            RENDER => "/MediaRenderer/RenderingControl/Control",
            CONTENT => "/MediaServer/ContentDirectory/Control",
            _ => "/MediaRenderer/AVTransport/Control",
        };
        let parameters = args
            .iter()
            .map(|(key, value)| format!("<{key}>{}</{key}>", xml(value)))
            .collect::<String>();
        let body = format!(
            "<?xml version=\"1.0\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{action} xmlns:u=\"{service}\">{parameters}</u:{action}></s:Body></s:Envelope>"
        );
        let started = std::time::Instant::now();
        tracing::info!(%ip, action, "Sonos request started");
        let send = || {
            self.http
                .post(format!("http://{ip}:{}{path}", self.port))
                .header("content-type", "text/xml; charset=utf-8")
                .header("soapaction", format!("\"{service}#{action}\""))
                .body(body.clone())
                .timeout(Duration::from_secs(if action == "AddMultipleURIsToQueue" {
                    15
                } else {
                    5
                }))
                .send()
        };
        let response = retry_connect(ip, action, send).await;
        let result = match response {
            Ok(response) => self
                .text(response)
                .await
                .with_context(|| format!("Sonos {action} at {ip} failed")),
            Err(error) => {
                Err(error).with_context(|| format!("Sonos {action} at {ip} did not respond"))
            }
        };
        if let Err(error) = &result {
            tracing::warn!(%ip, action, error = %error, "Sonos request failed");
        }
        tracing::info!(%ip, action, elapsed_ms = started.elapsed().as_millis() as u64, ok = result.is_ok(), "Sonos request finished");
        result
    }
    async fn av(&self, ip: Ipv4Addr, action: &str, values: &[(&str, String)]) -> Result<String> {
        let mut args = vec![("InstanceID", "0".into())];
        args.extend_from_slice(values);
        self.soap(ip, AV, action, &args).await
    }
    pub async fn rooms(&self, ip: Ipv4Addr) -> Result<Vec<Room>> {
        let response = self.soap(ip, TOPOLOGY, "GetZoneGroupState", &[]).await?;
        parse_topology(&element(&response, "ZoneGroupState").context("Missing Sonos topology")?)
    }
    /// Bounded unicast fallback also works on iOS without multicast entitlement.
    /// Discovery runs on demand, never as an idle background subnet poll.
    pub async fn discover(&self, interfaces: &[crate::DjLinkInterface]) -> Result<Vec<Room>> {
        let mut peers = Vec::new();
        let mut ordered: Vec<_> = interfaces.iter().collect();
        ordered.sort_by_key(|interface| interface.ip.is_link_local());
        for interface in ordered {
            if !(interface.ip.is_private() || interface.ip.is_link_local()) {
                continue;
            }
            peers.extend(
                crate::discovery::neighbours(Some(&interface.name))
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|ip| {
                        crate::discovery::usable_peer(interface.ip, interface.netmask, *ip)
                    }),
            );
            let mask = u32::from(interface.netmask).max(0xffff_fc00);
            let network = u32::from(interface.ip) & mask;
            peers.extend(
                (network + 1..(network | !mask))
                    .map(Ipv4Addr::from)
                    .filter(|ip| *ip != interface.ip),
            );
        }
        let mut seen = HashSet::new();
        peers.retain(|ip| seen.insert(*ip));
        let mut peers = peers.into_iter();
        let mut pending = JoinSet::new();
        loop {
            while pending.len() < 32 {
                let Some(ip) = peers.next() else { break };
                let client = self.clone();
                pending.spawn(async move {
                    timeout(
                        Duration::from_millis(300),
                        TcpStream::connect((ip, client.port)),
                    )
                    .await
                    .ok()?
                    .ok()?;
                    let response = client
                        .http
                        .get(format!(
                            "http://{ip}:{}/xml/device_description.xml",
                            client.port
                        ))
                        .send()
                        .await
                        .ok()?;
                    let text = client.text(response).await.ok()?;
                    (element(&text, "manufacturer").as_deref() == Some("Sonos, Inc.")).then_some(ip)
                });
            }
            let Some(result) = pending.join_next().await else {
                break;
            };
            if let Ok(Some(ip)) = result {
                if let Ok(rooms) = self.rooms(ip).await {
                    let rooms: Vec<_> = rooms
                        .into_iter()
                        .filter(|room| {
                            interfaces.iter().any(|interface| {
                                crate::discovery::usable_peer(
                                    interface.ip,
                                    interface.netmask,
                                    room.ip,
                                ) && crate::discovery::usable_peer(
                                    interface.ip,
                                    interface.netmask,
                                    room.coordinator,
                                )
                            })
                        })
                        .collect();
                    if !rooms.is_empty() {
                        pending.abort_all();
                        return Ok(rooms);
                    }
                }
            }
        }
        Ok(vec![])
    }
    pub async fn load(
        &self,
        room: &Room,
        tracks: &[Track],
        index: usize,
        position: f64,
        autoplay: bool,
    ) -> Result<Room> {
        ensure!(
            !tracks.is_empty() && tracks.len() <= 2000 && index < tracks.len(),
            "Invalid Sonos queue"
        );
        for track in tracks {
            let url = reqwest::Url::parse(&track.url)?;
            ensure!(
                ["http", "https"].contains(&url.scheme())
                    && !track.url.chars().any(char::is_whitespace),
                "Invalid Sonos media URL"
            );
        }
        let current = self
            .rooms(room.ip)
            .await?
            .into_iter()
            .find(|r| r.id == room.id)
            .context("Sonos room disappeared")?;
        let ip = current.coordinator;
        self.av(ip, "Stop", &[]).await?;
        self.av(ip, "RemoveAllTracksFromQueue", &[]).await?;
        // Native queue playback keeps advancing even when the phone is asleep.
        // Finish this requested prefix before switching transport. Controller
        // fills the remaining entries asynchronously after this call returns.
        for chunk in tracks.chunks(16) {
            self.append(&current, chunk).await?;
        }
        // Set queue mode before changing source. Source activation can begin
        // media resolution on legacy players; keep URI -> track Seek -> Play
        // contiguous so a settings request does not delay selecting the track.
        self.av(ip, "SetPlayMode", &[("NewPlayMode", "NORMAL".into())])
            .await?;
        self.av(
            ip,
            "SetAVTransportURI",
            &[
                (
                    "CurrentURI",
                    format!("x-rincon-queue:{}#0", current.coordinator_id),
                ),
                ("CurrentURIMetaData", String::new()),
            ],
        )
        .await?;
        self.av(
            ip,
            "Seek",
            &[
                ("Unit", "TRACK_NR".into()),
                ("Target", (index + 1).to_string()),
            ],
        )
        .await?;
        if position > 0.0 {
            self.seek(ip, position).await?;
        }
        if autoplay {
            self.av(ip, "Play", &[("Speed", "1".into())]).await?;
        }
        tracing::info!(
            queue_index = index,
            total = tracks.len(),
            "Sonos queue ready"
        );
        Ok(current)
    }
    /// Append exactly once; an uncertain response must be reconciled by reading
    /// the native queue, never by blindly repeating this mutation.
    pub async fn append(&self, room: &Room, tracks: &[Track]) -> Result<QueueRevision> {
        self.append_at(room, tracks, None).await
    }
    /// Carry the observed update ID forward and check the renderer's receipt.
    /// A rejected/malformed/uncertain response stops filling; only a fresh
    /// prefix reconciliation may resume it. Legacy firmware's rejection of a
    /// stale UpdateID must be verified rather than inferred from the schema.
    pub async fn append_at(
        &self,
        room: &Room,
        tracks: &[Track],
        expected: Option<QueueRevision>,
    ) -> Result<QueueRevision> {
        ensure!(
            !tracks.is_empty() && tracks.len() <= 16,
            "Invalid Sonos queue batch"
        );
        let ip = room.coordinator;
        let response = self
            .av(
                ip,
                "AddMultipleURIsToQueue",
                &[
                    (
                        "UpdateID",
                        expected.map_or(0, |queue| queue.update_id).to_string(),
                    ),
                    ("NumberOfURIs", tracks.len().to_string()),
                    (
                        "EnqueuedURIs",
                        tracks
                            .iter()
                            .map(|t| t.url.as_str())
                            .collect::<Vec<_>>()
                            .join(" "),
                    ),
                    (
                        "EnqueuedURIsMetaData",
                        tracks.iter().map(metadata).collect::<Vec<_>>().join(" "),
                    ),
                    ("ContainerURI", String::new()),
                    ("ContainerMetaData", String::new()),
                    ("DesiredFirstTrackNumberEnqueued", "0".into()),
                    ("EnqueueAsNext", "0".into()),
                ],
            )
            .await?;
        let first = queue_number(&response, "FirstTrackNumberEnqueued")? as usize;
        let added = queue_number(&response, "NumTracksAdded")? as usize;
        let queue = QueueRevision {
            count: queue_number(&response, "NewQueueLength")? as usize,
            update_id: queue_number(&response, "NewUpdateID")?,
        };
        ensure!(
            added == tracks.len() && first > 0 && first.checked_add(added - 1) == Some(queue.count),
            "Sonos append receipt does not match the requested tail"
        );
        if let Some(expected) = expected {
            ensure!(
                first == expected.count + 1 && queue.count == expected.count + added,
                "Sonos queue changed during append"
            );
        }
        Ok(queue)
    }
    /// Read every native queue entry (including repeated URLs) before resuming a
    /// partial fill. Sonos may return fewer entries than RequestedCount.
    pub async fn queue_prefix_len(&self, room: &Room, tracks: &[Track]) -> Result<usize> {
        Ok(self.queue_prefix(room, tracks).await?.count)
    }
    pub async fn queue_prefix(&self, room: &Room, tracks: &[Track]) -> Result<QueueRevision> {
        let mut offset = 0;
        let mut revision = None;
        loop {
            let response = self
                .soap(
                    room.coordinator,
                    CONTENT,
                    "Browse",
                    &[
                        ("ObjectID", "Q:0".into()),
                        ("BrowseFlag", "BrowseDirectChildren".into()),
                        ("Filter", "res".into()),
                        ("StartingIndex", offset.to_string()),
                        ("RequestedCount", "100".into()),
                        ("SortCriteria", String::new()),
                    ],
                )
                .await?;
            let update_id = queue_number(&response, "UpdateID")?;
            ensure!(
                revision.is_none_or(|previous| previous == update_id),
                "Sonos queue changed while reading"
            );
            revision = Some(update_id);
            let total = element(&response, "TotalMatches")
                .context("Missing Sonos queue length")?
                .parse::<usize>()?;
            let returned = element(&response, "NumberReturned")
                .context("Missing Sonos queue page length")?
                .parse::<usize>()?;
            ensure!(
                total <= tracks.len() && offset + returned <= total,
                "Sonos queue belongs to another source"
            );
            let document = element(&response, "Result").context("Missing Sonos queue items")?;
            let mut reader = Reader::from_str(&document);
            let mut urls = Vec::new();
            loop {
                match reader.read_event()? {
                    Event::Start(tag) if tag.local_name().as_ref() == b"item" => {
                        let item = reader.read_text(tag.name())?;
                        urls.push(
                            element(&item, "res").context("Sonos queue entry has no media URL")?,
                        );
                    }
                    Event::Eof => break,
                    _ => (),
                }
            }
            ensure!(urls.len() == returned, "Sonos queue page is incomplete");
            for (index, url) in urls.iter().enumerate() {
                ensure!(
                    tracks[offset + index].url == *url,
                    "Sonos queue belongs to another source"
                );
            }
            offset += returned;
            if offset == total {
                return Ok(QueueRevision {
                    count: total,
                    update_id,
                });
            }
            ensure!(returned > 0, "Sonos queue changed while reading");
        }
    }
    /// Reattach without loading, seeking, playing, or changing the remote queue.
    pub async fn reconnect(
        &self,
        room: &Room,
        tracks: &[Track],
        interfaces: &[crate::DjLinkInterface],
    ) -> Result<(Room, Status)> {
        ensure!(
            !tracks.is_empty() && tracks.len() <= 2000,
            "Invalid saved Sonos queue"
        );
        let local = interfaces.iter().any(|interface| {
            crate::discovery::usable_peer(interface.ip, interface.netmask, room.ip)
        });
        let cached = if local {
            self.rooms(room.ip).await.ok()
        } else {
            None
        };
        let current = match cached.and_then(|rooms| rooms.into_iter().find(|r| r.id == room.id)) {
            Some(room) => room,
            None => self
                .discover(interfaces)
                .await?
                .into_iter()
                .find(|r| r.id == room.id)
                .context("Saved Sonos room is not on this network")?,
        };
        let status = self.status(&current, tracks).await?;
        ensure!(
            status.owned || status.state != "TRANSITIONING",
            "Sonos is still changing tracks"
        );
        Ok((current, status))
    }
    pub async fn status(&self, room: &Room, tracks: &[Track]) -> Result<Status> {
        let volume = self.volume(room).await?;
        self.transport_status(room, tracks, volume).await
    }
    pub async fn volume(&self, room: &Room) -> Result<u8> {
        let response = self
            .soap(
                room.ip,
                RENDER,
                "GetVolume",
                &[("InstanceID", "0".into()), ("Channel", "Master".into())],
            )
            .await?;
        let volume = element(&response, "CurrentVolume")
            .context("Missing Sonos volume")?
            .parse::<u8>()?;
        ensure!(volume <= 100, "Invalid Sonos volume");
        Ok(volume)
    }
    async fn transport_status(&self, room: &Room, tracks: &[Track], volume: u8) -> Result<Status> {
        // An isolated read cannot establish that playback continued throughout
        // the two requests. The controller compensates their gap only when it
        // has a preceding confirmed observation of the same playing track.
        let (status, _) = self.transport_observation(room, tracks, volume).await?;
        Ok(status)
    }
    // A single observer owns these reads. Read transport last: a position call
    // held during buffering must not publish an earlier TRANSITIONING state
    // after audio already started. Retain the position's own receipt timestamp
    // so the following state read doesn't silently shift the media clock back.
    async fn transport_observation(
        &self,
        room: &Room,
        tracks: &[Track],
        volume: u8,
    ) -> Result<(Status, std::time::Instant)> {
        let ip = room.coordinator;
        let position = self.av(ip, "GetPositionInfo", &[]).await?;
        let sampled_at = std::time::Instant::now();
        let transport = self.av(ip, "GetTransportInfo", &[]).await?;
        let track_number = element(&position, "Track").and_then(|v| v.parse::<usize>().ok());
        let index = track_number.unwrap_or(0).saturating_sub(1);
        let uri = element(&position, "TrackURI").unwrap_or_default();
        let incomplete =
            track_number.is_none_or(|n| n == 0) || uri.is_empty() || uri == "NOT_IMPLEMENTED";
        // These independent SOAP replies can straddle a track transition. An
        // absent current URI is unknown ownership, never proof of another source.
        let state = if incomplete {
            "TRANSITIONING".to_owned()
        } else {
            element(&transport, "CurrentTransportState").context("Missing Sonos transport state")?
        };
        Ok((
            Status {
                playing: state == "PLAYING",
                state,
                position: seconds(&element(&position, "RelTime").unwrap_or_default()),
                duration: seconds(&element(&position, "TrackDuration").unwrap_or_default()),
                queue_index: index,
                owned: !incomplete && tracks.get(index).is_some_and(|t| t.url == uri),
                volume,
            },
            sampled_at,
        ))
    }
    pub async fn command(
        &self,
        room: &Room,
        tracks: &[Track],
        command: &str,
        value: f64,
    ) -> Result<()> {
        self.command_with_selection_intent(room, tracks, command, value, || {
            Some(command == "track")
        })
        .await
    }
    async fn command_with_selection_intent(
        &self,
        room: &Room,
        tracks: &[Track],
        command: &str,
        value: f64,
        selection_intent: impl Fn() -> Option<bool>,
    ) -> Result<()> {
        let position = timeout(
            STATUS_TIMEOUT,
            self.av(room.coordinator, "GetPositionInfo", &[]),
        )
        .await
        .map_err(|_| OwnershipReadPending)??;
        let index = element(&position, "Track").and_then(|v| v.parse::<usize>().ok());
        let uri = element(&position, "TrackURI").unwrap_or_default();
        if index.is_none_or(|n| n == 0) || uri.is_empty() || uri == "NOT_IMPLEMENTED" {
            return Err(OwnershipReadPending.into());
        }
        ensure!(
            index
                .and_then(|i| i.checked_sub(1))
                .and_then(|i| tracks.get(i))
                .is_some_and(|track| track.url == uri),
            "Sonos is now playing from another source"
        );
        let ip = room.coordinator;
        match command {
            "play" | "pause" | "volume" => self.room_control(room, command, value).await?,
            "stop" => {
                self.av(ip, "Stop", &[]).await?;
            }
            "seek" => self.seek(ip, value).await?,
            "track" | "track-paused" => {
                ensure!(
                    value.is_finite() && value >= 0.0 && (value as usize) < tracks.len(),
                    "Invalid queue position"
                );
                // TRACK_NR preserves an already-playing transport. Sending a
                // second Play during its buffering transition can occupy the
                // renderer for seconds and hold later Pause/Next intents.
                // This read is still before any mutation, so its timeout is
                // safe for the controller's existing deferred-intent handling.
                let transport = timeout(STATUS_TIMEOUT, self.av(ip, "GetTransportInfo", &[]))
                    .await
                    .map_err(|_| OwnershipReadPending)??;
                let state = element(&transport, "CurrentTransportState");
                if !matches!(
                    state.as_deref(),
                    Some("PLAYING" | "PAUSED_PLAYBACK" | "STOPPED")
                ) {
                    return Err(OwnershipReadPending.into());
                }
                let was_playing = state.as_deref() == Some("PLAYING");
                let Some(autoplay) = selection_intent() else {
                    return Ok(());
                };
                if !autoplay && was_playing {
                    self.av(ip, "Pause", &[]).await?;
                }
                if selection_intent().is_none() {
                    return Ok(());
                }
                self.av(
                    ip,
                    "Seek",
                    &[
                        ("Unit", "TRACK_NR".into()),
                        ("Target", (value as usize + 1).to_string()),
                    ],
                )
                .await?;
                if !was_playing && selection_intent() == Some(true) {
                    self.av(ip, "Play", &[("Speed", "1".into())]).await?;
                }
            }
            _ => bail!("Unsupported Sonos command"),
        }
        Ok(())
    }
    /// Explicit user transport/volume intent targets the selected room. Unlike
    /// automatic cleanup and queue-index operations, it needs no ownership GET.
    /// The mutation is sent once; an uncertain response is never replayed.
    pub async fn room_control(&self, room: &Room, command: &str, value: f64) -> Result<()> {
        match command {
            "play" => {
                self.av(room.coordinator, "Play", &[("Speed", "1".into())])
                    .await?;
            }
            "pause" => {
                self.av(room.coordinator, "Pause", &[]).await?;
            }
            "volume" => {
                ensure!(value.is_finite(), "Invalid Sonos volume");
                self.set_group_volume(room, value.clamp(0.0, 100.0).round() as u8)
                    .await?;
            }
            _ => bail!("Unsupported explicit Sonos room control"),
        }
        Ok(())
    }
    async fn seek(&self, ip: Ipv4Addr, position: f64) -> Result<()> {
        ensure!(position.is_finite() && position >= 0.0, "Invalid seek time");
        let seconds = position.min(86400.0 * 7.0) as u64;
        self.av(
            ip,
            "Seek",
            &[
                ("Unit", "REL_TIME".into()),
                (
                    "Target",
                    format!(
                        "{}:{:02}:{:02}",
                        seconds / 3600,
                        seconds / 60 % 60,
                        seconds % 60
                    ),
                ),
            ],
        )
        .await?;
        Ok(())
    }
}
fn xml(value: &str) -> String {
    quick_xml::escape::escape(value).into_owned()
}
fn element(document: &str, name: &str) -> Option<String> {
    let mut reader = Reader::from_str(document);
    loop {
        match reader.read_event().ok()? {
            Event::Start(tag) if tag.local_name().as_ref() == name.as_bytes() => {
                let value = reader.read_text(tag.name()).ok()?;
                return Some(quick_xml::escape::unescape(&value).ok()?.into_owned());
            }
            Event::Eof => return None,
            _ => {}
        }
    }
}
fn seconds(value: &str) -> f64 {
    let values: Vec<_> = value.split(':').map(str::parse::<f64>).collect();
    if let [Ok(hours), Ok(minutes), Ok(seconds)] = values.as_slice() {
        let value = hours * 3600.0 + minutes * 60.0 + seconds;
        if value.is_finite() && value >= 0.0 {
            return value;
        }
    }
    0.0
}
fn metadata(track: &Track) -> String {
    format!(
        "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\"><item id=\"0\" parentID=\"0\" restricted=\"true\"><dc:title>{}</dc:title><dc:creator>{}</dc:creator><upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo=\"http-get:*:{}:*\">{}</res></item></DIDL-Lite>",
        xml(&track.title),
        xml(&track.artist),
        xml(&track.mime),
        xml(&track.url)
    )
}
pub fn parse_topology(document: &str) -> Result<Vec<Room>> {
    let mut reader = Reader::from_str(document);
    let mut coordinator = String::new();
    let mut members = Vec::new();
    loop {
        match reader.read_event()? {
            Event::Start(tag) | Event::Empty(tag) => {
                let attributes: BTreeMap<String, String> = tag
                    .attributes()
                    .map(|value| {
                        let value = value?;
                        Ok((
                            String::from_utf8(value.key.as_ref().to_vec())?,
                            value
                                .decode_and_unescape_value(reader.decoder())?
                                .into_owned(),
                        ))
                    })
                    .collect::<Result<_>>()?;
                match tag.local_name().as_ref() {
                    b"ZoneGroup" => {
                        coordinator = attributes.get("Coordinator").cloned().unwrap_or_default()
                    }
                    b"ZoneGroupMember" => {
                        if let (Some(id), Some(name), Some(location)) = (
                            attributes.get("UUID"),
                            attributes.get("ZoneName"),
                            attributes.get("Location"),
                        ) {
                            let ip = reqwest::Url::parse(location)?
                                .host_str()
                                .context("Sonos location has no host")?
                                .parse::<Ipv4Addr>()?;
                            members.push((
                                id.clone(),
                                name.clone(),
                                ip,
                                coordinator.clone(),
                                attributes.get("Invisible").is_some_and(|v| v == "1"),
                            ));
                        }
                    }
                    _ => {}
                }
            }
            Event::End(tag) if tag.local_name().as_ref() == b"ZoneGroup" => coordinator.clear(),
            Event::Eof => break,
            _ => {}
        }
    }
    let mut rooms: Vec<_> = members
        .iter()
        .filter(|m| !m.4)
        .filter_map(|(id, name, ip, coordinator_id, _)| {
            let coordinator = members.iter().find(|m| &m.0 == coordinator_id)?.2;
            Some(Room {
                id: id.clone(),
                name: name.clone(),
                ip: *ip,
                coordinator,
                coordinator_id: coordinator_id.clone(),
            })
        })
        .collect();
    rooms.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(rooms)
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn read_request(socket: &mut tokio::net::TcpStream) {
        use tokio::io::AsyncReadExt;
        let mut bytes = Vec::new();
        loop {
            let mut buffer = [0; 4096];
            let count = socket.read(&mut buffer).await.unwrap();
            assert!(count > 0);
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                let length: usize = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length:").map(str::trim))
                    .unwrap()
                    .parse()
                    .unwrap();
                if bytes.len() >= end + 4 + length {
                    return;
                }
            }
        }
    }
    #[tokio::test]
    async fn connection_failure_retries_once_before_sending() {
        use tokio::{io::AsyncWriteExt, net::TcpListener};
        let unavailable = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let unavailable_port = unavailable.local_addr().unwrap().port();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(unavailable);
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            read_request(&mut socket).await;
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        });
        let client = Client::new().unwrap();
        let mut attempts = 0;
        let result = retry_connect(Ipv4Addr::LOCALHOST, "AddMultipleURIsToQueue", || {
            attempts += 1;
            let target = if attempts == 1 {
                unavailable_port
            } else {
                port
            };
            client
                .http
                .post(format!("http://127.0.0.1:{target}/"))
                .body("queue mutation")
                .send()
        })
        .await;
        assert!(result.is_ok());
        assert_eq!(attempts, 2);
        server.await.unwrap();
        attempts = 0;
        assert!(
            retry_connect(Ipv4Addr::LOCALHOST, "Play", || {
                attempts += 1;
                client
                    .http
                    .post(format!("http://127.0.0.1:{unavailable_port}/"))
                    .body("play")
                    .send()
            })
            .await
            .is_err()
        );
        assert_eq!(
            attempts, 2,
            "Retries must be bounded even when the device stays offline"
        );
    }
    #[tokio::test]
    async fn soap_never_replays_a_mutation_after_response_loss_or_http_error() {
        use tokio::{io::AsyncWriteExt, net::TcpListener};
        for http_error in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                read_request(&mut socket).await;
                if http_error {
                    socket.write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                }
                drop(socket); // the speaker may have applied the mutation
                assert!(
                    tokio::time::timeout(Duration::from_millis(250), listener.accept())
                        .await
                        .is_err()
                );
            });
            let client = Client {
                port,
                ..Client::new().unwrap()
            };
            assert!(
                client
                    .av(Ipv4Addr::LOCALHOST, "AddMultipleURIsToQueue", &[])
                    .await
                    .is_err()
            );
            server.await.unwrap();
        }
    }
    #[tokio::test]
    async fn load_completes_queue_before_play_and_never_plays_a_failed_queue() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        for (index, autoplay, fail_tail) in [
            (0, true, false),
            (17, true, false),
            (39, true, false),
            (0, false, false),
            (0, true, true),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let mut queued = Vec::new();
                let mut played = false;
                let mut selected = None;
                let mut normal_mode = false;
                let mut transport_set = false;
                // Topology, Stop, clear, three queue batches, mode, transport,
                // track seek, and optional Play.
                let requests = if fail_tail {
                    5
                } else {
                    9 + usize::from(autoplay)
                };
                for _ in 0..requests {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut bytes = Vec::new();
                    loop {
                        let mut buffer = [0; 8192];
                        let count = socket.read(&mut buffer).await.unwrap();
                        assert!(count > 0);
                        bytes.extend_from_slice(&buffer[..count]);
                        if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                            let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                            let length: usize = headers
                                .lines()
                                .find_map(|line| {
                                    line.strip_prefix("content-length:").map(str::trim)
                                })
                                .unwrap()
                                .parse()
                                .unwrap();
                            if bytes.len() >= end + 4 + length {
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
                    let mut body = String::new();
                    let mut status = "200 OK";
                    match action {
                        "GetZoneGroupState" => {
                            body = format!(
                                "<ZoneGroupState>{}</ZoneGroupState>",
                                xml(&format!(
                                    r#"<ZoneGroups><ZoneGroup Coordinator="A"><ZoneGroupMember UUID="A" ZoneName="Office" Location="http://127.0.0.1:{port}/xml/device_description.xml"/></ZoneGroup></ZoneGroups>"#
                                ))
                            )
                        }
                        "AddMultipleURIsToQueue" => {
                            assert!(!played, "Queue writes must finish before playback starts");
                            if fail_tail && !queued.is_empty() {
                                status = "500 Internal Server Error";
                                body = "<errorCode>800</errorCode>".into();
                            } else {
                                let first = queued.len() + 1;
                                queued.extend(
                                    element(&request, "EnqueuedURIs")
                                        .unwrap()
                                        .split_whitespace()
                                        .map(str::to_owned),
                                );
                                body = format!(
                                    "<FirstTrackNumberEnqueued>{first}</FirstTrackNumberEnqueued><NumTracksAdded>{}</NumTracksAdded><NewQueueLength>{}</NewQueueLength><NewUpdateID>{}</NewUpdateID>",
                                    queued.len() + 1 - first,
                                    queued.len(),
                                    queued.len()
                                );
                            }
                        }
                        "SetPlayMode" => {
                            assert_eq!(queued.len(), 40);
                            assert!(!transport_set, "Normalize mode before source activation");
                            assert_eq!(element(&request, "NewPlayMode").as_deref(), Some("NORMAL"));
                            normal_mode = true;
                        }
                        "SetAVTransportURI" => {
                            assert!(normal_mode);
                            assert!(!played);
                            transport_set = true;
                        }
                        "Seek" => {
                            assert!(transport_set);
                            selected = Some(
                                element(&request, "Target")
                                    .unwrap()
                                    .parse::<usize>()
                                    .unwrap(),
                            );
                            assert_eq!(selected, Some(index + 1));
                            assert!(queued.len() > index);
                        }
                        "Play" => {
                            assert_eq!(selected, Some(index + 1));
                            assert_eq!(queued.len(), 40);
                            played = true;
                        }
                        "Stop" | "RemoveAllTracksFromQueue" => (),
                        _ => panic!("Unexpected action {action}"),
                    }
                    socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                }
                assert_eq!(
                    queued,
                    (0..if fail_tail { 16 } else { 40 })
                        .map(|n| format!("https://media.test/{n}.mp3"))
                        .collect::<Vec<_>>()
                );
                assert_eq!(played, autoplay && !fail_tail);
                if fail_tail {
                    assert!(
                        tokio::time::timeout(Duration::from_millis(100), listener.accept())
                            .await
                            .is_err(),
                        "A failed queue must not issue Play or any further commands"
                    );
                }
            });
            let client = Client {
                port,
                ..Client::new().unwrap()
            };
            let room = Room {
                id: "A".into(),
                name: "Office".into(),
                ip: Ipv4Addr::LOCALHOST,
                coordinator: Ipv4Addr::LOCALHOST,
                coordinator_id: "A".into(),
            };
            let tracks = (0..40)
                .map(|n| Track {
                    url: format!("https://media.test/{n}.mp3"),
                    title: n.to_string(),
                    artist: String::new(),
                    mime: "audio/mpeg".into(),
                })
                .collect::<Vec<_>>();
            let result = tokio::time::timeout(
                Duration::from_secs(5),
                client.load(&room, &tracks, index, 0.0, autoplay),
            )
            .await
            .unwrap();
            assert_eq!(result.is_err(), fail_tail);
            server.await.unwrap();
        }
    }
    #[tokio::test]
    async fn reconnect_reads_live_queue_without_mutating_transport_and_rejects_other_sources() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        for owned in [true, false] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let server = tokio::spawn(async move {
                let mut actions = Vec::new();
                for _ in 0..4 {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut bytes = Vec::new();
                    loop {
                        let mut buffer = [0; 4096];
                        let n = socket.read(&mut buffer).await.unwrap();
                        assert!(n > 0);
                        bytes.extend_from_slice(&buffer[..n]);
                        if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                            let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                            let length: usize = headers
                                .lines()
                                .find_map(|line| {
                                    line.strip_prefix("content-length:").map(str::trim)
                                })
                                .unwrap()
                                .parse()
                                .unwrap();
                            if bytes.len() >= end + 4 + length {
                                break;
                            }
                        }
                    }
                    let request = String::from_utf8(bytes).unwrap();
                    let action = [
                        "GetZoneGroupState",
                        "GetPositionInfo",
                        "GetTransportInfo",
                        "GetVolume",
                    ]
                    .into_iter()
                    .find(|action| request.contains(&format!("#{action}")))
                    .expect("Reconnect must never mutate the speaker");
                    actions.push(action);
                    let body = match action {
                        "GetZoneGroupState" => format!(
                            "<ZoneGroupState>{}</ZoneGroupState>",
                            xml(&format!(
                                r#"<ZoneGroups><ZoneGroup Coordinator="A"><ZoneGroupMember UUID="A" ZoneName="Office" Location="http://127.0.0.1:{port}/xml/device_description.xml"/></ZoneGroup></ZoneGroups>"#
                            ))
                        ),
                        "GetPositionInfo" => format!(
                            "<Track>2</Track><TrackURI>{}</TrackURI><RelTime>0:01:23</RelTime><TrackDuration>0:05:00</TrackDuration>",
                            if owned {
                                "https://media.test/second.mp3"
                            } else {
                                "https://another.test/music.mp3"
                            }
                        ),
                        "GetTransportInfo" => {
                            "<CurrentTransportState>PLAYING</CurrentTransportState>".into()
                        }
                        _ => "<CurrentVolume>20</CurrentVolume>".into(),
                    };
                    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                }
                actions
            });
            let client = Client {
                port,
                ..Client::new().unwrap()
            };
            let room = Room {
                id: "A".into(),
                name: "Old name".into(),
                ip: Ipv4Addr::LOCALHOST,
                coordinator: Ipv4Addr::LOCALHOST,
                coordinator_id: "A".into(),
            };
            let tracks = ["first", "second"].map(|name| Track {
                url: format!("https://media.test/{name}.mp3"),
                title: name.into(),
                artist: String::new(),
                mime: "audio/mpeg".into(),
            });
            let interfaces = [crate::DjLinkInterface {
                name: "lo".into(),
                index: 1,
                ip: Ipv4Addr::new(127, 0, 0, 2),
                broadcast: Ipv4Addr::new(127, 255, 255, 255),
                netmask: Ipv4Addr::new(255, 0, 0, 0),
            }];
            let (current, status) = client.reconnect(&room, &tracks, &interfaces).await.unwrap();
            assert_eq!(current.name, "Office");
            assert_eq!(status.queue_index, 1);
            assert_eq!(status.position, 83.0);
            assert_eq!(status.volume, 20);
            assert!(status.playing);
            assert_eq!(status.owned, owned);
            assert_eq!(server.await.unwrap().len(), 4);
        }
    }
    #[test]
    fn grouped_room_targets_coordinator_and_hides_satellites() {
        let rooms = parse_topology(r#"<ZoneGroups><ZoneGroup Coordinator="A"><ZoneGroupMember UUID="A" ZoneName="Living Room" Location="http://192.168.1.2:1400/xml/device_description.xml"/><ZoneGroupMember UUID="B" ZoneName="Kitchen &amp; Dining" Location="http://192.168.1.3:1400/xml/device_description.xml"/><ZoneGroupMember UUID="C" ZoneName="Sub" Invisible="1" Location="http://192.168.1.4:1400/xml/device_description.xml"/></ZoneGroup></ZoneGroups>"#).unwrap();
        assert_eq!(rooms.len(), 2);
        assert_eq!(rooms[0].name, "Kitchen & Dining");
        assert_eq!(rooms[0].ip, Ipv4Addr::new(192, 168, 1, 3));
        assert_eq!(rooms[0].coordinator, Ipv4Addr::new(192, 168, 1, 2));
    }
    #[test]
    fn metadata_and_soap_values_roundtrip_special_characters() {
        let track = Track {
            url: "https://music.test/a?x=1&y=2".into(),
            title: "A < B & C".into(),
            artist: "Artist".into(),
            mime: "audio/mpeg".into(),
        };
        assert_eq!(
            element(&metadata(&track), "title").as_deref(),
            Some(track.title.as_str())
        );
        assert_eq!(
            element(&metadata(&track), "res").as_deref(),
            Some(track.url.as_str())
        );
        assert_eq!(seconds("1:02:03"), 3723.0);
        assert_eq!(seconds("NOT_IMPLEMENTED"), 0.0);
    }
}
