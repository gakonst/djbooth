import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import {
  canonicalSourceUrl,
  exactSourcesFromRekordboxComment,
  LinkPageMetadataClient,
  SidecarMetadataClient,
  SoundCloudMetadataClient,
  SpotifySourceMetadataClient,
} from "../src/source-metadata.js";

describe("exact source metadata", () => {
  test("keeps per-track comment links and rejects containing-set links", () => {
    expect(
      exactSourcesFromRekordboxComment(
        [
          "[tracks-ts]",
          "Set URL: https://www.youtube.com/watch?v=set-id",
          "Media source: https://soundcloud.com/artist/track?utm_source=test",
          "Spotify URL: https://open.spotify.com/track/abc123?si=secret",
        ].join("\n"),
      ),
    ).toEqual([
      {
        provider: "soundcloud",
        url: "https://soundcloud.com/artist/track",
        origin: "rekordbox-comment",
      },
      {
        provider: "spotify",
        url: "https://open.spotify.com/track/abc123",
        origin: "rekordbox-comment",
      },
    ]);
  });

  test("extracts SoundCloud publisher metadata without resolving media", async () => {
    const hydration = [
      {
        hydratable: "sound",
        data: {
          title: "Artist - Track",
          full_duration: 241_000,
          genre: "Dance & EDM",
          tag_list: '"Indie Dance"',
          label_name: "Night Records",
          release_date: "2026-07-14T00:00:00Z",
          purchase_url: "https://label.example/track",
          description: "Listen & download: https://label.lnk.to/release",
          publisher_metadata: { artist: "Artist", isrc: "USAAA2600001" },
        },
      },
    ];
    const fetch = vi.fn(
      async () =>
        new Response(`<script>window.__sc_hydration = ${JSON.stringify(hydration)};</script>`),
    );
    const client = new SoundCloudMetadataClient({ cache: false, fetch });

    await expect(client.lookup("https://soundcloud.com/artist/track")).resolves.toEqual({
      title: "Artist - Track",
      artist: "Artist",
      label: "Night Records",
      genre: "Indie Dance",
      isrc: "USAAA2600001",
      releaseDate: "2026-07-14",
      durationSeconds: 241,
      relatedUrls: ["https://label.example/track", "https://label.lnk.to/release"],
    });
  });

  test("joins exact Spotify track, album, and artist records", async () => {
    const raw = vi.fn(async (_method: string, path: string) => {
      if (path === "tracks/abc123") {
        return {
          name: "Track",
          duration_ms: 240_000,
          external_ids: { isrc: "USAAA2600001" },
          artists: [{ id: "artist-1", name: "Artist" }],
          album: { id: "album-1", name: "Track", release_date: "2026" },
        };
      }
      if (path === "albums/album-1") {
        return {
          name: "Track",
          label: "Night Records",
          release_date: "2026-07-14",
          genres: [],
        };
      }
      return { genres: ["minimal tech house", "house"] };
    });
    const client = new SpotifySourceMetadataClient({
      raw: async <T>(method: string, path: string) => (await raw(method, path)) as T,
    });

    await expect(client.lookup("https://open.spotify.com/track/abc123")).resolves.toEqual({
      title: "Track",
      artist: "Artist",
      album: "Track",
      label: "Night Records",
      genre: "minimal tech house",
      isrc: "USAAA2600001",
      releaseDate: "2026-07-14",
      durationSeconds: 240,
    });
    expect(raw).toHaveBeenCalledTimes(3);
  });

  test("uses strict Spotify search as a catalog fallback", async () => {
    const raw = vi.fn(async (_method: string, path: string) => {
      if (path === "search") {
        return {
          tracks: {
            items: [
              {
                id: "abc123",
                name: "Track",
                duration_ms: 240_000,
                external_ids: { isrc: "USAAA2600001" },
                artists: [{ id: "artist-1", name: "Artist" }],
                album: { id: "album-1", name: "Track", release_date: "2026" },
              },
            ],
          },
        };
      }
      if (path === "tracks/abc123") {
        return {
          name: "Track",
          duration_ms: 240_000,
          external_ids: { isrc: "USAAA2600001" },
          artists: [{ id: "artist-1", name: "Artist" }],
          album: { id: "album-1", name: "Track", release_date: "2026" },
        };
      }
      if (path === "albums/album-1") {
        return { name: "Track", label: "Night Records", release_date: "2026-07-14" };
      }
      return { genres: ["minimal tech house"] };
    });
    const client = new SpotifySourceMetadataClient({
      raw: async <T>(method: string, path: string) => (await raw(method, path)) as T,
    });

    await expect(
      client.lookupCatalog({ title: "Track", artists: ["Artist"], durationSeconds: 240 }),
    ).resolves.toMatchObject({
      album: "Track",
      label: "Night Records",
      genre: "minimal tech house",
      isrc: "USAAA2600001",
      provider: "spotify",
      recordingId: "abc123",
      matchedBy: "artist-title",
    });
  });

  test("retries Spotify catalog lookup broadly for a safe spelling correction", async () => {
    const queries: string[] = [];
    const track = {
      id: "baila",
      name: "Baila Conmigo",
      duration_ms: 327_000,
      external_ids: { isrc: "US83Z2552735" },
      artists: [{ id: "artist-1", name: "MARé (AM)" }],
      album: { id: "album-1", name: "Baila Conmigo", release_date: "2025" },
    };
    const client = new SpotifySourceMetadataClient({
      async raw<T>(_method: string, path: string, options?: { query?: Record<string, unknown> }) {
        if (path === "search") {
          const query = String(options?.query?.q ?? "");
          queries.push(query);
          return {
            tracks: { items: query.startsWith('track:"') ? [] : [track] },
          } as T;
        }
        if (path === "tracks/baila") return track as T;
        if (path === "albums/album-1")
          return {
            name: "Baila Conmigo",
            label: "Maccabi House",
            release_date: "2025-11-28",
          } as T;
        return { genres: ["organic house"] } as T;
      },
    });

    await expect(
      client.lookupCatalog({
        title: "Baila Conmigao",
        artists: ["Maré (Am)"],
        durationSeconds: 327,
      }),
    ).resolves.toMatchObject({
      title: "Baila Conmigo",
      album: "Baila Conmigo",
      label: "Maccabi House",
      genre: "organic house",
      recordingId: "baila",
    });
    expect(queries).toEqual([
      'track:"Baila Conmigao" artist:"Maré (Am)"',
      "Baila Conmigao Maré (Am)",
    ]);
  });

  test("finds relocated sidecars by canonical source URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-sidecars-"));
    const nested = join(root, "relocated");
    await mkdir(nested);
    await writeFile(
      join(nested, "track.info.json"),
      JSON.stringify({
        webpage_url: "https://soundcloud.com/artist/track?utm_source=download",
        track: "Artist - Track",
        artist: "Artist",
        album: "Track",
        label_name: "Night Records",
        genre: "House",
      }),
    );
    const client = new SidecarMetadataClient([root]);

    await expect(client.lookup("https://soundcloud.com/artist/track")).resolves.toMatchObject({
      title: "Artist - Track",
      artist: "Artist",
      album: "Track",
      label: "Night Records",
      genre: "House",
    });
    expect(canonicalSourceUrl("https://soundcloud.com/artist/track?si=abc#fragment")).toBe(
      "https://soundcloud.com/artist/track",
    );
  });

  test("expands a smart link into exact catalog URLs", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          [
            'scanUrl:\\"upc:199538098419\\"',
            '<a href="https://music.apple.com/us/album/release/202?i=101&at=affiliate">Apple</a>',
            '<a href="https://open.spotify.com/track/spotify-id?si=abc">Spotify</a>',
            '<a href="https://www.deezer.com/track/3979074551?app_id=1">Deezer</a>',
          ].join(""),
        ),
    );
    const client = new LinkPageMetadataClient({ cache: false, fetch });

    await expect(client.lookup("https://label.lnk.to/release")).resolves.toEqual({
      relatedUrls: [
        "apple:upc:199538098419",
        "deezer:upc:199538098419",
        "https://music.apple.com/us/album/release/202?i=101",
        "https://www.deezer.com/track/3979074551?app_id=1",
        "https://open.spotify.com/track/spotify-id",
      ],
    });
  });
});
