import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";

import { getConfig, MasterDatabase } from "@gakonst/rekordbox";

import { parseManifest, type SetManifest } from "./manifest.js";

const PIPELINE_TABLE = "djboothSetPipeline";

/** Only an explicit new workflow path opts in to a managed, headless library. */
export function prepareWorkflowDatabase(dbPath: string | undefined): void {
  if (!dbPath) return;
  try {
    // lstat preserves dangling symlinks too: never treat an existing entry as new.
    lstatSync(dbPath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  MasterDatabase.createManaged(resolve(dbPath)).close();
}

/** Bounded diagnostics derived from master.db; never a second workflow ledger. */
export function inspectImportDetails(database: MasterDatabase, source: string) {
  if (!database.hasTable(PIPELINE_TABLE)) return null;
  const row = database.selectRawRows<{ StateJson: string; UpdatedAt: string }>(
    `SELECT "StateJson", "UpdatedAt" FROM "${PIPELINE_TABLE}" WHERE "Source" = ?`,
    [source],
  )[0];
  if (!row) return null;
  const state = parseManifest(JSON.parse(row.StateJson));
  const text = (value: string) => value.replace(/https?:\/\/\S+/g, "[provider URL]").slice(0, 300);
  const analyzed = new Set(state.artifacts.analysis?.map((item) => item.mediaPath) ?? []);
  return {
    updatedAt: row.UpdatedAt,
    tracklist: state.tracklist,
    warnings: [
      ...state.warnings,
      ...state.errors.map((error) => `${error.stage}: ${error.message}`),
    ]
      .slice(-10)
      .map(text),
    tracks: state.entries.map((entry) => ({
      order: entry.order,
      artist: entry.identity.artist?.slice(0, 120),
      title: entry.identity.title?.slice(0, 120),
      identity: entry.identity.status,
      acquisition: entry.acquisition.status,
      kind:
        entry.acquisition.status === "downloaded"
          ? (entry.acquisition.download.kind ?? "individual")
          : undefined,
      analyzed:
        entry.acquisition.status === "downloaded" &&
        analyzed.has(entry.acquisition.download.mediaPath),
      rekordbox: entry.rekordbox.status,
      warnings: entry.warnings.slice(-2).map((warning) => text(warning).slice(0, 80)),
      errors: entry.errors
        .slice(-2)
        .map((error) => ({ stage: error.stage, message: text(error.message).slice(0, 80) })),
    })),
  };
}

export type RekordboxPipelineLocation = {
  dbPath: string;
  dbDirectory: string;
};

export type RekordboxPipelineStoreOptions = {
  source: string;
  dbPath?: string;
  dbDirectory?: string;
  key?: string;
  keepOpen?: boolean;
  outputDirectory: string;
};

export type RekordboxImportStatus = {
  source: string;
  title?: string;
  updatedAt: string;
  tracks: number;
  identified: number;
  downloaded: number;
  analyzed: number;
  ready: number;
  blocked: number;
  pending: number;
};

/** Durable set-pipeline state stored inside the normal Rekordbox master.db. */
export class RekordboxPipelineStore {
  readonly source: string;
  readonly location: RekordboxPipelineLocation;
  readonly artifactDirectory: string;
  private readonly key: string | undefined;
  private readonly keepOpen: boolean;
  private database: MasterDatabase | undefined;

  constructor(options: RekordboxPipelineStoreOptions) {
    this.source = options.source;
    this.location = resolveRekordboxPipelineLocation(options);
    this.key = options.key;
    this.keepOpen = options.keepOpen ?? false;
    const sourceId = createHash("sha256").update(options.source).digest("hex").slice(0, 16);
    this.artifactDirectory = join(resolve(options.outputDirectory), ".djbooth", "sets", sourceId);
  }

  async load(): Promise<SetManifest | undefined> {
    return this.withDatabase((database) => {
      const rows = database.selectRawRows<{ StateJson: string }>(
        `SELECT "StateJson" FROM "${PIPELINE_TABLE}" WHERE "Source" = ?`,
        [this.source],
      );
      if (!rows.length) return undefined;
      if (rows.length !== 1) throw new Error(`Multiple pipeline rows use source '${this.source}'`);
      return parseManifest(JSON.parse(rows[0]!.StateJson) as unknown);
    });
  }

  async save(state: SetManifest): Promise<void> {
    const parsed = parseManifest(structuredClone(state));
    await this.withDatabase((database) => {
      database.executeSql(
        `INSERT INTO "${PIPELINE_TABLE}" ("Source", "StateJson", "UpdatedAt")
         VALUES (?, ?, ?)
         ON CONFLICT("Source") DO UPDATE SET
           "StateJson" = excluded."StateJson",
           "UpdatedAt" = excluded."UpdatedAt"`,
        [this.source, JSON.stringify(parsed), new Date().toISOString()],
      );
    });
  }

  /** Close a workflow-scoped SQLCipher session after its final durable checkpoint. */
  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  private async withDatabase<result>(
    task: (database: MasterDatabase) => result | Promise<result>,
  ): Promise<result> {
    const database =
      this.database ??
      new MasterDatabase({
        path: this.location.dbPath,
        dbDirectory: this.location.dbDirectory,
        playlistXml: false,
        readonly: false,
        unlock: true,
        ...(this.key === undefined ? {} : { key: this.key }),
      });
    if (this.keepOpen) this.database = database;
    try {
      if (!database.hasTable(PIPELINE_TABLE)) {
        database.executeSql(
          `CREATE TABLE IF NOT EXISTS "${PIPELINE_TABLE}" (
             "Source" TEXT PRIMARY KEY NOT NULL,
             "StateJson" TEXT NOT NULL,
             "UpdatedAt" TEXT NOT NULL
           )`,
        );
      }
      return await task(database);
    } finally {
      if (!this.keepOpen) database.close();
    }
  }
}

export function resolveRekordboxPipelineLocation(
  options: Pick<RekordboxPipelineStoreOptions, "dbPath" | "dbDirectory">,
): RekordboxPipelineLocation {
  const configured = getConfig("rekordbox7") ?? getConfig("rekordbox6");
  const configuredPath = options.dbPath ?? configured?.dbPath;
  if (!configuredPath) throw new TypeError("No Rekordbox master.db was supplied or discovered");
  const dbPath = resolve(configuredPath);
  return {
    dbPath,
    dbDirectory: resolve(
      options.dbDirectory ??
        (options.dbPath ? join(dbPath, "..") : configured?.dbDir) ??
        join(dbPath, ".."),
    ),
  };
}

/** Read agent-facing import progress from the pipeline rows stored in master.db. */
export function inspectRekordboxImports(
  options: Pick<RekordboxPipelineStoreOptions, "dbPath" | "dbDirectory"> & {
    database?: MasterDatabase;
  } = {},
): { dbPath: string; imports: RekordboxImportStatus[] } {
  const location = options.database
    ? { dbPath: options.database.path, dbDirectory: options.database.dbDirectory }
    : resolveRekordboxPipelineLocation(options);
  const database =
    options.database ??
    new MasterDatabase({
      path: location.dbPath,
      dbDirectory: location.dbDirectory,
      playlistXml: false,
      readonly: true,
      unlock: true,
    });
  try {
    if (!database.hasTable(PIPELINE_TABLE)) return { dbPath: location.dbPath, imports: [] };
    const rows = database.selectRawRows<{ Source: string; StateJson: string; UpdatedAt: string }>(
      `SELECT "Source", "StateJson", "UpdatedAt" FROM "${PIPELINE_TABLE}" ORDER BY "UpdatedAt" DESC`,
    );
    return {
      dbPath: location.dbPath,
      imports: rows.map((row) => {
        const state = parseManifest(JSON.parse(row.StateJson) as unknown);
        const analyzedPaths = new Set(
          state.artifacts.analysis?.map((item) => item.mediaPath) ?? [],
        );
        const ready = state.entries.filter((entry) => entry.rekordbox.status === "imported").length;
        const blocked = state.entries.filter(
          (entry) =>
            entry.identity.status === "unidentified" ||
            entry.acquisition.status === "failed" ||
            entry.acquisition.status === "unmatched" ||
            entry.acquisition.status === "skipped" ||
            entry.rekordbox.status === "failed",
        ).length;
        return {
          source: row.Source,
          ...(state.source.title ? { title: state.source.title } : {}),
          updatedAt: row.UpdatedAt,
          tracks: state.entries.length,
          identified: state.entries.filter((entry) => entry.identity.status === "identified")
            .length,
          downloaded: state.entries.filter((entry) => entry.acquisition.status === "downloaded")
            .length,
          analyzed: state.entries.filter(
            (entry) =>
              entry.acquisition.status === "downloaded" &&
              analyzedPaths.has(entry.acquisition.download.mediaPath),
          ).length,
          ready,
          blocked,
          pending: Math.max(0, state.entries.length - ready - blocked),
        };
      }),
    };
  } finally {
    if (!options.database) database.close();
  }
}
