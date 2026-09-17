//! C ABI adapter only; queue orchestration and protocol live in djtools-link.
use anyhow::{Context, Result};
use djtools_link::sonos::{Client, Controller, Room, Session, StatusPollSkipped, Track};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::{Mutex, OnceLock};
use tokio::runtime::Runtime;

static RUNTIME: OnceLock<Runtime> = OnceLock::new();
static CLIENT: OnceLock<Client> = OnceLock::new();
static CONTROLLER: OnceLock<Controller> = OnceLock::new();
static ROOMS: Mutex<Vec<Room>> = Mutex::new(Vec::new());
static LOCAL_MEDIA: Mutex<Option<djtools_link::sonos::local_media::LocalMediaServer>> =
    Mutex::new(None);
fn runtime() -> Result<&'static Runtime> {
    if RUNTIME.get().is_none() {
        let _ = RUNTIME.set(
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?,
        );
    }
    RUNTIME.get().context("Sonos runtime unavailable")
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Load {
    request_id: String,
    room_id: String,
    tracks: Vec<Track>,
    index: usize,
    #[serde(default)]
    position: f64,
    #[serde(default = "autoplay")]
    autoplay: bool,
}
fn autoplay() -> bool {
    true
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Command {
    request_id: String,
    command: String,
    #[serde(default)]
    value: f64,
}
pub fn request(operation: &str, input: &str) -> Result<Value> {
    let rt = runtime()?;
    if CLIENT.get().is_none() {
        let _ = CLIENT.set(Client::new()?);
    }
    let client = CLIENT.get().context("Sonos client unavailable")?;
    let controller = CONTROLLER.get_or_init(|| Controller::new(client.clone()));
    match operation {
        "groups.all" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct GroupRequest {
                preferred_room_id: Option<String>,
            }
            let request: GroupRequest = serde_json::from_str(input)?;
            let rooms = ROOMS
                .lock()
                .map_err(|_| anyhow::anyhow!("Sonos discovery lock"))?
                .clone();
            let preferred = request
                .preferred_room_id
                .or_else(|| controller.checkpoint().ok().map(|s| s.room.id));
            let room = rt.block_on(client.group_all(&rooms, preferred.as_deref()))?;
            *ROOMS
                .lock()
                .map_err(|_| anyhow::anyhow!("Sonos discovery lock"))? =
                client.group_state().rooms.clone();
            Ok(json!({"room": room, "group": client.group_state()}))
        }
        "groups.limits" => {
            let limits: djtools_link::sonos::groups::VolumeLimits = serde_json::from_str(input)?;
            Ok(serde_json::to_value(
                rt.block_on(client.set_volume_limits(limits))?,
            )?)
        }
        "groups.disable" => {
            rt.block_on(client.disable_group());
            Ok(json!({"ok": true}))
        }
        "local.start" => {
            #[derive(Deserialize)]
            struct Local {
                files: Vec<djtools_link::sonos::local_media::MediaFile>,
            }
            let input: Local = serde_json::from_str(input)?;
            let room = controller.checkpoint()?.room;
            let server = rt.block_on(djtools_link::sonos::local_media::LocalMediaServer::start(
                room.coordinator,
                input.files,
            ))?;
            let result = json!({"urls": server.urls});
            *LOCAL_MEDIA
                .lock()
                .map_err(|_| anyhow::anyhow!("Local media lock"))? = Some(server);
            Ok(result)
        }
        "local.stop" => {
            LOCAL_MEDIA
                .lock()
                .map_err(|_| anyhow::anyhow!("Local media lock"))?
                .take();
            Ok(json!({"ok": true}))
        }
        "discover" => {
            let rooms = rt.block_on(client.discover(&djtools_link::djlink_interfaces()))?;
            *ROOMS
                .lock()
                .map_err(|_| anyhow::anyhow!("Sonos discovery lock"))? = rooms.clone();
            Ok(json!({"rooms": rooms}))
        }
        "checkpoint" => Ok(serde_json::to_value(controller.checkpoint()?)?),
        "restore" => {
            let saved: Session = serde_json::from_str(input)?;
            let snapshot =
                rt.block_on(controller.restore(saved, &djtools_link::djlink_interfaces()))?;
            if let Some(snapshot) = snapshot {
                let mut rooms = ROOMS
                    .lock()
                    .map_err(|_| anyhow::anyhow!("Sonos discovery lock"))?;
                rooms.retain(|room| room.id != snapshot.room.id);
                rooms.push(snapshot.room.clone());
                Ok(serde_json::to_value(snapshot)?)
            } else {
                Ok(json!({"active": false}))
            }
        }
        "load" => {
            let input: Load = serde_json::from_str(input)?;
            let room = ROOMS
                .lock()
                .map_err(|_| anyhow::anyhow!("Sonos discovery lock"))?
                .iter()
                .find(|room| room.id == input.room_id)
                .cloned()
                .context("Find this Sonos room before playing")?;
            Ok(serde_json::to_value(rt.block_on(controller.load(
                input.request_id,
                &room,
                input.tracks,
                input.index,
                input.position,
                input.autoplay,
            ))?)?)
        }
        "resume" => {
            rt.block_on(controller.resume_queue())?;
            Ok(json!({"ok": true}))
        }
        "disconnect" => {
            rt.block_on(controller.disconnect())?;
            Ok(json!({"active": false}))
        }
        "status" => match rt.block_on(controller.status()) {
            Ok(Some(snapshot)) => {
                let mut value = serde_json::to_value(snapshot)?;
                value["group"] = serde_json::to_value(client.group_state())?;
                Ok(value)
            }
            Ok(None) => Ok(json!({"active": false})),
            Err(error) if error.downcast_ref::<StatusPollSkipped>().is_some() => Ok(json!({
                "active": true, "busy": true, "requestId": controller.checkpoint().ok().map(|session| session.request_id)
            })),
            Err(error) => Err(error),
        },
        "submit" => {
            let input: Command = serde_json::from_str(input)?;
            let _runtime = rt.enter();
            controller.submit(&input.request_id, &input.command, input.value)?;
            Ok(json!({"submitted": true}))
        }
        "command" => {
            let input: Command = serde_json::from_str(input)?;
            rt.block_on(controller.command(&input.request_id, &input.command, input.value))?;
            Ok(json!({"ok": true}))
        }
        _ => anyhow::bail!("Unknown Sonos operation"),
    }
}
