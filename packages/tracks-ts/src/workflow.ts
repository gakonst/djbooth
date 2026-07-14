import { realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  analyzeTracks,
  type AnalyzeTracksOptions,
  type AnalyzeTracksResult,
} from "@gakonst/rekordbox";

import {
  acquireManifest,
  DEFAULT_ACQUISITION_CONCURRENCY,
  DEFAULT_SPOTIFY_REFRESH_CONCURRENCY,
  DEFAULT_VERIFICATION_CONCURRENCY,
  type AcquireManifestResult,
  type AcquisitionArtifactVerified,
  type AcquisitionPlan,
  type SpotifyLibraryClient,
  type TrackAcquirer,
} from "./acquire-manifest.js";
import { probeAudio, readManifest, sha256File, writeManifestAtomic } from "./acquisition.js";
import { JsonDiskCache, type CacheMode, type CacheStats } from "./cache.js";
import { TracksError } from "./errors.js";
import {
  buildAcquisitionPlan,
  type BuildAcquisitionPlanOptions,
} from "./generic-acquisition-plan.js";
import { identify } from "./identify.js";
import { defaultTrackLibraryRoot } from "./library-paths.js";
import { createManifest, type RekordboxAnalysisArtifact, type SetManifest } from "./manifest.js";
import {
  importManifestToRekordbox,
  type ImportManifestToRekordboxOptions,
  type ImportManifestToRekordboxResult,
} from "./rekordbox-db.js";
import {
  enrichSpotifyManifest,
  type SpotifyEnrichmentOptions,
  type SpotifyEnrichmentResult,
} from "./spotify-enrichment.js";
import type { IdentifyOptions, Tracklist } from "./types.js";

export type SetSourceClip = {
  /** Existing local set recording. The workflow never downloads it. */
  path: string;
  /** Canonical URL used to annotate extracted clips. Defaults to the resolved set URL. */
  url?: string;
};

type SourceSetArtifact = NonNullable<SetManifest["artifacts"]["sourceSet"]>;

export const DEFAULT_NATIVE_ANALYSIS_CONCURRENCY = 4;
export const MAX_NATIVE_ANALYSIS_CONCURRENCY = 64;

export type WorkflowStageName =
  | "resolve"
  | "source-set"
  | "spotify"
  | "acquisition"
  | "analysis"
  | "rekordbox";

export type WorkflowStageStatus = "completed" | "resumed" | "skipped";

export type WorkflowStage = {
  stage: WorkflowStageName;
  status: WorkflowStageStatus;
  durationMs: number;
  operations?: number;
  cacheHits?: number;
  networkRequests?: number;
  concurrency?: number;
};

export type WorkflowProgress = {
  stage: WorkflowStageName;
  status: "started" | WorkflowStageStatus;
  message: string;
  durationMs?: number;
};

export type WorkflowPerformance = {
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  warmResume: boolean;
  peakConcurrency: number;
  stages: WorkflowStage[];
  caches: Record<string, CacheStats>;
};

export type WorkflowImportOptions = Omit<
  ImportManifestToRekordboxOptions,
  "approved" | "analysisDirectories" | "manifest" | "manifestPath"
>;

export type RunSetToRekordboxOptions = {
  source: string;
  manifestPath: string;
  /** Canonical library root. Defaults to MUSIC_LIBRARY_ROOT or ~/.djtools/tracks. */
  outputDirectory?: string;
  /** Required acknowledgement: the final stage mutates the normal encrypted master.db. */
  approved: true;
  identify?: IdentifyOptions;
  spotify?: SpotifyLibraryClient;
  spotifyOptions?: SpotifyEnrichmentOptions;
  acquirers: TrackAcquirer[];
  localArtifactDirectories?: readonly string[];
  /** Source-set clipping is disabled unless this is explicitly true. */
  allowSourceSetClips?: boolean;
  /** An existing local set recording; the workflow never downloads a whole set. */
  sourceSet?: SetSourceClip;
  stagingDirectory?: string;
  cacheMode?: CacheMode;
  acquisitionConcurrency?: number;
  verificationConcurrency?: number;
  spotifyConcurrency?: number;
  analysisConcurrency?: number;
  analysis?: Omit<AnalyzeTracksOptions, "concurrency">;
  signal?: AbortSignal;
  rekordbox?: WorkflowImportOptions;
  onProgress?: (progress: WorkflowProgress) => void;
  dependencies?: Partial<RunSetToRekordboxDependencies>;
};

export type RunSetToRekordboxResult = {
  manifest: SetManifest;
  manifestPath: string;
  outputDirectory: string;
  acquisition: AcquireManifestResult;
  spotify?: SpotifyEnrichmentResult;
  analysis: AnalyzeTracksResult;
  analysisDirectories: Record<string, string>;
  rekordbox: ImportManifestToRekordboxResult;
  performance: WorkflowPerformance;
};

type WorkflowImportCallOptions = ImportManifestToRekordboxOptions & {
  analysisDirectories?: Readonly<Record<string, string>>;
};

export type RunSetToRekordboxDependencies = {
  exists(path: string): Promise<boolean>;
  readManifest(path: string): Promise<SetManifest>;
  writeManifest(path: string, manifest: SetManifest): Promise<void>;
  identify(source: string, options?: IdentifyOptions): Promise<Tracklist>;
  createManifest(tracklist: Tracklist): SetManifest;
  enrichSpotify(
    manifest: SetManifest,
    spotify: SpotifyLibraryClient,
    options?: SpotifyEnrichmentOptions,
  ): Promise<SpotifyEnrichmentResult>;
  describeSourceSet(source: SetSourceClip, manifest: SetManifest): Promise<SourceSetArtifact>;
  buildPlan(manifest: SetManifest, options: BuildAcquisitionPlanOptions): Promise<AcquisitionPlan>;
  acquire(options: Parameters<typeof acquireManifest>[0]): Promise<AcquireManifestResult>;
  analyze(paths: readonly string[], options?: AnalyzeTracksOptions): Promise<AnalyzeTracksResult>;
  importRekordbox(options: WorkflowImportCallOptions): Promise<ImportManifestToRekordboxResult>;
};

const defaultDependencies: RunSetToRekordboxDependencies = {
  async exists(path) {
    try {
      return (await stat(path)).isFile();
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  },
  readManifest,
  writeManifest: writeManifestAtomic,
  identify,
  createManifest,
  enrichSpotify: enrichSpotifyManifest,
  describeSourceSet,
  buildPlan: buildAcquisitionPlan,
  acquire: acquireManifest,
  analyze: analyzeTracks,
  importRekordbox: (options) => importManifestToRekordbox(options),
};

/**
 * Resolve, enrich, acquire, analyze, and import one set through library calls only.
 *
 * Durable manifests, metadata caches, completed audio, analyzer outputs, and the verified
 * Rekordbox checkpoint are reused on later runs. Independent work inside each stage uses its
 * configured bounded limit; the encrypted database still commits exactly once.
 */
export async function runSetToRekordbox(
  options: RunSetToRekordboxOptions,
): Promise<RunSetToRekordboxResult> {
  if (options.approved !== true) {
    throw new TracksError(
      "INVALID_SOURCE",
      "Set import requires approved: true because it writes the normal Rekordbox database",
      { exitCode: 2 },
    );
  }
  if (options.sourceSet && !options.allowSourceSetClips) {
    throw new TracksError(
      "INVALID_SOURCE",
      "A source set was supplied without explicit allowSourceSetClips: true",
      { exitCode: 2 },
    );
  }
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const startedAt = new Date();
  const started = performance.now();
  const stages: WorkflowStage[] = [];
  const manifestPath = resolve(options.manifestPath);
  const outputDirectory = resolve(options.outputDirectory ?? defaultTrackLibraryRoot());
  const existed = await dependencies.exists(manifestPath);

  const runStage = async <T>(
    stage: WorkflowStageName,
    task: () => Promise<{ value: T; details: Omit<WorkflowStage, "durationMs" | "stage"> }>,
  ): Promise<T> => {
    options.signal?.throwIfAborted();
    options.onProgress?.({ stage, status: "started", message: `${stage} started` });
    const stageStarted = performance.now();
    const { value, details } = await task();
    const durationMs = roundMilliseconds(performance.now() - stageStarted);
    stages.push({ stage, durationMs, ...details });
    options.onProgress?.({
      stage,
      status: details.status,
      message: `${stage} ${details.status} in ${durationMs.toFixed(2)}ms`,
      durationMs,
    });
    return value;
  };

  let manifest = await runStage("resolve", async () => {
    if (existed) {
      const resumed = await dependencies.readManifest(manifestPath);
      if (resumed.source.input !== options.source) {
        throw new TracksError(
          "INVALID_SOURCE",
          `Manifest source '${resumed.source.input}' does not match '${options.source}'`,
          { exitCode: 2 },
        );
      }
      return { value: resumed, details: { status: "resumed" } };
    }
    const resolved = dependencies.createManifest(
      await dependencies.identify(options.source, {
        ...options.identify,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.cacheMode && options.identify?.cacheMode === undefined
          ? { cacheMode: options.cacheMode }
          : {}),
      }),
    );
    resolved.artifacts.root = dirname(manifestPath);
    resolved.artifacts.manifest = manifestPath;
    resolved.artifacts.downloadDirectory = outputDirectory;
    await dependencies.writeManifest(manifestPath, resolved);
    return {
      value: resolved,
      details: { status: "completed", operations: resolved.entries.length },
    };
  });

  if (options.allowSourceSetClips) {
    manifest = await runStage("source-set", async () => {
      const prior = manifest.artifacts.sourceSet;
      const sourceSet = options.sourceSet
        ? prior && resolve(prior.path) === resolve(options.sourceSet.path)
          ? prior
          : await dependencies.describeSourceSet(options.sourceSet, manifest)
        : prior;
      if (!sourceSet) {
        throw new TracksError(
          "INVALID_SOURCE",
          "allowSourceSetClips requires an explicit local sourceSet or a verified manifest source-set artifact",
          { exitCode: 2 },
        );
      }
      const resumed = sourceSet === prior;
      if (!resumed) {
        manifest.artifacts.sourceSet = sourceSet;
        await dependencies.writeManifest(manifestPath, manifest);
      }
      return {
        value: manifest,
        details: { status: resumed ? "resumed" : "completed", operations: 1 },
      };
    });
  } else {
    stages.push({ stage: "source-set", status: "skipped", durationMs: 0 });
  }

  let spotifyResult: SpotifyEnrichmentResult | undefined;
  if (options.spotify) {
    spotifyResult = await runStage("spotify", async () => {
      const result = await dependencies.enrichSpotify(manifest, options.spotify!, {
        ...options.spotifyOptions,
        ...(options.signal ? { signal: options.signal } : {}),
        concurrency:
          options.spotifyConcurrency ??
          options.spotifyOptions?.concurrency ??
          DEFAULT_SPOTIFY_REFRESH_CONCURRENCY,
      });
      manifest = result.manifest;
      if (result.attempted || result.skipped)
        await dependencies.writeManifest(manifestPath, manifest);
      return {
        value: result,
        details: {
          status: result.attempted ? "completed" : "resumed",
          operations: result.attempted,
          ...(result.cache ? { cacheHits: result.cache.hits } : {}),
          networkRequests: result.networkRequests,
          concurrency: result.maxConcurrency,
        },
      };
    });
  } else {
    stages.push({ stage: "spotify", status: "skipped", durationMs: 0 });
  }

  const pendingSpotify = manifest.entries.filter(
    (entry) => entry.identity.status === "identified" && entry.spotify.status === "pending",
  );
  if (pendingSpotify.length) {
    throw new TracksError(
      "AUTH_REQUIRED",
      `${String(pendingSpotify.length)} identified tracks still need Spotify enrichment; provide one Spotify client before acquisition`,
      { exitCode: 2 },
    );
  }

  const sourceSet = options.allowSourceSetClips ? manifest.artifacts.sourceSet : undefined;
  const analysisConcurrency = options.analysisConcurrency ?? DEFAULT_NATIVE_ANALYSIS_CONCURRENCY;
  const analysisRuns: AnalyzeTracksResult[] = [];
  const analysisByPath = new Map<string, AnalyzeTracksResult["results"][number]>();
  const analysisByIdentity = new Map<string, AnalyzeTracksResult["results"][number]>();
  const analysisTasks = new Map<string, Promise<void>>();
  const analysisLimit = createPromiseLimiter(analysisConcurrency);
  let analysisStarted: number | undefined;
  let analysisPeakConcurrency = 0;
  let activeAnalysis = 0;
  const analyzerOptions = (concurrency: number): AnalyzeTracksOptions => ({
    ...options.analysis,
    concurrency,
    ...(options.signal ? { signal: options.signal } : {}),
    onProgress(progress) {
      options.analysis?.onProgress?.(progress);
      options.onProgress?.({
        stage: "analysis",
        status: "started",
        message: `${progress.phase} ${String(progress.completed)}/${String(progress.total)} ${basename(progress.audioPath)}`,
      });
    },
  });
  const analyzeVerifiedArtifact = async (artifact: AcquisitionArtifactVerified): Promise<void> => {
    const path = resolve(artifact.path);
    const identity = await analysisIdentity(path);
    const existing = analysisTasks.get(identity);
    if (existing) return existing;
    analysisStarted ??= performance.now();
    if (analysisTasks.size === 0) {
      options.onProgress?.({
        stage: "analysis",
        status: "started",
        message: "analysis started while acquisition continues",
      });
    }
    const task = analysisLimit(async () => {
      activeAnalysis += 1;
      analysisPeakConcurrency = Math.max(analysisPeakConcurrency, activeAnalysis);
      try {
        recordAnalysisRun(
          analysisRuns,
          analysisByPath,
          analysisByIdentity,
          [{ path, identity }],
          await dependencies.analyze([path], analyzerOptions(1)),
        );
      } finally {
        activeAnalysis -= 1;
      }
    });
    analysisTasks.set(identity, task);
    return task;
  };
  let acquisition: AcquireManifestResult;
  try {
    acquisition = await runStage("acquisition", async () => {
      const result = await dependencies.acquire({
        manifestPath,
        plan: (current) =>
          dependencies.buildPlan(current, {
            outputDirectory,
            ...(options.stagingDirectory
              ? { stagingDirectory: resolve(options.stagingDirectory) }
              : {}),
            localDirectories: (options.localArtifactDirectories ?? []).map((path) => resolve(path)),
            ...(sourceSet
              ? { allowSourceSetClips: true, sourceSetPath: resolve(sourceSet.path) }
              : {}),
          }),
        acquirers: options.acquirers,
        ...(options.spotify ? { spotify: options.spotify } : {}),
        refreshSpotify: false,
        requireCompletePlan: true,
        continueOnError: false,
        concurrency: options.acquisitionConcurrency ?? DEFAULT_ACQUISITION_CONCURRENCY,
        verificationConcurrency:
          options.verificationConcurrency ?? DEFAULT_VERIFICATION_CONCURRENCY,
        verificationCache: new JsonDiskCache({
          namespace: "audio-verification-v1",
          ...(options.cacheMode ? { mode: options.cacheMode } : {}),
        }),
        spotifyConcurrency: options.spotifyConcurrency ?? DEFAULT_SPOTIFY_REFRESH_CONCURRENCY,
        ...(options.signal ? { signal: options.signal } : {}),
        onProgress(progress) {
          options.onProgress?.({
            stage: "acquisition",
            status: "started",
            message: `${progress.phase}: ${progress.message}`,
          });
        },
        onArtifactVerified: analyzeVerifiedArtifact,
      });
      return {
        value: result,
        details: {
          status: result.downloaded.length ? "completed" : "resumed",
          operations: result.downloaded.length + result.resumed.length,
          ...(sumCacheMetric(result.performance.caches, "hits") === undefined
            ? {}
            : { cacheHits: sumCacheMetric(result.performance.caches, "hits")! }),
          concurrency: maximumObservedAcquisitionConcurrency(result),
        },
      };
    });
  } catch (error) {
    await Promise.allSettled(analysisTasks.values());
    throw error;
  }
  manifest = acquisition.manifest;
  assertAcquisitionComplete(manifest, acquisition);

  const mediaPaths = acquiredMediaPaths(manifest);
  const analysisRequests = await Promise.all(
    mediaPaths.map(async (path) => ({
      path: resolve(path),
      identity: await analysisIdentity(path),
    })),
  );
  assertDistinctAnalysisIdentities(analysisRequests);
  await Promise.all(analysisTasks.values());
  for (const request of analysisRequests) {
    const existing = analysisByIdentity.get(request.identity);
    if (existing && !analysisByPath.has(request.path)) analysisByPath.set(request.path, existing);
  }
  const missingAnalysis = analysisRequests.filter(({ path }) => !analysisByPath.has(path));
  if (missingAnalysis.length) {
    analysisStarted ??= performance.now();
    if (analysisTasks.size === 0) {
      options.onProgress?.({
        stage: "analysis",
        status: "started",
        message: "analysis started",
      });
    }
    const fallback = await dependencies.analyze(
      missingAnalysis.map(({ path }) => path),
      analyzerOptions(analysisConcurrency),
    );
    analysisPeakConcurrency = Math.max(analysisPeakConcurrency, fallback.concurrency);
    recordAnalysisRun(analysisRuns, analysisByPath, analysisByIdentity, missingAnalysis, fallback);
  }
  const analysisDurationMs = roundMilliseconds(
    performance.now() - (analysisStarted ?? performance.now()),
  );
  const analysis = combineAnalysisRuns(
    analysisRuns,
    analysisByPath,
    mediaPaths,
    analysisPeakConcurrency,
    analysisDurationMs,
  );
  const analysisArtifacts = analysis.results.map((result, index) =>
    toAnalysisArtifact(mediaPaths[index]!, result),
  );
  const analysisMetadataChanged = !isDeepStrictEqual(
    manifest.artifacts.analysis,
    analysisArtifacts,
  );
  if (analysisMetadataChanged) {
    manifest.artifacts.analysis = analysisArtifacts;
    await dependencies.writeManifest(manifestPath, manifest);
  }
  const analysisStatus = analysis.analyzed || analysisMetadataChanged ? "completed" : "resumed";
  stages.push({
    stage: "analysis",
    status: analysisStatus,
    durationMs: analysisDurationMs,
    operations: analysis.requested,
    cacheHits: analysis.cacheHits,
    concurrency: analysis.concurrency,
  });
  options.onProgress?.({
    stage: "analysis",
    status: analysisStatus,
    message: `analysis ${analysisStatus} in ${analysisDurationMs.toFixed(2)}ms`,
    durationMs: analysisDurationMs,
  });
  const analysisDirectories = Object.fromEntries(
    analysis.results.map((result, index) => [
      resolve(mediaPaths[index]!),
      dirname(result.summaryPath),
    ]),
  );

  const rekordbox = await runStage("rekordbox", async () => {
    const result = await dependencies.importRekordbox({
      approved: true,
      manifest,
      manifestPath,
      analysisDirectories,
      ...options.rekordbox,
    });
    return {
      value: result,
      details: {
        status: result.performance.changed ? "completed" : "resumed",
        operations: result.imported.length,
        concurrency: 1,
      },
    };
  });
  manifest = rekordbox.manifest;

  const caches: Record<string, CacheStats> = {
    ...(spotifyResult?.cache ? { spotify: spotifyResult.cache } : {}),
    ...acquisition.performance.caches,
  };
  const peakConcurrency = Math.max(
    1,
    ...stages.map((stage) => stage.concurrency ?? 0),
    spotifyResult?.maxConcurrency ?? 0,
    maximumObservedAcquisitionConcurrency(acquisition),
    analysis.concurrency,
  );
  return {
    manifest,
    manifestPath,
    outputDirectory,
    acquisition,
    ...(spotifyResult ? { spotify: spotifyResult } : {}),
    analysis,
    analysisDirectories,
    rekordbox,
    performance: {
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      totalMs: roundMilliseconds(performance.now() - started),
      warmResume:
        existed &&
        stages.every((stage) => stage.status === "resumed" || stage.status === "skipped"),
      peakConcurrency,
      stages,
      caches,
    },
  };
}

function toAnalysisArtifact(
  mediaPath: string,
  result: AnalyzeTracksResult["results"][number],
): RekordboxAnalysisArtifact {
  return {
    mediaPath: resolve(mediaPath),
    summaryPath: resolve(result.summaryPath),
    backend: result.backend,
    tempoBpm: result.summary.tempo_bpm,
    key: result.summary.key,
    keySource: result.summary.key_source,
    sourceMtimeMs: result.source.mtimeMs,
    sourceSize: result.source.size,
  };
}

async function describeSourceSet(
  source: SetSourceClip,
  manifest: SetManifest,
): Promise<SourceSetArtifact> {
  const path = resolve(source.path);
  const [probe, sha256] = await Promise.all([probeAudio(path), sha256File(path)]);
  if (!probe.bitrate) {
    throw new TracksError("INVALID_SOURCE", `Could not determine source-set bitrate for '${path}'`);
  }
  const url = source.url ?? manifest.source.url ?? manifest.source.input;
  return {
    url,
    path,
    sha256,
    durationSeconds: probe.durationSeconds,
    codec: probe.codec,
    bitrate: probe.bitrate,
  };
}

function acquiredMediaPaths(manifest: SetManifest): string[] {
  const paths = new Set<string>();
  for (const entry of manifest.entries) {
    if (entry.acquisition.status !== "downloaded") continue;
    for (const download of [
      entry.acquisition.download,
      ...(entry.acquisition.alternatives ?? []),
    ]) {
      paths.add(resolve(download.mediaPath));
    }
  }
  return [...paths];
}

function assertAcquisitionComplete(
  manifest: SetManifest,
  acquisition: AcquireManifestResult,
): void {
  const incomplete = manifest.entries.filter((entry) => entry.acquisition.status !== "downloaded");
  if (!acquisition.failures.length && !incomplete.length) return;
  throw new TracksError(
    "TOOL_FAILED",
    `Acquisition incomplete: ${String(incomplete.length)} manifest entries and ${String(acquisition.failures.length)} failures; refusing Rekordbox import`,
    {
      details: {
        incomplete: incomplete.map((entry) => ({
          id: entry.id,
          order: entry.order,
          status: entry.acquisition.status,
        })),
        failures: acquisition.failures,
      },
    },
  );
}

function maximumObservedAcquisitionConcurrency(result: AcquireManifestResult): number {
  return Math.max(0, ...result.performance.stages.map((stage) => stage.maxConcurrency ?? 0));
}

function sumCacheMetric(
  caches: Record<string, CacheStats> | undefined,
  metric: keyof CacheStats,
): number | undefined {
  if (!caches) return undefined;
  return Object.values(caches).reduce((total, cache) => total + cache[metric], 0);
}

function recordAnalysisRun(
  runs: AnalyzeTracksResult[],
  byPath: Map<string, AnalyzeTracksResult["results"][number]>,
  byIdentity: Map<string, AnalyzeTracksResult["results"][number]>,
  requests: readonly AnalysisRequest[],
  run: AnalyzeTracksResult,
): void {
  if (run.results.length !== requests.length) {
    throw new Error(
      `Native analysis returned ${String(run.results.length)} results for ${String(requests.length)} requested media paths`,
    );
  }
  for (const [index, request] of requests.entries()) {
    const result = run.results[index]!;
    const resultIdentity = resolve(result.source.path);
    if (resultIdentity !== request.identity) {
      throw new Error(
        `Native analysis result '${resultIdentity}' does not match requested media identity '${request.identity}'`,
      );
    }
    if (byPath.has(request.path))
      throw new Error(`Native analysis returned duplicate media path '${request.path}'`);
    if (byIdentity.has(request.identity))
      throw new Error(`Native analysis returned duplicate media identity '${request.identity}'`);
  }
  runs.push(run);
  for (const [index, request] of requests.entries()) {
    const result = run.results[index]!;
    byPath.set(request.path, result);
    byIdentity.set(request.identity, result);
  }
}

type AnalysisRequest = {
  /** Manifest-owned durable key; never replace this with an analyzer realpath. */
  path: string;
  /** Canonical filesystem identity used only to correlate analyzer work/results. */
  identity: string;
};

async function analysisIdentity(path: string): Promise<string> {
  const lexical = resolve(path);
  try {
    return await realpath(lexical);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return lexical;
    throw error;
  }
}

function assertDistinctAnalysisIdentities(requests: readonly AnalysisRequest[]): void {
  const byIdentity = new Map<string, string>();
  for (const request of requests) {
    const prior = byIdentity.get(request.identity);
    if (prior && prior !== request.path) {
      throw new TracksError(
        "INVALID_SOURCE",
        `Downloaded manifest paths '${prior}' and '${request.path}' resolve to the same media file`,
        { exitCode: 2 },
      );
    }
    byIdentity.set(request.identity, request.path);
  }
}

function combineAnalysisRuns(
  runs: readonly AnalyzeTracksResult[],
  byPath: ReadonlyMap<string, AnalyzeTracksResult["results"][number]>,
  mediaPaths: readonly string[],
  concurrency: number,
  elapsedMs: number,
): AnalyzeTracksResult {
  const results = mediaPaths.map((mediaPath) => {
    const result = byPath.get(resolve(mediaPath));
    if (!result) throw new Error(`Native analysis returned no result for '${resolve(mediaPath)}'`);
    return result;
  });
  const analyzed = runs.reduce((total, run) => total + run.analyzed, 0);
  const cacheHits = runs.reduce((total, run) => total + run.cacheHits, 0);
  return {
    analyzed,
    cacheHits,
    concurrency: mediaPaths.length ? Math.max(1, concurrency) : 0,
    elapsedMs: Math.round(elapsedMs),
    requested: mediaPaths.length,
    results,
    throughputTracksPerSecond:
      analyzed && elapsedMs ? roundMilliseconds((analyzed * 1_000) / elapsedMs) : 0,
    timings: {
      analyzeMs: elapsedMs,
      preflightMs: Math.max(0, ...runs.map((run) => run.timings.preflightMs)),
      totalMs: elapsedMs,
    },
  };
}

function createPromiseLimiter(concurrency: number) {
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_NATIVE_ANALYSIS_CONCURRENCY
  ) {
    throw new RangeError(
      `analysisConcurrency must be an integer between 1 and ${String(MAX_NATIVE_ANALYSIS_CONCURRENCY)}`,
    );
  }
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

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
