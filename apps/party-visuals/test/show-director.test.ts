import assert from "node:assert/strict";
import { test } from "node:test";
import { createShowDirector } from "../src/music/show-director.ts";
import { createMusicFollower } from "../src/music/follow.ts";
import type { MusicLane } from "../src/scenes.ts";

const lane = (patch: Partial<MusicLane> = {}): MusicLane => ({
  trackId: "a",
  waveform: null,
  time: 0.1,
  playing: true,
  level: 0.5,
  bpm: 120,
  ...patch,
});
const bands = new Float32Array([0.5, 0.6, 0.4, 0.2, 0.5, 0.4, 0.5, 0.3]);

test("muting the followed deck holds the course, while a paused seek repositions it", () => {
  const follow = createMusicFollower();
  const song = lane({
    time: 2,
    waveform: { durationSeconds: 60, source: "rekordbox", peaks: [0.3, 0.5, 0.4] },
  });
  const before = follow.update([song], 1, 0.1);
  song.level = 0;
  song.time = 8;
  const muted = follow.update([song], 2, 0.1);
  assert.equal(muted.time, before.time);
  assert.equal(muted.playing, false);
  song.playing = false;
  song.time = 15;
  assert.equal(follow.update([song], 3, 0.1).time, 15);
});

test("muted and paused decks never generate musical lighting", () => {
  const director = createShowDirector();
  const cue = director.update([lane({ level: 0 }), lane({ playing: false })], bands, 0.05);
  assert.equal(cue.active, false);
  assert.equal(cue.phase, "idle");
  assert.equal(cue.kick, 0);
  assert.equal(cue.energy, 0);
});

test("Rekordbox phrases take priority and seeking updates the phrase immediately", () => {
  const director = createShowDirector();
  const song = lane({
    rhythm: {
      durationSeconds: 40,
      phrases: {
        mood: "high",
        entries: [
          { kind: "up", startSeconds: 0, endSeconds: 20, fillSeconds: null },
          { kind: "chorus", startSeconds: 20, endSeconds: 40, fillSeconds: null },
        ],
      },
    },
  });
  assert.equal(director.update([song], bands, 0.05).phase, "build");
  song.time = 25;
  const cue = director.update([song], bands, 0.05);
  assert.equal(cue.phase, "drop");
  assert.equal(cue.source, "phrases");
  assert.equal(cue.progress, 0.25);
  assert.ok(cue.bloom > 0);
});

test("a crossfade only hands over tempo after the new leader remains louder", () => {
  const director = createShowDirector();
  const a = lane({ bpm: 120 });
  const b = lane({ trackId: "b", bpm: 135, level: 0.2 });
  director.update([a, b], bands, 0.1);
  b.level = 0.8;
  for (let i = 0; i < 5; i++) assert.equal(director.update([a, b], bands, 0.1).bpm, 120);
  for (let i = 0; i < 3; i++) director.update([a, b], bands, 0.1);
  assert.equal(director.update([a, b], bands, 0.1).bpm, 135);
  b.playing = false;
  assert.equal(director.update([a, b], bands, 0.1).bpm, 120);
});

test("missing analysis uses audible bands, without inventing a phrase", () => {
  const cue = createShowDirector().update([lane()], bands, 0.05);
  assert.equal(cue.source, "audio");
  assert.equal(cue.phase, "groove");
  assert.ok(cue.bass > cue.air);
});

test("placeholder waveforms never claim to identify song structure", () => {
  const waveform = { durationSeconds: 60, source: "placeholder" as const, peaks: [0.9, 0.9, 0.9] };
  const cue = createShowDirector().update([lane({ waveform })], bands, 0.05);
  assert.equal(cue.source, "audio");
  assert.equal(cue.phase, "groove");
});

test("beat indicators account for a beat grid beginning off the downbeat", () => {
  const waveform = {
    durationSeconds: 4,
    source: "rekordbox" as const,
    peaks: [0.4, 0.5],
    beatGrid: [
      { timeSeconds: 0, beat: 3 as const },
      { timeSeconds: 0.5, beat: 4 as const },
    ],
  };
  const cue = createShowDirector().update([lane({ time: 0.25, waveform })], bands, 0.05);
  assert.equal(cue.beat, 2.5);
});

test("silence drains the envelopes after transport stops", () => {
  const director = createShowDirector();
  const song = lane();
  for (let i = 0; i < 30; i++) director.update([song], bands, 0.1);
  song.playing = false;
  let cue = director.update([song], bands, 0.1);
  for (let i = 0; i < 40; i++) cue = director.update([song], bands, 0.1);
  assert.equal(cue.source, "idle");
  assert.ok(cue.kick < 0.00001 && cue.bass < 0.00001 && cue.energy < 0.00001);
});

test("pitched playback uses source tempo with the audio playhead, without doubling the speed", () => {
  const director = createShowDirector();
  const track = lane({ sourceBpm: 120, bpm: 150, time: 1.25 });
  const first = director.update([track], bands, 0.05);
  assert.equal(first.bpm, 150);
  assert.equal(first.beat, 2.5);
  track.time = 2.5;
  assert.equal(director.update([track], bands, 0.05).beat, 5);
  // A seek uses the track position immediately; no accumulated animation clock.
  track.time = 10.25;
  assert.equal(director.update([track], bands, 0.05).beat, 20.5);
});
