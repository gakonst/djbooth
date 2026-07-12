import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { JsonDiskCache, type CacheMode } from "../cache.js";
import { TracksError } from "../errors.js";
import { runProcess } from "../process.js";
import type { Environment } from "../types.js";

export interface MediaMetadata {
  id?: string;
  title?: string;
  description?: string;
  durationSeconds?: number;
  webpageUrl?: string;
  uploader?: string;
  extractor?: string;
}

export interface InspectMetadataOptions {
  env?: Environment;
  cookies?: string;
  cookiesFromBrowser?: string;
  signal?: AbortSignal;
  cache?: JsonDiskCache | false;
  cacheMode?: CacheMode;
}

export interface CliCommand {
  executable: string;
  prefix: string[];
}

/** Read set metadata through ytdlp-ts without downloading media bytes. */
export async function inspectMediaMetadata(
  source: string,
  options: InspectMetadataOptions = {},
): Promise<MediaMetadata> {
  const authenticated = Boolean(
    options.cookies || options.cookiesFromBrowser || hasSensitiveMediaSource(source),
  );
  const cache =
    options.cache === false || authenticated
      ? undefined
      : (options.cache ??
        new JsonDiskCache({
          namespace: "set-metadata-v1",
          ...(options.cacheMode ? { mode: options.cacheMode } : {}),
        }));
  if (cache) {
    return cache.getOrLoad(
      {
        source,
      },
      () => inspectMediaMetadataUncached(source, options),
      {
        ttlMs: 6 * 60 * 60 * 1000,
        ...(options.cacheMode ? { mode: options.cacheMode } : {}),
        shouldStore: (metadata) =>
          !metadata.webpageUrl || !hasSensitiveMediaSource(metadata.webpageUrl),
      },
    );
  }
  return inspectMediaMetadataUncached(source, options);
}

function hasSensitiveMediaSource(source: string): boolean {
  try {
    const url = new URL(source);
    const pathname = decodePathname(url.pathname);
    if (
      /(^|\.)soundcloud\.com$/iu.test(url.hostname) &&
      pathname
        .split("/")
        .filter(Boolean)
        .slice(2)
        .some((segment) => /^s-/iu.test(segment))
    ) {
      return true;
    }
    return [...url.searchParams.keys()].some((key) =>
      /(?:^|[_-])(?:auth|expires?|key|secret|signature|token)(?:$|[_-])/iu.test(key),
    );
  } catch {
    return false;
  }
}

function decodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

async function inspectMediaMetadataUncached(
  source: string,
  options: InspectMetadataOptions,
): Promise<MediaMetadata> {
  const env = options.env ?? process.env;
  const command = await getYtdlpTsCommand(env);
  const args = [
    ...command.prefix,
    "inspect",
    source,
    "--engine",
    "auto",
    "--no-playlist",
    "--format",
    "json",
    "--filter-output",
    "info.id,info.title,info.duration,info.description,info.webpage_url,info.uploader,info.extractor_key,info.extractor",
  ];
  if (options.cookies) args.push("--cookies", options.cookies);
  if (options.cookiesFromBrowser) args.push("--cookies-from-browser", options.cookiesFromBrowser);

  const result = await runProcess(command.executable, args, {
    env,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  let body: unknown;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    throw new TracksError(
      "INVALID_RESPONSE",
      `ytdlp-ts returned non-JSON metadata: ${result.stdout.slice(0, 300)}`,
    );
  }
  const outer = asRecord(body);
  const info = asRecord(asRecord(outer.data).info ?? outer.info);
  if (!Object.keys(info).length) {
    throw new TracksError("INVALID_RESPONSE", "ytdlp-ts response is missing info metadata");
  }
  const durationSeconds = numberValue(info.duration);
  return {
    ...(typeof info.id === "string" ? { id: info.id } : {}),
    ...(typeof info.title === "string" ? { title: info.title } : {}),
    ...(typeof info.description === "string" ? { description: info.description } : {}),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(typeof info.webpage_url === "string" ? { webpageUrl: info.webpage_url } : {}),
    ...(typeof info.uploader === "string" ? { uploader: info.uploader } : {}),
    ...(typeof info.extractor_key === "string"
      ? { extractor: info.extractor_key }
      : typeof info.extractor === "string"
        ? { extractor: info.extractor }
        : {}),
  };
}

export async function getYtdlpTsCommand(env: Environment = process.env): Promise<CliCommand> {
  if (env.YTDLP_TS_PATH) return commandForPath(env.YTDLP_TS_PATH);

  const sibling = resolve(import.meta.dirname, "../../../ytdlp-ts/dist/cli.js");
  try {
    await access(sibling);
    return { executable: process.execPath, prefix: [sibling] };
  } catch {
    return { executable: "ytdlp-ts", prefix: [] };
  }
}

function commandForPath(path: string): { executable: string; prefix: string[] } {
  return /\.[cm]?js$/iu.test(path)
    ? { executable: process.execPath, prefix: [path] }
    : { executable: path, prefix: [] };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberValue(value: unknown): number | undefined {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}
