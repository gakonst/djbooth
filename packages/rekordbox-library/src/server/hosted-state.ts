import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3-multiple-ciphers";

import type {
  HostedPlaylistMutation,
  HostedPlaylistProvider,
  HostedPlaylistSyncState,
  HostedTrackDownloadState,
} from "../shared/types.js";

export type HostedPlaylistState = {
  provider: HostedPlaylistProvider;
  remoteId: string;
  downloadEnabled: boolean;
  localPlaylistId: string | null;
  revision: string | null;
  syncState: HostedPlaylistSyncState;
  syncError: string | null;
  syncCurrent?: number;
  syncTotal?: number;
  updatedAt: string;
};

export type HostedTrackMapping = {
  provider: HostedPlaylistProvider;
  remoteTrackId: string;
  localContentId: string | null;
  downloadState: HostedTrackDownloadState;
  downloadError: string | null;
  updatedAt: string;
};

export type HostedJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type HostedPlaylistJob = {
  id: string;
  kind: "download-playlist";
  provider: HostedPlaylistProvider;
  playlistId: string;
  status: HostedJobStatus;
  current: number;
  total: number;
  error: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type HostedOutboxEntry = {
  id: string;
  dedupeKey: string;
  playlistId: string;
  mutation: HostedPlaylistMutation;
  status: "queued" | "running" | "failed";
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type PlaylistStateRow = {
  provider: HostedPlaylistProvider;
  remote_id: string;
  download_enabled: number;
  local_playlist_id: string | null;
  revision: string | null;
  sync_state: HostedPlaylistSyncState;
  sync_error: string | null;
  sync_current?: number | null;
  sync_total?: number | null;
  updated_at: string;
};

type TrackMappingRow = {
  provider: HostedPlaylistProvider;
  remote_track_id: string;
  local_content_id: string | null;
  download_state: HostedTrackDownloadState;
  download_error: string | null;
  updated_at: string;
};

type JobRow = {
  id: string;
  kind: "download-playlist";
  provider: HostedPlaylistProvider;
  playlist_id: string;
  status: HostedJobStatus;
  current: number;
  total: number;
  error: string | null;
  payload_json: string;
  created_at: string;
  updated_at: string;
};

type OutboxRow = {
  id: string;
  dedupe_key: string;
  playlist_id: string;
  mutation_json: string;
  status: "queued" | "running" | "failed";
  attempts: number;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type WebCacheRow = {
  payload_json: string;
  expires_at: number;
  updated_at: number;
};

const maximumWebCachePayloadBytes = 8 * 1024 * 1024;
const maximumWebCacheEntries = 512;
const maximumWebCacheStaleMs = 7 * 24 * 60 * 60 * 1_000;

export function defaultHostedStatePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MUSIC_LIBRARY_STATE_PATH) return env.MUSIC_LIBRARY_STATE_PATH;
  const root = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(root, "music-ts", "rekordbox-library.sqlite");
}

/** Small, WAL-backed control database. Provider calls and Rekordbox media never live here. */
export class HostedPlaylistStateStore {
  readonly path: string;
  readonly #database: Database.Database;

  constructor(path = defaultHostedStatePath()) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    this.#database = new Database(path);
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("synchronous = NORMAL");
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("busy_timeout = 5000");
    this.#migrate();
    chmodSync(path, 0o600);
    this.#recoverInterruptedWork();
  }

  close(): void {
    this.#database.close();
  }

  getPlaylist(provider: HostedPlaylistProvider, remoteId: string): HostedPlaylistState | undefined {
    const row = this.#database
      .prepare(
        `SELECT p.provider, p.remote_id, p.download_enabled, p.local_playlist_id, p.revision,
                p.sync_state, p.sync_error, p.updated_at,
                j.current AS sync_current, j.total AS sync_total
           FROM playlist_state p
           LEFT JOIN hosted_job j ON j.id = (
             SELECT h.id FROM hosted_job h
              WHERE h.provider = p.provider AND h.playlist_id = p.remote_id
              ORDER BY h.created_at DESC LIMIT 1
           )
          WHERE p.provider = ? AND p.remote_id = ?`,
      )
      .get(provider, remoteId) as PlaylistStateRow | undefined;
    return row ? playlistState(row) : undefined;
  }

  getPlaylistByLocalId(localPlaylistId: string): HostedPlaylistState | undefined {
    const rows = this.#database
      .prepare(
        `SELECT p.provider, p.remote_id, p.download_enabled, p.local_playlist_id, p.revision,
                p.sync_state, p.sync_error, p.updated_at,
                j.current AS sync_current, j.total AS sync_total
           FROM playlist_state p
           LEFT JOIN hosted_job j ON j.id = (
             SELECT h.id FROM hosted_job h
              WHERE h.provider = p.provider AND h.playlist_id = p.remote_id
              ORDER BY h.created_at DESC LIMIT 1
           )
          WHERE p.local_playlist_id = ?
          LIMIT 2`,
      )
      .all(localPlaylistId) as PlaylistStateRow[];
    if (rows.length > 1) {
      throw new Error(
        `Local playlist '${localPlaylistId}' is mapped to multiple hosted playlists; refusing sync`,
      );
    }
    return rows[0] ? playlistState(rows[0]) : undefined;
  }

  listPlaylists(): HostedPlaylistState[] {
    const rows = this.#database
      .prepare(
        `SELECT p.provider, p.remote_id, p.download_enabled, p.local_playlist_id, p.revision,
                p.sync_state, p.sync_error, p.updated_at,
                j.current AS sync_current, j.total AS sync_total
           FROM playlist_state p
           LEFT JOIN hosted_job j ON j.id = (
             SELECT h.id FROM hosted_job h
              WHERE h.provider = p.provider AND h.playlist_id = p.remote_id
              ORDER BY h.created_at DESC LIMIT 1
           )
          ORDER BY p.provider, p.remote_id`,
      )
      .all() as PlaylistStateRow[];
    return rows.map(playlistState);
  }

  setDownloadEnabled(
    provider: HostedPlaylistProvider,
    remoteId: string,
    enabled: boolean,
  ): HostedPlaylistState {
    const now = new Date().toISOString();
    const row = this.#database
      .prepare(
        `INSERT INTO playlist_state (
           provider, remote_id, download_enabled, sync_state, updated_at
         ) VALUES (?, ?, ?, 'idle', ?)
         ON CONFLICT(provider, remote_id) DO UPDATE SET
           download_enabled = excluded.download_enabled,
           updated_at = excluded.updated_at
         RETURNING provider, remote_id, download_enabled, local_playlist_id, revision,
                   sync_state, sync_error, updated_at`,
      )
      .get(provider, remoteId, enabled ? 1 : 0, now) as PlaylistStateRow;
    return playlistState(row);
  }

  updatePlaylistSync(
    provider: HostedPlaylistProvider,
    remoteId: string,
    input: {
      revision?: string | null;
      localPlaylistId?: string | null;
      state?: HostedPlaylistSyncState;
      error?: string | null;
    },
  ): HostedPlaylistState {
    const now = new Date().toISOString();
    const row = this.#database
      .prepare(
        `INSERT INTO playlist_state (
           provider, remote_id, download_enabled, local_playlist_id, revision,
           sync_state, sync_error, updated_at
         ) VALUES (?, ?, 0, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, remote_id) DO UPDATE SET
           local_playlist_id = CASE WHEN ? THEN excluded.local_playlist_id
                                    ELSE playlist_state.local_playlist_id END,
           revision = CASE WHEN ? THEN excluded.revision ELSE playlist_state.revision END,
           sync_state = CASE WHEN ? THEN excluded.sync_state ELSE playlist_state.sync_state END,
           sync_error = CASE WHEN ? THEN excluded.sync_error ELSE playlist_state.sync_error END,
           updated_at = excluded.updated_at
         RETURNING provider, remote_id, download_enabled, local_playlist_id, revision,
                   sync_state, sync_error, updated_at`,
      )
      .get(
        provider,
        remoteId,
        input.localPlaylistId ?? null,
        input.revision ?? null,
        input.state ?? "idle",
        input.error ?? null,
        now,
        input.localPlaylistId === undefined ? 0 : 1,
        input.revision === undefined ? 0 : 1,
        input.state === undefined ? 0 : 1,
        input.error === undefined ? 0 : 1,
      ) as PlaylistStateRow;
    return playlistState(row);
  }

  getTrack(
    provider: HostedPlaylistProvider,
    remoteTrackId: string,
  ): HostedTrackMapping | undefined {
    const row = this.#database
      .prepare(
        `SELECT provider, remote_track_id, local_content_id, download_state,
                download_error, updated_at
           FROM track_mapping
          WHERE provider = ? AND remote_track_id = ?`,
      )
      .get(provider, remoteTrackId) as TrackMappingRow | undefined;
    return row ? trackMapping(row) : undefined;
  }

  listTracks(provider: HostedPlaylistProvider): HostedTrackMapping[] {
    const rows = this.#database
      .prepare(
        `SELECT provider, remote_track_id, local_content_id, download_state,
                download_error, updated_at
           FROM track_mapping
          WHERE provider = ?`,
      )
      .all(provider) as TrackMappingRow[];
    return rows.map(trackMapping);
  }

  listTracksByLocalContentIds(
    provider: HostedPlaylistProvider,
    localContentIds: readonly string[],
  ): HostedTrackMapping[] {
    if (!localContentIds.length) return [];
    const rows = this.#database
      .prepare(
        `WITH requested(local_content_id) AS (
           SELECT DISTINCT CAST(value AS TEXT) FROM json_each(?)
         )
         SELECT mapping.provider, mapping.remote_track_id, mapping.local_content_id,
                mapping.download_state, mapping.download_error, mapping.updated_at
           FROM track_mapping mapping
           JOIN requested ON requested.local_content_id = mapping.local_content_id
          WHERE mapping.provider = ?`,
      )
      .all(JSON.stringify(localContentIds), provider) as TrackMappingRow[];
    return rows.map(trackMapping);
  }

  getWebCache<T>(
    key: string,
    options: { allowExpired?: boolean; maxStaleMs?: number } = {},
  ): { value: T; expiresAt: number; updatedAt: number } | undefined {
    const row = this.#database
      .prepare("SELECT payload_json, expires_at, updated_at FROM web_cache WHERE cache_key = ?")
      .get(key) as WebCacheRow | undefined;
    if (!row) return undefined;
    const now = Date.now();
    const maxStaleMs = options.maxStaleMs ?? maximumWebCacheStaleMs;
    if (row.expires_at <= now) {
      if (row.expires_at < now - maxStaleMs) this.deleteWebCache(key);
      if (!options.allowExpired || row.expires_at < now - maxStaleMs) return undefined;
    }
    try {
      return {
        value: JSON.parse(row.payload_json) as T,
        expiresAt: row.expires_at,
        updatedAt: row.updated_at,
      };
    } catch {
      this.deleteWebCache(key);
      return undefined;
    }
  }

  setWebCache(key: string, value: unknown, ttlMs: number): void {
    if (!key || key.length > 512) throw new RangeError("Web cache key is invalid");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 0)
      throw new RangeError("Web cache duration must be a non-negative integer");
    const payload = JSON.stringify(value);
    if (payload === undefined) throw new TypeError("Web cache value is not JSON serializable");
    if (Buffer.byteLength(payload) > maximumWebCachePayloadBytes)
      throw new RangeError("Web cache payload exceeds 8 MiB");
    const now = Date.now();
    this.#database.transaction(() => {
      this.#database
        .prepare(
          `INSERT INTO web_cache (cache_key, payload_json, expires_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(cache_key) DO UPDATE SET
             payload_json = excluded.payload_json,
             expires_at = excluded.expires_at,
             updated_at = excluded.updated_at`,
        )
        .run(key, payload, now + ttlMs, now);
      this.#database
        .prepare("DELETE FROM web_cache WHERE expires_at < ?")
        .run(now - maximumWebCacheStaleMs);
      this.#database
        .prepare(
          `DELETE FROM web_cache
            WHERE cache_key IN (
              SELECT cache_key FROM web_cache
              ORDER BY updated_at DESC
              LIMIT -1 OFFSET ?
            )`,
        )
        .run(maximumWebCacheEntries);
    })();
  }

  deleteWebCache(key: string): void {
    this.#database.prepare("DELETE FROM web_cache WHERE cache_key = ?").run(key);
  }

  setTrack(
    provider: HostedPlaylistProvider,
    remoteTrackId: string,
    input: {
      localContentId?: string | null;
      state: HostedTrackDownloadState;
      error?: string | null;
    },
  ): HostedTrackMapping {
    const now = new Date().toISOString();
    const row = this.#database
      .prepare(
        `INSERT INTO track_mapping (
           provider, remote_track_id, local_content_id, download_state,
           download_error, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, remote_track_id) DO UPDATE SET
           local_content_id = CASE WHEN ? THEN excluded.local_content_id
                                   ELSE track_mapping.local_content_id END,
           download_state = excluded.download_state,
           download_error = excluded.download_error,
           updated_at = excluded.updated_at
         RETURNING provider, remote_track_id, local_content_id, download_state,
                   download_error, updated_at`,
      )
      .get(
        provider,
        remoteTrackId,
        input.localContentId ?? null,
        input.state,
        input.error ?? null,
        now,
        input.localContentId === undefined ? 0 : 1,
      ) as TrackMappingRow;
    return trackMapping(row);
  }

  enqueueDownload(
    provider: HostedPlaylistProvider,
    playlistId: string,
    payload: Record<string, unknown> = {},
  ): HostedPlaylistJob {
    const id = randomUUID();
    const now = new Date().toISOString();
    const inserted = this.#database
      .prepare(
        `INSERT INTO hosted_job (
           id, kind, provider, playlist_id, status, current, total, payload_json,
           created_at, updated_at
         ) VALUES (?, 'download-playlist', ?, ?, 'queued', 0, 0, ?, ?, ?)
         ON CONFLICT DO NOTHING
         RETURNING *`,
      )
      .get(id, provider, playlistId, JSON.stringify(payload), now, now) as JobRow | undefined;
    if (inserted) return hostedJob(inserted);
    const active = this.getActiveDownload(provider, playlistId);
    if (active) return active;
    throw new Error(`Unable to enqueue hosted download for '${playlistId}'`);
  }

  getJob(id: string): HostedPlaylistJob | undefined {
    const row = this.#database.prepare("SELECT * FROM hosted_job WHERE id = ?").get(id) as
      | JobRow
      | undefined;
    return row ? hostedJob(row) : undefined;
  }

  getActiveDownload(
    provider: HostedPlaylistProvider,
    playlistId: string,
  ): HostedPlaylistJob | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM hosted_job
          WHERE provider = ? AND playlist_id = ? AND kind = 'download-playlist'
            AND status IN ('queued', 'running')
          ORDER BY created_at LIMIT 1`,
      )
      .get(provider, playlistId) as JobRow | undefined;
    return row ? hostedJob(row) : undefined;
  }

  listJobs(limit = 100): HostedPlaylistJob[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000)
      throw new RangeError("Job limit must be between 1 and 1000");
    const rows = this.#database
      .prepare("SELECT * FROM hosted_job ORDER BY created_at DESC LIMIT ?")
      .all(limit) as JobRow[];
    return rows.map(hostedJob);
  }

  claimNextJob(): HostedPlaylistJob | undefined {
    const row = this.#database
      .prepare(
        `UPDATE hosted_job
            SET status = 'running', updated_at = ?
          WHERE id = (
            SELECT id FROM hosted_job WHERE status = 'queued' ORDER BY created_at LIMIT 1
          ) AND status = 'queued'
        RETURNING *`,
      )
      .get(new Date().toISOString()) as JobRow | undefined;
    return row ? hostedJob(row) : undefined;
  }

  updateJob(
    id: string,
    input: { status?: HostedJobStatus; current?: number; total?: number; error?: string | null },
  ): HostedPlaylistJob {
    if (input.current !== undefined && (!Number.isSafeInteger(input.current) || input.current < 0))
      throw new RangeError("Invalid job progress");
    if (input.total !== undefined && (!Number.isSafeInteger(input.total) || input.total < 0))
      throw new RangeError("Invalid job total");
    if (input.current !== undefined && input.total !== undefined && input.total < input.current)
      throw new RangeError("Invalid job total");
    const row = this.#database
      .prepare(
        `UPDATE hosted_job
            SET status = COALESCE(?, status),
                current = COALESCE(?, current),
                total = COALESCE(?, total),
                error = CASE WHEN ? THEN ? ELSE error END,
                updated_at = ?
          WHERE id = ?
            AND COALESCE(?, current) <= COALESCE(?, total)
        RETURNING *`,
      )
      .get(
        input.status ?? null,
        input.current ?? null,
        input.total ?? null,
        input.error === undefined ? 0 : 1,
        input.error ?? null,
        new Date().toISOString(),
        id,
        input.current ?? null,
        input.total ?? null,
      ) as JobRow | undefined;
    if (!row) {
      if (!this.getJob(id)) throw new RangeError(`Unknown hosted job ${id}`);
      throw new RangeError("Invalid job total");
    }
    return hostedJob(row);
  }

  enqueueMutation(
    mutation: HostedPlaylistMutation,
    dedupeKey = `${mutation.type}:${"playlistId" in mutation ? mutation.playlistId : mutation.provider}`,
  ): HostedOutboxEntry {
    const id = randomUUID();
    const now = new Date().toISOString();
    const playlistId = "playlistId" in mutation ? mutation.playlistId : "";
    const row = this.#database
      .prepare(
        `INSERT INTO hosted_outbox (
           id, dedupe_key, playlist_id, mutation_json, status, attempts, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)
         ON CONFLICT(dedupe_key) DO UPDATE SET
           playlist_id = excluded.playlist_id,
           mutation_json = excluded.mutation_json,
           status = 'queued',
           error = NULL,
           updated_at = excluded.updated_at
         RETURNING *`,
      )
      .get(id, dedupeKey, playlistId, JSON.stringify(mutation), now, now) as OutboxRow;
    return outboxEntry(row);
  }

  claimNextMutation(): HostedOutboxEntry | undefined {
    const row = this.#database
      .prepare(
        `UPDATE hosted_outbox
            SET status = 'running', attempts = attempts + 1, updated_at = ?
          WHERE id = (
            SELECT id FROM hosted_outbox
             WHERE status = 'queued'
             ORDER BY created_at, rowid
             LIMIT 1
          ) AND status = 'queued'
        RETURNING *`,
      )
      .get(new Date().toISOString()) as OutboxRow | undefined;
    return row ? outboxEntry(row) : undefined;
  }

  completeMutation(id: string): void {
    this.#database.prepare("DELETE FROM hosted_outbox WHERE id = ?").run(id);
  }

  failMutation(id: string, error: string, retry: boolean): HostedOutboxEntry {
    const row = this.#database
      .prepare(
        `UPDATE hosted_outbox SET status = ?, error = ?, updated_at = ? WHERE id = ?
         RETURNING *`,
      )
      .get(retry ? "queued" : "failed", error, new Date().toISOString(), id) as
      | OutboxRow
      | undefined;
    if (!row) throw new RangeError(`Unknown hosted outbox entry ${id}`);
    return outboxEntry(row);
  }

  getOutbox(id: string): HostedOutboxEntry | undefined {
    const row = this.#database.prepare("SELECT * FROM hosted_outbox WHERE id = ?").get(id) as
      | OutboxRow
      | undefined;
    return row ? outboxEntry(row) : undefined;
  }

  getOutboxByKey(dedupeKey: string): HostedOutboxEntry | undefined {
    const row = this.#database
      .prepare("SELECT * FROM hosted_outbox WHERE dedupe_key = ?")
      .get(dedupeKey) as OutboxRow | undefined;
    return row ? outboxEntry(row) : undefined;
  }

  getLatestPendingMutation(playlistId: string): HostedOutboxEntry | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM hosted_outbox
          WHERE playlist_id = ? AND status IN ('queued', 'running')
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get(playlistId) as OutboxRow | undefined;
    return row ? outboxEntry(row) : undefined;
  }

  #recoverInterruptedWork(): void {
    const now = new Date().toISOString();
    this.#database
      .prepare("UPDATE hosted_job SET status = 'queued', updated_at = ? WHERE status = 'running'")
      .run(now);
    this.#database
      .prepare(
        "UPDATE hosted_outbox SET status = 'queued', updated_at = ? WHERE status = 'running'",
      )
      .run(now);
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS playlist_state (
        provider TEXT NOT NULL CHECK (provider IN ('spotify', 'soundcloud')),
        remote_id TEXT NOT NULL,
        download_enabled INTEGER NOT NULL DEFAULT 0 CHECK (download_enabled IN (0, 1)),
        local_playlist_id TEXT,
        revision TEXT,
        sync_state TEXT NOT NULL DEFAULT 'idle'
          CHECK (sync_state IN ('idle', 'queued', 'syncing', 'error')),
        sync_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider, remote_id)
      );
      CREATE INDEX IF NOT EXISTS playlist_state_local_playlist
        ON playlist_state(local_playlist_id)
        WHERE local_playlist_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS track_mapping (
        provider TEXT NOT NULL CHECK (provider IN ('spotify', 'soundcloud')),
        remote_track_id TEXT NOT NULL,
        local_content_id TEXT,
        download_state TEXT NOT NULL DEFAULT 'remote'
          CHECK (download_state IN ('remote', 'queued', 'downloading', 'downloaded', 'error')),
        download_error TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider, remote_track_id)
      );
      CREATE INDEX IF NOT EXISTS track_mapping_provider_local_content
        ON track_mapping(provider, local_content_id)
        WHERE local_content_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS hosted_job (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind = 'download-playlist'),
        provider TEXT NOT NULL CHECK (provider IN ('spotify', 'soundcloud')),
        playlist_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        current INTEGER NOT NULL DEFAULT 0 CHECK (current >= 0),
        total INTEGER NOT NULL DEFAULT 0 CHECK (total >= current),
        error TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS hosted_job_status_created
        ON hosted_job(status, created_at);
      CREATE INDEX IF NOT EXISTS hosted_job_playlist_created
        ON hosted_job(provider, playlist_id, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS hosted_job_active_playlist
        ON hosted_job(provider, playlist_id, kind)
        WHERE status IN ('queued', 'running');
      CREATE TABLE IF NOT EXISTS hosted_outbox (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        playlist_id TEXT NOT NULL,
        mutation_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS hosted_outbox_status_created
        ON hosted_outbox(status, created_at);
      CREATE TABLE IF NOT EXISTS web_cache (
        cache_key TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS web_cache_expiry
        ON web_cache(expires_at);
    `);
  }
}

function playlistState(row: PlaylistStateRow): HostedPlaylistState {
  return {
    provider: row.provider,
    remoteId: row.remote_id,
    downloadEnabled: row.download_enabled === 1,
    localPlaylistId: row.local_playlist_id,
    revision: row.revision,
    syncState: row.sync_state,
    syncError: row.sync_error,
    ...(row.sync_total !== undefined && row.sync_total !== null && row.sync_total > 0
      ? { syncCurrent: row.sync_current ?? 0, syncTotal: row.sync_total }
      : {}),
    updatedAt: row.updated_at,
  };
}

function trackMapping(row: TrackMappingRow): HostedTrackMapping {
  return {
    provider: row.provider,
    remoteTrackId: row.remote_track_id,
    localContentId: row.local_content_id,
    downloadState: row.download_state,
    downloadError: row.download_error,
    updatedAt: row.updated_at,
  };
}

function hostedJob(row: JobRow): HostedPlaylistJob {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    playlistId: row.playlist_id,
    status: row.status,
    current: row.current,
    total: row.total,
    error: row.error,
    payload: parseObject(row.payload_json, "hosted job payload"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function outboxEntry(row: OutboxRow): HostedOutboxEntry {
  return {
    id: row.id,
    dedupeKey: row.dedupe_key,
    playlistId: row.playlist_id,
    mutation: JSON.parse(row.mutation_json) as HostedPlaylistMutation,
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseObject(value: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new TypeError(`Invalid ${label}`);
  return parsed as Record<string, unknown>;
}
