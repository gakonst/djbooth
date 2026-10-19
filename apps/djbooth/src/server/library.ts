import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ContentCueInput,
  type DatabaseRow,
  DjmdAlbum,
  DjmdArtist,
  DjmdColor,
  DjmdContent,
  DjmdGenre,
  DjmdKey,
  DjmdLabel,
  DjmdPlaylist,
  DjmdSongPlaylist,
  MasterDatabase,
  type ModelClass,
  PlaylistType,
  normalizeRekordboxKeyName,
} from "@gakonst/rekordbox/masterdb";
import { acquireRekordboxDatabaseLock } from "@gakonst/tracks";
import { parseFile, selectCover } from "music-metadata";

import type {
  LibraryBootstrap,
  LibraryMutation,
  MutationReceipt,
  PlaylistItem,
  TrackDetail,
  TrackBeatGridEntry,
  TrackCue,
  TrackColorId,
  TrackSummary,
  TrackSort,
  TrackSortField,
  TrackWaveform,
  TracksResponse,
} from "../shared/types.js";
import { normalizeTrackMetadataInput } from "../shared/track-metadata.js";

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
  dbPath?: string;
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

type MutationResult = { changedId: string; membershipIds?: string[] };

type WaveformCacheEntry = {
  analysisPaths: string[];
  analysisVersion: string;
  retryAt: number | null;
  waveform: TrackWaveform;
};

type BootstrapProjection = Omit<LibraryBootstrap["library"], "processes">;

const sqliteBusyTimeoutMs = 5_000;
const databaseLockTimeoutMs = 10_000;
const placeholderWaveformRetryMs = 5_000;

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

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function trackRevision(value: unknown): string {
  const revision = nullableString(value);
  if (!revision) throw new TypeError("Track metadata revision is unavailable");
  return revision;
}

function numberValue(value: unknown, fallback = 0): number {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function trackColorId(value: unknown): TrackColorId | null {
  return typeof value === "string" && /^[1-8]$/u.test(value) ? (value as TrackColorId) : null;
}

function fileExists(path: string | null): boolean {
  if (!path) return false;
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function fileVersion(paths: string[]): string {
  return paths
    .map((path) => {
      try {
        const metadata = statSync(path);
        return `${path}:${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
      } catch {
        return `${path}:missing`;
      }
    })
    .join("\n");
}

function mapTrack(
  row: RawTrack,
  pathExists: (path: string | null) => boolean = fileExists,
): TrackSummary {
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
    label: nullableString(row.label),
    genre: nullableString(row.genre),
    key: nullableString(row.keyName),
    colorId: trackColorId(row.colorId),
    bpm: bpmHundredths === null || bpmHundredths <= 0 ? null : bpmHundredths / 100,
    durationSeconds: nullableNumber(row.durationSeconds),
    rating: numberValue(row.rating),
    playCount: numberValue(row.playCount),
    analyzed: Boolean(nullableString(row.analysisPath)) && numberValue(row.analysed) > 0,
    artworkAvailable: pathExists(artworkPath),
    fileExists: pathExists(path),
    path,
    ...(membershipId === null ? {} : { playlistMembershipId: membershipId }),
    ...(trackNumber === null ? {} : { trackNumber }),
  };
}

const trackSortSql: Record<TrackSortField, string> = {
  position: `membership."TrackNo"`,
  title: `COALESCE(content."Title", 'Untitled') COLLATE NOCASE`,
  album: `NULLIF(album."Name", '') COLLATE NOCASE`,
  genre: `NULLIF(genre."Name", '') COLLATE NOCASE`,
  bpm: `CASE WHEN content."BPM" > 0 THEN content."BPM" END`,
  key: `NULLIF(keyRow."ScaleName", '') COLLATE NOCASE`,
  plays: `COALESCE(content."DJPlayCount", 0)`,
  status: `rekordbox_file_status(
    content."FolderPath", content."AnalysisDataPath", content."Analysed"
  )`,
  duration: `content."Length"`,
};

function trackOrderSql(sort: TrackSort | undefined, inPlaylist: boolean): string {
  const title = trackSortSql.title;
  if (!sort)
    return inPlaylist
      ? `membership."TrackNo" ASC NULLS LAST, ${title} ASC, membership."ID"`
      : `${title} ASC, content."ID"`;
  const field = sort.field === "position" && !inPlaylist ? "title" : sort.field;
  const direction = sort.direction === "desc" ? "DESC" : "ASC";
  return `${trackSortSql[field]} ${direction} NULLS LAST, ${title} ASC, content."ID"`;
}

export function trackComparator(
  sort: TrackSort | undefined,
): (left: TrackSummary, right: TrackSummary) => number {
  if (!sort) return (left, right) => left.title.localeCompare(right.title);
  const direction = sort.direction === "desc" ? -1 : 1;
  return (left, right) => {
    const compared = compareNullable(
      trackSortValue(left, sort.field),
      trackSortValue(right, sort.field),
      direction,
    );
    return compared || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
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

function compareNullable(
  left: string | number | null,
  right: string | number | null,
  direction: -1 | 1,
): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  const compared =
    typeof left === "number" && typeof right === "number"
      ? left - right
      : String(left).localeCompare(String(right), undefined, {
          numeric: true,
          sensitivity: "base",
        });
  return direction * compared;
}

function escapeLikePattern(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
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
  maximum = 16_384,
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

function beatGridEntries(value: unknown, maximum = 20_000): TrackBeatGridEntry[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maximum).flatMap((entry): TrackBeatGridEntry[] => {
    if (!entry || typeof entry !== "object") return [];
    const { beat, time } = entry as { beat?: unknown; time?: unknown };
    if (![1, 2, 3, 4].includes(beat as number)) return [];
    if (typeof time !== "number" || !Number.isFinite(time) || time < 0) return [];
    return [{ beat: beat as TrackBeatGridEntry["beat"], timeSeconds: time }];
  });
}

type ReadableAnlzFile = {
  get(key: string): unknown;
  has(key: string): boolean;
};

/** Convert already-parsed Rekordbox ANLZ files into the bounded waveform sent to the UI. */
export function waveformFromAnlzFiles(
  files: readonly ReadableAnlzFile[],
  durationSeconds: number | null,
): TrackWaveform {
  let peaks: number[] = [];
  let colors: Array<[number, number, number]> = [];
  let beatGrid: TrackBeatGridEntry[] = [];
  for (const file of files) {
    if (!file.has("PQTZ")) continue;
    beatGrid = beatGridEntries(file.get("PQTZ"));
    if (beatGrid.length) break;
  }
  for (const key of ["PWV5", "PWV4", "PWV3", "PWV2", "PWAV"]) {
    for (const file of files) {
      if (!file.has(key)) continue;
      peaks = waveformHeights(file.get(key));
      colors = waveformColors(file.get(key));
      if (peaks.length) break;
    }
    if (peaks.length) break;
  }
  return {
    durationSeconds,
    ...normalizeWaveform(peaks, colors),
    ...(beatGrid.length ? { beatGrid } : {}),
    source: peaks.length ? "rekordbox" : "placeholder",
  };
}

function normalizeArtworkContentType(format: string, source: string): string {
  const normalized = format.trim().toLocaleLowerCase();
  if (normalized === "image/jpg" || normalized === "jpg" || normalized === "jpeg")
    return "image/jpeg";
  if (["image/jpeg", "image/png", "image/gif", "image/webp"].includes(normalized))
    return normalized;
  throw new TypeError(`Embedded artwork in '${source}' uses unsupported format '${format}'`);
}

/** Direct TypeScript service behind the local djbooth.ai workstation. */
export class RekordboxLibraryService {
  readonly dbPath: string | undefined;
  readonly key: string | undefined;
  readonly unlock: boolean;
  readonly writeEnabled: boolean;

  private readonly mutationTails = new Map<string, Promise<void>>();
  private readonly audioPathCache = new Map<string, string>();
  private readonly waveformCache = new Map<string, WaveformCacheEntry>();
  private readonly fileExistenceCache = new Map<string, { checkedAt: number; exists: boolean }>();
  private bootstrapProjection: BootstrapProjection | undefined;
  private playlistProjection: PlaylistItem[] | undefined;
  private database: MasterDatabase | undefined;
  private databaseFilesVersion: string | undefined;

  constructor(options: LibraryOptions = {}) {
    this.dbPath = options.dbPath;
    this.key = options.key;
    this.unlock = options.unlock ?? true;
    this.writeEnabled = options.writeEnabled ?? true;
  }

  private open(readonly = !this.writeEnabled): MasterDatabase {
    return this.configureConnection(
      new MasterDatabase({
        readonly,
        unlock: this.unlock,
        ...(this.dbPath === undefined ? {} : { path: this.dbPath }),
        ...(this.key === undefined ? {} : { key: this.key }),
      }),
    );
  }

  private getDatabase(): MasterDatabase {
    if (!this.database?.connection?.open) {
      this.database = this.open();
      this.databaseFilesVersion = this.captureDatabaseFilesVersion(this.database);
    }
    // A readSnapshot transaction shares one identity map until its snapshot ends.
    if (!this.database.connection?.inTransaction) this.database.expireIdentityMap();
    return this.database;
  }

  private captureDatabaseFilesVersion(database: MasterDatabase): string {
    return fileVersion([
      database.path,
      `${database.path}-wal`,
      resolve(database.dbDirectory, "masterPlaylists6.xml"),
    ]);
  }

  private getFreshDatabaseUnderLock(): MasterDatabase {
    let database = this.getDatabase();
    const currentVersion = this.captureDatabaseFilesVersion(database);
    if (this.databaseFilesVersion !== currentVersion) {
      this.invalidate();
      database = this.getDatabase();
    }
    return database;
  }

  private configureConnection(database: MasterDatabase): MasterDatabase {
    // Connection-local wait only: preserve Rekordbox's existing DELETE/WAL journal mode.
    database.connection?.pragma(`busy_timeout = ${sqliteBusyTimeoutMs}`);
    database.connection?.function(
      "rekordbox_file_status",
      (path: unknown, analysisPath: unknown, analysed: unknown) => {
        if (!this.cachedFileExists(nullableString(path))) return 0;
        return nullableString(analysisPath) && numberValue(analysed) > 0 ? 2 : 1;
      },
    );
    return database;
  }

  /** Close the shared SQLite session and release cached derived assets. */
  close(): void {
    this.database?.close();
    this.database = undefined;
    this.databaseFilesVersion = undefined;
    this.clearDerivedCaches();
  }

  /** Drop connection-owned state after a database or sidecar change outside this service. */
  invalidate(): void {
    this.close();
  }

  /** Return the canonical database path without recomputing library health statistics. */
  getDatabasePath(): string {
    return realpathSync(this.getDatabase().path);
  }

  /** Read related projections in one SQLite snapshot, including external edits. */
  readSnapshot<T>(read: () => T): T {
    const database = this.getFreshDatabaseUnderLock();
    this.playlistProjection = undefined;
    return database.connection!.transaction(read)();
  }

  private clearDerivedCaches(): void {
    this.audioPathCache.clear();
    this.waveformCache.clear();
    this.fileExistenceCache.clear();
    this.bootstrapProjection = undefined;
    this.playlistProjection = undefined;
  }

  private cachedFileExists(path: string | null): boolean {
    if (!path) return false;
    const now = Date.now();
    const cached = this.fileExistenceCache.get(path);
    if (cached && now - cached.checkedAt < 10_000) return cached.exists;
    const exists = fileExists(path);
    this.fileExistenceCache.set(path, { checkedAt: now, exists });
    if (this.fileExistenceCache.size > 32_768)
      this.fileExistenceCache.delete(this.fileExistenceCache.keys().next().value!);
    return exists;
  }

  private mapTrack(row: RawTrack): TrackSummary {
    return mapTrack(row, (path) => this.cachedFileExists(path));
  }

  private async acquireDatabaseLock(dbPath: string): Promise<() => Promise<void>> {
    const deadline = Date.now() + databaseLockTimeoutMs;
    let retryDelayMs = 20;
    for (;;) {
      try {
        return await acquireRekordboxDatabaseLock(dbPath, { durability: "session" });
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

  private isActiveRow(db: MasterDatabase, row: DatabaseRow): boolean {
    return (
      !db.hasColumn(row.tableName, "rb_local_deleted") ||
      Number(row.get("rb_local_deleted") ?? 0) === 0
    );
  }

  private metadataNamesEqual(left: unknown, right: string): boolean {
    return (
      typeof left === "string" &&
      left.trim().localeCompare(right, undefined, { sensitivity: "accent" }) === 0
    );
  }

  private findActiveNamedRow<row extends DatabaseRow>(
    db: MasterDatabase,
    model: ModelClass<row>,
    name: string,
    filters: Record<string, string | null> = {},
  ): row | undefined {
    let query = db
      .query(model)
      .where(filters)
      .whereRaw('"Name" = ? COLLATE NOCASE', [name])
      .orderBy("ID");
    if (db.hasColumn(model.tableName, "rb_local_deleted"))
      query = query.whereRaw('("rb_local_deleted" IS NULL OR "rb_local_deleted" = 0)');
    return query.first();
  }

  /** Return library identity, mode, and health counts. */
  getBootstrap(csrfToken: string): LibraryBootstrap {
    let projection = this.bootstrapProjection;
    if (!projection) {
      const db = this.getDatabase();
      const stats = db.getLibraryHealth();
      projection = Object.freeze({
        dbPath: db.path,
        dbDirectory: db.dbDirectory,
        writeEnabled: this.writeEnabled,
        stats: Object.freeze(stats),
      });
      this.bootstrapProjection = projection;
    }
    return { csrfToken, library: projection };
  }

  /** Return the active playlist hierarchy and direct membership counts. */
  getPlaylists(): PlaylistItem[] {
    if (!this.playlistProjection) {
      const items = this.getDatabase()
        .listPlaylists()
        .map((playlist) =>
          Object.freeze({
            id: playlist.id,
            name: playlist.name || "Untitled playlist",
            parentId: playlist.parentId,
            seq: playlist.sequence,
            type: playlist.type,
            trackCount: playlist.trackCount,
            ...(playlist.countError === undefined ? {} : { countError: playlist.countError }),
          }),
        );
      Object.freeze(items);
      this.playlistProjection = items;
    }
    return this.playlistProjection;
  }

  /** Search or page through tracks, preserving normal-playlist membership order. */
  getTracks(options: TrackQuery = {}): TracksResponse {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 10_000);
    const offset = Math.max(options.offset ?? 0, 0);
    const filter = options.filter ?? "all";
    const q = options.q?.trim() ?? "";
    const db = this.getDatabase();
    if (options.playlistId) {
      const activePlaylist = db.selectRawRows<{ attribute: number; id: string }>(
        `SELECT p."ID" AS id, p."Attribute" AS attribute FROM "djmdPlaylist" p
           WHERE p."ID" = ? AND ${this.active(db, "djmdPlaylist", "p")}`,
        [options.playlistId],
      )[0];
      if (!activePlaylist) throw new RangeError(`Playlist '${options.playlistId}' was not found`);
      if (Number(activePlaylist.attribute) === PlaylistType.FOLDER)
        throw new TypeError("A playlist folder has no track contents");
      if (Number(activePlaylist.attribute) === PlaylistType.SMART_PLAYLIST) {
        const playlist = db.query(DjmdPlaylist).where({ ID: options.playlistId }).one();
        return this.getSmartPlaylistTracks(db, playlist, {
          filter,
          limit,
          offset,
          q,
          ...(options.sort ? { sort: options.sort } : {}),
        });
      }
    }

    const parameters: unknown[] = [];
    const searchParameters: unknown[] = [];
    const useSearchCte = Boolean(q && !options.playlistId);
    const membershipJoin = options.playlistId
      ? `JOIN "djmdSongPlaylist" membership
             ON membership."ContentID" = content."ID" AND membership."PlaylistID" = ?
            AND ${this.active(db, "djmdSongPlaylist", "membership")}`
      : "";
    if (options.playlistId) parameters.push(options.playlistId);
    const where = [this.active(db, "djmdContent", "content")];
    if (q) {
      const pattern = `%${escapeLikePattern(q)}%`;
      if (useSearchCte) searchParameters.push(pattern, pattern, pattern, pattern);
      else {
        where.push(`(content."Title" LIKE ? ESCAPE '\\' OR artist."Name" LIKE ? ESCAPE '\\'
            OR album."Name" LIKE ? ESCAPE '\\' OR content."FileNameL" LIKE ? ESCAPE '\\')`);
        parameters.push(pattern, pattern, pattern, pattern);
      }
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
    const sortField =
      options.sort?.field === "position" && !options.playlistId ? "title" : options.sort?.field;
    const searchCte = useSearchCte
      ? `WITH "matchingContent"("id") AS (
          SELECT searchContent."ID" FROM "djmdContent" searchContent
          WHERE ${this.active(db, "djmdContent", "searchContent")}
            AND (searchContent."Title" LIKE ? ESCAPE '\\'
              OR searchContent."FileNameL" LIKE ? ESCAPE '\\')
          UNION
          SELECT searchContent."ID" FROM "djmdContent" searchContent
          JOIN "djmdArtist" searchArtist ON searchArtist."ID" = searchContent."ArtistID"
          WHERE ${this.active(db, "djmdContent", "searchContent")}
            AND ${this.active(db, "djmdArtist", "searchArtist")}
            AND searchArtist."Name" LIKE ? ESCAPE '\\'
          UNION
          SELECT searchContent."ID" FROM "djmdContent" searchContent
          JOIN "djmdAlbum" searchAlbum ON searchAlbum."ID" = searchContent."AlbumID"
          WHERE ${this.active(db, "djmdContent", "searchContent")}
            AND ${this.active(db, "djmdAlbum", "searchAlbum")}
            AND searchAlbum."Name" LIKE ? ESCAPE '\\'
        )`
      : "";
    const matchingContentJoin = useSearchCte
      ? 'JOIN "matchingContent" searchMatch ON searchMatch."id" = content."ID"'
      : "";
    const pageJoins = [matchingContentJoin, membershipJoin];
    if (q && !useSearchCte) {
      pageJoins.push('LEFT JOIN "djmdArtist" artist ON artist."ID" = content."ArtistID"');
      pageJoins.push('LEFT JOIN "djmdAlbum" album ON album."ID" = content."AlbumID"');
    } else if (sortField === "album") {
      pageJoins.push('LEFT JOIN "djmdAlbum" album ON album."ID" = content."AlbumID"');
    }
    if (sortField === "genre")
      pageJoins.push('LEFT JOIN "djmdGenre" genre ON genre."ID" = content."GenreID"');
    if (sortField === "key")
      pageJoins.push('LEFT JOIN "djmdKey" keyRow ON keyRow."ID" = content."KeyID"');
    const pageFrom = `FROM "djmdContent" content ${pageJoins.filter(Boolean).join(" ")}`;
    const countFrom = `FROM "djmdContent" content
        ${matchingContentJoin}
        ${membershipJoin}
        ${q && !useSearchCte ? 'LEFT JOIN "djmdArtist" artist ON artist."ID" = content."ArtistID"' : ""}
        ${q && !useSearchCte ? 'LEFT JOIN "djmdAlbum" album ON album."ID" = content."AlbumID"' : ""}`;
    const predicate = where.join(" AND ");
    const order = trackOrderSql(options.sort, Boolean(options.playlistId));
    const pageRows = db.selectRawRows(
      `${searchCte} SELECT COUNT(*) OVER() AS totalCount,
                content."ID" AS id
                ${options.playlistId ? ', membership."ID" AS playlistMembershipId, membership."TrackNo" AS trackNumber' : ""}
         ${pageFrom} WHERE ${predicate} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...searchParameters, ...parameters, limit, offset],
    );
    const count = pageRows[0]
      ? numberValue(pageRows[0].totalCount)
      : offset === 0
        ? 0
        : this.scalar(db, `${searchCte} SELECT COUNT(*) AS count ${countFrom} WHERE ${predicate}`, [
            ...searchParameters,
            ...parameters,
          ]);
    const summaries = this.getTrackSummariesById(
      db,
      pageRows.map((row) => stringValue(row.id)),
    );
    const items = pageRows.flatMap((row) => {
      const track = summaries.get(stringValue(row.id));
      if (!track) return [];
      const playlistMembershipId = nullableString(row.playlistMembershipId);
      const trackNumber = nullableNumber(row.trackNumber);
      return [
        {
          ...track,
          ...(playlistMembershipId === null ? {} : { playlistMembershipId }),
          ...(trackNumber === null ? {} : { trackNumber }),
        },
      ];
    });
    return { items, count, limit, offset };
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
    // The playlist selector already resolves smart criteria. Project only IDs here; asking for
    // getPlaylistTracks would materialize joined artist/key metadata that the summary query below
    // immediately loads again with the rest of the table columns.
    const orderedContentIds = db
      .getPlaylistContents(playlist)
      .select("ID")
      .map((row) => stringValue(row.ID));
    const summaries = this.getTrackSummariesById(db, orderedContentIds);
    const rows = orderedContentIds
      .flatMap((id) => {
        const track = summaries.get(id);
        return track ? [track] : [];
      })
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

  private getTrackSummariesById(
    db: MasterDatabase,
    ids: readonly string[],
  ): Map<string, TrackSummary> {
    const tracks = new Map<string, TrackSummary>();
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      const placeholders = chunk.map(() => "?").join(", ");
      const rows = db.selectRawRows(
        `SELECT content."ID" AS id, content."Title" AS title,
                content."FolderPath" AS path, content."BPM" AS bpmHundredths,
                content."ColorID" AS colorId,
                content."Length" AS durationSeconds, content."Rating" AS rating,
                content."DJPlayCount" AS playCount, content."AnalysisDataPath" AS analysisPath,
                content."Analysed" AS analysed, artist."Name" AS artist,
                album."Name" AS album, album."ImagePath" AS artworkPath,
                label."Name" AS label, genre."Name" AS genre, keyRow."ScaleName" AS keyName
         FROM "djmdContent" content
         LEFT JOIN "djmdArtist" artist ON artist."ID" = content."ArtistID"
         LEFT JOIN "djmdAlbum" album ON album."ID" = content."AlbumID"
         LEFT JOIN "djmdLabel" label ON label."ID" = content."LabelID"
         LEFT JOIN "djmdGenre" genre ON genre."ID" = content."GenreID"
         LEFT JOIN "djmdKey" keyRow ON keyRow."ID" = content."KeyID"
         WHERE content."ID" IN (${placeholders})
           AND ${this.active(db, "djmdContent", "content")}`,
        chunk,
      );
      for (const row of rows) {
        const track = this.mapTrack(row);
        tracks.set(track.id, track);
      }
    }
    return tracks;
  }

  /** Return full metadata, analysis state, and playlist memberships for one track. */
  getTrack(id: string): TrackDetail {
    const db = this.getDatabase();
    const rows = db.selectRawRows(
      `SELECT content."ID" AS id, content."Title" AS title,
                content."FolderPath" AS path, content."BPM" AS bpmHundredths,
                content."ColorID" AS colorId,
                content."Length" AS durationSeconds, content."Rating" AS rating,
                content."DJPlayCount" AS playCount, content."AnalysisDataPath" AS analysisPath,
                content."Analysed" AS analysed, content."Commnt" AS comment,
                content."ISRC" AS isrc, content."ReleaseYear" AS releaseYear,
                content."BitRate" AS bitRate, content."SampleRate" AS sampleRate,
                content."FileSize" AS fileSize,
                strftime('%Y-%m-%dT%H:%M:%fZ', content."created_at") AS addedAt,
                CAST(content."updated_at" AS TEXT) AS revision, artist."Name" AS artist,
                album."Name" AS album, album."ImagePath" AS artworkPath,
                label."Name" AS label, genre."Name" AS genre, keyRow."ScaleName" AS keyName
         FROM "djmdContent" content
         LEFT JOIN "djmdArtist" artist ON artist."ID" = content."ArtistID"
         LEFT JOIN "djmdAlbum" album ON album."ID" = content."AlbumID"
         LEFT JOIN "djmdLabel" label ON label."ID" = content."LabelID"
         LEFT JOIN "djmdGenre" genre ON genre."ID" = content."GenreID"
         LEFT JOIN "djmdKey" keyRow ON keyRow."ID" = content."KeyID"
         WHERE content."ID" = ? AND ${this.active(db, "djmdContent", "content")}`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new RangeError(`Track '${id}' was not found`);
    const summary = this.mapTrack(row);
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
      revision: trackRevision(row.revision),
      addedAt: nullableString(row.addedAt) ?? undefined,
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
  }

  /** Resolve a trusted database-owned audio path for range streaming. */
  getAudioPath(id: string): string {
    const cached = this.audioPathCache.get(id);
    if (cached && fileExists(cached)) return cached;
    this.audioPathCache.delete(id);
    const db = this.getDatabase();
    const row = db.selectRawRows(
      `SELECT content."FolderPath" AS path FROM "djmdContent" content
       WHERE content."ID" = ? AND ${this.active(db, "djmdContent", "content")}`,
      [id],
    )[0];
    if (!row) throw new RangeError(`Track '${id}' was not found`);
    const path = nullableString(row.path);
    if (!path || !fileExists(path)) throw new RangeError(`Audio for track '${id}' is unavailable`);
    this.audioPathCache.set(id, path);
    if (this.audioPathCache.size > 512)
      this.audioPathCache.delete(this.audioPathCache.keys().next().value!);
    return path;
  }

  /** Resolve the database-owned cover source without reading image or audio bytes. */
  getArtworkSource(id: string): { kind: "file" | "embedded"; path: string } {
    const db = this.getDatabase();
    let audioPath: string | null = null;
    let rawArtwork: string | null = null;
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
      const artwork = candidates.find((candidate) => this.cachedFileExists(candidate));
      if (artwork) return { kind: "file", path: artwork };
    }

    if (!audioPath || !this.cachedFileExists(audioPath))
      throw new RangeError(`Artwork for track '${id}' is unavailable`);
    return { kind: "embedded", path: resolve(audioPath) };
  }

  /** Resolve Rekordbox artwork or read the recording's embedded front cover. */
  async getArtwork(id: string): Promise<ArtworkAsset> {
    const resolved = this.getArtworkSource(id);
    if (resolved.kind === "file") return { kind: "file", path: resolved.path };
    try {
      const requested = resolved.path;
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

  /** Original analysis artifacts owned by master.db; no analysis is run here. */
  getAnalysisPaths(id: string): Record<"DAT" | "EXT" | "2EX", string | undefined> {
    return this.getDatabase().getContentAnlzPaths(id);
  }

  /** Return bounded precomputed Rekordbox peaks or a streaming-safe placeholder instruction. */
  getWaveform(id: string): TrackWaveform {
    const cached = this.waveformCache.get(id);
    if (
      cached &&
      (cached.retryAt === null || Date.now() < cached.retryAt) &&
      cached.analysisVersion === fileVersion(cached.analysisPaths)
    )
      return cached.waveform;
    const db = this.getDatabase();
    const row = db.selectRawRows(
      `SELECT content."Length" AS durationSeconds,
              content."AnalysisDataPath" AS analysisPath
         FROM "djmdContent" content
         WHERE content."ID" = ? AND ${this.active(db, "djmdContent", "content")}`,
      [id],
    )[0];
    if (!row) throw new RangeError(`Track '${id}' was not found`);
    const analysisPath = nullableString(row.analysisPath);
    const analysisPaths = analysisPath
      ? [
          resolve(
            db.shareDirectory,
            dirname(analysisPath.replace(/^[/\\]+/u, "").replaceAll("\\", "/")),
          ),
        ]
      : [];
    let peaks: number[] = [];
    let colors: Array<[number, number, number]> = [];
    let beatGrid: TrackBeatGridEntry[] = [];
    try {
      analysisPaths.push(
        ...Object.values(db.getContentAnlzPaths(id)).filter(
          (path): path is string => path !== undefined,
        ),
      );
      const files = [...db.readContentAnlzFiles(id).values()];
      for (const file of files) {
        if (!file.has("PQTZ")) continue;
        beatGrid = beatGridEntries(file.get("PQTZ"));
        if (beatGrid.length) break;
      }
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
    const result: TrackWaveform = {
      durationSeconds: nullableNumber(row.durationSeconds),
      ...waveform,
      ...(beatGrid.length ? { beatGrid } : {}),
      source: peaks.length ? "rekordbox" : "placeholder",
    };
    this.waveformCache.set(id, {
      analysisPaths,
      analysisVersion: fileVersion(analysisPaths),
      retryAt: peaks.length ? null : Date.now() + placeholderWaveformRetryMs,
      waveform: result,
    });
    if (this.waveformCache.size > 128)
      this.waveformCache.delete(this.waveformCache.keys().next().value!);
    return result;
  }

  /** Apply one serialized local mutation using SQLite's transaction boundary. */
  async mutate(mutation: LibraryMutation): Promise<MutationReceipt> {
    if (!this.writeEnabled) throw new Error("Library is running in read-only mode");

    const dbPath = realpathSync(this.getDatabase().path);
    return this.serializeMutation(dbPath, () => this.mutateSerialized(dbPath, mutation));
  }

  private async mutateSerialized(
    dbPath: string,
    mutation: LibraryMutation,
  ): Promise<MutationReceipt> {
    const releaseLock = await this.acquireDatabaseLock(dbPath);
    try {
      const writer = this.getFreshDatabaseUnderLock();
      try {
        this.assertMutationPrecondition(writer, mutation);
        const cueMutation = mutation.type === "upsert-cue" || mutation.type === "delete-cue";
        const expectation = cueMutation
          ? this.applyMutation(writer, mutation)
          : writer.noAutoflush(() => this.applyMutation(writer, mutation));
        writer.commit();
        this.databaseFilesVersion = this.captureDatabaseFilesVersion(writer);
        const revisionContentId =
          mutation.type === "update-track" ||
          mutation.type === "set-track-color" ||
          mutation.type === "upsert-cue" ||
          mutation.type === "delete-cue"
            ? mutation.contentId
            : undefined;
        const revision = revisionContentId
          ? this.getTrackRevision(writer, revisionContentId)
          : undefined;
        writer.expireIdentityMap();
        this.clearDerivedCaches();
        return {
          operation: mutation.type,
          changedId: expectation.changedId,
          ...(expectation.membershipIds ? { membershipIds: expectation.membershipIds } : {}),
          ...(revision ? { revision } : {}),
          finishedAt: new Date().toISOString(),
        };
      } catch (error) {
        try {
          writer.rollback();
        } catch {
          // Preserve the original SQLite or sidecar error.
        }
        // A sidecar save can fail after SQLite has committed. Reopen both on the next operation so
        // no identity-map or masterPlaylists6.xml state survives an uncertain outcome.
        this.invalidate();
        throw error;
      }
    } finally {
      await releaseLock();
    }
  }

  private assertMutationPrecondition(db: MasterDatabase, mutation: LibraryMutation): void {
    if (mutation.type === "update-track") {
      if (this.getTrackRevision(db, mutation.contentId) !== mutation.expectedRevision)
        throw new LibraryMutationConflictError(
          `Track '${mutation.contentId}' changed after metadata was loaded; reload it and try again`,
        );
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

  private getTrackRevision(db: MasterDatabase, contentId: string): string {
    const row = db.selectRawRows(
      `SELECT CAST(content."updated_at" AS TEXT) AS revision
         FROM "djmdContent" content
         WHERE content."ID" = ? AND ${this.active(db, "djmdContent", "content")}`,
      [contentId],
    )[0];
    if (!row) throw new RangeError(`Track '${contentId}' was not found`);
    return trackRevision(row.revision);
  }

  private applyMutation(db: MasterDatabase, mutation: LibraryMutation): MutationResult {
    switch (mutation.type) {
      case "create-playlist": {
        const name = mutation.name.trim();
        if (!name) throw new TypeError("Playlist name must not be empty");
        let parent: DjmdPlaylist | undefined;
        if (mutation.parentId) {
          parent = this.requireActivePlaylistModel(db, mutation.parentId);
          if (Number(parent.Attribute) !== PlaylistType.FOLDER)
            throw new TypeError("Playlist parent must be a folder");
        }
        const options = {
          ...(parent ? { parent } : {}),
          ...(mutation.seq === undefined ? {} : { seq: mutation.seq }),
        };
        const playlist =
          mutation.kind === "folder"
            ? db.createPlaylistFolder(name, options)
            : db.createPlaylist(name, options);
        return { changedId: playlist.ID };
      }
      case "rename-playlist": {
        const name = mutation.name.trim();
        if (!name) throw new TypeError("Playlist name must not be empty");
        const playlist = this.requireActivePlaylistModel(db, mutation.playlistId);
        db.renamePlaylist(playlist, name);
        return { changedId: mutation.playlistId };
      }
      case "delete-playlist": {
        db.deletePlaylist(this.requireActivePlaylistModel(db, mutation.playlistId));
        return { changedId: mutation.playlistId };
      }
      case "set-track-color": {
        const content = this.requireActiveContentModel(db, mutation.contentId);
        if (mutation.colorId) {
          const color = db.query(DjmdColor).where({ ID: mutation.colorId }).oneOrNone();
          if (!color || !this.isActiveRow(db, color))
            throw new RangeError(`Track color '${mutation.colorId}' was not found`);
        }
        content.set("ColorID", mutation.colorId);
        if (db.hasColumn(content.tableName, "TrackInfoUpdated")) content.TrackInfoUpdated = "2";
        if (db.hasColumn(content.tableName, "updated_at")) content.set("updated_at", new Date());
        return { changedId: mutation.contentId };
      }
      case "update-track": {
        const content = this.requireActiveContentModel(db, mutation.contentId);
        const metadata = normalizeTrackMetadataInput(mutation.metadata);
        const artistName = metadata.artist;
        const albumName = metadata.album;
        const labelName = metadata.label;
        const labelProvided = labelName !== undefined;
        const genreName = metadata.genre;
        const keyName = metadata.key;
        const currentArtist = content.Artist;
        const artistUnchanged = Boolean(
          artistName &&
          currentArtist &&
          this.isActiveRow(db, currentArtist) &&
          this.metadataNamesEqual(currentArtist.get("Name"), artistName),
        );
        const artist = artistName
          ? artistUnchanged
            ? currentArtist
            : (this.findActiveNamedRow(db, DjmdArtist, artistName) ??
              db.addArtist(artistName, artistName))
          : undefined;
        const currentGenre = content.Genre;
        const genre = genreName
          ? currentGenre &&
            this.isActiveRow(db, currentGenre) &&
            this.metadataNamesEqual(currentGenre.get("Name"), genreName)
            ? currentGenre
            : (this.findActiveNamedRow(db, DjmdGenre, genreName) ?? db.addGenre(genreName))
          : undefined;
        const currentLabel = content.Label;
        const label = !labelProvided
          ? currentLabel
          : labelName
            ? currentLabel &&
              this.isActiveRow(db, currentLabel) &&
              this.metadataNamesEqual(currentLabel.get("Name"), labelName)
              ? currentLabel
              : (this.findActiveNamedRow(db, DjmdLabel, labelName) ?? db.addLabel(labelName))
            : undefined;
        const currentAlbum = content.Album;
        const album = albumName
          ? currentAlbum &&
            artistUnchanged &&
            this.isActiveRow(db, currentAlbum) &&
            this.metadataNamesEqual(currentAlbum.get("Name"), albumName)
            ? currentAlbum
            : (this.findActiveNamedRow(db, DjmdAlbum, albumName, {
                AlbumArtistID: artist?.ID ?? null,
              }) ?? db.addAlbum(albumName, artist ? { artist } : {}))
          : undefined;
        const keys = keyName
          ? db
              .query(DjmdKey)
              .all()
              .filter((candidate) => this.isActiveRow(db, candidate))
          : [];
        const key = keyName
          ? (keys.find((candidate) => this.metadataNamesEqual(candidate.ScaleName, keyName)) ??
            keys.find((candidate) => candidate.ScaleName === normalizeRekordboxKeyName(keyName)))
          : undefined;
        if (keyName && !key) throw new TypeError(`Rekordbox key '${keyName}' was not found`);

        content.Title = metadata.title;
        content.set("ArtistID", artist?.ID ?? null);
        content.set("AlbumID", album?.ID ?? null);
        if (labelProvided) content.set("LabelID", label?.ID ?? null);
        content.set("GenreID", genre?.ID ?? null);
        content.KeyID = key?.ID ?? null;
        content.BPM = metadata.bpm === null ? null : Math.round(metadata.bpm * 100);
        content.set("Rating", metadata.rating);
        content.set("Commnt", metadata.comment);
        content.set("ReleaseYear", metadata.releaseYear);
        content.set("ISRC", metadata.isrc);
        if (db.hasColumn(content.tableName, "TrackInfoUpdated")) content.TrackInfoUpdated = "2";
        if (db.hasColumn(content.tableName, "updated_at")) content.set("updated_at", new Date());
        return { changedId: mutation.contentId };
      }
      case "add-track": {
        const playlist = this.requireNormalPlaylistModel(db, mutation.playlistId);
        const content = this.requireActiveContentModel(db, mutation.contentId);
        const songs = this.requireSafePlaylistSongs(db, mutation.playlistId);
        const target = mutation.trackNumber ?? songs.length + 1;
        if (!Number.isInteger(target) || target < 1 || target > songs.length + 1)
          throw new RangeError("Track number is out of range");
        for (const song of songs) if (song.TrackNo >= target) song.TrackNo += 1;
        const membership = db.create(DjmdSongPlaylist, {
          ContentID: content.ID,
          ID: randomUUID(),
          PlaylistID: playlist.ID,
          TrackNo: target,
          UUID: randomUUID(),
        });
        return { changedId: membership.ID };
      }
      case "remove-track": {
        this.requireNormalPlaylistModel(db, mutation.playlistId);
        const songs = this.requireSafePlaylistSongs(db, mutation.playlistId);
        const membership = songs.find((song) => song.ID === mutation.membershipId);
        if (!membership)
          throw new RangeError(`Playlist membership '${mutation.membershipId}' was not found`);
        const oldTrackNumber = membership.TrackNo;
        db.delete(membership);
        for (const song of songs)
          if (song.ID !== membership.ID && song.TrackNo > oldTrackNumber) song.TrackNo -= 1;
        return { changedId: mutation.membershipId };
      }
      case "move-track": {
        this.requireNormalPlaylistModel(db, mutation.playlistId);
        const songs = this.requireSafePlaylistSongs(db, mutation.playlistId);
        const membership = songs.find((song) => song.ID === mutation.membershipId);
        if (!membership)
          throw new RangeError(`Playlist membership '${mutation.membershipId}' was not found`);
        if (
          !Number.isInteger(mutation.trackNumber) ||
          mutation.trackNumber < 1 ||
          mutation.trackNumber > songs.length
        )
          throw new RangeError("Track number is out of range");
        const oldTrackNumber = membership.TrackNo;
        if (mutation.trackNumber > oldTrackNumber)
          for (const song of songs)
            if (song.TrackNo > oldTrackNumber && song.TrackNo <= mutation.trackNumber)
              song.TrackNo -= 1;
        if (mutation.trackNumber < oldTrackNumber)
          for (const song of songs)
            if (song.TrackNo >= mutation.trackNumber && song.TrackNo < oldTrackNumber)
              song.TrackNo += 1;
        membership.TrackNo = mutation.trackNumber;
        return { changedId: mutation.membershipId };
      }
      case "replace-playlist-tracks": {
        const playlist = this.requireNormalPlaylistModel(db, mutation.playlistId);
        const existing = this.requireSafePlaylistSongs(db, mutation.playlistId);
        const currentMembershipIds = existing.map((membership) => membership.ID);
        if (JSON.stringify(currentMembershipIds) !== JSON.stringify(mutation.expectedMembershipIds))
          throw new LibraryMutationConflictError(
            `Playlist '${mutation.playlistId}' changed after the canvas snapshot; reload it before applying order`,
          );
        this.requireActiveContents(db, mutation.contentIds);
        const availableByContent = new Map<string, DjmdSongPlaylist[]>();
        for (const membership of existing) {
          const contentId = membership.ContentID;
          const matches = availableByContent.get(contentId) ?? [];
          matches.push(membership);
          availableByContent.set(contentId, matches);
        }
        const desired = mutation.contentIds.map((contentId) => ({
          contentId,
          existing: availableByContent.get(contentId)?.shift(),
        }));
        for (const membership of [...availableByContent.values()].flat()) db.delete(membership);
        const resulting = desired.map((entry, index) => {
          if (entry.existing) {
            entry.existing.TrackNo = index + 1;
            return entry.existing;
          }
          return db.create(DjmdSongPlaylist, {
            ContentID: entry.contentId,
            ID: randomUUID(),
            PlaylistID: playlist.ID,
            TrackNo: index + 1,
            UUID: randomUUID(),
          });
        });
        return {
          changedId: mutation.playlistId,
          membershipIds: resulting.map((membership) => membership.ID),
        };
      }
      case "upsert-cue": {
        const content = this.requireActiveContentModel(db, mutation.contentId);
        const cue = db.upsertContentCue(content, mutation.cue as ContentCueInput);
        return { changedId: cue.id };
      }
      case "delete-cue": {
        const content = this.requireActiveContentModel(db, mutation.contentId);
        db.deleteContentCue(content, mutation.cueId);
        return { changedId: mutation.cueId };
      }
    }
  }

  private requireActivePlaylistModel(db: MasterDatabase, id: string): DjmdPlaylist {
    const query = db.query(DjmdPlaylist).where({ ID: id });
    const playlist = db.hasColumn("djmdPlaylist", "rb_local_deleted")
      ? query.whereRaw('("rb_local_deleted" IS NULL OR "rb_local_deleted" = 0)').oneOrNone()
      : query.oneOrNone();
    if (!playlist) throw new RangeError(`Playlist '${id}' was not found`);
    return playlist;
  }

  private requireNormalPlaylistModel(db: MasterDatabase, id: string): DjmdPlaylist {
    const playlist = this.requireActivePlaylistModel(db, id);
    if (Number(playlist.Attribute) !== PlaylistType.PLAYLIST)
      throw new TypeError("Playlist must be normal");
    return playlist;
  }

  private requireActiveContentModel(db: MasterDatabase, id: string): DjmdContent {
    const query = db.query(DjmdContent).where({ ID: id });
    const content = db.hasColumn("djmdContent", "rb_local_deleted")
      ? query.whereRaw('("rb_local_deleted" IS NULL OR "rb_local_deleted" = 0)').oneOrNone()
      : query.oneOrNone();
    if (!content) throw new RangeError(`Track '${id}' was not found`);
    return content;
  }

  private requireActiveContents(db: MasterDatabase, ids: readonly string[]): void {
    const uniqueIds = [...new Set(ids)];
    const found = new Set<string>();
    for (let offset = 0; offset < uniqueIds.length; offset += 500) {
      const chunk = uniqueIds.slice(offset, offset + 500);
      const placeholders = chunk.map(() => "?").join(", ");
      for (const row of db.selectRawRows(
        `SELECT content."ID" AS id FROM "djmdContent" content
         WHERE content."ID" IN (${placeholders})
           AND ${this.active(db, "djmdContent", "content")}`,
        chunk,
      ))
        found.add(stringValue(row.id));
    }
    const missing = uniqueIds.find((id) => !found.has(id));
    if (missing) throw new RangeError(`Track '${missing}' was not found`);
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

  private requireSafePlaylistSongs(db: MasterDatabase, playlistId: string): DjmdSongPlaylist[] {
    const rows = db
      .query(DjmdSongPlaylist)
      .where({ PlaylistID: playlistId })
      .orderBy("TrackNo")
      .orderBy("ID")
      .all();
    const tracksDeletion = db.hasColumn("djmdSongPlaylist", "rb_local_deleted");
    const deleted = tracksDeletion
      ? rows.filter((row) => Number(row.get("rb_local_deleted") ?? 0) !== 0)
      : [];
    if (deleted.length)
      throw new Error(
        `Playlist '${playlistId}' has ${deleted.length} soft-deleted membership row(s); reconcile it before mutation`,
      );
    const active = tracksDeletion
      ? rows.filter((row) => Number(row.get("rb_local_deleted") ?? 0) === 0)
      : rows;
    const trackNumbers = active.map((row) => Number(row.TrackNo));
    const expected = trackNumbers.map((_, index) => index + 1);
    if (trackNumbers.some((trackNumber, index) => trackNumber !== expected[index]))
      throw new Error(
        `Playlist '${playlistId}' has a non-contiguous active track order: ${trackNumbers.join(", ")}`,
      );
    return active;
  }
}
