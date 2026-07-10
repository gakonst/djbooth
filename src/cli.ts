#!/usr/bin/env node

import { Cli, z } from "incur";

import {
  AnlzFile,
  BeatGridTag,
  createMySettingFile,
  getAnlzPaths,
  getMySettingPaths,
  LogicalOperator,
  MasterDatabase,
  modelByTable,
  DjmdContent,
  DjmdPlaylist,
  readMySettingFile,
  RekordboxXml,
  SmartList,
  updateConfig,
  version,
  walkAnlzDirectories,
} from "./index.js";
import type {
  ConditionInput,
  DatabaseValue,
  MySettingFilename,
  NodeKeyType,
  TrackAttributes,
  TrackSelector,
} from "./index.js";

const cli = Cli.create("rekordbox", {
  version,
  description: "Inspect and modify Rekordbox libraries and export formats.",
  sync: {
    suggestions: [
      "inspect my Rekordbox configuration",
      "summarize a Rekordbox XML export",
      "inspect an ANLZ file",
      "list playlists in my Rekordbox library",
    ],
  },
});

cli.command("status", {
  description: "Show implementation and runtime status.",
  output: z.object({
    name: z.string(),
    version: z.string(),
    runtime: z.string(),
    phase: z.string(),
  }),
  run() {
    return {
      name: "@gakonst/rekordbox",
      version,
      runtime: process.version,
      phase: "active-port",
    };
  },
});

const configCli = Cli.create("config", {
  description: "Discover Rekordbox installations and library paths.",
}).command("show", {
  description: "Show detected Rekordbox paths and versions.",
  options: z.object({
    appDir: z.string().optional().describe("Pioneer application-data directory"),
    installDir: z.string().optional().describe("Pioneer/Rekordbox installation root"),
    rekordbox5Dirname: z.string().optional().describe("Exact Rekordbox 5 directory name"),
    rekordbox6Dirname: z.string().optional().describe("Exact Rekordbox 6 directory name"),
    rekordbox7Dirname: z.string().optional().describe("Exact Rekordbox 7 directory name"),
  }),
  examples: [{ description: "Auto-detect Rekordbox installations" }],
  run(c) {
    return updateConfig({
      pioneerAppDir: c.options.appDir,
      pioneerInstallDir: c.options.installDir,
      rekordbox5Dirname: c.options.rekordbox5Dirname,
      rekordbox6Dirname: c.options.rekordbox6Dirname,
      rekordbox7Dirname: c.options.rekordbox7Dirname,
    });
  },
});

cli.command(configCli);

const settingsCli = Cli.create("settings", {
  description: "Read and write Rekordbox My Settings binary files.",
});

settingsCli.command("list", {
  description: "Find My Settings files below a directory.",
  args: z.object({ root: z.string().describe("Directory to scan") }),
  options: z.object({ deep: z.boolean().default(false).describe("Scan recursively") }),
  run(c) {
    const paths = getMySettingPaths(c.args.root, c.options.deep);
    return { count: paths.length, paths };
  },
});

settingsCli.command("show", {
  description: "Parse and show a My Settings file.",
  args: z.object({ path: z.string().describe("Settings file") }),
  run(c) {
    const file = readMySettingFile(c.args.path);
    return {
      ...file.toJSON(),
      allowedValues: Object.fromEntries(file.keys().map((key) => [key, file.allowedValues(key)])),
    };
  },
});

settingsCli.command("set", {
  description: "Update one setting and write a checksummed binary.",
  args: z.object({
    path: z.string().describe("Settings file"),
    key: z.string().describe("Setting name"),
    value: z.string().describe("Symbolic setting value"),
  }),
  options: z.object({
    output: z.string().optional().describe("Destination; defaults to the source file"),
  }),
  run(c) {
    const file = readMySettingFile(c.args.path);
    file.set(c.args.key, c.args.value);
    const output = c.options.output ?? c.args.path;
    file.save(output);
    return { output, ...file.toJSON() };
  },
});

settingsCli.command("create", {
  description: "Create a default My Settings binary.",
  args: z.object({
    filename: z
      .enum(["MYSETTING.DAT", "MYSETTING2.DAT", "DJMMYSETTING.DAT", "DEVSETTING.DAT"])
      .describe("Settings format"),
    output: z.string().describe("Destination file"),
  }),
  options: z.object({
    version: z.string().optional().describe("DEVSETTING Rekordbox version"),
  }),
  run(c) {
    const file = createMySettingFile(c.args.filename as MySettingFilename);
    if (c.options.version !== undefined) file.version = c.options.version;
    file.save(c.args.output);
    return { output: c.args.output, ...file.toJSON() };
  },
});

cli.command(settingsCli);

function paginateTagValue(value: unknown, offset: number, limit: number): unknown {
  if (Array.isArray(value))
    return { count: value.length, items: value.slice(offset, offset + limit), limit, offset };
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        Array.isArray(item) ? item.slice(offset, offset + limit) : item,
      ]),
    );
  return value;
}

function numberList(value: string): Array<number> {
  const values = value.split(",").map((item) => Number(item.trim()));
  if (values.some((item) => !Number.isFinite(item)))
    throw new TypeError(`Invalid comma-separated number list '${value}'`);
  return values;
}

const anlzCli = Cli.create("anlz", {
  description: "Read and write Rekordbox ANLZ analysis files.",
});

anlzCli.command("scan", {
  description: "Find directories and DAT/EXT/2EX files recursively.",
  args: z.object({ root: z.string().describe("USBANLZ root directory") }),
  run(c) {
    const directories = walkAnlzDirectories(c.args.root).map((directory) => ({
      directory,
      files: getAnlzPaths(directory),
    }));
    return { count: directories.length, directories };
  },
});

anlzCli.command("info", {
  description: "Show bounded ANLZ file and tag metadata.",
  args: z.object({ path: z.string().describe("ANLZ DAT, EXT, or 2EX file") }),
  run(c) {
    return AnlzFile.parseFile(c.args.path).summary();
  },
});

anlzCli.command("tag", {
  description: "Parse one tag by four-character type or semantic name.",
  args: z.object({
    path: z.string().describe("ANLZ DAT, EXT, or 2EX file"),
    key: z.string().describe("Tag type such as PQTZ or name such as beat_grid"),
  }),
  options: z.object({
    limit: z.number().int().min(1).max(100_000).default(1_000).describe("Array items to return"),
    offset: z.number().int().min(0).default(0).describe("Array items to skip"),
  }),
  run(c) {
    const tag = AnlzFile.parseFile(c.args.path).getTag(c.args.key);
    return {
      ...tag.summary(),
      value: paginateTagValue(tag.get(), c.options.offset, c.options.limit),
    };
  },
});

anlzCli.command("set-path", {
  description: "Replace the PPTH audio path and save the rebuilt ANLZ file.",
  args: z.object({
    path: z.string().describe("ANLZ DAT, EXT, or 2EX file"),
    audioPath: z.string().describe("New audio path"),
  }),
  options: z.object({
    output: z.string().optional().describe("Destination; defaults to the source file"),
  }),
  run(c) {
    const file = AnlzFile.parseFile(c.args.path);
    file.setPath(c.args.audioPath);
    const output = c.options.output ?? c.args.path;
    file.save(output);
    return { output, path: file.get("path") };
  },
});

anlzCli.command("set-beat-grid", {
  description: "Replace every existing PQTZ beat, BPM, and time value.",
  args: z.object({ path: z.string().describe("ANLZ DAT file") }),
  options: z.object({
    beats: z.string().describe("Comma-separated beat numbers"),
    bpms: z.string().describe("Comma-separated BPM values"),
    output: z.string().optional().describe("Destination; defaults to the source file"),
    times: z.string().describe("Comma-separated times in seconds"),
  }),
  run(c) {
    const file = AnlzFile.parseFile(c.args.path);
    const tag = file.getTag("PQTZ");
    if (!(tag instanceof BeatGridTag)) throw new TypeError("PQTZ tag has an unexpected handler");
    tag.set(numberList(c.options.beats), numberList(c.options.bpms), numberList(c.options.times));
    const output = c.options.output ?? c.args.path;
    file.save(output);
    return { beatGrid: tag.get(), output };
  },
});

cli.command(anlzCli);

const smartlistCli = Cli.create("smartlist", {
  description: "Parse, build, and compile Rekordbox smart playlists.",
});

smartlistCli.command("parse", {
  description: "Parse smart-playlist XML.",
  args: z.object({ xml: z.string().describe("Smart-playlist NODE XML") }),
  run(c) {
    const smartList = SmartList.fromXml(c.args.xml);
    return { ...smartList.toJSON(), sql: smartList.compileSql() };
  },
});

smartlistCli.command("build", {
  description: "Build smart-playlist XML from JSON conditions.",
  args: z.object({ playlistId: z.number().int().describe("Unsigned playlist ID") }),
  options: z.object({
    autoUpdate: z.number().int().min(0).max(1).default(0).describe("Automatic update flag"),
    conditions: z
      .string()
      .default("[]")
      .describe("JSON array of {property,operator,valueLeft,valueRight?,unit?}"),
    logical: z.enum(["all", "any"]).default("all").describe("Condition combination mode"),
  }),
  run(c) {
    const parsed = JSON.parse(c.options.conditions) as Array<{
      operator: number;
      property: string;
      unit?: string;
      valueLeft: string | number;
      valueRight?: string | number;
    }>;
    if (!Array.isArray(parsed)) throw new TypeError("--conditions must be a JSON array");
    const smartList = new SmartList(
      c.options.logical === "all" ? LogicalOperator.ALL : LogicalOperator.ANY,
      c.options.autoUpdate,
    );
    smartList.playlistId = c.args.playlistId;
    for (const condition of parsed) smartList.addCondition(condition as ConditionInput);
    return { smartList: smartList.toJSON(), xml: smartList.toXml() };
  },
});

smartlistCli.command("sql", {
  description: "Compile smart-playlist XML to parameterized SQLite SQL.",
  args: z.object({ xml: z.string().describe("Smart-playlist NODE XML") }),
  options: z.object({
    tableAlias: z.string().optional().describe("Optional content-table alias"),
  }),
  run(c) {
    return SmartList.fromXml(c.args.xml).compileSql({ tableAlias: c.options.tableAlias });
  },
});

cli.command(smartlistCli);

const dbOpenOptions = z.object({
  path: z.string().optional().describe("master.db path; defaults to auto-discovery"),
  plain: z.boolean().default(false).describe("Open an unencrypted SQLite database"),
});
const dbWriteOptions = dbOpenOptions.extend({
  allowWhileRunning: z.boolean().default(false).describe("Allow commit while Rekordbox is running"),
  write: z.boolean().default(false).describe("Required acknowledgement for database mutation"),
});

function openDatabase(options: { path?: string; plain: boolean }, write = false): MasterDatabase {
  return new MasterDatabase({
    key: process.env.REKORDBOX_DB_KEY,
    path: options.path,
    readonly: !write,
    unlock: !options.plain,
  });
}

function requireDatabaseWrite(options: { write: boolean }): void {
  if (!options.write) throw new TypeError("Database mutations require the explicit --write flag");
}

const databaseCli = Cli.create("db", {
  description: "Query and mutate Rekordbox 6/7 master databases.",
});

databaseCli.command("info", {
  description: "Show database paths, tables, and high-level counts.",
  options: dbOpenOptions,
  run(c) {
    const db = openDatabase(c.options);
    try {
      return {
        contentCount: db.hasTable("djmdContent") ? db.query(DjmdContent).count() : 0,
        dbDirectory: db.dbDirectory,
        path: db.path,
        playlistCount: db.hasTable("djmdPlaylist") ? db.query(DjmdPlaylist).count() : 0,
        readonly: db.readonly,
        shareDirectory: db.shareDirectory,
        tables: db.tableNames,
      };
    } finally {
      db.close();
    }
  },
});

databaseCli.command("table", {
  description: "List rows from any physical table.",
  args: z.object({ table: z.string().describe("Physical table name") }),
  options: dbOpenOptions.extend({
    filters: z.string().default("{}").describe("JSON object of equality filters"),
    limit: z.number().int().min(1).max(100_000).default(100).describe("Maximum rows"),
    offset: z.number().int().min(0).default(0).describe("Rows to skip"),
    orderBy: z.string().optional().describe("Physical column to order by"),
    descending: z.boolean().default(false).describe("Use descending order"),
  }),
  run(c) {
    const db = openDatabase(c.options);
    try {
      const model = modelByTable[c.args.table];
      let query = model ? db.query(model) : db.query(c.args.table);
      const filters = JSON.parse(c.options.filters) as Record<string, string | number | null>;
      query = query.where(filters);
      if (c.options.orderBy)
        query = query.orderBy(c.options.orderBy, c.options.descending ? "desc" : "asc");
      const count = query.count();
      const rows = query.offset(c.options.offset).limit(c.options.limit).all();
      return { count, limit: c.options.limit, offset: c.options.offset, rows, table: c.args.table };
    } finally {
      db.close();
    }
  },
});

databaseCli.command("search", {
  description: "Search tracks and joined artist/album/genre/key metadata.",
  args: z.object({ text: z.string().describe("Case-insensitive search text") }),
  options: dbOpenOptions.extend({
    limit: z.number().int().min(1).max(100_000).default(100),
    offset: z.number().int().min(0).default(0),
  }),
  run(c) {
    const db = openDatabase(c.options);
    try {
      const rows = db.searchContent(c.args.text);
      return {
        count: rows.length,
        rows: rows.slice(c.options.offset, c.options.offset + c.options.limit),
      };
    } finally {
      db.close();
    }
  },
});

databaseCli.command("copy-unlocked", {
  description: "Copy a decrypted logical database into a new plain SQLite file.",
  args: z.object({ output: z.string().describe("New destination database") }),
  options: dbOpenOptions,
  async run(c) {
    const db = openDatabase(c.options);
    try {
      await db.copyUnlocked(c.args.output);
      return { output: c.args.output, source: db.path, tables: db.tableNames.length };
    } finally {
      db.close();
    }
  },
});

const databaseRowCli = Cli.create("row", { description: "Generic mapped-row mutations." });

databaseRowCli.command("create", {
  description: "Insert a row using a JSON object of physical columns.",
  args: z.object({
    table: z.string().describe("Physical table name"),
    values: z.string().describe("JSON object of physical column values"),
  }),
  options: dbWriteOptions,
  run(c) {
    requireDatabaseWrite(c.options);
    const db = openDatabase(c.options, true);
    try {
      const model = modelByTable[c.args.table];
      if (!model) throw new TypeError(`No mapped model for table '${c.args.table}'`);
      const row = db.create(model, JSON.parse(c.args.values));
      db.commit({ allowWhileRunning: c.options.allowWhileRunning });
      return { row, table: c.args.table };
    } finally {
      db.close();
    }
  },
});

databaseRowCli.command("update", {
  description: "Update a row selected by primary-key column and value.",
  args: z.object({
    table: z.string().describe("Physical table name"),
    id: z.string().describe("Primary-key value"),
    values: z.string().describe("JSON object of physical column updates"),
  }),
  options: dbWriteOptions.extend({
    keyColumn: z.string().default("ID").describe("Primary-key column"),
  }),
  run(c) {
    requireDatabaseWrite(c.options);
    const db = openDatabase(c.options, true);
    try {
      const model = modelByTable[c.args.table];
      if (!model) throw new TypeError(`No mapped model for table '${c.args.table}'`);
      const row = db
        .query(model)
        .where({ [c.options.keyColumn]: c.args.id })
        .one();
      for (const [key, value] of Object.entries(JSON.parse(c.args.values)))
        row.set(key, value as DatabaseValue);
      db.commit({ allowWhileRunning: c.options.allowWhileRunning });
      return { row, table: c.args.table };
    } finally {
      db.close();
    }
  },
});

databaseRowCli.command("delete", {
  description: "Delete a row selected by primary-key column and value.",
  args: z.object({
    table: z.string().describe("Physical table name"),
    id: z.string().describe("Primary-key value"),
  }),
  options: dbWriteOptions.extend({
    keyColumn: z.string().default("ID").describe("Primary-key column"),
  }),
  run(c) {
    requireDatabaseWrite(c.options);
    const db = openDatabase(c.options, true);
    try {
      const model = modelByTable[c.args.table];
      if (!model) throw new TypeError(`No mapped model for table '${c.args.table}'`);
      const row = db
        .query(model)
        .where({ [c.options.keyColumn]: c.args.id })
        .one();
      const deleted = row.toJSON();
      db.delete(row);
      db.commit({ allowWhileRunning: c.options.allowWhileRunning });
      return { deleted, table: c.args.table };
    } finally {
      db.close();
    }
  },
});

const databasePlaylistCli = Cli.create("playlist", {
  description: "Query and mutate master-database playlists.",
});

const databaseContentCli = Cli.create("content", {
  description: "Create tracks and coordinate database/ANLZ paths.",
});

databaseContentCli.command("add", {
  description: "Add an existing audio file as a content row.",
  args: z.object({ audioPath: z.string().describe("Existing audio file") }),
  options: dbWriteOptions.extend({
    albumId: z.string().optional(),
    artistId: z.string().optional(),
    genreId: z.string().optional(),
    title: z.string().optional(),
  }),
  run(c) {
    requireDatabaseWrite(c.options);
    const db = openDatabase(c.options, true);
    try {
      const row = db.addContent(c.args.audioPath, {
        AlbumID: c.options.albumId ?? null,
        ArtistID: c.options.artistId ?? null,
        GenreID: c.options.genreId ?? null,
        Title: c.options.title ?? null,
      });
      db.commit({ allowWhileRunning: c.options.allowWhileRunning });
      return row;
    } finally {
      db.close();
    }
  },
});

databaseContentCli.command("set-path", {
  description: "Update a content path and matching ANLZ PPTH tags.",
  args: z.object({
    contentId: z.string().describe("Content ID"),
    audioPath: z.string().describe("New audio path"),
  }),
  options: dbWriteOptions.extend({
    checkPath: z.boolean().default(true).describe("Require the new audio path to exist"),
    saveAnlz: z.boolean().default(true).describe("Write updated analysis files"),
  }),
  run(c) {
    requireDatabaseWrite(c.options);
    const db = openDatabase(c.options, true);
    try {
      db.updateContentPath(c.args.contentId, c.args.audioPath, {
        checkPath: c.options.checkPath,
        commit: false,
        saveAnlz: c.options.saveAnlz,
      });
      db.commit({ allowWhileRunning: c.options.allowWhileRunning });
      return db.query(DjmdContent).where({ ID: c.args.contentId }).one();
    } finally {
      db.close();
    }
  },
});

databasePlaylistCli.command("contents", {
  description: "List tracks selected by a regular or smart playlist.",
  args: z.object({ id: z.string().describe("Playlist ID") }),
  options: dbOpenOptions.extend({
    limit: z.number().int().min(1).max(100_000).default(100),
    offset: z.number().int().min(0).default(0),
  }),
  run(c) {
    const db = openDatabase(c.options);
    try {
      const query = db.getPlaylistContents(c.args.id);
      return {
        count: query.count(),
        rows: query.offset(c.options.offset).limit(c.options.limit).all(),
      };
    } finally {
      db.close();
    }
  },
});

databasePlaylistCli.command("create", {
  description: "Create a normal playlist, folder, or smart playlist.",
  args: z.object({ name: z.string().describe("Playlist name") }),
  options: dbWriteOptions.extend({
    parent: z.string().optional().describe("Parent folder ID"),
    seq: z.number().int().positive().optional().describe("One-based sibling sequence"),
    smartXml: z.string().optional().describe("Smart-list NODE XML"),
    type: z.enum(["playlist", "folder", "smart"]).default("playlist"),
  }),
  run(c) {
    requireDatabaseWrite(c.options);
    const db = openDatabase(c.options, true);
    try {
      const options = { parent: c.options.parent, seq: c.options.seq };
      const row =
        c.options.type === "folder"
          ? db.createPlaylistFolder(c.args.name, options)
          : c.options.type === "smart"
            ? db.createSmartPlaylist(
                c.args.name,
                SmartList.fromXml(c.options.smartXml ?? ""),
                options,
              )
            : db.createPlaylist(c.args.name, options);
      db.commit({ allowWhileRunning: c.options.allowWhileRunning });
      return row;
    } finally {
      db.close();
    }
  },
});

databasePlaylistCli.command("add-track", {
  description: "Add content to a normal playlist.",
  args: z.object({
    playlistId: z.string().describe("Playlist ID"),
    contentId: z.string().describe("Content ID"),
  }),
  options: dbWriteOptions.extend({
    trackNumber: z.number().int().positive().optional().describe("One-based insertion point"),
  }),
  run(c) {
    requireDatabaseWrite(c.options);
    const db = openDatabase(c.options, true);
    try {
      const row = db.addToPlaylist(c.args.playlistId, c.args.contentId, c.options.trackNumber);
      db.commit({ allowWhileRunning: c.options.allowWhileRunning });
      return row;
    } finally {
      db.close();
    }
  },
});

databasePlaylistCli.command("remove-track", {
  description: "Remove a playlist-membership row.",
  args: z.object({
    playlistId: z.string().describe("Playlist ID"),
    songId: z.string().describe("djmdSongPlaylist ID"),
  }),
  options: dbWriteOptions,
  run(c) {
    requireDatabaseWrite(c.options);
    const db = openDatabase(c.options, true);
    try {
      db.removeFromPlaylist(c.args.playlistId, c.args.songId);
      db.commit({ allowWhileRunning: c.options.allowWhileRunning });
      return { playlistId: c.args.playlistId, removed: c.args.songId };
    } finally {
      db.close();
    }
  },
});

databasePlaylistCli.command("move", {
  description: "Move a playlist to another parent and/or sequence.",
  args: z.object({ playlistId: z.string().describe("Playlist ID") }),
  options: dbWriteOptions.extend({
    parent: z.string().optional().describe("New parent folder ID"),
    seq: z.number().int().positive().optional().describe("New one-based sequence"),
  }),
  run(c) {
    requireDatabaseWrite(c.options);
    const db = openDatabase(c.options, true);
    try {
      db.movePlaylist(c.args.playlistId, { parent: c.options.parent, seq: c.options.seq });
      db.commit({ allowWhileRunning: c.options.allowWhileRunning });
      return db.query(DjmdPlaylist).where({ ID: c.args.playlistId }).one();
    } finally {
      db.close();
    }
  },
});

databaseCli.command(databaseRowCli);
databaseCli.command(databaseContentCli);
databaseCli.command(databasePlaylistCli);
cli.command(databaseCli);

function playlistPath(xml: RekordboxXml, path: string | undefined) {
  return path ? xml.getPlaylist(...path.split("/").filter(Boolean)) : xml.rootPlaylistFolder;
}

function trackSelector(options: {
  index?: number;
  location?: string;
  trackId?: number;
}): TrackSelector {
  if (options.trackId !== undefined) return { trackId: options.trackId };
  if (options.location !== undefined) return { location: options.location };
  return { index: options.index ?? 0 };
}

const xmlCli = Cli.create("xml", {
  description: "Read and write Rekordbox collection XML files.",
});

xmlCli.command("info", {
  description: "Show collection, product, and playlist metadata.",
  args: z.object({ path: z.string().describe("Rekordbox XML file") }),
  run(c) {
    return new RekordboxXml(c.args.path).summary();
  },
});

xmlCli.command("tracks", {
  description: "List typed collection track metadata.",
  args: z.object({ path: z.string().describe("Rekordbox XML file") }),
  options: z.object({
    limit: z.number().int().min(1).max(10_000).default(100).describe("Maximum tracks to return"),
    offset: z.number().int().min(0).default(0).describe("Tracks to skip"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    return {
      count: xml.numTracks,
      limit: c.options.limit,
      offset: c.options.offset,
      tracks: xml.getTracks().slice(c.options.offset, c.options.offset + c.options.limit),
    };
  },
});

xmlCli.command("playlists", {
  description: "Show a playlist subtree.",
  args: z.object({ path: z.string().describe("Rekordbox XML file") }),
  options: z.object({
    playlist: z.string().optional().describe("Slash-delimited playlist path"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    const node = playlistPath(xml, c.options.playlist);
    return { node: node.toJSON(), tree: node.treeString() };
  },
});

xmlCli.command("create", {
  description: "Create an empty Rekordbox XML file.",
  args: z.object({ output: z.string().describe("Destination XML file") }),
  options: z.object({
    company: z.string().default("").describe("Product company"),
    formatVersion: z.string().default("1.0.0").describe("Rekordbox XML format version"),
    name: z.string().default("rekordbox-ts").describe("Product name"),
    version: z.string().default("0.0.0").describe("Product version"),
  }),
  run(c) {
    const xml = new RekordboxXml({
      company: c.options.company,
      formatVersion: c.options.formatVersion,
      name: c.options.name,
      version: c.options.version,
    });
    xml.save(c.args.output);
    return { output: c.args.output, ...xml.summary() };
  },
});

const xmlTrackCli = Cli.create("track", {
  description: "Inspect and mutate XML collection tracks.",
});

xmlTrackCli.command("show", {
  description: "Show one track selected by index, ID, or location.",
  args: z.object({ path: z.string().describe("Rekordbox XML file") }),
  options: z.object({
    index: z.number().int().min(0).optional().describe("Zero-based collection index"),
    location: z.string().optional().describe("Track filesystem location"),
    trackId: z.number().int().optional().describe("Track ID"),
  }),
  run(c) {
    return new RekordboxXml(c.args.path).getTrack(trackSelector(c.options));
  },
});

xmlTrackCli.command("add", {
  description: "Add a track and save the XML document.",
  args: z.object({
    path: z.string().describe("Rekordbox XML file"),
    location: z.string().describe("Audio-file location"),
  }),
  options: z.object({
    album: z.string().optional().describe("Album"),
    artist: z.string().optional().describe("Artist"),
    genre: z.string().optional().describe("Genre"),
    name: z.string().optional().describe("Track title"),
    output: z.string().optional().describe("Destination; defaults to the source file"),
    rating: z.number().int().min(0).max(5).optional().describe("Rating from zero to five"),
    trackId: z.number().int().positive().optional().describe("Explicit track ID"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    const attributes: TrackAttributes = {
      Album: c.options.album,
      Artist: c.options.artist,
      Genre: c.options.genre,
      Name: c.options.name,
      Rating: c.options.rating,
      TrackID: c.options.trackId,
    };
    const track = xml.addTrack(c.args.location, attributes);
    const output = c.options.output ?? c.args.path;
    xml.save(output);
    return { output, track };
  },
});

xmlTrackCli.command("remove", {
  description: "Remove a track and save the XML document.",
  args: z.object({ path: z.string().describe("Rekordbox XML file") }),
  options: z.object({
    location: z.string().optional().describe("Track filesystem location"),
    output: z.string().optional().describe("Destination; defaults to the source file"),
    trackId: z.number().int().optional().describe("Track ID"),
  }),
  run(c) {
    if (c.options.trackId === undefined && c.options.location === undefined)
      throw new TypeError("Either --track-id or --location is required");
    const xml = new RekordboxXml(c.args.path);
    const selector: TrackSelector =
      c.options.trackId !== undefined
        ? { trackId: c.options.trackId }
        : { location: c.options.location! };
    const track = xml.getTrack(selector);
    const removed = track.toJSON();
    xml.removeTrack(track);
    const output = c.options.output ?? c.args.path;
    xml.save(output);
    return { output, removed };
  },
});

const xmlPlaylistCli = Cli.create("playlist", {
  description: "Inspect and mutate XML playlists and folders.",
});

xmlPlaylistCli.command("add", {
  description: "Add a playlist or folder and save the XML document.",
  args: z.object({
    path: z.string().describe("Rekordbox XML file"),
    name: z.string().describe("New playlist or folder name"),
  }),
  options: z.object({
    folder: z.boolean().default(false).describe("Create a folder instead of a playlist"),
    keyType: z.enum(["TrackID", "Location"]).default("TrackID").describe("Playlist key type"),
    output: z.string().optional().describe("Destination; defaults to the source file"),
    parent: z.string().optional().describe("Slash-delimited parent folder path"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    const parent = playlistPath(xml, c.options.parent);
    const node = c.options.folder
      ? parent.addPlaylistFolder(c.args.name)
      : parent.addPlaylist(c.args.name, c.options.keyType as NodeKeyType);
    const output = c.options.output ?? c.args.path;
    xml.save(output);
    return { node: node.toJSON(), output };
  },
});

xmlPlaylistCli.command("remove", {
  description: "Remove a playlist or folder and save the XML document.",
  args: z.object({
    path: z.string().describe("Rekordbox XML file"),
    name: z.string().describe("Playlist or folder name"),
  }),
  options: z.object({
    output: z.string().optional().describe("Destination; defaults to the source file"),
    parent: z.string().optional().describe("Slash-delimited parent folder path"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    playlistPath(xml, c.options.parent).removePlaylist(c.args.name);
    const output = c.options.output ?? c.args.path;
    xml.save(output);
    return { output, removed: c.args.name };
  },
});

xmlPlaylistCli.command("add-track", {
  description: "Add a track key to a playlist and save the XML document.",
  args: z.object({
    path: z.string().describe("Rekordbox XML file"),
    playlist: z.string().describe("Slash-delimited playlist path"),
    key: z.string().describe("Track ID or location, according to playlist KeyType"),
  }),
  options: z.object({
    output: z.string().optional().describe("Destination; defaults to the source file"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    const playlist = playlistPath(xml, c.args.playlist);
    const key = playlist.keyType === "TrackID" ? Number.parseInt(c.args.key, 10) : c.args.key;
    playlist.addTrack(key);
    const output = c.options.output ?? c.args.path;
    xml.save(output);
    return { entries: playlist.entries, key, output, playlist: c.args.playlist };
  },
});

xmlPlaylistCli.command("remove-track", {
  description: "Remove a track key from a playlist and save the XML document.",
  args: z.object({
    path: z.string().describe("Rekordbox XML file"),
    playlist: z.string().describe("Slash-delimited playlist path"),
    key: z.string().describe("Track ID or location, according to playlist KeyType"),
  }),
  options: z.object({
    output: z.string().optional().describe("Destination; defaults to the source file"),
  }),
  run(c) {
    const xml = new RekordboxXml(c.args.path);
    const playlist = playlistPath(xml, c.args.playlist);
    const key = playlist.keyType === "TrackID" ? Number.parseInt(c.args.key, 10) : c.args.key;
    playlist.removeTrack(key);
    const output = c.options.output ?? c.args.path;
    xml.save(output);
    return { entries: playlist.entries, key, output, playlist: c.args.playlist };
  },
});

xmlCli.command(xmlTrackCli);
xmlCli.command(xmlPlaylistCli);
cli.command(xmlCli);

cli.serve();

export default cli;
