import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import { analyzeTracks } from "@gakonst/rekordbox/analyzer";
import {
  SoulseekLibraryAcquirer,
  YtdlpNativeAcquirer,
  acquireManifest,
  analyzeExistingManifest,
  buildAcquisitionPlan,
  buildProviderPlaylistManifest as createProviderPlaylistManifest,
  defaultTrackLibraryRoot,
  importManifestToRekordbox,
  writeManifestAtomic,
  type AcquireFailure,
  type AcquireManifestOptions,
  type AcquisitionPlan,
  type AnalyzeExistingManifestOptions,
  type BuildAcquisitionPlanOptions,
  type ImportManifestToRekordboxOptions,
  type ProviderPlaylistManifestInput,
  type SetManifest,
  type SoulseekLibraryClient,
  type TrackAcquirer,
} from "@gakonst/tracks";

import type {
  HostedPlaylistProvider,
  HostedTrackDownloadState,
  TrackSummary,
} from "../shared/types.js";
import type {
  HostedJobStatus,
  HostedPlaylistJob,
  HostedPlaylistStateStore,
} from "./hosted-state.js";
import { hostedPlaylistId, parseHostedPlaylistId } from "./hosted/ids.js";

export type HostedAcquisitionCatalog = {
  getTracks(playlistId: string): Promise<TrackSummary[]>;
};

/** Structural job/state subset implemented by HostedPlaylistStateStore. */
export type HostedAcquisitionStateStore = Pick<
  HostedPlaylistStateStore,
  | "claimNextJob"
  | "getJob"
  | "getPlaylist"
  | "getTrack"
  | "setTrack"
  | "updateJob"
  | "updatePlaylistSync"
> & {
  readonly path?: string;
};

export type HostedDownloadJobPayload = {
  /** Human-readable provider playlist name. */
  playlistName?: string;
  /** Exact public provider playlist URL when available. */
  externalUrl?: string;
  owner?: string;
  revision?: string;
  /** Per-job import override. False downloads and analyzes without touching Rekordbox. */
  importToRekordbox?: boolean;
  folderName?: string;
};

export type HostedRekordboxImportOptions = {
  enabled: boolean;
  dbPath?: string;
  dbDirectory?: string;
  key?: string;
  backupRoot?: string;
  folderNames?: Partial<Record<HostedPlaylistProvider, string>>;
};

export type HostedAcquirerBundle = {
  acquirers: TrackAcquirer[];
  close?: () => void | Promise<void>;
};

export type HostedAcquirerFactory = (
  signal: AbortSignal,
) => HostedAcquirerBundle | Promise<HostedAcquirerBundle>;

type HostedAcquireResult = {
  manifest: SetManifest;
  failures: AcquireFailure[];
};

type HostedAnalyzeResult = {
  manifest: SetManifest;
  analysisDirectories: Record<string, string>;
};

export type HostedAnalyzeTrackOptions = {
  audioPath: string;
  signal: AbortSignal;
};

type HostedImportResult = {
  playlistId: string;
  imported: Array<{ entryId: string; contentId: string }>;
};

export type HostedAcquisitionDependencies = {
  createManifest(input: ProviderPlaylistManifestInput): SetManifest;
  writeManifest(path: string, manifest: SetManifest): Promise<void>;
  buildPlan(manifest: SetManifest, options: BuildAcquisitionPlanOptions): Promise<AcquisitionPlan>;
  acquire(options: AcquireManifestOptions): Promise<HostedAcquireResult>;
  analyzeTrack(options: HostedAnalyzeTrackOptions): Promise<void>;
  analyze(options: AnalyzeExistingManifestOptions): Promise<HostedAnalyzeResult>;
  importRekordbox(options: ImportManifestToRekordboxOptions): Promise<HostedImportResult>;
};

export type HostedPlaylistAcquisitionWorkerOptions = {
  state: HostedAcquisitionStateStore;
  catalog: HostedAcquisitionCatalog;
  /** Durable manifest root. Defaults beside the hosted-state SQLite database. */
  stateRoot?: string;
  /** Canonical recording root. Defaults to MUSIC_LIBRARY_ROOT or ~/.djtools/tracks. */
  outputDirectory?: string;
  localDirectories?: readonly string[];
  acquisitionConcurrency?: number;
  analysisConcurrency?: number;
  rekordbox?: HostedRekordboxImportOptions;
  acquirers?: readonly TrackAcquirer[];
  createAcquirers?: HostedAcquirerFactory;
  dependencies?: Partial<HostedAcquisitionDependencies>;
  onJobChanged?: (job: HostedPlaylistJob) => void;
};

const defaultDependencies: HostedAcquisitionDependencies = {
  createManifest: createProviderPlaylistManifest,
  writeManifest: writeManifestAtomic,
  buildPlan: buildAcquisitionPlan,
  acquire: acquireManifest,
  async analyzeTrack({ audioPath, signal }) {
    await analyzeTracks([audioPath], { concurrency: 1, signal });
  },
  analyze: analyzeExistingManifest,
  importRekordbox: importManifestToRekordbox,
};

/**
 * Durable, one-job-at-a-time hosted-playlist acquisition worker.
 *
 * The state database owns queue recovery. This worker owns no provider credentials or media state;
 * every restart claims the next queued job, refetches its playlist, and resumes from durable media.
 */
export class HostedPlaylistAcquisitionWorker {
  readonly #state: HostedAcquisitionStateStore;
  readonly #catalog: HostedAcquisitionCatalog;
  readonly #stateRoot: string;
  readonly #outputDirectory: string;
  readonly #localDirectories: readonly string[];
  readonly #acquisitionConcurrency: number;
  readonly #analysisConcurrency: number;
  readonly #rekordbox: HostedRekordboxImportOptions;
  readonly #acquirers: readonly TrackAcquirer[] | undefined;
  readonly #createAcquirers: HostedAcquirerFactory;
  readonly #dependencies: HostedAcquisitionDependencies;
  readonly #onJobChanged: ((job: HostedPlaylistJob) => void) | undefined;

  #started = false;
  #closing = false;
  #closed = false;
  #kickRequested = false;
  #drain: Promise<void> | undefined;
  #current:
    | {
        controller: AbortController;
        jobId: string;
        phase: "provider" | "acquisition" | "analysis" | "import";
        trackIds: string[];
      }
    | undefined;
  readonly #cancelled = new Set<string>();

  constructor(options: HostedPlaylistAcquisitionWorkerOptions) {
    if (options.acquirers && options.createAcquirers) {
      throw new TypeError("Configure acquirers or createAcquirers, not both");
    }
    this.#state = options.state;
    this.#catalog = options.catalog;
    this.#stateRoot = resolve(
      options.stateRoot ??
        (options.state.path
          ? join(dirname(options.state.path), "hosted-acquisition")
          : (() => {
              throw new TypeError("stateRoot is required when the state store has no path");
            })()),
    );
    this.#outputDirectory = resolve(options.outputDirectory ?? defaultTrackLibraryRoot());
    this.#localDirectories = (options.localDirectories ?? []).map((path) => resolve(path));
    this.#acquisitionConcurrency = positiveInteger(
      options.acquisitionConcurrency,
      3,
      "acquisitionConcurrency",
    );
    this.#analysisConcurrency = positiveInteger(
      options.analysisConcurrency,
      4,
      "analysisConcurrency",
    );
    this.#rekordbox = options.rekordbox ?? { enabled: false };
    this.#acquirers = options.acquirers;
    this.#createAcquirers = options.createAcquirers ?? createDefaultHostedAcquirers;
    this.#dependencies = { ...defaultDependencies, ...options.dependencies };
    this.#onJobChanged = options.onJobChanged;
  }

  get currentJobId(): string | undefined {
    return this.#current?.jobId;
  }

  /** Begin draining jobs recovered or queued in HostedPlaylistStateStore. Idempotent. */
  start(): void {
    if (this.#closed) throw new Error("Hosted playlist acquisition worker is closed");
    if (this.#started) return;
    this.#started = true;
    void this.kick();
  }

  /** Promptly drain all currently queued work. Concurrent calls share the same serial loop. */
  kick(): Promise<void> {
    if (this.#closed || this.#closing || !this.#started) return Promise.resolve();
    this.#kickRequested = true;
    if (!this.#drain) {
      const running = this.#drainJobs();
      let wrapped: Promise<void>;
      wrapped = running.finally(() => {
        if (this.#drain === wrapped) this.#drain = undefined;
        if (this.#kickRequested && this.#started && !this.#closing && !this.#closed) {
          void this.kick();
        }
      });
      this.#drain = wrapped;
    }
    return this.#drain;
  }

  /** Cancel queued/running acquisition. The final atomic Rekordbox import is never interrupted. */
  cancel(jobId: string): boolean {
    const job = this.#state.getJob(jobId);
    if (!job || isTerminal(job.status)) return false;
    if (job.status === "queued") {
      this.#emit(this.#state.updateJob(job.id, { status: "cancelled", error: null }));
      return true;
    }
    if (this.#current?.jobId !== job.id || this.#current.phase === "import") return false;
    this.#cancelled.add(job.id);
    this.#current.controller.abort(
      new DOMException("Hosted playlist download cancelled", "AbortError"),
    );
    return true;
  }

  /** Stop accepting work. In-flight network/analysis work returns to the durable queue. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    if (this.#current && this.#current.phase !== "import") {
      this.#current.controller.abort(
        new DOMException("Hosted playlist acquisition worker closed", "AbortError"),
      );
    }
    await this.#drain;
    this.#started = false;
    this.#closed = true;
    this.#closing = false;
  }

  async #drainJobs(): Promise<void> {
    while (this.#started && !this.#closing) {
      this.#kickRequested = false;
      const job = this.#state.claimNextJob();
      if (!job) {
        if (this.#kickRequested) continue;
        return;
      }
      this.#emit(job);
      await this.#runClaimedJob(job);
    }
  }

  async #runClaimedJob(job: HostedPlaylistJob): Promise<void> {
    const controller = new AbortController();
    this.#current = { controller, jobId: job.id, phase: "provider", trackIds: [] };
    try {
      await this.#processJob(job, controller.signal);
      if (this.#cancelled.has(job.id)) {
        this.#emit(this.#state.updateJob(job.id, { status: "cancelled", error: null }));
      } else {
        this.#emit(this.#state.updateJob(job.id, { status: "completed", error: null }));
      }
    } catch (error) {
      const message = errorMessage(error);
      if (this.#cancelled.has(job.id)) {
        this.#emit(this.#state.updateJob(job.id, { status: "cancelled", error: null }));
        this.#updateSyncAfterInterruption(job, "idle");
        this.#resetInterruptedTracks(job, "remote", null);
      } else if (this.#closing) {
        this.#emit(this.#state.updateJob(job.id, { status: "queued", error: null }));
        this.#updateSyncAfterInterruption(job, "queued");
        this.#resetInterruptedTracks(job, "queued", null);
      } else {
        this.#emit(this.#state.updateJob(job.id, { status: "failed", error: message }));
        try {
          const reference = jobReference(job);
          this.#state.updatePlaylistSync(reference.provider, reference.remoteId, {
            state: "error",
            error: message,
          });
        } catch {
          // The invalid durable job itself is already marked failed.
        }
        this.#resetInterruptedTracks(job, "error", message);
      }
    } finally {
      this.#cancelled.delete(job.id);
      if (this.#current?.jobId === job.id) this.#current = undefined;
    }
  }

  async #processJob(job: HostedPlaylistJob, signal: AbortSignal): Promise<void> {
    const reference = jobReference(job);
    const configured = this.#state.getPlaylist(reference.provider, reference.remoteId);
    if (configured && !configured.downloadEnabled) {
      this.#cancelled.add(job.id);
      return;
    }
    const payload = readPayload(job.payload);
    this.#state.updatePlaylistSync(reference.provider, reference.remoteId, {
      ...(payload.revision ? { revision: payload.revision } : {}),
      state: "syncing",
      error: null,
    });

    const tracks = await abortable(
      this.#catalog.getTracks(hostedPlaylistId(reference.provider, reference.remoteId)),
      signal,
    );
    signal.throwIfAborted();
    this.#current!.trackIds = tracks.map((track) => requireRemoteTrack(track, reference.provider));
    this.#emit(this.#state.updateJob(job.id, { current: 0, total: tracks.length, error: null }));
    for (const track of tracks) {
      const remoteTrackId = requireRemoteTrack(track, reference.provider);
      this.#state.setTrack(reference.provider, remoteTrackId, {
        state: "queued",
        error: null,
      });
    }

    const manifestPath = hostedPlaylistManifestPath(
      this.#stateRoot,
      reference.provider,
      reference.remoteId,
    );
    const manifest = acquisitionPlanningManifest(
      reference.provider,
      this.#manifest(reference.provider, reference.remoteId, payload, tracks),
    );
    manifest.artifacts.root = dirname(manifestPath);
    manifest.artifacts.manifest = manifestPath;
    manifest.artifacts.downloadDirectory = this.#outputDirectory;
    await this.#dependencies.writeManifest(manifestPath, manifest);
    signal.throwIfAborted();

    const plan = await this.#dependencies.buildPlan(manifest, {
      outputDirectory: this.#outputDirectory,
      localDirectories: this.#localDirectories,
      stagingDirectory: join(dirname(manifestPath), ".staging"),
    });
    const physicalPlan = deduplicateProviderRecordings(reference.provider, tracks, plan);
    installProviderPreferredCandidates(reference.provider, manifest, physicalPlan.plan);
    signal.throwIfAborted();

    this.#current!.phase = "acquisition";
    const bundle: HostedAcquirerBundle = this.#acquirers
      ? { acquirers: [...this.#acquirers] }
      : await this.#createAcquirers(signal);
    const completedOrders = new Set<number>();
    const analyzeTrack = createTaskLimiter(this.#analysisConcurrency);
    let acquisition: HostedAcquireResult;
    try {
      acquisition = await this.#dependencies.acquire({
        manifestPath,
        plan: physicalPlan.plan,
        refreshSpotify: false,
        acquirers: bundle.acquirers,
        // The durable manifest retains every playlist membership. Exact repeated provider tracks
        // intentionally share one physical acquisition plan entry and are fanned out below.
        requireCompletePlan: false,
        continueOnError: true,
        concurrency: this.#acquisitionConcurrency,
        signal,
        onProgress: (progress) => {
          if (progress.phase !== "recording" && progress.phase !== "clip") return;
          const track = tracks[progress.entryOrder - 1];
          if (!track?.hosted) return;
          this.#state.setTrack(reference.provider, track.hosted.remoteId, {
            state: "downloading",
            error: null,
          });
        },
        onArtifactVerified: async (artifact) => {
          for (const order of physicalPlan.memberOrders(artifact.entryOrder)) {
            const track = tracks[order - 1];
            if (!track?.hosted) continue;
            this.#state.setTrack(reference.provider, track.hosted.remoteId, {
              state: "downloaded",
              error: null,
            });
          }
          // Start native Rekordbox analysis as soon as this verified recording is durable. The
          // manifest-level pass below reuses these cache artifacts to checkpoint the analysis
          // ledger and produce the path-to-analysis-directory map used by import.
          await analyzeTrack(() =>
            this.#dependencies.analyzeTrack({ audioPath: artifact.path, signal }),
          );
          for (const order of physicalPlan.memberOrders(artifact.entryOrder)) {
            completedOrders.add(order);
          }
          this.#emit(
            this.#state.updateJob(job.id, {
              current: Math.min(completedOrders.size, tracks.length),
              total: tracks.length,
            }),
          );
        },
      });
    } finally {
      try {
        await bundle.close?.();
      } catch {
        // Acquisition result is authoritative; cleanup must not rewrite its durable outcome.
      }
    }
    signal.throwIfAborted();

    if (physicalPlan.hasDuplicates) {
      acquisition = fanOutProviderRecordingResults(acquisition, physicalPlan);
      await this.#dependencies.writeManifest(manifestPath, acquisition.manifest);
      signal.throwIfAborted();
    }

    const failedOrders = new Map(
      acquisition.failures.map((failure) => [failure.entryOrder, failure]),
    );
    const downloadedOrders = downloadedEntryOrders(acquisition.manifest);
    for (const [index, track] of tracks.entries()) {
      const remoteTrackId = requireRemoteTrack(track, reference.provider);
      const order = index + 1;
      if (downloadedOrders.has(order)) {
        this.#state.setTrack(reference.provider, remoteTrackId, {
          state: "downloaded",
          error: null,
        });
      } else {
        this.#state.setTrack(reference.provider, remoteTrackId, {
          state: "error",
          error: failedOrders.get(order)?.message ?? "Track was not acquired",
        });
      }
    }
    this.#emit(
      this.#state.updateJob(job.id, {
        current: downloadedOrders.size,
        total: tracks.length,
      }),
    );

    let analyzedManifest = acquisition.manifest;
    let analysisDirectories: Record<string, string> = {};
    if (downloadedOrders.size > 0) {
      this.#current!.phase = "analysis";
      const analyzed = await this.#dependencies.analyze({
        manifestPath,
        concurrency: this.#analysisConcurrency,
        signal,
      });
      analyzedManifest = analyzed.manifest;
      analysisDirectories = analyzed.analysisDirectories;
    }
    signal.throwIfAborted();

    if (downloadedOrders.size !== tracks.length || acquisition.failures.length > 0) {
      throw new Error(
        acquisitionFailureMessage(tracks.length, downloadedOrders.size, acquisition.failures),
      );
    }

    let localPlaylistId: string | null | undefined;
    if (this.#shouldImport(payload)) {
      this.#current!.phase = "import";
      const imported = await this.#dependencies.importRekordbox({
        approved: true,
        manifest: analyzedManifest,
        manifestPath,
        folderName:
          payload.folderName ??
          this.#rekordbox.folderNames?.[reference.provider] ??
          providerLabel(reference.provider),
        playlistName: payload.playlistName ?? reference.remoteId,
        ...(configured?.localPlaylistId ? { playlistId: configured.localPlaylistId } : {}),
        analysisDirectories,
        ...(this.#rekordbox.dbPath ? { dbPath: this.#rekordbox.dbPath } : {}),
        ...(this.#rekordbox.dbDirectory ? { dbDirectory: this.#rekordbox.dbDirectory } : {}),
        ...(this.#rekordbox.key ? { key: this.#rekordbox.key } : {}),
        ...(this.#rekordbox.backupRoot ? { backupRoot: this.#rekordbox.backupRoot } : {}),
      });
      localPlaylistId = imported.playlistId;
      const entryOrders = new Map(analyzedManifest.entries.map((entry) => [entry.id, entry.order]));
      for (const item of imported.imported) {
        const entryOrder = entryOrders.get(item.entryId);
        const track = entryOrder === undefined ? undefined : tracks[entryOrder - 1];
        if (!track?.hosted) continue;
        this.#state.setTrack(reference.provider, track.hosted.remoteId, {
          localContentId: item.contentId,
          state: "downloaded",
          error: null,
        });
      }
    }

    this.#state.updatePlaylistSync(reference.provider, reference.remoteId, {
      ...(payload.revision ? { revision: payload.revision } : {}),
      ...(localPlaylistId === undefined ? {} : { localPlaylistId }),
      state: "idle",
      error: null,
    });
  }

  #manifest(
    provider: HostedPlaylistProvider,
    remoteId: string,
    payload: HostedDownloadJobPayload,
    tracks: readonly TrackSummary[],
  ): SetManifest {
    const common = {
      provider,
      id: remoteId,
      title: payload.playlistName ?? remoteId,
      url: payload.externalUrl ?? defaultPlaylistUrl(provider, remoteId),
      ...(payload.owner ? { owner: payload.owner } : {}),
    };
    const input: ProviderPlaylistManifestInput =
      provider === "spotify"
        ? {
            ...common,
            provider,
            tracks: tracks.map((track, index) => spotifyManifestTrack(track, index)),
          }
        : {
            ...common,
            provider,
            tracks: tracks.map((track, index) => soundCloudManifestTrack(track, index)),
          };
    return this.#dependencies.createManifest(input);
  }

  #shouldImport(payload: HostedDownloadJobPayload): boolean {
    return this.#rekordbox.enabled && payload.importToRekordbox !== false;
  }

  #resetInterruptedTracks(
    job: HostedPlaylistJob,
    state: HostedTrackDownloadState,
    error: string | null,
  ): void {
    try {
      const reference = jobReference(job);
      const remoteTrackIds = new Set([
        ...(this.#current?.jobId === job.id ? this.#current.trackIds : []),
        ...tracksFromPayload(job.payload),
      ]);
      for (const remoteTrackId of remoteTrackIds) {
        const prior = this.#state.getTrack(reference.provider, remoteTrackId);
        if (prior && prior.downloadState !== "queued" && prior.downloadState !== "downloading") {
          continue;
        }
        this.#state.setTrack(reference.provider, remoteTrackId, { state, error });
      }
    } catch {
      // Invalid job references have no safe provider track key to update.
    }
  }

  #updateSyncAfterInterruption(job: HostedPlaylistJob, state: "idle" | "queued"): void {
    try {
      const reference = jobReference(job);
      this.#state.updatePlaylistSync(reference.provider, reference.remoteId, {
        state,
        error: null,
      });
    } catch {
      // Invalid job references have no safe provider playlist key to update.
    }
  }

  #emit(job: HostedPlaylistJob): void {
    if (!this.#onJobChanged) return;
    try {
      this.#onJobChanged(job);
    } catch {
      // Observability cannot own queue correctness.
    }
  }
}

/** Stable, traversal-safe manifest location for a provider playlist. */
export function hostedPlaylistManifestPath(
  stateRoot: string,
  provider: HostedPlaylistProvider,
  remoteId: string,
): string {
  const digest = createHash("sha256").update(remoteId).digest("hex").slice(0, 20);
  return join(resolve(stateRoot), "playlists", provider, digest, "manifest.json");
}

/** Default ordered backend set: Soulseek first, then the typed native ytdlp implementation. */
export async function createDefaultHostedAcquirers(
  signal: AbortSignal,
): Promise<HostedAcquirerBundle> {
  let client: (SoulseekLibraryClient & { disconnect?(): Promise<void> }) | undefined;
  try {
    // Kept lazy so merely browsing hosted playlists never initializes networking.
    const moduleName = "slsk-ts";
    const slsk = (await import(moduleName)) as unknown as {
      SoulseekClient: new () => SoulseekLibraryClient & { disconnect?(): Promise<void> };
    };
    client = new slsk.SoulseekClient();
  } catch (error) {
    if (!isMissingSlskModule(error)) throw error;
  }
  return {
    acquirers: [
      new SoulseekLibraryAcquirer(client, { signal }),
      new YtdlpNativeAcquirer({ signal }),
    ],
    ...(client?.disconnect
      ? {
          close: async () => {
            await client!.disconnect!();
          },
        }
      : {}),
  };
}

function spotifyManifestTrack(track: TrackSummary, index: number) {
  const remoteId = requireRemoteTrack(track, "spotify");
  const id = remoteId.replace(/^spotify:track:/u, "");
  if (!id || id === remoteId) throw new TypeError(`Invalid Spotify track URI: ${remoteId}`);
  return {
    provider: "spotify" as const,
    order: index + 1,
    id,
    uri: remoteId,
    url: track.hosted?.externalUrl ?? `https://open.spotify.com/track/${encodeURIComponent(id)}`,
    title: track.title,
    artists: [track.artist ?? "Unknown Artist"],
    ...(track.album ? { album: track.album } : {}),
    ...(track.hosted?.albumArtists ? { albumArtists: track.hosted.albumArtists } : {}),
    ...(track.hosted?.releaseDate ? { releaseDate: track.hosted.releaseDate } : {}),
    ...(track.hosted?.isrc ? { isrc: track.hosted.isrc } : {}),
    ...(track.hosted?.explicit === undefined ? {} : { explicit: track.hosted.explicit }),
    ...(durationMs(track.durationSeconds) === undefined
      ? {}
      : { durationMs: durationMs(track.durationSeconds)! }),
  };
}

function soundCloudManifestTrack(track: TrackSummary, index: number) {
  const remoteId = requireRemoteTrack(track, "soundcloud");
  const permalinkUrl = track.hosted?.externalUrl;
  if (!permalinkUrl) {
    throw new TypeError(`SoundCloud track ${remoteId} has no downloadable permalink`);
  }
  return {
    provider: "soundcloud" as const,
    order: index + 1,
    urn: remoteId,
    permalinkUrl,
    title: track.title,
    artists: [track.artist ?? "Unknown Artist"],
    ...(track.album ? { album: track.album } : {}),
    ...(track.hosted?.isrc ? { isrc: track.hosted.isrc } : {}),
    ...(durationMs(track.durationSeconds) === undefined
      ? {}
      : { durationMs: durationMs(track.durationSeconds)! }),
  };
}

function acquisitionPlanningManifest(
  provider: HostedPlaylistProvider,
  manifest: SetManifest,
): SetManifest {
  if (provider !== "soundcloud") return manifest;
  const planned = structuredClone(manifest);
  for (const entry of planned.entries) {
    if (entry.spotify.status === "pending") {
      entry.spotify = {
        status: "unmatched",
        query:
          entry.spotify.query ??
          (entry.identity.status === "identified"
            ? entry.identity.searchQuery
            : `SoundCloud track ${String(entry.order)}`),
      };
    }
  }
  return planned;
}

function installProviderPreferredCandidates(
  provider: HostedPlaylistProvider,
  manifest: SetManifest,
  plan: AcquisitionPlan,
): void {
  if (provider !== "soundcloud") return;
  const entries = new Map(manifest.entries.map((entry) => [entry.order, entry]));
  for (const recording of plan.recordings) {
    const selected = entries.get(recording.entryOrder)?.acquisition;
    if (!selected || (selected.status !== "selected" && selected.status !== "downloaded")) continue;
    const candidate = selected.status === "selected" ? selected.selected : selected.selected;
    if (!candidate || candidate.backend !== "ytdlp") continue;
    for (const variant of recording.variants) {
      variant.preferredCandidate = {
        id: soundCloudExtractorId(candidate.id),
        source: candidate.source,
        title: candidate.title,
        ...(candidate.artist ? { artist: candidate.artist } : {}),
        ...(candidate.durationSeconds === undefined
          ? {}
          : { durationSeconds: candidate.durationSeconds }),
        backend: "ytdlp",
      };
      variant.preferredCandidatePlacement = "backend-fallback";
    }
  }
}

type ProviderPhysicalPlan = {
  plan: AcquisitionPlan;
  groups: ReadonlyMap<number, readonly number[]>;
  hasDuplicates: boolean;
  memberOrders(canonicalOrder: number): readonly number[];
};

/**
 * Collapse exact repeated provider track IDs to one physical recording operation.
 *
 * The full manifest remains untouched: its entries are playlist memberships, not physical files.
 * Only the acquisition plan is collapsed, using the first planned occurrence as the canonical
 * recording. Different provider IDs are never collapsed, even when their text metadata matches.
 */
function deduplicateProviderRecordings(
  provider: HostedPlaylistProvider,
  tracks: readonly TrackSummary[],
  plan: AcquisitionPlan,
): ProviderPhysicalPlan {
  const plannedOrders = new Set<number>();
  for (const item of [...plan.clips, ...plan.recordings]) {
    if (plannedOrders.has(item.entryOrder)) {
      throw new Error(`Hosted acquisition plan repeats entry order ${String(item.entryOrder)}`);
    }
    plannedOrders.add(item.entryOrder);
  }

  const trackOrdersByRemoteId = new Map<string, number[]>();
  tracks.forEach((track, index) => {
    const remoteId = requireRemoteTrack(track, provider);
    const orders = trackOrdersByRemoteId.get(remoteId) ?? [];
    orders.push(index + 1);
    trackOrdersByRemoteId.set(remoteId, orders);
  });
  for (const order of plannedOrders) {
    if (order < 1 || order > tracks.length) {
      throw new Error(`Hosted acquisition plan references absent entry order ${String(order)}`);
    }
  }

  const groups = new Map<number, readonly number[]>();
  const retainedOrders = new Set<number>();
  for (const [remoteId, orders] of trackOrdersByRemoteId) {
    const canonicalOrder = orders.find((order) => plannedOrders.has(order));
    if (canonicalOrder === undefined) {
      throw new Error(`Hosted ${provider} track ${remoteId} has no acquisition plan entry`);
    }
    retainedOrders.add(canonicalOrder);
    groups.set(canonicalOrder, orders);
  }

  const physicalPlan: AcquisitionPlan = {
    ...plan,
    clips: plan.clips.filter((clip) => retainedOrders.has(clip.entryOrder)),
    recordings: plan.recordings.filter((recording) => retainedOrders.has(recording.entryOrder)),
  };
  return {
    plan: physicalPlan,
    groups,
    hasDuplicates: [...groups.values()].some((orders) => orders.length > 1),
    memberOrders(canonicalOrder) {
      return groups.get(canonicalOrder) ?? [canonicalOrder];
    },
  };
}

function fanOutProviderRecordingResults(
  acquisition: HostedAcquireResult,
  physicalPlan: ProviderPhysicalPlan,
): HostedAcquireResult {
  const entriesByOrder = new Map(acquisition.manifest.entries.map((entry) => [entry.order, entry]));
  for (const [canonicalOrder, memberOrders] of physicalPlan.groups) {
    const canonical = entriesByOrder.get(canonicalOrder);
    if (!canonical) {
      throw new Error(`Acquisition result has no canonical entry order ${String(canonicalOrder)}`);
    }
    const acquisitionErrors = canonical.errors.filter((error) => error.stage === "acquisition");
    for (const order of memberOrders) {
      if (order === canonicalOrder) continue;
      const member = entriesByOrder.get(order);
      if (!member)
        throw new Error(`Acquisition result has no duplicate entry order ${String(order)}`);
      member.acquisition = structuredClone(canonical.acquisition);
      member.errors = [
        ...member.errors.filter((error) => error.stage !== "acquisition"),
        ...structuredClone(acquisitionErrors),
      ];
      for (const warning of canonical.warnings) {
        if (!member.warnings.includes(warning)) member.warnings.push(warning);
      }
    }
  }

  const failures = acquisition.failures.flatMap((failure) =>
    physicalPlan.memberOrders(failure.entryOrder).map((entryOrder) => ({ ...failure, entryOrder })),
  );
  return { manifest: acquisition.manifest, failures };
}

function downloadedEntryOrders(manifest: SetManifest): Set<number> {
  return new Set(
    manifest.entries
      .filter((entry) => entry.acquisition.status === "downloaded")
      .map((entry) => entry.order),
  );
}

function jobReference(job: HostedPlaylistJob): {
  provider: HostedPlaylistProvider;
  remoteId: string;
} {
  if (job.playlistId.startsWith("hosted:")) {
    const parsed = parseHostedPlaylistId(job.playlistId);
    if (parsed.provider !== job.provider) {
      throw new TypeError(
        `Hosted job provider ${job.provider} does not match playlist ${job.playlistId}`,
      );
    }
    return parsed;
  }
  if (!job.playlistId.trim()) throw new TypeError("Hosted job playlist ID must not be empty");
  return { provider: job.provider, remoteId: job.playlistId.trim() };
}

function readPayload(payload: Record<string, unknown>): HostedDownloadJobPayload {
  return {
    ...optionalPayloadString(payload, "playlistName"),
    ...optionalPayloadString(payload, "externalUrl"),
    ...optionalPayloadString(payload, "owner"),
    ...optionalPayloadString(payload, "revision"),
    ...optionalPayloadString(payload, "folderName"),
    ...(typeof payload.importToRekordbox === "boolean"
      ? { importToRekordbox: payload.importToRekordbox }
      : {}),
  };
}

function optionalPayloadString(
  payload: Record<string, unknown>,
  key: "playlistName" | "externalUrl" | "owner" | "revision" | "folderName",
): Partial<Record<typeof key, string>> {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? { [key]: value.trim() } : {};
}

function tracksFromPayload(payload: Record<string, unknown>): string[] {
  const value = payload.remoteTrackIds;
  return Array.isArray(value)
    ? value.filter((track): track is string => typeof track === "string" && track.length > 0)
    : [];
}

function requireRemoteTrack(track: TrackSummary, provider: HostedPlaylistProvider): string {
  if (!track.hosted || track.hosted.provider !== provider || !track.hosted.remoteId.trim()) {
    throw new TypeError(`Hosted ${provider} playlist returned a non-${provider} track`);
  }
  return track.hosted.remoteId.trim();
}

function defaultPlaylistUrl(provider: HostedPlaylistProvider, remoteId: string): string {
  if (provider === "spotify") {
    return `https://open.spotify.com/playlist/${encodeURIComponent(remoteId)}`;
  }
  const id = remoteId.replace(/^soundcloud:playlists:/u, "");
  return `https://api.soundcloud.com/playlists/${encodeURIComponent(id)}`;
}

function soundCloudExtractorId(remoteId: string): string {
  return remoteId.replace(/^soundcloud:tracks:/u, "");
}

function durationMs(seconds: number | null): number | undefined {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const milliseconds = Math.round(seconds * 1_000);
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

function acquisitionFailureMessage(
  total: number,
  completed: number,
  failures: readonly AcquireFailure[],
): string {
  const detail = failures
    .slice(0, 3)
    .map((failure) => `#${String(failure.entryOrder)} ${failure.message}`)
    .join("; ");
  return `Hosted playlist acquired ${String(completed)}/${String(total)} tracks${detail ? `: ${detail}` : ""}`;
}

function providerLabel(provider: HostedPlaylistProvider): string {
  return provider === "spotify" ? "Spotify" : "SoundCloud";
}

function isTerminal(status: HostedJobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return resolved;
}

function createTaskLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = (): void => {
    const next = queue.shift();
    if (next) next();
    else active -= 1;
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < concurrency) active += 1;
    else await new Promise<void>((resolve) => queue.push(resolve));
    try {
      return await task();
    } finally {
      release();
    }
  };
}

function isMissingSlskModule(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
  );
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const aborted = () => rejectPromise(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void operation.then(resolvePromise, rejectPromise).finally(() => {
      signal.removeEventListener("abort", aborted);
    });
  });
}
