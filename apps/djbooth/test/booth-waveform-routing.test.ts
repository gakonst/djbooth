import { expect, it } from "vitest";
import { waveformVisualLane } from "../../dj-monitor/src/visual-signals.js";
import type { DashboardSnapshot, DeckState, TrackWaveform } from "../../dj-monitor/src/types.js";

const state = {
  mixer: { controls: {}, meters: { "usb.3_4": { rmsDbfs: -120 } } },
} as unknown as DashboardSnapshot;
const deck = { connected: true, playing: true, bpm: 126 } as DeckState;
const wave: TrackWaveform = { source: "rekordbox", durationSeconds: 10, peaks: [0.2, 0.8] };

it("uses each player's waveform even when its numbered USB pair is silent", () => {
  expect(waveformVisualLane(state, deck, 2, wave, 0).level).toBeCloseTo(0.2);
  expect(waveformVisualLane(state, deck, 2, wave, 10).level).toBeCloseTo(0.8);
  expect(waveformVisualLane(state, deck, 1, { ...wave, peaks: [0.5, 0.1] }, 10).level).toBeCloseTo(
    0.1,
  );
  expect(waveformVisualLane(state, deck, 2, wave, 0).level).toBeCloseTo(0.2);
});

it("stops a paused deck and respects a closed channel fader", () => {
  expect(waveformVisualLane(state, { ...deck, playing: false }, 2, wave, 10).level).toBe(0);
  const muted = {
    ...state,
    mixer: {
      ...state.mixer,
      controls: {
        "channel.2.fader": {
          percent: 0,
          label: "Fader",
          value: 0,
          state: null,
          raw: "",
          changedAtUs: 0,
        },
      },
    },
  } satisfies DashboardSnapshot;
  expect(waveformVisualLane(muted, deck, 2, wave, 10).level).toBe(0);
  expect(waveformVisualLane(state, deck, 2, { ...wave, source: "placeholder" }, 10).level).toBe(0);
});
