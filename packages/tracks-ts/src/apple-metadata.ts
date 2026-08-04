import { setTimeout as delay } from "node:timers/promises";

import { normalizeMatchText } from "./acquisition.js";
import { JsonDiskCache, type CacheMode, type CacheStats } from "./cache.js";
import type { CatalogMetadata, CatalogMetadataQuery } from "./catalog-metadata.js";

const APPLE_SEARCH_BASE_URL = "https://itunes.apple.com/";
const APPLE_REQUEST_INTERVAL_MS = 3_100;

export type AppleMetadataClientOptions = {
  baseUrl?: string;
  cache?: JsonDiskCache | false;
  cacheMode?: CacheMode;
  country?: string;
  fetch?: typeof globalThis.fetch;
  requestIntervalMs?: number;
};

type JsonRecord = Record<string, unknown>;

/** Cached, duration-strict Apple catalog metadata from exact IDs or artist/title search. */
export class AppleMetadataClient {
  readonly provider = "apple" as const;
  readonly #baseUrl: string;
  readonly #cache: JsonDiskCache | undefined;
  readonly #country: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #requestIntervalMs: number;
  #nextRequestAt = 0;
  #requestQueue = Promise.resolve();

  constructor(options: AppleMetadataClientOptions = {}) {
    this.#baseUrl = new URL(options.baseUrl ?? APPLE_SEARCH_BASE_URL).toString();
    this.#cache =
      options.cache === false
        ? undefined
        : (options.cache ??
          new JsonDiskCache({
            namespace: "apple-metadata-v1",
            defaultTtlMs: 30 * 24 * 60 * 60 * 1000,
            ...(options.cacheMode ? { mode: options.cacheMode } : {}),
          }));
    this.#country = options.country?.trim().toLocaleUpperCase("en-US") || "US";
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#requestIntervalMs = nonnegativeInteger(
      options.requestIntervalMs ?? APPLE_REQUEST_INTERVAL_MS,
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
    const normalizedQuery = {
      title,
      artists,
      ...(query.album?.trim() ? { album: query.album.trim() } : {}),
      ...(query.durationSeconds ? { durationSeconds: query.durationSeconds } : {}),
    };
    const load = async () => (await this.#search(normalizedQuery)) ?? null;
    const value = this.#cache
      ? await this.#cache.getOrLoad(
          { operation: "apple-metadata-search-v1", country: this.#country, query: normalizedQuery },
          load,
          {
            ttlMs: (result) => (result === null ? 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000),
          },
        )
      : await load();
    return value ?? undefined;
  }

  async lookupTrackUrl(source: string): Promise<CatalogMetadata | undefined> {
    const trackId = appleTrackId(source);
    if (!trackId) return undefined;
    const response = asRecord(
      await this.#get("lookup", { id: trackId, entity: "song", country: this.#country }),
    );
    const track = array(response.results)
      .map(asRecord)
      .find((value) => String(value.trackId ?? "") === trackId);
    return track ? this.#metadataFromTrack(track, "source-url") : undefined;
  }

  async lookupUpc(upc: string): Promise<CatalogMetadata | undefined> {
    if (!/^\d{8,14}$/u.test(upc)) return undefined;
    const response = asRecord(
      await this.#get("lookup", { upc, entity: "song", country: this.#country }),
    );
    const values = array(response.results).map(asRecord);
    const collection = values.find((value) => value.wrapperType === "collection");
    const track = values.find((value) => value.kind === "song");
    if (!collection && !track) return undefined;
    return this.#metadataFromTrack(track ?? collection!, "source-url", collection);
  }

  async #search(query: CatalogMetadataQuery): Promise<CatalogMetadata | undefined> {
    const response = asRecord(
      await this.#get("search", {
        term: `${query.artists.join(" ")} ${query.title}`,
        country: this.#country,
        media: "music",
        entity: "song",
        limit: "25",
      }),
    );
    const candidates = array(response.results)
      .map(asRecord)
      .flatMap((track) => {
        const title = clean(track.trackName);
        const artist = clean(track.artistName);
        const durationMs = number(track.trackTimeMillis);
        if (!title || !artist || track.kind !== "song") return [];
        const titleScore = titleSimilarity(query.title, title);
        const artistScore = identitySimilarity(query.artists.join(" "), artist);
        const durationScore = durationSimilarity(query.durationSeconds, durationMs);
        if (titleScore < 0.92 || artistScore < 0.65 || durationScore < 0.72) return [];
        return [{ track, score: titleScore * 0.5 + artistScore * 0.3 + durationScore * 0.2 }];
      })
      .toSorted((left, right) => right.score - left.score);
    const best = candidates[0];
    if (!best || best.score - (candidates[1]?.score ?? 0) < 0.04) return undefined;
    return this.#metadataFromTrack(best.track, "artist-title");
  }

  async #metadataFromTrack(
    track: JsonRecord,
    matchedBy: CatalogMetadata["matchedBy"],
    knownCollection?: JsonRecord,
  ): Promise<CatalogMetadata | undefined> {
    const trackId = positiveInteger(track.trackId);
    const collectionId = positiveInteger(track.collectionId);
    if (!trackId && !collectionId) return undefined;
    let collection = knownCollection;
    if (!collection && collectionId) {
      const response = asRecord(
        await this.#get("lookup", {
          id: String(collectionId),
          entity: "song",
          country: this.#country,
        }),
      );
      collection = array(response.results)
        .map(asRecord)
        .find((value) => value.wrapperType === "collection");
    }
    const title = clean(track.trackName);
    const artist = clean(track.artistName);
    const album = clean(track.collectionName) ?? clean(collection?.collectionName);
    const label = copyrightLabel(collection?.copyright);
    const genre = clean(track.primaryGenreName) ?? clean(collection?.primaryGenreName);
    const releaseDate = dateOnly(track.releaseDate) ?? dateOnly(collection?.releaseDate);
    const durationMs = number(track.trackTimeMillis);
    return {
      ...(matchedBy === "source-url" && title ? { title } : {}),
      ...(matchedBy === "source-url" && artist ? { artist } : {}),
      ...(album ? { album } : {}),
      ...(label ? { label } : {}),
      ...(genre ? { genre } : {}),
      ...(releaseDate ? { releaseDate } : {}),
      ...(matchedBy === "source-url" && durationMs ? { durationSeconds: durationMs / 1_000 } : {}),
      provider: this.provider,
      recordingId: trackId ? String(trackId) : `collection:${String(collectionId)}`,
      ...(collectionId ? { releaseId: String(collectionId) } : {}),
      matchedBy,
    };
  }

  async #get(path: string, query: Record<string, string>): Promise<unknown> {
    const url = new URL(path, this.#baseUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const load = () => this.#request(url);
    return this.#cache
      ? this.#cache.getOrLoad({ url: url.toString() }, load, {
          ttlMs: (value) =>
            value === undefined ? 24 * 60 * 60 * 1_000 : 30 * 24 * 60 * 60 * 1_000,
        })
      : load();
  }

  async #request(url: URL): Promise<unknown> {
    await this.#pace();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await this.#fetch(url, { headers: { accept: "application/json" } });
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await delay(Number.isFinite(retryAfter) ? retryAfter * 1_000 : 3_100 * (attempt + 1));
        await this.#pace();
        continue;
      }
      if (response.status === 404) return undefined;
      if (!response.ok) {
        throw new Error(`Apple metadata request failed: HTTP ${String(response.status)} ${url}`);
      }
      return response.json();
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

function appleTrackId(source: string): string | undefined {
  try {
    const url = new URL(source);
    const value = url.searchParams.get("i");
    return value && /^\d+$/u.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function copyrightLabel(value: unknown): string | undefined {
  const text = clean(value);
  if (!text) return undefined;
  return (
    text
      .replace(/^[℗©]\s*/u, "")
      .replace(/^\d{4}\s*/u, "")
      .replace(/,?\s+under exclusive licen[cs]e to .*$/iu, "")
      .trim() || undefined
  );
}

function titleSimilarity(left: string, right: string): number {
  const expected = catalogTitle(left);
  const actual = catalogTitle(right);
  if (expected === actual) return versionCompatible(left, right) ? 1 : 0.9;
  return identitySimilarity(expected, actual);
}

function catalogTitle(value: string): string {
  return normalizeMatchText(value)
    .replace(/\b(?:original|extended|radio)\s+(?:mix|edit)\b/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function versionCompatible(expected: string, actual: string): boolean {
  const expectedVersions = versionWords(expected);
  const actualVersions = versionWords(actual);
  if (!expectedVersions.size || !actualVersions.size) return true;
  return [...expectedVersions].some((value) => actualVersions.has(value));
}

function versionWords(value: string): Set<string> {
  return new Set(
    normalizeMatchText(value)
      .split(" ")
      .filter((word) => /^(?:club|dub|edit|extended|instrumental|radio|remix)$/u.test(word)),
  );
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

function durationSimilarity(
  expectedSeconds: number | undefined,
  actualMs: number | undefined,
): number {
  if (!expectedSeconds || !actualMs) return 0.5;
  const difference = Math.abs(expectedSeconds - actualMs / 1_000);
  return Math.max(0, 1 - difference / Math.max(10, expectedSeconds * 0.06));
}

function dateOnly(value: unknown): string | undefined {
  const text = clean(value);
  return text ? /^\d{4}(?:-\d{2}(?:-\d{2})?)?/u.exec(text)?.[0] : undefined;
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function clean(value: unknown): string | undefined {
  const result = typeof value === "string" ? value.trim() : "";
  return result || undefined;
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = number(value);
  return parsed && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be a nonnegative integer`);
  return value;
}
