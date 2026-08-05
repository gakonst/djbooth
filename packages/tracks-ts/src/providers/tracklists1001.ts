import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonDiskCache, type CacheMode, type CacheStats } from "../cache.js";
import { isAbortError, TracksError } from "../errors.js";
import { mapConcurrent, runProcess } from "../process.js";
import { parseTimestamp } from "../time.js";
import type {
  ChartTrack,
  ChartTracks,
  DatabaseTrack,
  DatabaseTrackSuggestion,
  DatabaseTracklist,
  FindTracklistResult,
  LatestTracklists,
  SearchTracklists,
  TrackMediaLink,
  TracklistEntry,
  TracklistSummary,
} from "../types.js";

export const DEFAULT_PARSE_API_BASE =
  "https://api.parse.bot/scraper/b93889bc-63b3-4524-8ff6-be513ab4401a";

export type Tracklists1001BrowserOptions = {
  /** Injected loader for tests or an embedding application. */
  loadHtml?: (url: string, signal?: AbortSignal) => Promise<string>;
  /** NanoCodex profile-session executable. */
  command?: string;
  sourceBrowser?: "brave" | "chrome";
  profile?: string;
  waitMs?: number;
};

export interface Tracklists1001ClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  cache?: JsonDiskCache | false;
  pageCache?: JsonDiskCache | false;
  mediaCache?: JsonDiskCache | false;
  cacheMode?: CacheMode;
  browser?: Tracklists1001BrowserOptions | false;
  mediaConcurrency?: number;
}

/**
 * Resolve and cache 1001Tracklists data through Parse, with an optional headed profile fallback
 * that also expands the page's exact per-track media identities.
 */
export class Tracklists1001Client {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #signal?: AbortSignal;
  readonly #cache: JsonDiskCache | undefined;
  readonly #pageCache: JsonDiskCache | undefined;
  readonly #mediaCache: JsonDiskCache | undefined;
  readonly #cacheMode: CacheMode;
  readonly #browser: Tracklists1001BrowserOptions | undefined;
  readonly #mediaConcurrency: number;

  constructor(options: Tracklists1001ClientOptions) {
    if (!options.apiKey) {
      throw new TracksError("AUTH_REQUIRED", "PARSE_API_KEY is required for 1001Tracklists access");
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_PARSE_API_BASE).replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (options.signal) this.#signal = options.signal;
    this.#cache =
      options.cache === false
        ? undefined
        : (options.cache ??
          new JsonDiskCache({
            namespace: "1001tracklists-v6",
            ...(options.cacheMode ? { mode: options.cacheMode } : {}),
          }));
    this.#pageCache =
      options.cache === false || options.pageCache === false
        ? undefined
        : (options.pageCache ??
          new JsonDiskCache({
            namespace: "1001tracklists-pages-v1",
            ...(options.cacheMode ? { mode: options.cacheMode } : {}),
          }));
    this.#mediaCache =
      options.cache === false || options.mediaCache === false
        ? undefined
        : (options.mediaCache ??
          new JsonDiskCache({
            namespace: "1001tracklists-media-v2",
            ...(options.cacheMode ? { mode: options.cacheMode } : {}),
          }));
    this.#cacheMode = options.cacheMode ?? "default";
    this.#browser = options.browser === false ? undefined : options.browser;
    this.#mediaConcurrency = boundedInteger(options.mediaConcurrency ?? 8, 1, 32);
  }

  cacheStats(): CacheStats | undefined {
    return mergeCacheStats(
      this.#cache?.snapshot(),
      this.#pageCache?.snapshot(),
      this.#mediaCache?.snapshot(),
    );
  }

  async get(url: string): Promise<DatabaseTracklist> {
    const load = () => this.#getUncached(url);
    if (!this.#cache) return load();
    return this.#cache.getOrLoad(
      { baseUrl: this.#baseUrl, endpoint: "get_tracklist", params: { url }, resolver: "v2" },
      load,
      { ttlMs: 7 * 24 * 60 * 60 * 1000, mode: this.#cacheMode },
    );
  }

  async findByMediaUrl(mediaUrl: string): Promise<FindTracklistResult> {
    return this.#request("find_by_media_url", { url: normalizeMediaUrl(mediaUrl) }, (value) => {
      const record = asRecord(value);
      if (record.found === false) return { found: false };
      const nested = record.tracklist ?? record.result ?? value;
      return { found: true, ...parseTracklist(nested) };
    });
  }

  async search(title: string, uploader?: string): Promise<SearchTracklists> {
    const normalizedTitle = normalizeSearchText(title);
    const normalizedUploader = uploader ? normalizeSearchText(uploader) : undefined;
    return this.#request(
      "search_tracklists",
      { title: normalizedTitle, ...(normalizedUploader ? { uploader: normalizedUploader } : {}) },
      (value) => ({ items: parseSummaries(value) }),
      {
        cacheKey: {
          title: normalizedTitle.toLocaleLowerCase("en-US"),
          ...(normalizedUploader
            ? { uploader: normalizedUploader.toLocaleLowerCase("en-US") }
            : {}),
        },
      },
    );
  }

  async latest(): Promise<LatestTracklists> {
    return this.#request("list_latest", {}, (value) => ({ items: parseSummaries(value) }));
  }

  async charts(type: "weekly" | "trending" | "mostheard" = "weekly"): Promise<ChartTracks> {
    return this.#request("list_charts", { type }, (value) => {
      const record = asRecord(value);
      const rawItems = arrayFrom(record.items ?? record.tracks ?? record.chart ?? value);
      const items: ChartTrack[] = rawItems.map((item, index) => {
        const row = asRecord(item);
        const rank = numberValue(row.rank) ?? index + 1;
        return {
          name: stringValue(row.name ?? row.title, `chart item ${index + 1} name`),
          url: stringValue(row.url ?? row.href, `chart item ${index + 1} URL`),
          rank,
        };
      });
      return { chart: typeof record.chart === "string" ? record.chart : type, items };
    });
  }

  async #getUncached(url: string): Promise<DatabaseTracklist> {
    try {
      const endpoint = new URL(`${this.#baseUrl}/get_tracklist`);
      return parseTracklist(await this.#requestUncached(endpoint, { url }));
    } catch (error) {
      if (!this.#browser || !canUseBrowserFallback(error)) throw error;
      return this.#getFromBrowser(url);
    }
  }

  async #getFromBrowser(url: string): Promise<DatabaseTracklist> {
    const html = this.#pageCache
      ? await this.#pageCache.getOrLoad(
          { url, renderer: "headed-profile-v1" },
          () => loadBrowserHtml(url, this.#browser!, this.#signal),
          {
            ttlMs: 7 * 24 * 60 * 60 * 1000,
            mode: this.#cacheMode,
            shouldStore: isCompleteTracklistHtml,
          },
        )
      : await loadBrowserHtml(url, this.#browser!, this.#signal);
    const parsed = parse1001TracklistHtml(html, url);
    const mediaByItem = new Map<string, TrackMediaLink[]>();
    const mediaItems = [
      ...new Map(
        parsed.tracks.flatMap((track) =>
          track.mediaItemId && track.mediaObjectId
            ? [
                [
                  `${String(track.mediaObjectId)}:${track.mediaItemId}`,
                  { objectId: track.mediaObjectId, itemId: track.mediaItemId },
                ] as const,
              ]
            : [],
        ),
      ).values(),
    ];
    await mapConcurrent(mediaItems, this.#mediaConcurrency, async ({ objectId, itemId }) => {
      const links = await this.#loadMediaLinks(url, objectId, itemId);
      mediaByItem.set(`${String(objectId)}:${itemId}`, links);
    });
    parsed.tracks = parsed.tracks.map((track) => {
      if (!track.mediaItemId || !track.mediaObjectId) return track;
      const media = preferredMediaOrder(
        mediaByItem.get(`${String(track.mediaObjectId)}:${track.mediaItemId}`) ?? [],
        track.durationSeconds,
      );
      return {
        ...track,
        ...(media.length ? { media, links: legacyLinks(media) } : {}),
      };
    });
    return parsed;
  }

  async #loadMediaLinks(
    tracklistUrl: string,
    mediaObjectId: 5 | 8,
    mediaItemId: string,
  ): Promise<TrackMediaLink[]> {
    const origin = new URL(tracklistUrl).origin;
    const load = async () => {
      const url = new URL("/ajax/get_medialink.php", origin);
      url.searchParams.set("idObject", String(mediaObjectId));
      url.searchParams.set("idItem", mediaItemId);
      let response: Response;
      try {
        response = await this.#fetch(url, {
          headers: { Accept: "application/json", Referer: tracklistUrl },
          ...(this.#signal ? { signal: this.#signal } : {}),
        });
      } catch (error) {
        if (isAbortError(error)) throw error;
        throw new TracksError(
          "API_ERROR",
          `1001Tracklists media request failed for ${mediaItemId}: ${errorMessage(error)}`,
          { cause: error, retryable: true },
        );
      }
      const text = await response.text();
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        throw new TracksError(
          "INVALID_RESPONSE",
          `1001Tracklists media response was non-JSON (${response.status}): ${text.slice(0, 300)}`,
          { retryable: response.status >= 500 },
        );
      }
      if (!response.ok) {
        throw new TracksError(
          "API_ERROR",
          `1001Tracklists media request failed for ${mediaItemId}: HTTP ${response.status}`,
          { retryable: response.status === 429 || response.status >= 500, details: body },
        );
      }
      return body;
    };
    const raw = this.#mediaCache
      ? await this.#mediaCache.getOrLoad({ origin, mediaObjectId, mediaItemId }, load, {
          ttlMs: 30 * 24 * 60 * 60 * 1000,
          mode: this.#cacheMode,
          shouldStore: isValidMediaResponse,
        })
      : await load();
    return parseMediaLinks(raw);
  }

  async #request<T>(
    endpoint: string,
    params: Record<string, string>,
    parse: (value: unknown) => T,
    options: { cacheKey?: unknown } = {},
  ): Promise<T> {
    const url = new URL(`${this.#baseUrl}/${endpoint}`);

    if (this.#cache) {
      return this.#cache.getOrLoad(
        {
          baseUrl: this.#baseUrl,
          endpoint,
          params: options.cacheKey ?? params,
        },
        async () => parse(await this.#requestUncached(url, params)),
        { ttlMs: (value) => cacheTtl(endpoint, value), mode: this.#cacheMode },
      );
    }
    return parse(await this.#requestUncached(url, params));
  }

  async #requestUncached(url: URL, params: Record<string, string>): Promise<unknown> {
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: { "X-API-Key": this.#apiKey },
        ...(this.#signal ? { signal: this.#signal } : {}),
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw new TracksError("API_ERROR", `1001Tracklists request failed: ${errorMessage(error)}`, {
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
        `1001Tracklists wrapper returned non-JSON (${response.status}): ${text.slice(0, 300)}`,
        { retryable: response.status >= 500 },
      );
    }
    const record = asRecord(body);
    if (!response.ok || record.status === "error" || record.error) {
      const message = apiMessage(record) ?? `HTTP ${response.status}`;
      throw new TracksError("API_ERROR", `1001Tracklists wrapper error: ${message}`, {
        retryable: response.status === 429 || response.status >= 500,
        details: body,
      });
    }
    if (!("data" in record)) {
      throw new TracksError("INVALID_RESPONSE", "1001Tracklists wrapper response is missing data", {
        details: body,
      });
    }
    return record.data;
  }
}

function cacheTtl(endpoint: string, value: unknown): number {
  if (endpoint === "get_tracklist") return 7 * 24 * 60 * 60 * 1000;
  if (endpoint === "find_by_media_url" && isFindMiss(value)) return 15 * 60 * 1000;
  if (endpoint === "search_tracklists" && isSearchMiss(value)) return 15 * 60 * 1000;
  if (endpoint === "find_by_media_url" || endpoint === "search_tracklists")
    return 6 * 60 * 60 * 1000;
  return 15 * 60 * 1000;
}

function isFindMiss(value: unknown): boolean {
  return asRecord(value).found === false;
}

function isSearchMiss(value: unknown): boolean {
  return arrayFrom(asRecord(value).items).length === 0;
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function databaseTracklistToEntries(tracklist: DatabaseTracklist) {
  const entries: TracklistEntry[] = tracklist.tracks.map((track, index) => {
    const startSeconds = track.timestamp ? parseTimestamp(track.timestamp) : undefined;
    const songLink = firstTrackLink(track);
    const mediaLinks = preferredMediaOrder(track.media ?? [], track.durationSeconds);
    return {
      order: track.order || index + 1,
      ...(track.isId === undefined ? {} : { isId: track.isId }),
      ...(track.timestamp ? { timestamp: normalizeTimestamp(track.timestamp) } : {}),
      ...(startSeconds === undefined ? {} : { startSeconds }),
      ...(track.artist ? { artist: track.artist } : {}),
      ...(track.title ? { title: track.title } : {}),
      ...(track.mix ? { mix: track.mix } : {}),
      ...(track.label ? { label: track.label } : {}),
      ...(songLink ? { songLink } : {}),
      ...(mediaLinks.length ? { mediaLinks } : {}),
    };
  });
  return entries.map((entry, index) => {
    const startSeconds = entry.startSeconds;
    if (startSeconds === undefined || entry.endSeconds !== undefined) return entry;
    const nextStart = entries
      .slice(index + 1)
      .map((candidate) => candidate.startSeconds)
      .find(
        (candidate): candidate is number => candidate !== undefined && candidate > startSeconds,
      );
    const endSeconds = nextStart ?? tracklist.durationSeconds;
    return endSeconds !== undefined && endSeconds > startSeconds ? { ...entry, endSeconds } : entry;
  });
}

function parseTracklist(value: unknown): DatabaseTracklist {
  const outer = asRecord(value);
  const record = asRecord(outer.tracklist ?? outer.result ?? value);
  const event = asRecord(record.event);
  const tracks = arrayFrom(record.tracks ?? record.entries).map(parseTrack);
  const url = stringValue(record.url ?? outer.url, "tracklist URL");
  const durationSeconds = numberValue(record.durationSeconds ?? record.duration_seconds);
  const djName = nullableString(event.djName ?? record.djName);
  const lineup = arrayFrom(event.lineup).filter((item): item is string => typeof item === "string");
  const suggestions = parseSuggestions(record.suggestions);
  return {
    url,
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    event: {
      name: stringValue(event.name ?? record.title ?? outer.title, "event name"),
      ...(typeof event.date === "string" ? { date: event.date } : {}),
      ...(typeof djName === "string" ? { djName } : {}),
      lineup: lineup.length ? lineup : typeof djName === "string" ? [djName] : [],
    },
    tracks,
    ...(suggestions.length ? { suggestions } : {}),
  };
}

function parseTrack(value: unknown, index: number): DatabaseTrack {
  const row = asRecord(value);
  const order = numberValue(row.order ?? row.position) ?? index + 1;
  const cueSeconds = numberValue(row.cueSeconds ?? row.cue_seconds);
  const artist = nullableString(row.artist);
  const title = stripArtistPrefix(artist, nullableString(row.title));
  const label = nullableString(row.label);
  const mix = nullableString(row.mix);
  const timestamp = nullableString(row.timestamp ?? row.time);
  const isId = typeof row.isId === "boolean" ? row.isId : undefined;
  const durationSeconds = numberValue(row.durationSeconds ?? row.duration_seconds);
  const media = parseTrackMedia(row.media ?? row.mediaLinks);
  const mediaObjectId =
    row.mediaObjectId === 5 || row.mediaObjectId === 8 ? row.mediaObjectId : undefined;
  return {
    order,
    ...(isId === undefined ? {} : { isId }),
    ...(typeof row.positionId === "string" ? { positionId: row.positionId } : {}),
    ...(typeof row.trackId === "string" ? { trackId: row.trackId } : {}),
    ...(typeof row.mediaItemId === "string" ? { mediaItemId: row.mediaItemId } : {}),
    ...(mediaObjectId === undefined ? {} : { mediaObjectId }),
    ...(row.kind === "position" || row.kind === "mashup-part" ? { kind: row.kind } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(artist !== undefined ? { artist } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(mix !== undefined ? { mix } : {}),
    ...(cueSeconds !== undefined
      ? { timestamp: String(cueSeconds) }
      : timestamp !== undefined
        ? { timestamp }
        : {}),
    ...(isLinks(row.links) ? { links: row.links } : {}),
    ...(media.length ? { media } : {}),
  };
}

function parseSummaries(value: unknown): TracklistSummary[] {
  const record = asRecord(value);
  const items = arrayFrom(
    record.items ?? record.results ?? record.tracklists ?? record.latest ?? value,
  );
  return items.map((item, index) => {
    const row = asRecord(item);
    const durationSeconds = numberValue(row.durationSeconds ?? row.duration_seconds);
    return {
      title: stringValue(row.title ?? row.name, `result ${index + 1} title`),
      url: stringValue(row.url ?? row.href, `result ${index + 1} URL`),
      ...(typeof row.djName === "string"
        ? { djName: row.djName }
        : typeof row.uploader === "string"
          ? { djName: row.uploader }
          : {}),
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
    };
  });
}

function normalizeTimestamp(value: string): string {
  const seconds = parseTimestamp(value);
  if (seconds === undefined) return value;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = Math.floor(seconds % 60);
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, "0")).join(":");
}

function firstTrackLink(track: DatabaseTrack): string | undefined {
  const media = preferredMediaOrder(track.media ?? [], track.durationSeconds);
  for (const platform of ["soundcloud", "youtube", "spotify"]) {
    const link = media.find((candidate) => candidate.platform === platform);
    if (link) return link.url;
  }
  const links = track.links;
  if (Array.isArray(links)) return links.find((link) => typeof link === "string");
  if (links && typeof links === "object")
    return Object.values(links).find((link) => typeof link === "string");
  return undefined;
}

function preferredMediaOrder(
  media: readonly TrackMediaLink[],
  durationSeconds: number | undefined,
): TrackMediaLink[] {
  const copy = media.map((link) => ({ ...link }));
  if (durationSeconds === undefined) return copy;
  const spotify = copy
    .filter((link) => link.platform === "spotify")
    .toSorted(
      (left, right) =>
        mediaDurationDifference(left, durationSeconds) -
        mediaDurationDifference(right, durationSeconds),
    );
  let spotifyIndex = 0;
  return copy.map((link) => (link.platform === "spotify" ? spotify[spotifyIndex++]! : link));
}

function mediaDurationDifference(link: TrackMediaLink, durationSeconds: number): number {
  return link.durationSeconds === undefined
    ? Number.POSITIVE_INFINITY
    : Math.abs(link.durationSeconds - durationSeconds);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayFrom(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown, field: string): string {
  if (typeof value === "string" && value) return value;
  throw new TracksError("INVALID_RESPONSE", `1001Tracklists response is missing ${field}`);
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function stripArtistPrefix(
  artist: string | null | undefined,
  title: string | null | undefined,
): string | null | undefined {
  if (!artist || !title) return title;
  for (const separator of [" - ", " – ", " — "]) {
    const prefix = `${artist}${separator}`;
    if (title.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())) {
      return title.slice(prefix.length);
    }
  }
  return title;
}

function numberValue(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isLinks(value: unknown): value is Record<string, string> | string[] | null {
  if (value === null) return true;
  if (Array.isArray(value)) return value.every((item) => typeof item === "string");
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((item) => typeof item === "string")
  );
}

function apiMessage(record: Record<string, unknown>): string | undefined {
  if (typeof record.message === "string") return record.message;
  if (typeof record.detail === "string") return record.detail;
  if (typeof record.error === "string") return record.error;
  const error = asRecord(record.error);
  return typeof error.message === "string" ? error.message : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Parse a fully rendered 1001Tracklists page without trusting headless placeholder identities. */
export function parse1001TracklistHtml(html: string, requestedUrl: string): DatabaseTracklist {
  const rows = extractElementsByClass(html, "div", "tlpItem");
  if (!rows.length) {
    const pageText = stripHtml(html).slice(0, 240);
    throw new TracksError(
      "INVALID_RESPONSE",
      `1001Tracklists browser did not return a tracklist: ${pageText || "empty page"}`,
      {
        details: {
          url: requestedUrl,
          action:
            "Complete the one-time 1001Tracklists verification in the configured source browser, then retry.",
        },
      },
    );
  }

  let comparableRows = 0;
  let mismatchedRows = 0;
  const tracks = rows.map((row, index): DatabaseTrack => {
    const attributes = firstTagAttributes(row);
    const metaName = metaValue(row, "itemprop", "name");
    const metaArtist = metaValue(row, "itemprop", "byArtist");
    const visible = stripHtml(extractElementsByClass(row, "span", "trackValue")[0] ?? "");
    if (metaName && visible) {
      comparableRows += 1;
      if (comparableTrackText(metaName) !== comparableTrackText(visible)) mismatchedRows += 1;
    }
    const identity = parseHtmlIdentity(metaName ?? visible, metaArtist);
    const isId = attributes["data-isid"] === "true" || !identity.artist || !identity.title;
    const cue = numberValue(
      firstMatchingTagAttributes(row, "input", (item) => Boolean(item.id?.endsWith("_cue_seconds")))
        ?.value,
    );
    const mediaAttributes = firstTagByClassAttributes(row, "div", "mediaRow");
    const mediaItemId = mediaAttributes?.["data-trackid"] ?? mediaAttributes?.["data-tlp"];
    const mediaObjectId = mediaAttributes?.["data-trackid"]
      ? 5
      : mediaAttributes?.["data-tlp"]
        ? 8
        : undefined;
    const publisher = metaValue(row, "itemprop", "publisher");
    const label = publisher ? stripHtml(decodeHtml(publisher)) : undefined;
    const durationSeconds = parseIsoDuration(metaValue(row, "itemprop", "duration"));
    return {
      order: index + 1,
      isId,
      ...(attributes["data-id"] ? { positionId: attributes["data-id"] } : {}),
      ...(attributes["data-trackid"] ? { trackId: attributes["data-trackid"] } : {}),
      ...(mediaItemId ? { mediaItemId } : {}),
      ...(mediaObjectId ? { mediaObjectId } : {}),
      kind: attributes["data-mashpos"] === "true" ? "mashup-part" : "position",
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      ...(identity.artist ? { artist: identity.artist } : {}),
      ...(identity.title ? { title: identity.title } : {}),
      ...(identity.mix ? { mix: identity.mix } : {}),
      ...(label ? { label } : {}),
      ...(cue !== undefined && cue > 0 ? { timestamp: String(cue) } : {}),
    };
  });

  const mismatchLimit = Math.max(1, Math.ceil(comparableRows / 3));
  if (mismatchedRows >= mismatchLimit) {
    throw new TracksError(
      "INVALID_RESPONSE",
      `1001Tracklists returned ${mismatchedRows}/${comparableRows} mismatched placeholder identities; a headed profile session is required`,
      { details: { url: requestedUrl, mismatchedRows, comparableRows } },
    );
  }

  const canonical = metaValue(html, "property", "og:url") ?? canonicalLink(html) ?? requestedUrl;
  const titleElement = firstCapture(html, /<title\b[^>]*>([\s\S]*?)<\/title>/iu);
  const name =
    metaValue(html, "property", "og:title") ??
    (titleElement ? decodeHtml(titleElement) : canonical);
  const djName = name.split(/\s+@\s+/u)[0]?.trim();
  const lineup = djName
    ? djName
        .split(/\s+(?:&|b2b|vs\.?)\s+/iu)
        .map((artist) => artist.trim())
        .filter(Boolean)
    : [];
  const durationSeconds = pageDurationSeconds(html);
  const suggestions = parseHtmlSuggestions(html);
  const date = metaValue(html, "name", "dcterms.modified");
  return {
    url: canonical,
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    event: {
      name,
      ...(date ? { date } : {}),
      ...(djName ? { djName } : {}),
      lineup,
    },
    tracks,
    ...(suggestions.length ? { suggestions } : {}),
  };
}

async function loadBrowserHtml(
  url: string,
  browser: Tracklists1001BrowserOptions,
  signal?: AbortSignal,
): Promise<string> {
  if (browser.loadHtml) return browser.loadHtml(url, signal);
  if (!browser.command) {
    throw new TracksError(
      "TOOL_MISSING",
      "1001Tracklists needs a headed browser fallback; set TRACKS_1001_BROWSER_PATH to the NanoCodex profile-session executable",
      { exitCode: 127 },
    );
  }
  const directory = await mkdtemp(join(tmpdir(), "tracks-1001-browser-"));
  const output = join(directory, "tracklist.html");
  try {
    const args = [
      url,
      "--source-browser",
      browser.sourceBrowser ?? "chrome",
      "--headed",
      "--wait-ms",
      String(browser.waitMs ?? 6_000),
      "--html-output",
      output,
    ];
    if (browser.profile) args.push("--profile", browser.profile);
    await runProcess(browser.command, args, {
      ...(signal ? { signal } : {}),
      maxOutputBytes: 2 * 1024 * 1024,
    });
    return await readFile(output, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseHtmlIdentity(
  fullName: string | undefined,
  byArtist: string | undefined,
): { artist?: string; title?: string; mix?: string } {
  if (!fullName || /^(?:ID|\?)\s*[-–—]\s*(?:ID|\?)$/iu.test(fullName.trim())) return {};
  const split = splitTrackName(fullName);
  const artist = split.artist ?? byArtist?.trim();
  let title = split.title ?? stripArtistPrefix(artist, fullName)?.trim();
  if (!artist || !title) return {};
  const mixMatch = /\s+\(([^()]*(?:mix|remix|edit|rework|bootleg|dub|version)[^()]*)\)\s*$/iu.exec(
    title,
  );
  const mix = mixMatch?.[1]?.trim();
  if (mixMatch) title = title.slice(0, mixMatch.index).trim();
  return { artist, title, ...(mix ? { mix } : {}) };
}

function splitTrackName(value: string): { artist?: string; title?: string } {
  const match = /^(.+?)\s+[-–—]\s+(.+)$/u.exec(value.trim());
  return match ? { artist: match[1]!.trim(), title: match[2]!.trim() } : {};
}

function parseHtmlSuggestions(html: string): DatabaseTrackSuggestion[] {
  return extractElementsByClass(html, "div", "sugTog").flatMap((suggestion) => {
    const attributes = firstTagAttributes(suggestion);
    const id = attributes.id?.replace(/^sug_/u, "");
    const positionId = attributes["data-tlp"];
    const position = numberValue(attributes["data-pos"]);
    const type = numberValue(attributes["data-type"]);
    const text = stripHtml(
      firstCapture(
        suggestion,
        /<(?:div|span)\b[^>]*\bid=["']sug\d+_value["'][^>]*>([\s\S]*?)<\/(?:div|span)>/iu,
      ) ?? "",
    );
    if (!id || !positionId || position === undefined || type === undefined || !text) return [];
    const timestamp = stripHtml(
      firstCapture(
        suggestion,
        /<span\b[^>]*\bid=["']sug\d+_cue_value["'][^>]*>([\s\S]*?)<\/span>/iu,
      ) ?? "",
    );
    const startSeconds = timestamp ? parseTimestamp(timestamp) : undefined;
    const submitterCapture = firstCapture(
      suggestion,
      /href=["'][^"']*\/user\/([^/"']+)\/index\.html/iu,
    );
    const submitter = submitterCapture
      ? decodeHtml(submitterCapture)
      : /\bGuest\b/u.test(stripHtml(suggestion))
        ? "Guest"
        : undefined;
    return [
      {
        id,
        position: position + 1,
        positionId,
        type,
        text,
        ...(timestamp ? { timestamp: normalizeTimestamp(timestamp) } : {}),
        ...(startSeconds === undefined ? {} : { startSeconds }),
        ...(submitter ? { submitter } : {}),
      },
    ];
  });
}

function pageDurationSeconds(html: string): number | undefined {
  const videoIndex = html.search(/itemtype=["']https:\/\/schema\.org\/VideoObject["']/iu);
  if (videoIndex < 0) return undefined;
  const nearby = html.slice(videoIndex, videoIndex + 2_000);
  const duration = metaValue(nearby, "itemprop", "duration");
  return parseIsoDuration(duration);
}

function parseIsoDuration(duration: string | undefined): number | undefined {
  if (!duration) return undefined;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/iu.exec(duration);
  if (!match) return undefined;
  return Number(match[1] ?? 0) * 3_600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

function canonicalLink(html: string): string | undefined {
  for (const tag of html.match(/<link\b[^>]*>/giu) ?? []) {
    const attributes = parseAttributes(tag);
    if (attributes.rel === "canonical" && attributes.href) return attributes.href;
  }
  return undefined;
}

function metaValue(html: string, attribute: string, value: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/giu) ?? []) {
    const attributes = parseAttributes(tag);
    if (attributes[attribute] === value && attributes.content) return attributes.content;
  }
  return undefined;
}

function firstTagAttributes(html: string): Record<string, string> {
  return parseAttributes(html.match(/^<[^>]+>/u)?.[0] ?? "");
}

function firstTagByClassAttributes(
  html: string,
  tagName: string,
  className: string,
): Record<string, string> | undefined {
  for (const tag of html.match(new RegExp(`<${tagName}\\b[^>]*>`, "giu")) ?? []) {
    const attributes = parseAttributes(tag);
    if (classTokens(attributes.class).includes(className)) return attributes;
  }
  return undefined;
}

function firstMatchingTagAttributes(
  html: string,
  tagName: string,
  predicate: (attributes: Record<string, string>) => boolean,
): Record<string, string> | undefined {
  for (const tag of html.match(new RegExp(`<${tagName}\\b[^>]*>`, "giu")) ?? []) {
    const attributes = parseAttributes(tag);
    if (predicate(attributes)) return attributes;
  }
  return undefined;
}

function extractElementsByClass(html: string, tagName: string, className: string): string[] {
  const expression = new RegExp(`<\\/?${tagName}\\b[^>]*>`, "giu");
  const elements: string[] = [];
  let start = -1;
  let depth = 0;
  for (let match = expression.exec(html); match; match = expression.exec(html)) {
    const tag = match[0];
    const closing = tag.startsWith("</");
    if (start < 0) {
      if (closing) continue;
      const attributes = parseAttributes(tag);
      if (!classTokens(attributes.class).includes(className)) continue;
      start = match.index;
      depth = 1;
      continue;
    }
    depth += closing ? -1 : 1;
    if (depth !== 0) continue;
    elements.push(html.slice(start, expression.lastIndex));
    start = -1;
  }
  return elements;
}

function parseAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const body = tag.replace(/^<\/?[^\s>]+/u, "").replace(/\/?>$/u, "");
  const expression = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  for (let match = expression.exec(body); match; match = expression.exec(body)) {
    const name = match[1]?.toLocaleLowerCase("en-US");
    if (!name) continue;
    attributes[name] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function classTokens(value: string | undefined): string[] {
  return value?.split(/\s+/u).filter(Boolean) ?? [];
}

function stripHtml(value: string): string {
  return decodeHtml(value.replace(/<[^>]*>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim();
}

function decodeHtml(value: string | undefined): string {
  if (!value) return "";
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/giu,
    (_entity, decimal: string | undefined, hexadecimal: string | undefined, named: string) => {
      if (decimal) return String.fromCodePoint(Number(decimal));
      if (hexadecimal) return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      return (
        {
          amp: "&",
          apos: "'",
          gt: ">",
          lt: "<",
          nbsp: " ",
          quot: '"',
        }[named.toLocaleLowerCase("en-US")] ?? _entity
      );
    },
  );
}

function comparableTrackText(value: string): string {
  return decodeHtml(value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function firstCapture(value: string, expression: RegExp): string | undefined {
  return expression.exec(value)?.[1];
}

function parseMediaLinks(value: unknown): TrackMediaLink[] {
  const record = asRecord(value);
  if (record.noLinkFound === true) return [];
  const rows = [...arrayFrom(record.data), ...arrayFrom(record.more)];
  const links = rows.flatMap((row): TrackMediaLink[] => {
    const item = asRecord(row);
    if (item.isDeleted === true) return [];
    const source = typeof item.source === "string" ? item.source : undefined;
    const sourceId =
      typeof item.playerId === "string"
        ? item.playerId
        : typeof item.idLink === "string"
          ? item.idLink
          : numberValue(item.playerId ?? item.idLink)?.toString();
    if (!source || !sourceId) return [];
    const platform = MEDIA_SOURCE_NAMES[source] ?? `1001-source-${source}`;
    const player = typeof item.player === "string" ? item.player : undefined;
    const embedUrl = player ? iframeSource(player) : undefined;
    const url = canonicalMediaUrl(platform, sourceId, embedUrl);
    if (!url) return [];
    const durationSeconds = numberValue(item.duration);
    return [
      {
        platform,
        sourceId,
        url,
        ...(embedUrl ? { embedUrl } : {}),
        ...(durationSeconds !== undefined && durationSeconds > 0 ? { durationSeconds } : {}),
      },
    ];
  });
  return links.filter(
    (link, index) =>
      links.findIndex(
        (candidate) =>
          candidate.platform === link.platform &&
          candidate.sourceId === link.sourceId &&
          candidate.url === link.url,
      ) === index,
  );
}

const MEDIA_SOURCE_NAMES: Record<string, string> = {
  "1": "beatport",
  "2": "apple",
  "4": "traxsource",
  "6": "bandcamp",
  "10": "soundcloud",
  "13": "youtube",
  "36": "spotify",
};

function iframeSource(player: string): string | undefined {
  const tag = player.match(/<iframe\b[^>]*>/iu)?.[0];
  return tag ? parseAttributes(tag).src : undefined;
}

function canonicalMediaUrl(
  platform: string,
  sourceId: string,
  embedUrl: string | undefined,
): string | undefined {
  if (platform === "spotify") return `https://open.spotify.com/track/${sourceId}`;
  if (platform === "youtube")
    return `https://www.youtube.com/watch?v=${encodeURIComponent(sourceId)}`;
  if (platform === "soundcloud") return `https://api.soundcloud.com/tracks/${sourceId}`;
  if (platform === "beatport") return `https://www.beatport.com/track/-/${sourceId}`;
  if (platform === "traxsource") return `https://www.traxsource.com/track/${sourceId}`;
  if (platform === "apple" && embedUrl) {
    try {
      const url = new URL(embedUrl.replace("://embed.music.apple.com", "://music.apple.com"));
      url.search = "";
      url.searchParams.set("i", sourceId);
      return url.toString();
    } catch {
      return embedUrl;
    }
  }
  return embedUrl;
}

function legacyLinks(media: readonly TrackMediaLink[]): Record<string, string> {
  const links: Record<string, string> = {};
  const counts = new Map<string, number>();
  for (const item of media) {
    const count = (counts.get(item.platform) ?? 0) + 1;
    counts.set(item.platform, count);
    links[count === 1 ? item.platform : `${item.platform}:${count}`] = item.url;
  }
  return links;
}

function parseTrackMedia(value: unknown): TrackMediaLink[] {
  return arrayFrom(value).flatMap((candidate): TrackMediaLink[] => {
    const item = asRecord(candidate);
    if (
      typeof item.platform !== "string" ||
      typeof item.sourceId !== "string" ||
      typeof item.url !== "string"
    ) {
      return [];
    }
    const durationSeconds = numberValue(item.durationSeconds);
    return [
      {
        platform: item.platform,
        sourceId: item.sourceId,
        url: item.url,
        ...(typeof item.embedUrl === "string" ? { embedUrl: item.embedUrl } : {}),
        ...(durationSeconds !== undefined && durationSeconds > 0 ? { durationSeconds } : {}),
      },
    ];
  });
}

function parseSuggestions(value: unknown): DatabaseTrackSuggestion[] {
  return arrayFrom(value).flatMap((candidate): DatabaseTrackSuggestion[] => {
    const item = asRecord(candidate);
    const position = numberValue(item.position);
    const type = numberValue(item.type);
    if (
      typeof item.id !== "string" ||
      typeof item.positionId !== "string" ||
      position === undefined ||
      type === undefined ||
      typeof item.text !== "string"
    ) {
      return [];
    }
    const startSeconds = numberValue(item.startSeconds);
    return [
      {
        id: item.id,
        position,
        positionId: item.positionId,
        type,
        text: item.text,
        ...(typeof item.timestamp === "string" ? { timestamp: item.timestamp } : {}),
        ...(startSeconds === undefined ? {} : { startSeconds }),
        ...(typeof item.submitter === "string" ? { submitter: item.submitter } : {}),
      },
    ];
  });
}

function isCompleteTracklistHtml(html: string): boolean {
  return (
    typeof html === "string" && /\btlpItem\b/u.test(html) && /rel=["']canonical["']/iu.test(html)
  );
}

function isValidMediaResponse(value: unknown): boolean {
  const record = asRecord(value);
  return (
    record.noLinkFound === true ||
    (record.success === true && (Array.isArray(record.data) || Array.isArray(record.more)))
  );
}

function canUseBrowserFallback(error: unknown): boolean {
  return (
    error instanceof TracksError &&
    (error.code === "INVALID_RESPONSE" || (error.code === "API_ERROR" && error.retryable))
  );
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`mediaConcurrency must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function mergeCacheStats(...values: Array<CacheStats | undefined>): CacheStats | undefined {
  const present = values.filter((value): value is CacheStats => value !== undefined);
  if (!present.length) return undefined;
  return present.reduce<CacheStats>(
    (total, value) => ({
      hits: total.hits + value.hits,
      misses: total.misses + value.misses,
      writes: total.writes + value.writes,
      bypasses: total.bypasses + value.bypasses,
      coalesced: total.coalesced + value.coalesced,
      errors: total.errors + value.errors,
      readMs: total.readMs + value.readMs,
      loadMs: total.loadMs + value.loadMs,
      writeMs: total.writeMs + value.writeMs,
    }),
    {
      hits: 0,
      misses: 0,
      writes: 0,
      bypasses: 0,
      coalesced: 0,
      errors: 0,
      readMs: 0,
      loadMs: 0,
      writeMs: 0,
    },
  );
}

export function normalizeMediaUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.hostname === "youtu.be") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      if (id) return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    }
    if (/(^|\.)youtube\.com$/i.test(url.hostname)) {
      const parts = url.pathname.split("/").filter(Boolean);
      const id =
        url.searchParams.get("v") ??
        (parts[0] && ["live", "shorts", "embed"].includes(parts[0]) ? parts[1] : undefined);
      if (id) return `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
    }
    if (/(^|\.)soundcloud\.com$/i.test(url.hostname)) {
      return `https://soundcloud.com${url.pathname.replace(/\/$/, "")}`;
    }
  } catch {
    // Let the API validate non-URL values in direct client use.
  }
  return value;
}

export function isDatabaseMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    if (url.hostname === "youtu.be" || /(^|\.)youtube\.com$/i.test(url.hostname)) {
      return normalizeMediaUrl(value) !== value || url.searchParams.has("v");
    }
    if (/(^|\.)soundcloud\.com$/i.test(url.hostname)) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length < 2 || parts.some((part) => /^s-/i.test(part))) return false;
      return ![...url.searchParams.keys()].some((key) =>
        /(auth|expires|key|secret|signature|token)/i.test(key),
      );
    }
    return false;
  } catch {
    return false;
  }
}
