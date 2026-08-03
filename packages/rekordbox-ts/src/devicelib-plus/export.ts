import { existsSync } from "node:fs";

import Database from "better-sqlite3-multiple-ciphers";

import { deobfuscate } from "../utils.js";
import { DEVICE_LIBRARY_PLUS_KEY_BLOB, DeviceLibraryPlus } from "./database.js";

const SCHEMA = `
CREATE TABLE album(album_id integer primary key, name varchar, artist_id integer, image_id integer, isComplation integer, nameForSearch varchar);
CREATE TABLE artist(artist_id integer primary key, name varchar, nameForSearch varchar);
CREATE TABLE category(category_id integer primary key, menuItem_id integer, sequenceNo integer, isVisible integer);
CREATE TABLE color(color_id integer primary key, name varchar);
CREATE TABLE content(content_id integer primary key, title varchar, titleForSearch varchar, subtitle varchar, bpmx100 integer, length integer, trackNo integer, discNo integer, artist_id_artist integer, artist_id_remixer integer, artist_id_originalArtist integer, artist_id_composer integer, artist_id_lyricist integer, album_id integer, genre_id integer, label_id integer, key_id integer, color_id integer, image_id integer, djComment varchar, rating integer, releaseYear integer, releaseDate varchar, dateCreated varchar, dateAdded varchar, path varchar, fileName varchar, fileSize integer, fileType integer, bitrate integer, bitDepth integer, samplingRate integer, isrc varchar, djPlayCount integer, isHotCueAutoLoadOn integer, isKuvoDeliverStatusOn integer, kuvoDeliveryComment varchar, masterDbId integer, masterContentId integer, analysisDataFilePath varchar, analysedBits integer, contentLink integer, hasModified integer, cueUpdateCount integer, analysisDataUpdateCount integer, informationUpdateCount integer);
CREATE TABLE cue(cue_id integer primary key, content_id integer, kind integer, colorTableIndex integer, cueComment varchar, isActiveLoop integer, beatLoopNumerator integer, beatLoopDenominator integer, inUsec integer, outUsec integer, in150FramePerSec integer, out150FramePerSec integer, inMpegFrameNumber integer, outMpegFrameNumber integer, inMpegAbs integer, outMpegAbs integer, inDecodingStartFramePosition integer, outDecodingStartFramePosition integer, inFileOffsetInBlock integer, OutFileOffsetInBlock integer, inNumberOfSampleInBlock integer, outNumberOfSampleInBlock integer);
CREATE TABLE genre(genre_id integer primary key, name varchar);
CREATE TABLE history(history_id integer primary key, sequenceNo integer, name varchar, attribute integer, history_id_parent integer);
CREATE TABLE history_content(history_id integer, content_id integer, sequenceNo integer);
CREATE TABLE hotCueBankList(hotCueBankList_id integer primary key, sequenceNo integer, name varchar, image_id integer, attribute integer, hotCueBankList_id_parent integer);
CREATE TABLE hotCueBankList_cue(hotCueBankList_id integer, cue_id integer, sequenceNo integer);
CREATE TABLE image(image_id integer primary key, path varchar);
CREATE TABLE key(key_id integer primary key, name varchar);
CREATE TABLE label(label_id integer primary key, name varchar);
CREATE TABLE menuItem(menuItem_id integer primary key, kind integer, name varchar);
CREATE TABLE myTag(myTag_id integer primary key, sequenceNo integer, name varchar, attribute integer, myTag_id_parent integer);
CREATE TABLE myTag_content(myTag_id integer, content_id integer);
CREATE TABLE playlist(playlist_id integer primary key, sequenceNo integer, name varchar, image_id integer, attribute integer, playlist_id_parent integer);
CREATE TABLE playlist_content(playlist_id integer, content_id integer, sequenceNo integer);
CREATE TABLE property(deviceName varchar, dbVersion varchar, numberOfContents integer, createdDate varchar, backGroundColorType integer, myTagMasterDBID integer);
CREATE TABLE recommendedLike(content_id_1 integer, content_id_2 integer, rating integer, createdDate integer);
CREATE TABLE sort(sort_id integer primary key, menuItem_id integer, sequenceNo integer, isVisible integer, isSelectedAsSubColumn integer);
CREATE INDEX index_hotCueBankList_cue_hotCueBankList_id on hotCueBankList_cue(hotCueBankList_id);
CREATE INDEX index_myTag_content_content_id on myTag_content(content_id);
CREATE INDEX index_myTag_content_myTag_id on myTag_content(myTag_id);
CREATE INDEX index_playlist_content_playlist_id on playlist_content(playlist_id);
`;

const MENU_ITEMS: ReadonlyArray<readonly [number, number, string]> = [
  [1, 128, "\uFFFAGENRE\uFFFB"],
  [2, 129, "\uFFFAARTIST\uFFFB"],
  [3, 130, "\uFFFAALBUM\uFFFB"],
  [4, 131, "\uFFFATRACK\uFFFB"],
  [5, 133, "\uFFFABPM\uFFFB"],
  [6, 134, "\uFFFARATING\uFFFB"],
  [7, 135, "\uFFFAYEAR\uFFFB"],
  [8, 136, "\uFFFAREMIXER\uFFFB"],
  [9, 137, "\uFFFALABEL\uFFFB"],
  [10, 138, "\uFFFAORIGINAL ARTIST\uFFFB"],
  [11, 139, "\uFFFAKEY\uFFFB"],
  [12, 141, "\uFFFACUE\uFFFB"],
  [13, 142, "\uFFFACOLOR\uFFFB"],
  [14, 146, "\uFFFATIME\uFFFB"],
  [15, 147, "\uFFFABITRATE\uFFFB"],
  [16, 148, "\uFFFAFILE NAME\uFFFB"],
  [17, 132, "\uFFFAPLAYLIST\uFFFB"],
  [18, 152, "\uFFFAHOT CUE BANK\uFFFB"],
  [19, 149, "\uFFFAHISTORY\uFFFB"],
  [20, 145, "\uFFFASEARCH\uFFFB"],
  [21, 150, "\uFFFACOMMENTS\uFFFB"],
  [22, 140, "\uFFFADATE ADDED\uFFFB"],
  [23, 151, "\uFFFADJ PLAY COUNT\uFFFB"],
  [24, 144, "\uFFFAFOLDER\uFFFB"],
  [25, 161, "\uFFFADEFAULT\uFFFB"],
  [26, 162, "\uFFFAALPHABET\uFFFB"],
  [27, 170, "\uFFFAMATCHING\uFFFB"],
];

const CATEGORIES: ReadonlyArray<readonly [number, number, number, number]> = [
  [1, 1, 0, 0],
  [2, 2, 1, 1],
  [3, 3, 2, 1],
  [4, 4, 3, 1],
  [5, 17, 5, 1],
  [6, 5, 0, 0],
  [7, 6, 0, 0],
  [8, 7, 0, 0],
  [9, 8, 0, 0],
  [10, 9, 0, 0],
  [11, 10, 0, 0],
  [12, 11, 4, 1],
  [15, 13, 0, 0],
  [17, 24, 9, 1],
  [18, 20, 7, 1],
  [19, 14, 0, 0],
  [20, 15, 0, 0],
  [21, 16, 0, 0],
  [22, 19, 6, 1],
  [23, 18, 0, 0],
  [26, 27, 8, 1],
  [27, 22, 10, 1],
];

const SORTS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0, 25, 1, 1, 0],
  [1, 26, 2, 1, 0],
  [2, 2, 3, 1, 0],
  [3, 3, 4, 1, 0],
  [4, 5, 5, 1, 0],
  [5, 6, 6, 1, 0],
  [6, 1, 0, 0, 0],
  [7, 21, 0, 0, 0],
  [8, 14, 0, 0, 0],
  [9, 8, 0, 0, 0],
  [10, 9, 0, 0, 0],
  [11, 10, 0, 0, 0],
  [12, 11, 7, 1, 0],
  [13, 15, 0, 0, 0],
  [15, 13, 0, 0, 0],
  [16, 23, 0, 0, 0],
  [17, 22, 0, 0, 0],
];

const COLORS = ["Pink", "Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple"];

/** Track metadata required by a OneLibrary USB export. */
export type OneLibraryExportTrack = {
  masterContentId: string;
  title: string;
  artist?: string | null;
  key?: string | null;
  subtitle?: string | null;
  bpmHundredths?: number | null;
  durationSeconds?: number | null;
  trackNumber?: number | null;
  discNumber?: number | null;
  comment?: string | null;
  rating?: number | null;
  releaseYear?: number | null;
  releaseDate?: string | null;
  dateAdded?: string | null;
  fileName: string;
  fileSize: number;
  fileType: number;
  bitrate?: number | null;
  bitDepth?: number | null;
  samplingRate?: number | null;
  isrc?: string | null;
  playCount?: number | null;
  analysedBits?: number | null;
  usbAudioPath: string;
  usbAnalysisPath: string;
};

/** Options for creating or appending one playlist in an encrypted OneLibrary database. */
export type WriteOneLibraryPlaylistOptions = {
  path: string;
  folderName: string;
  playlistName: string;
  tracks: ReadonlyArray<OneLibraryExportTrack>;
  create?: boolean;
  key?: string;
  unlock?: boolean;
  generatedAt?: Date;
};

/** OneLibrary identifiers and counts after a verified playlist write. */
export type WriteOneLibraryPlaylistResult = {
  folderId: number;
  playlistId: number;
  contentIds: number[];
  contents: number;
  playlists: number;
};

/** Create or append one ordered playlist in a USB OneLibrary database. */
export function writeOneLibraryPlaylist(
  options: WriteOneLibraryPlaylistOptions,
): WriteOneLibraryPlaylistResult {
  const create = options.create ?? !existsSync(options.path);
  if (create && existsSync(options.path))
    throw new Error(`OneLibrary database '${options.path}' already exists`);
  if (!create && !existsSync(options.path))
    throw new Error(`OneLibrary database '${options.path}' does not exist`);
  if (!options.tracks.length) throw new TypeError("OneLibrary playlist must contain tracks");
  const generatedAt = options.generatedAt ?? new Date();
  if (!Number.isFinite(generatedAt.getTime())) throw new TypeError("OneLibrary clock is invalid");

  const database = new Database(options.path, { fileMustExist: !create });
  if (options.unlock ?? true) {
    const key = options.key ?? deobfuscate(DEVICE_LIBRARY_PLUS_KEY_BLOB);
    database.pragma("cipher='sqlcipher'");
    database.pragma("legacy=4");
    database.pragma(`key='${key.replaceAll("'", "''")}'`);
  }
  database.pragma("foreign_keys=ON");
  database.prepare("SELECT name FROM sqlite_master LIMIT 1").get();

  try {
    database.transaction(() => {
      if (create) initialize(database, generatedAt);
    })();
    const output = database.transaction(() => appendPlaylist(database, options))();
    database.pragma("wal_checkpoint(TRUNCATE)");
    database.close();
    verifyOneLibrary(options.path, options, output);
    return output;
  } catch (error) {
    if (database.open) database.close();
    throw error;
  }
}

function initialize(database: Database.Database, generatedAt: Date): void {
  database.exec(SCHEMA);
  const menu = database.prepare("INSERT INTO menuItem VALUES (?, ?, ?)");
  for (const row of MENU_ITEMS) menu.run(...row);
  const category = database.prepare("INSERT INTO category VALUES (?, ?, ?, ?)");
  for (const row of CATEGORIES) category.run(...row);
  const sort = database.prepare("INSERT INTO sort VALUES (?, ?, ?, ?, ?)");
  for (const row of SORTS) sort.run(...row);
  const color = database.prepare("INSERT INTO color VALUES (?, ?)");
  for (const [index, name] of COLORS.entries()) color.run(index + 1, name);
  database.prepare("INSERT INTO myTag VALUES (1, 0, 'Tags', 0, 0)").run();
  database
    .prepare("INSERT INTO property VALUES ('', '10000', 0, ?, 0, 1)")
    .run(dateOnly(generatedAt));
}

function appendPlaylist(
  database: Database.Database,
  options: WriteOneLibraryPlaylistOptions,
): WriteOneLibraryPlaylistResult {
  const existingPlaylist = database
    .prepare(
      `SELECT p.playlist_id
       FROM playlist p
       JOIN playlist f ON f.playlist_id = p.playlist_id_parent
       WHERE f.playlist_id_parent = 0 AND f.attribute = 1 AND f.name = ?
         AND p.attribute = 0 AND p.name = ?`,
    )
    .get(options.folderName, options.playlistName) as { playlist_id: number } | undefined;
  if (existingPlaylist)
    throw new Error(
      `OneLibrary playlist '${options.folderName} / ${options.playlistName}' already exists`,
    );

  let folder = database
    .prepare(
      "SELECT playlist_id FROM playlist WHERE playlist_id_parent = 0 AND attribute = 1 AND name = ?",
    )
    .get(options.folderName) as { playlist_id: number } | undefined;
  if (!folder) {
    const folderId = nextId(database, "playlist", "playlist_id");
    const sequence = countChildren(database, 0);
    database
      .prepare("INSERT INTO playlist VALUES (?, ?, ?, NULL, 1, 0)")
      .run(folderId, sequence, options.folderName);
    folder = { playlist_id: folderId };
  }
  const playlistId = nextId(database, "playlist", "playlist_id");
  database
    .prepare("INSERT INTO playlist VALUES (?, ?, ?, NULL, 0, ?)")
    .run(
      playlistId,
      countChildren(database, folder.playlist_id),
      options.playlistName,
      folder.playlist_id,
    );

  const contentIds: number[] = [];
  for (const [index, track] of options.tracks.entries()) {
    const existing = database
      .prepare("SELECT content_id FROM content WHERE path = ?")
      .get(track.usbAudioPath) as { content_id: number } | undefined;
    const contentId = existing?.content_id ?? insertContent(database, track, options.generatedAt);
    contentIds.push(contentId);
    database
      .prepare("INSERT INTO playlist_content VALUES (?, ?, ?)")
      .run(playlistId, contentId, index + 1);
  }
  database.prepare("UPDATE property SET numberOfContents = (SELECT COUNT(*) FROM content)").run();
  return {
    folderId: folder.playlist_id,
    playlistId,
    contentIds,
    contents: count(database, "content"),
    playlists: count(database, "playlist"),
  };
}

function insertContent(
  database: Database.Database,
  track: OneLibraryExportTrack,
  generatedAt = new Date(),
): number {
  const contentId = nextId(database, "content", "content_id");
  const artistId = namedId(database, "artist", "artist_id", track.artist);
  const keyId = namedId(database, "key", "key_id", track.key);
  const added = track.dateAdded?.slice(0, 10) || dateOnly(generatedAt);
  database
    .prepare(
      `INSERT INTO content (
        content_id, title, titleForSearch, subtitle, bpmx100, length, trackNo, discNo,
        artist_id_artist, artist_id_remixer, artist_id_originalArtist, artist_id_composer,
        artist_id_lyricist, album_id, genre_id, label_id, key_id, color_id, image_id,
        djComment, rating, releaseYear, releaseDate, dateCreated, dateAdded, path, fileName,
        fileSize, fileType, bitrate, bitDepth, samplingRate, isrc, djPlayCount,
        isHotCueAutoLoadOn, isKuvoDeliverStatusOn, kuvoDeliveryComment, masterDbId,
        masterContentId, analysisDataFilePath, analysedBits, contentLink, hasModified,
        cueUpdateCount, analysisDataUpdateCount, informationUpdateCount
      ) VALUES (
        ?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, NULL, NULL, ?, 0, NULL,
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, '', NULL, ?, ?, ?, NULL, 0, '', 1, 1
      )`,
    )
    .run(
      contentId,
      track.title,
      track.subtitle ?? "",
      track.bpmHundredths ?? 0,
      track.durationSeconds ?? 0,
      track.trackNumber ?? 0,
      track.discNumber ?? 0,
      artistId,
      keyId,
      track.comment ?? "",
      track.rating ?? 0,
      track.releaseYear ?? 0,
      track.releaseDate?.slice(0, 10) ?? "",
      added,
      added,
      track.usbAudioPath,
      track.fileName,
      track.fileSize,
      track.fileType,
      track.bitrate ?? 0,
      track.bitDepth ?? 0,
      track.samplingRate ?? 0,
      track.isrc ?? "",
      track.playCount ?? 0,
      safeInteger(track.masterContentId),
      track.usbAnalysisPath,
      track.analysedBits ?? 105,
    );
  return contentId;
}

function verifyOneLibrary(
  path: string,
  options: WriteOneLibraryPlaylistOptions,
  expected: WriteOneLibraryPlaylistResult,
): void {
  const database = new DeviceLibraryPlus({
    path,
    key: options.key,
    readonly: true,
    unlock: options.unlock ?? true,
  });
  try {
    const check = database.executeSql<{ quick_check: string }>("PRAGMA quick_check");
    if (!Array.isArray(check) || check[0]?.quick_check !== "ok")
      throw new Error("Generated OneLibrary database failed quick_check");
    const playlist = database.executeSql<{ count: number }>(
      `SELECT COUNT(*) AS count FROM playlist p
       JOIN playlist f ON f.playlist_id = p.playlist_id_parent
       WHERE f.playlist_id = ? AND p.playlist_id = ? AND f.attribute = 1 AND p.attribute = 0`,
      [expected.folderId, expected.playlistId],
    );
    const membership = database.executeSql<{ content_id: number }>(
      "SELECT content_id FROM playlist_content WHERE playlist_id = ? ORDER BY sequenceNo",
      [expected.playlistId],
    );
    if (!Array.isArray(playlist) || playlist[0]?.count !== 1)
      throw new Error("Generated OneLibrary playlist hierarchy failed verification");
    if (
      !Array.isArray(membership) ||
      JSON.stringify(membership.map(({ content_id }) => content_id)) !==
        JSON.stringify(expected.contentIds)
    )
      throw new Error("Generated OneLibrary playlist order failed verification");
  } finally {
    database.close();
  }
}

function namedId(
  database: Database.Database,
  table: "artist" | "key",
  idColumn: "artist_id" | "key_id",
  value: string | null | undefined,
): number | null {
  if (!value) return null;
  const existing = database
    .prepare(`SELECT ${idColumn} AS id FROM ${table} WHERE name = ?`)
    .get(value) as { id: number } | undefined;
  if (existing) return existing.id;
  const id = nextId(database, table, idColumn);
  if (table === "artist") database.prepare("INSERT INTO artist VALUES (?, ?, NULL)").run(id, value);
  else database.prepare("INSERT INTO key VALUES (?, ?)").run(id, value);
  return id;
}

function nextId(database: Database.Database, table: string, column: string): number {
  const row = database
    .prepare(`SELECT COALESCE(MAX(${column}), 0) + 1 AS id FROM ${table}`)
    .get() as {
    id: number;
  };
  return row.id;
}

function countChildren(database: Database.Database, parentId: number): number {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM playlist WHERE playlist_id_parent = ?")
    .get(parentId) as { count: number };
  return row.count;
}

function count(database: Database.Database, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function safeInteger(value: string): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
