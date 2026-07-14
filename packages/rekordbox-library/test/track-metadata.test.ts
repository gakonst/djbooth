import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { TrackDetail, TracksResponse } from "../src/shared/types.js";
import { applyOptimisticLibraryMutation } from "../src/client/optimistic-library.js";

const detail: TrackDetail = {
  id: "track-1",
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
      comment: "Peak time",
      releaseYear: 2026,
      isrc: "TEST00000001",
    });
  });
});
