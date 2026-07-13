import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MasterDatabase, MasterPlaylistXml } from "@gakonst/rekordbox";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LibraryMutationError, RekordboxLibraryService } from "../src/server/library.js";

const roots: string[] = [];
const now = "2026-07-12 12:00:00.000 +00:00";

type Fixture = {
  backupRoot: string;
  dbPath: string;
  root: string;
  xmlPath: string;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function copiedFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rekordbox-library-service-"));
  roots.push(root);
  const source = join(root, "source");
  const target = join(root, "working-copy");
  const backupRoot = join(root, "backups");
  mkdirSync(source);
  mkdirSync(target);
  const sourceDbPath = join(source, "master.db");
  writeFileSync(sourceDbPath, "");
  const setup = new MasterDatabase({
    path: sourceDbPath,
    readonly: false,
    unlock: false,
  });
  setup.connection!.exec(`
    CREATE TABLE agentRegistry (
      registry_id TEXT PRIMARY KEY, int_1 INTEGER, created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    );
    CREATE TABLE djmdArtist (ID TEXT PRIMARY KEY, Name TEXT, rb_local_deleted INTEGER);
    CREATE TABLE djmdAlbum (ID TEXT PRIMARY KEY, Name TEXT, rb_local_deleted INTEGER);
    CREATE TABLE djmdGenre (ID TEXT PRIMARY KEY, Name TEXT, rb_local_deleted INTEGER);
    CREATE TABLE djmdKey (ID TEXT PRIMARY KEY, ScaleName TEXT, rb_local_deleted INTEGER);
    CREATE TABLE djmdContent (
      ID TEXT PRIMARY KEY, FolderPath TEXT, FileNameL TEXT, Title TEXT, ArtistID TEXT,
      AlbumID TEXT, GenreID TEXT, KeyID TEXT, BPM INTEGER, Length INTEGER, Rating INTEGER,
      DJPlayCount INTEGER, AnalysisDataPath TEXT, Analysed INTEGER, Commnt TEXT, ISRC TEXT,
      ReleaseYear INTEGER, BitRate INTEGER, SampleRate INTEGER, FileSize INTEGER, UUID TEXT,
      rb_local_usn INTEGER, rb_local_deleted INTEGER, created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    );
    CREATE TABLE djmdPlaylist (
      ID TEXT PRIMARY KEY, Seq INTEGER, Name TEXT, ImagePath TEXT, Attribute INTEGER,
      ParentID TEXT, SmartList TEXT, UUID TEXT, rb_local_usn INTEGER,
      rb_local_deleted INTEGER, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL
    );
    CREATE TABLE djmdSongPlaylist (
      ID TEXT PRIMARY KEY, PlaylistID TEXT, ContentID TEXT, TrackNo INTEGER, UUID TEXT,
      rb_local_usn INTEGER, rb_local_deleted INTEGER, created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    );

    INSERT INTO agentRegistry VALUES ('localUpdateCount', 10, '${now}', '${now}');
    INSERT INTO djmdArtist VALUES ('100', 'Test Artist', NULL);
    INSERT INTO djmdAlbum VALUES ('150', 'Test Album', NULL);
    INSERT INTO djmdGenre VALUES ('200', 'House', NULL);
    INSERT INTO djmdKey VALUES ('300', 'Fm', NULL);
    INSERT INTO djmdContent VALUES (
      '1', '/Music/One.mp3', 'One.mp3', 'One', '100', '150', '200', '300',
      12400, 180, 3, 2, '/PIONEER/USBANLZ/001/ANLZ0000.DAT', 105, 'First',
      'TEST00000001', 2025, 320, 44100, 1000, 'content-1', 1, NULL, '${now}', '${now}'
    );
    INSERT INTO djmdContent VALUES (
      '2', '/Music/Two.mp3', 'Two.mp3', 'Two', '100', '150', '200', '300',
      12600, 200, 4, 0, '/PIONEER/USBANLZ/002/ANLZ0000.DAT', 105, 'Second',
      'TEST00000002', 2026, 320, 48000, 2000, 'content-2', 2, NULL, '${now}', '${now}'
    );
    INSERT INTO djmdPlaylist VALUES (
      '500', 1, 'Playlist', NULL, 0, 'root', NULL, 'playlist-500', 3, NULL, '${now}', '${now}'
    );
    INSERT INTO djmdPlaylist VALUES (
      '600', 2, 'Soft deletes', NULL, 0, 'root', NULL, 'playlist-600', 4, NULL, '${now}', '${now}'
    );
    INSERT INTO djmdPlaylist VALUES (
      '700', 3, 'Deleted playlist', NULL, 0, 'root', NULL, 'playlist-700', 5, 1, '${now}', '${now}'
    );
    INSERT INTO djmdSongPlaylist VALUES (
      'song-1', '500', '1', 1, 'song-1-uuid', 6, NULL, '${now}', '${now}'
    );
    INSERT INTO djmdSongPlaylist VALUES (
      'song-deleted', '600', '2', 1, 'song-deleted-uuid', 7, 1, '${now}', '${now}'
    );
  `);
  setup.close();

  const sourceXmlPath = join(source, "masterPlaylists6.xml");
  writeFileSync(
    sourceXmlPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<MASTER_PLAYLIST Version="3.0.0" AutomaticSync="0">
  <PRODUCT Name="rekordbox" Version="7.0.9" Company="AlphaTheta"/>
  <PLAYLISTS>
    <NODE Id="1F4" ParentId="0" Attribute="0" Timestamp="${Date.now()}" Lib_Type="0" CheckType="0"/>
    <NODE Id="258" ParentId="0" Attribute="0" Timestamp="${Date.now()}" Lib_Type="0" CheckType="0"/>
    <NODE Id="2BC" ParentId="0" Attribute="0" Timestamp="${Date.now()}" Lib_Type="0" CheckType="0"/>
  </PLAYLISTS>
</MASTER_PLAYLIST>`,
  );

  const dbPath = join(target, "master.db");
  const xmlPath = join(target, "masterPlaylists6.xml");
  copyFileSync(sourceDbPath, dbPath);
  copyFileSync(sourceXmlPath, xmlPath);
  return { backupRoot, dbPath, root, xmlPath };
}

function service(fixture: Fixture): RekordboxLibraryService {
  return new RekordboxLibraryService({
    backupRoot: fixture.backupRoot,
    dbPath: fixture.dbPath,
    getProcessState: () => ({ rekordboxPid: 0, rekordboxAgentPid: 0 }),
    unlock: false,
    writeEnabled: true,
  });
}

function readJournal(backupDirectory: string): Record<string, any> {
  const names = readdirSync(backupDirectory).filter(
    (name) => name.startsWith("library-mutation-") && name.endsWith(".json"),
  );
  expect(names).toHaveLength(1);
  return JSON.parse(readFileSync(join(backupDirectory, names[0]!), "utf8")) as Record<string, any>;
}

describe("RekordboxLibraryService", () => {
  it("preserves unsupported smart-playlist count failures as unknown", () => {
    const fixture = copiedFixture();
    const database = new MasterDatabase({ path: fixture.dbPath, readonly: false, unlock: false });
    database
      .connection!.prepare(
        `INSERT INTO djmdPlaylist
          (ID, Seq, Name, ImagePath, Attribute, ParentID, SmartList, UUID, rb_local_usn,
           rb_local_deleted, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, 'root', ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        "800",
        4,
        "Unsupported smart",
        4,
        '<NODE Id="2" LogicalOperator="1" AutomaticUpdate="1"><CONDITION PropertyName="mixName" Operator="1" ValueUnit="" ValueLeft="Club Mix" ValueRight=""/></NODE>',
        "playlist-800",
        8,
        now,
        now,
      );
    database.close();

    const playlist = service(fixture)
      .getPlaylists()
      .find((item) => item.id === "800");
    expect(playlist).toMatchObject({
      countError: expect.stringContaining("unsupported criteria: mixName"),
      trackCount: null,
      type: "smart",
    });
  });

  it("excludes soft-deleted memberships and playlists from copied-fixture reads", () => {
    const fixture = copiedFixture();
    const library = service(fixture);

    expect(library.getPlaylists()).toEqual([
      expect.objectContaining({ id: "500", trackCount: 1 }),
      expect.objectContaining({ id: "600", trackCount: 0 }),
    ]);
    expect(library.getTracks({ playlistId: "600" })).toMatchObject({ count: 0, items: [] });
    expect(library.getTrack("2").playlists).toEqual([]);
    expect(() => library.getTracks({ playlistId: "700" })).toThrow("was not found");
  });

  it("journals and semantically verifies every playlist mutation on a copied fixture", async () => {
    const fixture = copiedFixture();
    const library = service(fixture);

    const added = await library.mutate({ type: "add-track", playlistId: "500", contentId: "2" });
    await library.mutate({
      type: "move-track",
      playlistId: "500",
      membershipId: added.changedId,
      trackNumber: 1,
    });
    await library.mutate({
      type: "remove-track",
      playlistId: "500",
      membershipId: added.changedId,
    });
    await library.mutate({ type: "rename-playlist", playlistId: "500", name: "Renamed" });
    const folder = await library.mutate({
      type: "create-playlist",
      name: "Folder",
      kind: "folder",
    });
    const child = await library.mutate({
      type: "create-playlist",
      name: "Child",
      parentId: folder.changedId,
    });
    const removedFolder = await library.mutate({
      type: "delete-playlist",
      playlistId: folder.changedId,
    });

    const successJournal = readJournal(removedFolder.backupDirectory);
    expect(successJournal).toMatchObject({
      schemaVersion: 1,
      mutation: { type: "delete-playlist", playlistId: folder.changedId },
      stages: {
        database: { status: "succeeded" },
        sidecar: { status: "succeeded" },
        verification: { status: "succeeded" },
        receipt: { status: "succeeded" },
      },
      receipt: removedFolder,
    });
    expect(existsSync(join(removedFolder.backupDirectory, "backup.json"))).toBe(true);

    const db = new MasterDatabase({ path: fixture.dbPath, readonly: true, unlock: false });
    expect(
      db.selectRawRows('SELECT "Name" AS name FROM "djmdPlaylist" WHERE "ID" = ?', ["500"]),
    ).toEqual([{ name: "Renamed" }]);
    expect(
      db.selectRawRows(
        'SELECT "ContentID" AS contentId, "TrackNo" AS trackNumber FROM "djmdSongPlaylist" WHERE "PlaylistID" = ?',
        ["500"],
      ),
    ).toEqual([{ contentId: "1", trackNumber: 1 }]);
    expect(
      db.selectRawRows('SELECT "ID" FROM "djmdPlaylist" WHERE "ID" IN (?, ?)', [
        folder.changedId,
        child.changedId,
      ]),
    ).toEqual([]);
    db.close();
    const sidecar = new MasterPlaylistXml(fixture.xmlPath);
    expect(sidecar.get(folder.changedId)).toBeUndefined();
    expect(sidecar.get(child.changedId)).toBeUndefined();
  });

  it("records a recoverable partial commit when sidecar persistence fails", async () => {
    const fixture = copiedFixture();
    const library = service(fixture);
    vi.spyOn(MasterPlaylistXml.prototype, "save").mockImplementation(() => {
      throw new Error("injected sidecar failure");
    });

    let failure: LibraryMutationError | undefined;
    try {
      await library.mutate({ type: "create-playlist", name: "Partial" });
    } catch (error) {
      expect(error).toBeInstanceOf(LibraryMutationError);
      failure = error as LibraryMutationError;
    }
    expect(failure).toBeDefined();
    expect(failure).toMatchObject({ databaseCommitted: true, sidecarCommitted: false });
    expect(failure!.message).toContain(failure!.backupDirectory);
    expect(existsSync(failure!.journalPath)).toBe(true);
    expect(readJournal(failure!.backupDirectory)).toMatchObject({
      mutation: { type: "create-playlist", name: "Partial" },
      stages: {
        database: { status: "succeeded" },
        sidecar: { status: "failed" },
        verification: { status: "failed" },
        receipt: { status: "failed" },
      },
    });

    const db = new MasterDatabase({ path: fixture.dbPath, readonly: true, unlock: false });
    const committed = db.selectRawRows('SELECT "ID" AS id FROM "djmdPlaylist" WHERE "Name" = ?', [
      "Partial",
    ]);
    expect(committed).toHaveLength(1);
    db.close();
    expect(new MasterPlaylistXml(fixture.xmlPath).get(String(committed[0]!.id))).toBeUndefined();
  });
});
