import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it } from "vitest";

import {
  Album,
  Artist,
  Content,
  DEVICE_LIBRARY_PLUS_KEY_BLOB,
  DeviceLibraryPlus,
  FileType,
  Playlist,
  PlaylistContent,
  Property,
  TABLES,
} from "../src/devicelib-plus/index.js";
import { deobfuscate } from "../src/utils.js";

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture(): { audioPath: string; dbPath: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "rekordbox-ts-device-"));
  roots.push(root);
  const dbPath = join(root, "exportLibrary.db");
  const audioPath = join(root, "new.mp3");
  writeFileSync(audioPath, Buffer.from([0x49, 0x44, 0x33]));
  const database = new Database(dbPath);
  database.exec(`
    CREATE TABLE album (
      album_id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255) UNIQUE, artist_id INTEGER,
      image_id INTEGER, isComplation INTEGER, nameForSearch VARCHAR(255)
    );
    CREATE TABLE artist (
      artist_id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255) UNIQUE, nameForSearch VARCHAR(255)
    );
    CREATE TABLE category (
      category_id INTEGER PRIMARY KEY AUTOINCREMENT, menuItem_id INTEGER, sequenceNo INTEGER, isVisible INTEGER
    );
    CREATE TABLE color (color_id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255) UNIQUE);
    CREATE TABLE content (
      content_id INTEGER PRIMARY KEY AUTOINCREMENT, title VARCHAR(255), titleForSearch VARCHAR(255),
      subtitle VARCHAR(255), bpmx100 INTEGER, length INTEGER, trackNo INTEGER, discNo INTEGER,
      artist_id_artist INTEGER, artist_id_remixer INTEGER, artist_id_originalArtist INTEGER,
      artist_id_composer INTEGER, artist_id_lyricist INTEGER, album_id INTEGER, genre_id INTEGER,
      label_id INTEGER, key_id INTEGER, color_id INTEGER, image_id INTEGER, djComment VARCHAR(255),
      rating INTEGER, releaseYear INTEGER, releaseDate TEXT, dateCreated TEXT, dateAdded TEXT,
      path VARCHAR(255) UNIQUE NOT NULL, fileName VARCHAR(255) NOT NULL, fileSize BIGINT NOT NULL,
      fileType INTEGER NOT NULL, bitrate INTEGER NOT NULL, bitDepth INTEGER NOT NULL,
      samplingRate INTEGER NOT NULL, isrc VARCHAR(12), isHotCueAutoLoadOn INTEGER,
      isKuvoDeliverStatusOn INTEGER, kuvoDeliveryComment VARCHAR(255), masterDbId INTEGER,
      masterContentId INTEGER, analysisDataFilePath VARCHAR(255), analysedBits INTEGER,
      contentLink INTEGER, hasModified INTEGER, cueUpdateCount INTEGER,
      analysisDataUpdateCount INTEGER, informationUpdateCount INTEGER
    );
    CREATE TABLE cue (
      cue_id INTEGER PRIMARY KEY AUTOINCREMENT, content_id INTEGER, kind INTEGER,
      colorTableIndex INTEGER, cueComment VARCHAR(255), isActiveLoop INTEGER,
      beatLoopNumerator INTEGER, beatLoopDenominator INTEGER, inUsec INTEGER, outUsec INTEGER,
      in150FramePerSec INTEGER, out150FramePerSec INTEGER, inMpegFrameNumber INTEGER,
      outMpegFrameNumber INTEGER, inMpegAbs INTEGER, outMpegAbs INTEGER,
      inDecodingStartFramePosition INTEGER, outDecodingStartFramePosition INTEGER,
      inFileOffsetInBlock INTEGER, outFileOffsetInBlock INTEGER,
      inNumberOfSampleInBlock INTEGER, outNumberOfSampleInBlock INTEGER
    );
    CREATE TABLE genre (genre_id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255) UNIQUE);
    CREATE TABLE history (
      history_id INTEGER PRIMARY KEY AUTOINCREMENT, sequenceNo INTEGER, name VARCHAR(255),
      attribute TEXT, history_id_parent INTEGER
    );
    CREATE TABLE history_content (
      history_id INTEGER, content_id INTEGER, sequenceNo INTEGER, PRIMARY KEY (history_id, content_id)
    );
    CREATE TABLE hotCueBankList (
      hotCueBankList_id INTEGER PRIMARY KEY AUTOINCREMENT, sequenceNo INTEGER, name VARCHAR(255),
      image_id INTEGER, attribute INTEGER, hotCueBankList_id_parent INTEGER
    );
    CREATE TABLE hotCueBankList_cue (
      hotCueBankList_id INTEGER, cue_id INTEGER, sequenceNo INTEGER,
      PRIMARY KEY (hotCueBankList_id, cue_id)
    );
    CREATE TABLE image (image_id INTEGER PRIMARY KEY AUTOINCREMENT, path VARCHAR(255) UNIQUE);
    CREATE TABLE key (key_id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255) UNIQUE);
    CREATE TABLE label (label_id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(255) UNIQUE);
    CREATE TABLE menuItem (
      menuItem_id INTEGER PRIMARY KEY AUTOINCREMENT, kind INTEGER, name VARCHAR(255)
    );
    CREATE TABLE myTag (
      myTag_id INTEGER PRIMARY KEY AUTOINCREMENT, sequenceNo INTEGER NOT NULL,
      name VARCHAR(255) UNIQUE, attribute INTEGER, myTag_id_parent INTEGER
    );
    CREATE TABLE myTag_content (
      myTag_id INTEGER, content_id INTEGER, PRIMARY KEY (myTag_id, content_id)
    );
    CREATE TABLE playlist (
      playlist_id INTEGER PRIMARY KEY AUTOINCREMENT, sequenceNo INTEGER NOT NULL,
      name VARCHAR(255) NOT NULL, image_id INTEGER, attribute INTEGER, playlist_id_parent INTEGER
    );
    CREATE TABLE playlist_content (
      playlist_id INTEGER, content_id INTEGER, sequenceNo INTEGER NOT NULL,
      PRIMARY KEY (playlist_id, content_id)
    );
    CREATE TABLE property (
      deviceName VARCHAR(255) PRIMARY KEY, dbVersion INTEGER, numberOfContents INTEGER,
      createdDate TEXT, backGroundColorType INTEGER, myTagMasterDBID INTEGER
    );
    CREATE TABLE recommendedLike (
      content_id_1 INTEGER, content_id_2 INTEGER, rating INTEGER, createdDate TEXT,
      PRIMARY KEY (content_id_1, content_id_2)
    );
    CREATE TABLE sort (
      sort_id INTEGER PRIMARY KEY AUTOINCREMENT, menuItem_id INTEGER NOT NULL,
      sequenceNo INTEGER, isVisible INTEGER, isSelectedAsSubColumn INTEGER
    );
  `);
  const insert = database.transaction(() => {
    database.prepare("INSERT INTO artist VALUES (?, ?, ?)").run(1, "Orbital", "orbital");
    database
      .prepare("INSERT INTO album VALUES (?, ?, ?, ?, ?, ?)")
      .run(1, "In Sides", 1, null, 0, "in sides");
    database.prepare("INSERT INTO genre VALUES (?, ?)").run(1, "Electronic");
    database.prepare("INSERT INTO key VALUES (?, ?)").run(1, "Fm");
    database
      .prepare(
        `INSERT INTO content (
          content_id, title, titleForSearch, artist_id_artist, album_id, genre_id, key_id,
          dateCreated, dateAdded, path, fileName, fileSize, fileType, bitrate, bitDepth,
          samplingRate, hasModified, cueUpdateCount, analysisDataUpdateCount, informationUpdateCount
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        1,
        "The Box",
        "the box",
        1,
        1,
        1,
        1,
        "2026-07-10 12:00:00.000 +00:00",
        "2026-07-10 12:00:00.000 +00:00",
        "/Contents/The Box.mp3",
        "The Box.mp3",
        100,
        1,
        320,
        16,
        44100,
        0,
        0,
        0,
        0,
      );
    database.prepare("INSERT INTO cue (cue_id, content_id, kind) VALUES (?, ?, ?)").run(1, 1, 0);
    database.prepare("INSERT INTO playlist VALUES (?, ?, ?, ?, ?, ?)").run(1, 1, "Set", null, 0, 0);
    database.prepare("INSERT INTO playlist_content VALUES (?, ?, ?)").run(1, 1, 1);
  });
  insert();
  database.close();
  return { audioPath, dbPath, root };
}

describe("DeviceLibraryPlus queries", () => {
  it("maps all tables, typed dates, relationships, proxies, and search", () => {
    const { dbPath } = fixture();
    const db = new DeviceLibraryPlus({ path: dbPath, readonly: true, unlock: false });
    expect(TABLES).toHaveLength(22);
    expect(db.tableNames).toHaveLength(22);
    const content = db.query(Content).one();
    expect(content.dateCreated).toBeInstanceOf(Date);
    expect(content.artist).toBeInstanceOf(Artist);
    expect(content.artist_name).toBe("Orbital");
    expect(content.album).toBeInstanceOf(Album);
    expect(content.cues).toHaveLength(1);
    const playlist = db.query(Playlist).one();
    expect(playlist.songs[0]).toBeInstanceOf(PlaylistContent);
    expect(playlist.contents[0]).toBe(content);
    expect(db.searchContent("orbital")).toEqual([content]);
    expect(db.toObject().Content).toHaveLength(1);
    db.close();
  });

  it("opens a SQLCipher database with the upstream default key", () => {
    const root = mkdtempSync(join(tmpdir(), "rekordbox-ts-device-cipher-"));
    roots.push(root);
    const dbPath = join(root, "exportLibrary.db");
    const connection = new Database(dbPath);
    connection.pragma("cipher='sqlcipher'");
    connection.pragma("legacy=4");
    connection.pragma(`key='${deobfuscate(DEVICE_LIBRARY_PLUS_KEY_BLOB)}'`);
    connection.exec("CREATE TABLE property (deviceName TEXT PRIMARY KEY)");
    connection.close();

    const db = new DeviceLibraryPlus(dbPath);
    expect(db.tableNames).toEqual(["property"]);
    db.close();
  });
});

describe("DeviceLibraryPlus mutations", () => {
  it("creates autoincrement rows, content, playlists, tags, and properties", () => {
    const { audioPath, dbPath } = fixture();
    const db = new DeviceLibraryPlus({
      allowWhileRunning: true,
      path: dbPath,
      readonly: false,
      unlock: false,
    });
    const artist = db.addArtist("Autechre");
    expect(Number(artist.artist_id)).toBe(2);
    const content = db.addContent(audioPath, FileType.MP3, {
      bitrate: 320,
      values: { artist_id_artist: artist.artist_id, title: "Bike" },
    });
    expect(Number(content.content_id)).toBe(2);
    const playlist = db.addPlaylist("Second Set");
    db.addPlaylistContent(playlist.playlist_id, content.content_id);
    const tag = db.addMyTag("Driving");
    db.addMyTagContent(tag.myTag_id, content.content_id);
    db.addProperty(123, { deviceName: "USB" });
    db.updateContentCount();
    db.commit();
    db.close();

    const reopened = new DeviceLibraryPlus({ path: dbPath, readonly: true, unlock: false });
    expect(reopened.query(Artist).where({ name: "Autechre" }).count()).toBe(1);
    expect(
      reopened.query(PlaylistContent).where({ playlist_id: playlist.playlist_id }).count(),
    ).toBe(1);
    expect(reopened.query(Property).one().numberOfContents).toBe(2);
    reopened.close();
  });

  it("rolls back staged changes", () => {
    const { dbPath } = fixture();
    const db = new DeviceLibraryPlus({ path: dbPath, readonly: false, unlock: false });
    db.addColor("Pink");
    db.rollback();
    expect(db.query("color").where({ name: "Pink" }).count()).toBe(0);
    db.close();
  });

  it("persists relationship, association-proxy, and collection mutations", () => {
    const { dbPath } = fixture();
    const db = new DeviceLibraryPlus({ path: dbPath, readonly: false, unlock: false });
    const constructed = Artist.create(db, { name: "Constructed" });
    db.add(constructed);
    expect(db.query(Artist).where({ name: "Constructed" }).one()).toBe(constructed);
    const content = db.query(Content).one();
    content.artist_name = "Renamed";
    expect(content.artist?.name).toBe("Renamed");

    const destination = db.addPlaylist("Destination");
    const membership = db.query(PlaylistContent).one();
    destination.songs.push(membership);
    expect(membership.playlist_id).toBe(destination.playlist_id);
    db.rollback();
    expect(content.artist?.name).toBe("Orbital");
    expect(membership.playlist_id).toBe(1);
    db.close();
  });
});
