import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";

import { AnlzFile, getAnlzPaths } from "../anlz/index.js";
import {
  assertRekordboxWriteStopped,
  DjmdContent,
  getRekordboxWriteProcessState,
  MasterDatabase,
  type RekordboxWriteProcessState,
} from "../masterdb/index.js";
import { inspectLegacyDevicePdb, LegacyDevicePdbWriter } from "./pdb.js";

const EXPORT_PDB = join("PIONEER", "rekordbox", "export.pdb");
const PLAYLIST_MARKER = ".music-cdj-playlist-sync.json";

type PlaylistSyncRecord = {
  databasePath: string;
  playlistId: string;
  playlistName: string;
  usbFolderId: number;
  usbPlaylistId: number;
  trackIds: number[];
  syncedAt: string;
};

type PlaylistSyncMarker = {
  schemaVersion: 1;
  format: "legacy-device-playlist-sync";
  records: PlaylistSyncRecord[];
};

/** Options for appending one master-library playlist to an existing Rekordbox USB export. */
export type SyncLegacyDevicePlaylistOptions = {
  /** Explicit acknowledgement for USB mutation. */
  approved: boolean;
  /** Mounted FAT/exFAT CDJ media root. */
  targetDirectory: string;
  /** Exact normal Rekordbox playlist ID. */
  playlistId: string;
  /** Rekordbox `master.db`; defaults to the configured Rekordbox 6/7 database. */
  databasePath?: string;
  /** Optional SQLCipher key override. */
  databaseKey?: string;
  /** Disable SQLCipher setup for an explicitly plain SQLite library. */
  databaseUnlock?: boolean;
  /** Deterministic clock override for tests. */
  now?: Date;
  /** Testable process-state override. */
  getProcessState?: () => RekordboxWriteProcessState;
};

/** Result of one scoped, append-only legacy Device Library playlist synchronization. */
export type SyncLegacyDevicePlaylistResult = {
  schemaVersion: 1;
  format: "legacy-device-playlist-sync";
  databasePath: string;
  targetDirectory: string;
  playlistId: string;
  playlistName: string;
  folderName: string;
  usbFolderId: number;
  usbPlaylistId: number;
  tracks: number;
  audioFiles: number;
  analysisFiles: number;
  bytesCopied: number;
  backupPath: string | null;
  changed: boolean;
};

/**
 * Append one playlist to a Rekordbox-created legacy USB export without rebuilding existing rows.
 *
 * Existing tracks and playlists remain in place. New audio and rewritten ANLZ files are staged
 * first, the prior PDB is backed up, and the validated replacement PDB is published last.
 */
export async function syncLegacyDevicePlaylist(
  options: SyncLegacyDevicePlaylistOptions,
): Promise<SyncLegacyDevicePlaylistResult> {
  if (!options.approved)
    throw new TypeError("USB playlist synchronization requires write approval");
  assertRekordboxWriteStopped((options.getProcessState ?? getRekordboxWriteProcessState)());
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("Sync clock is invalid");
  const targetDirectory = await realpath(resolve(options.targetDirectory));
  const pdbPath = join(targetDirectory, EXPORT_PDB);
  const originalPdb = await readFile(pdbPath);
  const original = inspectLegacyDevicePdb(originalPdb);
  if (original.histories.length)
    throw new Error(
      `USB contains ${String(original.histories.length)} unimported CDJ history item(s); import them before scoped playlist sync`,
    );

  const database = new MasterDatabase({
    ...(options.databasePath ? { path: options.databasePath } : {}),
    ...(options.databaseKey ? { key: options.databaseKey } : {}),
    unlock: options.databaseUnlock ?? true,
    readonly: true,
  });
  try {
    const databasePath = await realpath(database.path);
    const summary = database.listPlaylists().find(({ id }) => id === options.playlistId);
    if (!summary || summary.type !== "playlist")
      throw new RangeError(`Normal playlist '${options.playlistId}' was not found`);
    const parent = database.listPlaylists().find(({ id }) => id === summary.parentId);
    const folderName = parent?.type === "folder" ? parent.name : "DJ Sets I Like";
    const markerPath = join(targetDirectory, PLAYLIST_MARKER);
    const marker = await readPlaylistMarker(markerPath);
    const prior = marker.records.find(
      (record) => record.databasePath === databasePath && record.playlistId === summary.id,
    );
    if (prior) {
      verifyPriorRecord(original, prior);
      return result({
        databasePath,
        targetDirectory,
        summary,
        folderName,
        record: prior,
        tracks: prior.trackIds.length,
        changed: false,
      });
    }

    const existingFolder = original.playlists.find(
      (playlist) => playlist.parentId === 0 && playlist.name === folderName,
    );
    if (existingFolder && !existingFolder.folder)
      throw new Error(`USB root item '${folderName}' exists but is not a folder`);
    if (
      existingFolder &&
      original.playlists.some(
        (playlist) => playlist.parentId === existingFolder.id && playlist.name === summary.name,
      )
    )
      throw new Error(
        `USB playlist '${folderName} / ${summary.name}' already exists without a music-ts sync receipt`,
      );

    const tracks = database.getPlaylistTracks(summary.id);
    if (!tracks.length) throw new Error(`Playlist '${summary.name}' contains no tracks`);
    const writer = new LegacyDevicePdbWriter(originalPdb);
    const nextTrackId = Math.max(0, ...original.tracks.map(({ id }) => id)) + 1;
    const stagingRoot = join(targetDirectory, `.music-cdj-playlist-staging-${randomUUID()}`);
    await mkdir(stagingRoot);
    const stagedInstalls: Array<{ staged: string; target: string }> = [];
    let bytesCopied = 0;
    let analysisFiles = 0;
    let published = false;
    try {
      const trackIds: number[] = [];
      for (const [index, track] of tracks.entries()) {
        const content = database.query(DjmdContent).where({ ID: track.contentId }).one();
        const audioPath = requiredString(track.path, `Track '${track.contentId}' audio path`);
        const audio = await stat(audioPath);
        if (!audio.isFile()) throw new Error(`Track '${track.contentId}' audio is not a file`);
        const pdbId = nextTrackId + index;
        const idHex = pdbId.toString(16).toUpperCase().padStart(8, "0");
        const filename = safeFilename(
          stringValue(content.get("FileNameL")) ?? basename(audioPath),
          pdbId,
        );
        const usbAudioPath = `/Contents/music-ts/${idHex}/${filename}`;
        const analysisPath = requiredString(
          content.get("AnalysisDataPath"),
          `Track '${track.contentId}' AnalysisDataPath`,
        );
        const analysisDirectory = resolveAnalysisDirectory(database, analysisPath);
        const analysis = getAnlzPaths(analysisDirectory);
        if (!analysis.DAT)
          throw new Error(
            `Track '${track.contentId}' has no ANLZ0000.DAT in '${analysisDirectory}'`,
          );
        const analysisGroup = `P${String(pdbId % 1000).padStart(3, "0")}`;
        const usbAnalysisDirectory = `/PIONEER/USBANLZ/${analysisGroup}/${idHex}`;
        writer.addTrack({
          id: pdbId,
          title: track.title ?? filename,
          artist: track.artist,
          key: track.key,
          filePath: usbAudioPath,
          filename,
          analyzePath: `${usbAnalysisDirectory}/ANLZ0000.DAT`,
          tempo: track.bpm === null ? 0 : Math.round(track.bpm * 100),
          duration: track.durationSeconds ?? 0,
          fileSize: audio.size,
          fileType: track.fileType ?? undefined,
          playCount: integerValue(content.get("DJPlayCount")),
          rating: integerValue(content.get("Rating")),
          colorId: integerValue(content.get("ColorID")),
          sampleRate: integerValue(content.get("SampleRate"), 44_100),
          sampleDepth: integerValue(content.get("BitDepth"), 16),
          bitrate: integerValue(content.get("BitRate")),
          trackNumber: integerValue(content.get("TrackNo")),
          discNumber: integerValue(content.get("DiscNo")),
          year: integerValue(content.get("ReleaseYear")),
          comment: stringValue(content.get("Commnt")) ?? "",
          mixName: stringValue(content.get("Subtitle")) ?? "",
          dateAdded: dateValue(content.get("StockDate")),
          releaseDate: dateValue(content.get("ReleaseDate")),
        });
        trackIds.push(pdbId);

        const stagedAudio = mediaPath(stagingRoot, usbAudioPath);
        await mkdir(dirname(stagedAudio), { recursive: true });
        await copyFile(audioPath, stagedAudio);
        bytesCopied += audio.size;
        stagedInstalls.push({
          staged: stagedAudio,
          target: mediaPath(targetDirectory, usbAudioPath),
        });

        for (const type of ["DAT", "EXT", "2EX"] as const) {
          const source = analysis[type];
          if (!source) continue;
          const staged = join(
            stagingRoot,
            "PIONEER",
            "USBANLZ",
            analysisGroup,
            idHex,
            `ANLZ0000.${type}`,
          );
          await mkdir(dirname(staged), { recursive: true });
          const file = AnlzFile.parseFile(source);
          file.setPath(usbAudioPath);
          file.save(staged);
          AnlzFile.parseFile(staged);
          bytesCopied += (await stat(staged)).size;
          analysisFiles++;
          stagedInstalls.push({
            staged,
            target: join(
              targetDirectory,
              "PIONEER",
              "USBANLZ",
              analysisGroup,
              idHex,
              `ANLZ0000.${type}`,
            ),
          });
        }
      }

      const usbFolderId = existingFolder?.id ?? writer.createPlaylist(folderName, { folder: true });
      const usbPlaylistId = writer.createPlaylist(summary.name, { parentId: usbFolderId });
      for (const [index, trackId] of trackIds.entries())
        writer.addToPlaylist(usbPlaylistId, trackId, index + 1);
      const nextPdb = writer.build();
      const nextInspection = inspectLegacyDevicePdb(nextPdb);
      verifyAppend(original, nextInspection, usbFolderId, usbPlaylistId, trackIds);
      const stagedPdb = join(stagingRoot, EXPORT_PDB);
      await mkdir(dirname(stagedPdb), { recursive: true });
      await writeFile(stagedPdb, nextPdb);

      const timestamp = now.toISOString().replaceAll(/[-:.]/gu, "").replace("Z", "Z");
      const backupPath = join(
        targetDirectory,
        "PIONEER",
        "rekordbox",
        `export.pdb.music-ts-backup-${timestamp}`,
      );
      await copyFile(pdbPath, backupPath);
      const installed: string[] = [];
      try {
        for (const install of stagedInstalls) {
          await mkdir(dirname(install.target), { recursive: true });
          await rename(install.staged, install.target);
          installed.push(install.target);
        }
        await rename(stagedPdb, pdbPath);
        published = true;
      } catch (error) {
        if (!published)
          await Promise.all(
            installed.map((path) => rm(path, { force: true }).catch(() => undefined)),
          );
        throw error;
      }

      const record: PlaylistSyncRecord = {
        databasePath,
        playlistId: summary.id,
        playlistName: summary.name,
        usbFolderId,
        usbPlaylistId,
        trackIds,
        syncedAt: now.toISOString(),
      };
      await writePlaylistMarker(markerPath, { ...marker, records: [...marker.records, record] });
      return result({
        databasePath,
        targetDirectory,
        summary,
        folderName,
        record,
        tracks: tracks.length,
        audioFiles: tracks.length,
        analysisFiles,
        bytesCopied,
        backupPath,
        changed: true,
      });
    } finally {
      await rm(stagingRoot, { force: true, recursive: true });
    }
  } finally {
    database.close();
  }
}

function result(input: {
  databasePath: string;
  targetDirectory: string;
  summary: { id: string; name: string };
  folderName: string;
  record: PlaylistSyncRecord;
  tracks: number;
  audioFiles?: number;
  analysisFiles?: number;
  bytesCopied?: number;
  backupPath?: string;
  changed: boolean;
}): SyncLegacyDevicePlaylistResult {
  return {
    schemaVersion: 1,
    format: "legacy-device-playlist-sync",
    databasePath: input.databasePath,
    targetDirectory: input.targetDirectory,
    playlistId: input.summary.id,
    playlistName: input.summary.name,
    folderName: input.folderName,
    usbFolderId: input.record.usbFolderId,
    usbPlaylistId: input.record.usbPlaylistId,
    tracks: input.tracks,
    audioFiles: input.audioFiles ?? 0,
    analysisFiles: input.analysisFiles ?? 0,
    bytesCopied: input.bytesCopied ?? 0,
    backupPath: input.backupPath ?? null,
    changed: input.changed,
  };
}

function verifyAppend(
  before: ReturnType<typeof inspectLegacyDevicePdb>,
  after: ReturnType<typeof inspectLegacyDevicePdb>,
  folderId: number,
  playlistId: number,
  trackIds: readonly number[],
): void {
  for (const track of before.tracks) {
    const current = after.tracks.find(({ id }) => id === track.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(track))
      throw new Error(`Existing USB track ${String(track.id)} changed during scoped sync`);
  }
  for (const playlist of before.playlists) {
    const current = after.playlists.find(({ id }) => id === playlist.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(playlist))
      throw new Error(`Existing USB playlist ${String(playlist.id)} changed during scoped sync`);
  }
  const folder = after.playlists.find(({ id }) => id === folderId);
  const playlist = after.playlists.find(({ id }) => id === playlistId);
  if (!folder?.folder) throw new Error("Scoped USB folder was not materialized");
  if (!playlist || playlist.parentId !== folderId || playlist.folder)
    throw new Error("Scoped USB playlist was not materialized under its folder");
  if (JSON.stringify(playlist.trackIds) !== JSON.stringify(trackIds))
    throw new Error("Scoped USB playlist order failed verification");
}

function verifyPriorRecord(
  inspection: ReturnType<typeof inspectLegacyDevicePdb>,
  record: PlaylistSyncRecord,
): void {
  const folder = inspection.playlists.find(({ id }) => id === record.usbFolderId);
  const playlist = inspection.playlists.find(({ id }) => id === record.usbPlaylistId);
  if (!folder?.folder || !playlist || playlist.parentId !== folder.id)
    throw new Error(`USB sync receipt for '${record.playlistName}' no longer matches export.pdb`);
  if (JSON.stringify(playlist.trackIds) !== JSON.stringify(record.trackIds))
    throw new Error(`USB sync receipt for '${record.playlistName}' has stale track order`);
}

async function readPlaylistMarker(path: string): Promise<PlaylistSyncMarker> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<PlaylistSyncMarker>;
    if (
      value.schemaVersion !== 1 ||
      value.format !== "legacy-device-playlist-sync" ||
      !Array.isArray(value.records)
    )
      throw new TypeError(`Invalid scoped playlist sync marker '${path}'`);
    return value as PlaylistSyncMarker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { schemaVersion: 1, format: "legacy-device-playlist-sync", records: [] };
    throw error;
  }
}

async function writePlaylistMarker(path: string, marker: PlaylistSyncMarker): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path);
}

function resolveAnalysisDirectory(database: MasterDatabase, analysisPath: string): string {
  const relative = analysisPath.replace(/^[/\\]+/u, "").replaceAll("\\", "/");
  return join(database.shareDirectory, dirname(relative));
}

function mediaPath(root: string, path: string): string {
  const relative = path.replace(/^\/+/, "");
  if (!relative || relative.split("/").some((segment) => !segment || segment === ".."))
    throw new TypeError(`Unsafe USB media path '${path}'`);
  return join(root, ...relative.split(posix.sep));
}

function safeFilename(value: string, trackId: number): string {
  const sanitized = [...value]
    .map((character) => (character.codePointAt(0)! < 0x20 ? "_" : character))
    .join("")
    .replaceAll(/[<>:"/\\|?*]/gu, "_")
    .replaceAll(/[. ]+$/gu, "")
    .slice(0, 180);
  return sanitized || `track-${String(trackId).padStart(8, "0")}`;
}

function requiredString(value: unknown, name: string): string {
  const string = stringValue(value);
  if (!string) throw new TypeError(`${name} is missing`);
  return string;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function integerValue(value: unknown, fallback = 0): number {
  const number =
    typeof value === "string" && value.trim() ? Number(value) : Number(value ?? fallback);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
}

function dateValue(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime()))
    return value.toISOString().slice(0, 10);
  const match = stringValue(value)?.match(/^\d{4}-\d{2}-\d{2}/u);
  return match?.[0] ?? "";
}
