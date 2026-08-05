import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { getConfig, MasterDatabase } from "@gakonst/rekordbox";

import { parseManifest, type SetManifest } from "./manifest.js";
import { acquireRekordboxDatabaseLock } from "./rekordbox-db.js";

const PIPELINE_TABLE = "djboothSetPipeline";

export type RekordboxPipelineLocation = {
  dbPath: string;
  dbDirectory: string;
};

export type RekordboxPipelineStoreOptions = {
  source: string;
  dbPath?: string;
  dbDirectory?: string;
  key?: string;
  outputDirectory: string;
};

/** Durable set-pipeline state stored inside the normal Rekordbox master.db. */
export class RekordboxPipelineStore {
  readonly source: string;
  readonly location: RekordboxPipelineLocation;
  readonly artifactDirectory: string;
  private readonly key: string | undefined;

  constructor(options: RekordboxPipelineStoreOptions) {
    this.source = options.source;
    this.location = resolveRekordboxPipelineLocation(options);
    this.key = options.key;
    const sourceId = createHash("sha256").update(options.source).digest("hex").slice(0, 16);
    this.artifactDirectory = join(resolve(options.outputDirectory), ".djbooth", "sets", sourceId);
  }

  async load(): Promise<SetManifest | undefined> {
    const release = await acquireRekordboxDatabaseLock(this.location.dbPath);
    try {
      return await this.withDatabase((database) => {
        const rows = database.selectRawRows<{ StateJson: string }>(
          `SELECT "StateJson" FROM "${PIPELINE_TABLE}" WHERE "Source" = ?`,
          [this.source],
        );
        if (!rows.length) return undefined;
        if (rows.length !== 1)
          throw new Error(`Multiple pipeline rows use source '${this.source}'`);
        return parseManifest(JSON.parse(rows[0]!.StateJson) as unknown);
      });
    } finally {
      await release();
    }
  }

  async save(state: SetManifest): Promise<void> {
    const parsed = parseManifest(structuredClone(state));
    const release = await acquireRekordboxDatabaseLock(this.location.dbPath);
    try {
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
    } finally {
      await release();
    }
  }

  private async withDatabase<result>(
    task: (database: MasterDatabase) => result | Promise<result>,
  ): Promise<result> {
    const database = new MasterDatabase({
      path: this.location.dbPath,
      dbDirectory: this.location.dbDirectory,
      readonly: false,
      unlock: true,
      ...(this.key === undefined ? {} : { key: this.key }),
    });
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
      database.close();
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
    dbDirectory: resolve(options.dbDirectory ?? configured?.dbDir ?? join(dbPath, "..")),
  };
}
