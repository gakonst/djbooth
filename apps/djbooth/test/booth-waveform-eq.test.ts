import { expect, it } from "vitest";
import { waveformBands, waveformVisualLane } from "../../dj-monitor/src/visual-signals.js";
import { shapeWaveformSignal } from "../../dj-monitor/src/waveform-signal.js";
import type { ControlState, DashboardSnapshot, DeckState } from "../../dj-monitor/src/types.js";

const control = (percent: number | null, state: string | null = null): ControlState => ({
  percent,
  state,
  label: "test",
  value: null,
  raw: "",
  changedAtUs: 0,
});
const snapshot = (controls: Record<string, ControlState>): DashboardSnapshot => ({
  schemaVersion: 1,
  sequence: 0,
  observedAtUs: 0,
  decks: [],
  mixer: { device: "DJM-A9", connected: true, bpm: 120, controls, meters: {} },
});
const signal = { amplitude: 0.6, color: [240, 80, 20] };

it("preserves the waveform at neutral EQ and filter settings", () => {
  const bands = waveformBands(snapshot({}), 1);
  expect(bands).toEqual([1, 1, 1]);
  expect(shapeWaveformSignal(signal, bands)).toEqual(signal);
});

it("cuts bass independently and dims bass-heavy samples more than treble-heavy samples", () => {
  const state = snapshot({ "channel.1.eq.low": control(0) });
  const bands = waveformBands(state, 1);
  expect(shapeWaveformSignal(signal, bands).amplitude).toBeLessThan(0.2);
  expect(
    shapeWaveformSignal({ amplitude: 0.6, color: [20, 80, 240] }, bands).amplitude,
  ).toBeGreaterThan(0.5);
  expect(waveformBands(state, 2)).toEqual([1, 1, 1]);
  expect(signal.color).toEqual([240, 80, 20]);
});

it("sweeps low-pass left and high-pass right only when FILTER is selected", () => {
  const state = snapshot({
    "soundColorFx.effect": control(null, "filter"),
    "channel.1.color": control(0),
  });
  expect(waveformBands(state, 1)).toEqual([1, 0, 0]);
  state.mixer.controls["channel.1.color"] = control(100);
  expect(waveformBands(state, 1)).toEqual([0, 0, 1]);
  state.mixer.controls["channel.1.color"] = control(50);
  expect(waveformBands(state, 1)).toEqual([1, 1, 1]);
  state.mixer.controls["soundColorFx.effect"] = control(null, "noise");
  state.mixer.controls["channel.1.color"] = control(0);
  expect(waveformBands(state, 1)).toEqual([1, 1, 1]);
});

it("silences the waveform and its scene energy when all three EQ bands are cut", () => {
  const state = snapshot(
    Object.fromEntries(["low", "mid", "high"].map((band) => [`channel.1.eq.${band}`, control(0)])),
  );
  const bands = waveformBands(state, 1);
  expect(shapeWaveformSignal(signal, bands).amplitude).toBe(0);
  expect(shapeWaveformSignal({ amplitude: 0.8, color: null }, bands).amplitude).toBe(0);
  const deck = { connected: true, playing: true } as DeckState;
  expect(
    waveformVisualLane(
      state,
      deck,
      1,
      { source: "rekordbox", durationSeconds: 1, peaks: [0.6], colors: [[240, 80, 20]] },
      0,
    ).level,
  ).toBe(0);
});
