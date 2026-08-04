import { setTimeout as delay } from "node:timers/promises";

import { normalizeMatchText } from "./acquisition.js";
import { JsonDiskCache, type CacheMode, type CacheStats } from "./cache.js";
import type { CatalogMetadata, CatalogMetadataQuery } from "./catalog-metadata.js";

const DEEZER_BASE_URL = "https://api.deezer.com/";
const DEFAULT_REQUEST_INTERVAL_MS = 150;

export type DeezerMetadataClientOptions = {
  baseUrl?: string;
  cache?: JsonDiskCache | false;
  cacheMode?: CacheMode;
  fetch?: typeof globalThis.fetch;
  requestIntervalMs?: number;
};

/** Cached release metadata from exact Deezer ISRCs or strictly matched catalog searches. */
export class DeezerMetadataClient {
  readonly provider = "deezer" as const;
  readonly #baseUrl: string;
  readonly #cache: JsonDiskCache | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #requestIntervalMs: number;
  #nextRequestAt = 0;
  #requestQueue = Promise.resolve();

  constructor(options: DeezerMetadataClientOptions = {}) {
    this.#baseUrl = new URL(options.baseUrl ?? DEEZER_BASE_URL).toString();
    this.#cache =
      options.cache === false
        ? undefined
        : (options.cache ??
          new JsonDiskCache({
            namespace: "deezer-metadata-v1",
            defaultTtlMs: 30 * 24 * 60 * 60 * 1000,
            ...(options.cacheMode ? { mode: options.cacheMode } : {}),
          }));
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#requestIntervalMs = nonnegativeInteger(
      options.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS,
      "requestIntervalMs",
    );
  }

  cacheStats(): CacheStats | undefined {
    return this.#cache?.snapshot();
  }

  async lookup(query: CatalogMetadataQuery): Promise<CatalogMetadata | undefined> {
    const title = query.title.trim();
    const artists = query.artists.map((artist) => artist.trim()).filter(Boolean);
    if (!title || !artists.length) return undefined;
    const isrc = normalizeIsrc(query.isrc);
    const normalizedQuery = {
      title,
      artists,
      ...(query.album?.trim() ? { album: query.album.trim() } : {}),
      ...(isrc ? { isrc } : {}),
      ...(query.durationSeconds ? { durationSeconds: query.durationSeconds } : {}),
    };
    const load = async () => (await this.#lookup(normalizedQuery)) ?? null;
    const value = this.#cache
      ? await this.#cache.getOrLoad(
          { operation: "metadata-lookup-v2", query: normalizedQuery },
          load,
          {
            ttlMs: (result) => (result === null ? 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000),
          },
        )
      : await load();
    return value ?? undefined;
  }

  async #lookup(query: CatalogMetadataQuery): Promise<CatalogMetadata | undefined> {
    const isrc = normalizeIsrc(query.isrc);
    const match = isrc ? await this.#trackByIsrc(isrc) : await this.#trackBySearch(query);
    if (!match) return undefined;
    const trackId = positiveId(match.id);
    const albumId = positiveId(asRecord(match.album).id);
    if (!trackId || !albumId) return undefined;
    const [track, album] = await Promise.all([
      isrc ? match : this.#get(`track/${trackId}`).then(asRecord),
      this.#get(`album/${albumId}`).then(asRecord),
    ]);
    const albumTitle = clean(album.title) ?? clean(asRecord(match.album).title);
    const label = clean(album.label);
    const genre = array(album.genres)
      .map(asRecord)
      .map((value) => clean(value.name))
      .find(Boolean);
    const releaseDate = clean(album.release_date);
    const matchedIsrc = normalizeIsrc(clean(track.isrc));
    return {
      ...(albumTitle ? { album: albumTitle } : {}),
      ...(label ? { label } : {}),
      ...(genre ? { genre } : {}),
      ...(matchedIsrc ? { isrc: matchedIsrc } : {}),
      ...(releaseDate ? { releaseDate } : {}),
      provider: this.provider,
      recordingId: String(trackId),
      releaseId: String(albumId),
      matchedBy: isrc ? "isrc" : "artist-title",
    };
  }

  async #trackByIsrc(isrc: string): Promise<Record<string, unknown> | undefined> {
    const track = asRecord(await this.#get(`track/isrc:${encodeURIComponent(isrc)}`));
    return normalizeIsrc(clean(track.isrc)) === isrc && positiveId(track.id) ? track : undefined;
  }

  async #trackBySearch(query: CatalogMetadataQuery): Promise<Record<string, unknown> | undefined> {
    const response = asRecord(
      await this.#get("search", {
        q: `artist:"${query.artists.join(" ")}" track:"${query.title}"`,
        limit: "10",
      }),
    );
    const candidates = array(response.data)
      .map(asRecord)
      .flatMap((track) => {
        const title = clean(track.title_short) ?? clean(track.title);
        const artist = clean(asRecord(track.artist).name);
        const duration = number(track.duration);
        if (!title || !artist || catalogTitle(query.title) !== catalogTitle(title)) return [];
        const artistScore = identitySimilarity(query.artists.join(" "), artist);
        const durationScore = durationSimilarity(query.durationSeconds, duration);
        if (artistScore < 0.65 || durationScore < 0.7) return [];
        return [{ track, score: artistScore * 0.7 + durationScore * 0.3 }];
      })
      .toSorted((left, right) => right.score - left.score);
    if (!candidates[0] || candidates[0].score - (candidates[1]?.score ?? 0) < 0.05)
      return undefined;
    return candidates[0].track;
  }

  async #get(path: string, query: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(path, this.#baseUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const load = () => this.#request(url);
    return this.#cache
      ? this.#cache.getOrLoad({ url: url.toString() }, load, {
          ttlMs: (value) => (value === undefined ? 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000),
        })
      : load();
  }

  async #request(url: URL): Promise<unknown> {
    await this.#pace();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.#fetch(url, { headers: { accept: "application/json" } });
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await delay(Number.isFinite(retryAfter) ? retryAfter * 1000 : 750 * (attempt + 1));
        await this.#pace();
        continue;
      }
      if (!response.ok) {
        throw new Error(`Deezer request failed: HTTP ${String(response.status)} ${url}`);
      }
      const value = (await response.json()) as unknown;
      const error = asRecord(asRecord(value).error);
      if (Object.keys(error).length) {
        const code = number(error.code);
        if (code === 800) return undefined;
        throw new Error(`Deezer request failed: ${clean(error.message) ?? "unknown API error"}`);
      }
      return value;
    }
    return undefined;
  }

  async #pace(): Promise<void> {
    let release!: () => void;
    const previous = this.#requestQueue;
    this.#requestQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const waitMs = Math.max(0, this.#nextRequestAt - Date.now());
    if (waitMs > 0) await delay(waitMs);
    this.#nextRequestAt = Date.now() + this.#requestIntervalMs;
    release();
  }
}

function catalogTitle(value: string): string {
  return normalizeMatchText(value)
    .replace(/\b(?:original|extended|radio)\s+(?:mix|edit)\b/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function identitySimilarity(left: string, right: string): number {
  const expected = normalizeMatchText(left);
  const actual = normalizeMatchText(right);
  if (!expected || !actual) return 0;
  if (expected === actual || expected.includes(actual) || actual.includes(expected)) return 1;
  const expectedTokens = new Set(expected.split(" ").filter((token) => token !== "and"));
  const actualTokens = new Set(actual.split(" ").filter((token) => token !== "and"));
  const matched = [...expectedTokens].filter((token) => actualTokens.has(token)).length;
  return matched / Math.max(expectedTokens.size, actualTokens.size);
}

function durationSimilarity(expected: number | undefined, actual: number | undefined): number {
  if (!expected || !actual) return 0.75;
  const difference = Math.abs(expected - actual);
  return Math.max(0, 1 - difference / Math.max(8, expected * 0.04));
}

function normalizeIsrc(value: string | undefined): string | undefined {
  const normalized = value?.replaceAll("-", "").trim().toLocaleUpperCase("en-US");
  return normalized && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/u.test(normalized) ? normalized : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function array(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return Array.isArray(asRecord(value).data) ? (asRecord(value).data as unknown[]) : [];
}

function clean(value: unknown): string | undefined {
  const result = typeof value === "string" ? value.trim() : "";
  return result || undefined;
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveId(value: unknown): number | undefined {
  const parsed = number(value);
  return parsed && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be a nonnegative integer`);
  return value;
}
