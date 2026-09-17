//! Recorded-set publication metadata, reduced from the same durable Rust timeline.
use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Track {
    player: u64,
    source_player: Option<u64>,
    source_slot: Option<u64>,
    track_id: u64,
    title: String,
    artist: String,
    elapsed_us: u64,
    on_air_observed: Option<bool>,
    on_air_elapsed_us: Option<u64>,
}

/// Rebuildable artifacts only: events.jsonl remains the original performance capture.
/// Playback is not proof of audibility: headphone previews are retained and labelled
/// for review when the mixer's on-air telemetry did not confirm them.
pub fn prepare(directory: &Path) -> Result<Value> {
    anyhow::ensure!(
        directory.is_absolute(),
        "Recording directory must be absolute"
    );
    let input = BufReader::new(File::open(directory.join("events.jsonl"))?);
    let mut tracks: Vec<Track> = Vec::new();
    let mut loaded = BTreeMap::<u64, (Value, Option<usize>)>::new();
    let mut started_ns = None;
    let mut audio_origin_us = None;
    let mut finished = false;
    let mut audio_frames = 0;
    let mut gaps = 0;
    let mut interrupted = false;
    for line in input.lines() {
        let row: Value = serde_json::from_str(&line?).context("Invalid recording timeline")?;
        let payload = &row["payload"];
        let elapsed = row["elapsedUs"].as_u64().unwrap_or(0);
        match row["kind"].as_str().unwrap_or("") {
            "recordingStarted" => {
                started_ns = row["monotonicNs"]
                    .as_str()
                    .and_then(|v| v.parse::<u64>().ok())
                    .map(|v| v.saturating_sub(elapsed.saturating_mul(1000)));
            }
            "audioBuffer" => {
                audio_frames += payload["frames"].as_u64().unwrap_or(0);
                if audio_origin_us.is_none() {
                    audio_origin_us = Some(
                        payload["hostTimeNs"]
                            .as_str()
                            .and_then(|v| v.parse::<u64>().ok())
                            .zip(started_ns)
                            .map(|(sample, start)| sample.saturating_sub(start) / 1000)
                            .unwrap_or(elapsed),
                    );
                }
            }
            "captureGap" => gaps += payload["count"].as_u64().unwrap_or(1),
            "interrupted" | "recorderError" => interrupted = true,
            "recordingStopped" => {
                finished = true;
                gaps = gaps.max(payload["gaps"].as_u64().unwrap_or(0));
            }
            "hardware" => {
                let Some(decks) = payload["snapshot"]["decks"].as_array() else {
                    continue;
                };
                loaded.retain(|player, _| {
                    decks.iter().any(|deck| {
                        deck["player"].as_u64() == Some(*player) && deck["connected"] != false
                    })
                });
                for deck in decks {
                    if deck["connected"] == false {
                        continue;
                    }
                    let Some(player) = deck["player"].as_u64() else {
                        continue;
                    };
                    let identity =
                        json!([deck["sourcePlayer"], deck["sourceSlot"], deck["trackId"]]);
                    let state = loaded.entry(player).or_insert((Value::Null, None));
                    if state.0 != identity {
                        *state = (identity, None);
                    }
                    let Some(track_id) = deck["trackId"].as_u64().filter(|v| *v > 0) else {
                        continue;
                    };
                    if deck["playing"] != true {
                        continue;
                    }
                    let index = *state.1.get_or_insert_with(|| {
                        tracks.push(Track {
                            player,
                            source_player: deck["sourcePlayer"].as_u64(),
                            source_slot: deck["sourceSlot"].as_u64(),
                            track_id,
                            title: format!("Unknown track {track_id}"),
                            artist: String::new(),
                            elapsed_us: elapsed,
                            on_air_observed: None,
                            on_air_elapsed_us: None,
                        });
                        tracks.len() - 1
                    });
                    let track = &mut tracks[index];
                    if let Some(title) = deck["trackTitle"].as_str().filter(|v| !v.is_empty()) {
                        track.title = clean(title);
                    }
                    if let Some(artist) = deck["trackArtist"].as_str().filter(|v| !v.is_empty()) {
                        track.artist = clean(artist);
                    }
                    // The Rust decoder's onAir flag is independent of CDJ activity.
                    if let Some(on_air) = deck["onAir"].as_bool() {
                        if on_air {
                            track.on_air_elapsed_us.get_or_insert(elapsed);
                        }
                        track.on_air_observed =
                            Some(track.on_air_observed.unwrap_or(false) || on_air);
                    }
                }
            }
            _ => {}
        }
    }
    anyhow::ensure!(finished, "Stop recording before preparing the set");
    let origin = audio_origin_us.unwrap_or(0);
    for track in &mut tracks {
        track.elapsed_us = track.elapsed_us.saturating_sub(origin);
        track.on_air_elapsed_us = track.on_air_elapsed_us.map(|v| v.saturating_sub(origin));
    }
    tracks.sort_by_key(|track| {
        (
            track.on_air_elapsed_us.unwrap_or(track.elapsed_us),
            track.player,
        )
    });
    let mut description = String::from(
        "Tracklist (on-air timestamps where available; unconfirmed playback marked *):\n",
    );
    for track in &tracks {
        let seconds = track.on_air_elapsed_us.unwrap_or(track.elapsed_us) / 1_000_000;
        let title = if track.artist.is_empty() {
            track.title.clone()
        } else {
            format!("{} – {}", track.artist, track.title)
        };
        description.push_str(&format!(
            "{:02}:{:02}:{:02} {}{}\n",
            seconds / 3600,
            seconds / 60 % 60,
            seconds % 60,
            title,
            if track.on_air_observed == Some(true) {
                ""
            } else {
                " *"
            }
        ));
    }
    let report = json!({"schemaVersion":1,"tracks":tracks,"description":description,
        "timestampOrigin":if audio_origin_us.is_some() {"firstAudioSample"} else {"recordingStart"},
        "audioFrames":audio_frames,"gaps":gaps,"interrupted":interrupted,
        "requiresTracklistReview":tracks.iter().any(|t| t.on_air_observed != Some(true)),"soundCloudDescriptionFits":description.chars().count() <= 4000});
    // Replace derivative files atomically; keep every entry even when SoundCloud's
    // description limit would require an attached/external full tracklist.
    for (name, bytes) in [
        ("tracklist.json", serde_json::to_vec_pretty(&report)?),
        ("tracklist.txt", description.into_bytes()),
    ] {
        let temporary = directory.join(format!(".{name}.tmp"));
        std::fs::write(&temporary, bytes)?;
        std::fs::rename(temporary, directory.join(name))?;
    }
    Ok(report)
}
fn clean(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn deck(player: u64, id: Value, playing: bool, active: bool) -> Value {
        json!({"player":player,"trackId":id,"sourcePlayer":17,"sourceSlot":4,
            "playing":playing,"active":active,"trackTitle":"Title\nInjected","trackArtist":"Artist"})
    }
    #[test]
    fn keeps_every_deck_reloads_and_aligns_to_audio_not_callback_time() {
        let directory = tempfile::tempdir().unwrap();
        let mut rows =
            vec![json!({"kind":"recordingStarted","elapsedUs":0,"monotonicNs":"1000000000"})];
        let mut hardware = |elapsed, decks| {
            rows.push(json!({"kind":"hardware","elapsedUs":elapsed,"payload":{"snapshot":{"decks":decks}}}))
        };
        hardware(
            100_000,
            vec![
                deck(1, json!(9), true, false),
                deck(2, json!(10), false, false),
            ],
        );
        hardware(
            300_000,
            vec![
                deck(1, json!(9), false, false),
                deck(2, json!(10), true, true),
            ],
        );
        hardware(
            400_000,
            vec![
                deck(1, json!(9), true, true),
                deck(2, json!(10), true, true),
            ],
        );
        hardware(500_000, vec![deck(1, Value::Null, false, false)]);
        hardware(
            600_000,
            vec![
                deck(1, json!(9), true, false),
                deck(6, json!(42), true, true),
            ],
        );
        rows.push(json!({"kind":"audioBuffer","elapsedUs":450_000,"payload":{"frames":4800,"hostTimeNs":"1200000000"}}));
        rows.push(json!({"kind":"recordingStopped","payload":{"gaps":2}}));
        std::fs::write(
            directory.path().join("events.jsonl"),
            rows.iter()
                .map(|r| r.to_string() + "\n")
                .collect::<String>(),
        )
        .unwrap();
        let report = prepare(directory.path()).unwrap();
        let tracks = report["tracks"].as_array().unwrap();
        assert_eq!(tracks.len(), 4);
        assert_eq!(tracks[0]["elapsedUs"], 0);
        assert!(tracks[0]["onAirObserved"].is_null());
        assert_eq!(tracks[1]["elapsedUs"], 100_000);
        assert_eq!(tracks[2]["elapsedUs"], 400_000);
        assert_eq!(tracks[3]["player"], 6);
        assert_eq!(tracks[0]["title"], "Title Injected");
        assert_eq!(report["audioFrames"], 4800);
        assert_eq!(report["gaps"], 2);
        assert_eq!(report["timestampOrigin"], "firstAudioSample");
        assert!(directory.path().join("tracklist.txt").exists());
    }
    #[test]
    fn uses_real_on_air_and_records_reappearance_as_a_new_play() {
        let directory = tempfile::tempdir().unwrap();
        let rows = [
            (
                100,
                json!([{"player":1,"trackId":9,"playing":true,"active":true,"onAir":false}]),
            ),
            (
                200,
                json!([{"player":1,"trackId":9,"playing":true,"active":false,"onAir":true}]),
            ),
            (300, json!([])),
            (
                400,
                json!([{"player":1,"trackId":9,"playing":true,"onAir":true}]),
            ),
        ];
        let mut lines = rows
            .iter()
            .map(|(at, decks)| {
                json!({"kind":"hardware","elapsedUs":at,"payload":{"snapshot":{"decks":decks}}})
                    .to_string()
                    + "\n"
            })
            .collect::<String>();
        lines.push_str("{\"kind\":\"recordingStopped\"}\n");
        std::fs::write(directory.path().join("events.jsonl"), lines).unwrap();
        let report = prepare(directory.path()).unwrap();
        assert_eq!(report["tracks"].as_array().unwrap().len(), 2);
        assert_eq!(report["tracks"][0]["elapsedUs"], 100);
        assert_eq!(report["tracks"][0]["onAirElapsedUs"], 200);
        assert_eq!(report["tracks"][0]["onAirObserved"], true);
        assert_eq!(report["tracks"][1]["onAirElapsedUs"], 400);
        assert_eq!(report["requiresTracklistReview"], false);
    }

    #[test]
    fn refuses_live_or_unfinished_timeline() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("events.jsonl"),
            "{\"kind\":\"recordingStarted\"}\n",
        )
        .unwrap();
        assert!(prepare(directory.path()).is_err());
    }
}
