import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  LogicalOperator,
  MasterDatabase,
  MasterPlaylistXml,
  Operator,
  PlaylistType,
  Property,
  SmartList,
} from "@gakonst/rekordbox";
import { acquireRekordboxDatabaseLock } from "@gakonst/tracks";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LibraryMutationConflictError,
  RekordboxLibraryService,
  trackComparator,
} from "../src/server/library.js";
import type { TrackSortField } from "../src/shared/types.js";

const roots: string[] = [];
const services: RekordboxLibraryService[] = [];
const now = "2026-07-12 12:00:00.000 +00:00";

type Fixture = {
  dbPath: string;
  root: string;
  xmlPath: string;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const service of services.splice(0)) service.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function copiedFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "rekordbox-library-service-"));
  roots.push(root);
  const source = join(root, "source");
  const target = join(root, "working-copy");
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
    CREATE TABLE djmdArtist (
      ID TEXT PRIMARY KEY, Name TEXT, UUID TEXT, SearchStr TEXT, rb_local_deleted INTEGER
    );
    CREATE TABLE djmdAlbum (
      ID TEXT PRIMARY KEY, Name TEXT, ImagePath TEXT, UUID TEXT, AlbumArtistID TEXT,
      Compilation INTEGER, SearchStr TEXT, rb_local_deleted INTEGER
    );
    CREATE TABLE djmdGenre (
      ID TEXT PRIMARY KEY, Name TEXT, UUID TEXT, rb_local_deleted INTEGER
    );
    CREATE TABLE djmdColor (
      ID TEXT PRIMARY KEY, ColorCode INTEGER, SortKey INTEGER, Commnt TEXT,
      rb_local_deleted INTEGER
    );
    CREATE TABLE djmdKey (ID TEXT PRIMARY KEY, ScaleName TEXT, rb_local_deleted INTEGER);
    CREATE TABLE djmdContent (
      ID TEXT PRIMARY KEY, FolderPath TEXT, FileNameL TEXT, Title TEXT, ArtistID TEXT,
      AlbumID TEXT, GenreID TEXT, KeyID TEXT, ColorID TEXT, BPM INTEGER, Length INTEGER,
      Rating INTEGER,
      DJPlayCount INTEGER, AnalysisDataPath TEXT, Analysed INTEGER, Commnt TEXT, ISRC TEXT,
      ReleaseYear INTEGER, BitRate INTEGER, SampleRate INTEGER, FileSize INTEGER, UUID TEXT,
      rb_local_usn INTEGER, rb_local_deleted INTEGER, created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL, CueUpdated TEXT
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

    INSERT INTO agentRegistry VALUES ('localUpdateCount', 10, '${now}', '${now}');
    INSERT INTO djmdArtist VALUES ('100', 'Test Artist', 'artist-100', 'Test Artist', NULL);
    INSERT INTO djmdAlbum VALUES (
      '150', 'Test Album', NULL, 'album-150', '100', NULL, NULL, NULL
    );
    INSERT INTO djmdGenre VALUES ('200', 'House', 'genre-200', NULL);
    INSERT INTO djmdColor VALUES ('1', NULL, 1, 'Pink', NULL);
    INSERT INTO djmdColor VALUES ('2', NULL, 2, 'Red', NULL);
    INSERT INTO djmdColor VALUES ('3', NULL, 3, 'Orange', NULL);
    INSERT INTO djmdColor VALUES ('4', NULL, 4, 'Yellow', NULL);
    INSERT INTO djmdColor VALUES ('5', NULL, 5, 'Green', NULL);
    INSERT INTO djmdColor VALUES ('6', NULL, 6, 'Aqua', NULL);
    INSERT INTO djmdColor VALUES ('7', NULL, 7, 'Blue', NULL);
    INSERT INTO djmdColor VALUES ('8', NULL, 8, 'Purple', NULL);
    INSERT INTO djmdKey VALUES ('300', 'Fm', NULL);
    INSERT INTO djmdKey VALUES ('301', '4A', NULL);
    INSERT INTO djmdContent VALUES (
      '1', '/Music/One.mp3', 'One.mp3', 'One', '100', '150', '200', '300', '7',
      12400, 180, 3, 2, '/PIONEER/USBANLZ/001/ANLZ0000.DAT', 105, 'First',
      'TEST00000001', 2025, 320, 44100, 1000, 'content-1', 1, NULL, '${now}', '${now}', NULL
    );
    INSERT INTO djmdContent VALUES (
      '2', '/Music/Two.mp3', 'Two.mp3', 'Two', '100', '150', '200', '300', NULL,
      12600, 200, 4, 0, '/PIONEER/USBANLZ/002/ANLZ0000.DAT', 105, 'Second',
      'TEST00000002', 2026, 320, 48000, 2000, 'content-2', 2, NULL, '${now}', '${now}', NULL
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
  return { dbPath, root, xmlPath };
}

function service(fixture: Fixture): RekordboxLibraryService {
  const library = new RekordboxLibraryService({
    dbPath: fixture.dbPath,
    getProcessState: () => ({ rekordboxPid: 0, rekordboxAgentPid: 0 }),
    unlock: false,
    writeEnabled: true,
  });
  services.push(library);
  return library;
}

function configureTrackQueryFixture(fixture: Fixture): void {
  const availablePath = join(fixture.root, "available.mp3");
  const missingPath = join(fixture.root, "missing.mp3");
  writeFileSync(availablePath, "");
  const database = new MasterDatabase({ path: fixture.dbPath, readonly: false, unlock: false });
  database.connection!.exec(`
    INSERT INTO djmdArtist VALUES ('101', 'Needle Artist', 'artist-101', NULL, NULL);
    INSERT INTO djmdAlbum VALUES (
      '151', 'Needle Album', NULL, 'album-151', NULL, NULL, NULL, NULL
    );
    INSERT INTO djmdGenre VALUES ('201', 'Ambient', 'genre-201', NULL);
    UPDATE djmdContent
       SET Title = 'Bravo', FolderPath = '${availablePath.replaceAll("'", "''")}'
     WHERE ID = '1';
    UPDATE djmdContent
       SET Title = 'alpha', FileNameL = 'literal%_mix\\take.mp3', ArtistID = '101', AlbumID = '151',
           GenreID = '201', KeyID = '301', FolderPath = '${missingPath.replaceAll("'", "''")}'
     WHERE ID = '2';
    UPDATE djmdSongPlaylist SET TrackNo = 2 WHERE ID = 'song-1';
    INSERT INTO djmdSongPlaylist VALUES (
      'song-2', '500', '2', 1, 'song-2-uuid', 8, NULL, '${now}', '${now}'
    );
  `);
  database.close();
}

describe("RekordboxLibraryService", () => {
  it("reuses one SQLite session across reads and closes it idempotently", () => {
    const fixture = copiedFixture();
    const open = vi.spyOn(MasterDatabase.prototype, "open");
    const close = vi.spyOn(MasterDatabase.prototype, "close");
    const library = service(fixture);

    library.getBootstrap("token");
    library.getPlaylists();
    library.getTracks();
    library.getTracks({ playlistId: "500" });
    library.getTrack("1");
    library.getWaveform("1");

    expect(open).toHaveBeenCalledTimes(1);
    library.close();
    library.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reopens a stale session under the lock before a cooperating playlist write", async () => {
    const fixture = copiedFixture();
    const open = vi.spyOn(MasterDatabase.prototype, "open");
    const first = service(fixture);
    const second = service(fixture);

    // Both services intentionally cache the same pre-mutation database and playlist sidecar.
    first.getPlaylists();
    second.getPlaylists();
    expect(open).toHaveBeenCalledTimes(2);

    const firstReceipt = await first.mutate({ type: "create-playlist", name: "First writer" });
    const secondReceipt = await second.mutate({ type: "create-playlist", name: "Second writer" });

    // The second service must reopen after acquiring the shared lock, before it stages against its
    // stale in-memory masterPlaylists6.xml document.
    expect(open).toHaveBeenCalledTimes(3);
    await second.mutate({
      type: "rename-playlist",
      playlistId: secondReceipt.changedId,
      name: "Second writer updated",
    });
    // Capturing the post-commit version prevents a service from treating its own prior write as
    // external and reopening again.
    expect(open).toHaveBeenCalledTimes(3);
    const sidecar = new MasterPlaylistXml(fixture.xmlPath);
    expect(sidecar.get(firstReceipt.changedId)).toBeDefined();
    expect(sidecar.get(secondReceipt.changedId)).toBeDefined();
    const database = new MasterDatabase({ path: fixture.dbPath, readonly: true, unlock: false });
    expect(
      database
        .listPlaylists()
        .filter((playlist) =>
          [firstReceipt.changedId, secondReceipt.changedId].includes(playlist.id),
        )
        .map((playlist) => playlist.name),
    ).toEqual(["First writer", "Second writer updated"]);
    database.close();
  });

  it("revalidates a cached audio path before serving it", () => {
    const fixture = copiedFixture();
    const audioPath = join(fixture.root, "cached-audio.mp3");
    writeFileSync(audioPath, "audio");
    const database = new MasterDatabase({ path: fixture.dbPath, readonly: false, unlock: false });
    database
      .connection!.prepare('UPDATE "djmdContent" SET "FolderPath" = ? WHERE "ID" = ?')
      .run(audioPath, "1");
    database.close();
    const library = service(fixture);

    expect(library.getAudioPath("1")).toBe(audioPath);
    rmSync(audioPath);

    expect(() => library.getAudioPath("1")).toThrow("Audio for track '1' is unavailable");
  });

  it("retries cached placeholder waveforms", () => {
    const fixture = copiedFixture();
    const database = new MasterDatabase({ path: fixture.dbPath, readonly: true, unlock: false });
    mkdirSync(database.getAnlzDirectory("1"), { recursive: true });
    database.close();
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const read = vi
      .spyOn(MasterDatabase.prototype, "readContentAnlzFiles")
      .mockReturnValue(new Map() as never);
    const library = service(fixture);

    expect(library.getWaveform("1").source).toBe("placeholder");
    expect(library.getWaveform("1").source).toBe("placeholder");
    expect(read).toHaveBeenCalledTimes(1);

    now += 5_001;
    expect(library.getWaveform("1").source).toBe("placeholder");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reloads a cached waveform when its analysis file changes", () => {
    const fixture = copiedFixture();
    const database = new MasterDatabase({ path: fixture.dbPath, readonly: true, unlock: false });
    const analysisDirectory = database.getAnlzDirectory("1");
    database.close();
    mkdirSync(analysisDirectory, { recursive: true });
    const analysisPath = join(analysisDirectory, "ANLZ0000.DAT");
    writeFileSync(analysisPath, "initial");
    let heights = [1, 2];
    const read = vi.spyOn(MasterDatabase.prototype, "readContentAnlzFiles").mockImplementation(
      () =>
        new Map([
          [
            "DAT",
            new Map<string, unknown>([
              [
                "PQTZ",
                [
                  { beat: 1, bpm: 128, time: 0.025 },
                  { beat: 2, bpm: 128, time: 0.494 },
                ],
              ],
              ["PWV5", { heights }],
            ]),
          ],
        ]) as never,
    );
    const library = service(fixture);

    expect(library.getWaveform("1")).toMatchObject({
      beatGrid: [
        { beat: 1, timeSeconds: 0.025 },
        { beat: 2, timeSeconds: 0.494 },
      ],
      peaks: [0.5, 1],
      source: "rekordbox",
    });
    heights = [8, 1];
    expect(library.getWaveform("1")).toMatchObject({ peaks: [0.5, 1], source: "rekordbox" });
    expect(read).toHaveBeenCalledTimes(1);

    writeFileSync(analysisPath, "changed analysis file");
    expect(library.getWaveform("1")).toMatchObject({ peaks: [1, 0.125], source: "rekordbox" });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reopens the session only after explicit external invalidation", () => {
    const fixture = copiedFixture();
    const open = vi.spyOn(MasterDatabase.prototype, "open");
    const library = service(fixture);

    expect(library.getPlaylists()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "500", name: "Playlist" })]),
    );
    const external = new MasterDatabase({ path: fixture.dbPath, readonly: false, unlock: false });
    external
      .connection!.prepare('UPDATE "djmdPlaylist" SET "Name" = ? WHERE "ID" = ?')
      .run("External", "500");
    external.close();
    expect(open).toHaveBeenCalledTimes(2);

    library.invalidate();
    expect(library.getPlaylists()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "500", name: "External" })]),
    );
    expect(open).toHaveBeenCalledTimes(3);
  });

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

  it("projects smart-playlist IDs without materializing duplicate joined track metadata", () => {
    const fixture = copiedFixture();
    const smartList = new SmartList(LogicalOperator.ALL);
    smartList.playlistId = "800";
    smartList.addCondition(Property.NAME, Operator.CONTAINS, "o");
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
        "Supported smart",
        PlaylistType.SMART_PLAYLIST,
        smartList.toXml(),
        "playlist-800",
        8,
        now,
        now,
      );
    database.close();
    const materializeTracks = vi.spyOn(MasterDatabase.prototype, "getPlaylistTracks");

    expect(
      service(fixture)
        .getTracks({ playlistId: "800" })
        .items.map((track) => track.id),
    ).toEqual(["1", "2"]);
    expect(materializeTracks).not.toHaveBeenCalled();
  });

  it("excludes soft-deleted memberships and playlists from copied-fixture reads", () => {
    const fixture = copiedFixture();
    const library = service(fixture);

    expect(library.getPlaylists()).toEqual([
      expect.objectContaining({ id: "500", trackCount: 1 }),
      expect.objectContaining({ id: "600", trackCount: 0 }),
    ]);
    expect(library.getTracks({ playlistId: "600" })).toMatchObject({ count: 0, items: [] });
    expect(library.getTracks({ limit: 1, offset: 99 })).toMatchObject({ count: 2, items: [] });
    expect(library.getTracks({ q: "does-not-exist" })).toMatchObject({ count: 0, items: [] });
    expect(library.getTrack("2").playlists).toEqual([]);
    expect(() => library.getTracks({ playlistId: "700" })).toThrow("was not found");
  });

  it("sorts track pages by every supported field in both directions", () => {
    const fixture = copiedFixture();
    configureTrackQueryFixture(fixture);
    const library = service(fixture);
    const sortCases: Array<{
      field: Exclude<TrackSortField, "position">;
      ascending: string[];
    }> = [
      { field: "title", ascending: ["2", "1"] },
      { field: "album", ascending: ["2", "1"] },
      { field: "genre", ascending: ["2", "1"] },
      { field: "bpm", ascending: ["1", "2"] },
      { field: "key", ascending: ["2", "1"] },
      { field: "plays", ascending: ["2", "1"] },
      { field: "status", ascending: ["2", "1"] },
      { field: "duration", ascending: ["1", "2"] },
    ];

    for (const { field, ascending } of sortCases) {
      expect(
        library.getTracks({ sort: { field, direction: "asc" } }).items.map((track) => track.id),
        `${field} ascending`,
      ).toEqual(ascending);
      expect(
        library.getTracks({ sort: { field, direction: "desc" } }).items.map((track) => track.id),
        `${field} descending`,
      ).toEqual([...ascending].reverse());
    }
    expect(
      library
        .getTracks({ playlistId: "500", sort: { field: "position", direction: "asc" } })
        .items.map((track) => track.id),
    ).toEqual(["2", "1"]);
    expect(
      library
        .getTracks({ playlistId: "500", sort: { field: "position", direction: "desc" } })
        .items.map((track) => track.id),
    ).toEqual(["1", "2"]);
    expect(
      library
        .getTracks({ playlistId: "500", sort: { field: "status", direction: "asc" } })
        .items.map((track) => [track.id, track.fileExists]),
    ).toEqual([
      ["2", false],
      ["1", true],
    ]);
    expect(
      library
        .getTracks({ playlistId: "500", sort: { field: "status", direction: "desc" } })
        .items.map((track) => [track.id, track.fileExists]),
    ).toEqual([
      ["1", true],
      ["2", false],
    ]);
    expect(
      library
        .getTracks({ sort: { field: "position", direction: "asc" } })
        .items.map((track) => track.id),
    ).toEqual(["2", "1"]);
  });

  it("keeps missing sort values last in SQL and the smart comparator", () => {
    const fixture = copiedFixture();
    configureTrackQueryFixture(fixture);
    const database = new MasterDatabase({ path: fixture.dbPath, readonly: false, unlock: false });
    database.connection!.exec(`
      UPDATE djmdContent SET BPM = 0, Length = NULL WHERE ID = '2';
      INSERT INTO djmdContent (
        ID, FolderPath, FileNameL, Title, BPM, Length, DJPlayCount, AnalysisDataPath, Analysed,
        UUID, rb_local_usn, rb_local_deleted, created_at, updated_at
      )
      SELECT '3', FolderPath, 'Three.mp3', 'Charlie', 13000, 240, 5, AnalysisDataPath, Analysed,
             'content-3', 9, NULL, '${now}', '${now}'
        FROM djmdContent WHERE ID = '1';
      INSERT INTO djmdSongPlaylist VALUES (
        'song-3', '500', '3', 3, 'song-3-uuid', 10, NULL, '${now}', '${now}'
      );
    `);
    database.close();
    const library = service(fixture);

    const summaries = ["2", "1", "3"].map((id) => library.getTrack(id));
    for (const field of ["bpm", "duration"] satisfies TrackSortField[]) {
      for (const playlistId of [undefined, "500"]) {
        expect(
          library
            .getTracks({
              ...(playlistId ? { playlistId } : {}),
              sort: { field, direction: "asc" },
            })
            .items.map((track) => track.id),
          `${field} ${playlistId ?? "library"} ascending`,
        ).toEqual(["1", "3", "2"]);
        expect(
          library
            .getTracks({
              ...(playlistId ? { playlistId } : {}),
              sort: { field, direction: "desc" },
            })
            .items.map((track) => track.id),
          `${field} ${playlistId ?? "library"} descending`,
        ).toEqual(["3", "1", "2"]);
      }
      expect(
        [...summaries].sort(trackComparator({ field, direction: "asc" })).map(({ id }) => id),
        `smart comparator ${field} ascending`,
      ).toEqual(["1", "3", "2"]);
      expect(
        [...summaries].sort(trackComparator({ field, direction: "desc" })).map(({ id }) => id),
        `smart comparator ${field} descending`,
      ).toEqual(["3", "1", "2"]);
    }
  });

  it("searches title, filename, artist, and album with escaped wildcards", () => {
    const fixture = copiedFixture();
    configureTrackQueryFixture(fixture);
    const library = service(fixture);

    for (const query of ["alpha", "%_", "\\", "Needle Artist", "Needle Album"])
      expect(library.getTracks({ q: query }).items.map((track) => track.id)).toEqual(["2"]);
    for (const field of [
      "position",
      "title",
      "album",
      "genre",
      "bpm",
      "key",
      "plays",
      "status",
      "duration",
    ] satisfies TrackSortField[])
      expect(
        library
          .getTracks({ q: "Needle", sort: { field, direction: "desc" } })
          .items.map((track) => track.id),
        `search sorted by ${field}`,
      ).toEqual(["2"]);
    expect(
      library
        .getTracks({
          playlistId: "500",
          q: "Needle Artist",
          sort: { field: "key", direction: "desc" },
        })
        .items.map((track) => track.id),
    ).toEqual(["2"]);
    expect(
      library.getTracks({ playlistId: "500", q: "\\" }).items.map((track) => track.id),
    ).toEqual(["2"]);
  });

  it("directly commits every playlist mutation on a copied fixture", async () => {
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
      expectedPlaylistIds: [folder.changedId, child.changedId],
    });

    expect(removedFolder).toMatchObject({
      operation: "delete-playlist",
      changedId: folder.changedId,
    });

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

  it("restores an empty playlist at its exact sibling sequence", async () => {
    const fixture = copiedFixture();
    const library = service(fixture);
    const before = library
      .getPlaylists()
      .filter((playlist) => playlist.parentId === "root")
      .map(({ id, seq }) => ({ id, seq }));

    const restored = await library.mutate({
      type: "create-playlist",
      name: "Restored first",
      seq: 1,
    });
    expect(
      library
        .getPlaylists()
        .filter((playlist) => playlist.parentId === "root")
        .map(({ id, seq }) => ({ id, seq })),
    ).toEqual([
      { id: restored.changedId, seq: 1 },
      ...before.map((item) => ({ ...item, seq: item.seq + 1 })),
    ]);

    await library.mutate({
      type: "delete-playlist",
      playlistId: restored.changedId,
      expectedPlaylistIds: [restored.changedId],
    });
    expect(
      library
        .getPlaylists()
        .filter((playlist) => playlist.parentId === "root")
        .map(({ id, seq }) => ({ id, seq })),
    ).toEqual(before);
  });

  it("reads, changes, and clears a track color", async () => {
    const fixture = copiedFixture();
    const library = service(fixture);

    expect(library.getTrack("1").colorId).toBe("7");
    const colored = await library.mutate({ type: "set-track-color", contentId: "1", colorId: "2" });
    expect(library.getTracks().items.find((track) => track.id === "1")?.colorId).toBe("2");
    expect(colored.revision).toBe(library.getTrack("1").revision);

    const cleared = await library.mutate({
      type: "set-track-color",
      contentId: "1",
      colorId: null,
    });
    expect(library.getTrack("1").colorId).toBeNull();
    expect(cleared.revision).toBe(library.getTrack("1").revision);
  });

  it("updates normalized track metadata in the Rekordbox database", async () => {
    const fixture = copiedFixture();
    const library = service(fixture);
    const initialRevision = library.getTrack("1").revision;

    await library.mutate({
      type: "update-track",
      contentId: "1",
      expectedRevision: initialRevision,
      metadata: {
        title: "  Updated title  ",
        artist: "Test Artist",
        album: "Test Album",
        genre: "House",
        key: "F minor",
        bpm: 128.25,
        rating: 5,
        comment: "  Peak time  ",
        releaseYear: 2024,
        isrc: "NEW000000001",
      },
    });

    const updated = library.getTrack("1");
    expect(updated.revision).not.toBe(initialRevision);
    expect(updated).toMatchObject({
      album: "Test Album",
      artist: "Test Artist",
      bpm: 128.25,
      comment: "Peak time",
      genre: "House",
      isrc: "NEW000000001",
      key: "4A",
      rating: 5,
      releaseYear: 2024,
      title: "Updated title",
    });
  });

  it("rejects stale track metadata before staging any changes", async () => {
    const fixture = copiedFixture();
    const library = service(fixture);
    const initialRevision = library.getTrack("1").revision;
    const metadata = {
      title: "First committed title",
      artist: "Test Artist",
      album: "Test Album",
      genre: "House",
      key: "F minor",
      bpm: 128,
      rating: 4,
      comment: "Committed",
      releaseYear: 2025,
      isrc: "NEW000000002",
    };

    const receipt = await library.mutate({
      type: "update-track",
      contentId: "1",
      expectedRevision: initialRevision,
      metadata,
    });
    const committedRevision = library.getTrack("1").revision;
    expect(committedRevision).not.toBe(initialRevision);
    expect(receipt.revision).toBe(committedRevision);

    await expect(
      library.mutate({
        type: "update-track",
        contentId: "1",
        expectedRevision: initialRevision,
        metadata: {
          ...metadata,
          title: "Stale title",
          artist: "Never staged artist",
        },
      }),
    ).rejects.toBeInstanceOf(LibraryMutationConflictError);
    expect(library.getTrack("1")).toMatchObject({
      revision: committedRevision,
      title: "First committed title",
      artist: "Test Artist",
    });

    const db = new MasterDatabase({ path: fixture.dbPath, readonly: true, unlock: false });
    expect(
      db.selectRawRows('SELECT "ID" FROM "djmdArtist" WHERE "Name" = ?', ["Never staged artist"]),
    ).toEqual([]);
    db.close();
  });

  it("atomically replaces playlist order", async () => {
    const fixture = copiedFixture();
    const library = service(fixture);

    const receipt = await library.mutate({
      type: "replace-playlist-tracks",
      playlistId: "500",
      contentIds: ["2", "1"],
      expectedMembershipIds: ["song-1"],
    });

    expect(receipt.membershipIds).toEqual([expect.any(String), "song-1"]);
    expect(library.getTracks({ playlistId: "500" }).items).toMatchObject([
      { id: "2", trackNumber: 1 },
      { id: "1", trackNumber: 2 },
    ]);
    const db = new MasterDatabase({ path: fixture.dbPath, readonly: true, unlock: false });
    expect(
      db.selectRawRows(
        `SELECT "ID" AS id, "UUID" AS uuid, "ContentID" AS contentId, "TrackNo" AS trackNumber
         FROM "djmdSongPlaylist" WHERE "PlaylistID" = ? ORDER BY "TrackNo"`,
        ["500"],
      ),
    ).toEqual([
      expect.objectContaining({ contentId: "2", trackNumber: 1 }),
      { contentId: "1", id: "song-1", trackNumber: 2, uuid: "song-1-uuid" },
    ]);
    db.close();
  });

  it("rejects a stale canvas snapshot before writing", async () => {
    const fixture = copiedFixture();
    const library = service(fixture);

    await expect(
      library.mutate({
        type: "replace-playlist-tracks",
        playlistId: "500",
        contentIds: ["1"],
        expectedMembershipIds: ["stale-membership"],
      }),
    ).rejects.toBeInstanceOf(LibraryMutationConflictError);
  });

  it("rejects deletion when a confirmed playlist subtree has changed", async () => {
    const fixture = copiedFixture();
    const library = service(fixture);
    const folder = await library.mutate({
      type: "create-playlist",
      name: "Folder",
      kind: "folder",
    });
    await library.mutate({
      type: "create-playlist",
      name: "Late child",
      parentId: folder.changedId,
    });

    await expect(
      library.mutate({
        type: "delete-playlist",
        playlistId: folder.changedId,
        expectedPlaylistIds: [folder.changedId],
      }),
    ).rejects.toBeInstanceOf(LibraryMutationConflictError);
    expect(library.getPlaylists()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: folder.changedId, name: "Folder" }),
        expect.objectContaining({ name: "Late child", parentId: folder.changedId }),
      ]),
    );
  });

  it("checks the Rekordbox process state once immediately before commit", async () => {
    const fixture = copiedFixture();
    const getProcessState = vi.fn(() => ({ rekordboxPid: 0, rekordboxAgentPid: 0 }));
    const library = new RekordboxLibraryService({
      dbPath: fixture.dbPath,
      getProcessState,
      unlock: false,
      writeEnabled: true,
    });
    services.push(library);

    await library.mutate({ type: "create-playlist", name: "Guarded" });

    expect(getProcessState).toHaveBeenCalledTimes(1);
    expect(library.getPlaylists()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Guarded" })]),
    );
  });

  it("does not autoflush new metadata relations before the process guard", async () => {
    const fixture = copiedFixture();
    let transactionOpenAtGuard: boolean | undefined;
    let library!: RekordboxLibraryService;
    library = new RekordboxLibraryService({
      dbPath: fixture.dbPath,
      getProcessState: () => {
        transactionOpenAtGuard = (library as unknown as { database?: MasterDatabase }).database
          ?.connection?.inTransaction;
        return { rekordboxPid: 0, rekordboxAgentPid: 0 };
      },
      unlock: false,
      writeEnabled: true,
    });
    services.push(library);
    const initialRevision = library.getTrack("1").revision;

    await library.mutate({
      type: "update-track",
      contentId: "1",
      expectedRevision: initialRevision,
      metadata: {
        title: "One",
        artist: "New Artist",
        album: "New Album",
        genre: "New Genre",
        key: "Fm",
        bpm: 124,
        rating: 3,
        comment: "First",
        releaseYear: 2024,
        isrc: "TEST00000001",
      },
    });

    expect(transactionOpenAtGuard).toBe(false);
    expect(library.getTrack("1")).toMatchObject({
      album: "New Album",
      artist: "New Artist",
      genre: "New Genre",
    });
  });

  it("does not autoflush playlist deletion before the process guard", async () => {
    const fixture = copiedFixture();
    let transactionOpenAtGuard: boolean | undefined;
    let library!: RekordboxLibraryService;
    library = new RekordboxLibraryService({
      dbPath: fixture.dbPath,
      getProcessState: () => {
        transactionOpenAtGuard = (library as unknown as { database?: MasterDatabase }).database
          ?.connection?.inTransaction;
        return { rekordboxPid: 0, rekordboxAgentPid: 0 };
      },
      unlock: false,
      writeEnabled: true,
    });
    services.push(library);

    await library.mutate({
      type: "delete-playlist",
      playlistId: "500",
      expectedPlaylistIds: ["500"],
    });

    expect(transactionOpenAtGuard).toBe(false);
    expect(library.getPlaylists()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "500" })]),
    );
  });

  it("rolls back staged changes when Rekordbox starts before commit", async () => {
    const fixture = copiedFixture();
    const library = new RekordboxLibraryService({
      dbPath: fixture.dbPath,
      getProcessState: () => ({ rekordboxPid: 123, rekordboxAgentPid: 0 }),
      unlock: false,
      writeEnabled: true,
    });
    services.push(library);

    await expect(
      library.mutate({ type: "create-playlist", name: "Never committed" }),
    ).rejects.toThrow("Close Rekordbox");

    expect(library.getPlaylists()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Never committed" })]),
    );
  });

  it("writes, reads, and deletes memory and A-P Hot Cues", async () => {
    const fixture = copiedFixture();
    const library = service(fixture);

    const memory = await library.mutate({
      type: "upsert-cue",
      contentId: "1",
      cue: { kind: "memory", type: "cue", startSeconds: 12.345 },
    });
    expect(memory.revision).toBe(library.getTrack("1").revision);
    const hot = await library.mutate({
      type: "upsert-cue",
      contentId: "1",
      cue: {
        kind: "hot",
        slot: 16,
        type: "loop",
        startSeconds: 20,
        endSeconds: 24,
        comment: "Drop",
        color: 255,
      },
    });
    expect(library.getTrack("1").cues).toMatchObject([
      { id: memory.changedId, kind: "memory", startSeconds: 12.345 },
      { id: hot.changedId, kind: "hot", slot: 16, type: "loop", comment: "Drop" },
    ]);

    await library.mutate({
      type: "delete-cue",
      contentId: "1",
      cueId: memory.changedId,
    });
    expect(library.getTrack("1").cues.map((cue) => cue.id)).toEqual([hot.changedId]);
  });

  it("waits for a concurrent external WAL writer and serializes queued mutations", async () => {
    const fixture = copiedFixture();
    const library = service(fixture);
    const journalSetup = new MasterDatabase({
      path: fixture.dbPath,
      readonly: false,
      unlock: false,
    });
    expect(journalSetup.connection!.pragma("journal_mode = WAL", { simple: true })).toBe("wal");
    journalSetup.close();

    const releaseExternalWriter = await acquireRekordboxDatabaseLock(fixture.dbPath);
    const externalWriter = new MasterDatabase({
      path: fixture.dbPath,
      readonly: false,
      unlock: false,
    });
    externalWriter.renamePlaylist("500", "External");
    externalWriter.flush();

    let firstSettled = false;
    const first = library.mutate({
      type: "add-track",
      playlistId: "500",
      contentId: "2",
    });
    void first.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );
    const second = library.mutate({
      type: "upsert-cue",
      contentId: "1",
      cue: { kind: "memory", type: "cue", startSeconds: 30 },
    });

    await delay(75);
    const waitedForExternalWriter = !firstSettled;
    externalWriter.commit({ allowWhileRunning: true });
    externalWriter.close();
    await releaseExternalWriter();
    expect(waitedForExternalWriter).toBe(true);
    await Promise.all([first, second]);

    expect(library.getPlaylists()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "500", name: "External" })]),
    );
    expect(library.getTracks({ playlistId: "500" }).items.map((track) => track.id)).toEqual([
      "1",
      "2",
    ]);
    expect(library.getTrack("1").cues).toEqual([
      expect.objectContaining({ kind: "memory", startSeconds: 30 }),
    ]);
  });

  it("surfaces a sidecar failure after SQLite commits", async () => {
    const fixture = copiedFixture();
    const open = vi.spyOn(MasterDatabase.prototype, "open");
    const close = vi.spyOn(MasterDatabase.prototype, "close");
    const library = service(fixture);
    library.getPlaylists();
    vi.spyOn(MasterPlaylistXml.prototype, "save").mockImplementation(() => {
      throw new Error("injected sidecar failure");
    });

    await expect(library.mutate({ type: "create-playlist", name: "Partial" })).rejects.toThrow(
      "injected sidecar failure",
    );

    expect(close).toHaveBeenCalledTimes(1);
    expect(library.getPlaylists()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "Partial" })]),
    );
    expect(open).toHaveBeenCalledTimes(2);

    const db = new MasterDatabase({ path: fixture.dbPath, readonly: true, unlock: false });
    const committed = db.selectRawRows('SELECT "ID" AS id FROM "djmdPlaylist" WHERE "Name" = ?', [
      "Partial",
    ]);
    expect(committed).toHaveLength(1);
    db.close();
    expect(new MasterPlaylistXml(fixture.xmlPath).get(String(committed[0]!.id))).toBeUndefined();
  });
});
