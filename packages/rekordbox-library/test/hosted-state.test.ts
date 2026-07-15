import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HostedPlaylistStateStore } from "../src/server/hosted-state.js";

const roots: string[] = [];
const stores: HostedPlaylistStateStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function state(): HostedPlaylistStateStore {
  const root = mkdtempSync(join(tmpdir(), "hosted-playlist-state-"));
  roots.push(root);
  const store = new HostedPlaylistStateStore(join(root, "state.sqlite"));
  stores.push(store);
  return store;
}

describe("HostedPlaylistStateStore", () => {
  it("persists download subscriptions and provider mappings", () => {
    const store = state();
    expect(store.setDownloadEnabled("spotify", "playlist-a", true)).toMatchObject({
      downloadEnabled: true,
      provider: "spotify",
      remoteId: "playlist-a",
      syncState: "idle",
    });

    store.updatePlaylistSync("spotify", "playlist-a", {
      revision: "snapshot-2",
      localPlaylistId: "local-9",
    });
    expect(store.getPlaylist("spotify", "playlist-a")).toMatchObject({
      downloadEnabled: true,
      revision: "snapshot-2",
      localPlaylistId: "local-9",
    });

    store.setTrack("spotify", "spotify:track:1", {
      state: "downloaded",
      localContentId: "content-1",
    });
    expect(store.getTrack("spotify", "spotify:track:1")).toMatchObject({
      downloadState: "downloaded",
      localContentId: "content-1",
    });
    store.setTrack("soundcloud", "soundcloud:tracks:1", { state: "queued" });
    expect(store.listTracks("spotify")).toEqual([
      expect.objectContaining({
        remoteTrackId: "spotify:track:1",
        localContentId: "content-1",
      }),
    ]);
  });

  it("coalesces active download jobs and atomically claims one", () => {
    const store = state();
    const first = store.enqueueDownload("soundcloud", "soundcloud:playlists:1");
    const duplicate = store.enqueueDownload("soundcloud", "soundcloud:playlists:1");
    expect(duplicate.id).toBe(first.id);

    const running = store.claimNextJob();
    expect(running).toMatchObject({ id: first.id, status: "running" });
    expect(store.getActiveDownload("soundcloud", "soundcloud:playlists:1")).toMatchObject({
      id: first.id,
      status: "running",
    });
    expect(store.claimNextJob()).toBeUndefined();
    expect(store.updateJob(first.id, { current: 1, total: 2 })).toMatchObject({
      current: 1,
      total: 2,
    });
  });

  it("coalesces rapid optimistic writes and resumes interrupted work", () => {
    const store = state();
    const first = store.enqueueMutation(
      {
        type: "rename-hosted-playlist",
        playlistId: "spotify:playlist:one",
        name: "First",
        expectedRevision: "snapshot-1",
      },
      "rename:spotify:playlist:one",
    );
    const latest = store.enqueueMutation(
      {
        type: "rename-hosted-playlist",
        playlistId: "spotify:playlist:one",
        name: "Latest",
        expectedRevision: "snapshot-1",
      },
      "rename:spotify:playlist:one",
    );
    expect(latest.id).toBe(first.id);
    expect(latest.mutation).toMatchObject({ name: "Latest" });

    const running = store.claimNextMutation();
    expect(running).toMatchObject({ status: "running", attempts: 1 });
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = new HostedPlaylistStateStore(store.path);
    stores.push(reopened);
    expect(reopened.claimNextMutation()).toMatchObject({ status: "running", attempts: 2 });
  });
});
