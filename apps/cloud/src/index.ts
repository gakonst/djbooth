import { ensureDownloadWorkflow, type DownloadParams } from "./download-workflow.js";
export { DownloadWorkflow } from "./download-workflow.js";
import { type AgentTools } from "./agent-tools.js";
export { AgentTools } from "./agent-tools.js";
import { musicRoute } from "./music.js";
export { ContainerProxy } from "@cloudflare/containers";
import type { PlaylistContainer } from "./playlist-container.js";
export { PlaylistContainer } from "./playlist-container.js";
import { authenticate, authRoute, AuthError, type Account } from "./auth.js";
import { agentRoute } from "./agent.js";
import { migrateLegacy } from "./legacy-migration.js";
import { imports } from "./imports.js";
import { crewRoute } from "./crews.js";

export interface Env {
  /** Optional authenticated, streaming, idempotent SoundCloud upload broker. */
  SOUNDCLOUD_UPLOAD_SERVICE?: Fetcher;
  DOWNLOAD_WORKFLOW?: Workflow<DownloadParams>;
  LIBRARY_DB: D1Database;
  MEDIA: R2Bucket;
  CONNECT_API_SERVICE?: Fetcher;
  LEGACY_LIBRARY_OWNER?: string;
  ASSETS?: Fetcher;
  AGENT_TOOLS?: DurableObjectNamespace<AgentTools>;
  PLAYLIST_CONTAINERS?: DurableObjectNamespace<PlaylistContainer>;
  IMPORT_PROVIDER_ENV?: string;
  BROWSER?: BrowserRun;
  AI?: Ai;
}

type Kind = "track" | "collection" | "favorite" | "annotation";
const KINDS = ["track", "collection", "favorite", "annotation"] as const;
const LEGACY_KINDS: readonly string[] = ["track", "collection", "favorite"];
interface Operation {
  operationID: string;
  kind: Kind;
  entityID: string;
  baseVersion: number;
  payload: string | null;
  deleted: boolean;
}
interface Row {
  sequence: number;
  operation_id: string;
  kind: Kind;
  entity_id: string;
  base_version: number;
  payload: string | null;
  deleted: number;
}

const MAX_OPERATION_BYTES = 512 * 1024;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
interface MediaChunk {
  hash: string;
  size: number;
}
interface Composition {
  version: 1;
  size: number;
  contentType: string;
  chunks: MediaChunk[];
}
const ID = /^[\p{L}\p{N}_.:@/-]{1,256}$/u;
const HASH = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();

class HTTPError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(value: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function change(row: Row) {
  return {
    sequence: row.sequence,
    operationID: row.operation_id,
    kind: row.kind,
    entityID: row.entity_id,
    payload: row.payload,
    deleted: row.deleted === 1,
  };
}

async function readJSON(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    throw new HTTPError(415, "Send application/json.");
  }
  if (!request.body) throw new HTTPError(400, "Missing operation.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_OPERATION_BYTES) {
        await reader.cancel();
        throw new HTTPError(413, "Operation is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    throw new HTTPError(400, "Invalid JSON.");
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function operation(value: unknown): Operation {
  if (
    !record(value) ||
    typeof value.operationID !== "string" ||
    !ID.test(value.operationID) ||
    typeof value.entityID !== "string" ||
    !ID.test(value.entityID) ||
    !KINDS.some((kind) => kind === value.kind) ||
    !Number.isSafeInteger(value.baseVersion) ||
    (value.baseVersion as number) < 0 ||
    typeof value.deleted !== "boolean"
  )
    throw new HTTPError(400, "Invalid sync operation.");

  // Swift omits nil fields during encoding, so omitted tombstone payloads are null.
  value.payload ??= null;
  if (value.deleted) {
    if (value.payload !== null) throw new HTTPError(400, "Deleted items must have a null payload.");
  } else {
    if (
      typeof value.payload !== "string" ||
      encoder.encode(value.payload).length > MAX_PAYLOAD_BYTES
    ) {
      throw new HTTPError(400, "Invalid or oversized payload.");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(value.payload);
    } catch {
      throw new HTTPError(400, "Payload must contain JSON.");
    }
    if (!record(payload)) throw new HTTPError(400, "Payload must be an object.");
    if (value.kind === "annotation") {
      if (
        typeof payload.note !== "string" ||
        encoder.encode(payload.note).length > 16_384 ||
        (payload.color != null &&
          (typeof payload.color !== "string" ||
            !["red", "blue", "pink", "cyan"].includes(payload.color))) ||
        Object.keys(payload).some((key) => key !== "note" && key !== "color")
      ) {
        throw new HTTPError(
          400,
          "Invalid annotation: notes are limited to 16,384 UTF-8 bytes and colors to red, blue, pink, or cyan.",
        );
      }
    } else if (value.kind === "favorite") {
      if (typeof payload.enabled !== "boolean")
        throw new HTTPError(400, "Favorite enabled must be a boolean.");
    } else {
      if (payload.id !== value.entityID)
        throw new HTTPError(400, "Payload ID must match entityID.");
      if (value.kind === "collection") {
        if (
          typeof payload.name !== "string" ||
          payload.name.length > 4096 ||
          !Array.isArray(payload.trackIDs) ||
          payload.trackIDs.length > 10000 ||
          !payload.trackIDs.every((id) => typeof id === "string" && ID.test(id))
        ) {
          throw new HTTPError(400, "Invalid collection.");
        }
      } else {
        if (
          typeof payload.title !== "string" ||
          payload.title.length > 4096 ||
          ["artworkAvailable", "fileExists", "analyzed"].some(
            (key) => typeof payload[key] !== "boolean",
          ) ||
          (payload.mediaHash != null &&
            (typeof payload.mediaHash !== "string" || !HASH.test(payload.mediaHash))) ||
          (payload.mediaExtension != null &&
            (typeof payload.mediaExtension !== "string" ||
              !/^[a-z0-9]{1,12}$/.test(payload.mediaExtension)))
        ) {
          throw new HTTPError(400, "Invalid track.");
        }
        for (const key of ["artist", "album", "genre", "key"]) {
          if (
            payload[key] != null &&
            (typeof payload[key] !== "string" || payload[key].length > 4096)
          ) {
            throw new HTTPError(400, `Invalid track ${key}.`);
          }
        }
        for (const key of ["bpm", "durationSeconds"]) {
          if (
            payload[key] != null &&
            (typeof payload[key] !== "number" || !Number.isFinite(payload[key]) || payload[key] < 0)
          ) {
            throw new HTTPError(400, `Invalid track ${key}.`);
          }
        }
        if (payload.hosted != null) {
          const hosted = payload.hosted;
          if (
            !record(hosted) ||
            ["provider", "remoteId", "downloadState"].some(
              (key) => typeof hosted[key] !== "string",
            ) ||
            ["externalUrl", "localContentId"].some(
              (key) => hosted[key] != null && typeof hosted[key] !== "string",
            )
          ) {
            throw new HTTPError(400, "Invalid hosted track.");
          }
        }
        if (payload.waveform != null) {
          const waveform = payload.waveform;
          if (
            !record(waveform) ||
            !Array.isArray(waveform.peaks) ||
            waveform.peaks.length > 8192 ||
            !waveform.peaks.every(
              (peak) => typeof peak === "number" && Number.isFinite(peak) && peak >= 0 && peak <= 1,
            ) ||
            typeof waveform.source !== "string" ||
            !["rekordbox", "placeholder"].includes(waveform.source) ||
            (waveform.durationSeconds != null &&
              (typeof waveform.durationSeconds !== "number" ||
                !Number.isFinite(waveform.durationSeconds) ||
                waveform.durationSeconds < 0)) ||
            (waveform.colors != null &&
              (!Array.isArray(waveform.colors) ||
                waveform.colors.length > 8192 ||
                !waveform.colors.every(
                  (color) =>
                    Array.isArray(color) &&
                    color.length >= 3 &&
                    color.length <= 4 &&
                    color.every(
                      (component) =>
                        Number.isInteger(component) && component >= 0 && component <= 255,
                    ),
                )))
          ) {
            throw new HTTPError(400, "Invalid waveform.");
          }
          if (waveform.beatGrid != null) {
            const grid = waveform.beatGrid;
            if (
              !record(grid) ||
              !Array.isArray(grid.times) ||
              !Array.isArray(grid.beats) ||
              grid.times.length > 20_000 ||
              grid.times.length !== grid.beats.length ||
              !grid.times.every(
                (time, index, times) =>
                  typeof time === "number" &&
                  Number.isFinite(time) &&
                  time >= 0 &&
                  (index === 0 || time > times[index - 1]),
              ) ||
              !grid.beats.every((beat) => Number.isInteger(beat) && beat >= 1 && beat <= 4)
            )
              throw new HTTPError(400, "Invalid beatgrid.");
          }
        }
        for (const key of [
          "filePath",
          "path",
          "FolderPath",
          "accessToken",
          "refreshToken",
          "password",
        ]) {
          if (key in payload)
            throw new HTTPError(
              400,
              "Local paths and account secrets do not belong in synced tracks.",
            );
        }
      }
    }
  }
  return value as unknown as Operation;
}

async function push(request: Request, env: Env, account: Account): Promise<Response> {
  const op = operation(await readJSON(request));
  // The conditional append and both reads share one D1 transaction. Two devices
  // cannot both append against the same base version. Retried operation IDs cannot
  // append a second row, even if their original response was lost.
  const results = await env.LIBRARY_DB.batch<Row>([
    env.LIBRARY_DB.prepare(`INSERT INTO sync_changes
      (account_id, operation_id, kind, entity_id, base_version, payload, deleted)
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE COALESCE((SELECT sequence FROM sync_changes
        WHERE account_id = ? AND kind = ? AND entity_id = ? ORDER BY sequence DESC LIMIT 1), 0) = ?
        AND NOT EXISTS (SELECT 1 FROM sync_changes WHERE account_id = ? AND operation_id = ?)`).bind(
      account.id,
      op.operationID,
      op.kind,
      op.entityID,
      op.baseVersion,
      op.payload,
      Number(op.deleted),
      account.id,
      op.kind,
      op.entityID,
      op.baseVersion,
      account.id,
      op.operationID,
    ),
    env.LIBRARY_DB.prepare(
      "SELECT * FROM sync_changes WHERE account_id = ? AND operation_id = ?",
    ).bind(account.id, op.operationID),
    env.LIBRARY_DB.prepare(
      "SELECT * FROM sync_changes WHERE account_id = ? AND kind = ? AND entity_id = ? ORDER BY sequence DESC LIMIT 1",
    ).bind(account.id, op.kind, op.entityID),
  ]);
  const existing = results[1].results[0];
  if (existing) {
    if (
      existing.kind !== op.kind ||
      existing.entity_id !== op.entityID ||
      existing.base_version !== op.baseVersion ||
      existing.payload !== op.payload ||
      existing.deleted !== Number(op.deleted)
    ) {
      throw new HTTPError(422, "operationID was already used for a different operation.");
    }
    return json(change(existing), results[0].meta.changes === 1 ? 201 : 200);
  }
  const current = results[2].results[0];
  return json(
    {
      current: current
        ? change(current)
        : {
            sequence: 0,
            operationID: "",
            kind: op.kind,
            entityID: op.entityID,
            payload: null,
            deleted: true,
          },
    },
    409,
  );
}

async function pull(url: URL, env: Env, account: Account): Promise<Response> {
  const raw = url.searchParams.get("after") ?? "0";
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new HTTPError(400, "Invalid sync cursor.");
  const after = Number(raw);
  const namespace = url.searchParams.get("namespace");
  if (namespace !== null && !/^cloud:[a-f0-9-]{36}$/i.test(namespace))
    throw new HTTPError(400, "Invalid playlist namespace.");
  // Older apps reject unknown enum cases. Opt in to annotations explicitly while
  // advancing every client over the same global sequence, including hidden rows.
  const requested = url.searchParams.get("kinds");
  const kinds = requested == null ? LEGACY_KINDS : requested.split(",");
  if (!kinds.length || kinds.some((kind) => !KINDS.some((known) => known === kind))) {
    throw new HTTPError(400, "Invalid sync entity kinds.");
  }
  // Always start on the primary: advancing a cursor from a lagging replica can
  // otherwise make a device miss committed writes after a push on another device.
  const db = env.LIBRARY_DB.withSession("first-primary");
  const query =
    namespace === null
      ? db
          .prepare(
            "SELECT * FROM sync_changes WHERE account_id = ? AND sequence > ? ORDER BY sequence LIMIT 101",
          )
          .bind(account.id, after)
      : db
          .prepare(
            "SELECT * FROM sync_changes WHERE account_id = ? AND sequence > ? AND entity_id LIKE ? ORDER BY sequence LIMIT 101",
          )
          .bind(account.id, after, `${namespace}:%`);
  const { results } = await query.all<Row>();
  const changes: ReturnType<typeof change>[] = [];
  let bytes = 0;
  let scanned = 0,
    cursor = after;
  for (const row of results) {
    if (scanned >= 100) break;
    const item = change(row);
    if (kinds.includes(row.kind)) {
      const size = encoder.encode(JSON.stringify(item)).length;
      if (changes.length > 0 && bytes + size > MAX_PAGE_BYTES) break;
      bytes += size;
      changes.push(item);
    }
    scanned++;
    cursor = row.sequence;
  }
  return json({
    changes,
    cursor,
    hasMore: scanned < results.length,
  });
}

function mediaHeaders(
  object: { size: number; httpMetadata?: { contentType?: string } },
  hash: string,
): Headers {
  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
    "content-length": String(object.size),
    etag: `"${hash}"`,
    "x-content-type-options": "nosniff",
  });
  return headers;
}

function byteRange(value: string, size: number): { offset: number; length: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { offset: Math.max(0, size - suffix), length: Math.min(suffix, size) };
  }
  const start = Number(match[1]),
    end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start)
    return null;
  return { offset: start, length: Math.min(end, size - 1) - start + 1 };
}

async function compose(
  request: Request,
  env: Env,
  hash: string,
  account: Account,
): Promise<Response> {
  if (request.method !== "POST")
    return json({ error: { message: "Method not allowed." } }, 405, { allow: "POST" });
  const value = await readJSON(request);
  if (
    !record(value) ||
    !Array.isArray(value.chunks) ||
    value.chunks.length === 0 ||
    value.chunks.length > 256 ||
    !value.chunks.every(
      (chunk) =>
        record(chunk) &&
        typeof chunk.hash === "string" &&
        HASH.test(chunk.hash) &&
        Number.isSafeInteger(chunk.size) &&
        (chunk.size as number) > 0 &&
        (chunk.size as number) <= MAX_CHUNK_BYTES,
    )
  ) {
    throw new HTTPError(400, "Provide 1 to 256 ordered chunks, each at most 16 MiB.");
  }
  const chunks = value.chunks as MediaChunk[];
  const contentType = value.contentType ?? "application/octet-stream";
  if (
    typeof contentType !== "string" ||
    (contentType !== "application/octet-stream" && !/^audio\/[a-z0-9.+-]+$/i.test(contentType))
  ) {
    throw new HTTPError(400, "Invalid audio content type.");
  }
  const size = chunks.reduce((total, chunk) => total + chunk.size, 0);
  const existing = await env.MEDIA.head(`accounts/${account.id}/sha256/${hash}`);
  if (existing) return json({ hash, size: existing.size, created: false });
  const prior = await env.MEDIA.get(`accounts/${account.id}/compositions/${hash}`);
  if (prior) return json({ hash, size: (await prior.json<Composition>()).size, created: false });

  // Chunk objects are already immutable and individually verified. Rehash their
  // ordered bytes before making the complete media address visible. This handles
  // multi-hour sets without buffering them or exceeding Cloudflare's ingress cap.
  const digest = new crypto.DigestStream("SHA-256");
  const writer = digest.getWriter();
  // Observe rejection even when a missing chunk aborts before digest is awaited.
  void digest.digest.catch(() => {});
  try {
    for (const chunk of chunks) {
      const object = await env.MEDIA.get(`accounts/${account.id}/sha256/${chunk.hash}`);
      if (!object || object.size !== chunk.size)
        throw new HTTPError(
          409,
          "Upload all chunks with their correct sizes before completing media.",
        );
      const reader = object.body.getReader();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          await writer.write(part.value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    await writer.close();
    const actual = [...new Uint8Array(await digest.digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (actual !== hash)
      throw new HTTPError(422, "Combined media checksum does not match its SHA-256 address.");
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  } finally {
    writer.releaseLock();
  }
  const composition: Composition = { version: 1, size, contentType, chunks };
  const stored = await env.MEDIA.put(
    `accounts/${account.id}/compositions/${hash}`,
    JSON.stringify(composition),
    {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
    },
  );
  return json({ hash, size, created: Boolean(stored) }, stored ? 201 : 200);
}

function compositionBody(
  env: Env,
  composition: Composition,
  account: Account,
  range?: { offset: number; length: number },
): ReadableStream<Uint8Array> {
  const start = range?.offset ?? 0,
    end = start + (range?.length ?? composition.size);
  let offset = 0;
  const selected = composition.chunks.flatMap((chunk) => {
    const from = Math.max(start, offset),
      to = Math.min(end, offset + chunk.size);
    const result =
      to > from ? [{ hash: chunk.hash, offset: from - offset, length: to - from }] : [];
    offset += chunk.size;
    return result;
  });
  let index = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          if (!reader) {
            const chunk = selected[index++];
            if (!chunk) {
              controller.close();
              return;
            }
            const object = await env.MEDIA.get(`accounts/${account.id}/sha256/${chunk.hash}`, {
              range: { offset: chunk.offset, length: chunk.length },
            });
            if (!object || !("body" in object)) throw new Error("Missing immutable audio chunk");
            reader = object.body.getReader();
          }
          const part = await reader.read();
          if (part.done) {
            reader.releaseLock();
            reader = undefined;
            continue;
          }
          controller.enqueue(part.value);
          return;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason);
    },
  });
}

async function media(
  request: Request,
  env: Env,
  hash: string,
  account: Account,
): Promise<Response> {
  const key = `accounts/${account.id}/sha256/${hash}`;
  if (request.method === "PUT") {
    const rawLength = request.headers.get("content-length");
    if (!rawLength || !/^\d+$/.test(rawLength))
      throw new HTTPError(411, "Content-Length is required for media uploads.");
    const length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_MEDIA_BYTES) {
      throw new HTTPError(413, "Media must be between 1 byte and 512 MiB.");
    }
    if (!request.body) throw new HTTPError(400, "Missing media.");
    const type =
      request.headers.get("content-type")?.split(";")[0].trim() ?? "application/octet-stream";
    if (type !== "application/octet-stream" && !/^audio\/[a-z0-9.+-]+$/i.test(type)) {
      throw new HTTPError(415, "Upload audio or application/octet-stream.");
    }
    const existing = await env.MEDIA.head(key);
    if (existing) return json({ hash, size: existing.size, created: false });
    let object: R2Object | null;
    try {
      object = await env.MEDIA.put(key, request.body, {
        sha256: hash,
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType: type },
      });
    } catch (error) {
      if (error instanceof Error && /checksum|digest|hash.*match/i.test(error.message)) {
        throw new HTTPError(422, "Media checksum does not match its SHA-256 address.");
      }
      throw error;
    }
    if (!object) {
      const winner = await env.MEDIA.head(key);
      if (!winner) throw new HTTPError(503, "Upload raced another request; retry.");
      return json({ hash, size: winner.size, created: false });
    }
    return json({ hash, size: object.size, created: true }, 201);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json({ error: { message: "Method not allowed." } }, 405, { allow: "GET, HEAD, PUT" });
  }
  const object = await env.MEDIA.head(key);
  let composition: Composition | undefined;
  if (!object) {
    const stored = await env.MEDIA.get(`accounts/${account.id}/compositions/${hash}`);
    if (!stored) throw new HTTPError(404, "Media is not available.");
    composition = await stored.json<Composition>();
  }
  const size = object?.size ?? composition!.size;
  const headers = mediaHeaders(
    object ?? { size, httpMetadata: { contentType: composition!.contentType } },
    hash,
  );
  const etag = headers.get("etag")!;
  const noneMatch = request.headers.get("if-none-match");
  if (
    noneMatch
      ?.split(",")
      .some((value) => value.trim().replace(/^W\//, "") === etag || value.trim() === "*")
  ) {
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }
  if (request.method === "HEAD") return new Response(null, { headers });
  const rawRange = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  const useRange = rawRange && (!ifRange || ifRange === etag);
  const range = useRange ? byteRange(rawRange, size) : undefined;
  if (range === null) {
    headers.set("content-range", `bytes */${size}`);
    headers.set("content-length", "0");
    return new Response(null, { status: 416, headers });
  }
  let body: ReadableStream<Uint8Array>;
  if (composition) body = compositionBody(env, composition, account, range);
  else {
    const stored = await env.MEDIA.get(key, range ? { range } : {});
    if (!stored || !("body" in stored)) throw new HTTPError(503, "Media unavailable; retry.");
    body = stored.body;
  }
  if (range) {
    headers.set(
      "content-range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`,
    );
    headers.set("content-length", String(range.length));
  }
  return new Response(body, { status: range ? 206 : 200, headers });
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await env.LIBRARY_DB.prepare("DELETE FROM login_codes WHERE expires_at<=?")
      .bind(Date.now())
      .run();
    if (!env.PLAYLIST_CONTAINERS) return;
    if (env.DOWNLOAD_WORKFLOW) {
      // Adopt saved agent work only after the workflow runtime has been deployed.
      await env.LIBRARY_DB.prepare(
        "UPDATE import_requests SET workflow_id=lower(hex(randomblob(16))), status='queued', message='Continuing download', updated_at=? WHERE workflow_id IS NULL AND (status IN ('queued','running') OR (status='failed' AND message='Your agent stopped before publishing all tracks. Retry to resume saved work.'))",
      )
        .bind(Date.now())
        .run();
      const jobs = await env.LIBRARY_DB.prepare(
        "SELECT account_id, id, source, workflow_id FROM import_requests WHERE workflow_id IS NOT NULL AND status IN ('queued','running') ORDER BY created_at LIMIT 100",
      ).all<{ account_id: string; id: string; source: string; workflow_id: string }>();
      const submissions = await Promise.allSettled(
        jobs.results.map((job) =>
          ensureDownloadWorkflow(
            env,
            { accountId: job.account_id, id: job.id, source: job.source },
            job.workflow_id,
          ),
        ),
      );
      for (const result of submissions)
        if (result.status === "rejected")
          console.error(
            "Download workflow submission will retry",
            result.reason instanceof Error ? result.reason.name : "UnknownError",
          );
    }
    if (env.AGENT_TOOLS) {
      const owners = await env.LIBRARY_DB.prepare(
        "SELECT DISTINCT account_id, agent_grant_id, agent_id FROM import_requests WHERE workflow_id IS NULL AND agent_grant_id IS NOT NULL AND agent_id IS NOT NULL AND (status IN ('queued','running') OR (status='failed' AND message='Your agent stopped before publishing all tracks. Retry to resume saved work.')) LIMIT 100",
      ).all<{ account_id: string; agent_grant_id: string; agent_id: string }>();
      for (const owner of owners.results)
        await env.AGENT_TOOLS.getByName(
          `${owner.account_id}:${owner.agent_grant_id}:${owner.agent_id}`,
        ).wake();
    }
    await env.LIBRARY_DB.prepare(
      "UPDATE import_requests SET status='queued', phase='queued', current=0, total=1, message='Updating CDJ files in the cloud', analysis_repair=1, updated_at=? WHERE status='complete' AND analysis_version<1",
    )
      .bind(Date.now())
      .run();
    const pending = await env.LIBRARY_DB.prepare(
      "SELECT account_id, id, source FROM import_requests WHERE status IN ('queued','running') ORDER BY created_at LIMIT 100",
    ).all<{ account_id: string; id: string; source: string }>();
    for (const job of pending.results)
      await env.PLAYLIST_CONTAINERS.getByName(`${job.account_id}:${job.id}`).enqueue(
        job.account_id,
        job.id,
        job.source,
      );
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/health" && request.method === "GET")
        return json({ service: "djbooth-library", version: 1 });
      if (url.pathname.startsWith("/v1/auth/")) return await authRoute(request, env, readJSON);
      if (
        env.ASSETS &&
        (url.pathname === "/" || url.pathname.startsWith("/assets/")) &&
        ["GET", "HEAD"].includes(request.method)
      )
        return env.ASSETS.fetch(request);
      // One-use phone bridge ticket; ownership is encoded in the DO routing ID,
      // then checked against the live Connect grant inside the DO.
      const phone = /^\/v1\/agent\/phone\/([a-f0-9]{64})\/tool-host$/.exec(url.pathname);
      if (phone && env.AGENT_TOOLS)
        return env.AGENT_TOOLS.get(env.AGENT_TOOLS.idFromString(phone[1])).fetch(request);
      const account = await authenticate(request, env);
      if (url.pathname === "/v1/migrations/legacy")
        return await migrateLegacy(request, env, account);
      if (url.pathname.startsWith("/v1/music/"))
        return await musicRoute(request, env, account, readJSON, (hash) =>
          media(new Request(request.url), env, hash, account),
        );
      if (url.pathname.startsWith("/v1/agent/"))
        return await agentRoute(request, env, account, readJSON);
      return await accountFetch(request, env, account);
    } catch (error) {
      if (error instanceof HTTPError || error instanceof AuthError)
        return json({ error: { message: error.message } }, error.status);
      console.error("Library request failed", error instanceof Error ? error.name : "UnknownError");
      return json({ error: { message: "Library is temporarily unavailable; retry." } }, 503);
    }
  },
} satisfies ExportedHandler<Env>;

/** Internal entrypoint: only the public authenticated router or a verified container owner calls this. */
export async function accountFetch(
  request: Request,
  env: Env,
  account: Account,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/v1/imports" || url.pathname.startsWith("/v1/imports/"))
      return await imports(request, env, account, readJSON);
    if (
      url.pathname === "/v1/crews" ||
      url.pathname.startsWith("/v1/crews/") ||
      url.pathname.startsWith("/v1/crew-invites/")
    )
      return await crewRoute(request, env, account, readJSON);
    if (url.pathname === "/v1/sync/changes") {
      if (request.method === "GET") return await pull(url, env, account);
      if (request.method === "POST") return await push(request, env, account);
      return json({ error: { message: "Method not allowed." } }, 405, { allow: "GET, POST" });
    }
    const composed = /^\/v1\/media\/([a-f0-9]{64})\/compose$/.exec(url.pathname);
    if (composed) return await compose(request, env, composed[1], account);
    const match = /^\/v1\/media\/([a-f0-9]{64})$/.exec(url.pathname);
    if (match) return await media(request, env, match[1], account);
    throw new HTTPError(404, "Not found.");
  } catch (error) {
    if (error instanceof HTTPError || error instanceof AuthError)
      return json({ error: { message: error.message } }, error.status);
    // Do not reflect database errors, request bodies, or tokens into responses/logs.
    console.error("Library request failed", error instanceof Error ? error.name : "UnknownError");
    return json({ error: { message: "Library is temporarily unavailable; retry." } }, 503);
  }
}
