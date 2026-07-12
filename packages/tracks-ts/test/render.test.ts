import { describe, expect, test } from "vitest";

import { createManifest } from "../src/manifest.js";
import { parseTracklistJson, renderTracklist } from "../src/render.js";
import type { Tracklist } from "../src/types.js";

const tracklist: Tracklist = {
  source: "set.mp3",
  provider: "audd",
  title: "My Set",
  complete: true,
  tracks: [
    {
      order: 1,
      startSeconds: 0,
      artist: "Artist",
      title: "Opening",
      mix: "Club Mix",
      confidence: 95,
      overlaps: [{ artist: "Guest", title: "Acapella", confidence: 80 }],
    },
    { order: 2, startSeconds: 65.5, artist: "Other", title: "Next", label: "Label" },
  ],
};

describe("renderTracklist", () => {
  test("renders 1001-style text", () => {
    expect(renderTracklist(tracklist)).toBe(
      "00:00:00  Artist — Opening\n          w/ Guest — Acapella\n00:01:05  Other — Next  [Label]",
    );
  });

  test("renders YouTube chapters", () => {
    expect(renderTracklist(tracklist, { style: "youtube" })).toBe(
      "00:00 Artist — Opening\n01:05 Other — Next",
    );
  });

  test("renders CUE sheets", () => {
    expect(renderTracklist(tracklist, { style: "cue", audioFile: "mix.wav" })).toContain(
      'FILE "mix.wav" WAVE\n  TRACK 01 AUDIO',
    );
    expect(renderTracklist(tracklist, { style: "cue" })).toContain("INDEX 01 01:05:37");
    expect(renderTracklist(tracklist, { style: "cue" })).toContain('FILE "set.mp3" MP3');
  });

  test("accepts incur data envelopes", () => {
    const parsed = parseTracklistJson({ data: tracklist });
    expect(parsed).toMatchObject({
      title: "My Set",
      tracks: tracklist.tracks,
    });
    expect(renderTracklist(parsed)).toContain("w/ Guest — Acapella");
  });

  test("renders the nested resolver manifest", () => {
    const parsed = parseTracklistJson({ data: createManifest(tracklist) });
    expect(parsed).toMatchObject({ title: "My Set", tracks: tracklist.tracks });
    expect(renderTracklist(parsed, { style: "youtube" })).toContain("01:05 Other — Next");
  });

  test("prepends a zero chapter when recognition begins later", () => {
    const delayed = {
      ...tracklist,
      tracks: [{ order: 1, startSeconds: 2, artist: "Artist", title: "Opening" }],
    };
    expect(renderTracklist(delayed, { style: "youtube" })).toBe(
      "00:00 My Set\n00:02 Artist — Opening",
    );
  });

  test("does not duplicate a zero chapter for a sub-second first match", () => {
    const immediate = {
      ...tracklist,
      tracks: [{ order: 1, startSeconds: 0.5, artist: "Artist", title: "Opening" }],
    };
    expect(renderTracklist(immediate, { style: "youtube" })).toBe("00:00 Artist — Opening");
  });

  test.each(["youtube", "cue"] as const)("rejects missing timestamps for %s", (style) => {
    expect(() =>
      renderTracklist(
        { ...tracklist, tracks: [{ order: 1, artist: "Artist", title: "Opening" }] },
        { style },
      ),
    ).toThrow(/requires timestamps/);
  });
});
