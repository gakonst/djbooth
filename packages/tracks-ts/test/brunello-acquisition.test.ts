import { describe, expect, test } from "vitest";

import { refreshKnownSpotifyTracks, type SpotifyLibraryClient } from "../src/acquire-manifest.js";
import { createManifest } from "../src/manifest.js";
import {
  BRUNELLO_1001_URL,
  BRUNELLO_SOUNDCLOUD_URL,
  BRUNELLO_YOUTUBE_URL,
  buildBrunelloAcquisitionPlan,
  reconcileBrunelloManifest,
} from "../src/presets/brunello-lib-2026.js";

function manifest() {
  return createManifest({
    source: BRUNELLO_YOUTUBE_URL,
    provider: "description",
    complete: true,
    tracks: Array.from({ length: 26 }, (_, index) => ({
      order: index + 1,
      artist: "Placeholder",
      title: `Track ${index + 1}`,
    })),
  });
}

describe("Brunello acquisition preset", () => {
  test("reconciles 26 cues into 21 individual masters and 8 set extracts", () => {
    const reconciled = reconcileBrunelloManifest(manifest());
    const plan = buildBrunelloAcquisitionPlan(reconciled);
    const variants = plan.recordings.flatMap((recording) => recording.variants);
    const sourceClipVariants = variants.filter((variant) => variant.sourceClip);

    expect(reconciled.source).toMatchObject({
      input: BRUNELLO_YOUTUBE_URL,
      url: BRUNELLO_YOUTUBE_URL,
      date: "2026-05-23",
      lineup: ["Brunello"],
    });
    expect(reconciled.tracklist.url).toBe(BRUNELLO_1001_URL);
    expect(reconciled.artifacts.sourceSet?.url).toBe(BRUNELLO_SOUNDCLOUD_URL);
    expect(reconciled.entries.map((entry) => entry.cue.startSeconds)).toHaveLength(26);
    expect(reconciled.entries[5]!.identity).toMatchObject({
      status: "unidentified",
      artist: "Unknown Artist",
      title: "ID [Set Extract @ 22:27]",
    });
    expect(reconciled.entries[24]!.identity).toMatchObject({
      artist: "Unknown Artist",
      title: "ID [Set Extract @ 1:50:30]",
    });
    expect(plan.clips).toHaveLength(7);
    expect(sourceClipVariants).toHaveLength(1);
    expect(variants.filter((variant) => !variant.sourceClip)).toHaveLength(21);
    expect(plan.clips.length + variants.length).toBe(29);
    expect(
      new Set([
        ...plan.clips.map((clip) => clip.entryOrder),
        ...plan.recordings.map((recording) => recording.entryOrder),
      ]).size,
    ).toBe(26);
  });

  test("marks the mixed Nen Lambo fallback as a non-ISRC set extract", () => {
    const plan = buildBrunelloAcquisitionPlan(reconcileBrunelloManifest(manifest()));
    const mixed = plan.recordings
      .find((recording) => recording.entryOrder === 17)!
      .variants.find((variant) => variant.spotifyId === "3I9WmdmUmEbpIpjjwWEWTR")!;

    expect(mixed.isrc).toBeUndefined();
    expect(mixed.metadata.isrc).toBeUndefined();
    expect(mixed.metadata.title).toContain("[Set Extract]");
    expect(mixed.sourceClip).toMatchObject({
      sourceUrl: BRUNELLO_SOUNDCLOUD_URL,
      startSeconds: 4420,
      endSeconds: 4737,
      containsTransitions: true,
    });
  });

  test("refreshes known Spotify IDs without the removed batch endpoint", async () => {
    const reconciled = reconcileBrunelloManifest(manifest());
    const paths: string[] = [];
    const spotify: SpotifyLibraryClient = {
      async raw(_method, path) {
        paths.push(path);
        const id = path.split("/").at(-1)!;
        return {
          id,
          uri: `spotify:track:${id}`,
          name: `Track ${id}`,
          artists: [{ name: "Artist" }],
          album: {
            name: "Album",
            release_date: "2026-01-02",
            artists: [{ name: "Album Artist" }],
          },
          duration_ms: 200_000,
          explicit: false,
          external_ids: { isrc: "USAAA2600001" },
          external_urls: { spotify: `https://open.spotify.com/track/${id}` },
        } as never;
      },
    };

    const result = await refreshKnownSpotifyTracks(reconciled, spotify);

    expect(paths).toHaveLength(22);
    expect(paths.every((path) => /^tracks\/[\w-]+$/u.test(path))).toBe(true);
    expect(paths).not.toContain("tracks");
    expect(reconciled.entries.find((entry) => entry.order === 1)!.spotify).toMatchObject({
      releaseDate: "2026-01-02",
      albumArtists: ["Album Artist"],
    });
    expect(result).toMatchObject({
      ids: 22,
      requests: 22,
      networkRequests: 22,
      received: 22,
      concurrency: 8,
      maxConcurrency: 8,
    });
  });
});
