import { describe, expect, test } from "vitest";

import { parseManifest } from "../src/manifest.js";
import {
  buildProviderPlaylistManifest,
  type ProviderPlaylistManifestInput,
  type SoundCloudProviderPlaylistTrack,
  type SpotifyProviderPlaylistTrack,
} from "../src/provider-playlist-manifest.js";

function spotifyTrack(
  order: number,
  overrides: Partial<SpotifyProviderPlaylistTrack> = {},
): SpotifyProviderPlaylistTrack {
  return {
    provider: "spotify",
    order,
    id: "spotify-track-1",
    uri: "spotify:track:spotify-track-1",
    url: "https://open.spotify.com/track/spotify-track-1",
    title: "Exact Mix",
    artists: ["Artist One", "Artist Two"],
    album: "Album One",
    albumArtists: ["Artist One"],
    label: "Night Records",
    genre: "House",
    releaseDate: "2026-07-14",
    durationMs: 241_234,
    explicit: false,
    isrc: "USAAA2600001",
    ...overrides,
  };
}

function soundCloudTrack(
  order: number,
  overrides: Partial<SoundCloudProviderPlaylistTrack> = {},
): SoundCloudProviderPlaylistTrack {
  return {
    provider: "soundcloud",
    order,
    urn: "soundcloud:tracks:123456789",
    permalinkUrl: "https://soundcloud.com/artist-one/exact-mix",
    title: "Exact Mix",
    artists: ["Artist One"],
    durationMs: 241_234,
    isrc: "USAAA2600001",
    ...overrides,
  };
}

describe("buildProviderPlaylistManifest", () => {
  test("prefills exact Spotify identity, orders rows, and preserves duplicate recordings", () => {
    const tracks = [
      spotifyTrack(30),
      spotifyTrack(10),
      {
        provider: "spotify" as const,
        order: 20,
        id: "spotify-track-2",
        uri: "spotify:track:spotify-track-2",
        url: "https://open.spotify.com/track/spotify-track-2",
        title: "Second Track",
        artists: ["Artist Three"],
        explicit: true,
      },
    ];
    const input = {
      provider: "spotify",
      id: "spotify:playlist:playlist-1",
      title: "Hosted Playlist",
      url: "https://open.spotify.com/playlist/playlist-1",
      owner: "Owner",
      tracks,
    } satisfies ProviderPlaylistManifestInput;

    const manifest = buildProviderPlaylistManifest(input);

    expect(input.tracks.map(({ order }) => order)).toEqual([30, 10, 20]);
    expect(manifest.source).toEqual({
      input: input.url,
      id: input.id,
      url: input.url,
      title: input.title,
      uploader: input.owner,
    });
    expect(manifest.tracklist).toEqual({ provider: "description", complete: true });
    expect(manifest.entries.map(({ id, order }) => ({ id, order }))).toEqual([
      { id: "track-010", order: 10 },
      { id: "track-020", order: 20 },
      { id: "track-030", order: 30 },
    ]);
    expect(manifest.entries[0]!.spotify).toEqual({
      status: "matched",
      query: "Artist One, Artist Two - Exact Mix",
      score: 1,
      id: "spotify-track-1",
      uri: "spotify:track:spotify-track-1",
      url: "https://open.spotify.com/track/spotify-track-1",
      name: "Exact Mix",
      artists: ["Artist One", "Artist Two"],
      album: "Album One",
      albumArtists: ["Artist One"],
      releaseDate: "2026-07-14",
      durationMs: 241_234,
      explicit: false,
      isrc: "USAAA2600001",
    });
    expect(manifest.entries[0]!.identity).toMatchObject({
      status: "identified",
      artist: "Artist One, Artist Two",
      title: "Exact Mix",
      album: "Album One",
      label: "Night Records",
      genre: "House",
      releaseDate: "2026-07-14",
      isrc: "USAAA2600001",
      songLink: "https://open.spotify.com/track/spotify-track-1",
    });
    expect(manifest.entries[0]!.acquisition).toEqual({
      status: "pending",
      query: "Artist One, Artist Two - Exact Mix",
    });
    expect(manifest.entries[2]!.spotify).toEqual(manifest.entries[0]!.spotify);
    expect(manifest.entries[2]!.identity).toEqual(manifest.entries[0]!.identity);
    expect(JSON.stringify(manifest.entries[0]!.acquisition)).not.toContain("spotify.com");
    expect(parseManifest(structuredClone(manifest))).toEqual(manifest);
  });

  test("retains exact SoundCloud URN and permalink as a preferred ytdlp candidate", () => {
    const permalink =
      "https://soundcloud.com/artist-one/exact-mix?secret_token=s-ExactProviderValue";
    const manifest = buildProviderPlaylistManifest({
      provider: "soundcloud",
      id: "soundcloud:playlists:987654321",
      title: "SoundCloud Playlist",
      url: "https://soundcloud.com/artist-one/sets/playlist",
      owner: "Artist One",
      tracks: [
        soundCloudTrack(2, { permalinkUrl: permalink }),
        soundCloudTrack(1, { permalinkUrl: permalink }),
      ],
    });

    expect(manifest.entries).toHaveLength(2);
    expect(manifest.entries.map(({ order }) => order)).toEqual([1, 2]);
    for (const entry of manifest.entries) {
      expect(entry.identity).toMatchObject({
        status: "identified",
        artist: "Artist One",
        title: "Exact Mix",
        songLink: permalink,
      });
      expect(entry.spotify).toEqual({
        status: "pending",
        query: "Artist One - Exact Mix",
      });
      expect(entry.acquisition).toEqual({
        status: "selected",
        query: "Artist One - Exact Mix",
        candidates: [
          {
            backend: "ytdlp",
            id: "soundcloud:tracks:123456789",
            source: permalink,
            title: "Exact Mix",
            artist: "Artist One",
            durationSeconds: 241.234,
            score: 1,
          },
        ],
        selected: {
          backend: "ytdlp",
          id: "soundcloud:tracks:123456789",
          source: permalink,
          title: "Exact Mix",
          artist: "Artist One",
          durationSeconds: 241.234,
          score: 1,
        },
      });
    }
    expect(parseManifest(structuredClone(manifest))).toEqual(manifest);
  });

  test("builds an empty hosted playlist as a valid durable checkpoint", () => {
    const manifest = buildProviderPlaylistManifest({
      provider: "spotify",
      id: "spotify:playlist:empty",
      title: "Empty",
      url: "https://open.spotify.com/playlist/empty",
      tracks: [],
    });

    expect(manifest.entries).toEqual([]);
    expect(parseManifest(JSON.parse(JSON.stringify(manifest)) as unknown)).toEqual(manifest);
  });

  test("rejects provider mixing and duplicate or invalid positions", () => {
    const base = {
      provider: "spotify",
      id: "spotify:playlist:playlist-1",
      title: "Hosted Playlist",
      url: "https://open.spotify.com/playlist/playlist-1",
    } as const;

    expect(() =>
      buildProviderPlaylistManifest({
        ...base,
        tracks: [soundCloudTrack(1)],
      } as unknown as ProviderPlaylistManifestInput),
    ).toThrow('playlist.tracks[0].provider must equal playlist.provider ("spotify")');
    expect(() =>
      buildProviderPlaylistManifest({
        ...base,
        tracks: [spotifyTrack(1), spotifyTrack(1)],
      }),
    ).toThrow("playlist.tracks[1].order must be unique (1 is repeated)");
    expect(() =>
      buildProviderPlaylistManifest({
        ...base,
        tracks: [spotifyTrack(0)],
      }),
    ).toThrow("playlist.tracks[0].order must be a positive safe integer");
  });

  test("rejects unusable provider metadata before constructing a manifest", () => {
    const base = {
      provider: "soundcloud",
      id: "soundcloud:playlists:987654321",
      title: "SoundCloud Playlist",
      url: "https://soundcloud.com/artist-one/sets/playlist",
    } as const;

    expect(() =>
      buildProviderPlaylistManifest({
        ...base,
        tracks: [soundCloudTrack(1, { artists: [] })],
      }),
    ).toThrow("playlist.tracks[0].artists must not be empty");
    expect(() =>
      buildProviderPlaylistManifest({
        ...base,
        tracks: [soundCloudTrack(1, { durationMs: -1 })],
      }),
    ).toThrow("playlist.tracks[0].durationMs must be a positive safe integer");
    expect(() =>
      buildProviderPlaylistManifest({
        ...base,
        tracks: [soundCloudTrack(1, { permalinkUrl: "soundcloud:tracks:123" })],
      }),
    ).toThrow("playlist.tracks[0].permalinkUrl must be an absolute HTTP(S) URL");
  });
});
