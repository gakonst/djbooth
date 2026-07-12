import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  analyzeTrack,
  analyzeTrackAsync,
  analyzeTracks,
  getAnalyzerBinary,
  readAnalysisResult,
} from "../src/analyzer/index.js";

const roots: Array<string> = [];

afterEach(() => {
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
});
