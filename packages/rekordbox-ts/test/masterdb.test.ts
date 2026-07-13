import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnlzFile } from "../src/anlz/index.js";

import {
  DatabaseRow,
  DjmdAlbum,
  DjmdArtist,
  DjmdCategory,
  DjmdContent,
  DjmdHistory,
  DjmdMixerParam,
  DjmdMyTag,
  DjmdPlaylist,
  DjmdRelatedTracks,
  DjmdSampler,
  DjmdSongHistory,
  DjmdSongMyTag,
  DjmdSongPlaylist,
  DjmdSongRelatedTracks,
  DjmdSongSampler,
  DjmdSort,
  MasterDatabase,
  MasterPlaylistXml,
  LogicalOperator,
  Operator,
  PlaylistType,
  Property,
  SmartList,
  normalizeRekordboxKeyName,
  stringToDatetime,
} from "../src/masterdb/index.js";

class DefaultRow extends DatabaseRow {
  static override tableName = "defaults";
}

const roots: Array<string> = [];
const now = "2026-07-10 12:00:00.000 +00:00";

function analysisFixture(path: string): Buffer {
  const encoded = Buffer.from(path, "utf16le");
  encoded.swap16();
  const content = Buffer.alloc(4 + encoded.length + 2);
  content.writeUInt32BE(encoded.length + 2, 0);
  encoded.copy(content, 4);
  const tag = Buffer.alloc(12 + content.length);
  tag.write("PPTH", 0, "ascii");
  tag.writeUInt32BE(16, 4);
  tag.writeUInt32BE(tag.length, 8);
  content.copy(tag, 12);
  const header = Buffer.alloc(28);
  header.write("PMAI", 0, "ascii");
  header.writeUInt32BE(28, 4);
  header.writeUInt32BE(header.length + tag.length, 8);
  return Buffer.concat([header, tag]);
}

function writeAnalysisSummary(
  directory: string,
  audioPath: string,
  values: { key?: string | null; tempoBpm?: number | null } = {},
): void {
  const source = statSync(audioPath);
  const summaryPath = join(directory, "analysis.json");
  writeFileSync(
    summaryPath,
    `${JSON.stringify({
      analyzePath: join(directory, "ANLZ0000.DAT"),
      audioPath: realpathSync(audioPath),
      backend: "test",
      binary: "/test/rekordbox-analyzer",
      callbackError: null,
      callbackStatus: 0,
      contentId: 1,
      nativeLog: join(directory, "rehost-native.log"),
      outputs: ["DAT", "EXT", "2EX"].map((type) => [
        join(directory, `ANLZ0000.${type}`),
        statSync(join(directory, `ANLZ0000.${type}`)).size,
      ]),
      source: { mtimeMs: source.mtimeMs, path: realpathSync(audioPath), size: source.size },
      startResult: 0,
      summary: {
        beat_grid: null,
        files: [],
        key: values.key === undefined ? "Bm" : values.key,
        key_source: "test",
        tempo_bpm: values.tempoBpm === undefined ? 128.006_827 : values.tempoBpm,
      },
      summaryPath,
      timings: {
        analyzeStartMs: 0,
        backendMs: 0,
        completionMs: 0,
        loadMs: 0,
        outputPrepareMs: 0,
        summarizeMs: 0,
        totalMs: 0,
      },
    })}\n`,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture(): { dbPath: string; root: string; xmlPath: string } {
  const root = mkdtempSync(join(tmpdir(), "rekordbox-ts-masterdb-"));
  roots.push(root);
  const dbPath = join(root, "master.db");
  const database = new Database(dbPath);
  database.exec(`
    CREATE TABLE agentRegistry (
      registry_id TEXT PRIMARY KEY, int_1 INTEGER, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
    );
    CREATE TABLE djmdArtist (
      ID TEXT PRIMARY KEY, Name TEXT, SearchStr TEXT, UUID TEXT, rb_local_usn INTEGER,
      created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
    );
    CREATE TABLE djmdAlbum (
      ID TEXT PRIMARY KEY, Name TEXT, AlbumArtistID TEXT, ImagePath TEXT, Compilation INTEGER,
      SearchStr TEXT, UUID TEXT, rb_local_usn INTEGER, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
    );
    CREATE TABLE djmdGenre (
      ID TEXT PRIMARY KEY, Name TEXT, UUID TEXT, rb_local_usn INTEGER,
      created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
    );
    CREATE TABLE djmdLabel (
      ID TEXT PRIMARY KEY, Name TEXT, UUID TEXT, rb_local_usn INTEGER,
      created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
    );
    CREATE TABLE djmdKey (ID TEXT PRIMARY KEY, ScaleName TEXT);
    CREATE TABLE djmdDevice (ID TEXT PRIMARY KEY, MasterDBID TEXT, Name TEXT);
    CREATE TABLE djmdContent (
      ID TEXT PRIMARY KEY, FolderPath TEXT, FileNameL TEXT, Title TEXT, ArtistID TEXT, AlbumID TEXT,
      GenreID TEXT, KeyID TEXT, LabelID TEXT, OrgArtistID TEXT, ComposerID TEXT, RemixerID TEXT,
      Commnt TEXT, SearchStr TEXT, AnalysisDataPath TEXT, UUID TEXT, rb_file_id TEXT,
      rb_local_usn INTEGER, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
    );
    CREATE TABLE djmdPlaylist (
      ID TEXT PRIMARY KEY, Seq INTEGER, Name TEXT, ImagePath TEXT, Attribute INTEGER, ParentID TEXT,
      SmartList TEXT, UUID TEXT, rb_local_usn INTEGER, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
    );
    CREATE TABLE djmdSongPlaylist (
      ID TEXT PRIMARY KEY, PlaylistID TEXT, ContentID TEXT, TrackNo INTEGER, UUID TEXT,
      rb_local_usn INTEGER, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
    );
    CREATE TABLE djmdCue (ID TEXT PRIMARY KEY, ContentID TEXT, HotCue INTEGER);
    CREATE TABLE djmdMixerParam (
      ID TEXT PRIMARY KEY, ContentID TEXT, GainHigh INTEGER, GainLow INTEGER, PeakHigh INTEGER, PeakLow INTEGER
    );
    CREATE TABLE djmdActiveCensor (ID TEXT PRIMARY KEY, ContentID TEXT);
    CREATE TABLE djmdMenuItems (ID TEXT PRIMARY KEY, Name TEXT);
    CREATE TABLE djmdCategory (ID TEXT PRIMARY KEY, MenuItemID TEXT, Seq INTEGER);
    CREATE TABLE djmdSort (ID TEXT PRIMARY KEY, MenuItemID TEXT, Seq INTEGER);
    CREATE TABLE djmdMyTag (ID TEXT PRIMARY KEY, Seq INTEGER, Name TEXT, Attribute INTEGER, ParentID TEXT);
    CREATE TABLE djmdSongMyTag (ID TEXT PRIMARY KEY, MyTagID TEXT, ContentID TEXT, TrackNo INTEGER);
    CREATE TABLE djmdHistory (ID TEXT PRIMARY KEY, Seq INTEGER, Name TEXT, ParentID TEXT);
    CREATE TABLE djmdSongHistory (ID TEXT PRIMARY KEY, HistoryID TEXT, ContentID TEXT, TrackNo INTEGER);
    CREATE TABLE djmdRelatedTracks (ID TEXT PRIMARY KEY, Seq INTEGER, Name TEXT, ParentID TEXT);
    CREATE TABLE djmdSongRelatedTracks (ID TEXT PRIMARY KEY, RelatedTracksID TEXT, ContentID TEXT, TrackNo INTEGER);
    CREATE TABLE djmdSampler (ID TEXT PRIMARY KEY, Seq INTEGER, Name TEXT, ParentID TEXT);
    CREATE TABLE djmdSongSampler (ID TEXT PRIMARY KEY, SamplerID TEXT, ContentID TEXT, TrackNo INTEGER);
    CREATE TABLE defaults (ID INTEGER PRIMARY KEY AUTOINCREMENT, Value TEXT DEFAULT 'default');
  `);
  const insert = database.transaction(() => {
    database
      .prepare("INSERT INTO agentRegistry VALUES (?, ?, ?, ?)")
      .run("localUpdateCount", 10, now, now);
    database
      .prepare("INSERT INTO djmdArtist VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("100", "Loopmasters", "loopmasters", "artist-uuid", 1, now, now);
    database
      .prepare("INSERT INTO djmdAlbum VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("150", "Album", "100", null, 0, "album", "album-uuid", 1, now, now);
    database
      .prepare("INSERT INTO djmdGenre VALUES (?, ?, ?, ?, ?, ?)")
      .run("200", "House", "genre-uuid", 2, now, now);
    database.prepare("INSERT INTO djmdKey VALUES (?, ?)").run("300", "Fm");
    database.prepare("INSERT INTO djmdDevice VALUES (?, ?, ?)").run("400", "master", "Device");
    database
      .prepare(
        "INSERT INTO djmdContent VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "1",
        "/Music/Demo 1.mp3",
        "Demo 1.mp3",
        "Demo Track 1",
        "100",
        "150",
        "200",
        "300",
        null,
        null,
        null,
        null,
        "Great",
        "Loopmasters Demo",
        null,
        "content-1",
        "file-1",
        3,
        now,
        now,
      );
    database
      .prepare(
        "INSERT INTO djmdContent VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "2",
        "/Music/Noise.wav",
        "Noise.wav",
        "NOISE",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        "",
        "Noise",
        null,
        "content-2",
        "file-2",
        4,
        now,
        now,
      );
    database
      .prepare("INSERT INTO djmdPlaylist VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("500", 1, "Playlist", null, 0, "root", null, "playlist-uuid", 5, now, now);
    database
      .prepare("INSERT INTO djmdSongPlaylist VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("song-1", "500", "1", 1, "song-uuid", 6, now, now);
    const gain = Buffer.alloc(4);
    gain.writeFloatBE(1, 0);
    database
      .prepare("INSERT INTO djmdMixerParam VALUES (?, ?, ?, ?, ?, ?)")
      .run("mix-1", "1", gain.readUInt16BE(0), gain.readUInt16BE(2), 0, 0);
    database.exec(`
      INSERT INTO djmdActiveCensor VALUES ('censor-1', '1');
      INSERT INTO djmdMenuItems VALUES ('menu-1', 'Menu');
      INSERT INTO djmdCategory VALUES ('category-1', 'menu-1', 1);
      INSERT INTO djmdSort VALUES ('sort-1', 'menu-1', 1);
      INSERT INTO djmdMyTag VALUES ('tag-root', 1, 'Tags', 1, 'root');
      INSERT INTO djmdMyTag VALUES ('tag-1', 1, 'Energy', 0, 'tag-root');
      INSERT INTO djmdSongMyTag VALUES ('tag-song-1', 'tag-1', '1', 1);
      INSERT INTO djmdHistory VALUES ('history-root', 1, 'History', 'root');
      INSERT INTO djmdHistory VALUES ('history-1', 1, 'Today', 'history-root');
      INSERT INTO djmdSongHistory VALUES ('history-song-1', 'history-1', '1', 1);
      INSERT INTO djmdRelatedTracks VALUES ('related-root', 1, 'Related', 'root');
      INSERT INTO djmdRelatedTracks VALUES ('related-1', 1, 'List', 'related-root');
      INSERT INTO djmdSongRelatedTracks VALUES ('related-song-1', 'related-1', '1', 1);
      INSERT INTO djmdSampler VALUES ('sampler-root', 1, 'Sampler', 'root');
      INSERT INTO djmdSampler VALUES ('sampler-1', 1, 'Bank', 'sampler-root');
      INSERT INTO djmdSongSampler VALUES ('sampler-song-1', 'sampler-1', '1', 1);
    `);
  });
  insert();
  database.exec(`
    ALTER TABLE djmdContent ADD COLUMN BPM INTEGER;
    ALTER TABLE djmdContent ADD COLUMN Length INTEGER;
    ALTER TABLE djmdContent ADD COLUMN FileType INTEGER;
    ALTER TABLE djmdContent ADD COLUMN Analysed INTEGER;
    UPDATE djmdContent SET BPM = 12801, Length = 345, FileType = 1, Analysed = 105 WHERE ID = '1';
    UPDATE djmdContent SET FileType = 11, Analysed = 0 WHERE ID = '2';
  `);
  database.close();

  const xmlPath = join(root, "masterPlaylists6.xml");
  writeFileSync(
    xmlPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<MASTER_PLAYLIST Version="3.0.0" AutomaticSync="0">
  <PRODUCT Name="rekordbox" Version="7.0.9" Company="AlphaTheta"/>
  <PLAYLISTS><NODE Id="1F4" ParentId="0" Attribute="0" Timestamp="${new Date("2026-07-10T12:00:00Z").getTime()}" Lib_Type="0" CheckType="0"/></PLAYLISTS>
</MASTER_PLAYLIST>`,
  );
  return { dbPath, root, xmlPath };
}

describe("MasterDatabase queries", () => {
  it("maps rows, dates, relationships, search, and virtual mixer values", () => {
    const { dbPath } = fixture();
    const db = new MasterDatabase({ path: dbPath, readonly: true, unlock: false });
    expect(db.tableNames).toContain("djmdContent");
    expect(db.query(DjmdContent).count()).toBe(2);
    expect(db.query(DjmdContent).limit(1).count()).toBe(1);
    expect(db.query(DjmdContent).offset(1).count()).toBe(1);
    expect(db.query(DjmdContent).limit(0).count()).toBe(0);
    expect(
      db
        .query(DjmdContent)
        .orderBy("ID")
        .offset(1)
        .limit(1)
        .all()
        .map((row) => row.ID),
    ).toEqual(["2"]);

    const content = db.query(DjmdContent).where({ ID: "1" }).one();
    expect(content).toBeInstanceOf(DjmdContent);
    expect(content.Title).toBe("Demo Track 1");
    expect(content.created_at).toBeInstanceOf(Date);
    expect(content.Artist).toBeInstanceOf(DjmdArtist);
    expect(content.Artist?.Name).toBe("Loopmasters");
    expect(db.searchContent("loopmasters").map((row) => row.ID)).toEqual(["1"]);
    expect(
      db
        .getPlaylistContents("500")
        .all()
        .map((row) => row.ID),
    ).toEqual(["1"]);

    const mixer = db.query(DjmdMixerParam).one();
    expect(mixer.Gain).toBeCloseTo(0);
    expect(mixer.Peak).toBe(Number.NEGATIVE_INFINITY);
    expect(() => db.query(DjmdContent).orderBy("ID", "sideways" as never)).toThrow(RangeError);
    db.close();
  });

  it("rejects syntactically valid but impossible dates", () => {
    expect(() => stringToDatetime("2026-99-99 12:00:00 +00:00")).toThrow(TypeError);
    expect(() => stringToDatetime("not-a-date")).toThrow(TypeError);
  });

  it("returns ordered joined playlist memberships without collapsing duplicates", () => {
    const { dbPath } = fixture();
    const fixtureDatabase = new Database(dbPath);
    fixtureDatabase.exec(`
      UPDATE djmdSongPlaylist SET TrackNo = 3 WHERE ID = 'song-1';
      INSERT INTO djmdSongPlaylist VALUES ('song-2', '500', '2', 1, 'song-uuid-2', 7, '${now}', '${now}');
      INSERT INTO djmdSongPlaylist VALUES ('song-3', '500', '1', 2, 'song-uuid-3', 8, '${now}', '${now}');
      INSERT INTO djmdSongPlaylist VALUES ('song-orphan', '500', 'missing', 4, 'song-uuid-4', 9, '${now}', '${now}');
    `);
    fixtureDatabase.close();

    const db = new MasterDatabase({ path: dbPath, readonly: true, unlock: false });
    const tracks = db.getPlaylistTracks("500");
    expect(tracks.map(({ contentId, position }) => [contentId, position])).toEqual([
      ["2", 1],
      ["1", 2],
      ["1", 3],
    ]);
    expect(tracks[1]).toMatchObject({
      analyzed: 105,
      artist: "Loopmasters",
      bpm: 128.01,
      durationSeconds: 345,
      fileType: 1,
      key: "Fm",
      membershipId: "song-3",
      path: "/Music/Demo 1.mp3",
      title: "Demo Track 1",
    });
    expect(db.getPlaylistTracks("500", { limit: 1, offset: 1 })).toEqual([tracks[1]]);
    expect(db.countPlaylistTracks("500")).toBe(3);
    db.close();
  });

  it("lists active playlist metadata with honest regular and smart counts", () => {
    const { dbPath } = fixture();
    const supported = new SmartList();
    supported.playlistId = "502";
    supported.addCondition(Property.ARTIST, Operator.EQUAL, "Loopmasters");
    const unsupported = new SmartList();
    unsupported.playlistId = "503";
    unsupported.addCondition(Property.MIX_NAME, Operator.EQUAL, "Club Mix");
    const fixtureDatabase = new Database(dbPath);
    fixtureDatabase.exec(`
      ALTER TABLE djmdPlaylist ADD COLUMN rb_local_deleted INTEGER DEFAULT 0;
      ALTER TABLE djmdSongPlaylist ADD COLUMN rb_local_deleted INTEGER DEFAULT 0;
      ALTER TABLE djmdContent ADD COLUMN rb_local_deleted INTEGER DEFAULT 0;
      UPDATE djmdContent SET rb_local_deleted = 1, ArtistID = '100' WHERE ID = '2';
      UPDATE djmdPlaylist SET ParentID = '501', Seq = 1 WHERE ID = '500';
    `);
    fixtureDatabase
      .prepare(
        `INSERT INTO djmdPlaylist
          (ID, Seq, Name, ImagePath, Attribute, ParentID, SmartList, UUID, rb_local_usn,
           created_at, updated_at, rb_local_deleted)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("501", 1, "Folder", PlaylistType.FOLDER, "root", null, "folder-uuid", 9, now, now, 0);
    const insertPlaylist = fixtureDatabase.prepare(
      `INSERT INTO djmdPlaylist
        (ID, Seq, Name, ImagePath, Attribute, ParentID, SmartList, UUID, rb_local_usn,
         created_at, updated_at, rb_local_deleted)
       VALUES (?, ?, ?, NULL, ?, '501', ?, ?, ?, ?, ?, ?)`,
    );
    insertPlaylist.run(
      "502",
      2,
      "Supported smart",
      PlaylistType.SMART_PLAYLIST,
      supported.toXml(),
      "smart-uuid",
      10,
      now,
      now,
      0,
    );
    insertPlaylist.run(
      "503",
      3,
      "Unsupported smart",
      PlaylistType.SMART_PLAYLIST,
      unsupported.toXml(),
      "unsupported-uuid",
      11,
      now,
      now,
      0,
    );
    insertPlaylist.run(
      "504",
      4,
      "Deleted",
      PlaylistType.PLAYLIST,
      null,
      "deleted-uuid",
      12,
      now,
      now,
      1,
    );
    fixtureDatabase.exec(`
      INSERT INTO djmdSongPlaylist
        (ID, PlaylistID, ContentID, TrackNo, UUID, rb_local_usn, created_at, updated_at,
         rb_local_deleted)
      VALUES ('song-deleted-content', '500', '2', 2, 'song-dc-uuid', 13, '${now}', '${now}', 0);
      INSERT INTO djmdSongPlaylist
        (ID, PlaylistID, ContentID, TrackNo, UUID, rb_local_usn, created_at, updated_at,
         rb_local_deleted)
      VALUES ('song-deleted-membership', '500', '1', 3, 'song-dm-uuid', 14, '${now}', '${now}', 1);
      INSERT INTO djmdSongPlaylist
        (ID, PlaylistID, ContentID, TrackNo, UUID, rb_local_usn, created_at, updated_at,
         rb_local_deleted)
      VALUES ('song-orphan-list', '500', 'missing', 4, 'song-orphan-uuid', 15, '${now}', '${now}', 0);
    `);
    fixtureDatabase.close();

    const db = new MasterDatabase({ path: dbPath, readonly: true, unlock: false });
    const playlists = db.listPlaylists();
    expect(playlists.map((playlist) => playlist.id).sort()).toEqual(["500", "501", "502", "503"]);
    expect(playlists.find((playlist) => playlist.id === "501")).toMatchObject({
      parentId: "root",
      sequence: 1,
      trackCount: null,
      type: "folder",
    });
    expect(playlists.find((playlist) => playlist.id === "500")).toMatchObject({
      parentId: "501",
      trackCount: 1,
      type: "playlist",
    });
    expect(playlists.find((playlist) => playlist.id === "502")).toMatchObject({
      trackCount: 1,
      type: "smart",
    });
    expect(playlists.find((playlist) => playlist.id === "503")).toMatchObject({
      trackCount: null,
      type: "smart",
      countError: expect.stringContaining("unsupported criteria: mixName"),
    });

    expect(
      db
        .getPlaylistContents("500")
        .all()
        .map((content) => content.ID),
    ).toEqual(["1"]);
    expect(db.countPlaylistTracks("500")).toBe(1);
    expect(db.getPlaylistTracks("500").map((track) => track.membershipId)).toEqual(["song-1"]);

    expect(
      db
        .getPlaylistContents("502")
        .all()
        .map((content) => content.ID),
    ).toEqual(["1"]);
    expect(db.countPlaylistTracks("502")).toBe(1);
    expect(db.getPlaylistTracks("502").map((track) => track.contentId)).toEqual(["1"]);

    const deleted = db.query(DjmdPlaylist).where({ ID: "504" }).one();
    for (const read of [
      () => db.getPlaylistContents("504"),
      () => db.countPlaylistTracks("504"),
      () => db.getPlaylistTracks("504"),
      () => db.getPlaylistContents(deleted),
    ])
      expect(read).toThrow("Playlist '504' was not found or is deleted");
    db.close();
  });

  it("selects smart playlists with joined artist and key criteria in one metadata query", () => {
    const { dbPath } = fixture();
    const smartList = new SmartList(LogicalOperator.ALL);
    smartList.playlistId = "501";
    smartList
      .addCondition(Property.ARTIST, Operator.EQUAL, "Loopmasters")
      .addCondition(Property.KEY, Operator.EQUAL, "Fm");
    const fixtureDatabase = new Database(dbPath);
    fixtureDatabase
      .prepare("INSERT INTO djmdPlaylist VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "501",
        2,
        "Joined smart playlist",
        null,
        PlaylistType.SMART_PLAYLIST,
        "root",
        smartList.toXml(),
        "smart-playlist-uuid",
        9,
        now,
        now,
      );
    fixtureDatabase.close();

    const db = new MasterDatabase({ path: dbPath, readonly: true, unlock: false });
    expect(db.getPlaylistTracks("501")).toEqual([
      expect.objectContaining({
        artist: "Loopmasters",
        contentId: "1",
        key: "Fm",
        membershipId: null,
        position: 1,
      }),
    ]);
    expect(db.countPlaylistTracks("501")).toBe(1);
    expect(
      db
        .getPlaylistContents("501")
        .all()
        .map((content) => content.ID),
    ).toEqual(["1"]);
    db.close();
  });

  it("fails closed when a smart playlist uses unsupported criteria", () => {
    const { dbPath } = fixture();
    const smartList = new SmartList();
    smartList.playlistId = "502";
    smartList.addCondition(Property.MIX_NAME, Operator.EQUAL, "Club Mix");
    const fixtureDatabase = new Database(dbPath);
    fixtureDatabase
      .prepare("INSERT INTO djmdPlaylist VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "502",
        2,
        "Unsupported smart playlist",
        null,
        PlaylistType.SMART_PLAYLIST,
        "root",
        smartList.toXml(),
        "unsupported-smart-playlist-uuid",
        9,
        now,
        now,
      );
    fixtureDatabase.close();

    const db = new MasterDatabase({ path: dbPath, readonly: true, unlock: false });
    expect(() => db.getPlaylistTracks("502")).toThrow(
      "Smart playlist 'Unsupported smart playlist' (502) uses unsupported criteria: mixName",
    );
    expect(() => db.countPlaylistTracks("502")).toThrow("unsupported criteria: mixName");
    expect(() => db.getPlaylistContents("502")).toThrow("unsupported criteria: mixName");
    db.close();
  });

  it("opens the same connection after close", () => {
    const { dbPath } = fixture();
    const db = new MasterDatabase({ path: dbPath, readonly: true, unlock: false });
    db.close();
    db.open();
    expect(db.query(DjmdContent).count()).toBe(2);
    db.close();
  });

  it("matches the complete SQLAlchemy relationship and projection surface", () => {
    const { dbPath } = fixture();
    const db = new MasterDatabase({ path: dbPath, readonly: true, unlock: false });
    const content = db.query(DjmdContent).where({ ID: "1" }).one();
    expect(content.AlbumArtist?.ID).toBe("100");
    expect(content.AlbumArtistName).toBe("Loopmasters");
    expect(content.MyTagNames).toEqual(["Energy"]);
    expect(content.MyTagIDs).toEqual(["tag-1"]);
    expect(content.ActiveCensors).toHaveLength(1);
    expect(db.query(DjmdAlbum).one().AlbumArtistName).toBe("Loopmasters");
    expect(db.query(DjmdCategory).one().MenuItem?.Name).toBe("Menu");
    expect(db.query(DjmdSort).one().MenuItem?.Name).toBe("Menu");

    const history = db.query(DjmdHistory).where({ ID: "history-root" }).one();
    expect(history.Children[0]?.Parent).toBe(history);
    const historySong = db.query(DjmdSongHistory).one();
    expect(historySong.History?.Name).toBe("Today");
    expect(historySong.Content).toBe(content);

    const tag = db.query(DjmdMyTag).where({ ID: "tag-1" }).one();
    expect(tag.Parent?.Name).toBe("Tags");
    expect(db.query(DjmdSongMyTag).one().MyTagName).toBe("Energy");
    expect(db.query(DjmdRelatedTracks).where({ ID: "related-1" }).one().Songs).toHaveLength(1);
    expect(db.query(DjmdSongRelatedTracks).one().RelatedTracks?.Name).toBe("List");
    expect(db.query(DjmdSampler).where({ ID: "sampler-1" }).one().Songs).toHaveLength(1);
    expect(db.query(DjmdSongSampler).one().Sampler?.Name).toBe("Bank");

    expect(db.query(DjmdContent).where({ ID: "1" }).select("ID", "Title")).toEqual([
      { ID: "1", Title: "Demo Track 1" },
    ]);
    expect(
      db.executeSql<{ Name: string }>(
        'SELECT ar."Name" FROM "djmdContent" c JOIN "djmdArtist" ar ON ar."ID" = c."ArtistID" WHERE c."ID" = ?',
        ["1"],
      ),
    ).toEqual([{ Name: "Loopmasters" }]);
    db.close();
  });

  it("copies logical schema and data into a plain SQLite database", async () => {
    const { dbPath, root } = fixture();
    const output = join(root, "copy.db");
    const db = new MasterDatabase({ path: dbPath, readonly: true, unlock: false });
    await db.copyUnlocked(output);
    db.close();
    const copy = new Database(output, { readonly: true });
    expect(copy.prepare("SELECT COUNT(*) AS count FROM djmdContent").get()).toEqual({ count: 2 });
    copy.close();
  });
});

describe("MasterDatabase mutations", () => {
  it("respects no-autoflush scopes when querying playlist tracks", () => {
    const { dbPath } = fixture();
    const db = new MasterDatabase({
      allowWhileRunning: true,
      path: dbPath,
      readonly: false,
      unlock: false,
    });
    const content = db.query(DjmdContent).where({ ID: "1" }).one();
    content.Title = "Staged title";

    expect(db.withNoAutoflush(() => db.getPlaylistTracks("500")[0]?.title)).toBe("Demo Track 1");
    expect(db.getPlaylistTracks("500")[0]?.title).toBe("Staged title");
    db.rollback();
    db.close();
  });

  it("normalizes analyzer key names to canonical Camelot names", () => {
    expect(normalizeRekordboxKeyName("Bm")).toBe("10A");
    expect(normalizeRekordboxKeyName("Bmin")).toBe("10A");
    expect(normalizeRekordboxKeyName("G♯min")).toBe("1A");
    expect(normalizeRekordboxKeyName("Emaj")).toBe("12B");
    expect(normalizeRekordboxKeyName("10A")).toBe("10A");
    expect(() => normalizeRekordboxKeyName("not-a-key")).toThrow("Unsupported musical key");
  });

  it("installs native analysis files and updates the content row", () => {
    const { dbPath, root } = fixture();
    const audioPath = join(root, "Demo 1.mp3");
    writeFileSync(audioPath, "audio");
    const raw = new Database(dbPath);
    raw.exec(
      "ALTER TABLE djmdContent ADD COLUMN AnalysisUpdated TEXT; ALTER TABLE djmdContent ADD COLUMN TrackInfoUpdated TEXT;",
    );
    raw
      .prepare("UPDATE djmdContent SET FolderPath = ?, FileNameL = ? WHERE ID = ?")
      .run(audioPath, "Demo 1.mp3", "1");
    raw.prepare("INSERT INTO djmdKey VALUES (?, ?)").run("301", "10A");
    raw.close();
    const analysisDirectory = join(root, "analysis");
    mkdirSync(analysisDirectory);
    for (const type of ["DAT", "EXT", "2EX"])
      writeFileSync(join(analysisDirectory, `ANLZ0000.${type}`), analysisFixture("/old/path.mp3"));
    writeAnalysisSummary(analysisDirectory, audioPath);

    const db = new MasterDatabase({
      allowWhileRunning: true,
      path: dbPath,
      readonly: false,
      unlock: false,
    });
    const result = db.installContentAnalysis("1", analysisDirectory, {
      allowWhileRunning: true,
    });
    expect(result.analysisDataPath).toBe("/PIONEER/USBANLZ/con/tent-1/ANLZ0000.DAT");
    expect(result.bpmHundredths).toBe(12_801);
    expect(result.keyId).toBe("301");
    expect(result.keyName).toBe("10A");
    expect(result.tempoBpm).toBe(128.006_827);
    expect(AnlzFile.parseFile(result.paths.DAT).get("PPTH")).toBe(audioPath);
    const installedDat = readFileSync(result.paths.DAT);
    const synced = db.syncContentAnalysisMetadata("1", analysisDirectory, {
      allowWhileRunning: true,
    });
    expect(synced).toEqual({
      bpmHundredths: 12_801,
      contentId: "1",
      keyId: "301",
      keyName: "10A",
      tempoBpm: 128.006_827,
    });
    expect(readFileSync(result.paths.DAT)).toEqual(installedDat);
    writeFileSync(audioPath, "changed after analysis");
    expect(() =>
      db.syncContentAnalysisMetadata("1", analysisDirectory, { allowWhileRunning: true }),
    ).toThrow("source fingerprint does not match");
    db.close();

    const reopened = new MasterDatabase({ path: dbPath, readonly: true, unlock: false });
    const content = reopened.query(DjmdContent).where({ ID: "1" }).one();
    expect(content.AnalysisDataPath).toBe(result.analysisDataPath);
    expect(content.Analysed).toBe(105);
    expect(content.AnalysisUpdated).toBe("2");
    expect(content.TrackInfoUpdated).toBe("2");
    expect(content.BPM).toBe(12_801);
    expect(content.KeyID).toBe("301");
    expect(content.Key?.ScaleName).toBe("10A");
    reopened.close();
  });

  it("allows the same album name for different album artists", () => {
    const { dbPath } = fixture();
    const db = new MasterDatabase({
      allowWhileRunning: true,
      path: dbPath,
      readonly: false,
      unlock: false,
    });
    const secondArtist = db.addArtist("Second Artist");

    expect(() => db.addAlbum("Album", { artist: "100" })).toThrow(
      "already exists for album artist '100'",
    );
    const secondAlbum = db.addAlbum("Album", { artist: secondArtist });
    expect(secondAlbum.AlbumArtist?.ID).toBe(secondArtist.ID);
    db.commit();
    db.close();

    const reopened = new MasterDatabase({ path: dbPath, readonly: true, unlock: false });
    expect(reopened.query(DjmdAlbum).where({ Name: "Album" }).count()).toBe(2);
    expect(
      reopened.query(DjmdAlbum).where({ Name: "Album", AlbumArtistID: secondArtist.ID }).one()
        .AlbumArtistName,
    ).toBe("Second Artist");
    reopened.close();
  });

  it("stages, rolls back, and commits row changes with local USNs", () => {
    const { dbPath } = fixture();
    const db = new MasterDatabase({
      allowWhileRunning: true,
      path: dbPath,
      readonly: false,
      unlock: false,
    });
    const content = db.query(DjmdContent).where({ ID: "1" }).one();
    expect(db.registry.getInt("localUpdateCount")).toBe(10);
    expect(DjmdArtist.columns(db)).toContain("Name");
    expect(DjmdContent.relationships()).toContain("MyTags");
    const constructed = DjmdArtist.create(db, { ID: "detached", Name: "Detached" });
    expect(db.query(DjmdArtist).where({ ID: "detached" }).oneOrNone()).toBeUndefined();
    expect(constructed.pformat()).toContain("Detached");
    db.add(constructed);
    const events: Array<string> = [];
    db.registerEvent("before_commit", () => events.push("before"));
    db.registerEvent("after_commit", () => events.push("after"));
    content.Title = "Changed";
    db.rollback();
    expect(content.Title).toBe("Demo Track 1");
    db.add(constructed);

    content.Title = "Committed";
    const artist = db.addArtist("New Artist");
    db.commit();
    expect(events).toEqual(["before", "after"]);
    expect(db.getLocalUsn()).toBeGreaterThan(10);
    expect(artist.rb_local_usn).toBeTypeOf("number");
    db.close();

    const reopened = new MasterDatabase({ path: dbPath, readonly: true, unlock: false });
    expect(reopened.query(DjmdContent).where({ ID: "1" }).one().Title).toBe("Committed");
    expect(reopened.query(DjmdArtist).where({ Name: "New Artist" }).count()).toBe(1);
    expect(reopened.query(DjmdArtist).where({ ID: "detached" }).one().toDict().Name).toBe(
      "Detached",
    );
    reopened.close();
  });

  it("creates playlists and maintains song ordering", () => {
    const { dbPath, xmlPath } = fixture();
    const db = new MasterDatabase({
      allowWhileRunning: true,
      path: dbPath,
      readonly: false,
      unlock: false,
    });
    const folder = db.createPlaylistFolder("Folder");
    const playlist = db.createPlaylist("New Playlist", { parent: folder });
    const sibling = db.createPlaylist("Sibling", { parent: folder });
    db.movePlaylist(sibling, { seq: 1 });
    expect(sibling.Seq).toBe(1);
    expect(playlist.Seq).toBe(2);
    const first = db.addToPlaylist(playlist, "1");
    const second = db.addToPlaylist(playlist, "2", 1);
    expect(first.TrackNo).toBe(2);
    expect(second.TrackNo).toBe(1);
    db.moveSongInPlaylist(playlist, first, 1);
    expect(first.TrackNo).toBe(1);
    expect(second.TrackNo).toBe(2);
    db.commit();
    expect(new MasterPlaylistXml(xmlPath).get(playlist.ID)?.ParentId).toBe(
      Number(folder.ID).toString(16).toUpperCase(),
    );
    db.close();

    const reopened = new MasterDatabase({ path: dbPath, readonly: true, unlock: false });
    const songs = reopened
      .query(DjmdSongPlaylist)
      .where({ PlaylistID: playlist.ID })
      .orderBy("TrackNo")
      .all();
    expect(songs.map((song) => song.ContentID)).toEqual(["1", "2"]);
    expect(reopened.query(DjmdPlaylist).where({ ParentID: folder.ID }).count()).toBe(2);
    reopened.close();
  });

  it("commits row deletions without assigning a local USN to the deleted model", () => {
    const { dbPath } = fixture();
    const db = new MasterDatabase({
      allowWhileRunning: true,
      path: dbPath,
      readonly: false,
      unlock: false,
    });
    db.removeFromPlaylist("500", "song-1");
    expect(() => db.commit()).not.toThrow();
    db.close();

    const reopened = new MasterDatabase({ path: dbPath, readonly: true, unlock: false });
    expect(reopened.query(DjmdSongPlaylist).where({ ID: "song-1" }).count()).toBe(0);
    reopened.close();
  });

  it("preserves a committed database and the original sidecar error when saving XML fails", () => {
    const { dbPath } = fixture();
    const db = new MasterDatabase({
      allowWhileRunning: true,
      path: dbPath,
      readonly: false,
      unlock: false,
    });
    const playlist = db.createPlaylist("Committed before sidecar failure");
    const failure = new Error("sidecar save failed");
    vi.spyOn(db.playlistXml!, "save").mockImplementation(() => {
      throw failure;
    });

    let thrown: unknown;
    try {
      db.commit();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(failure);
    expect(db.query(DjmdPlaylist).where({ ID: playlist.ID }).count()).toBe(1);
    expect(() => db.close()).not.toThrow();

    const reopened = new MasterDatabase({ path: dbPath, readonly: true, unlock: false });
    expect(reopened.query(DjmdPlaylist).where({ ID: playlist.ID }).count()).toBe(1);
    reopened.close();
  });

  it("rejects fractional positions, cross-playlist songs, and hierarchy cycles", () => {
    const { dbPath } = fixture();
    const db = new MasterDatabase({
      allowWhileRunning: true,
      path: dbPath,
      readonly: false,
      unlock: false,
    });
    const folder = db.createPlaylistFolder("Folder");
    const child = db.createPlaylistFolder("Child", { parent: folder });
    const other = db.createPlaylist("Other");
    expect(() => db.createPlaylist("Bad", { seq: 1.5 })).toThrow(RangeError);
    expect(() => db.addToPlaylist(other, "1", 1.5)).toThrow(RangeError);
    const membership = db.query(DjmdSongPlaylist).where({ ID: "song-1" }).one();
    expect(() => db.moveSongInPlaylist(other, membership, 1)).toThrow(TypeError);
    expect(() => db.movePlaylist(folder, { parent: child })).toThrow(TypeError);
    expect(folder.ParentID).toBe("root");
    expect(() => db.movePlaylist(other, { seq: Number.NaN })).toThrow(RangeError);
    expect(() => db.generateUnusedId(DjmdContent, { bits: 16 as never })).toThrow(RangeError);
    db.rollback();
    db.close();
  });

  it("preserves contiguous playlist ordering through a deterministic 300-operation state machine", () => {
    const { dbPath } = fixture();
    const db = new MasterDatabase({
      allowWhileRunning: true,
      path: dbPath,
      readonly: false,
      unlock: false,
    });
    const playlist = db.createPlaylist("State machine");
    let state = 0xa341_316c;
    const random = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    };

    for (let iteration = 0; iteration < 300; iteration++) {
      const songs = db
        .query(DjmdSongPlaylist)
        .where({ PlaylistID: playlist.ID })
        .orderBy("TrackNo")
        .all();
      const operation = random() % 3;
      if (!songs.length || (operation === 0 && songs.length < 30)) {
        db.addToPlaylist(playlist, random() % 2 ? "1" : "2", 1 + (random() % (songs.length + 1)));
      } else if (operation === 1) {
        db.removeFromPlaylist(playlist, songs[random() % songs.length]!);
      } else {
        db.moveSongInPlaylist(
          playlist,
          songs[random() % songs.length]!,
          1 + (random() % songs.length),
        );
      }
      const ordered = db
        .query(DjmdSongPlaylist)
        .where({ PlaylistID: playlist.ID })
        .orderBy("TrackNo")
        .all();
      expect(ordered.map((song) => song.TrackNo)).toEqual(
        Array.from({ length: ordered.length }, (_, index) => index + 1),
      );
    }
    db.commit({ autoincrement: false });
    db.close();

    const reopened = new MasterDatabase({ path: dbPath, readonly: true, unlock: false });
    const trackNumbers = reopened
      .query(DjmdSongPlaylist)
      .where({ PlaylistID: playlist.ID })
      .orderBy("TrackNo")
      .all()
      .map((song) => song.TrackNo);
    expect(trackNumbers).toEqual(
      Array.from({ length: trackNumbers.length }, (_, index) => index + 1),
    );
    reopened.close();
  });

  it("handles default inserts and every new-row rollback/delete boundary", () => {
    const { dbPath } = fixture();
    const db = new MasterDatabase({
      allowWhileRunning: true,
      path: dbPath,
      readonly: false,
      unlock: false,
    });

    const neverFlushed = db.create(DefaultRow, {});
    db.delete(neverFlushed);
    db.commit({ autoincrement: false });
    expect(db.query(DefaultRow).count()).toBe(0);

    const rolledBack = db.create(DefaultRow, {});
    expect(db.query(DefaultRow).count()).toBe(1);
    expect(rolledBack.ID).toBeTypeOf("number");
    db.rollback();
    expect(rolledBack.ID).toBeUndefined();
    expect(db.query(DefaultRow).count()).toBe(0);

    db.add(rolledBack);
    db.commit({ autoincrement: false });
    expect(rolledBack.Value).toBeUndefined();
    expect(db.query(DefaultRow).count()).toBe(1);

    const flushedThenDeleted = db.create(DefaultRow, {});
    expect(db.query(DefaultRow).count()).toBe(2);
    db.delete(flushedThenDeleted);
    db.commit({ autoincrement: false });
    expect(db.query(DefaultRow).count()).toBe(1);
    db.close();
  });

  it("rekeys the identity map when a primary key changes", () => {
    const { dbPath } = fixture();
    const db = new MasterDatabase({
      allowWhileRunning: true,
      path: dbPath,
      readonly: false,
      unlock: false,
    });
    const content = db.query(DjmdContent).where({ ID: "1" }).one();
    content.ID = "99";
    db.commit({ autoincrement: false });
    expect(db.query(DjmdContent).where({ ID: "1" }).oneOrNone()).toBeUndefined();
    expect(db.query(DjmdContent).where({ ID: "99" }).one()).toBe(content);
    db.close();
  });

  it("persists relationship, proxy, and live collection mutations", () => {
    const { dbPath } = fixture();
    const db = new MasterDatabase({
      allowWhileRunning: true,
      path: dbPath,
      readonly: false,
      unlock: false,
    });
    const content = db.query(DjmdContent).where({ ID: "1" }).one();
    content.ArtistName = "Renamed";
    expect(content.Artist?.Name).toBe("Renamed");

    const destination = db.createPlaylist("Destination");
    const membership = db.query(DjmdSongPlaylist).where({ ID: "song-1" }).one();
    destination.Songs.push(membership);
    expect(membership.PlaylistID).toBe(destination.ID);
    db.rollback();
    expect(content.Artist?.Name).toBe("Loopmasters");
    expect(membership.PlaylistID).toBe("500");
    db.close();
  });
});

describe("MasterPlaylistXml", () => {
  it("adds, updates, removes, and reloads playlist metadata", () => {
    const { xmlPath } = fixture();
    const xml = new MasterPlaylistXml(xmlPath);
    expect(xml.version).toBe("3.0.0");
    expect(xml.get(500)?.Attribute).toBe(0);
    xml.add(600, "root", PlaylistType.FOLDER, new Date("2026-07-10T13:00:00Z"));
    xml.update(600, { attribute: PlaylistType.SMART_PLAYLIST });
    expect(xml.get(600)?.Attribute).toBe(PlaylistType.SMART_PLAYLIST);
    xml.remove(500);
    xml.save();
    expect(readFileSync(xmlPath, "utf8").match(/<\?xml/gu)).toHaveLength(1);
    const reloaded = new MasterPlaylistXml(xmlPath);
    expect(reloaded.get(500)).toBeUndefined();
    expect(reloaded.get(600)?.ParentId).toBe("0");
  });

  it("keeps its source and cleans the temporary file when atomic replacement fails", () => {
    const { root, xmlPath } = fixture();
    const original = readFileSync(xmlPath, "utf8");
    const xml = new MasterPlaylistXml(xmlPath);
    xml.add(600, "root", PlaylistType.PLAYLIST, new Date("2026-07-10T13:00:00Z"));
    const destination = join(root, "cannot-replace-directory");
    mkdirSync(destination);

    expect(() => xml.save(destination)).toThrow();
    expect(xml.path).toBe(xmlPath);
    expect(xml.modified).toBe(true);
    expect(readFileSync(xmlPath, "utf8")).toBe(original);
    expect(
      readdirSync(root).filter((name) => name.startsWith(".cannot-replace-directory.")),
    ).toEqual([]);
  });
});
