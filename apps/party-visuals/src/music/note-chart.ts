import type { TrackPhraseKind, TrackRhythm } from "../../../djbooth/src/shared/types.js";
import type { TrackWaveform } from "../../../dj-monitor/src/types.js";
import { analyzeSong, type Section, type SongMap, type Style } from "./song-map.js";

export const NOTE_LANES = 5;

/** Which part of the mix a note follows. */
export type Sound = "kick" | "bass" | "snare" | "hat" | "melody" | "crash";

export type Note = {
  time: number;
  lane: number;
  /** Seconds the note is held; 0 for a tap. */
  length: number;
  /** A big beat: a drop, a crash or a hard transient. Drawn larger, always shown. */
  big: boolean;
  /** 0–1 importance among every note in the song; the density slider shows the top share. */
  rank: number;
  sound: Sound;
};
export type Fret = { time: number; downbeat: boolean };
export type Chart = { song: SongMap; notes: Note[]; frets: Fret[] };

/**
 * Lanes read like a drum chart, low to high: kick on the left, off-beat bass next to it,
 * snare in the middle, hats on the right, and the melody climbing across the inner lanes.
 */
const KICK_LANE = 0;
const BASS_LANE = 1;
const SNARE_LANE = 2;
const HAT_LANES = [4, 3];
const MELODY_LANES = [1, 2, 3];

const STYLE_WEIGHT: Record<Style, number> = {
  break: 0.6,
  vocal: 0.85,
  groove: 1,
  build: 1.05,
  drop: 1.15,
};
/** How many sixteenths a slot sits from the beat matters: beats > eighths > sixteenths. */
const GRID_WEIGHT = [0.3, 0, 0.12, 0];
const BANDS = 3;
const LOW = 0,
  MID = 1,
  HIGH = 2;
/** A band hits when its onset is at least this share of the song's typical strong onset. */
const THRESHOLD = [0.42, 0.45, 0.5];

function beatsOf(waveform: TrackWaveform, bpm: number): Fret[] {
  const grid = waveform.beatGrid ?? [];
  if (grid.length >= 16) return grid.map((b) => ({ time: b.timeSeconds, downbeat: b.beat === 1 }));
  const beat = 60 / (bpm > 0 ? bpm : 120);
  return Array.from({ length: Math.ceil(waveform.durationSeconds / beat) }, (_, i) => ({
    time: i * beat,
    downbeat: i % 4 === 0,
  }));
}

function percentile(values: ArrayLike<number>, p: number) {
  const sorted = Array.from(values)
    .filter((v) => v > 0.001)
    .sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

/** Rekordbox's three-band detail waveform: interleaved low, mid, high bytes up to 127. */
function detailBands(bands: NonNullable<TrackRhythm["bands"]>) {
  const bytes = Uint8Array.from(atob(bands.data), (c) => c.charCodeAt(0));
  const n = Math.floor(bytes.length / 3);
  const out = Array.from({ length: BANDS }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let b = 0; b < BANDS; b++) out[b]![i] = bytes[i * 3 + b]! / 127;
  return { bands: out, rate: bands.rate };
}

/**
 * Per-band energy over the song, from the three-band detail when there is one. Otherwise
 * from the colour waveform, which tints each column by its balance of lows (red), mids
 * (green) and highs (blue) with the strongest band at full brightness, so height × each
 * band's share of the tint approximates how loud it is.
 */
function bandEnergy(waveform: TrackWaveform, rhythm?: TrackRhythm | null) {
  if (rhythm?.bands) return detailBands(rhythm.bands);
  const n = waveform.peaks.length;
  const bands = Array.from({ length: BANDS }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    const peak = waveform.peaks[i] ?? 0;
    const color = waveform.colors?.[i];
    const total = color ? color[0] + color[1] + color[2] : 0;
    for (let b = 0; b < BANDS; b++) bands[b]![i] = total > 0 ? (peak * color![b]!) / total : peak / BANDS;
  }
  return { bands, rate: n / waveform.durationSeconds };
}

/** How each Rekordbox phrase plays in the chart. */
const PHRASE_STYLE: Record<TrackPhraseKind, Style> = {
  intro: "groove",
  verse: "groove",
  up: "build",
  chorus: "drop",
  down: "break",
  bridge: "break",
  outro: "break",
};

/** The song's structure: Rekordbox's own phrases when analysed, otherwise read from the waveform. */
export function songOf(waveform: TrackWaveform, bpm: number, rhythm?: TrackRhythm | null): SongMap {
  const song = analyzeSong(waveform, bpm);
  const phrases = rhythm?.phrases?.entries;
  if (!phrases?.length) return song;
  const sections: Section[] = phrases.map((phrase) => ({
    start: phrase.startSeconds,
    end: phrase.endSeconds,
    style: PHRASE_STYLE[phrase.kind],
    ...(phrase.fillSeconds !== null ? { fill: phrase.fillSeconds } : {}),
  }));
  return { ...song, sections };
}

const charts = new Map<string, Chart>();

/** One chart per track and analysis, shared by the scene and the click track. */
export function chartFor(trackId: string, waveform: TrackWaveform, bpm: number, rhythm?: TrackRhythm | null) {
  const key = `${trackId}:${rhythm?.bands ? "detail" : "color"}:${rhythm?.phrases ? "phrases" : ""}`;
  let chart = charts.get(key);
  if (!chart) {
    chart = buildChart(waveform, bpm, rhythm);
    charts.set(key, chart);
    if (charts.size > 24) charts.delete(charts.keys().next().value!);
  }
  return chart;
}

type Slot = {
  time: number;
  /** 0 on the beat, 1–3 for the sixteenths after it. */
  sub: number;
  downbeat: boolean;
  style: Style;
  /** Onset strength per band, relative to the song's own strong onsets. */
  onset: number[];
  /** Level per band just after the slot. */
  level: number[];
  /** Brightness of the mids, for melodic contour. */
  bright: number;
};

/**
 * Chart a whole song ahead of time from its Rekordbox analysis, like a rhythm-game chart:
 * the beat grid is split into sixteenths, each slot is checked for a fresh hit in the lows,
 * mids and highs, and each hit is a note in the lane for that sound. The chart starts easy
 * (strong beats only) and gets harder through the song, every bar keeps its pulse, and
 * every section change is marked: a crash chord on each drop with a roll leading into it.
 */
export function buildChart(waveform: TrackWaveform, bpm: number, rhythm?: TrackRhythm | null): Chart {
  const song = songOf(waveform, bpm, rhythm);
  const frets = beatsOf(waveform, bpm);
  const duration = waveform.durationSeconds;
  const { bands, rate } = bandEnergy(waveform, rhythm);
  const detail = !!rhythm?.bands;
  const n = bands[0]!.length;
  const at = (t: number) => Math.max(0, Math.min(n - 1, Math.round(t * rate)));
  const max = (band: Float32Array, from: number, to: number) => {
    let value = 0;
    for (let i = at(from), end = Math.max(at(from) + 1, at(to)); i < end; i++) value = Math.max(value, band[i]!);
    return value;
  };
  const mean = (band: Float32Array, from: number, to: number) => {
    const i0 = at(from),
      i1 = Math.max(i0 + 1, at(to));
    let sum = 0;
    for (let i = i0; i < i1; i++) sum += band[i]!;
    return sum / (i1 - i0);
  };

  let section = 0;
  const styleAt = (t: number) => {
    while (section < song.sections.length - 1 && t >= song.sections[section]!.end) section++;
    return song.sections[section]?.style ?? "groove";
  };

  // Sixteenth-note slots across the whole beat grid.
  const slots: Slot[] = [];
  const raw: number[][] = Array.from({ length: BANDS }, () => []);
  frets.forEach((fret, i) => {
    const step = (frets[i + 1]?.time ?? fret.time + (frets[i - 1] ? fret.time - frets[i - 1]!.time : 0.5)) - fret.time;
    for (let sub = 0; sub < 4; sub++) {
      const time = fret.time + (sub * step) / 4;
      if (time < 0.05 || time > duration - 0.3) continue;
      const onset: number[] = [],
        level: number[] = [];
      for (let b = 0; b < BANDS; b++) {
        // A hit is energy now that was not there a moment ago.
        const now = max(bands[b]!, time - 0.02, time + 0.045);
        const before = mean(bands[b]!, time - Math.min(0.12, step * 0.45), time - 0.025);
        onset.push(Math.max(0, now - before));
        level.push(now);
        raw[b]!.push(onset[b]!);
      }
      const mid = level[MID]!,
        high = level[HIGH]!;
      slots.push({
        time,
        sub,
        downbeat: fret.downbeat && sub === 0,
        style: styleAt(time),
        onset,
        level,
        bright: high / (mid + high + 0.001),
      });
    }
  });
  // Every band is judged against its own strong hits, so quiet hats still chart.
  const scale = raw.map((values) => percentile(values, 0.9) || 1);
  for (const slot of slots) for (let b = 0; b < BANDS; b++) slot.onset[b] = slot.onset[b]! / scale[b]!;

  /** A band hits in a slot when its onset clears the threshold and peaks there, not a neighbour. */
  const hits = (i: number, b: number) => {
    const o = slots[i]!.onset[b]!;
    return (
      o >= THRESHOLD[b]! &&
      o >= (slots[i - 1]?.onset[b] ?? 0) &&
      o > (slots[i + 1]?.onset[b] ?? 0) * 0.9
    );
  };

  const beat = 60 / (bpm > 0 ? bpm : 120);
  const bar = beat * 4;

  /**
   * How hard the chart is at a moment: it opens easy, steps up to medium and then hard as
   * the song goes on, and eases off a step through breakdowns.
   */
  const tierAt = (time: number, style: Style) => {
    const progress = time / duration;
    const base = progress < 0.22 ? 0 : progress < 0.5 ? 1 : 2;
    return Math.max(0, base - (style === "break" ? 1 : 0));
  };

  type Candidate = {
    time: number;
    lane: number;
    length: number;
    sound: Sound;
    weight: number;
    big: boolean;
    sub: number;
    /** Strong enough to chart off the eighth-note grid at hard. */
    strong: boolean;
    /** Placed to keep the beat going; always shown, whatever the density. */
    pulse?: boolean;
  };
  const candidates: Candidate[] = [];
  const brights = slots.map((s) => s.bright).sort((a, b) => a - b);
  const brightRank = (b: number) => {
    let low = 0,
      high = brights.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (brights[mid]! < b) low = mid + 1;
      else high = mid;
    }
    return low / Math.max(1, brights.length);
  };
  let hat = 0,
    melodyLane = 2;

  slots.forEach((slot, i) => {
    const weightOf = (b: number) =>
      (slot.onset[b]! + GRID_WEIGHT[slot.sub]! + (slot.downbeat ? 0.25 : 0)) * STYLE_WEIGHT[slot.style];
    const low = hits(i, LOW),
      mid = hits(i, MID),
      high = hits(i, HIGH);
    const push = (lane: number, sound: Sound, band: number, bonus = 0) =>
      candidates.push({
        time: slot.time,
        lane,
        length: 0,
        sound,
        weight: weightOf(band) + bonus,
        big: false,
        sub: slot.sub,
        strong: slot.onset[band]! > 1.3,
      });

    if (low && slot.sub === 0) push(KICK_LANE, "kick", LOW, 0.2);
    // Off-beat bass only reads reliably from the three-band detail; against the audio, the
    // colour waveform's off-beat lows land on a real bass hit less than a quarter of the time.
    else if (low && detail) push(BASS_LANE, "bass", LOW);
    // Mids hitting together with highs read as a snare or clap; mids alone as melody.
    if (mid && high && slot.sub % 2 === 0 && slot.onset[HIGH]! > 0.4) push(SNARE_LANE, "snare", MID, 0.15);
    else if (mid) {
      const home = MELODY_LANES[Math.min(MELODY_LANES.length - 1, Math.floor(brightRank(slot.bright) * MELODY_LANES.length))]!;
      // Follow the melody's brightness a step at a time.
      melodyLane += Math.sign(home - melodyLane);
      push(melodyLane, "melody", MID);
    }
    if (high && !mid) push(HAT_LANES[hat++ % HAT_LANES.length]!, "hat", HIGH, -0.15);
  });

  // Transitions are always charted: every section opens on a big note, entering a drop or
  // chorus lands on a crash chord, and a roll sweeps across the lanes where the analysis
  // marks a fill (or through the bar before a drop when it marks none).
  const nearestFret = (t: number) =>
    frets.reduce((best, f) => (Math.abs(f.time - t) < Math.abs(best - t) ? f.time : best), Infinity);
  const forced: Candidate[] = [];
  const rolls: [number, number][] = [];
  const force = (time: number, lane: number, sound: Sound, length = 0) =>
    forced.push({ time, lane, length, sound, weight: 5, big: true, sub: 0, strong: true });
  const roll = (from: number, to: number, tier: number) => {
    const step = tier === 0 ? beat : beat / 2;
    rolls.push([from - 0.01, to + 0.01]);
    const sweep = [0, 1, 2, 3, 4, 3, 2, 1];
    for (let k = 0, t = from; t < to - 0.01; k++, t += step)
      forced.push({ time: t, lane: sweep[k % sweep.length]!, length: 0, sound: "snare", weight: 4, big: false, sub: 0, strong: true });
  };
  song.sections.forEach((section, i) => {
    if (i === 0) return;
    const previous = song.sections[i - 1]!;
    const time = nearestFret(section.start);
    const tier = tierAt(time, section.style);
    const entering = section.style === "drop" && previous.style !== "drop";
    if (previous.fill !== undefined) roll(nearestFret(Math.max(previous.fill, time - bar * 2)), time, tier);
    else if (entering) roll(time - bar, time, tier);
    if (entering) for (const lane of tier === 0 ? [1, 3] : [0, 2, 4]) force(time, lane, "crash");
    else if (section.style === "break") force(time, 2, "melody", Math.min(section.end - section.start, bar * 2) * 0.9);
    else force(time, 2, section.style === "drop" ? "crash" : section.style === "build" ? "snare" : "kick");
  });

  // Regular hits, grouped by moment, then thinned to the tier's grid, sounds and spacing.
  // Easy is about a note every two beats, medium one a beat, hard up to one an eighth.
  const RULES = [
    { gap: 2, subs: [0], sounds: ["kick", "snare", "melody"], chord: 1 },
    { gap: 1, subs: [0, 2], sounds: ["kick", "snare", "bass", "melody"], chord: 1 },
    { gap: 0.5, subs: [0, 2], sounds: ["kick", "snare", "bass", "melody", "hat"], chord: 2 },
  ];
  candidates.sort((a, b) => a.time - b.time);
  section = 0;
  type Group = { time: number; items: Candidate[]; weight: number; gap: number; chord: number };
  const groups: Group[] = [];
  for (let i = 0; i < candidates.length; ) {
    let j = i;
    while (j < candidates.length && candidates[j]!.time - candidates[i]!.time < 0.01) j++;
    const time = candidates[i]!.time;
    const rules = RULES[tierAt(time, styleAt(time))]!;
    const items = candidates
      .slice(i, j)
      .filter((c) => rules.sounds.includes(c.sound))
      .filter((c) => rules.subs.includes(c.sub) || (rules === RULES[2] && c.strong && c.sound !== "hat"))
      .sort((a, b) => b.weight - a.weight);
    i = j;
    if (!items.length || rolls.some(([from, to]) => time > from && time < to)) continue;
    groups.push({ time, items, weight: items[0]!.weight, gap: rules.gap * beat - 0.01, chord: rules.chord });
  }

  // Strongest moments first; each keeps the tier's spacing from everything already taken.
  const taken: number[] = [...new Set(forced.map((c) => c.time))].sort((a, b) => a - b);
  const insert = (t: number) => {
    let low = 0,
      high = taken.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (taken[mid]! < t) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  const kept: Candidate[] = [...forced];
  for (const group of [...groups].sort((a, b) => b.weight - a.weight)) {
    const at = insert(group.time);
    const before = taken[at - 1] ?? -Infinity,
      after = taken[at] ?? Infinity;
    if (group.time - before < group.gap || after - group.time < group.gap) continue;
    taken.splice(at, 0, group.time);
    const lanes = new Set<number>();
    for (const c of group.items) {
      if (lanes.size >= group.chord || lanes.has(c.lane)) continue;
      lanes.add(c.lane);
      kept.push(c);
    }
  }

  // Keep the pulse: wherever there is music and nothing charted for a stretch (two beats
  // at easy, a beat after that), the beat gets a note in the lane of whichever sound is
  // loudest on it.
  const onBeat = new Map(slots.filter((s) => s.sub === 0).map((s) => [Math.round(s.time * 1000), s]));
  section = 0;
  let beatInBar = 0;
  for (const fret of frets) {
    beatInBar = fret.downbeat ? 0 : beatInBar + 1;
    const slot = onBeat.get(Math.round(fret.time * 1000));
    if (!slot || Math.max(...slot.level) < 0.08) continue;
    const every = [2, 1, 1][tierAt(fret.time, styleAt(fret.time))]!;
    if (beatInBar % every) continue;
    const at = insert(fret.time - 0.01);
    if ((taken[at] ?? Infinity) < fret.time + every * beat - 0.01) continue;
    if (fret.time - (taken[at - 1] ?? -Infinity) < beat * 0.5) continue;
    taken.splice(at, 0, fret.time);
    const loudest = slot.onset.indexOf(Math.max(...slot.onset));
    const [lane, sound]: [number, Sound] =
      loudest === LOW ? [KICK_LANE, "kick"] : loudest === MID ? [melodyLane, "melody"] : [HAT_LANES[0]!, "hat"];
    kept.push({ time: fret.time, lane, length: 0, sound, weight: 1, big: false, sub: 0, strong: false, pulse: true });
  }
  kept.sort((a, b) => a.time - b.time || a.lane - b.lane);

  // Held notes: a melody hit whose mids keep ringing for at least a beat and a half before
  // the next note. Nothing else lands in a lane while it is held.
  kept.forEach((c, i) => {
    if (c.sound !== "melody" || c.length) return;
    const next = kept.slice(i + 1).find((o) => o.time > c.time + 0.01)?.time ?? Infinity;
    const start = mean(bands[MID]!, c.time, c.time + 0.06);
    let end = c.time;
    while (end + beat / 2 <= next && end - c.time < bar * 2 && mean(bands[MID]!, end, end + beat / 2) > start * 0.7)
      end += beat / 2;
    if (end - c.time >= beat * 1.5) c.length = end - c.time - beat / 4;
  });

  // The hardest-hitting regular notes are big too; rolls stay plain so the crash stands out.
  const regular = (c: Candidate) => !c.big && c.weight < 4;
  const weights = kept
    .filter(regular)
    .map((c) => c.weight)
    .sort((a, b) => a - b);
  const hardest = weights[Math.floor(weights.length * 0.97)] ?? Infinity;
  // Rank each note against its neighbours (about eight bars either way), so the density
  // slider thins every part of the song evenly instead of emptying the easy opening.
  const window = bar * 8;
  const ranks = kept.map((c) => {
    let below = 0,
      around = 0;
    for (const other of kept) {
      if (Math.abs(other.time - c.time) > window) continue;
      around++;
      if (other.weight < c.weight) below++;
    }
    return below / Math.max(1, around - 1);
  });
  const notes: Note[] = kept.map((c, i) => ({
    time: c.time,
    lane: c.lane,
    length: c.length,
    big: c.big || (regular(c) && c.weight >= hardest && c.sound !== "hat"),
    // Transitions, rolls and the pulse are the chart's backbone and survive any density.
    rank: c.pulse || c.weight >= 4 ? 1 : ranks[i]!,
    sound: c.sound,
  }));
  return { song, notes, frets };
}

/**
 * A stand-in track for when nothing is playing: a 124 BPM tune whose waveform carries a real
 * kick, snare, hats and a melody, with a build and a drop.
 */
export function idleWaveform(): TrackWaveform {
  const bpm = 124;
  const beat = 60 / bpm;
  const rate = 150;
  const plan: [Style, number][] = [
    ["vocal", 8],
    ["groove", 8],
    ["build", 4],
    ["drop", 16],
    ["break", 8],
    ["groove", 8],
    ["build", 4],
    ["drop", 16],
  ];
  const bars = plan.reduce((sum, [, length]) => sum + length, 0);
  const duration = bars * 4 * beat;
  const peaks: number[] = [];
  const colors: Array<[number, number, number]> = [];
  const melody = [0, 3, 5, 7, 5, 3, 8, 7];
  for (let i = 0; i < duration * rate; i++) {
    const t = i / rate;
    let bar = Math.floor(t / (4 * beat)),
      style: Style = "groove";
    for (const [s, length] of plan) {
      if (bar < length) {
        style = s;
        break;
      }
      bar -= length;
    }
    const beats = t / beat;
    const phase = beats % 1;
    const beatInBar = Math.floor(beats) % 4;
    const sixteenth = (beats * 4) % 1;
    const sixteenthIndex = Math.floor(beats * 4) % 16;
    const four = style !== "break" && style !== "vocal";
    const kick = four || (style === "vocal" && beatInBar === 0) ? Math.exp(-phase * 12) : 0;
    const snare = four && beatInBar % 2 === 1 ? Math.exp(-phase * 10) * 0.8 : 0;
    // Hats on the off-beat eighths, with sixteenths in drops and build-ups.
    const hatOn = style === "drop" || style === "build" ? true : sixteenthIndex % 4 === 2;
    const hat = style !== "break" && hatOn ? Math.exp(-sixteenth * 9) * 0.5 : 0;
    // A melody note every half beat; it rings out through the breakdown.
    const note = Math.floor(beats * 2);
    const ring = style === "break" ? 0.7 : Math.exp(-((beats * 2) % 1) * 3);
    const lead = note % 3 === 2 && style !== "break" ? 0 : ring * 0.55;
    const pitch = melody[note % melody.length]! / 8;
    const low = kick + (style === "drop" ? 0.15 : 0.05),
      mid = snare * 0.6 + lead * (1 - pitch * 0.5) + 0.05,
      high = snare * 0.5 + hat + lead * pitch * 0.6 + 0.03;
    const peak = Math.min(1, Math.max(low, mid, high) * (style === "break" ? 0.6 : 1));
    const top = Math.max(low, mid, high);
    peaks.push(peak);
    colors.push([(low / top) * 255, (mid / top) * 255, (high / top) * 255]);
  }
  const beatGrid = Array.from({ length: Math.floor(duration / beat) }, (_, i) => ({
    beat: ((i % 4) + 1) as 1 | 2 | 3 | 4,
    timeSeconds: i * beat,
  }));
  return { durationSeconds: duration, peaks, colors, beatGrid, source: "placeholder" };
}
