import { describe, expect, it, vi } from "vitest";

import { HostedPlaylistCatalog } from "../src/server/hosted/catalog.js";
import { hostedPlaylistId, parseHostedPlaylistId } from "../src/server/hosted/ids.js";
import type {
  HostedPlaylistProviderAdapter,
  HostedPlaylistStateReaderWriter,
} from "../src/server/hosted/types.js";
import type { HostedPlaylistProvider, PlaylistItem, TrackSummary } from "../src/shared/types.js";

describe("HostedPlaylistCatalog", () => {
  it("isolates disconnected providers and decorates provider data from local state", async () => {
    const spotify = adapter("spotify");
    const soundcloud = adapter("soundcloud");
    soundcloud.listPlaylists = vi.fn(async () => {
      throw new Error("SoundCloud login required");
    });
    const state = {
      ...stateStore(),
      listPlaylists: vi.fn<NonNullable<HostedPlaylistStateReaderWriter["listPlaylists"]>>(() => [
        {
          provider: "spotify",
          remoteId: "list1",
          downloadEnabled: true,
          revision: "stored",
          syncState: "syncing",
          syncError: null,
        },
      ]),
      listTracks: vi.fn<NonNullable<HostedPlaylistStateReaderWriter["listTracks"]>>(() => [
        {
          provider: "spotify",
          remoteTrackId: "spotify:track:one",
          localContentId: "content-1",
          downloadState: "downloaded",
          downloadError: null,
        },
      ]),
    };
    const catalog = new HostedPlaylistCatalog({ adapters: [spotify, soundcloud], state });

    const listed = await catalog.listPlaylists();
    expect(listed.providers).toEqual([
      { provider: "spotify", connected: true, displayName: "spotify-user" },
      { provider: "soundcloud", connected: false, error: "SoundCloud login required" },
    ]);
    expect(listed.items[0]?.hosted).toMatchObject({
      downloadEnabled: true,
      syncState: "syncing",
    });
    expect(state.listPlaylists).toHaveBeenCalledOnce();
    expect(state.getPlaylist).not.toHaveBeenCalled();

    const tracks = await catalog.getTracks(hostedPlaylistId("spotify", "list1"));
    expect(tracks[0]?.hosted).toMatchObject({
      localContentId: "content-1",
      downloadState: "downloaded",
    });
    expect(state.listTracks).toHaveBeenCalledOnce();
    expect(state.getTrack).not.toHaveBeenCalled();

    state.listPlaylists.mockReturnValue([
      {
        provider: "spotify",
        remoteId: "list1",
        downloadEnabled: false,
        revision: "stored",
        syncState: "idle",
        syncError: null,
      },
    ]);
    state.listTracks.mockReturnValue([
      {
        provider: "spotify",
        remoteTrackId: "spotify:track:one",
        localContentId: null,
        downloadState: "remote",
        downloadError: null,
      },
    ]);
    const locallyStaleList = {
      ...listed,
      items: listed.items.map((item) => ({
        ...item,
        hosted: item.hosted ? { ...item.hosted, syncError: "stale" } : undefined,
      })),
    };
    const locallyStaleTracks = tracks.map((track) => ({
      ...track,
      hosted: track.hosted ? { ...track.hosted, downloadError: "stale" } : undefined,
    }));

    const refreshedList = await catalog.refreshPlaylistState(locallyStaleList);
    const refreshedTracks = await catalog.refreshTrackState(
      hostedPlaylistId("spotify", "list1"),
      locallyStaleTracks,
    );
    expect(refreshedList.items[0]?.hosted).toMatchObject({
      downloadEnabled: false,
      syncState: "idle",
    });
    expect(refreshedList.items[0]?.hosted?.syncError).toBeUndefined();
    expect(refreshedTracks[0]?.hosted).toMatchObject({
      localContentId: null,
      downloadState: "remote",
    });
    expect(refreshedTracks[0]?.hosted?.downloadError).toBeUndefined();
    expect(spotify.listPlaylists).toHaveBeenCalledOnce();
    expect(spotify.getTracks).toHaveBeenCalledOnce();
  });

  it("serializes mutations per playlist while allowing other playlists to proceed", async () => {
    const provider = adapter("spotify");
    const releaseFirst = deferred<void>();
    const calls: string[] = [];
    provider.renamePlaylist = vi.fn(async (remoteId, name) => {
      calls.push(`start:${remoteId}:${name}`);
      if (name === "first") await releaseFirst.promise;
      calls.push(`end:${remoteId}:${name}`);
      return playlist("spotify", remoteId, name);
    });
    const catalog = new HostedPlaylistCatalog({ adapters: [provider] });
    const first = catalog.mutate({
      type: "rename-hosted-playlist",
      playlistId: hostedPlaylistId("spotify", "list1"),
      name: "first",
      expectedRevision: "revision",
    });
    const second = catalog.mutate({
      type: "rename-hosted-playlist",
      playlistId: hostedPlaylistId("spotify", "list1"),
      name: "second",
      expectedRevision: "revision",
    });
    const other = catalog.mutate({
      type: "rename-hosted-playlist",
      playlistId: hostedPlaylistId("spotify", "list2"),
      name: "other",
      expectedRevision: "revision",
    });

    await other;
    expect(calls).toEqual(["start:list1:first", "start:list2:other", "end:list2:other"]);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(calls).toEqual([
      "start:list1:first",
      "start:list2:other",
      "end:list2:other",
      "end:list1:first",
      "start:list1:second",
      "end:list1:second",
    ]);
  });

  it("uses namespaced IDs and persists download toggles without provider writes", async () => {
    const provider = adapter("soundcloud");
    const state = stateStore();
    const catalog = new HostedPlaylistCatalog({
      adapters: [provider],
      now: () => new Date("2026-07-14T12:00:00.000Z"),
      state,
    });
    const playlistId = hostedPlaylistId("soundcloud", "soundcloud:playlists:42");

    const receipt = await catalog.mutate({
      type: "set-hosted-playlist-download",
      playlistId,
      enabled: true,
    });

    expect(parseHostedPlaylistId(playlistId)).toEqual({
      provider: "soundcloud",
      remoteId: "soundcloud:playlists:42",
    });
    expect(state.setDownloadEnabled).toHaveBeenCalledWith(
      "soundcloud",
      "soundcloud:playlists:42",
      true,
    );
    expect(provider.renamePlaylist).not.toHaveBeenCalled();
    expect(receipt).toEqual({
      operation: "set-hosted-playlist-download",
      playlistId,
      revision: "stored",
      queuedAt: "2026-07-14T12:00:00.000Z",
    });
  });
});

function adapter(provider: HostedPlaylistProvider): HostedPlaylistProviderAdapter {
  return {
    provider,
    listPlaylists: vi.fn(async () => ({
      displayName: `${provider}-user`,
      items: [playlist(provider, "list1", "List")],
    })),
    getTracks: vi.fn(async () => [track(provider)]),
    createPlaylist: vi.fn(async (name) => playlist(provider, "created", name)),
    renamePlaylist: vi.fn(async (remoteId, name) => playlist(provider, remoteId, name)),
    replacePlaylistTracks: vi.fn(async (remoteId) => playlist(provider, remoteId, "List")),
    deletePlaylist: vi.fn(async () => undefined),
  };
}

function playlist(provider: HostedPlaylistProvider, remoteId: string, name: string): PlaylistItem {
  return {
    id: hostedPlaylistId(provider, remoteId),
    name,
    parentId: `hosted:${provider}`,
    seq: 1,
    type: "playlist",
    trackCount: 1,
    hosted: {
      provider,
      remoteId,
      revision: "revision",
      externalUrl: null,
      owned: true,
      capabilities: { itemsReadable: true, detailsEditable: true, itemsEditable: true },
      downloadEnabled: false,
      syncState: "idle",
    },
  };
}

function track(provider: HostedPlaylistProvider): TrackSummary {
  const remoteId = provider === "spotify" ? "spotify:track:one" : "soundcloud:tracks:1";
  return {
    id: `track:${remoteId}`,
    title: "Track",
    artist: null,
    album: null,
    genre: null,
    key: null,
    colorId: null,
    bpm: null,
    durationSeconds: null,
    rating: 0,
    playCount: 0,
    analyzed: false,
    artworkAvailable: false,
    fileExists: false,
    path: null,
    hosted: {
      provider,
      remoteId,
      externalUrl: null,
      localContentId: null,
      downloadState: "remote",
    },
  };
}

type TestStateStore = HostedPlaylistStateReaderWriter & {
  getPlaylist: ReturnType<typeof vi.fn<HostedPlaylistStateReaderWriter["getPlaylist"]>>;
  getTrack: ReturnType<typeof vi.fn<HostedPlaylistStateReaderWriter["getTrack"]>>;
  setDownloadEnabled: ReturnType<
    typeof vi.fn<HostedPlaylistStateReaderWriter["setDownloadEnabled"]>
  >;
  updatePlaylistSync: ReturnType<
    typeof vi.fn<HostedPlaylistStateReaderWriter["updatePlaylistSync"]>
  >;
};

function stateStore(): TestStateStore {
  return {
    getPlaylist: vi.fn<HostedPlaylistStateReaderWriter["getPlaylist"]>(() => undefined),
    getTrack: vi.fn<HostedPlaylistStateReaderWriter["getTrack"]>(() => undefined),
    setDownloadEnabled: vi.fn<HostedPlaylistStateReaderWriter["setDownloadEnabled"]>(
      (provider, remoteId, enabled) => ({
        provider,
        remoteId,
        downloadEnabled: enabled,
        revision: "stored",
        syncState: "idle" as const,
        syncError: null,
      }),
    ),
    updatePlaylistSync: vi.fn<HostedPlaylistStateReaderWriter["updatePlaylistSync"]>(
      (provider, remoteId, input) => ({
        provider,
        remoteId,
        downloadEnabled: false,
        revision: input.revision ?? null,
        syncState: input.state ?? "idle",
        syncError: input.error ?? null,
      }),
    ),
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
