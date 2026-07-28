import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { describe, expect, test, vi } from "vitest";

import type { AcquireManifestResult, AcquisitionPerformance } from "../src/acquire-manifest.js";
import { createManifest, type SetManifest } from "../src/manifest.js";
import { planRekordboxImport, type ImportManifestToRekordboxResult } from "../src/rekordbox-db.js";
import type { SpotifyEnrichmentResult } from "../src/spotify-enrichment.js";
import type { Tracklist } from "../src/types.js";
import {
  DEFAULT_NATIVE_ANALYSIS_CONCURRENCY,
  MAX_NATIVE_ANALYSIS_CONCURRENCY,
  runSetToRekordbox,
  type RunSetToRekordboxDependencies,
} from "../src/workflow.js";

const source = "https://youtu.be/example-set";
const manifestPath = resolve("/tmp/music-ts-workflow/manifest.json");
const outputDirectory = resolve("/tmp/music-ts-workflow/tracks");
const mediaPath = resolve(outputDirectory, "001 - Artist - Track.m4a");
const analysisDirectory = resolve(outputDirectory, ".rekordbox-analysis");

function tracklist(): Tracklist {
  return {
    source,
    url: source,
    provider: "description",
    title: "Example Set",
    complete: true,
    tracks: [
      {
        order: 1,
        timestamp: "00:00:00",
        startSeconds: 0,
        endSeconds: 180,
        artist: "Artist",
        title: "Track",
      },
    ],
  };
}

function enrichedManifest(): SetManifest {
  const manifest = createManifest(tracklist());
  manifest.entries[0]!.spotify = {
    status: "matched",
    query: 'track:"Track" artist:"Artist"',
    score: 1,
    id: "spotify-track",
    uri: "spotify:track:spotify-track",
    name: "Track",
    artists: ["Artist"],
  };
  return manifest;
}

function downloadedManifest(withAnalysis = false): SetManifest {
  const manifest = enrichedManifest();
  manifest.entries[0]!.acquisition = {
    status: "downloaded",
    download: {
      backend: "slsk",
      kind: "individual",
      mediaPath,
      files: [mediaPath],
      source: "slsk://download?username=peer&filename=track.flac",
      spotifyId: "spotify-track",
    },
  };
  if (withAnalysis) {
    manifest.artifacts.analysis = [
      {
        mediaPath,
        summaryPath: resolve(analysisDirectory, "analysis.json"),
        backend: "rekordbox-dlopen-rehost",
        tempoBpm: 128.006827,
        key: "Bm",
        keySource: "rekordbox-notify-complete",
        sourceMtimeMs: 1,
        sourceSize: 1,
      },
    ];
  }
  return manifest;
}

function acquisitionPerformance(): AcquisitionPerformance {
  return {
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
    totalMs: 1,
    concurrency: 3,
    verificationConcurrency: 8,
    spotifyConcurrency: 8,
    stages: [{ stage: "recordings", durationMs: 1, operations: 1, maxConcurrency: 1 }],
    checkpoints: {
      calls: 1,
      flushes: 1,
      writes: 1,
      skipped: 0,
      coalesced: 0,
      durationMs: 1,
    },
  };
}

function acquisitionResult(manifest: SetManifest, resumed: boolean): AcquireManifestResult {
  return {
    manifest,
    downloaded: resumed ? [] : [mediaPath],
    resumed: resumed ? [mediaPath] : [],
    failures: [],
    unavailableBackends: [],
    performance: acquisitionPerformance(),
  };
}

function spotifyResult(manifest: SetManifest, attempted: number): SpotifyEnrichmentResult {
  return {
    manifest,
    attempted,
    requests: attempted,
    networkRequests: attempted,
    concurrency: 8,
    maxConcurrency: attempted ? 1 : 0,
    matched: attempted,
    ambiguous: 0,
    unmatched: 0,
    skipped: 0,
    failed: 0,
    untouched: attempted ? 0 : 1,
    durationMs: 1,
  };
}

function analysisResult(cacheHit: boolean) {
  return {
    analyzed: cacheHit ? 0 : 1,
    cacheHits: cacheHit ? 1 : 0,
    concurrency: 1,
    elapsedMs: 1,
    requested: 1,
    threadBudget: 4,
    throughputTracksPerSecond: cacheHit ? 0 : 1_000,
    timings: { analyzeMs: 1, preflightMs: 0, totalMs: 1 },
    results: [
      {
        backend: "rekordbox-dlopen-rehost",
        source: { path: mediaPath, mtimeMs: 1, size: 1 },
        summary: {
          beat_grid: null,
          files: [],
          key: "Bm",
          key_source: "rekordbox-notify-complete",
          tempo_bpm: 128.006827,
        },
        summaryPath: resolve(analysisDirectory, "analysis.json"),
      },
    ],
    workerThreadBudgets: [4],
  } as unknown as Awaited<ReturnType<RunSetToRekordboxDependencies["analyze"]>>;
}

function importResult(manifest: SetManifest, changed: boolean): ImportManifestToRekordboxResult {
  return {
    manifest,
    dbPath: "/tmp/master.db",
    playlistId: "playlist",
    folderId: "folder",
    imported: [
      {
        key: "track-001:0",
        entryId: "track-001",
        variantIndex: 0,
        mediaPath,
        contentId: "content",
        membershipId: "membership",
        trackNumber: 1,
      },
    ],
    plan: { folderName: "Sets", playlistName: "Example Set", items: [] },
    backup: {
      directory: "/tmp/backup",
      createdAt: new Date(0).toISOString(),
      files: [],
      reportPath: "/tmp/backup/backup.json",
    },
    verification: {
      quickCheck: "ok",
      foreignKeyViolationCount: 0,
      playlistSidecarVerified: true,
      expectedMembershipCount: 1,
      playlistMembershipCount: 1,
      verifiedMetadataCount: 1,
      verifiedPaths: [mediaPath],
      expectedAnalysisCount: 1,
      verifiedAnalysisCount: 1,
      verifiedAnalysisPaths: [analysisDirectory],
    },
    performance: {
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(0).toISOString(),
      totalMs: 1,
      changed,
      stages: [],
    },
  };
}

describe("runSetToRekordbox", () => {
  test("uses a four-worker clean-room analysis default without lowering the explicit cap", () => {
    expect(DEFAULT_NATIVE_ANALYSIS_CONCURRENCY).toBe(4);
    expect(MAX_NATIVE_ANALYSIS_CONCURRENCY).toBe(64);
  });

  test("composes the entire approved flow as libraries and installs clean-room analysis", async () => {
    const writes: SetManifest[] = [];
    const calls: string[] = [];
    let plannedOptions: unknown;
    let importedAnalysis: Readonly<Record<string, string>> | undefined;
    const dependencies: RunSetToRekordboxDependencies = {
      exists: async () => false,
      readManifest: vi.fn(),
      writeManifest: async (_path, manifest) => {
        writes.push(structuredClone(manifest));
      },
      identify: async () => {
        calls.push("resolve");
        return tracklist();
      },
      createManifest,
      enrichSpotify: async (manifest, _spotify, options) => {
        expect(options?.concurrency).toBe(8);
        calls.push("spotify");
        manifest.entries[0]!.spotify = enrichedManifest().entries[0]!.spotify;
        return spotifyResult(manifest, 1);
      },
      describeSourceSet: vi.fn(),
      buildPlan: async (_manifest, options) => {
        calls.push("plan");
        plannedOptions = options;
        return {
          clips: [],
          recordings: [],
          stagingDirectory: resolve(outputDirectory, ".staging"),
        };
      },
      acquire: async (options) => {
        expect(options).toMatchObject({
          concurrency: 3,
          verificationConcurrency: 8,
          spotifyConcurrency: 8,
        });
        calls.push("acquire");
        await (options.plan as (manifest: SetManifest) => Promise<unknown>)(enrichedManifest());
        const analysisTask = options.onArtifactVerified?.({
          entryOrder: 1,
          variantIndex: 0,
          path: mediaPath,
          sha256: "a".repeat(64),
          kind: "individual",
          status: "downloaded",
        });
        await analysisTask;
        expect(calls).toContain("analyze");
        calls.push("acquire-finish");
        return acquisitionResult(downloadedManifest(), false);
      },
      analyze: async (paths, options) => {
        calls.push("analyze");
        expect(paths).toEqual([mediaPath]);
        expect(options?.concurrency).toBe(1);
        expect(options).toMatchObject({
          analyzerBinary: "/tmp/rekordbox-analyzer",
          engine: "clean",
          threads: 7,
        });
        return analysisResult(false);
      },
      importRekordbox: async (options) => {
        calls.push("rekordbox");
        expect(options.approved).toBe(true);
        importedAnalysis = options.analysisDirectories;
        return importResult(options.manifest, true);
      },
    };

    const result = await runSetToRekordbox({
      source,
      manifestPath,
      outputDirectory,
      approved: true,
      spotify: { raw: vi.fn() },
      acquirers: [],
      analysis: {
        analyzerBinary: "/tmp/rekordbox-analyzer",
        engine: "clean",
        threads: 7,
      },
      localArtifactDirectories: [resolve("/tmp/local-tracks")],
      dependencies,
    });

    expect(calls).toEqual([
      "resolve",
      "spotify",
      "acquire",
      "plan",
      "analyze",
      "acquire-finish",
      "rekordbox",
    ]);
    expect(plannedOptions).toMatchObject({
      outputDirectory,
      localDirectories: [resolve("/tmp/local-tracks")],
    });
    expect(importedAnalysis).toEqual({ [mediaPath]: analysisDirectory });
    expect(writes).toHaveLength(3);
    expect(result.manifest.artifacts.analysis).toEqual([
      expect.objectContaining({
        mediaPath,
        summaryPath: resolve(analysisDirectory, "analysis.json"),
        tempoBpm: 128.006827,
        key: "Bm",
      }),
    ]);
    expect(result.performance.peakConcurrency).toBe(1);
    expect(result.analysis.threadBudget).toBe(7);
    expect(result.analysis.workerThreadBudgets).toEqual([7]);
    expect(result.performance.warmResume).toBe(false);
    expect(result.performance.stages.map(({ stage, status }) => [stage, status])).toEqual([
      ["resolve", "completed"],
      ["source-set", "skipped"],
      ["spotify", "completed"],
      ["acquisition", "completed"],
      ["analysis", "completed"],
      ["rekordbox", "completed"],
    ]);
  });

  test("keeps a manifest symlink as the Rekordbox key when analysis returns its realpath", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "music-ts-workflow-symlink-"));
    try {
      const canonicalMediaPath = resolve(directory, "canonical.m4a");
      const manifestMediaPath = resolve(directory, "manifest-link.m4a");
      const symlinkAnalysisDirectory = resolve(directory, ".rekordbox-analysis");
      await writeFile(canonicalMediaPath, "verified audio fixture");
      await symlink(canonicalMediaPath, manifestMediaPath);
      const canonicalIdentity = await realpath(manifestMediaPath);
      const manifest = downloadedManifest();
      const acquisition = manifest.entries[0]!.acquisition;
      if (acquisition.status !== "downloaded") throw new Error("Expected downloaded fixture");
      acquisition.download.mediaPath = manifestMediaPath;
      acquisition.download.files = [manifestMediaPath];

      const analyze = vi.fn<RunSetToRekordboxDependencies["analyze"]>(async (paths) => {
        expect(paths).toEqual([manifestMediaPath]);
        const result = analysisResult(false);
        result.results[0]!.source.path = canonicalIdentity;
        result.results[0]!.summaryPath = resolve(symlinkAnalysisDirectory, "analysis.json");
        return result;
      });
      const dependencies: RunSetToRekordboxDependencies = {
        exists: async () => true,
        readManifest: async () => manifest,
        writeManifest: vi.fn(),
        identify: vi.fn(),
        createManifest,
        enrichSpotify: async (current) => spotifyResult(current, 0),
        describeSourceSet: vi.fn(),
        buildPlan: async () => ({ clips: [], recordings: [], stagingDirectory: directory }),
        acquire: async (options) => {
          await options.onArtifactVerified?.({
            entryOrder: 1,
            variantIndex: 0,
            path: manifestMediaPath,
            sha256: "a".repeat(64),
            kind: "individual",
            status: "resumed",
          });
          return {
            ...acquisitionResult(manifest, true),
            resumed: [manifestMediaPath],
          };
        },
        analyze,
        importRekordbox: async (options) => {
          const analysisDirectories = options.analysisDirectories;
          expect(analysisDirectories).toEqual({
            [manifestMediaPath]: symlinkAnalysisDirectory,
          });
          if (!analysisDirectories) throw new Error("Expected analysis directory handoff");
          const plan = planRekordboxImport(options.manifest, {
            analysisDirectories,
          });
          expect(plan.items[0]).toMatchObject({
            mediaPath: manifestMediaPath,
            analysisDirectory: symlinkAnalysisDirectory,
          });
          return importResult(options.manifest, true);
        },
      };

      const result = await runSetToRekordbox({
        source,
        manifestPath: resolve(directory, "manifest.json"),
        outputDirectory: directory,
        approved: true,
        acquirers: [],
        dependencies,
      });

      expect(analyze).toHaveBeenCalledOnce();
      expect(result.analysis.results[0]!.source.path).toBe(canonicalIdentity);
      expect(result.manifest.artifacts.analysis).toEqual([
        expect.objectContaining({ mediaPath: manifestMediaPath }),
      ]);
      expect(result.analysisDirectories).toEqual({
        [manifestMediaPath]: symlinkAnalysisDirectory,
      });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("takes the fully cached warm-resume path without resolving or rewriting", async () => {
    const manifest = downloadedManifest(true);
    const dependencies: RunSetToRekordboxDependencies = {
      exists: async () => true,
      readManifest: async () => manifest,
      writeManifest: vi.fn(),
      identify: vi.fn(),
      createManifest,
      enrichSpotify: async (current) => spotifyResult(current, 0),
      describeSourceSet: vi.fn(),
      buildPlan: async () => ({ clips: [], recordings: [], stagingDirectory: "/tmp/staging" }),
      acquire: async () => acquisitionResult(manifest, true),
      analyze: async () => analysisResult(true),
      importRekordbox: async (options) => importResult(options.manifest, false),
    };

    const result = await runSetToRekordbox({
      source,
      manifestPath,
      outputDirectory,
      approved: true,
      spotify: { raw: vi.fn() },
      acquirers: [],
      dependencies,
    });

    expect(dependencies.identify).not.toHaveBeenCalled();
    expect(dependencies.writeManifest).not.toHaveBeenCalled();
    expect(result.performance.warmResume).toBe(true);
    expect(result.performance.stages.map((stage) => stage.status)).toEqual([
      "resumed",
      "skipped",
      "resumed",
      "resumed",
      "resumed",
      "resumed",
    ]);
  });

  test("backfills durable analyzer metadata on an older warm manifest", async () => {
    const manifest = downloadedManifest();
    const writeManifest = vi.fn();
    const dependencies: RunSetToRekordboxDependencies = {
      exists: async () => true,
      readManifest: async () => manifest,
      writeManifest,
      identify: vi.fn(),
      createManifest,
      enrichSpotify: async (current) => spotifyResult(current, 0),
      describeSourceSet: vi.fn(),
      buildPlan: async () => ({ clips: [], recordings: [], stagingDirectory: "/tmp/staging" }),
      acquire: async () => acquisitionResult(manifest, true),
      analyze: async () => analysisResult(true),
      importRekordbox: async (options) => {
        expect(options.manifest.artifacts.analysis).toHaveLength(1);
        return importResult(options.manifest, true);
      },
    };

    const result = await runSetToRekordbox({
      source,
      manifestPath,
      outputDirectory,
      approved: true,
      spotify: { raw: vi.fn() },
      acquirers: [],
      dependencies,
    });

    expect(writeManifest).toHaveBeenCalledOnce();
    expect(result.performance.warmResume).toBe(false);
    expect(result.performance.stages.find((stage) => stage.stage === "analysis")?.status).toBe(
      "completed",
    );
  });

  test("recovers failed individual recordings from approved cues in the same invocation", async () => {
    const sourceSetPath = resolve("/tmp/music-ts-workflow/source-set.m4a");
    const sourceSet = {
      url: source,
      path: sourceSetPath,
      sha256: "b".repeat(64),
      durationSeconds: 3_600,
      codec: "aac",
      bitrate: 256_000,
    };
    const failed = enrichedManifest();
    failed.artifacts.sourceSet = sourceSet;
    failed.entries[0]!.acquisition = {
      status: "failed",
      query: "Artist Track",
      error: {
        stage: "acquisition",
        message: "No individual recording candidate passed validation",
        retryable: true,
      },
    };
    failed.entries[0]!.errors.push({
      stage: "acquisition",
      message: "No individual recording candidate passed validation",
      retryable: true,
    });
    const recovered = structuredClone(failed);
    recovered.entries[0]!.acquisition = {
      status: "downloaded",
      query: "Artist Track",
      download: {
        backend: "ytdlp",
        kind: "source-set-clip",
        mediaPath,
        files: [mediaPath],
        source,
        engine: "reference",
        sha256: "c".repeat(64),
        spotifyId: "spotify-track",
        clip: {
          sourceSetUrl: source,
          startSeconds: 0,
          endSeconds: 180,
          containsTransitions: true,
          qualityNote: "Cue-bounded set recovery",
        },
      },
    };
    recovered.entries[0]!.errors = [];
    const acquire = vi.fn(
      async (options: Parameters<RunSetToRekordboxDependencies["acquire"]>[0]) => {
        const pass = acquire.mock.calls.length;
        if (pass === 1) {
          expect(options.continueOnError).toBe(true);
          await (options.plan as (manifest: SetManifest) => Promise<unknown>)(failed);
          return {
            manifest: failed,
            downloaded: [],
            resumed: [],
            failures: [
              {
                entryOrder: 1,
                spotifyId: "spotify-track",
                message: "No individual recording candidate passed validation",
              },
            ],
            unavailableBackends: [],
            performance: acquisitionPerformance(),
          };
        }
        expect(options.continueOnError).toBe(false);
        await (options.plan as (manifest: SetManifest) => Promise<unknown>)(failed);
        recovered.entries[0]!.warnings = [...failed.entries[0]!.warnings];
        return {
          manifest: recovered,
          downloaded: [mediaPath],
          resumed: [],
          failures: [],
          unavailableBackends: [],
          performance: acquisitionPerformance(),
        };
      },
    );
    const buildPlan = vi.fn(async () => ({
      clips: [],
      recordings: [],
      stagingDirectory: "/tmp/staging",
    }));
    const dependencies: RunSetToRekordboxDependencies = {
      exists: async () => false,
      readManifest: vi.fn(),
      writeManifest: vi.fn(),
      identify: async () => tracklist(),
      createManifest: () => enrichedManifest(),
      enrichSpotify: vi.fn(),
      describeSourceSet: async () => sourceSet,
      buildPlan,
      acquire,
      analyze: async () => analysisResult(false),
      importRekordbox: async (options) => importResult(options.manifest, true),
    };

    const result = await runSetToRekordbox({
      source,
      manifestPath,
      outputDirectory,
      approved: true,
      allowSourceSetClips: true,
      sourceSet: { path: sourceSetPath },
      acquirers: [],
      dependencies,
    });

    expect(acquire).toHaveBeenCalledTimes(2);
    expect(buildPlan).toHaveBeenCalledTimes(2);
    expect(result.acquisition.downloaded).toEqual([mediaPath]);
    expect(result.acquisition.failures).toEqual([]);
    expect(result.performance.automation).toEqual({
      spotifyCanonicalSelections: 0,
      acquisitionPasses: 2,
      sourceSetFallbacks: 1,
    });
    expect(result.manifest.entries[0]!.warnings).toContain(
      "Automatic source-set fallback after individual acquisition failure: No individual recording candidate passed validation",
    );
  });

  test("rejects a local set source unless cue clipping was explicitly allowed", async () => {
    await expect(
      runSetToRekordbox({
        source,
        manifestPath,
        outputDirectory,
        approved: true,
        sourceSet: { path: "/tmp/full-set.m4a" },
        acquirers: [],
      }),
    ).rejects.toThrow("without explicit allowSourceSetClips: true");
  });
});
