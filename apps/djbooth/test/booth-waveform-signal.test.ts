import { expect, it } from "vitest";
import {
  waveformSignal,
  waveformBeat,
  waveformAccent,
} from "../../dj-monitor/src/waveform-signal.js";
import type { TrackWaveform } from "../../dj-monitor/src/types.js";
const waveform: TrackWaveform = {
  durationSeconds: 2,
  peaks: [0.2, 0.8, 0.4],
  colors: [
    [255, 0, 0],
    [0, 0, 255],
    [0, 255, 0],
  ],
  source: "rekordbox",
  beatGrid: [
    { beat: 1, timeSeconds: 0.2 },
    { beat: 2, timeSeconds: 0.7 },
    { beat: 3, timeSeconds: 1.3 },
  ],
};
it("carries local RGB and amplitude together without a fixed deck tint", () => {
  expect(waveformSignal(waveform, 0)).toEqual({ amplitude: 0.2, color: [255, 0, 0] });
  expect(waveformSignal(waveform, 0.5)).toEqual({ amplitude: 0.5, color: [127.5, 0, 127.5] });
  expect(waveformSignal(waveform, -1)).toEqual({ amplitude: 0, color: null });
});
it("aligns pulses to offset and variable beat grids, including seeks", () => {
  expect(waveformBeat(waveform, 0.2, 120)).toBe(0);
  expect(waveformBeat(waveform, 0.7, 120)).toBe(1);
  expect(waveformBeat(waveform, 1, 120)).toBeCloseTo(1.5);
  expect(waveformBeat(waveform, 1.9, 120)).toBeCloseTo(3);
  expect(waveformBeat(waveform, 0.45, 120)).toBeCloseTo(0.5);
});
it("keeps independent deck phases and handles absent analysis", () => {
  expect(waveformBeat(null, 0.25, 120)).toBe(0.5);
  expect(waveformBeat(null, 0.25, 60)).toBe(0.25);
  expect(waveformSignal(null, 1).color).toBeNull();
});

it("preserves green/blue on quieter decks and between beats instead of whitening them", () => {
  const cyan = waveformAccent([0, 210, 255], 0.15, 0);
  expect(cyan[1]).toBeGreaterThan(cyan[0] * 4);
  expect(cyan[2]).toBeGreaterThan(cyan[1]);
  const green = waveformAccent([0, 255, 60], 0.1, 0);
  expect(green[1]).toBeGreaterThan(green[2] * 2);
  const red = waveformAccent([255, 0, 0], 0.9, 0);
  expect(red[0]).toBeGreaterThan(red[1] * 4);
});

it("brightens the same deck's hue on its beat without changing other decks", () => {
  const quiet = waveformAccent([0, 210, 255], 0.2, 0);
  const beat = waveformAccent([0, 210, 255], 0.2, 1);
  expect(beat[2]).toBeGreaterThan(quiet[2] * 1.5);
  expect(beat[2]).toBeGreaterThan(beat[1]);
  expect(beat[1]).toBeGreaterThan(beat[0]);
  const neutral = waveformAccent([255, 0, 0], 0.8, 1, 0);
  expect(neutral[0]).toBe(neutral[1]);
  expect(neutral[1]).toBe(neutral[2]);
});
