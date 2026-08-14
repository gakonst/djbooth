import { useEffect, useState } from "react";

import type { TrackWaveform } from "./types.js";

export function useTrackWaveform(trackId: number | null): TrackWaveform | null {
  const [waveform, setWaveform] = useState<TrackWaveform | null>(null);

  useEffect(() => {
    setWaveform(null);
    if (trackId == null) return;
    const controller = new AbortController();
    void fetch(`/v1/tracks/${encodeURIComponent(String(trackId))}/waveform`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`waveform request failed with ${response.status}`);
        return (await response.json()) as TrackWaveform;
      })
      .then((value) => setWaveform(value))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setWaveform(null);
      });
    return () => controller.abort();
  }, [trackId]);

  return waveform;
}
