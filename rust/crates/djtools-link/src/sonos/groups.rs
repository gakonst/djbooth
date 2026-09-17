//! Synchronized room grouping and app volume ceilings. Swift only renders this
//! state; every volume command passes through the same Rust policy.
use super::{Client, RENDER, Room};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Mutex};
use tokio::sync::Mutex as AsyncMutex;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeLimits {
    pub master: u8,
    #[serde(default)]
    pub rooms: BTreeMap<String, u8>,
}
impl Default for VolumeLimits {
    fn default() -> Self {
        Self {
            master: 100,
            rooms: BTreeMap::new(),
        }
    }
}
impl VolumeLimits {
    fn validate(&self) -> Result<()> {
        ensure!(
            self.master <= 100 && self.rooms.len() <= 256 && self.rooms.values().all(|v| *v <= 100),
            "Invalid Sonos volume limits"
        );
        Ok(())
    }
    fn target(&self, room: &str, value: u8) -> u8 {
        value
            .min(self.master)
            .min(*self.rooms.get(room).unwrap_or(&100))
    }
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupState {
    pub enabled: bool,
    pub rooms: Vec<Room>,
    pub coordinator_id: Option<String>,
    pub volume: Option<u8>,
    pub room_volumes: BTreeMap<String, u8>,
    pub limits: VolumeLimits,
}
#[derive(Default)]
pub(super) struct GroupControl {
    state: Mutex<GroupState>,
    gate: AsyncMutex<()>,
}
impl Client {
    pub fn group_state(&self) -> GroupState {
        self.groups.state.lock().unwrap().clone()
    }
    pub async fn disable_group(&self) {
        let _gate = self.groups.gate.lock().await;
        self.groups.state.lock().unwrap().enabled = false;
    }
    async fn raw_volume(&self, room: &Room, value: u8) -> Result<()> {
        self.soap(
            room.ip,
            RENDER,
            "SetVolume",
            &[
                ("InstanceID", "0".into()),
                ("Channel", "Master".into()),
                ("DesiredVolume", value.to_string()),
            ],
        )
        .await?;
        Ok(())
    }
    async fn apply_room_volumes(&self, targets: Vec<(Room, u8)>) -> Result<()> {
        let mut targets = targets.into_iter();
        let mut tasks = tokio::task::JoinSet::new();
        let mut errors = Vec::new();
        loop {
            while tasks.len() < 4 {
                let Some((room, value)) = targets.next() else {
                    break;
                };
                let client = self.clone();
                tasks.spawn(async move {
                    let result = client.raw_volume(&room, value).await;
                    (room, value, result)
                });
            }
            let Some(result) = tasks.join_next().await else {
                break;
            };
            match result {
                Ok((room, value, Ok(()))) => {
                    self.groups
                        .state
                        .lock()
                        .unwrap()
                        .room_volumes
                        .insert(room.id, value);
                }
                Ok((room, _, Err(error))) => errors.push(format!("{}: {error}", room.name)),
                Err(error) => errors.push(error.to_string()),
            }
        }
        ensure!(
            errors.is_empty(),
            "Sonos room volume failed: {}",
            errors.join("; ")
        );
        Ok(())
    }
    pub(super) async fn set_group_volume(&self, room: &Room, value: u8) -> Result<()> {
        let _gate = self.groups.gate.lock().await;
        let state = self.group_state();
        let grouped =
            state.enabled && state.coordinator_id.as_deref() == Some(&room.coordinator_id);
        let rooms = if grouped {
            state.rooms
        } else {
            vec![room.clone()]
        };
        self.apply_room_volumes(
            rooms
                .into_iter()
                .map(|room| {
                    let target = state.limits.target(&room.id, value);
                    (room, target)
                })
                .collect(),
        )
        .await?;
        if grouped {
            self.groups.state.lock().unwrap().volume = Some(value.min(state.limits.master));
        }
        Ok(())
    }
    pub async fn set_volume_limits(&self, limits: VolumeLimits) -> Result<GroupState> {
        limits.validate()?;
        let _gate = self.groups.gate.lock().await;
        // Store first, so even an uncertain volume reply cannot let the next
        // explicit command exceed the newly requested ceiling.
        self.groups.state.lock().unwrap().limits = limits.clone();
        let state = self.group_state();
        if state.enabled {
            let mut targets = Vec::new();
            for room in &state.rooms {
                // Lowering a ceiling may reduce volume, raising one never raises
                // the room automatically. Read its real current level first.
                let current = self.volume(room).await?;
                targets.push((room.clone(), limits.target(&room.id, current)));
            }
            self.apply_room_volumes(targets).await?;
            self.groups.state.lock().unwrap().volume = state.volume.map(|v| v.min(limits.master));
        }
        Ok(self.group_state())
    }
    pub async fn group_all(&self, rooms: &[Room], preferred_id: Option<&str>) -> Result<Room> {
        let _gate = self.groups.gate.lock().await;
        ensure!(!rooms.is_empty(), "No Sonos rooms found on this network");
        let preferred = preferred_id
            .and_then(|id| rooms.iter().find(|r| r.id == id))
            .unwrap_or(&rooms[0]);
        let topology = self.rooms(preferred.coordinator).await?;
        let coordinator = topology
            .iter()
            .find(|r| r.id == preferred.coordinator_id)
            .cloned()
            .context("Sonos coordinator is unavailable")?;
        let limits = self.group_state().limits;
        let level = match self.group_state().volume {
            Some(value) => value,
            None => self.volume(&coordinator).await?,
        }
        .min(limits.master);
        // Establish the requested level and ceilings before joining a room that
        // might otherwise start playing immediately at its previous loud level.
        self.apply_room_volumes(
            topology
                .iter()
                .cloned()
                .map(|room| {
                    let target = limits.target(&room.id, level);
                    (room, target)
                })
                .collect(),
        )
        .await?;
        for room in &topology {
            if room.id == coordinator.id || room.coordinator_id == coordinator.id {
                continue;
            }
            self.av(
                room.ip,
                "SetAVTransportURI",
                &[
                    ("CurrentURI", format!("x-rincon:{}", coordinator.id)),
                    ("CurrentURIMetaData", String::new()),
                ],
            )
            .await?;
        }
        let mut confirmed = Vec::new();
        for attempt in 0..10 {
            confirmed = self.rooms(coordinator.ip).await?;
            if topology.iter().all(|room| {
                confirmed
                    .iter()
                    .any(|r| r.id == room.id && r.coordinator_id == coordinator.id)
            }) {
                break;
            }
            if attempt < 9 {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
        ensure!(
            topology.iter().all(|room| confirmed
                .iter()
                .any(|r| r.id == room.id && r.coordinator_id == coordinator.id)),
            "Some Sonos rooms have not joined the group"
        );
        let mut state = self.groups.state.lock().unwrap();
        state.enabled = true;
        state.rooms = confirmed
            .into_iter()
            .filter(|r| r.coordinator_id == coordinator.id)
            .collect();
        state.coordinator_id = Some(coordinator.id.clone());
        state.volume = Some(level);
        Ok(coordinator)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn master_and_room_ceilings_apply_together_without_scaling() {
        let limits = VolumeLimits {
            master: 60,
            rooms: [("office".into(), 25), ("kitchen".into(), 80)].into(),
        };
        assert_eq!(limits.target("office", 90), 25);
        assert_eq!(limits.target("kitchen", 90), 60);
        assert_eq!(limits.target("new-room", 90), 60);
        assert_eq!(limits.target("office", 10), 10);
        assert_eq!(limits.target("office", 0), 0);
        assert!(
            VolumeLimits {
                master: 101,
                rooms: BTreeMap::new()
            }
            .validate()
            .is_err()
        );
    }
    #[tokio::test]
    async fn grouping_and_normal_volume_commands_share_caps() {
        use axum::{Router, extract::State, http::HeaderMap, routing::post};
        use std::sync::Arc;
        #[derive(Default)]
        struct Fake {
            joined: bool,
            levels: Vec<u8>,
            reads: std::collections::VecDeque<u8>,
            actions: Vec<String>,
        }
        async fn soap(
            State((state, port)): State<(Arc<Mutex<Fake>>, u16)>,
            headers: HeaderMap,
            body: String,
        ) -> String {
            let action = headers["soapaction"]
                .to_str()
                .unwrap()
                .split('#')
                .nth(1)
                .unwrap()
                .trim_matches('"');
            let ip = headers["host"]
                .to_str()
                .unwrap()
                .split(':')
                .next()
                .unwrap()
                .to_owned();
            let mut s = state.lock().unwrap();
            s.actions.push(format!("{ip}:{action}"));
            match action {
                "GetZoneGroupState" => {
                    let a = format!(
                        r#"<ZoneGroupMember UUID="A" ZoneName="Office" Location="http://127.0.0.1:{port}/xml/device_description.xml"/>"#
                    );
                    let b = format!(
                        r#"<ZoneGroupMember UUID="B" ZoneName="Kitchen" Location="http://127.0.0.1:{port}/xml/device_description.xml"/>"#
                    );
                    let topology = if s.joined {
                        format!(
                            r#"<ZoneGroups><ZoneGroup Coordinator="A">{a}{b}</ZoneGroup></ZoneGroups>"#
                        )
                    } else {
                        format!(
                            r#"<ZoneGroups><ZoneGroup Coordinator="A">{a}</ZoneGroup><ZoneGroup Coordinator="B">{b}</ZoneGroup></ZoneGroups>"#
                        )
                    };
                    format!(
                        "<ZoneGroupState>{}</ZoneGroupState>",
                        super::super::xml(&topology)
                    )
                }
                "GetVolume" => format!(
                    "<CurrentVolume>{}</CurrentVolume>",
                    s.reads.pop_front().expect("unexpected volume read")
                ),
                "SetVolume" => {
                    s.levels.push(
                        super::super::element(&body, "DesiredVolume")
                            .unwrap()
                            .parse()
                            .unwrap(),
                    );
                    String::new()
                }
                "SetAVTransportURI" => {
                    assert_eq!(
                        super::super::element(&body, "CurrentURI").as_deref(),
                        Some("x-rincon:A")
                    );
                    let mut levels = s.levels.clone();
                    levels.sort();
                    assert_eq!(levels, vec![10, 30]);
                    s.joined = true;
                    String::new()
                }
                _ => panic!("Unexpected {action}"),
            }
        }
        let listener = tokio::net::TcpListener::bind("0.0.0.0:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(Mutex::new(Fake {
            reads: [40, 30, 10, 30, 10].into(),
            ..Fake::default()
        }));
        let app = Router::new()
            .fallback(post(soap))
            .with_state((state.clone(), port));
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = Client {
            port,
            ..Client::new().unwrap()
        };
        client
            .set_volume_limits(VolumeLimits {
                master: 30,
                rooms: [("B".into(), 10)].into(),
            })
            .await
            .unwrap();
        let rooms = client.rooms("127.0.0.1".parse().unwrap()).await.unwrap();
        let leader = client.group_all(&rooms, Some("A")).await.unwrap();
        assert_eq!(client.group_state().rooms.len(), 2);
        client.room_control(&leader, "volume", 90.0).await.unwrap();
        let mut levels = state.lock().unwrap().levels[2..4].to_vec();
        levels.sort();
        assert_eq!(levels, vec![10, 30]);
        client
            .set_volume_limits(VolumeLimits {
                master: 80,
                rooms: [("B".into(), 50)].into(),
            })
            .await
            .unwrap();
        let mut levels = state.lock().unwrap().levels[4..6].to_vec();
        levels.sort();
        assert_eq!(levels, vec![10, 30], "Raising ceilings cannot raise volume");
        client
            .set_volume_limits(VolumeLimits {
                master: 5,
                rooms: BTreeMap::new(),
            })
            .await
            .unwrap();
        assert_eq!(&state.lock().unwrap().levels[6..8], &[5, 5]);
        let rooms = client.group_state().rooms;
        client.group_all(&rooms, Some("A")).await.unwrap();
        assert_eq!(
            state
                .lock()
                .unwrap()
                .actions
                .iter()
                .filter(|a| a.ends_with(":SetAVTransportURI"))
                .count(),
            1,
            "Reconnecting an existing group never rejoins it"
        );
        task.abort();
    }
}
