import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

import Database from "better-sqlite3-multiple-ciphers";
import { Cli } from "incur";
import { afterEach, describe, expect, it } from "vitest";

import { rekordboxCli } from "../src/cli.js";
import { MasterDatabase } from "../src/index.js";
import {
  acquireCueWriteLock,
  assertContentCueMirrorMatches,
  performGuardedCueMutation,
} from "../src/masterdb/safe-cue-write.js";

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function runCli(...args: Array<string>) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 15_000,
  });
}

function playlistFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "rekordbox-ts-cli-playlist-"));
  roots.push(root);
  const path = join(root, "plain.db");
  const database = new Database(path);
  database.exec(`
    CREATE TABLE djmdPlaylist (
      ID TEXT PRIMARY KEY, Name TEXT, Attribute INTEGER, ParentID TEXT, Seq INTEGER, SmartList TEXT
    );
    CREATE TABLE djmdSongPlaylist (
      ID TEXT PRIMARY KEY, PlaylistID TEXT, ContentID TEXT, TrackNo INTEGER
    );
    CREATE TABLE djmdArtist (ID TEXT PRIMARY KEY, Name TEXT);
    CREATE TABLE djmdKey (ID TEXT PRIMARY KEY, ScaleName TEXT);
    CREATE TABLE djmdContent (
      ID TEXT PRIMARY KEY, FolderPath TEXT, Title TEXT, ArtistID TEXT, BPM INTEGER, KeyID TEXT,
      Length INTEGER, FileType INTEGER, Analysed INTEGER
    );

    INSERT INTO djmdPlaylist VALUES ('folder-1', 'DJ Sets', 1, 'root', 1, NULL);
    INSERT INTO djmdPlaylist VALUES ('playlist-1', 'Festival Set', 0, 'folder-1', 1, NULL);
    INSERT INTO djmdArtist VALUES ('artist-1', 'First Artist');
    INSERT INTO djmdArtist VALUES ('artist-2', 'Second Artist');
    INSERT INTO djmdKey VALUES ('key-1', '10A');
    INSERT INTO djmdKey VALUES ('key-2', '7B');
    INSERT INTO djmdContent VALUES (
      '900', '/Music/Second.flac', 'Second Track', 'artist-2', 12801, 'key-1', 165, 5, 105
    );
    INSERT INTO djmdContent VALUES (
      '100', '/Music/First.m4a', 'First Track', 'artist-1', 12400, 'key-2', NULL, 4, 105
    );
    INSERT INTO djmdSongPlaylist VALUES ('membership-2', 'playlist-1', '900', 2);
    INSERT INTO djmdSongPlaylist VALUES ('membership-1', 'playlist-1', '100', 1);
    INSERT INTO djmdSongPlaylist VALUES ('membership-3', 'playlist-1', '900', 3);
  `);
  database.close();
  return path;
}

function cueFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "rekordbox-ts-cli-cues-"));
  roots.push(root);
  const path = join(root, "plain.db");
  const database = new Database(path);
  const now = "2026-07-13 12:00:00.000 +00:00";
  database.exec(`
    CREATE TABLE agentRegistry (
      registry_id TEXT PRIMARY KEY, int_1 INTEGER, created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    );
    CREATE TABLE djmdContent (
      ID TEXT PRIMARY KEY, UUID TEXT, Length INTEGER, CueUpdated TEXT,
      rb_local_deleted INTEGER DEFAULT 0, rb_local_usn INTEGER,
      created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
    );
    CREATE TABLE djmdCue (
      ID TEXT PRIMARY KEY, ContentID TEXT, InMsec INTEGER, InFrame INTEGER,
      InMpegFrame INTEGER, InMpegAbs INTEGER, OutMsec INTEGER, OutFrame INTEGER,
      OutMpegFrame INTEGER, OutMpegAbs INTEGER, Kind INTEGER, Color INTEGER,
      ColorTableIndex INTEGER, ActiveLoop INTEGER, Comment TEXT, BeatLoopSize INTEGER,
      CueMicrosec INTEGER, InPointSeekInfo TEXT, OutPointSeekInfo TEXT, ContentUUID TEXT,
      UUID TEXT, rb_data_status INTEGER DEFAULT 0, rb_local_data_status INTEGER DEFAULT 0,
      rb_local_deleted INTEGER DEFAULT 0, rb_local_synced INTEGER DEFAULT 0, usn INTEGER,
      rb_local_usn INTEGER, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
    );
    CREATE TABLE contentCue (
      ID TEXT PRIMARY KEY, ContentID TEXT, Cues TEXT, rb_cue_count INTEGER, UUID TEXT,
      rb_data_status INTEGER DEFAULT 0, rb_local_data_status INTEGER DEFAULT 0,
      rb_local_deleted INTEGER DEFAULT 0, rb_local_synced INTEGER DEFAULT 0, usn INTEGER,
      rb_local_usn INTEGER, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
    );
    INSERT INTO agentRegistry VALUES ('localUpdateCount', 100, '${now}', '${now}');
    INSERT INTO djmdContent VALUES (
      'track-1', 'content-uuid-1', 300, NULL, 0, 1, '${now}', '${now}'
    );
  `);
  database.close();
  writeFileSync(
    join(root, "masterPlaylists6.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<MASTER_PLAYLIST Version="3.0.0" AutomaticSync="0">
  <PRODUCT Name="rekordbox" Version="7.2.1" Company="AlphaTheta"/>
  <PLAYLISTS/>
</MASTER_PLAYLIST>
`,
  );
  return path;
}

describe("CLI process boundary", () => {
  it("serves the named CLI and machine-readable status", () => {
    const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };
    const version = runCli("--version");
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe(packageJson.version);

    const status = runCli("status", "--json");
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      name: "@gakonst/rekordbox",
      version: packageJson.version,
      phase: "complete-port",
    });

    const llms = runCli("--llms");
    expect(llms.status, llms.stderr).toBe(0);
    expect(llms.stdout).toContain("# rekordbox");
    expect(llms.stdout).toContain("rekordbox db table");
    expect(llms.stdout).toContain("rekordbox db playlist list");
    expect(llms.stdout).toContain("rekordbox db playlist show");
    expect(llms.stdout).toContain("rekordbox stems separate");
  }, 20_000);

  it("exports an import-safe CLI that composes as a child command", async () => {
    let output = "";
    let exitCode: number | undefined;
    const parent = Cli.create("music");
    parent.command(rekordboxCli);

    await parent.serve(["rekordbox", "status", "--json"], {
      stdout(value) {
        output += value;
      },
      exit(code) {
        exitCode = code;
      },
    });

    expect(rekordboxCli.name).toBe("rekordbox");
    expect(exitCode).toBeUndefined();
    expect(JSON.parse(output)).toMatchObject({ name: "@gakonst/rekordbox" });
  });

  it("queries a plain database and rejects non-object filters", () => {
    const root = mkdtempSync(join(tmpdir(), "rekordbox-ts-cli-"));
    roots.push(root);
    const path = join(root, "plain.db");
    const database = new Database(path);
    database.exec("CREATE TABLE sample (ID TEXT PRIMARY KEY, Name TEXT)");
    database.prepare("INSERT INTO sample VALUES (?, ?)").run("1", "needle");
    database.close();

    const result = runCli(
      "db",
      "table",
      "sample",
      "--path",
      path,
      "--plain",
      "--filters",
      '{"Name":"needle"}',
      "--json",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ count: 1, table: "sample" });

    const sql = runCli(
      "db",
      "sql",
      "SELECT Name FROM sample WHERE ID = ?",
      "--path",
      path,
      "--plain",
      "--parameters",
      '["1"]',
      "--json",
    );
    expect(sql.status, sql.stderr).toBe(0);
    expect(JSON.parse(sql.stdout)).toMatchObject({ count: 1, rows: [{ Name: "needle" }] });

    const invalid = runCli(
      "db",
      "table",
      "sample",
      "--path",
      path,
      "--plain",
      "--filters",
      "[]",
      "--json",
    );
    expect(invalid.status).not.toBe(0);
    expect(`${invalid.stdout}\n${invalid.stderr}`).toContain("filters must be a JSON object");
  }, 20_000);

  it("requires write mode for arbitrary SQL mutations", () => {
    const root = mkdtempSync(join(tmpdir(), "rekordbox-ts-cli-sql-"));
    roots.push(root);
    const path = join(root, "plain.db");
    const database = new Database(path);
    database.exec("CREATE TABLE sample (ID TEXT PRIMARY KEY)");
    database.close();

    const result = runCli(
      "db",
      "sql",
      "INSERT INTO sample VALUES ('1')",
      "--path",
      path,
      "--plain",
      "--json",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ changes: 1 });
  }, 20_000);

  it("lists the complete playlist hierarchy as JSON and a compact table", () => {
    const path = playlistFixture();
    const database = new Database(path);
    database.exec(`
      INSERT INTO djmdPlaylist VALUES ('folder-2', 'Club / Sets', 1, 'folder-1', 2, NULL);
      INSERT INTO djmdPlaylist VALUES (
        'smart-1', 'Smart Picks', 4, 'folder-2', 1,
        '<NODE Id="1" LogicalOperator="1" AutomaticUpdate="1"><CONDITION PropertyName="artist" Operator="1" ValueUnit="" ValueLeft="First Artist" ValueRight=""/></NODE>'
      );
    `);
    database.close();

    const json = runCli("db", "playlist", "list", "--path", path, "--plain", "--json");
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      summary: { total: 4, playlists: 1, smartPlaylists: 1, folders: 2 },
      filter: { type: "all" },
      page: { total: 4, offset: 0, limit: null, returned: 4, hasMore: false },
      entries: [
        {
          path: "DJ Sets",
          type: "folder",
          trackCount: null,
          childCount: 2,
          id: "folder-1",
          name: "DJ Sets",
          parentId: "root",
          sequence: 1,
          depth: 0,
          pathSegments: ["DJ Sets"],
          idPath: ["folder-1"],
        },
        {
          path: "DJ Sets › Festival Set",
          type: "playlist",
          trackCount: 3,
          childCount: 0,
          id: "playlist-1",
          name: "Festival Set",
          parentId: "folder-1",
          sequence: 1,
          depth: 1,
          pathSegments: ["DJ Sets", "Festival Set"],
          idPath: ["folder-1", "playlist-1"],
        },
        {
          path: "DJ Sets › Club / Sets",
          type: "folder",
          trackCount: null,
          childCount: 1,
          id: "folder-2",
          name: "Club / Sets",
          parentId: "folder-1",
          sequence: 2,
          depth: 1,
          pathSegments: ["DJ Sets", "Club / Sets"],
          idPath: ["folder-1", "folder-2"],
        },
        {
          path: "DJ Sets › Club / Sets › Smart Picks",
          type: "smart",
          trackCount: 1,
          childCount: 0,
          id: "smart-1",
          name: "Smart Picks",
          parentId: "folder-2",
          sequence: 1,
          depth: 2,
          pathSegments: ["DJ Sets", "Club / Sets", "Smart Picks"],
          idPath: ["folder-1", "folder-2", "smart-1"],
        },
      ],
    });

    const markdown = runCli("db", "playlist", "list", "--path", path, "--plain");
    expect(markdown.status, markdown.stderr).toBe(0);
    expect(markdown.stdout).toContain("## entries");
    expect(markdown.stdout).toContain("| path");
    expect(markdown.stdout).toContain("DJ Sets › Club / Sets › Smart Picks");
    expect(markdown.stdout).not.toContain("pathSegments");

    const page = runCli(
      "db",
      "playlist",
      "list",
      "--path",
      path,
      "--plain",
      "--type",
      "playable",
      "--limit",
      "1",
      "--offset",
      "1",
      "--json",
    );
    expect(page.status, page.stderr).toBe(0);
    expect(JSON.parse(page.stdout)).toMatchObject({
      filter: { type: "playable" },
      page: { total: 2, offset: 1, limit: 1, returned: 1, hasMore: false },
      entries: [{ id: "smart-1", type: "smart" }],
    });
  }, 20_000);

  it("shows an exact-name playlist as ordered JSON and Markdown", () => {
    const path = playlistFixture();
    const json = runCli(
      "db",
      "playlist",
      "show",
      "Festival Set",
      "--path",
      path,
      "--plain",
      "--json",
    );
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      playlist: {
        id: "playlist-1",
        name: "Festival Set",
        parentId: "folder-1",
        type: "playlist",
        count: 3,
      },
      page: {
        offset: 0,
        limit: null,
        returned: 3,
        hasMore: false,
      },
      tracks: [
        {
          position: 1,
          artist: "First Artist",
          title: "First Track",
          bpm: 124,
          key: "7B",
          duration: null,
          format: "M4A",
          analyzed: 105,
          contentId: "100",
          durationSeconds: null,
          fileType: 4,
          membershipId: "membership-1",
          path: "/Music/First.m4a",
        },
        {
          position: 2,
          artist: "Second Artist",
          title: "Second Track",
          bpm: 128.01,
          key: "10A",
          duration: "2:45",
          format: "FLAC",
          analyzed: 105,
          contentId: "900",
          durationSeconds: 165,
          fileType: 5,
          membershipId: "membership-2",
          path: "/Music/Second.flac",
        },
        {
          position: 3,
          artist: "Second Artist",
          title: "Second Track",
          bpm: 128.01,
          key: "10A",
          duration: "2:45",
          format: "FLAC",
          analyzed: 105,
          contentId: "900",
          durationSeconds: 165,
          fileType: 5,
          membershipId: "membership-3",
          path: "/Music/Second.flac",
        },
      ],
    });

    const markdown = runCli("db", "playlist", "show", "Festival Set", "--path", path, "--plain");
    expect(markdown.status, markdown.stderr).toBe(0);
    expect(markdown.stdout).toContain("## playlist");
    expect(markdown.stdout).toContain("## tracks");
    expect(markdown.stdout).toContain("| position | artist");
    expect(markdown.stdout).toContain("| 2        | Second Artist");
    expect(markdown.stdout).not.toContain("contentId");
    expect(markdown.stdout).not.toContain("/Music/Second.flac");
  }, 20_000);

  it("returns every track by default and reports explicit pagination", () => {
    const path = playlistFixture();
    const database = new Database(path);
    const insert = database.prepare(
      "INSERT INTO djmdSongPlaylist VALUES (?, 'playlist-1', '900', ?)",
    );
    const addRows = database.transaction(() => {
      for (let position = 4; position <= 104; position++)
        insert.run(`membership-${position}`, position);
    });
    addRows();
    database.close();

    const complete = runCli(
      "db",
      "playlist",
      "show",
      "Festival Set",
      "--path",
      path,
      "--plain",
      "--json",
    );
    expect(complete.status, complete.stderr).toBe(0);
    expect(JSON.parse(complete.stdout)).toMatchObject({
      playlist: { count: 104 },
      page: { offset: 0, limit: null, returned: 104, hasMore: false },
    });

    const page = runCli(
      "db",
      "playlist",
      "show",
      "Festival Set",
      "--path",
      path,
      "--plain",
      "--limit",
      "2",
      "--offset",
      "1",
      "--json",
    );
    expect(page.status, page.stderr).toBe(0);
    expect(JSON.parse(page.stdout)).toMatchObject({
      playlist: { count: 104 },
      page: { offset: 1, limit: 2, returned: 2, hasMore: true },
      tracks: [{ position: 2 }, { position: 3 }],
    });
  }, 20_000);

  it("shows joined smart-playlist criteria and fails closed on unsupported criteria", () => {
    const path = playlistFixture();
    const database = new Database(path);
    const insert = database.prepare("INSERT INTO djmdPlaylist VALUES (?, ?, 4, 'folder-1', ?, ?)");
    insert.run(
      "smart-1",
      "Smart Festival Set",
      2,
      '<NODE Id="1" LogicalOperator="1" AutomaticUpdate="1"><CONDITION PropertyName="artist" Operator="1" ValueUnit="" ValueLeft="First Artist" ValueRight=""/><CONDITION PropertyName="key" Operator="1" ValueUnit="" ValueLeft="7B" ValueRight=""/></NODE>',
    );
    insert.run(
      "smart-2",
      "Unsupported Smart Set",
      3,
      '<NODE Id="2" LogicalOperator="1" AutomaticUpdate="1"><CONDITION PropertyName="mixName" Operator="1" ValueUnit="" ValueLeft="Club Mix" ValueRight=""/></NODE>',
    );
    database.close();

    const supported = runCli(
      "db",
      "playlist",
      "show",
      "Smart Festival Set",
      "--path",
      path,
      "--plain",
      "--json",
    );
    expect(supported.status, supported.stderr).toBe(0);
    expect(JSON.parse(supported.stdout)).toMatchObject({
      playlist: { count: 1, id: "smart-1", type: "smart" },
      tracks: [{ artist: "First Artist", contentId: "100", key: "7B", position: 1 }],
    });

    const unsupported = runCli(
      "db",
      "playlist",
      "show",
      "Unsupported Smart Set",
      "--path",
      path,
      "--plain",
      "--json",
    );
    expect(unsupported.status).not.toBe(0);
    expect(`${unsupported.stdout}\n${unsupported.stderr}`).toContain(
      "uses unsupported criteria: mixName",
    );
  }, 20_000);

  it("fails safely on ambiguous playlist names and accepts a parent ID", () => {
    const path = playlistFixture();
    const database = new Database(path);
    database.exec(`
      INSERT INTO djmdPlaylist VALUES ('folder-2', 'Archive', 1, 'root', 2, NULL);
      INSERT INTO djmdPlaylist VALUES ('playlist-2', 'Festival Set', 0, 'folder-2', 1, NULL);
    `);
    database.close();

    const ambiguous = runCli(
      "db",
      "playlist",
      "show",
      "Festival Set",
      "--path",
      path,
      "--plain",
      "--json",
    );
    expect(ambiguous.status).not.toBe(0);
    expect(`${ambiguous.stdout}\n${ambiguous.stderr}`).toContain(
      "Multiple playlists named 'Festival Set' match",
    );
    expect(`${ambiguous.stdout}\n${ambiguous.stderr}`).toContain("playlist-1 (parent folder-1)");
    expect(`${ambiguous.stdout}\n${ambiguous.stderr}`).toContain("playlist-2 (parent folder-2)");

    const selected = runCli(
      "db",
      "playlist",
      "show",
      "Festival Set",
      "--parent-id",
      "folder-1",
      "--path",
      path,
      "--plain",
      "--json",
    );
    expect(selected.status, selected.stderr).toBe(0);
    expect(JSON.parse(selected.stdout).playlist.id).toBe("playlist-1");
  }, 20_000);

  it("accepts an ID when duplicate names share one parent", () => {
    const path = playlistFixture();
    const database = new Database(path);
    database.exec(
      "INSERT INTO djmdPlaylist VALUES ('playlist-2', 'Festival Set', 0, 'folder-1', 2, NULL)",
    );
    database.close();

    const stillAmbiguous = runCli(
      "db",
      "playlist",
      "show",
      "Festival Set",
      "--parent-id",
      "folder-1",
      "--path",
      path,
      "--plain",
      "--json",
    );
    expect(stillAmbiguous.status).not.toBe(0);
    expect(`${stillAmbiguous.stdout}\n${stillAmbiguous.stderr}`).toContain(
      "Pass --parent-id or --id",
    );

    const selected = runCli(
      "db",
      "playlist",
      "show",
      "Festival Set",
      "--id",
      "playlist-2",
      "--path",
      path,
      "--plain",
      "--json",
    );
    expect(selected.status, selected.stderr).toBe(0);
    expect(JSON.parse(selected.stdout)).toMatchObject({
      playlist: { id: "playlist-2", count: 0 },
      page: { returned: 0, hasMore: false },
    });
  }, 20_000);

  it("runs database mutations without acknowledgement flags", () => {
    const result = runCli("db", "row", "create", "--help");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("--write");
    expect(result.stdout).not.toContain("allow-while-running");
  }, 20_000);

  it("lists, sets, updates, and deletes normalized content cues", () => {
    const path = cueFixture();
    const memory = runCli(
      "db",
      "content",
      "set-cue",
      "track-1",
      "12.3454",
      "--comment",
      "Intro",
      "--path",
      path,
      "--plain",
      "--json",
    );
    expect(memory.status, memory.stderr).toBe(0);
    const memoryReceipt = JSON.parse(memory.stdout) as { cue: { id: string } };
    expect(memoryReceipt).toMatchObject({
      operation: "set-cue",
      quickCheck: "ok",
      foreignKeyViolationCount: 0,
      semanticVerification: "exact",
      cue: {
        activeLoop: false,
        color: null,
        comment: "Intro",
        contentId: "track-1",
        endSeconds: null,
        kind: "memory",
        slot: null,
        startSeconds: 12.345,
        type: "cue",
      },
    });
    const committed = new Database(path, { readonly: true });
    expect(
      (
        committed
          .prepare("SELECT int_1 AS count FROM agentRegistry WHERE registry_id = ?")
          .get("localUpdateCount") as { count: number }
      ).count,
    ).toBe(104);
    expect(
      (
        committed
          .prepare("SELECT CueUpdated AS value FROM djmdContent WHERE ID = ?")
          .get("track-1") as { value: string }
      ).value,
    ).toBe("1");
    const mirror = committed
      .prepare("SELECT Cues FROM contentCue WHERE ContentID = ? AND rb_local_deleted = 0")
      .get("track-1") as { Cues: string };
    expect(JSON.parse(mirror.Cues)).toEqual([
      expect.objectContaining({ ID: memoryReceipt.cue.id, ContentID: "track-1" }),
    ]);
    committed.close();

    const hot = runCli(
      "db",
      "content",
      "set-cue",
      "track-1",
      "20",
      "--kind",
      "hot",
      "--slot",
      "P",
      "--type",
      "loop",
      "--end-seconds",
      "24.5",
      "--active-loop",
      "--comment",
      "Drop",
      "--color",
      "255",
      "--color-table-index",
      "36",
      "--path",
      path,
      "--plain",
      "--json",
    );
    expect(hot.status, hot.stderr).toBe(0);
    const hotReceipt = JSON.parse(hot.stdout) as { cue: { id: string } };
    const hotCue = hotReceipt.cue;
    expect(hotReceipt).toMatchObject({
      operation: "set-cue",
      cue: {
        activeLoop: true,
        color: 255,
        colorTableIndex: 36,
        endSeconds: 24.5,
        kind: "hot",
        slot: 16,
        startSeconds: 20,
        type: "loop",
      },
    });

    const updated = runCli(
      "db",
      "content",
      "set-cue",
      "track-1",
      "21",
      "--id",
      hotCue.id,
      "--path",
      path,
      "--plain",
      "--json",
    );
    expect(updated.status, updated.stderr).toBe(0);
    expect(JSON.parse(updated.stdout)).toMatchObject({
      operation: "set-cue",
      cue: {
        activeLoop: true,
        color: 255,
        colorTableIndex: 36,
        comment: "Drop",
        endSeconds: 24.5,
        id: hotCue.id,
        kind: "hot",
        slot: 16,
        startSeconds: 21,
        type: "loop",
      },
    });

    const cleared = runCli(
      "db",
      "content",
      "set-cue",
      "track-1",
      "22",
      "--id",
      hotCue.id,
      "--no-active-loop",
      "--clear-comment",
      "--clear-color",
      "--clear-color-table-index",
      "--path",
      path,
      "--plain",
      "--json",
    );
    expect(cleared.status, cleared.stderr).toBe(0);
    expect(JSON.parse(cleared.stdout)).toMatchObject({
      operation: "set-cue",
      cue: {
        activeLoop: false,
        color: null,
        colorTableIndex: null,
        comment: "",
        endSeconds: 24.5,
        id: hotCue.id,
        kind: "hot",
        slot: 16,
        startSeconds: 22,
        type: "loop",
      },
    });

    const page = runCli(
      "db",
      "content",
      "cues",
      "track-1",
      "--limit",
      "1",
      "--offset",
      "1",
      "--path",
      path,
      "--plain",
      "--json",
    );
    expect(page.status, page.stderr).toBe(0);
    expect(JSON.parse(page.stdout)).toMatchObject({
      contentId: "track-1",
      count: 2,
      limit: 1,
      offset: 1,
      rows: [{ id: hotCue.id, kind: "hot", slot: 16 }],
    });

    const deleted = runCli(
      "db",
      "content",
      "delete-cue",
      "track-1",
      hotCue.id,
      "--path",
      path,
      "--plain",
      "--json",
    );
    expect(deleted.status, deleted.stderr).toBe(0);
    expect(JSON.parse(deleted.stdout)).toMatchObject({
      operation: "delete-cue",
      contentId: "track-1",
      deleted: { id: hotCue.id, kind: "hot", slot: 16 },
      quickCheck: "ok",
      semanticVerification: "exact",
    });

    const invalid = runCli(
      "db",
      "content",
      "set-cue",
      "track-1",
      "30",
      "--kind",
      "hot",
      "--path",
      path,
      "--plain",
      "--json",
    );
    expect(invalid.status).not.toBe(0);
    expect(`${invalid.stdout}\n${invalid.stderr}`).toContain("require --slot A through P");
  }, 40_000);

  it("coordinates cue writes through the exact shared tracks-ts lock", async () => {
    const path = cueFixture();
    const alias = `${path}.alias`;
    symlinkSync(path, alias);
    const canonicalPath = realpathSync(path);
    const lock = await acquireCueWriteLock(alias);
    expect(lock.path).toBe(`${canonicalPath}.tracks-ts.lock`);
    try {
      await expect(
        performGuardedCueMutation(
          {
            dbPath: path,
            unlock: false,
          },
          {
            type: "set-cue",
            contentId: "track-1",
            cue: { kind: "memory", startSeconds: 10, type: "cue" },
          },
        ),
      ).rejects.toThrow(`write lock already exists: ${canonicalPath}.tracks-ts.lock`);
    } finally {
      await lock.release();
    }
    expect(existsSync(`${canonicalPath}.tracks-ts.lock`)).toBe(false);
  });

  it("serializes concurrent cue-writer recovery of one stale shared lock", async () => {
    const path = cueFixture();
    const canonicalPath = realpathSync(path);
    const lockPath = `${canonicalPath}.tracks-ts.lock`;
    writeFileSync(lockPath, "{}\n");
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    utimesSync(lockPath, stale, stale);

    const results = await Promise.allSettled([
      acquireCueWriteLock(path),
      acquireCueWriteLock(path),
    ]);
    const acquired = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(acquired).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);

    await acquired[0]!.release();
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${lockPath}.acquire`)).toBe(false);
  });

  it("does not remove a replacement shared lock on cue-writer release", async () => {
    const path = cueFixture();
    const canonicalPath = realpathSync(path);
    const lock = await acquireCueWriteLock(path);
    rmSync(lock.path);
    const replacement = { pid: process.pid, token: "replacement-owner" };
    writeFileSync(lock.path, `${JSON.stringify(replacement)}\n`);

    await lock.release();

    expect(JSON.parse(readFileSync(lock.path, "utf8"))).toEqual(replacement);
    expect(existsSync(`${canonicalPath}.tracks-ts.lock.acquire`)).toBe(false);
  });

  it("detects semantic contentCue corruption despite matching cue IDs", async () => {
    const path = cueFixture();
    await performGuardedCueMutation(
      {
        dbPath: path,
        unlock: false,
      },
      {
        type: "set-cue",
        contentId: "track-1",
        cue: { kind: "memory", startSeconds: 10, type: "cue" },
      },
    );
    const raw = new Database(path);
    const row = raw
      .prepare("SELECT ID, Cues FROM contentCue WHERE ContentID = ?")
      .get("track-1") as {
      ID: string;
      Cues: string;
    };
    const entries = JSON.parse(row.Cues) as Array<Record<string, unknown>>;
    Object.assign(entries[0]!, {
      ActiveLoop: 1,
      Color: 7,
      Comment: "corrupt",
      InMsec: 99_000,
      OutMsec: 150_000,
    });
    raw.prepare("UPDATE contentCue SET Cues = ? WHERE ID = ?").run(JSON.stringify(entries), row.ID);
    raw.close();

    const probe = new MasterDatabase({ path, readonly: true, unlock: false });
    try {
      expect(() => assertContentCueMirrorMatches(probe, "track-1")).toThrow(
        "contentCue.Cues mismatch",
      );
    } finally {
      probe.close();
    }
  });
});
