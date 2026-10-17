//! Played-track history owned by djbooth, stored alongside the library in master.db.
//! Library metadata remains read-only; only the djbooth extension table is written.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Datelike, FixedOffset, Local};
use rusqlite::{Connection, OpenFlags, params};
use tokio::sync::{broadcast, oneshot};

use crate::library::open_rekordbox_connection;
use crate::{
    DjLinkServer, DjLinkTelemetryEvent, DjLinkTelemetryKind, SLOT_REKORDBOX, TRACK_TYPE_REKORDBOX,
};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub history_id: u32,
    pub name: String,
    pub tracks: Vec<u32>,
}

/// Use on one blocking worker, never on the audio/network event loop.
pub struct PlaybackHistory {
    connection: Connection,
    source_player: u8,
    recorded: HashSet<(u32, u32)>,
}

impl PlaybackHistory {
    /// Consume telemetry independently of serving audio. Retry failed writes without caching them.
    pub async fn run(
        mut self,
        server: Arc<DjLinkServer>,
        mut events: broadcast::Receiver<DjLinkTelemetryEvent>,
        mut shutdown: oneshot::Receiver<()>,
    ) -> Result<()> {
        loop {
            let event = tokio::select! {
                biased;
                event = events.recv() => match event {
                    Ok(event) => event,
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(skipped, "history_telemetry_lagged");
                        continue;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                _ = &mut shutdown => break,
            };
            let observed_at = Local::now().fixed_offset();
            loop {
                let next = event.clone();
                let (history, result) = tokio::task::spawn_blocking(move || {
                    let result = self.observe(&next, observed_at);
                    (self, result)
                })
                .await?;
                self = history;
                match result {
                    Ok(Some(entries)) => {
                        server.set_history(entries);
                        tracing::info!(player = event.player, "history_saved");
                        break;
                    }
                    Ok(None) => break,
                    Err(error) => {
                        tracing::error!(%error, player = event.player, "history_write_failed_retrying");
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_secs(1)) => {},
                            _ = &mut shutdown => return Err(error),
                        }
                    }
                }
            }
        }
        Ok(())
    }

    pub fn open(path: &Path, source_player: u8) -> Result<Self> {
        let connection = open_rekordbox_connection(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS djbooth_play_history (
                sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                day INTEGER NOT NULL,
                track_id TEXT NOT NULL,
                player INTEGER NOT NULL,
                played_at TEXT NOT NULL,
                UNIQUE(day, track_id)
            );",
        )?;
        let mut history = Self {
            connection,
            source_player,
            recorded: HashSet::new(),
        };
        for day in history.entries()? {
            history
                .recorded
                .extend(day.tracks.into_iter().map(|id| (day.history_id, id)));
        }
        Ok(history)
    }

    /// Daily lists, newest day first; tracks retain first-play order within each day.
    pub fn entries(&self) -> Result<Vec<HistoryRecord>> {
        let mut statement = self.connection.prepare(
            "SELECT day, CAST(track_id AS INTEGER) FROM djbooth_play_history
             ORDER BY day DESC, sequence ASC",
        )?;
        let rows =
            statement.query_map([], |row| Ok((row.get::<_, u32>(0)?, row.get::<_, u32>(1)?)))?;
        let mut histories: Vec<HistoryRecord> = Vec::new();
        for row in rows {
            let (day, track) = row?;
            if histories
                .last()
                .is_none_or(|history| history.history_id != day)
            {
                histories.push(HistoryRecord {
                    history_id: day,
                    name: format!("{}-{:02}-{:02}", day / 10000, day / 100 % 100, day % 100),
                    tracks: Vec::new(),
                });
            }
            histories.last_mut().unwrap().tracks.push(track);
        }
        Ok(histories)
    }

    /// Record actual playback from this source, not loads, pauses or another player's library.
    /// Returns an updated menu only after the SQLite write has committed successfully.
    pub fn observe(
        &mut self,
        event: &DjLinkTelemetryEvent,
        observed_at: DateTime<FixedOffset>,
    ) -> Result<Option<Vec<HistoryRecord>>> {
        if event.kind != DjLinkTelemetryKind::Status {
            return Ok(None);
        }
        let Some(deck) = event.deck.as_ref().filter(|deck| {
            deck.playing
                && matches!(
                    deck.play_state,
                    "playing" | "looping" | "cue-playing" | "moving-alt"
                )
                && deck.source_player == self.source_player
                && deck.source_slot == SLOT_REKORDBOX
                && deck.track_type == TRACK_TYPE_REKORDBOX
        }) else {
            return Ok(None);
        };
        let Some(track_id) = deck.track_id.filter(|id| *id != 0) else {
            return Ok(None);
        };
        let day = observed_at.year() as u32 * 10000 + observed_at.month() * 100 + observed_at.day();
        if self.recorded.contains(&(day, track_id)) {
            return Ok(None);
        }
        // One atomic write; SQLite serializes it against imports and analysis writers.
        // A unique key also prevents duplicates across reconnects and concurrent processes.
        self.connection.execute(
            "INSERT INTO djbooth_play_history(day, track_id, player, played_at)
             SELECT ?1, ID, ?3, ?4 FROM djmdContent
             WHERE ID = ?2 AND COALESCE(rb_local_deleted, 0) = 0
             ON CONFLICT(day, track_id) DO NOTHING",
            params![
                day,
                track_id.to_string(),
                deck.player,
                observed_at.to_rfc3339()
            ],
        )?;
        let histories = self.entries()?;
        // Don't cache unknown content: a concurrent library import may make it valid later.
        if histories
            .iter()
            .any(|history| history.history_id == day && history.tracks.contains(&track_id))
        {
            self.recorded.insert((day, track_id));
            Ok(Some(histories))
        } else {
            Ok(None)
        }
    }
}
