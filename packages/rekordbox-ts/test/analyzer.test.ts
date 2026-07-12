import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeTrack,
  analyzeTrackAsync,
  analyzeTracks,
  diagnoseAnalyzer,
  getAnalyzerBinary,
  readAnalysisResult,
} from "../src/analyzer/index.js";

const roots: Array<string> = [];
const helperPaths = [resolve("analyze"), resolve("doctor")];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
const archDescriptor = Object.getOwnPropertyDescriptor(process, "arch");
const analyzerRoot = process.env.REKORDBOX_ANALYZER_ROOT;

const fakeAnalyzer = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const command = basename(process.argv[1]);
const mode = process.env.FAKE_ANALYZER_MODE;
if (command === "doctor") {
  if (mode === "fail-doctor") {
    console.error("fake doctor failure");
    process.exit(3);
  }
  console.log(JSON.stringify({
    app: process.env.REKORDBOX_ANALYZER_APP,
    cache: process.env.REKORDBOX_ANALYZER_CACHE,
    root: process.env.REKORDBOX_ANALYZER_ROOT,
  }));
  process.exit(0);
}

const [audioPath, outputDirectory, nativeLog] = process.argv.slice(2);
if (process.env.FAKE_ANALYZER_COUNTER)
  appendFileSync(process.env.FAKE_ANALYZER_COUNTER, "1\\n");
if (mode === "fail" || basename(audioPath).includes("fail")) {
  console.error("fake analyzer failure");
  process.exit(2);
}
if (mode === "hang") await new Promise((resolve) => setTimeout(resolve, 60_000));

mkdirSync(outputDirectory, { recursive: true });
const header = Buffer.alloc(28);
header.write("PMAI", 0, "ascii");
header.writeUInt32BE(28, 4);
header.writeUInt32BE(28, 8);
const outputs = [];
for (const suffix of ["DAT", "EXT", "2EX"]) {
  if (mode === "missing-twoex" && suffix === "2EX") continue;
  const path = join(outputDirectory, \`ANLZ0000.\${suffix}\`);
  writeFileSync(path, header);
  outputs.push([path, header.length]);
}
if (mode === "invalid-json") {
  console.log("not json");
  process.exit(0);
}
console.log(JSON.stringify({
  analyzePath: join(outputDirectory, "ANLZ0000.DAT"),
  audioPath: realpathSync(audioPath),
  backend: "fake",
  binary: process.execPath,
  callbackError: null,
  callbackStatus: 0,
  contentId: process.pid,
  nativeLog,
  outputs,
  startResult: 0,
  summary: {
    beat_grid: null,
    files: [],
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
  delete process.env.FAKE_ANALYZER_MODE;
  if (analyzerRoot === undefined) delete process.env.REKORDBOX_ANALYZER_ROOT;
  else process.env.REKORDBOX_ANALYZER_ROOT = analyzerRoot;
  for (const path of helperPaths) rmSync(path, { force: true });
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("Rekordbox analyzer wrapper", () => {
  it("resolves explicit helpers and reads durable summaries", () => {
    expect(getAnalyzerBinary("./helper")).toBe(resolve("helper"));
    const root = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
    roots.push(root);
    const path = join(root, "analysis.json");
    const result = { backend: "rekordbox-dlopen-rehost", summaryPath: path };
    writeFileSync(path, JSON.stringify(result));
    expect(readAnalysisResult(path)).toEqual(result);
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
    await expect(analyzeTracks(["same.mp3", "same.mp3"])).rejects.toThrow(
      "Multiple tracks resolve",
    );
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
      cache: resolve("cache"),
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
    expect(() => diagnoseAnalyzer({ analyzerBinary: process.execPath })).toThrow("requires macOS");
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
