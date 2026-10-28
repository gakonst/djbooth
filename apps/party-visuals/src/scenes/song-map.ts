import type { TrackWaveform } from "../../../dj-monitor/src/types.js";

/**
 * Rhythm read ahead of the playhead from a track's Rekordbox colour waveform: every hit, split
 * roughly into kick (red/low), snare (green/mid) and hat (blue/high), plus how hard each passage plays.
 */
export type SongMap = {
  step: number;
  amplitude: Float32Array;
  kick: Float32Array;
  snare: Float32Array;
  hat: Float32Array;
  /** Loudness of the surrounding passage, 0–1 across the track: breakdowns low, drops high. */
  section: Float32Array;
  beatGrid: NonNullable<TrackWaveform["beatGrid"]>;
};

/**
 * Rises over the last ~40 ms, weighted by how much this band dominates the hit, then normalised
 * against nearby hits so quiet passages keep their groove.
 */
function onsets(band: Float32Array, dominance: Float32Array, step: number) {
  const n = band.length;
  const lag = Math.max(1, Math.round(0.04 / step));
  const raw = new Float32Array(n);
  let strongest = 0;
  for (let i = 0; i < n; i++) {
    let before = 0;
    for (let k = Math.max(0, i - lag); k < i; k++) before = Math.max(before, band[k]!);
    raw[i] = Math.max(0, band[i]! - before) * dominance[i]!;
    strongest = Math.max(strongest, raw[i]!);
  }
  const block = Math.max(1, Math.round(1 / step));
  const blocks = new Float32Array(Math.ceil(n / block));
  for (let i = 0; i < n; i++) blocks[Math.floor(i / block)] = Math.max(blocks[Math.floor(i / block)]!, raw[i]!);
  const out = new Float32Array(n);
  for (let b = 0; b < blocks.length; b++) {
    let local = 0;
    for (let k = Math.max(0, b - 4); k <= Math.min(blocks.length - 1, b + 4); k++) local = Math.max(local, blocks[k]!);
    // A floor keeps near-silence from being amplified into fake hits.
    const scale = Math.max(local * 0.85, strongest * 0.15, 1e-4);
    for (let i = b * block; i < Math.min(n, (b + 1) * block); i++) out[i] = Math.min(1, raw[i]! / scale);
  }
  return out;
}

export function buildSongMap(waveform: TrackWaveform | null | undefined): SongMap | null {
  const n = waveform?.peaks.length ?? 0;
  if (!waveform || n < 64 || waveform.durationSeconds <= 0) return null;
  const step = waveform.durationSeconds / n;
  const amplitude = Float32Array.from(waveform.peaks);
  const bands = [new Float32Array(n), new Float32Array(n), new Float32Array(n)] as const;
  const dominance = [new Float32Array(n), new Float32Array(n), new Float32Array(n)] as const;
  for (let i = 0; i < n; i++) {
    const color = waveform.colors?.[i];
    const total = color ? color[0] + color[1] + color[2] : 0;
    const strongest = color ? Math.max(color[0], color[1], color[2], 1) : 1;
    for (let b = 0; b < 3; b++) {
      bands[b]![i] = color && total > 0 ? (amplitude[i]! * color[b]! * 3) / total : amplitude[i]!;
      // A kick still tints mid and high a little; squaring keeps that spill from reading as a hit.
      dominance[b]![i] = color ? (color[b]! / strongest) ** 2 : 1;
    }
  }
  const radius = Math.max(1, Math.round(1.5 / step));
  const section = new Float32Array(n);
  let sum = 0,
    loudest = 1e-4;
  for (let i = -radius; i < n; i++) {
    sum += amplitude[i + radius] ?? 0;
    sum -= amplitude[i - radius - 1] ?? 0;
    if (i >= 0) loudest = Math.max(loudest, (section[i] = sum / (radius * 2 + 1)));
  }
  for (let i = 0; i < n; i++) section[i] = section[i]! / loudest;
  return {
    step,
    amplitude,
    kick: onsets(bands[0], dominance[0], step),
    snare: onsets(bands[1], dominance[1], step),
    hat: onsets(bands[2], dominance[2], step),
    section,
    beatGrid: waveform.beatGrid ?? [],
  };
}

/** The strongest value within a span of track time. */
export function peakIn(values: Float32Array, map: SongMap, from: number, to: number) {
  const first = Math.max(0, Math.floor(from / map.step));
  const last = Math.min(values.length - 1, Math.ceil(to / map.step));
  let peak = 0;
  for (let i = first; i <= last; i++) peak = Math.max(peak, values[i]!);
  return peak;
}

/** 2 when a bar starts within the span, 1 for any other beat, else 0. */
export function beatIn(map: SongMap, from: number, to: number) {
  const grid = map.beatGrid;
  let low = 0,
    high = grid.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (grid[mid]!.timeSeconds < from) low = mid + 1;
    else high = mid;
  }
  const entry = grid[low];
  return entry && entry.timeSeconds < to ? (entry.beat === 1 ? 2 : 1) : 0;
}

const chroma = new Float32Array(12);

/**
 * The dominant pitch class of the live spectrum, placed on the circle of fifths so related notes
 * get related hues. Clarity is near 0 for noise or drums and rises for a clear melodic note.
 */
export function melody(spectrum: Uint8Array, sampleRate: number) {
  chroma.fill(0);
  const binHz = sampleRate / (spectrum.length * 2);
  const first = Math.ceil(220 / binHz),
    last = Math.min(spectrum.length - 1, Math.floor(2500 / binHz));
  let total = 0;
  for (let k = first; k <= last; k++) {
    const v = (spectrum[k]! / 255) ** 2;
    const note = Math.round(69 + 12 * Math.log2((k * binHz) / 440));
    chroma[((note % 12) + 12) % 12]! += v;
    total += v;
  }
  let best = 0;
  for (let pc = 1; pc < 12; pc++) if (chroma[pc]! > chroma[best]!) best = pc;
  const clarity = total > 0.05 ? Math.max(0, (chroma[best]! / total - 1 / 12) / (1 - 1 / 12)) : 0;
  return { hue: ((best * 7) % 12) / 12, clarity: Math.min(1, clarity * 2.5) };
}
