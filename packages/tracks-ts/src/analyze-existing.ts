import { dirname, resolve } from "node:path";
import { realpath } from "node:fs/promises";

import {
  analyzeTracks,
  type AnalyzeTracksOptions,
  type AnalyzeTracksResult,
  type RekordboxAnalysisResult,
} from "@gakonst/rekordbox";

import {
  acquirePipelineManifestLock,
  readManifestSnapshot,
  writeManifestAtomic,
} from "./acquisition.js";
import { TracksError } from "./errors.js";
import type {
  RekordboxAnalysisArtifact,
  RekordboxAnalysisRunArtifact,
  SetManifest,
} from "./manifest.js";
import { DEFAULT_NATIVE_ANALYSIS_CONCURRENCY } from "./workflow.js";

export type AnalyzeExistingManifestProgress = Parameters<
  NonNullable<AnalyzeTracksOptions["onProgress"]>
>[0];

export type AnalyzeExistingManifestOptions = Omit<AnalyzeTracksOptions, "concurrency"> & {
  manifestPath: string;
  concurrency?: number;
  dependencies?: Partial<AnalyzeExistingManifestDependencies>;
};

export type AnalyzeExistingManifestResult = {
  analysis: AnalyzeTracksResult;
  analysisDirectories: Record<string, string>;
  finishedAt: string;
  manifest: SetManifest;
  manifestPath: string;
  startedAt: string;
  totalMs: number;
};

export type AnalyzeExistingManifestDependencies = {
  acquireLock: typeof acquirePipelineManifestLock;
  analyze: typeof analyzeTracks;
  readManifestSnapshot: typeof readManifestSnapshot;
  writeManifest: typeof writeManifestAtomic;
};

const defaultDependencies: AnalyzeExistingManifestDependencies = {
  acquireLock: acquirePipelineManifestLock,
  analyze: analyzeTracks,
  readManifestSnapshot,
  writeManifest: writeManifestAtomic,
};

/** Analyze only media already recorded in a durable manifest; never acquire, retag, or import. */
export async function analyzeExistingManifest(
  options: AnalyzeExistingManifestOptions,
): Promise<AnalyzeExistingManifestResult> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const manifestPath = resolve(options.manifestPath);
  const dependencies = { ...defaultDependencies, ...options.dependencies };
  const release = await dependencies.acquireLock(manifestPath);
  try {
    const snapshot = await dependencies.readManifestSnapshot(manifestPath);
    const manifest = snapshot.manifest;
    const mediaPaths = acquiredMediaPaths(manifest);
    if (!mediaPaths.length) {
      throw new TracksError("INVALID_SOURCE", "Manifest has no downloaded media to analyze", {
        exitCode: 2,
      });
    }

    let analysis: AnalyzeTracksResult;
    try {
      analysis = await dependencies.analyze(mediaPaths, {
        concurrency: options.concurrency ?? DEFAULT_NATIVE_ANALYSIS_CONCURRENCY,
        ...(options.analyzerBinary ? { analyzerBinary: options.analyzerBinary } : {}),
        ...(options.force === undefined ? {} : { force: options.force }),
        ...(options.rekordboxApp ? { rekordboxApp: options.rekordboxApp } : {}),
        ...(options.rekordboxCache ? { rekordboxCache: options.rekordboxCache } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      });
    } catch (error) {
      const status = error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed";
      const partial = partialAnalysis(error, mediaPaths.length);
      const run = analysisRunArtifact(
        startedAt,
        new Date().toISOString(),
        partial ?? {
          analyzed: 0,
          cacheHits: 0,
          cancelled: status === "cancelled" ? mediaPaths.length : 0,
          failed: status === "failed" ? mediaPaths.length : 0,
          requested: mediaPaths.length,
        },
        status,
        performance.now() - started,
      );
      if (partial) {
        await persistAnalysisArtifacts(
          manifestPath,
          manifest,
          mediaPaths,
          partial.results,
          run,
          snapshot.contents,
          dependencies,
        );
      } else {
        await persistAnalysisRun(manifestPath, manifest, run, snapshot.contents, dependencies);
      }
      throw error;
    }
    const analysisFinishedAt = new Date().toISOString();
    await persistAnalysisArtifacts(
      manifestPath,
      manifest,
      mediaPaths,
      analysis.results,
      analysisRunArtifact(
        startedAt,
        analysisFinishedAt,
        analysis,
        "completed",
        performance.now() - started,
      ),
      snapshot.contents,
      dependencies,
    );
    const finishedAt = new Date().toISOString();
    return {
      analysis,
      analysisDirectories: analysisDirectories(mediaPaths, analysis.results),
      finishedAt,
      manifest,
      manifestPath,
      startedAt,
      totalMs: roundMilliseconds(performance.now() - started),
    };
  } finally {
    await release();
  }
}

async function persistAnalysisRun(
  manifestPath: string,
  manifest: SetManifest,
  run: RekordboxAnalysisRunArtifact,
  expectedContents: string,
  dependencies: AnalyzeExistingManifestDependencies,
): Promise<void> {
  const nextManifest = structuredClone(manifest);
  nextManifest.artifacts.analysisRuns = [...(manifest.artifacts.analysisRuns ?? []), run];
  await dependencies.writeManifest(manifestPath, nextManifest, { expectedContents });
  manifest.artifacts.analysisRuns = nextManifest.artifacts.analysisRuns;
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

async function persistAnalysisArtifacts(
  manifestPath: string,
  manifest: SetManifest,
  mediaPaths: readonly string[],
  results: readonly (RekordboxAnalysisResult | undefined)[],
  run: RekordboxAnalysisRunArtifact,
  expectedContents: string,
  dependencies: AnalyzeExistingManifestDependencies,
): Promise<void> {
  const selectedIdentities = new Set(
    (await Promise.all(mediaPaths.map(pathIdentities))).flatMap((identities) => [...identities]),
  );
  const retained: RekordboxAnalysisArtifact[] = [];
  for (const artifact of manifest.artifacts.analysis ?? []) {
    const identities = await pathIdentities(artifact.mediaPath);
    if (![...identities].some((identity) => selectedIdentities.has(identity))) {
      retained.push(artifact);
    }
  }
  const analyzed = results.flatMap((result, index) =>
    result ? [toAnalysisArtifact(mediaPaths[index]!, result)] : [],
  );
  const artifacts = [...retained, ...analyzed];
  const nextManifest = structuredClone(manifest);
  nextManifest.artifacts.analysis = artifacts;
  nextManifest.artifacts.analysisRuns = [...(manifest.artifacts.analysisRuns ?? []), run];
  await dependencies.writeManifest(manifestPath, nextManifest, { expectedContents });
  manifest.artifacts.analysis = artifacts;
  manifest.artifacts.analysisRuns = nextManifest.artifacts.analysisRuns;
}

function toAnalysisArtifact(
  mediaPath: string,
  result: RekordboxAnalysisResult,
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

async function pathIdentities(path: string): Promise<Set<string>> {
  const lexical = resolve(path);
  try {
    return new Set([lexical, await realpath(lexical)]);
  } catch {
    return new Set([lexical]);
  }
}

type PartialAnalysis = {
  analyzed: number;
  cacheHits: number;
  cancelled: number;
  failed: number;
  requested: number;
  results: Array<RekordboxAnalysisResult | undefined>;
};

function partialAnalysis(error: unknown, requested: number): PartialAnalysis | undefined {
  if (!error || typeof error !== "object" || !("partialResult" in error)) return undefined;
  const partial = (error as { partialResult?: Record<string, unknown> }).partialResult;
  if (!Array.isArray(partial?.results)) return undefined;
  const results = partial.results as Array<RekordboxAnalysisResult | undefined>;
  const durable = results.filter((result) => result !== undefined).length;
  const cacheHits = nonnegativeIntegerOr(partial.cacheHits, 0);
  const analyzed = nonnegativeIntegerOr(partial.analyzed, Math.max(0, durable - cacheHits));
  const aborted = error instanceof Error && error.name === "AbortError";
  const unaccounted = Math.max(0, requested - analyzed - cacheHits);
  const failed = nonnegativeIntegerOr(partial.failed, aborted ? 0 : unaccounted);
  const cancelled = nonnegativeIntegerOr(
    partial.cancelled,
    aborted ? Math.max(0, requested - analyzed - cacheHits - failed) : 0,
  );
  return {
    analyzed,
    cacheHits,
    cancelled,
    failed,
    requested: nonnegativeIntegerOr(partial.requested, requested),
    results,
  };
}

function analysisRunArtifact(
  startedAt: string,
  finishedAt: string,
  result: Pick<PartialAnalysis, "analyzed" | "cacheHits" | "requested"> & {
    cancelled?: number;
    failed?: number;
  },
  status: RekordboxAnalysisRunArtifact["status"],
  totalMs: number,
): RekordboxAnalysisRunArtifact {
  return {
    analyzed: result.analyzed,
    cacheHits: result.cacheHits,
    cancelled: result.cancelled ?? 0,
    failed: result.failed ?? 0,
    finishedAt,
    requested: result.requested,
    startedAt,
    status,
    totalMs: roundMilliseconds(totalMs),
  };
}

function nonnegativeIntegerOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function analysisDirectories(
  mediaPaths: readonly string[],
  results: readonly RekordboxAnalysisResult[],
): Record<string, string> {
  return Object.fromEntries(
    results.map((result, index) => [resolve(mediaPaths[index]!), dirname(result.summaryPath)]),
  );
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}
