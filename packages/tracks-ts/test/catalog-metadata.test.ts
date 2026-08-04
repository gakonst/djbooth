import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { JsonDiskCache } from "../src/cache.js";
import { MusicBrainzMetadataClient } from "../src/catalog-metadata.js";

function json(value: unknown): Response {
  return Response.json(value);
}

describe("MusicBrainzMetadataClient", () => {
  test("resolves official release metadata from an exact ISRC", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/isrc/")) {
        return json({
          recordings: [
            {
              id: "recording-1",
              title: "Exact Mix",
              length: 241_000,
              "artist-credit": [{ name: "Artist One" }],
            },
          ],
        });
      }
      if (url.pathname.includes("/recording/")) {
        return json({
          id: "recording-1",
          title: "Exact Mix",
          genres: [{ name: "House", count: 2 }],
          releases: [
            {
              id: "release-1",
              title: "Exact Mix",
              status: "Official",
              date: "2026-07-14",
              "release-group": { "primary-type": "Single" },
            },
          ],
        });
      }
      return json({
        id: "release-1",
        title: "Exact Mix",
        date: "2026-07-14",
        "label-info": [{ label: { name: "Night Records" } }],
        genres: [{ name: "House", count: 1 }],
        "release-group": { genres: [{ name: "House", count: 1 }] },
      });
    });
    const client = new MusicBrainzMetadataClient({ cache: false, fetch, requestIntervalMs: 0 });

    await expect(
      client.lookup({
        title: "Exact Mix",
        artists: ["Artist One"],
        isrc: "US-AAA-26-00001",
        durationSeconds: 241,
      }),
    ).resolves.toEqual({
      album: "Exact Mix",
      label: "Night Records",
      genre: "House",
      releaseDate: "2026-07-14",
      provider: "musicbrainz",
      recordingId: "recording-1",
      releaseId: "release-1",
      matchedBy: "isrc",
    });
  });

  test("rejects inexact title search and caches the negative result", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-musicbrainz-cache-"));
    const fetch = vi.fn(async () =>
      json({
        recordings: [
          {
            id: "wrong-recording",
            score: 99,
            title: "Live Version",
            "artist-credit": [{ name: "Artist One" }],
          },
        ],
      }),
    );
    const client = new MusicBrainzMetadataClient({
      cache: new JsonDiskCache({ namespace: "musicbrainz-test-v1", root }),
      fetch,
      requestIntervalMs: 0,
    });
    const query = { title: "Exact Mix", artists: ["Artist One"] };

    await expect(client.lookup(query)).resolves.toBeUndefined();
    await expect(client.lookup(query)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(client.cacheStats()).toMatchObject({ hits: 1, misses: 2, writes: 2 });
  });

  test("uses the primary credited artist genre when the recording and release lack taxonomy", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/recording/") && !url.pathname.endsWith("/recording")) {
        return json({
          id: "recording-1",
          title: "Exact Mix",
          "artist-credit": [{ artist: { id: "artist-1", name: "Artist One" } }],
          releases: [
            {
              id: "release-1",
              title: "Exact Mix",
              status: "Official",
              "release-group": { "primary-type": "Single" },
            },
          ],
        });
      }
      if (url.pathname.includes("/release/")) {
        return json({ id: "release-1", title: "Exact Mix" });
      }
      if (url.pathname.includes("/artist/")) {
        return json({ genres: [{ name: "Progressive House", count: 4 }] });
      }
      return json({
        recordings: [
          {
            id: "recording-1",
            score: 100,
            title: "Exact Mix",
            "artist-credit": [{ name: "Artist One" }],
          },
        ],
      });
    });
    const client = new MusicBrainzMetadataClient({ cache: false, fetch, requestIntervalMs: 0 });

    await expect(
      client.lookup({ title: "Exact Mix", artists: ["Artist One"] }),
    ).resolves.toMatchObject({ genre: "Progressive House" });
  });
});
