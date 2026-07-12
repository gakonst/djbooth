import { isAbortError, TracksError } from "../errors.js";
import { parseTimestamp } from "../time.js";
import type {
  ChartTrack,
  ChartTracks,
  DatabaseTrack,
  DatabaseTracklist,
  FindTracklistResult,
  LatestTracklists,
  SearchTracklists,
  TracklistSummary,
} from "../types.js";

export const DEFAULT_PARSE_API_BASE =
  "https://api.parse.bot/scraper/b93889bc-63b3-4524-8ff6-be513ab4401a";

export interface Tracklists1001ClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

/** Typed client for Parse's managed, unofficial 1001Tracklists wrapper. */
export class Tracklists1001Client {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #signal?: AbortSignal;

  constructor(options: Tracklists1001ClientOptions) {
    if (!options.apiKey) {
      throw new TracksError("AUTH_REQUIRED", "PARSE_API_KEY is required for 1001Tracklists access");
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_PARSE_API_BASE).replace(/\/$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (options.signal) this.#signal = options.signal;
  }

  async get(url: string): Promise<DatabaseTracklist> {
    return parseTracklist(await this.#request("get_tracklist", { url }));
  }

  async findByMediaUrl(mediaUrl: string): Promise<FindTracklistResult> {
    const value = await this.#request("find_by_media_url", { url: normalizeMediaUrl(mediaUrl) });
    const record = asRecord(value);
    if (record.found === false) return { found: false };
    const nested = record.tracklist ?? record.result ?? value;
    return { found: true, ...parseTracklist(nested) };
  }

  async search(title: string, uploader?: string): Promise<SearchTracklists> {
    const value = await this.#request("search_tracklists", {
      title,
      ...(uploader ? { uploader } : {}),
    });
    return { items: parseSummaries(value) };
  }

  async latest(): Promise<LatestTracklists> {
    return { items: parseSummaries(await this.#request("list_latest")) };
  }

  async charts(type: "weekly" | "trending" | "mostheard" = "weekly"): Promise<ChartTracks> {
    const value = await this.#request("list_charts", { type });
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
  }

  async #request(endpoint: string, params: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(`${this.#baseUrl}/${endpoint}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { "X-API-Key": this.#apiKey },
        ...(this.#signal ? { signal: this.#signal } : {}),
      });
    } catch (error) {
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

export function databaseTracklistToEntries(tracklist: DatabaseTracklist) {
  return tracklist.tracks.map((track, index) => {
    const startSeconds = track.timestamp ? parseTimestamp(track.timestamp) : undefined;
    const songLink = firstLink(track.links);
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
    };
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
  return {
    order,
    ...(isId === undefined ? {} : { isId }),
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

function firstLink(links: DatabaseTrack["links"]): string | undefined {
  if (Array.isArray(links)) return links.find((link) => typeof link === "string");
  if (links && typeof links === "object")
    return Object.values(links).find((link) => typeof link === "string");
  return undefined;
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
  if (typeof record.error === "string") return record.error;
  const error = asRecord(record.error);
  return typeof error.message === "string" ? error.message : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
