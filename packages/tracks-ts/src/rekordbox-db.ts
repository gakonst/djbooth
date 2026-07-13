import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  lstatSync,
  readFileSync,
  rmSync,
} from "node:fs";
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { basename, dirname, join, resolve } from "node:path";

import { XMLParser, XMLValidator } from "fast-xml-parser";

import { acquirePipelineManifestLock } from "./acquisition.js";
import { TracksError } from "./errors.js";
import {
  parseManifest,
  type AcquisitionDownload,
  type ManifestArtifacts,
  type ResolvedTrack,
  type SetManifest,
  type SpotifyCandidate,
} from "./manifest.js";
import { formatTimestamp } from "./time.js";
import { mapConcurrent } from "./process.js";

const DEFAULT_FOLDER_NAME = "DJ Sets I Like";
const DEFAULT_REKORDBOX_MODULE = "@gakonst/rekordbox";
/** Parallel read/hash/copy work only; database access remains serialized. */
export const DEFAULT_REKORDBOX_IO_CONCURRENCY = 64;

type DatabaseValue = string | number | bigint | Buffer | Date | null;

type DatabaseRow = {
  ID: string;
  Name?: string | null;
  tableName: string;
  get(key: string): DatabaseValue | undefined;
  set(key: string, value: DatabaseValue): DatabaseRow;
};

type DjmdArtist = DatabaseRow & { Name: string | null };
type DjmdAlbum = DatabaseRow & { Name: string | null };
type DjmdLabel = DatabaseRow & { Name: string | null };
type DjmdContent = DatabaseRow & {
  Title: string | null;
  FolderPath: string | null;
};
type DjmdPlaylist = DatabaseRow & {
  Name: string;
  Attribute: number;
  ParentID: string;
};
type DjmdSongPlaylist = DatabaseRow & {
  PlaylistID: string;
  ContentID: string;
  TrackNo: number;
};

type RekordboxModel<row extends DatabaseRow> = {
  tableName: string;
  readonly _rowType?: row;
};

type RekordboxQuery<row extends DatabaseRow> = {
  where(filters: Record<string, DatabaseValue>): RekordboxQuery<row>;
  orderBy(column: string): RekordboxQuery<row>;
  all(): row[];
  one(): row;
  first(): row | undefined;
};

export type RekordboxMasterDatabase = {
  query<row extends DatabaseRow>(model: RekordboxModel<row>): RekordboxQuery<row>;
  addArtist(name: string): DjmdArtist;
  addAlbum(name: string, options?: { artist?: DjmdArtist }): DjmdAlbum;
  addLabel(name: string): DjmdLabel;
  addContent(path: string, values?: Record<string, DatabaseValue>): DjmdContent;
  createPlaylist(name: string, options?: { parent?: DjmdPlaylist }): DjmdPlaylist;
  createPlaylistFolder(name: string, options?: { parent?: DjmdPlaylist }): DjmdPlaylist;
  addToPlaylist(
    playlist: DjmdPlaylist,
    content: DjmdContent,
    trackNumber?: number,
  ): DjmdSongPlaylist;
  moveSongInPlaylist(
    playlist: DjmdPlaylist,
    membership: DjmdSongPlaylist,
    trackNumber: number,
  ): void;
  installContentAnalysis(
    content: DjmdContent | string | number,
    analysisDirectory: string,
    options?: { allowWhileRunning?: boolean; commit?: boolean; replace?: boolean },
  ): RekordboxInstalledAnalysis;
  syncContentAnalysisMetadata(
    content: DjmdContent | string | number,
    analysisDirectory: string,
    options?: { allowWhileRunning?: boolean; commit?: boolean },
  ): RekordboxAnalysisMetadata;
  getContentAnlzPaths(
    content: DjmdContent | string | number,
  ): Record<"2EX" | "DAT" | "EXT", string | undefined>;
  readContentAnlzFiles(
    content: DjmdContent | string | number,
  ): Map<string, { get(key: string): unknown }>;
  hasColumn(table: string, column: string): boolean;
  selectRawRows(sql: string, parameters?: unknown[]): Array<Record<string, unknown>>;
  commit(options?: { allowWhileRunning?: boolean }): void;
  close(): void;
};

export type RekordboxLibrary = {
  MasterDatabase: new (options: {
    path: string;
    dbDirectory: string;
    readonly: boolean;
    unlock: boolean;
    allowWhileRunning?: boolean;
    key?: string;
  }) => RekordboxMasterDatabase;
  DjmdArtist: RekordboxModel<DjmdArtist>;
  DjmdAlbum: RekordboxModel<DjmdAlbum>;
  DjmdLabel: RekordboxModel<DjmdLabel>;
  DjmdContent: RekordboxModel<DjmdContent>;
  DjmdPlaylist: RekordboxModel<DjmdPlaylist>;
  DjmdSongPlaylist: RekordboxModel<DjmdSongPlaylist>;
  PlaylistType: { FOLDER: number; PLAYLIST: number };
  readAnalysisMetadata(analysisDirectory: string): {
    key: string | null;
    tempoBpm: number | null;
  };
  normalizeRekordboxKeyName(value: string): string;
  getConfig(section: "rekordbox6" | "rekordbox7"): { dbPath: string; dbDir: string } | undefined;
  getRekordboxPid(): number;
  getRekordboxAgentPid(): number;
};

export type RekordboxTrackMetadata = {
  title: string;
  artist: string;
  album?: string;
  albumArtist?: string;
  label?: string;
  releaseDate?: string;
  releaseYear?: number;
  isrc?: string;
  durationSeconds?: number;
  comment: string;
};

export type RekordboxImportItem = {
  key: string;
  entryId: string;
  entryOrder: number;
  variantIndex: number;
  mediaPath: string;
  analysisDirectory?: string;
  download: AcquisitionDownload;
  metadata: RekordboxTrackMetadata;
};

export type RekordboxImportPlan = {
  folderName: string;
  playlistName: string;
  items: RekordboxImportItem[];
};

export type RekordboxBackupFile = {
  name: string;
  sourcePath: string;
  backupPath: string;
  bytes: number;
  sha256: string;
  sourceBytesBefore: number;
  sourceBytesAfter: number;
  sourceSha256Before: string;
  sourceSha256After: string;
};

export type RekordboxBackup = {
  directory: string;
  createdAt: string;
  files: RekordboxBackupFile[];
  reportPath: string;
};

export type RekordboxImportedItem = {
  key: string;
  entryId: string;
  variantIndex: number;
  mediaPath: string;
  contentId: string;
  membershipId: string;
  trackNumber: number;
};

export type RekordboxVerification = {
  quickCheck: "ok";
  foreignKeyViolationCount: 0;
  playlistSidecarVerified: true;
  expectedMembershipCount: number;
  playlistMembershipCount: number;
  verifiedMetadataCount: number;
  expectedAnalysisCount: number;
  verifiedAnalysisCount: number;
  verifiedAnalysisPaths: string[];
  verifiedPaths: string[];
};

export type RekordboxInstalledAnalysis = {
  analysisDataPath: string;
  bpmHundredths: number | null;
  contentId: string;
  directory: string;
  keyId: string | null;
  keyName: string | null;
  paths: Record<"2EX" | "DAT" | "EXT", string>;
  tempoBpm: number | null;
};

export type RekordboxAnalysisMetadata = Pick<
  RekordboxInstalledAnalysis,
  "bpmHundredths" | "contentId" | "keyId" | "keyName" | "tempoBpm"
>;

export type RekordboxPlaylistArtifact = NonNullable<ManifestArtifacts["rekordbox"]>;

export type MasterPlaylistSidecarExpectation = {
  parentId: string;
  attribute: number;
  parentAttribute: number;
};

/** Reject malformed or stale Rekordbox playlist companion XML after a database commit. */
export function validateMasterPlaylistSidecar(
  source: string,
  playlistId: string,
  expectation?: MasterPlaylistSidecarExpectation,
): void {
  const declarations = [...source.matchAll(/<\?xml\b/giu)];
  if (declarations.length !== 1 || declarations[0]!.index !== 0)
    throw new Error(`Rekordbox playlist sidecar has ${declarations.length} XML declarations`);
  const validation = XMLValidator.validate(source);
  if (validation !== true) {
    throw new Error(
      `Rekordbox playlist sidecar is malformed: ${validation.err.msg} at line ${validation.err.line}`,
    );
  }
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    isArray: (_name, path) => path === "MASTER_PLAYLIST.PLAYLISTS.NODE",
  }).parse(source) as unknown;
  const root = objectValue(parsed)?.MASTER_PLAYLIST;
  const playlists = objectValue(root)?.PLAYLISTS;
  const nodes = objectValue(playlists)?.NODE;
  if (!Array.isArray(nodes)) throw new Error("Rekordbox playlist sidecar has no NODE list");
  const hexadecimalId = rekordboxHexId(playlistId);
  const matches = nodes.filter((node) => objectValue(node)?.Id === hexadecimalId);
  if (matches.length !== 1) {
    throw new Error(
      `Rekordbox playlist sidecar has ${matches.length} nodes for playlist '${playlistId}'`,
    );
  }
  if (expectation) {
    const node = objectValue(matches[0])!;
    const parentHexId = rekordboxHexId(expectation.parentId);
    if (node.ParentId !== parentHexId || String(node.Attribute) !== String(expectation.attribute)) {
      throw new Error(`Rekordbox playlist sidecar has wrong parent/type for '${playlistId}'`);
    }
    const parents = nodes.filter((candidate) => objectValue(candidate)?.Id === parentHexId);
    if (
      parents.length !== 1 ||
      String(objectValue(parents[0])?.Attribute) !== String(expectation.parentAttribute)
    ) {
      throw new Error(`Rekordbox playlist sidecar has no matching parent for '${playlistId}'`);
    }
  }
}

export type ImportManifestToRekordboxOptions = {
  /** Required acknowledgement because this mutates the encrypted Rekordbox database. */
  approved: true;
  manifest: SetManifest;
  manifestPath: string;
  dbPath?: string;
  dbDirectory?: string;
  key?: string;
  folderName?: string;
  playlistName?: string;
  backupRoot?: string;
  /** Native analyzer output directories keyed by absolute media path. */
  analysisDirectories?: Readonly<Record<string, string>>;
  now?: Date;
  /** Inject the library directly for tests or a custom runtime. */
  rekordboxModule?: RekordboxLibrary;
  /** Optional package name or file URL used when no module object is injected. */
  rekordboxModuleSpecifier?: string;
};

export type ImportManifestToRekordboxResult = {
  manifest: SetManifest;
  dbPath: string;
  playlistId: string;
  folderId: string;
  plan: RekordboxImportPlan;
  imported: RekordboxImportedItem[];
  backup: RekordboxBackup;
  verification: RekordboxVerification;
  performance: RekordboxPerformance;
};

export type RekordboxPerformance = {
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  changed: boolean;
  stages: Array<{ stage: string; durationMs: number }>;
};

type MediaReceipt = {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number | bigint;
  sha256: string;
};

type ProcessState = { rekordboxPid: number; rekordboxAgentPid: number };

type ResolvedDatabaseLocation = { dbPath: string; dbDirectory: string };

type SpotifyMetadata = {
  id?: string;
  name?: string;
  artists?: string[];
  album?: string;
  albumArtists?: string[];
  releaseDate?: string;
  durationMs?: number;
  isrc?: string;
};

/** Pure safety guard used by the direct database entrypoint. */
export function assertRekordboxImportApproved(approved: unknown): asserts approved is true {
  if (approved !== true)
    throw new TracksError(
      "INVALID_SOURCE",
      "Direct Rekordbox database import requires approved: true",
      { exitCode: 2 },
    );
}

/** Pure process-state validation; PID collection stays at the live entrypoint boundary. */
export function assertRekordboxStopped(state: ProcessState): void {
  const running = [
    state.rekordboxPid ? `rekordbox (PID ${state.rekordboxPid})` : undefined,
    state.rekordboxAgentPid ? `rekordboxAgent (PID ${state.rekordboxAgentPid})` : undefined,
  ].filter((value): value is string => value !== undefined);
  if (running.length)
    throw new TracksError(
      "TOOL_FAILED",
      `Close Rekordbox before direct database import; running: ${running.join(", ")}`,
      { details: state },
    );
}

export function defaultRekordboxPlaylistName(manifest: SetManifest): string {
  const name = manifest.source.title?.trim() || manifest.source.id?.trim() || "DJ Set";
  return `${name} [tracks-ts]`;
}

/** Resolve one native-analysis directory from an absolute-media-path lookup. */
export function resolveRekordboxAnalysisDirectory(
  mediaPath: string,
  analysisDirectories: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (!analysisDirectories) return undefined;
  const target = resolve(mediaPath);
  let match: string | undefined;
  for (const [candidate, directory] of Object.entries(analysisDirectories)) {
    if (resolve(candidate) !== target) continue;
    if (!directory.trim())
      throw new TypeError(`Rekordbox analysis directory for '${target}' is empty`);
    if (match !== undefined)
      throw new TypeError(`Multiple Rekordbox analysis directories map to '${target}'`);
    match = resolve(directory);
  }
  return match;
}

/**
 * Expand each downloaded entry into one primary item followed by its alternatives.
 * Entries remain in cue order and variants remain adjacent.
 */
export function planRekordboxImport(
  input: SetManifest,
  options: {
    mediaBaseDirectory?: string;
    folderName?: string;
    playlistName?: string;
    analysisDirectories?: Readonly<Record<string, string>>;
  } = {},
): RekordboxImportPlan {
  const manifest = parseManifest(structuredClone(input));
  const mediaBaseDirectory = resolve(options.mediaBaseDirectory ?? process.cwd());
  const items: RekordboxImportItem[] = [];

  for (const entry of manifest.entries) {
    const acquisitionErrors = entry.errors.filter((error) => error.stage === "acquisition");
    if (acquisitionErrors.length)
      throw new TracksError(
        "INVALID_SOURCE",
        `Manifest entry ${entry.id} has unresolved acquisition errors`,
        { exitCode: 2, details: { errors: acquisitionErrors } },
      );
    if (entry.acquisition.status !== "downloaded")
      throw new TracksError(
        "INVALID_SOURCE",
        `Manifest entry ${entry.id} is not downloaded (status: ${entry.acquisition.status})`,
        { exitCode: 2 },
      );
    const downloads = [entry.acquisition.download, ...(entry.acquisition.alternatives ?? [])];
    downloads.forEach((download, variantIndex) => {
      const mediaPath = resolve(mediaBaseDirectory, download.mediaPath);
      const analysisDirectory = resolveRekordboxAnalysisDirectory(
        mediaPath,
        options.analysisDirectories,
      );
      items.push({
        key: `${entry.id}:${variantIndex}`,
        entryId: entry.id,
        entryOrder: entry.order,
        variantIndex,
        mediaPath,
        ...(analysisDirectory ? { analysisDirectory } : {}),
        download: structuredClone(download),
        metadata: metadataForDownload(manifest, entry, download, variantIndex),
      });
    });
  }

  const paths = items.map((item) => item.mediaPath);
  if (new Set(paths).size !== paths.length)
    throw new TracksError(
      "INVALID_SOURCE",
      "Downloaded manifest variants must have globally distinct media paths",
      { exitCode: 2 },
    );
  const analysisDirectories = items.flatMap((item) =>
    item.analysisDirectory ? [item.analysisDirectory] : [],
  );
  if (new Set(analysisDirectories).size !== analysisDirectories.length)
    throw new TracksError(
      "INVALID_SOURCE",
      "Native Rekordbox analysis directories must be globally distinct",
      { exitCode: 2 },
    );
  const plannedPaths = new Set(paths);
  for (const mediaPath of Object.keys(options.analysisDirectories ?? {}))
    if (!plannedPaths.has(resolve(mediaPath)))
      throw new TracksError(
        "INVALID_SOURCE",
        `Rekordbox analysis references media outside this manifest: ${resolve(mediaPath)}`,
        { exitCode: 2 },
      );
  if (!items.length)
    throw new TracksError("INVALID_SOURCE", "Manifest has no downloaded tracks to import", {
      exitCode: 2,
    });

  return {
    folderName: options.folderName?.trim() || DEFAULT_FOLDER_NAME,
    playlistName: options.playlistName?.trim() || defaultRekordboxPlaylistName(manifest),
    items,
  };
}

/** Build the persisted manifest handoff after a verified database import. */
export function applyRekordboxImportResults(
  input: SetManifest,
  imported: RekordboxImportedItem[],
  rekordboxArtifact: RekordboxPlaylistArtifact,
): SetManifest {
  const manifest = structuredClone(parseManifest(structuredClone(input)));
  const byEntry = new Map<string, RekordboxImportedItem[]>();
  for (const item of imported) {
    const group = byEntry.get(item.entryId) ?? [];
    group.push(item);
    byEntry.set(item.entryId, group);
  }

  for (const entry of manifest.entries) {
    if (entry.acquisition.status !== "downloaded") continue;
    const expected = 1 + (entry.acquisition.alternatives?.length ?? 0);
    const items = (byEntry.get(entry.id) ?? []).sort(
      (left, right) => left.variantIndex - right.variantIndex,
    );
    if (items.length !== expected || items.some((item, index) => item.variantIndex !== index))
      throw new TracksError(
        "INVALID_RESPONSE",
        `Rekordbox result count does not match downloaded variants for ${entry.id}`,
      );
    const dbContentIds = items.map((item) => item.contentId);
    const playlistMembershipIds = items.map((item) => item.membershipId);
    entry.rekordbox = {
      status: "imported",
      target: "rekordbox-db",
      artifact: rekordboxArtifact.dbPath,
      dbContentId: dbContentIds[0]!,
      playlistMembershipId: playlistMembershipIds[0]!,
      dbContentIds,
      playlistMembershipIds,
    };
  }
  manifest.artifacts.rekordbox = structuredClone(rekordboxArtifact);
  return parseManifest(manifest);
}

/** Files captured before any database connection is opened for writing. */
export function rekordboxBackupSources(
  dbDirectory: string,
  dbPath = join(resolve(dbDirectory), "master.db"),
): Array<{
  name: string;
  sourcePath: string;
  required: boolean;
}> {
  const directory = resolve(dbDirectory);
  const databasePath = resolve(dbPath);
  const databaseName = basename(databasePath);
  return [
    { name: databaseName, sourcePath: databasePath, required: true },
    { name: `${databaseName}-wal`, sourcePath: `${databasePath}-wal`, required: false },
    { name: `${databaseName}-shm`, sourcePath: `${databasePath}-shm`, required: false },
    {
      name: `${databaseName}-journal`,
      sourcePath: `${databasePath}-journal`,
      required: false,
    },
    {
      name: "masterPlaylists6.xml",
      sourcePath: join(directory, "masterPlaylists6.xml"),
      required: true,
    },
  ];
}

/** Create an exclusive, durable, checksummed pre-write backup. */
export async function backupRekordboxDatabase(
  dbDirectory: string,
  options: { backupRoot?: string; dbPath?: string; now?: Date } = {},
): Promise<RekordboxBackup> {
  const createdAt = (options.now ?? new Date()).toISOString();
  const backupRoot = resolve(options.backupRoot ?? join(dbDirectory, "tracks-ts-backups"));
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const directory = join(backupRoot, `rekordbox-${backupTimestamp(createdAt)}`);
  await mkdir(directory, { recursive: false, mode: 0o700 });

  let files: RekordboxBackupFile[] = [];
  try {
    const copied = await mapConcurrent(
      rekordboxBackupSources(dbDirectory, options.dbPath),
      DEFAULT_REKORDBOX_IO_CONCURRENCY,
      async (source): Promise<RekordboxBackupFile | undefined> => {
        let sourceStat;
        try {
          sourceStat = await stat(source.sourcePath);
        } catch (error) {
          if (isMissingPathError(error) && !source.required) return undefined;
          throw error;
        }
        if (!sourceStat.isFile())
          throw new TypeError(`Rekordbox backup source '${source.sourcePath}' is not a file`);
        const sourceSha256Before = await sha256File(source.sourcePath);
        const backupPath = join(directory, source.name);
        await copyFile(source.sourcePath, backupPath, fsConstants.COPYFILE_EXCL);
        await syncFile(backupPath);
        const copiedStat = await stat(backupPath);
        const sourceStatAfter = await stat(source.sourcePath);
        const [copiedSha256, sourceSha256After] = await Promise.all([
          sha256File(backupPath),
          sha256File(source.sourcePath),
        ]);
        if (
          sourceStat.size !== sourceStatAfter.size ||
          sourceStat.size !== copiedStat.size ||
          sourceSha256Before !== sourceSha256After ||
          sourceSha256Before !== copiedSha256
        )
          throw new Error(`Rekordbox backup source changed while copying: ${source.sourcePath}`);
        return {
          name: source.name,
          sourcePath: source.sourcePath,
          backupPath,
          bytes: copiedStat.size,
          sha256: copiedSha256,
          sourceBytesBefore: sourceStat.size,
          sourceBytesAfter: sourceStatAfter.size,
          sourceSha256Before,
          sourceSha256After,
        };
      },
    );
    files = copied.filter((file): file is RekordboxBackupFile => file !== undefined);
    const reportPath = join(directory, "backup.json");
    await writeExclusiveJson(reportPath, { createdAt, files });
    await syncDirectory(directory);
    return { directory, createdAt, files, reportPath };
  } catch (error) {
    throw new TracksError("TOOL_FAILED", `Could not create Rekordbox backup '${directory}'`, {
      cause: error,
      details: { directory },
    });
  }
}

/**
 * Import a completed manifest into the normal encrypted Rekordbox 6/7 master.db.
 * The function refuses to run without explicit approval or while either Rekordbox
 * process is alive, backs up all companion files, commits once, then verifies by
 * reopening read-only before atomically updating the manifest.
 */
export async function importManifestToRekordbox(
  options: ImportManifestToRekordboxOptions,
): Promise<ImportManifestToRekordboxResult> {
  const startedAt = new Date();
  const started = performance.now();
  assertRekordboxImportApproved(options.approved);
  const manifestPath = resolve(options.manifestPath);
  const lockStarted = performance.now();
  const release = await acquirePipelineManifestLock(manifestPath);
  const lockMs = roundMilliseconds(performance.now() - lockStarted);
  try {
    const result = await importManifestToRekordboxLocked(options, manifestPath);
    result.performance.totalMs = roundMilliseconds(performance.now() - started);
    result.performance.startedAt = startedAt.toISOString();
    result.performance.finishedAt = new Date().toISOString();
    result.performance.stages.unshift({ stage: "manifest-lock", durationMs: lockMs });
    return result;
  } finally {
    await release();
  }
}

async function importManifestToRekordboxLocked(
  options: ImportManifestToRekordboxOptions,
  manifestPath: string,
): Promise<ImportManifestToRekordboxResult> {
  const started = performance.now();
  const stages: RekordboxPerformance["stages"] = [];
  const measure = async <T>(stage: string, task: () => T | Promise<T>): Promise<T> => {
    const stageStarted = performance.now();
    try {
      return await task();
    } finally {
      stages.push({ stage, durationMs: roundMilliseconds(performance.now() - stageStarted) });
    }
  };
  const manifest = parseManifest(structuredClone(options.manifest));
  const manifestBytes = await readFile(manifestPath);
  const diskManifest = parseManifest(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  if (!isDeepStrictEqual(diskManifest, manifest))
    throw new TracksError(
      "INVALID_SOURCE",
      `Manifest '${manifestPath}' changed or does not match the supplied manifest`,
      { exitCode: 2 },
    );
  const manifestSha256 = sha256Bytes(manifestBytes);
  const plan = planRekordboxImport(manifest, {
    mediaBaseDirectory: dirname(manifestPath),
    ...(options.folderName === undefined ? {} : { folderName: options.folderName }),
    ...(options.playlistName === undefined ? {} : { playlistName: options.playlistName }),
    ...(options.analysisDirectories === undefined
      ? {}
      : { analysisDirectories: options.analysisDirectories }),
  });
  const mediaReceipts = await measure("media-preflight", async () => {
    const [receipts] = await Promise.all([
      assertMediaFilesExist(plan),
      assertAnalysisDirectoriesExist(plan),
    ]);
    return receipts;
  });

  const rekordbox = await measure("library-load", () => loadRekordboxLibrary(options));
  const location = resolveDatabaseLocation(rekordbox, options);
  const releaseDatabaseLock = await acquireRekordboxDatabaseLock(location.dbPath);
  try {
    assertRekordboxStopped(readProcessState(rekordbox));
    await assertRekordboxWriteTargets(location);
    const checkpointed = checkpointedRekordboxImport(manifest, plan, location.dbPath);
    if (checkpointed) {
      const existingStarted = performance.now();
      try {
        const verification = verifyCommittedImport(
          rekordbox,
          location,
          options.key,
          checkpointed.folderId,
          checkpointed.playlistId,
          checkpointed.imported,
          plan,
        );
        await assertMediaFilesExist(plan, mediaReceipts);
        const backup = await readRekordboxBackup(checkpointed.backupDirectory);
        return {
          manifest,
          dbPath: location.dbPath,
          playlistId: checkpointed.playlistId,
          folderId: checkpointed.folderId,
          plan,
          imported: checkpointed.imported,
          backup,
          verification,
          performance: {
            startedAt: new Date(Date.now() - (performance.now() - started)).toISOString(),
            finishedAt: new Date().toISOString(),
            totalMs: roundMilliseconds(performance.now() - started),
            changed: false,
            stages,
          },
        };
      } catch (error) {
        if (!isRepairableRekordboxCheckpointDrift(error)) {
          throw new TracksError(
            "TOOL_FAILED",
            "Existing Rekordbox checkpoint could not be safely verified; refusing database mutation",
            {
              cause: error,
              details: {
                dbPath: location.dbPath,
                backupDirectory: checkpointed.backupDirectory,
              },
            },
          );
        }
      } finally {
        stages.push({
          stage: "existing-import-verification",
          durationMs: roundMilliseconds(performance.now() - existingStarted),
        });
      }
    }
    const backup = await measure("database-backup", () =>
      backupRekordboxDatabase(location.dbDirectory, {
        dbPath: location.dbPath,
        ...(options.backupRoot === undefined ? {} : { backupRoot: options.backupRoot }),
        ...(options.now === undefined ? {} : { now: options.now }),
      }),
    );
    assertRekordboxStopped(readProcessState(rekordbox));

    let writer: RekordboxMasterDatabase | undefined;
    let playlistId: string;
    let folderId: string;
    let imported: RekordboxImportedItem[];
    let installedAnalysis: RekordboxInstalledAnalysis[] = [];
    let databaseCommitAttempted = false;
    try {
      await measure("database-write-plan", () => {
        writer = new rekordbox.MasterDatabase({
          path: location.dbPath,
          dbDirectory: location.dbDirectory,
          readonly: false,
          unlock: true,
          allowWhileRunning: false,
          ...(options.key === undefined ? {} : { key: options.key }),
        });
        const writeResult = writeRekordboxPlan(writer, rekordbox, plan);
        playlistId = writeResult.playlistId;
        folderId = writeResult.folderId;
        imported = writeResult.imported;
        installedAnalysis = writeResult.installedAnalysis;
      });
      await measure("media-recheck-before-commit", () =>
        assertMediaFilesExist(plan, mediaReceipts),
      );
      await measure("database-commit", () => {
        assertRekordboxStopped(readProcessState(rekordbox));
        databaseCommitAttempted = true;
        writer!.commit({ allowWhileRunning: false });
      });
    } catch (error) {
      if (!databaseCommitAttempted) removeInstalledAnalysis(installedAnalysis);
      throw new TracksError(
        "TOOL_FAILED",
        `Rekordbox database import failed; pre-write backup: ${backup.directory}`,
        { cause: error, details: { backup } },
      );
    } finally {
      const closeStarted = performance.now();
      writer?.close();
      stages.push({
        stage: "database-close",
        durationMs: roundMilliseconds(performance.now() - closeStarted),
      });
    }

    let verification: RekordboxVerification;
    try {
      verification = await measure("database-verification", () => {
        assertRekordboxStopped(readProcessState(rekordbox));
        return verifyCommittedImport(
          rekordbox,
          location,
          options.key,
          folderId!,
          playlistId!,
          imported!,
          plan,
        );
      });
      await measure("media-recheck-after-commit", () => assertMediaFilesExist(plan, mediaReceipts));
    } catch (error) {
      throw new TracksError(
        "TOOL_FAILED",
        `Rekordbox post-commit verification failed; restore or inspect backup: ${backup.directory}`,
        { cause: error, details: { backup } },
      );
    }
    const updatedManifest = applyRekordboxImportResults(manifest, imported!, {
      target: "rekordbox-db",
      dbPath: location.dbPath,
      folderName: plan.folderName,
      folderId: folderId!,
      playlistName: plan.playlistName,
      playlistId: playlistId!,
      backupDirectory: backup.directory,
    });
    await measure("manifest-checkpoint", () =>
      writeManifestAtomically(manifestPath, updatedManifest, manifestSha256),
    );
    return {
      manifest: updatedManifest,
      dbPath: location.dbPath,
      playlistId: playlistId!,
      folderId: folderId!,
      plan,
      imported: imported!,
      backup,
      verification,
      performance: {
        startedAt: new Date(Date.now() - (performance.now() - started)).toISOString(),
        finishedAt: new Date().toISOString(),
        totalMs: roundMilliseconds(performance.now() - started),
        changed: true,
        stages,
      },
    };
  } finally {
    await releaseDatabaseLock();
  }
}

function metadataForDownload(
  manifest: SetManifest,
  entry: ResolvedTrack,
  download: AcquisitionDownload,
  variantIndex: number,
): RekordboxTrackMetadata {
  const spotify = spotifyMetadata(entry, download, variantIndex);
  const isSetExtract = download.kind === "source-set-clip" || download.clip !== undefined;
  const isUnidentified = entry.identity.status === "unidentified" || entry.identity.isId === true;
  const identityTitle = entry.identity.title?.trim();
  const mix = entry.identity.mix?.trim();
  const baseTitle = isUnidentified
    ? `ID [Set Extract @ ${entry.cue.timestamp ?? formatTimestamp(entry.cue.startSeconds ?? 0)}]`
    : spotify?.name?.trim() ||
      (identityTitle
        ? mix && !identityTitle.toLocaleLowerCase().includes(mix.toLocaleLowerCase())
          ? `${identityTitle} (${mix})`
          : identityTitle
        : `Track ${entry.order}`);
  const title =
    isSetExtract && !isUnidentified && !/\[Set Extract\]/iu.test(baseTitle)
      ? `${baseTitle} [Set Extract]`
      : baseTitle;
  const identityArtist = entry.identity.artist?.trim();
  const artist =
    (isUnidentified ? undefined : spotify?.artists?.filter(Boolean).join(", ").trim()) ||
    (isUnidentified ? undefined : identityArtist) ||
    "Unknown Artist";
  const album = isSetExtract
    ? undefined
    : spotify?.album?.trim() || entry.identity.album?.trim() || undefined;
  const albumArtist = album
    ? spotify?.albumArtists?.filter(Boolean).join(", ").trim() || artist
    : undefined;
  const releaseDate = isSetExtract
    ? undefined
    : spotify?.releaseDate?.trim() || entry.identity.releaseDate?.trim() || undefined;
  const releaseYear = releaseDateYear(releaseDate);
  const isrc = isSetExtract
    ? undefined
    : download.isrc?.trim() || spotify?.isrc?.trim() || entry.identity.isrc?.trim();
  const durationSeconds = isSetExtract
    ? clipDuration(download)
    : spotify?.durationMs === undefined
      ? clipDuration(download)
      : Math.max(1, Math.round(spotify.durationMs / 1000));

  return {
    title,
    artist,
    ...(album ? { album } : {}),
    ...(albumArtist ? { albumArtist } : {}),
    ...(entry.identity.label?.trim() ? { label: entry.identity.label.trim() } : {}),
    ...(releaseDate ? { releaseDate } : {}),
    ...(releaseYear === undefined ? {} : { releaseYear }),
    ...(isrc ? { isrc } : {}),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    comment: downloadComment(manifest, entry, download),
  };
}

function spotifyMetadata(
  entry: ResolvedTrack,
  download: AcquisitionDownload,
  variantIndex: number,
): SpotifyMetadata | undefined {
  if (entry.spotify.status === "matched") {
    const candidate = matchSpotifyCandidate(entry.spotify.candidates, download);
    return candidate ?? entry.spotify;
  }
  if (entry.spotify.status !== "ambiguous") return undefined;
  return (
    matchSpotifyCandidate(entry.spotify.candidates, download) ??
    entry.spotify.candidates[variantIndex]
  );
}

function matchSpotifyCandidate(
  candidates: SpotifyCandidate[] | undefined,
  download: AcquisitionDownload,
): SpotifyCandidate | undefined {
  if (!candidates?.length) return undefined;
  if (download.spotifyId) {
    const byId = candidates.find((candidate) => candidate.id === download.spotifyId);
    if (byId) return byId;
  }
  if (download.isrc) {
    const isrc = download.isrc.toLocaleUpperCase();
    return candidates.find((candidate) => candidate.isrc?.toLocaleUpperCase() === isrc);
  }
  return undefined;
}

function clipDuration(download: AcquisitionDownload): number | undefined {
  if (!download.clip) return undefined;
  return Math.max(1, Math.round(download.clip.endSeconds - download.clip.startSeconds));
}

function releaseDateYear(releaseDate: string | undefined): number | undefined {
  const match = releaseDate ? /^(\d{4})(?:-|$)/u.exec(releaseDate) : undefined;
  return match ? Number(match[1]) : undefined;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

function downloadComment(
  manifest: SetManifest,
  entry: ResolvedTrack,
  download: AcquisitionDownload,
): string {
  const setTitle = manifest.source.title?.trim() || manifest.source.id?.trim() || "DJ set";
  const setUrl = manifest.source.url ?? manifest.source.input;
  if (download.clip) {
    const range = `${formatTimestamp(download.clip.startSeconds)}–${formatTimestamp(download.clip.endSeconds)}`;
    return [
      "[Set Extract]",
      `Source: ${download.clip.sourceSetTitle?.trim() || setTitle}`,
      `Source URL: ${download.clip.sourceSetUrl}`,
      `Set range: ${range}`,
      `Quality: ${download.clip.qualityNote}`,
      ...(download.clip.containsTransitions ? ["Transitions: may be present"] : []),
    ].join("\n");
  }

  const cue =
    entry.cue.startSeconds === undefined
      ? entry.cue.timestamp
      : entry.cue.endSeconds === undefined
        ? formatTimestamp(entry.cue.startSeconds)
        : `${formatTimestamp(entry.cue.startSeconds)}–${formatTimestamp(entry.cue.endSeconds)}`;
  return [
    "[tracks-ts]",
    `Set: ${setTitle}`,
    `Set URL: ${setUrl}`,
    ...(cue ? [`Set cue: ${cue}`] : []),
    `Acquisition: ${download.backend} ${download.kind ?? "individual"}`,
    ...(download.source ? [`Media source: ${download.source}`] : []),
    ...(download.spotifyId ? [`Spotify ID: ${download.spotifyId}`] : []),
    ...(download.spotifyId
      ? [`Spotify URL: https://open.spotify.com/track/${download.spotifyId}`]
      : entry.spotify.status === "matched" && entry.spotify.url
        ? [`Spotify URL: ${entry.spotify.url}`]
        : []),
  ].join("\n");
}

async function assertMediaFilesExist(
  plan: RekordboxImportPlan,
  previous?: ReadonlyMap<string, MediaReceipt>,
): Promise<Map<string, MediaReceipt>> {
  const receipts = new Map<string, MediaReceipt>();
  await mapConcurrent(plan.items, DEFAULT_REKORDBOX_IO_CONCURRENCY, async (item) => {
    let mediaStat;
    try {
      mediaStat = await stat(item.mediaPath);
    } catch (error) {
      throw new TracksError("INVALID_SOURCE", `Downloaded media is missing: ${item.mediaPath}`, {
        cause: error,
        exitCode: 2,
      });
    }
    if (!mediaStat.isFile())
      throw new TracksError("INVALID_SOURCE", `Downloaded media is not a file: ${item.mediaPath}`, {
        exitCode: 2,
      });
    if (!item.download.sha256)
      throw new TracksError(
        "INVALID_SOURCE",
        `Downloaded media has no recorded SHA-256: ${item.mediaPath}`,
        { exitCode: 2 },
      );
    const prior = previous?.get(item.mediaPath);
    const unchanged =
      prior !== undefined &&
      prior.size === mediaStat.size &&
      prior.mtimeMs === mediaStat.mtimeMs &&
      prior.ctimeMs === mediaStat.ctimeMs &&
      prior.ino === mediaStat.ino;
    const actualSha256 = unchanged ? prior.sha256 : await sha256File(item.mediaPath);
    if (actualSha256 !== item.download.sha256)
      throw new TracksError(
        "INVALID_SOURCE",
        `Downloaded media SHA-256 changed: ${item.mediaPath}`,
        { exitCode: 2 },
      );
    receipts.set(item.mediaPath, {
      path: item.mediaPath,
      size: mediaStat.size,
      mtimeMs: mediaStat.mtimeMs,
      ctimeMs: mediaStat.ctimeMs,
      ino: mediaStat.ino,
      sha256: actualSha256,
    });
  });
  return receipts;
}

async function assertAnalysisDirectoriesExist(plan: RekordboxImportPlan): Promise<void> {
  const analyzed = plan.items.filter(
    (item): item is RekordboxImportItem & { analysisDirectory: string } =>
      item.analysisDirectory !== undefined,
  );
  await mapConcurrent(analyzed, DEFAULT_REKORDBOX_IO_CONCURRENCY, async (item) => {
    await Promise.all(
      ["ANLZ0000.DAT", "ANLZ0000.EXT", "ANLZ0000.2EX", "analysis.json"].map(async (name) => {
        const path = join(item.analysisDirectory, name);
        let fileStat;
        try {
          fileStat = await stat(path);
        } catch (error) {
          throw new TracksError(
            "INVALID_SOURCE",
            `Native Rekordbox analysis is missing ${name} for '${item.mediaPath}'`,
            { cause: error, exitCode: 2, details: { analysisDirectory: item.analysisDirectory } },
          );
        }
        if (!fileStat.isFile())
          throw new TracksError(
            "INVALID_SOURCE",
            `Native Rekordbox analysis artifact is not a file: ${path}`,
            { exitCode: 2 },
          );
      }),
    );
  });
}

function checkpointedRekordboxImport(
  manifest: SetManifest,
  plan: RekordboxImportPlan,
  dbPath: string,
):
  | {
      folderId: string;
      playlistId: string;
      backupDirectory: string;
      imported: RekordboxImportedItem[];
    }
  | undefined {
  const artifact = manifest.artifacts.rekordbox;
  if (
    !artifact ||
    resolve(artifact.dbPath) !== resolve(dbPath) ||
    artifact.folderName !== plan.folderName ||
    artifact.playlistName !== plan.playlistName
  ) {
    return undefined;
  }
  const imported: RekordboxImportedItem[] = [];
  for (const [index, item] of plan.items.entries()) {
    const entry = manifest.entries.find((candidate) => candidate.id === item.entryId);
    if (!entry || entry.rekordbox.status !== "imported") return undefined;
    const contentId =
      entry.rekordbox.dbContentIds?.[item.variantIndex] ??
      (item.variantIndex === 0 ? entry.rekordbox.dbContentId : undefined);
    const membershipId =
      entry.rekordbox.playlistMembershipIds?.[item.variantIndex] ??
      (item.variantIndex === 0 ? entry.rekordbox.playlistMembershipId : undefined);
    if (!contentId || !membershipId) return undefined;
    imported.push({
      key: item.key,
      entryId: item.entryId,
      variantIndex: item.variantIndex,
      mediaPath: item.mediaPath,
      contentId,
      membershipId,
      trackNumber: index + 1,
    });
  }
  return {
    folderId: artifact.folderId,
    playlistId: artifact.playlistId,
    backupDirectory: artifact.backupDirectory,
    imported,
  };
}

/** Read and fully reverify a checkpointed backup before relying on it for recovery. */
export async function readRekordboxBackup(directory: string): Promise<RekordboxBackup> {
  const resolvedDirectory = resolve(directory);
  const reportPath = join(resolvedDirectory, "backup.json");
  const value = JSON.parse(await readFile(reportPath, "utf8")) as {
    createdAt?: unknown;
    files?: unknown;
  };
  if (
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Array.isArray(value.files)
  ) {
    throw new Error(`Invalid Rekordbox backup report: ${reportPath}`);
  }
  const files = value.files.filter(isRekordboxBackupFile);
  if (files.length !== value.files.length || !files.length) {
    throw new Error(`Invalid Rekordbox backup file inventory: ${reportPath}`);
  }
  await mapConcurrent(files, DEFAULT_REKORDBOX_IO_CONCURRENCY, async (file) => {
    if (
      basename(file.name) !== file.name ||
      resolve(file.backupPath) !== join(resolvedDirectory, file.name)
    ) {
      throw new Error(`Invalid Rekordbox backup path: ${file.backupPath}`);
    }
    const backupStat = await lstat(file.backupPath);
    if (!backupStat.isFile() || backupStat.isSymbolicLink() || backupStat.size !== file.bytes) {
      throw new Error(`Rekordbox backup file changed: ${file.backupPath}`);
    }
    if ((await sha256File(file.backupPath)) !== file.sha256) {
      throw new Error(`Rekordbox backup checksum changed: ${file.backupPath}`);
    }
  });
  return { directory: resolvedDirectory, createdAt: value.createdAt, files, reportPath };
}

function isRekordboxBackupFile(value: unknown): value is RekordboxBackupFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Record<string, unknown>;
  return (
    typeof file.name === "string" &&
    typeof file.sourcePath === "string" &&
    typeof file.backupPath === "string" &&
    Number.isSafeInteger(file.bytes) &&
    (file.bytes as number) >= 0 &&
    typeof file.sha256 === "string" &&
    /^[\da-f]{64}$/u.test(file.sha256) &&
    Number.isSafeInteger(file.sourceBytesBefore) &&
    (file.sourceBytesBefore as number) >= 0 &&
    Number.isSafeInteger(file.sourceBytesAfter) &&
    (file.sourceBytesAfter as number) >= 0 &&
    typeof file.sourceSha256Before === "string" &&
    /^[\da-f]{64}$/u.test(file.sourceSha256Before) &&
    typeof file.sourceSha256After === "string" &&
    /^[\da-f]{64}$/u.test(file.sourceSha256After)
  );
}

function isRepairableRekordboxCheckpointDrift(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    /^Rekordbox playlist folder verification failed/u,
    /^Rekordbox playlist row verification failed/u,
    /^Rekordbox playlist sidecar /u,
    /^Rekordbox playlist has \d+ memberships/u,
    /^Rekordbox import plan\/result mismatch/u,
    /^Rekordbox membership verification failed/u,
    /^Rekordbox (?:Artist|AlbumArtist|Album|Label)ID is missing/u,
    /^Rekordbox KeyID (?:is missing|'[^']+' is invalid)/u,
    /^Rekordbox \w+ mismatch/u,
  ].some((pattern) => pattern.test(message));
}

async function assertRekordboxWriteTargets(location: ResolvedDatabaseLocation): Promise<void> {
  for (const path of [location.dbPath, join(location.dbDirectory, "masterPlaylists6.xml")]) {
    try {
      await access(path, fsConstants.R_OK | fsConstants.W_OK);
    } catch (error) {
      throw new TracksError(
        "INVALID_SOURCE",
        `Required Rekordbox write target is missing or not readable/writable: ${path}`,
        { cause: error, exitCode: 2 },
      );
    }
  }
}

function resolveDatabaseLocation(
  rekordbox: RekordboxLibrary,
  options: ImportManifestToRekordboxOptions,
): ResolvedDatabaseLocation {
  if (options.dbPath) {
    const dbPath = resolve(options.dbPath);
    return { dbPath, dbDirectory: resolve(options.dbDirectory ?? dirname(dbPath)) };
  }
  const configured = rekordbox.getConfig("rekordbox7") ?? rekordbox.getConfig("rekordbox6");
  if (!configured)
    throw new TracksError("TOOL_MISSING", "Could not discover a Rekordbox 6/7 master.db");
  return {
    dbPath: resolve(configured.dbPath),
    dbDirectory: resolve(options.dbDirectory ?? configured.dbDir),
  };
}

async function loadRekordboxLibrary(
  options: ImportManifestToRekordboxOptions,
): Promise<RekordboxLibrary> {
  if (options.rekordboxModule) return options.rekordboxModule;
  const specifier = options.rekordboxModuleSpecifier ?? DEFAULT_REKORDBOX_MODULE;
  let loaded: unknown;
  try {
    loaded = await import(specifier);
  } catch (error) {
    throw new TracksError(
      "TOOL_MISSING",
      `Could not import Rekordbox library '${specifier}'; install it or pass rekordboxModule`,
      { cause: error },
    );
  }
  if (!isRekordboxLibrary(loaded))
    throw new TracksError("INVALID_RESPONSE", `Module '${specifier}' is not a Rekordbox library`);
  return loaded;
}

function isRekordboxLibrary(value: unknown): value is RekordboxLibrary {
  if (!value || typeof value !== "object") return false;
  const module = value as Record<string, unknown>;
  return (
    typeof module.MasterDatabase === "function" &&
    typeof module.getConfig === "function" &&
    typeof module.getRekordboxPid === "function" &&
    typeof module.getRekordboxAgentPid === "function" &&
    typeof module.readAnalysisMetadata === "function" &&
    typeof module.normalizeRekordboxKeyName === "function" &&
    typeof module.DjmdContent === "function" &&
    typeof module.DjmdPlaylist === "function" &&
    typeof module.DjmdSongPlaylist === "function" &&
    typeof module.DjmdArtist === "function" &&
    typeof module.DjmdAlbum === "function" &&
    typeof module.DjmdLabel === "function" &&
    !!module.PlaylistType
  );
}

function readProcessState(rekordbox: RekordboxLibrary): ProcessState {
  return {
    rekordboxPid: rekordbox.getRekordboxPid(),
    rekordboxAgentPid: rekordbox.getRekordboxAgentPid(),
  };
}

/** Apply a validated import plan to an already-open write transaction. */
export function writeRekordboxPlan(
  db: RekordboxMasterDatabase,
  rekordbox: RekordboxLibrary,
  plan: RekordboxImportPlan,
): {
  folderId: string;
  playlistId: string;
  imported: RekordboxImportedItem[];
  installedAnalysis: RekordboxInstalledAnalysis[];
} {
  const folders = db
    .query(rekordbox.DjmdPlaylist)
    .where({ Name: plan.folderName, Attribute: rekordbox.PlaylistType.FOLDER })
    .all();
  if (folders.length > 1)
    throw new Error(`Multiple Rekordbox folders named '${plan.folderName}' exist`);
  const folder = folders[0] ?? db.createPlaylistFolder(plan.folderName);
  const playlists = db
    .query(rekordbox.DjmdPlaylist)
    .where({
      Name: plan.playlistName,
      ParentID: folder.ID,
      Attribute: rekordbox.PlaylistType.PLAYLIST,
    })
    .all();
  if (playlists.length > 1)
    throw new Error(
      `Multiple Rekordbox playlists named '${plan.playlistName}' exist in the folder`,
    );
  const playlist = playlists[0] ?? db.createPlaylist(plan.playlistName, { parent: folder });
  if (playlists[0] && db.hasColumn(playlist.tableName, "updated_at"))
    playlist.set("updated_at", new Date());
  const artists = new Map<string, DjmdArtist>();
  const albums = new Map<string, DjmdAlbum>();
  const labels = new Map<string, DjmdLabel>();
  const existingMemberships = db
    .query(rekordbox.DjmdSongPlaylist)
    .where({ PlaylistID: playlist.ID })
    .all();
  const membershipByContentId = new Map<string, DjmdSongPlaylist>();
  const contentByPath = new Map<string, DjmdContent>();
  const expectedPaths = new Set(plan.items.map((item) => item.mediaPath));
  for (const membership of existingMemberships) {
    if (membershipByContentId.has(membership.ContentID))
      throw new Error(`Duplicate playlist memberships exist for content '${membership.ContentID}'`);
    const content = db.query(rekordbox.DjmdContent).where({ ID: membership.ContentID }).one();
    if (!content.FolderPath || !expectedPaths.has(content.FolderPath))
      throw new Error(
        `Existing playlist '${plan.playlistName}' contains a track outside this manifest`,
      );
    if (contentByPath.has(content.FolderPath))
      throw new Error(`Multiple Rekordbox content rows use '${content.FolderPath}'`);
    membershipByContentId.set(membership.ContentID, membership);
    contentByPath.set(content.FolderPath, content);
  }
  for (const item of plan.items) {
    const artist = findOrCreateNamed(db, rekordbox.DjmdArtist, item.metadata.artist, artists, () =>
      db.addArtist(item.metadata.artist),
    );
    const albumArtist = item.metadata.albumArtist
      ? findOrCreateNamed(db, rekordbox.DjmdArtist, item.metadata.albumArtist, artists, () =>
          db.addArtist(item.metadata.albumArtist!),
        )
      : artist;
    const album = item.metadata.album
      ? findOrCreateAlbum(db, rekordbox.DjmdAlbum, item.metadata.album, albumArtist, albums)
      : undefined;
    const label = item.metadata.label
      ? findOrCreateNamed(db, rekordbox.DjmdLabel, item.metadata.label, labels, () =>
          db.addLabel(item.metadata.label!),
        )
      : undefined;
    const values: Record<string, DatabaseValue> = {
      Title: item.metadata.title,
      ArtistID: artist.ID,
      AlbumID: album?.ID ?? null,
      LabelID: label?.ID ?? null,
      Length: item.metadata.durationSeconds ?? null,
      ISRC: item.metadata.isrc ?? null,
      ReleaseDate: item.metadata.releaseDate ?? null,
      ReleaseYear: item.metadata.releaseYear ?? null,
      Commnt: item.metadata.comment,
      TrackNo: item.entryOrder,
    };
    const cachedContent = contentByPath.get(item.mediaPath);
    const existing = cachedContent
      ? [cachedContent]
      : db.query(rekordbox.DjmdContent).where({ FolderPath: item.mediaPath }).all();
    if (existing.length > 1)
      throw new Error(`Multiple Rekordbox content rows use '${item.mediaPath}'`);
    const content = existing[0] ?? db.addContent(item.mediaPath, values);
    if (existing[0]) setExistingContentMetadata(db, content, values);
    contentByPath.set(item.mediaPath, content);
  }

  const installedAnalysis: RekordboxInstalledAnalysis[] = [];
  try {
    for (const item of plan.items) {
      if (!item.analysisDirectory) continue;
      const content = contentByPath.get(item.mediaPath)!;
      const currentAnalysisPath = content.get("AnalysisDataPath");
      if (
        currentAnalysisPath !== null &&
        currentAnalysisPath !== undefined &&
        currentAnalysisPath !== ""
      ) {
        const synchronized = db.syncContentAnalysisMetadata(content, item.analysisDirectory, {
          allowWhileRunning: false,
          commit: false,
        });
        if (synchronized.contentId !== content.ID)
          throw new Error(
            `Rekordbox analysis metadata was synchronized for the wrong content row '${content.ID}'`,
          );
        continue;
      }
      const installed = db.installContentAnalysis(content, item.analysisDirectory, {
        allowWhileRunning: false,
        commit: false,
        replace: false,
      });
      installedAnalysis.push(installed);
      if (installed.contentId !== content.ID)
        throw new Error(
          `Rekordbox analysis was installed for the wrong content row '${content.ID}'`,
        );
    }

    const imported: RekordboxImportedItem[] = [];
    for (const [index, item] of plan.items.entries()) {
      const content = contentByPath.get(item.mediaPath)!;
      const target = index + 1;
      const existingMembership = membershipByContentId.get(content.ID);
      const membership = existingMembership ?? db.addToPlaylist(playlist, content, target);
      if (existingMembership && membership.TrackNo !== target)
        db.moveSongInPlaylist(playlist, membership, target);
      imported.push({
        key: item.key,
        entryId: item.entryId,
        variantIndex: item.variantIndex,
        mediaPath: item.mediaPath,
        contentId: content.ID,
        membershipId: membership.ID,
        trackNumber: target,
      });
    }
    return {
      folderId: folder.ID,
      playlistId: playlist.ID,
      imported,
      installedAnalysis,
    };
  } catch (error) {
    removeInstalledAnalysis(installedAnalysis);
    throw error;
  }
}

function removeInstalledAnalysis(installed: ReadonlyArray<RekordboxInstalledAnalysis>): void {
  for (const analysis of installed)
    for (const path of Object.values(analysis.paths)) rmSync(path, { force: true });
}

function findOrCreateAlbum(
  db: RekordboxMasterDatabase,
  model: RekordboxModel<DjmdAlbum>,
  name: string,
  artist: DjmdArtist,
  cache: Map<string, DjmdAlbum>,
): DjmdAlbum {
  const key = `${artist.ID}\u0000${name}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const existing = db
    .query(model)
    .where({ Name: name, AlbumArtistID: artist.ID })
    .orderBy("ID")
    .first();
  const album = existing ?? db.addAlbum(name, { artist });
  cache.set(key, album);
  return album;
}

function findOrCreateNamed<row extends DatabaseRow & { ID: string; Name: string | null }>(
  db: RekordboxMasterDatabase,
  model: RekordboxModel<row>,
  name: string,
  cache: Map<string, row>,
  create: () => row,
): row {
  const cached = cache.get(name);
  if (cached) return cached;
  const existing = db.query(model).where({ Name: name }).orderBy("ID").first();
  const row = existing ?? create();
  cache.set(name, row);
  return row;
}

function setExistingContentMetadata(
  db: RekordboxMasterDatabase,
  content: DjmdContent,
  values: Record<string, DatabaseValue>,
): void {
  for (const [key, value] of Object.entries(values))
    if (db.hasColumn(content.tableName, key) && content.get(key) !== value) content.set(key, value);
}

function verifyCommittedImport(
  rekordbox: RekordboxLibrary,
  location: ResolvedDatabaseLocation,
  key: string | undefined,
  folderId: string,
  playlistId: string,
  imported: RekordboxImportedItem[],
  plan: RekordboxImportPlan,
): RekordboxVerification {
  const db = new rekordbox.MasterDatabase({
    path: location.dbPath,
    dbDirectory: location.dbDirectory,
    readonly: true,
    unlock: true,
    ...(key === undefined ? {} : { key }),
  });
  try {
    const quickRows = db.selectRawRows("PRAGMA quick_check");
    const quickValues = quickRows.map((row) => String(Object.values(row)[0]));
    if (quickValues.length !== 1 || quickValues[0]?.toLocaleLowerCase() !== "ok")
      throw new Error(`Rekordbox quick_check failed: ${quickValues.join("; ")}`);
    const foreignKeys = db.selectRawRows("PRAGMA foreign_key_check");
    if (foreignKeys.length)
      throw new Error(`Rekordbox foreign_key_check found ${foreignKeys.length} violation(s)`);
    const folders = db.query(rekordbox.DjmdPlaylist).where({ ID: folderId }).all();
    if (
      folders.length !== 1 ||
      folders[0]!.Name !== plan.folderName ||
      folders[0]!.Attribute !== rekordbox.PlaylistType.FOLDER
    ) {
      throw new Error(`Rekordbox playlist folder verification failed for '${plan.folderName}'`);
    }
    const playlists = db.query(rekordbox.DjmdPlaylist).where({ ID: playlistId }).all();
    if (
      playlists.length !== 1 ||
      playlists[0]!.Name !== plan.playlistName ||
      playlists[0]!.ParentID !== folderId ||
      playlists[0]!.Attribute !== rekordbox.PlaylistType.PLAYLIST
    ) {
      throw new Error(`Rekordbox playlist row verification failed for '${plan.playlistName}'`);
    }
    validateMasterPlaylistSidecar(
      readFileSync(join(location.dbDirectory, "masterPlaylists6.xml"), "utf8"),
      playlistId,
      {
        parentId: folderId,
        attribute: rekordbox.PlaylistType.PLAYLIST,
        parentAttribute: rekordbox.PlaylistType.FOLDER,
      },
    );
    const memberships = db
      .query(rekordbox.DjmdSongPlaylist)
      .where({ PlaylistID: playlistId })
      .orderBy("TrackNo")
      .all();
    if (memberships.length !== imported.length)
      throw new Error(
        `Rekordbox playlist has ${memberships.length} memberships; expected ${imported.length}`,
      );
    const verifiedPaths: string[] = [];
    const verifiedAnalysisPaths: string[] = [];
    const relationCache = new Map<string, DatabaseRow>();
    for (const [index, expected] of imported.entries()) {
      const planned = plan.items[index];
      if (!planned || planned.key !== expected.key)
        throw new Error(`Rekordbox import plan/result mismatch at track ${index + 1}`);
      const membership = memberships[index]!;
      const content = db.query(rekordbox.DjmdContent).where({ ID: membership.ContentID }).one();
      if (
        membership.ID !== expected.membershipId ||
        membership.ContentID !== expected.contentId ||
        membership.TrackNo !== index + 1 ||
        content.FolderPath !== expected.mediaPath
      )
        throw new Error(`Rekordbox membership verification failed at track ${index + 1}`);
      verifyContentMetadata(db, rekordbox, content, planned, relationCache);
      verifiedAnalysisPaths.push(...verifyContentAnalysis(db, rekordbox, content, planned));
      verifiedPaths.push(content.FolderPath);
    }
    return {
      quickCheck: "ok",
      foreignKeyViolationCount: 0,
      playlistSidecarVerified: true,
      expectedMembershipCount: imported.length,
      playlistMembershipCount: memberships.length,
      verifiedMetadataCount: imported.length,
      expectedAnalysisCount: plan.items.filter((item) => item.analysisDirectory !== undefined)
        .length,
      verifiedAnalysisCount: verifiedAnalysisPaths.length / 3,
      verifiedAnalysisPaths,
      verifiedPaths,
    };
  } finally {
    db.close();
  }
}

function verifyContentAnalysis(
  db: RekordboxMasterDatabase,
  rekordbox: RekordboxLibrary,
  content: DjmdContent,
  planned: RekordboxImportItem,
): string[] {
  if (!planned.analysisDirectory) return [];
  const analysisDataPath = content.get("AnalysisDataPath");
  if (
    typeof analysisDataPath !== "string" ||
    !/^[/\\]PIONEER[/\\]USBANLZ[/\\].+[/\\]ANLZ0000\.DAT$/u.test(analysisDataPath)
  )
    throw new Error(`Rekordbox AnalysisDataPath is invalid for '${planned.mediaPath}'`);
  const expectedFlags: Array<[string, string | number]> = [
    ["Analysed", 105],
    ["AnalysisUpdated", "2"],
    ["TrackInfoUpdated", "2"],
  ];
  for (const [column, expected] of expectedFlags)
    if (db.hasColumn(content.tableName, column))
      assertMetadataValue(planned, column, content.get(column), expected);

  const analyzer = rekordbox.readAnalysisMetadata(planned.analysisDirectory);
  if (analyzer.tempoBpm !== null) {
    assertMetadataValue(planned, "BPM", content.get("BPM"), Math.round(analyzer.tempoBpm * 100));
  }
  if (analyzer.key !== null) {
    const keyId = content.get("KeyID");
    if (typeof keyId !== "string" || !keyId)
      throw new Error(`Rekordbox KeyID is missing for '${planned.mediaPath}'`);
    const activeClause = db.hasColumn("djmdKey", "rb_local_deleted")
      ? ' AND ("rb_local_deleted" IS NULL OR "rb_local_deleted" = 0)'
      : "";
    const keys = db.selectRawRows(
      `SELECT "ScaleName" FROM "djmdKey" WHERE "ID" = ?${activeClause}`,
      [keyId],
    );
    if (keys.length !== 1)
      throw new Error(`Rekordbox KeyID '${keyId}' is invalid for '${planned.mediaPath}'`);
    assertMetadataValue(
      planned,
      "Key",
      keys[0]?.ScaleName,
      rekordbox.normalizeRekordboxKeyName(analyzer.key),
    );
  }

  const paths = db.getContentAnlzPaths(content);
  const parsed = db.readContentAnlzFiles(content);
  const verified: string[] = [];
  const expectedMediaPath = planned.mediaPath.replaceAll("\\", "/");
  for (const type of ["DAT", "EXT", "2EX"] as const) {
    const path = paths[type];
    if (!path) throw new Error(`Rekordbox installed analysis has no ANLZ0000.${type}`);
    const fileStat = lstatSync(path);
    if (!fileStat.isFile() || fileStat.isSymbolicLink())
      throw new Error(`Rekordbox installed analysis is not a regular file: ${path}`);
    const file = parsed.get(path);
    if (!file)
      throw new Error(`Rekordbox installed analysis could not be parsed: ANLZ0000.${type}`);
    if (file.get("PPTH") !== expectedMediaPath)
      throw new Error(`Rekordbox installed analysis has the wrong PPTH: ANLZ0000.${type}`);
    verified.push(path);
  }
  if (parsed.size !== 3)
    throw new Error(`Rekordbox installed analysis has ${parsed.size} parsed files; expected 3`);
  return verified;
}

function verifyContentMetadata(
  db: RekordboxMasterDatabase,
  rekordbox: RekordboxLibrary,
  content: DjmdContent,
  planned: RekordboxImportItem,
  relationCache: Map<string, DatabaseRow>,
): void {
  const metadata = planned.metadata;
  assertMetadataValue(planned, "Title", content.Title, metadata.title);
  assertMetadataValue(planned, "ISRC", content.get("ISRC") ?? null, metadata.isrc ?? null);
  assertMetadataValue(
    planned,
    "Length",
    content.get("Length") == null ? null : Number(content.get("Length")),
    metadata.durationSeconds ?? null,
  );
  assertMetadataValue(planned, "Commnt", content.get("Commnt") ?? null, metadata.comment);
  assertMetadataValue(
    planned,
    "ReleaseDate",
    normalizeReleaseDate(content.get("ReleaseDate")),
    normalizeReleaseDate(metadata.releaseDate),
  );
  assertMetadataValue(
    planned,
    "ReleaseYear",
    content.get("ReleaseYear") == null ? null : Number(content.get("ReleaseYear")),
    metadata.releaseYear ?? null,
  );

  const artistId = content.get("ArtistID");
  if (artistId == null) throw new Error(`Rekordbox ArtistID is missing for '${planned.mediaPath}'`);
  const artist = findRelationById(db, rekordbox.DjmdArtist, String(artistId), relationCache);
  assertMetadataValue(planned, "Artist", artist.Name, metadata.artist);

  const album = verifyNamedRelation(
    db,
    rekordbox.DjmdAlbum,
    content.get("AlbumID"),
    metadata.album,
    "Album",
    planned,
    relationCache,
  );
  if (album) {
    const albumArtistId = album.get("AlbumArtistID");
    if (albumArtistId == null) {
      throw new Error(`Rekordbox AlbumArtistID is missing for '${planned.mediaPath}'`);
    }
    const albumArtist = findRelationById(
      db,
      rekordbox.DjmdArtist,
      String(albumArtistId),
      relationCache,
    );
    assertMetadataValue(
      planned,
      "AlbumArtist",
      albumArtist.Name,
      metadata.albumArtist ?? metadata.artist,
    );
  }
  verifyNamedRelation(
    db,
    rekordbox.DjmdLabel,
    content.get("LabelID"),
    metadata.label,
    "Label",
    planned,
    relationCache,
  );
}

function normalizeReleaseDate(value: DatabaseValue | undefined): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/u.exec(text);
  return match?.[3]
    ? `${match[1]}-${match[2]}-${match[3]}`
    : match?.[2]
      ? `${match[1]}-${match[2]}`
      : (match?.[1] ?? text);
}

function verifyNamedRelation<row extends DatabaseRow & { Name: string | null }>(
  db: RekordboxMasterDatabase,
  model: RekordboxModel<row>,
  id: DatabaseValue | undefined,
  expected: string | undefined,
  field: string,
  planned: RekordboxImportItem,
  relationCache: Map<string, DatabaseRow>,
): row | undefined {
  if (expected === undefined) {
    assertMetadataValue(planned, field, id ?? null, null);
    return undefined;
  }
  if (id == null) throw new Error(`Rekordbox ${field}ID is missing for '${planned.mediaPath}'`);
  const row = findRelationById(db, model, String(id), relationCache);
  assertMetadataValue(planned, field, row.Name, expected);
  return row;
}

function findRelationById<row extends DatabaseRow>(
  db: RekordboxMasterDatabase,
  model: RekordboxModel<row>,
  id: string,
  cache: Map<string, DatabaseRow>,
): row {
  const key = `${model.tableName}\u0000${id}`;
  const cached = cache.get(key);
  if (cached) return cached as row;
  const value = db.query(model).where({ ID: id }).one();
  cache.set(key, value);
  return value;
}

function assertMetadataValue(
  planned: RekordboxImportItem,
  field: string,
  actual: unknown,
  expected: unknown,
): void {
  if (!Object.is(actual, expected))
    throw new Error(
      `Rekordbox ${field} mismatch for '${planned.mediaPath}': expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
}

async function writeManifestAtomically(
  path: string,
  manifest: SetManifest,
  expectedSha256: string,
): Promise<void> {
  const directory = dirname(path);
  const pathStat = await stat(path);
  const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", pathStat.mode & 0o777);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const currentSha256 = sha256Bytes(await readFile(path));
    if (currentSha256 !== expectedSha256)
      throw new TracksError(
        "TOOL_FAILED",
        `Manifest '${path}' changed during Rekordbox import; database is committed but manifest was not overwritten`,
      );
    await rename(temporary, path);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function acquireRekordboxDatabaseLock(dbPath: string): Promise<() => Promise<void>> {
  const path = `${dbPath}.tracks-ts.lock`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(path, "wx", 0o600);
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      if (attempt === 0 && (await isStaleRekordboxDatabaseLock(path))) {
        await unlink(path).catch(() => undefined);
        await syncDirectory(dirname(path));
        continue;
      }
      const owner = await readLockOwner(path);
      throw new TracksError(
        "TOOL_FAILED",
        `Rekordbox database import lock already exists: ${path}`,
        { details: { path, owner } },
      );
    }
  }
  if (!handle) throw new TracksError("TOOL_FAILED", `Could not acquire database lock ${path}`);
  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), dbPath })}\n`,
      "utf8",
    );
    await handle.sync();
    await syncDirectory(dirname(path));
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await handle.close();
    } finally {
      await unlink(path).catch(() => undefined);
      await syncDirectory(dirname(path));
    }
  };
}

async function isStaleRekordboxDatabaseLock(path: string): Promise<boolean> {
  const owner = await readLockOwner(path);
  if (owner?.pid && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return isProcessMissingError(error);
    }
  }
  try {
    return Date.now() - (await stat(path)).mtimeMs > 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

async function readLockOwner(
  path: string,
): Promise<{ pid?: number; createdAt?: string } | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.pid === "number" ? { pid: record.pid } : {}),
      ...(typeof record.createdAt === "string" ? { createdAt: record.createdAt } : {}),
    };
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function rekordboxHexId(id: string): string {
  try {
    return BigInt(id).toString(16).toUpperCase();
  } catch (error) {
    throw new Error(`Rekordbox ID is not a decimal integer: ${id}`, { cause: error });
  }
}

function backupTimestamp(iso: string): string {
  return iso.replace(/[-:]/gu, "").replace(".", "-");
}

async function writeExclusiveJson(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedSyncError(error)) throw error;
  } finally {
    await handle?.close();
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isProcessMissingError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function isUnsupportedSyncError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EINVAL" ||
      error.code === "ENOTSUP" ||
      error.code === "EISDIR" ||
      error.code === "EPERM")
  );
}
