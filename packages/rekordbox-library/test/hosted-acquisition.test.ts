import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAcquisitionPlan,
  buildProviderPlaylistManifest,
  unavailableTrackAcquirer,
  writeManifestAtomic,
  type AcquireManifestOptions,
  type ImportManifestToRekordboxOptions,
  type SetManifest,
} from "@gakonst/tracks";
import { afterEach, describe, expect, it } from "vitest";

import {
  HostedPlaylistAcquisitionWorker,
  createDefaultHostedAcquirers,
  hostedPlaylistManifestPath,
  type HostedAcquisitionDependencies,
} from "../src/server/hosted-acquisition.js";
import { HostedPlaylistStateStore } from "../src/server/hosted-state.js";
import type { HostedPlaylistProvider, TrackSummary } from "../src/shared/types.js";

const roots: string[] = [];
const stores: HostedPlaylistStateStore[] = [];
const workers: HostedPlaylistAcquisitionWorker[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close();
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("HostedPlaylistAcquisitionWorker", () => {
  it("constructs the default non-Spotify media backends in preference order", async () => {
    const bundle = await createDefaultHostedAcquirers(new AbortController().signal);
    try {
      expect(bundle.acquirers.map(({ backend }) => backend)).toEqual(["slsk", "ytdlp"]);
    } finally {
      await bundle.close?.();
    }
  });

  it("downloads a fresh SoundCloud snapshot, analyzes it, then imports provider mappings", async () => {
    const fixture = state();
    const remotePlaylistId = "soundcloud:playlists:77";
    const remoteTrackId = "soundcloud:tracks:99";
    const permalink = "https://soundcloud.com/gak/exact-track";
    fixture.store.setDownloadEnabled("soundcloud", remotePlaylistId, true);
    const job = fixture.store.enqueueDownload("soundcloud", remotePlaylistId, {
      playlistName: "Exact playlist",
      externalUrl: "https://soundcloud.com/gak/sets/exact-playlist",
      owner: "GAK",
      revision: "soundcloud-revision-2",
      remoteTrackIds: [remoteTrackId],
    });

    let catalogPlaylistId: string | undefined;
    let planningManifest: SetManifest | undefined;
    let acquisitionOptions: AcquireManifestOptions | undefined;
    let importOptions: ImportManifestToRekordboxOptions | undefined;
    let acquired: SetManifest | undefined;
    const dependencies = {
      createManifest: buildProviderPlaylistManifest,
      writeManifest: writeManifestAtomic,
      async buildPlan(manifest, options) {
        planningManifest = manifest;
        return buildAcquisitionPlan(manifest, options);
      },
      async acquire(options) {
        acquisitionOptions = options;
        const plan = materializedPlan(options);
        expect(options.acquirers.map(({ backend }) => backend)).toEqual(["slsk", "ytdlp"]);
        expect(options.refreshSpotify).toBe(false);
        expect(plan.recordings[0]?.variants[0]?.preferredCandidate).toMatchObject({
          backend: "ytdlp",
          id: "99",
          source: permalink,
        });
        options.onProgress?.({
          phase: "recording",
          entryOrder: 1,
          variant: 1,
          totalVariants: 1,
          message: "downloading",
        });
        await options.onArtifactVerified?.({
          entryOrder: 1,
          variantIndex: 0,
          path: join(fixture.root, "track.m4a"),
          sha256: "a".repeat(64),
          kind: "individual",
          status: "downloaded",
        });
        acquired = downloadedManifest(planningManifest!, fixture.root);
        return { manifest: acquired, failures: [] };
      },
      async analyze(options) {
        expect(options.manifestPath).toBe(
          hostedPlaylistManifestPath(fixture.stateRoot, "soundcloud", remotePlaylistId),
        );
        return {
          manifest: acquired!,
          analysisDirectories: { [join(fixture.root, "track.m4a")]: fixture.root },
        };
      },
      async importRekordbox(options) {
        importOptions = options;
        return {
          playlistId: "local-playlist-77",
          imported: [{ entryId: options.manifest.entries[0]!.id, contentId: "content-99" }],
        };
      },
    } satisfies Partial<HostedAcquisitionDependencies>;
    const worker = createWorker(fixture, {
      catalog: {
        async getTracks(playlistId) {
          catalogPlaylistId = playlistId;
          return [hostedTrack("soundcloud", remoteTrackId, permalink)];
        },
      },
      dependencies,
      rekordbox: { enabled: true, folderNames: { soundcloud: "SoundCloud - GAK" } },
    });

    worker.start();
    await worker.kick();

    expect(catalogPlaylistId).toBe("hosted:soundcloud:soundcloud%3Aplaylists%3A77");
    expect(planningManifest?.entries[0]?.spotify.status).toBe("unmatched");
    expect(acquisitionOptions?.signal?.aborted).toBe(false);
    expect(importOptions).toMatchObject({
      approved: true,
      folderName: "SoundCloud - GAK",
      playlistName: "Exact playlist",
    });
    expect(fixture.store.getJob(job.id)).toMatchObject({
      status: "completed",
      current: 1,
      total: 1,
    });
    expect(fixture.store.getTrack("soundcloud", remoteTrackId)).toMatchObject({
      downloadState: "downloaded",
      localContentId: "content-99",
      downloadError: null,
    });
    expect(fixture.store.getPlaylist("soundcloud", remotePlaylistId)).toMatchObject({
      localPlaylistId: "local-playlist-77",
      revision: "soundcloud-revision-2",
      syncState: "idle",
    });

    const durable = JSON.parse(
      readFileSync(
        hostedPlaylistManifestPath(fixture.stateRoot, "soundcloud", remotePlaylistId),
        "utf8",
      ),
    ) as SetManifest;
    expect(durable.source).toMatchObject({
      input: "https://soundcloud.com/gak/sets/exact-playlist",
      id: remotePlaylistId,
      title: "Exact playlist",
      uploader: "GAK",
    });
    expect(durable.entries[0]?.acquisition).toMatchObject({
      status: "selected",
      selected: { backend: "ytdlp", source: permalink },
    });
  });

  it("keeps Spotify URLs out of direct acquisition and processes recovered jobs serially", async () => {
    const fixture = state();
    for (const playlistId of ["spotify-one", "spotify-two"]) {
      fixture.store.setDownloadEnabled("spotify", playlistId, true);
      fixture.store.enqueueDownload("spotify", playlistId, {
        playlistName: playlistId,
        externalUrl: `https://open.spotify.com/playlist/${playlistId}`,
      });
    }

    let active = 0;
    let peak = 0;
    const started: string[] = [];
    const releaseFirst = deferred<void>();
    const dependencies = successfulDependencies(fixture.root, {
      async acquire(options) {
        const plan = materializedPlan(options);
        active += 1;
        peak = Math.max(peak, active);
        started.push(plan.recordings[0]!.variants[0]!.spotifyId!);
        expect(plan.recordings[0]!.variants[0]!.preferredCandidate).toBeUndefined();
        if (started.length === 1) await releaseFirst.promise;
        const manifest = downloadedManifestFromPlan(options, fixture.root);
        await options.onArtifactVerified?.({
          entryOrder: 1,
          variantIndex: 0,
          path: join(fixture.root, "spotify.m4a"),
          sha256: "b".repeat(64),
          kind: "individual",
          status: "downloaded",
        });
        active -= 1;
        return { manifest, failures: [] };
      },
    });
    const worker = createWorker(fixture, {
      catalog: {
        async getTracks(playlistId) {
          const remote = playlistId.endsWith("spotify-one") ? "one" : "two";
          return [
            hostedTrack(
              "spotify",
              `spotify:track:${remote}`,
              `https://open.spotify.com/track/${remote}`,
            ),
          ];
        },
      },
      dependencies,
    });

    worker.start();
    const drain = worker.kick();
    await eventually(
      () => started.length === 1,
      () => JSON.stringify(fixture.store.listJobs()),
    );
    expect(active).toBe(1);
    releaseFirst.resolve();
    await drain;

    expect(peak).toBe(1);
    expect(started).toEqual(["one", "two"]);
    expect(fixture.store.listJobs().map(({ status }) => status)).toEqual([
      "completed",
      "completed",
    ]);
  });

  it("cancels active work cooperatively and resets unfinished track state", async () => {
    const fixture = state();
    const playlistId = "spotify-cancel";
    const trackId = "spotify:track:cancel";
    fixture.store.setDownloadEnabled("spotify", playlistId, true);
    const job = fixture.store.enqueueDownload("spotify", playlistId, {
      playlistName: "Cancel me",
      remoteTrackIds: [trackId],
    });
    const entered = deferred<void>();
    const dependencies = successfulDependencies(fixture.root, {
      async acquire(options) {
        entered.resolve();
        return await new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(options.signal!.reason), {
            once: true,
          });
        });
      },
    });
    const worker = createWorker(fixture, {
      catalog: {
        getTracks: async () => [hostedTrack("spotify", trackId)],
      },
      dependencies,
    });

    worker.start();
    const drain = worker.kick();
    await entered.promise;
    expect(worker.cancel(job.id)).toBe(true);
    await drain;

    expect(fixture.store.getJob(job.id)).toMatchObject({ status: "cancelled", error: null });
    expect(fixture.store.getTrack("spotify", trackId)).toMatchObject({
      downloadState: "remote",
      downloadError: null,
    });
    expect(fixture.store.getPlaylist("spotify", playlistId)).toMatchObject({ syncState: "idle" });
  });

  it("requeues an interrupted running job on store reopen and fails partial snapshots clearly", async () => {
    const fixture = state();
    const playlistId = "spotify-recovered";
    const trackId = "spotify:track:missing";
    fixture.store.setDownloadEnabled("spotify", playlistId, true);
    const job = fixture.store.enqueueDownload("spotify", playlistId, {
      playlistName: "Recovered",
      remoteTrackIds: [trackId],
    });
    expect(fixture.store.claimNextJob()?.status).toBe("running");
    fixture.store.close();
    stores.splice(stores.indexOf(fixture.store), 1);
    const reopened = new HostedPlaylistStateStore(join(fixture.root, "state.sqlite"));
    stores.push(reopened);

    const dependencies = successfulDependencies(fixture.root, {
      async acquire(options) {
        const manifest = pendingManifestFromPlan(options);
        return {
          manifest,
          failures: [{ entryOrder: 1, spotifyId: "missing", message: "No verified source" }],
        };
      },
    });
    const worker = createWorker(
      { ...fixture, store: reopened },
      {
        catalog: { getTracks: async () => [hostedTrack("spotify", trackId)] },
        dependencies,
      },
    );

    worker.start();
    await worker.kick();

    expect(reopened.getJob(job.id)).toMatchObject({
      status: "failed",
      current: 0,
      total: 1,
      error: expect.stringContaining("0/1"),
    });
    expect(reopened.getTrack("spotify", trackId)).toMatchObject({
      downloadState: "error",
      downloadError: "No verified source",
    });
    expect(reopened.getPlaylist("spotify", playlistId)).toMatchObject({
      syncState: "error",
      syncError: expect.stringContaining("No verified source"),
    });
  });
});

function state(): { root: string; stateRoot: string; store: HostedPlaylistStateStore } {
  const root = mkdtempSync(join(tmpdir(), "hosted-acquisition-"));
  roots.push(root);
  const store = new HostedPlaylistStateStore(join(root, "state.sqlite"));
  stores.push(store);
  return { root, stateRoot: join(root, "worker"), store };
}

function createWorker(
  fixture: { root: string; stateRoot: string; store: HostedPlaylistStateStore },
  options: {
    catalog: { getTracks(playlistId: string): Promise<TrackSummary[]> };
    dependencies: Partial<HostedAcquisitionDependencies>;
    rekordbox?: { enabled: boolean; folderNames?: { soundcloud?: string; spotify?: string } };
  },
): HostedPlaylistAcquisitionWorker {
  const worker = new HostedPlaylistAcquisitionWorker({
    state: fixture.store,
    catalog: options.catalog,
    stateRoot: fixture.stateRoot,
    outputDirectory: join(fixture.root, "music"),
    acquirers: [
      unavailableTrackAcquirer("slsk", "test double"),
      unavailableTrackAcquirer("ytdlp", "test double"),
    ],
    dependencies: options.dependencies,
    rekordbox: options.rekordbox,
  });
  workers.push(worker);
  return worker;
}

function successfulDependencies(
  root: string,
  overrides: Partial<HostedAcquisitionDependencies> = {},
): Partial<HostedAcquisitionDependencies> {
  let created: SetManifest | undefined;
  let acquired: SetManifest | undefined;
  return {
    createManifest(input) {
      created = buildProviderPlaylistManifest(input);
      return created;
    },
    writeManifest: writeManifestAtomic,
    buildPlan: buildAcquisitionPlan,
    async acquire(options) {
      acquired = downloadedManifest(created!, root);
      await options.onArtifactVerified?.({
        entryOrder: 1,
        variantIndex: 0,
        path: join(root, "track.m4a"),
        sha256: "c".repeat(64),
        kind: "individual",
        status: "downloaded",
      });
      return { manifest: acquired, failures: [] };
    },
    async analyze() {
      return { manifest: acquired!, analysisDirectories: {} };
    },
    async importRekordbox() {
      throw new Error("Unexpected Rekordbox import in test");
    },
    ...overrides,
  };
}

function downloadedManifest(manifest: SetManifest, root: string): SetManifest {
  const downloaded = structuredClone(manifest);
  for (const entry of downloaded.entries) {
    const mediaPath = join(root, `${entry.id}.m4a`);
    entry.acquisition = {
      status: "downloaded",
      ...(entry.acquisition.status === "selected"
        ? {
            query: entry.acquisition.query,
            candidates: entry.acquisition.candidates,
            selected: entry.acquisition.selected,
          }
        : {}),
      download: {
        backend: "ytdlp",
        kind: "individual",
        mediaPath,
        files: [mediaPath],
        source: "https://www.youtube.com/watch?v=fake-source",
        sha256: "d".repeat(64),
      },
    };
  }
  return downloaded;
}

function downloadedManifestFromPlan(options: AcquireManifestOptions, root: string): SetManifest {
  const manifest = manifestFromPlan(options);
  return downloadedManifest(manifest, root);
}

function pendingManifestFromPlan(options: AcquireManifestOptions): SetManifest {
  return manifestFromPlan(options);
}

function manifestFromPlan(options: AcquireManifestOptions): SetManifest {
  const source = materializedPlan(options);
  const spotifyId = source.recordings[0]?.variants[0]?.spotifyId ?? "missing";
  return buildProviderPlaylistManifest({
    provider: "spotify",
    id: "spotify-test-playlist",
    title: "Spotify test playlist",
    url: "https://open.spotify.com/playlist/spotify-test-playlist",
    tracks: [
      {
        provider: "spotify",
        order: 1,
        id: spotifyId,
        uri: `spotify:track:${spotifyId}`,
        url: `https://open.spotify.com/track/${spotifyId}`,
        title: "Exact track",
        artists: ["Exact artist"],
      },
    ],
  });
}

function materializedPlan(options: AcquireManifestOptions) {
  const plan = options.plan;
  if (typeof plan === "function") throw new Error("Test expected a materialized acquisition plan");
  return plan;
}

function hostedTrack(
  provider: HostedPlaylistProvider,
  remoteId: string,
  externalUrl?: string,
): TrackSummary {
  return {
    id: `hosted-track:${provider}:${remoteId}`,
    title: "Exact track",
    artist: "Exact artist",
    album: "Exact album",
    genre: null,
    key: null,
    colorId: null,
    bpm: null,
    durationSeconds: 240,
    rating: 0,
    playCount: 0,
    analyzed: false,
    artworkAvailable: false,
    fileExists: false,
    path: null,
    trackNumber: 1,
    hosted: {
      provider,
      remoteId,
      externalUrl:
        externalUrl ??
        (provider === "spotify"
          ? `https://open.spotify.com/track/${remoteId.replace(/^spotify:track:/u, "")}`
          : null),
      localContentId: null,
      downloadState: "remote",
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function eventually(predicate: () => boolean, describe = () => ""): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Condition was not reached ${describe()}`);
}
