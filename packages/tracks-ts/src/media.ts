import { stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import { TracksError } from "./errors.js";
import { runProcess } from "./process.js";
import type { Environment } from "./types.js";

export interface PreparedMedia {
  path: string;
  title?: string;
  sourceUrl?: string;
  durationSeconds: number;
  temporary: boolean;
  cleanup(): Promise<void>;
}

export interface PrepareMediaOptions {
  signal?: AbortSignal;
  env?: Environment;
}

export async function prepareMedia(
  source: string,
  options: PrepareMediaOptions = {},
): Promise<PreparedMedia> {
  const env = options.env ?? process.env;
  const localPath = await existingFile(source);
  if (!localPath) {
    throw new TracksError(
      "INVALID_SOURCE",
      isHttpUrl(source)
        ? "Remote sample recognition is disabled; use metadata/1001 resolution or AudD Enterprise so tracks never downloads the source set"
        : `Source is not a readable local audio file: ${source}`,
      { exitCode: 2 },
    );
  }
  const durationSeconds = await probeDuration(localPath, {
    env,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return {
    path: localPath,
    title: basename(localPath),
    durationSeconds,
    temporary: false,
    async cleanup() {},
  };
}

export async function probeDuration(
  path: string,
  options: { env?: Environment; signal?: AbortSignal } = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const result = await runProcess(
    env.FFPROBE_PATH ?? "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      path,
    ],
    { env, ...(options.signal ? { signal: options.signal } : {}) },
  );
  const duration = Number(result.stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new TracksError("INVALID_SOURCE", `ffprobe returned an invalid duration for ${path}`);
  }
  return duration;
}

export async function extractClip(
  mediaPath: string,
  outputPath: string,
  startSeconds: number,
  durationSeconds: number,
  options: { env?: Environment; signal?: AbortSignal } = {},
): Promise<{ path: string; bytes: number }> {
  const env = options.env ?? process.env;
  await runProcess(
    env.FFMPEG_PATH ?? "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-ss",
      String(startSeconds),
      "-i",
      mediaPath,
      "-t",
      String(durationSeconds),
      "-vn",
      "-ac",
      "1",
      "-ar",
      "44.1k",
      "-b:a",
      "96k",
      "-y",
      outputPath,
    ],
    { env, ...(options.signal ? { signal: options.signal } : {}) },
  );
  const info = await stat(outputPath);
  return { path: outputPath, bytes: info.size };
}

export function sampleOffsets(
  durationSeconds: number,
  intervalSeconds: number,
  clipSeconds: number,
  limit?: number,
  startSeconds = 0,
): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new TracksError("INVALID_SOURCE", "Media duration must be positive");
  }
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    throw new TracksError("INVALID_SOURCE", "Sample interval must be positive");
  }
  if (!Number.isFinite(clipSeconds) || clipSeconds <= 0) {
    throw new TracksError("INVALID_SOURCE", "Sample clip length must be positive");
  }
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    throw new TracksError("INVALID_SOURCE", "Sample limit must be a positive integer");
  }
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds >= durationSeconds) {
    throw new TracksError(
      "INVALID_SOURCE",
      `Start offset ${startSeconds} is outside the ${durationSeconds}-second source`,
      { exitCode: 2 },
    );
  }
  const offsets: number[] = [];
  const finalStart = Math.max(
    startSeconds,
    durationSeconds - Math.min(clipSeconds, durationSeconds),
  );
  for (let offset = startSeconds; offset <= finalStart; offset += intervalSeconds) {
    offsets.push(Math.round(offset * 1000) / 1000);
    if (limit !== undefined && offsets.length >= limit) break;
  }
  const roundedFinalStart = Math.round(finalStart * 1000) / 1000;
  if ((limit === undefined || offsets.length < limit) && offsets.at(-1)! < roundedFinalStart) {
    offsets.push(roundedFinalStart);
  }
  return offsets;
}

export function hasCompleteSampleCoverage(
  offsets: readonly number[],
  durationSeconds: number,
  clipSeconds: number,
): boolean {
  if (!offsets.length || offsets[0] !== 0) return false;
  for (let index = 1; index < offsets.length; index += 1) {
    if (offsets[index]! - offsets[index - 1]! > clipSeconds) return false;
  }
  return offsets.at(-1)! + clipSeconds >= durationSeconds;
}

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function is1001Url(value: string): boolean {
  try {
    return /(^|\.)1001tracklists\.com$/i.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function isSupportedDownloadUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return (
      hostname === "youtu.be" ||
      /(^|\.)youtube(?:-nocookie)?\.com$/i.test(hostname) ||
      /(^|\.)soundcloud\.com$/i.test(hostname)
    );
  } catch {
    return false;
  }
}

async function existingFile(value: string): Promise<string | undefined> {
  try {
    const path = resolve(value);
    if ((await stat(path)).isFile()) return path;
  } catch {
    // A URL and a missing path both arrive here; the caller distinguishes them.
  }
  return undefined;
}
