import { mkdir, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  DEFAULT_YOUTUBE_SEARCH_RESULTS,
  ExtractorRegistry,
  MAX_YOUTUBE_SEARCH_RESULTS,
  downloadMedia,
  nativeFallbackFor,
  searchYoutube,
  type MediaInfo,
  type NativeDownloadOptions,
  type NativeDownloadResult,
  type YoutubeSearchOptions,
  type YoutubeSearchResult,
  YtdlpError,
} from "@gakonst/ytdlp-ts";

import { JsonDiskCache, type CacheMode, type CacheStats } from "../cache.js";
import type {
  BackendAvailability,
  IndividualDownload,
  TrackAcquirer,
} from "../acquire-manifest.js";
import type {
  ScoredYoutubeCandidate,
  YoutubeSearchCandidate,
  YoutubeTarget,
} from "../acquisition.js";
import { probeAudio } from "../acquisition.js";

export type YtdlpMediaInfo = {
  id: string;
  title: string;
  webpage_url?: string;
  original_url?: string;
  url?: string;
  extractor?: string;
  uploader?: string;
  artist?: string;
  creator?: string;
  duration?: number;
  entries?: YtdlpMediaInfo[];
  formats?: Array<{
    ext?: string;
    acodec?: string;
    vcodec?: string;
  }>;
};

export type YtdlpReferenceClient = {
  inspect(
    url: string,
    options?: {
      playlist?: boolean;
      flatPlaylist?: boolean;
      extractorArgs?: string[];
      cookiesFromBrowser?: string;
    },
  ): Promise<YtdlpMediaInfo>;
  download(
    url: string,
    options?: {
      playlist?: boolean;
      format?: string;
      output?: string;
      paths?: string;
      noOverwrites?: boolean;
      continueDownload?: boolean;
      retries?: number;
      fragmentRetries?: number;
      extractAudio?: boolean;
      audioFormat?: string;
      audioQuality?: string;
      embedMetadata?: boolean;
      extractorArgs?: string[];
      cookiesFromBrowser?: string;
    },
  ): Promise<{ files: string[]; stdout: string; stderr: string }>;
};

export type YtdlpNativeAcquirerOptions = {
  /** An explicitly registered reference downloader may try a fresh rejected CDN URL. */
  allowReferenceFallback?: boolean;
  searchLimit?: number;
  cache?: JsonDiskCache | false;
  cacheMode?: CacheMode;
  searchTtlMs?: number;
  signal?: AbortSignal;
};

export type YtdlpNativeAcquirerDependencies = {
  searchYoutube(query: string, options?: YoutubeSearchOptions): Promise<YoutubeSearchResult[]>;
  extract(url: string, context?: { signal?: AbortSignal }): Promise<MediaInfo>;
  downloadMedia(info: MediaInfo, options?: NativeDownloadOptions): Promise<NativeDownloadResult>;
  probeAudio(path: string): Promise<unknown>;
};

const defaultNativeDependencies: YtdlpNativeAcquirerDependencies = {
  searchYoutube,
  extract: (url, context) => new ExtractorRegistry().extract(url, context),
  downloadMedia,
  probeAudio,
};

/** Native-only ytdlp-ts adapter. It never constructs or invokes ReferenceClient. */
export class YtdlpNativeAcquirer implements TrackAcquirer {
  readonly backend = "ytdlp" as const;
  readonly #searchLimit: number;
  readonly #cache: JsonDiskCache | undefined;
  readonly #cacheMode: CacheMode;
  readonly #searchTtlMs: number;
  readonly #signal: AbortSignal | undefined;
  readonly #allowReferenceFallback: boolean;
  readonly #dependencies: YtdlpNativeAcquirerDependencies;

  constructor(
    options: YtdlpNativeAcquirerOptions = {},
    dependencies: Partial<YtdlpNativeAcquirerDependencies> = {},
  ) {
    this.#searchLimit = boundedSearchLimit(options.searchLimit);
    this.#cacheMode = options.cacheMode ?? "default";
    this.#cache =
      options.cache === false
        ? undefined
        : (options.cache ??
          new JsonDiskCache({
            namespace: "youtube-native-search-v1",
            ...(options.cacheMode ? { mode: options.cacheMode } : {}),
          }));
    this.#searchTtlMs = options.searchTtlMs ?? 6 * 60 * 60 * 1000;
    this.#signal = options.signal;
    this.#allowReferenceFallback = options.allowReferenceFallback ?? false;
    this.#dependencies = { ...defaultNativeDependencies, ...dependencies };
  }

  cacheStats(): CacheStats | undefined {
    return this.#cache?.snapshot();
  }

  availability(): Promise<BackendAvailability> {
    return Promise.resolve({ available: true });
  }

  shouldContinueAfterError(error: unknown) {
    // download() has already re-extracted and retried a rejected media URL.
    // Preserve native-only behavior unless the caller opted into another engine.
    if (this.#allowReferenceFallback && isForbiddenMediaError(error)) return undefined;
    return nativeFallbackFor(error) ?? false;
  }

  async search(target: YoutubeTarget): Promise<YoutubeSearchCandidate[]> {
    const query = target.searchQuery ?? [...target.artists, target.title].join(" ").trim();
    const load = async () =>
      sanitizeNativeSearchResults(
        await this.#dependencies.searchYoutube(query, {
          limit: this.#searchLimit,
          ...(this.#signal ? { signal: this.#signal } : {}),
        }),
      );
    const results = this.#cache
      ? await this.#cache.getOrLoad(
          {
            schemaVersion: 1,
            kind: "native-youtube-search",
            query,
            limit: this.#searchLimit,
          },
          load,
          { ttlMs: this.#searchTtlMs, mode: this.#cacheMode },
        )
      : await load();
    return sanitizeNativeSearchResults(results);
  }

  async download(
    candidate: ScoredYoutubeCandidate,
    destinationDirectory: string,
    basename: string,
  ): Promise<IndividualDownload> {
    await mkdir(destinationDirectory, { recursive: true });
    const existing = await existingOutput(destinationDirectory, basename);
    if (existing) {
      try {
        await this.#dependencies.probeAudio(existing);
        return {
          path: existing,
          source: candidate.source,
          engine: "native",
          temporary: true,
          qualityNote: "Resumed a previously completed native ytdlp-ts staging artifact.",
        };
      } catch {
        await rm(existing, { force: true });
      }
    }

    const context = this.#signal ? { signal: this.#signal } : {};
    let info = await this.#dependencies.extract(candidate.source, context);
    assertMediaIdentity(info, candidate.id);
    const downloadOptions: NativeDownloadOptions = {
      format: "bestaudio[ext=m4a]",
      paths: destinationDirectory,
      output: `${basename}.%(ext)s`,
      noOverwrites: true,
      continueDownload: true,
      retries: 5,
      writeInfoJson: false,
      writeThumbnail: false,
      ...(this.#signal ? { signal: this.#signal } : {}),
    };
    let result: NativeDownloadResult;
    try {
      result = await this.#dependencies.downloadMedia(info, downloadOptions);
    } catch (error) {
      if (!isForbiddenMediaError(error)) throw error;
      const refreshed = await this.#dependencies.extract(candidate.source, context);
      assertMediaIdentity(refreshed, info.id);
      assertMediaIdentity(refreshed, candidate.id);
      info = refreshed;
      result = await this.#dependencies.downloadMedia(info, downloadOptions);
    }
    const path = await findOutputFile(result.files, destinationDirectory, basename);
    return {
      path,
      source: candidate.source,
      engine: "native",
      temporary: true,
      transcoded: false,
      qualityNote: "Downloaded direct source AAC/M4A with the TypeScript-native ytdlp-ts engine.",
    };
  }
}

function assertMediaIdentity(info: MediaInfo, expected: string): void {
  if (info.id === expected) return;
  const soundcloudID = /^soundcloud:tracks:(\d+)$/.exec(expected)?.[1];
  if (info.extractor === "soundcloud" && soundcloudID === info.id) return;
  throw new YtdlpError(
    "YOUTUBE_IDENTITY_MISMATCH",
    `Native inspection returned '${info.id}' for '${expected}'`,
  );
}

function isForbiddenMediaError(error: unknown): boolean {
  return (
    error instanceof YtdlpError && error.code === "HTTP_ERROR" && error.details?.status === 403
  );
}

export class YtdlpReferenceAcquirer implements TrackAcquirer {
  readonly backend = "ytdlp" as const;
  readonly requiresPriorCapabilityFailure: boolean;
  readonly #client: YtdlpReferenceClient;
  readonly #searchLimit: number;
  readonly #cache: JsonDiskCache | undefined;
  readonly #cacheMode: CacheMode;
  readonly #searchTtlMs: number;
  readonly #metadataTtlMs: number;
  readonly #searchProviders: readonly ("youtube" | "soundcloud")[];
  readonly #cookiesFromBrowser: string | undefined;

  constructor(
    client: YtdlpReferenceClient,
    options: {
      searchLimit?: number;
      cache?: JsonDiskCache | false;
      cacheMode?: CacheMode;
      searchTtlMs?: number;
      metadataTtlMs?: number;
      requiresPriorCapabilityFailure?: boolean;
      searchProviders?: readonly ("youtube" | "soundcloud")[];
      cookiesFromBrowser?: string;
    } = {},
  ) {
    this.#client = client;
    this.#cookiesFromBrowser = options.cookiesFromBrowser;
    this.#searchProviders = options.searchProviders ?? ["youtube"];
    this.requiresPriorCapabilityFailure = options.requiresPriorCapabilityFailure ?? false;
    this.#searchLimit = options.searchLimit ?? 10;
    this.#cacheMode = options.cacheMode ?? "default";
    this.#cache =
      options.cache === false
        ? undefined
        : (options.cache ??
          new JsonDiskCache({
            namespace: "youtube-metadata-v1",
            ...(options.cacheMode ? { mode: options.cacheMode } : {}),
          }));
    this.#searchTtlMs = options.searchTtlMs ?? 6 * 60 * 60 * 1000;
    this.#metadataTtlMs = options.metadataTtlMs ?? 24 * 60 * 60 * 1000;
  }

  cacheStats(): CacheStats | undefined {
    return this.#cache?.snapshot();
  }

  availability(): Promise<BackendAvailability> {
    return Promise.resolve({ available: true });
  }

  async search(target: YoutubeTarget): Promise<YoutubeSearchCandidate[]> {
    const query = target.searchQuery ?? [...target.artists, target.title].join(" ");
    // Provider search treats every credit as a required term. Uploads often
    // credit only the main artist; scoring still checks the complete identity.
    const queries = [
      ...new Set([
        query,
        ...(!target.searchQuery && target.artists.length > 1
          ? [[target.artists[0], target.title].join(" ")]
          : []),
      ]),
    ];
    const inspectOptions: Parameters<YtdlpReferenceClient["inspect"]>[1] = {
      flatPlaylist: true,
    };
    const results = await Promise.allSettled(
      this.#searchProviders.flatMap((provider) =>
        queries.map((searchQuery) =>
          this.#inspect(
            "search",
            `${provider === "soundcloud" ? "scsearch" : "ytsearch"}${this.#searchLimit}:${searchQuery}`,
            inspectOptions,
            this.#searchTtlMs,
          ),
        ),
      ),
    );
    const successful = results.filter((result) => result.status === "fulfilled");
    if (!successful.length) {
      throw new AggregateError(
        results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        "All media searches failed",
      );
    }
    return successful
      .flatMap((result) => result.value.entries ?? [])
      .flatMap((entry) => {
        const source = mediaUrl(entry);
        if (!source || !entry.id || !entry.title) return [];
        return [
          {
            id: entry.id,
            source,
            title: entry.title,
            ...((entry.artist ?? entry.creator) ? { artist: entry.artist ?? entry.creator } : {}),
            ...(entry.uploader ? { uploader: entry.uploader } : {}),
            ...(entry.duration === undefined ? {} : { durationSeconds: entry.duration }),
          },
        ];
      });
  }

  async download(
    candidate: ScoredYoutubeCandidate,
    destinationDirectory: string,
    basename: string,
  ): Promise<IndividualDownload> {
    await mkdir(destinationDirectory, { recursive: true });
    const existing = await existingOutput(destinationDirectory, basename);
    if (existing) {
      try {
        await probeAudio(existing);
        return {
          path: existing,
          source: candidate.source,
          engine: "reference",
          temporary: true,
          qualityNote: "Resumed a previously completed yt-dlp staging artifact.",
        };
      } catch {
        await rm(existing, { force: true });
      }
    }
    const inspectOptions: Parameters<YtdlpReferenceClient["inspect"]>[1] = {
      playlist: false,
    };
    const info = await this.#inspect(
      "media",
      candidate.source,
      inspectOptions,
      this.#metadataTtlMs,
    );
    const directM4a = hasDirectM4a(info);
    const result = await this.#client.download(candidate.source, {
      ...(this.#cookiesFromBrowser ? { cookiesFromBrowser: this.#cookiesFromBrowser } : {}),
      playlist: false,
      format: directM4a ? "bestaudio[ext=m4a]/bestaudio/best" : "bestaudio/best",
      paths: destinationDirectory,
      output: `${basename}.%(ext)s`,
      noOverwrites: true,
      continueDownload: true,
      retries: 5,
      fragmentRetries: 5,
      extractAudio: true,
      audioFormat: "m4a",
      audioQuality: "0",
      embedMetadata: false,
    });
    const path = await findOutputFile(result.files, destinationDirectory, basename);
    return {
      path,
      source: candidate.source,
      engine: "reference",
      temporary: true,
      transcoded: !directM4a,
      qualityNote: directM4a
        ? "Downloaded the source AAC/M4A audio and stream-copied tags without re-encoding."
        : "No AAC/M4A source was advertised; yt-dlp converted the best available audio to M4A for Rekordbox compatibility.",
    };
  }

  async #inspect(
    kind: "search" | "media",
    source: string,
    options: Parameters<YtdlpReferenceClient["inspect"]>[1],
    ttlMs: number,
  ): Promise<YtdlpMediaInfo> {
    if (this.#cookiesFromBrowser) {
      return this.#client.inspect(source, {
        ...options,
        cookiesFromBrowser: this.#cookiesFromBrowser,
      });
    }
    if (!this.#cache || isSensitiveMediaSource(source)) {
      return this.#client.inspect(source, options);
    }
    const cached = await this.#cache.getOrLoad(
      { schemaVersion: 2, kind, source, options },
      async () => {
        const inspected = await this.#client.inspect(source, options);
        return {
          cacheable: kind === "search" || !containsSensitivePageUrl(inspected),
          value: sanitizeMediaInfo(inspected),
        };
      },
      {
        ttlMs,
        mode: this.#cacheMode,
        shouldStore: (result) => result.cacheable,
      },
    );
    return cached.value;
  }
}

function boundedSearchLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_YOUTUBE_SEARCH_RESULTS;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("searchLimit must be a positive integer");
  }
  return Math.min(value, MAX_YOUTUBE_SEARCH_RESULTS);
}

type NativeSearchIdentity = Pick<
  YoutubeSearchResult,
  "id" | "title" | "uploader" | "durationSeconds"
>;

function sanitizeNativeSearchResults(
  results: readonly NativeSearchIdentity[],
): YoutubeSearchCandidate[] {
  const seen = new Set<string>();
  return results.flatMap((result) => {
    if (
      typeof result.id !== "string" ||
      !/^[\w-]{11}$/u.test(result.id) ||
      typeof result.title !== "string" ||
      !result.title.trim() ||
      seen.has(result.id)
    ) {
      return [];
    }
    seen.add(result.id);
    return [
      {
        id: result.id,
        source: `https://www.youtube.com/watch?v=${result.id}`,
        title: result.title.trim(),
        ...(typeof result.uploader === "string" && result.uploader.trim()
          ? { uploader: result.uploader.trim() }
          : {}),
        ...(typeof result.durationSeconds === "number" &&
        Number.isFinite(result.durationSeconds) &&
        result.durationSeconds > 0
          ? { durationSeconds: result.durationSeconds }
          : {}),
      },
    ];
  });
}

function sanitizeMediaInfo(info: YtdlpMediaInfo): YtdlpMediaInfo {
  const webpageUrl = stablePageUrl(info.webpage_url) ?? stablePageUrl(info.url);
  const originalUrl = stablePageUrl(info.original_url);
  return {
    id: info.id,
    title: info.title,
    ...(webpageUrl ? { webpage_url: webpageUrl } : {}),
    ...(originalUrl ? { original_url: originalUrl } : {}),
    ...(info.extractor ? { extractor: info.extractor } : {}),
    ...(info.uploader ? { uploader: info.uploader } : {}),
    ...(info.artist ? { artist: info.artist } : {}),
    ...(info.creator ? { creator: info.creator } : {}),
    ...(info.duration === undefined ? {} : { duration: info.duration }),
    ...(info.entries
      ? {
          entries: info.entries
            .filter((entry) => !containsSensitivePageUrl(entry))
            .map(sanitizeMediaInfo),
        }
      : {}),
    ...(info.formats
      ? {
          formats: info.formats.map((format) => ({
            ...(format.ext ? { ext: format.ext } : {}),
            ...(format.acodec ? { acodec: format.acodec } : {}),
            ...(format.vcodec ? { vcodec: format.vcodec } : {}),
          })),
        }
      : {}),
  };
}

function stablePageUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!/(^|\.)(?:youtube\.com|youtu\.be|soundcloud\.com)$/iu.test(url.hostname)) return undefined;
    if (/(^|\.)soundcloud\.com$/iu.test(url.hostname) && isPrivateSoundCloudUrl(url)) {
      return undefined;
    }
    const videoId =
      /(^|\.)youtube\.com$/iu.test(url.hostname) && url.pathname === "/watch"
        ? url.searchParams.get("v")
        : undefined;
    url.search = "";
    if (videoId) url.searchParams.set("v", videoId);
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function containsSensitivePageUrl(info: YtdlpMediaInfo): boolean {
  return (
    isSensitiveMediaSource(info.webpage_url) ||
    isSensitiveMediaSource(info.original_url) ||
    (info.entries?.some(containsSensitivePageUrl) ?? false)
  );
}

function isSensitiveMediaSource(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (/(^|\.)soundcloud\.com$/iu.test(url.hostname) && isPrivateSoundCloudUrl(url)) return true;
    return [...url.searchParams.keys()].some((key) =>
      /(?:^|[_-])(?:auth|expires?|key|secret|signature|token)(?:$|[_-])/iu.test(key),
    );
  } catch {
    return false;
  }
}

function isPrivateSoundCloudUrl(url: URL): boolean {
  const pathname = safelyDecodePathname(url.pathname);
  const segments = pathname.split("/").filter(Boolean);
  if (segments.slice(2).some((segment) => /^s-/iu.test(segment))) return true;
  return [...url.searchParams.keys()].some((key) =>
    /(?:^|[_-])(?:auth|expires?|key|secret|signature|token)(?:$|[_-])/iu.test(key),
  );
}

function safelyDecodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

async function existingOutput(directory: string, basename: string): Promise<string | undefined> {
  const files = await readdir(directory);
  const file = files.find(
    (candidate) =>
      candidate.startsWith(`${basename}.`) && candidate.toLocaleLowerCase("en-US").endsWith(".m4a"),
  );
  return file ? join(directory, file) : undefined;
}

export function unavailableTrackAcquirer(backend: "slsk" | "ytdlp", reason: string): TrackAcquirer {
  return {
    backend,
    availability: () => Promise.resolve({ available: false, reason }),
    search: () => Promise.resolve([]),
    download: () => Promise.reject(new Error(`${backend} unavailable: ${reason}`)),
  };
}

function mediaUrl(info: YtdlpMediaInfo): string | undefined {
  if (info.webpage_url) return info.webpage_url;
  if (info.original_url?.startsWith("http")) return info.original_url;
  if (info.url?.startsWith("http")) return info.url;
  if (/youtube/iu.test(info.extractor ?? "") || /^[\w-]{11}$/u.test(info.id)) {
    return `https://www.youtube.com/watch?v=${info.id}`;
  }
  return undefined;
}

function hasDirectM4a(info: YtdlpMediaInfo): boolean {
  return (info.formats ?? []).some((format) => {
    return (
      format.ext === "m4a" &&
      format.acodec !== undefined &&
      format.acodec !== "none" &&
      (format.vcodec === undefined || format.vcodec === "none")
    );
  });
}

async function findOutputFile(
  reported: readonly string[],
  directory: string,
  basename: string,
): Promise<string> {
  const reportedM4a = reported.find((path) => path.toLocaleLowerCase("en-US").endsWith(".m4a"));
  if (reportedM4a) {
    return isAbsolute(reportedM4a) ? reportedM4a : resolve(directory, reportedM4a);
  }
  const files = await readdir(directory);
  const existing = files.find(
    (file) => file.startsWith(`${basename}.`) && file.toLocaleLowerCase("en-US").endsWith(".m4a"),
  );
  if (!existing) throw new Error(`yt-dlp did not report an M4A output for ${basename}`);
  return join(directory, existing);
}
