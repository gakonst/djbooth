import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { parseSoundcloudHydration, type MediaInfo, type ReferenceClient } from "@gakonst/ytdlp-ts";

import { JsonDiskCache, type CacheMode, type CacheStats } from "./cache.js";
import { AppleMetadataClient } from "./apple-metadata.js";
import type { CatalogMetadata, CatalogMetadataQuery } from "./catalog-metadata.js";
import { DeezerMetadataClient } from "./deezer-metadata.js";
import type { SpotifyRawClient } from "./integrations/spotify-cache.js";
import {
  isSafeSpotifyAutomaticMatch,
  parseSpotifySearchTracks,
  scoreSpotifyCandidates,
  type SpotifyScoringTarget,
  type SpotifyTrackCandidate,
} from "./spotify-enrichment.js";

export type ExactSourceProvider =
  | "apple"
  | "bandcamp"
  | "deezer"
  | "linkpage"
  | "sidecar"
  | "soundcloud"
  | "spotify"
  | "youtube";

export type ExactTrackSource = {
  provider: Exclude<ExactSourceProvider, "sidecar">;
  url: string;
  origin: "manifest" | "rekordbox-comment";
};

export type ExactSourceMetadata = {
  title?: string | undefined;
  artist?: string | undefined;
  album?: string | undefined;
  label?: string | undefined;
  genre?: string | undefined;
  isrc?: string | undefined;
  releaseDate?: string | undefined;
  durationSeconds?: number | undefined;
  relatedUrls?: string[] | undefined;
};

export type ExactSourceMetadataClient = {
  provider: ExactSourceProvider;
  supports(url: string): boolean;
  lookup(url: string): Promise<ExactSourceMetadata | undefined>;
  lookupCatalog?(query: CatalogMetadataQuery): Promise<CatalogMetadata | undefined>;
  cacheStats(): CacheStats | undefined;
};

type JsonRecord = Record<string, unknown>;

/** Exact metadata from public SoundCloud track hydration; no OAuth or stream resolution required. */
export class SoundCloudMetadataClient implements ExactSourceMetadataClient {
  readonly provider = "soundcloud" as const;
  readonly #cache: JsonDiskCache | undefined;
  readonly #fetch: typeof globalThis.fetch;

  constructor(
    options: {
      cache?: JsonDiskCache | false;
      cacheMode?: CacheMode;
      fetch?: typeof globalThis.fetch;
    } = {},
  ) {
    this.#cache =
      options.cache === false
        ? undefined
        : (options.cache ??
          new JsonDiskCache({
            namespace: "soundcloud-source-metadata-v3",
            defaultTtlMs: 7 * 24 * 60 * 60 * 1000,
            ...(options.cacheMode ? { mode: options.cacheMode } : {}),
          }));
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  supports(url: string): boolean {
    return sourceProvider(url) === this.provider;
  }

  cacheStats(): CacheStats | undefined {
    return this.#cache?.snapshot();
  }

  async lookup(source: string): Promise<ExactSourceMetadata | undefined> {
    if (!this.supports(source)) return undefined;
    const url = canonicalSourceUrl(source);
    const load = async () => (await this.#lookup(url)) ?? null;
    const value = this.#cache
      ? await this.#cache.getOrLoad({ operation: "soundcloud-track-v2", url }, load, {
          ttlMs: (result) => (result === null ? 6 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000),
        })
      : await load();
    return value ?? undefined;
  }

  async #lookup(url: string): Promise<ExactSourceMetadata | undefined> {
    const response = await this.#fetch(url, {
      headers: { accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`SoundCloud metadata request failed: HTTP ${String(response.status)} ${url}`);
    }
    const hydration = parseSoundcloudHydration(await response.text());
    const track = record(hydration.find((item) => item.hydratable === "sound")?.data);
    if (!Object.keys(track).length) return undefined;
    const publisher = record(track.publisher_metadata);
    const user = record(track.user);
    const releaseDate = dateOnly(track.release_date);
    const purchaseUrl = httpUrl(track.purchase_url);
    const descriptionUrls = clean(track.description)
      ? purchaseLinks(clean(track.description)!)
      : [];
    return compactMetadata({
      title: clean(track.title),
      artist: clean(track.metadata_artist) ?? clean(publisher.artist) ?? clean(user.username),
      album: clean(publisher.album_title),
      label: clean(track.label_name) ?? clean(publisher.publisher),
      genre: sourceGenre(track.genre, track.tag_list),
      isrc: clean(track.isrc) ?? clean(publisher.isrc),
      releaseDate,
      durationSeconds: milliseconds(track.full_duration) ?? milliseconds(track.duration),
      ...(purchaseUrl || descriptionUrls.length
        ? { relatedUrls: [...new Set([...(purchaseUrl ? [purchaseUrl] : []), ...descriptionUrls])] }
        : {}),
    });
  }
}

/** Exact Spotify track, release, and credited-artist metadata through the saved spots session. */
export class SpotifySourceMetadataClient implements ExactSourceMetadataClient {
  readonly provider = "spotify" as const;
  readonly #client: SpotifyRawClient & { cacheStats?: () => CacheStats | undefined };

  constructor(client: SpotifyRawClient & { cacheStats?: () => CacheStats | undefined }) {
    this.#client = client;
  }

  supports(url: string): boolean {
    return sourceProvider(url) === this.provider && spotifyTrackId(url) !== undefined;
  }

  cacheStats(): CacheStats | undefined {
    return this.#client.cacheStats?.();
  }

  async lookup(url: string): Promise<ExactSourceMetadata | undefined> {
    const id = spotifyTrackId(url);
    if (!id) return undefined;
    const track = record(await this.#client.raw("GET", `tracks/${id}`));
    if (!Object.keys(track).length) return undefined;
    const simplifiedAlbum = record(track.album);
    const albumId = clean(simplifiedAlbum.id);
    const artistIds = [
      ...new Set(
        array(track.artists)
          .map(record)
          .map((value) => clean(value.id))
          .filter((value): value is string => value !== undefined),
      ),
    ].slice(0, 5);
    const [album, artistRecords]: [JsonRecord, JsonRecord[]] = await Promise.all([
      albumId ? this.#client.raw("GET", `albums/${albumId}`).then(record) : Promise.resolve({}),
      Promise.all(
        artistIds.map((artistId) => this.#client.raw("GET", `artists/${artistId}`).then(record)),
      ),
    ]);
    const artists = array(track.artists)
      .map(record)
      .map((value) => clean(value.name))
      .filter((value): value is string => value !== undefined);
    return compactMetadata({
      title: clean(track.name),
      artist: artists.join(", ") || undefined,
      album: clean(album.name) ?? clean(simplifiedAlbum.name),
      label: clean(album.label),
      genre: spotifyGenre(album, artistRecords),
      isrc: clean(record(track.external_ids).isrc),
      releaseDate: clean(album.release_date) ?? clean(simplifiedAlbum.release_date),
      durationSeconds: milliseconds(track.duration_ms),
    });
  }

  async lookupCatalog(query: CatalogMetadataQuery): Promise<CatalogMetadata | undefined> {
    const title = spotifySearchTerm(query.title);
    const artists = spotifySearchTerm(query.artists.join(" "));
    const searches = query.isrc
      ? [`isrc:${query.isrc}`]
      : [`track:"${title}" artist:"${artists}"`, `${title} ${artists}`];
    const target: SpotifyScoringTarget = {
      title: query.title,
      artist: query.artists.join(", "),
      ...(query.isrc ? { isrc: query.isrc } : {}),
      ...(query.durationSeconds ? { durationMs: query.durationSeconds * 1_000 } : {}),
    };
    const candidates = new Map<string, SpotifyTrackCandidate>();
    let best: ReturnType<typeof scoreSpotifyCandidates>[number] | undefined;
    for (const search of searches) {
      const response = await this.#client.raw("GET", "search", {
        query: { q: search, type: "track", limit: 10 },
      });
      for (const candidate of parseSpotifySearchTracks(response))
        candidates.set(candidate.id, candidate);
      const safe = scoreSpotifyCandidates(target, [...candidates.values()]).filter(
        (candidate) =>
          candidate.score >= (query.isrc ? 1 : 0.82) &&
          isSafeSpotifyAutomaticMatch(target, candidate),
      );
      const selected = safe[0];
      if (selected && selected.score - (safe[1]?.score ?? 0) >= 0.05) {
        best = selected;
        break;
      }
    }
    if (!best) return undefined;
    const metadata = await this.lookup(`https://open.spotify.com/track/${best.id}`);
    if (!metadata) return undefined;
    return {
      ...(metadata.title ? { title: metadata.title } : {}),
      ...(metadata.artist ? { artist: metadata.artist } : {}),
      ...(metadata.album ? { album: metadata.album } : {}),
      ...(metadata.label ? { label: metadata.label } : {}),
      ...(metadata.genre ? { genre: metadata.genre } : {}),
      ...(metadata.isrc ? { isrc: metadata.isrc } : {}),
      ...(metadata.releaseDate ? { releaseDate: metadata.releaseDate } : {}),
      ...(metadata.durationSeconds ? { durationSeconds: metadata.durationSeconds } : {}),
      provider: this.provider,
      recordingId: best.id,
      matchedBy: query.isrc ? "isrc" : "artist-title",
    };
  }
}

/** Exact Apple Music/iTunes metadata from smart-link track IDs and UPCs. */
export class AppleSourceMetadataClient implements ExactSourceMetadataClient {
  readonly provider = "apple" as const;
  readonly #client: AppleMetadataClient;

  constructor(client: AppleMetadataClient) {
    this.#client = client;
  }

  supports(url: string): boolean {
    return sourceProvider(url) === this.provider || /^apple:upc:\d{8,14}$/u.test(url);
  }

  cacheStats(): CacheStats | undefined {
    return this.#client.cacheStats();
  }

  async lookup(url: string): Promise<ExactSourceMetadata | undefined> {
    const upc = /^apple:upc:(\d{8,14})$/u.exec(url)?.[1];
    const metadata = upc
      ? await this.#client.lookupUpc(upc)
      : await this.#client.lookupTrackUrl(url);
    return metadata ? compactMetadata(metadata) : undefined;
  }
}

/** Exact Deezer metadata reached through a provider or smart-link track URL. */
export class DeezerSourceMetadataClient implements ExactSourceMetadataClient {
  readonly provider = "deezer" as const;
  readonly #client: DeezerMetadataClient;

  constructor(client: DeezerMetadataClient) {
    this.#client = client;
  }

  supports(url: string): boolean {
    return sourceProvider(url) === this.provider || /^deezer:upc:\d{8,14}$/u.test(url);
  }

  cacheStats(): CacheStats | undefined {
    return this.#client.cacheStats();
  }

  async lookup(url: string): Promise<ExactSourceMetadata | undefined> {
    const upc = /^deezer:upc:(\d{8,14})$/u.exec(url)?.[1];
    const metadata = upc
      ? await this.#client.lookupAlbumUpc(upc)
      : await this.#client.lookupTrackUrl(url);
    if (!metadata) return undefined;
    return compactMetadata(metadata);
  }
}

/** Cached expansion of public music smart links into exact provider track URLs. */
export class LinkPageMetadataClient implements ExactSourceMetadataClient {
  readonly provider = "linkpage" as const;
  readonly #cache: JsonDiskCache | undefined;
  readonly #fetch: typeof globalThis.fetch;

  constructor(
    options: {
      cache?: JsonDiskCache | false;
      cacheMode?: CacheMode;
      fetch?: typeof globalThis.fetch;
    } = {},
  ) {
    this.#cache =
      options.cache === false
        ? undefined
        : (options.cache ??
          new JsonDiskCache({
            namespace: "music-linkpage-metadata-v3",
            defaultTtlMs: 7 * 24 * 60 * 60 * 1000,
            ...(options.cacheMode ? { mode: options.cacheMode } : {}),
          }));
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  supports(source: string): boolean {
    try {
      const host = new URL(source).hostname.replace(/^www\./u, "");
      return /(?:^|\.)(?:fanlink\.to|ffm\.to|hypeddit\.com|hypeddit\.link|lnk\.to|orcd\.co)$/iu.test(
        host,
      );
    } catch {
      return false;
    }
  }

  cacheStats(): CacheStats | undefined {
    return this.#cache?.snapshot();
  }

  async lookup(source: string): Promise<ExactSourceMetadata | undefined> {
    if (!this.supports(source)) return undefined;
    const url = canonicalSourceUrl(source);
    const load = async () => (await this.#lookup(url)) ?? null;
    const value = this.#cache
      ? await this.#cache.getOrLoad({ operation: "music-linkpage-v2", url }, load, {
          ttlMs: (result) => (result === null ? 6 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000),
        })
      : await load();
    return value ?? undefined;
  }

  async #lookup(url: string): Promise<ExactSourceMetadata | undefined> {
    const response = await this.#fetch(url, {
      headers: { accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
    });
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`Music link request failed: HTTP ${String(response.status)} ${url}`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) {
      throw new Error(`Music link response is too large: ${String(contentLength)} bytes ${url}`);
    }
    const html = (await response.text())
      .replaceAll("&amp;", "&")
      .replaceAll("\\u002F", "/")
      .replaceAll("\\u0026", "&")
      .replaceAll("\\/", "/");
    const providerUrls = [...html.matchAll(/https?:\/\/[^\s"'<>\\]+/gu)]
      .map((match) => match[0].replace(/[),.;]+$/u, ""))
      .filter((value) => sourceProvider(value) !== undefined)
      .map(canonicalSourceUrl)
      .filter((value, index, values) => values.indexOf(value) === index)
      .toSorted((left, right) => sourcePriority(left) - sourcePriority(right))
      .slice(0, 8);
    const upc = /\bscanUrl\s*:\s*\\?["']upc:(\d{8,14})/iu.exec(html)?.[1];
    const relatedUrls = [
      ...(upc ? [`apple:upc:${upc}`, `deezer:upc:${upc}`] : []),
      ...providerUrls,
    ].slice(0, 8);
    const releaseDate = dateOnly(/\breleaseDate\\?"?\s*:\s*\\?"([^"\\]+)/iu.exec(html)?.[1]);
    if (!relatedUrls.length && !releaseDate) return undefined;
    return compactMetadata({ releaseDate, relatedUrls });
  }
}

/** Cached full yt-dlp inspection for exact YouTube and Bandcamp acquisition URLs. */
export class ReferenceSourceMetadataClient implements ExactSourceMetadataClient {
  readonly provider: "bandcamp" | "youtube";
  readonly #cache: JsonDiskCache | undefined;
  readonly #reference: Pick<ReferenceClient, "inspect">;

  constructor(
    provider: "bandcamp" | "youtube",
    reference: Pick<ReferenceClient, "inspect">,
    options: { cache?: JsonDiskCache | false; cacheMode?: CacheMode } = {},
  ) {
    this.provider = provider;
    this.#reference = reference;
    this.#cache =
      options.cache === false
        ? undefined
        : (options.cache ??
          new JsonDiskCache({
            namespace: `${provider}-source-metadata-v1`,
            defaultTtlMs: 7 * 24 * 60 * 60 * 1000,
            ...(options.cacheMode ? { mode: options.cacheMode } : {}),
          }));
  }

  supports(url: string): boolean {
    return sourceProvider(url) === this.provider;
  }

  cacheStats(): CacheStats | undefined {
    return this.#cache?.snapshot();
  }

  async lookup(source: string): Promise<ExactSourceMetadata | undefined> {
    if (!this.supports(source)) return undefined;
    const url = canonicalSourceUrl(source);
    const load = async () => this.#inspect(url);
    const value = this.#cache
      ? await this.#cache.getOrLoad({ operation: "reference-inspect", url }, load, {
          ttlMs: (result) => (result === null ? 6 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000),
        })
      : await load();
    return value ?? undefined;
  }

  async #inspect(url: string): Promise<ExactSourceMetadata | null> {
    const info = (await this.#reference.inspect(url, { playlist: false })) as MediaInfo;
    if (!info?.id) return null;
    const artist = clean(info.artist) ?? clean(info.album_artist);
    const title = clean(info.track) ?? clean(info.title);
    const releaseDate = this.provider === "bandcamp" ? dateOnly(info.release_date) : undefined;
    const description = clean(info.description);
    return compactMetadata({
      title,
      artist,
      album: clean(info.album),
      label: clean(info.label),
      genre: preferredGenre([clean(info.genre), ...strings(info.genres)]),
      isrc: clean(info.isrc),
      releaseDate,
      durationSeconds: positiveNumber(info.duration),
      ...(description ? { relatedUrls: purchaseLinks(description) } : {}),
    });
  }
}

/** Local yt-dlp sidecars indexed by canonical source URL, independent of current media location. */
export class SidecarMetadataClient implements ExactSourceMetadataClient {
  readonly provider = "sidecar" as const;
  readonly #roots: string[];
  #index: Promise<Map<string, ExactSourceMetadata>> | undefined;

  constructor(roots: string[]) {
    this.#roots = roots.map((root) => resolve(root));
  }

  supports(url: string): boolean {
    return sourceProvider(url) !== undefined;
  }

  cacheStats(): undefined {
    return undefined;
  }

  async lookup(url: string): Promise<ExactSourceMetadata | undefined> {
    this.#index ??= buildSidecarIndex(this.#roots);
    return (await this.#index).get(canonicalSourceUrl(url));
  }
}

/** Parse only fields that identify an individual downloaded track, never a containing DJ set. */
export function exactSourcesFromRekordboxComment(comment: string | undefined): ExactTrackSource[] {
  if (!comment?.trim()) return [];
  const values: string[] = [];
  for (const line of comment.split(/\r?\n/u)) {
    const labeled = /^(?:Media source|Spotify URL):\s*(https?:\/\/\S+)\s*$/iu.exec(line.trim());
    if (labeled?.[1]) values.push(labeled[1]);
  }
  if (/^https?:\/\/\S+$/iu.test(comment.trim())) values.push(comment.trim());
  return uniqueSources(values, "rekordbox-comment");
}

export function exactSourcesFromUrls(
  values: Array<string | undefined>,
  origin: ExactTrackSource["origin"] = "manifest",
): ExactTrackSource[] {
  return uniqueSources(
    values.flatMap((value) => (value ? [value] : [])),
    origin,
  );
}

export function sourceProvider(
  source: string,
): Exclude<ExactSourceProvider, "sidecar"> | undefined {
  let hostname: string;
  try {
    hostname = new URL(source).hostname.replace(/^www\./u, "").toLocaleLowerCase("en-US");
  } catch {
    return undefined;
  }
  if (hostname === "soundcloud.com" || hostname === "snd.sc") return "soundcloud";
  if (
    (hostname === "music.apple.com" || hostname === "itunes.apple.com") &&
    /^\d+$/u.test(new URL(source).searchParams.get("i") ?? "")
  )
    return "apple";
  if (hostname === "open.spotify.com") return "spotify";
  if (hostname === "deezer.com" && /^\/track\/\d+/u.test(new URL(source).pathname)) return "deezer";
  if (hostname === "youtube.com" || hostname === "youtu.be" || hostname === "music.youtube.com")
    return "youtube";
  if (hostname === "bandcamp.com" || hostname.endsWith(".bandcamp.com")) return "bandcamp";
  return undefined;
}

export function canonicalSourceUrl(source: string): string {
  const url = new URL(source);
  url.hash = "";
  for (const key of Array.from(url.searchParams.keys())) {
    if (/^(?:si|utm_.+|go|app|at|ct|itsc.+|lid|cid|sr|src|ls)$/iu.test(key)) {
      url.searchParams.delete(key);
    }
  }
  url.hostname = url.hostname.toLocaleLowerCase("en-US");
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  return url.toString();
}

async function buildSidecarIndex(roots: string[]): Promise<Map<string, ExactSourceMetadata>> {
  const index = new Map<string, ExactSourceMetadata>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const path of await sidecarFiles(root)) {
      let value: JsonRecord;
      try {
        value = record(JSON.parse(await readFile(path, "utf8")));
      } catch {
        continue;
      }
      const extractor = clean(value.extractor_key) ?? clean(value.extractor);
      const metadata = compactMetadata({
        title: clean(value.track) ?? clean(value.title),
        artist: clean(value.artist) ?? clean(value.album_artist),
        album: clean(value.album) ?? clean(value.album_title),
        label: clean(value.label) ?? clean(value.label_name),
        genre: preferredGenre([clean(value.genre), ...strings(value.genres)]),
        isrc: clean(value.isrc),
        releaseDate: /youtube/iu.test(extractor ?? "") ? undefined : dateOnly(value.release_date),
        durationSeconds: positiveNumber(value.duration),
        ...(clean(value.description)
          ? { relatedUrls: purchaseLinks(clean(value.description)!) }
          : {}),
      });
      for (const source of [value.webpage_url, value.original_url]) {
        const url = httpUrl(source);
        if (url && sourceProvider(url)) index.set(canonicalSourceUrl(url), metadata);
      }
    }
  }
  return index;
}

async function sidecarFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [resolve(root)];
  while (pending.length) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".music-ts") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith(".info.json")) files.push(path);
    }
  }
  return files;
}

function uniqueSources(values: string[], origin: ExactTrackSource["origin"]): ExactTrackSource[] {
  const sources = new Map<string, ExactTrackSource>();
  for (const value of values) {
    const provider = sourceProvider(value);
    if (!provider) continue;
    const url = canonicalSourceUrl(value);
    sources.set(`${provider}:${url}`, { provider, url, origin });
  }
  return [...sources.values()];
}

function spotifyTrackId(source: string): string | undefined {
  try {
    const url = new URL(source);
    const match = /^\/track\/([\dA-Za-z]+)(?:\/|$)/u.exec(url.pathname);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function sourcePriority(source: string): number {
  if (source.startsWith("apple:upc:") || source.startsWith("deezer:upc:")) return 0;
  const provider = sourceProvider(source);
  return provider === "apple"
    ? 0
    : provider === "deezer"
      ? 1
      : provider === "spotify"
        ? 2
        : provider === "bandcamp"
          ? 3
          : provider === "soundcloud"
            ? 4
            : 5;
}

function spotifySearchTerm(value: string): string {
  return value.replaceAll(/["\\]/gu, " ").replace(/\s+/gu, " ").trim();
}

function sourceGenre(primary: unknown, tags: unknown): string | undefined {
  const explicit = preferredGenre([clean(primary)]);
  if (explicit) return explicit;
  return quotedTags(clean(tags)).find(looksLikeGenre);
}

function spotifyGenre(album: JsonRecord, artists: JsonRecord[]): string | undefined {
  const releaseGenre = preferredGenre(strings(album.genres));
  if (releaseGenre) return releaseGenre;
  const artistGenres = artists.map((artist) =>
    strings(artist.genres).filter((genre) => preferredGenre([genre]) !== undefined),
  );
  if (artistGenres.length === 1) return preferredGenre(artistGenres[0]!);
  const counts = new Map<string, { genre: string; count: number }>();
  for (const genres of artistGenres) {
    for (const genre of new Set(genres)) {
      const key = genre.toLocaleLowerCase("en-US");
      const prior = counts.get(key);
      counts.set(key, { genre: prior?.genre ?? genre, count: (prior?.count ?? 0) + 1 });
    }
  }
  const best = [...counts.values()].toSorted(
    (left, right) => right.count - left.count || left.genre.localeCompare(right.genre),
  )[0];
  return best && best.count >= 2 ? best.genre : undefined;
}

function looksLikeGenre(value: string): boolean {
  return /\b(?:acid|afro|ambient|breaks?|breakbeat|dance|deep|disco|drum\s*(?:and|&|n)\s*bass|dubstep|electro|funk|garage|house|indie|melodic|minimal|organic|progressive|soul|tech|techno|trance)\b/iu.test(
    value,
  );
}

function preferredGenre(values: Array<string | undefined>): string | undefined {
  return values
    .map(clean)
    .find(
      (value) =>
        value !== undefined &&
        !/^(?:dance\s*&\s*edm|dance|edm|electronic|music|other|none)$/iu.test(value),
    );
}

function quotedTags(value: string | undefined): string[] {
  if (!value) return [];
  const quoted = [...value.matchAll(/"([^"]+)"/gu)].map((match) => match[1]!);
  return quoted.length ? quoted : value.split(/\s+/u);
}

function purchaseLinks(description: string): string[] {
  const links: string[] = [];
  for (const line of description.split(/\r?\n/u).slice(0, 30)) {
    if (!/\b(?:buy|download|purchase|stream\s*\/\s*download)\b/iu.test(line)) continue;
    for (const match of line.matchAll(/https?:\/\/[^\s<>]+/gu)) {
      const value = match[0].replace(/[),.;]+$/u, "");
      if (httpUrl(value)) links.push(value);
    }
  }
  return [...new Set(links)].slice(0, 4);
}

function compactMetadata(value: ExactSourceMetadata): ExactSourceMetadata {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) =>
      Array.isArray(entry) ? entry.length > 0 : entry !== undefined,
    ),
  ) as ExactSourceMetadata;
}

function dateOnly(value: unknown): string | undefined {
  const text = clean(value);
  if (!text) return undefined;
  const compact = /^(\d{4})(\d{2})(\d{2})$/u.exec(text);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return /^\d{4}(?:-\d{2}(?:-\d{2})?)?/u.exec(text)?.[0];
}

function milliseconds(value: unknown): number | undefined {
  const number = positiveNumber(value);
  return number === undefined ? undefined : number / 1_000;
}

function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function httpUrl(value: unknown): string | undefined {
  const text = clean(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return /^https?:$/u.test(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function strings(value: unknown): string[] {
  return array(value)
    .map(clean)
    .filter((entry): entry is string => entry !== undefined);
}

function record(value: unknown): JsonRecord {
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
