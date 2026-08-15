import type { TrackWaveform } from "../shared/types.js";

/** Return only waveform data backed by real Rekordbox/USB analysis. */
export function displayWaveform(waveform: TrackWaveform | null | undefined): TrackWaveform | null {
  return waveform?.source === "rekordbox" && waveform.peaks.length > 0 ? waveform : null;
}
