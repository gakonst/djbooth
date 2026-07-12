import { createHmac } from "node:crypto";

import { isAbortError, TracksError } from "../errors.js";
import type { RecognitionMoment, TrackMatch } from "../types.js";

export interface AcrCloudClientOptions {
  host: string;
  accessKey: string;
  accessSecret: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  now?: () => number;
}

export class AcrCloudClient {
  readonly #host: string;
  readonly #accessKey: string;
  readonly #accessSecret: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #signal?: AbortSignal;
  readonly #now: () => number;

  constructor(options: AcrCloudClientOptions) {
    if (!options.host || !options.accessKey || !options.accessSecret) {
      throw new TracksError(
        "AUTH_REQUIRED",
        "ACR_HOST, ACR_ACCESS_KEY, and ACR_ACCESS_SECRET are required for ACRCloud",
      );
    }
    this.#host = options.host.replace(/^https?:\/\//, "").replace(/\/$/, "");
    this.#accessKey = options.accessKey;
    this.#accessSecret = options.accessSecret;
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (options.signal) this.#signal = options.signal;
    this.#now = options.now ?? Date.now;
  }

  async recognizeClip(clip: Blob, scanSeconds: number): Promise<RecognitionMoment> {
    const endpoint = "/v1/identify";
    const timestamp = String(Math.floor(this.#now() / 1000));
    const signature = signAcrCloud(this.#accessSecret, this.#accessKey, timestamp, endpoint);
    const form = new FormData();
    form.set("sample", clip, "sample.mp3");
    form.set("sample_bytes", String(clip.size));
    form.set("access_key", this.#accessKey);
    form.set("data_type", "audio");
    form.set("signature_version", "1");
    form.set("signature", signature);
    form.set("timestamp", timestamp);

    let response: Response;
    try {
      response = await this.#fetch(`https://${this.#host}${endpoint}`, {
        method: "POST",
        body: form,
        ...(this.#signal ? { signal: this.#signal } : {}),
      });
    } catch (error) {
      throw new TracksError("API_ERROR", `ACRCloud request failed: ${errorMessage(error)}`, {
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
        `ACRCloud returned non-JSON (${response.status}): ${text.slice(0, 300)}`,
      );
    }
    const record = asRecord(body);
    const status = asRecord(record.status);
    const code = numberValue(status.code);
    if (code === undefined) {
      throw new TracksError("INVALID_RESPONSE", "ACRCloud response is missing status.code", {
        details: body,
      });
    }
    if (!response.ok || (code !== undefined && code !== 0 && code !== 1001)) {
      throw new TracksError(
        "API_ERROR",
        `ACRCloud error: ${typeof status.msg === "string" ? status.msg : `HTTP ${response.status}`}`,
        {
          retryable: response.status === 429 || response.status >= 500 || code === 3015,
          details: body,
        },
      );
    }
    if (code === 1001) return { offsetSeconds: scanSeconds, matches: [] };

    const music = asRecord(record.metadata).music;
    const matches = (Array.isArray(music) ? music : [])
      .map((item) => parseMusic(asRecord(item), scanSeconds))
      .filter((match): match is TrackMatch => match !== undefined);
    return { offsetSeconds: scanSeconds, matches };
  }
}

export function signAcrCloud(
  accessSecret: string,
  accessKey: string,
  timestamp: string,
  endpoint = "/v1/identify",
): string {
  const stringToSign = ["POST", endpoint, accessKey, "audio", "1", timestamp].join("\n");
  return createHmac("sha1", accessSecret).update(stringToSign, "utf8").digest("base64");
}

function parseMusic(music: Record<string, unknown>, scanSeconds: number): TrackMatch | undefined {
  if (typeof music.title !== "string") return undefined;
  const artists = Array.isArray(music.artists) ? music.artists : [];
  const artist = artists
    .map((item) => asRecord(item).name)
    .filter((name): name is string => typeof name === "string")
    .join(", ");
  if (!artist) return undefined;
  const album = asRecord(music.album);
  const externalIds = asRecord(music.external_ids);
  const confidence = numberValue(music.score);
  const sampleStartOffset = numberValue(music.sample_begin_time_offset_ms);
  const sampleEndOffset = numberValue(music.sample_end_time_offset_ms);
  return {
    startSeconds: scanSeconds + (sampleStartOffset ?? 0) / 1000,
    ...(sampleEndOffset === undefined ? {} : { endSeconds: scanSeconds + sampleEndOffset / 1000 }),
    scanSeconds,
    artist,
    title: music.title,
    provider: "acrcloud",
    ...(typeof album.name === "string" ? { album: album.name } : {}),
    ...(typeof music.label === "string" ? { label: music.label } : {}),
    ...(typeof music.release_date === "string" ? { releaseDate: music.release_date } : {}),
    ...(typeof externalIds.isrc === "string" ? { isrc: externalIds.isrc } : {}),
    ...(typeof externalIds.upc === "string" ? { upc: externalIds.upc } : {}),
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
