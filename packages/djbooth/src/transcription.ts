import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const repositoryPythonProjectDirectory = fileURLToPath(
  new URL("../../../python/muscriptor-mlx/", import.meta.url),
);
const defaultPythonEnvironmentDirectory = join(
  homedir(),
  "Library",
  "Caches",
  "djbooth",
  "muscriptor-mlx",
  "python-3.12",
);
const MAX_HELPER_OUTPUT_BYTES = 10 * 1024 * 1024;

export const muscriptorSetupResultSchema = z.object({
  backend: z.literal("mlx"),
  checkpoint: z.string(),
  model: z.string(),
  size: z.number().int().positive(),
});

export const transcriptionResultSchema = z.object({
  audioSeconds: z.number().nonnegative(),
  backend: z.literal("mlx"),
  chunks: z.number().int().nonnegative(),
  events: z.string(),
  generationSeconds: z.number().nonnegative(),
  instruments: z.array(z.string()).nullable(),
  model: z.string(),
  notes: z.number().int().nonnegative(),
  rawNotes: z.number().int().nonnegative(),
  output: z.string(),
  realtimeFactor: z.number().nonnegative(),
  totalSeconds: z.number().nonnegative(),
});

export type MuscriptorSetupResult = z.infer<typeof muscriptorSetupResultSchema>;
export type TranscriptionResult = z.infer<typeof transcriptionResultSchema>;

export type TranscriptionRuntimeOptions = {
  cacheDirectory?: string | undefined;
  onLog?: ((message: string) => void) | undefined;
  pythonProjectDirectory?: string | undefined;
  signal?: AbortSignal | undefined;
  uvBinary?: string | undefined;
};

export type TranscribeAudioOptions = TranscriptionRuntimeOptions & {
  durationSeconds?: number | undefined;
  eventsPath?: string | undefined;
  instruments?: Array<string> | undefined;
  maxTokens?: number | undefined;
  startSeconds?: number | undefined;
  tempo?: number | undefined;
};

/** Download and convert the pinned MuScriptor-large checkpoint for MLX. */
export async function setupMuscriptor(
  options: TranscriptionRuntimeOptions = {},
): Promise<MuscriptorSetupResult> {
  return muscriptorSetupResultSchema.parse(await runPython(["setup"], options));
}

/** Transcribe a mix or stem into multitrack MIDI and structured note-event JSON. */
export async function transcribeAudioToMidi(
  audioPath: string,
  outputPath: string,
  options: TranscribeAudioOptions = {},
): Promise<TranscriptionResult> {
  const args = [
    "transcribe",
    resolve(audioPath),
    "--output",
    resolve(outputPath),
    "--start",
    String(options.startSeconds ?? 0),
    "--max-tokens",
    String(options.maxTokens ?? 2_000),
    "--tempo",
    String(options.tempo ?? 120),
  ];
  if (options.durationSeconds !== undefined)
    args.push("--duration", String(options.durationSeconds));
  if (options.eventsPath) args.push("--events", resolve(options.eventsPath));
  for (const instrument of options.instruments ?? []) args.push("--instrument", instrument);
  return transcriptionResultSchema.parse(await runPython(args, options));
}

async function runPython(
  commandArgs: Array<string>,
  options: TranscriptionRuntimeOptions,
): Promise<unknown> {
  const projectDirectory = resolvePythonProjectDirectory(options.pythonProjectDirectory);
  const [action, ...actionArgs] = commandArgs;
  if (!action) throw new TypeError("MuScriptor action is required");
  const helperArgs = options.cacheDirectory
    ? [action, "--cache-directory", resolve(options.cacheDirectory), ...actionArgs]
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
    join(projectDirectory, "djbooth_muscriptor_mlx.py"),
    ...helperArgs,
  ];
  const command = options.uvBinary ?? process.env.DJBOOTH_MUSCRIPTOR_UV_BINARY ?? "uv";
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
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(() => reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError")));
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_HELPER_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish(() => reject(new Error("MuScriptor helper output exceeded 10 MiB")));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-1_000_000);
      options.onLog?.(chunk);
    });
    child.once("error", (error) => {
      finish(() =>
        reject(
          new Error(
            `Unable to start '${command}': ${error.message}. Install uv from https://docs.astral.sh/uv/`,
          ),
        ),
      );
    });
    child.once("close", (code, signal) => {
      finish(() => {
        if (code !== 0) {
          const reason = signal ? `signal ${signal}` : `exit ${String(code)}`;
          reject(
            new Error(
              `MuScriptor MLX helper failed (${reason}): ${stderr.trim() || stdout.trim()}`,
            ),
          );
          return;
        }
        try {
          resolveResult(JSON.parse(stdout));
        } catch (error) {
          reject(
            new Error(
              `MuScriptor MLX helper returned invalid JSON: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
        }
      });
    });
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
  });
}

function resolvePythonProjectDirectory(explicit?: string): string {
  return resolve(
    explicit ??
      process.env.DJBOOTH_MUSCRIPTOR_MLX_PROJECT ??
      process.env.MUSIC_MUSCRIPTOR_MLX_PROJECT ??
      repositoryPythonProjectDirectory,
  );
}
