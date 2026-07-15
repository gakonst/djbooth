import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  FileSessionStore as SpotifyFileSessionStore,
  SpotifyClient,
  SpotifyOAuth,
} from "@gakonst/spots";
import { createSoundCloudUserClient } from "@gakonst/soundcloud";

import type {
  HostedMutationReceipt,
  HostedPlaylistMutation,
  HostedPlaylistProvider,
  HostedPlaylistsResponse,
  TrackSummary,
} from "../shared/types.js";
import {
  HostedPlaylistAcquisitionWorker,
  type HostedPlaylistAcquisitionWorkerOptions,
} from "./hosted-acquisition.js";
import { HostedPlaylistStateStore } from "./hosted-state.js";
import { HostedPlaylistCatalog } from "./hosted/catalog.js";
import { hostedPlaylistId, parseHostedPlaylistId } from "./hosted/ids.js";
import { SoundCloudHostedPlaylistAdapter } from "./hosted/soundcloud.js";
import { SpotifyHostedPlaylistAdapter } from "./hosted/spotify.js";
import type { HostedAdapterListResult, HostedPlaylistProviderAdapter } from "./hosted/types.js";
import type { HostedPlaylistApi } from "./server.js";

export type DefaultHostedPlaylistRuntimeOptions = {
  statePath?: string;
  playlistCacheMs?: number;
  trackCacheMs?: number;
  writeEnabled?: boolean;
  dbPath?: string;
  key?: string;
};

export type HostedPlaylistRuntimeCatalog = Pick<
  HostedPlaylistCatalog,
  "getTracks" | "listPlaylists" | "mutate" | "streamTrack"
>;

export type HostedAcquisitionWorkerLifecycle = Pick<
  HostedPlaylistAcquisitionWorker,
  "cancel" | "close" | "kick" | "start"
>;

export type HostedAcquisitionWorkerFactory = (
  options: HostedPlaylistAcquisitionWorkerOptions,
) => HostedAcquisitionWorkerLifecycle;

export type HostedPlaylistRuntimeOptions = {
  catalog: HostedPlaylistRuntimeCatalog;
  state: HostedPlaylistStateStore;
  playlistCacheMs?: number;
  trackCacheMs?: number;
  acquisition?: Omit<HostedPlaylistAcquisitionWorkerOptions, "catalog" | "onJobChanged" | "state">;
  createAcquisitionWorker?: HostedAcquisitionWorkerFactory;
};

export async function createDefaultHostedPlaylistRuntime(
  options: DefaultHostedPlaylistRuntimeOptions = {},
): Promise<HostedPlaylistApi> {
  loadWorkspaceEnvironment();
  const state = new HostedPlaylistStateStore(options.statePath);
  const adapters = await Promise.all([
    createSpotifyAdapter().catch(
      (error: unknown) => new UnavailableHostedPlaylistAdapter("spotify", errorMessage(error)),
    ),
    createSoundCloudAdapter().catch(
      (error: unknown) => new UnavailableHostedPlaylistAdapter("soundcloud", errorMessage(error)),
    ),
  ]);
  const catalog = new HostedPlaylistCatalog({ adapters, state });
  return new CachedHostedPlaylistRuntime({
    catalog,
    state,
    playlistCacheMs: options.playlistCacheMs,
    trackCacheMs: options.trackCacheMs,
    acquisition: {
      rekordbox: {
        enabled: options.writeEnabled === true,
        ...(options.dbPath ? { dbPath: options.dbPath } : {}),
        ...(options.key ? { key: options.key } : {}),
      },
    },
  });
}

export class CachedHostedPlaylistRuntime implements HostedPlaylistApi {
  readonly #catalog: HostedPlaylistRuntimeCatalog;
  readonly #state: HostedPlaylistStateStore;
  readonly #worker: HostedAcquisitionWorkerLifecycle;
  readonly #playlistCacheMs: number;
  readonly #trackCacheMs: number;
  readonly #jobListeners = new Set<(event: { playlistId: string }) => void>();
  #playlistCache: { expiresAt: number; promise: Promise<HostedPlaylistsResponse> } | undefined;
  readonly #trackCache = new Map<string, { expiresAt: number; promise: Promise<TrackSummary[]> }>();
  #closePromise: Promise<void> | undefined;

  constructor(options: HostedPlaylistRuntimeOptions) {
    this.#catalog = options.catalog;
    this.#state = options.state;
    this.#playlistCacheMs = positiveDuration(options.playlistCacheMs, 60_000);
    this.#trackCacheMs = positiveDuration(options.trackCacheMs, 30_000);
    const createWorker =
      options.createAcquisitionWorker ??
      ((workerOptions: HostedPlaylistAcquisitionWorkerOptions) =>
        new HostedPlaylistAcquisitionWorker(workerOptions));
    this.#worker = createWorker({
      ...options.acquisition,
      catalog: this.#catalog,
      state: this.#state,
      onJobChanged: (job) => this.#handleJobChanged(job),
    });
    this.#worker.start();
  }

  listPlaylists(): Promise<HostedPlaylistsResponse> {
    const now = Date.now();
    if (this.#playlistCache && this.#playlistCache.expiresAt > now)
      return this.#playlistCache.promise;
    const promise = this.#catalog
      .listPlaylists()
      .then((response) => this.#scheduleChangedDownloads(response))
      .catch((error: unknown) => {
        if (this.#playlistCache?.promise === promise) this.#playlistCache = undefined;
        throw error;
      });
    this.#playlistCache = { expiresAt: now + this.#playlistCacheMs, promise };
    return promise;
  }

  getTracks(playlistId: string): Promise<TrackSummary[]> {
    const now = Date.now();
    const cached = this.#trackCache.get(playlistId);
    if (cached && cached.expiresAt > now) return cached.promise;
    const promise = this.#catalog.getTracks(playlistId).catch((error: unknown) => {
      if (this.#trackCache.get(playlistId)?.promise === promise)
        this.#trackCache.delete(playlistId);
      throw error;
    });
    this.#trackCache.set(playlistId, { expiresAt: now + this.#trackCacheMs, promise });
    return promise;
  }

  streamTrack(trackId: string): Promise<Response> {
    return this.#catalog.streamTrack(trackId);
  }

  onJobChanged(listener: (event: { playlistId: string }) => void): () => void {
    this.#jobListeners.add(listener);
    return () => this.#jobListeners.delete(listener);
  }

  async mutate(mutation: HostedPlaylistMutation): Promise<HostedMutationReceipt> {
    const priorPlaylists = this.#playlistCache?.promise;
    const receipt = await this.#catalog.mutate(mutation);
    this.#playlistCache = undefined;
    if ("playlistId" in mutation) this.#trackCache.delete(mutation.playlistId);
    if (mutation.type === "set-hosted-playlist-download") {
      const { provider, remoteId } = parseHostedPlaylistId(mutation.playlistId);
      if (mutation.enabled) {
        const playlist = (await priorPlaylists?.catch(() => undefined))?.items.find(
          (candidate) => candidate.id === mutation.playlistId,
        );
        this.#state.updatePlaylistSync(provider, remoteId, {
          revision: playlist?.hosted?.revision ?? receipt.revision,
          state: "queued",
          error: null,
        });
        this.#state.enqueueDownload(provider, remoteId, {
          hostedPlaylistId: mutation.playlistId,
          ...(playlist ? { playlistName: playlist.name } : {}),
          ...(playlist?.hosted?.externalUrl ? { externalUrl: playlist.hosted.externalUrl } : {}),
          ...(playlist?.hosted?.revision
            ? { revision: playlist.hosted.revision }
            : receipt.revision
              ? { revision: receipt.revision }
              : {}),
        });
        void this.#worker.kick().catch(() => undefined);
      } else {
        this.#state.updatePlaylistSync(provider, remoteId, {
          state: "idle",
          error: null,
        });
        const active =
          this.#state.getActiveDownload(provider, remoteId) ??
          this.#state.getActiveDownload(provider, mutation.playlistId);
        if (active) this.#worker.cancel(active.id);
      }
    } else if (mutation.type === "replace-hosted-playlist-tracks") {
      const { provider, remoteId } = parseHostedPlaylistId(mutation.playlistId);
      const configured = this.#state.getPlaylist(provider, remoteId);
      if (configured?.downloadEnabled) {
        const playlist = (await priorPlaylists?.catch(() => undefined))?.items.find(
          (candidate) => candidate.id === mutation.playlistId,
        );
        this.#state.updatePlaylistSync(provider, remoteId, {
          revision: receipt.revision,
          state: "queued",
          error: null,
        });
        this.#state.enqueueDownload(provider, remoteId, {
          hostedPlaylistId: mutation.playlistId,
          ...(playlist ? { playlistName: playlist.name } : {}),
          ...(playlist?.hosted?.externalUrl ? { externalUrl: playlist.hosted.externalUrl } : {}),
          ...(receipt.revision ? { revision: receipt.revision } : {}),
        });
        void this.#worker.kick().catch(() => undefined);
      }
    }
    return receipt;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#jobListeners.clear();
    this.#trackCache.clear();
    this.#playlistCache = undefined;
    try {
      await this.#worker.close();
    } finally {
      this.#state.close();
    }
  }

  #scheduleChangedDownloads(response: HostedPlaylistsResponse): HostedPlaylistsResponse {
    let changed = false;
    const items = response.items.map((playlist) => {
      if (!playlist.hosted?.downloadEnabled) return playlist;
      const { provider, remoteId, revision } = playlist.hosted;
      const stored = this.#state.getPlaylist(provider, remoteId);
      if (
        !stored ||
        stored.revision === revision ||
        stored.syncState === "queued" ||
        stored.syncState === "syncing" ||
        this.#state.getActiveDownload(provider, remoteId)
      ) {
        return playlist;
      }
      this.#state.updatePlaylistSync(provider, remoteId, { state: "queued", error: null });
      this.#state.enqueueDownload(provider, remoteId, {
        hostedPlaylistId: playlist.id,
        playlistName: playlist.name,
        ...(playlist.hosted.externalUrl ? { externalUrl: playlist.hosted.externalUrl } : {}),
        ...(revision ? { revision } : {}),
      });
      changed = true;
      const { syncError: _syncError, ...hosted } = playlist.hosted;
      return {
        ...playlist,
        hosted: { ...hosted, syncState: "queued" as const },
      };
    });
    if (changed) void this.#worker.kick().catch(() => undefined);
    return changed ? { ...response, items } : response;
  }

  #handleJobChanged(job: {
    playlistId: string;
    provider: HostedPlaylistProvider;
    payload: Record<string, unknown>;
  }): void {
    const payloadPlaylistId = job.payload.hostedPlaylistId;
    const playlistId = job.playlistId.startsWith("hosted:")
      ? job.playlistId
      : typeof payloadPlaylistId === "string" && payloadPlaylistId.startsWith("hosted:")
        ? payloadPlaylistId
        : hostedPlaylistId(job.provider, job.playlistId);
    this.#playlistCache = undefined;
    this.#trackCache.delete(playlistId);
    for (const listener of this.#jobListeners) {
      try {
        listener({ playlistId });
      } catch {
        // One observer must not interrupt durable queue progress or other observers.
      }
    }
  }
}

class UnavailableHostedPlaylistAdapter implements HostedPlaylistProviderAdapter {
  readonly provider: HostedPlaylistProvider;
  readonly #reason: string;

  constructor(provider: HostedPlaylistProvider, reason: string) {
    this.provider = provider;
    this.#reason = reason;
  }

  listPlaylists(): Promise<HostedAdapterListResult> {
    return Promise.reject(new Error(this.#reason));
  }

  getTracks(): Promise<TrackSummary[]> {
    return Promise.reject(new Error(this.#reason));
  }

  createPlaylist(): Promise<never> {
    return Promise.reject(new Error(this.#reason));
  }

  renamePlaylist(): Promise<never> {
    return Promise.reject(new Error(this.#reason));
  }

  replacePlaylistTracks(): Promise<never> {
    return Promise.reject(new Error(this.#reason));
  }

  deletePlaylist(): Promise<never> {
    return Promise.reject(new Error(this.#reason));
  }
}

async function createSpotifyAdapter(): Promise<HostedPlaylistProviderAdapter> {
  const store = new SpotifyFileSessionStore();
  const session = await store.load();
  if (!session) throw new Error("Spotify login required; run `music spots auth login`");
  const client = new SpotifyClient({
    auth: new SpotifyOAuth({
      clientId: session.clientId,
      redirectUri: session.redirectUri,
      store,
      ...(process.env.SPOTIFY_CLIENT_SECRET
        ? { clientSecret: process.env.SPOTIFY_CLIENT_SECRET }
        : {}),
    }),
  });
  return new SpotifyHostedPlaylistAdapter(client);
}

async function createSoundCloudAdapter(): Promise<HostedPlaylistProviderAdapter> {
  const client = await createSoundCloudUserClient({
    clientSecret: process.env.SOUNDCLOUD_CLIENT_SECRET,
  });
  return new SoundCloudHostedPlaylistAdapter(client);
}

function loadWorkspaceEnvironment(): void {
  const candidates = [
    resolve(import.meta.dirname, "../../../..", ".env"),
    resolve(process.cwd(), ".env"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path) process.loadEnvFile(path);
}

function positiveDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError("Cache duration must be a non-negative integer");
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
