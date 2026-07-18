import { describe, expect, it, vi } from "vitest";

import { renderRgbWaveform } from "../src/client/components/RgbWaveform.js";
import { createDecorativeWaveform, waveformWithFallback } from "../src/client/waveform-fallback.js";
import type { TrackWaveform } from "../src/shared/types.js";

describe("unanalysed waveform fallback", () => {
  it("creates stable bounded RGB placeholder data", () => {
    const first = createDecorativeWaveform("hosted-track:spotify:one", 180);
    const repeated = createDecorativeWaveform("hosted-track:spotify:one", 180);
    const other = createDecorativeWaveform("hosted-track:spotify:two", 180);

    expect(first).toEqual(repeated);
    expect(first).not.toEqual(other);
    expect(first).toMatchObject({ durationSeconds: 180, source: "placeholder" });
    expect(first.peaks).toHaveLength(360);
    expect(first.colors).toHaveLength(first.peaks.length);
    expect(first.peaks.every((peak) => peak >= 0 && peak <= 1)).toBe(true);
    expect(
      first.colors?.every((color) => color.every((channel) => channel >= 0 && channel <= 255)),
    ).toBe(true);
  });

  it("bounds memory for missing, short, and very long provider durations", () => {
    expect(createDecorativeWaveform("missing", null).peaks).toHaveLength(512);
    expect(createDecorativeWaveform("short", 10).peaks).toHaveLength(256);
    expect(createDecorativeWaveform("long", 10_000).peaks).toHaveLength(1_024);
    expect(createDecorativeWaveform("invalid", Number.NaN).durationSeconds).toBeNull();
  });

  it("keeps real analysis untouched and decorates empty placeholders", () => {
    const rekordbox: TrackWaveform = {
      durationSeconds: 180,
      peaks: [0.2, 1],
      colors: [
        [10, 20, 30],
        [40, 50, 60],
      ],
      source: "rekordbox",
    };
    const placeholder: TrackWaveform = {
      durationSeconds: 90,
      peaks: [],
      beatGrid: [{ beat: 1, timeSeconds: 0.5 }],
      source: "placeholder",
    };

    expect(waveformWithFallback(rekordbox, "local")).toBe(rekordbox);
    expect(waveformWithFallback(placeholder, "local", 180)).toMatchObject({
      durationSeconds: 90,
      source: "placeholder",
      beatGrid: placeholder.beatGrid,
    });
    expect(waveformWithFallback(null, "remote", 180).peaks).not.toHaveLength(0);
  });

  it("renders placeholder RGB bars across the complete overview width", () => {
    const waveform = createDecorativeWaveform("remote", 180);
    const fills: Array<{ fillStyle: string; x: number; width: number }> = [];
    let fillStyle = "";
    const context = {
      canvas: { width: 8, height: 20 },
      clearRect: vi.fn(),
      fillRect(x: number, _y: number, width: number) {
        fills.push({ fillStyle, x, width });
      },
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(value: string | CanvasGradient | CanvasPattern) {
        fillStyle = String(value);
      },
    } as unknown as CanvasRenderingContext2D;

    renderRgbWaveform([waveform.peaks], waveform.colors, context, { width: 8, height: 20 });

    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 8, 20);
    expect(fills.slice(0, 8).map(({ x, width }) => [x, width])).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 1],
      [6, 1],
      [7, 1],
    ]);
    expect(fills.slice(0, 8).every(({ fillStyle }) => fillStyle.startsWith("rgb("))).toBe(true);
  });
});
