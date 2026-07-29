import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import { z } from "zod";

import { AnlzFile, getAnlzPaths } from "../anlz/index.js";

const cleanHelperName = "rekordbox-analyzer";
const referenceHelperName = "rekordbox-analyzer-reference";
const analyzerThreadsEnvironment = "REKORDBOX_ANALYZER_THREADS";
const analyzerRhythmModeEnvironment = "REKORDBOX_ANALYZER_RHYTHM_MODE";
const maximumAnalyzerThreads = 64;

/** Select the releasable clean-room DSP or the local proprietary parity oracle. */
export type AnalyzerEngine = "clean" | "reference";

/** Beat-grid policy matching Rekordbox's Normal and Dynamic analysis modes. */
export type AnalyzerRhythmMode = "normal" | "dynamic" | "auto";

/** Parsed beat-grid summary emitted by an analyzer engine. */
export type RekordboxBeatGridSummary = {
  avg_bpm: number;
  beat_count: number;
  first_beats: Array<{ beat: number; bpm: number; time_ms: number }>;
  first_downbeat_ms: number;
  last_beat_ms: number;
  max_bpm: number;
  min_bpm: number;
};

/** Standardized clean-room feature evidence for one generated phrase. */
export type RekordboxPhraseFeatureSummary = {
  beat: number;
  distance_from_previous: number;
  duration_bars: number;
  energy_delta_z: number;
  energy_z: number;
  high_band_z: number;
  index: number;
  low_band_z: number;
  mid_band_z: number;
  onset_z: number;
  zero_crossing_z: number;
};

/** Bounded phrase entry emitted in an analyzer result summary. */
export type RekordboxPhraseSummary = {
  b: boolean;
  beat: number;
  features?: RekordboxPhraseFeatureSummary;
  fill_beat: number | null;
  index: number;
  k1: boolean;
  k2: boolean;
  k3: boolean;
  kind: number;
  transition_beats: [number | null, number | null, number | null];
};

/** Bounded clean-room song-structure summary. */
export type RekordboxSongStructureSummary = {
  end_beat: number;
  first_phrases: Array<RekordboxPhraseSummary>;
  input_mix: string;
  mood: number;
  phrase_count: number;
  sample_rate: number;
};

/** Analyzer result plus the durable summary path. */
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
  rhythmFallback?: string | null;
  rhythmMode?: "normal" | "dynamic";
  rhythmModeRequested?: AnalyzerRhythmMode;
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
    song_structure?: RekordboxSongStructureSummary;
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

/** One endpoint in a sub-millisecond Rekordbox beat-grid comparison. */
export type BeatGridEndpoint = {
  beat: number;
  bpm: number;
  timeMs: number;
};

/** Absolute aligned beat timestamp errors, in milliseconds. */
export type BeatTimestampErrorDistribution = {
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
};

/** Absolute aligned tempo errors, in beats per minute. */
export type BeatTempoErrorDistribution = {
  meanBpm: number;
  medianBpm: number;
  p95Bpm: number;
  maxBpm: number;
};

/** Precision, recall, and F1 inside one beat-timing collar. */
export type BeatGridMatchRate = {
  toleranceMs: number;
  matches: number;
  precision: number;
  recall: number;
  f1: number;
};

/** Semantic PQTZ/PQT2 comparison produced by the clean-room analyzer. */
export type BeatGridDifferential = {
  referenceDirectory: string;
  candidateDirectory: string;
  referenceBeatCount: number;
  candidateBeatCount: number;
  matchedBeats: number;
  referenceUnmatchedBeats: number;
  candidateUnmatchedBeats: number;
  referenceFirst: BeatGridEndpoint;
  candidateFirst: BeatGridEndpoint;
  referenceLast: BeatGridEndpoint;
  candidateLast: BeatGridEndpoint;
  firstTimestampErrorMs: number;
  lastTimestampErrorMs: number;
  alignedTimestampError: BeatTimestampErrorDistribution;
  driftMsPer100Beats: number;
  beatNumberPhase: number;
  beatNumberAccuracy: number;
  referenceTempoChanges: number;
  candidateTempoChanges: number;
  alignedTempoError: BeatTempoErrorDistribution;
  referenceDownbeatCount: number;
  candidateDownbeatCount: number;
  matchedDownbeats: number;
  downbeatTimestampError: BeatTimestampErrorDistribution;
  at70Ms: BeatGridMatchRate;
  at100Ms: BeatGridMatchRate;
};

/** Options for a bounded semantic beat-grid comparison. */
export type CompareBeatGridsOptions = {
  analyzerBinary?: string;
  timeoutMs?: number;
};

/** Same-column scalar errors for one decoded Rekordbox waveform component. */
export type WaveformComponentDifferential = {
  name: string;
  referenceCount: number;
  candidateCount: number;
  overlapCount: number;
  countDelta: number;
  exactValues: number;
  exactFraction: number;
  correlation: number | null;
  meanReference: number;
  meanCandidate: number;
  meanAbsoluteError: number;
  medianAbsoluteError: number;
  p95AbsoluteError: number;
  maxAbsoluteError: number;
  signedMeanError: number;
};

/** Semantic component comparison for one Rekordbox waveform tag. */
export type WaveformTagDifferential = {
  kind: string;
  entryBytes: number;
  referenceCount: number;
  candidateCount: number;
  countDelta: number;
  components: Array<WaveformComponentDifferential>;
};

/** Semantic PWAV/PWV2/PWV3/PWV4/PWV5/PWV6/PWV7 comparison. */
export type WaveformDifferential = {
  referenceDirectory: string;
  candidateDirectory: string;
  waveforms: Array<WaveformTagDifferential>;
};

/** Options for a bounded semantic waveform comparison. */
export type CompareWaveformsOptions = {
  analyzerBinary?: string;
  timeoutMs?: number;
};

const finiteNumber = z.number().finite();
const nonNegativeNumber = finiteNumber.min(0);
const nonNegativeInteger = z.number().int().min(0);
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
const songStructureSchema = z.object({
  end_beat: z.number().int().min(1).max(65_535),
  first_phrases: z
    .array(
      z.object({
        b: z.boolean(),
        beat: z.number().int().min(1).max(65_535),
        features: z
          .object({
            beat: z.number().int().min(1).max(65_535),
            distance_from_previous: nonNegativeNumber,
            duration_bars: z.number().int().min(1),
            energy_delta_z: finiteNumber,
            energy_z: finiteNumber,
            high_band_z: finiteNumber,
            index: z.number().int().min(1).max(65_535),
            low_band_z: finiteNumber,
            mid_band_z: finiteNumber,
            onset_z: finiteNumber,
            zero_crossing_z: finiteNumber,
          })
          .optional(),
        fill_beat: z.number().int().min(1).max(65_535).nullable(),
        index: z.number().int().min(1).max(65_535),
        k1: z.boolean(),
        k2: z.boolean(),
        k3: z.boolean(),
        kind: z.number().int().min(1).max(65_535),
        transition_beats: z.tuple([
          z.number().int().min(1).max(65_535).nullable(),
          z.number().int().min(1).max(65_535).nullable(),
          z.number().int().min(1).max(65_535).nullable(),
        ]),
      }),
    )
    .max(12),
  input_mix: z.literal("left-0.99-right-0.01"),
  mood: z.number().int().min(1).max(3),
  phrase_count: z.number().int().min(1),
  sample_rate: z.union([z.literal(44_100), z.literal(48_000)]),
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
  rhythmFallback: z.string().nullable().optional(),
  rhythmMode: z.enum(["normal", "dynamic"]).optional(),
  rhythmModeRequested: z.enum(["normal", "dynamic", "auto"]).optional(),
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
    song_structure: songStructureSchema.optional(),
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
const beatGridEndpointSchema = z.object({
  beat: z.number().int().min(1).max(4),
  bpm: finiteNumber.positive(),
  timeMs: nonNegativeNumber,
});
const timestampErrorDistributionSchema = z.object({
  meanMs: nonNegativeNumber,
  medianMs: nonNegativeNumber,
  p95Ms: nonNegativeNumber,
  maxMs: nonNegativeNumber,
});
const tempoErrorDistributionSchema = z.object({
  meanBpm: nonNegativeNumber,
  medianBpm: nonNegativeNumber,
  p95Bpm: nonNegativeNumber,
  maxBpm: nonNegativeNumber,
});
const beatGridMatchRateSchema = z.object({
  toleranceMs: nonNegativeNumber,
  matches: nonNegativeInteger,
  precision: finiteNumber.min(0).max(1),
  recall: finiteNumber.min(0).max(1),
  f1: finiteNumber.min(0).max(1),
});
const beatGridDifferentialSchema = z.object({
  referenceDirectory: z.string().min(1),
  candidateDirectory: z.string().min(1),
  referenceBeatCount: nonNegativeInteger,
  candidateBeatCount: nonNegativeInteger,
  matchedBeats: nonNegativeInteger,
  referenceUnmatchedBeats: nonNegativeInteger,
  candidateUnmatchedBeats: nonNegativeInteger,
  referenceFirst: beatGridEndpointSchema,
  candidateFirst: beatGridEndpointSchema,
  referenceLast: beatGridEndpointSchema,
  candidateLast: beatGridEndpointSchema,
  firstTimestampErrorMs: finiteNumber,
  lastTimestampErrorMs: finiteNumber,
  alignedTimestampError: timestampErrorDistributionSchema,
  driftMsPer100Beats: finiteNumber,
  beatNumberPhase: nonNegativeInteger.max(3),
  beatNumberAccuracy: finiteNumber.min(0).max(1),
  referenceTempoChanges: nonNegativeInteger,
  candidateTempoChanges: nonNegativeInteger,
  alignedTempoError: tempoErrorDistributionSchema,
  referenceDownbeatCount: nonNegativeInteger,
  candidateDownbeatCount: nonNegativeInteger,
  matchedDownbeats: nonNegativeInteger,
  downbeatTimestampError: timestampErrorDistributionSchema,
  at70Ms: beatGridMatchRateSchema,
  at100Ms: beatGridMatchRateSchema,
});
const waveformComponentDifferentialSchema = z.object({
  name: z.string().min(1),
  referenceCount: nonNegativeInteger,
  candidateCount: nonNegativeInteger,
  overlapCount: nonNegativeInteger,
  countDelta: z.number().int(),
  exactValues: nonNegativeInteger,
  exactFraction: finiteNumber.min(0).max(1),
  correlation: finiteNumber.min(-1).max(1).nullable(),
  meanReference: nonNegativeNumber,
  meanCandidate: nonNegativeNumber,
  meanAbsoluteError: nonNegativeNumber,
  medianAbsoluteError: nonNegativeNumber,
  p95AbsoluteError: nonNegativeNumber,
  maxAbsoluteError: nonNegativeNumber,
  signedMeanError: finiteNumber,
});
const waveformDifferentialSchema = z.object({
  referenceDirectory: z.string().min(1),
  candidateDirectory: z.string().min(1),
  waveforms: z.array(
    z.object({
      kind: z.enum(["PWAV", "PWV2", "PWV3", "PWV4", "PWV5", "PWV6", "PWV7"]),
      entryBytes: z.number().int().min(1).max(6),
      referenceCount: nonNegativeInteger,
      candidateCount: nonNegativeInteger,
      countDelta: z.number().int(),
      components: z.array(waveformComponentDifferentialSchema).min(1),
    }),
  ),
});

/** Options for producing Rekordbox DAT, EXT, and 2EX files. */
export type AnalyzeTrackOptions = {
  analyzerBinary?: string;
  engine?: AnalyzerEngine;
  force?: boolean;
  outputDirectory?: string;
  rekordboxApp?: string;
  rekordboxCache?: string;
  /** Normal for a static grid, Dynamic for tempo changes, or conservative Auto selection. */
  rhythmMode?: AnalyzerRhythmMode;
  signal?: AbortSignal;
  /** Native CPU workers for one clean analyzer process. */
  threads?: number;
  timeoutMs?: number;
};

const hostAnalyzerParallelism = Math.min(maximumAnalyzerThreads, availableParallelism());
const defaultBatchThreadMultiplier =
  process.platform === "darwin" && process.arch === "arm64" ? 2 : 1;

/**
 * Default native scheduling budget shared across active analyzer processes.
 *
 * Apple Silicon keeps two Rayon slots per core: measured Auto analysis benefits
 * from overlapping independent DSP branches, while process concurrency remains
 * bounded to physical host parallelism.
 */
export const DEFAULT_ANALYZER_THREAD_BUDGET = Math.min(
  maximumAnalyzerThreads,
  hostAnalyzerParallelism * defaultBatchThreadMultiplier,
);

/** CPU-adaptive default for process-isolated clean analyzer workers. */
export const DEFAULT_ANALYZER_CONCURRENCY = Math.min(12, hostAnalyzerParallelism);

/** Measured single-track sweet spot before native parallelism regresses. */
export const DEFAULT_ANALYZER_TRACK_THREADS = Math.min(8, DEFAULT_ANALYZER_THREAD_BUDGET);

/** Progress emitted by a bounded multi-track analyzer run. */
export type AnalyzeTracksProgress = {
  audioPath: string;
  completed: number;
  index: number;
  phase: "cached" | "started" | "completed" | "failed" | "cancelled";
  total: number;
};

/** Options for bounded, process-isolated Rekordbox analysis. */
export type AnalyzeTracksOptions = Omit<AnalyzeTrackOptions, "outputDirectory"> & {
  concurrency?: number;
  onProgress?: (progress: AnalyzeTracksProgress) => void;
};

/** Ordered results and wall-clock timing for a multi-track analyzer run. */
export type AnalyzeTracksResult = {
  analyzed: number;
  cacheHits: number;
  concurrency: number;
  elapsedMs: number;
  requested: number;
  results: Array<RekordboxAnalysisResult>;
  threadBudget: number;
  throughputTracksPerSecond: number;
  timings: {
    analyzeMs: number;
    preflightMs: number;
    totalMs: number;
  };
  workerThreadBudgets: Array<number>;
};

/** Stable failure classification for one item in a batch analyzer run. */
export type AnalyzeTrackFailure = {
  audioPath: string;
  error: Error;
  index: number;
  kind: "timeout" | "native-incompatible" | "invalid-output" | "process" | "unknown";
};

/** Successful/cache-hit work retained when another batch item fails. */
export type AnalyzeTracksPartialResult = Omit<AnalyzeTracksResult, "results"> & {
  cancelled: number;
  failed: number;
  results: Array<RekordboxAnalysisResult | undefined>;
};

/** Batch error carrying indexed failures and every durable partial result. */
export class AnalyzeTracksError extends AggregateError {
  readonly failures: AnalyzeTrackFailure[];
  readonly partialResult: AnalyzeTracksPartialResult;

  constructor(failures: AnalyzeTrackFailure[], partialResult: AnalyzeTracksPartialResult) {
    super(
      failures.map((failure) => failure.error),
      `Rekordbox analysis failed for ${String(failures.length)} track(s)`,
    );
    this.name = "AnalyzeTracksError";
    this.failures = failures;
    this.partialResult = partialResult;
  }
}

/** Abort-compatible batch error carrying every durable result completed before cancellation. */
export class AnalyzeTracksCancelledError extends Error {
  readonly failures: AnalyzeTrackFailure[];
  readonly partialResult: AnalyzeTracksPartialResult;

  constructor(
    reason: Error,
    partialResult: AnalyzeTracksPartialResult,
    failures: AnalyzeTrackFailure[] = [],
  ) {
    super(
      `Rekordbox analysis cancelled with ${String(partialResult.cancelled)} track(s) unfinished`,
      { cause: reason },
    );
    this.name = "AbortError";
    this.failures = failures;
    this.partialResult = partialResult;
  }
}

type PreparedAnalysis = {
  args: Array<string>;
  cached?: RekordboxAnalysisResult;
  command: string;
  engine: AnalyzerEngine;
  env: NodeJS.ProcessEnv;
  inputPath: string;
  outputDirectory: string;
  source: RekordboxAnalysisResult["source"];
  summaryPath: string;
};

/** Resolve an explicit, PATH-installed, user-local, or repository-built analyzer helper. */
export function getAnalyzerBinary(explicit?: string, engine: AnalyzerEngine = "clean"): string {
  const helperName = engine === "clean" ? cleanHelperName : referenceHelperName;
  const path =
    explicit ??
    (engine === "clean"
      ? process.env.REKORDBOX_CLEAN_ANALYZER_BINARY
      : (process.env.REKORDBOX_REFERENCE_ANALYZER_BINARY ?? process.env.REKORDBOX_ANALYZER_BINARY));
  if (path) return resolve(path);
  const pathCandidates = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, helperName));
  const installedCandidates = [
    ...pathCandidates,
    join(homedir(), ".local/bin", helperName),
    `/opt/homebrew/bin/${helperName}`,
    `/usr/local/bin/${helperName}`,
  ];
  const candidates =
    engine === "clean"
      ? [
          fileURLToPath(new URL(`../../.rekordbox-analyzer/${cleanHelperName}`, import.meta.url)),
          fileURLToPath(
            new URL(
              `../../../../native/rekordbox-analyzer-core/target/release/${cleanHelperName}`,
              import.meta.url,
            ),
          ),
          ...installedCandidates,
        ]
      : [
          ...installedCandidates,
          fileURLToPath(new URL(`../../vendor/${cleanHelperName}`, import.meta.url)),
        ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/** Inspect the selected clean-room analyzer or local reference oracle. */
export function diagnoseAnalyzer(
  options: Pick<
    AnalyzeTrackOptions,
    "analyzerBinary" | "engine" | "rekordboxApp" | "rekordboxCache"
  > = {},
): unknown {
  const engine = options.engine ?? "clean";
  if (engine === "reference" && process.platform !== "darwin") {
    throw new TypeError("The Rekordbox reference analyzer requires macOS");
  }
  const analyzerBinary = getAnalyzerBinary(options.analyzerBinary, engine);
  if (!existsSync(analyzerBinary))
    throw new TypeError(`${engine} analyzer helper '${analyzerBinary}' does not exist`);
  const env = analyzerEnvironment(engine, analyzerBinary, options);
  return runAnalyzerDoctor(engine, analyzerBinary, env);
}

/** Compare two Rekordbox PQTZ/PQT2 grids with bounded monotonic alignment. */
export function compareBeatGrids(
  referenceDirectory: string,
  candidateDirectory: string,
  options: CompareBeatGridsOptions = {},
): BeatGridDifferential {
  const reference = analysisDirectory(referenceDirectory, "Reference");
  const candidate = analysisDirectory(candidateDirectory, "Candidate");
  const analyzerBinary = getAnalyzerBinary(options.analyzerBinary, "clean");
  if (!existsSync(analyzerBinary)) {
    throw new TypeError(
      `clean analyzer helper '${analyzerBinary}' does not exist; set REKORDBOX_CLEAN_ANALYZER_BINARY or build it with pnpm --filter @gakonst/rekordbox build:analyzer`,
    );
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("Beat-grid comparison timeout must be a positive integer");
  }
  const env = analyzerEnvironment("clean", analyzerBinary, {});
  verifyAnalyzerEngine("clean", analyzerBinary, env);
  const { args, command } = analyzerInvocation("clean", analyzerBinary, [
    "beat-grid-diff",
    reference,
    candidate,
  ]);
  const child = spawnSync(command, args, {
    encoding: "utf8",
    env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: timeoutMs,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(
      `beat-grid comparison exited with ${child.status ?? "no status"}: ${child.stderr.trim()}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(child.stdout) as unknown;
  } catch (cause) {
    throw new TypeError("Beat-grid comparison returned malformed JSON", { cause });
  }
  const parsed = beatGridDifferentialSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`Invalid beat-grid comparison: ${z.prettifyError(parsed.error)}`);
  }
  if (
    resolve(parsed.data.referenceDirectory) !== reference ||
    resolve(parsed.data.candidateDirectory) !== candidate
  ) {
    throw new TypeError("Beat-grid comparison returned mismatched analysis directories");
  }
  return parsed.data;
}

/** Compare decoded waveform values rather than opaque ANLZ bytes. */
export function compareWaveforms(
  referenceDirectory: string,
  candidateDirectory: string,
  options: CompareWaveformsOptions = {},
): WaveformDifferential {
  const reference = analysisDirectory(referenceDirectory, "Reference");
  const candidate = analysisDirectory(candidateDirectory, "Candidate");
  const analyzerBinary = getAnalyzerBinary(options.analyzerBinary, "clean");
  if (!existsSync(analyzerBinary)) {
    throw new TypeError(
      `clean analyzer helper '${analyzerBinary}' does not exist; set REKORDBOX_CLEAN_ANALYZER_BINARY or build it with pnpm --filter @gakonst/rekordbox build:analyzer`,
    );
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError("Waveform comparison timeout must be a positive integer");
  }
  const env = analyzerEnvironment("clean", analyzerBinary, {});
  verifyAnalyzerEngine("clean", analyzerBinary, env);
  const { args, command } = analyzerInvocation("clean", analyzerBinary, [
    "waveform-diff",
    reference,
    candidate,
  ]);
  const child = spawnSync(command, args, {
    encoding: "utf8",
    env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: timeoutMs,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(
      `waveform comparison exited with ${child.status ?? "no status"}: ${child.stderr.trim()}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(child.stdout) as unknown;
  } catch (cause) {
    throw new TypeError("Waveform comparison returned malformed JSON", { cause });
  }
  const parsed = waveformDifferentialSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`Invalid waveform comparison: ${z.prettifyError(parsed.error)}`);
  }
  if (
    resolve(parsed.data.referenceDirectory) !== reference ||
    resolve(parsed.data.candidateDirectory) !== candidate
  ) {
    throw new TypeError("Waveform comparison returned mismatched analysis directories");
  }
  return parsed.data;
}

/** Produce structurally compatible DAT, EXT, and 2EX analysis artifacts. */
export function analyzeTrack(
  audioPath: string,
  options: AnalyzeTrackOptions = {},
): RekordboxAnalysisResult {
  throwIfAborted(options.signal);
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
  throwIfAborted(options.signal);
  const prepared = prepareAnalysis(audioPath, options);
  if (prepared.cached) return prepared.cached;
  const stdout = await runAnalyzerWithCompatibilityFallback(
    prepared,
    options.timeoutMs ?? 300_000,
    options.signal,
  );
  return persistAnalysisResult(stdout, prepared);
}

/** Analyze tracks concurrently in isolated native worker processes, preserving input order. */
export async function analyzeTracks(
  audioPaths: ReadonlyArray<string>,
  options: AnalyzeTracksOptions = {},
): Promise<AnalyzeTracksResult> {
  const configuredConcurrency = options.concurrency ?? DEFAULT_ANALYZER_CONCURRENCY;
  if (
    !Number.isInteger(configuredConcurrency) ||
    configuredConcurrency < 1 ||
    configuredConcurrency > 64
  )
    throw new TypeError("Analyzer concurrency must be an integer between 1 and 64");
  const requested = audioPaths.length;
  const threadBudget = validateAnalyzerThreads(
    options.threads ??
      Math.min(
        DEFAULT_ANALYZER_THREAD_BUDGET,
        Math.max(1, requested) * DEFAULT_ANALYZER_TRACK_THREADS,
      ),
    "Analyzer thread budget",
  );

  const absolutePaths = audioPaths.map((audioPath) => resolve(audioPath));
  if (options.signal?.aborted) {
    throw new AnalyzeTracksCancelledError(abortError(options.signal), {
      analyzed: 0,
      cacheHits: 0,
      cancelled: requested,
      concurrency: Math.min(configuredConcurrency, threadBudget, requested),
      elapsedMs: 0,
      failed: 0,
      requested,
      results: Array.from({ length: requested }),
      threadBudget,
      throughputTracksPerSecond: 0,
      timings: { analyzeMs: 0, preflightMs: 0, totalMs: 0 },
      workerThreadBudgets: [],
    });
  }
  const outputDirectories = absolutePaths.map(defaultOutputDirectory);
  const destinations = new Set<string>();
  for (const outputDirectory of outputDirectories) {
    if (destinations.has(outputDirectory))
      throw new TypeError(`Multiple tracks resolve to analyzer output '${outputDirectory}'`);
    destinations.add(outputDirectory);
  }

  const started = performance.now();
  const preflightStarted = performance.now();
  const verifiedHelpers = new Set<string>();
  const prepared = absolutePaths.map((audioPath) =>
    prepareAnalysis(audioPath, { ...options, threads: undefined }, verifiedHelpers),
  );
  const preflightMs = roundMilliseconds(performance.now() - preflightStarted);
  const concurrency = Math.min(configuredConcurrency, threadBudget, absolutePaths.length);
  const results = Array.from<RekordboxAnalysisResult>({ length: absolutePaths.length });
  const failures = Array.from<AnalyzeTrackFailure | undefined>({ length: absolutePaths.length });
  const pending: number[] = [];
  let completed = 0;
  for (const [index, analysis] of prepared.entries()) {
    if (analysis.cached) {
      results[index] = analysis.cached;
      completed += 1;
      emitAnalyzeProgress(options.onProgress, {
        audioPath: absolutePaths[index]!,
        completed,
        index,
        phase: "cached",
        total: absolutePaths.length,
      });
    } else pending.push(index);
  }
  const analyzeStarted = performance.now();
  const activeWorkers = Math.min(concurrency, pending.length);
  const workerThreadBudgets = distributeThreadBudget(threadBudget, activeWorkers);
  let nextIndex = 0;
  const worker = async (nativeThreads: number) => {
    while (true) {
      if (options.signal?.aborted) return;
      const index = pending[nextIndex++];
      if (index === undefined) return;
      const audioPath = absolutePaths[index]!;
      emitAnalyzeProgress(options.onProgress, {
        audioPath,
        completed,
        index,
        phase: "started",
        total: absolutePaths.length,
      });
      try {
        const analysis = withAnalyzerThreads(prepared[index]!, nativeThreads);
        const stdout = await runAnalyzerWithCompatibilityFallback(
          analysis,
          options.timeoutMs ?? 300_000,
          options.signal,
        );
        results[index] = persistAnalysisResult(stdout, analysis);
        completed += 1;
        emitAnalyzeProgress(options.onProgress, {
          audioPath,
          completed,
          index,
          phase: "completed",
          total: absolutePaths.length,
        });
      } catch (cause) {
        if (options.signal?.aborted) {
          emitAnalyzeProgress(options.onProgress, {
            audioPath,
            completed,
            index,
            phase: "cancelled",
            total: absolutePaths.length,
          });
          return;
        }
        const message = cause instanceof Error ? cause.message : String(cause);
        const error = new Error(`Failed to analyze '${audioPath}': ${message}`, { cause });
        failures[index] = {
          audioPath,
          error,
          index,
          kind: classifyAnalyzerFailure(cause),
        };
        completed += 1;
        emitAnalyzeProgress(options.onProgress, {
          audioPath,
          completed,
          index,
          phase: "failed",
          total: absolutePaths.length,
        });
      }
    }
  };
  await Promise.all(workerThreadBudgets.map(worker));
  const analyzeMs = roundMilliseconds(performance.now() - analyzeStarted);
  const totalMs = roundMilliseconds(performance.now() - started);
  const itemFailures = failures.filter(
    (failure): failure is AnalyzeTrackFailure => failure !== undefined,
  );
  const cacheHits = absolutePaths.length - pending.length;
  const durableResults = results.filter(
    (result): result is RekordboxAnalysisResult => result !== undefined,
  ).length;
  const analyzed = Math.max(0, durableResults - cacheHits);
  const cancelled = Math.max(0, absolutePaths.length - durableResults - itemFailures.length);
  const partialResult: AnalyzeTracksPartialResult = {
    analyzed,
    cacheHits,
    cancelled,
    concurrency,
    elapsedMs: Math.round(totalMs),
    failed: itemFailures.length,
    requested: absolutePaths.length,
    results,
    threadBudget,
    throughputTracksPerSecond:
      analyzed && analyzeMs ? roundMilliseconds((analyzed * 1_000) / analyzeMs) : 0,
    timings: { analyzeMs, preflightMs, totalMs },
    workerThreadBudgets,
  };
  if (options.signal?.aborted) {
    throw new AnalyzeTracksCancelledError(abortError(options.signal), partialResult, itemFailures);
  }
  if (itemFailures.length) {
    throw new AnalyzeTracksError(itemFailures, partialResult);
  }
  return {
    analyzed: pending.length,
    cacheHits,
    concurrency,
    elapsedMs: Math.round(totalMs),
    requested: absolutePaths.length,
    results,
    threadBudget,
    throughputTracksPerSecond:
      pending.length && analyzeMs ? roundMilliseconds((pending.length * 1_000) / analyzeMs) : 0,
    timings: { analyzeMs, preflightMs, totalMs },
    workerThreadBudgets,
  };
}

function distributeThreadBudget(threadBudget: number, workers: number): Array<number> {
  if (workers === 0) return [];
  const base = Math.floor(threadBudget / workers);
  const remainder = threadBudget % workers;
  return Array.from({ length: workers }, (_, index) => base + Number(index < remainder));
}

function withAnalyzerThreads(prepared: PreparedAnalysis, threads: number): PreparedAnalysis {
  if (prepared.engine !== "clean") return prepared;
  return {
    ...prepared,
    env: {
      ...prepared.env,
      [analyzerThreadsEnvironment]: String(threads),
    },
  };
}

function validateAnalyzerThreads(value: number, label = "Analyzer threads"): number {
  if (!Number.isInteger(value) || value < 1 || value > maximumAnalyzerThreads) {
    throw new TypeError(
      `${label} must be an integer between 1 and ${String(maximumAnalyzerThreads)}`,
    );
  }
  return value;
}

function emitAnalyzeProgress(
  observer: AnalyzeTracksOptions["onProgress"],
  progress: AnalyzeTracksProgress,
): void {
  try {
    observer?.(progress);
  } catch {
    // Progress is observational; callback failures must not orphan analyzer workers.
  }
}

function classifyAnalyzerFailure(cause: unknown): AnalyzeTrackFailure["kind"] {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/timed out/iu.test(message)) return "timeout";
  if (/startAnalyze failed with status -1/iu.test(message)) return "native-incompatible";
  if (/did not produce|invalid Rekordbox|schema|malformed JSON/iu.test(message)) {
    return "invalid-output";
  }
  if (/exited with|spawn|output exceeded|abort trap/iu.test(message)) return "process";
  return "unknown";
}

function prepareAnalysis(
  audioPath: string,
  options: AnalyzeTrackOptions,
  verifiedHelpers?: Set<string>,
): PreparedAnalysis {
  const absoluteAudioPath = resolve(audioPath);
  if (!existsSync(absoluteAudioPath))
    throw new TypeError(`Audio file '${absoluteAudioPath}' does not exist`);
  const engine = options.engine ?? "clean";
  if (engine === "reference" && process.platform !== "darwin") {
    throw new TypeError("The Rekordbox reference analyzer requires macOS");
  }
  if (engine === "reference" && options.rhythmMode === "auto") {
    throw new TypeError(
      "The Rekordbox reference analyzer requires an explicit Normal or Dynamic rhythm mode",
    );
  }
  const analyzerBinary = getAnalyzerBinary(options.analyzerBinary, engine);
  if (!existsSync(analyzerBinary))
    throw new TypeError(
      `${engine} analyzer helper '${analyzerBinary}' does not exist; set ${
        engine === "clean"
          ? "REKORDBOX_CLEAN_ANALYZER_BINARY"
          : "REKORDBOX_REFERENCE_ANALYZER_BINARY"
      }${
        engine === "clean"
          ? " or build it with pnpm --filter @gakonst/rekordbox build:analyzer"
          : "; the local reference oracle is not included in releases"
      }`,
    );
  if (options.threads !== undefined) validateAnalyzerThreads(options.threads);
  const env = analyzerEnvironment(engine, analyzerBinary, options);
  verifyAnalyzerEngine(engine, analyzerBinary, env, verifiedHelpers);
  const source = sourceFingerprint(absoluteAudioPath);
  const outputDirectory = resolve(
    options.outputDirectory ?? defaultOutputDirectory(absoluteAudioPath),
  );
  const summaryPath = join(outputDirectory, "analysis.json");
  const nativeLogPath = join(
    outputDirectory,
    engine === "clean" ? "clean-room-analyzer.log" : "rehost-native.log",
  );
  const outputPaths = [
    join(outputDirectory, "ANLZ0000.DAT"),
    join(outputDirectory, "ANLZ0000.EXT"),
    join(outputDirectory, "ANLZ0000.2EX"),
    nativeLogPath,
    summaryPath,
  ];
  assertDistinctAnalyzerTargets(source.path, outputPaths);
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
        cached.source.mtimeMs === source.mtimeMs &&
        cachedResultMatchesEngine(cached, engine, options.rhythmMode ?? "normal")
      ) {
        validateAnalysisFiles(outputDirectory, source.path);
        return {
          args: [],
          cached,
          command: analyzerBinary,
          engine,
          env: process.env,
          inputPath: absoluteAudioPath,
          outputDirectory,
          source,
          summaryPath,
        };
      }
    } catch {
      // Invalid or stale cached artifacts are replaced by a new analysis.
    }
  }
  // Remove only the bounded analyzer artifacts before a real run. This keeps a
  // helper that omitted one output from accidentally validating a stale file.
  for (const path of outputPaths) rmSync(path, { force: true });

  const { args, command } = analyzerInvocation(engine, analyzerBinary, [
    "analyze",
    absoluteAudioPath,
    outputDirectory,
    nativeLogPath,
  ]);
  return {
    args,
    command,
    engine,
    env,
    inputPath: absoluteAudioPath,
    outputDirectory,
    source,
    summaryPath,
  };
}

function assertDistinctAnalyzerTargets(sourcePath: string, targets: Array<string>): void {
  const sourceIdentity = realpathSync(sourcePath);
  const seen = new Map<string, string>();
  for (const target of targets) {
    const identity = existsSync(target) ? realpathSync(target) : resolve(target);
    if (identity === sourceIdentity) {
      throw new TypeError(`Analyzer output '${target}' collides with input audio '${sourcePath}'`);
    }
    const previous = seen.get(identity);
    if (previous) {
      throw new TypeError(`Analyzer output '${target}' collides with '${previous}'`);
    }
    seen.set(identity, target);
  }
}

function cachedResultMatchesEngine(
  result: RekordboxAnalysisResult,
  engine: AnalyzerEngine,
  rhythmMode: AnalyzerRhythmMode,
): boolean {
  if (!analysisBackendMatchesEngine(result, engine)) return false;
  const cachedMode =
    result.rhythmModeRequested ??
    result.rhythmMode ??
    (engine === "reference" ? "dynamic" : "normal");
  return cachedMode === rhythmMode;
}

function analysisBackendMatchesEngine(
  result: RekordboxAnalysisResult,
  engine: AnalyzerEngine,
): boolean {
  return engine === "clean"
    ? result.backend.startsWith("clean-room-")
    : result.backend === "rekordbox-dlopen-rehost";
}

function analyzerEnvironment(
  engine: AnalyzerEngine,
  analyzerBinary: string,
  options: Pick<AnalyzeTrackOptions, "rekordboxApp" | "rekordboxCache" | "rhythmMode" | "threads">,
): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.REKORDBOX_ANALYZER_ENGINE = engine;
  env.REKORDBOX_ANALYZER_ROOT ??= dirname(dirname(analyzerBinary));
  env[analyzerRhythmModeEnvironment] = options.rhythmMode ?? "normal";
  if (engine === "clean") {
    env[analyzerThreadsEnvironment] = String(options.threads ?? DEFAULT_ANALYZER_TRACK_THREADS);
  }
  if (options.rekordboxApp) env.REKORDBOX_ANALYZER_APP = resolve(options.rekordboxApp);
  if (options.rekordboxCache) env.REKORDBOX_ANALYZER_CACHE = resolve(options.rekordboxCache);
  return env;
}

function analyzerInvocation(
  engine: AnalyzerEngine,
  analyzerBinary: string,
  args: Array<string>,
): { args: Array<string>; command: string } {
  if (engine === "reference" && process.arch === "arm64") {
    return { args: ["-x86_64", analyzerBinary, ...args], command: "/usr/bin/arch" };
  }
  return { args, command: analyzerBinary };
}

function runAnalyzerDoctor(
  engine: AnalyzerEngine,
  analyzerBinary: string,
  env: NodeJS.ProcessEnv,
): unknown {
  const { args, command } = analyzerInvocation(engine, analyzerBinary, ["doctor"]);
  const child = spawnSync(command, args, { encoding: "utf8", env, maxBuffer: 4 * 1024 * 1024 });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(
      `${engine} analyzer doctor exited with ${child.status ?? "no status"}: ${child.stderr.trim()}`,
    );
  }
  let report: unknown;
  try {
    report = JSON.parse(child.stdout) as unknown;
  } catch (cause) {
    throw new TypeError(`${engine} analyzer doctor returned malformed JSON`, { cause });
  }
  if (engine === "clean") {
    const record =
      report && typeof report === "object" ? (report as Record<string, unknown>) : undefined;
    if (
      record?.cleanRoom !== true ||
      record.proprietaryDependencies !== false ||
      typeof record.backend !== "string" ||
      !record.backend.startsWith("clean-room-")
    ) {
      throw new TypeError(
        `clean analyzer identity check failed for '${analyzerBinary}'; refusing a legacy or proprietary helper`,
      );
    }
  }
  return report;
}

function verifyAnalyzerEngine(
  engine: AnalyzerEngine,
  analyzerBinary: string,
  env: NodeJS.ProcessEnv,
  verifiedHelpers?: Set<string>,
): void {
  if (engine !== "clean") return;
  const metadata = statSync(analyzerBinary);
  const identity = `${realpathSync(analyzerBinary)}\u0000${String(metadata.size)}\u0000${String(metadata.mtimeMs)}`;
  if (verifiedHelpers?.has(identity)) return;
  runAnalyzerDoctor(engine, analyzerBinary, env);
  verifiedHelpers?.add(identity);
}

function analysisDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute))
    throw new TypeError(`${label} analysis directory '${absolute}' does not exist`);
  const metadata = statSync(absolute);
  if (!metadata.isDirectory()) {
    throw new TypeError(`${label} analysis path '${absolute}' is not a directory`);
  }
  return realpathSync(absolute);
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

function runAnalyzer(
  prepared: PreparedAnalysis,
  timeoutMs: number,
  optionsSignal?: AbortSignal,
): Promise<string> {
  throwIfAborted(optionsSignal);
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(prepared.command, prepared.args, {
      env: prepared.env,
      ...(optionsSignal ? { signal: optionsSignal } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const maxBuffer = 4 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let captureError: Error | undefined;
    let spawnError: Error | undefined;
    let aborted = false;
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
    const abort = () => {
      aborted = true;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1_000);
    };
    optionsSignal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1_000);
    }, timeoutMs);
    child.once("close", (status, exitSignal) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      optionsSignal?.removeEventListener("abort", abort);
      if (aborted) return rejectPromise(abortError(optionsSignal));
      if (spawnError) return rejectPromise(spawnError);
      if (captureError) return rejectPromise(captureError);
      if (timedOut)
        return rejectPromise(new Error(`Rekordbox analyzer timed out after ${timeoutMs}ms`));
      if (status !== 0)
        return rejectPromise(
          new Error(
            `Rekordbox analyzer exited with ${status ?? `signal ${exitSignal ?? "unknown"}`}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
      resolvePromise(stdout);
    });
  });
}

async function runAnalyzerWithCompatibilityFallback(
  prepared: PreparedAnalysis,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await runAnalyzer(prepared, timeoutMs, signal);
  } catch (cause) {
    if (
      prepared.engine !== "reference" ||
      !requiresAsciiInputFallback(cause, prepared.source.path)
    ) {
      throw cause;
    }
  }

  throwIfAborted(signal);
  const stagingDirectory = mkdtempSync(join(tmpdir(), "rekordbox-analyzer-"));
  const extension = extname(prepared.source.path).toLowerCase() || ".audio";
  const stagedAudioPath = join(stagingDirectory, `track${extension}`);
  const stagedOutputDirectory = join(stagingDirectory, "output");
  const installDirectory = mkdtempSync(
    join(dirname(prepared.outputDirectory), ".rekordbox-install-"),
  );
  try {
    copyFileSync(prepared.source.path, stagedAudioPath);
    mkdirSync(stagedOutputDirectory, { recursive: true });
    const staged: PreparedAnalysis = {
      ...prepared,
      args: prepared.args.map((argument) => {
        if (argument === prepared.inputPath) return stagedAudioPath;
        if (argument === prepared.outputDirectory) return stagedOutputDirectory;
        if (argument.startsWith(`${prepared.outputDirectory}/`)) {
          return `${stagedOutputDirectory}${argument.slice(prepared.outputDirectory.length)}`;
        }
        return argument;
      }),
      inputPath: stagedAudioPath,
      outputDirectory: stagedOutputDirectory,
      summaryPath: join(stagedOutputDirectory, "analysis.json"),
    };
    const stdout = await runAnalyzer(staged, timeoutMs, signal);
    cpSync(stagedOutputDirectory, installDirectory, { recursive: true });
    rewriteAnalysisTrackPaths(installDirectory, prepared.source.path);
    validateAnalysisFiles(installDirectory, prepared.source.path);
    const rewritten = rewriteStagedAnalyzerPaths(
      stdout,
      stagedAudioPath,
      stagedOutputDirectory,
      installDirectory,
      prepared,
    );
    validateNativeAnalyzerOutput(rewritten, prepared);
    replaceDirectoryAtomically(installDirectory, prepared.outputDirectory);
    return rewritten;
  } finally {
    rmSync(stagingDirectory, { force: true, recursive: true });
    rmSync(installDirectory, { force: true, recursive: true });
  }
}

function rewriteAnalysisTrackPaths(outputDirectory: string, audioPath: string): void {
  const nativePath = analyzerTrackPath(audioPath);
  for (const path of Object.values(getAnlzPaths(outputDirectory))) {
    if (!path) continue;
    const file = AnlzFile.parseFile(path);
    if (!file.has("PPTH")) continue;
    file.setPath(nativePath);
    file.save();
  }
}

function analyzerTrackPath(audioPath: string): string {
  return `?/${basename(audioPath)}`;
}

function validateNativeAnalyzerOutput(stdout: string, prepared: PreparedAnalysis): void {
  const native = JSON.parse(stdout) as Omit<RekordboxAnalysisResult, "source" | "summaryPath">;
  native.audioPath = prepared.source.path;
  const result = parseAnalysisResult(
    { ...native, source: prepared.source, summaryPath: prepared.summaryPath },
    "staged native analyzer output",
  );
  assertAnalysisEngine(result, prepared.engine);
}

function replaceDirectoryAtomically(source: string, destination: string): void {
  const previous = `${source}-previous`;
  let movedPrevious = false;
  if (existsSync(destination)) {
    renameSync(destination, previous);
    movedPrevious = true;
  }
  try {
    renameSync(source, destination);
  } catch (cause) {
    if (movedPrevious && !existsSync(destination)) renameSync(previous, destination);
    throw cause;
  }
  if (movedPrevious) rmSync(previous, { force: true, recursive: true });
}

function rewriteStagedAnalyzerPaths(
  stdout: string,
  stagedAudioPath: string,
  stagedOutputDirectory: string,
  installDirectory: string,
  prepared: PreparedAnalysis,
): string {
  const replacePaths = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (value === stagedAudioPath) return prepared.source.path;
      if (value.startsWith(`${stagedOutputDirectory}/`)) {
        return `${prepared.outputDirectory}${value.slice(stagedOutputDirectory.length)}`;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(replacePaths);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        replacePaths(item),
      ]),
    );
  };
  const updateInstalledSizes = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const items = value.map(updateInstalledSizes);
      if (items.length === 2 && typeof items[0] === "string" && typeof items[1] === "number") {
        const path = stagedInstallPath(items[0], installDirectory, prepared.outputDirectory);
        if (path) items[1] = statSync(path).size;
      }
      return items;
    }
    if (!value || typeof value !== "object") return value;
    const record = Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        updateInstalledSizes(item),
      ]),
    );
    if (typeof record.path === "string" && typeof record.size === "number") {
      const path = stagedInstallPath(record.path, installDirectory, prepared.outputDirectory);
      if (path) record.size = statSync(path).size;
    }
    return record;
  };
  return JSON.stringify(updateInstalledSizes(replacePaths(JSON.parse(stdout) as unknown)));
}

function stagedInstallPath(
  canonicalPath: string,
  installDirectory: string,
  outputDirectory: string,
): string | undefined {
  if (!canonicalPath.startsWith(`${outputDirectory}/`)) return undefined;
  return `${installDirectory}${canonicalPath.slice(outputDirectory.length)}`;
}

function requiresAsciiInputFallback(cause: unknown, sourcePath: string): boolean {
  if (![...sourcePath].some((character) => (character.codePointAt(0) ?? 0) > 0x7f)) return false;
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.includes("Rekordbox startAnalyze failed with status -1");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw abortError(signal);
}

function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("Rekordbox analysis aborted", "AbortError");
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
  native.audioPath = prepared.source.path;
  validateAnalysisFiles(prepared.outputDirectory, prepared.source.path);
  const result = parseAnalysisResult(
    { ...native, source: prepared.source, summaryPath: prepared.summaryPath },
    "analyzer output",
  );
  assertAnalysisEngine(result, prepared.engine);
  const temporary = `${prepared.summaryPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`);
  renameSync(temporary, prepared.summaryPath);
  return result;
}

function assertAnalysisEngine(result: RekordboxAnalysisResult, engine: AnalyzerEngine): void {
  if (!analysisBackendMatchesEngine(result, engine)) {
    throw new TypeError(`${engine} analyzer returned incompatible backend '${result.backend}'`);
  }
}

function validateAnalysisFiles(outputDirectory: string, audioPath?: string): void {
  const paths = getAnlzPaths(outputDirectory);
  for (const type of ["DAT", "EXT", "2EX"] as const) {
    const path = paths[type];
    if (!path) throw new Error(`Rekordbox analyzer did not produce ANLZ0000.${type}`);
    const file = AnlzFile.parseFile(path);
    if (audioPath && file.has("PPTH") && file.get("PPTH") !== analyzerTrackPath(audioPath)) {
      throw new Error(
        `Rekordbox analyzer PPTH path does not match '${basename(audioPath)}' in ANLZ0000.${type}`,
      );
    }
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
