import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const repositoryPythonProjectDirectory = fileURLToPath(
  new URL("../../../../python/a2sb-mlx/", import.meta.url),
);
const defaultPythonEnvironmentDirectory = join(
  homedir(),
  "Library",
  "Caches",
  "rekordbox-ts",
  "enhancement",
  "python-3.12",
);

const checkpointStatusSchema = z.object({
  checkpoint: z.string(),
  convertedPath: z.string(),
  convertedReady: z.boolean(),
  sourcePath: z.string(),
  sourceReady: z.boolean(),
});
const enhancementDoctorResultSchema = z.object({
  architecture: z.string(),
  backend: z.literal("mlx"),
  cacheDirectory: z.string(),
  checkpoints: z.array(checkpointStatusSchema),
  device: z.string(),
  license: z.string(),
  macOS: z.string(),
  mlxVersion: z.string(),
  model: z.string(),
  modelRevision: z.string(),
  python: z.string(),
  pythonEnvironment: z.string(),
});
const convertedWeightSchema = z.object({
  checkpoint: z.string(),
  convertedThisRun: z.boolean(),
  parameterCount: z.number().int().positive(),
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().positive(),
  sourcePath: z.string(),
});
const enhancementSetupResultSchema = z.object({
  backend: z.literal("mlx"),
  cacheDirectory: z.string(),
  license: z.string(),
  model: z.string(),
  profile: z.enum(["one-split", "two-split", "all"]),
  revision: z.string(),
  weights: z.array(convertedWeightSchema),
});
const enhancedArtifactSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().positive(),
});
const enhancementResultSchema = z.object({
  backend: z.literal("mlx"),
  channelMode: z.enum(["mono", "mid-side", "independent"]),
  cutoffHz: z.number().int().positive(),
  cutoffMethod: z.enum(["explicit", "codec-edge", "spectral-rolloff"]),
  detectedCutoffHz: z.number().int().positive(),
  detectedRolloffHz: z.number().int().positive(),
  device: z.string(),
  durationSeconds: z.number().positive(),
  inputPath: z.string(),
  model: z.string(),
  modelRevision: z.string(),
  ode: z.boolean(),
  output: enhancedArtifactSchema,
  processingSeconds: z.number().nonnegative(),
  profile: z.enum(["one-split", "two-split"]),
  sampleRate: z.literal(44_100),
  seed: z.number().int(),
  startSeconds: z.number().nonnegative(),
  steps: z.number().int().min(2),
});

export type EnhancementProfile = "one-split" | "two-split";
export type EnhancementDoctorResult = z.infer<typeof enhancementDoctorResultSchema>;
export type EnhancementSetupResult = z.infer<typeof enhancementSetupResultSchema>;
export type EnhancementResult = z.infer<typeof enhancementResultSchema>;

export type EnhancementRuntimeOptions = {
  cacheDirectory?: string;
  onLog?: (message: string) => void;
  pythonProjectDirectory?: string;
  uvBinary?: string;
};

export type EnhanceAudioOptions = EnhancementRuntimeOptions & {
  batchSize?: number;
  channelMode?: "mid-side" | "independent";
  cutoffHz?: number;
  force?: boolean;
  maxSeconds?: number;
  ode?: boolean;
  overlap?: boolean;
  profile?: EnhancementProfile;
  seed?: number;
  startSeconds?: number;
  steps?: number;
};

export async function diagnoseEnhancement(
  options: EnhancementRuntimeOptions = {},
): Promise<EnhancementDoctorResult> {
  return enhancementDoctorResultSchema.parse(await runPython(["doctor"], options));
}

export async function setupEnhancement(
  options: EnhancementRuntimeOptions & {
    force?: boolean;
    profile?: EnhancementProfile | "all";
  } = {},
): Promise<EnhancementSetupResult> {
  const args = ["setup", "--profile", options.profile ?? "one-split"];
  if (options.force) args.push("--force");
  return enhancementSetupResultSchema.parse(await runPython(args, options));
}

export async function enhanceAudio(
  audioPath: string,
  outputPath: string,
  options: EnhanceAudioOptions = {},
): Promise<EnhancementResult> {
  const args = [
    "enhance",
    resolve(audioPath),
    resolve(outputPath),
    "--profile",
    options.profile ?? "one-split",
    "--steps",
    String(options.steps ?? 50),
    "--channel-mode",
    options.channelMode ?? "mid-side",
    "--seed",
    String(options.seed ?? 0),
    "--batch-size",
    String(options.batchSize ?? 1),
  ];
  if (options.cutoffHz !== undefined) args.push("--cutoff-hz", String(options.cutoffHz));
  if (options.force) args.push("--force");
  if (options.maxSeconds !== undefined) args.push("--max-seconds", String(options.maxSeconds));
  if (options.startSeconds !== undefined)
    args.push("--start-seconds", String(options.startSeconds));
  if (options.ode) args.push("--ode");
  if (options.overlap === false) args.push("--no-overlap");
  return enhancementResultSchema.parse(await runPython(args, options));
}

async function runPython(
  commandArgs: Array<string>,
  options: EnhancementRuntimeOptions,
): Promise<unknown> {
  const projectDirectory = resolvePythonProjectDirectory(options.pythonProjectDirectory);
  const helperArgs = options.cacheDirectory
    ? ["--cache-directory", options.cacheDirectory, ...commandArgs]
    : commandArgs;
  const args = [
    "run",
    "--python",
    "3.12",
    "--project",
    projectDirectory,
    "--locked",
    "--no-dev",
    "python",
    join(projectDirectory, "djbooth_a2sb_mlx.py"),
    ...helperArgs,
  ];
  const command = options.uvBinary ?? "uv";
  const pythonEnvironmentDirectory = options.cacheDirectory
    ? join(resolve(options.cacheDirectory), "python-3.12")
    : defaultPythonEnvironmentDirectory;
  return await new Promise((resolveResult, reject) => {
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
        reject(
          new Error(`MLX enhancement helper failed (${reason}): ${stderr.trim() || stdout.trim()}`),
        );
        return;
      }
      try {
        resolveResult(JSON.parse(stdout));
      } catch (error) {
        reject(
          new Error(
            `MLX enhancement helper returned invalid JSON: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    });
  });
}

function resolvePythonProjectDirectory(explicit?: string): string {
  return resolve(
    explicit ??
      process.env.DJBOOTH_A2SB_MLX_PROJECT ??
      process.env.MUSIC_A2SB_MLX_PROJECT ??
      process.env.REKORDBOX_A2SB_MLX_PROJECT ??
      repositoryPythonProjectDirectory,
  );
}
