import {
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import Database from "better-sqlite3-multiple-ciphers";

import {
  AnlzFile,
  getAnlzPaths as findAnlzPaths,
  readAnlzFiles as readAnlzFilesInDirectory,
} from "../anlz/index.js";
import { readAnalysisResult } from "../analyzer/index.js";
import { getConfig } from "../config/index.js";
import { deobfuscate, warnDeprecated } from "../utils.js";
import { MasterPlaylistXml } from "./aux-files.js";
import * as models from "./models.js";
import { managedLibrarySchema } from "./managed-schema.js";
import {
  Property,
  propertyColumnMap,
  SmartList,
  type Property as SmartPlaylistProperty,
} from "./smartlist.js";

const defaultKeyBlob = "PN_Pq^*N>(JYe*u^8;Yg76HuZ<mR13S?=>)b9;DpoTXV(6ItkU`}8*m6tx_I{Solh_N#dfe{v=";

type TableColumn = {
  name: string;
  notnull: 0 | 1;
  pk: 0 | 1;
  type: string;
};

type TableSchema = {
  columns: Array<TableColumn>;
  dates: Set<string>;
  names: Set<string>;
  primaryKeys: Array<string>;
};

type WhereClause = { parameters: Array<unknown>; sql: string };

/** Result of an arbitrary parameterized SQLite statement. */
export type SqlResult<row extends Record<string, unknown> = Record<string, unknown>> =
  | Array<row>
  | Database.RunResult;

/** Raised when an operation requires an open SQLite connection. */
export class SessionNotInitializedError extends Error {
  override name = "SessionNotInitializedError";

  constructor() {
    super("SQLite session is not initialized");
  }
}

/** Options for opening a Rekordbox master database. */
export type MasterDatabaseOptions = {
  dbDirectory?: string;
  key?: string;
  path?: string;
  /** Parse masterPlaylists6.xml; disable for SQL-only short-lived readers. */
  playlistXml?: boolean;
  readonly?: boolean;
  unlock?: boolean;
};

/** Commit behavior controls. */
export type CommitOptions = {
  autoincrement?: boolean;
};

/** Result of installing generated ANLZ files for a master-library track. */
export type InstallContentAnalysisResult = {
  analysisDataPath: string;
  bpmHundredths: number | null;
  contentId: string;
  directory: string;
  keyId: string | null;
  keyName: string | null;
  paths: Record<"2EX" | "DAT" | "EXT", string>;
  tempoBpm: number | null;
};

/** BPM and key metadata synchronized from a validated analyzer summary. */
export type SyncContentAnalysisMetadataResult = {
  bpmHundredths: number | null;
  contentId: string;
  keyId: string | null;
  keyName: string | null;
  tempoBpm: number | null;
};

/** Ordered, joined metadata for one track membership in a Rekordbox playlist. */
export type PlaylistTrack = {
  analyzed: number | null;
  artist: string | null;
  bpm: number | null;
  contentId: string;
  durationSeconds: number | null;
  fileType: number | null;
  key: string | null;
  membershipId: string | null;
  path: string | null;
  position: number;
  title: string | null;
};

/** Pagination controls for an ordered playlist-track query. */
export type PlaylistTrackOptions = {
  limit?: number;
  offset?: number;
};

/** Flat metadata for one active Rekordbox playlist-tree entry. */
export type PlaylistSummary = {
  countError?: string;
  id: string;
  name: string;
  parentId: string;
  sequence: number;
  trackCount: number | null;
  type: "folder" | "playlist" | "smart";
};

/** Compact active-library health counters shared by CLI and workstation surfaces. */
export type LibraryHealth = {
  tracks: number;
  playlists: number;
  folders: number;
  analyzed: number;
  missingAnalysis: number;
  missingBpm: number;
  missingKey: number;
};

/** Rekordbox 7 Hot Cue slot number (A through P). */
export type HotCueSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;

/** Whether a content cue is a chronological memory cue or an addressable Hot Cue. */
export type ContentCueKind = "hot" | "memory";

/** Whether a content cue marks one position or a loop range. */
export type ContentCueType = "cue" | "loop";

/** Normalized cue point stored in a Rekordbox master library. */
export type ContentCuePoint = {
  activeLoop: boolean;
  color: number | null;
  colorTableIndex: number | null;
  comment: string;
  contentId: string;
  endSeconds: number | null;
  id: string;
  kind: ContentCueKind;
  slot: HotCueSlot | null;
  startSeconds: number;
  type: ContentCueType;
};

type ContentCueInputCommon = {
  activeLoop?: boolean;
  color?: number | null;
  colorTableIndex?: number | null;
  comment?: string;
  endSeconds?: number | null;
  id?: string;
  startSeconds: number;
  type: ContentCueType;
};

/** Validated desired state for one Rekordbox memory cue or Hot Cue. */
export type ContentCueInput = ContentCueInputCommon &
  ({ kind: "hot"; slot: HotCueSlot } | { kind: "memory"; slot?: never });

type NormalizedContentCueInput = Omit<ContentCuePoint, "contentId" | "id"> & { id?: string };

type SmartPlaylistSelection = {
  artistExpression: string;
  fromSql: string;
  keyExpression: string;
  parameters: Array<unknown>;
  whereSql: string;
};

type NormalizedMusicalKey = {
  mode: "major" | "minor";
  pitchClass: number;
};

const camelotKeys: ReadonlyArray<NormalizedMusicalKey> = [
  { mode: "minor", pitchClass: 8 },
  { mode: "minor", pitchClass: 3 },
  { mode: "minor", pitchClass: 10 },
  { mode: "minor", pitchClass: 5 },
  { mode: "minor", pitchClass: 0 },
  { mode: "minor", pitchClass: 7 },
  { mode: "minor", pitchClass: 2 },
  { mode: "minor", pitchClass: 9 },
  { mode: "minor", pitchClass: 4 },
  { mode: "minor", pitchClass: 11 },
  { mode: "minor", pitchClass: 6 },
  { mode: "minor", pitchClass: 1 },
  { mode: "major", pitchClass: 11 },
  { mode: "major", pitchClass: 6 },
  { mode: "major", pitchClass: 1 },
  { mode: "major", pitchClass: 8 },
  { mode: "major", pitchClass: 3 },
  { mode: "major", pitchClass: 10 },
  { mode: "major", pitchClass: 5 },
  { mode: "major", pitchClass: 0 },
  { mode: "major", pitchClass: 7 },
  { mode: "major", pitchClass: 2 },
  { mode: "major", pitchClass: 9 },
  { mode: "major", pitchClass: 4 },
];

function normalizeMusicalKey(value: string): NormalizedMusicalKey | undefined {
  const normalized = value.trim().replaceAll("♯", "#").replaceAll("♭", "b");
  const camelot = /^(1[0-2]|[1-9])([AB])$/iu.exec(normalized);
  if (camelot) {
    const number = Number(camelot[1]);
    const offset = camelot[2]!.toUpperCase() === "A" ? 0 : 12;
    return camelotKeys[offset + number - 1];
  }

  const musical = /^([A-G])([#b]?)(?:(m|min|minor)|(maj|major))?$/iu.exec(
    normalized.replaceAll(/\s+/gu, ""),
  );
  if (!musical) return undefined;
  const naturalPitchClasses: Record<string, number> = {
    A: 9,
    B: 11,
    C: 0,
    D: 2,
    E: 4,
    F: 5,
    G: 7,
  };
  const accidental = musical[2] === "#" ? 1 : musical[2] === "b" ? -1 : 0;
  return {
    mode: musical[3] ? "minor" : "major",
    pitchClass: (naturalPitchClasses[musical[1]!.toUpperCase()]! + accidental + 12) % 12,
  };
}

function camelotName(key: NormalizedMusicalKey): string {
  const offset = key.mode === "minor" ? 0 : 12;
  const index = camelotKeys.findIndex(
    (candidate, candidateIndex) =>
      candidateIndex >= offset &&
      candidateIndex < offset + 12 &&
      candidate.pitchClass === key.pitchClass,
  );
  if (index < 0) throw new TypeError("Unsupported musical key");
  return `${index - offset + 1}${key.mode === "minor" ? "A" : "B"}`;
}

/** Normalize a conventional or Camelot musical key to Rekordbox's canonical Camelot name. */
export function normalizeRekordboxKeyName(value: string): string {
  const normalized = normalizeMusicalKey(value);
  if (!normalized) throw new TypeError(`Unsupported musical key '${value}'`);
  return camelotName(normalized);
}

/** Callback registered for a transaction/session lifecycle event. */
export type DatabaseEventHandler = (database: MasterDatabase) => void;

/** Convert a JavaScript date to Rekordbox's UTC database representation. */
export function datetimeToString(value: Date): string {
  return `${value.toISOString().slice(0, 23).replace("T", " ")} +00:00`;
}

/** Parse Rekordbox's extended datetime representation. */
export function stringToDatetime(value: string): Date {
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:\s*([+-]\d{2}:\d{2}|Z))?/u.exec(
      value.trim(),
    );
  if (!match) throw new TypeError(`Invalid Rekordbox datetime '${value}'`);
  const date = new Date(`${match[1]}T${match[2]}${match[3] ?? "Z"}`);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid Rekordbox datetime '${value}'`);
  return date;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function equalValue(
  left: models.DatabaseValue | undefined,
  right: models.DatabaseValue | undefined,
): boolean {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  if (Buffer.isBuffer(left) && Buffer.isBuffer(right)) return left.equals(right);
  return left === right;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

/** A small SQLAlchemy-like, typed query wrapper for mapped Rekordbox rows. */
export class Query<row extends models.DatabaseRow> implements Iterable<row> {
  private filters: Record<string, models.DatabaseValue> = {};
  private clauses: Array<WhereClause> = [];
  private ordering: Array<{ column: string; direction: "ASC" | "DESC" }> = [];
  private rowLimit: number | undefined;
  private rowOffset: number | undefined;

  constructor(
    private database: MasterDatabase,
    /** Model returned by this query. */
    readonly model: models.ModelClass<row>,
  ) {}

  private clone(): Query<row> {
    const query = new Query(this.database, this.model);
    query.filters = { ...this.filters };
    query.clauses = this.clauses.map((clause) => ({
      ...clause,
      parameters: [...clause.parameters],
    }));
    query.ordering = this.ordering.map((order) => ({ ...order }));
    query.rowLimit = this.rowLimit;
    query.rowOffset = this.rowOffset;
    return query;
  }

  /** Add equality/NULL filters by physical column. */
  where(filters: Record<string, models.DatabaseValue>): Query<row> {
    const query = this.clone();
    for (const key of Object.keys(filters))
      if (!this.database.hasColumn(this.model.tableName, key))
        throw new RangeError(`Column '${key}' does not exist on '${this.model.tableName}'`);
    Object.assign(query.filters, filters);
    return query;
  }

  /** Compatibility alias for {@link where}. */
  filterBy(filters: Record<string, models.DatabaseValue>): Query<row> {
    return this.where(filters);
  }

  /** Add a parameterized raw predicate. */
  whereRaw(sql: string, parameters: Array<unknown> = []): Query<row> {
    const query = this.clone();
    query.clauses.push({ parameters, sql });
    return query;
  }

  /** SQLAlchemy-compatible alias for a parameterized predicate. */
  filter(sql: string, parameters: Array<unknown> = []): Query<row> {
    return this.whereRaw(sql, parameters);
  }

  /** Add physical-column ordering. */
  orderBy(column: string, direction: "asc" | "desc" = "asc"): Query<row> {
    if (!this.database.hasColumn(this.model.tableName, column))
      throw new RangeError(`Column '${column}' does not exist on '${this.model.tableName}'`);
    if (direction !== "asc" && direction !== "desc")
      throw new RangeError("Query order direction must be 'asc' or 'desc'");
    const query = this.clone();
    query.ordering.push({ column, direction: direction.toUpperCase() as "ASC" | "DESC" });
    return query;
  }

  /** Limit rows returned. */
  limit(count: number): Query<row> {
    if (!Number.isInteger(count) || count < 0)
      throw new RangeError("Query limit must be non-negative");
    const query = this.clone();
    query.rowLimit = count;
    return query;
  }

  /** Skip rows. */
  offset(count: number): Query<row> {
    if (!Number.isInteger(count) || count < 0)
      throw new RangeError("Query offset must be non-negative");
    const query = this.clone();
    query.rowOffset = count;
    return query;
  }

  private statement(count = false): { parameters: Array<unknown>; sql: string } {
    const table = quoteIdentifier(this.model.tableName);
    const where: Array<string> = [];
    const parameters: Array<unknown> = [];
    for (const [column, value] of Object.entries(this.filters)) {
      if (value === null) where.push(`${quoteIdentifier(column)} IS NULL`);
      else {
        where.push(`${quoteIdentifier(column)} = ?`);
        parameters.push(this.database.serializeValue(value));
      }
    }
    for (const clause of this.clauses) {
      where.push(clause.sql);
      parameters.push(...clause.parameters.map((value) => this.database.serializeUnknown(value)));
    }
    let sql = `SELECT ${count ? "COUNT(*) AS count" : "*"} FROM ${table}`;
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    if (!count && this.ordering.length)
      sql += ` ORDER BY ${this.ordering
        .map((order) => `${quoteIdentifier(order.column)} ${order.direction}`)
        .join(", ")}`;
    if (!count && this.rowLimit !== undefined) sql += ` LIMIT ${this.rowLimit}`;
    else if (!count && this.rowOffset !== undefined) sql += " LIMIT -1";
    if (!count && this.rowOffset !== undefined) sql += ` OFFSET ${this.rowOffset}`;
    return { parameters, sql };
  }

  /** Return all rows. */
  all(): Array<row> {
    const statement = this.statement();
    return this.database.selectRows(this.model, statement.sql, statement.parameters);
  }

  /** Return the first row, or undefined. */
  first(): row | undefined {
    return this.limit(1).all()[0];
  }

  /** Return exactly one row. */
  one(): row {
    const rows = this.limit(2).all();
    if (rows.length !== 1) throw new RangeError(`Expected exactly one row, found ${rows.length}`);
    return rows[0]!;
  }

  /** Return zero or one row. */
  oneOrNone(): row | undefined {
    const rows = this.limit(2).all();
    if (rows.length > 1) throw new RangeError(`Expected at most one row, found ${rows.length}`);
    return rows[0];
  }

  /** Count matching rows. */
  count(): number {
    if (this.rowLimit !== undefined || this.rowOffset !== undefined) {
      const statement = this.statement();
      return this.database.countRows(
        `SELECT COUNT(*) AS count FROM (${statement.sql}) AS "_count"`,
        statement.parameters,
      );
    }
    const statement = this.statement(true);
    return this.database.countRows(statement.sql, statement.parameters);
  }

  /** Select physical columns instead of materializing model rows. */
  select<column extends string>(...columns: Array<column>): Array<Record<column, unknown>> {
    if (!columns.length) throw new RangeError("At least one column must be selected");
    for (const column of columns)
      if (!this.database.hasColumn(this.model.tableName, column))
        throw new RangeError(`Column '${column}' does not exist on '${this.model.tableName}'`);
    const statement = this.statement();
    statement.sql = statement.sql.replace(
      /^SELECT \*/u,
      `SELECT ${columns.map((column) => quoteIdentifier(column)).join(", ")}`,
    );
    return this.database.selectRawRows<Record<column, unknown>>(
      statement.sql,
      statement.parameters,
    );
  }

  /** Stream matching model rows without materializing the complete result set. */
  iterate(): IterableIterator<row> {
    const statement = this.statement();
    return this.database.iterateRows(this.model, statement.sql, statement.parameters);
  }

  /** Return a zero-based row by index. */
  at(index: number): row | undefined {
    return this.offset(index).limit(1).first();
  }

  [Symbol.iterator](): Iterator<row> {
    return this.iterate();
  }
}

/** Tracks local USN updates made through a master database. */
export class RekordboxAgentRegistry {
  constructor(private database: MasterDatabase) {}

  /** Query every agent registry row. */
  getRegistries(): Query<models.AgentRegistry> {
    return this.database.query(models.AgentRegistry);
  }

  /** Return one registry row by identifier. */
  getRegistry(key: string): models.AgentRegistry {
    return this.database.query(models.AgentRegistry).where({ registry_id: key }).one();
  }

  getString(key: string): string | null {
    const value = this.getRegistry(key).get("str_1");
    return value == null ? null : String(value);
  }
  getText(key: string): string | null {
    const value = this.getRegistry(key).get("text_1");
    return value == null ? null : String(value);
  }
  getInt(key: string): number {
    return Number(this.getRegistry(key).get("int_1"));
  }
  getDate(key: string): Date | null {
    const value = this.getRegistry(key).get("date_1");
    if (value == null) return null;
    return value instanceof Date ? value : stringToDatetime(String(value));
  }

  setString(key: string, value: string): void {
    this.getRegistry(key).set("str_1", value);
  }
  setText(key: string, value: string): void {
    this.getRegistry(key).set("text_1", value);
  }
  setInt(key: string, value: number): void {
    this.getRegistry(key).set("int_1", value);
  }
  setDate(key: string, value: Date): void {
    this.getRegistry(key).set("date_1", value);
  }

  /** Record an explicit model update, matching pyrekordbox's registry hook. */
  onUpdate(instance: models.DatabaseRow, key: string, value: models.DatabaseValue): void {
    if (instance.get(key) !== value) instance.set(key, value);
    else this.database.recordChange(instance);
  }

  /** Record an explicitly constructed model as newly created. */
  onCreate(instance: models.DatabaseRow): void {
    this.database.add(instance);
  }

  /** Record an explicit deletion hook without issuing a second DELETE. */
  onDelete(instance: models.DatabaseRow): void {
    this.database.recordChange(instance);
  }

  /** Record every row participating in an ordering move. */
  onMove(instances: models.DatabaseRow | Array<models.DatabaseRow>): void {
    for (const instance of Array.isArray(instances) ? instances : [instances])
      this.database.recordChange(instance);
  }

  /** Clear pending change events without discarding staged row values. */
  clearBuffer(): void {
    this.database.clearChanges();
  }
  /** Enable change/USN tracking. */
  enableTracking(): void {
    this.database.enableTracking();
  }
  /** Disable change/USN tracking until explicitly re-enabled. */
  disableTracking(): void {
    this.database.disableTracking();
  }
  /** Run a callback with change/USN tracking temporarily disabled. */
  disabled<result>(callback: () => result): result {
    return this.database.withTrackingDisabled(callback);
  }

  /** Current local update sequence number. */
  getLocalUpdateCount(): number {
    return this.getInt("localUpdateCount");
  }

  /** Set the global local update sequence number. */
  setLocalUpdateCount(value: number): void {
    if (!Number.isInteger(value)) throw new TypeError("USN must be an integer");
    this.database.withTrackingDisabled(() => this.setInt("localUpdateCount", value));
  }

  /** Increment the global local update sequence number. */
  incrementLocalUpdateCount(count = 1): number {
    if (!Number.isInteger(count) || count < 1)
      throw new RangeError("USN increment must be positive");
    const next = this.getLocalUpdateCount() + count;
    this.setLocalUpdateCount(next);
    return next;
  }

  /** Assign sequential local USNs to pending changes. */
  autoincrementLocalUpdateCount(setRowUsn = true): number {
    let usn = this.getLocalUpdateCount();
    const changes = this.database.consumeChanges();
    this.database.withTrackingDisabled(() => {
      for (const row of changes) {
        usn += 1;
        if (
          setRowUsn &&
          row.state !== "deleted" &&
          this.database.hasColumn(row.tableName, "rb_local_usn")
        )
          row.set("rb_local_usn", usn);
      }
      this.setLocalUpdateCount(usn);
    });
    return usn;
  }
}

/** Synchronous Rekordbox 6/7 `master.db` handler. */
export class MasterDatabase {
  /** Native SQLite connection for advanced read-only use. */
  connection: Database.Database | undefined;
  /** Change/USN registry. */
  registry: RekordboxAgentRegistry;
  /** Database file path. */
  path: string;
  /** Directory containing `master.db` and playlist metadata. */
  dbDirectory: string;
  /** Rekordbox share directory containing analysis data. */
  shareDirectory: string;
  /** Whether writes are disabled. */
  readonly: boolean;
  /** Optional `masterPlaylists6.xml` companion file. */
  playlistXml: MasterPlaylistXml | undefined;

  private options: Required<Pick<MasterDatabaseOptions, "readonly" | "unlock">> &
    MasterDatabaseOptions;
  private tables = new Set<string>();
  private schemas = new Map<string, TableSchema>();
  private identity = new Map<string, models.DatabaseRow>();
  private tracked = new Set<models.DatabaseRow>();
  private changes: Array<models.DatabaseRow> = [];
  private trackingDisabled = 0;
  private autoflushDisabled = 0;
  private transactionOpen = false;
  private events = new Map<string, DatabaseEventHandler>();

  constructor(
    pathOrOptions: string | MasterDatabaseOptions = {},
    overrides: MasterDatabaseOptions = {},
  ) {
    const supplied =
      typeof pathOrOptions === "string" ? { ...overrides, path: pathOrOptions } : pathOrOptions;
    const configured = supplied.path
      ? undefined
      : (getConfig("rekordbox7") ?? getConfig("rekordbox6"));
    const path = supplied.path ?? configured?.dbPath;
    if (!path) throw new TypeError("No Rekordbox 6/7 master.db path was supplied or discovered");
    if (!existsSync(path) || !statSync(path).isFile())
      throw new TypeError(`Database '${path}' does not exist`);
    this.path = path;
    this.dbDirectory = supplied.dbDirectory ?? dirname(path);
    this.shareDirectory = join(this.dbDirectory, "share");
    this.readonly = supplied.readonly ?? true;
    this.options = { ...supplied, path, readonly: this.readonly, unlock: supplied.unlock ?? true };
    this.registry = new RekordboxAgentRegistry(this);
    this.open();
    if (supplied.playlistXml !== false) {
      const playlistPath = join(this.dbDirectory, "masterPlaylists6.xml");
      if (existsSync(playlistPath)) this.playlistXml = new MasterPlaylistXml(playlistPath);
    }
  }

  /** Create an owned headless library without requiring a desktop Rekordbox installation. */
  static createManaged(path: string): MasterDatabase {
    if (existsSync(path)) throw new Error(`Refusing to replace database '${path}'`);
    mkdirSync(dirname(path), { recursive: true });
    const connection = new Database(path);
    try {
      connection.pragma("cipher='sqlcipher'");
      connection.pragma("legacy=4");
      connection.pragma(`key='${deobfuscate(defaultKeyBlob).replaceAll("'", "''")}'`);
      connection.exec(managedLibrarySchema);
      const now = new Date().toISOString();
      connection
        .prepare(
          "INSERT INTO agentRegistry (registry_id, int_1, created_at, updated_at) VALUES ('localUpdateCount', 0, ?, ?)",
        )
        .run(now, now);
      connection
        .prepare("INSERT INTO djmdDevice (ID, MasterDBID, Name) VALUES ('1', ?, 'djbooth cloud')")
        .run(randomUUID());
    } finally {
      connection.close();
    }
    writeFileSync(
      join(dirname(path), "masterPlaylists6.xml"),
      '<?xml version="1.0" encoding="UTF-8"?>\n<MASTER_PLAYLIST Version="3.0.0" AutomaticSync="0"><PRODUCT Name="rekordbox" Version="7.0.0" Company="AlphaTheta"/><PLAYLISTS/></MASTER_PLAYLIST>\n',
      { flag: "wx" },
    );
    return new MasterDatabase({ path, readonly: false });
  }

  /** Consistent logical snapshot, re-encrypted with this library's key. */
  async backup(output: string): Promise<void> {
    if (existsSync(output)) throw new Error(`Refusing to replace backup '${output}'`);
    const source = this.requireConnection();
    if (source.inTransaction) throw new Error("Back up through a separate read-only connection");
    source.exec("BEGIN");
    try {
      await this.copyUnlocked(output);
    } finally {
      source.exec("ROLLBACK");
    }
    if (this.options.unlock) {
      const destination = new Database(output);
      try {
        destination.pragma("cipher='sqlcipher'");
        destination.pragma("legacy=4");
        destination.pragma(
          `rekey='${(this.options.key ?? deobfuscate(defaultKeyBlob)).replaceAll("'", "''")}'`,
        );
      } finally {
        destination.close();
      }
    }
  }

  /** Open the native database connection if closed. */
  open(): void {
    if (this.connection?.open) return;
    const connection = new Database(this.path, {
      fileMustExist: true,
      readonly: this.readonly,
    });
    if (this.options.unlock) {
      const key = this.options.key ?? deobfuscate(defaultKeyBlob);
      connection.pragma("cipher='sqlcipher'");
      connection.pragma("legacy=4");
      connection.pragma(`key='${key.replaceAll("'", "''")}'`);
    }
    connection.pragma("foreign_keys=ON");
    connection.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
    this.connection = connection;
    this.loadSchema();
  }

  /** Roll back pending changes and close the native connection. */
  close(): void {
    if (!this.connection) return;
    this.rollback();
    this.connection.close();
    this.connection = undefined;
    this.tables.clear();
    this.schemas.clear();
    this.identity.clear();
    this.events.clear();
  }

  /** Register a SQLAlchemy-style lifecycle callback such as `before_flush`. */
  registerEvent(identifier: string, callback: DatabaseEventHandler): void {
    this.events.set(identifier, callback);
  }

  /** Remove a registered lifecycle callback. */
  unregisterEvent(identifier: string): void {
    if (!this.events.delete(identifier))
      throw new RangeError(`Database event '${identifier}' is not registered`);
  }

  private emit(identifier: string): void {
    this.events.get(identifier)?.(this);
  }

  /** Run a callback without query-triggered autoflush. */
  withNoAutoflush<result>(callback: () => result): result {
    this.autoflushDisabled += 1;
    try {
      return callback();
    } finally {
      this.autoflushDisabled -= 1;
    }
  }

  /** Callback wrapper corresponding to pyrekordbox's `no_autoflush` context. */
  get noAutoflush(): <result>(callback: () => result) => result {
    return <result>(callback: () => result) => this.withNoAutoflush(callback);
  }

  private requireConnection(): Database.Database {
    if (!this.connection?.open) throw new SessionNotInitializedError();
    return this.connection;
  }

  private requireWritable(): void {
    if (this.readonly)
      throw new Error("Database was opened read-only; pass readonly: false to mutate it");
  }

  private loadSchema(): void {
    const connection = this.requireConnection();
    const tables = connection
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as Array<{ name: string }>;
    this.tables = new Set(tables.map(({ name }) => name));
    this.schemas.clear();
  }

  /** Physical table names in this database. */
  get tableNames(): Array<string> {
    return [...this.tables].sort();
  }

  /**
   * Execute arbitrary parameterized SQL, matching the escape hatch provided by
   * pyrekordbox's public SQLAlchemy engine/session.
   *
   * Reader statements return plain rows. Mutating statements require a writable
   * database and return SQLite's run metadata.
   */
  executeSql<row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters: Array<unknown> = [],
  ): SqlResult<row> {
    if (this.tracked.size && !this.autoflushDisabled) this.flush();
    const statement = this.requireConnection().prepare(sql);
    const serialized = parameters.map((value) => this.serializeUnknown(value));
    if (statement.reader) return statement.all(...serialized) as Array<row>;
    this.requireWritable();
    const result = statement.run(...serialized);
    if (/^\s*(?:ALTER|CREATE|DROP)\s+TABLE\b/iu.test(sql)) this.loadSchema();
    return result;
  }

  /** Execute an arbitrary reader statement and return all plain rows. */
  selectRawRows<row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters: Array<unknown> = [],
  ): Array<row> {
    const result = this.executeSql<row>(sql, parameters);
    if (!Array.isArray(result)) throw new TypeError("SQL statement does not return rows");
    return result;
  }

  /** Whether a physical table exists. */
  hasTable(table: string): boolean {
    return this.tables.has(table);
  }

  /** Whether a physical column exists. */
  hasColumn(table: string, column: string): boolean {
    return this.hasTable(table) && this.schema(table).names.has(column);
  }

  /**
   * Forget materialized row identities so subsequent queries read fresh external database state.
   *
   * Existing row references remain unchanged. Expiry is rejected while any local write is staged or
   * flushed into an open transaction, because forgetting those rows would make rollback unsafe.
   */
  expireIdentityMap(): void {
    if (
      this.transactionOpen ||
      this.connection?.inTransaction ||
      this.tracked.size ||
      this.changes.length
    )
      throw new Error("Cannot expire the identity map while database changes are pending");
    this.identity.clear();
  }

  /** Physical column names for one introspected table. */
  columnNames(table: string): Array<string> {
    return this.schema(table).columns.map((column) => column.name);
  }

  private schema(table: string): TableSchema {
    const cached = this.schemas.get(table);
    if (cached) return cached;
    if (!this.tables.has(table)) throw new RangeError(`Table '${table}' does not exist`);
    const columns = this.requireConnection()
      .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
      .all() as Array<TableColumn>;
    const schema = {
      columns,
      dates: new Set(
        columns
          .filter(
            (column) =>
              /DATE|TIME/iu.test(column.type) ||
              ["releaseDate", "dateCreated", "dateAdded", "createdDate"].includes(column.name),
          )
          .map((column) => column.name),
      ),
      names: new Set(columns.map((column) => column.name)),
      primaryKeys: columns.filter((column) => column.pk).map((column) => column.name),
    } satisfies TableSchema;
    this.schemas.set(table, schema);
    return schema;
  }

  private deserialize(table: string, data: Record<string, unknown>): models.RowData {
    const dates = this.schema(table).dates;
    return Object.fromEntries(
      Object.entries(data).map(([key, value]) => [
        key,
        value !== null && typeof value === "string" && dates.has(key)
          ? stringToDatetime(value)
          : (value as models.DatabaseValue),
      ]),
    );
  }

  /** @internal Serialize a known row value. */
  serializeValue(value: models.DatabaseValue): unknown {
    return value instanceof Date ? datetimeToString(value) : value;
  }

  /** @internal Serialize an arbitrary query parameter. */
  serializeUnknown(value: unknown): unknown {
    return value instanceof Date ? datetimeToString(value) : value;
  }

  private identityKey(table: string, data: models.RowData): string | undefined {
    const keys = this.schema(table).primaryKeys;
    if (!keys.length || keys.some((key) => data[key] === undefined)) return undefined;
    return `${table}:${keys.map((key) => String(data[key])).join("\u001f")}`;
  }

  private materialize<row extends models.DatabaseRow>(
    model: models.ModelClass<row>,
    raw: Record<string, unknown>,
  ): row {
    const data = this.deserialize(model.tableName, raw);
    const key = this.identityKey(model.tableName, data);
    if (key) {
      const cached = this.identity.get(key);
      if (cached && cached.state !== "deleted") return cached as row;
    }
    const row = new model(this, data);
    if (key) this.identity.set(key, row);
    return row;
  }

  /** @internal Execute a row-selecting query. */
  selectRows<row extends models.DatabaseRow>(
    model: models.ModelClass<row>,
    sql: string,
    parameters: Array<unknown>,
  ): Array<row> {
    if (this.tracked.size && !this.autoflushDisabled) this.flush();
    const rows = this.requireConnection()
      .prepare(sql)
      .all(...parameters) as Array<Record<string, unknown>>;
    return rows.map((raw) => this.materialize(model, raw));
  }

  /** @internal Stream model rows from a parameterized statement. */
  *iterateRows<row extends models.DatabaseRow>(
    model: models.ModelClass<row>,
    sql: string,
    parameters: Array<unknown>,
  ): IterableIterator<row> {
    if (this.tracked.size && !this.autoflushDisabled) this.flush();
    const rows = this.requireConnection()
      .prepare(sql)
      .iterate(...parameters) as IterableIterator<Record<string, unknown>>;
    for (const raw of rows) yield this.materialize(model, raw);
  }

  /** @internal Execute a count query. */
  countRows(sql: string, parameters: Array<unknown>): number {
    if (this.tracked.size && !this.autoflushDisabled) this.flush();
    const row = this.requireConnection()
      .prepare(sql)
      .get(...parameters) as { count: number };
    return row.count;
  }

  /** Create a query for a model class or physical table name. */
  query<row extends models.DatabaseRow>(model: models.ModelClass<row>): Query<row>;
  /** Create an untyped query for a physical table name. */
  query(model: string): Query<models.DatabaseRow>;
  query<row extends models.DatabaseRow>(model: models.ModelClass<row> | string): Query<row> {
    this.requireConnection();
    let resolved: models.ModelClass<row>;
    if (typeof model === "string") {
      const tableName = model;
      resolved = (models.modelByTable[tableName] ??
        class extends models.DatabaseRow {
          static override tableName = tableName;
        }) as models.ModelClass<row>;
    } else resolved = model;
    this.schema(resolved.tableName);
    return new Query(this, resolved);
  }

  private lookup<row extends models.DatabaseRow>(
    model: models.ModelClass<row>,
    filters: Record<string, models.DatabaseValue> = {},
  ): Query<row> | row | undefined {
    const query = this.query(model).where(filters);
    return "ID" in filters || "registry_id" in filters ? query.oneOrNone() : query;
  }

  /** @internal Track one physical column update. */
  setRowValue(row: models.DatabaseRow, column: string, value: models.DatabaseValue): void {
    this.requireWritable();
    if (row.state === "deleted") throw new Error("Cannot mutate a deleted row");
    if (equalValue(row.data[column], value)) return;
    row.data[column] = value;
    this.tracked.add(row.proxy);
    if (!this.trackingDisabled) this.changes.push(row.proxy);
  }

  /** Construct a default-populated row without staging it in the session. */
  construct<row extends models.DatabaseRow>(
    model: models.ModelClass<row>,
    values: Record<string, models.DatabaseValue>,
  ): row {
    const schema = this.schema(model.tableName);
    for (const key of Object.keys(values))
      if (!schema.names.has(key))
        throw new RangeError(`Column '${key}' does not exist on '${model.tableName}'`);
    const now = new Date();
    const data: models.RowData = { ...values };
    if (schema.names.has("created_at") && data.created_at === undefined) data.created_at = now;
    if (schema.names.has("updated_at") && data.updated_at === undefined) data.updated_at = now;
    if (schema.names.has("UUID") && data.UUID === undefined) data.UUID = randomUUID();
    return new model(this, data, "new");
  }

  /** Create and stage a new mapped row. */
  create<row extends models.DatabaseRow>(
    model: models.ModelClass<row>,
    values: Record<string, models.DatabaseValue>,
  ): row {
    this.requireWritable();
    const row = this.construct(model, values);
    const data = row.data;
    const key = this.identityKey(model.tableName, data);
    if (key) this.identity.set(key, row);
    this.tracked.add(row.proxy);
    if (!this.trackingDisabled) this.changes.push(row.proxy);
    return row;
  }

  /** Stage a row for deletion. */
  delete(row: models.DatabaseRow): void {
    this.requireWritable();
    if (row.database !== this) throw new TypeError("Cannot delete a row owned by another database");
    if (row.state === "deleted") return;
    if (row.tableName === "djmdPlaylist" && !(row.newlyCreated && row.flushed === undefined)) {
      for (const child of this.query(models.DjmdPlaylist)
        .where({ ParentID: row.get("ID")! })
        .all())
        this.delete(child);
      for (const song of this.query(models.DjmdSongPlaylist)
        .where({ PlaylistID: row.get("ID")! })
        .all())
        this.delete(song);
    }
    if (row.newlyCreated && row.flushed === undefined) {
      const key = this.identityKey(row.tableName, row.data);
      if (key) this.identity.delete(key);
      this.tracked.delete(row.proxy);
      this.changes = this.changes.filter((change) => change !== row.proxy);
      row.state = "deleted";
      return;
    }
    row.state = "deleted";
    this.tracked.add(row.proxy);
    if (!this.trackingDisabled) this.changes.push(row.proxy);
  }

  /** Stage an already-created row owned by this database. */
  add(row: models.DatabaseRow): void {
    this.requireWritable();
    if (row.database !== this) throw new TypeError("Cannot add a row owned by another database");
    if (row.state !== "new") throw new TypeError("Only newly created rows can be added");
    if (this.tracked.has(row.proxy)) return;
    this.tracked.add(row.proxy);
    if (!this.trackingDisabled) this.changes.push(row.proxy);
  }

  /** @internal Record a row in the pending USN/update sequence. */
  recordChange(row: models.DatabaseRow): void {
    if (row.database !== this) throw new TypeError("Cannot track a row owned by another database");
    this.tracked.add(row.proxy);
    if (!this.trackingDisabled) this.changes.push(row.proxy);
  }

  /** @internal Temporarily suppress USN event recording. */
  withTrackingDisabled<result>(callback: () => result): result {
    this.trackingDisabled += 1;
    try {
      return callback();
    } finally {
      this.trackingDisabled -= 1;
    }
  }

  /** Disable change/USN tracking until {@link enableTracking} is called. */
  disableTracking(): void {
    this.trackingDisabled += 1;
  }

  /** Re-enable one level of explicitly disabled change/USN tracking. */
  enableTracking(): void {
    if (this.trackingDisabled > 0) this.trackingDisabled -= 1;
  }

  /** Clear pending USN events without changing staged rows. */
  clearChanges(): void {
    this.changes = [];
  }

  /** @internal Consume pending USN events. */
  consumeChanges(): Array<models.DatabaseRow> {
    const changes = [...this.changes];
    this.changes = [];
    return changes;
  }

  private primaryPredicate(row: models.DatabaseRow): WhereClause {
    const keys = this.schema(row.tableName).primaryKeys;
    if (!keys.length) throw new Error(`Table '${row.tableName}' has no primary key`);
    return {
      parameters: keys.map((key) => {
        const value = row.newlyCreated ? (row.flushed?.[key] ?? row.data[key]) : row.original[key];
        if (value === undefined)
          throw new Error(`Primary key '${key}' is missing on '${row.tableName}'`);
        return this.serializeValue(value);
      }),
      sql: keys.map((key) => `${quoteIdentifier(key)} = ?`).join(" AND "),
    };
  }

  /** Flush staged changes into an open SQLite transaction. */
  flush(): void {
    if (!this.tracked.size) return;
    this.requireWritable();
    this.emit("before_flush");
    const connection = this.requireConnection();
    if (!this.transactionOpen) {
      connection.exec("BEGIN");
      this.transactionOpen = true;
    }
    // Playlist moves/replacements commonly stage thousands of rows with the same physical shape.
    // Compile each INSERT/UPDATE/DELETE once for this flush and only rebind row values thereafter.
    const statements = new Map<string, Database.Statement>();
    const prepare = (sql: string): Database.Statement => {
      const cached = statements.get(sql);
      if (cached) return cached;
      const statement = connection.prepare(sql);
      statements.set(sql, statement);
      return statement;
    };

    for (const row of this.tracked) {
      if (row.state === "new" && row.flushed === undefined) {
        const entries = Object.entries(row.data);
        const sql = entries.length
          ? `INSERT INTO ${quoteIdentifier(row.tableName)} (${entries
              .map(([key]) => quoteIdentifier(key))
              .join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`
          : `INSERT INTO ${quoteIdentifier(row.tableName)} DEFAULT VALUES`;
        const result = prepare(sql).run(...entries.map(([, value]) => this.serializeValue(value)));
        const schema = this.schema(row.tableName);
        if (schema.primaryKeys.length === 1) {
          const primaryKey = schema.primaryKeys[0]!;
          const column = schema.columns.find((item) => item.name === primaryKey)!;
          if (row.data[primaryKey] === undefined && /INT/iu.test(column.type)) {
            row.data[primaryKey] = result.lastInsertRowid;
            const key = this.identityKey(row.tableName, row.data);
            if (key) this.identity.set(key, row.proxy);
          }
        }
        row.flushed = { ...row.data };
        continue;
      }

      if (row.state === "deleted") {
        const where = this.primaryPredicate(row);
        prepare(`DELETE FROM ${quoteIdentifier(row.tableName)} WHERE ${where.sql}`).run(
          ...where.parameters,
        );
        row.flushed = { ...row.data };
        continue;
      }

      const baseline = row.flushed ?? row.original;
      const changed = Object.keys(row.data).filter(
        (key) => !equalValue(row.data[key], baseline[key]),
      );
      if (!changed.length) continue;
      const where = this.primaryPredicate(row);
      const sql = `UPDATE ${quoteIdentifier(row.tableName)} SET ${changed
        .map((key) => `${quoteIdentifier(key)} = ?`)
        .join(", ")} WHERE ${where.sql}`;
      prepare(sql).run(
        ...changed.map((key) => this.serializeValue(row.data[key]!)),
        ...where.parameters,
      );
      row.flushed = { ...row.data };
      const previousKey = this.identityKey(row.tableName, row.original);
      const currentKey = this.identityKey(row.tableName, row.data);
      if (previousKey && previousKey !== currentKey) this.identity.delete(previousKey);
      if (currentKey) this.identity.set(currentKey, row.proxy);
    }
    this.emit("after_flush");
  }

  /** Commit staged changes, assigning local USNs by default. */
  commit(options: CommitOptions | boolean = {}): void {
    const normalized = typeof options === "boolean" ? { autoincrement: options } : options;
    this.assertCommitAllowed();
    this.emit("before_commit");
    if ((normalized.autoincrement ?? true) && this.changes.length)
      this.registry.autoincrementLocalUpdateCount(true);
    this.flush();
    const playlistChanges = [...this.tracked].filter((row) => row.tableName === "djmdPlaylist");
    if (this.transactionOpen) {
      this.requireConnection().exec("COMMIT");
      this.transactionOpen = false;
    }
    try {
      if (this.playlistXml) {
        for (const row of playlistChanges) {
          const id = row.get("ID");
          if (id == null) continue;
          const entry = this.playlistXml.get(String(id));
          if (row.state === "deleted") {
            if (entry) this.playlistXml.remove(String(id));
            continue;
          }
          const parentId = row.get("ParentID") ?? "root";
          const attribute = Number(row.get("Attribute"));
          const updatedAt = row.get("updated_at");
          const date = updatedAt instanceof Date ? updatedAt : new Date();
          if (entry)
            this.playlistXml.update(String(id), {
              attribute,
              parentId: String(parentId),
              updatedAt: date,
            });
          else this.playlistXml.add(String(id), String(parentId), attribute, date);
        }
        if (this.playlistXml.modified) this.playlistXml.save();
      }
    } finally {
      this.acceptCommittedChanges();
    }
    this.emit("after_commit");
  }

  private acceptCommittedChanges(): void {
    for (const row of this.tracked) {
      if (row.state === "deleted") {
        for (const values of [row.original, row.flushed, row.data]) {
          if (!values) continue;
          const key = this.identityKey(row.tableName, values);
          if (key) this.identity.delete(key);
        }
      } else {
        const previousKey = this.identityKey(row.tableName, row.original);
        const currentKey = this.identityKey(row.tableName, row.data);
        if (previousKey && previousKey !== currentKey) this.identity.delete(previousKey);
        if (currentKey) this.identity.set(currentKey, row.proxy);
        row.state = "existing";
        row.original = { ...row.data };
        row.flushed = undefined;
        row.newlyCreated = false;
      }
    }
    this.tracked.clear();
    this.changes = [];
  }

  /** Validate that the database was opened for writes. */
  assertCommitAllowed(): void {
    this.requireWritable();
  }

  /** Roll back all staged and flushed-but-uncommitted changes. */
  rollback(): void {
    if (this.transactionOpen && this.connection?.open) this.connection.exec("ROLLBACK");
    for (const row of this.tracked) {
      if (row.newlyCreated) {
        const key = this.identityKey(row.tableName, row.data);
        if (key) this.identity.delete(key);
        row.data = { ...row.original };
        row.state = "new";
        row.flushed = undefined;
      } else {
        row.data = { ...row.original };
        row.state = "existing";
        row.flushed = undefined;
      }
    }
    this.tracked.clear();
    this.changes = [];
    this.transactionOpen = false;
    this.emit("after_rollback");
  }

  /** Current local update sequence number. */
  getLocalUsn(): number {
    return this.registry.getLocalUpdateCount();
  }
  /** Set the global local update sequence number. */
  setLocalUsn(value: number): void {
    this.registry.setLocalUpdateCount(value);
  }
  /** Increment the global local update sequence number. */
  incrementLocalUsn(count = 1): number {
    return this.registry.incrementLocalUpdateCount(count);
  }
  /** Assign local USNs for pending changes. */
  autoincrementUsn(setRowUsn = true): number {
    return this.registry.autoincrementLocalUpdateCount(setRowUsn);
  }

  protected relationshipCollection<row extends models.DatabaseRow>(
    owner: models.DatabaseRow,
    model: models.ModelClass<row>,
    foreignKey: string,
    order?: string,
    ownerKey = "ID",
  ): Array<row> {
    const query = this.query(model).where({ [foreignKey]: owner.get(ownerKey)! });
    const rows = (
      order && this.hasColumn(model.tableName, order) ? query.orderBy(order) : query
    ).all();
    const attach = (value: unknown): row => {
      if (!(value instanceof models.DatabaseRow))
        throw new TypeError("Relationship collections only accept database rows");
      if (value.database !== this)
        throw new TypeError("Relationship row belongs to another database");
      if (value.state === "new") this.add(value);
      value.set(foreignKey, owner.get(ownerKey)!);
      return value as row;
    };
    const detach = (value: row | undefined) => {
      if (value && value.state !== "deleted") value.set(foreignKey, null);
      return value;
    };
    return new Proxy(rows, {
      get: (target, property, receiver) => {
        if (property === "push")
          return (...items: Array<row>) => Array.prototype.push.apply(target, items.map(attach));
        if (property === "unshift")
          return (...items: Array<row>) => Array.prototype.unshift.apply(target, items.map(attach));
        if (property === "pop") return () => detach(Array.prototype.pop.call(target));
        if (property === "shift") return () => detach(Array.prototype.shift.call(target));
        if (property === "splice")
          return (start: number, deleteCount?: number, ...items: Array<row>) => {
            const removed = Array.prototype.splice.call(
              target,
              start,
              deleteCount ?? target.length - start,
            ) as Array<row>;
            removed.forEach(detach);
            Array.prototype.splice.call(target, start, 0, ...items.map(attach));
            return removed;
          };
        return Reflect.get(target, property, receiver);
      },
      set: (target, property, value, receiver) => {
        if (typeof property === "string" && /^\d+$/u.test(property)) attach(value);
        return Reflect.set(target, property, value, receiver);
      },
    });
  }

  /** @internal Resolve relationships and virtual properties. */
  getComputed(row: models.DatabaseRow, property: string): unknown {
    const one = (model: models.ModelClass, filters: Record<string, models.DatabaseValue>) =>
      this.query(model).where(filters).oneOrNone();
    const named = (value: unknown, key: string) =>
      value instanceof models.DatabaseRow ? value[key] : undefined;
    const byId = (model: models.ModelClass, value: models.DatabaseValue | undefined) =>
      value == null ? undefined : one(model, { ID: value });

    if (
      ["contentActiveCensor", "contentCue", "contentFile", "djmdActiveCensor"].includes(
        row.tableName,
      ) &&
      property === "Content"
    )
      return byId(models.DjmdContent, row.get("ContentID"));

    if (row.tableName === "djmdAlbum") {
      if (property === "AlbumArtist") return byId(models.DjmdArtist, row.get("AlbumArtistID"));
      if (property === "AlbumArtistName")
        return named(this.getComputed(row, "AlbumArtist"), "Name");
    }
    if (row.tableName === "djmdCategory" && property === "MenuItem")
      return byId(models.DjmdMenuItems, row.get("MenuItemID"));

    if (row.tableName === "djmdContent") {
      const relations: Record<string, [models.ModelClass, string]> = {
        Album: [models.DjmdAlbum, "AlbumID"],
        Artist: [models.DjmdArtist, "ArtistID"],
        Color: [models.DjmdColor, "ColorID"],
        Composer: [models.DjmdArtist, "ComposerID"],
        Genre: [models.DjmdGenre, "GenreID"],
        Key: [models.DjmdKey, "KeyID"],
        Label: [models.DjmdLabel, "LabelID"],
        OrgArtist: [models.DjmdArtist, "OrgArtistID"],
        Remixer: [models.DjmdArtist, "RemixerID"],
      };
      const relation = relations[property];
      if (relation) {
        const id = row.get(relation[1]);
        return id == null ? undefined : one(relation[0], { ID: id });
      }
      if (property === "Cues") return this.relationshipCollection(row, models.DjmdCue, "ContentID");
      if (property === "MyTags")
        return this.relationshipCollection(row, models.DjmdSongMyTag, "ContentID", "TrackNo");
      if (property === "ActiveCensors")
        return this.relationshipCollection(row, models.DjmdActiveCensor, "ContentID");
      if (property === "MixerParams")
        return this.relationshipCollection(row, models.DjmdMixerParam, "ContentID");
      if (property === "AlbumArtist")
        return (this.getComputed(row, "Album") as models.DjmdAlbum | undefined)?.AlbumArtist;
      const proxies: Record<string, [string, string]> = {
        AlbumArtistName: ["Album", "AlbumArtistName"],
        AlbumName: ["Album", "Name"],
        ArtistName: ["Artist", "Name"],
        ColorName: ["Color", "Commnt"],
        ComposerName: ["Composer", "Name"],
        GenreName: ["Genre", "Name"],
        KeyName: ["Key", "ScaleName"],
        LabelName: ["Label", "Name"],
        OrgArtistName: ["OrgArtist", "Name"],
        RemixerName: ["Remixer", "Name"],
      };
      const proxy = proxies[property];
      if (proxy) return named(this.getComputed(row, proxy[0]), proxy[1]);
      if (property === "MyTagNames")
        return (this.getComputed(row, "MyTags") as Array<models.DjmdSongMyTag>).map(
          (tag) => tag.MyTagName,
        );
      if (property === "MyTagIDs")
        return (this.getComputed(row, "MyTags") as Array<models.DjmdSongMyTag>).map(
          (tag) => tag.MyTagID,
        );
    }

    const trees: Record<
      string,
      { child: models.ModelClass; link?: models.ModelClass; linkKey?: string }
    > = {
      djmdHistory: {
        child: models.DjmdHistory,
        link: models.DjmdSongHistory,
        linkKey: "HistoryID",
      },
      djmdHotCueBanklist: { child: models.DjmdHotCueBanklist },
      djmdMyTag: {
        child: models.DjmdMyTag,
        link: models.DjmdSongMyTag,
        linkKey: "MyTagID",
      },
      djmdRelatedTracks: {
        child: models.DjmdRelatedTracks,
        link: models.DjmdSongRelatedTracks,
        linkKey: "RelatedTracksID",
      },
      djmdSampler: {
        child: models.DjmdSampler,
        link: models.DjmdSongSampler,
        linkKey: "SamplerID",
      },
    };
    const tree = trees[row.tableName];
    if (tree) {
      if (property === "Children")
        return this.relationshipCollection(row, tree.child, "ParentID", "Seq");
      if (property === "Parent") {
        const parentId = row.get("ParentID");
        return parentId == null || parentId === "root"
          ? undefined
          : one(tree.child, { ID: parentId });
      }
      if ((property === "Songs" || property === "MyTags") && tree.link && tree.linkKey)
        return this.relationshipCollection(row, tree.link, tree.linkKey, "TrackNo");
    }
    if (row.tableName === "djmdPlaylist") {
      if (property === "isPlaylist")
        return Number(row.get("Attribute")) === models.PlaylistType.PLAYLIST;
      if (property === "isFolder")
        return Number(row.get("Attribute")) === models.PlaylistType.FOLDER;
      if (property === "isSmartPlaylist")
        return Number(row.get("Attribute")) === models.PlaylistType.SMART_PLAYLIST;
      if (property === "Songs")
        return this.relationshipCollection(row, models.DjmdSongPlaylist, "PlaylistID", "TrackNo");
      if (property === "Children")
        return this.relationshipCollection(row, models.DjmdPlaylist, "ParentID", "Seq");
      if (property === "Parent") {
        const id = row.get("ParentID");
        return id === "root" || id == null ? undefined : one(models.DjmdPlaylist, { ID: id });
      }
    }
    if (row.tableName === "djmdSongPlaylist") {
      if (property === "Content") return one(models.DjmdContent, { ID: row.get("ContentID")! });
      if (property === "Playlist") return one(models.DjmdPlaylist, { ID: row.get("PlaylistID")! });
    }
    const contentLinks = new Set([
      "djmdSongHistory",
      "djmdSongHotCueBanklist",
      "djmdSongMyTag",
      "djmdSongRelatedTracks",
      "djmdSongSampler",
      "djmdSongTagList",
    ]);
    if (contentLinks.has(row.tableName) && property === "Content")
      return byId(models.DjmdContent, row.get("ContentID"));
    if (row.tableName === "djmdSongHistory" && property === "History")
      return byId(models.DjmdHistory, row.get("HistoryID"));
    if (row.tableName === "djmdSongMyTag") {
      if (property === "MyTag") return byId(models.DjmdMyTag, row.get("MyTagID"));
      if (property === "MyTagName") return named(this.getComputed(row, "MyTag"), "Name");
    }
    if (row.tableName === "djmdSongRelatedTracks" && property === "RelatedTracks")
      return byId(models.DjmdRelatedTracks, row.get("RelatedTracksID"));
    if (row.tableName === "djmdSongSampler" && property === "Sampler")
      return byId(models.DjmdSampler, row.get("SamplerID"));
    if (row.tableName === "djmdSort" && property === "MenuItem")
      return byId(models.DjmdMenuItems, row.get("MenuItemID"));
    if (row.tableName === "djmdCue") {
      if (property === "Content") return one(models.DjmdContent, { ID: row.get("ContentID")! });
      if (property === "isMemoryCue") return Number(row.get("Kind")) === 0;
      if (property === "isHotCue") return Number(row.get("Kind")) > 0;
    }
    if (row.tableName === "djmdMixerParam") {
      if (property === "Content") return one(models.DjmdContent, { ID: row.get("ContentID")! });
      if (property === "Gain") return this.decodeDb(row.get("GainLow"), row.get("GainHigh"));
      if (property === "Peak") return this.decodeDb(row.get("PeakLow"), row.get("PeakHigh"));
    }
    return undefined;
  }

  /** @internal Set virtual values, relationships, and association proxies. */
  setComputed(row: models.DatabaseRow, property: string, value: unknown): boolean {
    if (row.tableName === "djmdMixerParam" && ["Gain", "Peak"].includes(property)) {
      const [low, high] = this.encodeDb(Number(value));
      row.set(`${property}Low`, low);
      row.set(`${property}High`, high);
      return true;
    }

    const ids: Record<string, Record<string, string>> = {
      contentActiveCensor: { Content: "ContentID" },
      contentCue: { Content: "ContentID" },
      contentFile: { Content: "ContentID" },
      djmdActiveCensor: { Content: "ContentID" },
      djmdAlbum: { AlbumArtist: "AlbumArtistID" },
      djmdCategory: { MenuItem: "MenuItemID" },
      djmdContent: {
        Album: "AlbumID",
        Artist: "ArtistID",
        Color: "ColorID",
        Composer: "ComposerID",
        Genre: "GenreID",
        Key: "KeyID",
        Label: "LabelID",
        OrgArtist: "OrgArtistID",
        Remixer: "RemixerID",
      },
      djmdCue: { Content: "ContentID" },
      djmdMixerParam: { Content: "ContentID" },
      djmdSongHistory: { Content: "ContentID", History: "HistoryID" },
      djmdSongHotCueBanklist: { Content: "ContentID" },
      djmdSongMyTag: { Content: "ContentID", MyTag: "MyTagID" },
      djmdSongPlaylist: { Content: "ContentID", Playlist: "PlaylistID" },
      djmdSongRelatedTracks: { Content: "ContentID", RelatedTracks: "RelatedTracksID" },
      djmdSongSampler: { Content: "ContentID", Sampler: "SamplerID" },
      djmdSongTagList: { Content: "ContentID" },
      djmdSort: { MenuItem: "MenuItemID" },
    };
    const foreignKey = ids[row.tableName]?.[property];
    if (foreignKey) {
      const id = value instanceof models.DatabaseRow ? value.get("ID") : value;
      if (id !== null && id !== undefined && typeof id !== "string" && typeof id !== "number")
        throw new TypeError("Relationship value must be a row, ID, or null");
      row.set(foreignKey, id == null ? null : String(id));
      return true;
    }

    if (
      [
        "djmdHistory",
        "djmdHotCueBanklist",
        "djmdMyTag",
        "djmdPlaylist",
        "djmdRelatedTracks",
        "djmdSampler",
      ].includes(row.tableName) &&
      property === "Parent"
    ) {
      const id = value instanceof models.DatabaseRow ? value.get("ID") : value;
      row.set("ParentID", id == null ? null : String(id));
      return true;
    }

    const collectionProperties = new Set([
      "ActiveCensors",
      "Children",
      "Cues",
      "MixerParams",
      "MyTags",
      "Songs",
    ]);
    if (collectionProperties.has(property) && Array.isArray(value)) {
      const current = this.getComputed(row, property);
      if (!Array.isArray(current)) return false;
      current.splice(0, current.length, ...value);
      return true;
    }

    const proxies: Record<string, [string, string]> = {
      AlbumArtistName: ["Album", "AlbumArtistName"],
      AlbumName: ["Album", "Name"],
      ArtistName: ["Artist", "Name"],
      ColorName: ["Color", "Commnt"],
      ComposerName: ["Composer", "Name"],
      GenreName: ["Genre", "Name"],
      KeyName: ["Key", "ScaleName"],
      LabelName: ["Label", "Name"],
      MyTagName: ["MyTag", "Name"],
      OrgArtistName: ["OrgArtist", "Name"],
      RemixerName: ["Remixer", "Name"],
    };
    const proxy = proxies[property];
    if (proxy) {
      const related = this.getComputed(row, proxy[0]);
      if (!(related instanceof models.DatabaseRow))
        throw new TypeError(`Cannot set '${property}' without an existing '${proxy[0]}' row`);
      related[proxy[1]] = value;
      return true;
    }
    return false;
  }

  private decodeDb(
    low: models.DatabaseValue | undefined,
    high: models.DatabaseValue | undefined,
  ): number {
    const data = Buffer.alloc(4);
    data.writeUInt16BE(Number(high), 0);
    data.writeUInt16BE(Number(low), 2);
    const factor = data.readFloatBE(0);
    return factor <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(factor);
  }

  private encodeDb(value: number): [number, number] {
    if (value === Number.NEGATIVE_INFINITY) return [0, 0];
    const data = Buffer.alloc(4);
    data.writeFloatBE(10 ** (value / 20), 0);
    const integer = data.readUInt32BE(0);
    return [integer & 0xffff, integer >>> 16];
  }

  // Table-specific query helpers.
  getActiveCensor(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdActiveCensor, filters);
  }
  getAlbum(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdAlbum, filters);
  }
  getArtist(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdArtist, filters);
  }
  getCategory(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdCategory, filters);
  }
  getColor(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdColor, filters);
  }
  getContent(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdContent, filters);
  }
  getCue(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdCue, filters);
  }

  private activeContentCueRows(content: models.DjmdContent): Array<models.DjmdCue> {
    return this.query(models.DjmdCue)
      .where({ ContentID: content.ID })
      .all()
      .filter((cue) => Number(cue.get("rb_local_deleted") ?? 0) === 0);
  }

  private assertActiveContent(content: models.DjmdContent): void {
    if (Number(content.get("rb_local_deleted") ?? 0) !== 0)
      throw new TypeError(`Content '${content.ID}' is deleted`);
  }

  private cueFromRow(row: models.DjmdCue): ContentCuePoint {
    const kind = Number(row.get("Kind"));
    if (!Number.isInteger(kind) || kind < 0 || kind > 16)
      throw new RangeError(`Cue '${String(row.get("ID"))}' has unsupported Kind '${kind}'`);
    const inMsec = Number(row.get("InMsec"));
    if (!Number.isInteger(inMsec) || inMsec < 0)
      throw new RangeError(`Cue '${String(row.get("ID"))}' has invalid InMsec '${inMsec}'`);
    const outMsec = Number(row.get("OutMsec") ?? -1);
    if (!Number.isInteger(outMsec) || outMsec < -1 || (outMsec >= 0 && outMsec <= inMsec))
      throw new RangeError(`Cue '${String(row.get("ID"))}' has invalid OutMsec '${outMsec}'`);
    const color = Number(row.get("Color") ?? -1);
    return {
      activeLoop: outMsec >= 0 && Number(row.get("ActiveLoop") ?? 0) !== 0,
      color: color < 0 ? null : color,
      colorTableIndex:
        row.get("ColorTableIndex") == null ? null : Number(row.get("ColorTableIndex")),
      comment: String(row.get("Comment") ?? ""),
      contentId: String(row.get("ContentID")),
      endSeconds: outMsec < 0 ? null : outMsec / 1_000,
      id: String(row.get("ID")),
      kind: kind === 0 ? "memory" : "hot",
      slot: kind === 0 ? null : (kind as HotCueSlot),
      startSeconds: inMsec / 1_000,
      type: outMsec < 0 ? "cue" : "loop",
    };
  }

  private sortContentCueRows(rows: Array<models.DjmdCue>): Array<models.DjmdCue> {
    return rows.sort((left, right) => {
      const leftKind = Number(left.get("Kind"));
      const rightKind = Number(right.get("Kind"));
      if ((leftKind === 0) !== (rightKind === 0)) return leftKind === 0 ? -1 : 1;
      if (leftKind > 0 && leftKind !== rightKind) return leftKind - rightKind;
      const position = Number(left.get("InMsec")) - Number(right.get("InMsec"));
      if (position) return position;
      return String(left.get("ID")).localeCompare(String(right.get("ID")), "en", {
        numeric: true,
      });
    });
  }

  private normalizeContentCueInput(
    content: models.DjmdContent,
    input: ContentCueInput,
  ): NormalizedContentCueInput {
    if (input.kind !== "memory" && input.kind !== "hot")
      throw new TypeError("Cue kind must be 'memory' or 'hot'");
    if (input.type !== "cue" && input.type !== "loop")
      throw new TypeError("Cue type must be 'cue' or 'loop'");
    if (
      input.kind === "hot" &&
      (!Number.isInteger(input.slot) || input.slot < 1 || input.slot > 16)
    )
      throw new RangeError("Hot Cue slot must be an integer from 1 through 16");
    if (input.kind === "memory" && input.slot !== undefined)
      throw new TypeError("Memory cues do not have a Hot Cue slot");

    const toMilliseconds = (value: number, label: string): number => {
      if (!Number.isFinite(value) || value < 0)
        throw new RangeError(`${label} must be a finite non-negative number`);
      const milliseconds = Math.round(value * 1_000);
      if (!Number.isSafeInteger(milliseconds)) throw new RangeError(`${label} is too large`);
      return milliseconds;
    };
    const startMsec = toMilliseconds(input.startSeconds, "Cue startSeconds");
    const duration = content.get("Length");
    const boundedDuration = Number(duration);
    if (
      Number.isFinite(boundedDuration) &&
      boundedDuration > 0 &&
      startMsec > boundedDuration * 1_000
    )
      throw new RangeError("Cue startSeconds exceeds the content duration");

    let endMsec: number | null = null;
    if (input.type === "loop") {
      if (input.endSeconds == null) throw new TypeError("Loop cues require endSeconds");
      endMsec = toMilliseconds(input.endSeconds, "Cue endSeconds");
      if (endMsec <= startMsec) throw new RangeError("Loop endSeconds must follow startSeconds");
      if (
        Number.isFinite(boundedDuration) &&
        boundedDuration > 0 &&
        endMsec > boundedDuration * 1_000
      )
        throw new RangeError("Cue endSeconds exceeds the content duration");
    } else {
      if (input.endSeconds != null) throw new TypeError("Point cues cannot have endSeconds");
      if (input.activeLoop) throw new TypeError("Only loop cues can be active loops");
    }

    const comment = input.comment ?? "";
    if (typeof comment !== "string") throw new TypeError("Cue comment must be a string");
    if (comment.length > 255) throw new RangeError("Cue comment cannot exceed 255 characters");
    const color = input.color ?? null;
    if (color != null && (!Number.isInteger(color) || color < 0 || color > 255))
      throw new RangeError("Cue color must be a Rekordbox color ID from 0 through 255 or null");
    const colorTableIndex = input.colorTableIndex ?? null;
    if (
      colorTableIndex != null &&
      (!Number.isInteger(colorTableIndex) || colorTableIndex < 0 || colorTableIndex > 62)
    )
      throw new RangeError("Cue colorTableIndex must be an integer from 0 through 62 or null");
    if (input.id !== undefined && (typeof input.id !== "string" || !input.id.length))
      throw new TypeError("Cue id must be a non-empty string when supplied");

    return {
      activeLoop: input.type === "loop" && (input.activeLoop ?? false),
      color,
      colorTableIndex,
      comment,
      endSeconds: endMsec == null ? null : endMsec / 1_000,
      id: input.id,
      kind: input.kind,
      slot: input.kind === "hot" ? input.slot : null,
      startSeconds: startMsec / 1_000,
      type: input.type,
    };
  }

  private applyContentCue(
    content: models.DjmdContent,
    input: NormalizedContentCueInput,
    row?: models.DjmdCue,
  ): models.DjmdCue {
    const startMsec = Math.round(input.startSeconds * 1_000);
    const endMsec = input.endSeconds == null ? -1 : Math.round(input.endSeconds * 1_000);
    const values: Record<string, models.DatabaseValue> = {
      ActiveLoop: Number(input.activeLoop),
      Color: input.color ?? (row?.get("Color") === null ? null : -1),
      ColorTableIndex: input.colorTableIndex ?? (row ? null : 0),
      Comment: input.comment,
      ContentID: content.ID,
      ContentUUID: content.UUID,
      InFrame: Math.floor((startMsec * 3) / 20),
      InMsec: startMsec,
      Kind: input.kind === "memory" ? 0 : input.slot!,
      OutMsec: endMsec,
    };
    if (!row) {
      return this.create(models.DjmdCue, {
        ...values,
        BeatLoopSize: 0,
        CueMicrosec: 0,
        ID: String(this.generateUnusedId(models.DjmdCue, { bits: 32 })),
        InMpegAbs: 0,
        InMpegFrame: 0,
        InPointSeekInfo: null,
        OutMpegAbs: 0,
        OutMpegFrame: 0,
        OutFrame: endMsec < 0 ? 0 : Math.floor((endMsec * 3) / 20),
        OutPointSeekInfo: null,
      });
    }
    const startChanged = Number(row.get("InMsec")) !== startMsec;
    const endChanged = Number(row.get("OutMsec") ?? -1) !== endMsec;
    if (startChanged || endChanged) {
      Object.assign(values, {
        BeatLoopSize: 0,
        CueMicrosec: 0,
        InMpegAbs: 0,
        InMpegFrame: 0,
        InPointSeekInfo: null,
        OutMpegAbs: 0,
        OutMpegFrame: 0,
        OutFrame: endMsec < 0 ? 0 : Math.floor((endMsec * 3) / 20),
        OutPointSeekInfo: null,
      });
    }
    for (const [key, value] of Object.entries(values)) row.set(key, value);
    if (this.hasColumn(row.tableName, "updated_at")) row.set("updated_at", new Date());
    return row;
  }

  private contentCueMirrorJson(
    rows: Array<models.DjmdCue>,
    existingJson?: models.DatabaseValue,
  ): string {
    const fields = [
      "ID",
      "ContentID",
      "InMsec",
      "InFrame",
      "InMpegFrame",
      "InMpegAbs",
      "OutMsec",
      "OutFrame",
      "OutMpegFrame",
      "OutMpegAbs",
      "Kind",
      "Color",
      "ColorTableIndex",
      "ActiveLoop",
      "Comment",
      "BeatLoopSize",
      "CueMicrosec",
      "InPointSeekInfo",
      "OutPointSeekInfo",
      "ContentUUID",
      "UUID",
      "created_at",
      "updated_at",
    ] as const;
    const existingById = new Map<string, Record<string, unknown>>();
    if (existingJson != null && existingJson !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(existingJson));
      } catch (error) {
        throw new TypeError("Existing contentCue.Cues JSON is malformed", { cause: error });
      }
      if (!Array.isArray(parsed)) throw new TypeError("Existing contentCue.Cues must be an array");
      for (const entry of parsed) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          throw new TypeError("Existing contentCue.Cues entries must be objects");
        const object = entry as Record<string, unknown>;
        const id = object.ID;
        if (typeof id !== "string" && typeof id !== "number")
          throw new TypeError("Existing contentCue.Cues entry is missing ID");
        const key = String(id);
        if (existingById.has(key))
          throw new TypeError(`Existing contentCue.Cues contains duplicate ID '${key}'`);
        existingById.set(key, object);
      }
    }
    return JSON.stringify(
      rows.map((row) => {
        const result = { ...existingById.get(String(row.ID)) };
        for (const field of fields) delete result[field];
        for (const field of fields) {
          const value = row.get(field);
          if (value == null || value === "") continue;
          result[field] =
            value instanceof Date ? value.toISOString().replace(/Z$/u, "+00:00") : value;
        }
        return result;
      }),
    );
  }

  private syncContentCueMirror(content: models.DjmdContent): void {
    if (!this.tableNames.includes(models.ContentCue.tableName)) return;
    if (!content.UUID) throw new TypeError(`Content '${content.ID}' has no UUID for contentCue`);
    const mirrors = this.query(models.ContentCue).where({ ContentID: content.ID }).all();
    const activeMirrors = mirrors.filter((row) => Number(row.get("rb_local_deleted") ?? 0) === 0);
    if (activeMirrors.length > 1)
      throw new Error(`Content '${content.ID}' has multiple active contentCue rows`);
    const mirror =
      activeMirrors[0] ?? mirrors.find((row) => String(row.get("ID")) === String(content.UUID));
    const cues = this.contentCueMirrorJson(this.activeContentCueRows(content), mirror?.get("Cues"));
    if (mirror) {
      mirror.set("Cues", cues);
      if (this.hasColumn(mirror.tableName, "rb_local_deleted")) mirror.set("rb_local_deleted", 0);
      if (this.hasColumn(mirror.tableName, "updated_at")) mirror.set("updated_at", new Date());
      return;
    }
    this.create(models.ContentCue, {
      ContentID: content.ID,
      Cues: cues,
      ID: content.UUID,
      rb_cue_count: null,
    });
  }

  private assertContentCueMirrorReadable(content: models.DjmdContent): void {
    if (!this.tableNames.includes(models.ContentCue.tableName)) return;
    const mirrors = this.query(models.ContentCue).where({ ContentID: content.ID }).all();
    const activeMirrors = mirrors.filter((row) => Number(row.get("rb_local_deleted") ?? 0) === 0);
    if (activeMirrors.length > 1)
      throw new Error(`Content '${content.ID}' has multiple active contentCue rows`);
    const mirror =
      activeMirrors[0] ?? mirrors.find((row) => String(row.get("ID")) === String(content.UUID));
    this.contentCueMirrorJson(this.activeContentCueRows(content), mirror?.get("Cues"));
  }

  private markContentCuesChanged(content: models.DjmdContent): void {
    if (this.hasColumn(content.tableName, "CueUpdated")) {
      const current = Number.parseInt(String(content.get("CueUpdated") ?? "0"), 10);
      content.set(
        "CueUpdated",
        String(Number.isSafeInteger(current) && current >= 0 ? current + 1 : 1),
      );
    }
    if (this.hasColumn(content.tableName, "updated_at")) content.set("updated_at", new Date());
    this.syncContentCueMirror(content);
  }

  /** Read active memory cues chronologically, followed by Hot Cues in slot order. */
  getContentCues(content: models.DjmdContent | string | number): Array<ContentCuePoint> {
    const contentRow = this.resolve(models.DjmdContent, content);
    this.assertActiveContent(contentRow);
    return this.sortContentCueRows(this.activeContentCueRows(contentRow)).map((cue) =>
      this.cueFromRow(cue),
    );
  }

  /**
   * Create or update one content cue without committing.
   *
   * An ID updates that owned cue. A Hot Cue without an ID updates its existing slot. A memory cue
   * without an ID creates a new row.
   */
  upsertContentCue(
    content: models.DjmdContent | string | number,
    input: ContentCueInput,
  ): ContentCuePoint {
    const contentRow = this.resolve(models.DjmdContent, content);
    this.assertActiveContent(contentRow);
    this.assertContentCueMirrorReadable(contentRow);
    const normalized = this.normalizeContentCueInput(contentRow, input);
    const existing = this.activeContentCueRows(contentRow);
    let row: models.DjmdCue | undefined;
    if (normalized.id) {
      row = existing.find((candidate) => String(candidate.ID) === normalized.id);
      if (!row)
        throw new TypeError(`Cue '${normalized.id}' does not belong to content '${contentRow.ID}'`);
    } else if (normalized.kind === "hot") {
      row = existing.find((candidate) => Number(candidate.Kind) === normalized.slot);
    }
    if (normalized.kind === "memory" && (!row || Number(row.Kind) !== 0)) {
      const memoryCount = existing.filter((candidate) => Number(candidate.Kind) === 0).length;
      if (memoryCount >= 10)
        throw new RangeError("A track cannot contain more than 10 memory cues");
    }
    if (normalized.kind === "hot") {
      const conflict = existing.find(
        (candidate) => Number(candidate.Kind) === normalized.slot && candidate.ID !== row?.ID,
      );
      if (conflict) throw new Error(`Hot Cue slot ${normalized.slot} is already occupied`);
    }
    const updated = this.applyContentCue(contentRow, normalized, row);
    this.markContentCuesChanged(contentRow);
    return this.cueFromRow(updated);
  }

  /** Delete one cue owned by the supplied content without committing. */
  deleteContentCue(
    content: models.DjmdContent | string | number,
    cue: models.DjmdCue | string | number,
  ): void {
    const contentRow = this.resolve(models.DjmdContent, content);
    this.assertActiveContent(contentRow);
    this.assertContentCueMirrorReadable(contentRow);
    const cueRow = this.resolve(models.DjmdCue, cue);
    if (String(cueRow.ContentID) !== String(contentRow.ID))
      throw new TypeError(`Cue '${cueRow.ID}' does not belong to content '${contentRow.ID}'`);
    if (Number(cueRow.get("rb_local_deleted") ?? 0) !== 0)
      throw new TypeError(`Cue '${cueRow.ID}' is deleted`);
    this.delete(cueRow);
    this.markContentCuesChanged(contentRow);
  }

  /**
   * Replace all cues owned by a content row without committing.
   *
   * Inputs are canonical: at most ten chronological memory cues first, then unique Hot Cues in
   * ascending slot order. IDs retain memory-cue row identity; Hot Cues also match by slot.
   */
  setContentCues(
    content: models.DjmdContent | string | number,
    inputs: ReadonlyArray<ContentCueInput>,
  ): Array<ContentCuePoint> {
    const contentRow = this.resolve(models.DjmdContent, content);
    this.assertActiveContent(contentRow);
    this.assertContentCueMirrorReadable(contentRow);
    const normalized = inputs.map((input) => this.normalizeContentCueInput(contentRow, input));
    const memory = normalized.filter((input) => input.kind === "memory");
    if (memory.length > 10) throw new RangeError("A track cannot contain more than 10 memory cues");
    let sawHotCue = false;
    let previousMemoryMsec = -1;
    let previousSlot = 0;
    const ids = new Set<string>();
    const slots = new Set<HotCueSlot>();
    for (const input of normalized) {
      if (input.id) {
        if (ids.has(input.id)) throw new Error(`Cue id '${input.id}' occurs more than once`);
        ids.add(input.id);
      }
      if (input.kind === "memory") {
        if (sawHotCue) throw new TypeError("Memory cues must precede Hot Cues");
        const msec = Math.round(input.startSeconds * 1_000);
        if (msec < previousMemoryMsec)
          throw new TypeError("Memory cues must be ordered chronologically");
        previousMemoryMsec = msec;
      } else {
        sawHotCue = true;
        if (slots.has(input.slot!))
          throw new Error(`Hot Cue slot ${input.slot} occurs more than once`);
        if (input.slot! < previousSlot) throw new TypeError("Hot Cues must be ordered by slot");
        slots.add(input.slot!);
        previousSlot = input.slot!;
      }
    }

    const existing = this.activeContentCueRows(contentRow);
    const byId = new Map(existing.map((cue) => [String(cue.ID), cue]));
    const used = new Set<models.DjmdCue>();
    const assignments: Array<models.DjmdCue | undefined> = [];
    for (const input of normalized) {
      let row: models.DjmdCue | undefined;
      if (input.id) {
        row = byId.get(input.id);
        if (!row)
          throw new TypeError(`Cue '${input.id}' does not belong to content '${contentRow.ID}'`);
      } else if (input.kind === "hot") {
        row = existing.find(
          (candidate) => Number(candidate.Kind) === input.slot && !used.has(candidate),
        );
      }
      if (row && used.has(row)) throw new Error(`Cue '${row.ID}' is assigned more than once`);
      if (row) used.add(row);
      assignments.push(row);
    }
    const updated = normalized.map((input, index) =>
      this.applyContentCue(contentRow, input, assignments[index]),
    );
    for (const cue of existing) if (!used.has(cue)) this.delete(cue);
    this.markContentCuesChanged(contentRow);
    return this.sortContentCueRows(updated).map((cue) => this.cueFromRow(cue));
  }
  getDevice(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdDevice, filters);
  }
  getGenre(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdGenre, filters);
  }
  getHistory(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdHistory, filters);
  }
  getHistorySongs(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdSongHistory, filters);
  }
  getHotCueBanklist(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdHotCueBanklist, filters);
  }
  getHotCueBanklistSongs(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdSongHotCueBanklist, filters);
  }
  getKey(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdKey, filters);
  }
  getLabel(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdLabel, filters);
  }
  getMenuItems(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdMenuItems, filters);
  }
  getMixerParam(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdMixerParam, filters);
  }
  getMyTag(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdMyTag, filters);
  }
  getMyTagSongs(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdSongMyTag, filters);
  }
  getPlaylist(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdPlaylist, filters);
  }
  getPlaylistSongs(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdSongPlaylist, filters);
  }
  getProperty(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdProperty, filters);
  }
  getRelatedTracks(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdRelatedTracks, filters);
  }
  getRelatedTracksSongs(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdSongRelatedTracks, filters);
  }
  getSampler(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdSampler, filters);
  }
  getSamplerSongs(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdSongSampler, filters);
  }
  getTagListSongs(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdSongTagList, filters);
  }
  getSort(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.DjmdSort, filters);
  }
  getAgentRegistry(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.AgentRegistry, filters);
  }
  getCloudAgentRegistry(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.CloudAgentRegistry, filters);
  }
  getContentActiveCensor(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.ContentActiveCensor, filters);
  }
  getContentCue(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.ContentCue, filters);
  }
  getContentFile(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.ContentFile, filters);
  }
  getHotCueBanklistCue(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.HotCueBanklistCue, filters);
  }
  getImageFile(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.ImageFile, filters);
  }
  getSettingFile(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.SettingFile, filters);
  }
  getUuidMap(filters: Record<string, models.DatabaseValue> = {}) {
    return this.lookup(models.UuidIDMap, filters);
  }

  /** Search content and joined descriptive tables case-insensitively. */
  searchContent(text: string): Array<models.DjmdContent> {
    if (this.tracked.size) this.flush();
    const pattern = `%${escapeLike(text)}%`;
    const sql = `SELECT DISTINCT c.* FROM "djmdContent" c
      LEFT JOIN "djmdArtist" ar ON ar."ID" = c."ArtistID"
      LEFT JOIN "djmdArtist" oa ON oa."ID" = c."OrgArtistID"
      LEFT JOIN "djmdArtist" co ON co."ID" = c."ComposerID"
      LEFT JOIN "djmdArtist" re ON re."ID" = c."RemixerID"
      LEFT JOIN "djmdAlbum" al ON al."ID" = c."AlbumID"
      LEFT JOIN "djmdGenre" ge ON ge."ID" = c."GenreID"
      LEFT JOIN "djmdKey" ke ON ke."ID" = c."KeyID"
      WHERE c."Title" LIKE ? ESCAPE '\\' OR c."Commnt" LIKE ? ESCAPE '\\'
        OR c."SearchStr" LIKE ? ESCAPE '\\' OR ar."Name" LIKE ? ESCAPE '\\'
        OR oa."Name" LIKE ? ESCAPE '\\' OR co."Name" LIKE ? ESCAPE '\\'
        OR re."Name" LIKE ? ESCAPE '\\' OR al."Name" LIKE ? ESCAPE '\\'
        OR ge."Name" LIKE ? ESCAPE '\\' OR ke."ScaleName" LIKE ? ESCAPE '\\'
      ORDER BY CAST(c."ID" AS INTEGER)`;
    const rows = this.requireConnection()
      .prepare(sql)
      .all(...Array(10).fill(pattern)) as Array<Record<string, unknown>>;
    return rows.map((row) => this.materialize(models.DjmdContent, row));
  }

  private compileSmartPlaylistSelection(
    playlist: Pick<models.DjmdPlaylist, "ID" | "Name" | "SmartList">,
  ): SmartPlaylistSelection {
    if (!playlist.SmartList) throw new TypeError("Smart playlist has no SmartList XML");
    const smartList = SmartList.fromXml(playlist.SmartList);
    const joins = new Map<string, string>();
    const expressions = new Map<SmartPlaylistProperty, string | null>();
    const contentTable = models.DjmdContent.tableName;

    const joinedName = (
      table: string,
      alias: string,
      foreignKey: string,
      nameColumn = "Name",
    ): string | null => {
      if (
        !this.hasColumn(contentTable, foreignKey) ||
        !this.hasTable(table) ||
        !this.hasColumn(table, "ID") ||
        !this.hasColumn(table, nameColumn)
      )
        return null;
      joins.set(
        alias,
        `LEFT JOIN ${quoteIdentifier(table)} ${quoteIdentifier(alias)} ON ${quoteIdentifier(alias)}."ID" = "c".${quoteIdentifier(foreignKey)}`,
      );
      return `${quoteIdentifier(alias)}.${quoteIdentifier(nameColumn)}`;
    };

    const expressionFor = (property: SmartPlaylistProperty): string | null => {
      if (expressions.has(property)) return expressions.get(property)!;
      let expression: string | null;
      switch (property) {
        case Property.ALBUM:
          expression = joinedName(models.DjmdAlbum.tableName, "al", "AlbumID");
          break;
        case Property.ALBUM_ARTIST: {
          const albumName = expressionFor(Property.ALBUM);
          if (
            !albumName ||
            !this.hasColumn(models.DjmdAlbum.tableName, "AlbumArtistID") ||
            !this.hasTable(models.DjmdArtist.tableName) ||
            !this.hasColumn(models.DjmdArtist.tableName, "ID") ||
            !this.hasColumn(models.DjmdArtist.tableName, "Name")
          ) {
            expression = null;
            break;
          }
          joins.set("aa", `LEFT JOIN "djmdArtist" "aa" ON "aa"."ID" = "al"."AlbumArtistID"`);
          expression = '"aa"."Name"';
          break;
        }
        case Property.ARTIST:
          expression = joinedName(models.DjmdArtist.tableName, "ar", "ArtistID");
          break;
        case Property.GENRE:
          expression = joinedName(models.DjmdGenre.tableName, "ge", "GenreID");
          break;
        case Property.KEY:
          expression = joinedName(models.DjmdKey.tableName, "ke", "KeyID", "ScaleName");
          break;
        case Property.LABEL:
          expression = joinedName(models.DjmdLabel.tableName, "la", "LabelID");
          break;
        case Property.ORIGINAL_ARTIST:
          expression = joinedName(models.DjmdArtist.tableName, "oa", "OrgArtistID");
          break;
        case Property.PRODUCER:
          expression = joinedName(models.DjmdArtist.tableName, "co", "ComposerID");
          break;
        case Property.REMIXED_BY:
          expression = joinedName(models.DjmdArtist.tableName, "re", "RemixerID");
          break;
        case Property.MIX_NAME:
        case Property.MYTAG:
          expression = null;
          break;
        default: {
          const column = propertyColumnMap[property];
          expression =
            column && this.hasColumn(contentTable, column)
              ? `"c".${quoteIdentifier(column)}`
              : null;
        }
      }
      expressions.set(property, expression);
      return expression;
    };

    const propertyExpressions: Partial<Record<SmartPlaylistProperty, string | null>> = {};
    for (const condition of smartList.conditions)
      propertyExpressions[condition.property] = expressionFor(condition.property);
    const compiled = smartList.compileSql({ propertyExpressions });
    if (compiled.unsupported.length) {
      const unsupported = [...new Set(compiled.unsupported)].join(", ");
      throw new TypeError(
        `Smart playlist '${playlist.Name}' (${playlist.ID}) uses unsupported criteria: ${unsupported}`,
      );
    }

    const artistExpression = expressionFor(Property.ARTIST) ?? "NULL";
    const keyExpression = expressionFor(Property.KEY) ?? "NULL";
    return {
      artistExpression,
      fromSql: `"djmdContent" "c"${joins.size ? ` ${[...joins.values()].join(" ")}` : ""}`,
      keyExpression,
      parameters: compiled.parameters,
      whereSql: compiled.sql,
    };
  }

  private activeRowPredicate(table: string, alias: string): string {
    return this.hasColumn(table, "rb_local_deleted")
      ? `(${quoteIdentifier(alias)}."rb_local_deleted" IS NULL OR ${quoteIdentifier(alias)}."rb_local_deleted" = 0)`
      : "1 = 1";
  }

  /** Return active content/playlist health with two aggregate queries and no row hydration. */
  getLibraryHealth(): LibraryHealth {
    const contentActive = this.activeRowPredicate(models.DjmdContent.tableName, "c");
    const playlistActive = this.activeRowPredicate(models.DjmdPlaylist.tableName, "p");
    const content = this.selectRawRows<{
      analyzed: number;
      missingBpm: number;
      missingKey: number;
      tracks: number;
    }>(
      `SELECT COUNT(*) AS tracks,
        COALESCE(SUM(CASE WHEN c."AnalysisDataPath" IS NOT NULL
          AND c."AnalysisDataPath" != '' AND COALESCE(c."Analysed", 0) > 0
          THEN 1 ELSE 0 END), 0) AS analyzed,
        COALESCE(SUM(CASE WHEN COALESCE(c."BPM", 0) <= 0 THEN 1 ELSE 0 END), 0)
          AS missingBpm,
        COALESCE(SUM(CASE WHEN c."KeyID" IS NULL OR c."KeyID" = ''
          THEN 1 ELSE 0 END), 0) AS missingKey
       FROM "djmdContent" c WHERE ${contentActive}`,
    )[0];
    const playlists = this.selectRawRows<{ attribute: number; count: number }>(
      `SELECT p."Attribute" AS attribute, COUNT(*) AS count FROM "djmdPlaylist" p
       WHERE ${playlistActive} AND p."Attribute" IN (?, ?, ?)
       GROUP BY p."Attribute"`,
      [
        models.PlaylistType.PLAYLIST,
        models.PlaylistType.FOLDER,
        models.PlaylistType.SMART_PLAYLIST,
      ],
    );
    const countByAttribute = new Map(
      playlists.map((row) => [Number(row.attribute), Number(row.count)]),
    );
    const tracks = Number(content?.tracks ?? 0);
    const analyzed = Number(content?.analyzed ?? 0);
    return {
      tracks,
      playlists:
        (countByAttribute.get(models.PlaylistType.PLAYLIST) ?? 0) +
        (countByAttribute.get(models.PlaylistType.SMART_PLAYLIST) ?? 0),
      folders: countByAttribute.get(models.PlaylistType.FOLDER) ?? 0,
      analyzed,
      missingAnalysis: tracks - analyzed,
      missingBpm: Number(content?.missingBpm ?? 0),
      missingKey: Number(content?.missingKey ?? 0),
    };
  }

  private resolveActivePlaylist(
    playlist: models.DjmdPlaylist | string | number,
  ): models.DjmdPlaylist {
    const id = String(
      playlist instanceof models.DatabaseRow ? (playlist as models.DjmdPlaylist).ID : playlist,
    );
    if (playlist instanceof models.DatabaseRow) {
      const row = playlist as models.DjmdPlaylist;
      const deleted = this.hasColumn(models.DjmdPlaylist.tableName, "rb_local_deleted")
        ? row.get("rb_local_deleted")
        : null;
      if (deleted == null || Number(deleted) === 0) return row;
    } else {
      const row = this.query(models.DjmdPlaylist)
        .where({ ID: id })
        .whereRaw(
          this.activeRowPredicate(models.DjmdPlaylist.tableName, models.DjmdPlaylist.tableName),
        )
        .oneOrNone();
      if (row) return row;
    }
    throw new RangeError(`Playlist '${id}' was not found or is deleted`);
  }

  /** Return every active folder, regular playlist, and smart playlist with direct track counts. */
  listPlaylists(): Array<PlaylistSummary> {
    type RawPlaylistSummary = {
      attribute: number | null;
      id: string | number;
      name: string | null;
      parentId: string | number | null;
      sequence: number | null;
      smartList: string | null;
      trackCount: number;
    };

    const playlistActive = this.activeRowPredicate(models.DjmdPlaylist.tableName, "p");
    const membershipActive = this.activeRowPredicate(models.DjmdSongPlaylist.tableName, "sp");
    const contentActive = this.activeRowPredicate(models.DjmdContent.tableName, "c");
    const rows = this.selectRawRows<RawPlaylistSummary>(
      `SELECT
        p."ID" AS "id",
        p."Name" AS "name",
        p."ParentID" AS "parentId",
        p."Seq" AS "sequence",
        p."Attribute" AS "attribute",
        p."SmartList" AS "smartList",
        COUNT(c."ID") AS "trackCount"
      FROM "djmdPlaylist" p
      LEFT JOIN "djmdSongPlaylist" sp
        ON sp."PlaylistID" = p."ID" AND ${membershipActive}
      LEFT JOIN "djmdContent" c
        ON c."ID" = sp."ContentID" AND ${contentActive}
      WHERE ${playlistActive} AND p."Attribute" IN (?, ?, ?)
      GROUP BY p."ID", p."Name", p."ParentID", p."Seq", p."Attribute", p."SmartList"
      ORDER BY p."ParentID", p."Seq", p."Name" COLLATE NOCASE,
        CAST(p."ID" AS INTEGER), p."ID"`,
      [
        models.PlaylistType.PLAYLIST,
        models.PlaylistType.FOLDER,
        models.PlaylistType.SMART_PLAYLIST,
      ],
    );

    return rows.map((row) => {
      const attribute = Number(row.attribute);
      const type =
        attribute === models.PlaylistType.FOLDER
          ? ("folder" as const)
          : attribute === models.PlaylistType.SMART_PLAYLIST
            ? ("smart" as const)
            : ("playlist" as const);
      let trackCount = type === "folder" ? null : Number(row.trackCount);
      let countError: string | undefined;
      if (type === "smart") {
        try {
          const selection = this.compileSmartPlaylistSelection({
            ID: String(row.id),
            Name: row.name ?? "",
            SmartList: row.smartList,
          });
          trackCount = this.countRows(
            `SELECT COUNT(*) AS count FROM ${selection.fromSql}
              WHERE (${selection.whereSql}) AND ${contentActive}`,
            selection.parameters,
          );
        } catch (error) {
          trackCount = null;
          countError = error instanceof Error ? error.message : String(error);
        }
      }
      return {
        id: String(row.id),
        name: row.name ?? "",
        parentId: row.parentId == null ? "root" : String(row.parentId),
        sequence: row.sequence == null ? 0 : Number(row.sequence),
        trackCount,
        type,
        ...(countError === undefined ? {} : { countError }),
      };
    });
  }

  /** Return content rows selected by a regular or smart playlist. */
  getPlaylistContents(playlist: models.DjmdPlaylist | string | number): Query<models.DjmdContent> {
    const row = this.resolveActivePlaylist(playlist);
    if (Number(row.Attribute) === models.PlaylistType.FOLDER)
      throw new TypeError("Playlist is a folder");
    const contentActive = this.activeRowPredicate(
      models.DjmdContent.tableName,
      models.DjmdContent.tableName,
    );
    if (Number(row.Attribute) === models.PlaylistType.SMART_PLAYLIST) {
      const selection = this.compileSmartPlaylistSelection(row);
      const selectedContentActive = this.activeRowPredicate(models.DjmdContent.tableName, "c");
      return this.query(models.DjmdContent)
        .whereRaw(contentActive)
        .whereRaw(
          `"ID" IN (SELECT "c"."ID" FROM ${selection.fromSql}
            WHERE (${selection.whereSql}) AND ${selectedContentActive})`,
          selection.parameters,
        );
    }
    const membershipActive = this.activeRowPredicate(models.DjmdSongPlaylist.tableName, "sp");
    return this.query(models.DjmdContent)
      .whereRaw(contentActive)
      .whereRaw(
        `"ID" IN (SELECT sp."ContentID" FROM "djmdSongPlaylist" sp
          WHERE sp."PlaylistID" = ? AND ${membershipActive})`,
        [row.ID],
      );
  }

  /** Count track rows selected by a regular or smart playlist. */
  countPlaylistTracks(playlist: models.DjmdPlaylist | string | number): number {
    const row = this.resolveActivePlaylist(playlist);
    if (Number(row.Attribute) === models.PlaylistType.FOLDER)
      throw new TypeError("Playlist is a folder");
    const contentActive = this.activeRowPredicate(models.DjmdContent.tableName, "c");
    if (Number(row.Attribute) === models.PlaylistType.SMART_PLAYLIST) {
      const selection = this.compileSmartPlaylistSelection(row);
      return this.countRows(
        `SELECT COUNT(*) AS count FROM ${selection.fromSql}
          WHERE (${selection.whereSql}) AND ${contentActive}`,
        selection.parameters,
      );
    }
    const membershipActive = this.activeRowPredicate(models.DjmdSongPlaylist.tableName, "sp");
    return this.countRows(
      `SELECT COUNT(*) AS count
        FROM "djmdSongPlaylist" sp
        JOIN "djmdContent" c ON c."ID" = sp."ContentID"
        WHERE sp."PlaylistID" = ? AND ${membershipActive} AND ${contentActive}`,
      [row.ID],
    );
  }

  /** Return ordered playlist memberships with joined artist, key, and track metadata. */
  getPlaylistTracks(
    playlist: models.DjmdPlaylist | string | number,
    options: PlaylistTrackOptions = {},
  ): Array<PlaylistTrack> {
    const limit = options.limit;
    const offset = options.offset ?? 0;
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
      throw new RangeError("Playlist track limit must be a positive integer");
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new RangeError("Playlist track offset must be a non-negative integer");

    const playlistRow = this.resolveActivePlaylist(playlist);
    if (Number(playlistRow.Attribute) === models.PlaylistType.FOLDER)
      throw new TypeError("Playlist is a folder");
    if (this.tracked.size && !this.autoflushDisabled) this.flush();

    type RawPlaylistTrack = {
      analyzed: number | null;
      artist: string | null;
      bpmHundredths: number | null;
      contentId: string | number;
      durationSeconds: number | null;
      fileType: number | null;
      key: string | null;
      membershipId?: string | number | null;
      path: string | null;
      position?: number | null;
      title: string | null;
    };

    const mapRows = (rows: Array<RawPlaylistTrack>): Array<PlaylistTrack> =>
      rows.map((row, index) => ({
        analyzed: row.analyzed === null ? null : Number(row.analyzed),
        artist: row.artist,
        bpm: row.bpmHundredths === null ? null : Number(row.bpmHundredths) / 100,
        contentId: String(row.contentId),
        durationSeconds: row.durationSeconds === null ? null : Number(row.durationSeconds),
        fileType: row.fileType === null ? null : Number(row.fileType),
        key: row.key,
        membershipId: row.membershipId == null ? null : String(row.membershipId),
        path: row.path,
        position: row.position == null ? offset + index + 1 : Number(row.position),
        title: row.title,
      }));

    if (Number(playlistRow.Attribute) === models.PlaylistType.SMART_PLAYLIST) {
      const selection = this.compileSmartPlaylistSelection(playlistRow);
      const contentActive = this.activeRowPredicate(models.DjmdContent.tableName, "c");
      const pagination =
        limit === undefined ? (offset ? " LIMIT -1 OFFSET ?" : "") : " LIMIT ? OFFSET ?";
      const paginationParameters = limit === undefined ? (offset ? [offset] : []) : [limit, offset];
      const rows = this.requireConnection()
        .prepare(
          `SELECT
            "c"."ID" AS "contentId",
            ${selection.artistExpression} AS "artist",
            "c"."Title" AS "title",
            "c"."BPM" AS "bpmHundredths",
            ${selection.keyExpression} AS "key",
            "c"."Length" AS "durationSeconds",
            "c"."FileType" AS "fileType",
            "c"."Analysed" AS "analyzed",
            "c"."FolderPath" AS "path",
            NULL AS "membershipId",
            NULL AS "position"
          FROM ${selection.fromSql}
          WHERE (${selection.whereSql}) AND ${contentActive}
          ORDER BY CAST("c"."ID" AS INTEGER), "c"."ID"${pagination}`,
        )
        .all(...selection.parameters, ...paginationParameters) as Array<RawPlaylistTrack>;
      return mapRows(rows);
    }

    const select = `SELECT
      c."ID" AS "contentId",
      ar."Name" AS "artist",
      c."Title" AS "title",
      c."BPM" AS "bpmHundredths",
      ke."ScaleName" AS "key",
      c."Length" AS "durationSeconds",
      c."FileType" AS "fileType",
      c."Analysed" AS "analyzed",
      c."FolderPath" AS "path"`;
    const pagination =
      limit === undefined ? (offset ? " LIMIT -1 OFFSET ?" : "") : " LIMIT ? OFFSET ?";
    const paginationParameters = limit === undefined ? (offset ? [offset] : []) : [limit, offset];
    const membershipActive = this.activeRowPredicate(models.DjmdSongPlaylist.tableName, "sp");
    const contentActive = this.activeRowPredicate(models.DjmdContent.tableName, "c");

    const rows = this.requireConnection()
      .prepare(
        `${select}, sp."ID" AS "membershipId", sp."TrackNo" AS "position"
          FROM "djmdSongPlaylist" sp
          JOIN "djmdContent" c ON c."ID" = sp."ContentID"
          LEFT JOIN "djmdArtist" ar ON ar."ID" = c."ArtistID"
          LEFT JOIN "djmdKey" ke ON ke."ID" = c."KeyID"
          WHERE sp."PlaylistID" = ? AND ${membershipActive} AND ${contentActive}
          ORDER BY sp."TrackNo", CAST(sp."ID" AS INTEGER), sp."ID"${pagination}`,
      )
      .all(playlistRow.ID, ...paginationParameters) as Array<RawPlaylistTrack>;
    return mapRows(rows);
  }

  /** Generate an unused random numeric ID. */
  generateUnusedId(
    model: models.ModelClass,
    options: { bits?: 28 | 32; field?: string } = {},
  ): number {
    const bits = options.bits ?? 28;
    if (bits !== 28 && bits !== 32) throw new RangeError("ID width must be 28 or 32 bits");
    const field = options.field ?? "ID";
    for (let attempt = 0; attempt < 1_000_000; attempt++) {
      const value = randomBytes(4).readUInt32BE(0) >>> (32 - bits);
      if (value < 100) continue;
      if (
        this.query(model)
          .where({ [field]: String(value) })
          .count() === 0
      )
        return value;
    }
    throw new Error("Could not generate an unused ID");
  }

  private resolve<row extends models.DatabaseRow>(
    model: models.ModelClass<row>,
    value: row | string | number,
  ): row {
    return value instanceof models.DatabaseRow
      ? value
      : this.query(model)
          .where({ ID: String(value) })
          .one();
  }

  /** Add a content row to a normal playlist. */
  addToPlaylist(
    playlist: models.DjmdPlaylist | string | number,
    content: models.DjmdContent | string | number,
    trackNumber?: number,
  ): models.DjmdSongPlaylist {
    const parent = this.resolve(models.DjmdPlaylist, playlist);
    const track = this.resolve(models.DjmdContent, content);
    if (parent.Attribute !== models.PlaylistType.PLAYLIST)
      throw new TypeError("Playlist must be normal");
    const songs = this.query(models.DjmdSongPlaylist)
      .where({ PlaylistID: parent.ID })
      .orderBy("TrackNo")
      .all();
    const target = trackNumber ?? songs.length + 1;
    if (!Number.isInteger(target) || target < 1 || target > songs.length + 1)
      throw new RangeError("Track number is out of range");
    for (const song of songs) if (song.TrackNo >= target) song.TrackNo += 1;
    return this.create(models.DjmdSongPlaylist, {
      ContentID: track.ID,
      ID: randomUUID(),
      PlaylistID: parent.ID,
      TrackNo: target,
      UUID: randomUUID(),
    });
  }

  /** Remove one playlist membership and close its sequence gap. */
  removeFromPlaylist(
    playlist: models.DjmdPlaylist | string | number,
    song: models.DjmdSongPlaylist | string | number,
  ): void {
    const parent = this.resolve(models.DjmdPlaylist, playlist);
    const membership = this.resolve(models.DjmdSongPlaylist, song);
    if (membership.PlaylistID !== parent.ID)
      throw new TypeError("Song is not in the supplied playlist");
    const old = membership.TrackNo;
    this.delete(membership);
    for (const other of this.query(models.DjmdSongPlaylist).where({ PlaylistID: parent.ID }).all())
      if (other.TrackNo > old) other.TrackNo -= 1;
  }

  /** Move one playlist membership and renumber intervening songs. */
  moveSongInPlaylist(
    playlist: models.DjmdPlaylist | string | number,
    song: models.DjmdSongPlaylist | string | number,
    newTrackNumber: number,
  ): void {
    const parent = this.resolve(models.DjmdPlaylist, playlist);
    const membership = this.resolve(models.DjmdSongPlaylist, song);
    const songs = this.query(models.DjmdSongPlaylist).where({ PlaylistID: parent.ID }).all();
    if (membership.PlaylistID !== parent.ID)
      throw new TypeError("Song is not in the supplied playlist");
    if (!Number.isInteger(newTrackNumber) || newTrackNumber < 1 || newTrackNumber > songs.length)
      throw new RangeError("Track number is out of range");
    const old = membership.TrackNo;
    if (newTrackNumber === old) return;
    for (const other of songs) {
      if (other.ID === membership.ID) continue;
      if (newTrackNumber > old && other.TrackNo > old && other.TrackNo <= newTrackNumber)
        other.TrackNo -= 1;
      if (newTrackNumber < old && other.TrackNo >= newTrackNumber && other.TrackNo < old)
        other.TrackNo += 1;
    }
    membership.TrackNo = newTrackNumber;
  }

  private createPlaylistRow(
    name: string,
    attribute: models.PlaylistType,
    options: {
      imagePath?: string;
      parent?: models.DjmdPlaylist | string | number;
      seq?: number;
      smartList?: SmartList;
      uuid?: string;
    } = {},
  ): models.DjmdPlaylist {
    const parentId = options.parent ? this.resolve(models.DjmdPlaylist, options.parent).ID : "root";
    if (
      options.parent &&
      this.resolve(models.DjmdPlaylist, options.parent).Attribute !== models.PlaylistType.FOLDER
    )
      throw new TypeError("Parent is not a folder");
    const siblings = this.query(models.DjmdPlaylist)
      .where({ ParentID: parentId })
      .orderBy("Seq")
      .all();
    const seq = options.seq ?? siblings.length + 1;
    if (!Number.isInteger(seq) || seq < 1 || seq > siblings.length + 1)
      throw new RangeError("Playlist sequence is out of range");
    for (const sibling of siblings) if (sibling.Seq >= seq) sibling.Seq += 1;
    const id = String(this.generateUnusedId(models.DjmdPlaylist));
    if (options.smartList) options.smartList.playlistId = id;
    return this.create(models.DjmdPlaylist, {
      Attribute: attribute,
      ID: id,
      ImagePath: options.imagePath ?? null,
      Name: name,
      ParentID: parentId,
      Seq: seq,
      SmartList: options.smartList?.toXml() ?? null,
      UUID: options.uuid ?? randomUUID(),
    });
  }

  /** Create a normal playlist. */
  createPlaylist(
    name: string,
    options: {
      imagePath?: string;
      parent?: models.DjmdPlaylist | string | number;
      seq?: number;
      uuid?: string;
    } = {},
  ) {
    return this.createPlaylistRow(name, models.PlaylistType.PLAYLIST, options);
  }
  /** Create a playlist folder. */
  createPlaylistFolder(
    name: string,
    options: {
      imagePath?: string;
      parent?: models.DjmdPlaylist | string | number;
      seq?: number;
    } = {},
  ) {
    return this.createPlaylistRow(name, models.PlaylistType.FOLDER, options);
  }
  /** Create a smart playlist. */
  createSmartPlaylist(
    name: string,
    smartList: SmartList,
    options: {
      imagePath?: string;
      parent?: models.DjmdPlaylist | string | number;
      seq?: number;
    } = {},
  ) {
    return this.createPlaylistRow(name, models.PlaylistType.SMART_PLAYLIST, {
      ...options,
      smartList,
    });
  }

  /** Rename a playlist or folder. */
  renamePlaylist(playlist: models.DjmdPlaylist | string | number, name: string): void {
    const row = this.resolve(models.DjmdPlaylist, playlist);
    row.Name = name;
    if (this.hasColumn(row.tableName, "updated_at")) row.set("updated_at", new Date());
  }

  /** Move a playlist within its parent or into another folder. */
  movePlaylist(
    playlist: models.DjmdPlaylist | string | number,
    options: { parent?: models.DjmdPlaylist | string | number; seq?: number },
  ): void {
    if (options.parent === undefined && options.seq === undefined)
      throw new TypeError("Either parent or seq is required");
    const row = this.resolve(models.DjmdPlaylist, playlist);
    const oldParent = row.ParentID;
    const oldSeq = row.Seq;
    const newParent = options.parent
      ? this.resolve(models.DjmdPlaylist, options.parent)
      : undefined;
    if (newParent && newParent.Attribute !== models.PlaylistType.FOLDER)
      throw new TypeError("Parent is not a folder");
    if (newParent) {
      const visited = new Set<string>();
      let ancestor: models.DjmdPlaylist | undefined = newParent;
      while (ancestor) {
        const id = String(ancestor.ID);
        if (id === String(row.ID))
          throw new TypeError("Cannot move a playlist into itself or one of its descendants");
        if (visited.has(id)) throw new Error("Existing playlist hierarchy contains a cycle");
        visited.add(id);
        const parentId: models.DatabaseValue | undefined = ancestor.get("ParentID");
        ancestor =
          parentId == null || parentId === "root"
            ? undefined
            : this.query(models.DjmdPlaylist).where({ ID: parentId }).oneOrNone();
      }
    }
    const parentId = newParent?.ID ?? oldParent;
    const siblings = this.query(models.DjmdPlaylist)
      .where({ ParentID: parentId })
      .orderBy("Seq")
      .all()
      .filter((sibling) => sibling.ID !== row.ID);
    const target = options.seq ?? siblings.length + 1;
    if (!Number.isInteger(target) || target < 1 || target > siblings.length + 1)
      throw new RangeError("Playlist sequence is out of range");

    if (parentId !== oldParent) {
      for (const sibling of this.query(models.DjmdPlaylist).where({ ParentID: oldParent }).all())
        if (sibling.ID !== row.ID && sibling.Seq > oldSeq) sibling.Seq -= 1;
      for (const sibling of siblings) if (sibling.Seq >= target) sibling.Seq += 1;
      row.ParentID = parentId;
    } else if (target > oldSeq) {
      for (const sibling of siblings)
        if (sibling.Seq > oldSeq && sibling.Seq <= target) sibling.Seq -= 1;
    } else if (target < oldSeq) {
      for (const sibling of siblings)
        if (sibling.Seq >= target && sibling.Seq < oldSeq) sibling.Seq += 1;
    }
    row.Seq = target;
    if (this.hasColumn(row.tableName, "updated_at")) row.set("updated_at", new Date());
  }

  /** Delete a playlist subtree and resequence remaining siblings. */
  deletePlaylist(playlist: models.DjmdPlaylist | string | number): void {
    const row = this.resolve(models.DjmdPlaylist, playlist);
    this.delete(row);
    for (const sibling of this.query(models.DjmdPlaylist).where({ ParentID: row.ParentID }).all())
      if (sibling.Seq > row.Seq) sibling.Seq -= 1;
  }

  private addNamed<row extends models.DatabaseRow>(
    model: models.ModelClass<row>,
    name: string,
    extra: Record<string, models.DatabaseValue> = {},
  ): row {
    if (this.query(model).where({ Name: name }).count())
      throw new Error(`${model.name} '${name}' already exists`);
    return this.create(model, {
      ID: String(this.generateUnusedId(model)),
      Name: name,
      UUID: randomUUID(),
      ...extra,
    });
  }

  /** Add a unique artist. */
  addArtist(name: string, searchString: string | null = null) {
    return this.addNamed(models.DjmdArtist, name, { SearchStr: searchString });
  }
  /** Add a unique genre. */
  addGenre(name: string) {
    return this.addNamed(models.DjmdGenre, name);
  }
  /** Add a unique label. */
  addLabel(name: string) {
    return this.addNamed(models.DjmdLabel, name);
  }
  /** Add an album unique by name and album artist. */
  addAlbum(
    name: string,
    options: {
      artist?: models.DjmdArtist | string | number;
      compilation?: boolean;
      imagePath?: string;
      searchString?: string;
    } = {},
  ) {
    const artistId = options.artist
      ? this.resolve(models.DjmdArtist, options.artist).get("ID")!
      : null;
    if (this.query(models.DjmdAlbum).where({ Name: name, AlbumArtistID: artistId }).count())
      throw new Error(`DjmdAlbum '${name}' already exists for album artist '${String(artistId)}'`);
    return this.create(models.DjmdAlbum, {
      ID: String(this.generateUnusedId(models.DjmdAlbum)),
      Name: name,
      UUID: randomUUID(),
      AlbumArtistID: artistId,
      Compilation: options.compilation == null ? null : Number(options.compilation),
      ImagePath: options.imagePath ?? null,
      SearchStr: options.searchString ?? null,
    });
  }

  /** Add a minimally populated content row for an existing audio file. */
  addContent(path: string, values: Record<string, models.DatabaseValue> = {}): models.DjmdContent {
    if (!existsSync(path) || !statSync(path).isFile())
      throw new TypeError(`Audio file '${path}' does not exist`);
    if (this.query(models.DjmdContent).where({ FolderPath: path }).count())
      throw new Error(`Track with path '${path}' already exists`);
    const extension = extname(path).slice(1).toUpperCase() as keyof typeof models.FileType;
    const fileType = models.FileType[extension];
    if (!fileType)
      throw new TypeError(`Unsupported content file type '.${extension.toLowerCase()}'`);
    const id = String(this.generateUnusedId(models.DjmdContent));
    const device = this.query(models.DjmdDevice).first();
    const today = new Date().toISOString().slice(0, 10);
    return this.create(models.DjmdContent, {
      DateCreated: today,
      DeviceID: device?.get("ID") ?? null,
      FileNameL: basename(path),
      FileSize: statSync(path).size,
      FileType: fileType,
      FolderPath: path,
      HotCueAutoLoad: "on",
      ID: id,
      MasterDBID: device?.get("MasterDBID") ?? null,
      MasterSongID: id,
      StockDate: today,
      UUID: randomUUID(),
      rb_file_id: String(this.generateUnusedId(models.DjmdContent, { field: "rb_file_id" })),
      ...values,
    });
  }

  /** Resolve the directory containing a content row's ANLZ files. */
  getAnlzDirectory(content: models.DjmdContent | string | number): string {
    const row = this.resolve(models.DjmdContent, content);
    if (!row.AnalysisDataPath) throw new TypeError(`Content '${row.ID}' has no AnalysisDataPath`);
    const relative = row.AnalysisDataPath.replace(/^[/\\]+/u, "").replaceAll("\\", "/");
    return join(this.shareDirectory, dirname(relative));
  }

  /** Find a content row's DAT, EXT, and 2EX files. */
  getContentAnlzPaths(content: models.DjmdContent | string | number) {
    return findAnlzPaths(this.getAnlzDirectory(content));
  }

  /** Read all ANLZ files for a content row. */
  readContentAnlzFiles(content: models.DjmdContent | string | number) {
    return readAnlzFilesInDirectory(this.getAnlzDirectory(content));
  }

  /** Read one ANLZ file for a content row. */
  readContentAnlzFile(content: models.DjmdContent | string | number, type: "2EX" | "DAT" | "EXT") {
    const path = this.getContentAnlzPaths(content)[type];
    return path ? AnlzFile.parseFile(path) : undefined;
  }

  /** Compatibility alias for {@link getAnlzDirectory}. */
  getAnlzDir(content: models.DjmdContent | string | number): string {
    return this.getAnlzDirectory(content);
  }

  /** Compatibility alias for {@link getContentAnlzPaths}. */
  getAnlzPaths(content: models.DjmdContent | string | number) {
    return this.getContentAnlzPaths(content);
  }

  /** Compatibility alias for {@link readContentAnlzFiles}. */
  readAnlzFiles(content: models.DjmdContent | string | number) {
    return this.readContentAnlzFiles(content);
  }

  /** Return one ANLZ path for a content row. */
  getAnlzPath(
    content: models.DjmdContent | string | number,
    type: "2EX" | "DAT" | "EX2" | "EXT",
  ): string | undefined {
    const normalized = type === "EX2" ? "2EX" : type;
    return this.getContentAnlzPaths(content)[normalized];
  }

  /** Compatibility alias for {@link readContentAnlzFile}. */
  readAnlzFile(
    content: models.DjmdContent | string | number,
    type: "2EX" | "DAT" | "EX2" | "EXT",
  ): AnlzFile | undefined {
    const normalized = type === "EX2" ? "2EX" : type;
    return this.readContentAnlzFile(content, normalized);
  }

  /** Install validated analyzer artifacts and mark a content row analyzed. */
  installContentAnalysis(
    content: models.DjmdContent | string | number,
    analysisDirectory: string,
    options: { commit?: boolean; replace?: boolean } = {},
  ): InstallContentAnalysisResult {
    this.assertCommitAllowed();
    const row = this.resolve(models.DjmdContent, content);
    if (!row.FolderPath) throw new TypeError(`Content '${row.ID}' has no FolderPath`);
    if (!row.UUID) throw new TypeError(`Content '${row.ID}' has no UUID`);
    const metadata = this.prepareContentAnalysisMetadata(row, analysisDirectory);
    const sourcePaths = findAnlzPaths(analysisDirectory);
    for (const type of ["DAT", "EXT", "2EX"] as const)
      if (!sourcePaths[type]) throw new TypeError(`Analysis directory has no ANLZ0000.${type}`);

    const uuid = row.UUID;
    if (uuid.length < 4) throw new TypeError(`Content '${row.ID}' has invalid UUID '${row.UUID}'`);
    const relativeDirectory = join("PIONEER", "USBANLZ", uuid.slice(0, 3), uuid.slice(3));
    const directory = join(this.shareDirectory, relativeDirectory);
    const paths = {
      "2EX": join(directory, "ANLZ0000.2EX"),
      DAT: join(directory, "ANLZ0000.DAT"),
      EXT: join(directory, "ANLZ0000.EXT"),
    };
    if (!options.replace)
      for (const path of Object.values(paths))
        if (existsSync(path)) throw new Error(`Analysis file '${path}' already exists`);

    mkdirSync(directory, { recursive: true });
    const temporaryPaths: Array<string> = [];
    const temporaryPath = (path: string) =>
      join(dirname(path), `.${basename(path, extname(path))}.${process.pid}${extname(path)}`);
    try {
      for (const type of ["DAT", "EXT", "2EX"] as const) {
        const file = AnlzFile.parseFile(sourcePaths[type]!);
        file.setPath(row.FolderPath.replaceAll("\\", "/"));
        const temporary = temporaryPath(paths[type]);
        file.save(temporary);
        AnlzFile.parseFile(temporary);
        temporaryPaths.push(temporary);
      }
      for (const type of ["DAT", "EXT", "2EX"] as const)
        renameSync(temporaryPath(paths[type]), paths[type]);
    } catch (error) {
      for (const path of temporaryPaths) rmSync(path, { force: true });
      throw error;
    }

    const analysisDataPath = `/${join(relativeDirectory, "ANLZ0000.DAT").replaceAll("\\", "/")}`;
    row.AnalysisDataPath = analysisDataPath;
    this.applyContentAnalysisMetadata(row, metadata);
    if (this.hasColumn(row.tableName, "Analysed")) row.set("Analysed", 105);
    if (this.hasColumn(row.tableName, "AnalysisUpdated")) row.set("AnalysisUpdated", "2");
    if (this.hasColumn(row.tableName, "TrackInfoUpdated")) row.set("TrackInfoUpdated", "2");
    if (options.commit ?? true) this.commit();
    return { analysisDataPath, contentId: row.ID, directory, paths, ...metadata };
  }

  /** Synchronize BPM and key from an existing analyzer summary without recopying ANLZ files. */
  syncContentAnalysisMetadata(
    content: models.DjmdContent | string | number,
    analysisDirectory: string,
    options: { commit?: boolean } = {},
  ): SyncContentAnalysisMetadataResult {
    this.assertCommitAllowed();
    const row = this.resolve(models.DjmdContent, content);
    const metadata = this.prepareContentAnalysisMetadata(row, analysisDirectory);
    this.applyContentAnalysisMetadata(row, metadata);
    if (this.hasColumn(row.tableName, "AnalysisUpdated")) row.set("AnalysisUpdated", "2");
    if (this.hasColumn(row.tableName, "TrackInfoUpdated")) row.set("TrackInfoUpdated", "2");
    if (options.commit ?? true) this.commit();
    return { contentId: row.ID, ...metadata };
  }

  private prepareContentAnalysisMetadata(
    row: models.DjmdContent,
    analysisDirectory: string,
  ): Omit<SyncContentAnalysisMetadataResult, "contentId"> {
    if (!row.FolderPath) throw new TypeError(`Content '${row.ID}' has no FolderPath`);
    if (!existsSync(row.FolderPath) || !statSync(row.FolderPath).isFile())
      throw new TypeError(`Content '${row.ID}' audio file '${row.FolderPath}' does not exist`);

    const summaryPath = join(analysisDirectory, "analysis.json");
    const analysis = readAnalysisResult(summaryPath);
    const contentPath = realpathSync(row.FolderPath);
    let sourcePath: string;
    let audioPath: string;
    try {
      sourcePath = realpathSync(analysis.source.path);
      audioPath = realpathSync(analysis.audioPath);
    } catch (cause) {
      throw new TypeError(
        `Analysis summary '${summaryPath}' references an unavailable source file`,
        { cause },
      );
    }
    if (sourcePath !== contentPath || audioPath !== contentPath)
      throw new TypeError(
        `Analysis summary '${summaryPath}' does not belong to content '${row.ID}' at '${row.FolderPath}'`,
      );
    const source = statSync(contentPath);
    if (analysis.source.size !== source.size || analysis.source.mtimeMs !== source.mtimeMs)
      throw new TypeError(
        `Analysis summary '${summaryPath}' source fingerprint does not match content '${row.ID}'`,
      );

    const tempoBpm = analysis.summary.tempo_bpm;
    const bpmHundredths = tempoBpm === null ? null : Math.round(tempoBpm * 100);
    if (bpmHundredths !== null && !Number.isSafeInteger(bpmHundredths))
      throw new TypeError(`Analysis summary '${summaryPath}' has an unsafe BPM value`);

    const analyzedKey = analysis.summary.key;
    let keyId: string | null = null;
    let keyName: string | null = null;
    if (analyzedKey !== null) {
      try {
        keyName = normalizeRekordboxKeyName(analyzedKey);
      } catch (cause) {
        throw new TypeError(
          `Analysis summary '${summaryPath}' has unsupported key '${analyzedKey}'`,
          { cause },
        );
      }
      const equivalentKeys = this.query(models.DjmdKey)
        .all()
        .filter(
          (key) =>
            key.ScaleName != null &&
            normalizeMusicalKey(key.ScaleName) !== undefined &&
            normalizeRekordboxKeyName(key.ScaleName) === keyName &&
            (!this.hasColumn(models.DjmdKey.tableName, "rb_local_deleted") ||
              Number(key.get("rb_local_deleted") ?? 0) === 0),
        );
      const canonicalKeys = equivalentKeys.filter(
        (key) => key.ScaleName?.trim().toUpperCase() === keyName,
      );
      const keys = canonicalKeys.length ? canonicalKeys : equivalentKeys;
      // Fresh libraries may not yet contain every musical key. Stage the missing
      // lookup through the same tracked transaction as the analyzed content row.
      if (keys.length === 0)
        keys.push(
          this.create(models.DjmdKey, {
            ID: String(this.generateUnusedId(models.DjmdKey)),
            ScaleName: keyName,
          }),
        );
      if (keys.length !== 1)
        throw new TypeError(
          `Expected exactly one djmdKey row for '${keyName}' (${analyzedKey}); found ${keys.length}`,
        );
      keyId = keys[0]!.ID;
    }
    return { bpmHundredths, keyId, keyName, tempoBpm };
  }

  private applyContentAnalysisMetadata(
    row: models.DjmdContent,
    metadata: Omit<SyncContentAnalysisMetadataResult, "contentId">,
  ): void {
    if (metadata.bpmHundredths !== null) {
      if (!this.hasColumn(row.tableName, "BPM"))
        throw new TypeError(`Content table '${row.tableName}' has no BPM column`);
      row.set("BPM", metadata.bpmHundredths);
    }
    if (metadata.keyId !== null) {
      if (!this.hasColumn(row.tableName, "KeyID"))
        throw new TypeError(`Content table '${row.tableName}' has no KeyID column`);
      row.set("KeyID", metadata.keyId);
    }
  }

  /** Paths referenced by the `settingFile` table. */
  getMySettingPaths(): Array<string> {
    if (!this.hasTable("settingFile")) return [];
    return this.query(models.SettingFile)
      .all()
      .map((row) => join(this.dbDirectory, String(row.get("Path") ?? "").replace(/^[/\\]+/u, "")));
  }

  /** Update a content path and every existing ANLZ PPTH tag. */
  updateContentPath(
    content: models.DjmdContent | string | number,
    path: string,
    options: {
      checkPath?: boolean;
      commit?: boolean;
      saveAnlz?: boolean;
    } = {},
  ): void {
    const row = this.resolve(models.DjmdContent, content);
    if ((options.commit ?? true) || (options.saveAnlz ?? true)) this.assertCommitAllowed();
    if ((options.checkPath ?? true) && !existsSync(path))
      throw new TypeError(`Path '${path}' does not exist`);
    const normalized = path.replaceAll("\\", "/");
    const oldPath = row.FolderPath;
    const analysis = this.readContentAnlzFiles(row);
    for (const file of analysis.values()) file.setPath(normalized);
    row.FolderPath = normalized;
    if (this.hasColumn(row.tableName, "OrgFolderPath") && row.get("OrgFolderPath") === oldPath)
      row.set("OrgFolderPath", normalized);
    if (row.FileNameL !== basename(normalized)) row.FileNameL = basename(normalized);
    if (options.saveAnlz ?? true) for (const [filePath, file] of analysis) file.save(filePath);
    if (options.commit ?? true) this.commit();
  }

  /** Update only a content filename while preserving its extension and directory. */
  updateContentFilename(
    content: models.DjmdContent | string | number,
    name: string,
    options: {
      checkPath?: boolean;
      commit?: boolean;
      saveAnlz?: boolean;
    } = {},
  ): void {
    const row = this.resolve(models.DjmdContent, content);
    if (!row.FolderPath) throw new TypeError(`Content '${row.ID}' has no FolderPath`);
    const extension = extname(row.FolderPath);
    const filename = `${basename(name, extname(name))}${extension}`;
    this.updateContentPath(row, join(dirname(row.FolderPath), filename), options);
  }

  /** Convert all known mapped tables to plain objects. */
  toObject(): Record<string, Array<Record<string, unknown>>> {
    return Object.fromEntries(
      models.TABLES.filter((name) => this.hasTable(models.modelClasses[name].tableName)).map(
        (name) => [
          name,
          this.query(models.modelClasses[name] as models.ModelClass<models.DatabaseRow>)
            .all()
            .map((row) => row.toJSON()),
        ],
      ),
    );
  }

  /** Upstream-compatible alias for {@link toObject}. */
  toDict(): Record<string, Array<Record<string, unknown>>> {
    return this.toObject();
  }

  /** Write all mapped tables to JSON. */
  toJson(path: string, options: { indent?: number } = {}): void {
    writeFileSync(path, `${JSON.stringify(this.toObject(), null, options.indent ?? 2)}\n`, "utf8");
  }

  /** Copy the decrypted logical schema/data into a new plain SQLite database. */
  async copyUnlocked(output: string): Promise<void> {
    if (existsSync(output)) throw new Error(`Refusing to overwrite existing database '${output}'`);
    const source = this.requireConnection();
    const destination = new Database(output);
    try {
      destination.pragma("foreign_keys=OFF");
      const schema = source
        .prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name",
        )
        .all() as Array<{ name: string; sql: string; tbl_name: string; type: string }>;
      const copy = destination.transaction(() => {
        for (const item of schema) if (item.type === "table") destination.exec(item.sql);
        for (const item of schema) {
          if (item.type !== "table") continue;
          const rows = source.prepare(`SELECT * FROM ${quoteIdentifier(item.name)}`).all() as Array<
            Record<string, unknown>
          >;
          if (!rows.length) continue;
          const columns = Object.keys(rows[0]!);
          const insert = destination.prepare(
            `INSERT INTO ${quoteIdentifier(item.name)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          );
          for (const row of rows) insert.run(...columns.map((column) => row[column]));
        }
        for (const item of schema) if (item.type !== "table") destination.exec(item.sql);
        destination.pragma(
          `user_version=${source.pragma("user_version", { simple: true }) as number}`,
        );
      });
      copy();
    } finally {
      destination.close();
    }
  }
}

/** @deprecated Use {@link MasterDatabase}; retained for pyrekordbox/db6 migrations. */
export class Rekordbox6Database extends MasterDatabase {
  constructor(
    pathOrOptions: string | MasterDatabaseOptions = {},
    overrides: MasterDatabaseOptions = {},
  ) {
    warnDeprecated("Rekordbox6Database", {
      hint: "The Rekordbox6Database class was renamed.",
      newName: "MasterDatabase",
    });
    super(pathOrOptions, overrides);
  }
}
