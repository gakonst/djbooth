import { existsSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

import Database from "better-sqlite3-multiple-ciphers";

import {
  AnlzFile,
  getAnlzPaths as findAnlzPaths,
  readAnlzFiles as readAnlzFilesInDirectory,
} from "../anlz/index.js";
import { getConfig } from "../config/index.js";
import { deobfuscate, getRekordboxPid } from "../utils.js";
import { MasterPlaylistXml } from "./aux-files.js";
import * as models from "./models.js";
import { SmartList } from "./smartlist.js";

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

/** Options for opening a Rekordbox master database. */
export type MasterDatabaseOptions = {
  allowWhileRunning?: boolean;
  dbDirectory?: string;
  key?: string;
  path?: string;
  readonly?: boolean;
  unlock?: boolean;
  warnIfRunning?: boolean;
};

/** Commit behavior controls. */
export type CommitOptions = {
  allowWhileRunning?: boolean;
  autoincrement?: boolean;
};

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
  return new Date(`${match[1]}T${match[2]}${match[3] ?? "Z"}`);
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

  /** Add physical-column ordering. */
  orderBy(column: string, direction: "asc" | "desc" = "asc"): Query<row> {
    if (!this.database.hasColumn(this.model.tableName, column))
      throw new RangeError(`Column '${column}' does not exist on '${this.model.tableName}'`);
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
    const statement = this.statement(true);
    return this.database.countRows(statement.sql, statement.parameters);
  }

  /** Return a zero-based row by index. */
  at(index: number): row | undefined {
    return this.offset(index).limit(1).first();
  }

  [Symbol.iterator](): Iterator<row> {
    return this.all()[Symbol.iterator]();
  }
}

/** Tracks local USN updates made through a master database. */
export class RekordboxAgentRegistry {
  constructor(private database: MasterDatabase) {}

  /** Current local update sequence number. */
  getLocalUpdateCount(): number {
    const row = this.database
      .query(models.AgentRegistry)
      .where({ registry_id: "localUpdateCount" })
      .one();
    return Number(row.get("int_1"));
  }

  /** Set the global local update sequence number. */
  setLocalUpdateCount(value: number): void {
    if (!Number.isInteger(value)) throw new TypeError("USN must be an integer");
    const row = this.database
      .query(models.AgentRegistry)
      .where({ registry_id: "localUpdateCount" })
      .one();
    this.database.withTrackingDisabled(() => row.set("int_1", value));
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
        if (setRowUsn && this.database.hasColumn(row.tableName, "rb_local_usn"))
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
  private schemas = new Map<string, TableSchema>();
  private identity = new Map<string, models.DatabaseRow>();
  private tracked = new Set<models.DatabaseRow>();
  private changes: Array<models.DatabaseRow> = [];
  private trackingDisabled = 0;
  private transactionOpen = false;

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
    const playlistPath = join(this.dbDirectory, "masterPlaylists6.xml");
    if (existsSync(playlistPath)) this.playlistXml = new MasterPlaylistXml(playlistPath);
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
    this.schemas.clear();
    this.identity.clear();
  }

  private requireConnection(): Database.Database {
    if (!this.connection?.open) throw new Error("SQLite connection is not initialized");
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
    this.schemas.clear();
    for (const { name } of tables) {
      const columns = connection
        .prepare(`PRAGMA table_info(${quoteIdentifier(name)})`)
        .all() as Array<TableColumn>;
      this.schemas.set(name, {
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
      });
    }
  }

  /** Physical table names in this database. */
  get tableNames(): Array<string> {
    return [...this.schemas.keys()].sort();
  }

  /** Whether a physical table exists. */
  hasTable(table: string): boolean {
    return this.schemas.has(table);
  }

  /** Whether a physical column exists. */
  hasColumn(table: string, column: string): boolean {
    return this.schemas.get(table)?.names.has(column) ?? false;
  }

  private schema(table: string): TableSchema {
    const schema = this.schemas.get(table);
    if (!schema) throw new RangeError(`Table '${table}' does not exist`);
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
    if (this.tracked.size) this.flush();
    const rows = this.requireConnection()
      .prepare(sql)
      .all(...parameters) as Array<Record<string, unknown>>;
    return rows.map((raw) => this.materialize(model, raw));
  }

  /** @internal Execute a count query. */
  countRows(sql: string, parameters: Array<unknown>): number {
    if (this.tracked.size) this.flush();
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
    this.tracked.add(row);
    if (!this.trackingDisabled) this.changes.push(row);
  }

  /** Create and stage a new mapped row. */
  create<row extends models.DatabaseRow>(
    model: models.ModelClass<row>,
    values: Record<string, models.DatabaseValue>,
  ): row {
    this.requireWritable();
    const schema = this.schema(model.tableName);
    for (const key of Object.keys(values))
      if (!schema.names.has(key))
        throw new RangeError(`Column '${key}' does not exist on '${model.tableName}'`);
    const now = new Date();
    const data: models.RowData = { ...values };
    if (schema.names.has("created_at") && data.created_at === undefined) data.created_at = now;
    if (schema.names.has("updated_at") && data.updated_at === undefined) data.updated_at = now;
    if (schema.names.has("UUID") && data.UUID === undefined) data.UUID = randomUUID();
    const row = new model(this, data, "new");
    const key = this.identityKey(model.tableName, data);
    if (key) this.identity.set(key, row);
    this.tracked.add(row);
    if (!this.trackingDisabled) this.changes.push(row);
    return row;
  }

  /** Stage a row for deletion. */
  delete(row: models.DatabaseRow): void {
    this.requireWritable();
    row.state = "deleted";
    this.tracked.add(row);
    if (!this.trackingDisabled) this.changes.push(row);
  }

  /** Stage an already-created row owned by this database. */
  add(row: models.DatabaseRow): void {
    this.requireWritable();
    if (row.database !== this) throw new TypeError("Cannot add a row owned by another database");
    if (row.state !== "new") throw new TypeError("Only newly created rows can be added");
    this.tracked.add(row);
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
      parameters: keys.map((key) => this.serializeValue(row.original[key]!)),
      sql: keys.map((key) => `${quoteIdentifier(key)} = ?`).join(" AND "),
    };
  }

  /** Flush staged changes into an open SQLite transaction. */
  flush(): void {
    if (!this.tracked.size) return;
    this.requireWritable();
    const connection = this.requireConnection();
    if (!this.transactionOpen) {
      connection.exec("BEGIN");
      this.transactionOpen = true;
    }

    for (const row of this.tracked) {
      if (row.state === "new" && row.flushed === undefined) {
        const entries = Object.entries(row.data);
        const sql = `INSERT INTO ${quoteIdentifier(row.tableName)} (${entries
          .map(([key]) => quoteIdentifier(key))
          .join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`;
        const result = connection
          .prepare(sql)
          .run(...entries.map(([, value]) => this.serializeValue(value)));
        const schema = this.schema(row.tableName);
        if (schema.primaryKeys.length === 1) {
          const primaryKey = schema.primaryKeys[0]!;
          const column = schema.columns.find((item) => item.name === primaryKey)!;
          if (row.data[primaryKey] === undefined && /INT/iu.test(column.type)) {
            row.data[primaryKey] = result.lastInsertRowid;
            const key = this.identityKey(row.tableName, row.data);
            if (key) this.identity.set(key, row);
          }
        }
        row.flushed = { ...row.data };
        continue;
      }

      if (row.state === "deleted") {
        if (row.state === "deleted" && row.original !== row.data) {
          const where = this.primaryPredicate(row);
          connection
            .prepare(`DELETE FROM ${quoteIdentifier(row.tableName)} WHERE ${where.sql}`)
            .run(...where.parameters);
        }
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
      connection
        .prepare(sql)
        .run(...changed.map((key) => this.serializeValue(row.data[key]!)), ...where.parameters);
      row.flushed = { ...row.data };
    }
  }

  /** Commit staged changes, assigning local USNs by default. */
  commit(options: CommitOptions | boolean = {}): void {
    this.requireWritable();
    const normalized = typeof options === "boolean" ? { autoincrement: options } : options;
    if (!(normalized.allowWhileRunning ?? this.options.allowWhileRunning) && getRekordboxPid())
      throw new Error("Rekordbox is running; close it before committing database changes");
    if ((normalized.autoincrement ?? true) && this.changes.length)
      this.registry.autoincrementLocalUpdateCount(true);
    this.flush();
    const playlistChanges = [...this.tracked].filter((row) => row.tableName === "djmdPlaylist");
    if (this.transactionOpen) this.requireConnection().exec("COMMIT");
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
    for (const row of this.tracked) {
      if (row.state === "deleted") {
        const key = this.identityKey(row.tableName, row.original);
        if (key) this.identity.delete(key);
      } else {
        row.state = "existing";
        row.original = { ...row.data };
        row.flushed = undefined;
      }
    }
    this.tracked.clear();
    this.changes = [];
    this.transactionOpen = false;
  }

  /** Roll back all staged and flushed-but-uncommitted changes. */
  rollback(): void {
    if (this.transactionOpen && this.connection?.open) this.connection.exec("ROLLBACK");
    for (const row of this.tracked) {
      if (row.state === "new") {
        const key = this.identityKey(row.tableName, row.data);
        if (key) this.identity.delete(key);
      } else {
        row.data = { ...row.original };
        row.state = "existing";
        row.flushed = undefined;
      }
    }
    this.tracked.clear();
    this.changes = [];
    this.transactionOpen = false;
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

  /** @internal Resolve relationships and virtual properties. */
  getComputed(row: models.DatabaseRow, property: string): unknown {
    const one = (model: models.ModelClass, filters: Record<string, models.DatabaseValue>) =>
      this.query(model).where(filters).oneOrNone();
    const many = (
      model: models.ModelClass,
      filters: Record<string, models.DatabaseValue>,
      order?: string,
    ) => {
      const query = this.query(model).where(filters);
      return (order ? query.orderBy(order) : query).all();
    };

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
      if (property === "Cues") return many(models.DjmdCue, { ContentID: row.get("ID")! });
      if (property === "MixerParams")
        return many(models.DjmdMixerParam, { ContentID: row.get("ID")! });
    }
    if (row.tableName === "djmdPlaylist") {
      if (property === "isPlaylist")
        return Number(row.get("Attribute")) === models.PlaylistType.PLAYLIST;
      if (property === "isFolder")
        return Number(row.get("Attribute")) === models.PlaylistType.FOLDER;
      if (property === "isSmartPlaylist")
        return Number(row.get("Attribute")) === models.PlaylistType.SMART_PLAYLIST;
      if (property === "Songs")
        return many(models.DjmdSongPlaylist, { PlaylistID: row.get("ID")! }, "TrackNo");
      if (property === "Children")
        return many(models.DjmdPlaylist, { ParentID: row.get("ID")! }, "Seq");
      if (property === "Parent") {
        const id = row.get("ParentID");
        return id === "root" || id == null ? undefined : one(models.DjmdPlaylist, { ID: id });
      }
    }
    if (row.tableName === "djmdSongPlaylist") {
      if (property === "Content") return one(models.DjmdContent, { ID: row.get("ContentID")! });
      if (property === "Playlist") return one(models.DjmdPlaylist, { ID: row.get("PlaylistID")! });
    }
    if (row.tableName === "djmdCue") {
      if (property === "Content") return one(models.DjmdContent, { ID: row.get("ContentID")! });
      if (property === "isMemoryCue") return Number(row.get("HotCue")) === 0;
      if (property === "isHotCue") return Number(row.get("HotCue")) > 0;
    }
    if (row.tableName === "djmdMixerParam") {
      if (property === "Content") return one(models.DjmdContent, { ID: row.get("ContentID")! });
      if (property === "Gain") return this.decodeDb(row.get("GainLow"), row.get("GainHigh"));
      if (property === "Peak") return this.decodeDb(row.get("PeakLow"), row.get("PeakHigh"));
    }
    return undefined;
  }

  /** @internal Set virtual mixer properties. */
  setComputed(row: models.DatabaseRow, property: string, value: unknown): boolean {
    if (row.tableName !== "djmdMixerParam" || !["Gain", "Peak"].includes(property)) return false;
    const [low, high] = this.encodeDb(Number(value));
    row.set(`${property}Low`, low);
    row.set(`${property}High`, high);
    return true;
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

  /** Return content rows selected by a regular or smart playlist. */
  getPlaylistContents(playlist: models.DjmdPlaylist | string | number): Query<models.DjmdContent> {
    const row =
      playlist instanceof models.DatabaseRow
        ? (playlist as models.DjmdPlaylist)
        : this.query(models.DjmdPlaylist)
            .where({ ID: String(playlist) })
            .one();
    if (Number(row.Attribute) === models.PlaylistType.FOLDER)
      throw new TypeError("Playlist is a folder");
    if (Number(row.Attribute) === models.PlaylistType.SMART_PLAYLIST) {
      if (!row.SmartList) throw new TypeError("Smart playlist has no SmartList XML");
      const compiled = SmartList.fromXml(row.SmartList).compileSql();
      return this.query(models.DjmdContent).whereRaw(compiled.sql, compiled.parameters);
    }
    return this.query(models.DjmdContent).whereRaw(
      '"ID" IN (SELECT "ContentID" FROM "djmdSongPlaylist" WHERE "PlaylistID" = ?)',
      [row.ID],
    );
  }

  /** Generate an unused random numeric ID. */
  generateUnusedId(
    model: models.ModelClass,
    options: { bits?: 28 | 32; field?: string } = {},
  ): number {
    const bits = options.bits ?? 28;
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
    if (target < 1 || target > songs.length + 1)
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
    if (newTrackNumber < 1 || newTrackNumber > songs.length)
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
    if (seq < 1 || seq > siblings.length + 1)
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
      UUID: randomUUID(),
    });
  }

  /** Create a normal playlist. */
  createPlaylist(
    name: string,
    options: {
      imagePath?: string;
      parent?: models.DjmdPlaylist | string | number;
      seq?: number;
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
    const parentId = newParent?.ID ?? oldParent;
    const siblings = this.query(models.DjmdPlaylist)
      .where({ ParentID: parentId })
      .orderBy("Seq")
      .all()
      .filter((sibling) => sibling.ID !== row.ID);
    const target = options.seq ?? siblings.length + 1;
    if (target < 1 || target > siblings.length + 1)
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
    for (const child of this.query(models.DjmdPlaylist).where({ ParentID: row.ID }).all())
      this.deletePlaylist(child);
    for (const song of this.query(models.DjmdSongPlaylist).where({ PlaylistID: row.ID }).all())
      this.delete(song);
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
  /** Add a unique album. */
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
    return this.addNamed(models.DjmdAlbum, name, {
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
    options: { checkPath?: boolean; commit?: boolean; saveAnlz?: boolean } = {},
  ): void {
    const row = this.resolve(models.DjmdContent, content);
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
    options: { checkPath?: boolean; commit?: boolean; saveAnlz?: boolean } = {},
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
          this.query(models.modelClasses[name])
            .all()
            .map((row) => row.toJSON()),
        ],
      ),
    );
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
