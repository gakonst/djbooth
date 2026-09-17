import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";

import {
  acquirePipelineManifestLock,
  createSourceSetClip,
  retagAudio,
  scoreYoutubeCandidates,
  verifyAudioFile,
  writeManifestAtomic,
  type AudioMetadata,
  type ScoredYoutubeCandidate,
  type YoutubeSearchCandidate,
  type YoutubeTarget,
} from "./acquisition.js";
import type {
  AcquisitionBackend,
  AcquisitionCandidate,
  AcquisitionDownload,
  AcquisitionFallback,
  ResolvedTrack,
  SetManifest,
  SpotifyCandidate,
} from "./manifest.js";
import { parseManifest } from "./manifest.js";
import { JsonDiskCache, type CacheStats } from "./cache.js";

export type SpotifyLibraryClient = {
  raw<T = unknown>(
    method: string,
    path: string,
    options?: {
      query?: Record<string, string | number | boolean | readonly string[] | undefined>;
      signal?: AbortSignal;
    },
  ): Promise<T | undefined>;
  cacheStats?(): CacheStats | undefined;
};

export type BackendAvailability = { available: true } | { available: false; reason: string };

export type IndividualDownload = {
  path: string;
  source: string;
  engine?: "native" | "reference";
  fallback?: AcquisitionFallback;
  temporary?: boolean;
  qualityNote?: string;
  transcoded?: boolean;
};

export type AcquirerFailurePhase = "search" | "download";
export type AcquirerFallback = AcquisitionFallback;

export type TrackAcquirer = {
  backend: AcquisitionBackend;
  /** Delay search and download until an earlier acquirer reports a safe capability fallback. */
  requiresPriorCapabilityFailure?: boolean;
  availability(): Promise<BackendAvailability>;
  search(target: YoutubeTarget): Promise<YoutubeSearchCandidate[]>;
  download(
    candidate: ScoredYoutubeCandidate,
    destinationDirectory: string,
    basename: string,
  ): Promise<IndividualDownload>;
  /** Restrict delegation after an acquirer failure. Validation failures remain candidate-local. */
  shouldContinueAfterError?(
    error: unknown,
    phase: AcquirerFailurePhase,
  ): AcquirerFallback | false | undefined;
};

export type AcquisitionClipPlan = {
  entryOrder: number;
  sourcePath: string;
  sourceUrl: string;
  sourceTitle?: string;
  outputPath: string;
  startSeconds: number;
  endSeconds: number;
  metadata: AudioMetadata;
  qualityNote: string;
  containsTransitions: boolean;
};

export type AcquisitionRecordingVariant = {
  spotifyId?: string;
  isrc?: string;
  title: string;
  artists: string[];
  album?: string;
  albumArtists?: string[];
  label?: string;
  genre?: string;
  releaseDate?: string;
  durationMs?: number;
  outputPath: string;
  metadata: AudioMetadata;
  searchQuery?: string;
  preferredCandidate?: YoutubeSearchCandidate & { backend: AcquisitionBackend };
  /** Try an audited provider source after earlier backends (for example Soulseek) have failed. */
  preferredCandidatePlacement?: "first" | "backend-fallback";
  /** Explicit local source selected by the generic plan builder; retagged into outputPath. */
  localArtifact?: {
    sourcePath: string;
    matchedBy: "spotify-id" | "isrc" | "artist-title";
  };
  sourceClip?: {
    sourcePath: string;
    sourceUrl: string;
    sourceTitle?: string;
    startSeconds: number;
    endSeconds: number;
    qualityNote: string;
    containsTransitions: boolean;
  };
};

export type AcquisitionRecordingPlan = {
  entryOrder: number;
  variants: AcquisitionRecordingVariant[];
};

export type AcquisitionPlan = {
  clips: AcquisitionClipPlan[];
  recordings: AcquisitionRecordingPlan[];
  stagingDirectory: string;
  sourceSets?: Array<{
    path: string;
    sha256: string;
    durationSeconds: number;
    codec: string;
    bitrate: number;
  }>;
};

export type AcquireProgress =
  | { phase: "manifest" | "spotify" | "backend"; message: string }
  | { phase: "progress"; current: number; total: number; message: string }
  | {
      phase: "clip" | "recording";
      message: string;
      entryOrder: number;
      variant?: number;
      totalVariants?: number;
    };

export type AcquireFailure = {
  entryOrder: number;
  spotifyId?: string;
  message: string;
};

export type AcquisitionArtifactVerified = {
  entryOrder: number;
  variantIndex?: number;
  path: string;
  sha256: string;
  kind: "individual" | "source-set-clip";
  status: "downloaded" | "resumed";
};

export type AcquireManifestResult = {
  manifest: SetManifest;
  downloaded: string[];
  resumed: string[];
  failures: AcquireFailure[];
  unavailableBackends: Array<{ backend: AcquisitionBackend; reason: string }>;
  verification?: AcquisitionVerification;
  performance: AcquisitionPerformance;
};

export type AcquisitionPerformance = {
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  concurrency: number;
  verificationConcurrency: number;
  spotifyConcurrency: number;
  stages: Array<{
    stage: string;
    durationMs: number;
    operations?: number;
    requests?: number;
    maxConcurrency?: number;
  }>;
  checkpoints: {
    calls: number;
    flushes: number;
    writes: number;
    skipped: number;
    coalesced: number;
    durationMs: number;
  };
  caches?: Record<string, CacheStats>;
};

type AcquisitionVerificationReceipt = {
  sha256: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number | bigint;
};

export type AcquisitionVerification = {
  files: number;
  individualFiles: number;
  sourceSetClips: number;
  sha256Verified: number;
  metadataVerified: number;
};

/** Network-bound acquisition stays conservative; callers can explicitly raise the cap. */
export const DEFAULT_ACQUISITION_CONCURRENCY = 3;
export const MAX_ACQUISITION_CONCURRENCY = 8;
export const DEFAULT_VERIFICATION_CONCURRENCY = 8;
export const MAX_VERIFICATION_CONCURRENCY = 16;
export const DEFAULT_SPOTIFY_REFRESH_CONCURRENCY = 8;
export const MAX_SPOTIFY_REFRESH_CONCURRENCY = 32;

export type AcquireManifestOptions = {
  /** Legacy JSON checkpoint adapter. New callers persist state in Rekordbox master.db. */
  manifestPath?: string;
  /** Current database-backed pipeline state. */
  state?: SetManifest;
  /** Persist database-backed pipeline state after each completed artifact. */
  saveState?: (state: SetManifest) => Promise<void>;
  plan: AcquisitionPlan | ((manifest: SetManifest) => AcquisitionPlan | Promise<AcquisitionPlan>);
  prepare?: (manifest: SetManifest) => SetManifest | Promise<SetManifest>;
  spotify?: SpotifyLibraryClient;
  refreshSpotify?: boolean;
  acquirers: TrackAcquirer[];
  minimumScore?: number;
  requireCompletePlan?: boolean;
  dryRun?: boolean;
  continueOnError?: boolean;
  /** Global limit for independent recording variants, including ambiguity alternatives. Defaults to 3. */
  concurrency?: number;
  /** Parallel stat/hash/tag checks. Defaults to 8 and is independent of transfer concurrency. */
  verificationConcurrency?: number;
  /** Parallel Spotify single-track metadata requests. Defaults to 8; Spotify removed its batch endpoint. */
  spotifyConcurrency?: number;
  /** Optional stat-keyed cache for successful SHA/tag/duration verification receipts. */
  verificationCache?: JsonDiskCache | false;
  /** Cancels queued work and prevents new provider/download tasks from starting. */
  signal?: AbortSignal;
  onProgress?: (progress: AcquireProgress) => void;
  /** Starts downstream work as soon as one durable, verified artifact is ready. */
  onArtifactVerified?: (artifact: AcquisitionArtifactVerified) => void | Promise<void>;
};

/**
 * Resumable acquisition library entry point. It composes a long-lived Spotify client and ordered
 * download backends, persists after every completed artifact, and never shells out to their CLIs.
 */
export async function acquireManifest(
  options: AcquireManifestOptions,
): Promise<AcquireManifestResult> {
  const runStartedAt = new Date();
  const runStarted = performance.now();
  const stages: AcquisitionPerformance["stages"] = [];
  let checkpointMs = 0;
  let checkpointCalls = 0;
  let checkpointFlushes = 0;
  let checkpointWrites = 0;
  const artifactCallbacks = new Map<string, Promise<void>>();
  const artifactCallbackErrors: Error[] = [];
  const scheduleArtifactCallback = (artifact: AcquisitionArtifactVerified): void => {
    if (!options.onArtifactVerified || artifactCallbacks.has(artifact.path)) return;
    const callback = Promise.resolve()
      .then(() => options.onArtifactVerified!(artifact))
      .catch((cause: unknown) => {
        artifactCallbackErrors.push(
          new Error(
            `Verified-artifact callback failed for '${artifact.path}': ${errorMessage(cause)}`,
            {
              cause,
            },
          ),
        );
      });
    artifactCallbacks.set(artifact.path, callback);
  };
  const waitForArtifactCallbacks = async (): Promise<void> => {
    await Promise.all(artifactCallbacks.values());
    if (artifactCallbackErrors.length) {
      throw new AggregateError(
        artifactCallbackErrors,
        `Verified-artifact callbacks failed for ${String(artifactCallbackErrors.length)} track(s): ${artifactCallbackErrors.map((error) => error.message).join("; ")}`,
      );
    }
  };
  const measure = async <T>(
    stage: string,
    task: () => T | Promise<T>,
    details: Omit<AcquisitionPerformance["stages"][number], "stage" | "durationMs"> = {},
  ): Promise<T> => {
    const started = performance.now();
    try {
      return await task();
    } finally {
      stages.push({
        stage,
        durationMs: roundMilliseconds(performance.now() - started),
        ...details,
      });
    }
  };
  const concurrency = integerConcurrency(options.concurrency ?? DEFAULT_ACQUISITION_CONCURRENCY);
  const verificationConcurrency = boundedConcurrency(
    options.verificationConcurrency ?? DEFAULT_VERIFICATION_CONCURRENCY,
    "verificationConcurrency",
    MAX_VERIFICATION_CONCURRENCY,
  );
  const spotifyConcurrency = boundedConcurrency(
    options.spotifyConcurrency ?? DEFAULT_SPOTIFY_REFRESH_CONCURRENCY,
    "spotifyConcurrency",
    MAX_SPOTIFY_REFRESH_CONCURRENCY,
  );
  const verificationCache =
    options.verificationCache === false ? undefined : options.verificationCache;
  const verificationCacheBefore = verificationCache?.snapshot();
  const performanceResult = (): AcquisitionPerformance => ({
    startedAt: runStartedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    totalMs: roundMilliseconds(performance.now() - runStarted),
    concurrency,
    verificationConcurrency,
    spotifyConcurrency,
    stages,
    checkpoints: {
      calls: checkpointCalls,
      flushes: checkpointFlushes,
      writes: checkpointWrites,
      skipped: checkpointFlushes - checkpointWrites,
      coalesced: checkpointCalls - checkpointFlushes,
      durationMs: roundMilliseconds(checkpointMs),
    },
    ...(verificationCache
      ? {
          caches: { audio: cacheStatsDelta(verificationCache.snapshot(), verificationCacheBefore) },
        }
      : {}),
  });
  const manifestPath = options.manifestPath ? resolve(options.manifestPath) : undefined;
  if (!manifestPath && (!options.state || !options.saveState)) {
    throw new TypeError("Acquisition requires database state and saveState");
  }
  const release = manifestPath
    ? await measure("state-lock", () => acquirePipelineManifestLock(manifestPath))
    : () => Promise.resolve();
  try {
    let manifest = options.state
      ? parseManifest(structuredClone(options.state))
      : parseManifest(JSON.parse(await readFile(manifestPath!, "utf8")) as unknown);
    let expectedManifestContents = serializeManifest(manifest);
    let checkpointedManifest = structuredClone(manifest);
    type CheckpointWaiter = { resolve: () => void; reject: (error: unknown) => void };
    let pendingCheckpoints: CheckpointWaiter[] = [];
    let checkpointFlush: Promise<void> | undefined;
    const scheduleCheckpointFlush = (): void => {
      checkpointFlush ??= Promise.resolve()
        .then(flushCheckpoints)
        .finally(() => {
          checkpointFlush = undefined;
          if (pendingCheckpoints.length) scheduleCheckpointFlush();
        });
    };
    const flushCheckpoints = async (): Promise<void> => {
      while (pendingCheckpoints.length) {
        const waiters = pendingCheckpoints;
        pendingCheckpoints = [];
        const checkpointStarted = performance.now();
        checkpointFlushes += 1;
        invalidateChangedRekordboxState(checkpointedManifest, manifest);
        const snapshot = structuredClone(manifest);
        const serialized = serializeManifest(snapshot);
        try {
          if (serialized !== expectedManifestContents) {
            checkpointWrites += 1;
            if (options.saveState) await options.saveState(snapshot);
            else await writeManifestAtomic(manifestPath!, snapshot);
            expectedManifestContents = serialized;
          }
          checkpointedManifest = snapshot;
          for (const waiter of waiters) waiter.resolve();
        } catch (error) {
          for (const waiter of waiters) waiter.reject(error);
        } finally {
          checkpointMs += performance.now() - checkpointStarted;
        }
      }
    };
    const checkpoint = (mutate?: () => void): Promise<void> => {
      checkpointCalls += 1;
      mutate?.();
      const next = new Promise<void>((resolve, reject) => {
        pendingCheckpoints.push({ resolve, reject });
      });
      scheduleCheckpointFlush();
      return next;
    };
    if (options.prepare) {
      manifest = await measure("manifest-prepare", () => options.prepare!(manifest));
    }
    const downloaded: string[] = [];
    const resumed: string[] = [];
    const failures: AcquireFailure[] = [];
    const unavailableBackends: Array<{ backend: AcquisitionBackend; reason: string }> = [];
    const minimumScore = options.minimumScore ?? 0.78;
    if (!Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 1) {
      throw new RangeError("minimumScore must be between 0 and 1");
    }
    options.onProgress?.({ phase: "manifest", message: "Manifest loaded and reconciled" });

    if (options.spotify && options.refreshSpotify !== false) {
      options.onProgress?.({
        phase: "spotify",
        message: "Refreshing known tracks with one long-lived Spotify client",
      });
      try {
        const metrics: Omit<AcquisitionPerformance["stages"][number], "stage" | "durationMs"> = {};
        await measure(
          "spotify-refresh",
          async () => {
            const result = await refreshKnownSpotifyTracks(manifest, options.spotify!, {
              concurrency: spotifyConcurrency,
              ...(options.signal ? { signal: options.signal } : {}),
            });
            metrics.operations = result.ids;
            metrics.requests = result.networkRequests;
            metrics.maxConcurrency = result.maxConcurrency;
          },
          metrics,
        );
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const warning = `Spotify refresh failed; retained checkpointed metadata: ${errorMessage(error)}`;
        if (!manifest.warnings.includes(warning)) manifest.warnings.push(warning);
      }
    }

    const plan = await measure("acquisition-plan", async () =>
      typeof options.plan === "function" ? options.plan(manifest) : options.plan,
    );
    reconcileCheckpointedPlan(manifest, plan);
    validatePlan(manifest, plan, options.requireCompletePlan ?? false, true);
    if (options.dryRun) {
      invalidateChangedRekordboxState(checkpointedManifest, manifest);
      return {
        manifest,
        downloaded,
        resumed,
        failures,
        unavailableBackends,
        performance: performanceResult(),
      };
    }

    const verificationReceipts = await measure(
      "artifact-preflight",
      () =>
        preflightExistingArtifacts(
          manifest,
          plan,
          verificationConcurrency,
          verificationCache,
          options.signal,
        ),
      {
        operations: plannedArtifactCount(plan),
        maxConcurrency: Math.min(plannedArtifactCount(plan), verificationConcurrency),
      },
    );
    const plannedPaths = [
      ...plan.clips.map((clip) => clip.outputPath),
      ...plan.recordings.flatMap((recording) =>
        recording.variants.map((variant) => variant.outputPath),
      ),
    ];
    if (plannedPaths.every((path) => verificationReceipts.has(path))) {
      let verification: AcquisitionVerification | undefined;
      try {
        verification = await measure("resume-fast-path", () =>
          verifyAcquisitionPlan(manifest, plan, verificationReceipts, verificationConcurrency),
        );
      } catch {
        // Valid media without a complete manifest checkpoint falls through for reconciliation.
      }
      if (verification) {
        resumed.push(...plannedPaths);
        await checkpoint();
        for (const artifact of plannedArtifactEvents(plan, verificationReceipts, "resumed")) {
          scheduleArtifactCallback(artifact);
        }
        await waitForArtifactCallbacks();
        return {
          manifest,
          downloaded,
          resumed: resumed.toSorted(),
          failures,
          unavailableBackends,
          verification,
          performance: performanceResult(),
        };
      }
    }
    const missingSetClip = [
      ...plan.clips.map((clip) => clip.outputPath),
      ...plan.recordings.flatMap((recording) =>
        recording.variants.flatMap((variant) => (variant.sourceClip ? [variant.outputPath] : [])),
      ),
    ].some((path) => !verificationReceipts.has(path));
    if (missingSetClip) {
      await measure("source-set-verification", async () => {
        for (const source of plan.sourceSets ?? []) {
          const verified = await verifyAudioFile(source.path, {
            expectedSha256: source.sha256,
            expectedDurationSeconds: source.durationSeconds,
            durationToleranceSeconds: 0.1,
          });
          if (verified.probe.codec !== source.codec) {
            throw new Error(
              `Source-set codec mismatch for ${source.path}: expected ${source.codec}, got ${verified.probe.codec}`,
            );
          }
          if (verified.probe.bitrate !== source.bitrate) {
            throw new Error(
              `Source-set bitrate mismatch for ${source.path}: expected ${source.bitrate}, got ${String(verified.probe.bitrate)}`,
            );
          }
        }
      });
    }
    const localArtifactRejections = new Map<AcquisitionRecordingVariant, string>();
    const unverifiedLocalArtifacts = plan.recordings.flatMap((recording) =>
      recording.variants.filter(
        (variant) =>
          variant.localArtifact !== undefined && !verificationReceipts.has(variant.outputPath),
      ),
    );
    if (unverifiedLocalArtifacts.length) {
      await measure(
        "local-artifact-verification",
        () =>
          mapConcurrent(
            unverifiedLocalArtifacts,
            verificationConcurrency,
            async (variant) => {
              const localArtifact = variant.localArtifact!;
              try {
                await validateAcquiredSource(
                  {
                    path: localArtifact.sourcePath,
                    source: localArtifact.sourcePath,
                    temporary: false,
                  },
                  targetForVariant(variant),
                );
              } catch (error) {
                throwIfAcquisitionCancelled(options.signal, error);
                localArtifactRejections.set(
                  variant,
                  `${variantLabel(variant)} skipped local artifact matched by ${localArtifact.matchedBy} (${localArtifact.sourcePath}): ${errorMessage(error)}`,
                );
                delete variant.localArtifact;
              }
            },
            options.signal,
          ),
        {
          operations: unverifiedLocalArtifacts.length,
          maxConcurrency: Math.min(unverifiedLocalArtifacts.length, verificationConcurrency),
        },
      );
    }
    await checkpoint();

    const availableAcquirers: TrackAcquirer[] = [];
    const needsBackend = plan.recordings.some((recording) =>
      recording.variants.some(
        (variant) =>
          !variant.sourceClip &&
          !variant.localArtifact &&
          !verificationReceipts.has(variant.outputPath),
      ),
    );
    if (needsBackend) {
      await measure("backend-availability", async () => {
        const availability = await Promise.all(
          options.acquirers.map(async (acquirer) => ({
            acquirer,
            availability: await acquirer.availability(),
          })),
        );
        for (const result of availability) {
          if (result.availability.available) {
            availableAcquirers.push(result.acquirer);
          } else {
            unavailableBackends.push({
              backend: result.acquirer.backend,
              reason: result.availability.reason,
            });
            const warning = `${result.acquirer.backend} unavailable: ${result.availability.reason}`;
            if (!manifest.warnings.includes(warning)) manifest.warnings.push(warning);
            options.onProgress?.({ phase: "backend", message: warning });
          }
        }
      });
    }
    await checkpoint();

    await mkdir(plan.stagingDirectory, { recursive: true });
    type CompletedRecording = {
      download: AcquisitionDownload;
      candidate?: AcquisitionCandidate;
    };
    type RecordingState = {
      recording: AcquisitionRecordingPlan;
      entry: ResolvedTrack;
      priorAcquisition?: Extract<ResolvedTrack["acquisition"], { status: "downloaded" }>;
      priorDownloads: AcquisitionDownload[];
      completed: Map<number, CompletedRecording>;
      failed: Set<number>;
    };
    const recordingStates = new Map(
      plan.recordings.map((recording) => {
        const entry = structuredClone(requireEntry(manifest, recording.entryOrder));
        const priorAcquisition =
          entry.acquisition.status === "downloaded"
            ? structuredClone(entry.acquisition)
            : undefined;
        const state: RecordingState = {
          recording,
          entry,
          ...(priorAcquisition ? { priorAcquisition } : {}),
          priorDownloads: priorAcquisition
            ? [priorAcquisition.download, ...(priorAcquisition.alternatives ?? [])]
            : [],
          completed: new Map(),
          failed: new Set(),
        };
        return [recording.entryOrder, state] as const;
      }),
    );
    const recordingJobs = plan.recordings.flatMap((recording) =>
      recording.variants.map((variant, variantIndex) => ({
        recording,
        variant,
        variantIndex,
      })),
    );
    let activeClips = 0;
    let activeVariants = 0;
    let processed = 0;
    const total = plan.clips.length + recordingJobs.length;
    const reportProcessed = () =>
      options.onProgress?.({
        phase: "progress",
        current: processed,
        total,
        message: `${processed}/${total} recordings processed`,
      });
    reportProcessed();
    const clipMetrics: Omit<AcquisitionPerformance["stages"][number], "stage" | "durationMs"> = {
      operations: plan.clips.length,
      maxConcurrency: 0,
    };
    const recordingMetrics: Omit<AcquisitionPerformance["stages"][number], "stage" | "durationMs"> =
      { operations: recordingJobs.length, maxConcurrency: 0 };

    const clipsTask = measure(
      "clips",
      () =>
        mapConcurrent(
          plan.clips,
          concurrency,
          async (clip) => {
            activeClips += 1;
            clipMetrics.maxConcurrency = Math.max(clipMetrics.maxConcurrency ?? 0, activeClips);
            options.onProgress?.({
              phase: "clip",
              entryOrder: clip.entryOrder,
              message: `Extracting set cue ${clip.entryOrder}`,
            });
            try {
              let sha256 = verificationReceipts.get(clip.outputPath)?.sha256;
              if (sha256) {
                resumed.push(clip.outputPath);
              } else {
                const verified = await createSourceSetClip({
                  sourcePath: clip.sourcePath,
                  outputPath: clip.outputPath,
                  startSeconds: clip.startSeconds,
                  endSeconds: clip.endSeconds,
                  metadata: clip.metadata,
                });
                sha256 = verified.sha256;
                verificationReceipts.set(
                  clip.outputPath,
                  await verificationReceipt(clip.outputPath, sha256),
                );
                downloaded.push(clip.outputPath);
              }
              options.signal?.throwIfAborted();
              await checkpoint(() => {
                const entry = requireEntry(manifest, clip.entryOrder);
                entry.acquisition = clipState(clip, sha256);
                clearAcquisitionErrors(entry);
              });
              scheduleArtifactCallback({
                entryOrder: clip.entryOrder,
                path: clip.outputPath,
                sha256,
                kind: "source-set-clip",
                status: downloaded.includes(clip.outputPath) ? "downloaded" : "resumed",
              });
            } catch (error) {
              throwIfAcquisitionCancelled(options.signal, error);
              const failure = toFailure(clip.entryOrder, undefined, error);
              failures.push(failure);
              await checkpoint(() =>
                markFailure(requireEntry(manifest, clip.entryOrder), failure.message),
              );
              if (options.continueOnError === false) throw error;
            } finally {
              activeClips -= 1;
              processed += 1;
              reportProcessed();
            }
          },
          options.signal,
        ),
      clipMetrics,
    );

    const recordingsTask = measure(
      "recordings",
      () =>
        mapConcurrent(
          recordingJobs,
          concurrency,
          async ({ recording, variant, variantIndex }) => {
            activeVariants += 1;
            recordingMetrics.maxConcurrency = Math.max(
              recordingMetrics.maxConcurrency ?? 0,
              activeVariants,
            );
            const state = recordingStates.get(recording.entryOrder)!;
            options.onProgress?.({
              phase: "recording",
              entryOrder: recording.entryOrder,
              variant: variantIndex + 1,
              totalVariants: recording.variants.length,
              message: `Acquiring ${variant.artists.join(", ")} — ${variant.title}`,
            });
            try {
              const prior = priorDownloadForVariant(state.priorDownloads, variant);
              if (prior && prior.mediaPath !== variant.outputPath)
                variant.outputPath = prior.mediaPath;
              const receipt = verificationReceipts.get(variant.outputPath);
              let completed: CompletedRecording;
              const warnings: string[] = [];
              const target = targetForVariant(variant);
              const localArtifact = variant.localArtifact;
              const localArtifactRejection = localArtifactRejections.get(variant);
              if (localArtifactRejection) warnings.push(localArtifactRejection);
              if (receipt) {
                const priorCandidate = candidateFromDownload(
                  prior,
                  state.priorAcquisition,
                  variant,
                );
                completed = {
                  download:
                    prior ??
                    (variant.sourceClip
                      ? recordingClipDownload(variant, receipt.sha256)
                      : individualDownload(variant, variant.outputPath, receipt.sha256)),
                  ...(priorCandidate ? { candidate: priorCandidate } : {}),
                };
                resumed.push(variant.outputPath);
              } else if (
                prior &&
                (await isCheckpointedAudioIntact(prior, variant, verificationCache))
              ) {
                // Metadata schemas evolve independently of the recording bytes. Retag a verified
                // checkpoint in place instead of reacquiring the same audio from the network.
                const tagged = await retagAudio({
                  sourcePath: variant.outputPath,
                  outputPath: variant.outputPath,
                  metadata: variant.metadata,
                  ...(prior.backend === "local" || !prior.source
                    ? {}
                    : {
                        acquisitionSource: {
                          backend: prior.backend,
                          source: prior.source,
                        },
                      }),
                  ...(variant.durationMs === undefined
                    ? {}
                    : { expectedDurationSeconds: variant.durationMs / 1000 }),
                });
                verificationReceipts.set(
                  variant.outputPath,
                  await verificationReceipt(variant.outputPath, tagged.sha256),
                );
                const priorCandidate = candidateFromDownload(
                  prior,
                  state.priorAcquisition,
                  variant,
                );
                completed = {
                  download: { ...prior, sha256: tagged.sha256 },
                  ...(priorCandidate ? { candidate: priorCandidate } : {}),
                };
                warnings.push(`${variantLabel(variant)} refreshed embedded metadata`);
                downloaded.push(variant.outputPath);
              } else if (localArtifact) {
                const tagged = await retagAudio({
                  sourcePath: localArtifact.sourcePath,
                  outputPath: variant.outputPath,
                  metadata: variant.metadata,
                  audioCodec: retagCodecForSource(
                    localArtifact.sourcePath,
                    variant.outputPath,
                    "slsk",
                  ),
                  ...(variant.durationMs === undefined
                    ? {}
                    : { expectedDurationSeconds: variant.durationMs / 1000 }),
                });
                verificationReceipts.set(
                  variant.outputPath,
                  await verificationReceipt(variant.outputPath, tagged.sha256),
                );
                completed = {
                  download: {
                    backend: "local",
                    kind: "individual",
                    mediaPath: variant.outputPath,
                    files: [variant.outputPath],
                    source: localArtifact.sourcePath,
                    sha256: tagged.sha256,
                    ...(localArtifact.matchedBy !== "artist-title"
                      ? { variantKey: variantKey(variant) }
                      : {}),
                    ...(localArtifact.matchedBy !== "artist-title" && variant.spotifyId
                      ? { spotifyId: variant.spotifyId }
                      : {}),
                    ...(localArtifact.matchedBy !== "artist-title" && variant.isrc
                      ? { isrc: variant.isrc }
                      : {}),
                  },
                };
                warnings.push(
                  `${variantLabel(variant)} adopted local artifact matched by ${localArtifact.matchedBy}`,
                );
                downloaded.push(variant.outputPath);
              } else if (variant.sourceClip) {
                const clip = variant.sourceClip;
                const verified = await createSourceSetClip({
                  sourcePath: clip.sourcePath,
                  outputPath: variant.outputPath,
                  startSeconds: clip.startSeconds,
                  endSeconds: clip.endSeconds,
                  metadata: variant.metadata,
                });
                verificationReceipts.set(
                  variant.outputPath,
                  await verificationReceipt(variant.outputPath, verified.sha256),
                );
                completed = {
                  download: {
                    backend: "ytdlp",
                    kind: "source-set-clip",
                    mediaPath: variant.outputPath,
                    files: [variant.outputPath],
                    source: clip.sourceUrl,
                    engine: "reference",
                    sha256: verified.sha256,
                    variantKey: variantKey(variant),
                    ...(variant.spotifyId ? { spotifyId: variant.spotifyId } : {}),
                    clip: {
                      sourceSetUrl: clip.sourceUrl,
                      ...(clip.sourceTitle ? { sourceSetTitle: clip.sourceTitle } : {}),
                      startSeconds: clip.startSeconds,
                      endSeconds: clip.endSeconds,
                      containsTransitions: clip.containsTransitions,
                      qualityNote: clip.qualityNote,
                    },
                  },
                };
                warnings.push(
                  `${variantLabel(variant)} is a cue-based source-set extract, not a verified release master; ISRC deliberately omitted`,
                );
                downloaded.push(variant.outputPath);
              } else {
                let acquired: Awaited<ReturnType<typeof acquireVariant>>;
                try {
                  acquired = await acquireVariant(
                    target,
                    variant,
                    availableAcquirers,
                    plan.stagingDirectory,
                    minimumScore,
                    variant.preferredCandidate,
                    variant.preferredCandidatePlacement,
                    options.signal,
                    "candidates" in state.entry.acquisition
                      ? state.entry.acquisition.candidates
                      : undefined,
                    (candidate) =>
                      checkpoint(() => {
                        const prior =
                          "candidates" in state.entry.acquisition
                            ? (state.entry.acquisition.candidates ?? [])
                            : [];
                        const candidates = [
                          ...prior.filter(
                            (item) =>
                              item.backend !== candidate.backend ||
                              item.source !== candidate.source,
                          ),
                          candidate,
                        ];
                        state.entry.acquisition =
                          state.entry.acquisition.status === "pending" ||
                          state.entry.acquisition.status === "skipped"
                            ? {
                                status: "searching",
                                query: variant.searchQuery ?? variant.title,
                                candidates,
                              }
                            : { ...state.entry.acquisition, candidates };
                        replaceEntry(manifest, structuredClone(state.entry));
                      }),
                  );
                } catch (error) {
                  if (!localArtifactRejection) throw error;
                  throw new Error(
                    `${errorMessage(error)}; local fallback reason: ${localArtifactRejection}`,
                  );
                }
                if (localArtifactRejection) variant.outputPath = m4aOutputPath(variant.outputPath);
                const adaptedOutputPath = outputPathForSource(
                  variant.outputPath,
                  acquired.source.path,
                  acquired.acquirer.backend,
                );
                assertAdaptedOutputUnique(plan, variant, adaptedOutputPath);
                variant.outputPath = adaptedOutputPath;
                const retagCodec = retagCodecForSource(
                  acquired.source.path,
                  variant.outputPath,
                  acquired.acquirer.backend,
                );
                const tagged = await retagAudio({
                  sourcePath: acquired.source.path,
                  outputPath: variant.outputPath,
                  metadata: variant.metadata,
                  acquisitionSource: {
                    backend: acquired.acquirer.backend,
                    source: acquired.candidate.source,
                  },
                  audioCodec: retagCodec,
                  ...(variant.durationMs === undefined
                    ? {}
                    : { expectedDurationSeconds: variant.durationMs / 1000 }),
                });
                verificationReceipts.set(
                  variant.outputPath,
                  await verificationReceipt(variant.outputPath, tagged.sha256),
                );
                if (acquired.source.temporary !== false)
                  await rm(acquired.source.path, { force: true });
                completed = {
                  download: {
                    backend: acquired.acquirer.backend,
                    kind: "individual",
                    mediaPath: variant.outputPath,
                    files: [variant.outputPath],
                    source: acquired.candidate.source,
                    ...(acquired.source.engine ? { engine: acquired.source.engine } : {}),
                    ...(acquired.source.fallback ? { fallback: acquired.source.fallback } : {}),
                    sha256: tagged.sha256,
                    variantKey: variantKey(variant),
                    ...(variant.spotifyId ? { spotifyId: variant.spotifyId } : {}),
                    ...(variant.isrc ? { isrc: variant.isrc } : {}),
                  },
                  candidate: manifestCandidate(acquired.acquirer, acquired.candidate),
                };
                if (acquired.source.qualityNote) {
                  warnings.push(
                    `${variantLabel(variant)} acquisition quality: ${acquired.source.qualityNote}`,
                  );
                }
                if (acquired.source.transcoded) {
                  warnings.push(
                    `${variantLabel(variant)} required a lossy compatibility transcode`,
                  );
                }
                if (retagCodec === "aac") {
                  warnings.push(
                    `${variantLabel(variant)} Soulseek source required a lossy AAC compatibility transcode`,
                  );
                } else if (retagCodec === "flac") {
                  warnings.push(
                    `${variantLabel(variant)} Soulseek PCM source was losslessly converted to FLAC`,
                  );
                }
                downloaded.push(variant.outputPath);
              }
              options.signal?.throwIfAborted();
              await checkpoint(() => {
                state.completed.set(variantIndex, completed);
                for (const warning of warnings) addUniqueWarning(state.entry, warning);
                persistPartial(
                  state.entry,
                  recording,
                  [...state.completed.entries()]
                    .sort(([left], [right]) => left - right)
                    .map(([, item]) => item),
                );
                if (!state.failed.size && state.completed.size === recording.variants.length) {
                  clearAcquisitionErrors(state.entry);
                }
                replaceEntry(manifest, structuredClone(state.entry));
              });
              const verifiedReceipt = verificationReceipts.get(variant.outputPath);
              if (!verifiedReceipt)
                throw new Error(`Missing verification receipt for ${variant.outputPath}`);
              scheduleArtifactCallback({
                entryOrder: recording.entryOrder,
                variantIndex,
                path: variant.outputPath,
                sha256: verifiedReceipt.sha256,
                kind: completed.download.kind ?? "individual",
                status: downloaded.includes(variant.outputPath) ? "downloaded" : "resumed",
              });
            } catch (error) {
              throwIfAcquisitionCancelled(options.signal, error);
              const failure = toFailure(recording.entryOrder, variant.spotifyId, error);
              failures.push(failure);
              await checkpoint(() => {
                state.failed.add(variantIndex);
                if (state.completed.size) addAcquisitionError(state.entry, failure.message);
                else markFailure(state.entry, failure.message, variant.searchQuery);
                replaceEntry(manifest, structuredClone(state.entry));
              });
              if (options.continueOnError === false) throw error;
            } finally {
              activeVariants -= 1;
              processed += 1;
              reportProcessed();
            }
          },
          options.signal,
        ),
      recordingMetrics,
    );

    const acquisitionStages = await Promise.allSettled([clipsTask, recordingsTask]);
    const rejected = acquisitionStages.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    await waitForArtifactCallbacks();
    if (rejected) throw rejected.reason;

    const verification = failures.length
      ? undefined
      : await measure("final-verification", () =>
          verifyAcquisitionPlan(manifest, plan, verificationReceipts, verificationConcurrency),
        );
    return {
      manifest,
      downloaded: downloaded.toSorted(),
      resumed: resumed.toSorted(),
      failures: failures.toSorted(
        (left, right) =>
          left.entryOrder - right.entryOrder ||
          (left.spotifyId ?? "").localeCompare(right.spotifyId ?? ""),
      ),
      unavailableBackends,
      ...(verification ? { verification } : {}),
      performance: performanceResult(),
    };
  } finally {
    await release();
  }
}

/** Fail-closed handoff gate for downstream Rekordbox import. */
export async function verifyAcquisitionPlan(
  manifest: SetManifest,
  plan: AcquisitionPlan,
  verified?: ReadonlyMap<string, AcquisitionVerificationReceipt>,
  concurrency = DEFAULT_VERIFICATION_CONCURRENCY,
): Promise<AcquisitionVerification> {
  const verificationConcurrency = boundedConcurrency(
    concurrency,
    "concurrency",
    MAX_VERIFICATION_CONCURRENCY,
  );
  reconcileCheckpointedPlan(manifest, plan);
  validatePlan(manifest, plan, false, true);
  const expected = [
    ...plan.clips.map((clip) => ({
      entryOrder: clip.entryOrder,
      path: clip.outputPath,
      kind: "source-set-clip" as const,
      durationSeconds: clip.endSeconds - clip.startSeconds,
      durationToleranceSeconds: 2,
      metadata: clip.metadata,
    })),
    ...plan.recordings.flatMap((recording) =>
      recording.variants.map((variant) => ({
        entryOrder: recording.entryOrder,
        path: variant.outputPath,
        kind: variant.sourceClip ? ("source-set-clip" as const) : ("individual" as const),
        durationSeconds: expectedVariantDurationSeconds(variant),
        durationToleranceSeconds: variant.sourceClip
          ? 2
          : Math.max(10, ((variant.durationMs ?? 0) / 1000) * 0.035),
        metadata: variant.metadata,
      })),
    ),
  ];
  const paths = new Set<string>();
  let individualFiles = 0;
  let sourceSetClips = 0;
  const filesToVerify: Array<{
    item: (typeof expected)[number];
    expectedSha256: string;
  }> = [];
  for (const item of expected) {
    if (paths.has(item.path)) throw new Error(`Acquisition plan repeats output ${item.path}`);
    paths.add(item.path);
    const entry = requireEntry(manifest, item.entryOrder);
    if (entry.errors.some((error) => error.stage === "acquisition")) {
      throw new Error(`Track ${item.entryOrder} retains an acquisition error`);
    }
    const download = downloadForPath(entry, item.path);
    if (!download) throw new Error(`Manifest does not checkpoint expected file ${item.path}`);
    if ((download.kind ?? "individual") !== item.kind) {
      throw new Error(`Acquisition kind mismatch for ${item.path}`);
    }
    if (!download.sha256) throw new Error(`Manifest has no SHA-256 for ${item.path}`);
    if (item.kind === "source-set-clip") {
      sourceSetClips += 1;
      if (download.isrc) throw new Error(`Source-set clip must not claim an ISRC: ${item.path}`);
    } else {
      individualFiles += 1;
    }
    filesToVerify.push({ item, expectedSha256: download.sha256 });
  }
  await mapConcurrent(filesToVerify, verificationConcurrency, async ({ item, expectedSha256 }) => {
    const receipt = verified?.get(item.path);
    if (
      !receipt ||
      receipt.sha256 !== expectedSha256 ||
      !(await fileMatchesVerificationReceipt(item.path, receipt))
    ) {
      await verifyAudioFile(item.path, {
        expectedSha256,
        ...(item.durationSeconds === undefined
          ? {}
          : { expectedDurationSeconds: item.durationSeconds }),
        durationToleranceSeconds: item.durationToleranceSeconds,
        expectedMetadata: item.metadata,
      });
    }
  });
  return {
    files: expected.length,
    individualFiles,
    sourceSetClips,
    sha256Verified: expected.length,
    metadataVerified: expected.length,
  };
}

export type SpotifyRefreshOptions = {
  /** Parallel individual-track requests. Defaults to 8; callers may set 1 through 32. */
  concurrency?: number;
  signal?: AbortSignal;
};

export type SpotifyRefreshResult = {
  ids: number;
  requests: number;
  networkRequests: number;
  received: number;
  concurrency: number;
  maxConcurrency: number;
  durationMs: number;
  cache?: CacheStats;
};

export async function refreshKnownSpotifyTracks(
  manifest: SetManifest,
  spotify: SpotifyLibraryClient,
  options: SpotifyRefreshOptions = {},
): Promise<SpotifyRefreshResult> {
  const started = performance.now();
  const concurrency = boundedConcurrency(
    options.concurrency ?? DEFAULT_SPOTIFY_REFRESH_CONCURRENCY,
    "concurrency",
    MAX_SPOTIFY_REFRESH_CONCURRENCY,
  );
  const cacheBefore = spotify.cacheStats?.();
  const ids = [
    ...new Set(
      manifest.entries.flatMap((entry) => {
        if (entry.spotify.status === "matched") return [entry.spotify.id];
        if (entry.spotify.status === "ambiguous") {
          return entry.spotify.candidates.map((candidate) => candidate.id);
        }
        return [];
      }),
    ),
  ];
  const tracksById = new Map<string, SpotifyApiTrack>();
  let active = 0;
  let maxConcurrency = 0;
  await mapConcurrent(
    ids,
    concurrency,
    async (id) => {
      active += 1;
      maxConcurrency = Math.max(maxConcurrency, active);
      try {
        const response = await spotify.raw<unknown>(
          "GET",
          `tracks/${encodeURIComponent(id)}`,
          options.signal ? { signal: options.signal } : {},
        );
        const track = parseSpotifyApiTrack(response);
        if (track) tracksById.set(track.id, track);
      } finally {
        active -= 1;
      }
    },
    options.signal,
  );
  for (const entry of manifest.entries) {
    if (entry.spotify.status === "matched") {
      const fresh = tracksById.get(entry.spotify.id);
      if (!fresh) continue;
      const candidate = mergeSpotifyCandidate(entry.spotify, fresh);
      entry.spotify = {
        status: "matched",
        query: entry.spotify.query,
        ...candidate,
        ...(entry.spotify.candidates
          ? {
              candidates: entry.spotify.candidates.map((existing) =>
                tracksById.has(existing.id)
                  ? mergeSpotifyCandidate(existing, tracksById.get(existing.id)!)
                  : existing,
              ),
            }
          : {}),
      };
      if (!entry.identity.album && fresh.album) entry.identity.album = fresh.album;
      if (!entry.identity.releaseDate && fresh.releaseDate) {
        entry.identity.releaseDate = fresh.releaseDate;
      }
      if (!entry.identity.isrc && fresh.isrc) entry.identity.isrc = fresh.isrc;
    } else if (entry.spotify.status === "ambiguous") {
      entry.spotify.candidates = entry.spotify.candidates.map((existing) =>
        tracksById.has(existing.id)
          ? mergeSpotifyCandidate(existing, tracksById.get(existing.id)!)
          : existing,
      );
    }
  }
  const cacheAfter = spotify.cacheStats?.();
  const cache = cacheAfter ? cacheStatsDelta(cacheAfter, cacheBefore) : undefined;
  return {
    ids: ids.length,
    requests: ids.length,
    networkRequests: cache
      ? Math.max(0, cache.misses + cache.bypasses - cache.coalesced)
      : ids.length,
    received: tracksById.size,
    concurrency,
    maxConcurrency,
    durationMs: roundMilliseconds(performance.now() - started),
    ...(cache ? { cache } : {}),
  };
}

async function acquireVariant(
  target: YoutubeTarget,
  variant: AcquisitionRecordingVariant,
  acquirers: readonly TrackAcquirer[],
  stagingDirectory: string,
  minimumScore: number,
  preferredCandidate?: YoutubeSearchCandidate & { backend: AcquisitionBackend },
  preferredCandidatePlacement: "first" | "backend-fallback" = "first",
  signal?: AbortSignal,
  priorCandidates: readonly AcquisitionCandidate[] = [],
  rememberCandidate?: (candidate: AcquisitionCandidate) => Promise<void>,
): Promise<{
  acquirer: TrackAcquirer;
  candidate: ScoredYoutubeCandidate;
  source: IndividualDownload;
}> {
  signal?.throwIfAborted();
  const failures: string[] = [];
  let capabilityFallback: AcquirerFallback | undefined;
  const retryCandidates = new Map<AcquisitionBackend, ScoredYoutubeCandidate[]>();
  for (const backend of ["slsk", "ytdlp"] as const) {
    // Re-evaluate saved identities against this recording; never trust an old
    // score if enrichment or the chosen variant has changed since the attempt.
    retryCandidates.set(
      backend,
      scoreYoutubeCandidates(
        target,
        priorCandidates.filter((candidate) => candidate.backend === backend),
      ),
    );
  }
  const preferredAcquirer = preferredCandidate
    ? acquirers.find((acquirer) => acquirer.backend === preferredCandidate.backend)
    : undefined;
  const preferredAttempted = new Set<TrackAcquirer>();
  const acquirePreferred = async (
    acquirer: TrackAcquirer,
  ): Promise<
    | {
        acquirer: TrackAcquirer;
        candidate: ScoredYoutubeCandidate;
        source: IndividualDownload;
      }
    | undefined
  > => {
    if (!preferredCandidate || preferredAttempted.has(acquirer)) return undefined;
    preferredAttempted.add(acquirer);
    const selected: ScoredYoutubeCandidate = { ...preferredCandidate, score: 1 };
    await rememberCandidate?.(manifestCandidate(acquirer, selected));
    let source: IndividualDownload | undefined;
    let validating = false;
    try {
      source = await acquirer.download(
        selected,
        candidateStagingDirectory(stagingDirectory, variant, acquirer.backend, selected),
        variantKey(variant),
      );
      signal?.throwIfAborted();
      validating = true;
      await validateAcquiredSource(source, target);
      signal?.throwIfAborted();
      return { acquirer, candidate: selected, source };
    } catch (error) {
      if (source && source.temporary !== false) await rm(source.path, { force: true });
      throwIfAcquisitionCancelled(signal, error);
      failures.push(`${acquirer.backend} audited source: ${errorMessage(error)}`);
      if (!validating) {
        const shouldContinue = acquirer.shouldContinueAfterError?.(error, "download");
        if (shouldContinue === false) throw error;
        if (shouldContinue) capabilityFallback = shouldContinue;
      }
      return undefined;
    }
  };
  if (preferredCandidate && !preferredAcquirer) {
    failures.push(`${preferredCandidate.backend}: audited source backend unavailable`);
  } else if (preferredAcquirer && preferredCandidatePlacement === "first") {
    const acquired = await acquirePreferred(preferredAcquirer);
    if (acquired) return acquired;
  }
  const searchAcquirer = async (acquirer: TrackAcquirer, audio = false) => {
    try {
      return {
        ok: true as const,
        candidates: scoreYoutubeCandidates(
          target,
          await acquirer.search(
            audio
              ? { ...target, searchQuery: [...target.artists, target.title, "audio"].join(" ") }
              : target,
          ),
        ),
      };
    } catch (error) {
      return { ok: false as const, error };
    }
  };
  const searches = acquirers.map((acquirer) =>
    acquirer.requiresPriorCapabilityFailure ||
    retryCandidates.get(acquirer.backend)?.length ||
    (preferredCandidate && acquirer.backend === preferredCandidate.backend)
      ? undefined
      : searchAcquirer(acquirer),
  );
  for (const [index, acquirer] of acquirers.entries()) {
    if (acquirer.requiresPriorCapabilityFailure && !capabilityFallback) {
      failures.push(`${acquirer.backend}: no typed native capability gap permitted reference use`);
      continue;
    }
    if (
      preferredCandidate &&
      acquirer.backend === preferredCandidate.backend &&
      !preferredAttempted.has(acquirer)
    ) {
      const acquired = await acquirePreferred(acquirer);
      if (acquired) return acquired;
    }
    // Provider search rankings can differ between engines. If a permitted
    // download fallback found the right recording, retry that exact identity
    // before making another search request (which can itself fail).
    const attempted = new Set<string>();
    if (preferredCandidate && preferredAttempted.has(acquirer)) {
      attempted.add(preferredCandidate.source);
    }
    for (const stage of ["saved", "search", "audio-search"] as const) {
      if (stage === "audio-search" && (acquirer.backend !== "ytdlp" || attempted.size > 0))
        continue;
      let candidates = retryCandidates.get(acquirer.backend) ?? [];
      if (stage !== "saved") {
        // Ordinary search often ranks music videos/radio edits ahead of the
        // album recording. Try one bounded audio query without relaxing the
        // identity or duration checks.
        const search = await (stage === "audio-search"
          ? searchAcquirer(acquirer, true)
          : (searches[index] ?? searchAcquirer(acquirer)));
        signal?.throwIfAborted();
        if (!search.ok) {
          throwIfAcquisitionCancelled(signal, search.error);
          failures.push(`${acquirer.backend} search: ${errorMessage(search.error)}`);
          const shouldContinue = acquirer.shouldContinueAfterError?.(search.error, "search");
          if (shouldContinue === false) throw search.error;
          if (shouldContinue) capabilityFallback = shouldContinue;
          continue;
        }
        candidates = search.candidates;
      }
      candidates = candidates.filter(
        (candidate, index, all) =>
          all.findIndex(
            (other) => other.id === candidate.id && other.source === candidate.source,
          ) === index,
      );
      const eligible = candidates.filter(
        (candidate) =>
          candidate.score >= minimumScore &&
          !hasWrongDuration(target, candidate) &&
          !attempted.has(candidate.source),
      );
      if (!eligible.length) {
        const best = candidates[0];
        if (stage === "search")
          failures.push(
            `${acquirer.backend}: no candidate met score ${minimumScore.toFixed(2)}${best ? ` (best ${best.score.toFixed(3)}: ${best.title})` : ""}`,
          );
        continue;
      }
      for (const selected of eligible) {
        attempted.add(selected.source);
        // Commit the source identity before network I/O so a killed process or a
        // transient failure can resume without rediscovering the recording.
        await rememberCandidate?.(manifestCandidate(acquirer, selected));
        let source: IndividualDownload | undefined;
        let validating = false;
        try {
          source = await acquirer.download(
            selected,
            candidateStagingDirectory(stagingDirectory, variant, acquirer.backend, selected),
            variantKey(variant),
          );
          signal?.throwIfAborted();
          validating = true;
          await validateAcquiredSource(source, target);
          signal?.throwIfAborted();
          return {
            acquirer,
            candidate: selected,
            source:
              acquirer.requiresPriorCapabilityFailure && capabilityFallback
                ? { ...source, fallback: capabilityFallback }
                : source,
          };
        } catch (error) {
          if (source && source.temporary !== false) await rm(source.path, { force: true });
          throwIfAcquisitionCancelled(signal, error);
          failures.push(`${acquirer.backend} ${selected.id}: ${errorMessage(error)}`);
          if (!validating) {
            const shouldContinue = acquirer.shouldContinueAfterError?.(error, "download");
            if (shouldContinue === false) throw error;
            if (shouldContinue) capabilityFallback = shouldContinue;
            const retained = retryCandidates.get(acquirer.backend) ?? [];
            retained.push(selected);
            retryCandidates.set(acquirer.backend, retained);
          }
        }
      }
    }
  }
  throw new Error(
    `Could not acquire ${variant.artists.join(", ")} — ${variant.title}: ${failures.join("; ") || "no available backend"}`,
  );
}

function candidateStagingDirectory(
  stagingDirectory: string,
  variant: AcquisitionRecordingVariant,
  backend: AcquisitionBackend,
  candidate: YoutubeSearchCandidate,
): string {
  const identity = createHash("sha256")
    .update(
      `${variantKey(variant)}\u0000${variant.outputPath}\u0000${backend}\u0000${candidate.id}\u0000${candidate.source}`,
    )
    .digest("hex")
    .slice(0, 20);
  return join(stagingDirectory, identity);
}

function clipState(clip: AcquisitionClipPlan, sha256: string): ResolvedTrack["acquisition"] {
  return {
    status: "downloaded",
    query: clip.metadata.title,
    download: {
      backend: "ytdlp",
      kind: "source-set-clip",
      mediaPath: clip.outputPath,
      files: [clip.outputPath],
      source: clip.sourceUrl,
      engine: "reference",
      sha256,
      clip: {
        sourceSetUrl: clip.sourceUrl,
        ...(clip.sourceTitle ? { sourceSetTitle: clip.sourceTitle } : {}),
        startSeconds: clip.startSeconds,
        endSeconds: clip.endSeconds,
        containsTransitions: clip.containsTransitions,
        qualityNote: clip.qualityNote,
      },
    },
  };
}

function persistPartial(
  entry: ResolvedTrack,
  recording: AcquisitionRecordingPlan,
  completed: Array<{ download: AcquisitionDownload; candidate?: AcquisitionCandidate }>,
): void {
  const first = completed[0];
  if (!first) return;
  const candidates = [
    ...completed.flatMap((item) => (item.candidate ? [item.candidate] : [])),
    ...("candidates" in entry.acquisition ? (entry.acquisition.candidates ?? []) : []),
  ].filter(
    (candidate, index, all) =>
      all.findIndex(
        (other) =>
          other.backend === candidate.backend &&
          other.source === candidate.source &&
          other.id === candidate.id,
      ) === index,
  );
  entry.acquisition = {
    status: "downloaded",
    query:
      recording.variants[0]?.searchQuery ??
      `${recording.variants[0]!.artists.join(", ")} - ${recording.variants[0]!.title}`,
    ...(candidates.length ? { candidates } : {}),
    ...(first.candidate ? { selected: first.candidate } : {}),
    download: first.download,
    ...(completed.length > 1
      ? { alternatives: completed.slice(1).map((item) => item.download) }
      : {}),
  };
}

function individualDownload(
  variant: AcquisitionRecordingVariant,
  path: string,
  sha256: string,
): AcquisitionDownload {
  const exactIdentity =
    !variant.localArtifact || variant.localArtifact.matchedBy !== "artist-title";
  return {
    backend: variant.localArtifact ? "local" : "ytdlp",
    kind: "individual",
    mediaPath: path,
    files: [path],
    sha256,
    ...(exactIdentity ? { variantKey: variantKey(variant) } : {}),
    ...(variant.localArtifact ? { source: variant.localArtifact.sourcePath } : {}),
    ...(exactIdentity && variant.spotifyId ? { spotifyId: variant.spotifyId } : {}),
    ...(exactIdentity && variant.isrc ? { isrc: variant.isrc } : {}),
  };
}

function variantKey(variant: AcquisitionRecordingVariant): string {
  if (variant.spotifyId) return variant.spotifyId;
  return createHash("sha256")
    .update(`${variant.artists.join("\u0000")}\u0000${variant.title}\u0000${variant.isrc ?? ""}`)
    .digest("hex")
    .slice(0, 20);
}

function variantLabel(variant: AcquisitionRecordingVariant): string {
  return variant.spotifyId ?? `${variant.artists.join(", ")} — ${variant.title}`;
}

function priorDownloadForVariant(
  downloads: readonly AcquisitionDownload[],
  variant: AcquisitionRecordingVariant,
): AcquisitionDownload | undefined {
  if (variant.sourceClip) {
    const sourceClips = downloads.filter((download) => download.kind === "source-set-clip");
    const byCue = sourceClips.find(
      (download) =>
        download.clip !== undefined &&
        nearlyEqual(download.clip.startSeconds, variant.sourceClip!.startSeconds) &&
        nearlyEqual(download.clip.endSeconds, variant.sourceClip!.endSeconds),
    );
    return byCue ?? (sourceClips.length === 1 ? sourceClips[0] : undefined);
  }
  // Cached clips may carry the same Spotify/variant ID as the wanted recording.
  // Never checkpoint or relabel them as an individual acquisition.
  downloads = downloads.filter(
    (download) => download.kind !== "source-set-clip" && download.clip === undefined,
  );
  if (variant.spotifyId) {
    return downloads.find((download) => download.spotifyId === variant.spotifyId);
  }
  if (variant.isrc) {
    const isrc = variant.isrc.toLocaleUpperCase("en-US");
    const byIsrc = downloads.find(
      (download) =>
        download.spotifyId === undefined && download.isrc?.toLocaleUpperCase("en-US") === isrc,
    );
    if (byIsrc) return byIsrc;
  }
  const key = variantKey(variant);
  const keyed = downloads.find((download) => download.variantKey === key);
  if (keyed) return keyed;
  return downloads.find(
    (download) =>
      download.spotifyId === undefined &&
      download.variantKey === undefined &&
      download.mediaPath === variant.outputPath,
  );
}

function outputPathForSource(
  requestedPath: string,
  sourcePath: string,
  backend: AcquisitionBackend,
): string {
  if (backend !== "slsk") return requestedPath;
  const sourceExtension = extname(sourcePath).toLocaleLowerCase("en-US");
  if (!sourceExtension) return requestedPath;
  const requestedExtension = extname(requestedPath);
  const stem = requestedExtension
    ? requestedPath.slice(0, -requestedExtension.length)
    : requestedPath;
  if (LOSSLESS_PCM_EXTENSIONS.has(sourceExtension)) return `${stem}.flac`;
  if (!PRESERVED_REKORDBOX_AUDIO_EXTENSIONS.has(sourceExtension)) return requestedPath;
  return `${stem}${sourceExtension}`;
}

function m4aOutputPath(path: string): string {
  const extension = extname(path);
  return `${extension ? path.slice(0, -extension.length) : path}.m4a`;
}

function targetForVariant(variant: AcquisitionRecordingVariant): YoutubeTarget {
  return {
    title: variant.title,
    artists: variant.artists,
    ...(variant.durationMs === undefined ? {} : { durationSeconds: variant.durationMs / 1000 }),
  };
}

const PRESERVED_REKORDBOX_AUDIO_EXTENSIONS = new Set([".flac", ".m4a", ".mp3"]);
const LOSSLESS_PCM_EXTENSIONS = new Set([".aif", ".aiff", ".wav", ".wave"]);

function retagCodecForSource(
  sourcePath: string,
  outputPath: string,
  backend: AcquisitionBackend,
): "copy" | "aac" | "flac" {
  if (backend !== "slsk") return "copy";
  const sourceExtension = extname(sourcePath).toLocaleLowerCase("en-US");
  const outputExtension = extname(outputPath).toLocaleLowerCase("en-US");
  if (sourceExtension === outputExtension) return "copy";
  if (sourceExtension === ".aac" && outputExtension === ".m4a") return "copy";
  return outputExtension === ".flac" ? "flac" : "aac";
}

function assertAdaptedOutputUnique(
  plan: AcquisitionPlan,
  current: AcquisitionRecordingVariant,
  outputPath: string,
): void {
  const conflicts = [
    ...plan.clips.map((clip) => clip.outputPath),
    ...plan.recordings.flatMap((recording) =>
      recording.variants
        .filter((variant) => variant !== current)
        .map((variant) => variant.outputPath),
    ),
  ];
  if (conflicts.includes(outputPath)) {
    throw new Error(`Adapted Soulseek output repeats another planned path: ${outputPath}`);
  }
}

function recordingClipDownload(
  variant: AcquisitionRecordingVariant,
  sha256: string,
): AcquisitionDownload {
  const clip = variant.sourceClip;
  if (!clip) throw new Error("Recording variant has no source clip");
  return {
    backend: "ytdlp",
    kind: "source-set-clip",
    mediaPath: variant.outputPath,
    files: [variant.outputPath],
    source: clip.sourceUrl,
    engine: "reference",
    sha256,
    variantKey: variantKey(variant),
    ...(variant.spotifyId ? { spotifyId: variant.spotifyId } : {}),
    clip: {
      sourceSetUrl: clip.sourceUrl,
      ...(clip.sourceTitle ? { sourceSetTitle: clip.sourceTitle } : {}),
      startSeconds: clip.startSeconds,
      endSeconds: clip.endSeconds,
      containsTransitions: clip.containsTransitions,
      qualityNote: clip.qualityNote,
    },
  };
}

function manifestCandidate(
  acquirer: TrackAcquirer,
  candidate: ScoredYoutubeCandidate,
): AcquisitionCandidate {
  return {
    backend: acquirer.backend,
    id: candidate.id,
    source: candidate.source,
    title: candidate.title,
    ...(candidate.artist ? { artist: candidate.artist } : {}),
    ...(candidate.durationSeconds === undefined
      ? {}
      : { durationSeconds: candidate.durationSeconds }),
    score: candidate.score,
  };
}

function candidateFromDownload(
  download: AcquisitionDownload | undefined,
  acquisition: Extract<ResolvedTrack["acquisition"], { status: "downloaded" }> | undefined,
  variant: AcquisitionRecordingVariant,
): AcquisitionCandidate | undefined {
  if (!download?.source || download.backend === "local") return undefined;
  const preferred = variant.preferredCandidate;
  if (preferred?.backend === download.backend && preferred.source === download.source) {
    return {
      backend: preferred.backend,
      id: preferred.id,
      source: preferred.source,
      title: preferred.title,
      ...(preferred.artist ? { artist: preferred.artist } : {}),
      ...(preferred.durationSeconds === undefined
        ? {}
        : { durationSeconds: preferred.durationSeconds }),
      score: 1,
    };
  }
  const checkpointed = [acquisition?.selected, ...(acquisition?.candidates ?? [])].find(
    (candidate) => candidate?.backend === download.backend && candidate.source === download.source,
  );
  if (checkpointed && checkpointed.title !== download.spotifyId) return checkpointed;
  return {
    backend: download.backend,
    id: sourceIdentifier(download.source) ?? download.spotifyId ?? download.source,
    source: download.source,
    title: variant.title,
    ...(variant.artists.length ? { artist: variant.artists.join(", ") } : {}),
    ...(variant.durationMs === undefined ? {} : { durationSeconds: variant.durationMs / 1000 }),
  };
}

function sourceIdentifier(source: string): string | undefined {
  try {
    const url = new URL(source);
    return url.searchParams.get("v") ?? url.pathname.split("/").filter(Boolean).at(-1);
  } catch {
    return undefined;
  }
}

function downloadForPath(entry: ResolvedTrack, path: string): AcquisitionDownload | undefined {
  if (entry.acquisition.status !== "downloaded") return undefined;
  return [entry.acquisition.download, ...(entry.acquisition.alternatives ?? [])].find(
    (download) => download.mediaPath === path,
  );
}

function checkpointedDownloads(entry: ResolvedTrack): AcquisitionDownload[] {
  return entry.acquisition.status === "downloaded"
    ? [entry.acquisition.download, ...(entry.acquisition.alternatives ?? [])]
    : [];
}

function priorDownloadForClip(
  entry: ResolvedTrack,
  clip: AcquisitionClipPlan,
): AcquisitionDownload | undefined {
  const clips = checkpointedDownloads(entry).filter(
    (download) => download.kind === "source-set-clip" || download.clip !== undefined,
  );
  const matchingRange = clips.find(
    (download) =>
      download.clip !== undefined &&
      nearlyEqual(download.clip.startSeconds, clip.startSeconds) &&
      nearlyEqual(download.clip.endSeconds, clip.endSeconds),
  );
  return (
    matchingRange ?? (clips.length === 1 && clips[0]!.clip === undefined ? clips[0] : undefined)
  );
}

/** Preserve durable legacy paths before validating or executing a freshly generated plan. */
function reconcileCheckpointedPlan(manifest: SetManifest, plan: AcquisitionPlan): void {
  for (const clip of plan.clips) {
    const prior = priorDownloadForClip(requireEntry(manifest, clip.entryOrder), clip);
    if (prior) clip.outputPath = prior.mediaPath;
  }
  for (const recording of plan.recordings) {
    const downloads = checkpointedDownloads(requireEntry(manifest, recording.entryOrder));
    recording.variants.forEach((variant) => {
      const prior = priorDownloadForVariant(downloads, variant);
      if (prior) variant.outputPath = prior.mediaPath;
    });
  }
}

async function preflightExistingArtifacts(
  manifest: SetManifest,
  plan: AcquisitionPlan,
  concurrency: number,
  cache?: JsonDiskCache,
  signal?: AbortSignal,
): Promise<Map<string, AcquisitionVerificationReceipt>> {
  const expected = [
    ...plan.clips.map((clip) => {
      const entry = requireEntry(manifest, clip.entryOrder);
      const prior = downloadForPath(entry, clip.outputPath) ?? priorDownloadForClip(entry, clip);
      if (prior) clip.outputPath = prior.mediaPath;
      return {
        path: clip.outputPath,
        metadata: prior?.sha256 ? undefined : clip.metadata,
        expectedSha256: prior?.sha256,
        expectedDurationSeconds: clip.endSeconds - clip.startSeconds,
        durationToleranceSeconds: 2,
        eligible: true,
      };
    }),
    ...plan.recordings.flatMap((recording) => {
      const entry = requireEntry(manifest, recording.entryOrder);
      const downloads =
        entry.acquisition.status === "downloaded"
          ? [entry.acquisition.download, ...(entry.acquisition.alternatives ?? [])]
          : [];
      return recording.variants.map((variant) => {
        const prior = priorDownloadForVariant(downloads, variant);
        if (prior && prior.mediaPath !== variant.outputPath) variant.outputPath = prior.mediaPath;
        return {
          path: variant.outputPath,
          metadata: prior?.sha256 ? undefined : variant.metadata,
          expectedSha256: prior?.sha256,
          expectedDurationSeconds: expectedVariantDurationSeconds(variant),
          durationToleranceSeconds: variant.sourceClip
            ? 2
            : Math.max(10, ((variant.durationMs ?? 0) / 1000) * 0.035),
          eligible:
            prior !== undefined ||
            variant.sourceClip !== undefined ||
            variant.localArtifact !== undefined,
        };
      });
    }),
  ];
  const receipts = new Map<string, AcquisitionVerificationReceipt>();
  await mapConcurrent(
    expected,
    concurrency,
    async (item) => {
      if (!item.eligible) return;
      try {
        const before = await stat(item.path);
        const verified = await verifyAudioCached(
          item.path,
          {
            ...(item.expectedSha256 ? { expectedSha256: item.expectedSha256 } : {}),
            ...(item.expectedDurationSeconds === undefined
              ? {}
              : { expectedDurationSeconds: item.expectedDurationSeconds }),
            durationToleranceSeconds: item.durationToleranceSeconds,
            ...(item.metadata ? { expectedMetadata: item.metadata } : {}),
          },
          cache,
        );
        const after = await stat(item.path);
        if (!sameFileStat(before, after)) {
          throw new Error(`Audio file changed during verification: ${item.path}`);
        }
        receipts.set(item.path, {
          sha256: verified.sha256,
          size: after.size,
          mtimeMs: after.mtimeMs,
          ctimeMs: after.ctimeMs,
          ino: after.ino,
        });
      } catch (error) {
        throwIfAcquisitionCancelled(signal, error);
        // A missing or invalid artifact is reacquired by the normal stage below.
      }
    },
    signal,
  );
  return receipts;
}

async function verificationReceipt(
  path: string,
  sha256: string,
): Promise<AcquisitionVerificationReceipt> {
  const info = await stat(path);
  return {
    sha256,
    size: info.size,
    mtimeMs: info.mtimeMs,
    ctimeMs: info.ctimeMs,
    ino: info.ino,
  };
}

async function fileMatchesVerificationReceipt(
  path: string,
  receipt: AcquisitionVerificationReceipt,
): Promise<boolean> {
  try {
    return sameFileStat(await stat(path), receipt);
  } catch {
    return false;
  }
}

function sameFileStat(
  left: Pick<AcquisitionVerificationReceipt, "size" | "mtimeMs" | "ctimeMs" | "ino">,
  right: Pick<AcquisitionVerificationReceipt, "size" | "mtimeMs" | "ctimeMs" | "ino">,
): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.ino === right.ino
  );
}

async function verifyAudioCached(
  path: string,
  options: Parameters<typeof verifyAudioFile>[1],
  cache?: JsonDiskCache,
): ReturnType<typeof verifyAudioFile> {
  if (!cache) return verifyAudioFile(path, options);
  const info = await stat(path);
  return cache.getOrLoad(
    {
      verificationVersion: 2,
      path: resolve(path),
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      ino: String(info.ino),
      options,
    },
    () => verifyAudioFile(path, options),
    { ttlMs: 30 * 24 * 60 * 60 * 1000 },
  );
}

async function isCheckpointedAudioIntact(
  download: AcquisitionDownload,
  variant: AcquisitionRecordingVariant,
  cache?: JsonDiskCache,
): Promise<boolean> {
  if (!download.sha256) return false;
  try {
    const durationSeconds = expectedVariantDurationSeconds(variant);
    await verifyAudioCached(
      variant.outputPath,
      {
        expectedSha256: download.sha256,
        ...(durationSeconds === undefined ? {} : { expectedDurationSeconds: durationSeconds }),
        durationToleranceSeconds: variant.sourceClip
          ? 2
          : Math.max(10, ((variant.durationMs ?? 0) / 1000) * 0.035),
      },
      cache,
    );
    return true;
  } catch {
    return false;
  }
}

function replaceEntry(manifest: SetManifest, replacement: ResolvedTrack): void {
  const index = manifest.entries.findIndex((entry) => entry.id === replacement.id);
  if (index < 0) throw new Error(`Manifest has no track ${replacement.id}`);
  manifest.entries[index] = replacement;
}

function requireEntry(manifest: SetManifest, order: number): ResolvedTrack {
  const entry = manifest.entries.find((candidate) => candidate.order === order);
  if (!entry) throw new Error(`Manifest has no track order ${order}`);
  return entry;
}

function validatePlan(
  manifest: SetManifest,
  plan: AcquisitionPlan,
  requireComplete: boolean,
  allowCheckpointedSoulseekOutputs = false,
): void {
  const orders = new Set(manifest.entries.map((entry) => entry.order));
  const planned = [
    ...plan.clips.map((clip) => clip.entryOrder),
    ...plan.recordings.map((r) => r.entryOrder),
  ];
  if (new Set(planned).size !== planned.length)
    throw new Error("Acquisition plan repeats an entry order");
  for (const recording of plan.recordings) {
    if (!recording.variants.length) {
      throw new Error(`Recording plan for order ${recording.entryOrder} has no variants`);
    }
  }
  const missingRequired = manifest.entries.filter(
    (entry) => entry.acquisition.status !== "skipped" && !planned.includes(entry.order),
  );
  if (requireComplete && missingRequired.length) {
    throw new Error(
      `Complete acquisition plan is missing required orders: ${missingRequired.map((entry) => entry.order).join(", ")}`,
    );
  }
  for (const order of planned)
    if (!orders.has(order)) throw new Error(`Plan references absent order ${order}`);
  const outputPaths = [
    ...plan.clips.map((clip) => clip.outputPath),
    ...plan.recordings.flatMap((recording) =>
      recording.variants.map((variant) => variant.outputPath),
    ),
  ];
  if (new Set(outputPaths).size !== outputPaths.length) {
    throw new Error("Acquisition plan repeats an output path");
  }
  for (const path of outputPaths) {
    if (!isAbsolute(path)) throw new Error(`Acquisition output must be absolute: ${path}`);
  }
  if (!isAbsolute(plan.stagingDirectory)) throw new Error("Staging directory must be absolute");

  const sourceSets = new Map<string, NonNullable<AcquisitionPlan["sourceSets"]>[number]>();
  for (const source of plan.sourceSets ?? []) {
    if (!isAbsolute(source.path))
      throw new Error(`Source-set path must be absolute: ${source.path}`);
    if (sourceSets.has(source.path)) throw new Error(`Source-set path is repeated: ${source.path}`);
    sourceSets.set(source.path, source);
    if (!/^[\da-f]{64}$/u.test(source.sha256)) {
      throw new Error(`Source-set SHA-256 is invalid for ${source.path}`);
    }
    if (!isPositiveFinite(source.durationSeconds)) {
      throw new Error(`Source-set duration must be positive for ${source.path}`);
    }
    if (!source.codec.trim()) throw new Error(`Source-set codec is required for ${source.path}`);
    if (!isPositiveFinite(source.bitrate)) {
      throw new Error(`Source-set bitrate must be positive for ${source.path}`);
    }
  }

  for (const clip of plan.clips) validateSourceClip(manifest, clip, sourceSets);
  for (const recording of plan.recordings) {
    const entry = requireEntry(manifest, recording.entryOrder);
    const spotifyCandidates: Array<{
      id: string;
      name?: string;
      artists?: string[];
      durationMs?: number;
      isrc?: string;
    }> =
      entry.spotify.status === "matched"
        ? [entry.spotify]
        : entry.spotify.status === "ambiguous"
          ? entry.spotify.candidates
          : [];
    const identityFallback =
      !spotifyCandidates.length &&
      (entry.spotify.status === "unmatched" || entry.spotify.status === "pending") &&
      entry.identity.status === "identified";
    if (!spotifyCandidates.length && !identityFallback) {
      throw new Error(
        `Recording plan for order ${recording.entryOrder} requires Spotify metadata or an identified recording identity`,
      );
    }
    const expectedById = new Map(spotifyCandidates.map((candidate) => [candidate.id, candidate]));
    const spotifyIds = new Set<string>();
    for (const variant of recording.variants) {
      const overlapVariant =
        !variant.spotifyId &&
        entry.identity.overlaps?.some(
          (overlap) =>
            variant.title === overlap.title && sameStrings(variant.artists, [overlap.artist]),
        );
      if (spotifyCandidates.length && !variant.spotifyId?.trim() && !overlapVariant) {
        throw new Error(`Recording variant for order ${recording.entryOrder} has no Spotify ID`);
      }
      if (!spotifyCandidates.length && variant.spotifyId) {
        throw new Error(
          `Spotify-unmatched recording for order ${recording.entryOrder} must not claim a Spotify ID`,
        );
      }
      if (variant.spotifyId && spotifyIds.has(variant.spotifyId)) {
        throw new Error(
          `Recording plan for order ${recording.entryOrder} repeats Spotify ID ${variant.spotifyId}`,
        );
      }
      if (variant.spotifyId) spotifyIds.add(variant.spotifyId);
      const expected = variant.spotifyId ? expectedById.get(variant.spotifyId) : undefined;
      if (variant.spotifyId && !expected) {
        throw new Error(
          `Recording plan for order ${recording.entryOrder} uses unapproved Spotify ID ${variant.spotifyId}`,
        );
      }
      if (
        variant.durationMs !== undefined &&
        (!Number.isSafeInteger(variant.durationMs) || variant.durationMs <= 0)
      ) {
        throw new Error(
          `Recording duration must be a positive integer for ${variantLabel(variant)}`,
        );
      }
      if (expected?.durationMs !== undefined && variant.durationMs !== expected.durationMs) {
        throw new Error(`Recording duration does not match Spotify for ${variant.spotifyId}`);
      }
      if (expected?.name !== undefined && variant.title !== expected.name) {
        throw new Error(`Recording title does not match Spotify for ${variant.spotifyId}`);
      }
      if (expected?.artists !== undefined && !sameStrings(variant.artists, expected.artists)) {
        throw new Error(`Recording artists do not match Spotify for ${variant.spotifyId}`);
      }
      if (identityFallback && entry.identity.status === "identified" && !overlapVariant) {
        const expectedTitle =
          entry.identity.mix && !entry.identity.title.includes(entry.identity.mix)
            ? `${entry.identity.title} (${entry.identity.mix})`
            : entry.identity.title;
        if (
          variant.title !== expectedTitle ||
          !sameStrings(variant.artists, [entry.identity.artist])
        ) {
          throw new Error(
            `Recording identity does not match tracklist for order ${recording.entryOrder}`,
          );
        }
      }
      if (!variant.sourceClip) {
        const outputExtension = extname(variant.outputPath).toLocaleLowerCase("en-US");
        const checkpointed = downloadForPath(entry, variant.outputPath);
        const allowedAdaptedOutput =
          allowCheckpointedSoulseekOutputs &&
          (checkpointed?.backend === "slsk" || checkpointed?.backend === "local") &&
          (outputExtension === ".flac" || outputExtension === ".mp3");
        const allowedLocalOutput =
          variant.localArtifact !== undefined &&
          (outputExtension === ".flac" || outputExtension === ".m4a" || outputExtension === ".mp3");
        if (outputExtension !== ".m4a" && !allowedAdaptedOutput && !allowedLocalOutput) {
          throw new Error(
            `Individual recording output must use an M4A staging target: ${variant.outputPath}`,
          );
        }
        if (variant.localArtifact) {
          if (!isAbsolute(variant.localArtifact.sourcePath)) {
            throw new Error(
              `Local artifact source must be absolute: ${variant.localArtifact.sourcePath}`,
            );
          }
        }
        const expectedIsrc =
          expected?.isrc ??
          (identityFallback && !overlapVariant && entry.identity.status === "identified"
            ? entry.identity.isrc
            : undefined);
        const exactLocalIdentity = variant.localArtifact?.matchedBy !== "artist-title";
        if (expectedIsrc && exactLocalIdentity && variant.isrc !== expectedIsrc) {
          throw new Error(`Recording ISRC does not match Spotify for ${variant.spotifyId}`);
        }
        if (expectedIsrc && exactLocalIdentity && variant.metadata.isrc !== expectedIsrc) {
          throw new Error(
            `Recording metadata ISRC does not match Spotify for ${variant.spotifyId}`,
          );
        }
      }
      if (variant.sourceClip) {
        validateSourceClip(
          manifest,
          {
            entryOrder: recording.entryOrder,
            outputPath: variant.outputPath,
            metadata: variant.metadata,
            ...variant.sourceClip,
          },
          sourceSets,
        );
      }
    }
    if (
      requireComplete &&
      spotifyCandidates.length > 0 &&
      (spotifyIds.size !== expectedById.size ||
        [...expectedById.keys()].some((id) => !spotifyIds.has(id)))
    ) {
      throw new Error(
        `Complete recording plan for order ${recording.entryOrder} must include every Spotify candidate`,
      );
    }
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function expectedVariantDurationSeconds(variant: AcquisitionRecordingVariant): number | undefined {
  if (variant.sourceClip) return variant.sourceClip.endSeconds - variant.sourceClip.startSeconds;
  if (variant.localArtifact?.matchedBy === "artist-title") return undefined;
  return variant.durationMs === undefined ? undefined : variant.durationMs / 1000;
}

type SourceClipShape = {
  entryOrder: number;
  sourcePath: string;
  sourceUrl: string;
  outputPath: string;
  startSeconds: number;
  endSeconds: number;
  metadata: AudioMetadata;
};

function validateSourceClip(
  manifest: SetManifest,
  clip: SourceClipShape,
  sourceSets: ReadonlyMap<string, NonNullable<AcquisitionPlan["sourceSets"]>[number]>,
): void {
  if (!isAbsolute(clip.sourcePath)) {
    throw new Error(`Source-set clip path must be absolute: ${clip.sourcePath}`);
  }
  const plannedSource = sourceSets.get(clip.sourcePath);
  if (!plannedSource) {
    throw new Error(`Source-set clip has no verified source checksum: ${clip.sourcePath}`);
  }
  if (!clip.sourceUrl.trim()) {
    throw new Error(`Source-set clip for order ${clip.entryOrder} has no source URL`);
  }
  if (clip.metadata.isrc?.trim()) {
    throw new Error(`Source-set clip metadata must not claim an ISRC for order ${clip.entryOrder}`);
  }
  if (!Number.isFinite(clip.startSeconds) || clip.startSeconds < 0) {
    throw new Error(
      `Source-set clip start must be finite and nonnegative for order ${clip.entryOrder}`,
    );
  }
  if (!Number.isFinite(clip.endSeconds) || clip.endSeconds <= clip.startSeconds) {
    throw new Error(`Source-set clip range is invalid for order ${clip.entryOrder}`);
  }
  if (clip.sourcePath === clip.outputPath) {
    throw new Error(`Source-set clip output must differ from its source: ${clip.sourcePath}`);
  }
  const artifact = manifest.artifacts.sourceSet;
  if (
    !artifact ||
    artifact.path !== clip.sourcePath ||
    artifact.url !== clip.sourceUrl ||
    artifact.sha256 !== plannedSource.sha256 ||
    !nearlyEqual(artifact.durationSeconds, plannedSource.durationSeconds) ||
    artifact.codec !== plannedSource.codec ||
    artifact.bitrate !== plannedSource.bitrate
  ) {
    throw new Error(
      `Source-set clip provenance for order ${clip.entryOrder} does not match the manifest artifact`,
    );
  }
  const entry = requireEntry(manifest, clip.entryOrder);
  if (
    entry.cue.startSeconds === undefined ||
    entry.cue.endSeconds === undefined ||
    !nearlyEqual(entry.cue.startSeconds, clip.startSeconds) ||
    !nearlyEqual(entry.cue.endSeconds, clip.endSeconds)
  ) {
    throw new Error(
      `Source-set clip range for order ${clip.entryOrder} must equal its manifest cue`,
    );
  }
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.001;
}

function serializeManifest(manifest: SetManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function integerConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ACQUISITION_CONCURRENCY) {
    throw new RangeError(
      `concurrency must be an integer between 1 and ${String(MAX_ACQUISITION_CONCURRENCY)}`,
    );
  }
  return value;
}

function boundedConcurrency(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${String(maximum)}`);
  }
  return value;
}

function plannedArtifactCount(plan: AcquisitionPlan): number {
  return (
    plan.clips.length +
    plan.recordings.reduce((total, recording) => total + recording.variants.length, 0)
  );
}

function plannedArtifactEvents(
  plan: AcquisitionPlan,
  receipts: ReadonlyMap<string, AcquisitionVerificationReceipt>,
  status: AcquisitionArtifactVerified["status"],
): AcquisitionArtifactVerified[] {
  return [
    ...plan.clips.map((clip) => ({
      entryOrder: clip.entryOrder,
      path: clip.outputPath,
      sha256: requireVerificationReceipt(receipts, clip.outputPath).sha256,
      kind: "source-set-clip" as const,
      status,
    })),
    ...plan.recordings.flatMap((recording) =>
      recording.variants.map((variant, variantIndex) => ({
        entryOrder: recording.entryOrder,
        variantIndex,
        path: variant.outputPath,
        sha256: requireVerificationReceipt(receipts, variant.outputPath).sha256,
        kind: variant.sourceClip ? ("source-set-clip" as const) : ("individual" as const),
        status,
      })),
    ),
  ];
}

function requireVerificationReceipt(
  receipts: ReadonlyMap<string, AcquisitionVerificationReceipt>,
  path: string,
): AcquisitionVerificationReceipt {
  const receipt = receipts.get(path);
  if (!receipt) throw new Error(`Missing verification receipt for ${path}`);
  return receipt;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

function cacheStatsDelta(after: CacheStats, before?: CacheStats): CacheStats {
  const baseline: CacheStats = before ?? {
    hits: 0,
    misses: 0,
    writes: 0,
    bypasses: 0,
    coalesced: 0,
    errors: 0,
    readMs: 0,
    loadMs: 0,
    writeMs: 0,
  };
  return Object.fromEntries(
    Object.entries(after).map(([key, value]) => [
      key,
      roundMilliseconds(value - baseline[key as keyof CacheStats]),
    ]),
  ) as CacheStats;
}

function invalidateChangedRekordboxState(previous: SetManifest, current: SetManifest): void {
  let invalidated = false;
  let analysisInvalidated = false;
  const previousById = new Map(previous.entries.map((entry) => [entry.id, entry]));
  for (const entry of current.entries) {
    const prior = previousById.get(entry.id);
    if (prior && downstreamFingerprint(prior) === downstreamFingerprint(entry)) continue;
    analysisInvalidated = true;
    if (
      entry.rekordbox.status === "imported" ||
      entry.rekordbox.status === "exported" ||
      entry.rekordbox.status === "failed"
    ) {
      entry.rekordbox = { status: "pending" };
      invalidated = true;
    }
    const errors = entry.errors.filter((error) => error.stage !== "rekordbox");
    if (errors.length !== entry.errors.length) {
      entry.errors = errors;
      invalidated = true;
    }
  }
  if (invalidated) {
    current.errors = current.errors.filter((error) => error.stage !== "rekordbox");
    delete current.artifacts.rekordbox;
  }
  if (analysisInvalidated) delete current.artifacts.analysis;
}

function downstreamFingerprint(entry: ResolvedTrack): string {
  const acquisition =
    entry.acquisition.status === "downloaded"
      ? {
          status: entry.acquisition.status,
          download: entry.acquisition.download,
          alternatives: entry.acquisition.alternatives,
        }
      : entry.acquisition;
  return JSON.stringify(
    canonicalValue({
      cue: entry.cue,
      identity: entry.identity,
      spotify: entry.spotify,
      acquisition,
      acquisitionErrors: entry.errors.filter((error) => error.stage === "acquisition"),
    }),
  );
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

function markFailure(entry: ResolvedTrack, message: string, query?: string): void {
  const candidates = "candidates" in entry.acquisition ? entry.acquisition.candidates : undefined;
  entry.acquisition = {
    status: "failed",
    ...(candidates?.length ? { candidates } : {}),
    ...(query ? { query } : {}),
    error: { stage: "acquisition", message, retryable: true },
  };
  addAcquisitionError(entry, message);
}

function addAcquisitionError(entry: ResolvedTrack, message: string): void {
  if (entry.errors.some((error) => error.stage === "acquisition" && error.message === message))
    return;
  entry.errors.push({ stage: "acquisition", message, retryable: true });
}

function clearAcquisitionErrors(entry: ResolvedTrack): void {
  entry.errors = entry.errors.filter((error) => error.stage !== "acquisition");
}

function addUniqueWarning(entry: ResolvedTrack, warning: string): void {
  if (!entry.warnings.includes(warning)) entry.warnings.push(warning);
}

function toFailure(
  entryOrder: number,
  spotifyId: string | undefined,
  error: unknown,
): AcquireFailure {
  return {
    entryOrder,
    ...(spotifyId ? { spotifyId } : {}),
    message: errorMessage(error),
  };
}

type SpotifyApiTrack = {
  id: string;
  uri: string;
  url?: string;
  name: string;
  artists: string[];
  album?: string;
  albumArtists?: string[];
  releaseDate?: string;
  durationMs?: number;
  explicit?: boolean;
  isrc?: string;
};

function parseSpotifyApiTrack(value: unknown): SpotifyApiTrack | undefined {
  const track = asRecord(value);
  if (typeof track.id !== "string" || typeof track.name !== "string") return undefined;
  const artists = Array.isArray(track.artists)
    ? track.artists
        .map(asRecord)
        .map((artist) => artist.name)
        .filter((name): name is string => typeof name === "string")
    : [];
  if (!artists.length) return undefined;
  const album = asRecord(track.album);
  const albumArtists = Array.isArray(album.artists)
    ? album.artists
        .map(asRecord)
        .map((artist) => artist.name)
        .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    : [];
  const externalIds = asRecord(track.external_ids);
  const externalUrls = asRecord(track.external_urls);
  return {
    id: track.id,
    uri: typeof track.uri === "string" ? track.uri : `spotify:track:${track.id}`,
    ...(typeof externalUrls.spotify === "string" ? { url: externalUrls.spotify } : {}),
    name: track.name,
    artists,
    ...(typeof album.name === "string" ? { album: album.name } : {}),
    ...(albumArtists.length ? { albumArtists } : {}),
    ...(typeof album.release_date === "string" ? { releaseDate: album.release_date } : {}),
    ...(typeof track.duration_ms === "number" ? { durationMs: track.duration_ms } : {}),
    ...(typeof track.explicit === "boolean" ? { explicit: track.explicit } : {}),
    ...(typeof externalIds.isrc === "string" ? { isrc: externalIds.isrc } : {}),
  };
}

function mergeSpotifyCandidate(
  existing: Pick<SpotifyCandidate, "score">,
  fresh: SpotifyApiTrack,
): SpotifyCandidate {
  return {
    score: existing.score,
    id: fresh.id,
    uri: fresh.uri,
    ...(fresh.url ? { url: fresh.url } : {}),
    name: fresh.name,
    artists: fresh.artists,
    ...(fresh.album ? { album: fresh.album } : {}),
    ...(fresh.albumArtists?.length ? { albumArtists: fresh.albumArtists } : {}),
    ...(fresh.releaseDate ? { releaseDate: fresh.releaseDate } : {}),
    ...(fresh.durationMs === undefined ? {} : { durationMs: fresh.durationMs }),
    ...(fresh.explicit === undefined ? {} : { explicit: fresh.explicit }),
    ...(fresh.isrc ? { isrc: fresh.isrc } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasWrongDuration(target: YoutubeTarget, candidate: ScoredYoutubeCandidate): boolean {
  if (target.durationSeconds === undefined || candidate.durationSeconds === undefined) return false;
  return (
    Math.abs(target.durationSeconds - candidate.durationSeconds) >
    Math.max(30, target.durationSeconds * 0.1)
  );
}

async function validateAcquiredSource(
  source: IndividualDownload,
  target: YoutubeTarget,
): Promise<void> {
  try {
    await verifyAudioFile(
      source.path,
      target.durationSeconds === undefined
        ? {}
        : {
            expectedDurationSeconds: target.durationSeconds,
            durationToleranceSeconds: Math.max(10, target.durationSeconds * 0.035),
          },
    );
  } catch (error) {
    if (source.temporary !== false) await rm(source.path, { force: true });
    throw error;
  }
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let cursor = 0;
  let stopped = false;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      if (stopped) return;
      try {
        signal?.throwIfAborted();
      } catch (error) {
        if (!stopped) firstError = error;
        stopped = true;
        return;
      }
      const index = cursor++;
      try {
        await task(values[index]!);
      } catch (error) {
        if (!stopped) firstError = error;
        stopped = true;
        return;
      }
    }
  });
  const settled = await Promise.allSettled(workers);
  const unexpected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (unexpected && !stopped) {
    firstError = unexpected.reason;
    stopped = true;
  }
  if (!stopped && signal?.aborted) {
    try {
      signal.throwIfAborted();
    } catch (error) {
      firstError = error;
      stopped = true;
    }
  }
  if (stopped) throw firstError;
}

function throwIfAcquisitionCancelled(signal: AbortSignal | undefined, error: unknown): void {
  if (signal?.aborted) signal.throwIfAborted();
  if (error instanceof Error && error.name === "AbortError") throw error;
}
