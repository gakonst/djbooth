import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  acquireRekordboxWriteLock,
  DjmdContent,
  DjmdPlaylist,
  MasterDatabase,
  PlaylistType,
} from "../masterdb/index.js";
import {
  checkpointLegacyDeviceHistoryReceipts,
  readLegacyDeviceExportMarker,
  reconcileLegacyDeviceLibrary,
  type LegacyDeviceExportMarker,
  type LegacyDeviceHistoryReceipt,
  type LegacyDeviceLibraryExportResult,
} from "./export.js";
import {
  inspectLegacyDevicePdb,
  type LegacyDevicePdbHistory,
  type LegacyDevicePdbInspection,
} from "./pdb.js";

const EXPORT_PDB = join("PIONEER", "rekordbox", "export.pdb");

type HistoryPlan = {
  fingerprint: string;
  generationId: string;
  history: LegacyDevicePdbHistory;
  contentIds: string[];
  playlistUuid: string;
};

type ImportedHistory = LegacyDeviceHistoryReceipt & {
  created: boolean;
  playCountIncrements: number;
};

/** Options for one complete mounted-USB ↔ master.db reconciliation. */
export type SyncLegacyDeviceLibraryOptions = {
  /** Mounted FAT/exFAT CDJ media root. */
  targetDirectory: string;
  /** Rekordbox `master.db`; defaults to the configured Rekordbox 6/7 database. */
  databasePath?: string;
  /** Optional SQLCipher key override. */
  databaseKey?: string;
  /** Disable SQLCipher setup for an explicitly plain SQLite library. */
  databaseUnlock?: boolean;
  /** Parallel audio-copy workers. */
  copyConcurrency?: number;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
  /** Deterministic clock override for tests. */
  now?: Date;
};

type HistoryImportRuntimeOptions = Pick<
  SyncLegacyDeviceLibraryOptions,
  "databaseKey" | "databaseUnlock" | "signal"
>;

/** One stable DeviceSQL-to-master-library identity used for CDJ history import. */
export type LegacyDeviceHistoryTrackMapping = {
  pdbId: number;
  contentId: string;
};

/** Options for importing mapped CDJ histories without reconciling the complete library. */
export type ImportMappedLegacyDeviceHistoriesOptions = HistoryImportRuntimeOptions & {
  databasePath: string;
  mediaId: string;
  generationId: string;
  histories: readonly LegacyDevicePdbHistory[];
  trackMap: readonly LegacyDeviceHistoryTrackMapping[];
  importedHistories?: readonly LegacyDeviceHistoryReceipt[];
  now?: Date;
};

/** Durable result of a mapped CDJ-history import. */
export type ImportMappedLegacyDeviceHistoriesResult = {
  historiesFound: number;
  historiesImported: number;
  historiesAlreadyImported: number;
  playlistsCreated: Array<{
    historyId: number;
    historyName: string;
    playlistId: string;
    playlistName: string;
    tracks: number;
  }>;
  playCountIncrements: number;
  receipts: LegacyDeviceHistoryReceipt[];
};

/** Result of importing new histories and differentially reconciling mounted CDJ media. */
export type SyncLegacyDeviceLibraryResult = {
  schemaVersion: 1;
  format: "legacy-device-library-sync";
  databasePath: string;
  targetDirectory: string;
  historiesFound: number;
  historiesImported: number;
  historiesAlreadyImported: number;
  playlistsCreated: Array<{
    historyId: number;
    historyName: string;
    playlistId: string;
    playlistName: string;
    tracks: number;
  }>;
  playCountIncrements: number;
  export: LegacyDeviceLibraryExportResult;
};

/**
 * Import every unseen CDJ history, then make exporter-owned USB media match master.db.
 *
 * History playlists are deterministic commit receipts. Retrying after a crash can therefore
 * finish the USB half without creating a second playlist or incrementing play counts twice.
 */
export async function syncLegacyDeviceLibrary(
  options: SyncLegacyDeviceLibraryOptions,
): Promise<SyncLegacyDeviceLibraryResult> {
  throwIfAborted(options.signal);
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("Sync clock is invalid");
  const targetDirectory = await realpath(resolve(options.targetDirectory));
  const marker = await readLegacyDeviceExportMarker(targetDirectory);
  const inspection = await readCurrentInspection(targetDirectory);
  const histories = inspection?.histories ?? [];
  if (histories.length && marker?.schemaVersion !== 2)
    throw new Error(
      "USB contains CDJ history but has no stable music-ts track mapping; refusing to overwrite or guess track identities",
    );

  const markerV2 = marker?.schemaVersion === 2 ? marker : undefined;
  const plans = markerV2 ? planHistories(markerV2, inspection, histories) : [];
  const priorFingerprints = new Set(
    markerV2?.importedHistories.map(({ fingerprint }) => fingerprint) ?? [],
  );
  const unseen = plans.filter(({ fingerprint }) => !priorFingerprints.has(fingerprint));
  const databasePath = await resolveDatabasePath(options);
  const imported = unseen.length
    ? await importHistoryPlans(databasePath, unseen, now, options)
    : { histories: [] };
  const receipts = mergeReceipts(
    markerV2?.importedHistories ?? [],
    imported.histories.map(({ created: _, playCountIncrements: __, ...receipt }) => receipt),
  );
  const checkpointedMarker =
    markerV2 && !sameReceiptSet(markerV2.importedHistories, receipts)
      ? await checkpointLegacyDeviceHistoryReceipts(targetDirectory, markerV2, receipts)
      : markerV2;
  const forceGeneration =
    checkpointedMarker?.importedHistories.some(
      ({ generationId }) => generationId === checkpointedMarker.generationId,
    ) ?? false;

  throwIfAborted(options.signal);
  const exported = await reconcileLegacyDeviceLibrary({
    targetDirectory,
    databasePath,
    databaseKey: options.databaseKey,
    databaseUnlock: options.databaseUnlock,
    replace: marker !== null,
    copyConcurrency: options.copyConcurrency,
    signal: options.signal,
    generatedAt: now,
    consumeHistories: true,
    importedHistories: receipts,
    forceGeneration,
  });
  return {
    schemaVersion: 1,
    format: "legacy-device-library-sync",
    databasePath,
    targetDirectory,
    historiesFound: histories.length,
    historiesImported: imported.histories.filter(({ created }) => created).length,
    historiesAlreadyImported:
      plans.length - unseen.length + imported.histories.filter(({ created }) => !created).length,
    playlistsCreated: imported.histories
      .filter(({ created }) => created)
      .map(({ historyId, historyName, playlistId, playlistName, tracks }) => ({
        historyId,
        historyName,
        playlistId,
        playlistName,
        tracks,
      })),
    playCountIncrements: imported.histories.reduce(
      (sum, history) => sum + history.playCountIncrements,
      0,
    ),
    export: exported,
  };
}

/**
 * Import mapped CDJ histories into `master.db` without exporting unrelated host playlists.
 *
 * Deterministic playlist UUIDs make a retry idempotent across the database-commit/USB-checkpoint
 * boundary. The caller persists `receipts` before consuming the history rows on the device.
 */
export async function importMappedLegacyDeviceHistories(
  options: ImportMappedLegacyDeviceHistoriesOptions,
): Promise<ImportMappedLegacyDeviceHistoriesResult> {
  throwIfAborted(options.signal);
  if (!options.mediaId.length || !options.generationId.length)
    throw new TypeError("CDJ history import requires stable media and generation identities");
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError("History import clock is invalid");
  const databasePath = await realpath(resolve(options.databasePath));
  const plans = planMappedHistories(
    options.mediaId,
    options.generationId,
    options.histories,
    options.trackMap,
  );
  const prior = options.importedHistories ?? [];
  const priorFingerprints = new Set(prior.map(({ fingerprint }) => fingerprint));
  const unseen = plans.filter(({ fingerprint }) => !priorFingerprints.has(fingerprint));
  const imported = unseen.length
    ? await importHistoryPlans(databasePath, unseen, now, options)
    : { histories: [] };
  const receipts = mergeReceipts(
    prior,
    imported.histories.map(({ created: _, playCountIncrements: __, ...receipt }) => receipt),
  );
  return {
    historiesFound: options.histories.length,
    historiesImported: imported.histories.filter(({ created }) => created).length,
    historiesAlreadyImported:
      plans.length - unseen.length + imported.histories.filter(({ created }) => !created).length,
    playlistsCreated: imported.histories
      .filter(({ created }) => created)
      .map(({ historyId, historyName, playlistId, playlistName, tracks }) => ({
        historyId,
        historyName,
        playlistId,
        playlistName,
        tracks,
      })),
    playCountIncrements: imported.histories.reduce(
      (sum, history) => sum + history.playCountIncrements,
      0,
    ),
    receipts,
  };
}

async function resolveDatabasePath(options: SyncLegacyDeviceLibraryOptions): Promise<string> {
  const database = new MasterDatabase({
    ...(options.databasePath ? { path: options.databasePath } : {}),
    ...(options.databaseKey ? { key: options.databaseKey } : {}),
    unlock: options.databaseUnlock ?? true,
    readonly: true,
  });
  try {
    return await realpath(database.path);
  } finally {
    database.close();
  }
}

async function readCurrentInspection(
  targetDirectory: string,
): Promise<LegacyDevicePdbInspection | undefined> {
  try {
    return inspectLegacyDevicePdb(await readFile(join(targetDirectory, EXPORT_PDB)));
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function planHistories(
  marker: LegacyDeviceExportMarker,
  inspection: LegacyDevicePdbInspection | undefined,
  histories: readonly LegacyDevicePdbHistory[],
): HistoryPlan[] {
  if (!inspection && histories.length) throw new Error("CDJ history exists without export.pdb");
  const inspectedTracks = new Map(inspection?.tracks.map((track) => [track.id, track]) ?? []);
  const contentByPdbId = new Map<number, string>();
  for (const mapping of marker.trackMap) {
    const track = inspectedTracks.get(mapping.pdbId);
    if (!track || track.filePath !== mapping.usbAudioPath)
      throw new Error(
        `USB track ${String(mapping.pdbId)} no longer matches its stable master-library identity`,
      );
    contentByPdbId.set(mapping.pdbId, mapping.contentId);
  }
  return planMappedHistories(
    marker.mediaId,
    marker.generationId,
    histories,
    [...contentByPdbId].map(([pdbId, contentId]) => ({ pdbId, contentId })),
  );
}

function planMappedHistories(
  mediaId: string,
  generationId: string,
  histories: readonly LegacyDevicePdbHistory[],
  trackMap: readonly LegacyDeviceHistoryTrackMapping[],
): HistoryPlan[] {
  const contentByPdbId = new Map<number, string>();
  for (const mapping of trackMap) {
    if (!Number.isSafeInteger(mapping.pdbId) || mapping.pdbId < 1 || !mapping.contentId.length)
      throw new TypeError("Invalid mapped CDJ history track identity");
    const existing = contentByPdbId.get(mapping.pdbId);
    if (existing && existing !== mapping.contentId)
      throw new Error(`DeviceSQL track ${String(mapping.pdbId)} has conflicting master identities`);
    contentByPdbId.set(mapping.pdbId, mapping.contentId);
  }
  return histories
    .filter(({ trackIds }) => trackIds.length > 0)
    .map((history) => {
      const contentIds = history.trackIds.map((trackId) => {
        const contentId = contentByPdbId.get(trackId);
        if (!contentId)
          throw new Error(
            `History '${history.name}' references unmapped USB track ${String(trackId)}`,
          );
        return contentId;
      });
      const fingerprint = historyFingerprint(mediaId, generationId, history);
      return {
        fingerprint,
        generationId,
        history,
        contentIds,
        playlistUuid: deterministicUuid(`music-ts:cdj-history:${fingerprint}`),
      };
    });
}

function historyFingerprint(
  mediaId: string,
  generationId: string,
  history: LegacyDevicePdbHistory,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        mediaId,
        generationId,
        historyId: history.id,
        historyName: history.name,
        trackIds: history.trackIds,
      }),
    )
    .digest("hex");
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function importHistoryPlans(
  databasePath: string,
  plans: readonly HistoryPlan[],
  now: Date,
  options: HistoryImportRuntimeOptions,
): Promise<{ histories: ImportedHistory[] }> {
  const lock = await acquireRekordboxWriteLock(databasePath);
  try {
    const preflight = inspectHistoryCommitState(
      databasePath,
      plans,
      options.databaseKey,
      options.databaseUnlock ?? true,
    );
    if (!preflight.pending.length)
      return {
        histories: preflight.committed.map((history) => ({
          ...history,
          created: false,
          playCountIncrements: 0,
        })),
      };

    const writer = openDatabase(
      databasePath,
      options.databaseKey,
      options.databaseUnlock ?? true,
      false,
    );
    const committed: ImportedHistory[] = [];
    const expectedCounts = new Map<string, number>();
    try {
      requireHistorySchema(writer);
      const reservedNames = new Set(
        writer
          .query(DjmdPlaylist)
          .all()
          .map(({ Name }) => Name)
          .filter((name): name is string => typeof name === "string"),
      );
      for (const recovered of preflight.committed)
        committed.push({ ...recovered, created: false, playCountIncrements: 0 });
      for (const plan of preflight.pending) {
        throwIfAborted(options.signal);
        const existing = writer.query(DjmdPlaylist).where({ UUID: plan.playlistUuid }).all();
        if (existing.length) {
          const receipt = verifyCommittedPlan(writer, plan, existing);
          committed.push({ ...receipt, created: false, playCountIncrements: 0 });
          continue;
        }
        const playlistName = nextDjSetName(reservedNames, now);
        reservedNames.add(playlistName);
        const playlist = writer.createPlaylist(playlistName, { uuid: plan.playlistUuid });
        for (const [index, contentId] of plan.contentIds.entries()) {
          const content = requireActiveContent(writer, contentId);
          writer.addToPlaylist(playlist, content, index + 1);
          const current = expectedCounts.get(contentId) ?? parsePlayCount(content.DJPlayCount);
          const next = current + 1;
          content.DJPlayCount = String(next);
          expectedCounts.set(contentId, next);
        }
        committed.push({
          fingerprint: plan.fingerprint,
          generationId: plan.generationId,
          historyId: plan.history.id,
          historyName: plan.history.name,
          importedAt: now.toISOString(),
          playlistId: playlist.ID,
          playlistName,
          tracks: plan.contentIds.length,
          created: true,
          playCountIncrements: plan.contentIds.length,
        });
      }
      writer.commit();
    } catch (error) {
      throw new Error(`CDJ history import failed: ${asError(error).message}`, { cause: error });
    } finally {
      writer.close();
    }

    verifyHistoryCommit(
      databasePath,
      plans,
      expectedCounts,
      options.databaseKey,
      options.databaseUnlock ?? true,
    );
    return { histories: committed };
  } finally {
    await lock.release();
  }
}

function inspectHistoryCommitState(
  databasePath: string,
  plans: readonly HistoryPlan[],
  key: string | undefined,
  unlock: boolean,
): {
  committed: LegacyDeviceHistoryReceipt[];
  pending: HistoryPlan[];
} {
  const database = openDatabase(databasePath, key, unlock, true);
  try {
    requireHistorySchema(database);
    const committed: LegacyDeviceHistoryReceipt[] = [];
    const pending: HistoryPlan[] = [];
    for (const plan of plans) {
      const existing = database.query(DjmdPlaylist).where({ UUID: plan.playlistUuid }).all();
      if (!existing.length) {
        for (const contentId of new Set(plan.contentIds)) requireActiveContent(database, contentId);
        pending.push(plan);
        continue;
      }
      committed.push(verifyCommittedPlan(database, plan, existing));
    }
    return { committed, pending };
  } finally {
    database.close();
  }
}

function verifyCommittedPlan(
  database: MasterDatabase,
  plan: HistoryPlan,
  playlists: DjmdPlaylist[],
): LegacyDeviceHistoryReceipt {
  if (playlists.length !== 1)
    throw new Error(`History receipt UUID '${plan.playlistUuid}' is not unique`);
  const playlist = playlists[0]!;
  if (Number(playlist.Attribute) !== PlaylistType.PLAYLIST)
    throw new Error(`History receipt '${playlist.ID}' is not a normal playlist`);
  const actual = database.getPlaylistTracks(playlist.ID).map(({ contentId }) => contentId);
  if (JSON.stringify(actual) !== JSON.stringify(plan.contentIds))
    throw new Error(`History receipt playlist '${playlist.ID}' does not match the USB history`);
  return {
    fingerprint: plan.fingerprint,
    generationId: plan.generationId,
    historyId: plan.history.id,
    historyName: plan.history.name,
    importedAt: new Date().toISOString(),
    playlistId: playlist.ID,
    playlistName: playlist.Name ?? "DJ Set",
    tracks: plan.contentIds.length,
  };
}

function verifyHistoryCommit(
  databasePath: string,
  plans: readonly HistoryPlan[],
  expectedCounts: ReadonlyMap<string, number>,
  key: string | undefined,
  unlock: boolean,
): void {
  const database = openDatabase(databasePath, key, unlock, true);
  try {
    const quickCheck = database.selectRawRows("PRAGMA quick_check");
    if (
      quickCheck.length !== 1 ||
      String(Object.values(quickCheck[0] ?? {})[0]).toLocaleLowerCase() !== "ok"
    )
      throw new Error("Rekordbox quick_check failed after CDJ history import");
    const foreignKeys = database.selectRawRows("PRAGMA foreign_key_check");
    if (foreignKeys.length)
      throw new Error(
        `Rekordbox foreign_key_check found ${String(foreignKeys.length)} violation(s) after CDJ history import`,
      );
    for (const plan of plans) {
      const playlists = database.query(DjmdPlaylist).where({ UUID: plan.playlistUuid }).all();
      verifyCommittedPlan(database, plan, playlists);
    }
    for (const [contentId, count] of expectedCounts) {
      const content = database.query(DjmdContent).where({ ID: contentId }).one();
      if (parsePlayCount(content.DJPlayCount) !== count)
        throw new Error(`Track '${contentId}' play count failed exact verification`);
    }
  } finally {
    database.close();
  }
}

function openDatabase(
  path: string,
  key: string | undefined,
  unlock: boolean,
  readonly: boolean,
): MasterDatabase {
  return new MasterDatabase({
    path,
    dbDirectory: dirname(path),
    key,
    readonly,
    unlock,
  });
}

function requireHistorySchema(database: MasterDatabase): void {
  for (const [table, columns] of [
    ["djmdContent", ["ID", "DJPlayCount"]],
    ["djmdPlaylist", ["ID", "Name", "Attribute", "ParentID", "Seq", "UUID"]],
    ["djmdSongPlaylist", ["ID", "PlaylistID", "ContentID", "TrackNo"]],
  ] as const) {
    if (!database.hasTable(table)) throw new Error(`Rekordbox database has no '${table}' table`);
    for (const column of columns)
      if (!database.hasColumn(table, column))
        throw new Error(`Rekordbox database '${table}' has no '${column}' column`);
  }
}

function requireActiveContent(database: MasterDatabase, contentId: string): DjmdContent {
  const rows = database.query(DjmdContent).where({ ID: contentId }).all();
  if (rows.length !== 1) throw new Error(`USB history track '${contentId}' is not in the library`);
  const content = rows[0]!;
  if (
    database.hasColumn("djmdContent", "rb_local_deleted") &&
    Number(content.get("rb_local_deleted") ?? 0) !== 0
  )
    throw new Error(`USB history track '${contentId}' was deleted from the library`);
  return content;
}

function parsePlayCount(value: unknown): number {
  const count = Number.parseInt(String(value ?? "0"), 10);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function nextDjSetName(reserved: ReadonlySet<string>, date: Date): string {
  const base = `DJ Set ${localDate(date)}`;
  if (!reserved.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix++) {
    const candidate = `${base} (${String(suffix)})`;
    if (!reserved.has(candidate)) return candidate;
  }
  throw new Error(`Could not allocate a unique playlist name for '${base}'`);
}

function localDate(date: Date): string {
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function mergeReceipts(
  previous: readonly LegacyDeviceHistoryReceipt[],
  next: readonly LegacyDeviceHistoryReceipt[],
): LegacyDeviceHistoryReceipt[] {
  const receipts = new Map(previous.map((receipt) => [receipt.fingerprint, receipt]));
  for (const receipt of next) receipts.set(receipt.fingerprint, receipt);
  return [...receipts.values()];
}

function sameReceiptSet(
  left: readonly LegacyDeviceHistoryReceipt[],
  right: readonly LegacyDeviceHistoryReceipt[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Sync aborted", "AbortError");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
