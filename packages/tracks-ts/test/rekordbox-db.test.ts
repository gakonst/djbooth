import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vitest";

import type { SetManifest } from "../src/manifest.js";
import {
  applyRekordboxImportResults,
  assertRekordboxImportApproved,
  assertRekordboxStopped,
  backupRekordboxDatabase,
  defaultRekordboxPlaylistName,
  planRekordboxImport,
  readRekordboxBackup,
  rekordboxBackupSources,
  validateMasterPlaylistSidecar,
  writeRekordboxPlan,
  type RekordboxImportPlan,
  type RekordboxLibrary,
  type RekordboxMasterDatabase,
} from "../src/rekordbox-db.js";

function completedManifest(): SetManifest {
  return {
    schemaVersion: 1,
    kind: "dj-set-pipeline",
    source: {
      input: "https://youtu.be/set",
      url: "https://soundcloud.com/dj/set",
      id: "set",
      title: "Festival Set",
      uploader: "DJ Example",
      durationSeconds: 600,
    },
    tracklist: { provider: "1001tracklists", complete: true },
    entries: [
      {
        id: "track-001",
        order: 1,
        cue: { timestamp: "00:00:00", startSeconds: 0, endSeconds: 300 },
        identity: {
          status: "identified",
          artist: "Bill Loko",
          title: "Nen Lambo",
          searchQuery: "Bill Loko - Nen Lambo",
        },
        spotify: {
          status: "ambiguous",
          query: "Bill Loko - Nen Lambo",
          candidates: [
            {
              score: 0.99,
              id: "spotify-full",
              uri: "spotify:track:spotify-full",
              name: "Nen Lambo (Rampa Edit)",
              artists: ["Bill Loko", "Rampa"],
              album: "Nen Lambo",
              durationMs: 375_609,
              isrc: "DEEC32000011",
            },
            {
              score: 0.98,
              id: "spotify-mixed",
              uri: "spotify:track:spotify-mixed",
              name: "Nen Lambo (&ME Edit) [Mixed]",
              artists: ["Bill Loko", "&ME"],
              album: "DJ Mix",
              durationMs: 346_235,
              isrc: "QM24S2300834",
            },
          ],
        },
        acquisition: {
          status: "downloaded",
          download: {
            backend: "ytdlp",
            kind: "individual",
            mediaPath: "/music/festival-set/tracks/01-full.m4a",
            files: ["/music/festival-set/tracks/01-full.m4a"],
            source: "https://youtu.be/full",
            spotifyId: "spotify-full",
            isrc: "DEEC32000011",
          },
          alternatives: [
            {
              backend: "ytdlp",
              kind: "individual",
              mediaPath: "/music/festival-set/tracks/01-mixed.m4a",
              files: ["/music/festival-set/tracks/01-mixed.m4a"],
              source: "https://youtu.be/mixed",
              spotifyId: "spotify-mixed",
              isrc: "QM24S2300834",
            },
          ],
        },
        rekordbox: { status: "pending" },
        warnings: [],
        errors: [],
      },
      {
        id: "track-002",
        order: 2,
        cue: { timestamp: "00:05:00", startSeconds: 300, endSeconds: 600 },
        identity: {
          status: "unidentified",
          isId: true,
          title: "ID [Set Extract @ 00:05:00]",
        },
        spotify: { status: "skipped", reason: "Unreleased ID" },
        acquisition: {
          status: "downloaded",
          download: {
            backend: "ytdlp",
            kind: "source-set-clip",
            mediaPath: "/music/festival-set/tracks/02-id.mp3",
            files: ["/music/festival-set/tracks/02-id.mp3"],
            source: "https://soundcloud.com/dj/set",
            clip: {
              sourceSetUrl: "https://soundcloud.com/dj/set",
              sourceSetTitle: "Festival Set",
              startSeconds: 300,
              endSeconds: 600,
              containsTransitions: true,
              qualityNote: "lossy set recording; transitions may be present",
            },
          },
        },
        rekordbox: { status: "pending" },
        warnings: ["Unreleased"],
        errors: [],
      },
    ],
    warnings: [],
    errors: [],
    artifacts: {},
  };
}

describe("Rekordbox direct database planning", () => {
  test("deduplicates albums by name and artist instead of name alone", () => {
    const albumFilters: Array<Record<string, unknown>> = [];
    let id = 0;
    const row = (tableName: string, values: Record<string, unknown>) => {
      const value = {
        ID: `${tableName}-${++id}`,
        tableName,
        ...values,
        get(key: string) {
          return (this as Record<string, unknown>)[key];
        },
        set(key: string, next: unknown) {
          (this as Record<string, unknown>)[key] = next;
          return this;
        },
      };
      return value;
    };
    const models = {
      DjmdArtist: { tableName: "artist" },
      DjmdAlbum: { tableName: "album" },
      DjmdLabel: { tableName: "label" },
      DjmdContent: { tableName: "content" },
      DjmdPlaylist: { tableName: "playlist" },
      DjmdSongPlaylist: { tableName: "membership" },
    };
    const folder = row("playlist", { Name: "DJ Sets I Like", Attribute: 0, ParentID: "root" });
    const playlist = row("playlist", {
      Name: "Set [tracks-ts]",
      Attribute: 1,
      ParentID: folder.ID,
    });
    const db = {
      query(model: { tableName: string }) {
        let filters: Record<string, unknown> = {};
        const query = {
          where(next: Record<string, unknown>) {
            filters = next;
            if (model.tableName === "album") albumFilters.push(next);
            return query;
          },
          orderBy() {
            return query;
          },
          all() {
            if (model.tableName === "playlist" && filters.Attribute === 0) return [folder];
            return [];
          },
          one() {
            throw new Error("unexpected one()");
          },
          first() {
            return undefined;
          },
        };
        return query;
      },
      addArtist(name: string) {
        return row("artist", { Name: name });
      },
      addAlbum(name: string, options: { artist: { ID: string } }) {
        return row("album", { Name: name, AlbumArtistID: options.artist.ID });
      },
      addLabel(name: string) {
        return row("label", { Name: name });
      },
      addContent(path: string, values: Record<string, unknown>) {
        return row("content", { FolderPath: path, ...values });
      },
      createPlaylist() {
        return playlist;
      },
      addToPlaylist(target: { ID: string }, content: { ID: string }, trackNumber: number) {
        return row("membership", {
          PlaylistID: target.ID,
          ContentID: content.ID,
          TrackNo: trackNumber,
        });
      },
      moveSongInPlaylist() {},
      hasColumn() {
        return true;
      },
      selectRawRows() {
        return [];
      },
      commit() {},
      close() {},
    } as unknown as RekordboxMasterDatabase;
    const rekordbox = {
      ...models,
      PlaylistType: { FOLDER: 0, PLAYLIST: 1 },
    } as unknown as RekordboxLibrary;
    const plan: RekordboxImportPlan = {
      folderName: "DJ Sets I Like",
      playlistName: "Set [tracks-ts]",
      items: ["First Artist", "Second Artist"].map((artist, index) => ({
        key: `track-${index}`,
        entryId: `track-${index}`,
        entryOrder: index + 1,
        variantIndex: 0,
        mediaPath: `/music/${index}.m4a`,
        download: {
          backend: "ytdlp" as const,
          mediaPath: `/music/${index}.m4a`,
          files: [`/music/${index}.m4a`],
        },
        metadata: {
          title: `Track ${index}`,
          artist,
          album: "Shared Album Name",
          comment: "test",
        },
      })),
    };

    const result = writeRekordboxPlan(db, rekordbox, plan);

    expect(result.imported).toHaveLength(2);
    expect(albumFilters).toEqual([
      { Name: "Shared Album Name", AlbumArtistID: "artist-3" },
      { Name: "Shared Album Name", AlbumArtistID: "artist-6" },
    ]);
  });

  test("expands primary and alternative downloads adjacently in cue order", () => {
    const plan = planRekordboxImport(completedManifest(), {
      mediaBaseDirectory: "/music/festival-set",
    });

    expect(plan).toMatchObject({
      folderName: "DJ Sets I Like",
      playlistName: "Festival Set [tracks-ts]",
    });
    expect(plan.items.map((item) => [item.key, item.mediaPath])).toEqual([
      ["track-001:0", resolve("/music/festival-set/tracks/01-full.m4a")],
      ["track-001:1", resolve("/music/festival-set/tracks/01-mixed.m4a")],
      ["track-002:0", resolve("/music/festival-set/tracks/02-id.mp3")],
    ]);
    expect(plan.items[0]!.metadata).toMatchObject({
      title: "Nen Lambo (Rampa Edit)",
      artist: "Bill Loko, Rampa",
      album: "Nen Lambo",
      durationSeconds: 376,
      isrc: "DEEC32000011",
    });
    expect(plan.items[1]!.metadata).toMatchObject({
      title: "Nen Lambo (&ME Edit) [Mixed]",
      artist: "Bill Loko, &ME",
      durationSeconds: 346,
      isrc: "QM24S2300834",
    });
    expect(plan.items[2]!.metadata).toMatchObject({
      title: "ID [Set Extract @ 00:05:00]",
      artist: "Unknown Artist",
      durationSeconds: 300,
    });
    expect(plan.items[2]!.metadata.comment).toBe(
      [
        "[Set Extract]",
        "Source: Festival Set",
        "Source URL: https://soundcloud.com/dj/set",
        "Set range: 00:05:00–00:10:00",
        "Quality: lossy set recording; transitions may be present",
        "Transitions: may be present",
      ].join("\n"),
    );
  });

  test("requires every manifest entry to have a completed download", () => {
    const manifest = completedManifest();
    manifest.entries[1]!.acquisition = { status: "pending" };
    expect(() => planRekordboxImport(manifest)).toThrow(
      "Manifest entry track-002 is not downloaded (status: pending)",
    );
  });

  test("rejects a partial multi-variant acquisition with an unresolved error", () => {
    const manifest = completedManifest();
    manifest.entries[0]!.errors.push({
      stage: "acquisition",
      message: "mixed variant unavailable",
      retryable: true,
    });

    expect(() => planRekordboxImport(manifest)).toThrow(
      "Manifest entry track-001 has unresolved acquisition errors",
    );
  });

  test("does not assign release-master metadata to a set-extract alternative", () => {
    const manifest = completedManifest();
    const acquisition = manifest.entries[0]!.acquisition;
    if (acquisition.status !== "downloaded" || !acquisition.alternatives) throw new Error();
    acquisition.alternatives[0] = {
      backend: "ytdlp",
      kind: "source-set-clip",
      mediaPath: "/music/festival-set/tracks/01-mixed.mp3",
      files: ["/music/festival-set/tracks/01-mixed.mp3"],
      source: "https://soundcloud.com/dj/set",
      spotifyId: "spotify-mixed",
      clip: {
        sourceSetUrl: "https://soundcloud.com/dj/set",
        sourceSetTitle: "Festival Set",
        startSeconds: 300,
        endSeconds: 340,
        containsTransitions: true,
        qualityNote: "lossy set recording; transitions may be present",
      },
    };

    const alternative = planRekordboxImport(manifest).items[1]!.metadata;
    expect(alternative).toMatchObject({
      title: "Nen Lambo (&ME Edit) [Mixed] [Set Extract]",
      artist: "Bill Loko, &ME",
      durationSeconds: 40,
    });
    expect(alternative).not.toHaveProperty("album");
    expect(alternative).not.toHaveProperty("releaseDate");
    expect(alternative).not.toHaveProperty("isrc");
  });

  test("rejects a media path reused across entries", () => {
    const manifest = completedManifest();
    const first = manifest.entries[0]!.acquisition;
    const second = manifest.entries[1]!.acquisition;
    if (first.status !== "downloaded" || second.status !== "downloaded") throw new Error();
    second.download.mediaPath = first.download.mediaPath;
    second.download.files = [first.download.mediaPath];
    expect(() => planRekordboxImport(manifest)).toThrow("globally distinct media paths");
  });

  test("writes scalar compatibility IDs and all variant IDs into a cloned manifest", () => {
    const input = completedManifest();
    const updated = applyRekordboxImportResults(
      input,
      [
        {
          key: "track-001:0",
          entryId: "track-001",
          variantIndex: 0,
          mediaPath: "/music/01-full.m4a",
          contentId: "content-1",
          membershipId: "membership-1",
          trackNumber: 1,
        },
        {
          key: "track-001:1",
          entryId: "track-001",
          variantIndex: 1,
          mediaPath: "/music/01-mixed.m4a",
          contentId: "content-2",
          membershipId: "membership-2",
          trackNumber: 2,
        },
        {
          key: "track-002:0",
          entryId: "track-002",
          variantIndex: 0,
          mediaPath: "/music/02-id.mp3",
          contentId: "content-3",
          membershipId: "membership-3",
          trackNumber: 3,
        },
      ],
      {
        target: "rekordbox-db",
        dbPath: "/rekordbox/master.db",
        folderName: "DJ Sets I Like",
        folderId: "folder-1",
        playlistName: "Festival Set [tracks-ts]",
        playlistId: "playlist-1",
        backupDirectory: "/backups/import-1",
      },
    );

    expect(updated).not.toBe(input);
    expect(input.entries[0]!.rekordbox).toEqual({ status: "pending" });
    expect(updated.entries[0]!.rekordbox).toEqual({
      status: "imported",
      target: "rekordbox-db",
      artifact: "/rekordbox/master.db",
      dbContentId: "content-1",
      playlistMembershipId: "membership-1",
      dbContentIds: ["content-1", "content-2"],
      playlistMembershipIds: ["membership-1", "membership-2"],
    });
    expect(updated.entries[1]!.rekordbox).toMatchObject({
      dbContentIds: ["content-3"],
      playlistMembershipIds: ["membership-3"],
    });
    expect(updated.artifacts.rekordbox).toEqual({
      target: "rekordbox-db",
      dbPath: "/rekordbox/master.db",
      folderName: "DJ Sets I Like",
      folderId: "folder-1",
      playlistName: "Festival Set [tracks-ts]",
      playlistId: "playlist-1",
      backupDirectory: "/backups/import-1",
    });
  });

  test("enforces explicit approval and stopped application plus agent", () => {
    expect(() => assertRekordboxImportApproved(false)).toThrow("requires approved: true");
    expect(() => assertRekordboxStopped({ rekordboxPid: 10, rekordboxAgentPid: 20 })).toThrow(
      "rekordbox (PID 10), rekordboxAgent (PID 20)",
    );
    expect(() => assertRekordboxStopped({ rekordboxPid: 0, rekordboxAgentPid: 0 })).not.toThrow();
  });

  test("derives deterministic naming and backup companion paths", () => {
    expect(defaultRekordboxPlaylistName(completedManifest())).toBe("Festival Set [tracks-ts]");
    const directory = resolve("/rekordbox");
    expect(rekordboxBackupSources(directory)).toEqual([
      { name: "master.db", sourcePath: join(directory, "master.db"), required: true },
      { name: "master.db-wal", sourcePath: join(directory, "master.db-wal"), required: false },
      { name: "master.db-shm", sourcePath: join(directory, "master.db-shm"), required: false },
      {
        name: "master.db-journal",
        sourcePath: join(directory, "master.db-journal"),
        required: false,
      },
      {
        name: "masterPlaylists6.xml",
        sourcePath: join(directory, "masterPlaylists6.xml"),
        required: true,
      },
    ]);
  });

  test("backs up the selected custom database and its companions", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-ts-rekordbox-backup-"));
    const dbDirectory = join(root, "rekordbox");
    const backupRoot = join(root, "backups");
    const dbPath = join(dbDirectory, "selected-library.db");
    try {
      await mkdir(dbDirectory);
      await Promise.all([
        writeFile(join(dbDirectory, "master.db"), "wrong database"),
        writeFile(dbPath, "selected database"),
        writeFile(`${dbPath}-wal`, "selected wal"),
        writeFile(join(dbDirectory, "masterPlaylists6.xml"), "<MASTER_PLAYLIST/>"),
      ]);

      const backup = await backupRekordboxDatabase(dbDirectory, {
        backupRoot,
        dbPath,
        now: new Date("2026-07-12T12:34:56.789Z"),
      });

      expect(backup.files.map((file) => file.name)).toEqual([
        "selected-library.db",
        "selected-library.db-wal",
        "masterPlaylists6.xml",
      ]);
      expect(await readFile(join(backup.directory, "selected-library.db"), "utf8")).toBe(
        "selected database",
      );
      expect(backup.files.some((file) => file.sourcePath.endsWith("/master.db"))).toBe(false);
      await expect(readRekordboxBackup(backup.directory)).resolves.toEqual(backup);

      await writeFile(backup.files[0]!.backupPath, "corrupted recovery file");
      await expect(readRekordboxBackup(backup.directory)).rejects.toThrow(
        "Rekordbox backup file changed",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("requires one XML declaration and the committed playlist in the sidecar", () => {
    const valid = `<?xml version="1.0" encoding="UTF-8"?>\n<MASTER_PLAYLIST><PLAYLISTS><NODE Id="6399D566" ParentId="0" Attribute="1"/><NODE Id="2002750" ParentId="6399D566" Attribute="0"/></PLAYLISTS></MASTER_PLAYLIST>`;
    const expectation = { parentId: "1671026022", attribute: 0, parentAttribute: 1 };
    expect(() => validateMasterPlaylistSidecar(valid, "33564496", expectation)).not.toThrow();
    expect(() =>
      validateMasterPlaylistSidecar(`<?xml version="1.0"?>\n${valid}`, "33564496"),
    ).toThrow("2 XML declarations");
    expect(() => validateMasterPlaylistSidecar(valid, "123")).toThrow("0 nodes for playlist '123'");
    expect(() =>
      validateMasterPlaylistSidecar(valid.replace("</PLAYLISTS>", ""), "33564496"),
    ).toThrow("malformed");
    expect(() =>
      validateMasterPlaylistSidecar(
        valid.replace("</PLAYLISTS>", '<NODE Id="2002750"/></PLAYLISTS>'),
        "33564496",
      ),
    ).toThrow("2 nodes");
    expect(() =>
      validateMasterPlaylistSidecar(
        valid.replace('ParentId="6399D566" Attribute="0"', 'ParentId="0" Attribute="1"'),
        "33564496",
        expectation,
      ),
    ).toThrow("wrong parent/type");
  });
});
