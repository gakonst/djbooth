import { JsonDiskCache, type CacheMode, type CacheStats } from "../cache.js";

export type SpotifyRawClient = {
  raw<T = unknown>(
    method: string,
    path: string,
    options?: {
      query?: Record<
        string,
        string | number | boolean | readonly (string | number | boolean)[] | undefined
      >;
      signal?: AbortSignal;
    },
  ): Promise<T | undefined>;
};

export type CachedSpotifyClientOptions = {
  cache?: JsonDiskCache | false;
  /** Non-secret account/market fingerprint. Caching is disabled when omitted. */
  cacheScope?: string;
  cacheMode?: CacheMode;
  searchTtlMs?: number;
  trackTtlMs?: number;
};

/** TTL-bounded cache for public Spotify search and track metadata responses. */
export class CachedSpotifyClient implements SpotifyRawClient {
  readonly #client: SpotifyRawClient;
  readonly #cache: JsonDiskCache | undefined;
  readonly #cacheMode: CacheMode;
  readonly #cacheScope: string | undefined;
  readonly #searchTtlMs: number;
  readonly #trackTtlMs: number;

  constructor(client: SpotifyRawClient, options: CachedSpotifyClientOptions = {}) {
    this.#client = client;
    this.#cacheMode = options.cacheMode ?? "default";
    this.#cacheScope = options.cacheScope?.trim() || undefined;
    this.#cache =
      options.cache === false || !this.#cacheScope
        ? undefined
        : (options.cache ??
          new JsonDiskCache({
            namespace: "spotify-metadata-v2",
            ...(options.cacheMode ? { mode: options.cacheMode } : {}),
          }));
    this.#searchTtlMs = options.searchTtlMs ?? 6 * 60 * 60 * 1000;
    this.#trackTtlMs = options.trackTtlMs ?? 24 * 60 * 60 * 1000;
  }

  cacheStats(): CacheStats | undefined {
    return this.#cache?.snapshot();
  }

  async raw<T = unknown>(
    method: string,
    path: string,
    options?: Parameters<SpotifyRawClient["raw"]>[2],
  ): Promise<T | undefined> {
    const normalizedMethod = method.toUpperCase();
    const normalizedPath = path.replace(/^\/+|\/+$/gu, "");
    const ttlMs = cacheTtl(normalizedMethod, normalizedPath, this.#searchTtlMs, this.#trackTtlMs);
    if (!this.#cache || ttlMs === undefined) {
      return this.#client.raw<T>(method, path, options);
    }
    return this.#cache.getOrLoad(
      {
        method: normalizedMethod,
        path: normalizedPath,
        query: options?.query ?? {},
        scope: this.#cacheScope,
      },
      () => this.#client.raw<T>(method, path, options),
      { ttlMs, mode: this.#cacheMode },
    );
  }
}

function cacheTtl(
  method: string,
  path: string,
  searchTtlMs: number,
  trackTtlMs: number,
): number | undefined {
  if (method !== "GET") return undefined;
  if (path === "search") return searchTtlMs;
  if (/^playlists\/[^/]+(?:\/items)?$/u.test(path)) return searchTtlMs;
  if (/^(?:albums|artists|tracks)\/[^/]+$/u.test(path)) return trackTtlMs;
  return undefined;
}
