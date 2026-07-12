import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";

import {
  acquirePipelineManifestLock,
  createSourceSetClip,
  probeAudio,
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
    options?: { query?: Record<string, string | number | boolean | readonly string[] | undefined> },
  ): Promise<T | undefined>;
};

export type BackendAvailability = { available: true } | { available: false; reason: string };

export type IndividualDownload = {
  path: string;
  source: string;
  engine?: "native" | "reference";
  temporary?: boolean;
  qualityNote?: string;
  transcoded?: boolean;
};

export type TrackAcquirer = {
  backend: AcquisitionBackend;
  availability(): Promise<BackendAvailability>;
  search(target: YoutubeTarget): Promise<YoutubeSearchCandidate[]>;
  download(
    candidate: ScoredYoutubeCandidate,
    destinationDirectory: string,
    basename: string,
  ): Promise<IndividualDownload>;
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
  spotifyId: string;
  isrc?: string;
  title: string;
  artists: string[];
  album?: string;
  albumArtists?: string[];
  releaseDate?: string;
  durationMs?: number;
  outputPath: string;
  metadata: AudioMetadata;
  searchQuery?: string;
  preferredCandidate?: YoutubeSearchCandidate & { backend: AcquisitionBackend };
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
  stages: Array<{ stage: string; durationMs: number; operations?: number }>;
  checkpoints: { writes: number; skipped: number; durationMs: number };
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

export type AcquireManifestOptions = {
  manifestPath: string;
  plan: AcquisitionPlan | ((manifest: SetManifest) => AcquisitionPlan | Promise<AcquisitionPlan>);
  prepare?: (manifest: SetManifest) => SetManifest | Promise<SetManifest>;
  spotify?: SpotifyLibraryClient;
  refreshSpotify?: boolean;
  acquirers: TrackAcquirer[];
  minimumScore?: number;
  requireCompletePlan?: boolean;
  dryRun?: boolean;
  continueOnError?: boolean;
  /** Independent recording jobs. Variants of one ambiguous cue remain ordered. */
  concurrency?: number;
  /** Optional stat-keyed cache for successful SHA/tag/duration verification receipts. */
  verificationCache?: JsonDiskCache | false;
  onProgress?: (progress: AcquireProgress) => void;
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
  let checkpointWrites = 0;
  const measure = async <T>(stage: string, task: () => T | Promise<T>): Promise<T> => {
    const started = performance.now();
    try {
      return await task();
    } finally {
      stages.push({ stage, durationMs: roundMilliseconds(performance.now() - started) });
    }
  };
  const concurrency = integerConcurrency(options.concurrency ?? 3);
  const verificationCache =
    options.verificationCache === false ? undefined : options.verificationCache;
  const verificationCacheBefore = verificationCache?.snapshot();
  const performanceResult = (): AcquisitionPerformance => ({
    startedAt: runStartedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    totalMs: roundMilliseconds(performance.now() - runStarted),
    concurrency,
    stages,
    checkpoints: {
      writes: checkpointWrites,
      skipped: checkpointCalls - checkpointWrites,
      durationMs: roundMilliseconds(checkpointMs),
    },
    ...(verificationCache
      ? {
          caches: { audio: cacheStatsDelta(verificationCache.snapshot(), verificationCacheBefore) },
        }
      : {}),
  });
  const manifestPath = resolve(options.manifestPath);
  const release = await measure("manifest-lock", () => acquirePipelineManifestLock(manifestPath));
  try {
    let expectedManifestContents = await readFile(manifestPath, "utf8");
    let manifest = parseManifest(JSON.parse(expectedManifestContents) as unknown);
    let checkpointedManifest = structuredClone(manifest);
    let checkpointTail = Promise.resolve();
    const checkpoint = (mutate?: () => void): Promise<void> => {
      const next = checkpointTail.then(async () => {
        const checkpointStarted = performance.now();
        checkpointCalls += 1;
        mutate?.();
        invalidateChangedRekordboxState(checkpointedManifest, manifest);
        const snapshot = structuredClone(manifest);
        const serialized = serializeManifest(snapshot);
        if (serialized === expectedManifestContents) {
          checkpointedManifest = snapshot;
          checkpointMs += performance.now() - checkpointStarted;
          return;
        }
        try {
          checkpointWrites += 1;
          await writeManifestAtomic(manifestPath, snapshot, {
            expectedContents: expectedManifestContents,
          });
          expectedManifestContents = serialized;
          checkpointedManifest = snapshot;
        } finally {
          checkpointMs += performance.now() - checkpointStarted;
        }
      });
      checkpointTail = next.catch(() => undefined);
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
        await measure("spotify-refresh", () =>
          refreshKnownSpotifyTracks(manifest, options.spotify!),
        );
      } catch (error) {
        const warning = `Spotify refresh failed; retained checkpointed metadata: ${errorMessage(error)}`;
        if (!manifest.warnings.includes(warning)) manifest.warnings.push(warning);
      }
    }

    const plan = await measure("acquisition-plan", async () =>
      typeof options.plan === "function" ? options.plan(manifest) : options.plan,
    );
    validatePlan(manifest, plan, options.requireCompletePlan ?? false);
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

    const verificationReceipts = await measure("artifact-preflight", () =>
      preflightExistingArtifacts(manifest, plan, Math.max(concurrency, 4), verificationCache),
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
          verifyAcquisitionPlan(manifest, plan, verificationReceipts),
        );
      } catch {
        // Valid media without a complete manifest checkpoint falls through for reconciliation.
      }
      if (verification) {
        resumed.push(...plannedPaths);
        await checkpoint();
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
    await checkpoint();

    const availableAcquirers: TrackAcquirer[] = [];
    const needsBackend = plan.recordings.some((recording) =>
      recording.variants.some(
        (variant) => !variant.sourceClip && !verificationReceipts.has(variant.outputPath),
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

    await measure("clips", () =>
      mapConcurrent(plan.clips, Math.min(concurrency, 2), async (clip) => {
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
            downloaded.push(clip.outputPath);
          }
          await checkpoint(() => {
            const entry = requireEntry(manifest, clip.entryOrder);
            entry.acquisition = clipState(clip, sha256);
            clearAcquisitionErrors(entry);
          });
        } catch (error) {
          const failure = toFailure(clip.entryOrder, undefined, error);
          failures.push(failure);
          await checkpoint(() =>
            markFailure(requireEntry(manifest, clip.entryOrder), failure.message),
          );
          if (options.continueOnError === false) throw error;
        }
      }),
    );

    await mkdir(plan.stagingDirectory, { recursive: true });
    await measure("recordings", () =>
      mapConcurrent(plan.recordings, concurrency, async (recording) => {
        const entry = structuredClone(requireEntry(manifest, recording.entryOrder));
        const persistEntry = () => checkpoint(() => replaceEntry(manifest, structuredClone(entry)));
        const priorAcquisition =
          entry.acquisition.status === "downloaded"
            ? structuredClone(entry.acquisition)
            : undefined;
        const priorDownloads = new Map(
          priorAcquisition
            ? [priorAcquisition.download, ...(priorAcquisition.alternatives ?? [])].flatMap(
                (download) => (download.spotifyId ? [[download.spotifyId, download] as const] : []),
              )
            : [],
        );
        const completed: Array<{
          download: AcquisitionDownload;
          candidate?: AcquisitionCandidate;
        }> = [];
        let recordingFailed = false;
        for (const [variantIndex, variant] of recording.variants.entries()) {
          options.onProgress?.({
            phase: "recording",
            entryOrder: recording.entryOrder,
            variant: variantIndex + 1,
            totalVariants: recording.variants.length,
            message: `Acquiring ${variant.artists.join(", ")} — ${variant.title}`,
          });
          try {
            const prior = priorDownloads.get(variant.spotifyId);
            if (prior && prior.mediaPath !== variant.outputPath) {
              variant.outputPath = prior.mediaPath;
            }
            const receipt = verificationReceipts.get(variant.outputPath);
            if (receipt) {
              const priorCandidate = candidateFromDownload(prior, priorAcquisition, variant);
              completed.push({
                download:
                  prior ??
                  (variant.sourceClip
                    ? recordingClipDownload(variant, receipt.sha256)
                    : individualDownload(variant, variant.outputPath, receipt.sha256)),
                ...(priorCandidate ? { candidate: priorCandidate } : {}),
              });
              resumed.push(variant.outputPath);
              continue;
            }

            if (variant.sourceClip) {
              const clip = variant.sourceClip;
              const verified = await createSourceSetClip({
                sourcePath: clip.sourcePath,
                outputPath: variant.outputPath,
                startSeconds: clip.startSeconds,
                endSeconds: clip.endSeconds,
                metadata: variant.metadata,
              });
              completed.push({
                download: {
                  backend: "ytdlp",
                  kind: "source-set-clip",
                  mediaPath: variant.outputPath,
                  files: [variant.outputPath],
                  source: clip.sourceUrl,
                  engine: "reference",
                  sha256: verified.sha256,
                  spotifyId: variant.spotifyId,
                  clip: {
                    sourceSetUrl: clip.sourceUrl,
                    ...(clip.sourceTitle ? { sourceSetTitle: clip.sourceTitle } : {}),
                    startSeconds: clip.startSeconds,
                    endSeconds: clip.endSeconds,
                    containsTransitions: clip.containsTransitions,
                    qualityNote: clip.qualityNote,
                  },
                },
              });
              addUniqueWarning(
                entry,
                `${variant.spotifyId} is a cue-based source-set extract, not a verified release master; ISRC deliberately omitted`,
              );
              downloaded.push(variant.outputPath);
              persistPartial(entry, recording, completed);
              await persistEntry();
              continue;
            }

            const target: YoutubeTarget = {
              title: variant.title,
              artists: variant.artists,
              ...(variant.durationMs === undefined
                ? {}
                : { durationSeconds: variant.durationMs / 1000 }),
            };
            const acquired = await acquireVariant(
              target,
              variant,
              availableAcquirers,
              plan.stagingDirectory,
              minimumScore,
              variant.preferredCandidate,
            );
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
              audioCodec: retagCodec,
              ...(variant.durationMs === undefined
                ? {}
                : { expectedDurationSeconds: variant.durationMs / 1000 }),
            });
            if (acquired.source.temporary !== false)
              await rm(acquired.source.path, { force: true });
            const download: AcquisitionDownload = {
              backend: acquired.acquirer.backend,
              kind: "individual",
              mediaPath: variant.outputPath,
              files: [variant.outputPath],
              source: acquired.candidate.source,
              ...(acquired.source.engine ? { engine: acquired.source.engine } : {}),
              sha256: tagged.sha256,
              spotifyId: variant.spotifyId,
              ...(variant.isrc ? { isrc: variant.isrc } : {}),
            };
            if (acquired.source.qualityNote) {
              addUniqueWarning(
                entry,
                `${variant.spotifyId} acquisition quality: ${acquired.source.qualityNote}`,
              );
            }
            if (acquired.source.transcoded) {
              addUniqueWarning(
                entry,
                `${variant.spotifyId} required a lossy compatibility transcode`,
              );
            }
            if (retagCodec === "aac") {
              addUniqueWarning(
                entry,
                `${variant.spotifyId} Soulseek source required a lossy AAC compatibility transcode`,
              );
            } else if (retagCodec === "flac") {
              addUniqueWarning(
                entry,
                `${variant.spotifyId} Soulseek PCM source was losslessly converted to FLAC`,
              );
            }
            completed.push({
              download,
              candidate: manifestCandidate(acquired.acquirer, acquired.candidate),
            });
            downloaded.push(variant.outputPath);
            persistPartial(entry, recording, completed);
            await persistEntry();
          } catch (error) {
            recordingFailed = true;
            const failure = toFailure(recording.entryOrder, variant.spotifyId, error);
            failures.push(failure);
            if (completed.length) {
              persistPartial(entry, recording, completed);
              addAcquisitionError(entry, failure.message);
            } else {
              markFailure(entry, failure.message, variant.searchQuery);
            }
            await persistEntry();
            if (options.continueOnError === false) throw error;
          }
        }
        if (!recordingFailed && completed.length === recording.variants.length) {
          persistPartial(entry, recording, completed);
          clearAcquisitionErrors(entry);
          await persistEntry();
        }
      }),
    );

    const verification = failures.length
      ? undefined
      : await measure("final-verification", () =>
          verifyAcquisitionPlan(manifest, plan, verificationReceipts),
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
): Promise<AcquisitionVerification> {
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
        durationSeconds: variant.sourceClip
          ? variant.sourceClip.endSeconds - variant.sourceClip.startSeconds
          : variant.durationMs === undefined
            ? undefined
            : variant.durationMs / 1000,
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
  await mapConcurrent(filesToVerify, 4, async ({ item, expectedSha256 }) => {
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

export async function refreshKnownSpotifyTracks(
  manifest: SetManifest,
  spotify: SpotifyLibraryClient,
): Promise<void> {
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
  await mapConcurrent(ids, 4, async (id) => {
    const response = await spotify.raw<unknown>("GET", `tracks/${encodeURIComponent(id)}`);
    const track = parseSpotifyApiTrack(response);
    if (track) tracksById.set(track.id, track);
  });
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
}

async function acquireVariant(
  target: YoutubeTarget,
  variant: AcquisitionRecordingVariant,
  acquirers: readonly TrackAcquirer[],
  stagingDirectory: string,
  minimumScore: number,
  preferredCandidate?: YoutubeSearchCandidate & { backend: AcquisitionBackend },
): Promise<{
  acquirer: TrackAcquirer;
  candidate: ScoredYoutubeCandidate;
  source: IndividualDownload;
}> {
  const failures: string[] = [];
  if (preferredCandidate) {
    const preferredAcquirer = acquirers.find(
      (acquirer) => acquirer.backend === preferredCandidate.backend,
    );
    if (preferredAcquirer) {
      const selected: ScoredYoutubeCandidate = { ...preferredCandidate, score: 1 };
      let source: IndividualDownload | undefined;
      try {
        source = await preferredAcquirer.download(
          selected,
          candidateStagingDirectory(stagingDirectory, variant, preferredAcquirer.backend, selected),
          variant.spotifyId,
        );
        await validateAcquiredSource(source, target);
        return { acquirer: preferredAcquirer, candidate: selected, source };
      } catch (error) {
        if (source && source.temporary !== false) await rm(source.path, { force: true });
        failures.push(`${preferredAcquirer.backend} audited source: ${errorMessage(error)}`);
      }
    } else {
      failures.push(`${preferredCandidate.backend}: audited source backend unavailable`);
    }
  }
  for (const acquirer of acquirers) {
    let candidates: ScoredYoutubeCandidate[];
    try {
      candidates = scoreYoutubeCandidates(target, await acquirer.search(target));
    } catch (error) {
      failures.push(`${acquirer.backend} search: ${errorMessage(error)}`);
      continue;
    }
    const eligible = candidates.filter(
      (candidate) => candidate.score >= minimumScore && !hasWrongDuration(target, candidate),
    );
    if (!eligible.length) {
      const best = candidates[0];
      failures.push(
        `${acquirer.backend}: no candidate met score ${minimumScore.toFixed(2)}${best ? ` (best ${best.score.toFixed(3)}: ${best.title})` : ""}`,
      );
      continue;
    }
    for (const selected of eligible) {
      let source: IndividualDownload | undefined;
      try {
        source = await acquirer.download(
          selected,
          candidateStagingDirectory(stagingDirectory, variant, acquirer.backend, selected),
          variant.spotifyId,
        );
        await validateAcquiredSource(source, target);
        return { acquirer, candidate: selected, source };
      } catch (error) {
        if (source && source.temporary !== false) await rm(source.path, { force: true });
        failures.push(`${acquirer.backend} ${selected.id}: ${errorMessage(error)}`);
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
      `${variant.spotifyId}\u0000${variant.outputPath}\u0000${backend}\u0000${candidate.id}\u0000${candidate.source}`,
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
  const candidates = completed.flatMap((item) => (item.candidate ? [item.candidate] : []));
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
  return {
    backend: "ytdlp",
    kind: "individual",
    mediaPath: path,
    files: [path],
    sha256,
    spotifyId: variant.spotifyId,
    ...(variant.isrc ? { isrc: variant.isrc } : {}),
  };
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
    spotifyId: variant.spotifyId,
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
  if (!download?.source) return undefined;
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

async function preflightExistingArtifacts(
  manifest: SetManifest,
  plan: AcquisitionPlan,
  concurrency: number,
  cache?: JsonDiskCache,
): Promise<Map<string, AcquisitionVerificationReceipt>> {
  const expected = [
    ...plan.clips.map((clip) => {
      const prior = downloadForPath(requireEntry(manifest, clip.entryOrder), clip.outputPath);
      return {
        path: clip.outputPath,
        metadata: clip.metadata,
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
        const prior = downloads.find((download) => download.spotifyId === variant.spotifyId);
        if (prior && prior.mediaPath !== variant.outputPath) variant.outputPath = prior.mediaPath;
        return {
          path: variant.outputPath,
          metadata: variant.metadata,
          expectedSha256: prior?.sha256,
          expectedDurationSeconds: variant.sourceClip
            ? variant.sourceClip.endSeconds - variant.sourceClip.startSeconds
            : variant.durationMs === undefined
              ? undefined
              : variant.durationMs / 1000,
          durationToleranceSeconds: variant.sourceClip
            ? 2
            : Math.max(10, ((variant.durationMs ?? 0) / 1000) * 0.035),
          eligible: prior !== undefined || variant.sourceClip !== undefined,
        };
      });
    }),
  ];
  const receipts = new Map<string, AcquisitionVerificationReceipt>();
  await mapConcurrent(expected, concurrency, async (item) => {
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
          expectedMetadata: item.metadata,
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
    } catch {
      // A missing or invalid artifact is reacquired by the normal stage below.
    }
  });
  return receipts;
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
  if (requireComplete && planned.length !== manifest.entries.length) {
    throw new Error(
      `Complete acquisition plan must cover all ${manifest.entries.length} entries; received ${planned.length}`,
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
    if (!spotifyCandidates.length) {
      throw new Error(
        `Recording plan for order ${recording.entryOrder} requires a matched or ambiguous Spotify decision`,
      );
    }
    const expectedById = new Map(spotifyCandidates.map((candidate) => [candidate.id, candidate]));
    const spotifyIds = new Set<string>();
    for (const variant of recording.variants) {
      if (!variant.spotifyId.trim()) {
        throw new Error(`Recording variant for order ${recording.entryOrder} has no Spotify ID`);
      }
      if (spotifyIds.has(variant.spotifyId)) {
        throw new Error(
          `Recording plan for order ${recording.entryOrder} repeats Spotify ID ${variant.spotifyId}`,
        );
      }
      spotifyIds.add(variant.spotifyId);
      const expected = expectedById.get(variant.spotifyId);
      if (!expected) {
        throw new Error(
          `Recording plan for order ${recording.entryOrder} uses unapproved Spotify ID ${variant.spotifyId}`,
        );
      }
      if (
        variant.durationMs !== undefined &&
        (!Number.isSafeInteger(variant.durationMs) || variant.durationMs <= 0)
      ) {
        throw new Error(`Recording duration must be a positive integer for ${variant.spotifyId}`);
      }
      if (expected.durationMs !== undefined && variant.durationMs !== expected.durationMs) {
        throw new Error(`Recording duration does not match Spotify for ${variant.spotifyId}`);
      }
      if (expected.name !== undefined && variant.title !== expected.name) {
        throw new Error(`Recording title does not match Spotify for ${variant.spotifyId}`);
      }
      if (expected.artists !== undefined && !sameStrings(variant.artists, expected.artists)) {
        throw new Error(`Recording artists do not match Spotify for ${variant.spotifyId}`);
      }
      if (!variant.sourceClip) {
        const outputExtension = extname(variant.outputPath).toLocaleLowerCase("en-US");
        const checkpointed = downloadForPath(entry, variant.outputPath);
        const allowedAdaptedOutput =
          allowCheckpointedSoulseekOutputs &&
          checkpointed?.backend === "slsk" &&
          (outputExtension === ".flac" || outputExtension === ".mp3");
        if (outputExtension !== ".m4a" && !allowedAdaptedOutput) {
          throw new Error(
            `Individual recording output must use an M4A staging target: ${variant.outputPath}`,
          );
        }
        if (expected.isrc && variant.isrc !== expected.isrc) {
          throw new Error(`Recording ISRC does not match Spotify for ${variant.spotifyId}`);
        }
        if (expected.isrc && variant.metadata.isrc !== expected.isrc) {
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
  if (!Number.isSafeInteger(value) || value < 1 || value > 8) {
    throw new RangeError("concurrency must be an integer between 1 and 8");
  }
  return value;
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
  const previousById = new Map(previous.entries.map((entry) => [entry.id, entry]));
  for (const entry of current.entries) {
    const prior = previousById.get(entry.id);
    if (prior && downstreamFingerprint(prior) === downstreamFingerprint(entry)) continue;
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
  entry.acquisition = {
    status: "failed",
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
    if (target.durationSeconds === undefined) {
      await probeAudio(source.path);
      return;
    }
    await verifyAudioFile(source.path, {
      expectedDurationSeconds: target.durationSeconds,
      durationToleranceSeconds: Math.max(10, target.durationSeconds * 0.035),
    });
  } catch (error) {
    if (source.temporary !== false) await rm(source.path, { force: true });
    throw error;
  }
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  let firstError: unknown;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      if (firstError !== undefined) return;
      const index = cursor++;
      try {
        await task(values[index]!);
      } catch (error) {
        firstError ??= error;
        return;
      }
    }
  });
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
}
