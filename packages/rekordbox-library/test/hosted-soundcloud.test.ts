import { describe, expect, it, vi } from "vitest";

import { hostedPlaylistId } from "../src/server/hosted/ids.js";
import { SoundCloudHostedPlaylistAdapter } from "../src/server/hosted/soundcloud.js";
import { HostedPlaylistConflictError } from "../src/server/hosted/types.js";

describe("SoundCloudHostedPlaylistAdapter", () => {
  it("paginates owned and liked playlists, prefers URNs, and marks liked lists read-only", async () => {
    const owned = soundCloudPlaylist("soundcloud:playlists:1", "Owned", "soundcloud:users:me", 2);
    const ownedNext = soundCloudPlaylist(
      "soundcloud:playlists:3",
      "Owned next page",
      "soundcloud:users:me",
      4,
    );
    const liked = soundCloudPlaylist(
      "soundcloud:playlists:2",
      "Liked",
      "soundcloud:users:other",
      3,
    );
    const client = new FakeSoundCloudClient([owned, ownedNext, liked]);
    client.ownedPlaylistUrns = ["soundcloud:playlists:1", "soundcloud:playlists:3"];
    client.likedPlaylistUrns = ["soundcloud:playlists:2"];
    client.pageSize = 1;
    const adapter = new SoundCloudHostedPlaylistAdapter(client);

    const result = await adapter.listPlaylists();

    expect(result.displayName).toBe("GAK");
    expect(result.items.map((item) => item.id)).toEqual([
      hostedPlaylistId("soundcloud", "soundcloud:playlists:1"),
      hostedPlaylistId("soundcloud", "soundcloud:playlists:3"),
      hostedPlaylistId("soundcloud", "soundcloud:playlists:2"),
    ]);
    expect(result.items[0]?.hosted).toMatchObject({
      remoteId: "soundcloud:playlists:1",
      owned: true,
      capabilities: { itemsReadable: true, detailsEditable: true, itemsEditable: true },
    });
    expect(result.items[2]?.hosted).toMatchObject({
      owned: false,
      capabilities: { itemsReadable: true, detailsEditable: false, itemsEditable: false },
    });
    expect(client.rawCalls.filter((call) => call.path.includes("/me/playlists"))).toHaveLength(2);
  });

  it("reads playlist tracks through the tracks endpoint and preserves duplicates", async () => {
    const playlist = soundCloudPlaylist(
      "soundcloud:playlists:1",
      "Owned",
      "soundcloud:users:me",
      3,
    );
    const client = new FakeSoundCloudClient([playlist]);
    client.ownedPlaylistUrns = [playlist.urn as string];
    client.trackPages.set(playlist.urn as string, [
      [soundCloudTrack("soundcloud:tracks:8")],
      [soundCloudTrack("soundcloud:tracks:8"), { title: "Missing identity" }],
    ]);
    const adapter = new SoundCloudHostedPlaylistAdapter(client);

    const tracks = await adapter.getTracks(playlist.urn as string);

    expect(tracks.map((track) => track.hosted?.remoteId)).toEqual([
      "soundcloud:tracks:8",
      "soundcloud:tracks:8",
    ]);
    expect(tracks.map((track) => track.trackNumber)).toEqual([1, 2]);
    expect(new Set(tracks.map((track) => track.playlistMembershipId)).size).toBe(2);
    const trackCalls = client.rawCalls.filter((call) =>
      call.path.includes("soundcloud:playlists:1/tracks"),
    );
    expect(trackCalls).toHaveLength(2);
    expect(trackCalls[0]?.path).toContain("secret_token=secret");
    const revision = (await adapter.listPlaylists()).items[0]!.hosted!.revision;
    await expect(
      adapter.replacePlaylistTracks(playlist.urn as string, ["soundcloud:tracks:8"], revision),
    ).rejects.toThrow(/unavailable items/u);
    expect(client.updatePlaylist).not.toHaveBeenCalled();
  });

  it("exposes the playback transport for playable and preview tracks", async () => {
    const urn = "soundcloud:playlists:1";
    const playlist = soundCloudPlaylist(urn, "Owned", "soundcloud:users:me", 3);
    const playable = {
      ...soundCloudTrack("soundcloud:tracks:1"),
      access: "playable",
      streamable: true,
    };
    const preview = {
      ...soundCloudTrack("soundcloud:tracks:2"),
      access: "preview",
      streamable: true,
    };
    const unavailable = {
      ...soundCloudTrack("soundcloud:tracks:3"),
      access: "playable",
      streamable: false,
    };
    const client = new FakeSoundCloudClient([playlist]);
    client.trackPages.set(urn, [[playable, preview, unavailable]]);
    const adapter = new SoundCloudHostedPlaylistAdapter(client);

    const tracks = await adapter.getTracks(urn);

    expect(tracks.map((track) => track.hosted?.streamKind)).toEqual([
      "hls",
      "progressive",
      undefined,
    ]);
  });

  it("resolves the current authenticated AAC HLS stream without requesting media in tests", async () => {
    const urn = "soundcloud:playlists:1";
    const playlist = soundCloudPlaylist(urn, "Owned", "soundcloud:users:me", 1);
    const remoteTrack = soundCloudTrack("soundcloud:tracks:8");
    remoteTrack.secret_token = "private-track-token";
    const client = new FakeSoundCloudClient([playlist]);
    client.trackPages.set(urn, [[remoteTrack]]);
    const fetchMedia = vi.fn<typeof globalThis.fetch>();
    const adapter = new SoundCloudHostedPlaylistAdapter(client, { fetchMedia });

    await adapter.getTracks(urn);
    const stream = await adapter.streamTrack("soundcloud:tracks:8", {
      range: "bytes=10-19",
    });

    expect(stream.kind).toBe("hls");
    expect(stream.response.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
    expect(client.rawCalls.at(-1)).toMatchObject({
      method: "GET",
      path: "/tracks/soundcloud:tracks:8/streams",
      options: { query: { secret_token: "private-track-token" } },
    });
    expect(fetchMedia).not.toHaveBeenCalled();
    expect(client.fetch).toHaveBeenCalledOnce();
    expect(client.fetch.mock.calls[0]![0].url).toMatch(
      /^https:\/\/api\.soundcloud\.com\/tracks\/soundcloud:tracks:8\/streams\//u,
    );
    expect(client.fetch.mock.calls[0]![0].headers.get("range")).toBeNull();
  });

  it("forwards byte ranges to full and preview progressive streams", async () => {
    const candidates = [
      ["http_mp3_128_url", "https://cf-media.sndcdn.com/full.mp3"],
      ["preview_mp3_128_url", "https://cf-preview-media.sndcdn.com/preview.mp3"],
    ] as const;

    for (const [field, url] of candidates) {
      const client = new FakeSoundCloudClient([]);
      client.streams = { [field]: url };
      const fetchMedia = vi.fn<typeof globalThis.fetch>();
      fetchMedia.mockResolvedValue(
        new Response("test", {
          status: 206,
          headers: {
            "accept-ranges": "bytes",
            "content-range": "bytes 10-13/100",
          },
        }),
      );
      const adapter = new SoundCloudHostedPlaylistAdapter(client, { fetchMedia });

      const stream = await adapter.streamTrack("soundcloud:tracks:8", {
        range: "bytes=10-13",
      });

      expect(stream.kind).toBe("progressive");
      expect(stream.response.status).toBe(206);
      expect(fetchMedia).toHaveBeenCalledOnce();
      expect(new Request(fetchMedia.mock.calls[0]![0]).headers.get("range")).toBe("bytes=10-13");
    }
  });

  it("preflights revisions and verifies rename, ordered replacement, creation, and deletion", async () => {
    const urn = "soundcloud:playlists:1";
    const playlist = soundCloudPlaylist(urn, "Owned", "soundcloud:users:me", 1);
    const client = new FakeSoundCloudClient([playlist]);
    client.ownedPlaylistUrns = [urn];
    client.trackPages.set(urn, [[soundCloudTrack("soundcloud:tracks:1")]]);
    const adapter = new SoundCloudHostedPlaylistAdapter(client, { includeLikedPlaylists: false });
    const listed = await adapter.listPlaylists();
    const firstRevision = listed.items[0]!.hosted!.revision;

    client.playlists.get(urn)!.last_modified = "2026-07-14T13:00:00Z";
    await expect(adapter.renamePlaylist(urn, "Conflict", firstRevision)).rejects.toBeInstanceOf(
      HostedPlaylistConflictError,
    );
    expect(client.updatePlaylist).not.toHaveBeenCalled();

    const current = await adapter.listPlaylists();
    const renamed = await adapter.renamePlaylist(
      urn,
      "Renamed",
      current.items[0]!.hosted!.revision,
    );
    expect(renamed.name).toBe("Renamed");

    const replaced = await adapter.replacePlaylistTracks(
      urn,
      ["soundcloud:tracks:4", "4", "soundcloud:tracks:5"],
      renamed.hosted!.revision,
    );
    expect(replaced.trackCount).toBe(3);
    expect(client.updatePlaylist).toHaveBeenLastCalledWith(urn, {
      tracks: ["soundcloud:tracks:4", "soundcloud:tracks:4", "soundcloud:tracks:5"],
    });

    const created = await adapter.createPlaylist("New list");
    expect(created).toMatchObject({ name: "New list", hosted: { owned: true } });

    await adapter.deletePlaylist(urn, replaced.hosted!.revision);
    expect(client.playlists.has(urn)).toBe(false);
  });

  it("refuses writes to liked playlists owned by another account", async () => {
    const playlist = soundCloudPlaylist(
      "soundcloud:playlists:2",
      "Liked",
      "soundcloud:users:other",
      1,
    );
    const client = new FakeSoundCloudClient([playlist]);
    client.likedPlaylistUrns = [playlist.urn as string];
    const adapter = new SoundCloudHostedPlaylistAdapter(client);
    const listed = await adapter.listPlaylists();

    await expect(
      adapter.renamePlaylist(playlist.urn as string, "No", listed.items[0]!.hosted!.revision),
    ).rejects.toThrow(/not owned/u);
  });
});

class FakeSoundCloudClient {
  readonly playlists = new Map<string, Record<string, unknown>>();
  readonly trackPages = new Map<string, Record<string, unknown>[][]>();
  readonly rawCalls: Array<{ method: string; path: string; options: unknown }> = [];
  ownedPlaylistUrns: string[] = [];
  likedPlaylistUrns: string[] = [];
  pageSize = 200;
  streams: Record<string, unknown> = {
    hls_aac_160_url:
      "https://api.soundcloud.com/tracks/soundcloud:tracks:8/streams/stream-id/hls-aac-160.m3u8",
  };
  #created = 20;
  #modified = 0;

  readonly fetch = vi.fn(
    async (_request: Request) =>
      new Response("#EXTM3U\n#EXT-X-ENDLIST\n", {
        headers: { "content-type": "application/vnd.apple.mpegurl" },
      }),
  );

  constructor(playlists: Record<string, unknown>[]) {
    for (const playlist of playlists) this.playlists.set(String(playlist.urn), playlist);
  }

  readonly updatePlaylist = vi.fn(
    async (reference: string, input: { title?: string; tracks?: readonly string[] }) => {
      const playlist = this.requirePlaylist(reference);
      if (input.title !== undefined) playlist.title = input.title;
      if (input.tracks !== undefined) {
        this.trackPages.set(reference, [input.tracks.map(soundCloudTrack)]);
        playlist.track_count = input.tracks.length;
      }
      playlist.last_modified = `2026-07-14T14:${String(++this.#modified).padStart(2, "0")}:00Z`;
      return structuredClone(playlist);
    },
  );

  readonly deletePlaylist = vi.fn(async (reference: string) => {
    this.requirePlaylist(reference);
    this.playlists.delete(reference);
    this.trackPages.delete(reference);
    this.ownedPlaylistUrns = this.ownedPlaylistUrns.filter((urn) => urn !== reference);
    return { playlistUrn: reference, deleted: true };
  });

  async getPlaylist(reference: string): Promise<Record<string, unknown>> {
    return structuredClone(this.requirePlaylist(reference));
  }

  async raw<T = unknown>(method: string, path: string, options?: unknown): Promise<T | undefined> {
    this.rawCalls.push({ method, path, options });
    if (method === "GET" && path === "/me") {
      return { urn: "soundcloud:users:me", username: "GAK" } as T;
    }
    if (method === "GET" && /^\/tracks\/soundcloud:tracks:[^/]+\/streams$/u.test(path)) {
      return structuredClone(this.streams) as T;
    }
    const url = new URL(path, "https://api.soundcloud.test");
    if (method === "GET" && url.pathname.endsWith("/me/playlists")) {
      return this.page(this.ownedPlaylistUrns, url) as T;
    }
    if (method === "GET" && url.pathname.endsWith("/me/likes/playlists")) {
      return this.page(this.likedPlaylistUrns, url) as T;
    }
    const trackMatch = /\/playlists\/(soundcloud:playlists:[^/]+)\/tracks$/u.exec(url.pathname);
    if (method === "GET" && trackMatch) {
      const urn = trackMatch[1]!;
      const page = Number(url.searchParams.get("page") ?? 0);
      const pages = this.trackPages.get(urn) ?? [];
      return {
        collection: structuredClone(pages[page] ?? []),
        next_href:
          page + 1 < pages.length
            ? `https://api.soundcloud.test/playlists/${urn}/tracks?page=${page + 1}`
            : null,
      } as T;
    }
    if (method === "POST" && path === "/playlists") {
      const title = (options as { body: { playlist: { title: string } } }).body.playlist.title;
      const urn = `soundcloud:playlists:${++this.#created}`;
      const playlist = soundCloudPlaylist(urn, title, "soundcloud:users:me", 0);
      this.playlists.set(urn, playlist);
      this.ownedPlaylistUrns.push(urn);
      this.trackPages.set(urn, [[]]);
      return structuredClone(playlist) as T;
    }
    throw new Error(`Unhandled fake SoundCloud request: ${method} ${path}`);
  }

  private page(urns: string[], url: URL): Record<string, unknown> {
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const selected = urns.slice(offset, offset + this.pageSize);
    const nextOffset = offset + selected.length;
    return {
      collection: selected.map((urn) => structuredClone(this.requirePlaylist(urn))),
      next_href:
        nextOffset < urns.length ? `${url.origin}${url.pathname}?offset=${nextOffset}` : null,
    };
  }

  private requirePlaylist(reference: string): Record<string, unknown> {
    const playlist = this.playlists.get(reference);
    if (!playlist) throw Object.assign(new Error("not found"), { status: 404 });
    return playlist;
  }
}

function soundCloudPlaylist(
  urn: string,
  title: string,
  ownerUrn: string,
  count: number,
): Record<string, unknown> {
  return {
    urn,
    title,
    user_urn: ownerUrn,
    user: { urn: ownerUrn, username: ownerUrn.endsWith(":me") ? "GAK" : "Other" },
    track_count: count,
    tracks_uri: `https://api.soundcloud.test/playlists/${urn}/tracks?secret_token=secret`,
    last_modified: "2026-07-14T12:00:00Z",
    sharing: "private",
    permalink_url: `https://soundcloud.com/test/sets/${urn.split(":").at(-1)}`,
  };
}

function soundCloudTrack(urn: string): Record<string, unknown> {
  return {
    urn,
    title: `Track ${urn.split(":").at(-1)}`,
    metadata_artist: "Artist",
    genre: "House",
    bpm: 124,
    duration: 240_000,
    playback_count: 10,
    artwork_url: "https://image.test/cover.jpg",
    permalink_url: `https://soundcloud.com/test/${urn.split(":").at(-1)}`,
  };
}
