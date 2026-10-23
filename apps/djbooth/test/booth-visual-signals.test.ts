import { describe, expect, it } from "vitest";
import { visualLane } from "../../dj-monitor/src/visual-signals.js";
import { createA9Decoder } from "../../dj-monitor/src/a9-midi.js";
import type { ControlState, DashboardSnapshot, DeckState } from "../../dj-monitor/src/types.js";
const control = (percent: number | null, state: string | null = null): ControlState => ({
  percent,
  state,
  label: "test",
  value: 0,
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
const deck = { connected: true, playing: true, bpm: 128 } as DeckState;
describe("booth visual routing", () => {
  it("silences a closed fader or assigned crossfader side without muting thru channels", () => {
    expect(visualLane(snapshot({ "channel.2.fader": control(0) }), deck, 2).level).toBe(0);
    const state = snapshot({
      "crossfader.position": control(100),
      "channel.1.crossfaderAssign": control(null, "a"),
    });
    expect(visualLane(state, deck, 1).level).toBe(0);
    expect(visualLane(state, deck, 2).level).toBeGreaterThan(0);
  });
  it("routes Beat FX only to the selected channel and only while on", () => {
    const state = snapshot({
      "beatFx.channel": control(null, "channel2"),
      "beatFx.on": control(null, "on"),
      "beatFx.levelDepth": control(80),
    });
    expect(visualLane(state, deck, 1).fx).toBe(0);
    expect(visualLane(state, deck, 2).fx).toBe(0.8);
    state.mixer.controls["beatFx.on"] = control(null, "off");
    expect(visualLane(state, deck, 2).fx).toBe(0);
  });
  it("does not invent playing energy for unplugged or paused decks", () => {
    expect(visualLane(snapshot({}), undefined, 1).level).toBe(0);
    expect(visualLane(snapshot({}), { ...deck, playing: false }, 1).level).toBe(0);
  });
  it("routes library analyzer energy through the same mixer gains as live decks", () => {
    const state = snapshot({
      "channel.1.fader": control(50),
      "master.level": control(80),
      "channel.1.trim": control(50),
      "channel.1.crossfaderAssign": control(null, "a"),
      "crossfader.position": control(75),
    });
    expect(visualLane(state, deck, 1, 0.8).level).toBeCloseTo(0.16);
    state.mixer.controls["master.level"] = control(0);
    expect(visualLane(state, deck, 1, 0.8).level).toBe(0);
    expect(visualLane(snapshot({}), { ...deck, playing: false }, 1, 0.8).level).toBe(0);
  });
});
describe("browser A9 MIDI decoding", () => {
  it("handles cues, note-off, FX selection, crossfader assignment and EQ", () => {
    const decode = createA9Decoder();
    const read = (s: number, c: number, v: number) => decode(new Uint8Array([s, c, v]), 100);
    expect(read(0x90, 0x0a, 127)).toMatchObject({
      name: "channel.1.cueA",
      control: { state: "on" },
    });
    expect(read(0x80, 0x0a, 64)).toMatchObject({ control: { state: "off" } });
    expect(read(0xb0, 0x37, 127)).toMatchObject({
      name: "beatFx.effect",
      control: { state: "echo" },
    });
    expect(read(0xb0, 0x41, 64)).toMatchObject({
      name: "channel.1.crossfaderAssign",
      control: { state: "thru" },
    });
    expect(read(0xb0, 0x04, 127)).toMatchObject({
      name: "channel.1.eq.low",
      control: { percent: 100 },
    });
  });
  it("combines FX time bytes and ignores unsupported messages", () => {
    const decode = createA9Decoder();
    decode(new Uint8Array([0xb0, 0x0d, 2]), 0);
    expect(decode(new Uint8Array([0xb0, 0x2d, 3]), 0)).toMatchObject({
      name: "beatFx.time",
      control: { value: 259 },
    });
    expect(decode(new Uint8Array([0xf8]), 0)).toBeNull();
    expect(decode(new Uint8Array([0xe0, 0, 64]), 0)).toBeNull();
  });
});
