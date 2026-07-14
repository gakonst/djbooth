import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ContentCueInput,
  DjmdAlbum,
  DjmdArtist,
  DjmdContent,
  DjmdGenre,
  DjmdKey,
  DjmdPlaylist,
  MasterDatabase,
  PlaylistType,
  getRekordboxAgentPid,
  getRekordboxPid,
} from "@gakonst/rekordbox";
import { acquireRekordboxDatabaseLock, assertRekordboxStopped } from "@gakonst/tracks";
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
  TrackSort,
  TrackSortField,
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
  sort?: TrackSort;
};

export type LibraryOptions = {
  /** @deprecated Interactive mutations no longer create per-edit backups. */
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

type MutationResult = { changedId: string };

const sqliteBusyTimeoutMs = 5_000;
const databaseLockTimeoutMs = 10_000;

function databaseLockBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Rekordbox database (?:import lock|lock acquisition guard) already exists:/u.test(error.message)
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/** Refuses a stale destructive write whose source snapshot no longer matches master.db. */
export class LibraryMutationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryMutationConflictError";
  }
}

/**
 * Legacy bulk-mutation recovery error retained for API compatibility.
 *
 * Interactive workbench mutations no longer create a backup and journal per edit, so new code
 * receives the underlying transaction error directly. Bulk workflows may still use this shape.
 */
export class LibraryMutationError extends Error {
  readonly backupDirectory: string;
  readonly journalPath: string;
  readonly databaseCommitted: boolean | undefined;
  readonly sidecarCommitted: boolean | undefined;

  constructor(
    message: string,
    options: {
      backupDirectory: string;
      cause?: unknown;
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

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function cleanMetadataValue(value: string | null): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
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

const trackSortSql: Record<TrackSortField, string> = {
  position: `membership."TrackNo"`,
  title: `content."Title" COLLATE NOCASE`,
  album: `album."Name" COLLATE NOCASE`,
  genre: `genre."Name" COLLATE NOCASE`,
  bpm: `content."BPM"`,
  key: `keyRow."ScaleName" COLLATE NOCASE`,
  plays: `content."DJPlayCount"`,
  status: `CASE
    WHEN content."FolderPath" IS NULL OR content."FolderPath" = '' THEN 0
    WHEN content."AnalysisDataPath" IS NULL OR content."AnalysisDataPath" = ''
      OR COALESCE(content."Analysed", 0) <= 0 THEN 1
    ELSE 2 END`,
  duration: `content."Length"`,
};

function trackOrderSql(sort: TrackSort | undefined, inPlaylist: boolean): string {
  if (!sort)
    return inPlaylist
      ? `membership."TrackNo", content."Title" COLLATE NOCASE, membership."ID"`
      : `content."Title" COLLATE NOCASE, artist."Name" COLLATE NOCASE, content."ID"`;
  const field = sort.field === "position" && !inPlaylist ? "title" : sort.field;
  const direction = sort.direction === "desc" ? "DESC" : "ASC";
  return `${trackSortSql[field]} ${direction}, content."Title" COLLATE NOCASE, content."ID"`;
}

function trackComparator(
  sort: TrackSort | undefined,
): (left: TrackSummary, right: TrackSummary) => number {
  if (!sort) return (left, right) => left.title.localeCompare(right.title);
  const direction = sort.direction === "desc" ? -1 : 1;
  return (left, right) => {
    const compared = compareNullable(
      trackSortValue(left, sort.field),
      trackSortValue(right, sort.field),
    );
    return (
      direction * compared ||
      left.title.localeCompare(right.title) ||
      left.id.localeCompare(right.id)
    );
  };
}

function trackSortValue(track: TrackSummary, field: TrackSortField): string | number | null {
  switch (field) {
    case "position":
      return track.trackNumber ?? null;
    case "title":
      return track.title;
    case "album":
      return track.album;
    case "genre":
      return track.genre;
    case "bpm":
      return track.bpm;
    case "key":
      return track.key;
    case "plays":
      return track.playCount;
    case "status":
      return track.fileExists ? (track.analyzed ? 2 : 1) : 0;
    case "duration":
      return track.durationSeconds;
  }
}

function compareNullable(left: string | number | null, right: string | number | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function waveformColor(value: unknown): [number, number, number] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.slice(0, 3);
  if (values.length !== 3 || !values.every((entry) => typeof entry === "number")) return undefined;
  const maximum = Math.max(...values, 1);
  const scale = maximum <= 7 ? 255 / 7 : maximum <= 127 ? 255 / 127 : 1;
  return values.map((entry) => Math.round(Math.max(0, Math.min(255, entry * scale)))) as [
    number,
    number,
    number,
  ];
}

function waveformColors(value: unknown): Array<[number, number, number]> {
  if (!value || typeof value !== "object") return [];
  const colors = (value as { colors?: unknown }).colors;
  if (!Array.isArray(colors)) return [];
  return colors.flatMap((color): Array<[number, number, number]> => {
    const direct = waveformColor(color);
    if (direct) return [direct];
    const foreground = waveformColor(Array.isArray(color) ? color[0] : undefined);
    return foreground ? [foreground] : [];
  });
}

function normalizeWaveform(
  values: number[],
  colors: Array<[number, number, number]>,
  maximum = 2_048,
): { peaks: number[]; colors?: Array<[number, number, number]> } {
  if (!values.length) return { peaks: [] };
  const finite = values.map((value) => (Number.isFinite(value) ? Math.max(0, value) : 0));
  const peak = finite.reduce((maximumValue, value) => Math.max(maximumValue, value), 1);
  const normalized = (value: number) => Math.round((value / peak) * 10_000) / 10_000;
  if (finite.length <= maximum) {
    return {
      peaks: finite.map(normalized),
      ...(colors.length === finite.length ? { colors } : {}),
    };
  }
  const reduced = Array.from({ length: maximum }, (_, index) => {
    const start = Math.floor((index * finite.length) / maximum);
    const end = Math.max(start + 1, Math.floor(((index + 1) * finite.length) / maximum));
    let binPeak = 0;
    let peakIndex = start;
    for (let offset = start; offset < end; offset++)
      if ((finite[offset] ?? 0) > binPeak) {
        binPeak = finite[offset] ?? 0;
        peakIndex = offset;
      }
    return { peak: normalized(binPeak), color: colors[peakIndex] };
  });
  const reducedColors = reduced.map((entry) => entry.color);
  return {
    peaks: reduced.map((entry) => entry.peak),
    ...(reducedColors.every((color): color is [number, number, number] => Boolean(color))
      ? { colors: reducedColors }
      : {}),
  };
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

/** Direct TypeScript service behind the local Rekordbox library workbench. */
export class RekordboxLibraryService {
  readonly dbPath: string | undefined;
  readonly key: string | undefined;
  readonly unlock: boolean;
  readonly writeEnabled: boolean;

  private readonly getProcessState: () => LibraryProcesses;
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(options: LibraryOptions = {}) {
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
    return this.configureConnection(
      new MasterDatabase({
        readonly,
        unlock: this.unlock,
        ...(this.dbPath === undefined ? {} : { path: this.dbPath }),
        ...(this.key === undefined ? {} : { key: this.key }),
      }),
    );
  }

  private openAt(dbPath: string, readonly = true): MasterDatabase {
    return this.configureConnection(
      new MasterDatabase({
        path: dbPath,
        readonly,
        unlock: this.unlock,
        ...(this.key === undefined ? {} : { key: this.key }),
      }),
    );
  }

  private configureConnection(database: MasterDatabase): MasterDatabase {
    // Connection-local wait only: preserve Rekordbox's existing DELETE/WAL journal mode.
    database.connection?.pragma(`busy_timeout = ${sqliteBusyTimeoutMs}`);
    return database;
  }

  private async acquireDatabaseLock(dbPath: string): Promise<() => Promise<void>> {
    const deadline = Date.now() + databaseLockTimeoutMs;
    let retryDelayMs = 20;
    for (;;) {
      try {
        return await acquireRekordboxDatabaseLock(dbPath);
      } catch (error) {
        if (!databaseLockBusy(error) || Date.now() >= deadline) throw error;
        await delay(retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 250);
      }
    }
  }

  private async serializeMutation<result>(
    dbPath: string,
    operation: () => Promise<result>,
  ): Promise<result> {
    const previous = this.mutationTails.get(dbPath) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.mutationTails.set(dbPath, tail);
    try {
      return await result;
    } finally {
      if (this.mutationTails.get(dbPath) === tail) this.mutationTails.delete(dbPath);
    }
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
      const order = trackOrderSql(options.sort, Boolean(options.playlistId));
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
    options: Required<Pick<TrackQuery, "filter" | "limit" | "offset">> & {
      q: string;
      sort?: TrackSort;
    },
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
      })
      .sort(trackComparator(options.sort));
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
      let colors: Array<[number, number, number]> = [];
      try {
        const files = [...db.readContentAnlzFiles(id).values()];
        for (const key of ["PWV5", "PWV4", "PWV3", "PWV2", "PWAV"]) {
          for (const file of files) {
            if (!file.has(key)) continue;
            peaks = waveformHeights(file.get(key));
            colors = waveformColors(file.get(key));
            if (peaks.length) break;
          }
          if (peaks.length) break;
        }
      } catch {
        // Missing or malformed analysis is expected for unanalysed tracks; WaveSurfer decodes audio.
      }
      const waveform = normalizeWaveform(peaks, colors);
      return {
        durationSeconds: nullableNumber(row.durationSeconds),
        ...waveform,
        source: peaks.length ? "rekordbox" : "placeholder",
      };
    } finally {
      db.close();
    }
  }

  /** Apply one serialized local mutation using SQLite's transaction boundary. */
  async mutate(mutation: LibraryMutation): Promise<MutationReceipt> {
    if (!this.writeEnabled)
      throw new Error("Library write mode is disabled; restart with the explicit --write flag");

    const location = this.open();
    let dbPath: string;
    try {
      dbPath = realpathSync(location.path);
    } finally {
      location.close();
    }
    return this.serializeMutation(dbPath, () => this.mutateSerialized(dbPath, mutation));
  }

  private async mutateSerialized(
    dbPath: string,
    mutation: LibraryMutation,
  ): Promise<MutationReceipt> {
    const releaseLock = await this.acquireDatabaseLock(dbPath);
    try {
      this.assertStopped();
      const writer = this.openAt(dbPath, false);
      try {
        this.assertMutationPrecondition(writer, mutation);
        const expectation = this.applyMutation(writer, mutation);
        this.assertStopped();
        writer.commit({ allowWhileRunning: false });
        return {
          operation: mutation.type,
          changedId: expectation.changedId,
          finishedAt: new Date().toISOString(),
        };
      } catch (error) {
        try {
          writer.rollback();
        } catch {
          // Preserve the original SQLite or sidecar error.
        }
        throw error;
      } finally {
        writer.close();
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

  private applyMutation(db: MasterDatabase, mutation: LibraryMutation): MutationResult {
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
        return { changedId: playlist.ID };
      }
      case "rename-playlist": {
        const name = mutation.name.trim();
        if (!name) throw new TypeError("Playlist name must not be empty");
        this.requireActivePlaylist(db, mutation.playlistId);
        db.renamePlaylist(mutation.playlistId, name);
        return { changedId: mutation.playlistId };
      }
      case "delete-playlist": {
        db.deletePlaylist(mutation.playlistId);
        return { changedId: mutation.playlistId };
      }
      case "update-track": {
        this.requireActiveContent(db, mutation.contentId);
        const content = db.query(DjmdContent).where({ ID: mutation.contentId }).one();
        const metadata = mutation.metadata;
        const artistName = cleanMetadataValue(metadata.artist);
        const albumName = cleanMetadataValue(metadata.album);
        const genreName = cleanMetadataValue(metadata.genre);
        const keyName = cleanMetadataValue(metadata.key);
        const artist = artistName
          ? (db.query(DjmdArtist).where({ Name: artistName }).first() ??
            db.addArtist(artistName, artistName))
          : undefined;
        const genre = genreName
          ? (db.query(DjmdGenre).where({ Name: genreName }).first() ?? db.addGenre(genreName))
          : undefined;
        const album = albumName
          ? (db
              .query(DjmdAlbum)
              .where({ Name: albumName, AlbumArtistID: artist?.ID ?? null })
              .first() ?? db.addAlbum(albumName, artist ? { artist } : {}))
          : undefined;
        const key = keyName
          ? db
              .query(DjmdKey)
              .all()
              .find((candidate) => candidate.ScaleName.toLowerCase() === keyName.toLowerCase())
          : undefined;
        if (keyName && !key) throw new TypeError(`Rekordbox key '${keyName}' was not found`);

        content.Title = metadata.title.trim();
        content.set("ArtistID", artist?.ID ?? null);
        content.set("AlbumID", album?.ID ?? null);
        content.set("GenreID", genre?.ID ?? null);
        content.KeyID = key?.ID ?? null;
        content.BPM = metadata.bpm === null ? null : Math.round(metadata.bpm * 100);
        content.set("Rating", metadata.rating);
        content.set("Commnt", cleanMetadataValue(metadata.comment));
        content.set("ReleaseYear", metadata.releaseYear);
        content.set("ISRC", cleanMetadataValue(metadata.isrc));
        if (db.hasColumn(content.tableName, "TrackInfoUpdated")) content.TrackInfoUpdated = "2";
        if (db.hasColumn(content.tableName, "updated_at"))
          content.set("updated_at", new Date());
        return { changedId: mutation.contentId };
      }
      case "add-track": {
        this.requireNormalPlaylist(db, mutation.playlistId);
        this.requireActiveContent(db, mutation.contentId);
        this.assertSafeMembershipState(db, mutation.playlistId);
        const membership = db.addToPlaylist(
          mutation.playlistId,
          mutation.contentId,
          mutation.trackNumber,
        );
        return { changedId: membership.ID };
      }
      case "remove-track": {
        this.requireNormalPlaylist(db, mutation.playlistId);
        this.assertSafeMembershipState(db, mutation.playlistId);
        const membership = this.requireActiveMembership(db, mutation.membershipId);
        if (membership.playlistId !== mutation.playlistId)
          throw new TypeError("Song is not in the supplied playlist");
        db.removeFromPlaylist(mutation.playlistId, mutation.membershipId);
        return { changedId: mutation.membershipId };
      }
      case "move-track": {
        this.requireNormalPlaylist(db, mutation.playlistId);
        this.assertSafeMembershipState(db, mutation.playlistId);
        const membership = this.requireActiveMembership(db, mutation.membershipId);
        if (membership.playlistId !== mutation.playlistId)
          throw new TypeError("Song is not in the supplied playlist");
        db.moveSongInPlaylist(mutation.playlistId, mutation.membershipId, mutation.trackNumber);
        return { changedId: mutation.membershipId };
      }
      case "replace-playlist-tracks": {
        this.requireNormalPlaylist(db, mutation.playlistId);
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

        desired.forEach((entry, index) => {
          const trackNumber = index + 1;
          if (entry.existing) {
            db.moveSongInPlaylist(mutation.playlistId, entry.existing.id, trackNumber);
            return;
          }
          db.addToPlaylist(mutation.playlistId, entry.contentId, trackNumber);
        });
        return { changedId: mutation.playlistId };
      }
      case "upsert-cue": {
        this.requireActiveContent(db, mutation.contentId);
        const cue = db.upsertContentCue(mutation.contentId, mutation.cue as ContentCueInput);
        return { changedId: cue.id };
      }
      case "delete-cue": {
        this.requireActiveContent(db, mutation.contentId);
        db.deleteContentCue(mutation.contentId, mutation.cueId);
        return { changedId: mutation.cueId };
      }
    }
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
}
