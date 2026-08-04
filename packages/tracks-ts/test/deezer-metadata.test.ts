import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { JsonDiskCache } from "../src/cache.js";
import { DeezerMetadataClient } from "../src/deezer-metadata.js";

function json(value: unknown): Response {
  return Response.json(value);
}

describe("DeezerMetadataClient", () => {
  test("resolves album, label, and genre from an exact ISRC", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/track/isrc:")) {
        return json({
          id: 101,
          title: "Exact Mix",
          isrc: "USAAA2600001",
          duration: 241,
          artist: { name: "Artist One" },
          album: { id: 202, title: "Exact Mix" },
        });
      }
      return json({
        id: 202,
        title: "Exact Mix",
        label: "Night Records",
        release_date: "2026-07-14",
        genres: { data: [{ id: 113, name: "Dance" }] },
      });
    });
    const client = new DeezerMetadataClient({ cache: false, fetch, requestIntervalMs: 0 });

    await expect(
      client.lookup({
        title: "Exact Mix",
        artists: ["Artist One"],
        isrc: "US-AAA-26-00001",
      }),
    ).resolves.toEqual({
      album: "Exact Mix",
      label: "Night Records",
      genre: "Dance",
      isrc: "USAAA2600001",
      releaseDate: "2026-07-14",
      provider: "deezer",
      recordingId: "101",
      releaseId: "202",
      matchedBy: "isrc",
    });
  });

  test("requires a unique title, artist, and duration search match and caches misses", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-deezer-cache-"));
    const fetch = vi.fn(async () =>
      json({
        data: [
          {
            id: 101,
            title_short: "Exact Mix",
            duration: 241,
            artist: { name: "Wrong Artist" },
            album: { id: 202, title: "Exact Mix" },
          },
        ],
      }),
    );
    const client = new DeezerMetadataClient({
      cache: new JsonDiskCache({ namespace: "deezer-test-v1", root }),
      fetch,
      requestIntervalMs: 0,
    });
    const query = { title: "Exact Mix", artists: ["Artist One"], durationSeconds: 241 };

    await expect(client.lookup(query)).resolves.toBeUndefined();
    await expect(client.lookup(query)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(client.cacheStats()).toMatchObject({ hits: 1, misses: 2, writes: 2 });
  });

  test("resolves a direct Deezer track URL without search", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/track/101") {
        return json({
          id: 101,
          title: "Exact Mix",
          isrc: "USAAA2600001",
          duration: 241,
          artist: { name: "Artist One" },
          album: { id: 202, title: "Exact Mix" },
        });
      }
      return json({
        id: 202,
        title: "Exact Mix",
        label: "Night Records",
        release_date: "2026-07-14",
        genres: { data: [{ id: 113, name: "House" }] },
      });
    });
    const client = new DeezerMetadataClient({ cache: false, fetch, requestIntervalMs: 0 });

    await expect(
      client.lookupTrackUrl("https://www.deezer.com/track/101?app_id=1"),
    ).resolves.toEqual({
      title: "Exact Mix",
      artist: "Artist One",
      album: "Exact Mix",
      label: "Night Records",
      genre: "House",
      isrc: "USAAA2600001",
      releaseDate: "2026-07-14",
      durationSeconds: 241,
      provider: "deezer",
      recordingId: "101",
      releaseId: "202",
      matchedBy: "source-url",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test("resolves an exact smart-link UPC", async () => {
    const fetch = vi.fn(async () =>
      json({
        id: 202,
        title: "Sticky",
        label: "South Of Saturn",
        release_date: "2025-07-25",
        genres: { data: [{ id: 113, name: "House" }] },
      }),
    );
    const client = new DeezerMetadataClient({ cache: false, fetch, requestIntervalMs: 0 });

    await expect(client.lookupAlbumUpc("199538098419")).resolves.toEqual({
      album: "Sticky",
      label: "South Of Saturn",
      genre: "House",
      releaseDate: "2025-07-25",
      provider: "deezer",
      recordingId: "upc:199538098419",
      releaseId: "202",
      matchedBy: "source-url",
    });
  });
});
