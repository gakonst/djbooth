import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DeviceLibraryPlus, writeOneLibraryPlaylist } from "@gakonst/rekordbox/devicelib-plus";
import { DjmdAlbum, DjmdArtist, DjmdContent, MasterDatabase } from "@gakonst/rekordbox/masterdb";
import { expect, test } from "vitest";
import { playlistCli } from "../src/playlist.js";

test("restores USB hierarchy, distinct same-name playlists and repeated ordered tracks; resumes pending copies", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "djbooth-restore-usb-"));
  const root = await realpath(temporary);
  try {
    const mount = join(root, "USB");
    const sourcePath = join(mount, "PIONEER/rekordbox/exportLibrary.db");
    const libraryDirectory = join(root, "audio");
    const masterPath = join(root, "master.db");
    await mkdir(dirname(sourcePath), { recursive: true });
    await mkdir(join(mount, "Contents"));
    await mkdir(libraryDirectory);
    const tracks = await Promise.all(
      ["A", "B", "C"].map(async (name, index) => {
        await writeFile(join(mount, "Contents", `${name}.mp3`), `audio ${name}`);
        return {
          masterContentId: String(index + 1),
          title: name,
          artist: name === "B" ? "Artist Two" : "Artist One",
          releaseYear: 2024,
          fileName: `${name}.mp3`,
          fileSize: 7,
          fileType: 1,
          usbAudioPath: `/Contents/${name}.mp3`,
          usbAnalysisPath: "",
        };
      }),
    );
    const exported = writeOneLibraryPlaylist({
      path: sourcePath,
      folderName: "Sets",
      playlistName: "Same name",
      tracks,
    });
    const source = new DeviceLibraryPlus(sourcePath, { readonly: false });
    source.open();
    try {
      source.executeSql("UPDATE content SET dateAdded = ''");
      source.executeSql("INSERT INTO genre VALUES (1, 'House')");
      source.executeSql("INSERT INTO label VALUES (1, 'Test Records')");
      source.executeSql(
        "INSERT INTO album(album_id, name, artist_id) SELECT artist_id, 'Shared album name', artist_id FROM artist",
      );
      source.executeSql(
        "UPDATE content SET album_id = artist_id_artist, genre_id = 1, label_id = 1, trackNo = 7",
      );
      source.executeSql("DELETE FROM playlist_content");
      source.executeSql("UPDATE playlist SET sequenceNo = 3 WHERE playlist_id = ?", [
        exported.folderId,
      ]);
      source.executeSql("INSERT INTO playlist VALUES (102, 2, 'Root first', NULL, 0, 0)");
      source.executeSql("UPDATE playlist SET sequenceNo = 2 WHERE playlist_id = ?", [
        exported.playlistId,
      ]);
      source.executeSql("INSERT INTO playlist VALUES (99, 1, 'Same name', NULL, 0, ?)", [
        exported.folderId,
      ]);
      source.executeSql("INSERT INTO playlist VALUES (100, 3, 'Nested', NULL, 1, ?)", [
        exported.folderId,
      ]);
      source.executeSql("INSERT INTO playlist VALUES (101, 1, 'Deep', NULL, 0, 100)");
      for (const [index, content] of [
        exported.contentIds[1],
        exported.contentIds[2],
        exported.contentIds[0],
        exported.contentIds[1],
      ].entries()) {
        source.executeSql("INSERT INTO playlist_content VALUES (?, ?, ?)", [
          exported.playlistId,
          content,
          index + 1,
        ]);
      }
      source.executeSql("INSERT INTO playlist_content VALUES (99, ?, 1)", [exported.contentIds[0]]);
      source.executeSql("INSERT INTO playlist_content VALUES (101, ?, 1)", [
        exported.contentIds[1],
      ]);
      source.commit();
    } finally {
      source.close();
    }
    const sourceBefore = await readFile(sourcePath);
    const master = MasterDatabase.createManaged(masterPath);
    const unrelated = master.createPlaylist("Keep me");
    master.commit();
    const unrelatedId = unrelated.ID;
    master.close();
    const copiedIds = new Map<string, string>();
    const copy = async (name: string) => {
      const original = join(mount, "Contents", `${name}.mp3`);
      const hash = createHash("sha256")
        .update(await readFile(original))
        .digest("hex");
      const destination = join(libraryDirectory, hash, `${name}.mp3`);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(original, destination);
      const db = new MasterDatabase({ path: masterPath, readonly: false });
      try {
        copiedIds.set(name, db.addContent(destination, { Title: name }).ID);
        db.commit();
      } finally {
        db.close();
      }
    };
    await copy("A");
    await copy("B");
    const run = async (structureOnly = false) => {
      let output = "";
      let exitCode: number | undefined;
      await playlistCli.serve(
        [
          "restore-usb",
          mount,
          "--path",
          masterPath,
          "--library-directory",
          libraryDirectory,
          "--progress",
          "never",
          "--format",
          "json",
          ...(structureOnly ? ["--structure-only"] : []),
        ],
        {
          stdout: (text) => {
            output += text;
          },
          exit: (code) => {
            exitCode = code;
          },
        },
      );
      expect(exitCode, output).not.toBe(1);
      return JSON.parse(output) as {
        folderId: string;
        pendingMemberships: number;
        playlists: Array<{ sourceId: number; playlistId: string }>;
      };
    };
    const structure = await run(true);
    expect(structure.playlists).toHaveLength(6);
    expect(structure.pendingMemberships).toBe(6);
    const initial = new MasterDatabase(masterPath);
    try {
      expect(
        initial
          .listPlaylists()
          .filter((row) => row.parentId === structure.folderId)
          .sort((a, b) => a.sequence - b.sequence)
          .map((row) => row.sequence),
      ).toEqual([1, 2]);
      expect(
        initial
          .listPlaylists()
          .filter((row) => row.parentId === structure.folderId)
          .sort((a, b) => a.sequence - b.sequence)
          .map((row) => row.name),
      ).toEqual(["Root first", "Sets"]);
    } finally {
      initial.close();
    }
    const first = await run();
    expect(first.folderId).toBe(structure.folderId);
    expect(first.pendingMemberships).toBe(1);
    await copy("C");
    const second = await run();
    expect(second.pendingMemberships).toBe(0);
    expect(second.folderId).toBe(first.folderId);
    expect(second.playlists.map((row) => row.playlistId)).toEqual(
      first.playlists.map((row) => row.playlistId),
    );
    expect(await run()).toEqual(second);
    expect(await run(true)).toEqual(second);
    const db = new MasterDatabase(masterPath);
    try {
      const a = db
        .query(DjmdContent)
        .where({ ID: copiedIds.get("A")! })
        .one();
      const b = db
        .query(DjmdContent)
        .where({ ID: copiedIds.get("B")! })
        .one();
      expect(a.Title).toBe("A");
      expect(a.ArtistName).toBe("Artist One");
      expect(b.ArtistName).toBe("Artist Two");
      expect(a.AlbumName).toBe("Shared album name");
      expect(b.AlbumName).toBe("Shared album name");
      expect(a.AlbumID).not.toBe(b.AlbumID);
      expect(a.GenreName).toBe("House");
      expect(a.LabelName).toBe("Test Records");
      expect(a.ReleaseYear).toBe(2024);
      expect(a.TrackNo).toBe(7);
      expect(db.query(DjmdArtist).count()).toBe(2);
      expect(db.query(DjmdAlbum).count()).toBe(2);
      const id = (sourceId: number) =>
        second.playlists.find((row) => row.sourceId === sourceId)!.playlistId;
      expect(db.getPlaylistTracks(id(exported.playlistId)).map((track) => track.contentId)).toEqual(
        [copiedIds.get("B"), copiedIds.get("C"), copiedIds.get("A"), copiedIds.get("B")],
      );
      expect(db.getPlaylistTracks(id(99)).map((track) => track.contentId)).toEqual([
        copiedIds.get("A"),
      ]);
      const tree = db.listPlaylists();
      expect(tree).toHaveLength(8);
      expect(tree.find((row) => row.id === id(101))?.parentId).toBe(id(100));
      expect(tree.find((row) => row.id === id(100))?.parentId).toBe(id(exported.folderId));
      expect(
        tree
          .filter((row) => row.parentId === id(exported.folderId))
          .sort((a, b) => a.sequence - b.sequence)
          .map((row) => row.id),
      ).toEqual([id(99), id(exported.playlistId), id(100)]);
      expect(tree.find((row) => row.id === unrelatedId)?.name).toBe("Keep me");
    } finally {
      db.close();
    }
    expect(await readFile(sourcePath)).toEqual(sourceBefore);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
