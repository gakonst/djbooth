import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, posix, resolve } from "node:path";

import { AnlzFile, getAnlzPaths } from "../anlz/index.js";
import {
  DeviceLibraryPlus,
  type OneLibraryExportTrack,
  writeOneLibraryPlaylist,
} from "../devicelib-plus/index.js";
import {
  assertRekordboxWriteStopped,
  DjmdContent,
  getRekordboxWriteProcessState,
  MasterDatabase,
  type RekordboxWriteProcessState,
} from "../masterdb/index.js";
import { inspectLegacyDevicePdb, LegacyDevicePdbWriter } from "./pdb.js";

const EXPORT_PDB = join("PIONEER", "rekordbox", "export.pdb");
const ONE_LIBRARY_DB = join("PIONEER", "rekordbox", "exportLibrary.db");
const PLAYLIST_MARKER = ".music-cdj-playlist-sync.json";

type PlaylistSyncRecord = {
  databasePath: string;
  playlistId: string;
  playlistName: string;
  usbFolderId: number;
  usbPlaylistId: number;
  trackIds: number[];
  oneLibraryFolderId?: number;
  oneLibraryPlaylistId?: number;
  oneLibraryContentIds?: number[];
  syncedAt: string;
};

type PlaylistSyncMarker = {
  schemaVersion: 1 | 2;
  format: "legacy-device-playlist-sync" | "dual-device-playlist-sync";
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
  /** Initialize an empty stick with traditional Device Library plus OneLibrary. */
  fresh?: boolean;
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

/** Result of one scoped, dual-format Device Library playlist synchronization. */
export type SyncLegacyDevicePlaylistResult = {
  schemaVersion: 2;
  format: "dual-device-playlist-sync";
  databasePath: string;
  targetDirectory: string;
  playlistId: string;
  playlistName: string;
  folderName: string;
  usbFolderId: number;
  usbPlaylistId: number;
  oneLibraryFolderId: number | null;
  oneLibraryPlaylistId: number | null;
  oneLibraryPath: string | null;
  tracks: number;
  audioFiles: number;
  analysisFiles: number;
  bytesCopied: number;
  backupPath: string | null;
  oneLibraryBackupPath: string | null;
  changed: boolean;
};

/**
 * Synchronize one playlist to both USB library formats without rebuilding unrelated rows.
 *
 * Fresh mode initializes an empty target. Existing mode preserves both databases. Audio and
 * rewritten ANLZ are staged once and shared by traditional Device Library and OneLibrary.
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
  const oneLibraryPath = join(targetDirectory, ONE_LIBRARY_DB);
  if (options.fresh) assertFreshTarget(targetDirectory);
  if (!options.fresh && !existsSync(oneLibraryPath))
    throw new Error(
      "Scoped dual-library sync requires exportLibrary.db; use --fresh on an empty stick",
    );
  const originalPdb = options.fresh ? new LegacyDevicePdbWriter().build() : await readFile(pdbPath);
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
    const marker = options.fresh
      ? ({ schemaVersion: 2, format: "dual-device-playlist-sync", records: [] } as const)
      : await readPlaylistMarker(markerPath);
    const prior = marker.records.find(
      (record) => record.databasePath === databasePath && record.playlistId === summary.id,
    );
    if (prior) {
      verifyPriorRecord(original, prior);
      verifyPriorOneLibrary(oneLibraryPath, prior);
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
    let oneLibraryFolderId: number | undefined;
    let oneLibraryPlaylistId: number | undefined;
    let oneLibraryContentIds: number[] | undefined;
    try {
      const trackIds: number[] = [];
      const oneLibraryTracks: OneLibraryExportTrack[] = [];
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
        const usbAnalysisDatPath = canonicalUsbAnalysisPath(analysisPath, track.contentId);
        const usbAnalysisDirectory = posix.dirname(usbAnalysisDatPath);
        writer.addTrack({
          id: pdbId,
          title: track.title ?? filename,
          artist: track.artist,
          key: track.key,
          filePath: usbAudioPath,
          filename,
          analyzePath: usbAnalysisDatPath,
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
        oneLibraryTracks.push({
          masterDbId: stringValue(content.get("MasterDBID")),
          masterContentId: track.contentId,
          title: track.title ?? filename,
          artist: track.artist,
          key: track.key,
          subtitle: stringValue(content.get("Subtitle")),
          bpmHundredths: track.bpm === null ? 0 : Math.round(track.bpm * 100),
          durationSeconds: track.durationSeconds,
          trackNumber: integerValue(content.get("TrackNo")),
          discNumber: integerValue(content.get("DiscNo")),
          comment: stringValue(content.get("Commnt")),
          rating: integerValue(content.get("Rating")),
          releaseYear: integerValue(content.get("ReleaseYear")),
          releaseDate: dateValue(content.get("ReleaseDate")),
          dateAdded: dateValue(content.get("StockDate")),
          fileName: filename,
          fileSize: audio.size,
          fileType: resolveFileType(track.fileType, filename),
          bitrate: integerValue(content.get("BitRate")),
          bitDepth: integerValue(content.get("BitDepth")),
          samplingRate: integerValue(content.get("SampleRate"), 44_100),
          isrc: stringValue(content.get("ISRC")),
          playCount: integerValue(content.get("DJPlayCount")),
          analysedBits: integerValue(content.get("Analysed"), 105),
          analysisDataUpdateCount: integerValue(content.get("AnalysisUpdated"), 2),
          informationUpdateCount: integerValue(content.get("TrackInfoUpdated"), 2),
          usbAudioPath,
          usbAnalysisPath: usbAnalysisDatPath,
        });

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
          const usbAnalysisPath = `${usbAnalysisDirectory}/ANLZ0000.${type}`;
          const staged = mediaPath(stagingRoot, usbAnalysisPath);
          await mkdir(dirname(staged), { recursive: true });
          const file = AnlzFile.parseFile(source);
          file.setPath(usbAudioPath);
          file.save(staged);
          AnlzFile.parseFile(staged);
          bytesCopied += (await stat(staged)).size;
          analysisFiles++;
          stagedInstalls.push({
            staged,
            target: mediaPath(targetDirectory, usbAnalysisPath),
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

      const stagedOneLibrary = join(stagingRoot, ONE_LIBRARY_DB);
      await mkdir(dirname(stagedOneLibrary), { recursive: true });
      if (!options.fresh) await copyFile(oneLibraryPath, stagedOneLibrary);
      const oneLibrary = writeOneLibraryPlaylist({
        create: options.fresh,
        folderName,
        generatedAt: now,
        path: stagedOneLibrary,
        playlistName: summary.name,
        tracks: oneLibraryTracks,
      });
      oneLibraryFolderId = oneLibrary.folderId;
      oneLibraryPlaylistId = oneLibrary.playlistId;
      oneLibraryContentIds = oneLibrary.contentIds;

      const timestamp = now.toISOString().replaceAll(/[-:.]/gu, "").replace("Z", "Z");
      const backupPath = options.fresh
        ? null
        : join(targetDirectory, "PIONEER", "rekordbox", `export.pdb.music-ts-backup-${timestamp}`);
      const oneLibraryBackupPath = options.fresh
        ? null
        : join(
            targetDirectory,
            "PIONEER",
            "rekordbox",
            `exportLibrary.db.music-ts-backup-${timestamp}`,
          );
      if (backupPath) await copyFile(pdbPath, backupPath);
      if (oneLibraryBackupPath) await copyFile(oneLibraryPath, oneLibraryBackupPath);
      const installed: string[] = [];
      let oneLibraryPublished = false;
      let pdbPublished = false;
      try {
        for (const install of stagedInstalls) {
          await mkdir(dirname(install.target), { recursive: true });
          await rename(install.staged, install.target);
          installed.push(install.target);
        }
        await mkdir(dirname(oneLibraryPath), { recursive: true });
        await rename(stagedOneLibrary, oneLibraryPath);
        oneLibraryPublished = true;
        await rename(stagedPdb, pdbPath);
        pdbPublished = true;

        const record: PlaylistSyncRecord = {
          databasePath,
          playlistId: summary.id,
          playlistName: summary.name,
          usbFolderId,
          usbPlaylistId,
          trackIds,
          oneLibraryFolderId,
          oneLibraryPlaylistId,
          oneLibraryContentIds,
          syncedAt: now.toISOString(),
        };
        verifyPriorRecord(inspectLegacyDevicePdb(await readFile(pdbPath)), record);
        verifyPriorOneLibrary(oneLibraryPath, record);
        await verifyInstalledMedia(
          targetDirectory,
          stagedInstalls.map(({ target }) => target),
        );
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
          backupPath: backupPath ?? undefined,
          oneLibraryBackupPath: oneLibraryBackupPath ?? undefined,
          changed: true,
        });
      } catch (error) {
        if (pdbPublished) await restorePublishedFile(pdbPath, backupPath);
        if (oneLibraryPublished) await restorePublishedFile(oneLibraryPath, oneLibraryBackupPath);
        await Promise.all(
          installed.map((path) => rm(path, { force: true }).catch(() => undefined)),
        );
        throw error;
      }
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
  oneLibraryBackupPath?: string;
  changed: boolean;
}): SyncLegacyDevicePlaylistResult {
  return {
    schemaVersion: 2,
    format: "dual-device-playlist-sync",
    databasePath: input.databasePath,
    targetDirectory: input.targetDirectory,
    playlistId: input.summary.id,
    playlistName: input.summary.name,
    folderName: input.folderName,
    usbFolderId: input.record.usbFolderId,
    usbPlaylistId: input.record.usbPlaylistId,
    oneLibraryFolderId: input.record.oneLibraryFolderId ?? null,
    oneLibraryPlaylistId: input.record.oneLibraryPlaylistId ?? null,
    oneLibraryPath: input.record.oneLibraryPlaylistId
      ? join(input.targetDirectory, ONE_LIBRARY_DB)
      : null,
    tracks: input.tracks,
    audioFiles: input.audioFiles ?? 0,
    analysisFiles: input.analysisFiles ?? 0,
    bytesCopied: input.bytesCopied ?? 0,
    backupPath: input.backupPath ?? null,
    oneLibraryBackupPath: input.oneLibraryBackupPath ?? null,
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

function verifyPriorOneLibrary(path: string, record: PlaylistSyncRecord): void {
  if (!record.oneLibraryFolderId || !record.oneLibraryPlaylistId || !record.oneLibraryContentIds)
    throw new Error(
      `USB sync receipt for '${record.playlistName}' predates OneLibrary; rebuild the stick with --fresh`,
    );
  const database = new DeviceLibraryPlus(path);
  try {
    const rows = database.executeSql<{ content_id: number }>(
      `SELECT pc.content_id
       FROM playlist_content pc
       JOIN playlist p ON p.playlist_id = pc.playlist_id
       WHERE p.playlist_id = ? AND p.playlist_id_parent = ?
       ORDER BY pc.sequenceNo`,
      [record.oneLibraryPlaylistId, record.oneLibraryFolderId],
    );
    if (
      !Array.isArray(rows) ||
      JSON.stringify(rows.map(({ content_id }) => content_id)) !==
        JSON.stringify(record.oneLibraryContentIds)
    )
      throw new Error(`USB sync receipt for '${record.playlistName}' no longer matches OneLibrary`);
  } finally {
    database.close();
  }
}

async function readPlaylistMarker(path: string): Promise<PlaylistSyncMarker> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<PlaylistSyncMarker>;
    if (
      ![1, 2].includes(value.schemaVersion ?? 0) ||
      !["legacy-device-playlist-sync", "dual-device-playlist-sync"].includes(value.format ?? "") ||
      !Array.isArray(value.records)
    )
      throw new TypeError(`Invalid scoped playlist sync marker '${path}'`);
    return value as PlaylistSyncMarker;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { schemaVersion: 2, format: "dual-device-playlist-sync", records: [] };
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

function canonicalUsbAnalysisPath(path: string, contentId: string): string {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    !normalized.startsWith("/PIONEER/USBANLZ/") ||
    posix.basename(normalized) !== "ANLZ0000.DAT" ||
    segments.includes(".") ||
    segments.includes("..")
  )
    throw new TypeError(`Track '${contentId}' has a non-canonical USB analysis path '${path}'`);
  return normalized;
}

function assertFreshTarget(targetDirectory: string): void {
  const managed = ["Contents", "PIONEER", PLAYLIST_MARKER, ".music-cdj-export.json"];
  const existing = managed.filter((name) => existsSync(join(targetDirectory, name)));
  if (existing.length)
    throw new Error(
      `--fresh requires an empty CDJ target; found ${existing.map((name) => `'${name}'`).join(", ")}`,
    );
}

function resolveFileType(value: number | null, filename: string): number {
  if (value && [1, 4, 5, 11, 12].includes(value)) return value;
  const inferred: Readonly<Record<string, number>> = {
    ".aif": 12,
    ".aiff": 12,
    ".flac": 5,
    ".m4a": 4,
    ".mp3": 1,
    ".wav": 11,
  };
  const fileType = inferred[extname(filename).toLowerCase()];
  if (!fileType) throw new TypeError(`Unsupported OneLibrary audio file '${filename}'`);
  return fileType;
}

async function verifyInstalledMedia(
  targetDirectory: string,
  paths: readonly string[],
): Promise<void> {
  for (const path of paths) {
    const installed = await stat(path);
    if (!installed.isFile()) throw new Error(`USB publication did not install '${path}'`);
    if (!/\/ANLZ\d{4}\.(?:DAT|EXT|2EX)$/u.test(path)) continue;
    const analysis = AnlzFile.parseFile(path);
    const audioPath = requiredString(analysis.get("PPTH"), `ANLZ '${path}' PPTH`);
    const audio = await stat(mediaPath(targetDirectory, audioPath));
    if (!audio.isFile()) throw new Error(`ANLZ '${path}' points to missing audio '${audioPath}'`);
  }
}

async function restorePublishedFile(path: string, backupPath: string | null): Promise<void> {
  if (backupPath) await copyFile(backupPath, path);
  else await rm(path, { force: true });
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
