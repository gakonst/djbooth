import type { TrackWaveform } from "./types.js";

export type WaveformBands = readonly [number, number, number];
export const FLAT_WAVEFORM_BANDS: WaveformBands = [1, 1, 1];

/** RGB analysis provides a visual approximation of low/mid/high energy, not audio DSP. */
export function shapeWaveformSignal(
  signal: { amplitude: number; color: readonly number[] | null },
  bands: WaveformBands,
) {
  const color = signal.color ?? [1, 1, 1];
  const total = color.reduce((sum, value) => sum + value, 0);
  const weighted = color.map((value, i) => value * bands[i]!);
  const gain =
    total > 0
      ? weighted.reduce((sum, value) => sum + value, 0) / total
      : (bands[0] + bands[1] + bands[2]) / 3;
  return {
    amplitude: Math.max(0, Math.min(1, signal.amplitude * gain)),
    color: signal.color ? weighted.map((value) => Math.min(255, value)) : null,
  };
}

export function waveformSignal(waveform: TrackWaveform | null | undefined, seconds: number) {
  if (
    !waveform ||
    waveform.durationSeconds <= 0 ||
    seconds < 0 ||
    seconds > waveform.durationSeconds
  )
    return { amplitude: 0, color: null };
  const index = (seconds / waveform.durationSeconds) * (waveform.peaks.length - 1);
  const low = Math.floor(index),
    mix = index - low;
  const a = waveform.colors?.[low],
    b = waveform.colors?.[low + 1] ?? a;
  return {
    amplitude: (waveform.peaks[low] ?? 0) * (1 - mix) + (waveform.peaks[low + 1] ?? 0) * mix,
    color: a && b ? a.map((value, i) => value * (1 - mix) + b[i]! * mix) : null,
  };
}

// Track time, rather than a free-running clock, preserves beat alignment after seeks.
export function waveformBeat(
  waveform: TrackWaveform | null | undefined,
  seconds: number,
  bpm: number,
) {
  const grid = waveform?.beatGrid;
  if (!grid?.length) return (seconds * (bpm > 0 ? bpm : 120)) / 60;
  let low = 0,
    high = grid.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (grid[mid]!.timeSeconds <= seconds) low = mid + 1;
    else high = mid;
  }
  const index = Math.max(0, low - 1);
  const start = grid[index]!.timeSeconds;
  const interval =
    index + 1 < grid.length
      ? grid[index + 1]!.timeSeconds - start
      : index > 0
        ? start - grid[index - 1]!.timeSeconds
        : 60 / (bpm > 0 ? bpm : 120);
  return index + (seconds - start) / (interval > 0 ? interval : 0.5);
}

/** Keep the track's hue visible between beats; rhythm changes its light output. */
export function waveformAccent(
  rgb: readonly number[],
  amplitude: number,
  pulse: number,
  emphasis = 1,
): [number, number, number] {
  const beat = Math.max(0, Math.min(1, pulse));
  const brightness = 0.45 + Math.max(0, Math.min(1, amplitude)) * 0.25 + beat * 0.3;
  const accent = Math.max(0, Math.min(1, emphasis)) * (0.88 + beat * 0.12);
  const max = Math.max(...rgb, 1);
  return [0, 1, 2].map((i) => brightness * (1 - accent + (rgb[i]! / max) * accent)) as [
    number,
    number,
    number,
  ];
}
