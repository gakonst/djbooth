import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { AnlzFile, getAnlzPaths } from "../anlz/index.js";

const helperName = "rekordbox-analyzer";

/** Parsed beat-grid summary emitted by the native Rekordbox analyzer. */
export type RekordboxBeatGridSummary = {
  avg_bpm: number;
  beat_count: number;
  first_beats: Array<{ beat: number; bpm: number; time_ms: number }>;
  first_downbeat_ms: number;
  last_beat_ms: number;
  max_bpm: number;
  min_bpm: number;
};

/** Native analyzer result plus the durable summary path. */
export type RekordboxAnalysisResult = {
  analyzePath: string;
  audioPath: string;
  backend: string;
  binary: string;
  callbackError: string | null;
  callbackStatus: number | null;
  contentId: number;
  nativeLog: string;
  outputs: Array<[string, number]>;
  startResult: number;
  summary: {
    beat_grid: RekordboxBeatGridSummary | null;
    files: Array<{ path: string; size: number; tags: Array<string> }>;
    key: string | null;
    key_source: string | null;
    tempo_bpm: number | null;
  };
  summaryPath: string;
};

/** Options for producing native Rekordbox DAT, EXT, and 2EX files. */
export type AnalyzeTrackOptions = {
  analyzerBinary?: string;
  force?: boolean;
  outputDirectory?: string;
  rekordboxApp?: string;
  rekordboxCache?: string;
  timeoutMs?: number;
};

/** Resolve the packaged universal analyzer helper or an explicit override. */
export function getAnalyzerBinary(explicit?: string): string {
  const path = explicit ?? process.env.REKORDBOX_ANALYZER_BINARY;
  if (path) return resolve(path);
  return fileURLToPath(new URL(`../../vendor/${helperName}`, import.meta.url));
}

/** Inspect Rekordbox application discovery, binary offsets, cache, and signatures. */
export function diagnoseAnalyzer(
  options: Pick<AnalyzeTrackOptions, "analyzerBinary" | "rekordboxApp" | "rekordboxCache"> = {},
): unknown {
  if (process.platform !== "darwin") throw new TypeError("Rekordbox analysis requires macOS");
  const analyzerBinary = getAnalyzerBinary(options.analyzerBinary);
  if (!existsSync(analyzerBinary))
    throw new TypeError(`Rekordbox analyzer helper '${analyzerBinary}' does not exist`);
  const env = { ...process.env };
  env.REKORDBOX_ANALYZER_ROOT ??= dirname(dirname(analyzerBinary));
  if (options.rekordboxApp) env.REKORDBOX_ANALYZER_APP = resolve(options.rekordboxApp);
  if (options.rekordboxCache) env.REKORDBOX_ANALYZER_CACHE = resolve(options.rekordboxCache);
  const command = process.arch === "arm64" ? "/usr/bin/arch" : analyzerBinary;
  const args = process.arch === "arm64" ? ["-x86_64", analyzerBinary, "doctor"] : ["doctor"];
  const child = spawnSync(command, args, { encoding: "utf8", env, maxBuffer: 4 * 1024 * 1024 });
  if (child.error) throw child.error;
  if (child.status !== 0)
    throw new Error(
      `Rekordbox analyzer doctor exited with ${child.status ?? "no status"}: ${child.stderr.trim()}`,
    );
  return JSON.parse(child.stdout) as unknown;
}

/** Produce the same DAT, EXT, and 2EX artifacts as Rekordbox's native analyzer. */
export function analyzeTrack(
  audioPath: string,
  options: AnalyzeTrackOptions = {},
): RekordboxAnalysisResult {
  const absoluteAudioPath = resolve(audioPath);
  if (!existsSync(absoluteAudioPath))
    throw new TypeError(`Audio file '${absoluteAudioPath}' does not exist`);
  if (process.platform !== "darwin") throw new TypeError("Rekordbox analysis requires macOS");
  const analyzerBinary = getAnalyzerBinary(options.analyzerBinary);
  if (!existsSync(analyzerBinary))
    throw new TypeError(
      `Rekordbox analyzer helper '${analyzerBinary}' does not exist; build it with pnpm --filter @gakonst/rekordbox build:analyzer`,
    );
  const outputDirectory = resolve(
    options.outputDirectory ??
      join(
        dirname(absoluteAudioPath),
        `${basename(absoluteAudioPath, extname(absoluteAudioPath))}.rekordbox`,
      ),
  );
  const summaryPath = join(outputDirectory, "analysis.json");
  const nativeLogPath = join(outputDirectory, "rehost-native.log");
  if (options.force) rmSync(outputDirectory, { force: true, recursive: true });
  mkdirSync(outputDirectory, { recursive: true });
  const existing = getAnlzPaths(outputDirectory);
  if (!options.force && existing.DAT && existing.EXT && existing["2EX"] && existsSync(summaryPath))
    return readAnalysisResult(summaryPath);

  const env = { ...process.env };
  env.REKORDBOX_ANALYZER_ROOT ??= dirname(dirname(analyzerBinary));
  if (options.rekordboxApp) env.REKORDBOX_ANALYZER_APP = resolve(options.rekordboxApp);
  if (options.rekordboxCache) env.REKORDBOX_ANALYZER_CACHE = resolve(options.rekordboxCache);
  const command = process.arch === "arm64" ? "/usr/bin/arch" : analyzerBinary;
  const args =
    process.arch === "arm64"
      ? ["-x86_64", analyzerBinary, "analyze", absoluteAudioPath, outputDirectory, nativeLogPath]
      : ["analyze", absoluteAudioPath, outputDirectory, nativeLogPath];
  const child = spawnSync(command, args, {
    encoding: "utf8",
    env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: options.timeoutMs ?? 300_000,
  });
  if (child.error) throw child.error;
  if (child.status !== 0)
    throw new Error(
      `Rekordbox analyzer exited with ${child.status ?? "no status"}: ${child.stderr.trim() || child.stdout.trim()}`,
    );
  const native = JSON.parse(child.stdout) as Omit<RekordboxAnalysisResult, "summaryPath">;
  const paths = getAnlzPaths(outputDirectory);
  for (const type of ["DAT", "EXT", "2EX"] as const) {
    const path = paths[type];
    if (!path) throw new Error(`Rekordbox analyzer did not produce ANLZ0000.${type}`);
    AnlzFile.parseFile(path);
  }
  const result = { ...native, summaryPath };
  const temporary = `${summaryPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(temporary, summaryPath);
  return result;
}

/** Read a previously persisted analyzer summary. */
export function readAnalysisResult(path: string): RekordboxAnalysisResult {
  return JSON.parse(readFileSync(path, "utf8")) as RekordboxAnalysisResult;
}
