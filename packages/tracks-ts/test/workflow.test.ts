import { resolve } from "node:path";

import { describe, expect, test, vi } from "vitest";

import type { AcquireManifestResult, AcquisitionPerformance } from "../src/acquire-manifest.js";
import { createManifest, type SetManifest } from "../src/manifest.js";
import type { ImportManifestToRekordboxResult } from "../src/rekordbox-db.js";
import type { SpotifyEnrichmentResult } from "../src/spotify-enrichment.js";
import type { Tracklist } from "../src/types.js";
import { runSetToRekordbox, type RunSetToRekordboxDependencies } from "../src/workflow.js";

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

function downloadedManifest(): SetManifest {
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
  return manifest;
}

function acquisitionPerformance(): AcquisitionPerformance {
  return {
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(0).toISOString(),
    totalMs: 1,
    concurrency: 64,
    verificationConcurrency: 64,
    spotifyConcurrency: 64,
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
    concurrency: 64,
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
    throughputTracksPerSecond: cacheHit ? 0 : 1_000,
    timings: { analyzeMs: 1, preflightMs: 0, totalMs: 1 },
    results: [
      {
        source: { path: mediaPath, mtimeMs: 1, size: 1 },
        summaryPath: resolve(analysisDirectory, "analysis.json"),
      },
    ],
  } as Awaited<ReturnType<RunSetToRekordboxDependencies["analyze"]>>;
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
  test("composes the entire approved flow as libraries and installs native analysis", async () => {
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
      enrichSpotify: async (manifest) => {
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
        await Promise.resolve();
        expect(calls).toContain("analyze");
        calls.push("acquire-finish");
        await analysisTask;
        return acquisitionResult(downloadedManifest(), false);
      },
      analyze: async (paths, options) => {
        calls.push("analyze");
        expect(paths).toEqual([mediaPath]);
        expect(options?.concurrency).toBe(1);
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
    expect(writes).toHaveLength(2);
    expect(result.performance.peakConcurrency).toBe(1);
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

  test("takes the fully cached warm-resume path without resolving or rewriting", async () => {
    const manifest = downloadedManifest();
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
