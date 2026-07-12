import { spawn } from "node:child_process";

import { TracksError } from "./errors.js";
import type { Environment } from "./types.js";

export interface RunProcessOptions {
  cwd?: string;
  env?: Environment;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}

export interface ProcessResult {
  stdout: string;
  stderr: string;
}

export function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024;
    let outputBytes = 0;

    const collect = (target: Buffer[], chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        child.kill();
        reject(
          new TracksError("TOOL_FAILED", `${command} produced more than ${maxOutputBytes} bytes`, {
            details: { command, args },
          }),
        );
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(
          new TracksError(
            "TOOL_MISSING",
            `${command} was not found; install it or set the corresponding path environment variable`,
            { cause: error, exitCode: 127 },
          ),
        );
        return;
      }
      reject(
        new TracksError("TOOL_FAILED", `Could not start ${command}: ${error.message}`, {
          cause: error,
        }),
      );
    });

    child.on("close", (code, signal) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) {
        resolve(result);
        return;
      }
      const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${String(code)}`;
      reject(
        new TracksError("TOOL_FAILED", `${command} failed: ${detail}`, {
          details: { command, args, code, signal },
        }),
      );
    });
  });
}

export async function mapConcurrent<T, U>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = [];
  let cursor = 0;
  let firstError: unknown;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (cursor < values.length) {
        if (firstError !== undefined) return;
        const index = cursor;
        cursor += 1;
        try {
          results[index] = await fn(values[index]!, index);
        } catch (error) {
          firstError ??= error;
          return;
        }
      }
    },
  );
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
  return results;
}
