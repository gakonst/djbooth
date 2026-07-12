import { openAsBlob } from "node:fs";
import { basename } from "node:path";

import { isAbortError, TracksError } from "../errors.js";
import { isHttpUrl } from "../media.js";
import { parseTimestamp } from "../time.js";
import type { RecognitionMoment, TrackMatch } from "../types.js";

export interface AudDClientOptions {
  apiToken: string;
  fetch?: typeof globalThis.fetch;
  standardUrl?: string;
  enterpriseUrl?: string;
  signal?: AbortSignal;
}

export interface AudDEnterpriseOptions {
  every?: number;
  skip?: number;
  limit?: number;
  startSeconds?: number;
}

export class AudDClient {
  readonly #apiToken: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #standardUrl: string;
  readonly #enterpriseUrl: string;
  readonly #signal?: AbortSignal;

  constructor(options: AudDClientOptions) {
    if (!options.apiToken) throw new TracksError("AUTH_REQUIRED", "AUDD_API_TOKEN is required");
    this.#apiToken = options.apiToken;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#standardUrl = options.standardUrl ?? "https://api.audd.io/";
    this.#enterpriseUrl = options.enterpriseUrl ?? "https://enterprise.audd.io/";
    if (options.signal) this.#signal = options.signal;
  }

  async recognizeEnterprise(
    source: string,
    options: AudDEnterpriseOptions = {},
  ): Promise<RecognitionMoment[]> {
    const form = new FormData();
    form.set("api_token", this.#apiToken);
    form.set("accurate_offsets", "true");
    if (isHttpUrl(source)) {
      form.set("url", source);
    } else {
      try {
        form.set("file", await openAsBlob(source), basename(source));
      } catch (error) {
        throw new TracksError(
          "INVALID_SOURCE",
          `Cannot read local audio file ${source}: ${errorMessage(error)}`,
          { cause: error, exitCode: 2 },
        );
      }
    }
    if (options.every !== undefined) form.set("every", String(options.every));
    if (options.skip !== undefined) form.set("skip", String(options.skip));
    if (options.limit !== undefined) form.set("limit", String(options.limit));
    if (options.startSeconds !== undefined)
      form.set("skip_first_seconds", String(Math.floor(options.startSeconds)));

    const body = await this.#post(this.#enterpriseUrl, form);
    const result = asRecord(body).result;
    if (!Array.isArray(result)) return [];
    return parseEnterpriseResult(result);
  }

  async recognizeClip(
    clip: Blob,
    scanSeconds: number,
    filename = "sample.mp3",
  ): Promise<RecognitionMoment> {
    const form = new FormData();
    form.set("api_token", this.#apiToken);
    form.set("file", clip, filename);
    const body = await this.#post(this.#standardUrl, form);
    const result = asRecord(body).result;
    if (!result || typeof result !== "object") return { offsetSeconds: scanSeconds, matches: [] };
    const match = parseSong(asRecord(result), scanSeconds, scanSeconds, "audd");
    return { offsetSeconds: scanSeconds, matches: match ? [match] : [] };
  }

  async #post(url: string, form: FormData): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        body: form,
        ...(this.#signal ? { signal: this.#signal } : {}),
      });
    } catch (error) {
      throw new TracksError("API_ERROR", `AudD request failed: ${errorMessage(error)}`, {
        cause: error,
        retryable: !isAbortError(error),
      });
    }
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      throw new TracksError(
        "INVALID_RESPONSE",
        `AudD returned non-JSON (${response.status}): ${text.slice(0, 300)}`,
      );
    }
    const record = asRecord(body);
    if (!response.ok || record.status === "error" || record.error) {
      const errorCode = apiErrorCode(record);
      throw new TracksError(
        "API_ERROR",
        `AudD error: ${apiMessage(record) ?? `HTTP ${response.status}`}`,
        {
          retryable: response.status === 429 || response.status >= 500 || errorCode === 611,
          details: body,
        },
      );
    }
    if (record.status !== "success") {
      throw new TracksError("INVALID_RESPONSE", "AudD response is missing status=success", {
        details: body,
      });
    }
    return body;
  }
}

export function parseEnterpriseResult(result: unknown[]): RecognitionMoment[] {
  const moments: RecognitionMoment[] = [];
  for (const raw of result) {
    const row = asRecord(raw);
    if ("artist" in row || "title" in row) {
      const start = numberValue(row.start_seconds);
      if (start === undefined) continue;
      const match = parseSong(row, start, start, "audd");
      if (match) appendFlatMatch(moments, match);
      continue;
    }

    const scanSeconds = parseTimestamp(
      typeof row.offset === "string" || typeof row.offset === "number" ? row.offset : undefined,
    );
    if (scanSeconds === undefined) continue;
    const songs = Array.isArray(row.songs) ? row.songs : [];
    const matches = songs
      .map((song) => {
        const record = asRecord(song);
        const startOffset = (numberValue(record.start_offset) ?? 0) / 1000;
        return parseSong(record, scanSeconds + startOffset, scanSeconds, "audd");
      })
      .filter((match): match is TrackMatch => match !== undefined);
    moments.push(...clusterMatches(matches, scanSeconds));
  }
  return moments;
}

function appendFlatMatch(moments: RecognitionMoment[], match: TrackMatch): void {
  const previous = moments.at(-1);
  if (previous && Math.abs(previous.offsetSeconds - match.startSeconds) < 0.1) {
    previous.matches.push(match);
    return;
  }
  moments.push({ offsetSeconds: match.startSeconds, matches: [match] });
}

function clusterMatches(matches: TrackMatch[], scanSeconds: number): RecognitionMoment[] {
  if (!matches.length) return [{ offsetSeconds: scanSeconds, matches: [] }];
  const sorted = [...matches].sort((a, b) => a.startSeconds - b.startSeconds);
  const clusters: { offsetSeconds: number; endSeconds: number; matches: TrackMatch[] }[] = [];
  for (const match of sorted) {
    const endSeconds = match.endSeconds ?? scanSeconds + 12;
    const cluster = clusters.at(-1);
    if (!cluster || match.startSeconds >= cluster.endSeconds) {
      clusters.push({ offsetSeconds: match.startSeconds, endSeconds, matches: [match] });
      continue;
    }
    cluster.matches.push(match);
    cluster.endSeconds = Math.max(cluster.endSeconds, endSeconds);
  }
  return clusters.map(({ offsetSeconds, matches }) => ({ offsetSeconds, matches }));
}

function parseSong(
  song: Record<string, unknown>,
  startSeconds: number,
  scanSeconds: number,
  provider: "audd",
): TrackMatch | undefined {
  if (typeof song.artist !== "string" || typeof song.title !== "string") return undefined;
  const endOffset = numberValue(song.end_offset);
  const explicitEnd = numberValue(song.end_seconds);
  const confidence = numberValue(song.score);
  return {
    startSeconds,
    scanSeconds,
    artist: song.artist,
    title: song.title,
    provider,
    ...(explicitEnd !== undefined
      ? { endSeconds: explicitEnd }
      : endOffset !== undefined
        ? { endSeconds: scanSeconds + endOffset / 1000 }
        : {}),
    ...(typeof song.album === "string" ? { album: song.album } : {}),
    ...(typeof song.label === "string" ? { label: song.label } : {}),
    ...(typeof song.release_date === "string" ? { releaseDate: song.release_date } : {}),
    ...(typeof song.isrc === "string" ? { isrc: song.isrc } : {}),
    ...(typeof song.upc === "string" ? { upc: song.upc } : {}),
    ...(typeof song.song_link === "string" ? { songLink: song.song_link } : {}),
    ...(confidence === undefined ? {} : { confidence }),
  };
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

function apiMessage(record: Record<string, unknown>): string | undefined {
  if (typeof record.message === "string") return record.message;
  if (typeof record.error === "string") return record.error;
  const error = asRecord(record.error);
  for (const key of ["error_message", "message", "branded_message"]) {
    if (typeof error[key] === "string") return error[key];
  }
  return undefined;
}

function apiErrorCode(record: Record<string, unknown>): number | undefined {
  const error = asRecord(record.error);
  return numberValue(error.error_code ?? error.code ?? record.error_code);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
