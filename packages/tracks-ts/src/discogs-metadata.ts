import { setTimeout as delay } from "node:timers/promises";

import { normalizeMatchText } from "./acquisition.js";
import { JsonDiskCache, type CacheMode, type CacheStats } from "./cache.js";
import type { CatalogMetadata, CatalogMetadataQuery } from "./catalog-metadata.js";

const DISCOGS_BASE_URL = "https://api.discogs.com/";
const DEFAULT_USER_AGENT = "djbooth.ai/0.2.0 (https://github.com/gakonst/djbooth)";
const UNAUTHENTICATED_REQUEST_INTERVAL_MS = 2_500;
const AUTHENTICATED_REQUEST_INTERVAL_MS = 1_050;

export type DiscogsMetadataClientOptions = {
  baseUrl?: string;
  cache?: JsonDiskCache | false;
  cacheMode?: CacheMode;
  fetch?: typeof globalThis.fetch;
  requestIntervalMs?: number;
  token?: string;
  userAgent?: string;
};

type JsonRecord = Record<string, unknown>;

/** Cached, release-detail-verified metadata from Discogs' public catalog. */
export class DiscogsMetadataClient {
  readonly provider = "discogs" as const;
  readonly #baseUrl: string;
  readonly #cache: JsonDiskCache | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #requestIntervalMs: number;
  readonly #token: string | undefined;
  readonly #userAgent: string;
  #nextRequestAt = 0;
  #requestQueue = Promise.resolve();

  constructor(options: DiscogsMetadataClientOptions = {}) {
    this.#baseUrl = new URL(options.baseUrl ?? DISCOGS_BASE_URL).toString();
    this.#cache =
      options.cache === false
        ? undefined
        : (options.cache ??
          new JsonDiskCache({
            namespace: "discogs-metadata-v1",
            defaultTtlMs: 30 * 24 * 60 * 60 * 1_000,
            ...(options.cacheMode ? { mode: options.cacheMode } : {}),
          }));
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#token = options.token?.trim() || process.env.DISCOGS_TOKEN?.trim() || undefined;
    this.#requestIntervalMs = nonnegativeInteger(
      options.requestIntervalMs ??
        (this.#token ? AUTHENTICATED_REQUEST_INTERVAL_MS : UNAUTHENTICATED_REQUEST_INTERVAL_MS),
      "requestIntervalMs",
    );
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
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
    const load = async () => (await this.#lookup(normalizedQuery)) ?? null;
    const value = this.#cache
      ? await this.#cache.getOrLoad(
          { operation: "discogs-metadata-search-v1", query: normalizedQuery },
          load,
          {
            ttlMs: (result) => (result === null ? 24 * 60 * 60 * 1_000 : 30 * 24 * 60 * 60 * 1_000),
          },
        )
      : await load();
    return value ?? undefined;
  }

  async #lookup(query: CatalogMetadataQuery): Promise<CatalogMetadata | undefined> {
    const response = record(
      await this.#get("database/search", {
        track: query.title,
        artist: query.artists.join(" "),
        type: "release",
        per_page: "10",
      }),
    );
    const candidates = array(response.results)
      .map(record)
      .flatMap((result) => {
        const id = positiveInteger(result.id);
        const heading = clean(result.title);
        if (!id || !heading) return [];
        const headingArtist = heading.split(" - ")[0] ?? "";
        const artistScore = identitySimilarity(query.artists.join(" "), headingArtist);
        if (artistScore < 0.72) return [];
        const formats = strings(result.format);
        return [{ id, score: artistScore + (formats.includes("File") ? 0.08 : 0) }];
      })
      .toSorted((left, right) => right.score - left.score || left.id - right.id)
      .slice(0, 4);
    const matches: Array<{ metadata: CatalogMetadata; score: number }> = [];
    for (const candidate of candidates) {
      const release = record(await this.#get(`releases/${String(candidate.id)}`, {}));
      const metadata = discogsReleaseMetadata(release, query);
      if (metadata) {
        const { score, ...fields } = metadata;
        matches.push({ metadata: fields, score: score + candidate.score * 0.05 });
      }
      if (matches.some((match) => match.score >= 0.99)) break;
    }
    const ranked = matches.toSorted(
      (left, right) =>
        right.score - left.score ||
        left.metadata.recordingId.localeCompare(right.metadata.recordingId),
    );
    const best = ranked[0];
    if (!best || best.score < 0.9) return undefined;
    return best.metadata;
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
      const response = await this.#fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent": this.#userAgent,
          ...(this.#token ? { authorization: `Discogs token=${this.#token}` } : {}),
        },
      });
      if (response.status === 404) return undefined;
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await delay(Number.isFinite(retryAfter) ? retryAfter * 1_000 : 2_500 * (attempt + 1));
        await this.#pace();
        continue;
      }
      if (!response.ok) {
        throw new Error(`Discogs metadata request failed: HTTP ${String(response.status)} ${url}`);
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

function discogsReleaseMetadata(
  release: JsonRecord,
  query: CatalogMetadataQuery,
): (CatalogMetadata & { score: number }) | undefined {
  const id = positiveInteger(release.id);
  const album = clean(release.title);
  if (!id || !album) return undefined;
  const releaseArtists = array(release.artists)
    .map(record)
    .map((artist) => discogsName(clean(artist.name)))
    .filter((artist): artist is string => artist !== undefined)
    .join(" ");
  const artistScore = identitySimilarity(query.artists.join(" "), releaseArtists);
  if (artistScore < 0.72) return undefined;
  const tracks = array(release.tracklist)
    .map(record)
    .flatMap((track) => {
      const title = clean(track.title);
      if (!title || clean(track.type_) === "heading") return [];
      const titleScore = titleSimilarity(query.title, title);
      const durationScore = durationSimilarity(
        query.durationSeconds,
        parseDuration(track.duration),
      );
      if (titleScore < 0.9 || durationScore < 0.6) return [];
      return [{ title, score: titleScore * 0.75 + durationScore * 0.25 }];
    })
    .toSorted((left, right) => right.score - left.score);
  const track = tracks[0];
  if (!track || track.score - (tracks[1]?.score ?? 0) < 0.03) return undefined;
  const label = array(release.labels)
    .map(record)
    .map((value) => discogsName(clean(value.name)))
    .find((value) => value && !/^not on label/iu.test(value));
  const genre = preferredStyle(strings(release.styles), strings(release.genres));
  const releaseDate = dateOnly(release.released) ?? dateOnly(release.year);
  return {
    album,
    ...(label ? { label } : {}),
    ...(genre ? { genre } : {}),
    ...(releaseDate ? { releaseDate } : {}),
    provider: "discogs",
    recordingId: `${String(id)}:${normalizeMatchText(track.title)}`,
    releaseId: String(id),
    matchedBy: "artist-title",
    score: track.score * 0.9 + artistScore * 0.1,
  };
}

function preferredStyle(styles: string[], genres: string[]): string | undefined {
  return [...styles, ...genres].find(
    (value) => !/^(?:electronic|funk\s*\/\s*soul|pop|stage\s*&\s*screen)$/iu.test(value),
  );
}

function discogsName(value: string | undefined): string | undefined {
  return value?.replace(/\s*\(\d+\)$/u, "").trim() || undefined;
}

function titleSimilarity(left: string, right: string): number {
  const expected = normalizeMatchText(left);
  const actual = normalizeMatchText(right);
  if (expected === actual) return 1;
  return identitySimilarity(
    expected.replace(/\b(?:original|extended|radio)\s+(?:mix|edit)\b/gu, "").trim(),
    actual.replace(/\b(?:original|extended|radio)\s+(?:mix|edit)\b/gu, "").trim(),
  );
}

function identitySimilarity(left: string, right: string): number {
  const expected = normalizeMatchText(left);
  const actual = normalizeMatchText(right);
  if (!expected || !actual) return 0;
  if (expected === actual) return 1;
  const expectedTokens = new Set(expected.split(" ").filter((word) => !connector(word)));
  const actualTokens = new Set(actual.split(" ").filter((word) => !connector(word)));
  const matched = [...expectedTokens].filter((token) => actualTokens.has(token)).length;
  return matched / Math.max(expectedTokens.size, actualTokens.size);
}

function connector(value: string): boolean {
  return /^(?:and|feat|featuring|ft|vs|x)$/u.test(value);
}

function durationSimilarity(expected: number | undefined, actual: number | undefined): number {
  if (!expected || !actual) return 0.7;
  const difference = Math.abs(expected - actual);
  return Math.max(0, 1 - difference / Math.max(12, expected * 0.08));
}

function parseDuration(value: unknown): number | undefined {
  const match = /^(\d{1,3}):(\d{2})$/u.exec(clean(value) ?? "");
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

function dateOnly(value: unknown): string | undefined {
  const text = clean(value);
  return text ? /^\d{4}(?:-\d{2}(?:-\d{2})?)?/u.exec(text)?.[0] : undefined;
}

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return array(value).flatMap((item) => (clean(item) ? [clean(item)!] : []));
}

function clean(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : String(value ?? "").trim();
  return text || undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be a nonnegative integer`);
  return value;
}
