import { mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { AnalyzeTracksResult, RekordboxAnalysisResult } from "@gakonst/rekordbox";
import { describe, expect, test, vi } from "vitest";

import {
  analyzeExistingManifest,
  type AnalyzeExistingManifestDependencies,
} from "../src/analyze-existing.js";
import { createManifest, type SetManifest } from "../src/manifest.js";
import { planRekordboxImport } from "../src/rekordbox-db.js";

const manifestPath = resolve("/tmp/music-ts-analysis-only/manifest.json");
const mediaPaths = [
  resolve("/tmp/music-ts-analysis-only/one.m4a"),
  resolve("/tmp/music-ts-analysis-only/two.m4a"),
];

function manifest(paths: readonly string[] = mediaPaths): SetManifest {
  const value = createManifest({
    source: "https://example.com/set",
    provider: "description",
    complete: true,
    tracks: paths.map((_, index) => ({
      order: index + 1,
      timestamp: `00:0${String(index)}:00`,
      startSeconds: index * 60,
      endSeconds: (index + 1) * 60,
      artist: "Artist",
      title: `Track ${String(index + 1)}`,
    })),
  });
  value.entries.forEach((entry, index) => {
    const mediaPath = paths[index]!;
    entry.acquisition = {
      status: "downloaded",
      download: {
        backend: "ytdlp",
        engine: "native",
        files: [mediaPath],
        kind: "individual",
        mediaPath,
        source: `https://example.com/watch/${String(index + 1)}`,
      },
    };
  });
  return value;
}

function analysis(path: string): RekordboxAnalysisResult {
  const directory = `${path}.rekordbox`;
  return {
    analyzePath: resolve(directory, "ANLZ0000.DAT"),
    audioPath: path,
    backend: "fake-native",
    binary: "/tmp/rekordbox-analyzer",
    callbackError: null,
    callbackStatus: 0,
    contentId: 1,
    nativeLog: resolve(directory, "rehost-native.log"),
    outputs: [],
    source: { mtimeMs: 1, path, size: 2 },
    startResult: 0,
    summary: {
      beat_grid: null,
      files: [],
      key: "Bm",
      key_source: "fake",
      tempo_bpm: 124,
    },
    summaryPath: resolve(directory, "analysis.json"),
    timings: {
      analyzeStartMs: 0,
      backendMs: 0,
      completionMs: 0,
      loadMs: 0,
      outputPrepareMs: 0,
      summarizeMs: 0,
      totalMs: 1,
    },
  };
}

function batch(results: RekordboxAnalysisResult[]): AnalyzeTracksResult {
  return {
    analyzed: results.length,
    cacheHits: 0,
    concurrency: results.length,
    elapsedMs: 1,
    requested: results.length,
    results,
    throughputTracksPerSecond: results.length * 1_000,
    timings: { analyzeMs: 1, preflightMs: 0, totalMs: 1 },
  };
}

function dependencies(value: SetManifest, analyze: AnalyzeExistingManifestDependencies["analyze"]) {
  const release = vi.fn(async () => undefined);
  const writeManifest = vi.fn(async () => undefined);
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  return {
    contents,
    release,
    writeManifest,
    value: {
      acquireLock: vi.fn(async () => release),
      analyze,
      readManifestSnapshot: vi.fn(async () => ({ contents, manifest: value })),
      writeManifest,
    } satisfies AnalyzeExistingManifestDependencies,
  };
}

describe("analysis-only manifest workflow", () => {
  test("analyzes existing media and checkpoints artifacts without changing acquisition", async () => {
    const value = manifest();
    const acquisition = structuredClone(value.entries.map((entry) => entry.acquisition));
    const analyze = vi.fn(async () => batch(mediaPaths.map(analysis)));
    const mocks = dependencies(value, analyze);

    const result = await analyzeExistingManifest({
      manifestPath,
      engine: "reference",
      dependencies: mocks.value,
    });

    expect(analyze).toHaveBeenCalledWith(
      mediaPaths,
      expect.objectContaining({ concurrency: 4, engine: "reference" }),
    );
    expect(result.manifest.artifacts.analysis).toHaveLength(2);
    expect(result.manifest.artifacts.analysisRuns).toEqual([
      expect.objectContaining({
        analyzed: 2,
        cacheHits: 0,
        cancelled: 0,
        failed: 0,
        requested: 2,
        status: "completed",
      }),
    ]);
    expect(result.analysisDirectories).toEqual(
      Object.fromEntries(mediaPaths.map((path) => [path, `${path}.rekordbox`])),
    );
    expect(result.manifest.entries.map((entry) => entry.acquisition)).toEqual(acquisition);
    expect(mocks.writeManifest).toHaveBeenCalledWith(manifestPath, expect.any(Object), {
      expectedContents: mocks.contents,
    });
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  test("checkpoints successful partial analysis before returning a typed batch failure", async () => {
    const value = manifest();
    const error = Object.assign(new Error("one track failed"), {
      partialResult: { results: [analysis(mediaPaths[0]!), undefined] },
    });
    const mocks = dependencies(
      value,
      vi.fn(async () => Promise.reject(error)),
    );

    await expect(analyzeExistingManifest({ manifestPath, dependencies: mocks.value })).rejects.toBe(
      error,
    );
    expect(value.artifacts.analysis).toHaveLength(1);
    expect(value.artifacts.analysis?.[0]?.mediaPath).toBe(mediaPaths[0]);
    expect(mocks.writeManifest).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  test("checkpoints cache hits and completed work before returning typed cancellation", async () => {
    const value = manifest();
    const error = Object.assign(new DOMException("Interrupted", "AbortError"), {
      failures: [],
      partialResult: {
        analyzed: 0,
        cacheHits: 1,
        cancelled: 1,
        concurrency: 1,
        elapsedMs: 10,
        failed: 0,
        requested: 2,
        results: [analysis(mediaPaths[0]!), undefined],
        throughputTracksPerSecond: 0,
        timings: { analyzeMs: 10, preflightMs: 0, totalMs: 10 },
      },
    });
    const mocks = dependencies(
      value,
      vi.fn(async () => Promise.reject(error)),
    );

    await expect(analyzeExistingManifest({ manifestPath, dependencies: mocks.value })).rejects.toBe(
      error,
    );
    expect(value.artifacts.analysis).toEqual([
      expect.objectContaining({ mediaPath: mediaPaths[0] }),
    ]);
    expect(value.artifacts.analysisRuns).toEqual([
      expect.objectContaining({
        analyzed: 0,
        cacheHits: 1,
        cancelled: 1,
        failed: 0,
        status: "cancelled",
      }),
    ]);
    expect(mocks.writeManifest).toHaveBeenCalledWith(manifestPath, expect.any(Object), {
      expectedContents: mocks.contents,
    });
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  test("records a failed run when analyzer preflight has no partial result", async () => {
    const value = manifest();
    value.artifacts.analysis = [
      {
        mediaPath: mediaPaths[0]!,
        summaryPath: `${mediaPaths[0]!}.rekordbox/analysis.json`,
        backend: "prior-native",
        tempoBpm: 124,
        key: "Bm",
        keySource: "prior",
        sourceMtimeMs: 1,
        sourceSize: 2,
      },
    ];
    const error = new TypeError("Rekordbox analyzer helper does not exist");
    const mocks = dependencies(
      value,
      vi.fn(async () => Promise.reject(error)),
    );

    await expect(analyzeExistingManifest({ manifestPath, dependencies: mocks.value })).rejects.toBe(
      error,
    );
    expect(value.artifacts.analysis).toHaveLength(1);
    expect(value.artifacts.analysisRuns).toEqual([
      expect.objectContaining({
        analyzed: 0,
        cacheHits: 0,
        cancelled: 0,
        failed: 2,
        requested: 2,
        status: "failed",
      }),
    ]);
    expect(mocks.writeManifest).toHaveBeenCalledWith(manifestPath, expect.any(Object), {
      expectedContents: mocks.contents,
    });
  });

  test("refuses to overwrite a non-cooperating manifest edit made during analysis", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tracks-analyze-existing-cas-"));
    const path = join(directory, "manifest.json");
    const starting = manifest();
    await writeFile(path, `${JSON.stringify(starting, null, 2)}\n`);
    const edited = structuredClone(starting);
    edited.warnings.push("manual edit during analysis");

    await expect(
      analyzeExistingManifest({
        manifestPath: path,
        dependencies: {
          analyze: vi.fn(async () => {
            await writeFile(path, `${JSON.stringify(edited, null, 2)}\n`);
            return batch(mediaPaths.map(analysis));
          }),
        },
      }),
    ).rejects.toThrow("Manifest changed");

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(edited);
  });

  test("keeps lexical manifest keys across symlink warm runs and the Rekordbox import map", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tracks-analyze-existing-symlink-"));
    const target = join(directory, "target.m4a");
    const link = join(directory, "library-link.m4a");
    const path = join(directory, "manifest.json");
    await writeFile(target, "audio");
    await symlink(target, link);
    await writeFile(path, `${JSON.stringify(manifest([link]), null, 2)}\n`);
    const canonicalTarget = await realpath(target);
    const analyzed = analysis(canonicalTarget);
    analyzed.summaryPath = join(directory, "library-link.rekordbox", "analysis.json");
    const analyze = vi.fn(async () => batch([analyzed]));

    const first = await analyzeExistingManifest({
      manifestPath: path,
      dependencies: { analyze },
    });
    const second = await analyzeExistingManifest({
      manifestPath: path,
      dependencies: { analyze },
    });

    expect(first.manifest.artifacts.analysis).toEqual([
      expect.objectContaining({ mediaPath: resolve(link) }),
    ]);
    expect(second.manifest.artifacts.analysis).toHaveLength(1);
    expect(second.manifest.artifacts.analysisRuns).toHaveLength(2);
    expect(second.manifest.artifacts.analysis?.[0]?.mediaPath).toBe(resolve(link));
    expect(second.analysisDirectories).toEqual({
      [resolve(link)]: dirname(analyzed.summaryPath),
    });
    const plan = planRekordboxImport(second.manifest, {
      analysisDirectories: second.analysisDirectories,
    });
    expect(plan.items[0]).toMatchObject({
      mediaPath: resolve(link),
      analysisDirectory: dirname(analyzed.summaryPath),
    });
  });
});
