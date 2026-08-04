import { describe, expect, test, vi } from "vitest";

import { DiscogsMetadataClient } from "../src/discogs-metadata.js";

function json(value: unknown): Response {
  return Response.json(value);
}

describe("DiscogsMetadataClient", () => {
  test("verifies the release tracklist before accepting label and style", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/database/search") {
        return json({
          results: [
            {
              id: 202,
              title: "Adam Port & Monolink - Point Of No Return",
              format: ["File", "MP3", "Single"],
            },
          ],
        });
      }
      return json({
        id: 202,
        title: "Point Of No Return",
        released: "2023-03-15",
        artists: [{ name: "Adam Port" }, { name: "Monolink" }],
        labels: [{ name: "Afterlife (6)" }],
        genres: ["Electronic"],
        styles: ["Progressive House"],
        tracklist: [{ title: "Point Of No Return (Extended Mix)", duration: "6:34" }],
      });
    });
    const client = new DiscogsMetadataClient({ cache: false, fetch, requestIntervalMs: 0 });

    await expect(
      client.lookup({
        title: "Point of No Return (Extended Mix)",
        artists: ["Adam Port", "Monolink"],
        durationSeconds: 394,
      }),
    ).resolves.toEqual({
      album: "Point Of No Return",
      label: "Afterlife",
      genre: "Progressive House",
      releaseDate: "2023-03-15",
      provider: "discogs",
      recordingId: "202:point of no return extended mix",
      releaseId: "202",
      matchedBy: "artist-title",
    });
  });

  test("rejects search results whose detailed tracklist does not match", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return url.pathname === "/database/search"
        ? json({ results: [{ id: 202, title: "Artist - Release", format: ["File"] }] })
        : json({
            id: 202,
            title: "Release",
            artists: [{ name: "Artist" }],
            tracklist: [{ title: "Different Track", duration: "4:00" }],
          });
    });
    const client = new DiscogsMetadataClient({ cache: false, fetch, requestIntervalMs: 0 });

    await expect(
      client.lookup({ title: "Expected Track", artists: ["Artist"], durationSeconds: 240 }),
    ).resolves.toBeUndefined();
  });
});
