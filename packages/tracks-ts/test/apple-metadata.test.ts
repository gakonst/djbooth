import { describe, expect, test, vi } from "vitest";

import { AppleMetadataClient } from "../src/apple-metadata.js";

function json(value: unknown): Response {
  return Response.json(value);
}

describe("AppleMetadataClient", () => {
  test("strictly matches catalog search and resolves the release copyright label", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/search") {
        return json({
          results: [
            {
              kind: "song",
              trackId: 101,
              trackName: "Work It Out (Extended Mix)",
              artistName: "Artist One",
              collectionId: 202,
              collectionName: "Work It Out - Single",
              primaryGenreName: "House",
              releaseDate: "2026-07-14T12:00:00Z",
              trackTimeMillis: 241_000,
            },
          ],
        });
      }
      return json({
        results: [
          {
            wrapperType: "collection",
            collectionId: 202,
            collectionName: "Work It Out - Single",
            copyright: "℗ 2026 Night Records, under exclusive licence to Example Music",
          },
        ],
      });
    });
    const client = new AppleMetadataClient({ cache: false, fetch, requestIntervalMs: 0 });

    await expect(
      client.lookup({
        title: "Work It Out (Extended Mix)",
        artists: ["Artist One"],
        durationSeconds: 241,
      }),
    ).resolves.toEqual({
      album: "Work It Out - Single",
      label: "Night Records",
      genre: "House",
      releaseDate: "2026-07-14",
      provider: "apple",
      recordingId: "101",
      releaseId: "202",
      matchedBy: "artist-title",
    });
  });

  test("resolves an exact Apple Music track ID from its smart-link URL", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const id = url.searchParams.get("id");
      if (id === "101") {
        return json({
          results: [
            {
              kind: "song",
              trackId: 101,
              trackName: "Work It Out",
              artistName: "Artist One",
              collectionId: 202,
              collectionName: "Work It Out - Single",
              primaryGenreName: "House",
              releaseDate: "2026-07-14T12:00:00Z",
              trackTimeMillis: 241_000,
            },
          ],
        });
      }
      return json({
        results: [
          {
            wrapperType: "collection",
            collectionId: 202,
            copyright: "℗ 2026 Night Records",
          },
        ],
      });
    });
    const client = new AppleMetadataClient({ cache: false, fetch, requestIntervalMs: 0 });

    await expect(
      client.lookupTrackUrl("https://music.apple.com/us/album/release/202?i=101&at=affiliate"),
    ).resolves.toMatchObject({
      title: "Work It Out",
      artist: "Artist One",
      album: "Work It Out - Single",
      label: "Night Records",
      durationSeconds: 241,
      matchedBy: "source-url",
    });
  });
});
