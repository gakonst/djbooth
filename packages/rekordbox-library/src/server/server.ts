import { randomBytes } from "node:crypto";
import {
  createReadStream,
  existsSync,
  realpathSync,
  type Stats,
  statSync,
  unwatchFile,
  watchFile,
} from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";

import { z } from "zod";

import type {
  ApiError,
  HostedMutationReceipt,
  HostedPlaylistMutation,
  HostedPlaylistsResponse,
  LibraryBootstrap,
  LibraryEvent,
  LibraryMutation,
  MutationReceipt,
  PlaylistItem,
  PromptContext,
  PromptPlan,
  TrackDetail,
  TrackSummary,
  TrackWaveform,
  TracksResponse,
  TrackSort,
  TrackSortField,
} from "../shared/types.js";
import {
  HostedPlaylistCapabilityError,
  HostedPlaylistConflictError,
  HostedPlaylistVerificationError,
  HostedTrackStreamUnavailableError,
  type HostedTrackStream,
  type HostedTrackStreamRequest,
} from "./hosted/types.js";
import {
  LibraryMutationConflictError,
  RekordboxLibraryService,
  type ArtworkAsset,
  type TrackFilter,
} from "./library.js";
import { planLibraryPrompt } from "./prompt.js";

const hostedMutationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("set-hosted-playlist-download"),
    playlistId: z.string().min(1).max(2_048),
    enabled: z.boolean(),
  }),
  z.object({
    type: z.literal("create-hosted-playlist"),
    provider: z.enum(["spotify", "soundcloud"]),
    name: z.string().trim().min(1).max(255),
  }),
  z.object({
    type: z.literal("rename-hosted-playlist"),
    playlistId: z.string().min(1).max(2_048),
    name: z.string().trim().min(1).max(255),
    expectedRevision: z.string().max(256).nullable(),
  }),
  z.object({
    type: z.literal("delete-hosted-playlist"),
    playlistId: z.string().min(1).max(2_048),
    expectedRevision: z.string().max(256).nullable(),
  }),
  z.object({
    type: z.literal("replace-hosted-playlist-tracks"),
    playlistId: z.string().min(1).max(2_048),
    remoteTrackIds: z.array(z.string().min(1).max(2_048)).max(10_000),
    expectedRevision: z.string().max(256).nullable(),
  }),
]);

const mutationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create-playlist"),
    name: z.string().trim().min(1).max(255),
    parentId: z.string().min(1).optional(),
    kind: z.enum(["playlist", "folder"]).optional(),
    seq: z.number().int().positive().max(1_000_000).optional(),
  }),
  z.object({
    type: z.literal("rename-playlist"),
    playlistId: z.string().min(1),
    name: z.string().trim().min(1).max(255),
  }),
  z.object({
    type: z.literal("delete-playlist"),
    playlistId: z.string().min(1),
    expectedPlaylistIds: z.array(z.string().min(1)).min(1).max(10_000),
  }),
  z.object({
    type: z.literal("set-track-color"),
    contentId: z.string().min(1),
    colorId: z.enum(["1", "2", "3", "4", "5", "6", "7", "8"]).nullable(),
  }),
  z.object({
    type: z.literal("update-track"),
    contentId: z.string().min(1),
    expectedRevision: z.string().min(1).max(128),
    metadata: z.object({
      title: z.string().trim().min(1).max(255),
      artist: z.string().trim().max(255).nullable(),
      album: z.string().trim().max(255).nullable(),
      genre: z.string().trim().max(255).nullable(),
      key: z.string().trim().max(64).nullable(),
      bpm: z.number().finite().positive().max(999).nullable(),
      rating: z.number().int().min(0).max(5),
      comment: z.string().trim().max(255).nullable(),
      releaseYear: z.number().int().min(0).max(9999).nullable(),
      isrc: z.string().trim().max(32).nullable(),
    }),
  }),
  z.object({
    type: z.literal("add-track"),
    playlistId: z.string().min(1),
    contentId: z.string().min(1),
    trackNumber: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("remove-track"),
    playlistId: z.string().min(1),
    membershipId: z.string().min(1),
  }),
  z.object({
    type: z.literal("move-track"),
    playlistId: z.string().min(1),
    membershipId: z.string().min(1),
    trackNumber: z.number().int().positive(),
  }),
  z.object({
    type: z.literal("replace-playlist-tracks"),
    playlistId: z.string().min(1),
    contentIds: z.array(z.string().min(1)).max(10_000),
    expectedMembershipIds: z.array(z.string().min(1)).max(10_000),
  }),
  z.object({
    type: z.literal("upsert-cue"),
    contentId: z.string().min(1),
    cue: z.object({
      id: z.string().min(1).optional(),
      kind: z.enum(["memory", "hot"]),
      type: z.enum(["cue", "loop"]),
      slot: z.number().int().min(1).max(16).optional(),
      startSeconds: z.number().finite().nonnegative(),
      endSeconds: z.number().finite().nonnegative().nullable().optional(),
      activeLoop: z.boolean().optional(),
      comment: z.string().max(255).optional(),
      color: z.number().int().min(0).max(255).nullable().optional(),
      colorTableIndex: z.number().int().min(0).max(62).nullable().optional(),
    }),
  }),
  z.object({
    type: z.literal("delete-cue"),
    contentId: z.string().min(1),
    cueId: z.string().min(1),
  }),
]);

const promptSchema = z.object({
  prompt: z.string().trim().min(1).max(2_000),
  context: z.object({
    playlistId: z.string().min(1).nullable(),
    trackId: z.string().min(1).nullable(),
    playheadSeconds: z.number().finite().nonnegative().nullable(),
  }),
});

export type LibraryApi = {
  close?(): void;
  getAudioPath(id: string): string;
  getArtwork(id: string): Promise<ArtworkAsset>;
  getBootstrap(csrfToken: string): LibraryBootstrap;
  getDatabasePath?(): string;
  getPlaylists(): PlaylistItem[];
  getTrack(id: string): TrackDetail;
  getWaveform(id: string): TrackWaveform;
  getTracks(options?: {
    filter?: TrackFilter;
    limit?: number;
    offset?: number;
    playlistId?: string;
    q?: string;
    sort?: TrackSort;
  }): TracksResponse;
  invalidate?(): void;
  mutate(mutation: LibraryMutation): Promise<MutationReceipt>;
};

export type HostedPlaylistApi = {
  close?(): void | Promise<void>;
  listPlaylists(): Promise<HostedPlaylistsResponse>;
  getTracks(playlistId: string): Promise<TrackSummary[]>;
  mirrorLocalMutation?(
    mutation: LibraryMutation,
    library: Pick<LibraryApi, "getTracks">,
  ): HostedMutationReceipt | undefined;
  onJobChanged?(listener: (event: { playlistId: string }) => void): () => void;
  streamTrack?(trackId: string, request?: HostedTrackStreamRequest): Promise<HostedTrackStream>;
  mutate(mutation: HostedPlaylistMutation): Promise<HostedMutationReceipt>;
};

export type LibraryServerOptions = {
  api?: LibraryApi;
  dbPath?: string;
  host?: string;
  key?: string;
  port?: number;
  staticDirectory?: string;
  writeEnabled?: boolean;
  hosted?: HostedPlaylistApi | false;
  hostedStatePath?: string;
};

export type RunningLibraryServer = {
  close(): Promise<void>;
  host: string;
  port: number;
  token: string;
  url: string;
};

const contentTypes: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const audioTypes: Readonly<Record<string, string>> = {
  ".aac": "audio/aac",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
};

const imageTypes: Readonly<Record<string, string>> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("cross-origin-resource-policy", "same-origin");
  response.setHeader("permissions-policy", "camera=(), geolocation=(), microphone=()");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-dns-prefetch-control", "off");
  response.setHeader("x-frame-options", "DENY");
}

function json(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const bytes = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": bytes.length,
    "content-type": "application/json; charset=utf-8",
  });
  response.end(request.method === "HEAD" ? undefined : bytes);
}

function apiError(
  status: number,
  code: string,
  message: string,
): { body: ApiError; status: number } {
  return { status, body: { error: { code, message } } };
}

function queryInteger(url: URL, name: string, fallback: number, maximum: number): number {
  const values = url.searchParams.getAll(name);
  if (!values.length) return fallback;
  if (values.length !== 1) throw new TypeError(`Invalid ${name}`);
  const raw = values[0]!;
  if (!/^\d+$/u.test(raw)) throw new TypeError(`Invalid ${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum)
    throw new TypeError(`Invalid ${name}`);
  return value;
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function assertRequestHost(request: IncomingMessage): void {
  if (!isLoopbackHost(request.headers.host)) throw new Error("Untrusted Host header");
}

function assertMutationRequest(request: IncomingMessage, token: string): void {
  if (request.headers["x-music-library-token"] !== token)
    throw new Error("Invalid library session token");
  const origin = request.headers.origin;
  if (origin && origin !== `http://${request.headers.host}`)
    throw new Error("Cross-origin library mutation rejected");
}

function assertLocalMediaRequest(request: IncomingMessage): void {
  const origin = request.headers.origin;
  if (origin && origin !== `http://${request.headers.host}`) {
    throw new Error("Cross-origin hosted media request rejected");
  }
  if (request.headers["sec-fetch-site"] === "cross-site") {
    throw new Error("Cross-origin hosted media request rejected");
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1024 * 1024)
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  if (!chunks.length) throw new TypeError("Request body is required");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function parseRange(
  header: string | undefined,
  size: number,
): { end: number; start: number } | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match) throw rangeNotSatisfiable(size);
  const startText = match[1]!;
  const endText = match[2]!;
  if (!startText && !endText) throw rangeNotSatisfiable(size);
  let start: number;
  let end: number;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw rangeNotSatisfiable(size);
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  )
    throw rangeNotSatisfiable(size);
  return { start, end: Math.min(end, size - 1) };
}

function rangeNotSatisfiable(size: number): HttpError {
  return new HttpError(416, "RANGE_NOT_SATISFIABLE", "Audio range is not satisfiable", {
    "content-range": `bytes */${size}`,
  });
}

async function inspectAudio(
  path: string,
): Promise<{ contentType: string; path: string; size: number }> {
  const extension = extname(path).toLocaleLowerCase();
  const contentType = audioTypes[extension];
  if (!contentType)
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Track is not a supported audio file");

  try {
    const requestedPath = resolve(path);
    const requestedSource = await lstat(requestedPath);
    if (requestedSource.isSymbolicLink() || !requestedSource.isFile())
      throw new Error("Audio source is not a regular file");
    const canonicalPath = await realpath(requestedPath);
    if (canonicalPath !== requestedPath) throw new Error("Audio source contains a symbolic link");
    const canonicalSource = await lstat(canonicalPath);
    if (canonicalSource.isSymbolicLink() || !canonicalSource.isFile())
      throw new Error("Audio source is not a regular file");
    return { contentType, path: canonicalPath, size: canonicalSource.size };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, "NOT_FOUND", "Track audio is unavailable");
  }
}

async function inspectArtwork(
  path: string,
): Promise<{ contentType: string; path: string; size: number }> {
  const contentType = imageTypes[extname(path).toLocaleLowerCase()];
  if (!contentType)
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Artwork is not a supported image file");
  try {
    const requestedPath = resolve(path);
    const requestedSource = await lstat(requestedPath);
    if (requestedSource.isSymbolicLink() || !requestedSource.isFile())
      throw new Error("Artwork source is not a regular file");
    const canonicalPath = await realpath(requestedPath);
    if (canonicalPath !== requestedPath) throw new Error("Artwork source contains a symbolic link");
    const canonicalSource = await lstat(canonicalPath);
    if (canonicalSource.isSymbolicLink() || !canonicalSource.isFile())
      throw new Error("Artwork source is not a regular file");
    return { contentType, path: canonicalPath, size: canonicalSource.size };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(404, "NOT_FOUND", "Track artwork is unavailable");
  }
}

async function streamHostedAudio(
  request: IncomingMessage,
  response: ServerResponse,
  hosted: HostedPlaylistApi,
  trackId: string,
): Promise<void> {
  if (!hosted.streamTrack)
    throw new HttpError(404, "STREAM_UNAVAILABLE", "Provider streaming is unavailable");
  const stream = await hosted.streamTrack(
    trackId,
    request.method === "GET" && request.headers.range ? { range: request.headers.range } : {},
  );
  const upstream = stream.response;
  const headers: Record<string, string> = {
    "cache-control": "private, no-store",
    "content-type": upstream.headers.get("content-type") ?? "audio/mpeg",
  };
  const forwardedHeaders =
    stream.kind === "progressive"
      ? ["accept-ranges", "content-length", "content-range"]
      : ["content-length"];
  for (const name of forwardedHeaders) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  if (stream.kind === "progressive" && upstream.status === 416) {
    upstream.body?.cancel().catch(() => undefined);
    delete headers["content-length"];
    response.writeHead(416, headers);
    response.end();
    return;
  }
  if (!upstream.ok || !upstream.body) {
    upstream.body?.cancel().catch(() => undefined);
    throw new HttpError(
      upstream.status === 403 ? 403 : 502,
      "STREAM_UNAVAILABLE",
      `Provider stream is unavailable (${String(upstream.status)})`,
    );
  }
  if (request.method === "HEAD") {
    response.writeHead(upstream.status, headers);
    await upstream.body.cancel();
    response.end();
    return;
  }
  if (stream.kind === "hls") {
    const body = absolutizeHlsManifest(await upstream.text(), upstream.url);
    const bytes = Buffer.from(body);
    headers["content-length"] = String(bytes.length);
    response.writeHead(upstream.status, headers);
    response.end(bytes);
    return;
  }
  response.writeHead(upstream.status, headers);
  const bodyStream = Readable.fromWeb(upstream.body as never);
  bodyStream.once("error", () => response.destroy());
  response.once("close", () => bodyStream.destroy());
  bodyStream.pipe(response);
}

export function absolutizeHlsManifest(manifest: string, sourceUrl: string): string {
  if (!sourceUrl) return manifest;
  const absolute = (value: string): string => {
    try {
      return new URL(value, sourceUrl).href;
    } catch {
      return value;
    }
  };
  return manifest
    .split("\n")
    .map((line) => {
      if (!line.trim() || line.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/gu, (_match, uri: string) => `URI="${absolute(uri)}"`);
      }
      return absolute(line.trim());
    })
    .join("\n");
}

async function streamAudio(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): Promise<void> {
  const source = await inspectAudio(path);
  // RFC 9110 defines Range for GET. HEAD returns the full representation headers.
  const range =
    request.method === "GET" ? parseRange(request.headers.range, source.size) : undefined;
  const start = range?.start ?? 0;
  const end = range?.end ?? source.size - 1;
  const status = range ? 206 : 200;
  const contentLength = range ? end - start + 1 : source.size;
  response.writeHead(status, {
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "content-length": contentLength,
    "content-type": source.contentType,
    ...(range ? { "content-range": `bytes ${start}-${end}/${source.size}` } : {}),
  });
  if (request.method === "HEAD" || contentLength === 0) {
    response.end();
    return;
  }
  const stream = createReadStream(source.path, { start, end });
  stream.once("error", () => response.destroy());
  response.once("close", () => stream.destroy());
  stream.pipe(response);
}

async function streamArtwork(
  request: IncomingMessage,
  response: ServerResponse,
  asset: ArtworkAsset,
): Promise<void> {
  if (asset.kind === "embedded") {
    const bytes = Buffer.from(asset.data);
    response.writeHead(200, {
      "cache-control": "private, max-age=300",
      "content-length": bytes.length,
      "content-type": asset.contentType,
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
    return;
  }
  const source = await inspectArtwork(asset.path);
  response.writeHead(200, {
    "cache-control": "private, max-age=300",
    "content-length": source.size,
    "content-type": source.contentType,
  });
  if (request.method === "HEAD" || source.size === 0) {
    response.end();
    return;
  }
  const stream = createReadStream(source.path);
  stream.once("error", () => response.destroy());
  response.once("close", () => stream.destroy());
  stream.pipe(response);
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  pathname: string,
): Promise<void> {
  const decoded = decodeURIComponent(pathname);
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  let candidate = resolve(root, relativePath);
  if (relative(root, candidate).startsWith(`..${sep}`) || relative(root, candidate) === "..")
    throw new Error("Static path escapes the client bundle");
  if (!existsSync(candidate) || !statSync(candidate).isFile()) candidate = join(root, "index.html");
  const realRoot = await realpath(root);
  const realCandidate = await realpath(candidate);
  if (relative(realRoot, realCandidate).startsWith(`..${sep}`))
    throw new Error("Static symlink escapes the client bundle");
  const bytes = request.method === "HEAD" ? undefined : await readFile(realCandidate);
  const contentLength = bytes?.length ?? statSync(realCandidate).size;
  response.writeHead(200, {
    "cache-control":
      extname(realCandidate) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    "content-length": contentLength,
    "content-security-policy":
      "default-src 'self'; base-uri 'none'; connect-src 'self' https://*.soundcloud.cloud https://*.sndcdn.com; form-action 'none'; frame-ancestors 'none'; frame-src https://open.spotify.com; img-src 'self' data:; media-src 'self' blob: https://*.soundcloud.cloud https://*.sndcdn.com; object-src 'none'; script-src 'self' https://open.spotify.com; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:",
    "content-type":
      contentTypes[extname(realCandidate).toLocaleLowerCase()] ?? "application/octet-stream",
  });
  response.end(bytes);
}

function assertMethod(request: IncomingMessage, allowed: readonly string[]): void {
  if (request.method && allowed.includes(request.method)) return;
  throw new HttpError(405, "METHOD_NOT_ALLOWED", "Method not allowed", {
    allow: allowed.join(", "),
  });
}

function hostedTracksResponse(
  source: readonly TrackSummary[],
  options: {
    direction: "asc" | "desc";
    filter: TrackFilter;
    limit: number;
    offset: number;
    q?: string;
    sort?: TrackSortField;
  },
): TracksResponse {
  const query = options.q?.trim().toLocaleLowerCase();
  const filtered = source.filter((track) => {
    if (options.filter === "analyzed" && !track.analyzed) return false;
    if (options.filter === "attention" && track.analyzed) return false;
    if (!query) return true;
    return [track.title, track.artist, track.album, track.genre]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLocaleLowerCase().includes(query));
  });
  const items = options.sort
    ? [...filtered].sort((left, right) => {
        const compared = compareHostedTracks(left, right, options.sort!);
        return options.direction === "asc" ? compared : -compared;
      })
    : filtered;
  return {
    items: items.slice(options.offset, options.offset + options.limit),
    count: items.length,
    limit: options.limit,
    offset: options.offset,
  };
}

function compareHostedTracks(
  left: TrackSummary,
  right: TrackSummary,
  field: TrackSortField,
): number {
  if (field === "position") return compareNullable(left.trackNumber, right.trackNumber);
  if (field === "bpm") return compareNullable(left.bpm, right.bpm);
  if (field === "plays") return left.playCount - right.playCount;
  if (field === "duration") return compareNullable(left.durationSeconds, right.durationSeconds);
  if (field === "status")
    return (left.hosted?.downloadState ?? "remote").localeCompare(
      right.hosted?.downloadState ?? "remote",
    );
  const leftValue = field === "title" ? left.title : (left[field] ?? "");
  const rightValue = field === "title" ? right.title : (right[field] ?? "");
  return String(leftValue).localeCompare(String(rightValue), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function compareNullable(
  left: number | undefined | null,
  right: number | undefined | null,
): number {
  if (left == null) return right == null ? 0 : 1;
  if (right == null) return -1;
  return left - right;
}

/** Start the loopback-only Rekordbox library HTTP server. */
export async function startLibraryServer(
  options: LibraryServerOptions = {},
): Promise<RunningLibraryServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost")
    throw new TypeError("The Rekordbox library server only binds to a loopback address");
  const port = options.port ?? 4179;
  const token = randomBytes(32).toString("base64url");
  const ownsApi = options.api === undefined;
  const api =
    options.api ??
    new RekordboxLibraryService({
      dbPath: options.dbPath,
      key: options.key,
      writeEnabled: options.writeEnabled,
    });
  const ownsHosted = options.hosted === undefined && ownsApi;
  const hosted =
    options.hosted === false
      ? undefined
      : (options.hosted ??
        (ownsApi
          ? await (
              await import("./hosted-runtime.js")
            ).createDefaultHostedPlaylistRuntime({
              statePath: options.hostedStatePath,
              writeEnabled: options.writeEnabled === true,
              dbPath: options.dbPath,
              key: options.key,
            })
          : undefined));
  let ownedDatabasePath: string | undefined;
  if (ownsApi) {
    try {
      ownedDatabasePath = realpathSync(
        api.getDatabasePath?.() ?? api.getBootstrap(token).library.dbPath,
      );
    } catch (error) {
      api.close?.();
      if (ownsHosted) await hosted?.close?.();
      throw error;
    }
  }
  const packageRoot = resolve(import.meta.dirname, "../..");
  const staticDirectory = resolve(options.staticDirectory ?? join(packageRoot, "dist/client"));
  const eventClients = new Set<ServerResponse>();
  const localFileVersions = new Map<string, string>();
  let watchedPaths: string[] = [];
  let watchedWalPath: string | undefined;
  let eventId = 0;
  let externalChangeTimer: ReturnType<typeof setTimeout> | undefined;
  const statsVersion = (stats: Stats): string =>
    stats.nlink === 0
      ? "missing"
      : `${String(stats.dev)}:${String(stats.ino)}:${String(stats.size)}:${String(stats.mtimeMs)}`;
  const isQuiescentWalState = (path: string, stats: Stats): boolean =>
    path === watchedWalPath && (stats.nlink === 0 || stats.size === 0);
  const watchedVersion = (path: string, stats: Stats): string =>
    isQuiescentWalState(path, stats) ? "quiescent-wal" : statsVersion(stats);
  const pathVersion = (path: string): string => {
    try {
      return watchedVersion(path, statSync(path));
    } catch {
      return path === watchedWalPath ? "quiescent-wal" : "missing";
    }
  };
  const rememberLocalFileVersions = () => {
    for (const path of watchedPaths) localFileVersions.set(path, pathVersion(path));
  };
  const writeEvent = (client: ServerResponse, message: string): boolean => {
    if (client.destroyed || client.writableEnded) {
      eventClients.delete(client);
      return false;
    }
    try {
      if (client.write(message)) return true;
    } catch {
      // A disconnected local browser must not retain an SSE response indefinitely.
    }
    eventClients.delete(client);
    client.end();
    return false;
  };
  const publish = (
    type: LibraryEvent["type"],
    details: Pick<LibraryEvent, "changedId" | "mutation"> = {},
  ) => {
    const event: LibraryEvent = {
      id: ++eventId,
      type,
      emittedAt: new Date().toISOString(),
      ...details,
    };
    const message = `id: ${String(event.id)}\nevent: library\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of eventClients) writeEvent(client, message);
    return event;
  };
  const stopHostedJobEvents = hosted?.onJobChanged?.(({ playlistId }) => {
    publish("hosted-job", { changedId: playlistId });
  });
  const heartbeat = setInterval(() => {
    for (const client of eventClients) writeEvent(client, ": keepalive\n\n");
  }, 20_000);
  heartbeat.unref();

  const server = createServer(async (request, response) => {
    setSecurityHeaders(response);
    try {
      assertRequestHost(request);
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (url.pathname === "/api/bootstrap") {
        assertMethod(request, ["GET", "HEAD"]);
        json(request, response, 200, api.getBootstrap(token));
        return;
      }
      if (url.pathname === "/api/events") {
        assertMethod(request, ["GET"]);
        response.writeHead(200, {
          "cache-control": "no-cache, no-store",
          connection: "keep-alive",
          "content-type": "text/event-stream; charset=utf-8",
          "x-accel-buffering": "no",
        });
        eventClients.add(response);
        const connected: LibraryEvent = {
          id: ++eventId,
          type: "connected",
          emittedAt: new Date().toISOString(),
        };
        writeEvent(
          response,
          `id: ${String(connected.id)}\nevent: library\ndata: ${JSON.stringify(connected)}\n\n`,
        );
        const removeClient = () => eventClients.delete(response);
        request.once("close", removeClient);
        response.once("close", removeClient);
        response.once("error", removeClient);
        return;
      }
      if (url.pathname === "/api/playlists") {
        assertMethod(request, ["GET", "HEAD"]);
        json(request, response, 200, { items: api.getPlaylists() });
        return;
      }
      if (url.pathname === "/api/hosted-playlists") {
        assertMethod(request, ["GET", "HEAD"]);
        const result = hosted
          ? await hosted.listPlaylists()
          : {
              items: [],
              providers: [
                { provider: "spotify" as const, connected: false },
                { provider: "soundcloud" as const, connected: false },
              ],
            };
        json(request, response, 200, result);
        return;
      }
      if (url.pathname === "/api/tracks") {
        assertMethod(request, ["GET", "HEAD"]);
        const filter = url.searchParams.get("filter") ?? "all";
        if (filter !== "all" && filter !== "analyzed" && filter !== "attention")
          throw new TypeError("Invalid track filter");
        const sort = url.searchParams.get("sort");
        const direction = url.searchParams.get("direction") ?? "asc";
        const sortFields: TrackSortField[] = [
          "position",
          "title",
          "album",
          "genre",
          "bpm",
          "key",
          "plays",
          "status",
          "duration",
        ];
        if (sort && !sortFields.includes(sort as TrackSortField))
          throw new TypeError("Invalid track sort field");
        if (direction !== "asc" && direction !== "desc")
          throw new TypeError("Invalid track sort direction");
        const limit = queryInteger(url, "limit", 100, 10_000);
        const offset = queryInteger(url, "offset", 0, 10_000_000);
        const playlistId = url.searchParams.get("playlistId");
        const q = url.searchParams.get("q") ?? undefined;
        if (playlistId?.startsWith("hosted:")) {
          if (!hosted)
            throw new HttpError(
              503,
              "HOSTED_PLAYLISTS_UNAVAILABLE",
              "Hosted playlists are not configured",
            );
          json(
            request,
            response,
            200,
            hostedTracksResponse(await hosted.getTracks(playlistId), {
              filter,
              limit,
              offset,
              direction,
              ...(q ? { q } : {}),
              ...(sort ? { sort: sort as TrackSortField } : {}),
            }),
          );
          return;
        }
        json(
          request,
          response,
          200,
          api.getTracks({
            filter,
            limit,
            offset,
            ...(playlistId ? { playlistId } : {}),
            ...(q ? { q } : {}),
            ...(sort ? { sort: { field: sort as TrackSortField, direction } } : {}),
          }),
        );
        return;
      }
      const trackMatch = /^\/api\/tracks\/([^/]+)$/u.exec(url.pathname);
      if (trackMatch) {
        assertMethod(request, ["GET", "HEAD"]);
        json(request, response, 200, { track: api.getTrack(decodeURIComponent(trackMatch[1]!)) });
        return;
      }
      const audioMatch = /^\/api\/audio\/([^/]+)$/u.exec(url.pathname);
      if (audioMatch) {
        assertMethod(request, ["GET", "HEAD"]);
        await streamAudio(request, response, api.getAudioPath(decodeURIComponent(audioMatch[1]!)));
        return;
      }
      const hostedAudioMatch = /^\/api\/hosted-audio\/([^/]+)$/u.exec(url.pathname);
      if (hostedAudioMatch) {
        assertMethod(request, ["GET", "HEAD"]);
        assertLocalMediaRequest(request);
        if (!hosted)
          throw new HttpError(
            503,
            "HOSTED_PLAYLISTS_UNAVAILABLE",
            "Hosted playlists are not configured",
          );
        await streamHostedAudio(
          request,
          response,
          hosted,
          decodeURIComponent(hostedAudioMatch[1]!),
        );
        return;
      }
      const artworkMatch = /^\/api\/artwork\/([^/]+)$/u.exec(url.pathname);
      if (artworkMatch) {
        assertMethod(request, ["GET", "HEAD"]);
        await streamArtwork(
          request,
          response,
          await api.getArtwork(decodeURIComponent(artworkMatch[1]!)),
        );
        return;
      }
      const waveformMatch = /^\/api\/waveforms\/([^/]+)$/u.exec(url.pathname);
      if (waveformMatch) {
        assertMethod(request, ["GET", "HEAD"]);
        json(request, response, 200, {
          waveform: api.getWaveform(decodeURIComponent(waveformMatch[1]!)),
        });
        return;
      }
      if (url.pathname === "/api/mutations") {
        assertMethod(request, ["POST"]);
        assertMutationRequest(request, token);
        const mutation = mutationSchema.parse(await readJsonBody(request)) as LibraryMutation;
        const receipt: MutationReceipt = await api.mutate(mutation);
        try {
          hosted?.mirrorLocalMutation?.(mutation, api);
        } catch {
          // The local SQLite commit is authoritative; provider mirror failures stay background-only.
        }
        rememberLocalFileVersions();
        publish("mutation", { changedId: receipt.changedId, mutation: mutation.type });
        json(request, response, 200, { receipt });
        return;
      }
      if (url.pathname === "/api/hosted-mutations") {
        assertMethod(request, ["POST"]);
        assertMutationRequest(request, token);
        if (!hosted)
          throw new HttpError(
            503,
            "HOSTED_PLAYLISTS_UNAVAILABLE",
            "Hosted playlists are not configured",
          );
        const mutation = hostedMutationSchema.parse(
          await readJsonBody(request),
        ) as HostedPlaylistMutation;
        const receipt = await hosted.mutate(mutation);
        publish("hosted-mutation", {
          changedId: receipt.playlistId,
          mutation: mutation.type,
        });
        json(request, response, 200, { receipt });
        return;
      }
      if (url.pathname === "/api/prompts/plan") {
        assertMethod(request, ["POST"]);
        assertMutationRequest(request, token);
        const input = promptSchema.parse(await readJsonBody(request)) as {
          context: PromptContext;
          prompt: string;
        };
        const plan: PromptPlan = planLibraryPrompt(input.prompt, input.context, api.getPlaylists());
        json(request, response, 200, { plan });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        json(request, response, 404, apiError(404, "NOT_FOUND", "API route not found").body);
        return;
      }
      assertMethod(request, ["GET", "HEAD"]);
      await serveStatic(request, response, staticDirectory, url.pathname);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      const responseError =
        error instanceof HttpError
          ? apiError(error.status, error.code, message)
          : error instanceof LibraryMutationConflictError
            ? apiError(409, "LIBRARY_CONFLICT", message)
            : error instanceof HostedPlaylistConflictError
              ? apiError(409, "HOSTED_PLAYLIST_CONFLICT", message)
              : error instanceof HostedTrackStreamUnavailableError
                ? apiError(404, "STREAM_UNAVAILABLE", message)
                : error instanceof HostedPlaylistCapabilityError
                  ? apiError(403, "HOSTED_PLAYLIST_FORBIDDEN", message)
                  : error instanceof HostedPlaylistVerificationError
                    ? apiError(502, "HOSTED_PLAYLIST_VERIFICATION_FAILED", message)
                    : error instanceof z.ZodError ||
                        error instanceof SyntaxError ||
                        error instanceof TypeError ||
                        error instanceof URIError
                      ? apiError(400, "INVALID_REQUEST", message)
                      : error instanceof RangeError
                        ? apiError(404, "NOT_FOUND", message)
                        : /write mode is disabled|session token|Cross-origin/u.test(message)
                          ? apiError(403, "FORBIDDEN", message)
                          : /Untrusted Host/u.test(message)
                            ? apiError(421, "MISDIRECTED_REQUEST", message)
                            : apiError(500, "INTERNAL_ERROR", message);
      if (error instanceof HttpError)
        for (const [name, value] of Object.entries(error.headers)) response.setHeader(name, value);
      json(request, response, responseError.status, responseError.body);
    }
  });

  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolveListen();
      });
    });
  } catch (error) {
    clearInterval(heartbeat);
    stopHostedJobEvents?.();
    if (ownsApi) api.close?.();
    if (ownsHosted) await hosted?.close?.();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Library server has no TCP address");
  const displayHost = host === "::1" ? "[::1]" : host;
  const watchers: Array<{ path: string; listener: (current: Stats, previous: Stats) => void }> = [];
  try {
    const dbPath =
      ownedDatabasePath ??
      realpathSync(api.getDatabasePath?.() ?? api.getBootstrap(token).library.dbPath);
    watchedWalPath = `${dbPath}-wal`;
    watchedPaths = [dbPath, watchedWalPath, join(dirname(dbPath), "masterPlaylists6.xml")];
    for (const watchedPath of watchedPaths) {
      const listener = (current: Stats, previous: Stats) => {
        if (statsVersion(current) === statsVersion(previous)) return;
        // Merely opening or closing our read connection can create/remove an empty WAL. Treat
        // missing and zero-byte WAL files as one quiescent state so reads cannot invalidate
        // themselves. A transition to or from a WAL containing frames remains external.
        if (isQuiescentWalState(watchedPath, current) && isQuiescentWalState(watchedPath, previous))
          return;
        const expectedLocalVersion = localFileVersions.get(watchedPath);
        if (expectedLocalVersion === watchedVersion(watchedPath, current)) {
          localFileVersions.delete(watchedPath);
        } else {
          localFileVersions.delete(watchedPath);
          if (externalChangeTimer) clearTimeout(externalChangeTimer);
          else {
            api.invalidate?.();
            // Invalidating closes the shared SQLite connection and can remove its WAL. Capture
            // that post-close state before the watcher observes it, including a refetch that
            // recreates the empty WAL before the next polling interval.
            rememberLocalFileVersions();
          }
          externalChangeTimer = setTimeout(() => {
            externalChangeTimer = undefined;
            publish("external-change");
          }, 200);
          externalChangeTimer.unref();
        }
      };
      watchFile(watchedPath, { interval: 750, persistent: false }, listener);
      watchers.push({ path: watchedPath, listener });
    }
  } catch {
    // The API remains available and reports its own bootstrap error; live refresh is best-effort.
  }
  let closePromise: Promise<void> | undefined;
  return {
    host,
    port: address.port,
    token,
    url: `http://${displayHost}:${address.port}/`,
    close: () => {
      closePromise ??= new Promise<void>((resolveClose, reject) => {
        clearInterval(heartbeat);
        if (externalChangeTimer) clearTimeout(externalChangeTimer);
        for (const watcher of watchers) unwatchFile(watcher.path, watcher.listener);
        for (const client of eventClients) client.end();
        eventClients.clear();
        stopHostedJobEvents?.();
        server.close((serverError) => {
          void (async () => {
            let closeError: unknown = serverError;
            try {
              if (ownsApi) api.close?.();
              if (ownsHosted) await hosted?.close?.();
            } catch (error) {
              closeError ??= error;
            }
            if (closeError)
              reject(closeError instanceof Error ? closeError : new Error(String(closeError)));
            else resolveClose();
          })();
        });
      });
      return closePromise;
    },
  };
}
