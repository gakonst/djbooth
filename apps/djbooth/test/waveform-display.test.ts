import { describe, expect, it } from "vitest";

import { displayWaveform } from "../src/client/waveform-display.js";
import type { TrackWaveform } from "../src/shared/types.js";

describe("waveform display", () => {
  it("renders only real analysis with peaks", () => {
    const rekordbox: TrackWaveform = {
      durationSeconds: 180,
      peaks: [0.2, 1],
      source: "rekordbox",
    };
    const placeholder: TrackWaveform = {
      durationSeconds: 180,
      peaks: [0.4, 0.8],
      source: "placeholder",
    };
    const empty: TrackWaveform = {
      durationSeconds: 180,
      peaks: [],
      source: "rekordbox",
    };

    expect(displayWaveform(rekordbox)).toBe(rekordbox);
    expect(displayWaveform(placeholder)).toBeNull();
    expect(displayWaveform(empty)).toBeNull();
    expect(displayWaveform(null)).toBeNull();
  });
});
