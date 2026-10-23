import type { ControlState, DashboardSnapshot, DeckState, TrackWaveform } from "./types.js";
import { waveformSignal, shapeWaveformSignal, type WaveformBands } from "./waveform-signal.js";

/** Neutral knobs preserve the source. Only the selected FILTER suppresses bands. */
export function waveformBands(snapshot: DashboardSnapshot, channel: number): WaveformBands {
  const controls = snapshot.mixer.controls;
  const prefix = `channel.${channel}.`;
  const eq = ["low", "mid", "high"].map(
    (band) => controlValue(controls, `${prefix}eq.${band}`, 0.5) * 2,
  );
  const filter =
    controls["soundColorFx.effect"]?.state === "filter"
      ? controlValue(controls, `${prefix}color`, 0.5) * 2 - 1
      : 0;
  const pass = Math.max(0, 1 - Math.abs(filter));
  return [
    eq[0]! * (filter > 0 ? pass ** 6 : 1),
    eq[1]! * pass ** 2,
    eq[2]! * (filter < 0 ? pass ** 6 : 1),
  ];
}

/** Player waveform energy is independent of the mixer's configurable USB routing. */
export function waveformVisualLane(
  snapshot: DashboardSnapshot,
  deck: DeckState | undefined,
  channel: number,
  waveform: TrackWaveform | null | undefined,
  position: number,
): VisualLane {
  const bands = waveformBands(snapshot, channel);
  const lane = visualLane(
    snapshot,
    deck,
    channel,
    waveform?.source === "rekordbox"
      ? shapeWaveformSignal(waveformSignal(waveform, position), bands).amplitude
      : undefined,
  );
  return { ...lane, low: bands[0] * 0.5, mid: bands[1] * 0.5, high: bands[2] * 0.5 };
}

export type VisualLane = {
  level: number;
  low: number;
  mid: number;
  high: number;
  color: number;
  fx: number;
  cue: number;
  bpm: number;
  effect: number;
};
const clamp = (x: number) => Math.max(0, Math.min(1, x));
export function controlValue(
  controls: Record<string, ControlState>,
  name: string,
  fallback: number,
): number {
  const value = controls[name]?.percent;
  return value == null || !Number.isFinite(value) ? fallback : clamp(value / 100);
}
export function visualLane(
  snapshot: DashboardSnapshot,
  deck: DeckState | undefined,
  channel: number,
  sourceLevel?: number,
): VisualLane {
  const c = snapshot.mixer.controls;
  const prefix = `channel.${channel}.`;
  const value = (name: string, fallback: number) => controlValue(c, prefix + name, fallback);
  const cross = controlValue(c, "crossfader.position", 0.5);
  const assign = c[prefix + "crossfaderAssign"]?.state;
  const crossGain =
    assign === "a" ? Math.min(1, 2 * (1 - cross)) : assign === "b" ? Math.min(1, 2 * cross) : 1;
  const selected = c["beatFx.channel"]?.state;
  const fxSelected =
    selected === "master" ||
    selected === `channel${channel}` ||
    (selected === "crossfaderA" && assign === "a") ||
    (selected === "crossfaderB" && assign === "b");
  const fxOn = c["beatFx.on"]?.state === "on" || controlValue(c, "beatFx.on", 0) > 0;
  const meter = snapshot.mixer.meters?.[`usb.${channel * 2 - 1}_${channel * 2}`];
  const energy = sourceLevel ?? (meter ? clamp((meter.rmsDbfs + 60) / 54) : 0.6);
  const effects = [
    "delay",
    "spiral",
    "roll",
    "tripletRoll",
    "flanger",
    "pingPong",
    "trans",
    "reverb",
    "echo",
    "phaser",
    "tripletFilter",
    "filter",
    "mobius",
    "helix",
  ];
  return {
    level:
      deck?.connected && deck.playing
        ? energy *
          value("fader", 1) *
          crossGain *
          controlValue(c, "master.level", 1) *
          (0.5 + value("trim", 0.5))
        : 0,
    low: value("eq.low", 0.5),
    mid: value("eq.mid", 0.5),
    high: value("eq.high", 0.5),
    color: value("color", 0.5) * 2 - 1,
    fx: fxOn && fxSelected ? controlValue(c, "beatFx.levelDepth", 0) : 0,
    cue: ["cueA", "cueB"].some((key) => c[prefix + key]?.state === "on" || value(key, 0) > 0)
      ? 1
      : 0,
    bpm: deck?.effectiveBpm ?? deck?.bpm ?? 120,
    effect: Math.max(0, effects.indexOf(c["beatFx.effect"]?.state ?? "")),
  };
}
