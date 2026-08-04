import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const repositoryPythonProjectDirectory = fileURLToPath(
  new URL("../../../../python/stems-mlx/", import.meta.url),
);
const defaultPythonEnvironmentDirectory = join(
  homedir(),
  "Library",
  "Caches",
  "rekordbox-ts",
  "stems",
  "python-3.12",
);
const stemNameSchema = z.enum(["instrumental", "vocals", "drums", "bass", "other"]);

const stemArtifactSchema = z.object({
  channels: z.number().int().positive(),
  frames: z.number().int().nonnegative(),
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  stem: z.string(),
});

const stemsSeparationResultSchema = z.object({
  audioPath: z.string(),
  backend: z.literal("mlx"),
  device: z.string(),
  durationSeconds: z.number().nonnegative(),
  layout: z.enum(["rekordbox", "four-stem"]),
  model: z.string(),
  modelRevision: z.string(),
  outputDirectory: z.string(),
  outputs: z.array(stemArtifactSchema),
  processingSeconds: z.number().nonnegative(),
  reconstruction: z.object({ peakError: z.number(), rmsError: z.number() }),
  sampleRate: z.number().int().positive(),
  selectedStems: z.array(stemNameSchema),
});

const stemsBatchResultSchema = z.object({
  backend: z.literal("mlx"),
  layout: z.enum(["rekordbox", "four-stem"]),
  model: z.string(),
  modelLoadSeconds: z.number().nonnegative(),
  modelRevision: z.string(),
  processingSeconds: z.number().nonnegative(),
  results: z.array(stemsSeparationResultSchema),
  selectedStems: z.array(stemNameSchema),
  trackCount: z.number().int().nonnegative(),
});

const stemsDoctorResultSchema = z.object({
  architecture: z.string(),
  backend: z.literal("mlx"),
  cacheDirectory: z.string(),
  checkpointReady: z.boolean(),
  configReady: z.boolean(),
  convertedReady: z.boolean(),
  device: z.string(),
  macOS: z.string(),
  mlxAudioSeparatorVersion: z.string(),
  mlxVersion: z.string(),
  model: z.string(),
  modelRevision: z.string(),
  python: z.string(),
  pythonEnvironment: z.string(),
});

const optionalArtifactSchema = z
  .object({ path: z.string(), size: z.number().int().nonnegative() })
  .nullable();
const stemsSetupResultSchema = z.object({
  backend: z.literal("mlx"),
  cacheDirectory: z.string(),
  checkpoint: optionalArtifactSchema,
  config: optionalArtifactSchema,
  converted: z.boolean(),
  convertedThisRun: z.boolean(),
  model: z.string(),
  modelLicense: z.string(),
  revision: z.string(),
  safetensors: optionalArtifactSchema,
});

/** Output layout from the clean MLX separator. */
export type StemsLayout = "rekordbox" | "four-stem";

/** One source that can be selected from a compatible output layout. */
export type StemName = z.infer<typeof stemNameSchema>;

/** One stem WAV emitted by the MLX separator. */
export type StemArtifact = z.infer<typeof stemArtifactSchema>;

/** Structured result from MLX stem separation. */
export type StemsSeparationResult = z.infer<typeof stemsSeparationResultSchema>;

/** Structured result from a model-reusing batch separation. */
export type StemsBatchResult = z.infer<typeof stemsBatchResultSchema>;

/** One input/output pair in a model-reusing batch separation. */
export type StemsBatchJob = {
  /** Existing local recording. */
  audioPath: string;
  /** Directory receiving this recording's selected stem WAVs. */
  outputDirectory: string;
};

/** MLX runtime and local model readiness. */
export type StemsDoctorResult = z.infer<typeof stemsDoctorResultSchema>;

/** Pinned model download and conversion status. */
export type StemsSetupResult = z.infer<typeof stemsSetupResultSchema>;

/** Shared process options for the optional Python/MLX runtime. */
export type StemsRuntimeOptions = {
  /** Persistent model cache override. */
  cacheDirectory?: string;
  /** Receives bounded setup and inference logs from stderr. */
  onLog?: (message: string) => void;
  /** Standalone `python/stems-mlx` uv project override. */
  pythonProjectDirectory?: string;
  /** `uv` executable override, primarily for controlled environments. */
  uvBinary?: string;
};

/** Options for one MLX separation. */
export type SeparateStemsOptions = StemsRuntimeOptions & {
  /** Replace existing named stem WAV files. */
  force?: boolean;
  /** Three Rekordbox-compatible sources, or the model's native four sources. */
  layout?: StemsLayout;
  /** Write only these compatible stems; inference still predicts all four sources. */
  stems?: Array<StemName>;
};

/** Inspect Apple Silicon, MLX, and converted model readiness. */
export async function diagnoseStems(options: StemsRuntimeOptions = {}): Promise<StemsDoctorResult> {
  return stemsDoctorResultSchema.parse(await runPython(["doctor"], options));
}

/** Download and convert the pinned Apache-2.0 four-stem checkpoint for MLX. */
export async function setupStems(options: StemsRuntimeOptions = {}): Promise<StemsSetupResult> {
  return stemsSetupResultSchema.parse(await runPython(["setup"], options));
}

/** Separate one recording with MLX-native Mel-Band-RoFormer inference. */
export async function separateStems(
  audioPath: string,
  outputDirectory: string,
  options: SeparateStemsOptions = {},
): Promise<StemsSeparationResult> {
  const args = [
    "separate",
    realpathSync(audioPath),
    outputDirectory,
    "--layout",
    options.layout ?? "rekordbox",
  ];
  if (options.force) args.push("--force");
  for (const stem of options.stems ?? []) args.push("--stem", stem);
  return stemsSeparationResultSchema.parse(await runPython(args, options));
}

/** Separate multiple recordings while loading the 3.76 GB model only once. */
export async function separateStemsBatch(
  jobs: Array<StemsBatchJob>,
  options: SeparateStemsOptions = {},
): Promise<StemsBatchResult> {
  if (jobs.length === 0) throw new TypeError("At least one stems batch job is required");
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "rekordbox-stems-batch-"));
  const requestPath = join(temporaryDirectory, "jobs.json");
  writeFileSync(
    requestPath,
    `${JSON.stringify(
      jobs.map((job) => ({
        audioPath: realpathSync(job.audioPath),
        outputDirectory: resolve(job.outputDirectory),
      })),
    )}\n`,
  );
  const args = ["batch", requestPath, "--layout", options.layout ?? "rekordbox"];
  if (options.force) args.push("--force");
  for (const stem of options.stems ?? []) args.push("--stem", stem);
  try {
    return stemsBatchResultSchema.parse(await runPython(args, options));
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

async function runPython(
  commandArgs: Array<string>,
  options: StemsRuntimeOptions,
): Promise<unknown> {
  const helperArgs = options.cacheDirectory
    ? ["--cache-directory", options.cacheDirectory, ...commandArgs]
    : commandArgs;
  const args = [
    "run",
    "--python",
    "3.12",
    "--project",
    resolvePythonProjectDirectory(options.pythonProjectDirectory),
    "--locked",
    "--no-dev",
    "python",
    join(resolvePythonProjectDirectory(options.pythonProjectDirectory), "djbooth_stems_mlx.py"),
    ...helperArgs,
  ];
  const command = options.uvBinary ?? "uv";
  const pythonEnvironmentDirectory = options.cacheDirectory
    ? join(resolve(options.cacheDirectory), "python-3.12")
    : defaultPythonEnvironmentDirectory;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, UV_PROJECT_ENVIRONMENT: pythonEnvironmentDirectory },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-1_000_000);
      options.onLog?.(chunk);
    });
    child.on("error", (error) => {
      reject(
        new Error(
          `Unable to start '${command}': ${error.message}. Install uv from https://docs.astral.sh/uv/`,
        ),
      );
    });
    child.on("close", (code, signal) => {
      if (code !== 0) {
        const reason = signal ? `signal ${signal}` : `exit ${String(code)}`;
        reject(new Error(`MLX stems helper failed (${reason}): ${stderr.trim() || stdout.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(
          new Error(
            `MLX stems helper returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  });
}

function resolvePythonProjectDirectory(explicit?: string): string {
  return resolve(
    explicit ??
      process.env.DJBOOTH_STEMS_MLX_PROJECT ??
      process.env.MUSIC_STEMS_MLX_PROJECT ??
      process.env.REKORDBOX_STEMS_MLX_PROJECT ??
      repositoryPythonProjectDirectory,
  );
}
