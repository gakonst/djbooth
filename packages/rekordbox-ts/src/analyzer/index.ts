import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { z } from "zod";

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
  source: {
    mtimeMs: number;
    path: string;
    size: number;
  };
  summary: {
    beat_grid: RekordboxBeatGridSummary | null;
    files: Array<{ path: string; size: number; tags: Array<string> }>;
    key: string | null;
    key_source: string | null;
    tempo_bpm: number | null;
  };
  summaryPath: string;
  timings: {
    analyzeStartMs: number;
    backendMs: number;
    completionMs: number;
    loadMs: number;
    outputPrepareMs: number;
    summarizeMs: number;
    totalMs: number;
  };
};

/** Analyzer metadata that can be projected onto a Rekordbox content row. */
export type RekordboxAnalysisMetadata = {
  key: string | null;
  tempoBpm: number | null;
};

const finiteNumber = z.number().finite();
const nonNegativeNumber = finiteNumber.min(0);
const beatSchema = z.object({
  beat: z.number().int().min(1),
  bpm: finiteNumber.positive(),
  time_ms: nonNegativeNumber,
});
const beatGridSchema = z.object({
  avg_bpm: finiteNumber.positive(),
  beat_count: z.number().int().min(0),
  first_beats: z.array(beatSchema),
  first_downbeat_ms: nonNegativeNumber,
  last_beat_ms: nonNegativeNumber,
  max_bpm: finiteNumber.positive(),
  min_bpm: finiteNumber.positive(),
});
const analysisResultSchema = z.object({
  analyzePath: z.string().min(1),
  audioPath: z.string().min(1),
  backend: z.string().min(1),
  binary: z.string().min(1),
  callbackError: z.string().nullable(),
  callbackStatus: z.number().int().nullable(),
  contentId: z.number().int(),
  nativeLog: z.string(),
  outputs: z.array(z.tuple([z.string().min(1), z.number().int().min(0)])),
  source: z.object({
    mtimeMs: nonNegativeNumber,
    path: z.string().min(1),
    size: z.number().int().min(0),
  }),
  startResult: z.number().int(),
  summary: z.object({
    beat_grid: beatGridSchema.nullable(),
    files: z.array(
      z.object({
        path: z.string().min(1),
        size: z.number().int().min(0),
        tags: z.array(z.string()),
      }),
    ),
    key: z.string().trim().min(1).max(64).nullable(),
    key_source: z.string().nullable(),
    tempo_bpm: finiteNumber.positive().max(1_000).nullable(),
  }),
  summaryPath: z.string().min(1),
  timings: z.object({
    analyzeStartMs: nonNegativeNumber,
    backendMs: nonNegativeNumber,
    completionMs: nonNegativeNumber,
    loadMs: nonNegativeNumber,
    outputPrepareMs: nonNegativeNumber,
    summarizeMs: nonNegativeNumber,
    totalMs: nonNegativeNumber,
  }),
});

/** Options for producing native Rekordbox DAT, EXT, and 2EX files. */
export type AnalyzeTrackOptions = {
  analyzerBinary?: string;
  force?: boolean;
  outputDirectory?: string;
  rekordboxApp?: string;
  rekordboxCache?: string;
  timeoutMs?: number;
};

/** Options for bounded, process-isolated native Rekordbox analysis. */
export type AnalyzeTracksOptions = Omit<AnalyzeTrackOptions, "outputDirectory"> & {
  concurrency?: number;
};

/** Ordered results and wall-clock timing for a multi-track analyzer run. */
export type AnalyzeTracksResult = {
  analyzed: number;
  cacheHits: number;
  concurrency: number;
  elapsedMs: number;
  requested: number;
  results: Array<RekordboxAnalysisResult>;
  throughputTracksPerSecond: number;
  timings: {
    analyzeMs: number;
    preflightMs: number;
    totalMs: number;
  };
};

type PreparedAnalysis = {
  args: Array<string>;
  cached?: RekordboxAnalysisResult;
  command: string;
  env: NodeJS.ProcessEnv;
  outputDirectory: string;
  source: RekordboxAnalysisResult["source"];
  summaryPath: string;
};

/** Resolve an explicit, PATH-installed, user-local, or repository-built analyzer helper. */
export function getAnalyzerBinary(explicit?: string): string {
  const path = explicit ?? process.env.REKORDBOX_ANALYZER_BINARY;
  if (path) return resolve(path);
  const pathCandidates = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, helperName));
  const candidates = [
    ...pathCandidates,
    join(homedir(), ".local/bin", helperName),
    "/opt/homebrew/bin/rekordbox-analyzer",
    "/usr/local/bin/rekordbox-analyzer",
    fileURLToPath(new URL(`../../vendor/${helperName}`, import.meta.url)),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
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
  const prepared = prepareAnalysis(audioPath, options);
  if (prepared.cached) return prepared.cached;
  const child = spawnSync(prepared.command, prepared.args, {
    encoding: "utf8",
    env: prepared.env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: options.timeoutMs ?? 300_000,
  });
  if (child.error) throw child.error;
  if (child.status !== 0)
    throw new Error(
      `Rekordbox analyzer exited with ${child.status ?? "no status"}: ${child.stderr.trim() || child.stdout.trim()}`,
    );
  return persistAnalysisResult(child.stdout, prepared);
}

/** Analyze one track without blocking the Node.js event loop. */
export async function analyzeTrackAsync(
  audioPath: string,
  options: AnalyzeTrackOptions = {},
): Promise<RekordboxAnalysisResult> {
  const prepared = prepareAnalysis(audioPath, options);
  if (prepared.cached) return prepared.cached;
  const stdout = await runAnalyzer(prepared, options.timeoutMs ?? 300_000);
  return persistAnalysisResult(stdout, prepared);
}

/** Analyze tracks concurrently in isolated native worker processes, preserving input order. */
export async function analyzeTracks(
  audioPaths: ReadonlyArray<string>,
  options: AnalyzeTracksOptions = {},
): Promise<AnalyzeTracksResult> {
  const configuredConcurrency = options.concurrency ?? 64;
  if (
    !Number.isInteger(configuredConcurrency) ||
    configuredConcurrency < 1 ||
    configuredConcurrency > 64
  )
    throw new TypeError("Analyzer concurrency must be an integer between 1 and 64");

  const absolutePaths = audioPaths.map((audioPath) => resolve(audioPath));
  const outputDirectories = absolutePaths.map(defaultOutputDirectory);
  const destinations = new Set<string>();
  for (const outputDirectory of outputDirectories) {
    if (destinations.has(outputDirectory))
      throw new TypeError(`Multiple tracks resolve to analyzer output '${outputDirectory}'`);
    destinations.add(outputDirectory);
  }

  const started = performance.now();
  const preflightStarted = performance.now();
  const prepared = absolutePaths.map((audioPath) => prepareAnalysis(audioPath, options));
  const preflightMs = roundMilliseconds(performance.now() - preflightStarted);
  const concurrency = Math.min(configuredConcurrency, absolutePaths.length);
  const results = Array.from<RekordboxAnalysisResult>({ length: absolutePaths.length });
  const failures = Array.from<Error | undefined>({ length: absolutePaths.length });
  const pending: number[] = [];
  for (const [index, analysis] of prepared.entries()) {
    if (analysis.cached) results[index] = analysis.cached;
    else pending.push(index);
  }
  const analyzeStarted = performance.now();
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = pending[nextIndex++];
      if (index === undefined) return;
      const audioPath = absolutePaths[index]!;
      try {
        const analysis = prepared[index]!;
        const stdout = await runAnalyzer(analysis, options.timeoutMs ?? 300_000);
        results[index] = persistAnalysisResult(stdout, analysis);
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        failures[index] = new Error(`Failed to analyze '${audioPath}': ${message}`, { cause });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  const analyzeMs = roundMilliseconds(performance.now() - analyzeStarted);
  const errors = failures.filter((error): error is Error => error !== undefined);
  if (errors.length)
    throw new AggregateError(errors, `Rekordbox analysis failed for ${errors.length} track(s)`);
  const totalMs = roundMilliseconds(performance.now() - started);
  return {
    analyzed: pending.length,
    cacheHits: absolutePaths.length - pending.length,
    concurrency,
    elapsedMs: Math.round(totalMs),
    requested: absolutePaths.length,
    results,
    throughputTracksPerSecond:
      pending.length && analyzeMs ? roundMilliseconds((pending.length * 1_000) / analyzeMs) : 0,
    timings: { analyzeMs, preflightMs, totalMs },
  };
}

function prepareAnalysis(audioPath: string, options: AnalyzeTrackOptions): PreparedAnalysis {
  const absoluteAudioPath = resolve(audioPath);
  if (!existsSync(absoluteAudioPath))
    throw new TypeError(`Audio file '${absoluteAudioPath}' does not exist`);
  if (process.platform !== "darwin") throw new TypeError("Rekordbox analysis requires macOS");
  const analyzerBinary = getAnalyzerBinary(options.analyzerBinary);
  if (!existsSync(analyzerBinary))
    throw new TypeError(
      `Rekordbox analyzer helper '${analyzerBinary}' does not exist; set REKORDBOX_ANALYZER_BINARY or build the repository-local helper with pnpm --filter @gakonst/rekordbox build:analyzer`,
    );
  const source = sourceFingerprint(absoluteAudioPath);
  const outputDirectory = resolve(
    options.outputDirectory ?? defaultOutputDirectory(absoluteAudioPath),
  );
  const summaryPath = join(outputDirectory, "analysis.json");
  const nativeLogPath = join(outputDirectory, "rehost-native.log");
  if (options.force) rmSync(outputDirectory, { force: true, recursive: true });
  mkdirSync(outputDirectory, { recursive: true });
  const existing = getAnlzPaths(outputDirectory);
  if (
    !options.force &&
    existing.DAT &&
    existing.EXT &&
    existing["2EX"] &&
    existsSync(summaryPath)
  ) {
    try {
      const cached = readAnalysisResult(summaryPath);
      if (
        cached.source?.path === source.path &&
        cached.source.size === source.size &&
        cached.source.mtimeMs === source.mtimeMs
      ) {
        validateAnalysisFiles(outputDirectory);
        return {
          args: [],
          cached,
          command: analyzerBinary,
          env: process.env,
          outputDirectory,
          source,
          summaryPath,
        };
      }
    } catch {
      // Invalid or stale cached artifacts are replaced by a new native analysis.
    }
  }

  const env = { ...process.env };
  env.REKORDBOX_ANALYZER_ROOT ??= dirname(dirname(analyzerBinary));
  if (options.rekordboxApp) env.REKORDBOX_ANALYZER_APP = resolve(options.rekordboxApp);
  if (options.rekordboxCache) env.REKORDBOX_ANALYZER_CACHE = resolve(options.rekordboxCache);
  const command = process.arch === "arm64" ? "/usr/bin/arch" : analyzerBinary;
  const args =
    process.arch === "arm64"
      ? ["-x86_64", analyzerBinary, "analyze", absoluteAudioPath, outputDirectory, nativeLogPath]
      : ["analyze", absoluteAudioPath, outputDirectory, nativeLogPath];
  return { args, command, env, outputDirectory, source, summaryPath };
}

function sourceFingerprint(audioPath: string): RekordboxAnalysisResult["source"] {
  const metadata = statSync(audioPath);
  if (!metadata.isFile()) throw new TypeError(`Audio path '${audioPath}' is not a file`);
  return {
    mtimeMs: metadata.mtimeMs,
    path: realpathSync(audioPath),
    size: metadata.size,
  };
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

function defaultOutputDirectory(absoluteAudioPath: string): string {
  return join(
    dirname(absoluteAudioPath),
    `${basename(absoluteAudioPath, extname(absoluteAudioPath))}.rekordbox`,
  );
}

function runAnalyzer(prepared: PreparedAnalysis, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(prepared.command, prepared.args, {
      env: prepared.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const maxBuffer = 4 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let captureError: Error | undefined;
    let spawnError: Error | undefined;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next) > maxBuffer) {
        captureError = new Error(`Rekordbox analyzer output exceeded ${maxBuffer} bytes`);
        child.kill("SIGKILL");
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, timeoutMs);
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (spawnError) return rejectPromise(spawnError);
      if (captureError) return rejectPromise(captureError);
      if (timedOut)
        return rejectPromise(new Error(`Rekordbox analyzer timed out after ${timeoutMs}ms`));
      if (status !== 0)
        return rejectPromise(
          new Error(
            `Rekordbox analyzer exited with ${status ?? `signal ${signal ?? "unknown"}`}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
      resolvePromise(stdout);
    });
  });
}

function persistAnalysisResult(
  stdout: string,
  prepared: PreparedAnalysis,
): RekordboxAnalysisResult {
  const currentSource = sourceFingerprint(prepared.source.path);
  if (
    currentSource.size !== prepared.source.size ||
    currentSource.mtimeMs !== prepared.source.mtimeMs
  )
    throw new Error(`Audio file '${prepared.source.path}' changed during Rekordbox analysis`);
  const native = JSON.parse(stdout) as Omit<RekordboxAnalysisResult, "source" | "summaryPath">;
  validateAnalysisFiles(prepared.outputDirectory);
  const result = parseAnalysisResult(
    { ...native, source: prepared.source, summaryPath: prepared.summaryPath },
    "native analyzer output",
  );
  const temporary = `${prepared.summaryPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(temporary, prepared.summaryPath);
  return result;
}

function validateAnalysisFiles(outputDirectory: string): void {
  const paths = getAnlzPaths(outputDirectory);
  for (const type of ["DAT", "EXT", "2EX"] as const) {
    const path = paths[type];
    if (!path) throw new Error(`Rekordbox analyzer did not produce ANLZ0000.${type}`);
    AnlzFile.parseFile(path);
  }
}

/** Read a previously persisted analyzer summary. */
export function readAnalysisResult(path: string): RekordboxAnalysisResult {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (cause) {
    throw new TypeError(`Invalid Rekordbox analysis summary '${path}': malformed JSON`, { cause });
  }
  return parseAnalysisResult(value, `analysis summary '${path}'`);
}

/** Read validated BPM and key metadata from an analyzer output directory. */
export function readAnalysisMetadata(analysisDirectory: string): RekordboxAnalysisMetadata {
  const result = readAnalysisResult(join(resolve(analysisDirectory), "analysis.json"));
  return { key: result.summary.key, tempoBpm: result.summary.tempo_bpm };
}

function parseAnalysisResult(value: unknown, source: string): RekordboxAnalysisResult {
  const parsed = analysisResultSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const location = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    throw new TypeError(
      `Invalid Rekordbox ${source}${location}: ${issue?.message ?? "schema validation failed"}`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
