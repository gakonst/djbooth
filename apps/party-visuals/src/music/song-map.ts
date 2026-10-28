import type { TrackWaveform } from "../../../dj-monitor/src/types.js";

/**
 * A song's structure, read ahead of time from its Rekordbox analysis: where the drops,
 * vocal passages, breakdowns and build-ups are, and where the rhythm does something unusual.
 */
export type Style = "break" | "vocal" | "groove" | "build" | "drop";
export type Section = {
  start: number;
  end: number;
  style: Style;
  /** Where a fill leads into the next section, when the analysis marks one. */
  fill?: number;
};
export type SongMap = {
  duration: number;
  /** Downbeat times in seconds. */
  bars: number[];
  /** Per-bar energy relative to the song's own loud passages (about 0–1.2). */
  energy: number[];
  sections: Section[];
  /** Times of one-off irregularities: a fill, a dropout, a sudden jump. */
  swirls: number[];
};

type BarFeatures = { energy: number; bass: number; mid: number; high: number };

const MIN_SECTION_BARS = 4;
const BUILD_BARS = 4;

function percentile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

function downbeats(waveform: TrackWaveform, bpm: number) {
  const grid = waveform.beatGrid ?? [];
  const bars = grid.filter((b) => b.beat === 1).map((b) => b.timeSeconds);
  if (bars.length >= 8) return bars;
  const bar = (4 * 60) / (bpm > 0 ? bpm : 120);
  return Array.from({ length: Math.ceil(waveform.durationSeconds / bar) }, (_, i) => i * bar);
}

/** Rekordbox's colour waveform: red follows the lows, green the mids, blue the highs. */
function barFeatures(waveform: TrackWaveform, from: number, to: number): BarFeatures {
  const n = waveform.peaks.length;
  const i0 = Math.max(0, Math.floor((from / waveform.durationSeconds) * (n - 1)));
  const i1 = Math.min(n, Math.max(i0 + 1, Math.floor((to / waveform.durationSeconds) * (n - 1))));
  let energy = 0,
    r = 0,
    g = 0,
    b = 0;
  for (let i = i0; i < i1; i++) {
    energy += waveform.peaks[i] ?? 0;
    const color = waveform.colors?.[i];
    if (color) {
      r += color[0];
      g += color[1];
      b += color[2];
    }
  }
  const count = i1 - i0;
  const total = r + g + b || 1;
  return { energy: energy / count, bass: r / total, mid: g / total, high: b / total };
}

function classify(energy: number, f: BarFeatures): Style {
  if (energy < 0.45) return "break";
  if (f.bass >= 0.31 && energy >= 0.78) return "drop";
  if (f.bass < 0.27) return "vocal";
  return "groove";
}

/** Replace each label with the most common one around it, so single bars do not flicker. */
function smoothLabels(labels: Style[]) {
  return labels.map((label, i) => {
    const counts = new Map<Style, number>();
    for (let k = Math.max(0, i - 1); k <= Math.min(labels.length - 1, i + 1); k++)
      counts.set(labels[k]!, (counts.get(labels[k]!) ?? 0) + (k === i ? 1.5 : 1));
    return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
  });
}

export function analyzeSong(waveform: TrackWaveform, bpm: number): SongMap {
  const bars = downbeats(waveform, bpm);
  const ends = [...bars.slice(1), waveform.durationSeconds];
  const features = bars.map((start, i) => barFeatures(waveform, start, ends[i]!));
  const loud = percentile(
    features.map((f) => f.energy).filter((e) => e > 0.02),
    0.9,
  );
  const energy = features.map((f) => Math.min(1.2, f.energy / (loud || 1)));
  let labels = smoothLabels(features.map((f, i) => classify(energy[i]!, f)));

  // Merge sections too short to be a musical phrase into the one before.
  let changed = true;
  while (changed) {
    changed = false;
    let start = 0;
    for (let i = 1; i <= labels.length; i++) {
      if (i < labels.length && labels[i] === labels[start]) continue;
      if (i - start < MIN_SECTION_BARS && labels.length > MIN_SECTION_BARS) {
        const fill = start > 0 ? labels[start - 1]! : (labels[i] ?? labels[start]!);
        if (fill !== labels[start]) {
          for (let k = start; k < i; k++) labels[k] = fill;
          changed = true;
        }
      }
      start = i;
    }
  }

  // The bars leading into each drop are its build-up.
  labels = labels.map((label, i) => {
    if (label === "drop") return label;
    for (let k = 1; k <= BUILD_BARS; k++) if (labels[i + k] === "drop") return "build";
    return label;
  });
  // A short leftover just before a build-up belongs to it.
  for (let i = labels.length - 1; i > 0; i--)
    if (labels[i] === "build" && labels[i - 1] !== "build") {
      let start = i - 1;
      while (start > 0 && labels[start - 1] === labels[i - 1]) start--;
      if (i - start < MIN_SECTION_BARS) for (let k = start; k < i; k++) labels[k] = "build";
    }

  const sections: Section[] = [];
  labels.forEach((style, i) => {
    const last = sections.at(-1);
    if (last && last.style === style) last.end = ends[i]!;
    else sections.push({ start: bars[i]!, end: ends[i]!, style });
  });

  // Irregularities: a bar unlike both neighbours, or a bar of unusual length.
  const boundaries = new Set(sections.map((s) => s.start));
  const typicalBar = percentile(
    bars.slice(1).map((t, i) => t - bars[i]!),
    0.5,
  );
  const swirls: number[] = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const nearBoundary = [bars[i - 1], bars[i], bars[i + 1]].some((t) => boundaries.has(t!));
    if (nearBoundary) continue;
    const around = (energy[i - 1]! + energy[i + 1]!) / 2;
    const bassAround = (features[i - 1]!.bass + features[i + 1]!.bass) / 2;
    const length = ends[i]! - bars[i]!;
    const odd =
      Math.abs(energy[i]! - around) > 0.28 ||
      Math.abs(features[i]!.bass - bassAround) > 0.16 ||
      Math.abs(length - typicalBar) > typicalBar * 0.06;
    const spaced = !swirls.length || bars[i]! - swirls.at(-1)! > typicalBar * 4;
    if (odd && spaced && energy[i]! > 0.05) swirls.push(bars[i]!);
  }

  return { duration: waveform.durationSeconds, bars, energy, sections, swirls };
}

/** A stand-in song for when nothing is playing, so the road still tells a story. */
export function idleSong(): SongMap {
  const bar = 2;
  const plan: [Style, number][] = [
    ["vocal", 16],
    ["groove", 16],
    ["build", 4],
    ["drop", 16],
    ["break", 8],
  ];
  const bars: number[] = [];
  const energy: number[] = [];
  const sections: Section[] = [];
  const swirls: number[] = [];
  const levels: Record<Style, number> = { break: 0.3, vocal: 0.6, groove: 0.7, build: 0.8, drop: 1 };
  let t = 0;
  for (let round = 0; round < 6; round++)
    for (const [style, length] of plan) {
      sections.push({ start: t, end: t + length * bar, style });
      for (let k = 0; k < length; k++) {
        bars.push(t);
        energy.push(levels[style]);
        if (style === "groove" && k === 10) swirls.push(t);
        t += bar;
      }
    }
  return { duration: t, bars, energy, sections, swirls };
}

export function sectionAt(song: SongMap, time: number) {
  return song.sections.find((s) => time >= s.start && time < s.end) ?? song.sections.at(-1);
}
