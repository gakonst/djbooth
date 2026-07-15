import { describe, expect, it, vi } from "vitest";

import { hostedPlaylistId } from "../src/server/hosted/ids.js";
import { SpotifyHostedPlaylistAdapter } from "../src/server/hosted/spotify.js";
import { HostedPlaylistConflictError } from "../src/server/hosted/types.js";

describe("SpotifyHostedPlaylistAdapter", () => {
  it("paginates the current library and exposes followed playlists as read-only", async () => {
    const client = new FakeSpotifyClient([
      spotifyPlaylist("owned", "Owned", "me", false, 2),
      spotifyPlaylist("shared", "Shared", "someone", true, 1),
      spotifyPlaylist("followed", "Followed", "someone", false, 9),
    ]);
    client.playlistPageSize = 2;
    const adapter = new SpotifyHostedPlaylistAdapter(client);

    const result = await adapter.listPlaylists();

    expect(result.displayName).toBe("Test User");
    expect(result.items).toHaveLength(3);
    expect(result.items.map((item) => item.id)).toEqual([
      hostedPlaylistId("spotify", "owned"),
      hostedPlaylistId("spotify", "shared"),
      hostedPlaylistId("spotify", "followed"),
    ]);
    expect(result.items[0]?.hosted).toMatchObject({
      owned: true,
      capabilities: { itemsReadable: true, detailsEditable: true, itemsEditable: true },
    });
    expect(result.items[1]?.hosted).toMatchObject({
      owned: false,
      capabilities: { itemsReadable: true, detailsEditable: false, itemsEditable: true },
    });
    expect(result.items[2]?.hosted).toMatchObject({
      owned: false,
      capabilities: { itemsReadable: true, detailsEditable: false, itemsEditable: false },
    });
    expect(client.rawCalls.filter((call) => call.path.includes("/me/playlists"))).toHaveLength(2);
  });

  it("paginates items, preserves duplicates, and skips null tracks and episodes", async () => {
    const client = new FakeSpotifyClient([spotifyPlaylist("owned", "Owned", "me", false, 4)]);
    client.trackPages.set("owned", [
      [
        spotifyItem("same"),
        { item: null },
        { item: { type: "episode", uri: "spotify:episode:e" } },
      ],
      [spotifyItem("same")],
    ]);
    const adapter = new SpotifyHostedPlaylistAdapter(client);

    const tracks = await adapter.getTracks("owned");

    expect(tracks).toHaveLength(2);
    expect(tracks.map((track) => track.hosted?.remoteId)).toEqual([
      "spotify:track:same",
      "spotify:track:same",
    ]);
    expect(tracks.map((track) => track.trackNumber)).toEqual([1, 4]);
    expect(new Set(tracks.map((track) => track.playlistMembershipId)).size).toBe(2);
    expect(tracks[0]?.hosted).toMatchObject({
      isrc: "US-ABC-26-00001",
      releaseDate: "2026-07-14",
      albumArtists: ["Album Artist"],
      explicit: false,
    });
    expect(client.rawCalls.filter((call) => call.path.includes("/items"))).toHaveLength(2);
  });

  it("preflights revisions and verifies rename, ordered replacement, creation, and removal", async () => {
    const client = new FakeSpotifyClient([spotifyPlaylist("owned", "Owned", "me", false, 1)]);
    client.trackPages.set("owned", [[spotifyItem("one")]]);
    const adapter = new SpotifyHostedPlaylistAdapter(client);
    const listed = await adapter.listPlaylists();
    const initialRevision = listed.items[0]!.hosted!.revision;

    client.playlists.get("owned")!.snapshot_id = "remote-change";
    await expect(
      adapter.renamePlaylist("owned", "Conflict", initialRevision),
    ).rejects.toBeInstanceOf(HostedPlaylistConflictError);
    expect(client.updatePlaylist).not.toHaveBeenCalled();

    const current = await adapter.listPlaylists();
    const renamed = await adapter.renamePlaylist(
      "owned",
      "Renamed",
      current.items[0]!.hosted!.revision,
    );
    expect(renamed.name).toBe("Renamed");

    client.trackPages.set("owned", [[spotifyItem("one")]]);
    const replaced = await adapter.replacePlaylistTracks(
      "owned",
      ["spotify:track:two", "spotify:track:two", "three"],
      renamed.hosted!.revision,
    );
    expect(replaced.trackCount).toBe(3);
    expect(client.updatePlaylist).toHaveBeenLastCalledWith("owned", {
      tracks: ["spotify:track:two", "spotify:track:two", "spotify:track:three"],
    });

    const created = await adapter.createPlaylist("New list");
    expect(created).toMatchObject({ name: "New list", hosted: { owned: true } });

    await adapter.deletePlaylist("owned", replaced.hosted!.revision);
    expect(client.playlists.has("owned")).toBe(false);
  });

  it("reads followed playlists while refusing writes", async () => {
    const client = new FakeSpotifyClient([
      spotifyPlaylist("followed", "Followed", "someone", false, 1),
    ]);
    const adapter = new SpotifyHostedPlaylistAdapter(client);
    const listed = await adapter.listPlaylists();

    client.trackPages.set("followed", [[spotifyItem("one")]]);
    await expect(adapter.getTracks("followed")).resolves.toHaveLength(1);
    await expect(
      adapter.renamePlaylist("followed", "No", listed.items[0]!.hosted!.revision),
    ).rejects.toThrow(/not owned by the current user/u);
  });

  it("allows collaborative item edits but reserves playlist details for the owner", async () => {
    const client = new FakeSpotifyClient([spotifyPlaylist("shared", "Shared", "someone", true, 1)]);
    client.trackPages.set("shared", [[spotifyItem("one")]]);
    const adapter = new SpotifyHostedPlaylistAdapter(client);
    const listed = await adapter.listPlaylists();
    const revision = listed.items[0]!.hosted!.revision;

    await expect(adapter.getTracks("shared")).resolves.toHaveLength(1);
    await expect(
      adapter.replacePlaylistTracks("shared", ["spotify:track:two"], revision),
    ).resolves.toMatchObject({ trackCount: 1 });
    await expect(adapter.renamePlaylist("shared", "No", revision)).rejects.toThrow(
      /not owned by the current user/u,
    );
  });
});

class FakeSpotifyClient {
  readonly playlists = new Map<string, Record<string, unknown>>();
  readonly trackPages = new Map<string, unknown[][]>();
  readonly rawCalls: Array<{ method: string; path: string; options: unknown }> = [];
  playlistPageSize = 50;
  #created = 0;

  constructor(playlists: Record<string, unknown>[]) {
    for (const playlist of playlists) this.playlists.set(String(playlist.id), playlist);
  }

  readonly updatePlaylist = vi.fn(
    async (reference: string, options: { name?: string; tracks?: readonly string[] }) => {
      const playlist = this.requirePlaylist(reference);
      if (options.name !== undefined) playlist.name = options.name;
      if (options.tracks !== undefined) {
        this.trackPages.set(reference, [
          options.tracks.map((uri) => spotifyItem(uri.split(":").at(-1)!)),
        ]);
        playlist.snapshot_id = `snapshot-${Date.now()}-${options.tracks.length}`;
        playlist.items = { total: options.tracks.length };
      }
      return { playlistId: reference, snapshotIds: [String(playlist.snapshot_id)] };
    },
  );

  readonly deletePlaylist = vi.fn(async (reference: string) => {
    this.requirePlaylist(reference);
    this.playlists.delete(reference);
    this.trackPages.delete(reference);
    return { playlistId: reference, removedFromLibrary: true, permanentlyDeleted: false };
  });

  async getPlaylist(reference: string): Promise<Record<string, unknown>> {
    return structuredClone(this.requirePlaylist(reference));
  }

  async raw<T = unknown>(method: string, path: string, options?: unknown): Promise<T | undefined> {
    this.rawCalls.push({ method, path, options });
    if (method === "GET" && path === "/me") {
      return { id: "me", account_id: "stable-me", display_name: "Test User" } as T;
    }
    if (method === "GET" && path.includes("/me/playlists")) {
      const url = new URL(path, "https://api.spotify.test");
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const all = [...this.playlists.values()].map((playlist) => structuredClone(playlist));
      const items = all.slice(offset, offset + this.playlistPageSize);
      const nextOffset = offset + items.length;
      return {
        items,
        next:
          nextOffset < all.length
            ? `https://api.spotify.test/v1/me/playlists?offset=${nextOffset}`
            : null,
      } as T;
    }
    const itemMatch = /\/playlists\/([^/]+)\/items/u.exec(
      new URL(path, "https://api.spotify.test").pathname,
    );
    if (method === "GET" && itemMatch) {
      const playlistId = decodeURIComponent(itemMatch[1]!);
      const url = new URL(path, "https://api.spotify.test");
      const page = Number(url.searchParams.get("page") ?? 0);
      const pages = this.trackPages.get(playlistId) ?? [];
      return {
        items: structuredClone(pages[page] ?? []),
        next:
          page + 1 < pages.length
            ? `https://api.spotify.test/v1/playlists/${playlistId}/items?page=${page + 1}`
            : null,
      } as T;
    }
    if (method === "POST" && path === "/me/playlists") {
      const body = (options as { body: { name: string } }).body;
      const id = `created${++this.#created}`;
      const playlist = spotifyPlaylist(id, body.name, "me", false, 0);
      this.playlists.set(id, playlist);
      this.trackPages.set(id, [[]]);
      return structuredClone(playlist) as T;
    }
    throw new Error(`Unhandled fake Spotify request: ${method} ${path}`);
  }

  private requirePlaylist(reference: string): Record<string, unknown> {
    const playlist = this.playlists.get(reference);
    if (!playlist) throw Object.assign(new Error("not found"), { status: 404 });
    return playlist;
  }
}

function spotifyPlaylist(
  id: string,
  name: string,
  owner: string,
  collaborative: boolean,
  count: number,
): Record<string, unknown> {
  return {
    id,
    name,
    owner: { id: owner },
    collaborative,
    public: false,
    snapshot_id: `snapshot-${id}`,
    items: { total: count },
    external_urls: { spotify: `https://open.spotify.com/playlist/${id}` },
  };
}

function spotifyItem(id: string): Record<string, unknown> {
  return {
    item: {
      id,
      uri: `spotify:track:${id}`,
      type: "track",
      name: `Track ${id}`,
      artists: [{ name: "Artist" }],
      album: {
        name: "Album",
        artists: [{ name: "Album Artist" }],
        release_date: "2026-07-14",
        images: [{ url: "https://image.test/cover.jpg" }],
      },
      external_ids: { isrc: "US-ABC-26-00001" },
      explicit: false,
      duration_ms: 180_000,
      external_urls: { spotify: `https://open.spotify.com/track/${id}` },
    },
  };
}
