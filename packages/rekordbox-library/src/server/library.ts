import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ContentCueInput,
  type ContentCuePoint,
  DjmdContent,
  DjmdPlaylist,
  MasterDatabase,
  PlaylistType,
  getRekordboxAgentPid,
  getRekordboxPid,
  version as rekordboxVersion,
} from "@gakonst/rekordbox";
import {
  acquireRekordboxDatabaseLock,
  assertRekordboxStopped,
  backupRekordboxDatabase,
} from "@gakonst/tracks";
import { parseFile, selectCover } from "music-metadata";

import type {
  LibraryBootstrap,
  LibraryMutation,
  LibraryProcesses,
  MutationReceipt,
  PlaylistItem,
  TrackDetail,
  TrackCue,
  TrackSummary,
  TrackWaveform,
  TracksResponse,
} from "../shared/types.js";

export type TrackFilter = "all" | "analyzed" | "attention";

export type TrackQuery = {
  filter?: TrackFilter;
  limit?: number;
  offset?: number;
  playlistId?: string;
  q?: string;
};

export type LibraryOptions = {
  backupRoot?: string;
  dbPath?: string;
  getProcessState?: () => LibraryProcesses;
  key?: string;
  unlock?: boolean;
  writeEnabled?: boolean;
};

export type ArtworkAsset =
  | { kind: "file"; path: string }
  | { kind: "embedded"; contentType: string; data: Uint8Array };

type RawTrack = Record<string, unknown>;

type MutationStageStatus =
  | "pending"
  | "in-progress"
  | "succeeded"
  | "failed"
  | "skipped"
  | "not-applicable";

type MutationStage = {
  status: MutationStageStatus;
  finishedAt?: string;
  message?: string;
};

type MutationJournal = {
  schemaVersion: 1;
  mutationId: string;
  rekordboxVersion: string;
  dbPath: string;
  backupDirectory: string;
  startedAt: string;
  updatedAt: string;
  mutation: LibraryMutation;
  changedId?: string;
  stages: {
    database: MutationStage;
    sidecar: MutationStage;
    verification: MutationStage;
    receipt: MutationStage;
  };
  receipt?: MutationReceipt;
  error?: { name: string; message: string };
};

type PlaylistExpectation = {
  id: string;
  name: string;
  parentId: string;
  attribute: number;
};

type MembershipExpectation = {
  id: string;
  playlistId: string;
  contentId: string;
  trackNumber: number;
};

type MutationExpectation =
  | {
      type: "create-playlist";
      changedId: string;
      playlist: PlaylistExpectation;
      sidecarExpected: boolean;
    }
  | {
      type: "rename-playlist";
      changedId: string;
      playlist: PlaylistExpectation;
      sidecarExpected: boolean;
    }
  | {
      type: "delete-playlist";
      changedId: string;
      deletedPlaylists: PlaylistExpectation[];
      sidecarExpected: boolean;
    }
  | {
      type: "add-track" | "move-track";
      changedId: string;
      membership: MembershipExpectation;
      playlist: PlaylistExpectation;
      sidecarExpected: boolean;
    }
  | {
      type: "remove-track";
      changedId: string;
      membershipId: string;
      playlist: PlaylistExpectation;
      sidecarExpected: boolean;
    }
  | {
      type: "replace-playlist-tracks";
      changedId: string;
      contentIds: string[];
      memberships: MembershipExpectation[];
      playlist: PlaylistExpectation;
      sidecarExpected: boolean;
    }
  | {
      type: "upsert-cue";
      changedId: string;
      cue: ContentCuePoint;
      sidecarExpected: false;
    }
  | {
      type: "delete-cue";
      changedId: string;
      contentId: string;
      sidecarExpected: false;
    };

type MutationProbe = {
  databaseError?: Error;
  sidecarError?: Error;
};

/** Mutation failure with durable recovery locations and observed commit state. */
export class LibraryMutationError extends Error {
  readonly backupDirectory: string;
  readonly journalPath: string;
  readonly databaseCommitted: boolean | undefined;
  readonly sidecarCommitted: boolean | undefined;

  constructor(
    message: string,
    options: {
      backupDirectory: string;
      cause: unknown;
      databaseCommitted: boolean | undefined;
      journalPath: string;
      sidecarCommitted: boolean | undefined;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "LibraryMutationError";
    this.backupDirectory = options.backupDirectory;
    this.journalPath = options.journalPath;
    this.databaseCommitted = options.databaseCommitted;
    this.sidecarCommitted = options.sidecarCommitted;
  }
}

/** Refuses a stale destructive write whose source snapshot no longer matches master.db. */
export class LibraryMutationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryMutationConflictError";
  }
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function numberValue(value: unknown, fallback = 0): number {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function fileExists(path: string | null): boolean {
  if (!path) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function mapTrack(row: RawTrack): TrackSummary {
  const path = nullableString(row.path);
  const artworkPath = nullableString(row.artworkPath);
  const bpmHundredths = nullableNumber(row.bpmHundredths);
  const membershipId = nullableString(row.playlistMembershipId);
  const trackNumber = nullableNumber(row.trackNumber);
  return {
    id: stringValue(row.id),
    title: stringValue(row.title, "Untitled"),
    artist: nullableString(row.artist),
    album: nullableString(row.album),
    genre: nullableString(row.genre),
    key: nullableString(row.keyName),
    bpm: bpmHundredths === null || bpmHundredths <= 0 ? null : bpmHundredths / 100,
    durationSeconds: nullableNumber(row.durationSeconds),
    rating: numberValue(row.rating),
    playCount: numberValue(row.playCount),
    analyzed: Boolean(nullableString(row.analysisPath)) && numberValue(row.analysed) > 0,
    artworkAvailable: fileExists(artworkPath),
    fileExists: fileExists(path),
    path,
    ...(membershipId === null ? {} : { playlistMembershipId: membershipId }),
    ...(trackNumber === null ? {} : { trackNumber }),
  };
}

function normalizeWaveform(values: number[], maximum = 2_048): number[] {
  if (!values.length) return [];
  const finite = values.map((value) => (Number.isFinite(value) ? Math.max(0, value) : 0));
  const peak = finite.reduce((maximumValue, value) => Math.max(maximumValue, value), 1);
  if (finite.length <= maximum)
    return finite.map((value) => Math.round((value / peak) * 10_000) / 10_000);
  const reduced = Array.from({ length: maximum }, (_, index) => {
    const start = Math.floor((index * finite.length) / maximum);
    const end = Math.max(start + 1, Math.floor(((index + 1) * finite.length) / maximum));
    let binPeak = 0;
    for (let offset = start; offset < end; offset++)
      binPeak = Math.max(binPeak, finite[offset] ?? 0);
    return binPeak / peak;
  });
  return reduced.map((value) => Math.round(value * 10_000) / 10_000);
}

function waveformHeights(value: unknown): number[] {
  if (!value || typeof value !== "object") return [];
  const heights = (value as { heights?: unknown }).heights;
  if (!Array.isArray(heights)) return [];
  return heights.flatMap((height): number[] => {
    if (typeof height === "number") return [height];
    if (Array.isArray(height)) {
      const numbers = height.filter((entry): entry is number => typeof entry === "number");
      return numbers.length ? [Math.max(...numbers)] : [];
    }
    return [];
  });
}

function normalizeArtworkContentType(format: string, source: string): string {
  const normalized = format.trim().toLocaleLowerCase();
  if (normalized === "image/jpg" || normalized === "jpg" || normalized === "jpeg")
    return "image/jpeg";
  if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(normalized))
    return normalized;
  throw new TypeError(`Embedded artwork in '${source}' uses unsupported format '${format}'`);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorRecord(error: unknown): { name: string; message: string } {
  const normalized = asError(error);
  return { name: normalized.name, message: normalized.message };
}

function stageStatus(status: MutationStageStatus, error?: unknown): MutationStage {
  return {
    status,
    ...(status === "pending" || status === "in-progress"
      ? {}
      : { finishedAt: new Date().toISOString() }),
    ...(error === undefined ? {} : { message: asError(error).message }),
  };
}

function committed(status: MutationStageStatus): boolean | undefined {
  if (status === "succeeded") return true;
  if (status === "failed" || status === "skipped") return false;
  return undefined;
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      !["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(String(error.code))
    )
      throw error;
  } finally {
    await handle?.close();
  }
}

async function writeJournal(
  path: string,
  journal: MutationJournal,
  exclusive = false,
): Promise<void> {
  journal.updatedAt = new Date().toISOString();
  const contents = `${JSON.stringify(journal, null, 2)}\n`;
  if (exclusive) {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(path));
    return;
  }

  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Direct TypeScript service behind the local Rekordbox library workbench. */
export class RekordboxLibraryService {
  readonly backupRoot: string | undefined;
  readonly dbPath: string | undefined;
  readonly key: string | undefined;
  readonly unlock: boolean;
  readonly writeEnabled: boolean;

  private readonly getProcessState: () => LibraryProcesses;

  constructor(options: LibraryOptions = {}) {
    this.backupRoot = options.backupRoot;
    this.dbPath = options.dbPath;
    this.key = options.key;
    this.unlock = options.unlock ?? true;
    this.writeEnabled = options.writeEnabled ?? false;
    this.getProcessState =
      options.getProcessState ??
      (() => ({
        rekordboxPid: getRekordboxPid(),
        rekordboxAgentPid: getRekordboxAgentPid(),
      }));
  }

  private open(readonly = true): MasterDatabase {
    return new MasterDatabase({
      readonly,
      unlock: this.unlock,
      ...(this.dbPath === undefined ? {} : { path: this.dbPath }),
      ...(this.key === undefined ? {} : { key: this.key }),
    });
  }

  private openAt(dbPath: string, readonly = true, includeSidecar = true): MasterDatabase {
    return new MasterDatabase({
      path: dbPath,
      readonly,
      unlock: this.unlock,
      ...(includeSidecar
        ? {}
        : { dbDirectory: join(dirname(dbPath), ".rekordbox-library-database-only") }),
      ...(this.key === undefined ? {} : { key: this.key }),
    });
  }

  private active(db: MasterDatabase, table: string, alias: string): string {
    return db.hasColumn(table, "rb_local_deleted")
      ? `(${alias}."rb_local_deleted" IS NULL OR ${alias}."rb_local_deleted" = 0)`
      : "1 = 1";
  }

  private scalar(db: MasterDatabase, sql: string, parameters: unknown[] = []): number {
    const row = db.selectRawRows(sql, parameters)[0];
    return numberValue(row?.count);
  }

  /** Return library identity, process state, safety mode, and health counts. */
  getBootstrap(csrfToken: string): LibraryBootstrap {
    const db = this.open();
    try {
      const activeContent = this.active(db, "djmdContent", "c");
      const activePlaylist = this.active(db, "djmdPlaylist", "p");
      const tracks = this.scalar(
        db,
        `SELECT COUNT(*) AS count FROM "djmdContent" c WHERE ${activeContent}`,
      );
      const analyzed = this.scalar(
        db,
        `SELECT COUNT(*) AS count FROM "djmdContent" c
         WHERE ${activeContent} AND c."AnalysisDataPath" IS NOT NULL
           AND c."AnalysisDataPath" != '' AND COALESCE(c."Analysed", 0) > 0`,
      );
      const missingBpm = this.scalar(
        db,
        `SELECT COUNT(*) AS count FROM "djmdContent" c
         WHERE ${activeContent} AND COALESCE(c."BPM", 0) <= 0`,
      );
      const missingKey = this.scalar(
        db,
        `SELECT COUNT(*) AS count FROM "djmdContent" c
         WHERE ${activeContent} AND (c."KeyID" IS NULL OR c."KeyID" = '')`,
      );
      const playlistRows = db.selectRawRows<{ attribute: number; count: number }>(
        `SELECT p."Attribute" AS attribute, COUNT(*) AS count FROM "djmdPlaylist" p
         WHERE ${activePlaylist} AND p."Attribute" IN (?, ?, ?)
         GROUP BY p."Attribute"`,
        [PlaylistType.PLAYLIST, PlaylistType.FOLDER, PlaylistType.SMART_PLAYLIST],
      );
      const countByAttribute = new Map(
        playlistRows.map((row) => [numberValue(row.attribute), numberValue(row.count)]),
      );
      return {
        csrfToken,
        library: {
          dbPath: db.path,
          dbDirectory: db.dbDirectory,
          writeEnabled: this.writeEnabled,
          processes: this.getProcessState(),
          stats: {
            tracks,
            playlists:
              (countByAttribute.get(PlaylistType.PLAYLIST) ?? 0) +
              (countByAttribute.get(PlaylistType.SMART_PLAYLIST) ?? 0),
            folders: countByAttribute.get(PlaylistType.FOLDER) ?? 0,
            analyzed,
            missingAnalysis: tracks - analyzed,
            missingBpm,
            missingKey,
          },
        },
      };
    } finally {
      db.close();
    }
  }

  /** Return the active playlist hierarchy and direct membership counts. */
  getPlaylists(): PlaylistItem[] {
    const db = this.open();
    try {
      return db.listPlaylists().map((playlist) => ({
        id: playlist.id,
        name: playlist.name || "Untitled playlist",
        parentId: playlist.parentId,
        seq: playlist.sequence,
        type: playlist.type,
        trackCount: playlist.trackCount,
        ...(playlist.countError === undefined ? {} : { countError: playlist.countError }),
      }));
    } finally {
      db.close();
    }
  }

  /** Search or page through tracks, preserving normal-playlist membership order. */
  getTracks(options: TrackQuery = {}): TracksResponse {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    const filter = options.filter ?? "all";
    const q = options.q?.trim() ?? "";
    const db = this.open();
    try {
      if (options.playlistId) {
        const activePlaylist = db.selectRawRows(
          `SELECT p."ID" FROM "djmdPlaylist" p
           WHERE p."ID" = ? AND ${this.active(db, "djmdPlaylist", "p")}`,
          [options.playlistId],
        )[0];
        if (!activePlaylist) throw new RangeError(`Playlist '${options.playlistId}' was not found`);
        const playlist = db.query(DjmdPlaylist).where({ ID: options.playlistId }).one();
        if (Number(playlist.Attribute) === PlaylistType.FOLDER)
          throw new TypeError("A playlist folder has no track contents");
        if (Number(playlist.Attribute) === PlaylistType.SMART_PLAYLIST)
          return this.getSmartPlaylistTracks(db, playlist, { filter, limit, offset, q });
      }

      const parameters: unknown[] = [];
      const membershipJoin = options.playlistId
        ? `JOIN "djmdSongPlaylist" membership
             ON membership."ContentID" = content."ID" AND membership."PlaylistID" = ?
            AND ${this.active(db, "djmdSongPlaylist", "membership")}`
        : "";
      if (options.playlistId) parameters.push(options.playlistId);
      const where = [this.active(db, "djmdContent", "content")];
      if (q) {
        const pattern = `%${q.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
        where.push(`(content."Title" LIKE ? ESCAPE '\\' OR artist."Name" LIKE ? ESCAPE '\\'
          OR album."Name" LIKE ? ESCAPE '\\' OR content."FileNameL" LIKE ? ESCAPE '\\')`);
        parameters.push(pattern, pattern, pattern, pattern);
      }
      if (filter === "analyzed")
        where.push(
          `content."AnalysisDataPath" IS NOT NULL AND content."AnalysisDataPath" != ''
           AND COALESCE(content."Analysed", 0) > 0`,
        );
      if (filter === "attention")
        where.push(
          `(content."AnalysisDataPath" IS NULL OR content."AnalysisDataPath" = ''
            OR COALESCE(content."Analysed", 0) <= 0 OR COALESCE(content."BPM", 0) <= 0
            OR content."KeyID" IS NULL OR content."KeyID" = '')`,
        );
      const from = `FROM "djmdContent" content
        ${membershipJoin}
        LEFT JOIN "djmdArtist" artist ON artist."ID" = content."ArtistID"
        LEFT JOIN "djmdAlbum" album ON album."ID" = content."AlbumID"
        LEFT JOIN "djmdGenre" genre ON genre."ID" = content."GenreID"
        LEFT JOIN "djmdKey" keyRow ON keyRow."ID" = content."KeyID"`;
      const predicate = where.join(" AND ");
      const count = this.scalar(
        db,
        `SELECT COUNT(*) AS count ${from} WHERE ${predicate}`,
        parameters,
      );
      const order = options.playlistId
        ? `membership."TrackNo", content."Title" COLLATE NOCASE, membership."ID"`
        : `content."Title" COLLATE NOCASE, artist."Name" COLLATE NOCASE, content."ID"`;
      const rows = db.selectRawRows(
        `SELECT content."ID" AS id, content."Title" AS title,
                content."FolderPath" AS path, content."BPM" AS bpmHundredths,
                content."Length" AS durationSeconds, content."Rating" AS rating,
                content."DJPlayCount" AS playCount, content."AnalysisDataPath" AS analysisPath,
                content."Analysed" AS analysed, artist."Name" AS artist,
                album."Name" AS album, album."ImagePath" AS artworkPath,
                genre."Name" AS genre, keyRow."ScaleName" AS keyName
                ${options.playlistId ? ', membership."ID" AS playlistMembershipId, membership."TrackNo" AS trackNumber' : ""}
         ${from} WHERE ${predicate} ORDER BY ${order} LIMIT ? OFFSET ?`,
        [...parameters, limit, offset],
      );
      return { items: rows.map(mapTrack), count, limit, offset };
    } finally {
      db.close();
    }
  }

  private getSmartPlaylistTracks(
    db: MasterDatabase,
    playlist: DjmdPlaylist,
    options: Required<Pick<TrackQuery, "filter" | "limit" | "offset">> & { q: string },
  ): TracksResponse {
    const normalizedQuery = options.q.toLocaleLowerCase();
    const rows = db
      .getPlaylistContents(playlist)
      .all()
      .map((content) => this.mapContentModel(content))
      .filter((track) => {
        if (
          normalizedQuery &&
          ![track.title, track.artist, track.album, track.path]
            .filter((value): value is string => value !== null)
            .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
        )
          return false;
        if (options.filter === "analyzed") return track.analyzed;
        if (options.filter === "attention") return !track.analyzed || !track.bpm || !track.key;
        return true;
      });
    return {
      items: rows.slice(options.offset, options.offset + options.limit),
      count: rows.length,
      limit: options.limit,
      offset: options.offset,
    };
  }

  private mapContentModel(content: DjmdContent): TrackSummary {
    return mapTrack({
      id: content.ID,
      title: content.Title,
      path: content.FolderPath,
      bpmHundredths: content.get("BPM"),
      durationSeconds: content.get("Length"),
      rating: content.get("Rating"),
      playCount: content.get("DJPlayCount"),
      analysisPath: content.AnalysisDataPath,
      analysed: content.Analysed,
      artist: content.ArtistName,
      album: content.AlbumName,
      artworkPath: content.Album?.get("ImagePath"),
      genre: content.GenreName,
      keyName: content.KeyName,
    });
  }

  /** Return full metadata, analysis state, and playlist memberships for one track. */
  getTrack(id: string): TrackDetail {
    const db = this.open();
    try {
      const rows = db.selectRawRows(
        `SELECT content."ID" AS id, content."Title" AS title,
                content."FolderPath" AS path, content."BPM" AS bpmHundredths,
                content."Length" AS durationSeconds, content."Rating" AS rating,
                content."DJPlayCount" AS playCount, content."AnalysisDataPath" AS analysisPath,
                content."Analysed" AS analysed, content."Commnt" AS comment,
                content."ISRC" AS isrc, content."ReleaseYear" AS releaseYear,
                content."BitRate" AS bitRate, content."SampleRate" AS sampleRate,
                content."FileSize" AS fileSize, artist."Name" AS artist,
                album."Name" AS album, album."ImagePath" AS artworkPath,
                genre."Name" AS genre, keyRow."ScaleName" AS keyName
         FROM "djmdContent" content
         LEFT JOIN "djmdArtist" artist ON artist."ID" = content."ArtistID"
         LEFT JOIN "djmdAlbum" album ON album."ID" = content."AlbumID"
         LEFT JOIN "djmdGenre" genre ON genre."ID" = content."GenreID"
         LEFT JOIN "djmdKey" keyRow ON keyRow."ID" = content."KeyID"
         WHERE content."ID" = ? AND ${this.active(db, "djmdContent", "content")}`,
        [id],
      );
      const row = rows[0];
      if (!row) throw new RangeError(`Track '${id}' was not found`);
      const summary = mapTrack(row);
      const memberships = db.selectRawRows(
        `SELECT playlist."ID" AS id, playlist."Name" AS name,
                membership."ID" AS membershipId, membership."TrackNo" AS trackNumber
         FROM "djmdSongPlaylist" membership
         JOIN "djmdPlaylist" playlist ON playlist."ID" = membership."PlaylistID"
         WHERE membership."ContentID" = ?
           AND ${this.active(db, "djmdSongPlaylist", "membership")}
           AND ${this.active(db, "djmdPlaylist", "playlist")}
         ORDER BY playlist."Name" COLLATE NOCASE, membership."TrackNo"`,
        [id],
      );
      return {
        ...summary,
        comment: nullableString(row.comment),
        isrc: nullableString(row.isrc),
        releaseYear: nullableNumber(row.releaseYear),
        bitRate: nullableNumber(row.bitRate),
        sampleRate: nullableNumber(row.sampleRate),
        fileSize: nullableNumber(row.fileSize),
        analysisPath: nullableString(row.analysisPath),
        cues: db.getContentCues(id) as TrackCue[],
        playlists: memberships.map((membership) => ({
          id: stringValue(membership.id),
          name: stringValue(membership.name),
          membershipId: stringValue(membership.membershipId),
          trackNumber: numberValue(membership.trackNumber),
        })),
      };
    } finally {
      db.close();
    }
  }

  /** Resolve a trusted database-owned audio path for range streaming. */
  getAudioPath(id: string): string {
    const db = this.open();
    let path: string | null;
    try {
      const row = db.selectRawRows(
        `SELECT content."FolderPath" AS path FROM "djmdContent" content
         WHERE content."ID" = ? AND ${this.active(db, "djmdContent", "content")}`,
        [id],
      )[0];
      if (!row) throw new RangeError(`Track '${id}' was not found`);
      path = nullableString(row.path);
    } finally {
      db.close();
    }
    if (!path || !existsSync(path) || !fileExists(path))
      throw new RangeError(`Audio for track '${id}' is unavailable`);
    return path;
  }

  /** Resolve Rekordbox artwork or read the recording's embedded front cover. */
  async getArtwork(id: string): Promise<ArtworkAsset> {
    const db = this.open();
    let audioPath: string | null = null;
    let rawArtwork: string | null = null;
    try {
      const row = db.selectRawRows(
        `SELECT album."ImagePath" AS artworkPath, content."FolderPath" AS audioPath
         FROM "djmdContent" content
         LEFT JOIN "djmdAlbum" album ON album."ID" = content."AlbumID"
         WHERE content."ID" = ? AND ${this.active(db, "djmdContent", "content")}`,
        [id],
      )[0];
      if (!row) throw new RangeError(`Track '${id}' was not found`);
      rawArtwork = nullableString(row.artworkPath);
      audioPath = nullableString(row.audioPath);
      if (rawArtwork) {
        let filePath = rawArtwork;
        if (rawArtwork.startsWith("file:")) {
          try {
            filePath = fileURLToPath(rawArtwork);
          } catch {
            filePath = "";
          }
        }
        const relativePath = filePath.replace(/^[/\\]+/u, "");
        const candidates = isAbsolute(filePath)
          ? [resolve(filePath)]
          : [
              resolve(db.dbDirectory, filePath),
              resolve(db.shareDirectory, filePath),
              resolve(db.dbDirectory, relativePath),
              resolve(db.shareDirectory, relativePath),
            ];
        const artwork = candidates.find((candidate) => fileExists(candidate));
        if (artwork) return { kind: "file", path: artwork };
      }
    } finally {
      db.close();
    }

    if (!audioPath || !fileExists(audioPath))
      throw new RangeError(`Artwork for track '${id}' is unavailable`);
    try {
      const requested = resolve(audioPath);
      const source = lstatSync(requested);
      if (source.isSymbolicLink() || !source.isFile() || realpathSync(requested) !== requested)
        throw new Error("Audio source is not a regular file");
      const metadata = await parseFile(requested, { duration: false, skipCovers: false });
      const cover = selectCover(metadata.common.picture);
      if (!cover || !cover.data.byteLength || cover.data.byteLength > 16 * 1024 * 1024)
        throw new Error("No bounded embedded cover is available");
      const contentType = normalizeArtworkContentType(cover.format, requested);
      return { kind: "embedded", contentType, data: cover.data };
    } catch (error) {
      if (error instanceof RangeError) throw error;
      throw new RangeError(`Artwork for track '${id}' is unavailable`, { cause: error });
    }
  }

  /** Return bounded precomputed Rekordbox peaks or a streaming-safe placeholder instruction. */
  getWaveform(id: string): TrackWaveform {
    const db = this.open();
    try {
      const row = db.selectRawRows(
        `SELECT content."Length" AS durationSeconds
         FROM "djmdContent" content
         WHERE content."ID" = ? AND ${this.active(db, "djmdContent", "content")}`,
        [id],
      )[0];
      if (!row) throw new RangeError(`Track '${id}' was not found`);
      let peaks: number[] = [];
      try {
        const files = [...db.readContentAnlzFiles(id).values()];
        for (const key of ["PWV5", "PWV4", "PWV3", "PWV2", "PWAV"]) {
          for (const file of files) {
            if (!file.has(key)) continue;
            peaks = waveformHeights(file.get(key));
            if (peaks.length) break;
          }
          if (peaks.length) break;
        }
      } catch {
        // Missing or malformed analysis is expected for unanalysed tracks; WaveSurfer decodes audio.
      }
      return {
        durationSeconds: nullableNumber(row.durationSeconds),
        peaks: normalizeWaveform(peaks),
        source: peaks.length ? "rekordbox" : "placeholder",
      };
    } finally {
      db.close();
    }
  }

  /** Apply one guarded playlist mutation and return its recovery receipt. */
  async mutate(mutation: LibraryMutation): Promise<MutationReceipt> {
    if (!this.writeEnabled)
      throw new Error("Library write mode is disabled; restart with the explicit --write flag");

    const location = this.open();
    const dbPath = realpathSync(location.path);
    const dbDirectory = dirname(dbPath);
    location.close();
    const releaseLock = await acquireRekordboxDatabaseLock(dbPath);
    try {
      this.assertStopped();
      const preflight = this.openAt(dbPath, true, false);
      try {
        this.assertMutationPrecondition(preflight, mutation);
      } finally {
        preflight.close();
      }
      const backup = await backupRekordboxDatabase(dbDirectory, {
        dbPath,
        ...(this.backupRoot === undefined ? {} : { backupRoot: this.backupRoot }),
      });
      const mutationId = randomUUID();
      const journalPath = join(backup.directory, `library-mutation-${mutationId}.json`);
      const startedAt = new Date().toISOString();
      const journal: MutationJournal = {
        schemaVersion: 1,
        mutationId,
        rekordboxVersion,
        dbPath,
        backupDirectory: backup.directory,
        startedAt,
        updatedAt: startedAt,
        mutation,
        stages: {
          database: stageStatus("pending"),
          sidecar: stageStatus("pending"),
          verification: stageStatus("pending"),
          receipt: stageStatus("pending"),
        },
      };
      let journalWritten = false;
      let expectation: MutationExpectation | undefined;
      let commitStarted = false;
      try {
        await writeJournal(journalPath, journal, true);
        journalWritten = true;
        this.assertStopped();
        const writer = this.openAt(dbPath, false);
        try {
          expectation = this.applyMutation(writer, mutation);
          journal.changedId = expectation.changedId;
          journal.stages.database = stageStatus("in-progress");
          journal.stages.sidecar = stageStatus(
            expectation.sidecarExpected ? "in-progress" : "not-applicable",
          );
          await writeJournal(journalPath, journal);
          this.assertStopped();
          commitStarted = true;
          writer.commit({ allowWhileRunning: false });
        } finally {
          writer.close();
        }

        journal.stages.database = stageStatus("succeeded");
        if (expectation.sidecarExpected) journal.stages.sidecar = stageStatus("succeeded");
        await writeJournal(journalPath, journal);

        journal.stages.verification = stageStatus("in-progress");
        await writeJournal(journalPath, journal);
        const probe = this.probeMutation(dbPath, expectation);
        const verificationErrors = [probe.databaseError, probe.sidecarError].filter(
          (error): error is Error => error !== undefined,
        );
        if (verificationErrors.length)
          throw new AggregateError(verificationErrors, "Rekordbox mutation verification failed");
        journal.stages.verification = stageStatus("succeeded");
        await writeJournal(journalPath, journal);

        const receipt: MutationReceipt = {
          operation: mutation.type,
          changedId: expectation.changedId,
          backupDirectory: backup.directory,
          quickCheck: "ok",
          foreignKeyViolationCount: 0,
          finishedAt: new Date().toISOString(),
        };
        journal.receipt = receipt;
        journal.stages.receipt = stageStatus("succeeded");
        await writeJournal(journalPath, journal);
        return receipt;
      } catch (error) {
        let failure: unknown = error;
        if (commitStarted && expectation) {
          const probe = this.probeMutation(dbPath, expectation);
          journal.stages.database = probe.databaseError
            ? stageStatus("failed", probe.databaseError)
            : stageStatus("succeeded");
          journal.stages.sidecar = expectation.sidecarExpected
            ? probe.sidecarError
              ? stageStatus("failed", probe.sidecarError)
              : stageStatus("succeeded")
            : stageStatus("not-applicable");
          const verificationError = probe.databaseError ?? probe.sidecarError;
          journal.stages.verification = verificationError
            ? stageStatus("failed", verificationError)
            : stageStatus("succeeded");
        } else {
          journal.stages.database = stageStatus("skipped", error);
          journal.stages.sidecar = stageStatus("skipped", error);
          journal.stages.verification = stageStatus("skipped", error);
        }
        journal.stages.receipt = stageStatus("failed", error);
        journal.error = errorRecord(error);
        try {
          if (journalWritten || existsSync(journalPath)) await writeJournal(journalPath, journal);
        } catch (journalError) {
          failure = new AggregateError(
            [asError(error), asError(journalError)],
            "Mutation failed and its outcome journal could not be updated",
          );
        }

        if (error instanceof LibraryMutationConflictError && !commitStarted) throw error;

        const databaseCommitted = committed(journal.stages.database.status);
        const sidecarCommitted = committed(journal.stages.sidecar.status);
        const state =
          databaseCommitted === true && journal.stages.sidecar.status === "failed"
            ? " after the database committed but before the playlist sidecar was verified"
            : databaseCommitted === true
              ? " after the database and playlist sidecar committed"
              : " before a verified database commit";
        throw new LibraryMutationError(
          `Library mutation '${mutation.type}' failed${state}; recovery backup: ${backup.directory}; outcome journal: ${journalPath}`,
          {
            backupDirectory: backup.directory,
            cause: failure,
            databaseCommitted,
            journalPath,
            sidecarCommitted,
          },
        );
      }
    } finally {
      await releaseLock();
    }
  }

  private assertStopped(): void {
    assertRekordboxStopped(this.getProcessState());
  }

  private assertMutationPrecondition(db: MasterDatabase, mutation: LibraryMutation): void {
    if (mutation.type === "replace-playlist-tracks") {
      this.requireNormalPlaylist(db, mutation.playlistId);
      const currentMembershipIds = db
        .selectRawRows(
          `SELECT membership."ID" AS id FROM "djmdSongPlaylist" membership
           WHERE membership."PlaylistID" = ?
             AND ${this.active(db, "djmdSongPlaylist", "membership")}
           ORDER BY membership."TrackNo", membership."ID"`,
          [mutation.playlistId],
        )
        .map((row) => stringValue(row.id));
      if (JSON.stringify(currentMembershipIds) !== JSON.stringify(mutation.expectedMembershipIds))
        throw new LibraryMutationConflictError(
          `Playlist '${mutation.playlistId}' changed after the canvas snapshot; reload it before applying order`,
        );
      return;
    }
    if (mutation.type === "delete-playlist") {
      const currentPlaylistIds = this.getActivePlaylistSubtree(db, mutation.playlistId)
        .map((playlist) => playlist.id)
        .sort();
      const expectedPlaylistIds = [...mutation.expectedPlaylistIds].sort();
      if (
        new Set(expectedPlaylistIds).size !== expectedPlaylistIds.length ||
        !expectedPlaylistIds.includes(mutation.playlistId) ||
        JSON.stringify(currentPlaylistIds) !== JSON.stringify(expectedPlaylistIds)
      )
        throw new LibraryMutationConflictError(
          `Playlist '${mutation.playlistId}' changed after deletion was confirmed; review its subtree and try again`,
        );
    }
  }

  private applyMutation(db: MasterDatabase, mutation: LibraryMutation): MutationExpectation {
    const sidecarExpected = db.playlistXml !== undefined;
    switch (mutation.type) {
      case "create-playlist": {
        const name = mutation.name.trim();
        if (!name) throw new TypeError("Playlist name must not be empty");
        if (mutation.parentId) {
          const parent = this.requireActivePlaylist(db, mutation.parentId);
          if (parent.attribute !== PlaylistType.FOLDER)
            throw new TypeError("Playlist parent must be a folder");
        }
        const options = mutation.parentId ? { parent: mutation.parentId } : {};
        const playlist =
          mutation.kind === "folder"
            ? db.createPlaylistFolder(name, options)
            : db.createPlaylist(name, options);
        return {
          type: mutation.type,
          changedId: playlist.ID,
          playlist: {
            id: playlist.ID,
            name,
            parentId: playlist.ParentID,
            attribute: Number(playlist.Attribute),
          },
          sidecarExpected,
        };
      }
      case "rename-playlist": {
        const name = mutation.name.trim();
        if (!name) throw new TypeError("Playlist name must not be empty");
        const playlist = this.requireActivePlaylist(db, mutation.playlistId);
        db.renamePlaylist(mutation.playlistId, name);
        return {
          type: mutation.type,
          changedId: mutation.playlistId,
          playlist: { ...playlist, name },
          sidecarExpected,
        };
      }
      case "delete-playlist": {
        this.assertMutationPrecondition(db, mutation);
        const deletedPlaylists = this.getActivePlaylistSubtree(db, mutation.playlistId);
        if (!deletedPlaylists.length)
          throw new RangeError(`Playlist '${mutation.playlistId}' was not found`);
        db.deletePlaylist(mutation.playlistId);
        return {
          type: mutation.type,
          changedId: mutation.playlistId,
          deletedPlaylists,
          sidecarExpected,
        };
      }
      case "add-track": {
        const playlist = this.requireNormalPlaylist(db, mutation.playlistId);
        this.requireActiveContent(db, mutation.contentId);
        this.assertSafeMembershipState(db, mutation.playlistId);
        const membership = db.addToPlaylist(
          mutation.playlistId,
          mutation.contentId,
          mutation.trackNumber,
        );
        return {
          type: mutation.type,
          changedId: membership.ID,
          membership: {
            id: membership.ID,
            playlistId: membership.PlaylistID,
            contentId: membership.ContentID,
            trackNumber: Number(membership.TrackNo),
          },
          playlist,
          sidecarExpected,
        };
      }
      case "remove-track": {
        const playlist = this.requireNormalPlaylist(db, mutation.playlistId);
        this.assertSafeMembershipState(db, mutation.playlistId);
        const membership = this.requireActiveMembership(db, mutation.membershipId);
        if (membership.playlistId !== mutation.playlistId)
          throw new TypeError("Song is not in the supplied playlist");
        db.removeFromPlaylist(mutation.playlistId, mutation.membershipId);
        return {
          type: mutation.type,
          changedId: mutation.membershipId,
          membershipId: mutation.membershipId,
          playlist,
          sidecarExpected,
        };
      }
      case "move-track": {
        const playlist = this.requireNormalPlaylist(db, mutation.playlistId);
        this.assertSafeMembershipState(db, mutation.playlistId);
        const membership = this.requireActiveMembership(db, mutation.membershipId);
        if (membership.playlistId !== mutation.playlistId)
          throw new TypeError("Song is not in the supplied playlist");
        db.moveSongInPlaylist(mutation.playlistId, mutation.membershipId, mutation.trackNumber);
        return {
          type: mutation.type,
          changedId: mutation.membershipId,
          membership: { ...membership, trackNumber: mutation.trackNumber },
          playlist,
          sidecarExpected,
        };
      }
      case "replace-playlist-tracks": {
        this.assertMutationPrecondition(db, mutation);
        const playlist = this.requireNormalPlaylist(db, mutation.playlistId);
        this.assertSafeMembershipState(db, mutation.playlistId);
        for (const contentId of mutation.contentIds) this.requireActiveContent(db, contentId);
        const existing = db.selectRawRows(
          `SELECT membership."ID" AS id,
                  membership."ContentID" AS contentId,
                  membership."TrackNo" AS trackNumber
           FROM "djmdSongPlaylist" membership
           WHERE membership."PlaylistID" = ?
             AND ${this.active(db, "djmdSongPlaylist", "membership")}
           ORDER BY membership."TrackNo", membership."ID"`,
          [mutation.playlistId],
        );
        const availableByContent = new Map<string, Array<{ id: string; trackNumber: number }>>();
        for (const row of existing) {
          const contentId = stringValue(row.contentId);
          const matches = availableByContent.get(contentId) ?? [];
          matches.push({ id: stringValue(row.id), trackNumber: Number(row.trackNumber) });
          availableByContent.set(contentId, matches);
        }
        const desired = mutation.contentIds.map((contentId) => ({
          contentId,
          existing: availableByContent.get(contentId)?.shift(),
        }));
        const removed = [...availableByContent.values()].flat();
        for (const membership of removed.sort(
          (left, right) => right.trackNumber - left.trackNumber,
        ))
          db.removeFromPlaylist(mutation.playlistId, membership.id);

        const memberships = desired.map((entry, index): MembershipExpectation => {
          const trackNumber = index + 1;
          if (entry.existing) {
            db.moveSongInPlaylist(mutation.playlistId, entry.existing.id, trackNumber);
            return {
              id: entry.existing.id,
              playlistId: mutation.playlistId,
              contentId: entry.contentId,
              trackNumber,
            };
          }
          const membership = db.addToPlaylist(mutation.playlistId, entry.contentId, trackNumber);
          return {
            id: membership.ID,
            playlistId: membership.PlaylistID,
            contentId: membership.ContentID,
            trackNumber: Number(membership.TrackNo),
          };
        });
        return {
          type: mutation.type,
          changedId: mutation.playlistId,
          contentIds: [...mutation.contentIds],
          memberships,
          playlist,
          sidecarExpected,
        };
      }
      case "upsert-cue": {
        this.requireActiveContent(db, mutation.contentId);
        const cue = db.upsertContentCue(mutation.contentId, mutation.cue as ContentCueInput);
        return {
          type: mutation.type,
          changedId: cue.id,
          cue,
          sidecarExpected: false,
        };
      }
      case "delete-cue": {
        this.requireActiveContent(db, mutation.contentId);
        db.deleteContentCue(mutation.contentId, mutation.cueId);
        return {
          type: mutation.type,
          changedId: mutation.cueId,
          contentId: mutation.contentId,
          sidecarExpected: false,
        };
      }
    }
  }

  private probeMutation(dbPath: string, expectation: MutationExpectation): MutationProbe {
    const probe: MutationProbe = {};
    let database: MasterDatabase | undefined;
    try {
      database = this.openAt(dbPath, true, false);
      this.verifyDatabaseMutation(database, expectation);
    } catch (error) {
      probe.databaseError = asError(error);
    } finally {
      database?.close();
    }

    if (!expectation.sidecarExpected) return probe;
    let sidecar: MasterDatabase | undefined;
    try {
      sidecar = this.openAt(dbPath);
      this.verifySidecarMutation(sidecar, expectation);
    } catch (error) {
      probe.sidecarError = asError(error);
    } finally {
      sidecar?.close();
    }
    return probe;
  }

  private verifyDatabaseMutation(db: MasterDatabase, expectation: MutationExpectation): void {
    const quickRows = db.selectRawRows("PRAGMA quick_check");
    const quickValues = quickRows.map((row) => String(Object.values(row)[0]));
    if (quickValues.length !== 1 || quickValues[0]?.toLocaleLowerCase() !== "ok")
      throw new Error(`Rekordbox quick_check failed: ${quickValues.join("; ")}`);
    const foreignKeys = db.selectRawRows("PRAGMA foreign_key_check");
    if (foreignKeys.length)
      throw new Error(`Rekordbox foreign_key_check found ${foreignKeys.length} violation(s)`);

    switch (expectation.type) {
      case "create-playlist":
      case "rename-playlist":
        this.assertPlaylistMatches(
          this.requireActivePlaylist(db, expectation.changedId),
          expectation.playlist,
        );
        return;
      case "delete-playlist":
        for (const playlist of expectation.deletedPlaylists) {
          const playlistCount = this.scalar(
            db,
            `SELECT COUNT(*) AS count FROM "djmdPlaylist" p
             WHERE p."ID" = ? AND ${this.active(db, "djmdPlaylist", "p")}`,
            [playlist.id],
          );
          if (playlistCount)
            throw new Error(`Deleted playlist '${playlist.id}' is still active in master.db`);
          const membershipCount = this.scalar(
            db,
            `SELECT COUNT(*) AS count FROM "djmdSongPlaylist" membership
             WHERE membership."PlaylistID" = ?
               AND ${this.active(db, "djmdSongPlaylist", "membership")}`,
            [playlist.id],
          );
          if (membershipCount)
            throw new Error(
              `Deleted playlist '${playlist.id}' still has ${membershipCount} active membership(s)`,
            );
        }
        return;
      case "add-track":
      case "move-track":
        this.assertPlaylistMatches(
          this.requireActivePlaylist(db, expectation.playlist.id),
          expectation.playlist,
        );
        this.assertMembershipMatches(
          this.requireActiveMembership(db, expectation.membership.id),
          expectation.membership,
        );
        this.assertMembershipSequence(db, expectation.playlist.id);
        return;
      case "remove-track": {
        this.assertPlaylistMatches(
          this.requireActivePlaylist(db, expectation.playlist.id),
          expectation.playlist,
        );
        const count = this.scalar(
          db,
          `SELECT COUNT(*) AS count FROM "djmdSongPlaylist" membership
           WHERE membership."ID" = ?
             AND ${this.active(db, "djmdSongPlaylist", "membership")}`,
          [expectation.membershipId],
        );
        if (count)
          throw new Error(
            `Removed playlist membership '${expectation.membershipId}' is still active`,
          );
        this.assertMembershipSequence(db, expectation.playlist.id);
        return;
      }
      case "replace-playlist-tracks": {
        this.assertPlaylistMatches(
          this.requireActivePlaylist(db, expectation.playlist.id),
          expectation.playlist,
        );
        const rows = db.selectRawRows(
          `SELECT membership."ID" AS id, membership."ContentID" AS contentId,
                  membership."TrackNo" AS trackNumber
           FROM "djmdSongPlaylist" membership
           WHERE membership."PlaylistID" = ?
             AND ${this.active(db, "djmdSongPlaylist", "membership")}
           ORDER BY membership."TrackNo", membership."ID"`,
          [expectation.playlist.id],
        );
        const contentIds = rows.map((row) => stringValue(row.contentId));
        if (JSON.stringify(contentIds) !== JSON.stringify(expectation.contentIds))
          throw new Error(
            `Playlist '${expectation.playlist.id}' content order verification mismatch`,
          );
        for (const membership of expectation.memberships)
          this.assertMembershipMatches(this.requireActiveMembership(db, membership.id), membership);
        this.assertMembershipSequence(db, expectation.playlist.id);
        return;
      }
      case "upsert-cue": {
        const cue = db
          .getContentCues(expectation.cue.contentId)
          .find((candidate) => candidate.id === expectation.cue.id);
        if (!cue || JSON.stringify(cue) !== JSON.stringify(expectation.cue))
          throw new Error(`Cue '${expectation.cue.id}' verification mismatch`);
        this.assertContentCueMirror(db, expectation.cue.contentId);
        return;
      }
      case "delete-cue": {
        const cue = db
          .getContentCues(expectation.contentId)
          .find((candidate) => candidate.id === expectation.changedId);
        if (cue) throw new Error(`Deleted cue '${expectation.changedId}' is still active`);
        this.assertContentCueMirror(db, expectation.contentId);
        return;
      }
    }
  }

  private verifySidecarMutation(db: MasterDatabase, expectation: MutationExpectation): void {
    const sidecar = db.playlistXml;
    if (!sidecar) throw new Error("masterPlaylists6.xml disappeared during library mutation");
    if (expectation.type === "upsert-cue" || expectation.type === "delete-cue") return;
    if (expectation.type === "delete-playlist") {
      for (const playlist of expectation.deletedPlaylists)
        if (sidecar.get(playlist.id))
          throw new Error(
            `Deleted playlist '${playlist.id}' is still present in masterPlaylists6.xml`,
          );
      return;
    }
    this.assertSidecarPlaylist(sidecar.get(expectation.playlist.id), expectation.playlist);
  }

  private requireActivePlaylist(db: MasterDatabase, id: string): PlaylistExpectation {
    const row = db.selectRawRows(
      `SELECT p."ID" AS id, p."Name" AS name, p."ParentID" AS parentId,
              p."Attribute" AS attribute
       FROM "djmdPlaylist" p
       WHERE p."ID" = ? AND ${this.active(db, "djmdPlaylist", "p")}`,
      [id],
    )[0];
    if (!row) throw new RangeError(`Playlist '${id}' was not found`);
    return {
      id: stringValue(row.id),
      name: stringValue(row.name),
      parentId: stringValue(row.parentId, "root"),
      attribute: numberValue(row.attribute, Number.NaN),
    };
  }

  private requireNormalPlaylist(db: MasterDatabase, id: string): PlaylistExpectation {
    const playlist = this.requireActivePlaylist(db, id);
    if (playlist.attribute !== PlaylistType.PLAYLIST)
      throw new TypeError("Playlist must be normal");
    return playlist;
  }

  private requireActiveContent(db: MasterDatabase, id: string): void {
    const count = this.scalar(
      db,
      `SELECT COUNT(*) AS count FROM "djmdContent" content
       WHERE content."ID" = ? AND ${this.active(db, "djmdContent", "content")}`,
      [id],
    );
    if (count !== 1) throw new RangeError(`Track '${id}' was not found`);
  }

  private requireActiveMembership(db: MasterDatabase, id: string): MembershipExpectation {
    const row = db.selectRawRows(
      `SELECT membership."ID" AS id, membership."PlaylistID" AS playlistId,
              membership."ContentID" AS contentId, membership."TrackNo" AS trackNumber
       FROM "djmdSongPlaylist" membership
       WHERE membership."ID" = ? AND ${this.active(db, "djmdSongPlaylist", "membership")}`,
      [id],
    )[0];
    if (!row) throw new RangeError(`Playlist membership '${id}' was not found`);
    return {
      id: stringValue(row.id),
      playlistId: stringValue(row.playlistId),
      contentId: stringValue(row.contentId),
      trackNumber: numberValue(row.trackNumber),
    };
  }

  private getActivePlaylistSubtree(db: MasterDatabase, id: string): PlaylistExpectation[] {
    const rows = db.selectRawRows(
      `WITH RECURSIVE tree(id, name, parentId, attribute) AS (
         SELECT root."ID", root."Name", root."ParentID", root."Attribute"
         FROM "djmdPlaylist" root
         WHERE root."ID" = ? AND ${this.active(db, "djmdPlaylist", "root")}
         UNION
         SELECT child."ID", child."Name", child."ParentID", child."Attribute"
         FROM "djmdPlaylist" child
         JOIN tree ON child."ParentID" = tree.id
         WHERE ${this.active(db, "djmdPlaylist", "child")}
       )
       SELECT id, name, parentId, attribute FROM tree`,
      [id],
    );
    return rows.map((row) => ({
      id: stringValue(row.id),
      name: stringValue(row.name),
      parentId: stringValue(row.parentId, "root"),
      attribute: numberValue(row.attribute, Number.NaN),
    }));
  }

  private assertSafeMembershipState(db: MasterDatabase, playlistId: string): void {
    if (db.hasColumn("djmdSongPlaylist", "rb_local_deleted")) {
      const deleted = this.scalar(
        db,
        `SELECT COUNT(*) AS count FROM "djmdSongPlaylist" membership
         WHERE membership."PlaylistID" = ? AND membership."rb_local_deleted" IS NOT NULL
           AND membership."rb_local_deleted" != 0`,
        [playlistId],
      );
      if (deleted)
        throw new Error(
          `Playlist '${playlistId}' has ${deleted} soft-deleted membership row(s); reconcile it before mutation`,
        );
    }
    this.assertMembershipSequence(db, playlistId);
  }

  private assertMembershipSequence(db: MasterDatabase, playlistId: string): void {
    const rows = db.selectRawRows(
      `SELECT membership."TrackNo" AS trackNumber
       FROM "djmdSongPlaylist" membership
       WHERE membership."PlaylistID" = ?
         AND ${this.active(db, "djmdSongPlaylist", "membership")}
       ORDER BY membership."TrackNo", membership."ID"`,
      [playlistId],
    );
    const trackNumbers = rows.map((row) => numberValue(row.trackNumber, Number.NaN));
    const expected = trackNumbers.map((_, index) => index + 1);
    if (trackNumbers.some((trackNumber, index) => trackNumber !== expected[index]))
      throw new Error(
        `Playlist '${playlistId}' has a non-contiguous active track order: ${trackNumbers.join(", ")}`,
      );
  }

  private assertContentCueMirror(db: MasterDatabase, contentId: string): void {
    if (!db.tableNames.includes("contentCue")) return;
    const rows = db.selectRawRows(
      `SELECT mirror."Cues" AS cues FROM "contentCue" mirror
       WHERE mirror."ContentID" = ? AND ${this.active(db, "contentCue", "mirror")}`,
      [contentId],
    );
    if (rows.length !== 1)
      throw new Error(`Content '${contentId}' has ${rows.length} active cue mirrors`);
    let entries: unknown;
    try {
      entries = JSON.parse(stringValue(rows[0]!.cues, "[]"));
    } catch (error) {
      throw new Error(`Content '${contentId}' has malformed cue mirror JSON`, { cause: error });
    }
    if (!Array.isArray(entries))
      throw new Error(`Content '${contentId}' cue mirror is not an array`);
    const expected = db.getContentCues(contentId);
    const mirrored = entries.map((entry) => {
      if (!entry || typeof entry !== "object")
        throw new Error(`Content '${contentId}' cue mirror contains a non-object entry`);
      const row = entry as Record<string, unknown>;
      const kind = numberValue(row.Kind, Number.NaN);
      const startMsec = numberValue(row.InMsec, Number.NaN);
      const endMsec = numberValue(row.OutMsec, -1);
      const color = numberValue(row.Color, -1);
      return {
        activeLoop: endMsec >= 0 && numberValue(row.ActiveLoop, 0) !== 0,
        color: color < 0 ? null : color,
        colorTableIndex:
          row.ColorTableIndex == null ? null : numberValue(row.ColorTableIndex, Number.NaN),
        comment: stringValue(row.Comment),
        contentId: stringValue(row.ContentID),
        endSeconds: endMsec < 0 ? null : endMsec / 1_000,
        id: stringValue(row.ID),
        kind: kind === 0 ? "memory" : "hot",
        slot: kind === 0 ? null : kind,
        startSeconds: startMsec / 1_000,
        type: endMsec < 0 ? "cue" : "loop",
      };
    });
    if (mirrored.length !== expected.length)
      throw new Error(`Content '${contentId}' cue mirror count verification mismatch`);
    const mirroredById = new Map<string, (typeof mirrored)[number]>();
    for (const cue of mirrored) {
      if (!cue.id || mirroredById.has(cue.id))
        throw new Error(`Content '${contentId}' cue mirror has a missing or duplicate cue ID`);
      mirroredById.set(cue.id, cue);
    }
    for (const cue of expected)
      if (JSON.stringify(mirroredById.get(cue.id)) !== JSON.stringify(cue))
        throw new Error(`Content '${contentId}' cue mirror verification mismatch for '${cue.id}'`);
  }

  private assertPlaylistMatches(actual: PlaylistExpectation, expected: PlaylistExpectation): void {
    if (
      actual.id !== expected.id ||
      actual.name !== expected.name ||
      actual.parentId !== expected.parentId ||
      actual.attribute !== expected.attribute
    )
      throw new Error(
        `Playlist '${expected.id}' verification mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
  }

  private assertMembershipMatches(
    actual: MembershipExpectation,
    expected: MembershipExpectation,
  ): void {
    if (
      actual.id !== expected.id ||
      actual.playlistId !== expected.playlistId ||
      actual.contentId !== expected.contentId ||
      actual.trackNumber !== expected.trackNumber
    )
      throw new Error(
        `Playlist membership '${expected.id}' verification mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
  }

  private assertSidecarPlaylist(
    actual: { Attribute: number; Id: string; ParentId: string } | undefined,
    expected: PlaylistExpectation,
  ): void {
    if (!actual) throw new Error(`Playlist '${expected.id}' is missing from masterPlaylists6.xml`);
    const parentId =
      expected.parentId === "root"
        ? "0"
        : Number(expected.parentId).toString(16).toLocaleUpperCase();
    if (actual.Attribute !== expected.attribute || actual.ParentId !== parentId)
      throw new Error(
        `Playlist '${expected.id}' sidecar mismatch: expected parent ${parentId} / attribute ${expected.attribute}, got parent ${actual.ParentId} / attribute ${actual.Attribute}`,
      );
  }
}
