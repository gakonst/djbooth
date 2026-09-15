import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it } from "vitest";

import { AnlzFile } from "../src/anlz/index.js";
import { DeviceLibraryPlus, writeOneLibraryPlaylist } from "../src/devicelib-plus/index.js";
import {
  exportLegacyDeviceLibrary,
  inspectLegacyDevicePdb,
  legacyUsbAnalysisPath,
  LegacyDevicePdbWriter,
  readLegacyDeviceExportMarker,
  syncLegacyDeviceLibrary,
  syncLegacyDevicePlaylist,
  syncLegacyDevicePlaylistFolder,
} from "../src/devicelib/index.js";
import { MasterDatabase } from "../src/masterdb/index.js";

import { createDeviceLibraryFixture } from "./helpers/device-library-fixture.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function exportFixture() {
  const fixture = createDeviceLibraryFixture();
  roots.push(fixture.root);
  return fixture;
}

async function writePlayedHistory(
  output: string,
  contentOrder: readonly string[],
  name = "HISTORY 001",
): Promise<void> {
  const marker = await readLegacyDeviceExportMarker(output);
  if (!marker || marker.schemaVersion !== 2) throw new Error("Expected a version 2 export marker");
  const byContentId = new Map(marker.trackMap.map((mapping) => [mapping.contentId, mapping]));
  const writer = new LegacyDevicePdbWriter();
  for (const mapping of marker.trackMap)
    writer.addTrack({
      id: mapping.pdbId,
      title: `Track ${mapping.contentId}`,
      filePath: mapping.usbAudioPath,
    });
  const history = writer.createHistory(name);
  for (const contentId of contentOrder) {
    const mapping = byContentId.get(contentId);
    if (!mapping) throw new Error(`Unknown fixture content '${contentId}'`);
    writer.addToHistory(history, mapping.pdbId);
  }
  writeFileSync(join(output, "PIONEER", "rekordbox", "export.pdb"), writer.build());
}

describe("legacy Device Library PDB", () => {
  it("derives the hardware ANLZ lookup path from the USB audio path", () => {
    expect(
      legacyUsbAnalysisPath(
        "/Contents/Brunello_Hilel Lev/Apathy/Brunello & Hilel Lev - Apathy.mp3",
      ),
    ).toBe("/PIONEER/USBANLZ/P03E/0000EAC4/ANLZ0000.DAT");
    expect(legacyUsbAnalysisPath("/Contents/Leo Portela/Bon Vibrant - Leo Portela.flac")).toBe(
      "/PIONEER/USBANLZ/P00E/000281CE/ANLZ0000.DAT",
    );
  });

  it("appends tracks and playlists without rebuilding existing rows", () => {
    const initial = new LegacyDevicePdbWriter();
    const existingTrack = initial.addTrack({
      id: 40,
      title: "Existing",
      artist: "Original Artist",
      filePath: "/Contents/original.mp3",
    });
    const existingFolder = initial.createPlaylist("Existing Folder", { folder: true });
    const existingPlaylist = initial.createPlaylist("Existing Playlist", {
      parentId: existingFolder,
    });
    initial.addToPlaylist(existingPlaylist, existingTrack);

    const appended = new LegacyDevicePdbWriter(initial.build());
    const newTrack = appended.addTrack({
      title: "New",
      artist: "New Artist",
      filePath: "/Contents/music-ts/new.m4a",
    });
    const newFolder = appended.createPlaylist("DJ Sets I Like", { folder: true });
    const newPlaylist = appended.createPlaylist("Lee Burridge", { parentId: newFolder });
    appended.addToPlaylist(newPlaylist, newTrack);

    const inspection = inspectLegacyDevicePdb(appended.build());
    expect(newTrack).toBe(41);
    expect(inspection.tracks).toEqual([
      expect.objectContaining({ id: 40, title: "Existing", artist: "Original Artist" }),
      expect.objectContaining({ id: 41, title: "New", artist: "New Artist" }),
    ]);
    expect(inspection.playlists).toEqual([
      expect.objectContaining({ id: existingFolder, name: "Existing Folder", folder: true }),
      expect.objectContaining({
        id: existingPlaylist,
        name: "Existing Playlist",
        trackIds: [40],
      }),
      expect.objectContaining({ id: newFolder, name: "DJ Sets I Like", folder: true }),
      expect.objectContaining({ id: newPlaylist, name: "Lee Burridge", trackIds: [41] }),
    ]);
  });

  it("writes tracks, lookup metadata, folders, and ordered playlists", () => {
    const writer = new LegacyDevicePdbWriter();
    const first = writer.addTrack({
      title: "Stavöstranos — épreuve",
      artist: "Artist",
      album: "Album",
      genre: "Techno",
      key: "Am",
      filePath: "/Contents/00000001/first.flac",
      analyzePath: "/PIONEER/USBANLZ/P001/00000001/ANLZ0000.DAT",
      tempo: 12801,
      duration: 321,
      fileSize: 12_345_678,
      fileType: 5,
    });
    const second = writer.addTrack({
      title: "Second",
      artist: "Artist",
      album: "Album",
      filePath: "/Contents/00000002/second.mp3",
      analyzePath: "/PIONEER/USBANLZ/P002/00000002/ANLZ0000.DAT",
    });
    const folder = writer.createPlaylist("2026 Gigs", { folder: true });
    const playlist = writer.createPlaylist("Berghain", { parentId: folder });
    writer.addToPlaylist(playlist, second);
    writer.addToPlaylist(playlist, first);

    const inspection = inspectLegacyDevicePdb(writer.build());

    expect(inspection.pageSize).toBe(4096);
    expect(inspection.tracks).toEqual([
      expect.objectContaining({
        id: first,
        title: "Stavöstranos — épreuve",
        artist: "Artist",
        album: "Album",
        genre: "Techno",
        key: "Am",
        tempo: 12801,
        duration: 321,
      }),
      expect.objectContaining({ id: second, title: "Second" }),
    ]);
    expect(inspection.playlists).toEqual([
      { id: folder, parentId: 0, name: "2026 Gigs", folder: true, trackIds: [] },
      {
        id: playlist,
        parentId: folder,
        name: "Berghain",
        folder: false,
        trackIds: [second, first],
      },
    ]);
  });

  it("allocates fresh pages for a large compiled library", () => {
    const writer = new LegacyDevicePdbWriter();
    for (let index = 0; index < 500; index++)
      writer.addTrack({
        title: `Track ${String(index).padStart(4, "0")}`,
        artist: `Artist ${String(index % 17)}`,
        filePath: `/Contents/${String(index).padStart(8, "0")}/track.mp3`,
      });

    const inspection = inspectLegacyDevicePdb(writer.build());
    expect(inspection.tracks).toHaveLength(500);
    expect(inspection.tracks.at(-1)).toMatchObject({ id: 500, title: "Track 0499" });
  });

  it("rejects unsupported audio formats instead of lying to the CDJ", () => {
    const writer = new LegacyDevicePdbWriter();
    expect(() =>
      writer.addTrack({ title: "Unsupported", filePath: "/Contents/track.ogg" }),
    ).toThrow("does not support '.ogg'");
  });

  it("preserves explicit track IDs and parses ordered CDJ histories", () => {
    const writer = new LegacyDevicePdbWriter();
    writer.addTrack({
      id: 42,
      title: "First",
      filePath: "/Contents/0000002A/first.mp3",
      playCount: 7,
    });
    writer.addTrack({
      id: 9,
      title: "Second",
      filePath: "/Contents/00000009/second.mp3",
    });
    const history = writer.createHistory("HISTORY 001", 6);
    writer.addToHistory(history, 9);
    writer.addToHistory(history, 42);
    writer.addToHistory(history, 9);

    const inspection = inspectLegacyDevicePdb(writer.build());
    expect(inspection.tracks.map(({ id, playCount }) => ({ id, playCount }))).toEqual([
      { id: 42, playCount: 7 },
      { id: 9, playCount: 0 },
    ]);
    expect(inspection.histories).toEqual([{ id: 6, name: "HISTORY 001", trackIds: [9, 42, 9] }]);
  });

  it("consumes histories without changing tracks or playlists", () => {
    const initial = new LegacyDevicePdbWriter();
    const track = initial.addTrack({
      id: 42,
      title: "Played",
      filePath: "/Contents/0000002A/played.mp3",
    });
    const playlist = initial.createPlaylist("Keep");
    initial.addToPlaylist(playlist, track);
    const history = initial.createHistory("HISTORY 001");
    initial.addToHistory(history, track);
    const before = inspectLegacyDevicePdb(initial.build());

    const consumed = new LegacyDevicePdbWriter(initial.build());
    consumed.clearHistories();
    const after = inspectLegacyDevicePdb(consumed.build());

    expect(after.histories).toEqual([]);
    expect(after.tracks).toEqual(before.tracks);
    expect(after.playlists).toEqual(before.playlists);
  });
});

describe("master.db to legacy Device Library export", () => {
  it("appends one playlist to an unowned existing export and reuses its receipt", async () => {
    const fixture = exportFixture();
    const rekordboxDirectory = join(fixture.output, "PIONEER", "rekordbox");
    mkdirSync(rekordboxDirectory, { recursive: true });
    const existing = new LegacyDevicePdbWriter();
    const existingTrack = existing.addTrack({
      id: 90,
      title: "Keep Me",
      filePath: "/Contents/existing/keep.mp3",
    });
    const existingPlaylist = existing.createPlaylist("Existing");
    existing.addToPlaylist(existingPlaylist, existingTrack);
    writeFileSync(join(rekordboxDirectory, "export.pdb"), existing.build());
    writeOneLibraryPlaylist({
      create: true,
      folderName: "Existing Folder",
      path: join(rekordboxDirectory, "exportLibrary.db"),
      playlistName: "Existing",
      tracks: [
        {
          masterContentId: "90",
          title: "Keep Me",
          fileName: "keep.mp3",
          fileSize: 1,
          fileType: 1,
          usbAudioPath: "/Contents/existing/keep.mp3",
          usbAnalysisPath: "/PIONEER/USBANLZ/P090/0000005A/ANLZ0000.DAT",
        },
      ],
    });

    const first = await syncLegacyDevicePlaylist({
      targetDirectory: fixture.output,
      databasePath: fixture.databasePath,
      databaseUnlock: false,
      playlistId: "playlist",
      now: new Date("2026-08-02T12:00:00Z"),
    });
    expect(first).toMatchObject({
      changed: true,
      folderName: "Gigs",
      playlistName: "Tonight",
      tracks: 2,
      audioFiles: 2,
      analysisFiles: 6,
    });
    const inspection = inspectLegacyDevicePdb(readFileSync(join(rekordboxDirectory, "export.pdb")));
    expect(inspection.tracks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 90, title: "Keep Me" }),
        expect.objectContaining({ id: 91, title: "Second" }),
        expect.objectContaining({ id: 92, title: "First" }),
      ]),
    );
    expect(inspection.playlists).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: existingPlaylist, name: "Existing", trackIds: [90] }),
        expect.objectContaining({ name: "Gigs", folder: true }),
        expect.objectContaining({ name: "Tonight", trackIds: [91, 92] }),
      ]),
    );
    const oneLibrary = new DeviceLibraryPlus(first.oneLibraryPath!);
    expect(
      oneLibrary.executeSql("SELECT name FROM playlist WHERE attribute = 0 ORDER BY playlist_id"),
    ).toEqual([{ name: "Existing" }, { name: "Tonight" }]);
    expect(oneLibrary.executeSql("SELECT COUNT(*) AS count FROM content")).toEqual([{ count: 3 }]);
    oneLibrary.close();

    const second = await syncLegacyDevicePlaylist({
      targetDirectory: fixture.output,
      databasePath: fixture.databasePath,
      databaseUnlock: false,
      playlistId: "playlist",
      now: new Date("2026-08-02T12:05:00Z"),
    });
    expect(second).toMatchObject({ changed: false, tracks: 2, bytesCopied: 0 });
  }, 15_000);

  it("initializes a fresh dual-library stick and verifies a zero-copy rerun", async () => {
    const fixture = exportFixture();
    mkdirSync(fixture.output);
    const first = await syncLegacyDevicePlaylist({
      databasePath: fixture.databasePath,
      databaseUnlock: false,
      fresh: true,
      now: new Date("2026-08-02T12:00:00Z"),
      playlistId: "playlist",
      targetDirectory: fixture.output,
    });
    expect(first).toMatchObject({
      analysisFiles: 6,
      audioFiles: 2,
      changed: true,
      format: "dual-device-playlist-sync",
      playlistName: "Tonight",
      tracks: 2,
    });
    const legacy = inspectLegacyDevicePdb(
      readFileSync(join(fixture.output, "PIONEER", "rekordbox", "export.pdb")),
    );
    expect(legacy.tracks).toHaveLength(2);
    expect(legacy.tracks.map(({ analyzePath }) => analyzePath)).toEqual([
      legacyUsbAnalysisPath("/Contents/music-ts/00000001/two.flac"),
      legacyUsbAnalysisPath("/Contents/music-ts/00000002/one.mp3"),
    ]);
    for (const track of legacy.tracks)
      expect(existsSync(join(fixture.output, track.analyzePath.slice(1)))).toBe(true);
    expect(legacy.playlists.map(({ name }) => name)).toEqual(["Gigs", "Tonight"]);
    const oneLibrary = new DeviceLibraryPlus(first.oneLibraryPath!);
    expect(
      oneLibrary.executeSql("SELECT title, analysisDataFilePath FROM content ORDER BY content_id"),
    ).toEqual([
      {
        title: "Second",
        analysisDataFilePath: legacyUsbAnalysisPath("/Contents/music-ts/00000001/two.flac"),
      },
      {
        title: "First",
        analysisDataFilePath: legacyUsbAnalysisPath("/Contents/music-ts/00000002/one.mp3"),
      },
    ]);
    expect(oneLibrary.executeSql("SELECT name FROM playlist ORDER BY playlist_id")).toEqual([
      { name: "Gigs" },
      { name: "Tonight" },
    ]);
    oneLibrary.close();

    const second = await syncLegacyDevicePlaylist({
      databasePath: fixture.databasePath,
      databaseUnlock: false,
      playlistId: "playlist",
      targetDirectory: fixture.output,
    });
    expect(second).toMatchObject({ changed: false, bytesCopied: 0, tracks: 2 });
  });

  it("syncs one host folder in one deduplicated pass and imports its CDJ history", async () => {
    const fixture = exportFixture();
    let connection = new Database(fixture.databasePath);
    connection.exec(`
      INSERT INTO djmdPlaylist (ID, Seq, Name, Attribute, ParentID, SmartList, rb_local_deleted)
      VALUES ('playlist-2', 2, 'Tomorrow', 0, 'folder', NULL, 0);
      INSERT INTO djmdSongPlaylist (ID, PlaylistID, ContentID, TrackNo, rb_local_deleted)
      VALUES ('membership-3', 'playlist-2', '1', 1, 0);
      INSERT INTO djmdSongPlaylist (ID, PlaylistID, ContentID, TrackNo, rb_local_deleted)
      VALUES ('membership-4', 'playlist-2', '2', 2, 0);
    `);
    connection.close();
    mkdirSync(fixture.output);

    const progress: string[] = [];
    const first = await syncLegacyDevicePlaylistFolder({
      databasePath: fixture.databasePath,
      databaseUnlock: false,
      folderName: "Gigs",
      fresh: true,
      now: new Date("2026-08-04T12:00:00Z"),
      onProgress(update) {
        progress.push(update.phase);
      },
      targetDirectory: fixture.output,
    });
    expect(first).toMatchObject({
      changed: true,
      playlistsChanged: 2,
      tracks: 4,
      uniqueTracksAdded: 2,
      audioFiles: 2,
      analysisFiles: 6,
      historiesFound: 0,
    });
    expect(first.playlists.map(({ playlistName }) => playlistName)).toEqual([
      "Tonight",
      "Tomorrow",
    ]);
    expect(progress).toEqual(
      expect.arrayContaining([
        "prepare",
        "inventory",
        "plan",
        "catalog",
        "copy",
        "publish",
        "verify",
        "complete",
      ]),
    );
    const pdbPath = join(fixture.output, "PIONEER", "rekordbox", "export.pdb");
    let inspection = inspectLegacyDevicePdb(readFileSync(pdbPath));
    expect(inspection.tracks).toHaveLength(2);
    expect(inspection.playlists.map(({ name }) => name)).toEqual(["Gigs", "Tonight", "Tomorrow"]);
    const marker = JSON.parse(
      readFileSync(join(fixture.output, ".music-cdj-playlist-sync.json"), "utf8"),
    ) as {
      schemaVersion: number;
      records: Array<{
        playlistName: string;
        trackIds: number[];
        contentIds: string[];
        oneLibraryContentIds: number[];
      }>;
    };
    expect(marker.schemaVersion).toBe(3);
    expect(marker.records.every(({ contentIds }) => contentIds.length === 2)).toBe(true);

    const played = new LegacyDevicePdbWriter(readFileSync(pdbPath));
    const history = played.createHistory("HISTORY 001");
    played.addToHistory(history, marker.records[0]!.trackIds[0]!);
    played.addToHistory(history, marker.records[0]!.trackIds[1]!);
    writeFileSync(pdbPath, played.build());
    const second = await syncLegacyDevicePlaylistFolder({
      databasePath: fixture.databasePath,
      databaseUnlock: false,
      folderName: "Gigs",
      now: new Date("2026-08-04T12:05:00Z"),
      targetDirectory: fixture.output,
    });
    expect(second).toMatchObject({
      audioFiles: 0,
      analysisFiles: 0,
      historiesFound: 1,
      historiesImported: 1,
      historyPlaylistsCreated: 1,
      playCountIncrements: 2,
      playlistsChanged: 0,
      uniqueTracksAdded: 0,
    });
    expect(second.bytesCopied).toBe(0);
    inspection = inspectLegacyDevicePdb(readFileSync(pdbPath));
    expect(inspection.histories).toEqual([]);
    connection = new Database(fixture.databasePath);
    expect(
      connection.prepare("SELECT Name FROM djmdPlaylist WHERE Name LIKE 'DJ Set %'").pluck().all(),
    ).toEqual(["DJ Set 2026-08-04"]);
    connection.close();
  });

  it("retires a legacy scoped receipt after its host playlist is deleted", async () => {
    const fixture = exportFixture();
    let connection = new Database(fixture.databasePath);
    connection.exec(`
      INSERT INTO djmdPlaylist (ID, Seq, Name, Attribute, ParentID, SmartList, rb_local_deleted)
      VALUES ('playlist-2', 2, 'Tomorrow', 0, 'folder', NULL, 0);
      INSERT INTO djmdSongPlaylist (ID, PlaylistID, ContentID, TrackNo, rb_local_deleted)
      VALUES ('membership-3', 'playlist-2', '1', 1, 0);
    `);
    connection.close();
    mkdirSync(fixture.output);

    await syncLegacyDevicePlaylistFolder({
      databasePath: fixture.databasePath,
      databaseUnlock: false,
      folderName: "Gigs",
      fresh: true,
      targetDirectory: fixture.output,
    });

    const markerPath = join(fixture.output, ".music-cdj-playlist-sync.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      records: Array<{ contentIds?: string[]; playlistId: string; playlistName: string }>;
    };
    const deletedRecord = marker.records.find(({ playlistId }) => playlistId === "playlist");
    if (!deletedRecord) throw new Error("Expected the Tonight scoped receipt");
    delete deletedRecord.contentIds;
    writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    connection = new Database(fixture.databasePath);
    connection.prepare("UPDATE djmdPlaylist SET rb_local_deleted = 1 WHERE ID = ?").run("playlist");
    connection.close();

    const result = await syncLegacyDevicePlaylistFolder({
      databasePath: fixture.databasePath,
      databaseUnlock: false,
      folderName: "Gigs",
      targetDirectory: fixture.output,
    });
    expect(result).toMatchObject({ changed: false, playlistsChanged: 0, tracks: 1 });
    const updatedMarker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      records: Array<{ playlistId: string }>;
    };
    expect(updatedMarker.records.map(({ playlistId }) => playlistId)).toEqual(["playlist-2"]);
  });

  it("uses the audio filename when a scoped playlist track has an empty title", async () => {
    const fixture = exportFixture();
    const connection = new Database(fixture.databasePath);
    connection.prepare("UPDATE djmdContent SET Title = '' WHERE ID = ?").run("1");
    connection.close();
    mkdirSync(fixture.output);

    await syncLegacyDevicePlaylistFolder({
      databasePath: fixture.databasePath,
      databaseUnlock: false,
      folderName: "Gigs",
      fresh: true,
      targetDirectory: fixture.output,
    });

    const inspection = inspectLegacyDevicePdb(
      readFileSync(join(fixture.output, "PIONEER", "rekordbox", "export.pdb")),
    );
    expect(inspection.tracks.find(({ filePath }) => filePath.endsWith("/one.mp3"))?.title).toBe(
      "one.mp3",
    );
  });

  it("keeps SQLite authoritative and emits audio, rewritten ANLZ, playlists, and export.pdb", async () => {
    const fixture = exportFixture();
    const before = createHash("sha256").update(readFileSync(fixture.databasePath)).digest("hex");
    const database = new MasterDatabase({
      path: fixture.databasePath,
      readonly: true,
      unlock: false,
    });
    const result = await exportLegacyDeviceLibrary({
      database,
      targetDirectory: fixture.output,
      generatedAt: new Date("2026-07-28T12:00:00Z"),
    });
    database.close();

    expect(result).toMatchObject({
      format: "legacy-device-library",
      tracks: 2,
      playlists: 2,
      analysisFiles: 6,
      generatedAt: "2026-07-28T12:00:00.000Z",
    });
    const inspection = inspectLegacyDevicePdb(readFileSync(result.pdbPath));
    expect(inspection.tracks.map(({ title, filePath }) => ({ title, filePath }))).toEqual([
      { title: "First", filePath: "/Contents/00000001/one.mp3" },
      { title: "Second", filePath: "/Contents/00000002/two.flac" },
    ]);
    expect(inspection.playlists).toEqual([
      { id: 1, parentId: 0, name: "Gigs", folder: true, trackIds: [] },
      { id: 2, parentId: 1, name: "Tonight", folder: false, trackIds: [2, 1] },
    ]);
    expect(
      AnlzFile.parseFile(
        join(fixture.output, inspection.tracks[0]!.analyzePath.replace(/^\//u, "")),
      ).get("PPTH"),
    ).toBe("/Contents/00000001/one.mp3");
    expect(existsSync(join(fixture.output, "Contents", "00000002", "two.flac"))).toBe(true);
    expect(createHash("sha256").update(readFileSync(fixture.databasePath)).digest("hex")).toBe(
      before,
    );
  });

  it("replaces only a volume carrying this exporter's ownership marker", async () => {
    const fixture = exportFixture();
    let database = new MasterDatabase({
      path: fixture.databasePath,
      readonly: true,
      unlock: false,
    });
    await exportLegacyDeviceLibrary({ database, targetDirectory: fixture.output });
    await expect(
      exportLegacyDeviceLibrary({ database, targetDirectory: fixture.output }),
    ).rejects.toThrow("pass replace");
    database.close();

    const connection = new Database(fixture.databasePath);
    connection.prepare("UPDATE djmdContent SET Title = 'Updated' WHERE ID = '1'").run();
    connection.close();
    database = new MasterDatabase({
      path: fixture.databasePath,
      readonly: true,
      unlock: false,
    });
    const replaced = await exportLegacyDeviceLibrary({
      database,
      targetDirectory: fixture.output,
      replace: true,
    });
    database.close();

    expect(inspectLegacyDevicePdb(readFileSync(replaced.pdbPath)).tracks[0]!.title).toBe("Updated");
  });

  it("rejects file metadata that disagrees with the actual audio extension", async () => {
    const fixture = exportFixture();
    const connection = new Database(fixture.databasePath);
    connection.prepare("UPDATE djmdContent SET FileType = 1 WHERE ID = '2'").run();
    connection.close();
    const database = new MasterDatabase({
      path: fixture.databasePath,
      readonly: true,
      unlock: false,
    });

    await expect(
      exportLegacyDeviceLibrary({ database, targetDirectory: fixture.output }),
    ).rejects.toThrow("disagrees with Rekordbox FileType 1");
    database.close();
  });

  it("differentially reuses stable media identities and removes deleted library tracks", async () => {
    const fixture = exportFixture();
    mkdirSync(fixture.output);
    const first = await syncLegacyDeviceLibrary({
      targetDirectory: fixture.output,
      databasePath: fixture.databasePath,
      databaseUnlock: false,
      now: new Date("2026-07-29T10:00:00Z"),
    });
    expect(first.export).toMatchObject({
      changed: true,
      tracksCopied: 2,
      tracksReused: 0,
    });
    const firstMarker = await readLegacyDeviceExportMarker(fixture.output);
    expect(firstMarker?.schemaVersion).toBe(2);

    const second = await syncLegacyDeviceLibrary({
      targetDirectory: fixture.output,
      databasePath: fixture.databasePath,
      databaseUnlock: false,
      now: new Date("2026-07-29T10:05:00Z"),
    });
    expect(second.export).toMatchObject({
      changed: false,
      tracksCopied: 0,
      tracksReused: 2,
      bytesCopied: 0,
    });

    let connection = new Database(fixture.databasePath);
    connection.prepare("UPDATE djmdContent SET Title = 'Metadata only' WHERE ID = '1'").run();
    connection.close();
    const metadataOnly = await syncLegacyDeviceLibrary({
      targetDirectory: fixture.output,
      databasePath: fixture.databasePath,
      databaseUnlock: false,
      now: new Date("2026-07-29T10:10:00Z"),
    });
    expect(metadataOnly.export).toMatchObject({
      changed: true,
      tracksCopied: 0,
      tracksReused: 2,
      bytesCopied: 0,
    });
    const metadataMarker = await readLegacyDeviceExportMarker(fixture.output);
    if (!firstMarker || firstMarker.schemaVersion !== 2)
      throw new Error("Expected initial version 2 marker");
    if (!metadataMarker || metadataMarker.schemaVersion !== 2)
      throw new Error("Expected updated version 2 marker");
    expect(metadataMarker.trackMap.map(({ contentId, pdbId }) => ({ contentId, pdbId }))).toEqual(
      firstMarker.trackMap.map(({ contentId, pdbId }) => ({ contentId, pdbId })),
    );

    connection = new Database(fixture.databasePath);
    connection.prepare("DELETE FROM djmdSongPlaylist WHERE ContentID = '2'").run();
    connection.prepare("DELETE FROM djmdContent WHERE ID = '2'").run();
    connection.close();
    const removed = await syncLegacyDeviceLibrary({
      targetDirectory: fixture.output,
      databasePath: fixture.databasePath,
      databaseUnlock: false,
      now: new Date("2026-07-29T10:15:00Z"),
    });
    expect(removed.export).toMatchObject({
      tracks: 1,
      tracksCopied: 0,
      tracksReused: 1,
      filesRemoved: 4,
    });
    expect(existsSync(join(fixture.output, "Contents", "00000002", "two.flac"))).toBe(false);
  });

  it("imports a played history as a dated playlist and recovers idempotently after export failure", async () => {
    const fixture = exportFixture();
    mkdirSync(fixture.output);
    const syncOptions = {
      targetDirectory: fixture.output,
      databasePath: fixture.databasePath,
      databaseUnlock: false,
      now: new Date("2026-07-29T12:00:00Z"),
    } as const;
    await syncLegacyDeviceLibrary(syncOptions);
    await writePlayedHistory(fixture.output, ["2", "1", "2"]);

    const secondAudio = readFileSync(fixture.audioPaths[1]);
    rmSync(fixture.audioPaths[1]);
    await expect(syncLegacyDeviceLibrary(syncOptions)).rejects.toThrow("two.flac");

    let connection = new Database(fixture.databasePath);
    expect(
      connection
        .prepare("SELECT Name FROM djmdPlaylist WHERE Name LIKE 'DJ Set %'")
        .all()
        .map((row) => (row as { Name: string }).Name),
    ).toEqual(["DJ Set 2026-07-29"]);
    expect(
      connection
        .prepare(
          `SELECT sp.ContentID
           FROM djmdSongPlaylist sp
           JOIN djmdPlaylist p ON p.ID = sp.PlaylistID
           WHERE p.Name = 'DJ Set 2026-07-29'
           ORDER BY sp.TrackNo`,
        )
        .all()
        .map((row) => (row as { ContentID: string }).ContentID),
    ).toEqual(["2", "1", "2"]);
    expect(
      connection
        .prepare("SELECT ID, DJPlayCount FROM djmdContent ORDER BY ID")
        .all()
        .map((row) => row as { ID: string; DJPlayCount: string }),
    ).toEqual([
      { ID: "1", DJPlayCount: "3" },
      { ID: "2", DJPlayCount: "2" },
    ]);
    connection.close();

    const checkpoint = await readLegacyDeviceExportMarker(fixture.output);
    if (!checkpoint || checkpoint.schemaVersion !== 2)
      throw new Error("Expected checkpointed version 2 marker");
    expect(checkpoint.importedHistories).toHaveLength(1);
    writeFileSync(
      join(fixture.output, ".music-cdj-export.json"),
      `${JSON.stringify({ ...checkpoint, importedHistories: [] }, null, 2)}\n`,
    );

    writeFileSync(fixture.audioPaths[1], secondAudio);
    const recovered = await syncLegacyDeviceLibrary(syncOptions);
    expect(recovered).toMatchObject({
      historiesFound: 1,
      historiesImported: 0,
      historiesAlreadyImported: 1,
      playCountIncrements: 0,
    });
    expect(inspectLegacyDevicePdb(readFileSync(recovered.export.pdbPath)).histories).toEqual([]);
    expect(
      inspectLegacyDevicePdb(readFileSync(recovered.export.pdbPath)).playlists.map(
        ({ name }) => name,
      ),
    ).toContain("DJ Set 2026-07-29");

    connection = new Database(fixture.databasePath);
    expect(
      connection
        .prepare("SELECT ID, DJPlayCount FROM djmdContent ORDER BY ID")
        .all()
        .map((row) => row as { ID: string; DJPlayCount: string }),
    ).toEqual([
      { ID: "1", DJPlayCount: "3" },
      { ID: "2", DJPlayCount: "2" },
    ]);
    expect(
      connection
        .prepare("SELECT COUNT(*) AS count FROM djmdPlaylist WHERE Name LIKE 'DJ Set %'")
        .get(),
    ).toEqual({ count: 1 });
    connection.close();
  });
});
