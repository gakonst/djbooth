import { describe, expect, it } from "vitest";

import { sortEditorTracks } from "../src/client/components/PlaylistEditor.js";
import { playlistDropTrackNumber } from "../src/client/components/playlist-order.js";
import type { TrackSummary, TrackSortField } from "../src/shared/types.js";

function track(
  id: string,
  title: string,
  values: Partial<Pick<TrackSummary, "bpm" | "durationSeconds" | "key" | "trackNumber">>,
): TrackSummary {
  return {
    id,
    title,
    artist: null,
    album: null,
    genre: null,
    key: values.key ?? null,
    bpm: values.bpm ?? null,
    durationSeconds: values.durationSeconds ?? null,
    rating: 0,
    playCount: 0,
    analyzed: false,
    artworkAvailable: false,
    fileExists: false,
    path: null,
    ...(values.trackNumber === undefined ? {} : { trackNumber: values.trackNumber }),
  };
}

describe("playlist drag ordering", () => {
  it("accounts for the source row being removed before a later target", () => {
    expect(playlistDropTrackNumber(1, 3, "before", 4)).toBe(2);
    expect(playlistDropTrackNumber(1, 3, "after", 4)).toBe(3);
  });

  it("places an upward drag on the requested side of its target", () => {
    expect(playlistDropTrackNumber(4, 2, "before", 4)).toBe(2);
    expect(playlistDropTrackNumber(4, 2, "after", 4)).toBe(3);
  });

  it("clamps drops to playlist bounds", () => {
    expect(playlistDropTrackNumber(4, 1, "before", 4)).toBe(1);
    expect(playlistDropTrackNumber(1, 4, "after", 4)).toBe(4);
  });

  it("keeps missing editor values last in both directions", () => {
    const items = [
      track("missing", "Missing", {}),
      track("low", "Low", { bpm: 120, durationSeconds: 180, key: "4A", trackNumber: 1 }),
      track("high", "High", { bpm: 130, durationSeconds: 240, key: "8A", trackNumber: 2 }),
    ];

    for (const field of ["position", "bpm", "key", "duration"] satisfies TrackSortField[]) {
      expect(
        sortEditorTracks(items, { field, direction: "asc" }).map((item) => item.id),
        `${field} ascending`,
      ).toEqual(["low", "high", "missing"]);
      expect(
        sortEditorTracks(items, { field, direction: "desc" }).map((item) => item.id),
        `${field} descending`,
      ).toEqual(["high", "low", "missing"]);
    }
  });
});
