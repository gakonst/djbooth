import assert from "node:assert/strict";
import { test } from "node:test";
import { createA9Decoder } from "../../dj-monitor/src/a9-midi.ts";
import { visualLane, waveformBands } from "../../dj-monitor/src/visual-signals.ts";
import type { DashboardSnapshot, DeckState } from "../../dj-monitor/src/types.ts";

const deck = {
  player: 1,
  connected: true,
  playing: true,
  bpm: 120,
  effectiveBpm: 126,
} as DeckState;
function mixer() {
  const snapshot = {
    mixer: { controls: {}, meters: {} },
    decks: [deck],
  } as unknown as DashboardSnapshot;
  const decode = createA9Decoder();
  const send = (...bytes: number[]) => {
    const event = decode(new Uint8Array(bytes), 100);
    if (event) snapshot.mixer.controls[event.name] = event.control;
    return event;
  };
  const level = () => visualLane(snapshot, deck, 1, 1).level;
  return { snapshot, send, level };
}

test("MIDI channel fader, master and crossfader mute the matching live lane", () => {
  const { send, level } = mixer();
  assert.equal(level(), 1);
  send(0xb3, 0x11, 0);
  assert.equal(level(), 0);
  send(0xb3, 0x11, 127);
  assert.equal(level(), 1);
  send(0xb3, 0x18, 0);
  assert.equal(level(), 0);
  send(0xb3, 0x18, 127);
  send(0xb3, 0x41, 0);
  send(0xb3, 0x0b, 127);
  assert.equal(level(), 0);
  send(0xb3, 0x0b, 0);
  assert.equal(level(), 1);
  send(0xb3, 0x12, 0);
  assert.equal(level(), 1);
});

test("MIDI EQ and color filter shape music bands without retiming the CDJ", () => {
  const { snapshot, send } = mixer();
  send(0xb0, 0x04, 0);
  assert.equal(waveformBands(snapshot, 1)[0], 0);
  send(0xb0, 0x04, 64);
  send(0x90, 0x57, 127);
  send(0xb0, 0x05, 127);
  const bands = waveformBands(snapshot, 1);
  assert.equal(bands[0], 0);
  assert.equal(bands[1], 0);
  assert.equal(bands[2], 1);
  assert.equal(visualLane(snapshot, deck, 1, 1).bpm, 126);
});

test("MIDI effect selection survives late releases and exposes beat FX depth", () => {
  const { snapshot, send } = mixer();
  send(0x90, 0x55, 127);
  send(0x90, 0x57, 127);
  send(0x80, 0x55, 0);
  assert.equal(snapshot.mixer.controls["soundColorFx.effect"]!.state, "filter");
  send(0x90, 0x01, 127);
  send(0xb0, 0x72, 127);
  send(0xb0, 0x5b, 127);
  assert.equal(visualLane(snapshot, deck, 1, 1).fx, 1);
  send(0xb0, 0x72, 0);
  assert.equal(visualLane(snapshot, deck, 1, 1).fx, 0);
});

test("14-bit MIDI values combine correctly and malformed messages are ignored", () => {
  const { send } = mixer();
  send(0xb0, 0x0d, 10);
  assert.equal(send(0xb0, 0x2d, 7)!.control.value, 1287);
  assert.equal(send(0xb0, 0x11, 255), null);
  assert.equal(send(0xf8), null);
  assert.equal(send(0xf0, 0x11, 127), null);
});
