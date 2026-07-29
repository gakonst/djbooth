import { randomUUID } from "node:crypto";
import { lstatSync, statSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, parse, resolve } from "node:path";

import { AnlzFile, getAnlzPaths } from "../anlz/index.js";
import { MasterDatabase, type PlaylistSummary } from "../masterdb/index.js";
import { inspectLegacyDevicePdb, LegacyDevicePdbWriter } from "./pdb.js";

const EXPORT_MARKER = ".music-cdj-export.json";
const EXPORT_SCHEMA_VERSION = 1;
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
  key: unknown;
  label: unknown;
  mixName: unknown;
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
  analysisPaths: Record<"2EX" | "DAT" | "EXT", string | undefined>;
  analysisTargetDirectory: string;
  audioPath: string;
  audioTargetPath: string;
  contentId: string;
  usbAudioPath: string;
};

type ExportMarker = {
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
  options: ExportLegacyDeviceLibraryOptions & { copyConcurrency: number },
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

  const stagingDirectory = join(targetDirectory, `.music-cdj-export-staging-${randomUUID()}`);
  await mkdir(stagingDirectory);
  const stagingPaths = exportPaths(stagingDirectory);
  const writer = new LegacyDevicePdbWriter();
  const trackIds = new Map<string, number>();
  let bytesCopied = 0;
  let analysisFiles = 0;
  try {
    const rows = readExportTracks(database);
    if (!rows.length)
      throw new Error(`SQLite database '${database.path}' contains no active tracks`);
    const jobs: ExportTrackJob[] = [];
    for (const row of rows) {
      throwIfAborted(options.signal);
      const contentId = requiredString(row.id, "track ID");
      const audioPath = requiredString(row.path, `track '${contentId}' audio path`);
      const audio = lstatSync(audioPath);
      if (!audio.isFile()) throw new TypeError(`Track '${contentId}' audio is not a regular file`);
      if (audio.size > 0xffff_ffff)
        throw new RangeError(`Track '${contentId}' exceeds the legacy 4 GiB file-size field`);
      const analysisPath = requiredString(
        row.analysisPath,
        `track '${contentId}' AnalysisDataPath`,
      );
      const analysisDirectory = resolveAnalysisDirectory(database, analysisPath);
      const sourceAnalysis = getAnlzPaths(analysisDirectory);
      if (!sourceAnalysis.DAT)
        throw new Error(`Track '${contentId}' has no ANLZ0000.DAT in '${analysisDirectory}'`);

      const nextTrackId = trackIds.size + 1;
      const filename = safeFilename(stringValue(row.fileName) ?? basename(audioPath), nextTrackId);
      const idHex = nextTrackId.toString(16).toUpperCase().padStart(8, "0");
      const usbAudioPath = `/Contents/${idHex}/${filename}`;
      const analysisGroup = `P${String(nextTrackId % 1000).padStart(3, "0")}`;
      const usbAnalysisDirectory = `/PIONEER/USBANLZ/${analysisGroup}/${idHex}`;
      const pdbTrackId = writer.addTrack({
        title: stringValue(row.title) ?? filename,
        filePath: usbAudioPath,
        filename,
        artist: stringValue(row.artist),
        album: stringValue(row.album),
        genre: stringValue(row.genre),
        key: stringValue(row.key),
        label: stringValue(row.label),
        comment: stringValue(row.comment) ?? "",
        mixName: stringValue(row.mixName) ?? "",
        releaseDate: dateValue(row.releaseDate),
        analyzePath: `${usbAnalysisDirectory}/ANLZ0000.DAT`,
        dateAdded: dateValue(row.stockDate) || dateValue(row.createdAt),
        tempo: integerValue(row.tempo),
        duration: integerValue(row.duration),
        year: integerValue(row.releaseYear),
        bitrate: integerValue(row.bitRate),
        sampleRate: integerValue(row.sampleRate, 44_100),
        sampleDepth: integerValue(row.bitDepth, 16),
        fileSize: audio.size,
        trackNumber: integerValue(row.trackNumber),
        discNumber: integerValue(row.discNumber),
        playCount: integerValue(row.playCount),
        rating: integerValue(row.rating),
        colorId: integerValue(row.colorId),
        fileType: supportedFileType(row.fileType, filename, contentId),
      });
      trackIds.set(contentId, pdbTrackId);
      jobs.push({
        analysisPaths: sourceAnalysis,
        analysisTargetDirectory: join(stagingDirectory, "PIONEER", "USBANLZ", analysisGroup, idHex),
        audioPath,
        audioTargetPath: join(stagingDirectory, "Contents", idHex, filename),
        contentId,
        usbAudioPath,
      });
    }

    const playlistCount = appendPlaylists(database, writer, trackIds);
    await runBounded(jobs, options.copyConcurrency, async (job) => {
      throwIfAborted(options.signal);
      await mkdir(dirname(job.audioTargetPath), { recursive: true });
      await copyFile(job.audioPath, job.audioTargetPath);
      bytesCopied += (await stat(job.audioTargetPath)).size;
      await mkdir(job.analysisTargetDirectory, { recursive: true });
      for (const type of ["DAT", "EXT", "2EX"] as const) {
        const source = job.analysisPaths[type];
        if (!source) continue;
        const file = AnlzFile.parseFile(source);
        file.setPath(job.usbAudioPath);
        const target = join(job.analysisTargetDirectory, `ANLZ0000.${type}`);
        file.save(target);
        AnlzFile.parseFile(target);
        bytesCopied += statSync(target).size;
        analysisFiles++;
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
    await mkdir(dirname(stagingPaths.pdb), { recursive: true });
    await writeFile(stagingPaths.pdb, pdb);
    await mkdir(stagingPaths.contents, { recursive: true });
    await mkdir(stagingPaths.analysis, { recursive: true });

    const generatedAt = (options.generatedAt ?? new Date()).toISOString();
    const nextMarker: ExportMarker = {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      format: "legacy-device-library",
      generatedAt,
      tracks: trackIds.size,
      playlists: playlistCount,
    };
    await installStagedExport(stagingDirectory, targetDirectory, nextMarker);
    return {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      format: "legacy-device-library",
      databasePath: database.path,
      targetDirectory,
      pdbPath: generatedPaths.pdb,
      tracks: trackIds.size,
      playlists: playlistCount,
      analysisFiles,
      bytesCopied,
      generatedAt,
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
      ${content("created_at")} AS createdAt
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

async function readExportMarker(path: string): Promise<ExportMarker | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<ExportMarker>;
    if (
      value.schemaVersion !== EXPORT_SCHEMA_VERSION ||
      value.format !== "legacy-device-library" ||
      typeof value.generatedAt !== "string" ||
      !Number.isSafeInteger(value.tracks) ||
      !Number.isSafeInteger(value.playlists)
    )
      throw new TypeError(`Invalid exporter ownership marker '${path}'`);
    return value as ExportMarker;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function installStagedExport(
  stagingRoot: string,
  targetRoot: string,
  marker: ExportMarker,
): Promise<void> {
  const staged = exportPaths(stagingRoot);
  const target = exportPaths(targetRoot);
  const backupRoot = join(targetRoot, `.music-cdj-export-backup-${randomUUID()}`);
  const backup = exportPaths(backupRoot);
  const markerTemporary = `${target.marker}.${randomUUID()}.tmp`;
  await mkdir(dirname(target.pdb), { recursive: true });
  await mkdir(dirname(backup.pdb), { recursive: true });

  const movedOld: Array<{ from: string; to: string }> = [];
  const installed: string[] = [];
  try {
    for (const [from, to] of [
      [target.contents, backup.contents],
      [target.analysis, backup.analysis],
      [target.pdb, backup.pdb],
    ] as const) {
      if (!(await pathExists(from))) continue;
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      movedOld.push({ from, to });
    }
    for (const [from, to] of [
      [staged.contents, target.contents],
      [staged.analysis, target.analysis],
      [staged.pdb, target.pdb],
    ] as const) {
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      installed.push(to);
    }
    await writeFile(markerTemporary, `${JSON.stringify(marker, null, 2)}\n`, {
      flag: "wx",
    });
    await rename(markerTemporary, target.marker);
    await rm(backupRoot, { force: true, recursive: true });
  } catch (error) {
    for (const path of installed.reverse()) await rm(path, { force: true, recursive: true });
    for (const { from, to } of movedOld.reverse()) {
      if (await pathExists(to)) {
        await mkdir(dirname(from), { recursive: true });
        await rename(to, from);
      }
    }
    throw error;
  } finally {
    await rm(markerTemporary, { force: true });
    await rm(backupRoot, { force: true, recursive: true });
  }
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

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
