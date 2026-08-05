import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { indexManifestMetadata } from "../src/metadata-enrichment.js";

describe("metadata enrichment provenance", () => {
  test("indexes moved recordings by Rekordbox ID, hash, Spotify ID, and original path", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-enrich-"));
    const set = join(root, "set");
    await mkdir(set);
    const originalPath = join(root, "original.m4a");
    const sha256 = "a".repeat(64);
    await writeFile(
      join(set, "manifest.json"),
      JSON.stringify({
        entries: [
          {
            identity: {
              status: "identified",
              artist: "Artist",
              title: "Track",
              label: "Label",
              mediaLinks: [{ platform: "soundcloud", url: "https://soundcloud.com/artist/track" }],
            },
            spotify: {
              status: "matched",
              id: "1234567890123456789012",
              url: "https://open.spotify.com/track/1234567890123456789012",
              album: "Release",
              isrc: "USAAA2600001",
            },
            acquisition: {
              status: "downloaded",
              download: {
                mediaPath: originalPath,
                sha256,
                spotifyId: "1234567890123456789012",
                source: "https://youtube.com/watch?v=containing-set",
                clip: { sourceSetUrl: "https://youtube.com/watch?v=containing-set" },
              },
            },
            rekordbox: {
              status: "imported",
              dbContentId: "content-1",
              dbContentIds: ["content-1", "content-2"],
            },
          },
        ],
      }),
    );

    const index = await indexManifestMetadata([root]);
    const record = index.byContentId.get("content-2");

    expect(record?.metadata).toMatchObject({
      artist: "Artist",
      title: "Track",
      album: "Release",
      label: "Label",
      isrc: "USAAA2600001",
    });
    expect(index.byPath.get(originalPath)).toBe(record);
    expect(index.bySha256.get(sha256)).toBe(record);
    expect(index.bySpotifyId.get("1234567890123456789012")).toBe(record);
    expect(record?.sources).toEqual([
      {
        provider: "soundcloud",
        url: "https://soundcloud.com/artist/track",
        origin: "manifest",
      },
      {
        provider: "spotify",
        url: "https://open.spotify.com/track/1234567890123456789012",
        origin: "manifest",
      },
    ]);
  });
});
