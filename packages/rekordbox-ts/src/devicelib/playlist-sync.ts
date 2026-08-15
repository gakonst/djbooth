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
import { DjmdContent, MasterDatabase } from "../masterdb/index.js";
import { legacyUsbAnalysisPath } from "./anlz-path.js";
import type { LegacyDeviceHistoryReceipt } from "./export.js";
import { inspectLegacyDevicePdb, LegacyDevicePdbWriter } from "./pdb.js";
import { importMappedLegacyDeviceHistories } from "./sync.js";

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
  contentIds?: string[];
  oneLibraryFolderId?: number;
  oneLibraryPlaylistId?: number;
  oneLibraryContentIds?: number[];
  syncedAt: string;
};

type PlaylistSyncMarker = {
  schemaVersion: 1 | 2 | 3;
  format: "legacy-device-playlist-sync" | "dual-device-playlist-sync";
  records: PlaylistSyncRecord[];
  mediaId?: string;
  generationId?: string;
  importedHistories?: LegacyDeviceHistoryReceipt[];
};

type HydratedPlaylistSyncMarker = PlaylistSyncMarker & {
  schemaVersion: 3;
  mediaId: string;
  generationId: string;
  importedHistories: LegacyDeviceHistoryReceipt[];
  records: Array<PlaylistSyncRecord & { contentIds: string[] }>;
};

/** Options for appending one master-library playlist to an existing Rekordbox USB export. */
export type SyncLegacyDevicePlaylistOptions = {
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
  changed: boolean;
};

/** Options for one filtered folder-level USB round trip. */
export type SyncLegacyDevicePlaylistFolderOptions = {
  /** Mounted FAT/exFAT CDJ media root. */
  targetDirectory: string;
  /** Exact host-library folder name whose direct playlist children should be synchronized. */
  folderName: string;
  /** Initialize an empty stick with traditional Device Library plus OneLibrary. */
  fresh?: boolean;
  /** Rekordbox `master.db`; defaults to the configured Rekordbox 6/7 database. */
  databasePath?: string;
  /** Optional SQLCipher key override. */
  databaseKey?: string;
  /** Disable SQLCipher setup for an explicitly plain SQLite library. */
  databaseUnlock?: boolean;
  /** Parallel unique-media copy workers. */
  copyConcurrency?: number;
  /** Observe bounded phase and item progress without affecting the sync. */
  onProgress?: (progress: SyncLegacyDevicePlaylistFolderProgress) => void;
  /** Deterministic clock override for tests. */
  now?: Date;
};

/** One machine-readable progress update for a filtered folder sync. */
export type SyncLegacyDevicePlaylistFolderProgress = {
  phase:
    | "prepare"
    | "inventory"
    | "history"
    | "plan"
    | "catalog"
    | "copy"
    | "publish"
    | "verify"
    | "complete";
  current?: number;
  total?: number;
  message: string;
};

/** Result of one filtered, batched, dual-format USB round trip. */
export type SyncLegacyDevicePlaylistFolderResult = {
  schemaVersion: 3;
  format: "dual-device-playlist-folder-sync";
  databasePath: string;
  targetDirectory: string;
  folderName: string;
  playlists: Array<{
    playlistId: string;
    playlistName: string;
    tracks: number;
    changed: boolean;
  }>;
  playlistsChanged: number;
  tracks: number;
  uniqueTracksAdded: number;
  audioFiles: number;
  analysisFiles: number;
  bytesCopied: number;
  historiesFound: number;
  historiesImported: number;
  historiesAlreadyImported: number;
  historyPlaylistsCreated: number;
  playCountIncrements: number;
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
  if (!options.fresh) checkpointOneLibrary(oneLibraryPath);
  const originalOneLibrary = options.fresh ? undefined : await readFile(oneLibraryPath);

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
        const usbAnalysisDatPath = legacyUsbAnalysisPath(usbAudioPath);
        const usbAnalysisDirectory = posix.dirname(usbAnalysisDatPath);
        writer.addTrack({
          id: pdbId,
          title: stringValue(track.title) ?? filename,
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
          masterContentId: integerValue(content.get("ID")),
          masterDbId: integerValue(content.get("MasterDBID")),
          analysisDataUpdateCount: integerValue(content.get("AnalysisUpdated"), 2),
          informationUpdateCount: integerValue(content.get("TrackInfoUpdated"), 2),
        });
        trackIds.push(pdbId);
        oneLibraryTracks.push({
          masterDbId: stringValue(content.get("MasterDBID")),
          masterContentId: track.contentId,
          title: stringValue(track.title) ?? filename,
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
        await removeOneLibrarySidecars(oneLibraryPath);
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
          changed: true,
        });
      } catch (error) {
        if (pdbPublished)
          await restorePublishedFile(pdbPath, options.fresh ? undefined : originalPdb);
        if (oneLibraryPublished) await restorePublishedFile(oneLibraryPath, originalOneLibrary);
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

/**
 * Import pending histories and synchronize every direct playlist in one host-library folder.
 *
 * The selected playlists are planned as one union, so shared tracks are assigned and copied once.
 * Both device catalogs are staged and published once, behind one pair of rollback snapshots.
 */
export async function syncLegacyDevicePlaylistFolder(
  options: SyncLegacyDevicePlaylistFolderOptions,
): Promise<SyncLegacyDevicePlaylistFolderResult> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("Sync clock is invalid");
  if (!options.folderName.trim()) throw new TypeError("Playlist folder name is required");
  const copyConcurrency = options.copyConcurrency ?? 4;
  if (!Number.isSafeInteger(copyConcurrency) || copyConcurrency < 1 || copyConcurrency > 32)
    throw new RangeError("Playlist-folder copy concurrency must be between 1 and 32");

  const targetDirectory = await realpath(resolve(options.targetDirectory));
  emitPlaylistFolderProgress(options.onProgress, {
    phase: "prepare",
    message: `Preparing '${targetDirectory}'`,
  });
  const pdbPath = join(targetDirectory, EXPORT_PDB);
  const oneLibraryPath = join(targetDirectory, ONE_LIBRARY_DB);
  const markerPath = join(targetDirectory, PLAYLIST_MARKER);
  if (options.fresh) assertFreshTarget(targetDirectory);
  if (!options.fresh && !existsSync(oneLibraryPath))
    throw new Error(
      "Filtered dual-library sync requires exportLibrary.db; use --fresh on an empty stick",
    );
  const originalPdb = options.fresh ? new LegacyDevicePdbWriter().build() : await readFile(pdbPath);
  const original = inspectLegacyDevicePdb(originalPdb);
  if (!options.fresh) checkpointOneLibrary(oneLibraryPath);
  const originalOneLibrary = options.fresh ? undefined : await readFile(oneLibraryPath);

  const database = new MasterDatabase({
    ...(options.databasePath ? { path: options.databasePath } : {}),
    ...(options.databaseKey ? { key: options.databaseKey } : {}),
    unlock: options.databaseUnlock ?? true,
    readonly: true,
  });
  try {
    const databasePath = await realpath(database.path);
    const library = database.listPlaylists();
    const folders = library.filter(
      ({ name, type }) => type === "folder" && name === options.folderName,
    );
    if (folders.length !== 1)
      throw new RangeError(
        folders.length
          ? `Playlist folder '${options.folderName}' is ambiguous`
          : `Playlist folder '${options.folderName}' was not found`,
      );
    const folder = folders[0]!;
    const summaries = library
      .filter(({ parentId, type }) => type === "playlist" && parentId === folder.id)
      .sort((left, right) => left.sequence - right.sequence || left.name.localeCompare(right.name));
    if (!summaries.length)
      throw new Error(`Playlist folder '${options.folderName}' contains no direct playlists`);
    emitPlaylistFolderProgress(options.onProgress, {
      phase: "inventory",
      current: summaries.length,
      total: summaries.length,
      message: `Found ${String(summaries.length)} playlists in '${options.folderName}'`,
    });

    const rawMarker = options.fresh
      ? ({
          schemaVersion: 2,
          format: "dual-device-playlist-sync",
          records: [],
        } satisfies PlaylistSyncMarker)
      : await readPlaylistMarker(markerPath);
    let marker = hydratePlaylistMarker(rawMarker, database, databasePath, original);
    const contentByPdbId = new Map<number, string>();
    for (const record of marker.records)
      for (const [index, pdbId] of record.trackIds.entries()) {
        const contentId = record.contentIds[index]!;
        const existing = contentByPdbId.get(pdbId);
        if (existing && existing !== contentId)
          throw new Error(`DeviceSQL track ${String(pdbId)} has conflicting scoped receipts`);
        contentByPdbId.set(pdbId, contentId);
      }

    let history = {
      historiesFound: original.histories.length,
      historiesImported: 0,
      historiesAlreadyImported: 0,
      playlistsCreated: [] as Array<{ playlistId: string }>,
      playCountIncrements: 0,
      receipts: marker.importedHistories,
    };
    if (original.histories.length) {
      await writePlaylistMarker(markerPath, marker);
      history = await importMappedLegacyDeviceHistories({
        databasePath,
        databaseKey: options.databaseKey,
        databaseUnlock: options.databaseUnlock,
        histories: original.histories,
        importedHistories: marker.importedHistories,
        mediaId: marker.mediaId,
        generationId: marker.generationId,
        now,
        trackMap: [...contentByPdbId].map(([pdbId, contentId]) => ({ pdbId, contentId })),
      });
      marker = { ...marker, importedHistories: history.receipts };
      await writePlaylistMarker(markerPath, marker);
    }
    emitPlaylistFolderProgress(options.onProgress, {
      phase: "history",
      current: history.historiesImported + history.historiesAlreadyImported,
      total: history.historiesFound,
      message: history.historiesFound
        ? `Reconciled ${String(history.historiesFound)} CDJ histories`
        : "No CDJ histories to import",
    });

    const priorByPlaylistId = new Map(marker.records.map((record) => [record.playlistId, record]));
    const selected = summaries.map((summary) => {
      const tracks = database.getPlaylistTracks(summary.id);
      if (!tracks.length) throw new Error(`Playlist '${summary.name}' contains no tracks`);
      const contentIds = tracks.map(({ contentId }) => contentId);
      const prior = priorByPlaylistId.get(summary.id);
      if (prior) {
        verifyPriorRecord(original, prior);
        verifyPriorOneLibrary(oneLibraryPath, prior);
        if (JSON.stringify(prior.contentIds) !== JSON.stringify(contentIds))
          throw new Error(
            `Host playlist '${summary.name}' changed after its scoped USB receipt; rebuild with --fresh`,
          );
      }
      return { summary, tracks, contentIds, prior };
    });
    const pending = selected.filter(({ prior }) => !prior);
    emitPlaylistFolderProgress(options.onProgress, {
      phase: "plan",
      current: selected.length - pending.length,
      total: selected.length,
      message: `${String(pending.length)} playlists require synchronization`,
    });
    if (!pending.length && !original.histories.length) {
      await writePlaylistMarker(markerPath, marker);
      emitPlaylistFolderProgress(options.onProgress, {
        phase: "complete",
        current: selected.length,
        total: selected.length,
        message: "USB folder is already synchronized",
      });
      return playlistFolderResult({
        databasePath,
        targetDirectory,
        folderName: options.folderName,
        selected,
        history,
      });
    }

    const existingFolder = original.playlists.find(
      (playlist) => playlist.parentId === 0 && playlist.name === options.folderName,
    );
    if (existingFolder && !existingFolder.folder)
      throw new Error(`USB root item '${options.folderName}' exists but is not a folder`);
    for (const { summary } of pending)
      if (
        existingFolder &&
        original.playlists.some(
          (playlist) => playlist.parentId === existingFolder.id && playlist.name === summary.name,
        )
      )
        throw new Error(
          `USB playlist '${options.folderName} / ${summary.name}' exists without a scoped sync receipt`,
        );

    const writer = new LegacyDevicePdbWriter(originalPdb);
    if (original.histories.length) writer.clearHistories();
    let nextTrackId = Math.max(0, ...original.tracks.map(({ id }) => id));
    const trackByPdbId = new Map(original.tracks.map((track) => [track.id, track]));
    const mediaByContentId = new Map<
      string,
      { pdbId: number; usbAudioPath: string; usbAnalysisPath: string }
    >();
    for (const [pdbId, contentId] of contentByPdbId) {
      const track = trackByPdbId.get(pdbId);
      if (!track)
        throw new Error(`Scoped receipt references missing DeviceSQL track ${String(pdbId)}`);
      mediaByContentId.set(contentId, {
        pdbId,
        usbAudioPath: track.filePath,
        usbAnalysisPath: track.analyzePath,
      });
    }

    const stagingRoot = join(targetDirectory, `.music-cdj-playlist-staging-${randomUUID()}`);
    await mkdir(stagingRoot);
    const stagedInstalls: Array<{ staged: string; target: string }> = [];
    const mediaJobs: Array<() => Promise<void>> = [];
    let bytesCopied = 0;
    let analysisFiles = 0;
    let audioFiles = 0;
    let uniqueTracksAdded = 0;
    const queueMediaCopy = (
      audioPath: string,
      audioSize: number,
      sourceAnalysis: ReturnType<typeof getAnlzPaths>,
      usbAudioPath: string,
      usbAnalysisPath: string,
    ) => {
      mediaJobs.push(async () => {
        const targetAudio = mediaPath(targetDirectory, usbAudioPath);
        const stagedAudio = mediaPath(stagingRoot, usbAudioPath);
        await mkdir(dirname(stagedAudio), { recursive: true });
        await copyFile(audioPath, stagedAudio);
        bytesCopied += audioSize;
        audioFiles++;
        stagedInstalls.push({ staged: stagedAudio, target: targetAudio });
        const usbAnalysisDirectory = posix.dirname(usbAnalysisPath);
        for (const type of ["DAT", "EXT", "2EX"] as const) {
          const source = sourceAnalysis[type];
          if (!source) continue;
          const targetPath = `${usbAnalysisDirectory}/ANLZ0000.${type}`;
          const target = mediaPath(targetDirectory, targetPath);
          const staged = mediaPath(stagingRoot, targetPath);
          await mkdir(dirname(staged), { recursive: true });
          const file = AnlzFile.parseFile(source);
          file.setPath(usbAudioPath);
          file.save(staged);
          AnlzFile.parseFile(staged);
          bytesCopied += (await stat(staged)).size;
          analysisFiles++;
          stagedInstalls.push({ staged, target });
        }
      });
    };
    const usbFolderId =
      existingFolder?.id ?? writer.createPlaylist(options.folderName, { folder: true });
    const prepared: Array<{
      item: (typeof pending)[number];
      trackIds: number[];
      oneLibraryTracks: OneLibraryExportTrack[];
      usbPlaylistId: number;
    }> = [];
    try {
      for (const item of pending) {
        const trackIds: number[] = [];
        const oneLibraryTracks: OneLibraryExportTrack[] = [];
        for (const track of item.tracks) {
          const content = database.query(DjmdContent).where({ ID: track.contentId }).one();
          const audioPath = requiredString(track.path, `Track '${track.contentId}' audio path`);
          const audio = await stat(audioPath);
          if (!audio.isFile()) throw new Error(`Track '${track.contentId}' audio is not a file`);
          let media = mediaByContentId.get(track.contentId);
          if (!media) {
            const pdbId = ++nextTrackId;
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
            const sourceAnalysis = getAnlzPaths(resolveAnalysisDirectory(database, analysisPath));
            if (!sourceAnalysis.DAT)
              throw new Error(`Track '${track.contentId}' has no ANLZ0000.DAT`);
            const usbAnalysisPath = legacyUsbAnalysisPath(usbAudioPath);
            writer.addTrack({
              id: pdbId,
              title: stringValue(track.title) ?? filename,
              artist: track.artist,
              key: track.key,
              filePath: usbAudioPath,
              filename,
              analyzePath: usbAnalysisPath,
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
              masterContentId: integerValue(content.get("ID")),
              masterDbId: integerValue(content.get("MasterDBID")),
              analysisDataUpdateCount: integerValue(content.get("AnalysisUpdated"), 2),
              informationUpdateCount: integerValue(content.get("TrackInfoUpdated"), 2),
            });
            media = { pdbId, usbAudioPath, usbAnalysisPath };
            mediaByContentId.set(track.contentId, media);
            uniqueTracksAdded++;
            queueMediaCopy(audioPath, audio.size, sourceAnalysis, usbAudioPath, usbAnalysisPath);
          }
          trackIds.push(media.pdbId);
          oneLibraryTracks.push(
            oneLibraryTrack(content, track, audio.size, media.usbAudioPath, media.usbAnalysisPath),
          );
        }
        const usbPlaylistId = writer.createPlaylist(item.summary.name, { parentId: usbFolderId });
        for (const [index, trackId] of trackIds.entries())
          writer.addToPlaylist(usbPlaylistId, trackId, index + 1);
        prepared.push({ item, trackIds, oneLibraryTracks, usbPlaylistId });
      }

      const nextPdb = writer.build();
      const nextInspection = inspectLegacyDevicePdb(nextPdb);
      if (nextInspection.histories.length)
        throw new Error("Filtered USB sync failed to consume imported CDJ histories");
      for (const item of prepared)
        verifyAppend(original, nextInspection, usbFolderId, item.usbPlaylistId, item.trackIds);
      const stagedPdb = join(stagingRoot, EXPORT_PDB);
      await mkdir(dirname(stagedPdb), { recursive: true });
      await writeFile(stagedPdb, nextPdb);

      const stagedOneLibrary = join(stagingRoot, ONE_LIBRARY_DB);
      await mkdir(dirname(stagedOneLibrary), { recursive: true });
      if (!options.fresh) await copyFile(oneLibraryPath, stagedOneLibrary);
      let createOneLibrary = options.fresh ?? false;
      const nextRecords = [...marker.records];
      for (const [index, item] of prepared.entries()) {
        emitPlaylistFolderProgress(options.onProgress, {
          phase: "catalog",
          current: index,
          total: prepared.length,
          message: `Writing OneLibrary playlist '${item.item.summary.name}'`,
        });
        const oneLibrary = writeOneLibraryPlaylist({
          create: createOneLibrary,
          folderName: options.folderName,
          generatedAt: now,
          path: stagedOneLibrary,
          playlistName: item.item.summary.name,
          tracks: item.oneLibraryTracks,
        });
        createOneLibrary = false;
        nextRecords.push({
          databasePath,
          playlistId: item.item.summary.id,
          playlistName: item.item.summary.name,
          usbFolderId,
          usbPlaylistId: item.usbPlaylistId,
          trackIds: item.trackIds,
          contentIds: item.item.contentIds,
          oneLibraryFolderId: oneLibrary.folderId,
          oneLibraryPlaylistId: oneLibrary.playlistId,
          oneLibraryContentIds: oneLibrary.contentIds,
          syncedAt: now.toISOString(),
        });
        emitPlaylistFolderProgress(options.onProgress, {
          phase: "catalog",
          current: index + 1,
          total: prepared.length,
          message: `Wrote OneLibrary playlist '${item.item.summary.name}'`,
        });
      }
      let completedMediaJobs = 0;
      emitPlaylistFolderProgress(options.onProgress, {
        phase: "copy",
        current: 0,
        total: mediaJobs.length,
        message: `Copying ${String(mediaJobs.length)} unique tracks and analysis artifacts`,
      });
      await runBounded(mediaJobs, copyConcurrency, async (job) => {
        await job();
        completedMediaJobs++;
        emitPlaylistFolderProgress(options.onProgress, {
          phase: "copy",
          current: completedMediaJobs,
          total: mediaJobs.length,
          message: `Copied ${String(completedMediaJobs)} of ${String(mediaJobs.length)} unique tracks`,
        });
      });

      const installed: string[] = [];
      let oneLibraryPublished = false;
      let pdbPublished = false;
      try {
        emitPlaylistFolderProgress(options.onProgress, {
          phase: "publish",
          current: 0,
          total: stagedInstalls.length + 2,
          message: "Publishing staged media and both Rekordbox catalogs",
        });
        for (const install of stagedInstalls) {
          await mkdir(dirname(install.target), { recursive: true });
          await rename(install.staged, install.target);
          installed.push(install.target);
        }
        await mkdir(dirname(oneLibraryPath), { recursive: true });
        await removeOneLibrarySidecars(oneLibraryPath);
        await rename(stagedOneLibrary, oneLibraryPath);
        oneLibraryPublished = true;
        await rename(stagedPdb, pdbPath);
        pdbPublished = true;
        const publishedMarker: HydratedPlaylistSyncMarker = {
          ...marker,
          generationId: randomUUID(),
          records: nextRecords,
        };
        for (const [index, record] of nextRecords.entries()) {
          verifyPriorRecord(inspectLegacyDevicePdb(await readFile(pdbPath)), record);
          verifyPriorOneLibrary(oneLibraryPath, record);
          emitPlaylistFolderProgress(options.onProgress, {
            phase: "verify",
            current: index + 1,
            total: nextRecords.length,
            message: `Verified playlist '${record.playlistName}'`,
          });
        }
        await verifyInstalledMedia(
          targetDirectory,
          stagedInstalls.map(({ target }) => target),
        );
        await writePlaylistMarker(markerPath, publishedMarker);
        emitPlaylistFolderProgress(options.onProgress, {
          phase: "complete",
          current: selected.length,
          total: selected.length,
          message: `Synchronized ${String(selected.length)} playlists`,
        });
        return playlistFolderResult({
          databasePath,
          targetDirectory,
          folderName: options.folderName,
          selected,
          history,
          bytesCopied,
          analysisFiles,
          audioFiles,
          uniqueTracksAdded,
        });
      } catch (error) {
        if (pdbPublished)
          await restorePublishedFile(pdbPath, options.fresh ? undefined : originalPdb);
        if (oneLibraryPublished) await restorePublishedFile(oneLibraryPath, originalOneLibrary);
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

function emitPlaylistFolderProgress(
  observer: SyncLegacyDevicePlaylistFolderOptions["onProgress"],
  progress: SyncLegacyDevicePlaylistFolderProgress,
): void {
  try {
    observer?.(progress);
  } catch {
    // Progress observers are diagnostic and must never interrupt USB publication.
  }
}

function hydratePlaylistMarker(
  marker: PlaylistSyncMarker,
  database: MasterDatabase,
  databasePath: string,
  inspection: ReturnType<typeof inspectLegacyDevicePdb>,
): HydratedPlaylistSyncMarker {
  const activePlaylistIds = new Set(
    database
      .listPlaylists()
      .filter(({ type }) => type !== "folder")
      .map(({ id }) => id),
  );
  const records = marker.records.flatMap((record) => {
    if (record.databasePath !== databasePath)
      throw new Error(
        `Scoped USB receipt belongs to '${record.databasePath}', not '${databasePath}'`,
      );
    verifyPriorRecord(inspection, record);
    if (!activePlaylistIds.has(record.playlistId)) {
      if (!record.contentIds) return [];
      if (record.contentIds.length !== record.trackIds.length)
        throw new Error(`Scoped USB receipt for '${record.playlistName}' has no stable track map`);
      return [{ ...record, contentIds: record.contentIds }];
    }
    const current = database.getPlaylistTracks(record.playlistId);
    const contentIds = record.contentIds ?? current.map(({ contentId }) => contentId);
    if (contentIds.length !== record.trackIds.length)
      throw new Error(`Scoped USB receipt for '${record.playlistName}' has no stable track map`);
    if (record.contentIds) {
      const currentIds = current.map(({ contentId }) => contentId);
      if (JSON.stringify(currentIds) !== JSON.stringify(record.contentIds))
        return [{ ...record, contentIds: record.contentIds }];
    } else {
      for (const [index, pdbId] of record.trackIds.entries()) {
        const deviceTrack = inspection.tracks.find(({ id }) => id === pdbId);
        const hostTrack = current[index];
        if (!deviceTrack || !hostTrack || deviceTrack.title !== hostTrack.title)
          throw new Error(
            `Legacy scoped receipt for '${record.playlistName}' cannot be safely migrated`,
          );
      }
    }
    return [{ ...record, contentIds }];
  });
  return {
    ...marker,
    schemaVersion: 3,
    format: "dual-device-playlist-sync",
    mediaId: marker.mediaId ?? randomUUID(),
    generationId: marker.generationId ?? randomUUID(),
    importedHistories: marker.importedHistories ?? [],
    records,
  };
}

function oneLibraryTrack(
  content: DjmdContent,
  track: ReturnType<MasterDatabase["getPlaylistTracks"]>[number],
  fileSize: number,
  usbAudioPath: string,
  usbAnalysisPath: string,
): OneLibraryExportTrack {
  const filename = stringValue(content.get("FileNameL")) ?? basename(usbAudioPath);
  return {
    masterDbId: stringValue(content.get("MasterDBID")),
    masterContentId: track.contentId,
    title: stringValue(track.title) ?? filename,
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
    fileSize,
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
    usbAnalysisPath,
  };
}

function playlistFolderResult(input: {
  databasePath: string;
  targetDirectory: string;
  folderName: string;
  selected: ReadonlyArray<{
    summary: { id: string; name: string };
    tracks: readonly unknown[];
    prior: PlaylistSyncRecord | undefined;
  }>;
  history: {
    historiesFound: number;
    historiesImported: number;
    historiesAlreadyImported: number;
    playlistsCreated: ReadonlyArray<unknown>;
    playCountIncrements: number;
  };
  uniqueTracksAdded?: number;
  audioFiles?: number;
  analysisFiles?: number;
  bytesCopied?: number;
}): SyncLegacyDevicePlaylistFolderResult {
  const playlists = input.selected.map(({ summary, tracks, prior }) => ({
    playlistId: summary.id,
    playlistName: summary.name,
    tracks: tracks.length,
    changed: !prior,
  }));
  const playlistsChanged = playlists.filter(({ changed }) => changed).length;
  const uniqueTracksAdded = input.uniqueTracksAdded ?? 0;
  return {
    schemaVersion: 3,
    format: "dual-device-playlist-folder-sync",
    databasePath: input.databasePath,
    targetDirectory: input.targetDirectory,
    folderName: input.folderName,
    playlists,
    playlistsChanged,
    tracks: playlists.reduce((sum, playlist) => sum + playlist.tracks, 0),
    uniqueTracksAdded,
    audioFiles: input.audioFiles ?? uniqueTracksAdded,
    analysisFiles: input.analysisFiles ?? 0,
    bytesCopied: input.bytesCopied ?? 0,
    historiesFound: input.history.historiesFound,
    historiesImported: input.history.historiesImported,
    historiesAlreadyImported: input.history.historiesAlreadyImported,
    historyPlaylistsCreated: input.history.playlistsCreated.length,
    playCountIncrements: input.history.playCountIncrements,
    changed:
      playlistsChanged > 0 ||
      input.history.historiesFound > 0 ||
      (input.audioFiles ?? 0) > 0 ||
      (input.analysisFiles ?? 0) > 0,
  };
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

function checkpointOneLibrary(path: string): void {
  const database = new DeviceLibraryPlus(path, { readonly: false });
  try {
    const result = database.connection?.pragma("wal_checkpoint(TRUNCATE)") as
      | Array<{ busy?: number }>
      | undefined;
    if (result?.some(({ busy }) => busy))
      throw new Error(`OneLibrary WAL checkpoint is busy for '${path}'`);
    if (!database.hasTable("playlist"))
      throw new Error(`OneLibrary checkpoint for '${path}' has no playlist table`);
  } finally {
    database.close();
  }
}

async function removeOneLibrarySidecars(path: string): Promise<void> {
  await Promise.all([rm(`${path}-wal`, { force: true }), rm(`${path}-shm`, { force: true })]);
}

async function readPlaylistMarker(path: string): Promise<PlaylistSyncMarker> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<PlaylistSyncMarker>;
    if (
      ![1, 2, 3].includes(value.schemaVersion ?? 0) ||
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

async function restorePublishedFile(path: string, original: Uint8Array | undefined): Promise<void> {
  if (original) await writeFile(path, original);
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

async function runBounded<item>(
  items: readonly item[],
  concurrency: number,
  run: (item: item) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        await run(items[index]!);
      }
    }),
  );
}
