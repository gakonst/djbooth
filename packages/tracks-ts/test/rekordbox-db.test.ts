import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test, vi } from "vitest";

import type { SetManifest } from "../src/manifest.js";
import {
  applyRekordboxImportResults,
  acquireRekordboxDatabaseLock,
  DEFAULT_REKORDBOX_IO_CONCURRENCY,
  defaultRekordboxPlaylistName,
  planRekordboxImport,
  preflightRekordboxMedia,
  resolveRekordboxAnalysisDirectory,
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
    tracklist: { provider: "agent", complete: true },
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

function repeatedRecordingManifest(): SetManifest {
  const manifest = completedManifest();
  const first = structuredClone(manifest.entries[0]!);
  if (first.acquisition.status !== "downloaded") throw new Error("invalid repeated fixture");
  delete first.acquisition.alternatives;
  const repeated = structuredClone(first);
  repeated.id = "track-002";
  repeated.order = 2;
  manifest.entries = [first, repeated];
  return manifest;
}

function captureContentValues(plan: RekordboxImportPlan): Array<Record<string, unknown>> {
  let id = 0;
  const values: Array<Record<string, unknown>> = [];
  const row = (tableName: string, fields: Record<string, unknown>) => ({
    ID: `${tableName}-${++id}`,
    tableName,
    ...fields,
    get(key: string) {
      return (this as Record<string, unknown>)[key];
    },
    set(key: string, value: unknown) {
      (this as Record<string, unknown>)[key] = value;
      return this;
    },
  });
  const models = {
    DjmdArtist: { tableName: "artist" },
    DjmdAlbum: { tableName: "album" },
    DjmdLabel: { tableName: "label" },
    DjmdContent: { tableName: "content" },
    DjmdPlaylist: { tableName: "playlist" },
    DjmdSongPlaylist: { tableName: "membership" },
  };
  const folder = row("playlist", { Name: plan.folderName, Attribute: 0, ParentID: "root" });
  const playlist = row("playlist", {
    Name: plan.playlistName,
    Attribute: 1,
    ParentID: folder.ID,
  });
  const db = {
    query(model: { tableName: string }) {
      let filters: Record<string, unknown> = {};
      const query = {
        where(next: Record<string, unknown>) {
          filters = next;
          return query;
        },
        orderBy() {
          return query;
        },
        all() {
          if (model.tableName === "playlist" && filters.Attribute === 0) return [folder];
          if (model.tableName === "playlist" && filters.Attribute === 1) return [playlist];
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
    addAlbum(name: string, options: { artist?: { ID: string } }) {
      return row("album", { Name: name, AlbumArtistID: options.artist?.ID });
    },
    addLabel(name: string) {
      return row("label", { Name: name });
    },
    addContent(path: string, contentValues: Record<string, unknown>) {
      values.push(structuredClone(contentValues));
      return row("content", { FolderPath: path, ...contentValues });
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
      return false;
    },
  } as unknown as RekordboxMasterDatabase;
  writeRekordboxPlan(
    db,
    { ...models, PlaylistType: { FOLDER: 0, PLAYLIST: 1 } } as unknown as RekordboxLibrary,
    plan,
  );
  return values;
}

async function durationPlanFixture() {
  const root = await mkdtemp(join(tmpdir(), "tracks-ts-rekordbox-duration-"));
  const manifest = completedManifest();
  manifest.entries = [manifest.entries[0]!];
  const entry = manifest.entries[0]!;
  if (entry.spotify.status !== "ambiguous" || entry.acquisition.status !== "downloaded")
    throw new Error("invalid duration fixture");
  entry.spotify.candidates[0]!.durationMs = 999_000;
  delete entry.spotify.candidates[1]!.durationMs;
  const downloads = [entry.acquisition.download, ...entry.acquisition.alternatives!];
  const durations = new Map<string, number>();
  for (const [index, download] of downloads.entries()) {
    const path = join(root, `track-${index + 1}.flac`);
    const contents = `verified audio ${index + 1}`;
    await writeFile(path, contents);
    download.mediaPath = path;
    download.files = [path];
    download.sha256 = createHash("sha256").update(contents).digest("hex");
    durations.set(path, index === 0 ? 101.4 : 201.6);
  }
  let probes = 0;
  return {
    root,
    plan: planRekordboxImport(manifest),
    probe: async (path: string) => {
      probes += 1;
      return { durationSeconds: durations.get(path)! };
    },
    probeCount: () => probes,
  };
}

describe("Rekordbox direct database planning", () => {
  test("caps parallel read/hash/copy work at eight available workers", () => {
    expect(DEFAULT_REKORDBOX_IO_CONCURRENCY).toBe(Math.min(8, availableParallelism()));
  });

  test("deduplicates albums by name and artist instead of name alone", () => {
    const albumFilters: Array<Record<string, unknown>> = [];
    const queryCounts = new Map<string, number>();
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
        queryCounts.set(model.tableName, (queryCounts.get(model.tableName) ?? 0) + 1);
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
        measuredDurationSeconds: 180 + index,
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
    expect(queryCounts.get("membership")).toBe(1);
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
      isrc: "DEEC32000011",
    });
    expect(plan.items[0]!.metadata.comment).toContain("Media source: https://youtu.be/full");
    expect(plan.items[0]!.metadata.comment).toContain(
      "Spotify URL: https://open.spotify.com/track/spotify-full",
    );
    expect(plan.items[1]!.metadata).toMatchObject({
      title: "Nen Lambo (&ME Edit) [Mixed]",
      artist: "Bill Loko, &ME",
      isrc: "QM24S2300834",
    });
    expect(plan.items[2]!.metadata).toMatchObject({
      title: "ID [Set Extract @ 00:05:00]",
      artist: "Unknown Artist",
    });
    expect(plan.items.every((item) => item.measuredDurationSeconds === undefined)).toBe(true);
    expect(plan.items.every((item) => !("durationSeconds" in item.metadata))).toBe(true);
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

  test("uses an acquired overlap identity when the primary recording was unavailable", () => {
    const manifest = completedManifest();
    const entry = manifest.entries[0]!;
    entry.identity = {
      status: "identified",
      artist: "Sub Focus",
      title: "Siren (Phrva Flip)",
      searchQuery: "Sub Focus - Siren (Phrva Flip)",
      overlaps: [{ artist: "A$AP Ferg", title: "WORK" }],
    };
    entry.spotify = { status: "unmatched", query: "Sub Focus - Siren (Phrva Flip)" };
    entry.acquisition = {
      status: "downloaded",
      download: {
        backend: "ytdlp",
        mediaPath: "/music/A$AP Ferg/WORK.m4a",
        files: ["/music/A$AP Ferg/WORK.m4a"],
        variantKey: createHash("sha256")
          .update("A$AP Ferg\u0000WORK\u0000")
          .digest("hex")
          .slice(0, 20),
      },
    };
    manifest.entries = [entry];

    expect(planRekordboxImport(manifest).items[0]!.metadata).toMatchObject({
      artist: "A$AP Ferg",
      title: "WORK",
    });
  });

  test("reuses an exact playlist ID across provider renames and duplicate display names", () => {
    const plan = planRekordboxImport(completedManifest(), {
      folderName: "Spotify",
      playlistName: "Renamed remotely",
      playlistId: "stable-local-playlist",
    });
    plan.items.forEach((item) => {
      item.measuredDurationSeconds = 180;
    });
    let id = 0;
    const row = (tableName: string, values: Record<string, unknown>) => ({
      ID: `${tableName}-${++id}`,
      tableName,
      ...values,
      get(key: string) {
        return (this as Record<string, unknown>)[key];
      },
      set(key: string, value: unknown) {
        (this as Record<string, unknown>)[key] = value;
        return this;
      },
    });
    const models = {
      DjmdArtist: { tableName: "artist" },
      DjmdAlbum: { tableName: "album" },
      DjmdLabel: { tableName: "label" },
      DjmdContent: { tableName: "content" },
      DjmdPlaylist: { tableName: "playlist" },
      DjmdSongPlaylist: { tableName: "membership" },
    };
    const folder = row("playlist", { Name: "Spotify", Attribute: 0, ParentID: "root" });
    const stable = row("playlist", {
      ID: "stable-local-playlist",
      Name: "Old provider name",
      Attribute: 1,
      ParentID: "old-folder",
    });
    const duplicateName = row("playlist", {
      Name: "Renamed remotely",
      Attribute: 1,
      ParentID: folder.ID,
    });
    const staleContent = row("content", { FolderPath: "/music/removed-remotely.flac" });
    const staleMembership = row("membership", {
      PlaylistID: stable.ID,
      ContentID: staleContent.ID,
      TrackNo: 1,
    });
    const createPlaylist = vi.fn();
    const deleteRow = vi.fn();
    const db = {
      query(model: { tableName: string }) {
        let filters: Record<string, unknown> = {};
        const query = {
          where(next: Record<string, unknown>) {
            filters = next;
            return query;
          },
          orderBy() {
            return query;
          },
          all() {
            if (model.tableName === "playlist" && filters.Attribute === 0) return [folder];
            if (model.tableName === "playlist" && filters.ID === stable.ID) return [stable];
            if (
              model.tableName === "playlist" &&
              filters.Name === "Renamed remotely" &&
              filters.ParentID === folder.ID
            )
              return [duplicateName];
            if (model.tableName === "membership" && filters.PlaylistID === stable.ID)
              return [staleMembership];
            return [];
          },
          one() {
            if (model.tableName === "content" && filters.ID === staleContent.ID)
              return staleContent;
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
      addAlbum(name: string, options: { artist?: { ID: string } }) {
        return row("album", { Name: name, AlbumArtistID: options.artist?.ID });
      },
      addLabel(name: string) {
        return row("label", { Name: name });
      },
      addContent(path: string, values: Record<string, unknown>) {
        return row("content", { FolderPath: path, ...values });
      },
      createPlaylist,
      renamePlaylist(playlist: { set(key: string, value: unknown): unknown }, name: string) {
        playlist.set("Name", name);
      },
      movePlaylist(
        playlist: { set(key: string, value: unknown): unknown },
        options: { parent: { ID: string } },
      ) {
        playlist.set("ParentID", options.parent.ID);
      },
      delete: deleteRow,
      addToPlaylist(target: { ID: string }, content: { ID: string }, trackNumber: number) {
        return row("membership", {
          PlaylistID: target.ID,
          ContentID: content.ID,
          TrackNo: trackNumber,
        });
      },
      moveSongInPlaylist() {},
      hasColumn() {
        return false;
      },
    } as unknown as RekordboxMasterDatabase;

    const result = writeRekordboxPlan(
      db,
      { ...models, PlaylistType: { FOLDER: 0, PLAYLIST: 1 } } as unknown as RekordboxLibrary,
      plan,
    );

    expect(plan.playlistId).toBe("stable-local-playlist");
    expect(result.playlistId).toBe("stable-local-playlist");
    expect(stable).toMatchObject({ Name: "Renamed remotely", ParentID: folder.ID });
    expect(createPlaylist).not.toHaveBeenCalled();
    expect(deleteRow).toHaveBeenCalledWith(staleMembership);
  });

  test("reuses one content row while importing repeated recording memberships in order", () => {
    const plan = planRekordboxImport(repeatedRecordingManifest());
    plan.items.forEach((item) => {
      item.measuredDurationSeconds = 240;
    });
    expect(plan.items.map(({ entryId, mediaPath }) => ({ entryId, mediaPath }))).toEqual([
      { entryId: "track-001", mediaPath: plan.items[0]!.mediaPath },
      { entryId: "track-002", mediaPath: plan.items[0]!.mediaPath },
    ]);

    let id = 0;
    const contents: Array<{ ID: string; FolderPath: string }> = [];
    const memberships: Array<{ ID: string; ContentID: string; TrackNo: number }> = [];
    const row = (tableName: string, values: Record<string, unknown>) => ({
      ID: `${tableName}-${++id}`,
      tableName,
      ...values,
      get(key: string) {
        return (this as Record<string, unknown>)[key];
      },
      set(key: string, value: unknown) {
        (this as Record<string, unknown>)[key] = value;
        return this;
      },
    });
    const models = {
      DjmdArtist: { tableName: "artist" },
      DjmdAlbum: { tableName: "album" },
      DjmdLabel: { tableName: "label" },
      DjmdContent: { tableName: "content" },
      DjmdPlaylist: { tableName: "playlist" },
      DjmdSongPlaylist: { tableName: "membership" },
    };
    const folder = row("playlist", { Name: plan.folderName, Attribute: 0, ParentID: "root" });
    const playlist = row("playlist", {
      Name: plan.playlistName,
      Attribute: 1,
      ParentID: folder.ID,
    });
    const db = {
      query(model: { tableName: string }) {
        let filters: Record<string, unknown> = {};
        const query = {
          where(next: Record<string, unknown>) {
            filters = next;
            return query;
          },
          orderBy() {
            return query;
          },
          all() {
            if (model.tableName === "playlist" && filters.Attribute === 0) return [folder];
            if (model.tableName === "playlist" && filters.Attribute === 1) return [playlist];
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
      addAlbum(name: string, options: { artist?: { ID: string } }) {
        return row("album", { Name: name, AlbumArtistID: options.artist?.ID });
      },
      addLabel(name: string) {
        return row("label", { Name: name });
      },
      addContent(path: string, values: Record<string, unknown>) {
        const content = row("content", { FolderPath: path, ...values });
        contents.push(content as unknown as { ID: string; FolderPath: string });
        return content;
      },
      addToPlaylist(_target: { ID: string }, content: { ID: string }, trackNumber: number) {
        const membership = row("membership", {
          PlaylistID: playlist.ID,
          ContentID: content.ID,
          TrackNo: trackNumber,
        });
        memberships.push(
          membership as unknown as { ID: string; ContentID: string; TrackNo: number },
        );
        return membership;
      },
      moveSongInPlaylist() {},
      hasColumn() {
        return false;
      },
    } as unknown as RekordboxMasterDatabase;

    const result = writeRekordboxPlan(
      db,
      { ...models, PlaylistType: { FOLDER: 0, PLAYLIST: 1 } } as unknown as RekordboxLibrary,
      plan,
    );

    expect(contents).toHaveLength(1);
    expect(memberships.map(({ ContentID, TrackNo }) => ({ ContentID, TrackNo }))).toEqual([
      { ContentID: contents[0]!.ID, TrackNo: 1 },
      { ContentID: contents[0]!.ID, TrackNo: 2 },
    ]);
    expect(new Set(memberships.map(({ ID }) => ID)).size).toBe(2);
    expect(
      result.imported.map(({ entryId, contentId, trackNumber }) => ({
        entryId,
        contentId,
        trackNumber,
      })),
    ).toEqual([
      { entryId: "track-001", contentId: contents[0]!.ID, trackNumber: 1 },
      { entryId: "track-002", contentId: contents[0]!.ID, trackNumber: 2 },
    ]);
  });

  test("writes actual media duration for mismatched and missing Spotify durations", async () => {
    const fixture = await durationPlanFixture();
    try {
      expect(fixture.plan.items[0]!.metadata).toMatchObject({
        title: "Nen Lambo (Rampa Edit)",
        artist: "Bill Loko, Rampa",
        isrc: "DEEC32000011",
      });
      expect(fixture.plan.items[1]!.metadata).toMatchObject({
        title: "Nen Lambo (&ME Edit) [Mixed]",
        artist: "Bill Loko, &ME",
        isrc: "QM24S2300834",
      });
      expect(fixture.plan.items.every((item) => !("durationSeconds" in item.metadata))).toBe(true);

      await preflightRekordboxMedia(fixture.plan, undefined, fixture.probe);

      expect(fixture.plan.items.map((item) => item.measuredDurationSeconds)).toEqual([101, 202]);
      expect(captureContentValues(fixture.plan).map((values) => values.Length)).toEqual([101, 202]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("refuses to write Length before artifact duration preflight", () => {
    expect(() => captureContentValues(planRekordboxImport(completedManifest()))).toThrow(
      "media duration was not measured",
    );
  });

  test("reuses a warm preflight receipt without probing unchanged media again", async () => {
    const fixture = await durationPlanFixture();
    try {
      const receipts = await preflightRekordboxMedia(fixture.plan, undefined, fixture.probe);
      expect(fixture.probeCount()).toBe(2);

      await preflightRekordboxMedia(fixture.plan, receipts, fixture.probe);

      expect(fixture.probeCount()).toBe(2);
      expect(fixture.plan.items.map((item) => item.measuredDurationSeconds)).toEqual([101, 202]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("hashes and probes a repeated recording once", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-ts-repeated-recording-"));
    try {
      const mediaPath = join(root, "shared.flac");
      const contents = "one verified physical recording";
      await writeFile(mediaPath, contents);
      const manifest = repeatedRecordingManifest();
      const sha256 = createHash("sha256").update(contents).digest("hex");
      for (const entry of manifest.entries) {
        if (entry.acquisition.status !== "downloaded") throw new Error("invalid repeated fixture");
        entry.acquisition.download.mediaPath = mediaPath;
        entry.acquisition.download.files = [mediaPath];
        entry.acquisition.download.sha256 = sha256;
      }
      const plan = planRekordboxImport(manifest);
      let probes = 0;

      const receipts = await preflightRekordboxMedia(plan, undefined, async () => {
        probes += 1;
        return { durationSeconds: 239.6 };
      });

      expect(probes).toBe(1);
      expect(receipts.size).toBe(1);
      expect(plan.items.map(({ measuredDurationSeconds }) => measuredDurationSeconds)).toEqual([
        240, 240,
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("maps native analysis directories by absolute media path", () => {
    const mediaPath = resolve("/music/festival-set/tracks/01-full.m4a");
    const analysisDirectory = resolve("/analysis/01-full");
    const analysisDirectories = { [mediaPath]: analysisDirectory };

    expect(resolveRekordboxAnalysisDirectory(mediaPath, analysisDirectories)).toBe(
      analysisDirectory,
    );
    const plan = planRekordboxImport(completedManifest(), {
      mediaBaseDirectory: "/music/festival-set",
      analysisDirectories,
    });
    expect(plan.items[0]!.analysisDirectory).toBe(analysisDirectory);
    expect(plan.items[1]).not.toHaveProperty("analysisDirectory");
    expect(() =>
      planRekordboxImport(completedManifest(), {
        mediaBaseDirectory: "/music/festival-set",
        analysisDirectories: { "/music/not-in-this-set.m4a": analysisDirectory },
      }),
    ).toThrow("analysis references media outside this manifest");
  });

  test("creates a missing folder and installs analysis without committing", () => {
    let id = 0;
    let commitCount = 0;
    let createdFolderName: string | undefined;
    const installationCalls: Array<{
      contentId: string;
      directory: string;
      options: Record<string, boolean | undefined>;
    }> = [];
    const row = (tableName: string, values: Record<string, unknown>) => ({
      ID: `${tableName}-${++id}`,
      tableName,
      ...values,
      get(key: string) {
        return (this as Record<string, unknown>)[key];
      },
      set(key: string, value: unknown) {
        (this as Record<string, unknown>)[key] = value;
        return this;
      },
    });
    const models = {
      DjmdArtist: { tableName: "artist" },
      DjmdAlbum: { tableName: "album" },
      DjmdLabel: { tableName: "label" },
      DjmdContent: { tableName: "content" },
      DjmdPlaylist: { tableName: "playlist" },
      DjmdSongPlaylist: { tableName: "membership" },
    };
    const db = {
      query() {
        const query = {
          where() {
            return query;
          },
          orderBy() {
            return query;
          },
          all() {
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
      addAlbum() {
        throw new Error("unexpected addAlbum()");
      },
      addLabel() {
        throw new Error("unexpected addLabel()");
      },
      addContent(path: string, values: Record<string, unknown>) {
        return row("content", { FolderPath: path, ...values });
      },
      createPlaylistFolder(name: string) {
        createdFolderName = name;
        return row("playlist", { Name: name, Attribute: 0, ParentID: "root" });
      },
      createPlaylist(name: string, options: { parent: { ID: string } }) {
        return row("playlist", {
          Name: name,
          Attribute: 1,
          ParentID: options.parent.ID,
        });
      },
      installContentAnalysis(
        content: { ID: string; set(key: string, value: unknown): unknown },
        directory: string,
        options: Record<string, boolean | undefined>,
      ) {
        installationCalls.push({ contentId: content.ID, directory, options });
        content.set("AnalysisDataPath", "/PIONEER/USBANLZ/con/tent/ANLZ0000.DAT");
        return {
          analysisDataPath: "/PIONEER/USBANLZ/con/tent/ANLZ0000.DAT",
          bpmHundredths: 12_801,
          contentId: content.ID,
          directory: "/rekordbox/share/PIONEER/USBANLZ/con/tent",
          keyId: "key-10a",
          keyName: "10A",
          paths: {
            DAT: "/rekordbox/share/PIONEER/USBANLZ/con/tent/ANLZ0000.DAT",
            EXT: "/rekordbox/share/PIONEER/USBANLZ/con/tent/ANLZ0000.EXT",
            "2EX": "/rekordbox/share/PIONEER/USBANLZ/con/tent/ANLZ0000.2EX",
          },
          tempoBpm: 128.006827,
        };
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
      commit() {
        commitCount += 1;
      },
    } as unknown as RekordboxMasterDatabase;
    const plan: RekordboxImportPlan = {
      folderName: "DJ Sets I Like",
      playlistName: "Analyzed Set",
      items: [
        {
          key: "track-1:0",
          entryId: "track-1",
          entryOrder: 1,
          variantIndex: 0,
          mediaPath: "/music/track-1.flac",
          measuredDurationSeconds: 180,
          analysisDirectory: "/analysis/track-1",
          download: {
            backend: "slsk",
            mediaPath: "/music/track-1.flac",
            files: ["/music/track-1.flac"],
          },
          metadata: { title: "Track 1", artist: "Artist 1", comment: "test" },
        },
      ],
    };
    const result = writeRekordboxPlan(
      db,
      {
        ...models,
        PlaylistType: { FOLDER: 0, PLAYLIST: 1 },
      } as unknown as RekordboxLibrary,
      plan,
    );

    expect(createdFolderName).toBe("DJ Sets I Like");
    expect(result.installedAnalysis).toHaveLength(1);
    expect(installationCalls).toEqual([
      {
        contentId: result.imported[0]!.contentId,
        directory: "/analysis/track-1",
        options: { commit: false, replace: false },
      },
    ]);
    expect(commitCount).toBe(0);
  });

  test.each([true, false])(
    "reuses installed ANLZ or repairs a missing directory (installed=%s)",
    (installed) => {
      const row = (tableName: string, values: Record<string, unknown>) => ({
        ID: `${tableName}-1`,
        tableName,
        ...values,
        get(key: string) {
          return (this as Record<string, unknown>)[key];
        },
        set(key: string, value: unknown) {
          (this as Record<string, unknown>)[key] = value;
          return this;
        },
      });
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
        Name: "Analyzed Set",
        Attribute: 1,
        ParentID: folder.ID,
      });
      const content = row("content", {
        FolderPath: "/music/track-1.flac",
        AnalysisDataPath: "/PIONEER/USBANLZ/con/tent/ANLZ0000.DAT",
      });
      const membership = row("membership", {
        PlaylistID: playlist.ID,
        ContentID: content.ID,
        TrackNo: 1,
      });
      const syncCalls: Array<{ directory: string; options: Record<string, boolean | undefined> }> =
        [];
      const paths = {
        DAT: "/installed/ANLZ0000.DAT",
        EXT: "/installed/ANLZ0000.EXT",
        "2EX": "/installed/ANLZ0000.2EX",
      };
      const db = {
        query(model: { tableName: string }) {
          let filters: Record<string, unknown> = {};
          const query = {
            where(next: Record<string, unknown>) {
              filters = next;
              return query;
            },
            orderBy() {
              return query;
            },
            all() {
              if (model.tableName === "playlist" && filters.Attribute === 0) return [folder];
              if (model.tableName === "playlist" && filters.Attribute === 1) return [playlist];
              if (model.tableName === "membership") return [membership];
              if (model.tableName === "content" && filters.FolderPath === "/music/track-1.flac")
                return [content];
              return [];
            },
            one() {
              if (model.tableName === "content" && filters.ID === content.ID) return content;
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
        getContentAnlzPaths() {
          if (!installed) throw Object.assign(new Error("Missing directory"), { code: "ENOENT" });
          return paths;
        },
        syncContentAnalysisMetadata(
          target: { ID: string },
          directory: string,
          options: Record<string, boolean | undefined>,
        ) {
          expect(target).toBe(content);
          syncCalls.push({ directory, options });
          content.set("BPM", 12_801);
          content.set("KeyID", "key-10a");
          return {
            bpmHundredths: 12_801,
            contentId: content.ID,
            keyId: "key-10a",
            keyName: "10A",
            tempoBpm: 128.006827,
          };
        },
        installContentAnalysis(target: { ID: string }) {
          if (installed) throw new Error("Existing analysis must not be replaced");
          content.set("BPM", 12_801);
          content.set("KeyID", "key-10a");
          return { contentId: target.ID, paths };
        },
        addToPlaylist() {
          throw new Error("unexpected addToPlaylist()");
        },
        moveSongInPlaylist() {},
        hasColumn() {
          return true;
        },
      } as unknown as RekordboxMasterDatabase;
      const plan: RekordboxImportPlan = {
        folderName: "DJ Sets I Like",
        playlistName: "Analyzed Set",
        items: [
          {
            key: "track-1:0",
            entryId: "track-1",
            entryOrder: 1,
            variantIndex: 0,
            mediaPath: "/music/track-1.flac",
            measuredDurationSeconds: 180,
            analysisDirectory: "/analysis/track-1",
            download: {
              backend: "slsk",
              mediaPath: "/music/track-1.flac",
              files: ["/music/track-1.flac"],
            },
            metadata: { title: "Track 1", artist: "Artist 1", comment: "test" },
          },
        ],
      };

      const result = writeRekordboxPlan(
        db,
        { ...models, PlaylistType: { FOLDER: 0, PLAYLIST: 1 } } as unknown as RekordboxLibrary,
        plan,
      );

      expect(result.imported[0]?.contentId).toBe(content.ID);
      expect(result.imported[0]?.membershipId).toBe(membership.ID);
      expect(content.get("BPM")).toBe(12_801);
      expect(result.installedAnalysis).toEqual(installed ? [] : [{ contentId: content.ID, paths }]);
      expect(syncCalls).toEqual(
        installed
          ? [
              {
                directory: "/analysis/track-1",
                options: { commit: false },
              },
            ]
          : [],
      );
    },
  );

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
    });
    expect(alternative).not.toHaveProperty("durationSeconds");
    expect(alternative).not.toHaveProperty("album");
    expect(alternative).not.toHaveProperty("releaseDate");
    expect(alternative).not.toHaveProperty("isrc");
  });

  test("preserves a full DJ mix title while retaining source provenance", () => {
    const manifest = completedManifest();
    manifest.source.input = "djbooth:whole-set:https://youtu.be/full-set";
    manifest.entries = [manifest.entries[0]!];
    manifest.entries[0]!.spotify = { status: "pending" };
    manifest.artifacts.sourceSet = {
      url: "https://youtu.be/full-set",
      path: "/music/full-set.m4a",
      durationSeconds: 7064,
      sha256: "a".repeat(64),
      codec: "aac",
      bitrate: 128000,
    };
    const acquisition = manifest.entries[0]!.acquisition;
    if (acquisition.status !== "downloaded") throw new Error();
    delete acquisition.alternatives;
    acquisition.download.kind = "source-set-clip";
    acquisition.download.clip = {
      sourceSetUrl: "https://youtu.be/full-set",
      startSeconds: 0,
      endSeconds: 7064,
      containsTransitions: true,
      qualityNote: "Complete original DJ mix",
    };
    const metadata = planRekordboxImport(manifest).items[0]!.metadata;
    expect(metadata.title).not.toContain("[Set Extract]");
    expect(metadata.comment).toContain("[Full DJ Set]");
    acquisition.download.clip.endSeconds = 300;
    expect(planRekordboxImport(manifest).items[0]!.metadata.title).toContain("[Set Extract]");
  });

  test("rejects a media path reused by different recording metadata", () => {
    const manifest = completedManifest();
    const first = manifest.entries[0]!.acquisition;
    const second = manifest.entries[1]!.acquisition;
    if (first.status !== "downloaded" || second.status !== "downloaded") throw new Error();
    second.download.mediaPath = first.download.mediaPath;
    second.download.files = [first.download.mediaPath];
    expect(() => planRekordboxImport(manifest)).toThrow(
      "Repeated media path must describe one identical recording",
    );
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
    });
  });

  test("derives the default playlist name", () => {
    expect(defaultRekordboxPlaylistName(completedManifest())).toBe("Festival Set [tracks-ts]");
  });

  test("canonicalizes symlink spellings to one Rekordbox database lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-ts-rekordbox-lock-"));
    const dbPath = join(root, "master.db");
    const aliasPath = join(root, "library-alias.db");
    try {
      await writeFile(dbPath, "fixture");
      await symlink(dbPath, aliasPath);
      const release = await acquireRekordboxDatabaseLock(aliasPath);
      await expect(acquireRekordboxDatabaseLock(dbPath)).rejects.toThrow(
        "database import lock already exists",
      );
      await release();
      const releaseAgain = await acquireRekordboxDatabaseLock(dbPath);
      await releaseAgain();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("defaults database locks to durable syncs and skips them in session mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-ts-rekordbox-lock-durability-"));
    const dbPath = join(root, "master.db");
    const probePath = join(root, "sync-probe");
    let sync: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await writeFile(dbPath, "fixture");
      const probe = await open(probePath, "wx");
      sync = vi.spyOn(Object.getPrototypeOf(probe), "sync");
      await probe.close();
      await rm(probePath);
      sync.mockClear();

      const releaseDurable = await acquireRekordboxDatabaseLock(dbPath);
      await releaseDurable();
      expect(sync).toHaveBeenCalled();
      sync.mockClear();

      const releaseSession = await acquireRekordboxDatabaseLock(dbPath, {
        durability: "session",
      });
      await expect(acquireRekordboxDatabaseLock(dbPath, { durability: "session" })).rejects.toThrow(
        "database import lock already exists",
      );
      await releaseSession();
      expect(sync).not.toHaveBeenCalled();
    } finally {
      sync?.mockRestore();
      await rm(root, { force: true, recursive: true });
    }
  });

  test.each([
    ["durable", undefined],
    ["session", { durability: "session" } as const],
  ])("recovers a crashed stale acquisition guard in %s mode", async (_mode, options) => {
    const root = await mkdtemp(join(tmpdir(), "tracks-ts-rekordbox-stale-guard-"));
    const dbPath = join(root, "master.db");
    const lockPath = `${dbPath}.tracks-ts.lock`;
    const guardPath = `${lockPath}.acquire`;
    try {
      await writeFile(dbPath, "fixture");
      await writeFile(guardPath, "{}\n");
      const stale = new Date(Date.now() - 25 * 60 * 60 * 1_000);
      await utimes(guardPath, stale, stale);

      const release = await acquireRekordboxDatabaseLock(dbPath, options);
      await release();

      await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(guardPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("preserves stale recovery and ownership checks in session mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-ts-rekordbox-session-lock-"));
    const dbPath = join(root, "master.db");
    const aliasPath = join(root, "library-alias.db");
    const lockPath = `${dbPath}.tracks-ts.lock`;
    try {
      await writeFile(dbPath, "fixture");
      await symlink(dbPath, aliasPath);
      await writeFile(lockPath, "{}\n");
      const stale = new Date(Date.now() - 25 * 60 * 60 * 1_000);
      await utimes(lockPath, stale, stale);

      const release = await acquireRekordboxDatabaseLock(aliasPath, { durability: "session" });
      await expect(acquireRekordboxDatabaseLock(dbPath, { durability: "session" })).rejects.toThrow(
        "database import lock already exists",
      );
      await rm(lockPath);
      const replacement = { pid: process.pid, token: "replacement-owner" };
      await writeFile(lockPath, `${JSON.stringify(replacement)}\n`);

      await release();

      expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(replacement);
      await expect(readFile(`${lockPath}.acquire`)).rejects.toMatchObject({ code: "ENOENT" });
      await rm(lockPath);
      const releaseAgain = await acquireRekordboxDatabaseLock(dbPath, {
        durability: "session",
      });
      await releaseAgain();
      await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("serializes concurrent recovery of one stale session database lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-ts-rekordbox-stale-lock-"));
    const dbPath = join(root, "master.db");
    const lockPath = `${dbPath}.tracks-ts.lock`;
    try {
      await writeFile(dbPath, "fixture");
      await writeFile(lockPath, "{}\n");
      const stale = new Date(Date.now() - 25 * 60 * 60 * 1_000);
      await utimes(lockPath, stale, stale);

      const results = await Promise.allSettled([
        acquireRekordboxDatabaseLock(dbPath, { durability: "session" }),
        acquireRekordboxDatabaseLock(dbPath, { durability: "session" }),
      ]);
      const acquired = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      expect(acquired).toHaveLength(1);
      expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);

      await acquired[0]!();
      await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(`${lockPath}.acquire`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("serializes concurrent recovery of one stale session acquisition guard", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-ts-rekordbox-stale-guard-"));
    const dbPath = join(root, "master.db");
    const lockPath = `${dbPath}.tracks-ts.lock`;
    const guardPath = `${lockPath}.acquire`;
    try {
      await writeFile(dbPath, "fixture");
      await writeFile(guardPath, "{}\n");
      const stale = new Date(Date.now() - 25 * 60 * 60 * 1_000);
      await utimes(guardPath, stale, stale);

      const attempts = 32;
      const results = await Promise.allSettled(
        Array.from({ length: attempts }, () =>
          acquireRekordboxDatabaseLock(dbPath, { durability: "session" }),
        ),
      );
      const acquired = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      expect(acquired).toHaveLength(1);
      expect(results.filter(({ status }) => status === "rejected")).toHaveLength(attempts - 1);

      await Promise.all(Array.from({ length: attempts }, () => acquired[0]!()));
      await expect(readFile(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(guardPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not remove a replacement Rekordbox database lock on release", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-ts-rekordbox-owned-lock-"));
    const dbPath = join(root, "master.db");
    const lockPath = `${dbPath}.tracks-ts.lock`;
    try {
      await writeFile(dbPath, "fixture");
      const release = await acquireRekordboxDatabaseLock(dbPath);
      await rm(lockPath);
      const replacement = { pid: process.pid, token: "replacement-owner" };
      await writeFile(lockPath, `${JSON.stringify(replacement)}\n`);

      await release();

      expect(JSON.parse(await readFile(lockPath, "utf8"))).toEqual(replacement);
      await expect(readFile(`${lockPath}.acquire`)).rejects.toMatchObject({ code: "ENOENT" });
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
