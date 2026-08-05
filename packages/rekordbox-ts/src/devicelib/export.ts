import { randomUUID } from "node:crypto";
import { lstatSync, statSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, parse, posix, resolve, sep } from "node:path";

import { AnlzFile, getAnlzPaths } from "../anlz/index.js";
import { MasterDatabase, type PlaylistSummary } from "../masterdb/index.js";
import { legacyUsbAnalysisPath } from "./anlz-path.js";
import { inspectLegacyDevicePdb, LegacyDevicePdbWriter } from "./pdb.js";

const EXPORT_MARKER = ".music-cdj-export.json";
const EXPORT_RESULT_SCHEMA_VERSION = 1;
const EXPORT_MARKER_SCHEMA_VERSION = 2;
const SUPPORTED_FILE_TYPES = new Set([1, 4, 5, 11, 12]);
const FILE_TYPE_BY_EXTENSION: Readonly<Record<string, number>> = {
  ".aif": 12,
  ".aiff": 12,
  ".flac": 5,
  ".m4a": 4,
  ".mp3": 1,
  ".wav": 11,
};

type RawExportTrack = {
  album: unknown;
  analysisDataUpdateCount: unknown;
  analysisPath: unknown;
  artist: unknown;
  bitDepth: unknown;
  bitRate: unknown;
  colorId: unknown;
  comment: unknown;
  createdAt: unknown;
  discNumber: unknown;
  duration: unknown;
  fileName: unknown;
  fileSize: unknown;
  fileType: unknown;
  genre: unknown;
  id: unknown;
  informationUpdateCount: unknown;
  key: unknown;
  label: unknown;
  mixName: unknown;
  masterDbId: unknown;
  path: unknown;
  playCount: unknown;
  rating: unknown;
  releaseDate: unknown;
  releaseYear: unknown;
  sampleRate: unknown;
  stockDate: unknown;
  tempo: unknown;
  title: unknown;
  trackNumber: unknown;
};

type ExportTrackJob = {
  analysisSources: Partial<Record<"2EX" | "DAT" | "EXT", ExportSourceFingerprint>>;
  analysisPaths: Record<"2EX" | "DAT" | "EXT", string | undefined>;
  analysisTargetDirectory: string;
  analysisStagingDirectory: string;
  audioSource: ExportSourceFingerprint;
  audioPath: string;
  audioTargetPath: string;
  audioStagingPath: string;
  contentId: string;
  usbAudioPath: string;
};

/** One source file fingerprint used to avoid rewriting unchanged USB media. */
export type ExportSourceFingerprint = {
  path: string;
  size: number;
  mtimeNs: string;
};

/** Stable mapping between a master-library track and its legacy DeviceSQL media identity. */
export type LegacyDeviceTrackMapping = {
  contentId: string;
  pdbId: number;
  usbAudioPath: string;
  audio: ExportSourceFingerprint;
  analysis: Partial<
    Record<"2EX" | "DAT" | "EXT", ExportSourceFingerprint & { outputSize: number }>
  >;
};

/** A history already committed to the master library. */
export type LegacyDeviceHistoryReceipt = {
  fingerprint: string;
  generationId: string;
  historyId: number;
  historyName: string;
  importedAt: string;
  playlistId: string;
  playlistName: string;
  tracks: number;
};

/** Durable ownership, identity, and differential-sync state stored on the USB volume. */
export type LegacyDeviceExportMarker = {
  schemaVersion: 2;
  format: "legacy-device-library";
  mediaId: string;
  generationId: string;
  generatedAt: string;
  tracks: number;
  playlists: number;
  trackMap: LegacyDeviceTrackMapping[];
  importedHistories: LegacyDeviceHistoryReceipt[];
};

type LegacyDeviceExportMarkerV1 = {
  schemaVersion: 1;
  format: "legacy-device-library";
  generatedAt: string;
  tracks: number;
  playlists: number;
};

/** Options for compiling a Rekordbox master SQLite database onto mounted CDJ media. */
export type ExportLegacyDeviceLibraryOptions = {
  /** Open database instance. The caller retains ownership and must close it. */
  database?: MasterDatabase;
  /** Rekordbox `master.db`; defaults to the configured Rekordbox 6/7 database. */
  databasePath?: string;
  /** Optional SQLCipher key override for `databasePath`. */
  databaseKey?: string;
  /** Disable SQLCipher setup for an explicitly plain SQLite fixture or library. */
  databaseUnlock?: boolean;
  /** Mounted FAT/exFAT root that will contain `Contents/` and `PIONEER/`. */
  targetDirectory: string;
  /** Replace only files previously owned by this exporter. */
  replace?: boolean;
  /** Parallel audio-copy workers. */
  copyConcurrency?: number;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
  /** Deterministic clock override for tests and reproducible exports. */
  generatedAt?: Date;
};

/** Result of a complete SQLite-to-CDJ legacy Device Library export. */
export type LegacyDeviceLibraryExportResult = {
  schemaVersion: 1;
  format: "legacy-device-library";
  databasePath: string;
  targetDirectory: string;
  pdbPath: string;
  tracks: number;
  playlists: number;
  analysisFiles: number;
  bytesCopied: number;
  generatedAt: string;
  changed: boolean;
  tracksCopied: number;
  tracksReused: number;
  filesRemoved: number;
};

/** Internal reconciliation state supplied by the bidirectional sync operation. */
export type ReconcileLegacyDeviceLibraryOptions = ExportLegacyDeviceLibraryOptions & {
  /** Consume already-validated histories instead of refusing to overwrite them. */
  consumeHistories?: boolean;
  /** Receipts retained after histories are compiled out of the fresh Device Library. */
  importedHistories?: LegacyDeviceHistoryReceipt[];
  /** Advance the media generation after a recovered post-PDB/pre-marker interruption. */
  forceGeneration?: boolean;
};

/**
 * Compile `master.db` into the legacy `export.pdb` format expected by a CDJ-3000.
 *
 * SQLite remains authoritative. The target receives copied audio, rewritten ANLZ
 * files, materialized playlists, and one disposable `export.pdb`.
 */
export async function exportLegacyDeviceLibrary(
  options: ExportLegacyDeviceLibraryOptions,
): Promise<LegacyDeviceLibraryExportResult> {
  return reconcileLegacyDeviceLibrary(options);
}

/**
 * Reconcile a mounted legacy Device Library with stable track IDs and differential media writes.
 *
 * Normal callers should use {@link exportLegacyDeviceLibrary}. Bidirectional sync supplies
 * validated history receipts and explicitly consumes the old history rows.
 */
export async function reconcileLegacyDeviceLibrary(
  options: ReconcileLegacyDeviceLibraryOptions,
): Promise<LegacyDeviceLibraryExportResult> {
  if (options.database && options.databasePath)
    throw new TypeError("Pass either database or databasePath, not both");
  const concurrency = options.copyConcurrency ?? 4;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32)
    throw new RangeError("copyConcurrency must be an integer between 1 and 32");
  throwIfAborted(options.signal);

  const ownedDatabase = options.database
    ? undefined
    : new MasterDatabase({
        ...(options.databasePath ? { path: options.databasePath } : {}),
        ...(options.databaseKey ? { key: options.databaseKey } : {}),
        unlock: options.databaseUnlock ?? true,
        readonly: true,
      });
  const database = options.database ?? ownedDatabase!;
  try {
    return await exportOpenDatabase(database, {
      ...options,
      copyConcurrency: concurrency,
    });
  } finally {
    ownedDatabase?.close();
  }
}

async function exportOpenDatabase(
  database: MasterDatabase,
  options: ReconcileLegacyDeviceLibraryOptions & { copyConcurrency: number },
): Promise<LegacyDeviceLibraryExportResult> {
  if (!database.hasTable("djmdContent"))
    throw new TypeError(`SQLite database '${database.path}' has no djmdContent table`);
  const targetDirectory = await validateTargetDirectory(options.targetDirectory);
  const generatedPaths = exportPaths(targetDirectory);
  const conflicts = (
    await Promise.all(
      [generatedPaths.contents, generatedPaths.analysis, generatedPaths.pdb].map(async (path) => ({
        exists: await pathExists(path),
        path,
      })),
    )
  ).filter(({ exists }) => exists);
  const marker = await readExportMarker(generatedPaths.marker);
  if (conflicts.length && !options.replace)
    throw new Error(
      `Target already contains a CDJ export (${conflicts.map(({ path }) => path).join(", ")}); pass replace only for exporter-owned media`,
    );
  if (conflicts.length && options.replace && !marker)
    throw new Error(
      `Refusing to replace an unowned CDJ export; '${generatedPaths.marker}' is missing`,
    );

  const existingInspection =
    marker && (await pathExists(generatedPaths.pdb))
      ? inspectLegacyDevicePdb(await readFile(generatedPaths.pdb))
      : undefined;
  if (existingInspection?.histories.length && !options.consumeHistories)
    throw new Error(
      `USB contains ${String(existingInspection.histories.length)} unimported CDJ history item(s); run music usb sync before replacing it`,
    );

  const previous = marker?.schemaVersion === EXPORT_MARKER_SCHEMA_VERSION ? marker : undefined;
  const previousByContentId = new Map(
    previous?.trackMap.map((mapping) => [mapping.contentId, mapping]) ?? [],
  );
  validateTrackMappings(previous?.trackMap ?? []);
  let nextTrackId = Math.max(0, ...(previous?.trackMap.map(({ pdbId }) => pdbId) ?? []));
  const stagingDirectory = join(targetDirectory, `.music-cdj-export-staging-${randomUUID()}`);
  await mkdir(stagingDirectory);
  const stagingPaths = exportPaths(stagingDirectory);
  const writer = new LegacyDevicePdbWriter();
  const trackIds = new Map<string, number>();
  const trackMap: LegacyDeviceTrackMapping[] = [];
  const mappingByContentId = new Map<string, LegacyDeviceTrackMapping>();
  const installs: Array<{ staged: string; target: string }> = [];
  let pdbChanged = false;
  let bytesCopied = 0;
  let analysisFiles = 0;
  let tracksCopied = 0;
  let tracksReused = 0;
  try {
    const rows = readExportTracks(database);
    if (!rows.length)
      throw new Error(`SQLite database '${database.path}' contains no active tracks`);
    const jobs: ExportTrackJob[] = [];
    for (const row of rows) {
      throwIfAborted(options.signal);
      const contentId = requiredString(row.id, "track ID");
      const audioPath = requiredString(row.path, `track '${contentId}' audio path`);
      const audioSource = sourceFingerprint(audioPath, `Track '${contentId}' audio`);
      if (audioSource.size > 0xffff_ffff)
        throw new RangeError(`Track '${contentId}' exceeds the legacy 4 GiB file-size field`);
      const analysisPath = requiredString(
        row.analysisPath,
        `track '${contentId}' AnalysisDataPath`,
      );
      const analysisDirectory = resolveAnalysisDirectory(database, analysisPath);
      const sourceAnalysis = getAnlzPaths(analysisDirectory);
      if (!sourceAnalysis.DAT)
        throw new Error(`Track '${contentId}' has no ANLZ0000.DAT in '${analysisDirectory}'`);

      const prior = previousByContentId.get(contentId);
      const pdbId = prior?.pdbId ?? ++nextTrackId;
      const idHex = pdbId.toString(16).toUpperCase().padStart(8, "0");
      const filename = safeFilename(stringValue(row.fileName) ?? basename(audioPath), pdbId);
      const usbAudioPath =
        prior && extname(prior.usbAudioPath).toLowerCase() === extname(filename).toLowerCase()
          ? prior.usbAudioPath
          : `/Contents/${idHex}/${filename}`;
      const usbAnalysisDatPath = legacyUsbAnalysisPath(usbAudioPath);
      const usbAnalysisDirectory = posix.dirname(usbAnalysisDatPath);
      const analysisSources: ExportTrackJob["analysisSources"] = {};
      for (const type of ["DAT", "EXT", "2EX"] as const) {
        const path = sourceAnalysis[type];
        if (path) analysisSources[type] = sourceFingerprint(path, `Track '${contentId}' ${type}`);
      }
      const mapping: LegacyDeviceTrackMapping = {
        contentId,
        pdbId,
        usbAudioPath,
        audio: audioSource,
        analysis: {},
      };
      trackMap.push(mapping);
      mappingByContentId.set(contentId, mapping);
      const pdbTrackId = writer.addTrack({
        id: pdbId,
        title: stringValue(row.title) ?? filename,
        filePath: usbAudioPath,
        filename: posix.basename(usbAudioPath),
        artist: stringValue(row.artist),
        album: stringValue(row.album),
        genre: stringValue(row.genre),
        key: stringValue(row.key),
        label: stringValue(row.label),
        comment: stringValue(row.comment) ?? "",
        mixName: stringValue(row.mixName) ?? "",
        releaseDate: dateValue(row.releaseDate),
        analyzePath: usbAnalysisDatPath,
        dateAdded: dateValue(row.stockDate) || dateValue(row.createdAt),
        tempo: integerValue(row.tempo),
        duration: integerValue(row.duration),
        year: integerValue(row.releaseYear),
        bitrate: integerValue(row.bitRate),
        sampleRate: integerValue(row.sampleRate, 44_100),
        sampleDepth: integerValue(row.bitDepth, 16),
        fileSize: audioSource.size,
        trackNumber: integerValue(row.trackNumber),
        discNumber: integerValue(row.discNumber),
        playCount: Math.min(integerValue(row.playCount), 0xffff),
        rating: integerValue(row.rating),
        colorId: integerValue(row.colorId),
        fileType: supportedFileType(row.fileType, filename, contentId),
        masterContentId: integerValue(row.id),
        masterDbId: integerValue(row.masterDbId),
        analysisDataUpdateCount: integerValue(row.analysisDataUpdateCount, 2),
        informationUpdateCount: integerValue(row.informationUpdateCount, 2),
      });
      trackIds.set(contentId, pdbTrackId);
      jobs.push({
        analysisSources,
        analysisPaths: sourceAnalysis,
        analysisTargetDirectory: mediaPath(targetDirectory, usbAnalysisDirectory),
        analysisStagingDirectory: join(
          stagingDirectory,
          ...usbAnalysisDirectory.replace(/^\/+/, "").split("/"),
        ),
        audioSource,
        audioPath,
        audioTargetPath: mediaPath(targetDirectory, usbAudioPath),
        audioStagingPath: mediaPath(stagingDirectory, usbAudioPath),
        contentId,
        usbAudioPath,
      });
    }

    const playlistCount = appendPlaylists(database, writer, trackIds);
    await runBounded(jobs, options.copyConcurrency, async (job) => {
      throwIfAborted(options.signal);
      const prior = previousByContentId.get(job.contentId);
      if (
        prior &&
        prior.usbAudioPath === job.usbAudioPath &&
        sameSource(prior.audio, job.audioSource) &&
        (await reusableFile(job.audioTargetPath, job.audioSource.size))
      ) {
        tracksReused++;
      } else {
        await mkdir(dirname(job.audioStagingPath), { recursive: true });
        await copyFile(job.audioPath, job.audioStagingPath);
        bytesCopied += (await stat(job.audioStagingPath)).size;
        tracksCopied++;
        installs.push({ staged: job.audioStagingPath, target: job.audioTargetPath });
      }

      for (const type of ["DAT", "EXT", "2EX"] as const) {
        const source = job.analysisPaths[type];
        const fingerprint = job.analysisSources[type];
        if (!source || !fingerprint) continue;
        analysisFiles++;
        const target = join(job.analysisTargetDirectory, `ANLZ0000.${type}`);
        const staged = join(job.analysisStagingDirectory, `ANLZ0000.${type}`);
        const priorAnalysis = prior?.analysis[type];
        if (
          priorAnalysis &&
          sameSource(priorAnalysis, fingerprint) &&
          (await reusableFile(target, priorAnalysis.outputSize))
        ) {
          mappingByContentId.get(job.contentId)!.analysis[type] = priorAnalysis;
          continue;
        }
        await mkdir(job.analysisStagingDirectory, { recursive: true });
        const file = AnlzFile.parseFile(source);
        file.setPath(job.usbAudioPath);
        file.save(staged);
        AnlzFile.parseFile(staged);
        const outputSize = statSync(staged).size;
        mappingByContentId.get(job.contentId)!.analysis[type] = {
          ...fingerprint,
          outputSize,
        };
        bytesCopied += outputSize;
        installs.push({ staged, target });
      }
    });

    const pdb = writer.build();
    const inspection = inspectLegacyDevicePdb(pdb);
    if (inspection.tracks.length !== trackIds.size)
      throw new Error(
        `Generated export.pdb contains ${String(inspection.tracks.length)} tracks, expected ${String(trackIds.size)}`,
      );
    if (inspection.playlists.length !== playlistCount)
      throw new Error(
        `Generated export.pdb contains ${String(inspection.playlists.length)} playlists, expected ${String(playlistCount)}`,
      );
    if (!(await fileEquals(generatedPaths.pdb, pdb))) {
      pdbChanged = true;
      await mkdir(dirname(stagingPaths.pdb), { recursive: true });
      await writeFile(stagingPaths.pdb, pdb);
      installs.push({ staged: stagingPaths.pdb, target: generatedPaths.pdb });
    }

    const desiredPaths = desiredGeneratedFiles(targetDirectory, trackMap);
    const removals =
      marker?.schemaVersion === 1
        ? [generatedPaths.contents, generatedPaths.analysis]
        : previous
          ? previousGeneratedFiles(targetDirectory, previous.trackMap).filter(
              (path) => !desiredPaths.has(path),
            )
          : [];
    const existingRemovals: string[] = [];
    for (const path of removals) if (await pathExists(path)) existingRemovals.push(path);

    const proposedMarker: LegacyDeviceExportMarker = {
      schemaVersion: EXPORT_MARKER_SCHEMA_VERSION,
      format: "legacy-device-library",
      mediaId: previous?.mediaId ?? randomUUID(),
      generationId:
        !previous || pdbChanged || options.forceGeneration ? randomUUID() : previous.generationId,
      generatedAt: (options.generatedAt ?? new Date()).toISOString(),
      tracks: trackIds.size,
      playlists: playlistCount,
      trackMap,
      importedHistories: options.importedHistories ?? previous?.importedHistories ?? [],
    };
    const markerChanged = !sameMarkerState(previous, proposedMarker);
    const changed = installs.length > 0 || existingRemovals.length > 0 || markerChanged;
    const generatedAt = changed
      ? proposedMarker.generatedAt
      : (previous?.generatedAt ?? proposedMarker.generatedAt);
    const nextMarker = { ...proposedMarker, generatedAt };
    if (changed)
      await installReconciledExport(
        stagingDirectory,
        targetDirectory,
        nextMarker,
        installs,
        existingRemovals,
      );
    return {
      schemaVersion: EXPORT_RESULT_SCHEMA_VERSION,
      format: "legacy-device-library",
      databasePath: database.path,
      targetDirectory,
      pdbPath: generatedPaths.pdb,
      tracks: trackIds.size,
      playlists: playlistCount,
      analysisFiles,
      bytesCopied,
      generatedAt,
      changed,
      tracksCopied,
      tracksReused,
      filesRemoved: existingRemovals.length,
    };
  } finally {
    await rm(stagingDirectory, { force: true, recursive: true });
  }
}

function readExportTracks(database: MasterDatabase): RawExportTrack[] {
  const content = (column: string, fallback = "NULL") =>
    database.hasColumn("djmdContent", column) ? `content."${column}"` : fallback;
  const join = (
    table: string,
    alias: string,
    foreignKey: string,
  ): { expression: (column: string) => string; sql: string } => {
    if (
      !database.hasTable(table) ||
      !database.hasColumn("djmdContent", foreignKey) ||
      !database.hasColumn(table, "ID")
    )
      return { expression: () => "NULL", sql: "" };
    return {
      expression: (column) => (database.hasColumn(table, column) ? `${alias}."${column}"` : "NULL"),
      sql: `LEFT JOIN "${table}" ${alias} ON ${alias}."ID" = content."${foreignKey}"`,
    };
  };
  const artist = join("djmdArtist", "artist", "ArtistID");
  const album = join("djmdAlbum", "album", "AlbumID");
  const genre = join("djmdGenre", "genre", "GenreID");
  const key = join("djmdKey", "keyRow", "KeyID");
  const label = join("djmdLabel", "label", "LabelID");
  const active = database.hasColumn("djmdContent", "rb_local_deleted")
    ? `(content."rb_local_deleted" IS NULL OR content."rb_local_deleted" = 0)`
    : "1 = 1";
  return database.selectRawRows<RawExportTrack>(
    `SELECT
      ${content("ID")} AS id,
      ${content("FolderPath")} AS path,
      ${content("FileNameL")} AS fileName,
      ${content("Title")} AS title,
      ${artist.expression("Name")} AS artist,
      ${album.expression("Name")} AS album,
      ${genre.expression("Name")} AS genre,
      ${key.expression("ScaleName")} AS key,
      ${label.expression("Name")} AS label,
      ${content("Commnt")} AS comment,
      ${content("Subtitle")} AS mixName,
      ${content("MasterDBID")} AS masterDbId,
      ${content("AnalysisDataPath")} AS analysisPath,
      ${content("BPM")} AS tempo,
      ${content("Length")} AS duration,
      ${content("ReleaseYear")} AS releaseYear,
      ${content("BitRate")} AS bitRate,
      ${content("SampleRate")} AS sampleRate,
      ${content("BitDepth")} AS bitDepth,
      ${content("FileSize")} AS fileSize,
      ${content("FileType")} AS fileType,
      ${content("TrackNo")} AS trackNumber,
      ${content("DiscNo")} AS discNumber,
      ${content("DJPlayCount")} AS playCount,
      ${content("Rating")} AS rating,
      ${content("ColorID")} AS colorId,
      ${content("ReleaseDate")} AS releaseDate,
      ${content("StockDate")} AS stockDate,
      ${content("created_at")} AS createdAt,
      ${content("AnalysisUpdated")} AS analysisDataUpdateCount,
      ${content("TrackInfoUpdated")} AS informationUpdateCount
    FROM "djmdContent" content
    ${artist.sql}
    ${album.sql}
    ${genre.sql}
    ${key.sql}
    ${label.sql}
    WHERE ${active}
    ORDER BY CAST(content."ID" AS INTEGER), content."ID"`,
  );
}

function appendPlaylists(
  database: MasterDatabase,
  writer: LegacyDevicePdbWriter,
  trackIds: ReadonlyMap<string, number>,
): number {
  const summaries = database
    .listPlaylists()
    .sort(
      (left, right) =>
        left.sequence - right.sequence ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    );
  const byId = new Map(summaries.map((playlist) => [playlist.id, playlist]));
  const pending = [...summaries];
  const exportedIds = new Map<string, number>();
  while (pending.length) {
    let progress = false;
    for (let index = 0; index < pending.length; ) {
      const playlist = pending[index]!;
      const parentIsRoot = playlist.parentId === "root" || !byId.has(playlist.parentId);
      const parentId = parentIsRoot ? 0 : exportedIds.get(playlist.parentId);
      if (!parentIsRoot && parentId === undefined) {
        index++;
        continue;
      }
      const exportedId = writer.createPlaylist(playlist.name || "Untitled Playlist", {
        parentId,
        folder: playlist.type === "folder",
      });
      exportedIds.set(playlist.id, exportedId);
      if (playlist.type !== "folder")
        appendPlaylistTracks(database, writer, playlist, exportedId, trackIds);
      pending.splice(index, 1);
      progress = true;
    }
    if (!progress)
      throw new Error(
        `Playlist hierarchy contains a cycle: ${pending.map(({ id, name }) => `${name} (${id})`).join(", ")}`,
      );
  }
  return exportedIds.size;
}

function appendPlaylistTracks(
  database: MasterDatabase,
  writer: LegacyDevicePdbWriter,
  playlist: PlaylistSummary,
  exportedPlaylistId: number,
  trackIds: ReadonlyMap<string, number>,
): void {
  let rows;
  try {
    rows = database.getPlaylistTracks(playlist.id);
  } catch (error) {
    throw new Error(`Could not materialize playlist '${playlist.name}' (${playlist.id})`, {
      cause: error,
    });
  }
  for (const [index, row] of rows.entries()) {
    const trackId = trackIds.get(row.contentId);
    if (!trackId)
      throw new Error(`Playlist '${playlist.name}' references unexported track '${row.contentId}'`);
    writer.addToPlaylist(exportedPlaylistId, trackId, index + 1);
  }
}

function resolveAnalysisDirectory(database: MasterDatabase, analysisPath: string): string {
  const relative = analysisPath.replace(/^[/\\]+/u, "").replaceAll("\\", "/");
  return join(database.shareDirectory, dirname(relative));
}

function supportedFileType(value: unknown, filename: string, contentId: string): number {
  const extension = extname(filename).toLowerCase();
  const inferred = FILE_TYPE_BY_EXTENSION[extension];
  if (!inferred)
    throw new TypeError(
      `Track '${contentId}' uses unsupported '${extension || "(no extension)"}' audio`,
    );
  if (value === null || value === undefined || value === "") return inferred;
  const declared = Number(value);
  if (!Number.isSafeInteger(declared) || !SUPPORTED_FILE_TYPES.has(declared))
    throw new TypeError(
      `Track '${contentId}' has unsupported Rekordbox FileType '${String(value)}'`,
    );
  if (declared !== inferred)
    throw new TypeError(
      `Track '${contentId}' filename '${filename}' disagrees with Rekordbox FileType ${String(declared)}`,
    );
  return declared;
}

function requiredString(value: unknown, name: string): string {
  const result = stringValue(value);
  if (!result) throw new TypeError(`${name} is missing`);
  return result;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function integerValue(value: unknown, fallback = 0): number {
  const number =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && value.trim().length
        ? Number(value)
        : typeof value === "number"
          ? value
          : fallback;
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
}

function dateValue(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime()))
    return value.toISOString().slice(0, 10);
  const text = stringValue(value);
  const match = text?.match(/^\d{4}-\d{2}-\d{2}/u);
  return match?.[0] ?? "";
}

function safeFilename(value: string, trackId: number): string {
  const withoutControlCharacters = [...value]
    .map((character) => (character.codePointAt(0)! < 0x20 ? "_" : character))
    .join("");
  const sanitized = withoutControlCharacters
    .replaceAll(/[<>:"/\\|?*]/gu, "_")
    .replaceAll(/[. ]+$/gu, "")
    .slice(0, 180);
  return sanitized || `track-${String(trackId).padStart(8, "0")}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Export aborted", "AbortError");
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

function exportPaths(root: string) {
  return {
    analysis: join(root, "PIONEER", "USBANLZ"),
    contents: join(root, "Contents"),
    marker: join(root, EXPORT_MARKER),
    pdb: join(root, "PIONEER", "rekordbox", "export.pdb"),
  };
}

async function validateTargetDirectory(path: string): Promise<string> {
  const requested = resolve(path);
  await mkdir(requested, { recursive: true });
  const metadata = await lstat(requested);
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw new TypeError(`Export target '${requested}' must be a real directory`);
  const resolved = await realpath(requested);
  if (resolved === parse(resolved).root)
    throw new TypeError(`Refusing to use filesystem root '${resolved}' as an export target`);
  return resolved;
}

async function readExportMarker(
  path: string,
): Promise<LegacyDeviceExportMarker | LegacyDeviceExportMarkerV1 | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parseExportMarker(value, path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Read and validate this exporter's durable state from a mounted media root. */
export async function readLegacyDeviceExportMarker(
  targetDirectory: string,
): Promise<LegacyDeviceExportMarker | LegacyDeviceExportMarkerV1 | null> {
  return readExportMarker(join(resolve(targetDirectory), EXPORT_MARKER));
}

/**
 * Atomically checkpoint committed history receipts before replacing the PDB that contains them.
 *
 * This closes the database-commit/media-refresh crash window. The next sync can safely consume
 * the same history without incrementing play counts again.
 */
export async function checkpointLegacyDeviceHistoryReceipts(
  targetDirectory: string,
  expected: LegacyDeviceExportMarker,
  importedHistories: readonly LegacyDeviceHistoryReceipt[],
): Promise<LegacyDeviceExportMarker> {
  const root = resolve(targetDirectory);
  const path = join(root, EXPORT_MARKER);
  const current = await readExportMarker(path);
  if (
    !current ||
    current.schemaVersion !== EXPORT_MARKER_SCHEMA_VERSION ||
    current.mediaId !== expected.mediaId ||
    current.generationId !== expected.generationId
  )
    throw new Error("USB export marker changed while histories were being imported");
  const next: LegacyDeviceExportMarker = {
    ...current,
    importedHistories: [...importedHistories],
  };
  parseExportMarker(next, path);
  if (sameMarkerState(current, next)) return current;
  const temporary = join(root, `${EXPORT_MARKER}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    await syncDirectory(root);
    return next;
  } finally {
    await rm(temporary, { force: true });
  }
}

function parseExportMarker(
  value: unknown,
  path: string,
): LegacyDeviceExportMarker | LegacyDeviceExportMarkerV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`Invalid exporter ownership marker '${path}'`);
  const marker = value as {
    schemaVersion?: unknown;
    format?: unknown;
    mediaId?: unknown;
    generationId?: unknown;
    generatedAt?: unknown;
    tracks?: unknown;
    playlists?: unknown;
    trackMap?: unknown;
    importedHistories?: unknown;
  };
  if (
    marker.format !== "legacy-device-library" ||
    typeof marker.generatedAt !== "string" ||
    !Number.isSafeInteger(marker.tracks) ||
    !Number.isSafeInteger(marker.playlists)
  )
    throw new TypeError(`Invalid exporter ownership marker '${path}'`);
  if (marker.schemaVersion === 1) return marker as LegacyDeviceExportMarkerV1;
  if (
    marker.schemaVersion !== EXPORT_MARKER_SCHEMA_VERSION ||
    typeof marker.mediaId !== "string" ||
    !marker.mediaId.length ||
    typeof marker.generationId !== "string" ||
    !marker.generationId.length ||
    !Array.isArray(marker.trackMap) ||
    !Array.isArray(marker.importedHistories)
  )
    throw new TypeError(`Invalid exporter ownership marker '${path}'`);
  validateTrackMappings(marker.trackMap);
  for (const receipt of marker.importedHistories) {
    if (
      !receipt ||
      typeof receipt !== "object" ||
      typeof receipt.fingerprint !== "string" ||
      typeof receipt.generationId !== "string" ||
      !receipt.generationId.length ||
      !Number.isSafeInteger(receipt.historyId) ||
      typeof receipt.historyName !== "string" ||
      typeof receipt.importedAt !== "string" ||
      typeof receipt.playlistId !== "string" ||
      typeof receipt.playlistName !== "string" ||
      !Number.isSafeInteger(receipt.tracks)
    )
      throw new TypeError(`Invalid history receipt in exporter ownership marker '${path}'`);
  }
  return marker as LegacyDeviceExportMarker;
}

function validateTrackMappings(mappings: readonly LegacyDeviceTrackMapping[]): void {
  const contentIds = new Set<string>();
  const pdbIds = new Set<number>();
  const paths = new Set<string>();
  for (const mapping of mappings) {
    if (
      !mapping ||
      typeof mapping !== "object" ||
      typeof mapping.contentId !== "string" ||
      !mapping.contentId.length ||
      !Number.isSafeInteger(mapping.pdbId) ||
      mapping.pdbId < 1 ||
      mapping.pdbId > 0xffff_ffff ||
      typeof mapping.usbAudioPath !== "string" ||
      !/^\/Contents\/[0-9A-F]{8}\/[^/]+$/u.test(mapping.usbAudioPath) ||
      !validSourceFingerprint(mapping.audio) ||
      !mapping.analysis ||
      typeof mapping.analysis !== "object"
    )
      throw new TypeError("Invalid track mapping in exporter ownership marker");
    const pathId = Number.parseInt(mapping.usbAudioPath.split("/")[2]!, 16);
    if (pathId !== mapping.pdbId)
      throw new TypeError(
        `Track mapping '${mapping.contentId}' path does not match DeviceSQL ID ${String(mapping.pdbId)}`,
      );
    if (contentIds.has(mapping.contentId))
      throw new TypeError(
        `Duplicate content ID '${mapping.contentId}' in exporter ownership marker`,
      );
    if (pdbIds.has(mapping.pdbId))
      throw new TypeError(
        `Duplicate DeviceSQL track ID ${String(mapping.pdbId)} in exporter ownership marker`,
      );
    if (paths.has(mapping.usbAudioPath))
      throw new TypeError(
        `Duplicate media path '${mapping.usbAudioPath}' in exporter ownership marker`,
      );
    contentIds.add(mapping.contentId);
    pdbIds.add(mapping.pdbId);
    paths.add(mapping.usbAudioPath);
    for (const [type, fingerprint] of Object.entries(mapping.analysis)) {
      if (
        !["2EX", "DAT", "EXT"].includes(type) ||
        !validSourceFingerprint(fingerprint) ||
        !Number.isSafeInteger(fingerprint.outputSize) ||
        fingerprint.outputSize < 0
      )
        throw new TypeError(`Invalid ${type} analysis mapping for content '${mapping.contentId}'`);
    }
  }
}

function validSourceFingerprint(value: unknown): value is ExportSourceFingerprint {
  if (!value || typeof value !== "object") return false;
  const fingerprint = value as Partial<ExportSourceFingerprint>;
  return (
    typeof fingerprint.path === "string" &&
    fingerprint.path.length > 0 &&
    Number.isSafeInteger(fingerprint.size) &&
    (fingerprint.size ?? -1) >= 0 &&
    typeof fingerprint.mtimeNs === "string" &&
    /^\d+$/u.test(fingerprint.mtimeNs)
  );
}

function sourceFingerprint(path: string, label: string): ExportSourceFingerprint {
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isFile()) throw new TypeError(`${label} is not a regular file`);
  const size = Number(metadata.size);
  if (!Number.isSafeInteger(size) || size < 0)
    throw new RangeError(`${label} has an unsupported byte size`);
  return {
    path: resolve(path),
    size,
    mtimeNs: metadata.mtimeNs.toString(),
  };
}

function sameSource(left: ExportSourceFingerprint, right: ExportSourceFingerprint): boolean {
  return left.path === right.path && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

async function reusableFile(path: string, size: number): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return !metadata.isSymbolicLink() && metadata.isFile() && metadata.size === size;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function fileEquals(path: string, expected: Buffer): Promise<boolean> {
  try {
    const actual = await readFile(path);
    return actual.equals(expected);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function mediaPath(root: string, usbPath: string): string {
  if (!usbPath.startsWith("/")) throw new TypeError(`Media path '${usbPath}' is not absolute`);
  const normalizedRoot = resolve(root);
  const target = resolve(normalizedRoot, `.${usbPath}`);
  if (!target.startsWith(`${normalizedRoot}${sep}`))
    throw new TypeError(`Media path '${usbPath}' escapes '${normalizedRoot}'`);
  return target;
}

function analysisFilePath(
  root: string,
  mapping: LegacyDeviceTrackMapping,
  type: "2EX" | "DAT" | "EXT",
): string {
  return mediaPath(
    root,
    legacyUsbAnalysisPath(mapping.usbAudioPath).replace(/\.DAT$/u, `.${type}`),
  );
}

function obsoleteAnalysisFilePaths(
  root: string,
  mapping: LegacyDeviceTrackMapping,
  type: "2EX" | "DAT" | "EXT",
): string[] {
  const idHex = mapping.pdbId.toString(16).toUpperCase().padStart(8, "0");
  const syntheticGroup = `P${String(mapping.pdbId % 1000).padStart(3, "0")}`;
  const paths = [join(root, "PIONEER", "USBANLZ", syntheticGroup, idHex, `ANLZ0000.${type}`)];
  const sourceMarker = `${sep}PIONEER${sep}USBANLZ${sep}`;
  const sourcePath = mapping.analysis[type]?.path;
  const markerIndex = sourcePath?.lastIndexOf(sourceMarker) ?? -1;
  if (sourcePath && markerIndex >= 0) {
    const usbPath = sourcePath.slice(markerIndex).split(sep).join("/");
    paths.push(mediaPath(root, usbPath));
  }
  return paths;
}

function desiredGeneratedFiles(
  root: string,
  mappings: readonly LegacyDeviceTrackMapping[],
): Set<string> {
  const paths: string[] = [];
  for (const mapping of mappings) {
    paths.push(mediaPath(root, mapping.usbAudioPath));
    for (const type of Object.keys(mapping.analysis) as Array<"2EX" | "DAT" | "EXT">)
      paths.push(analysisFilePath(root, mapping, type));
  }
  return new Set(paths);
}

function previousGeneratedFiles(
  root: string,
  mappings: readonly LegacyDeviceTrackMapping[],
): string[] {
  const paths: string[] = [];
  for (const mapping of mappings) {
    paths.push(mediaPath(root, mapping.usbAudioPath));
    for (const type of Object.keys(mapping.analysis) as Array<"2EX" | "DAT" | "EXT">) {
      paths.push(analysisFilePath(root, mapping, type));
      paths.push(...obsoleteAnalysisFilePaths(root, mapping, type));
    }
  }
  return paths;
}

function sameMarkerState(
  previous: LegacyDeviceExportMarker | undefined,
  next: LegacyDeviceExportMarker,
): boolean {
  if (!previous) return false;
  const withoutTimestamp = ({ generatedAt: _, ...value }: LegacyDeviceExportMarker) => value;
  return JSON.stringify(withoutTimestamp(previous)) === JSON.stringify(withoutTimestamp(next));
}

async function installReconciledExport(
  stagingRoot: string,
  targetRoot: string,
  marker: LegacyDeviceExportMarker,
  pendingInstalls: readonly { staged: string; target: string }[],
  pendingRemovals: readonly string[],
): Promise<void> {
  const target = exportPaths(targetRoot);
  const rollbackRoot = join(stagingRoot, ".rollback");
  const stagedMarker = join(stagingRoot, EXPORT_MARKER);
  await mkdir(rollbackRoot, { recursive: true });
  await writeFile(stagedMarker, `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx" });
  const installs = [...pendingInstalls, { staged: stagedMarker, target: target.marker }];
  const removals = [...new Set(pendingRemovals.map((path) => resolve(path)))];
  const replaced: Array<{ target: string; rollbackPath: string }> = [];
  const installed: string[] = [];
  try {
    let rollbackIndex = 0;
    for (const path of removals) {
      assertOwnedTarget(targetRoot, path);
      if (!(await pathExists(path))) continue;
      const rollbackPath = join(rollbackRoot, String(rollbackIndex++));
      await rename(path, rollbackPath);
      replaced.push({ target: path, rollbackPath });
    }
    for (const { staged, target: destination } of installs) {
      assertOwnedTarget(targetRoot, destination);
      if (await pathExists(destination)) {
        const rollbackPath = join(rollbackRoot, String(rollbackIndex++));
        await rename(destination, rollbackPath);
        replaced.push({ target: destination, rollbackPath });
      }
      await mkdir(dirname(destination), { recursive: true });
      await rename(staged, destination);
      installed.push(destination);
    }
  } catch (error) {
    for (const path of installed.reverse()) await rm(path, { force: true, recursive: true });
    for (const { target: destination, rollbackPath } of replaced.reverse()) {
      if (await pathExists(rollbackPath)) {
        await mkdir(dirname(destination), { recursive: true });
        await rename(rollbackPath, destination);
      }
    }
    throw error;
  }
}

function assertOwnedTarget(root: string, target: string): void {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (
    normalizedTarget === normalizedRoot ||
    !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)
  )
    throw new TypeError(`Refusing to reconcile path outside media root: '${normalizedTarget}'`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(errorCode(error) ?? "")) throw error;
  } finally {
    await handle?.close();
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
