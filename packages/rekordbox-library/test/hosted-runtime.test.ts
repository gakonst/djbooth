import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CachedHostedPlaylistRuntime,
  type HostedAcquisitionWorkerLifecycle,
} from "../src/server/hosted-runtime.js";
import { type HostedPlaylistJob, HostedPlaylistStateStore } from "../src/server/hosted-state.js";
import { HostedPlaylistCatalog } from "../src/server/hosted/catalog.js";
import { hostedPlaylistId } from "../src/server/hosted/ids.js";
import type { HostedPlaylistProviderAdapter } from "../src/server/hosted/types.js";
import type {
  HostedPlaylistMutation,
  HostedPlaylistsResponse,
  PlaylistItem,
  TrackSummary,
} from "../src/shared/types.js";

const roots: string[] = [];
const runtimes: CachedHostedPlaylistRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("CachedHostedPlaylistRuntime acquisition lifecycle", () => {
  it("forwards hosted stream byte-range requests without caching them", async () => {
    const root = mkdtempSync(join(tmpdir(), "hosted-runtime-stream-"));
    roots.push(root);
    const state = new HostedPlaylistStateStore(join(root, "state.sqlite"));
    const streamTrack = vi.fn(async () => ({
      kind: "progressive" as const,
      response: new Response("test", { status: 206 }),
    }));
    const runtime = new CachedHostedPlaylistRuntime({
      catalog: {
        listPlaylists: async () => ({ items: [], providers: [] }),
        getTracks: async () => [],
        streamTrack,
        mutate: async (mutation) => ({
          operation: mutation.type,
          playlistId: "playlistId" in mutation ? mutation.playlistId : "hosted:spotify:new",
          revision: null,
          queuedAt: "2026-07-14T00:00:00.000Z",
        }),
      },
      state,
      createAcquisitionWorker: idleAcquisitionWorker,
    });
    runtimes.push(runtime);

    const stream = await runtime.streamTrack("hosted-track:soundcloud:track", {
      range: "bytes=10-13",
    });

    expect(stream.kind).toBe("progressive");
    expect(stream.response.status).toBe(206);
    expect(streamTrack).toHaveBeenCalledWith("hosted-track:soundcloud:track", {
      range: "bytes=10-13",
    });
  });

  it("queues enabled playlists, kicks the worker, emits cache invalidation, and closes in order", async () => {
    const root = mkdtempSync(join(tmpdir(), "hosted-runtime-"));
    roots.push(root);
    const state = new HostedPlaylistStateStore(join(root, "state.sqlite"));
    const id = hostedPlaylistId("spotify", "playlist-one");
    const item = hostedPlaylist(id);
    const getTracks = vi.fn(async (): Promise<TrackSummary[]> => []);
    const catalog = new HostedPlaylistCatalog({
      state,
      adapters: [adapter(item, getTracks)],
    });
    const start = vi.fn();
    const kick = vi.fn(async () => undefined);
    const cancel = vi.fn(() => true);
    const close = vi.fn(async () => {
      expect(state.listJobs()).toHaveLength(1);
    });
    let emitJob: ((job: ReturnType<HostedPlaylistStateStore["getJob"]>) => void) | undefined;
    const runtime = new CachedHostedPlaylistRuntime({
      catalog,
      state,
      createAcquisitionWorker(options) {
        emitJob = (job) => {
          if (job) options.onJobChanged?.(job);
        };
        return { start, kick, cancel, close } satisfies HostedAcquisitionWorkerLifecycle;
      },
    });
    runtimes.push(runtime);

    expect(start).toHaveBeenCalledOnce();
    await runtime.listPlaylists();
    await runtime.getTracks(id);
    await runtime.getTracks(id);
    expect(getTracks).toHaveBeenCalledOnce();

    await runtime.mutate({
      type: "set-hosted-playlist-download",
      playlistId: id,
      enabled: true,
    });

    const [job] = state.listJobs();
    expect(job).toMatchObject({
      provider: "spotify",
      playlistId: "playlist-one",
      status: "queued",
      payload: {
        hostedPlaylistId: id,
        playlistName: "Remote one",
        externalUrl: "https://open.spotify.com/playlist/playlist-one",
        revision: "revision-one",
      },
    });
    expect(state.getPlaylist("spotify", "playlist-one")).toMatchObject({
      downloadEnabled: true,
      revision: "revision-one",
      syncState: "queued",
    });
    expect(kick).toHaveBeenCalledOnce();

    const listener = vi.fn();
    const unsubscribe = runtime.onJobChanged(listener);
    emitJob?.(job);
    expect(listener).toHaveBeenCalledWith({ playlistId: id });
    await runtime.getTracks(id);
    expect(getTracks).toHaveBeenCalledTimes(2);
    unsubscribe();

    await runtime.mutate({
      type: "set-hosted-playlist-download",
      playlistId: id,
      enabled: false,
    });
    expect(cancel).toHaveBeenCalledWith(job!.id);
    expect(state.getPlaylist("spotify", "playlist-one")).toMatchObject({
      downloadEnabled: false,
      syncState: "idle",
    });

    await runtime.close();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    expect(close).toHaveBeenCalledOnce();
    expect(() => state.listJobs()).toThrow();
  });

  it("redecorates cached provider rows for acquisition progress without provider reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "hosted-runtime-state-refresh-"));
    roots.push(root);
    const state = new HostedPlaylistStateStore(join(root, "state.sqlite"));
    const id = hostedPlaylistId("spotify", "playlist-one");
    const remotePlaylist = hostedPlaylist(id);
    const remoteTrack: TrackSummary = {
      ...localTrack("hosted-track:spotify:track:one", 1),
      path: null,
      fileExists: false,
      hosted: {
        provider: "spotify",
        remoteId: "spotify:track:one",
        externalUrl: null,
        localContentId: null,
        downloadState: "remote",
      },
    };
    const listPlaylists = vi.fn(async () => ({ items: [remotePlaylist], providers: [] }));
    const getTracks = vi.fn(async () => [remoteTrack]);
    const refreshPlaylistState = vi.fn(async (response: HostedPlaylistsResponse) => ({
      ...response,
      items: response.items.map((playlist) => ({
        ...playlist,
        hosted: playlist.hosted ? { ...playlist.hosted, syncState: "syncing" as const } : undefined,
      })),
    }));
    const refreshTrackState = vi.fn(async (_playlistId, tracks: readonly TrackSummary[]) =>
      tracks.map((track) => ({
        ...track,
        hosted: track.hosted
          ? { ...track.hosted, downloadState: "downloaded" as const }
          : undefined,
      })),
    );
    let emitJob: ((job: HostedPlaylistJob) => void) | undefined;
    const runtime = new CachedHostedPlaylistRuntime({
      catalog: {
        listPlaylists,
        getTracks,
        refreshPlaylistState,
        refreshTrackState,
        streamTrack: async () => ({ kind: "hls", response: new Response() }),
        mutate: async (mutation) => ({
          operation: mutation.type,
          playlistId: "playlistId" in mutation ? mutation.playlistId : id,
          revision: null,
          queuedAt: "2026-07-14T00:00:00.000Z",
        }),
      },
      state,
      createAcquisitionWorker(options) {
        emitJob = options.onJobChanged;
        return idleAcquisitionWorker();
      },
    });
    runtimes.push(runtime);

    await runtime.listPlaylists();
    await runtime.getTracks(id);
    emitJob?.({
      id: "job",
      kind: "download-playlist",
      provider: "spotify",
      playlistId: "playlist-one",
      status: "running",
      current: 1,
      total: 2,
      error: null,
      payload: { hostedPlaylistId: id },
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:01.000Z",
    });
    emitJob?.({
      id: "job",
      kind: "download-playlist",
      provider: "spotify",
      playlistId: "playlist-one",
      status: "running",
      current: 2,
      total: 2,
      error: null,
      payload: { hostedPlaylistId: id },
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:02.000Z",
    });

    await Promise.resolve();
    expect(refreshPlaylistState).not.toHaveBeenCalled();
    expect(refreshTrackState).not.toHaveBeenCalled();

    await expect(runtime.listPlaylists()).resolves.toMatchObject({
      items: [{ hosted: { syncState: "syncing" } }],
    });
    await expect(runtime.getTracks(id)).resolves.toMatchObject([
      { hosted: { downloadState: "downloaded" } },
    ]);
    expect(listPlaylists).toHaveBeenCalledOnce();
    expect(getTracks).toHaveBeenCalledOnce();
    expect(refreshPlaylistState).toHaveBeenCalledOnce();
    expect(refreshTrackState).toHaveBeenCalledOnce();
  });

  it("serves stale successful provider rows and retries disconnected catalogs quickly", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const root = mkdtempSync(join(tmpdir(), "hosted-runtime-provider-fallback-"));
    roots.push(root);
    const state = new HostedPlaylistStateStore(join(root, "state.sqlite"));
    const spotifyCached = { ...hostedPlaylist(hostedPlaylistId("spotify", "playlist-one")) };
    spotifyCached.name = "Spotify cached";
    const soundcloudCached = soundcloudPlaylist("playlist-two", "SoundCloud cached");
    const soundcloudFresh = soundcloudPlaylist("playlist-two", "SoundCloud fresh");
    const spotifyRecovered = {
      ...hostedPlaylist(hostedPlaylistId("spotify", "playlist-one")),
      name: "Spotify recovered",
    };
    const responses: HostedPlaylistsResponse[] = [
      {
        items: [spotifyCached, soundcloudCached],
        providers: [
          { provider: "spotify", connected: true, displayName: "spotify-user" },
          { provider: "soundcloud", connected: true, displayName: "soundcloud-user" },
        ],
      },
      {
        items: [soundcloudFresh],
        providers: [
          { provider: "spotify", connected: false, error: "fetch failed" },
          { provider: "soundcloud", connected: true, displayName: "soundcloud-user" },
        ],
      },
      {
        items: [spotifyRecovered, soundcloudFresh],
        providers: [
          { provider: "spotify", connected: true, displayName: "spotify-user" },
          { provider: "soundcloud", connected: true, displayName: "soundcloud-user" },
        ],
      },
    ];
    let responseIndex = 0;
    const listPlaylists = vi.fn(async () =>
      structuredClone(responses[Math.min(responseIndex++, responses.length - 1)]!),
    );
    const runtime = new CachedHostedPlaylistRuntime({
      catalog: {
        listPlaylists,
        getTracks: async () => [],
        streamTrack: async () => ({ kind: "hls", response: new Response() }),
        mutate: async (mutation) => ({
          operation: mutation.type,
          playlistId:
            "playlistId" in mutation ? mutation.playlistId : hostedPlaylistId("spotify", "new"),
          revision: null,
          queuedAt: "2026-07-18T00:00:00.000Z",
        }),
      },
      state,
      playlistCacheMs: 60_000,
      playlistRetryCacheMs: 5_000,
      createAcquisitionWorker: idleAcquisitionWorker,
    });
    runtimes.push(runtime);

    await expect(runtime.listPlaylists()).resolves.toMatchObject({
      items: [{ name: "Spotify cached" }, { name: "SoundCloud cached" }],
    });
    now += 60_000;
    const degraded = await runtime.listPlaylists();
    expect(degraded.items.map((item) => item.name)).toEqual(["Spotify cached", "SoundCloud fresh"]);
    expect(degraded.providers).toEqual([
      {
        provider: "spotify",
        connected: true,
        displayName: "spotify-user",
        error: "fetch failed",
      },
      { provider: "soundcloud", connected: true, displayName: "soundcloud-user" },
    ]);
    expect(listPlaylists).toHaveBeenCalledTimes(2);

    now += 4_999;
    await runtime.listPlaylists();
    expect(listPlaylists).toHaveBeenCalledTimes(2);
    now += 1;
    const recovered = await runtime.listPlaylists();
    expect(recovered.items.map((item) => item.name)).toEqual([
      "Spotify recovered",
      "SoundCloud fresh",
    ]);
    expect(recovered.providers[0]).toEqual({
      provider: "spotify",
      connected: true,
      displayName: "spotify-user",
    });
    expect(listPlaylists).toHaveBeenCalledTimes(3);

    now += 5_000;
    await runtime.listPlaylists();
    expect(listPlaylists).toHaveBeenCalledTimes(3);
  });

  it("queues configured playlists after provider revisions or hosted item edits", async () => {
    const root = mkdtempSync(join(tmpdir(), "hosted-runtime-sync-"));
    roots.push(root);
    const state = new HostedPlaylistStateStore(join(root, "state.sqlite"));
    const id = hostedPlaylistId("spotify", "playlist-one");
    state.setDownloadEnabled("spotify", "playlist-one", true);
    state.updatePlaylistSync("spotify", "playlist-one", {
      revision: "revision-old",
      state: "idle",
    });
    const item = hostedPlaylist(id);
    item.hosted = { ...item.hosted!, downloadEnabled: true, revision: "revision-provider" };
    const kick = vi.fn(async () => undefined);
    const runtime = new CachedHostedPlaylistRuntime({
      catalog: {
        listPlaylists: async () => ({ items: [item], providers: [] }),
        getTracks: async (): Promise<TrackSummary[]> => [],
        streamTrack: async () => ({ kind: "hls", response: new Response() }),
        mutate: async (mutation) => ({
          operation: mutation.type,
          playlistId: "playlistId" in mutation ? mutation.playlistId : id,
          revision: "revision-edit",
          queuedAt: "2026-07-14T00:00:00.000Z",
        }),
      },
      state,
      createAcquisitionWorker: () => ({
        start: vi.fn(),
        kick,
        cancel: vi.fn(() => true),
        close: vi.fn(async () => undefined),
      }),
    });
    runtimes.push(runtime);

    const listed = await runtime.listPlaylists();
    expect(listed.items[0]?.hosted?.syncState).toBe("queued");
    expect(state.listJobs()).toHaveLength(1);

    state.updateJob(state.listJobs()[0]!.id, { status: "completed" });
    state.updatePlaylistSync("spotify", "playlist-one", {
      revision: "revision-provider",
      state: "idle",
    });
    await runtime.mutate({
      type: "replace-hosted-playlist-tracks",
      playlistId: id,
      remoteTrackIds: ["spotify:track:one"],
      expectedRevision: "revision-provider",
    });

    await vi.waitFor(() => expect(state.listJobs()).toHaveLength(2));
    expect(state.getPlaylist("spotify", "playlist-one")).toMatchObject({
      revision: "revision-edit",
      syncState: "queued",
    });
    expect(kick).toHaveBeenCalledTimes(2);
  });

  it("durably queues provider writes immediately and resolves optimistic revisions in order", async () => {
    const root = mkdtempSync(join(tmpdir(), "hosted-runtime-outbox-"));
    roots.push(root);
    const state = new HostedPlaylistStateStore(join(root, "state.sqlite"));
    const id = hostedPlaylistId("spotify", "playlist-one");
    state.updatePlaylistSync("spotify", "playlist-one", {
      revision: "revision-1",
      state: "idle",
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    const mutate = vi.fn(async (mutation: HostedPlaylistMutation) => {
      const current = ++call;
      if (current === 1) await firstGate;
      return {
        operation: mutation.type,
        playlistId: "playlistId" in mutation ? mutation.playlistId : id,
        revision: `revision-${String(current + 1)}`,
        queuedAt: "2026-07-14T00:00:00.000Z",
      };
    });
    const runtime = new CachedHostedPlaylistRuntime({
      catalog: {
        listPlaylists: async () => ({ items: [], providers: [] }),
        getTracks: async (): Promise<TrackSummary[]> => [],
        streamTrack: async () => ({ kind: "hls", response: new Response() }),
        mutate,
      },
      state,
      createAcquisitionWorker: idleAcquisitionWorker,
    });
    runtimes.push(runtime);
    const listener = vi.fn();
    runtime.onJobChanged(listener);

    const first = await runtime.mutate({
      type: "rename-hosted-playlist",
      playlistId: id,
      name: "First rename",
      expectedRevision: "revision-1",
    });
    expect(first.revision).toMatch(/^local-outbox:/);
    const firstEntryId = first.revision!.slice("local-outbox:".length);
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(state.getOutbox(firstEntryId)).toMatchObject({ status: "running", attempts: 1 });

    let second: Awaited<ReturnType<CachedHostedPlaylistRuntime["mutate"]>>;
    try {
      second = await runtime.mutate({
        type: "replace-hosted-playlist-tracks",
        playlistId: id,
        remoteTrackIds: ["spotify:track:one"],
        expectedRevision: first.revision,
      });
      expect(second.revision).toMatch(/^local-outbox:/);
      expect(mutate).toHaveBeenCalledTimes(1);
    } finally {
      releaseFirst();
    }

    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
    expect(mutate.mock.calls[1]?.[0]).toMatchObject({
      type: "replace-hosted-playlist-tracks",
      expectedRevision: "revision-2",
    });
    await vi.waitFor(() => {
      expect(state.getOutbox(firstEntryId)).toBeUndefined();
      expect(state.getOutbox(second.revision!.slice("local-outbox:".length))).toBeUndefined();
    });
    expect(state.getPlaylist("spotify", "playlist-one")).toMatchObject({
      revision: "revision-3",
      syncState: "idle",
      syncError: null,
    });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("mirrors committed local rename and order edits through the durable outbox", async () => {
    const root = mkdtempSync(join(tmpdir(), "hosted-runtime-local-mirror-"));
    roots.push(root);
    const state = new HostedPlaylistStateStore(join(root, "state.sqlite"));
    const id = hostedPlaylistId("spotify", "playlist-one");
    state.setDownloadEnabled("spotify", "playlist-one", true);
    state.updatePlaylistSync("spotify", "playlist-one", {
      localPlaylistId: "local-playlist",
      revision: "revision-1",
      state: "idle",
    });
    state.setTrack("spotify", "spotify:track:one", {
      localContentId: "local-one",
      state: "downloaded",
    });
    state.setTrack("spotify", "spotify:track:two", {
      localContentId: "local-two",
      state: "downloaded",
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    const mutate = vi.fn(async (mutation: HostedPlaylistMutation) => {
      const current = ++call;
      if (current === 1) await firstGate;
      return {
        operation: mutation.type,
        playlistId: id,
        revision: `revision-${String(current + 1)}`,
        queuedAt: "2026-07-14T00:00:00.000Z",
      };
    });
    const kick = vi.fn(async () => undefined);
    const runtime = new CachedHostedPlaylistRuntime({
      catalog: {
        listPlaylists: async () => ({ items: [], providers: [] }),
        getTracks: async (): Promise<TrackSummary[]> => [],
        streamTrack: async () => ({ kind: "hls", response: new Response() }),
        mutate,
      },
      state,
      createAcquisitionWorker: () => ({
        start: vi.fn(),
        kick,
        cancel: vi.fn(() => true),
        close: vi.fn(async () => undefined),
      }),
    });
    runtimes.push(runtime);
    const library = {
      getTracks: vi.fn(() => ({
        items: [localTrack("local-two", 1), localTrack("local-one", 2)],
        count: 2,
        limit: 10_000,
        offset: 0,
      })),
    };

    const renamed = runtime.mirrorLocalMutation(
      { type: "rename-playlist", playlistId: "local-playlist", name: "Local rename" },
      library,
    );
    expect(renamed?.revision).toMatch(/^local-outbox:/);
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    const reordered = runtime.mirrorLocalMutation(
      {
        type: "move-track",
        playlistId: "local-playlist",
        membershipId: "membership-two",
        trackNumber: 1,
      },
      library,
    );
    expect(reordered?.revision).toMatch(/^local-outbox:/);
    releaseFirst();

    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      type: "rename-hosted-playlist",
      name: "Local rename",
      expectedRevision: "revision-1",
    });
    expect(mutate.mock.calls[1]?.[0]).toMatchObject({
      type: "replace-hosted-playlist-tracks",
      remoteTrackIds: ["spotify:track:two", "spotify:track:one"],
      expectedRevision: "revision-2",
    });
    await vi.waitFor(() =>
      expect(state.getPlaylist("spotify", "playlist-one")).toMatchObject({
        revision: "revision-3",
        syncState: "idle",
      }),
    );
    expect(state.listJobs()).toHaveLength(0);
    expect(kick).not.toHaveBeenCalled();
  });

  it("refuses incomplete cross-provider local mappings and never deletes the hosted playlist", () => {
    const root = mkdtempSync(join(tmpdir(), "hosted-runtime-local-mirror-safe-"));
    roots.push(root);
    const state = new HostedPlaylistStateStore(join(root, "state.sqlite"));
    state.setDownloadEnabled("spotify", "playlist-one", true);
    state.updatePlaylistSync("spotify", "playlist-one", {
      localPlaylistId: "local-playlist",
      revision: "revision-1",
      state: "idle",
    });
    state.setTrack("soundcloud", "soundcloud:tracks:one", {
      localContentId: "local-one",
      state: "downloaded",
    });
    const mutate = vi.fn(async () => {
      throw new Error("provider must not be called");
    });
    const runtime = new CachedHostedPlaylistRuntime({
      catalog: {
        listPlaylists: async () => ({ items: [], providers: [] }),
        getTracks: async (): Promise<TrackSummary[]> => [],
        streamTrack: async () => ({ kind: "hls", response: new Response() }),
        mutate,
      },
      state,
      createAcquisitionWorker: idleAcquisitionWorker,
    });
    runtimes.push(runtime);
    const library = {
      getTracks: () => ({
        items: [localTrack("local-one", 1)],
        count: 1,
        limit: 10_000,
        offset: 0,
      }),
    };

    expect(
      runtime.mirrorLocalMutation(
        {
          type: "add-track",
          playlistId: "local-playlist",
          contentId: "local-one",
        },
        library,
      ),
    ).toBeUndefined();
    expect(mutate).not.toHaveBeenCalled();
    expect(state.getPlaylist("spotify", "playlist-one")).toMatchObject({
      localPlaylistId: "local-playlist",
      syncState: "error",
      syncError: expect.stringContaining("no spotify identity mapping"),
    });

    runtime.mirrorLocalMutation(
      {
        type: "delete-playlist",
        playlistId: "local-folder",
        expectedPlaylistIds: ["local-folder", "local-playlist"],
      },
      library,
    );
    expect(state.getPlaylist("spotify", "playlist-one")).toMatchObject({
      downloadEnabled: true,
      localPlaylistId: null,
      revision: "revision-1",
    });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("retries transient provider failures with a bound and leaves durable failure state", async () => {
    const root = mkdtempSync(join(tmpdir(), "hosted-runtime-outbox-retry-"));
    roots.push(root);
    const state = new HostedPlaylistStateStore(join(root, "state.sqlite"));
    const id = hostedPlaylistId("soundcloud", "playlist-one");
    state.updatePlaylistSync("soundcloud", "playlist-one", {
      revision: "revision-1",
      state: "idle",
    });
    const mutate = vi.fn(async () => {
      throw new Error("temporary provider outage");
    });
    const runtime = new CachedHostedPlaylistRuntime({
      catalog: {
        listPlaylists: async () => ({ items: [], providers: [] }),
        getTracks: async (): Promise<TrackSummary[]> => [],
        streamTrack: async () => ({ kind: "hls", response: new Response() }),
        mutate,
      },
      state,
      outboxMaxAttempts: 3,
      outboxRetryBaseMs: 1,
      outboxRetryMaxMs: 2,
      createAcquisitionWorker: idleAcquisitionWorker,
    });
    runtimes.push(runtime);

    const receipt = await runtime.mutate({
      type: "rename-hosted-playlist",
      playlistId: id,
      name: "Queued rename",
      expectedRevision: "revision-1",
    });
    const entryId = receipt.revision!.slice("local-outbox:".length);
    await vi.waitFor(() =>
      expect(state.getOutbox(entryId)).toMatchObject({
        status: "failed",
        attempts: 3,
        error: "temporary provider outage",
      }),
    );
    expect(mutate).toHaveBeenCalledTimes(3);
    expect(state.getPlaylist("soundcloud", "playlist-one")).toMatchObject({
      syncState: "error",
      syncError: "temporary provider outage",
    });
  });
});

function idleAcquisitionWorker(): HostedAcquisitionWorkerLifecycle {
  return {
    start: vi.fn(),
    kick: vi.fn(async () => undefined),
    cancel: vi.fn(() => true),
    close: vi.fn(async () => undefined),
  };
}

function hostedPlaylist(id: string): PlaylistItem {
  return {
    id,
    name: "Remote one",
    parentId: "hosted:spotify",
    seq: 1,
    type: "playlist",
    trackCount: 0,
    hosted: {
      provider: "spotify",
      remoteId: "playlist-one",
      revision: "revision-one",
      externalUrl: "https://open.spotify.com/playlist/playlist-one",
      owned: true,
      capabilities: { itemsReadable: true, detailsEditable: true, itemsEditable: true },
      downloadEnabled: false,
      syncState: "idle",
    },
  };
}

function soundcloudPlaylist(remoteId: string, name: string): PlaylistItem {
  return {
    id: hostedPlaylistId("soundcloud", remoteId),
    name,
    parentId: "hosted:soundcloud",
    seq: 1,
    type: "playlist",
    trackCount: 0,
    hosted: {
      provider: "soundcloud",
      remoteId,
      revision: "soundcloud-revision",
      externalUrl: `https://soundcloud.com/user/sets/${remoteId}`,
      owned: true,
      capabilities: { itemsReadable: true, detailsEditable: true, itemsEditable: true },
      downloadEnabled: false,
      syncState: "idle",
    },
  };
}

function localTrack(id: string, position: number): TrackSummary {
  return {
    id,
    title: id,
    artist: null,
    album: null,
    genre: null,
    key: null,
    colorId: null,
    bpm: null,
    durationSeconds: null,
    rating: 0,
    playCount: 0,
    analyzed: true,
    artworkAvailable: false,
    fileExists: true,
    path: `/music/${id}.flac`,
    trackNumber: position,
  };
}

function adapter(
  item: PlaylistItem,
  getTracks: () => Promise<TrackSummary[]>,
): HostedPlaylistProviderAdapter {
  const unexpectedWrite = () => Promise.reject(new Error("Provider writes are forbidden in test"));
  return {
    provider: "spotify",
    listPlaylists: async () => ({ items: [item] }),
    getTracks,
    createPlaylist: unexpectedWrite,
    renamePlaylist: unexpectedWrite,
    replacePlaylistTracks: unexpectedWrite,
    deletePlaylist: unexpectedWrite,
  };
}
