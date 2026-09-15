import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3-multiple-ciphers";

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

/** Isolated synthetic master.db, media, and ANLZ used by USB export integration tests. */
export function createDeviceLibraryFixture(
  root = mkdtempSync(join(tmpdir(), "rekordbox-legacy-export-")),
): {
  audioPaths: [string, string];
  databasePath: string;
  output: string;
  root: string;
} {
  mkdirSync(root, { recursive: true });
  const databasePath = join(root, "master.db");
  const output = join(root, "media");
  const audioPaths: [string, string] = [join(root, "one.mp3"), join(root, "two.flac")];
  writeFileSync(audioPaths[0], Buffer.alloc(128, 1));
  writeFileSync(audioPaths[1], Buffer.alloc(256, 2));
  const analysisDirectories = [
    join(root, "share", "PIONEER", "USBANLZ", "AAA", "one"),
    join(root, "share", "PIONEER", "USBANLZ", "BBB", "two"),
  ];
  for (const [index, directory] of analysisDirectories.entries()) {
    mkdirSync(directory, { recursive: true });
    for (const type of ["DAT", "EXT", "2EX"])
      writeFileSync(join(directory, `ANLZ0000.${type}`), analysisFixture(audioPaths[index]!));
  }

  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE djmdArtist (ID TEXT PRIMARY KEY, Name TEXT);
    CREATE TABLE djmdAlbum (ID TEXT PRIMARY KEY, Name TEXT);
    CREATE TABLE djmdGenre (ID TEXT PRIMARY KEY, Name TEXT);
    CREATE TABLE djmdKey (ID TEXT PRIMARY KEY, ScaleName TEXT);
    CREATE TABLE djmdLabel (ID TEXT PRIMARY KEY, Name TEXT);
    CREATE TABLE djmdContent (
      ID TEXT PRIMARY KEY, FolderPath TEXT, FileNameL TEXT, Title TEXT,
      ArtistID TEXT, AlbumID TEXT, GenreID TEXT, KeyID TEXT, LabelID TEXT,
      Commnt TEXT, Subtitle TEXT, AnalysisDataPath TEXT, Analysed INTEGER, BPM INTEGER, Length INTEGER,
      ReleaseYear INTEGER, BitRate INTEGER, SampleRate INTEGER, BitDepth INTEGER,
      FileSize INTEGER, FileType INTEGER, TrackNo INTEGER, DiscNo INTEGER,
      DJPlayCount TEXT, Rating INTEGER, ColorID TEXT, ReleaseDate TEXT, StockDate TEXT,
      created_at TEXT, rb_local_deleted INTEGER DEFAULT 0
    );
    CREATE TABLE djmdPlaylist (
      ID TEXT PRIMARY KEY, Seq INTEGER, Name TEXT, Attribute INTEGER, ParentID TEXT,
      SmartList TEXT, rb_local_deleted INTEGER DEFAULT 0
    );
    CREATE TABLE djmdSongPlaylist (
      ID TEXT PRIMARY KEY, PlaylistID TEXT, ContentID TEXT, TrackNo INTEGER,
      rb_local_deleted INTEGER DEFAULT 0
    );
    INSERT INTO djmdArtist VALUES ('artist', 'Stavöstranos');
    INSERT INTO djmdAlbum VALUES ('album', 'Album');
    INSERT INTO djmdGenre VALUES ('genre', 'Techno');
    INSERT INTO djmdKey VALUES ('key', 'Am');
    INSERT INTO djmdLabel VALUES ('label', 'Label');
    INSERT INTO djmdContent VALUES (
      '1', '${audioPaths[0].replaceAll("'", "''")}', 'one.mp3', 'First', 'artist', 'album',
      'genre', 'key', 'label', 'comment', '', '/PIONEER/USBANLZ/AAA/one/ANLZ0000.DAT',
      105, 12801, 180, 2026, 320, 44100, 16, 128, 1, 1, 1, '2', 4, '3',
      '2026-07-01', '2026-07-02', '2026-07-02', 0
    );
    INSERT INTO djmdContent VALUES (
      '2', '${audioPaths[1].replaceAll("'", "''")}', 'two.flac', 'Second', 'artist', 'album',
      'genre', 'key', 'label', '', '', '/PIONEER/USBANLZ/BBB/two/ANLZ0000.DAT',
      105, 13000, 200, 2025, 1000, 48000, 24, 256, 5, 2, 1, '0', 0, '0',
      '2025-01-01', '2026-07-03', '2026-07-03', 0
    );
    INSERT INTO djmdPlaylist VALUES ('folder', 1, 'Gigs', 1, 'root', NULL, 0);
    INSERT INTO djmdPlaylist VALUES ('playlist', 1, 'Tonight', 0, 'folder', NULL, 0);
    INSERT INTO djmdSongPlaylist VALUES ('membership-1', 'playlist', '2', 1, 0);
    INSERT INTO djmdSongPlaylist VALUES ('membership-2', 'playlist', '1', 2, 0);
    ALTER TABLE djmdPlaylist ADD COLUMN ImagePath TEXT;
    ALTER TABLE djmdPlaylist ADD COLUMN UUID TEXT;
    ALTER TABLE djmdSongPlaylist ADD COLUMN UUID TEXT;
    CREATE TABLE agentRegistry (registry_id TEXT PRIMARY KEY, int_1 INTEGER);
    INSERT INTO agentRegistry VALUES ('localUpdateCount', 0);
  `);
  database.close();
  return { audioPaths, databasePath, output, root };
}
