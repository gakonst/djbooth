import { describe, expect, test } from "vitest";

import { TracksError } from "../src/errors.js";
import {
  createManifest,
  MANIFEST_KIND,
  parseManifest,
  trackSearchQuery,
  type SetManifest,
} from "../src/manifest.js";
import type { Tracklist, TracklistEntry } from "../src/types.js";

function tracklist(): Tracklist {
  return {
    source: "https://www.youtube.com/watch?v=set",
    sourceId: "set",
    provider: "audd",
    title: "Sunset Set",
    url: "https://www.youtube.com/watch?v=set",
    uploader: "DJ Example",
    date: "2026-07-11",
    lineup: ["DJ Example"],
    durationSeconds: 600,
    sampledEverySeconds: 60,
    complete: false,
    tracks: [
      {
        order: 1,
        timestamp: "00:00:10",
        startSeconds: 10,
        endSeconds: 210,
        artist: "Artist",
        title: "Track",
        mix: "Club Mix",
        album: "Album",
        label: "Label",
        releaseDate: "2026-01-02",
        isrc: "USAAA2600001",
        upc: "123456789012",
        songLink: "https://example.com/track",
        confidence: 98,
        overlaps: [{ artist: "Guest", title: "Acapella", confidence: 75 }],
      },
      {
        order: 2,
        isId: true,
        timestamp: "00:03:30",
        startSeconds: 210,
        artist: "ID",
        title: "ID",
      },
    ],
    warnings: ["Sampled recognition is incomplete."],
    matches: [
      {
        offsetSeconds: 10,
        matches: [
          {
            startSeconds: 10,
            endSeconds: 22,
            scanSeconds: 10,
            artist: "Artist",
            title: "Track",
            confidence: 98,
            provider: "audd",
          },
        ],
      },
    ],
  };
}

function cloneManifest(): SetManifest {
  return structuredClone(createManifest(tracklist()));
}

function expectInvalid(value: unknown, path: string): void {
  try {
    parseManifest(value);
    throw new Error("Expected parseManifest to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(TracksError);
    expect(error).toMatchObject({ code: "INVALID_SOURCE", exitCode: 2 });
    expect((error as Error).message).toContain(path);
  }
}

describe("pipeline manifests", () => {
  test("creates the canonical nested v1 pipeline handoff", () => {
    expect(createManifest(tracklist())).toEqual({
      schemaVersion: 1,
      kind: MANIFEST_KIND,
      source: {
        input: "https://www.youtube.com/watch?v=set",
        id: "set",
        url: "https://www.youtube.com/watch?v=set",
        title: "Sunset Set",
        uploader: "DJ Example",
        date: "2026-07-11",
        lineup: ["DJ Example"],
        durationSeconds: 600,
      },
      tracklist: {
        provider: "audd",
        complete: false,
        sampledEverySeconds: 60,
        matches: [
          {
            offsetSeconds: 10,
            matches: [
              {
                startSeconds: 10,
                endSeconds: 22,
                scanSeconds: 10,
                artist: "Artist",
                title: "Track",
                confidence: 98,
                provider: "audd",
              },
            ],
          },
        ],
      },
      entries: [
        {
          id: "track-001",
          order: 1,
          cue: { timestamp: "00:00:10", startSeconds: 10, endSeconds: 210 },
          identity: {
            status: "identified",
            artist: "Artist",
            title: "Track",
            mix: "Club Mix",
            album: "Album",
            label: "Label",
            releaseDate: "2026-01-02",
            isrc: "USAAA2600001",
            upc: "123456789012",
            songLink: "https://example.com/track",
            confidence: 98,
            overlaps: [{ artist: "Guest", title: "Acapella", confidence: 75 }],
            searchQuery: "Artist - Track (Club Mix)",
          },
          spotify: { status: "pending", query: "Artist - Track (Club Mix)" },
          acquisition: { status: "pending", query: "Artist - Track (Club Mix)" },
          rekordbox: { status: "pending" },
          warnings: [],
          errors: [],
        },
        {
          id: "track-002",
          order: 2,
          cue: { timestamp: "00:03:30", startSeconds: 210 },
          identity: {
            status: "unidentified",
            isId: true,
            artist: "ID",
            title: "ID",
          },
          spotify: { status: "pending" },
          acquisition: { status: "pending" },
          rekordbox: { status: "pending" },
          warnings: [],
          errors: [],
        },
      ],
      warnings: ["Sampled recognition is incomplete."],
      errors: [],
      artifacts: {},
    });
  });

  test("accepts a provider URL separately from the source-media URL", () => {
    const manifest = cloneManifest();
    manifest.tracklist.url = "https://www.1001tracklists.com/tracklist/example.html";

    expect(parseManifest(manifest).tracklist.url).toBe(manifest.tracklist.url);
  });

  test("maps a 1001Tracklists page separately from its source set", () => {
    const manifest = createManifest({
      ...tracklist(),
      source: "https://soundcloud.com/dj/example-set",
      provider: "1001tracklists",
      url: "https://www.1001tracklists.com/tracklist/example.html",
    });

    expect(manifest.source.url).toBe("https://soundcloud.com/dj/example-set");
    expect(manifest.tracklist.url).toBe("https://www.1001tracklists.com/tracklist/example.html");
  });

  test("does not mislabel a directly requested 1001Tracklists page as source media", () => {
    const page = "https://www.1001tracklists.com/tracklist/example.html";
    const manifest = createManifest({
      ...tracklist(),
      source: page,
      provider: "1001tracklists",
      url: page,
    });

    expect(manifest.source).not.toHaveProperty("url");
    expect(manifest.tracklist.url).toBe(page);
  });

  test("rejects a Rekordbox playlist artifact until every entry is imported", () => {
    const manifest = cloneManifest();
    manifest.artifacts.rekordbox = {
      target: "rekordbox-db",
      dbPath: "/rekordbox/master.db",
      folderName: "DJ Sets I Like",
      folderId: "folder-1",
      playlistName: "Set [tracks-ts]",
      playlistId: "playlist-1",
      backupDirectory: "/backups/one",
    };

    expectInvalid(manifest, "$.entries[0].rekordbox.status");
  });

  test("round-trips JSON and accepts completed pipeline states", () => {
    const manifest = cloneManifest();
    const spotifyCandidate = {
      score: 0.99,
      id: "spotify-id",
      uri: "spotify:track:spotify-id",
      url: "https://open.spotify.com/track/spotify-id",
      name: "Track",
      artists: ["Artist"],
      album: "Album",
      releaseDate: "2026-01-02",
      durationMs: 200_000,
      explicit: false,
      isrc: "USAAA2600001",
    };
    manifest.entries[0]!.spotify = {
      status: "matched",
      query: "Artist - Track (Club Mix)",
      ...spotifyCandidate,
      candidates: [spotifyCandidate],
    };
    const candidate = {
      backend: "ytdlp" as const,
      id: "youtube-id",
      source: "https://www.youtube.com/watch?v=track",
      title: "Artist - Track",
      artist: "Artist",
      durationSeconds: 200,
      score: 0.95,
    };
    manifest.entries[0]!.acquisition = {
      status: "downloaded",
      query: "Artist - Track (Club Mix)",
      candidates: [candidate],
      selected: candidate,
      download: {
        backend: "ytdlp",
        mediaPath: "/music/Artist - Track.m4a",
        files: ["/music/Artist - Track.m4a"],
        source: candidate.source,
        engine: "reference",
        sha256: "a".repeat(64),
      },
    };
    manifest.entries[0]!.rekordbox = {
      status: "exported",
      target: "rekordbox-xml",
      artifact: "/music/playlist.xml",
      xmlTrackId: 1,
    };
    manifest.entries[1]!.spotify = { status: "skipped", reason: "Unidentified track" };
    manifest.entries[1]!.acquisition = { status: "skipped", reason: "Unidentified track" };
    manifest.entries[1]!.rekordbox = { status: "skipped", reason: "No audio file" };
    manifest.artifacts = {
      root: "/music",
      manifest: "/music/manifest.json",
      downloadDirectory: "/music/tracks",
      m3u8: "/music/playlist.m3u8",
      rekordboxXml: "/music/playlist.xml",
    };
    manifest.errors.push({
      stage: "identity",
      code: "UNIDENTIFIED",
      message: "One track remains unidentified",
      retryable: false,
    });

    const json = JSON.parse(JSON.stringify(manifest)) as unknown;
    expect(parseManifest(json)).toEqual(manifest);
  });

  test("accepts source clips, alternative downloads, and multiple Rekordbox rows", () => {
    const manifest = cloneManifest();
    manifest.entries[0]!.acquisition = {
      status: "downloaded",
      download: {
        backend: "ytdlp",
        kind: "source-set-clip",
        mediaPath: "/music/clip.mp3",
        files: ["/music/clip.mp3"],
        source: "https://soundcloud.com/dj/set",
        sha256: "a".repeat(64),
        clip: {
          sourceSetUrl: "https://soundcloud.com/dj/set",
          sourceSetTitle: "DJ Set",
          startSeconds: 120,
          endSeconds: 300,
          containsTransitions: true,
          qualityNote: "Lossy set recording; transitions may be present",
        },
      },
      alternatives: [
        {
          backend: "ytdlp",
          kind: "individual",
          mediaPath: "/music/alternative.m4a",
          files: ["/music/alternative.m4a"],
          source: "https://www.youtube.com/watch?v=alternative",
          spotifyId: "spotify-alternative",
          isrc: "USAAA2600002",
        },
      ],
    };
    manifest.entries[0]!.rekordbox = {
      status: "imported",
      target: "rekordbox-db",
      dbContentIds: ["content-1", "content-2"],
      playlistMembershipIds: ["membership-1", "membership-2"],
    };

    expect(parseManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });

  test("preserves ambiguous Spotify candidates for manual selection", () => {
    const manifest = cloneManifest();
    manifest.entries[0]!.spotify = {
      status: "ambiguous",
      query: "Artist - Track (Club Mix)",
      candidates: [
        {
          score: 0.86,
          id: "first",
          uri: "spotify:track:first",
          name: "Track",
          artists: ["Artist"],
        },
        {
          score: 0.85,
          id: "second",
          uri: "spotify:track:second",
          name: "Track - Remastered",
          artists: ["Artist"],
        },
      ],
    };
    expect(parseManifest(manifest)).toEqual(manifest);
  });

  test.each([
    [null, "$"],
    [[], "$"],
    [{}, "$.schemaVersion"],
    [{ ...cloneManifest(), schemaVersion: 2 }, "$.schemaVersion"],
    [{ ...cloneManifest(), kind: "dj-set-tracklist" }, "$.kind"],
    [{ ...cloneManifest(), typo: true }, "$.typo"],
    [
      (() => {
        const value = cloneManifest() as unknown as Record<string, unknown>;
        value.source = { input: "set", typo: true };
        return value;
      })(),
      "$.source.typo",
    ],
    [
      (() => {
        const value = cloneManifest();
        value.entries[0]!.cue = { startSeconds: 10, endSeconds: 9 };
        return value;
      })(),
      "$.entries[0].cue.endSeconds",
    ],
    [
      (() => {
        const value = cloneManifest();
        value.entries[0]!.cue.timestamp = "00:00:11";
        return value;
      })(),
      "$.entries[0].cue.timestamp",
    ],
    [
      (() => {
        const value = cloneManifest();
        value.entries[0]!.id = "track-999";
        return value;
      })(),
      "$.entries[0].id",
    ],
    [
      (() => {
        const value = cloneManifest();
        (value.entries[0]!.identity as { searchQuery: string }).searchQuery = "wrong";
        return value;
      })(),
      "$.entries[0].identity.searchQuery",
    ],
    [
      (() => {
        const value = cloneManifest();
        value.entries[0]!.spotify = {
          status: "matched",
          query: "Artist - Track",
          score: 2,
          id: "id",
          uri: "spotify:track:id",
        };
        return value;
      })(),
      "$.entries[0].spotify.score",
    ],
    [
      (() => {
        const value = cloneManifest();
        value.entries[0]!.spotify = {
          status: "ambiguous",
          query: "Artist - Track",
          candidates: [],
        };
        return value;
      })(),
      "$.entries[0].spotify.candidates",
    ],
    [
      (() => {
        const value = cloneManifest();
        value.entries[0]!.acquisition = {
          status: "downloaded",
          download: {
            backend: "slsk",
            mediaPath: "/music/track.flac",
            files: ["/music/other.flac"],
          },
        };
        return value;
      })(),
      "$.entries[0].acquisition.download.files",
    ],
    [
      (() => {
        const value = cloneManifest();
        value.entries[0]!.acquisition = {
          status: "downloaded",
          download: {
            backend: "slsk",
            mediaPath: "music/track.flac",
            files: ["music/track.flac"],
          },
        };
        return value;
      })(),
      "$.entries[0].acquisition.download.mediaPath",
    ],
    [
      (() => {
        const value = cloneManifest() as unknown as { artifacts: Record<string, unknown> };
        value.artifacts.typo = "/tmp/file";
        return value;
      })(),
      "$.artifacts.typo",
    ],
    [
      (() => {
        const value = cloneManifest();
        const selected = {
          backend: "ytdlp" as const,
          id: "video-id",
          source: "https://www.youtube.com/watch?v=video-id",
          title: "Artist - Track",
        };
        value.entries[0]!.acquisition = {
          status: "selected",
          query: "Artist - Track",
          candidates: [],
          selected,
        };
        return value;
      })(),
      "$.entries[0].acquisition.candidates",
    ],
    [
      (() => {
        const value = cloneManifest();
        const selected = {
          backend: "ytdlp" as const,
          id: "selected-id",
          source: "https://www.youtube.com/watch?v=selected",
          title: "Artist - Track",
        };
        value.entries[0]!.acquisition = {
          status: "selected",
          query: "Artist - Track",
          candidates: [{ ...selected, id: "other-id" }],
          selected,
        };
        return value;
      })(),
      "$.entries[0].acquisition.selected",
    ],
    [
      (() => {
        const value = cloneManifest();
        const selected = {
          backend: "ytdlp" as const,
          id: "video-id",
          source: "https://www.youtube.com/watch?v=video-id",
          title: "Artist - Track",
        };
        value.entries[0]!.acquisition = {
          status: "downloaded",
          selected,
          download: {
            backend: "slsk",
            mediaPath: "/music/track.flac",
            files: ["/music/track.flac"],
          },
        };
        return value;
      })(),
      "$.entries[0].acquisition.download.backend",
    ],
    [
      (() => {
        const value = cloneManifest();
        value.entries[0]!.rekordbox = {
          status: "exported",
          target: "rekordbox-xml",
        };
        return value;
      })(),
      "$.entries[0].rekordbox",
    ],
  ])("strictly rejects malformed manifests at %s", (value, path) => {
    expectInvalid(value, path as string);
  });

  test("rejects duplicate orders and invalid runtime tracklists", () => {
    const duplicate = cloneManifest();
    duplicate.entries[1]!.order = 1;
    duplicate.entries[1]!.id = "track-001";
    expectInvalid(duplicate, "$.entries[1].id");

    const unsorted = cloneManifest();
    unsorted.entries.reverse();
    expectInvalid(unsorted, "$.entries[1].order");

    const invalidTracklist = tracklist();
    invalidTracklist.tracks[0]!.order = 0;
    expect(() => createManifest(invalidTracklist)).toThrowError(TracksError);
  });
});

describe("trackSearchQuery", () => {
  test.each<[TracklistEntry, string | undefined]>([
    [{ order: 1, artist: "Artist", title: "Title" }, "Artist - Title"],
    [{ order: 1, artist: "Artist", title: "Title", mix: "Remix" }, "Artist - Title (Remix)"],
    [{ order: 1, artist: "ID", title: "ID" }, undefined],
    [{ order: 1, artist: "?", title: "Title" }, undefined],
    [{ order: 1, artist: "Artist", title: "Unknown" }, undefined],
    [{ order: 1, artist: "Artist", title: "ID Remix" }, "Artist - ID Remix"],
    [{ order: 1, isId: true, artist: "Artist", title: "Title" }, undefined],
    [{ order: 1, artist: "Artist" }, undefined],
    [{ order: 1, artist: "  Artist ", title: " Title ", mix: " Remix " }, "Artist - Title (Remix)"],
    [{ order: 1, artist: " ID ", title: "Title" }, undefined],
  ])("builds a provider-neutral search query", (track, expected) => {
    expect(trackSearchQuery(track)).toBe(expected);
  });
});
