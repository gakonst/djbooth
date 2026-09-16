//! Serialization and ownership only. Every operation delegates to djtools-link.
use crate::{SESSION, Session};
use anyhow::{Context, Result};
use djtools_link::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    net::Ipv4Addr,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::broadcast;

include!(concat!(env!("OUT_DIR"), "/dispatch.rs"));
pub(crate) const SCHEMA: &str = include_str!(concat!(env!("OUT_DIR"), "/api.json"));

pub(crate) enum Subscription {
    Telemetry(broadcast::Receiver<DjLinkTelemetryEvent>),
    Mixer(broadcast::Receiver<DjLinkMixerTelemetryEvent>),
    Vu(broadcast::Receiver<DjLinkVuTelemetryEvent>),
}
#[derive(Default)]
pub(crate) struct Subscriptions {
    receivers: BTreeMap<u64, Subscription>,
}
static NEXT_SUBSCRIPTION: AtomicU64 = AtomicU64::new(1);
impl Subscriptions {
    fn insert(&mut self, receiver: Subscription) -> Result<u64> {
        anyhow::ensure!(
            self.receivers.len() < 64,
            "Close unused DJ Link subscriptions first"
        );
        let id = NEXT_SUBSCRIPTION
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| anyhow::anyhow!("Subscription IDs exhausted"))?;
        self.receivers.insert(id, receiver);
        Ok(id)
    }
}

fn drain<T: Serialize + Clone>(
    receiver: &mut broadcast::Receiver<T>,
    limit: usize,
) -> Result<Value> {
    let mut events = Vec::new();
    let mut lagged = 0;
    let mut closed = false;
    while events.len() < limit {
        match receiver.try_recv() {
            Ok(event) => events.push(serde_json::to_value(event)?),
            Err(broadcast::error::TryRecvError::Lagged(count)) => lagged += count,
            Err(broadcast::error::TryRecvError::Empty) => break,
            Err(broadcast::error::TryRecvError::Closed) => {
                closed = true;
                break;
            }
        }
    }
    Ok(json!({"events": events, "lagged": lagged, "closed": closed}))
}

pub(crate) fn function(operation: &str, input: &str) -> Result<Value> {
    // The free functions are synchronous; this runtime is only an executor for
    // the generated common dispatch signature and opens no DJ Link sockets.
    let runtime = tokio::runtime::Builder::new_current_thread().build()?;
    runtime.block_on(invoke_function(operation, input))
}

pub(crate) fn request(operation: &str, input: &str) -> Result<Value> {
    if operation == "new" {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Args {
            config: DjLinkConfig,
            library: LibrarySnapshot,
        }
        let args: Args = serde_json::from_str(input)?;
        let mut slot = SESSION
            .lock()
            .map_err(|_| anyhow::anyhow!("DJ Link runtime lock failed"))?;
        anyhow::ensure!(slot.is_none(), "Stop the existing DJ Link session first");
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        let server = runtime.block_on(DjLinkServer::new(args.config, args.library))?;
        *slot = Some(Arc::new(Session::new(server, runtime, false)));
        return Ok(Value::Null);
    }
    let session = SESSION
        .lock()
        .map_err(|_| anyhow::anyhow!("DJ Link runtime lock failed"))?
        .clone()
        .context("DJ Link session is not initialized")?;
    match operation {
        "start" => {
            let mut server = session
                .server
                .write()
                .map_err(|_| anyhow::anyhow!("DJ Link server lock failed"))?;
            session.runtime().block_on(server.start())?;
            session
                .started
                .store(true, std::sync::atomic::Ordering::Release);
            Ok(Value::Null)
        }
        "stop" => {
            session.stop();
            Ok(Value::Null)
        }
        "poll_events" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Args {
                subscription: u64,
                limit: usize,
            }
            let args: Args = serde_json::from_str(input)?;
            anyhow::ensure!(
                (1..=1024).contains(&args.limit),
                "Event limit must be 1..1024"
            );
            let mut streams = session
                .subscriptions
                .lock()
                .map_err(|_| anyhow::anyhow!("Subscription lock failed"))?;
            match streams
                .receivers
                .get_mut(&args.subscription)
                .context("Unknown subscription")?
            {
                Subscription::Telemetry(receiver) => drain(receiver, args.limit),
                Subscription::Mixer(receiver) => drain(receiver, args.limit),
                Subscription::Vu(receiver) => drain(receiver, args.limit),
            }
        }
        "unsubscribe" => {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Args {
                subscription: u64,
            }
            let args: Args = serde_json::from_str(input)?;
            let removed = session
                .subscriptions
                .lock()
                .map_err(|_| anyhow::anyhow!("Subscription lock failed"))?
                .receivers
                .remove(&args.subscription)
                .is_some();
            Ok(json!(removed))
        }
        _ => {
            let server = session
                .server
                .read()
                .map_err(|_| anyhow::anyhow!("DJ Link server lock failed"))?;
            let receiver = match operation {
                "subscribe_telemetry" => {
                    Some(Subscription::Telemetry(server.subscribe_telemetry()))
                }
                "subscribe_mixer_telemetry" => {
                    Some(Subscription::Mixer(server.subscribe_mixer_telemetry()))
                }
                "subscribe_vu_telemetry" => Some(Subscription::Vu(server.subscribe_vu_telemetry())),
                _ => None,
            };
            if let Some(receiver) = receiver {
                return Ok(json!(
                    session
                        .subscriptions
                        .lock()
                        .map_err(|_| anyhow::anyhow!("Subscription lock failed"))?
                        .insert(receiver)?
                ));
            }
            session
                .runtime()
                .block_on(invoke_server(&server, operation, input))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn library(path: PathBuf) -> LibrarySnapshot {
        let track = TrackRecord {
            track_id: 123,
            title: "Rust binding fixture".into(),
            artist: "Artist".into(),
            key: "Am".into(),
            camelot: "8A".into(),
            mount_path: path,
            ..Default::default()
        };
        LibrarySnapshot {
            master_db_id: 1,
            tracks_by_id: [(123, track.clone())].into(),
            all_tracks: vec![track],
            playlists: vec![],
        }
    }
    async fn server(path: PathBuf) -> DjLinkServer {
        DjLinkServer::new(
            DjLinkConfig {
                bind_ip: Some(Ipv4Addr::LOCALHOST),
                broadcast_ip: Some(Ipv4Addr::new(127, 0, 0, 3)),
                unicast_discovery_netmask: Some(Ipv4Addr::new(255, 255, 255, 252)),
                ..Default::default()
            },
            library(path),
        )
        .await
        .unwrap()
    }

    #[test]
    fn swift_operation_inventory_is_generated_from_the_same_rust_api() {
        let schema: Vec<Value> = serde_json::from_str(SCHEMA).unwrap();
        assert!(
            schema
                .iter()
                .filter(|method| method["operation"].as_str().unwrap().starts_with("server."))
                .count()
                >= 50
        );
        assert_eq!(
            include_str!(concat!(env!("OUT_DIR"), "/DJLinkMethods.swift")),
            include_str!("../../../../apps/apple/DJBooth/DJLinkMethods.swift")
        );
        let methods = schema
            .iter()
            .map(|value| value["operation"].as_str().unwrap())
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(methods.len(), schema.len());
        for operation in [
            "server.send_prepared_track",
            "server.send_load_track",
            "server.start_player",
            "server.subscribe_telemetry",
            "server.subscribe_mixer_telemetry",
            "server.subscribe_vu_telemetry",
            "server.send_raw_udp_payload_datagram_with_options",
        ] {
            assert!(methods.contains(operation), "missing {operation}");
        }
    }

    #[tokio::test]
    async fn generated_calls_preserve_rust_results_errors_and_binary_payloads() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("track.mp3");
        std::fs::write(&path, b"fixture").unwrap();
        let server = server(path).await;
        assert_eq!(
            invoke_server(&server, "library_track_metadata", r#"{"track_id":123}"#)
                .await
                .unwrap(),
            serde_json::to_value(server.library_track_metadata(123)).unwrap()
        );
        assert_eq!(
            invoke_server(&server, "resolve_library_track", r#"{"selector":"123"}"#)
                .await
                .unwrap(),
            serde_json::to_value(server.resolve_library_track("123").unwrap()).unwrap()
        );
        assert_eq!(
            invoke_server(&server, "library_waveform", r#"{"track_id":123}"#)
                .await
                .unwrap(),
            serde_json::to_value(server.library_waveform(123).await).unwrap()
        );
        assert_eq!(
            invoke_server(&server, "library_track_metadata", r#"{"track_id":999}"#)
                .await
                .unwrap(),
            Value::Null
        );
        let args = r#"{"track_id":999,"cue_ms":100}"#;
        assert_eq!(
            invoke_server(&server, "set_memory_cue_override", args)
                .await
                .unwrap_err()
                .to_string(),
            server
                .set_memory_cue_override(999, 100)
                .unwrap_err()
                .to_string()
        );
        assert!(
            invoke_server(
                &server,
                "set_memory_cue_override",
                r#"{"track_id":123,"cue_ms":100,"misspelled":1}"#
            )
            .await
            .is_err()
        );
        assert!(
            invoke_server(
                &server,
                "set_player_bpm",
                r#"{"target_player":1,"bpm_hundreds":70000}"#
            )
            .await
            .is_err(),
            "u16 overflow is rejected at the ABI"
        );
        assert_eq!(
            invoke_server(
                &server,
                "set_memory_cue_override",
                r#"{"track_id":123,"cue_ms":100}"#
            )
            .await
            .unwrap(),
            Value::Null
        );
        let search = invoke_server(
            &server,
            "profile_search",
            r#"{"query":"fixture","mode":"Track"}"#,
        )
        .await
        .unwrap();
        let direct = server.profile_search("fixture", DjLinkSearchMode::Track);
        assert_eq!(search["items"], serde_json::to_value(direct.items).unwrap());
        let receiver = tokio::net::UdpSocket::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let payload = vec![0, 1, 127, 128, 255];
        let input = json!({"target_ip":"127.0.0.1", "target_port":receiver.local_addr().unwrap().port(), "source_port":null, "target_mac":null, "payload":payload, "context":"binding parity test"});
        assert_eq!(
            invoke_server(
                &server,
                "send_raw_udp_payload_datagram_with_options",
                &input.to_string()
            )
            .await
            .unwrap(),
            json!(5)
        );
        let mut received = [0; 64];
        let size = tokio::time::timeout(Duration::from_secs(1), receiver.recv(&mut received))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&received[..size], payload);
    }

    #[test]
    fn exported_helpers_are_byte_identical_to_the_shared_protocol() {
        let args = json!({"model":"rekordbox","own_player_number":17,"target_player_number":1,"source_player_number":17,"source_slot":4,"source_track_type":1,"track_id":u32::MAX,"rekordbox_variant":false,"payload_byte_overrides":[[20,2]]});
        assert_eq!(
            function("build_status_load_track_command", &args.to_string()).unwrap(),
            json!(build_status_load_track_command(
                "rekordbox",
                17,
                1,
                17,
                4,
                1,
                u32::MAX,
                false,
                &[(20, 2)]
            ))
        );
        for identity in ["track:one:abc", "artist:é", "", "  "] {
            assert_eq!(
                function("stable_text_id", &json!({"value":identity}).to_string()).unwrap(),
                json!(stable_text_id(identity))
            );
        }
    }

    #[test]
    fn subscriptions_preserve_events_report_lag_and_close() {
        let (sender, mut receiver) = broadcast::channel(2);
        sender
            .send(DjLinkTelemetryEvent {
                kind: DjLinkTelemetryKind::Beat,
                player: 1,
                deck: None,
            })
            .unwrap();
        let result = drain(&mut receiver, 1).unwrap();
        assert_eq!(result["events"][0]["kind"], "Beat");
        assert_eq!(result["lagged"], 0);
        for player in 1..=4 {
            sender
                .send(DjLinkTelemetryEvent {
                    kind: DjLinkTelemetryKind::Device,
                    player,
                    deck: None,
                })
                .unwrap();
        }
        let result = drain(&mut receiver, 128).unwrap();
        assert_eq!(result["lagged"], 2);
        assert_eq!(result["events"].as_array().unwrap().len(), 2);
        drop(sender);
        assert_eq!(drain(&mut receiver, 1).unwrap()["closed"], true);
    }
}

#[cfg(test)]
mod ffi_tests {
    use super::*;
    use std::ffi::{CStr, CString};

    fn call(operation: &str, args: Value) -> Value {
        let op = CString::new(operation).unwrap();
        let input = CString::new(args.to_string()).unwrap();
        unsafe {
            let result = crate::djbooth_link_request(op.as_ptr(), input.as_ptr());
            assert!(!result.is_null());
            let response = serde_json::from_slice(CStr::from_ptr(result).to_bytes()).unwrap();
            crate::djbooth_link_free(result);
            response
        }
    }

    #[test]
    fn c_abi_owns_the_same_server_and_subscription_lifecycle() {
        struct Cleanup;
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = call("stop", json!({}));
            }
        }
        let _cleanup = Cleanup;
        let library = LibrarySnapshot {
            master_db_id: 42,
            tracks_by_id: BTreeMap::new(),
            all_tracks: vec![],
            playlists: vec![],
        };
        let config = DjLinkConfig {
            bind_ip: Some(Ipv4Addr::LOCALHOST),
            unicast_discovery_netmask: Some(Ipv4Addr::new(255, 255, 255, 252)),
            ..Default::default()
        };
        assert_eq!(
            call("server.new", json!({"config":config, "library":library})),
            json!({"ok":true,"value":null})
        );
        assert_eq!(call("server.bind_ip", json!({}))["value"], "127.0.0.1");
        assert_eq!(call("server.library_track_count", json!({}))["value"], 0);
        assert_eq!(
            call("server.library_track_metadata", json!({"track_id":12})),
            json!({"ok":true,"value":null})
        );
        let mut handles = Vec::new();
        for operation in [
            "server.subscribe_telemetry",
            "server.subscribe_mixer_telemetry",
            "server.subscribe_vu_telemetry",
        ] {
            let result = call(operation, json!({}));
            assert_eq!(result["ok"], true);
            let handle = result["value"].as_u64().unwrap();
            assert!(!handles.contains(&handle));
            handles.push(handle);
            assert_eq!(
                call(
                    "server.poll_events",
                    json!({"subscription":handle,"limit":128})
                )["value"],
                json!({"events":[],"lagged":0,"closed":false})
            );
            assert_eq!(
                call("server.unsubscribe", json!({"subscription":handle}))["value"],
                true
            );
            assert_eq!(
                call(
                    "server.poll_events",
                    json!({"subscription":handle,"limit":128})
                )["ok"],
                false
            );
        }
        assert_eq!(
            call("server.stop", json!({})),
            json!({"ok":true,"value":null})
        );
        let text = "track:é:🔊\u{0}end";
        assert_eq!(
            call("function.stable_text_id", json!({"value":text}))["value"],
            stable_text_id(text)
        );
        assert_eq!(
            call("function.normalize_camelot_key", json!({"value":"Am"}))["value"],
            normalize_camelot_key("Am")
        );
        assert!(call("api", json!({}))["value"].as_array().unwrap().len() >= 60);
    }
}
