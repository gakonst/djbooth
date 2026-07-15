import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CachedHostedPlaylistRuntime,
  type HostedAcquisitionWorkerLifecycle,
} from "../src/server/hosted-runtime.js";
import { HostedPlaylistStateStore } from "../src/server/hosted-state.js";
import { HostedPlaylistCatalog } from "../src/server/hosted/catalog.js";
import { hostedPlaylistId } from "../src/server/hosted/ids.js";
import type { HostedPlaylistProviderAdapter } from "../src/server/hosted/types.js";
import type { PlaylistItem, TrackSummary } from "../src/shared/types.js";

const roots: string[] = [];
const runtimes: CachedHostedPlaylistRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CachedHostedPlaylistRuntime acquisition lifecycle", () => {
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
        streamTrack: async () => new Response(),
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

    expect(state.listJobs()).toHaveLength(2);
    expect(state.getPlaylist("spotify", "playlist-one")).toMatchObject({
      revision: "revision-edit",
      syncState: "queued",
    });
    expect(kick).toHaveBeenCalledTimes(2);
  });
});

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
