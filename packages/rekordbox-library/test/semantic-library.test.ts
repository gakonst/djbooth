import { describe, expect, it } from "vitest";

import type { TrackSummary } from "../src/shared/types.js";
import {
  isSemanticDiscoveryRequest,
  modelTrack,
  resolveTemporaryCrateTracks,
  selectLibraryCandidates,
  summarizeLibraryCatalog,
} from "../src/client/semantic-library.js";

describe("semantic library discovery", () => {
  it("recognizes vibe/set prompts without misclassifying a literal lookup", () => {
    expect(isSemanticDiscoveryRequest("Find tracks for a late-night warm-up")).toBe(true);
    expect(isSemanticDiscoveryRequest("Curate a low-energy opening set")).toBe(true);
    expect(isSemanticDiscoveryRequest("Find the track Warm It Up by Rakim")).toBe(false);
  });

  it("summarizes playable genre and BPM facets", () => {
    const facets = summarizeLibraryCatalog([
      track("a", { genre: "Deep House", bpm: 118 }),
      track("b", { genre: "Deep House", bpm: 122 }),
      track("c", { genre: "Ambient", bpm: 90, fileExists: false }),
    ]);

    expect(facets.playableTracks).toBe(2);
    expect(facets.bpmRange).toEqual({ min: 118, max: 122 });
    expect(facets.genres[0]).toEqual({ name: "Deep House", count: 2 });
  });

  it("returns playable, bounded, artist-diverse candidates", () => {
    const tracks = [
      track("a1", { artist: "One", genre: "Deep House", bpm: 118, rating: 5 }),
      track("a2", { artist: "One", genre: "Deep House", bpm: 119, rating: 4 }),
      track("a3", { artist: "One", genre: "Deep House", bpm: 120, rating: 3 }),
      track("b1", { artist: "Two", genre: "Deep House", bpm: 121, rating: 2 }),
      track("c1", { artist: "Three", genre: "Techno", bpm: 124, rating: 5 }),
      track("missing", { artist: "Four", genre: "Deep House", bpm: 117, fileExists: false }),
    ];

    const candidates = selectLibraryCandidates(tracks, {
      bpmMin: 115,
      bpmMax: 122,
      genreTerms: ["house"],
      limit: 8,
    });

    expect(candidates.map((candidate) => candidate.id)).toEqual(["a1", "a2", "b1", "a3"]);
    expect(candidates).not.toContainEqual(expect.objectContaining({ id: "missing" }));
  });

  it("resolves a model selection in order without duplicates and strips paths from model rows", () => {
    const tracks = [track("a"), track("b"), track("c")];
    expect(resolveTemporaryCrateTracks(tracks, ["c", "a", "c"]).map((item) => item.id)).toEqual([
      "c",
      "a",
    ]);
    expect(modelTrack(tracks[0]!)).not.toHaveProperty("path");
    expect(() => resolveTemporaryCrateTracks(tracks, ["unknown"])).toThrow(/not in/u);
  });
});

function track(id: string, patch: Partial<TrackSummary> = {}): TrackSummary {
  return {
    id,
    title: `Track ${id}`,
    artist: "Artist",
    album: "Album",
    genre: "House",
    key: "8A",
    colorId: null,
    bpm: 120,
    durationSeconds: 360,
    rating: 1,
    playCount: 1,
    analyzed: true,
    artworkAvailable: false,
    fileExists: true,
    path: `/music/${id}.wav`,
    ...patch,
  };
}
