import assert from "node:assert/strict";
import { test } from "node:test";
import { createDanceMotion, sampleDance } from "../../dj-monitor/src/music-dance.ts";
import { buildChart, chartFor } from "../src/music/note-chart.ts";
import { waveformBeat } from "../../dj-monitor/src/waveform-signal.ts";
import type { TrackRhythm } from "../../djbooth/src/shared/types.ts";
import type { TrackWaveform } from "../../dj-monitor/src/types.ts";

test("choreography lands on kicks and shifts weight on alternating beats", () => {
  const kick = sampleDance(8, 0.6, 0.8, 0.5, 0.3);
  const offbeat = sampleDance(8.5, 0.6, 0.8, 0.5, 0.3);
  const other = sampleDance(9.5, 0.6, 0.8, 0.5, 0.3);
  assert.ok(kick.bounce < 0.00001 && kick.kick > 0.8);
  assert.ok(offbeat.bounce > 0.8 && offbeat.sway > 0.7);
  assert.ok(other.sway < -0.7);
  assert.ok(offbeat.kick < kick.kick * 0.02);
});

test("silence and invalid input cannot manufacture a dance", () => {
  for (const value of [sampleDance(4, 0, 1, 1, 1), sampleDance(NaN, 0.5, 1, 1, 1)]) {
    assert.equal(value.active, false);
    assert.equal(value.drive, 0);
    assert.equal(value.bounce, 0);
  }
  const dancer = createDanceMotion();
  dancer.update(0.5, 0.7, 0.6, 0.5, 0.2, 0.1);
  let atRest = dancer.update(0, 0, 0, 0, 0, 0.1);
  for (let i = 0; i < 30; i++) atRest = dancer.update(0, 0, 0, 0, 0, 0.1);
  assert.ok(atRest.bounce < 0.00001 && Math.abs(atRest.sway) < 0.00001);
});

function song(silentFrom = Infinity, silentTo = Infinity) {
  const duration = 32,
    rate = 200,
    beat = 0.5;
  const bytes = new Uint8Array(duration * rate * 3);
  const peaks: number[] = [];
  for (let i = 0; i < duration * rate; i++) {
    const time = i / rate,
      sub = Math.floor(time / (beat / 4) + 1e-8),
      phase = time - (sub * beat) / 4;
    const silent = time >= silentFrom && time < silentTo;
    const env = silent ? 0 : Math.exp(-phase * 70);
    const values = [sub % 4 === 0 ? env : 0, sub % 8 === 4 ? env * 0.95 : 0, env * 0.72];
    values.forEach((v, b) => (bytes[i * 3 + b] = Math.round(v * 127)));
    peaks.push(Math.max(...values));
  }
  const waveform: TrackWaveform = {
    durationSeconds: duration,
    peaks,
    source: "rekordbox",
    beatGrid: Array.from({ length: duration / beat }, (_, i) => ({
      timeSeconds: i * beat,
      beat: ((i % 4) + 1) as 1 | 2 | 3 | 4,
    })),
  };
  const rhythm: TrackRhythm = {
    durationSeconds: duration,
    bands: { rate, data: Buffer.from(bytes).toString("base64") },
    phrases: {
      mood: "high",
      entries: [{ kind: "verse", startSeconds: 0, endSeconds: duration, fillSeconds: null }],
    },
  };
  return { waveform, rhythm };
}

test("hard chart starts with sixteenths and chords instead of an easy ramp", () => {
  const { waveform, rhythm } = song();
  const { notes } = buildChart(waveform, 120, rhythm);
  const early = notes.filter((n) => n.time >= 2 && n.time < 6);
  const late = notes.filter((n) => n.time >= 18 && n.time < 22);
  assert.ok(early.length >= 32, `Expected dense opening, got ${early.length}`);
  assert.ok(early.some((n) => Math.abs(((n.time / 0.5) % 1) - 0.25) < 0.001));
  assert.equal(early.length, late.length);
  const chord = early.filter((n) => Math.abs(n.time - 2.5) < 0.001);
  assert.equal(chord.length, 3);
  assert.equal(new Set(notes.map((n) => `${n.time.toFixed(4)}:${n.lane}`)).size, notes.length);
});

test("hard charts leave actual silence empty", () => {
  const { waveform, rhythm } = song(8, 12);
  const chart = buildChart(waveform, 120, rhythm);
  assert.equal(chart.notes.filter((n) => n.time > 8.05 && n.time < 11.95).length, 0);
  const empty = buildChart({ ...waveform, peaks: waveform.peaks.map(() => 0) }, 120);
  assert.equal(empty.notes.length, 0);
});

test("each track charts on its own BPM, including sixteenths", () => {
  const original = song();
  for (const bpm of [80, 120, 180]) {
    const scale = 120 / bpm;
    const waveform: TrackWaveform = {
      ...original.waveform,
      durationSeconds: original.waveform.durationSeconds * scale,
      beatGrid: undefined,
    };
    const rhythm: TrackRhythm = {
      ...original.rhythm,
      bands: { ...original.rhythm.bands!, rate: original.rhythm.bands!.rate / scale },
      phrases: null,
    };
    const chart = chartFor(`tempo-${bpm}`, waveform, bpm, rhythm);
    assert.equal(chart.frets[1]!.time, 60 / bpm);
    assert.ok(chart.notes.length > 100);
    for (const note of chart.notes) {
      const sixteenth = (note.time * bpm) / 15;
      assert.ok(Math.abs(sixteenth - Math.round(sixteenth)) < 1e-7);
    }
  }
});

test("short offset beat grids override nominal BPM and preserve downbeats", () => {
  const waveform: TrackWaveform = {
    durationSeconds: 6,
    source: "rekordbox",
    peaks: Array(1200).fill(0.6),
    beatGrid: Array.from({ length: 12 }, (_, i) => ({
      timeSeconds: 0.17 + i * 0.45,
      beat: (((i + 2) % 4) + 1) as 1 | 2 | 3 | 4,
    })),
  };
  const slow = buildChart(waveform, 80);
  const fast = buildChart(waveform, 180);
  assert.deepEqual(
    slow.frets.map((f) => f.time),
    waveform.beatGrid!.map((b) => b.timeSeconds),
  );
  assert.deepEqual(
    slow.song.bars,
    waveform.beatGrid!.filter((b) => b.beat === 1).map((b) => b.timeSeconds),
  );
  assert.deepEqual(slow.notes, fast.notes);
  for (const note of slow.notes) {
    const subdivision = waveformBeat(waveform, note.time, 80) * 4;
    assert.ok(Math.abs(subdivision - Math.round(subdivision)) < 1e-7);
  }
});

test("cached charts refresh when a track's BPM or analysis is corrected", () => {
  const original = song();
  const waveform = { ...original.waveform, beatGrid: undefined } as TrackWaveform;
  const first = chartFor("corrected-track", waveform, 120);
  assert.equal(chartFor("corrected-track", waveform, 120), first);
  const changedTempo = chartFor("corrected-track", waveform, 100);
  assert.notEqual(changedTempo, first);
  assert.equal(changedTempo.frets[1]!.time, 0.6);
  waveform.beatGrid = original.waveform.beatGrid!.map((b) => ({
    ...b,
    timeSeconds: b.timeSeconds + 0.12,
  }));
  const changedGrid = chartFor("corrected-track", waveform, 100);
  assert.notEqual(changedGrid, changedTempo);
  assert.equal(changedGrid.frets[0]!.time, 0.12);
  const detailed = chartFor("corrected-track", waveform, 100, original.rhythm);
  const silent = chartFor("corrected-track", waveform, 100, {
    ...original.rhythm,
    bands: { rate: 200, data: Buffer.alloc(32 * 200 * 3).toString("base64") },
  });
  assert.ok(detailed.notes.length > 0);
  assert.equal(silent.notes.length, 0);
});

test("loading the same track on two decks retains both cached analyses", () => {
  const a = song();
  const b = song();
  const first = chartFor("both-decks", a.waveform, 120, a.rhythm);
  const second = chartFor("both-decks", b.waveform, 120, b.rhythm);
  assert.equal(chartFor("both-decks", a.waveform, 120, a.rhythm), first);
  assert.equal(chartFor("both-decks", b.waveform, 120, b.rhythm), second);
});
