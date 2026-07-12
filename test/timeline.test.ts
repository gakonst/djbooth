import { describe, expect, test } from "vitest";

import { buildTimeline } from "../src/timeline.js";
import type { RecognitionMoment, TrackMatch } from "../src/types.js";

function match(artist: string, title: string, startSeconds: number, confidence = 90): TrackMatch {
  return {
    artist,
    title,
    startSeconds,
    scanSeconds: Math.floor(startSeconds / 12) * 12,
    confidence,
    provider: "audd",
  };
}

describe("buildTimeline", () => {
  test("collapses held tracks and keeps confident blends", () => {
    const moments: RecognitionMoment[] = [
      { offsetSeconds: 0, matches: [match("A", "One", 1)] },
      { offsetSeconds: 12, matches: [match("A", "One", 12)] },
      {
        offsetSeconds: 24,
        matches: [match("B", "Two", 25, 95), match("A", "One", 25, 70)],
      },
      { offsetSeconds: 36, matches: [match("B", "Two", 37, 92)] },
    ];

    expect(buildTimeline(moments)).toEqual([
      expect.objectContaining({ order: 1, artist: "A", title: "One", timestamp: "00:00:01" }),
      expect.objectContaining({
        order: 2,
        artist: "B",
        title: "Two",
        timestamp: "00:00:25",
        overlaps: [{ artist: "A", title: "One", confidence: 70 }],
      }),
    ]);
  });

  test("filters low-score candidates", () => {
    const result = buildTimeline(
      [{ offsetSeconds: 0, matches: [match("Noise", "False", 0, 30)] }],
      { minScore: 40 },
    );
    expect(result).toEqual([]);
  });

  test("removes an isolated low-confidence blip", () => {
    const result = buildTimeline([
      { offsetSeconds: 0, matches: [match("A", "One", 0, 95)] },
      { offsetSeconds: 12, matches: [match("Wrong", "Guess", 12, 50)] },
      { offsetSeconds: 24, matches: [match("A", "One", 24, 90)] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ artist: "A", title: "One", order: 1 });
    expect(result[0]?.overlaps).toEqual([{ artist: "Wrong", title: "Guess", confidence: 50 }]);
  });

  test("preserves a middle track supported by multiple scans", () => {
    const result = buildTimeline([
      { offsetSeconds: 0, matches: [match("A", "One", 0, 95)] },
      { offsetSeconds: 12, matches: [match("B", "Two", 12, 80)] },
      { offsetSeconds: 24, matches: [match("B", "Two", 24, 85)] },
      { offsetSeconds: 36, matches: [match("A", "One", 36, 90)] },
    ]);
    expect(result.map((entry) => entry.artist)).toEqual(["A", "B", "A"]);
  });

  test("does not erase a sparse middle track across long no-match gaps", () => {
    const result = buildTimeline([
      { offsetSeconds: 0, matches: [match("A", "One", 0, 95)] },
      { offsetSeconds: 600, matches: [match("B", "Two", 600, 80)] },
      { offsetSeconds: 1200, matches: [match("A", "One", 1200, 90)] },
    ]);
    expect(result.map((entry) => entry.artist)).toEqual(["A", "B", "A"]);
  });

  test("keeps the strongest duplicate canonical candidate", () => {
    const result = buildTimeline([
      {
        offsetSeconds: 0,
        matches: [match("A", "One", 0, 30), match("A", "One", 0, 99)],
      },
    ]);
    expect(result[0]?.confidence).toBe(99);
  });

  test("uses blendScore independently from the primary score floor", () => {
    const result = buildTimeline(
      [
        {
          offsetSeconds: 0,
          matches: [match("A", "One", 0, 95), match("B", "Two", 0, 70)],
        },
      ],
      { minScore: 90, blendScore: 50 },
    );
    expect(result[0]?.overlaps).toEqual([{ artist: "B", title: "Two", confidence: 70 }]);
  });

  test("extends the evidence end when the same track repeats", () => {
    const first = { ...match("A", "One", 0), endSeconds: 10 };
    const second = { ...match("A", "One", 12), endSeconds: 22 };
    expect(
      buildTimeline([
        { offsetSeconds: 0, matches: [first] },
        { offsetSeconds: 12, matches: [second] },
      ])[0]?.endSeconds,
    ).toBe(22);
  });
});
