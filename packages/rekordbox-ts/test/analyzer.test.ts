import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AnlzFile } from "../src/anlz/index.js";
import {
  analyzeTrack,
  analyzeTrackAsync,
  analyzeTracks,
  AnalyzeTracksCancelledError,
  AnalyzeTracksError,
  DEFAULT_ANALYZER_CONCURRENCY,
  DEFAULT_ANALYZER_TRACK_THREADS,
  DEFAULT_ANALYZER_THREAD_BUDGET,
  compareBeatGrids,
  compareWaveforms,
  diagnoseAnalyzer,
  getAnalyzerBinary,
  readAnalysisResult,
} from "../src/analyzer/index.js";

const roots: Array<string> = [];
const helperPaths = [
  resolve("analyze"),
  resolve("beat-grid-diff"),
  resolve("doctor"),
  resolve("waveform-diff"),
];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const archDescriptor = Object.getOwnPropertyDescriptor(process, "arch");
const analyzerRoot = process.env.REKORDBOX_ANALYZER_ROOT;
const cleanAnalyzerBinary = process.env.REKORDBOX_CLEAN_ANALYZER_BINARY;
const genericAnalyzerBinary = process.env.REKORDBOX_ANALYZER_BINARY;
const referenceAnalyzerBinary = process.env.REKORDBOX_REFERENCE_ANALYZER_BINARY;
const fakeAnalyzerThreadsLog = process.env.FAKE_ANALYZER_THREADS_LOG;

const fakeAnalyzer = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const command = basename(process.argv[1]);
const mode = process.env.FAKE_ANALYZER_MODE;
if (command === "doctor") {
  if (process.env.FAKE_ANALYZER_DOCTOR_COUNTER)
    appendFileSync(process.env.FAKE_ANALYZER_DOCTOR_COUNTER, "1\\n");
  if (mode === "fail-doctor") {
    console.error("fake doctor failure");
    process.exit(3);
  }
  const legacy = mode === "legacy-doctor";
  console.log(JSON.stringify({
    app: process.env.REKORDBOX_ANALYZER_APP,
    backend: legacy || process.env.REKORDBOX_ANALYZER_ENGINE === "reference"
      ? "rekordbox-dlopen-rehost"
      : "clean-room-test",
    cache: process.env.REKORDBOX_ANALYZER_CACHE,
    cleanRoom: !legacy && process.env.REKORDBOX_ANALYZER_ENGINE !== "reference",
    proprietaryDependencies: legacy || process.env.REKORDBOX_ANALYZER_ENGINE === "reference",
    root: process.env.REKORDBOX_ANALYZER_ROOT,
  }));
  process.exit(0);
}

if (command === "beat-grid-diff") {
  if (mode === "fail") {
    console.error("fake beat-grid failure");
    process.exit(2);
  }
  if (mode === "invalid-json") {
    console.log("not json");
    process.exit(0);
  }
  const [referenceDirectory, candidateDirectory] = process.argv.slice(2);
  const endpoint = { beat: 1, bpm: 125, timeMs: 500 };
  const timestampError = { meanMs: 2, medianMs: 1, p95Ms: 4, maxMs: 5 };
  const tempoError = { meanBpm: 0.01, medianBpm: 0.01, p95Bpm: 0.02, maxBpm: 0.03 };
  const matchRate = { toleranceMs: 70, matches: 64, precision: 1, recall: 1, f1: 1 };
  console.log(JSON.stringify({
    referenceDirectory: realpathSync(referenceDirectory),
    candidateDirectory: realpathSync(candidateDirectory),
    referenceBeatCount: 64,
    candidateBeatCount: 64,
    matchedBeats: 64,
    referenceUnmatchedBeats: 0,
    candidateUnmatchedBeats: 0,
    referenceFirst: endpoint,
    candidateFirst: endpoint,
    referenceLast: endpoint,
    candidateLast: endpoint,
    firstTimestampErrorMs: -1,
    lastTimestampErrorMs: 2,
    alignedTimestampError: timestampError,
    driftMsPer100Beats: 0.25,
    beatNumberPhase: 0,
    beatNumberAccuracy: 1,
    referenceTempoChanges: 2,
    candidateTempoChanges: 1,
    alignedTempoError: tempoError,
    referenceDownbeatCount: 16,
    candidateDownbeatCount: 16,
    matchedDownbeats: 16,
    downbeatTimestampError: timestampError,
    at70Ms: matchRate,
    at100Ms: { ...matchRate, toleranceMs: 100 },
  }));
  process.exit(0);
}

if (command === "waveform-diff") {
  if (mode === "fail") {
    console.error("fake waveform failure");
    process.exit(2);
  }
  if (mode === "invalid-json") {
    console.log("not json");
    process.exit(0);
  }
  const [referenceDirectory, candidateDirectory] = process.argv.slice(2);
  console.log(JSON.stringify({
    referenceDirectory: realpathSync(referenceDirectory),
    candidateDirectory: realpathSync(candidateDirectory),
    waveforms: [{
      kind: "PWV7",
      entryBytes: 3,
      referenceCount: 64,
      candidateCount: 63,
      countDelta: -1,
      components: [{
        name: "low",
        referenceCount: 64,
        candidateCount: 63,
        overlapCount: 63,
        countDelta: -1,
        exactValues: 42,
        exactFraction: 2 / 3,
        correlation: 0.95,
        meanReference: 20,
        meanCandidate: 19,
        meanAbsoluteError: 1,
        medianAbsoluteError: 1,
        p95AbsoluteError: 2,
        maxAbsoluteError: 3,
        signedMeanError: -1,
      }],
    }],
  }));
  process.exit(0);
}

const [audioPath, outputDirectory, nativeLog] = process.argv.slice(2);
if (process.env.FAKE_ANALYZER_COUNTER)
  appendFileSync(process.env.FAKE_ANALYZER_COUNTER, "1\\n");
if (process.env.FAKE_ANALYZER_THREADS_LOG)
  appendFileSync(
    process.env.FAKE_ANALYZER_THREADS_LOG,
    (process.env.REKORDBOX_ANALYZER_THREADS ?? "unset") + "\\n",
  );
if (mode === "fail" || basename(audioPath).includes("fail")) {
  console.error("fake analyzer failure");
  process.exit(2);
}
if (mode === "unicode-path" && /[^\\x00-\\x7F]/u.test(audioPath)) {
  console.error("Rekordbox startAnalyze failed with status -1");
  process.exit(1);
}
if (mode === "ignore-term") {
  process.on("SIGTERM", () => undefined);
  await new Promise((resolve) => setTimeout(resolve, 60_000));
}
if (mode === "hang") await new Promise((resolve) => setTimeout(resolve, 60_000));

mkdirSync(outputDirectory, { recursive: true });
const encodedPath = Buffer.from("?/" + basename(audioPath) + "\\0", "utf16le").swap16();
const pathTag = Buffer.alloc(16 + encodedPath.length);
pathTag.write("PPTH", 0, "ascii");
pathTag.writeUInt32BE(16, 4);
pathTag.writeUInt32BE(pathTag.length, 8);
pathTag.writeUInt32BE(encodedPath.length, 12);
encodedPath.copy(pathTag, 16);
const header = Buffer.alloc(28);
header.write("PMAI", 0, "ascii");
header.writeUInt32BE(28, 4);
header.writeUInt32BE(28 + pathTag.length, 8);
const anlz = Buffer.concat([header, pathTag]);
const outputs = [];
for (const suffix of ["DAT", "EXT", "2EX"]) {
  if (mode === "missing-twoex" && suffix === "2EX") continue;
  const path = join(outputDirectory, \`ANLZ0000.\${suffix}\`);
  writeFileSync(path, anlz);
  outputs.push([path, anlz.length]);
}
if (mode === "invalid-json") {
  console.log("not json");
  process.exit(0);
}
console.log(JSON.stringify({
  analyzePath: join(outputDirectory, "ANLZ0000.DAT"),
  audioPath: realpathSync(audioPath),
  backend: process.env.REKORDBOX_ANALYZER_ENGINE === "reference"
    ? "rekordbox-dlopen-rehost"
    : "clean-room-test",
  binary: process.execPath,
  callbackError: null,
  callbackStatus: 0,
  contentId: process.pid,
  nativeLog,
  outputs,
  rhythmFallback: null,
  rhythmMode: process.env.REKORDBOX_ANALYZER_RHYTHM_MODE === "dynamic" ? "dynamic" : "normal",
  rhythmModeRequested: process.env.REKORDBOX_ANALYZER_RHYTHM_MODE ?? "normal",
  startResult: 0,
  summary: {
    beat_grid: null,
    files: outputs.map(([path, size]) => ({ path, size, tags: [] })),
    key: "F",
    key_source: "fake",
    tempo_bpm: 125,
  },
  timings: {
    analyzeStartMs: 0,
    backendMs: 0,
    completionMs: 0,
    loadMs: 0,
    outputPrepareMs: 0,
    summarizeMs: 0,
    totalMs: 0,
  },
}));
`;

function stubNativeRuntime(platform = "darwin", arch = "x64"): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  Object.defineProperty(process, "arch", { configurable: true, value: arch });
}

function installFakeAnalyzer(): void {
  for (const path of helperPaths) writeFileSync(path, fakeAnalyzer);
}

function makeAudio(root: string, name = "track.mp3"): string {
  const path = join(root, name);
  writeFileSync(path, "audio");
  return path;
}

function counterValue(path: string): number {
  return readFileSync(path, "utf8").trim().split(/\r?\n/u).filter(Boolean).length;
}

afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
  if (archDescriptor) Object.defineProperty(process, "arch", archDescriptor);
  delete process.env.FAKE_ANALYZER_COUNTER;
  delete process.env.FAKE_ANALYZER_DOCTOR_COUNTER;
  delete process.env.FAKE_ANALYZER_MODE;
  if (fakeAnalyzerThreadsLog === undefined) delete process.env.FAKE_ANALYZER_THREADS_LOG;
  else process.env.FAKE_ANALYZER_THREADS_LOG = fakeAnalyzerThreadsLog;
  if (analyzerRoot === undefined) delete process.env.REKORDBOX_ANALYZER_ROOT;
  else process.env.REKORDBOX_ANALYZER_ROOT = analyzerRoot;
  if (cleanAnalyzerBinary === undefined) delete process.env.REKORDBOX_CLEAN_ANALYZER_BINARY;
  else process.env.REKORDBOX_CLEAN_ANALYZER_BINARY = cleanAnalyzerBinary;
  if (genericAnalyzerBinary === undefined) delete process.env.REKORDBOX_ANALYZER_BINARY;
  else process.env.REKORDBOX_ANALYZER_BINARY = genericAnalyzerBinary;
  if (referenceAnalyzerBinary === undefined) delete process.env.REKORDBOX_REFERENCE_ANALYZER_BINARY;
  else process.env.REKORDBOX_REFERENCE_ANALYZER_BINARY = referenceAnalyzerBinary;
  for (const path of helperPaths) rmSync(path, { force: true });
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("Rekordbox analyzer wrapper", () => {
  it("resolves explicit helpers and rejects incomplete durable summaries", () => {
    expect(getAnalyzerBinary("./helper")).toBe(resolve("helper"));
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    const path = join(root, "analysis.json");
    const result = { backend: "rekordbox-dlopen-rehost", summaryPath: path };
    writeFileSync(path, JSON.stringify(result));
    expect(() => readAnalysisResult(path)).toThrow("Invalid Rekordbox analysis summary");
  });

  it("does not route the legacy proprietary helper override into the clean engine", () => {
    process.env.REKORDBOX_ANALYZER_BINARY = "/tmp/legacy-reference-analyzer";
    delete process.env.REKORDBOX_CLEAN_ANALYZER_BINARY;
    delete process.env.REKORDBOX_REFERENCE_ANALYZER_BINARY;

    expect(getAnalyzerBinary(undefined, "clean")).not.toBe(
      resolve("/tmp/legacy-reference-analyzer"),
    );
    expect(getAnalyzerBinary(undefined, "reference")).toBe(
      resolve("/tmp/legacy-reference-analyzer"),
    );

    process.env.REKORDBOX_CLEAN_ANALYZER_BINARY = "/tmp/clean-analyzer";
    expect(getAnalyzerBinary(undefined, "clean")).toBe(resolve("/tmp/clean-analyzer"));
  });

  it("rejects a missing audio file before launching the native helper", () => {
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    mkdirSync(join(root, "output"));
    expect(() => analyzeTrack(join(root, "missing.mp3"))).toThrow("does not exist");
  });

  it("supports empty bounded batches and rejects unsafe scheduler inputs", async () => {
    await expect(analyzeTracks([], { concurrency: 2 })).resolves.toMatchObject({
      concurrency: 0,
      requested: 0,
      results: [],
    });
    await expect(analyzeTracks([], { concurrency: 0 })).rejects.toThrow(
      "concurrency must be an integer",
    );
    await expect(analyzeTracks([], { concurrency: 65 })).rejects.toThrow(
      "concurrency must be an integer",
    );
    await expect(analyzeTracks([], { threads: 0 })).rejects.toThrow(
      "thread budget must be an integer",
    );
    await expect(analyzeTracks([], { threads: 65 })).rejects.toThrow(
      "thread budget must be an integer",
    );
    await expect(analyzeTracks(["same.mp3", "same.mp3"])).rejects.toThrow(
      "Multiple tracks resolve",
    );
  });

  it("shares one explicit native thread budget across isolated workers", async () => {
    installFakeAnalyzer();
    stubNativeRuntime();
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    const threadsLog = join(root, "threads");
    process.env.FAKE_ANALYZER_THREADS_LOG = threadsLog;
    const audioPaths = Array.from({ length: 4 }, (_, index) =>
      makeAudio(root, `track-${String(index)}.mp3`),
    );

    const result = await analyzeTracks(audioPaths, {
      analyzerBinary: process.execPath,
      concurrency: 4,
      force: true,
      threads: 7,
    });

    expect(DEFAULT_ANALYZER_THREAD_BUDGET).toBeGreaterThan(0);
    expect(result).toMatchObject({
      concurrency: 4,
      threadBudget: 7,
      workerThreadBudgets: [2, 2, 2, 1],
    });
    expect(
      readFileSync(threadsLog, "utf8")
        .trim()
        .split(/\r?\n/u)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([1, 2, 2, 2]);

    const single = makeAudio(root, "single.mp3");
    analyzeTrack(single, {
      analyzerBinary: process.execPath,
      force: true,
      threads: 5,
    });
    expect(readFileSync(threadsLog, "utf8").trim().split(/\r?\n/u).at(-1)).toBe("5");

    analyzeTrack(makeAudio(root, "default-single.mp3"), {
      analyzerBinary: process.execPath,
      force: true,
    });
    expect(readFileSync(threadsLog, "utf8").trim().split(/\r?\n/u).at(-1)).toBe(
      String(DEFAULT_ANALYZER_TRACK_THREADS),
    );

    const bounded = await analyzeTracks(
      [makeAudio(root, "bounded-one.mp3"), makeAudio(root, "bounded-two.mp3")],
      {
        analyzerBinary: process.execPath,
        concurrency: 4,
        force: true,
        threads: 1,
      },
    );
    expect(bounded.concurrency).toBe(1);
    expect(bounded.workerThreadBudgets).toEqual([1]);
  });

  it("uses CPU-adaptive worker defaults and reports cached and completed progress", async () => {
    installFakeAnalyzer();
    stubNativeRuntime();
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    const audioPaths = [makeAudio(root, "one.mp3"), makeAudio(root, "two.mp3")];
    const doctorCounter = join(root, "doctor-counter");
    process.env.FAKE_ANALYZER_DOCTOR_COUNTER = doctorCounter;
    const firstProgress: Array<string> = [];
    const first = await analyzeTracks(audioPaths, {
      analyzerBinary: process.execPath,
      force: true,
      onProgress(progress) {
        firstProgress.push(progress.phase);
      },
    });
    expect(DEFAULT_ANALYZER_CONCURRENCY).toBeGreaterThan(0);
    expect(DEFAULT_ANALYZER_CONCURRENCY).toBeLessThanOrEqual(
      Math.min(12, DEFAULT_ANALYZER_THREAD_BUDGET),
    );
    expect(DEFAULT_ANALYZER_TRACK_THREADS).toBe(Math.min(8, DEFAULT_ANALYZER_THREAD_BUDGET));
    expect(first.concurrency).toBe(2);
    expect(counterValue(doctorCounter)).toBe(1);
    expect(firstProgress.filter((phase) => phase === "started")).toHaveLength(2);
    expect(firstProgress.filter((phase) => phase === "completed")).toHaveLength(2);

    const warmProgress: Array<string> = [];
    await analyzeTracks(audioPaths, {
      analyzerBinary: process.execPath,
      onProgress(progress) {
        warmProgress.push(progress.phase);
      },
    });
    expect(warmProgress).toEqual(["cached", "cached"]);
    expect(counterValue(doctorCounter)).toBe(2);
  });

  it("does not let progress observer failures interrupt analyzer workers", async () => {
    installFakeAnalyzer();
    stubNativeRuntime();
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    const audioPaths = [makeAudio(root, "one.mp3"), makeAudio(root, "two.mp3")];

    const result = await analyzeTracks(audioPaths, {
      analyzerBinary: process.execPath,
      force: true,
      onProgress() {
        throw new Error("broken observer");
      },
    });

    expect(result.results).toHaveLength(2);
    expect(result.analyzed).toBe(2);
  });

  it("aborts active asynchronous analyzer workers with ordered partial results", async () => {
    installFakeAnalyzer();
    stubNativeRuntime();
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    const cachedPath = makeAudio(root, "cached.mp3");
    const cancelledPath = makeAudio(root, "cancelled.mp3");
    await analyzeTrackAsync(cachedPath, {
      analyzerBinary: process.execPath,
      force: true,
    });
    const controller = new AbortController();
    process.env.FAKE_ANALYZER_MODE = "hang";
    const pending = analyzeTracks([cachedPath, cancelledPath], {
      analyzerBinary: process.execPath,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new DOMException("test abort", "AbortError")), 20);
    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AnalyzeTracksCancelledError);
    expect(error).toMatchObject({
      name: "AbortError",
      partialResult: {
        analyzed: 0,
        cacheHits: 1,
        cancelled: 1,
        failed: 0,
        requested: 2,
      },
    });
    const cancelled = error as AnalyzeTracksCancelledError;
    expect(cancelled.partialResult.results[0]?.audioPath).toBe(realpathSync(cachedPath));
    expect(cancelled.partialResult.results[1]).toBeUndefined();
  });

  it("escalates an ignored abort signal to SIGKILL", async () => {
    installFakeAnalyzer();
    stubNativeRuntime();
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    const audioPath = makeAudio(root);
    const controller = new AbortController();
    process.env.FAKE_ANALYZER_MODE = "ignore-term";
    const pending = analyzeTrackAsync(audioPath, {
      analyzerBinary: process.execPath,
      force: true,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const started = performance.now();
    controller.abort(new DOMException("test abort", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(performance.now() - started).toBeGreaterThanOrEqual(900);
    expect(performance.now() - started).toBeLessThan(2_500);
  });

  it("retries the native Unicode-path failure through an exact ASCII staging copy", async () => {
    installFakeAnalyzer();
    stubNativeRuntime();
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    const audioPath = makeAudio(root, "Sébastien.mp3");
    process.env.FAKE_ANALYZER_MODE = "unicode-path";
    const result = await analyzeTrackAsync(audioPath, {
      analyzerBinary: process.execPath,
      engine: "reference",
      force: true,
    });
    expect(result.audioPath).toBe(realpathSync(audioPath));
    expect(result.source.path).toBe(realpathSync(audioPath));
    expect(readAnalysisResult(result.summaryPath).audioPath).toBe(realpathSync(audioPath));
    expect(result.outputs.every(([path]) => dirname(path) === dirname(result.summaryPath))).toBe(
      true,
    );
    for (const [path] of result.outputs) {
      expect(AnlzFile.parseFile(path).get("PPTH")).toBe("?/Sébastien.mp3");
    }
    expect(result.outputs.every(([path, size]) => statSync(path).size === size)).toBe(true);
    expect(result.summary.files.every(({ path, size }) => statSync(path).size === size)).toBe(true);
  });

  it("retains indexed partial results when one batch item fails", async () => {
    installFakeAnalyzer();
    stubNativeRuntime();
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    const successful = makeAudio(root, "good.mp3");
    const failed = makeAudio(root, "fail.mp3");
    const error = await analyzeTracks([successful, failed], {
      analyzerBinary: process.execPath,
      force: true,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AnalyzeTracksError);
    const batchError = error as AnalyzeTracksError;
    expect(batchError.failures).toMatchObject([
      { audioPath: resolve(failed), index: 1, kind: "process" },
    ]);
    expect(batchError.partialResult).toMatchObject({
      analyzed: 1,
      cancelled: 0,
      failed: 1,
      requested: 2,
    });
    expect(batchError.partialResult.results[0]?.audioPath).toBe(realpathSync(successful));
    expect(batchError.partialResult.results[1]).toBeUndefined();
  });

  it("rejects missing audio asynchronously before launching a worker", async () => {
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    await expect(analyzeTrackAsync(join(root, "missing.mp3"))).rejects.toThrow("does not exist");
  });

  it("diagnoses the helper and reports platform, path, and process failures", () => {
    installFakeAnalyzer();
    stubNativeRuntime();
    delete process.env.REKORDBOX_ANALYZER_ROOT;
    expect(
      diagnoseAnalyzer({
        analyzerBinary: process.execPath,
        rekordboxApp: "./rekordbox.app",
        rekordboxCache: "./cache",
      }),
    ).toEqual({
      app: resolve("rekordbox.app"),
      backend: "clean-room-test",
      cache: resolve("cache"),
      cleanRoom: true,
      proprietaryDependencies: false,
      root: dirname(dirname(process.execPath)),
    });

    process.env.FAKE_ANALYZER_MODE = "fail-doctor";
    expect(() => diagnoseAnalyzer({ analyzerBinary: process.execPath })).toThrow(
      "doctor exited with 3",
    );
    delete process.env.FAKE_ANALYZER_MODE;
    expect(() => diagnoseAnalyzer({ analyzerBinary: "./missing-helper" })).toThrow(
      "does not exist",
    );
    stubNativeRuntime("linux");
    expect(diagnoseAnalyzer({ analyzerBinary: process.execPath })).toEqual({
      backend: "clean-room-test",
      cleanRoom: true,
      proprietaryDependencies: false,
      root: dirname(dirname(process.execPath)),
    });
    expect(() =>
      diagnoseAnalyzer({ analyzerBinary: process.execPath, engine: "reference" }),
    ).toThrow("requires macOS");
  });

  it("compares beat grids through the clean helper with validated bounded output", () => {
    installFakeAnalyzer();
    stubNativeRuntime();
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    const reference = join(root, "reference");
    const candidate = join(root, "candidate");
    mkdirSync(reference);
    mkdirSync(candidate);

    expect(
      compareBeatGrids(reference, candidate, {
        analyzerBinary: process.execPath,
        timeoutMs: 1_000,
      }),
    ).toMatchObject({
      referenceDirectory: realpathSync(reference),
      candidateDirectory: realpathSync(candidate),
      referenceBeatCount: 64,
      candidateBeatCount: 64,
      alignedTimestampError: { medianMs: 1, p95Ms: 4 },
      beatNumberAccuracy: 1,
      at70Ms: { f1: 1 },
    });
    expect(() =>
      compareBeatGrids(join(root, "missing"), candidate, {
        analyzerBinary: process.execPath,
      }),
    ).toThrow("does not exist");
    expect(() =>
      compareBeatGrids(reference, candidate, {
        analyzerBinary: process.execPath,
        timeoutMs: 0,
      }),
    ).toThrow("positive integer");

    process.env.FAKE_ANALYZER_MODE = "invalid-json";
    expect(() =>
      compareBeatGrids(reference, candidate, { analyzerBinary: process.execPath }),
    ).toThrow("malformed JSON");
    process.env.FAKE_ANALYZER_MODE = "fail";
    expect(() =>
      compareBeatGrids(reference, candidate, { analyzerBinary: process.execPath }),
    ).toThrow("exited with 2");
  });

  it("compares decoded waveforms through the clean helper with validated bounded output", () => {
    installFakeAnalyzer();
    stubNativeRuntime();
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    const reference = join(root, "reference");
    const candidate = join(root, "candidate");
    mkdirSync(reference);
    mkdirSync(candidate);

    expect(
      compareWaveforms(reference, candidate, {
        analyzerBinary: process.execPath,
        timeoutMs: 1_000,
      }),
    ).toMatchObject({
      referenceDirectory: realpathSync(reference),
      candidateDirectory: realpathSync(candidate),
      waveforms: [
        {
          kind: "PWV7",
          countDelta: -1,
          components: [{ name: "low", correlation: 0.95, meanAbsoluteError: 1 }],
        },
      ],
    });
    expect(() =>
      compareWaveforms(join(root, "missing"), candidate, {
        analyzerBinary: process.execPath,
      }),
    ).toThrow("does not exist");
    expect(() =>
      compareWaveforms(reference, candidate, {
        analyzerBinary: process.execPath,
        timeoutMs: 0,
      }),
    ).toThrow("positive integer");

    process.env.FAKE_ANALYZER_MODE = "invalid-json";
    expect(() =>
      compareWaveforms(reference, candidate, { analyzerBinary: process.execPath }),
    ).toThrow("malformed JSON");
    process.env.FAKE_ANALYZER_MODE = "fail";
    expect(() =>
      compareWaveforms(reference, candidate, { analyzerBinary: process.execPath }),
    ).toThrow("exited with 2");
  });

  it("rejects a legacy proprietary helper before clean audio analysis", () => {
    installFakeAnalyzer();
    stubNativeRuntime();
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    const audioPath = makeAudio(root);
    process.env.FAKE_ANALYZER_MODE = "legacy-doctor";

    expect(() =>
      analyzeTrack(audioPath, { analyzerBinary: process.execPath, force: true }),
    ).toThrow("clean analyzer identity check failed");
    expect(() => diagnoseAnalyzer({ analyzerBinary: process.execPath })).toThrow(
      "clean analyzer identity check failed",
    );
  });

  it("runs synchronously, validates cache artifacts, and invalidates stale sources", () => {
    installFakeAnalyzer();
    stubNativeRuntime();
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    const audioPath = makeAudio(root);
    const outputDirectory = join(root, "output");
    const counter = join(root, "counter");
    process.env.FAKE_ANALYZER_COUNTER = counter;
    const options = { analyzerBinary: process.execPath, outputDirectory };

    const first = analyzeTrack(audioPath, { ...options, force: true });
    expect(first.summary.tempo_bpm).toBe(125);
    expect(first.source.path).toBe(realpathSync(audioPath));
    expect(counterValue(counter)).toBe(1);
    expect(analyzeTrack(audioPath, options).summaryPath).toBe(first.summaryPath);
    expect(counterValue(counter)).toBe(1);

    writeFileSync(join(outputDirectory, "ANLZ0000.2EX"), "invalid");
    analyzeTrack(audioPath, options);
    expect(counterValue(counter)).toBe(2);

    appendFileSync(audioPath, " changed");
    analyzeTrack(audioPath, options);
    expect(counterValue(counter)).toBe(3);

    expect(() => analyzeTrack(root, { analyzerBinary: process.execPath })).toThrow("is not a file");
  });

  it("propagates rhythm mode and never reuses a grid analyzed in another mode", () => {
    installFakeAnalyzer();
    stubNativeRuntime();
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    const audioPath = makeAudio(root);
    const outputDirectory = join(root, "output");
    const counter = join(root, "counter");
    process.env.FAKE_ANALYZER_COUNTER = counter;
    const options = { analyzerBinary: process.execPath, outputDirectory };

    const normal = analyzeTrack(audioPath, { ...options, force: true });
    expect(normal).toMatchObject({
      rhythmMode: "normal",
      rhythmModeRequested: "normal",
    });
    expect(analyzeTrack(audioPath, options).rhythmMode).toBe("normal");
    expect(counterValue(counter)).toBe(1);

    const dynamic = analyzeTrack(audioPath, { ...options, rhythmMode: "dynamic" });
    expect(dynamic).toMatchObject({
      rhythmMode: "dynamic",
      rhythmModeRequested: "dynamic",
    });
    expect(counterValue(counter)).toBe(2);
    expect(analyzeTrack(audioPath, { ...options, rhythmMode: "dynamic" }).rhythmMode).toBe(
      "dynamic",
    );
    expect(counterValue(counter)).toBe(2);

    const automatic = analyzeTrack(audioPath, { ...options, rhythmMode: "auto" });
    expect(automatic.rhythmModeRequested).toBe("auto");
    expect(counterValue(counter)).toBe(3);
  });

  it("never reuses analysis artifacts across clean and reference engines", () => {
    installFakeAnalyzer();
    stubNativeRuntime();
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    const audioPath = makeAudio(root);
    const outputDirectory = join(root, "output");
    const counter = join(root, "counter");
    process.env.FAKE_ANALYZER_COUNTER = counter;
    const options = { analyzerBinary: process.execPath, outputDirectory };

    expect(analyzeTrack(audioPath, { ...options, force: true }).backend).toBe("clean-room-test");
    expect(analyzeTrack(audioPath, { ...options, engine: "reference" }).backend).toBe(
      "rekordbox-dlopen-rehost",
    );
    expect(analyzeTrack(audioPath, { ...options, engine: "reference" }).backend).toBe(
      "rekordbox-dlopen-rehost",
    );
    expect(analyzeTrack(audioPath, options).backend).toBe("clean-room-test");
    expect(counterValue(counter)).toBe(3);
  });

  it("controls and isolates the local reference analyzer rhythm mode", () => {
    installFakeAnalyzer();
    stubNativeRuntime();
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    const audioPath = makeAudio(root);
    const outputDirectory = join(root, "output");
    const counter = join(root, "counter");
    process.env.FAKE_ANALYZER_COUNTER = counter;
    const options = {
      analyzerBinary: process.execPath,
      engine: "reference" as const,
      outputDirectory,
    };

    expect(analyzeTrack(audioPath, { ...options, force: true })).toMatchObject({
      rhythmMode: "normal",
      rhythmModeRequested: "normal",
    });
    expect(counterValue(counter)).toBe(1);
    expect(analyzeTrack(audioPath, options).rhythmMode).toBe("normal");
    expect(counterValue(counter)).toBe(1);

    expect(analyzeTrack(audioPath, { ...options, rhythmMode: "dynamic" })).toMatchObject({
      rhythmMode: "dynamic",
      rhythmModeRequested: "dynamic",
    });
    expect(counterValue(counter)).toBe(2);
    expect(analyzeTrack(audioPath, { ...options, rhythmMode: "dynamic" }).rhythmMode).toBe(
      "dynamic",
    );
    expect(counterValue(counter)).toBe(2);
    expect(() => analyzeTrack(audioPath, { ...options, rhythmMode: "auto" })).toThrow(
      "requires an explicit Normal or Dynamic",
    );
  });

  it("keeps force replacement bounded and rejects output aliases to the input", () => {
    installFakeAnalyzer();
    stubNativeRuntime();
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    const audioPath = makeAudio(root);
    const outputDirectory = join(root, "output");
    mkdirSync(outputDirectory);
    const unrelated = join(outputDirectory, "keep.txt");
    writeFileSync(unrelated, "caller-owned");

    analyzeTrack(audioPath, {
      analyzerBinary: process.execPath,
      force: true,
      outputDirectory,
    });
    expect(readFileSync(unrelated, "utf8")).toBe("caller-owned");

    const collidingAudio = makeAudio(root, "analysis.json");
    const before = readFileSync(collidingAudio);
    expect(() =>
      analyzeTrack(collidingAudio, {
        analyzerBinary: process.execPath,
        force: true,
        outputDirectory: root,
      }),
    ).toThrow("collides with input audio");
    expect(readFileSync(collidingAudio)).toEqual(before);
  });

  it("handles asynchronous success, helper failure, malformed output, and timeout", async () => {
    installFakeAnalyzer();
    stubNativeRuntime();
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    const audioPath = makeAudio(root);
    const options = {
      analyzerBinary: process.execPath,
      force: true,
      outputDirectory: join(root, "output"),
    };

    await expect(analyzeTrackAsync(audioPath, options)).resolves.toMatchObject({
      summary: { key: "F", tempo_bpm: 125 },
    });
    process.env.FAKE_ANALYZER_MODE = "fail";
    await expect(analyzeTrackAsync(audioPath, options)).rejects.toThrow("exited with 2");
    process.env.FAKE_ANALYZER_MODE = "missing-twoex";
    await expect(analyzeTrackAsync(audioPath, options)).rejects.toThrow("did not produce");
    process.env.FAKE_ANALYZER_MODE = "invalid-json";
    await expect(analyzeTrackAsync(audioPath, options)).rejects.toThrow();
    process.env.FAKE_ANALYZER_MODE = "hang";
    await expect(analyzeTrackAsync(audioPath, { ...options, timeoutMs: 20 })).rejects.toThrow(
      "timed out after 20ms",
    );
  });

  it("runs bounded batches in input order and aggregates worker failures", async () => {
    installFakeAnalyzer();
    stubNativeRuntime();
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    const audioPaths = [makeAudio(root, "one.mp3"), makeAudio(root, "two.mp3")];
    const options = { analyzerBinary: process.execPath, concurrency: 2, force: true };

    const batch = await analyzeTracks(audioPaths, options);
    expect(batch).toMatchObject({
      analyzed: 2,
      cacheHits: 0,
      concurrency: 2,
      requested: 2,
      timings: {
        analyzeMs: expect.any(Number),
        preflightMs: expect.any(Number),
        totalMs: expect.any(Number),
      },
    });
    expect(batch.throughputTracksPerSecond).toBeGreaterThan(0);
    expect(batch.results.map((result) => basename(result.audioPath))).toEqual([
      "one.mp3",
      "two.mp3",
    ]);
    await expect(
      analyzeTracks(audioPaths, { analyzerBinary: process.execPath, force: true }),
    ).resolves.toMatchObject({
      analyzed: 2,
      concurrency: 2,
      requested: 2,
    });
    await expect(
      analyzeTracks(audioPaths, { analyzerBinary: process.execPath, concurrency: 2 }),
    ).resolves.toMatchObject({
      analyzed: 0,
      cacheHits: 2,
      requested: 2,
      throughputTracksPerSecond: 0,
    });

    const failed = makeAudio(root, "fail.mp3");
    await expect(analyzeTracks([audioPaths[0]!, failed], options)).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: expect.stringContaining("fail.mp3") })],
    });
  });
});
