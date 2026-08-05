import { describe, expect, it, vi } from "vitest";
import type { SoundCloudClient } from "@gakonst/soundcloud";

import { prepareHostedImportSource } from "../src/import-source.js";
import type { SpotifyRawClient } from "../src/integrations/spotify-cache.js";

describe("hosted import sources", () => {
  it("snapshots every Spotify playlist page in provider order", async () => {
    const raw = vi.fn(async (_method: string, path: string) => {
      if (path === "/playlists/abc123") {
        return {
          id: "abc123",
          name: "Warm Up",
          external_urls: { spotify: "https://open.spotify.com/playlist/abc123" },
          owner: { display_name: "DJ" },
          items: { items: [spotifyItem("one", "First")], offset: 0, total: 2 },
        };
      }
      return { items: [spotifyItem("two", "Second")], offset: 1, total: 2 };
    });

    const result = await prepareHostedImportSource("spotify:playlist:abc123", {
      spotify: { raw } as unknown as SpotifyRawClient,
    });

    expect(result?.kind).toBe("spotify-playlist");
    expect(result?.manifest.source.input).toBe("spotify:playlist:abc123");
    expect(result?.manifest.source.url).toBe("https://open.spotify.com/playlist/abc123");
    expect(result?.manifest.entries.map((entry) => entry.identity.title)).toEqual([
      "First",
      "Second",
    ]);
    expect(raw).toHaveBeenCalledTimes(2);
  });

  it("uses exact SoundCloud track permalinks as acquisition candidates", async () => {
    const getPlaylist = vi.fn(async () => ({
      urn: "soundcloud:playlists:42",
      title: "Late Night",
      permalink_url: "https://soundcloud.com/dj/sets/late-night",
      user: { username: "dj" },
      tracks: [
        {
          urn: "soundcloud:tracks:7",
          title: "Dub",
          permalink_url: "https://soundcloud.com/producer/dub",
          metadata_artist: "Producer",
          duration: 300_000,
          genre: "Dub",
        },
      ],
    }));

    const result = await prepareHostedImportSource("https://soundcloud.com/dj/sets/late-night", {
      spotify: { raw: vi.fn() },
      soundcloud: { getPlaylist } as unknown as SoundCloudClient,
    });

    expect(result?.kind).toBe("soundcloud-playlist");
    expect(result?.manifest.entries[0]?.acquisition).toMatchObject({
      status: "selected",
      selected: { source: "https://soundcloud.com/producer/dub" },
    });
  });

  it("leaves ordinary DJ-set URLs on the resolver path", async () => {
    await expect(
      prepareHostedImportSource("https://soundcloud.com/dj/recorded-set", {
        spotify: { raw: vi.fn() },
      }),
    ).resolves.toBeUndefined();
  });
});

function spotifyItem(id: string, name: string) {
  return {
    item: {
      id,
      name,
      uri: `spotify:track:${id}`,
      artists: [{ name: "Artist" }],
      album: { name: "Album", release_date: "2026-01-02", artists: [{ name: "Artist" }] },
      external_ids: { isrc: `ISRC${id}` },
      external_urls: { spotify: `https://open.spotify.com/track/${id}` },
      duration_ms: 240_000,
    },
  };
}
