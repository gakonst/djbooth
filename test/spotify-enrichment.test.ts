import { describe, expect, test } from "vitest";

import { createManifest, parseManifest, type SetManifest } from "../src/manifest.js";
import {
  enrichSpotifyManifest,
  scoreSpotifyCandidates,
  type SpotifySearchClient,
} from "../src/spotify-enrichment.js";

function manifest(
  tracks: Array<{
    artist: string;
    title: string;
    mix?: string;
    isrc?: string;
    isId?: boolean;
  }>,
): SetManifest {
  return createManifest({
    source: "https://youtube.test/set",
    provider: "1001tracklists",
    complete: true,
    tracks: tracks.map((track, index) => ({
      order: index + 1,
      startSeconds: index * 300,
      endSeconds: (index + 1) * 300,
      ...track,
    })),
  });
}

function apiTrack(options: {
  id: string;
  name: string;
  artists: string[];
  durationMs?: number;
  isrc?: string;
  albumArtists?: string[];
}) {
  return {
    id: options.id,
    uri: `spotify:track:${options.id}`,
    external_urls: { spotify: `https://open.spotify.com/track/${options.id}` },
    name: options.name,
    artists: options.artists.map((name) => ({ name })),
    album: {
      name: "Release",
      release_date: "2026-06-19",
      artists: (options.albumArtists ?? options.artists).map((name) => ({ name })),
    },
    duration_ms: options.durationMs ?? 300_000,
    explicit: false,
    external_ids: options.isrc ? { isrc: options.isrc } : {},
  };
}

function searchClient(
  items: ReturnType<typeof apiTrack>[],
  calls: Array<{ method: string; path: string; query: Record<string, unknown> }>,
): SpotifySearchClient {
  return {
    async raw(_method, path, options) {
      calls.push({ method: _method, path, query: options?.query ?? {} });
      return { tracks: { items } } as never;
    },
  };
}

describe("Spotify manifest enrichment", () => {
  test("matches a safe title/mix/artist result and enriches identity metadata", async () => {
    const value = manifest([
      { artist: "Piero Pirupa & Shield", title: "I Like", mix: "Club Mix" },
      { artist: "Unknown Artist", title: "ID", isId: true },
    ]);
    const calls: Array<{ method: string; path: string; query: Record<string, unknown> }> = [];
    const spotify = searchClient(
      [
        apiTrack({
          id: "exact",
          name: "I Like - Club Mix",
          artists: ["Piero Pirupa", "Shield"],
          durationMs: 301_000,
          isrc: "ITJ782600041",
          albumArtists: ["Piero Pirupa"],
        }),
        apiTrack({
          id: "live",
          name: "I Like - Club Mix - Live",
          artists: ["Piero Pirupa", "Shield"],
        }),
      ],
      calls,
    );

    const result = await enrichSpotifyManifest(value, spotify, { market: "us" });

    expect(result).toMatchObject({
      attempted: 1,
      requests: 1,
      matched: 1,
      ambiguous: 0,
      unmatched: 0,
      skipped: 1,
      failed: 0,
    });
    expect(calls).toEqual([
      {
        method: "GET",
        path: "search",
        query: {
          q: 'track:"I Like (Club Mix)" artist:"Piero Pirupa & Shield"',
          type: "track",
          limit: 10,
          market: "US",
        },
      },
    ]);
    expect(value.entries[0]!.spotify).toMatchObject({
      status: "matched",
      id: "exact",
      name: "I Like - Club Mix",
      score: 1,
      candidates: [{ id: "exact" }, { id: "live" }],
      albumArtists: ["Piero Pirupa"],
    });
    expect(value.entries[0]!.identity).toMatchObject({
      album: "Release",
      releaseDate: "2026-06-19",
      isrc: "ITJ782600041",
    });
    expect(value.entries[1]!.spotify).toEqual({
      status: "skipped",
      reason: "Track identity is unresolved",
    });
    expect(parseManifest(value)).toEqual(value);
  });

  test("preserves close alternatives and reuses a duplicate query", async () => {
    const value = manifest([
      { artist: "Brunello", title: "Melted" },
      { artist: "Brunello", title: "Melted" },
    ]);
    const calls: Array<{ method: string; path: string; query: Record<string, unknown> }> = [];
    const spotify = searchClient(
      [
        apiTrack({ id: "first", name: "Melted", artists: ["Brunello"] }),
        apiTrack({ id: "second", name: "Melted", artists: ["Brunello"] }),
      ],
      calls,
    );

    const result = await enrichSpotifyManifest(value, spotify);

    expect(result).toMatchObject({ attempted: 2, requests: 1, matched: 0, ambiguous: 2 });
    expect(calls).toHaveLength(1);
    expect(value.entries[0]!.spotify).toEqual({
      status: "ambiguous",
      query: 'track:"Melted" artist:"Brunello"',
      candidates: [
        expect.objectContaining({ id: "first", score: 1 }),
        expect.objectContaining({ id: "second", score: 1 }),
      ],
    });
    expect(value.entries[1]!.spotify).toEqual(value.entries[0]!.spotify);

    const checkpoint = structuredClone(value.entries[0]!.spotify);
    const second = await enrichSpotifyManifest(value, spotify);
    expect(second).toMatchObject({ attempted: 0, requests: 0, untouched: 2 });
    expect(value.entries[0]!.spotify).toEqual(checkpoint);
  });

  test("uses an exact ISRC and will not silently choose a conflicting result", async () => {
    const value = manifest([{ artist: "Artist", title: "Same Name", isrc: "US-AAA-26-00001" }]);
    const calls: Array<{ method: string; path: string; query: Record<string, unknown> }> = [];
    const spotify = searchClient(
      [
        apiTrack({
          id: "conflict",
          name: "Same Name",
          artists: ["Artist"],
          isrc: "USAAA2600002",
        }),
        apiTrack({
          id: "exact",
          name: "Same Name",
          artists: ["Artist"],
          isrc: "USAAA2600001",
        }),
      ],
      calls,
    );

    await enrichSpotifyManifest(value, spotify);

    expect(calls[0]!.query.q).toBe("isrc:USAAA2600001");
    expect(value.entries[0]!.spotify).toMatchObject({
      status: "matched",
      id: "exact",
      score: 1,
    });
    const state = value.entries[0]!.spotify;
    expect(state.status === "matched" ? state.candidates?.[1]?.score : undefined).toBeLessThan(0.5);
  });

  test("leaves weak catalog results unmatched", async () => {
    const value = manifest([{ artist: "Jansons", title: "Panic At The Disco" }]);
    const calls: Array<{ method: string; path: string; query: Record<string, unknown> }> = [];

    const result = await enrichSpotifyManifest(
      value,
      searchClient(
        [apiTrack({ id: "wrong", name: "Totally Different", artists: ["Someone Else"] })],
        calls,
      ),
    );

    expect(result).toMatchObject({ attempted: 1, unmatched: 1 });
    expect(value.entries[0]!.spotify).toEqual({
      status: "unmatched",
      query: 'track:"Panic At The Disco" artist:"Jansons"',
    });
  });

  test("keeps a same-title result ambiguous when an expected collaborator is missing", async () => {
    const value = manifest([{ artist: "Brunello & Vargas", title: "Ghost Dance" }]);
    const calls: Array<{ method: string; path: string; query: Record<string, unknown> }> = [];

    const result = await enrichSpotifyManifest(
      value,
      searchClient([apiTrack({ id: "solo", name: "Ghost Dance", artists: ["Brunello"] })], calls),
    );

    expect(result).toMatchObject({ matched: 0, ambiguous: 1 });
    expect(value.entries[0]!.spotify).toMatchObject({
      status: "ambiguous",
      candidates: [{ id: "solo" }],
    });
  });

  test("uses caller-supplied recording duration only as supporting evidence", async () => {
    const candidates = [
      {
        id: "short",
        uri: "spotify:track:short",
        name: "Track",
        artists: ["Artist"],
        durationMs: 180_000,
      },
      {
        id: "long",
        uri: "spotify:track:long",
        name: "Track",
        artists: ["Artist"],
        durationMs: 300_000,
      },
    ];

    expect(scoreSpotifyCandidates({ artist: "Artist", title: "Track" }, candidates)).toEqual([
      expect.objectContaining({ id: "long", score: 1 }),
      expect.objectContaining({ id: "short", score: 1 }),
    ]);
    expect(
      scoreSpotifyCandidates({ artist: "Artist", title: "Track", durationMs: 300_000 }, candidates),
    ).toEqual([
      expect.objectContaining({ id: "long", score: 1 }),
      expect.objectContaining({ id: "short", score: 0.9 }),
    ]);
  });

  test("records request failures without discarding other entries", async () => {
    const value = manifest([
      { artist: "Broken", title: "Request" },
      { artist: "Working", title: "Request" },
    ]);
    const spotify: SpotifySearchClient = {
      async raw(_method, _path, options) {
        if (String(options?.query?.q).includes("Broken")) throw new Error("HTTP 429: rate limited");
        return {
          tracks: {
            items: [apiTrack({ id: "working", name: "Request", artists: ["Working"] })],
          },
        } as never;
      },
    };

    const result = await enrichSpotifyManifest(value, spotify);

    expect(result).toMatchObject({ failed: 1, matched: 1 });
    expect(value.entries[0]!.spotify).toMatchObject({
      status: "failed",
      error: {
        stage: "spotify",
        code: "SPOTIFY_SEARCH_FAILED",
        message: "HTTP 429: rate limited",
        retryable: true,
      },
    });
  });
});
