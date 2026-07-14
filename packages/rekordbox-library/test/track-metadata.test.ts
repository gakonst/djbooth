import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { TrackDetail, TracksResponse } from "../src/shared/types.js";
import { shouldHydrateTrackMetadataDraft } from "../src/client/components/TrackMetadataDialog.js";
import { applyOptimisticLibraryMutation } from "../src/client/optimistic-library.js";

const detail: TrackDetail = {
  id: "track-1",
  revision: "2026-07-12 12:00:00.000 +00:00",
  title: "Old title",
  artist: "Old artist",
  album: null,
  genre: null,
  key: "Am",
  bpm: 120,
  durationSeconds: 180,
  rating: 0,
  playCount: 0,
  analyzed: true,
  artworkAvailable: false,
  fileExists: true,
  path: "/Music/track.mp3",
  comment: null,
  isrc: null,
  releaseYear: null,
  bitRate: 320,
  sampleRate: 44_100,
  fileSize: 1_000,
  analysisPath: "/analysis.dat",
  cues: [],
  playlists: [],
};

describe("optimistic track metadata", () => {
  it("updates track lists and detail caches immediately", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData<TracksResponse>(["tracks", {}], {
      items: [detail],
      count: 1,
      limit: 100,
      offset: 0,
    });
    queryClient.setQueryData(["track", detail.id], detail);

    applyOptimisticLibraryMutation(queryClient, {
      type: "update-track",
      contentId: detail.id,
      expectedRevision: detail.revision,
      metadata: {
        title: "New title",
        artist: "New artist",
        album: "New album",
        genre: "House",
        key: "Fm",
        bpm: 128,
        rating: 4,
        comment: "Peak time",
        releaseYear: 2026,
        isrc: "TEST00000001",
      },
    });

    expect(queryClient.getQueryData<TracksResponse>(["tracks", {}])?.items[0]).toMatchObject({
      title: "New title",
      artist: "New artist",
      album: "New album",
      genre: "House",
      key: "Fm",
      bpm: 128,
      rating: 4,
    });
    expect(queryClient.getQueryData<TrackDetail>(["track", detail.id])).toMatchObject({
      title: "New title",
      revision: detail.revision,
      comment: "Peak time",
      releaseYear: 2026,
      isrc: "TEST00000001",
    });
  });

  it("hydrates a draft once per open track without replacing it on same-track refetches", () => {
    expect(shouldHydrateTrackMetadataDraft(true, "track-1", undefined)).toBe(true);
    expect(shouldHydrateTrackMetadataDraft(true, "track-1", "track-1")).toBe(false);
    expect(shouldHydrateTrackMetadataDraft(true, "track-2", "track-1")).toBe(true);
    expect(shouldHydrateTrackMetadataDraft(false, "track-1", undefined)).toBe(false);
  });
});
