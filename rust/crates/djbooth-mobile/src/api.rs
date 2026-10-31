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
