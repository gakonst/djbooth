import { randomUUID } from "node:crypto";
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
  LibraryMutation,
  HostedPlaylistMutation,
  HostedPlaylistProvider,
  HostedPlaylistsResponse,
  PlaylistItem,
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
import {
  HostedPlaylistCapabilityError,
  HostedPlaylistConflictError,
  HostedPlaylistVerificationError,
  type HostedAdapterListResult,
  type HostedPlaylistProviderAdapter,
  type HostedTrackStream,
  type HostedTrackStreamRequest,
  errorMessage as hostedErrorMessage,
} from "./hosted/types.js";
import type { HostedPlaylistApi, LibraryApi } from "./server.js";

export type DefaultHostedPlaylistRuntimeOptions = {
  statePath?: string;
  playlistCacheMs?: number;
  playlistRetryCacheMs?: number;
  trackCacheMs?: number;
  writeEnabled?: boolean;
  dbPath?: string;
  key?: string;
};

export type HostedPlaylistRuntimeCatalog = Pick<
  HostedPlaylistCatalog,
  "getTracks" | "listPlaylists" | "mutate" | "streamTrack"
> &
  Partial<Pick<HostedPlaylistCatalog, "refreshPlaylistState" | "refreshTrackState">>;

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
  playlistRetryCacheMs?: number;
  trackCacheMs?: number;
  acquisition?: Omit<HostedPlaylistAcquisitionWorkerOptions, "catalog" | "onJobChanged" | "state">;
  createAcquisitionWorker?: HostedAcquisitionWorkerFactory;
  outboxMaxAttempts?: number;
  outboxRetryBaseMs?: number;
  outboxRetryMaxMs?: number;
};

const OUTBOX_REVISION_PREFIX = "local-outbox:";
const LOCAL_MIRROR_OUTBOX_PREFIX = "local-mirror:";
const REMOTE_PLAYLIST_CACHE_KEY = "remote:hosted-playlists";
const REMOTE_CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1_000;
type QueuedHostedPlaylistMutation = Exclude<
  HostedPlaylistMutation,
  { type: "create-hosted-playlist" | "set-hosted-playlist-download" }
>;

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
    playlistRetryCacheMs: options.playlistRetryCacheMs,
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
  readonly #playlistRetryCacheMs: number;
  readonly #trackCacheMs: number;
  readonly #outboxMaxAttempts: number;
  readonly #outboxRetryBaseMs: number;
  readonly #outboxRetryMaxMs: number;
  readonly #jobListeners = new Set<(event: { playlistId: string }) => void>();
  #playlistCache: { expiresAt: number; promise: Promise<HostedPlaylistsResponse> } | undefined;
  #playlistRefresh: Promise<void> | undefined;
  #playlistSuccess: HostedPlaylistsResponse | undefined;
  readonly #trackCache = new Map<string, { expiresAt: number; promise: Promise<TrackSummary[]> }>();
  readonly #trackRefreshes = new Map<string, Promise<void>>();
  #playlistStateDirty = false;
  readonly #trackStateDirty = new Set<string>();
  #outboxDrain: Promise<void> | undefined;
  #outboxRetryAt = 0;
  #outboxRetryTimer: ReturnType<typeof setTimeout> | undefined;
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: HostedPlaylistRuntimeOptions) {
    this.#catalog = options.catalog;
    this.#state = options.state;
    this.#playlistCacheMs = positiveDuration(options.playlistCacheMs, 30 * 60_000);
    this.#playlistRetryCacheMs = positiveDuration(options.playlistRetryCacheMs, 5_000);
    this.#trackCacheMs = positiveDuration(options.trackCacheMs, 30 * 60_000);
    this.#outboxMaxAttempts = positiveInteger(options.outboxMaxAttempts, 4, "Outbox attempts");
    this.#outboxRetryBaseMs = positiveDuration(options.outboxRetryBaseMs, 250);
    this.#outboxRetryMaxMs = positiveDuration(options.outboxRetryMaxMs, 5_000);
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
    const persisted = this.#state.getWebCache<HostedPlaylistsResponse>(REMOTE_PLAYLIST_CACHE_KEY, {
      allowExpired: true,
      maxStaleMs: REMOTE_CACHE_STALE_MS,
    });
    if (persisted && isHostedPlaylistsResponse(persisted.value))
      this.#playlistSuccess = persisted.value;
    void this.#kickOutbox().catch(() => undefined);
  }

  listPlaylists(): Promise<HostedPlaylistsResponse> {
    const now = Date.now();
    const cached = this.#playlistCache;
    if (cached) {
      const promise = this.#refreshCachedPlaylistState(cached);
      if (cached.expiresAt <= now) this.#startPlaylistRefresh();
      return promise;
    }
    const persisted = this.#state.getWebCache<HostedPlaylistsResponse>(REMOTE_PLAYLIST_CACHE_KEY, {
      allowExpired: true,
      maxStaleMs: REMOTE_CACHE_STALE_MS,
    });
    if (persisted && isHostedPlaylistsResponse(persisted.value)) {
      this.#playlistSuccess = persisted.value;
      const promise = (
        this.#catalog.refreshPlaylistState
          ? this.#catalog.refreshPlaylistState(persisted.value)
          : Promise.resolve(persisted.value)
      ).then((response) => this.#scheduleChangedDownloads(response));
      this.#playlistCache = { expiresAt: persisted.expiresAt, promise };
      if (persisted.expiresAt <= now) this.#startPlaylistRefresh();
      return promise;
    }
    this.#playlistStateDirty = false;
    let promise: Promise<HostedPlaylistsResponse>;
    promise = this.#fetchPlaylists()
      .then((fresh) => {
        if (this.#playlistCache?.promise !== promise) return fresh;
        const { response, ttlMs } = this.#acceptPlaylists(fresh);
        if (this.#playlistCache?.promise === promise) {
          this.#playlistCache.expiresAt = Date.now() + ttlMs;
        }
        return response;
      })
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
    if (cached) {
      const promise = this.#refreshCachedTrackState(playlistId, cached);
      if (cached.expiresAt <= now) this.#startTrackRefresh(playlistId);
      return promise;
    }
    const persistentKey = remoteTrackCacheKey(playlistId);
    const persisted = this.#state.getWebCache<TrackSummary[]>(persistentKey, {
      allowExpired: true,
      maxStaleMs: REMOTE_CACHE_STALE_MS,
    });
    if (persisted && Array.isArray(persisted.value)) {
      const promise = this.#catalog.refreshTrackState
        ? this.#catalog.refreshTrackState(playlistId, persisted.value)
        : Promise.resolve(persisted.value);
      this.#trackCache.set(playlistId, { expiresAt: persisted.expiresAt, promise });
      if (persisted.expiresAt <= now) this.#startTrackRefresh(playlistId);
      return promise;
    }
    this.#trackStateDirty.delete(playlistId);
    const promise = this.#catalog
      .getTracks(playlistId)
      .then((tracks) => {
        this.#cacheWebResponse(persistentKey, tracks, this.#trackCacheMs);
        return tracks;
      })
      .catch((error: unknown) => {
        if (this.#trackCache.get(playlistId)?.promise === promise)
          this.#trackCache.delete(playlistId);
        throw error;
      });
    this.#trackCache.set(playlistId, { expiresAt: now + this.#trackCacheMs, promise });
    return promise;
  }

  streamTrack(trackId: string, request: HostedTrackStreamRequest = {}): Promise<HostedTrackStream> {
    return this.#catalog.streamTrack(trackId, request);
  }

  /** Mirror an already-committed local playlist edit through the durable provider outbox. */
  mirrorLocalMutation(
    mutation: LibraryMutation,
    library: Pick<LibraryApi, "getTracks">,
  ): HostedMutationReceipt | undefined {
    if (mutation.type === "delete-playlist") {
      this.#detachDeletedLocalPlaylists(new Set(mutation.expectedPlaylistIds));
      return undefined;
    }
    const localPlaylistId = localPlaylistMutationId(mutation);
    if (!localPlaylistId) return undefined;

    let configured;
    try {
      configured = this.#state.getPlaylistByLocalId(localPlaylistId);
    } catch (error) {
      // Ambiguous legacy mappings have no safe provider target. Mark every candidate, change none.
      for (const candidate of this.#state.listPlaylists()) {
        if (candidate.localPlaylistId !== localPlaylistId) continue;
        this.#state.updatePlaylistSync(candidate.provider, candidate.remoteId, {
          state: "error",
          error: hostedErrorMessage(error),
        });
        this.#emitPlaylistChanged(hostedPlaylistId(candidate.provider, candidate.remoteId));
      }
      return undefined;
    }
    if (!configured) return undefined;

    const playlistId = hostedPlaylistId(configured.provider, configured.remoteId);
    try {
      const pending = this.#state.getLatestPendingMutation(playlistId);
      const expectedRevision = pending ? outboxRevision(pending.id) : configured.revision;
      const hostedMutation: QueuedHostedPlaylistMutation =
        mutation.type === "rename-playlist"
          ? {
              type: "rename-hosted-playlist",
              playlistId,
              name: mutation.name,
              expectedRevision,
            }
          : {
              type: "replace-hosted-playlist-tracks",
              playlistId,
              remoteTrackIds: this.#remoteTrackIdsForLocalPlaylist(
                configured.provider,
                localPlaylistId,
                library,
              ),
              expectedRevision,
            };
      const receipt = this.#enqueueProviderMutation(
        hostedMutation,
        `${LOCAL_MIRROR_OUTBOX_PREFIX}${randomUUID()}`,
      );
      this.#emitPlaylistChanged(playlistId);
      return receipt;
    } catch (error) {
      this.#state.updatePlaylistSync(configured.provider, configured.remoteId, {
        state: "error",
        error: hostedErrorMessage(error),
      });
      this.#invalidateHostedPlaylist(playlistId);
      this.#emitPlaylistChanged(playlistId);
      return undefined;
    }
  }

  onJobChanged(listener: (event: { playlistId: string }) => void): () => void {
    this.#jobListeners.add(listener);
    return () => this.#jobListeners.delete(listener);
  }

  async mutate(mutation: HostedPlaylistMutation): Promise<HostedMutationReceipt> {
    if (
      mutation.type !== "set-hosted-playlist-download" &&
      mutation.type !== "create-hosted-playlist"
    ) {
      return this.#enqueueProviderMutation(mutation);
    }
    const priorPlaylists = this.#playlistCache?.promise;
    const receipt = await this.#catalog.mutate(mutation);
    this.#playlistCache = undefined;
    this.#playlistRefresh = undefined;
    this.#state.deleteWebCache(REMOTE_PLAYLIST_CACHE_KEY);
    this.#playlistStateDirty = false;
    if ("playlistId" in mutation) {
      this.#trackCache.delete(mutation.playlistId);
      this.#trackRefreshes.delete(mutation.playlistId);
      this.#state.deleteWebCache(remoteTrackCacheKey(mutation.playlistId));
    }
    if ("playlistId" in mutation) this.#trackStateDirty.delete(mutation.playlistId);
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
    }
    return receipt;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closing = true;
    if (this.#outboxRetryTimer) clearTimeout(this.#outboxRetryTimer);
    this.#outboxRetryTimer = undefined;
    this.#jobListeners.clear();
    this.#trackCache.clear();
    this.#trackRefreshes.clear();
    this.#trackStateDirty.clear();
    this.#playlistCache = undefined;
    this.#playlistRefresh = undefined;
    this.#playlistSuccess = undefined;
    this.#playlistStateDirty = false;
    try {
      await this.#outboxDrain;
      await this.#worker.close();
    } finally {
      this.#state.close();
    }
  }

  #enqueueProviderMutation(
    mutation: Exclude<
      HostedPlaylistMutation,
      { type: "create-hosted-playlist" | "set-hosted-playlist-download" }
    >,
    dedupeKey = `provider-write:${randomUUID()}`,
  ): HostedMutationReceipt {
    const reference = parseHostedPlaylistId(mutation.playlistId);
    const entry = this.#state.enqueueMutation(mutation, dedupeKey);
    const stored = this.#state.getPlaylist(reference.provider, reference.remoteId);
    this.#state.updatePlaylistSync(reference.provider, reference.remoteId, {
      ...(!stored && mutation.expectedRevision !== null
        ? { revision: mutation.expectedRevision }
        : {}),
      state: "queued",
      error: null,
    });
    this.#invalidateHostedPlaylist(mutation.playlistId);
    this.#requestOutboxKick();
    return {
      operation: mutation.type,
      playlistId: mutation.playlistId,
      revision: outboxRevision(entry.id),
      queuedAt: entry.createdAt,
    };
  }

  #requestOutboxKick(): void {
    void this.#kickOutbox()
      .catch(() => undefined)
      .finally(() => {
        // Covers enqueueing in the tiny window after an empty drain resolves but before cleanup.
        if (!this.#closing) void this.#kickOutbox().catch(() => undefined);
      });
  }

  #kickOutbox(): Promise<void> {
    if (this.#closing) return Promise.resolve();
    const remainingDelay = this.#outboxRetryAt - Date.now();
    if (remainingDelay > 0) {
      this.#scheduleOutboxRetry(remainingDelay);
      return this.#outboxDrain ?? Promise.resolve();
    }
    if (!this.#outboxDrain) {
      const running = this.#drainOutbox();
      let wrapped: Promise<void>;
      wrapped = running.finally(() => {
        if (this.#outboxDrain === wrapped) this.#outboxDrain = undefined;
      });
      this.#outboxDrain = wrapped;
    }
    return this.#outboxDrain;
  }

  async #drainOutbox(): Promise<void> {
    while (!this.#closing) {
      const entry = this.#state.claimNextMutation();
      if (!entry) return;
      const playlistId = entry.playlistId;
      try {
        const mutation = this.#resolveOutboxRevision(
          requireQueuedHostedMutation(entry.mutation),
          entry.id,
        );
        const receipt = await this.#catalog.mutate(mutation);
        await this.#finishProviderMutation(
          mutation,
          receipt,
          entry.dedupeKey.startsWith(LOCAL_MIRROR_OUTBOX_PREFIX),
        );
        this.#state.completeMutation(entry.id);
      } catch (error) {
        const retry = shouldRetryOutboxMutation(error, entry.attempts, this.#outboxMaxAttempts);
        this.#state.failMutation(entry.id, hostedErrorMessage(error), retry);
        if (playlistId) {
          const { provider, remoteId } = parseHostedPlaylistId(playlistId);
          this.#state.updatePlaylistSync(provider, remoteId, {
            state: retry ? "queued" : "error",
            error: hostedErrorMessage(error),
          });
          this.#invalidateHostedPlaylist(playlistId);
          this.#emitPlaylistChanged(playlistId);
        }
        if (retry) {
          const delay = Math.min(
            this.#outboxRetryMaxMs,
            this.#outboxRetryBaseMs * 2 ** Math.max(0, entry.attempts - 1),
          );
          this.#outboxRetryAt = Date.now() + delay;
          this.#scheduleOutboxRetry(delay);
          return;
        }
      }
    }
  }

  #resolveOutboxRevision(
    mutation: QueuedHostedPlaylistMutation,
    entryId: string,
  ): QueuedHostedPlaylistMutation {
    const dependencyId = parseOutboxRevision(mutation.expectedRevision);
    if (!dependencyId) return mutation;
    if (dependencyId !== entryId) {
      const dependency = this.#state.getOutbox(dependencyId);
      if (dependency?.status === "failed") {
        throw new HostedMutationDependencyError(dependencyId, dependency.error);
      }
      if (dependency) {
        throw new Error(`Hosted mutation dependency ${dependencyId} has not completed`);
      }
    }
    const { provider, remoteId } = parseHostedPlaylistId(mutation.playlistId);
    return {
      ...mutation,
      expectedRevision: this.#state.getPlaylist(provider, remoteId)?.revision ?? null,
    };
  }

  async #finishProviderMutation(
    mutation: QueuedHostedPlaylistMutation,
    receipt: HostedMutationReceipt,
    skipConfiguredDownload = false,
  ): Promise<void> {
    const playlistId = receipt.playlistId;
    const { provider, remoteId } = parseHostedPlaylistId(playlistId);
    if (mutation.type === "delete-hosted-playlist") {
      this.#state.setDownloadEnabled(provider, remoteId, false);
      this.#state.updatePlaylistSync(provider, remoteId, {
        revision: null,
        state: "idle",
        error: null,
      });
      const active = this.#state.getActiveDownload(provider, remoteId);
      if (active) this.#worker.cancel(active.id);
    } else {
      this.#state.updatePlaylistSync(provider, remoteId, {
        revision: receipt.revision,
        state: "idle",
        error: null,
      });
    }
    this.#invalidateHostedPlaylist(playlistId);
    this.#emitPlaylistChanged(playlistId);
    if (mutation.type === "replace-hosted-playlist-tracks" && !skipConfiguredDownload) {
      await this.#queueConfiguredDownload(playlistId, receipt.revision);
    }
  }

  #remoteTrackIdsForLocalPlaylist(
    provider: HostedPlaylistProvider,
    playlistId: string,
    library: Pick<LibraryApi, "getTracks">,
  ): string[] {
    const response = library.getTracks({
      playlistId,
      limit: 10_000,
      offset: 0,
      sort: { field: "position", direction: "asc" },
    });
    if (response.items.length !== response.count) {
      throw new Error(
        `Local playlist '${playlistId}' has ${String(response.count)} tracks; refusing a partial hosted replacement`,
      );
    }
    const mappings = new Map<string, Set<string>>();
    for (const mapping of this.#state.listTracksByLocalContentIds(
      provider,
      response.items.map((track) => track.id),
    )) {
      if (!mapping.localContentId) continue;
      const remoteIds = mappings.get(mapping.localContentId) ?? new Set<string>();
      remoteIds.add(mapping.remoteTrackId);
      mappings.set(mapping.localContentId, remoteIds);
    }
    return response.items.map((track) => {
      const remoteIds = mappings.get(track.id);
      if (!remoteIds?.size) {
        throw new Error(
          `Local track '${track.id}' has no ${provider} identity mapping; hosted playlist was not changed`,
        );
      }
      if (remoteIds.size !== 1) {
        throw new Error(
          `Local track '${track.id}' has multiple ${provider} identity mappings; hosted playlist was not changed`,
        );
      }
      return remoteIds.values().next().value!;
    });
  }

  #detachDeletedLocalPlaylists(localPlaylistIds: ReadonlySet<string>): void {
    for (const configured of this.#state.listPlaylists()) {
      if (!configured.localPlaylistId || !localPlaylistIds.has(configured.localPlaylistId))
        continue;
      this.#state.updatePlaylistSync(configured.provider, configured.remoteId, {
        localPlaylistId: null,
      });
      const playlistId = hostedPlaylistId(configured.provider, configured.remoteId);
      this.#invalidateHostedPlaylist(playlistId);
      this.#emitPlaylistChanged(playlistId);
    }
  }

  async #queueConfiguredDownload(playlistId: string, revision: string | null): Promise<void> {
    const { provider, remoteId } = parseHostedPlaylistId(playlistId);
    if (!this.#state.getPlaylist(provider, remoteId)?.downloadEnabled) return;
    let playlist: PlaylistItem | undefined;
    try {
      playlist = (await this.#catalog.listPlaylists()).items.find(
        (candidate) => candidate.id === playlistId,
      );
    } catch {
      // Metadata is optional; acquisition re-fetches the authoritative track list.
    }
    this.#state.updatePlaylistSync(provider, remoteId, {
      revision,
      state: "queued",
      error: null,
    });
    this.#state.enqueueDownload(provider, remoteId, {
      hostedPlaylistId: playlistId,
      ...(playlist ? { playlistName: playlist.name } : {}),
      ...(playlist?.hosted?.externalUrl ? { externalUrl: playlist.hosted.externalUrl } : {}),
      ...(revision ? { revision } : {}),
    });
    void this.#worker.kick().catch(() => undefined);
  }

  #scheduleOutboxRetry(delay: number): void {
    if (this.#closing || this.#outboxRetryTimer) return;
    this.#outboxRetryTimer = setTimeout(() => {
      this.#outboxRetryTimer = undefined;
      this.#outboxRetryAt = 0;
      void this.#kickOutbox();
    }, delay);
    this.#outboxRetryTimer.unref?.();
  }

  #refreshCachedPlaylistState(cached: {
    expiresAt: number;
    promise: Promise<HostedPlaylistsResponse>;
  }): Promise<HostedPlaylistsResponse> {
    if (!this.#playlistStateDirty || !this.#catalog.refreshPlaylistState) return cached.promise;
    this.#playlistStateDirty = false;
    const promise = cached.promise
      .then((response) => this.#catalog.refreshPlaylistState!(response))
      .catch((error: unknown) => {
        if (this.#playlistCache?.promise === promise) this.#playlistCache = undefined;
        throw error;
      });
    this.#playlistCache = { ...cached, promise };
    return promise;
  }

  #fetchPlaylists(): Promise<HostedPlaylistsResponse> {
    return this.#catalog.listPlaylists();
  }

  #acceptPlaylists(fresh: HostedPlaylistsResponse): {
    response: HostedPlaylistsResponse;
    ttlMs: number;
  } {
    const degraded = fresh.providers.some((provider) => !provider.connected);
    const merged = mergeHostedProviderFallbacks(fresh, this.#playlistSuccess);
    const response = this.#scheduleChangedDownloads(merged);
    this.#playlistSuccess = successfulHostedProviderSnapshot(
      response,
      fresh,
      this.#playlistSuccess,
    );
    if (this.#playlistSuccess.items.length || this.#playlistSuccess.providers.length)
      this.#cacheWebResponse(
        REMOTE_PLAYLIST_CACHE_KEY,
        this.#playlistSuccess,
        this.#playlistCacheMs,
      );
    return {
      response,
      ttlMs: degraded ? this.#playlistRetryCacheMs : this.#playlistCacheMs,
    };
  }

  #startPlaylistRefresh(): void {
    if (this.#playlistRefresh || this.#closing) return;
    let refresh: Promise<void>;
    refresh = this.#fetchPlaylists()
      .then((fresh) => {
        if (this.#playlistRefresh !== refresh) return;
        const { response, ttlMs } = this.#acceptPlaylists(fresh);
        this.#playlistCache = {
          expiresAt: Date.now() + ttlMs,
          promise: Promise.resolve(response),
        };
      })
      .catch(() => {
        if (this.#playlistRefresh === refresh && this.#playlistCache)
          this.#playlistCache.expiresAt = Date.now() + this.#playlistRetryCacheMs;
      })
      .finally(() => {
        if (this.#playlistRefresh === refresh) this.#playlistRefresh = undefined;
      });
    this.#playlistRefresh = refresh;
  }

  #refreshCachedTrackState(
    playlistId: string,
    cached: { expiresAt: number; promise: Promise<TrackSummary[]> },
  ): Promise<TrackSummary[]> {
    if (!this.#trackStateDirty.has(playlistId) || !this.#catalog.refreshTrackState)
      return cached.promise;
    this.#trackStateDirty.delete(playlistId);
    const promise = cached.promise
      .then((tracks) => this.#catalog.refreshTrackState!(playlistId, tracks))
      .catch((error: unknown) => {
        if (this.#trackCache.get(playlistId)?.promise === promise)
          this.#trackCache.delete(playlistId);
        throw error;
      });
    this.#trackCache.set(playlistId, { ...cached, promise });
    return promise;
  }

  #startTrackRefresh(playlistId: string): void {
    if (this.#trackRefreshes.has(playlistId) || this.#closing) return;
    let refresh: Promise<void>;
    refresh = this.#catalog
      .getTracks(playlistId)
      .then((tracks) => {
        if (this.#trackRefreshes.get(playlistId) !== refresh) return;
        this.#cacheWebResponse(remoteTrackCacheKey(playlistId), tracks, this.#trackCacheMs);
        this.#trackCache.set(playlistId, {
          expiresAt: Date.now() + this.#trackCacheMs,
          promise: Promise.resolve(tracks),
        });
      })
      .catch(() => {
        if (this.#trackRefreshes.get(playlistId) !== refresh) return;
        const cached = this.#trackCache.get(playlistId);
        if (cached) cached.expiresAt = Date.now() + this.#playlistRetryCacheMs;
      })
      .finally(() => {
        if (this.#trackRefreshes.get(playlistId) === refresh)
          this.#trackRefreshes.delete(playlistId);
      });
    this.#trackRefreshes.set(playlistId, refresh);
  }

  #cacheWebResponse(key: string, value: unknown, ttlMs: number): void {
    try {
      this.#state.setWebCache(key, value, ttlMs);
    } catch {
      // A cache quota/serialization failure must not hide a successful provider response.
    }
  }

  #invalidateHostedPlaylist(playlistId: string): void {
    this.#playlistCache = undefined;
    this.#playlistRefresh = undefined;
    this.#state.deleteWebCache(REMOTE_PLAYLIST_CACHE_KEY);
    this.#playlistStateDirty = false;
    this.#trackCache.delete(playlistId);
    this.#trackRefreshes.delete(playlistId);
    this.#state.deleteWebCache(remoteTrackCacheKey(playlistId));
    this.#trackStateDirty.delete(playlistId);
  }

  #emitPlaylistChanged(playlistId: string): void {
    for (const listener of this.#jobListeners) {
      try {
        listener({ playlistId });
      } catch {
        // One observer must not interrupt durable queue progress or other observers.
      }
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
    const playlistCache = this.#playlistCache;
    if (playlistCache && this.#catalog.refreshPlaylistState) {
      this.#playlistStateDirty = true;
    } else {
      this.#playlistCache = undefined;
      this.#playlistStateDirty = false;
    }
    const trackCache = this.#trackCache.get(playlistId);
    if (trackCache && this.#catalog.refreshTrackState) {
      this.#trackStateDirty.add(playlistId);
    } else {
      this.#trackCache.delete(playlistId);
      this.#trackStateDirty.delete(playlistId);
    }
    this.#emitPlaylistChanged(playlistId);
  }
}

class HostedMutationDependencyError extends Error {
  constructor(dependencyId: string, reason: string | null) {
    super(
      `Hosted mutation depends on failed mutation ${dependencyId}${reason ? `: ${reason}` : ""}`,
    );
    this.name = "HostedMutationDependencyError";
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

function mergeHostedProviderFallbacks(
  fresh: HostedPlaylistsResponse,
  successful: HostedPlaylistsResponse | undefined,
): HostedPlaylistsResponse {
  if (!successful) return fresh;
  const successfulStatuses = new Map(
    successful.providers
      .filter((status) => status.connected)
      .map((status) => [status.provider, status] as const),
  );
  const fallbackProviders = new Set(
    fresh.providers
      .filter((status) => !status.connected && successfulStatuses.has(status.provider))
      .map((status) => status.provider),
  );
  if (!fallbackProviders.size) return fresh;

  const items = fresh.providers.flatMap((status) =>
    hostedProviderItems(
      fallbackProviders.has(status.provider) ? successful : fresh,
      status.provider,
    ),
  );
  const knownProviders = new Set(fresh.providers.map((status) => status.provider));
  items.push(
    ...fresh.items.filter((item) => !item.hosted || !knownProviders.has(item.hosted.provider)),
  );
  return {
    items,
    providers: fresh.providers.map((status) => {
      if (!fallbackProviders.has(status.provider)) return status;
      return {
        ...successfulStatuses.get(status.provider)!,
        error: status.error ?? "Provider temporarily unavailable; showing cached playlists",
      };
    }),
  };
}

function successfulHostedProviderSnapshot(
  response: HostedPlaylistsResponse,
  fresh: HostedPlaylistsResponse,
  previous: HostedPlaylistsResponse | undefined,
): HostedPlaylistsResponse {
  const freshStatuses = new Map(fresh.providers.map((status) => [status.provider, status]));
  const previousStatuses = new Map(
    (previous?.providers ?? [])
      .filter((status) => status.connected)
      .map((status) => [status.provider, status] as const),
  );
  const responseStatuses = new Map(response.providers.map((status) => [status.provider, status]));
  const providers: HostedPlaylistsResponse["providers"] = [];
  const items: PlaylistItem[] = [];
  const order = [
    ...fresh.providers.map((status) => status.provider),
    ...(previous?.providers.map((status) => status.provider) ?? []),
  ].filter((provider, index, values) => values.indexOf(provider) === index);

  for (const provider of order) {
    const freshStatus = freshStatuses.get(provider);
    if (freshStatus?.connected) {
      providers.push(responseStatuses.get(provider) ?? freshStatus);
      items.push(...hostedProviderItems(response, provider));
      continue;
    }
    const previousStatus = previousStatuses.get(provider);
    if (!previousStatus) continue;
    providers.push(previousStatus);
    items.push(...hostedProviderItems(response, provider));
  }
  return { items, providers };
}

function hostedProviderItems(
  response: HostedPlaylistsResponse,
  provider: HostedPlaylistProvider,
): PlaylistItem[] {
  return response.items.filter((item) => item.hosted?.provider === provider);
}

function remoteTrackCacheKey(playlistId: string): string {
  return `remote:hosted-tracks:${playlistId}`;
}

function isHostedPlaylistsResponse(value: unknown): value is HostedPlaylistsResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "items" in value &&
    Array.isArray(value.items) &&
    "providers" in value &&
    Array.isArray(value.providers)
  );
}

function positiveDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError("Cache duration must be a non-negative integer");
  return value;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${label} must be a positive integer`);
  return value;
}

function outboxRevision(entryId: string): string {
  return `${OUTBOX_REVISION_PREFIX}${entryId}`;
}

function parseOutboxRevision(revision: string | null): string | undefined {
  if (!revision?.startsWith(OUTBOX_REVISION_PREFIX)) return undefined;
  const entryId = revision.slice(OUTBOX_REVISION_PREFIX.length);
  return entryId || undefined;
}

function requireQueuedHostedMutation(
  mutation: HostedPlaylistMutation,
): QueuedHostedPlaylistMutation {
  if (
    mutation.type === "create-hosted-playlist" ||
    mutation.type === "set-hosted-playlist-download"
  ) {
    throw new HostedMutationDependencyError(
      "invalid-outbox-entry",
      `${mutation.type} cannot run through the provider-write outbox`,
    );
  }
  return mutation;
}

function localPlaylistMutationId(mutation: LibraryMutation): string | undefined {
  switch (mutation.type) {
    case "rename-playlist":
    case "add-track":
    case "remove-track":
    case "move-track":
    case "replace-playlist-tracks":
      return mutation.playlistId;
    default:
      return undefined;
  }
}

function shouldRetryOutboxMutation(error: unknown, attempts: number, maxAttempts: number): boolean {
  if (attempts >= maxAttempts) return false;
  if (
    error instanceof HostedMutationDependencyError ||
    error instanceof HostedPlaylistCapabilityError ||
    error instanceof HostedPlaylistConflictError ||
    error instanceof HostedPlaylistVerificationError
  ) {
    return false;
  }
  const status = httpStatus(error);
  return (
    status === undefined || status === 408 || status === 425 || status === 429 || status >= 500
  );
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
