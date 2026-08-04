import type { TrackWaveform } from "../shared/types.js";

const DEFAULT_SAMPLE_COUNT = 512;
const MINIMUM_SAMPLE_COUNT = 256;
const MAXIMUM_SAMPLE_COUNT = 1_024;

/**
 * Supply a stable decorative waveform when a provider cannot expose audio analysis.
 *
 * The result deliberately remains a `placeholder`: it gives the full-width player a useful seek
 * surface without presenting synthetic peaks as Rekordbox analysis.
 */
export function waveformWithFallback(
  waveform: TrackWaveform | null | undefined,
  seed: string,
  durationSeconds?: number | null,
): TrackWaveform {
  if (waveform?.peaks.length) return waveform;
  const duration = positiveFinite(waveform?.durationSeconds) ?? positiveFinite(durationSeconds);
  const fallback = createDecorativeWaveform(seed, duration);
  return {
    ...fallback,
    ...(waveform?.beatGrid?.length ? { beatGrid: waveform.beatGrid } : {}),
  };
}

export function createDecorativeWaveform(
  seed: string,
  durationSeconds?: number | null,
): TrackWaveform {
  const duration = positiveFinite(durationSeconds);
  const sampleCount = duration
    ? clamp(Math.ceil(duration * 2), MINIMUM_SAMPLE_COUNT, MAXIMUM_SAMPLE_COUNT)
    : DEFAULT_SAMPLE_COUNT;
  const random = seededRandom(seed);
  const phaseOffset = random() * Math.PI * 2;
  const peaks: number[] = [];
  const colors: Array<[number, number, number]> = [];

  for (let index = 0; index < sampleCount; index += 1) {
    const progress = index / Math.max(1, sampleCount - 1);
    const edgeEnvelope = Math.min(1, Math.sqrt(Math.min(progress, 1 - progress) * 12 + 0.08));
    const phrase = 0.5 + 0.5 * Math.sin(progress * Math.PI * 18 + phaseOffset);
    const transient = index % 32 < 2 ? 0.14 : 0;
    const amplitude = clamp(
      (0.12 + random() * 0.5 + phrase * 0.12 + transient) * edgeEnvelope,
      0.035,
      0.88,
    );
    peaks.push(round(amplitude, 4));

    const huePhase = progress * Math.PI * 8 + phaseOffset;
    colors.push([
      Math.round(84 + 124 * normalizedSine(huePhase + 2.1)),
      Math.round(92 + 138 * normalizedSine(huePhase)),
      Math.round(126 + 112 * normalizedSine(huePhase - 2.1)),
    ]);
  }

  return {
    durationSeconds: duration ?? null,
    peaks,
    colors,
    source: "placeholder",
  };
}

function seededRandom(seed: string): () => number {
  let state = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 16_777_619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function normalizedSine(value: number): number {
  return (Math.sin(value) + 1) / 2;
}

function positiveFinite(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function round(value: number, precision: number): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
