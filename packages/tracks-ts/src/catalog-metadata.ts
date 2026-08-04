import { setTimeout as delay } from "node:timers/promises";

import { JsonDiskCache, type CacheMode, type CacheStats } from "./cache.js";
import { normalizeMatchText } from "./acquisition.js";

const MUSICBRAINZ_BASE_URL = "https://musicbrainz.org/ws/2/";
const DEFAULT_USER_AGENT = "djbooth.ai/0.2.0 (https://github.com/gakonst/djbooth)";
const MUSICBRAINZ_REQUEST_INTERVAL_MS = 1_050;

export type CatalogMetadataQuery = {
  title: string;
  artists: string[];
  album?: string;
  isrc?: string;
  durationSeconds?: number;
};

export type CatalogMetadata = {
  album?: string;
  label?: string;
  genre?: string;
  isrc?: string;
  releaseDate?: string;
  provider: "deezer" | "musicbrainz";
  recordingId: string;
  releaseId?: string;
  matchedBy: "isrc" | "artist-title";
};

export type MusicBrainzMetadataClientOptions = {
  baseUrl?: string;
  cache?: JsonDiskCache | false;
  cacheMode?: CacheMode;
  fetch?: typeof globalThis.fetch;
  requestIntervalMs?: number;
  userAgent?: string;
};

/** Conservative, cached release-metadata lookup using MusicBrainz's open catalog. */
export class MusicBrainzMetadataClient {
  readonly provider = "musicbrainz" as const;
  readonly #baseUrl: string;
  readonly #cache: JsonDiskCache | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #requestIntervalMs: number;
  readonly #userAgent: string;
  #nextRequestAt = 0;
  #requestQueue = Promise.resolve();

  constructor(options: MusicBrainzMetadataClientOptions = {}) {
    this.#baseUrl = new URL(options.baseUrl ?? MUSICBRAINZ_BASE_URL).toString();
    this.#cache =
      options.cache === false
        ? undefined
        : (options.cache ??
          new JsonDiskCache({
            namespace: "musicbrainz-metadata-v1",
            defaultTtlMs: 30 * 24 * 60 * 60 * 1000,
            ...(options.cacheMode ? { mode: options.cacheMode } : {}),
          }));
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#requestIntervalMs = nonnegativeInteger(
      options.requestIntervalMs ?? MUSICBRAINZ_REQUEST_INTERVAL_MS,
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
    const isrc = normalizeIsrc(query.isrc);
    const normalizedQuery = {
      title,
      artists,
      ...(query.album ? { album: query.album.trim() } : {}),
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
    return value ? { ...value, provider: this.provider } : undefined;
  }

  async #lookup(query: CatalogMetadataQuery): Promise<CatalogMetadata | undefined> {
    const isrc = normalizeIsrc(query.isrc);
    const matchedBy = isrc ? "isrc" : "artist-title";
    const recording = isrc
      ? await this.#recordingByIsrc(isrc, query)
      : await this.#recordingBySearch(query);
    if (!recording) return undefined;
    const detail = asRecord(
      await this.#get(`recording/${encodeURIComponent(recording.id)}`, {
        inc: "artist-credits+releases+release-groups+genres+tags",
      }),
    );
    const release = selectRelease(detail, query.album);
    if (!release) return { provider: this.provider, recordingId: recording.id, matchedBy };
    const releaseId = stringValue(release.id);
    if (!releaseId) return { provider: this.provider, recordingId: recording.id, matchedBy };
    const releaseDetail = asRecord(
      await this.#get(`release/${encodeURIComponent(releaseId)}`, {
        inc: "labels+release-groups+genres+tags",
      }),
    );
    const album = cleanValue(releaseDetail.title) ?? cleanValue(release.title);
    const label = releaseLabel(releaseDetail);
    const genre = consensusGenre([detail, releaseDetail, asRecord(releaseDetail["release-group"])]);
    const releaseDate = cleanValue(releaseDetail.date) ?? cleanValue(release.date);
    return {
      ...(album ? { album } : {}),
      ...(label ? { label } : {}),
      ...(genre ? { genre } : {}),
      ...(releaseDate ? { releaseDate } : {}),
      provider: this.provider,
      recordingId: recording.id,
      releaseId,
      matchedBy,
    };
  }

  async #recordingByIsrc(
    isrc: string,
    query: CatalogMetadataQuery,
  ): Promise<{ id: string } | undefined> {
    const value = asRecord(
      await this.#get(`isrc/${encodeURIComponent(isrc)}`, {
        inc: "artist-credits+releases",
      }),
    );
    return selectRecording(arrayValue(value.recordings), query, 0);
  }

  async #recordingBySearch(query: CatalogMetadataQuery): Promise<{ id: string } | undefined> {
    const value = asRecord(
      await this.#get("recording", {
        query: `${query.title} ${query.artists.join(" ")}`,
        dismax: "true",
        limit: "5",
      }),
    );
    return selectRecording(arrayValue(value.recordings), query, 95);
  }

  async #get(path: string, query: Record<string, string>): Promise<unknown> {
    const url = new URL(path, this.#baseUrl);
    for (const [key, value] of Object.entries({ ...query, fmt: "json" })) {
      url.searchParams.set(key, value);
    }
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
      const response = await this.#fetch(url, {
        headers: { accept: "application/json", "user-agent": this.#userAgent },
      });
      if (response.status === 404) return undefined;
      if ((response.status === 429 || response.status === 503) && attempt < 2) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await delay(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1_500 * (attempt + 1));
        await this.#pace();
        continue;
      }
      if (!response.ok) {
        throw new Error(`MusicBrainz request failed: HTTP ${String(response.status)} ${url}`);
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

function selectRecording(
  values: unknown[],
  query: CatalogMetadataQuery,
  minimumProviderScore: number,
): { id: string } | undefined {
  const scored = values.flatMap((value) => {
    const recording = asRecord(value);
    const id = stringValue(recording.id);
    const title = cleanValue(recording.title);
    const providerScore = numberValue(recording.score) ?? 100;
    if (!id || !title || providerScore < minimumProviderScore) return [];
    const titleScore = identitySimilarity(query.title, title);
    const creditedArtists = artistNames(recording);
    const artistScore = identitySimilarity(query.artists.join(" "), creditedArtists.join(" "));
    const durationScore = durationSimilarity(query.durationSeconds, numberValue(recording.length));
    if (
      minimumProviderScore > 0
        ? titleScore !== 1 || artistScore < 0.85
        : titleScore < 0.94 || artistScore < 0.7
    )
      return [];
    return [{ id, score: titleScore * 0.5 + artistScore * 0.35 + durationScore * 0.15 }];
  });
  return scored.toSorted(
    (left, right) => right.score - left.score || left.id.localeCompare(right.id),
  )[0];
}

function selectRelease(
  recording: Record<string, unknown>,
  expectedAlbum?: string,
): Record<string, unknown> | undefined {
  const recordingTitle = cleanValue(recording.title) ?? "";
  const releases = arrayValue(recording.releases)
    .map(asRecord)
    .filter((release) => {
      const secondary = arrayValue(asRecord(release["release-group"])["secondary-types"])
        .map(cleanValue)
        .filter((value): value is string => value !== undefined);
      return !secondary.some((value) => /^(?:compilation|dj-mix|mixtape\/street)$/iu.test(value));
    });
  return releases
    .map((release) => {
      const group = asRecord(release["release-group"]);
      const type = cleanValue(group["primary-type"])?.toLocaleLowerCase("en-US");
      const title = cleanValue(release.title) ?? "";
      let score = release.status === "Official" ? 20 : 0;
      if (expectedAlbum) score += identitySimilarity(expectedAlbum, title) * 30;
      else score += identitySimilarity(recordingTitle, title) * 15;
      if (type === "single" || type === "ep") score += 12;
      else if (type === "album") score += 8;
      if (release.country === "XW") score += 2;
      return { release, score, date: cleanValue(release.date) ?? "9999" };
    })
    .toSorted((left, right) => right.score - left.score || left.date.localeCompare(right.date))[0]
    ?.release;
}

function releaseLabel(release: Record<string, unknown>): string | undefined {
  return arrayValue(release["label-info"])
    .map(asRecord)
    .map((info) => cleanValue(asRecord(info.label).name))
    .find((label) => label !== undefined && label !== "[no label]");
}

function consensusGenre(sources: Record<string, unknown>[]): string | undefined {
  const counts = new Map<string, { name: string; count: number }>();
  for (const source of sources) {
    for (const value of arrayValue(source.genres)) {
      const genre = asRecord(value);
      const name = cleanValue(genre.name);
      const count = numberValue(genre.count) ?? 0;
      if (!name || count <= 0) continue;
      const key = name.toLocaleLowerCase("en-US");
      const prior = counts.get(key);
      counts.set(key, { name: prior?.name ?? name, count: (prior?.count ?? 0) + count });
    }
  }
  const ranked = [...counts.values()].toSorted(
    (left, right) => right.count - left.count || left.name.localeCompare(right.name),
  );
  const first = ranked[0];
  if (!first || first.count < 2 || first.count === ranked[1]?.count) return undefined;
  return first.name;
}

function artistNames(recording: Record<string, unknown>): string[] {
  return arrayValue(recording["artist-credit"])
    .map(asRecord)
    .map((credit) => cleanValue(credit.name) ?? cleanValue(asRecord(credit.artist).name))
    .filter((name): name is string => name !== undefined);
}

function identitySimilarity(left: string, right: string): number {
  const expected = normalizeMatchText(left);
  const actual = normalizeMatchText(right);
  if (!expected || !actual) return 0;
  if (expected === actual) return 1;
  if (expected.includes(actual) || actual.includes(expected)) return 0.95;
  const expectedTokens = new Set(expected.split(" "));
  const actualTokens = new Set(actual.split(" "));
  const matched = [...expectedTokens].filter((token) => actualTokens.has(token)).length;
  return matched / Math.max(expectedTokens.size, actualTokens.size);
}

function durationSimilarity(
  expectedSeconds: number | undefined,
  actualMs: number | undefined,
): number {
  if (!expectedSeconds || !actualMs) return 0.5;
  const difference = Math.abs(expectedSeconds - actualMs / 1000);
  return Math.max(0, 1 - difference / Math.max(10, expectedSeconds * 0.08));
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

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanValue(value: unknown): string | undefined {
  const cleaned = typeof value === "string" ? value.trim() : "";
  return cleaned || undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function nonnegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${label} must be a nonnegative integer`);
  return value;
}
