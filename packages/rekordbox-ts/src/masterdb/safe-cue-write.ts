import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { getRekordboxAgentPid, getRekordboxPid } from "../utils.js";
import { MasterDatabase } from "./database.js";
import type {
  ContentCueInput,
  ContentCueKind,
  ContentCuePoint,
  ContentCueType,
  HotCueSlot,
} from "./database.js";

const staleLockAgeMs = 24 * 60 * 60 * 1_000;

type ProcessState = {
  rekordboxPid: number;
  rekordboxAgentPid: number;
};

type BackupFile = {
  name: string;
  sourcePath: string;
  backupPath: string;
  bytes: number;
  sha256: string;
};

type CueWriteBackup = {
  directory: string;
  reportPath: string;
  files: Array<BackupFile>;
};

type JournalStage = {
  status: "pending" | "in-progress" | "succeeded" | "failed";
  finishedAt?: string;
  message?: string;
};

type CueWriteJournal = {
  schemaVersion: 1;
  mutationId: string;
  dbPath: string;
  backupDirectory: string;
  backupReportPath: string;
  startedAt: string;
  updatedAt: string;
  intent: GuardedCueMutation;
  changedId?: string;
  stages: {
    database: JournalStage;
    verification: JournalStage;
    receipt: JournalStage;
  };
  outcome?: {
    status: "succeeded" | "failed";
    committed: boolean;
    error?: { name: string; message: string };
  };
  receipt?: GuardedCueMutationReceipt;
};

type CueExpectation =
  | { state: "present"; cue: ContentCuePoint; cueUpdated?: string }
  | { state: "absent"; contentId: string; cueId: string; cueUpdated?: string };

/** Patch semantics used by guarded cue upserts; omitted fields preserve an existing cue. */
export type ContentCuePatch = {
  activeLoop?: boolean;
  color?: number | null;
  colorTableIndex?: number | null;
  comment?: string;
  endSeconds?: number | null;
  id?: string;
  kind?: ContentCueKind;
  slot?: HotCueSlot;
  startSeconds: number;
  type?: ContentCueType;
};

/** Cue mutation accepted by the guarded CLI write boundary. */
export type GuardedCueMutation =
  | { type: "set-cue"; contentId: string; cue: ContentCuePatch }
  | { type: "delete-cue"; contentId: string; cueId: string };

/** Testable options for one guarded cue mutation. */
export type GuardedCueWriteOptions = {
  dbPath: string;
  backupRoot?: string;
  key?: string;
  unlock?: boolean;
  getProcessState?: () => ProcessState;
};

type ReceiptBase = {
  operation: GuardedCueMutation["type"];
  contentId: string;
  changedId: string;
  backupDirectory: string;
  backupReportPath: string;
  backupFiles: Array<{ name: string; bytes: number; sha256: string }>;
  journalPath: string;
  quickCheck: "ok";
  foreignKeyViolationCount: 0;
  semanticVerification: "exact";
  finishedAt: string;
};

/** Recovery-oriented result emitted only after read-only integrity and semantic verification. */
export type GuardedCueMutationReceipt =
  | (ReceiptBase & { operation: "set-cue"; cue: ContentCuePoint })
  | (ReceiptBase & { operation: "delete-cue"; deleted: ContentCuePoint });

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String(error.code) : undefined;
}

function stage(status: JournalStage["status"], error?: unknown): JournalStage {
  return {
    status,
    ...(status === "pending" || status === "in-progress"
      ? {}
      : { finishedAt: new Date().toISOString() }),
    ...(error === undefined ? {} : { message: asError(error).message }),
  };
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

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function writeJson(path: string, value: unknown, exclusive = false): Promise<void> {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (exclusive) {
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(dirname(path));
    return;
  }

  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function backupSources(dbPath: string): Array<{ name: string; path: string; required: boolean }> {
  const directory = dirname(dbPath);
  const name = basename(dbPath);
  return [
    { name, path: dbPath, required: true },
    { name: `${name}-wal`, path: `${dbPath}-wal`, required: false },
    { name: `${name}-shm`, path: `${dbPath}-shm`, required: false },
    { name: `${name}-journal`, path: `${dbPath}-journal`, required: false },
    {
      name: "masterPlaylists6.xml",
      path: join(directory, "masterPlaylists6.xml"),
      required: false,
    },
  ];
}

async function createBackup(
  dbPath: string,
  mutationId: string,
  backupRoot?: string,
): Promise<CueWriteBackup> {
  const root = resolve(backupRoot ?? join(dirname(dbPath), "tracks-ts-backups"));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, "");
  const directory = join(root, `rekordbox-${timestamp}-${mutationId}`);
  await mkdir(directory, { mode: 0o700 });
  await syncDirectory(root);

  const files: Array<BackupFile> = [];
  for (const source of backupSources(dbPath)) {
    let before;
    try {
      before = await stat(source.path);
    } catch (error) {
      if (!source.required && errorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (!before.isFile()) throw new TypeError(`Backup source '${source.path}' is not a file`);
    const sourceSha256Before = await sha256File(source.path);
    const backupPath = join(directory, source.name);
    await copyFile(source.path, backupPath, constants.COPYFILE_EXCL);
    await syncFile(backupPath);
    const [after, copied, sourceSha256After, copiedSha256] = await Promise.all([
      stat(source.path),
      stat(backupPath),
      sha256File(source.path),
      sha256File(backupPath),
    ]);
    if (
      before.size !== after.size ||
      before.size !== copied.size ||
      sourceSha256Before !== sourceSha256After ||
      sourceSha256Before !== copiedSha256
    )
      throw new Error(`Backup source changed while copying: ${source.path}`);
    files.push({
      name: source.name,
      sourcePath: source.path,
      backupPath,
      bytes: copied.size,
      sha256: copiedSha256,
    });
  }

  const reportPath = join(directory, "backup.json");
  await writeJson(
    reportPath,
    {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      dbPath,
      files,
    },
    true,
  );
  await syncDirectory(directory);
  return { directory, reportPath, files };
}

async function readLockOwner(path: string): Promise<{ pid?: number; [key: string]: unknown }> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as { pid?: number }) : {};
  } catch {
    return {};
  }
}

async function staleLock(path: string): Promise<boolean> {
  const owner = await readLockOwner(path);
  if (Number.isSafeInteger(owner.pid) && (owner.pid ?? 0) > 0) {
    try {
      process.kill(owner.pid!, 0);
      return false;
    } catch (error) {
      return errorCode(error) === "ESRCH";
    }
  }
  try {
    return Date.now() - (await stat(path)).mtimeMs > staleLockAgeMs;
  } catch {
    return false;
  }
}

/** Acquire the same `${dbPath}.tracks-ts.lock` used by every direct library writer. */
export async function acquireCueWriteLock(
  dbPath: string,
): Promise<{ path: string; release: () => Promise<void> }> {
  const normalized = await realpath(resolve(dbPath));
  const path = `${normalized}.tracks-ts.lock`;
  const guard = await acquireCueWriteLockGuard(path);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const token = randomUUID();
  try {
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (await staleLock(path)) {
        await unlink(path).catch(() => undefined);
        await syncDirectory(dirname(path));
        handle = await open(path, "wx", 0o600);
      } else {
        const owner = await readLockOwner(path);
        throw new Error(
          `Rekordbox database write lock already exists: ${path}; owner: ${JSON.stringify(owner)}`,
        );
      }
    }
    if (!handle) throw new Error(`Could not acquire Rekordbox database write lock: ${path}`);
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString(), dbPath: normalized })}\n`,
      "utf8",
    );
    await handle.sync();
    await syncDirectory(dirname(path));
  } catch (error) {
    if (handle) await closeAndRemoveOwnedFile(path, handle, undefined).catch(() => undefined);
    throw error;
  } finally {
    await guard.release();
  }

  let released = false;
  return {
    path,
    release: async () => {
      if (released) return;
      const releaseGuard = await acquireCueWriteLockGuard(path);
      try {
        released = true;
        await closeAndRemoveOwnedFile(path, handle, token);
      } finally {
        await releaseGuard.release();
      }
    },
  };
}

async function acquireCueWriteLockGuard(lockPath: string): Promise<{ release(): Promise<void> }> {
  const path = `${lockPath}.acquire`;
  const token = randomUUID();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt <= 200; attempt += 1) {
    try {
      handle = await open(path, "wx", 0o600);
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (attempt === 200)
        throw new Error(
          `Rekordbox database lock acquisition guard already exists: ${path}; owner: ${JSON.stringify(await readLockOwner(path))}`,
        );
      await delay(10);
    }
  }
  if (!handle) throw new Error(`Could not acquire Rekordbox database lock guard: ${path}`);
  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString(), lockPath })}\n`,
      "utf8",
    );
    await handle.sync();
    await syncDirectory(dirname(path));
  } catch (error) {
    await closeAndRemoveOwnedFile(path, handle, undefined).catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      const removed = await closeAndRemoveOwnedFile(path, handle, token);
      if (!removed)
        throw new Error(`Rekordbox database lock acquisition guard ownership changed: ${path}`);
    },
  };
}

async function closeAndRemoveOwnedFile(
  path: string,
  handle: Awaited<ReturnType<typeof open>>,
  token: string | undefined,
): Promise<boolean> {
  const owned = await pathReferencesOwnedFile(path, handle, token);
  await handle.close();
  if (!owned) return false;
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  await syncDirectory(dirname(path));
  return true;
}

async function pathReferencesOwnedFile(
  path: string,
  handle: Awaited<ReturnType<typeof open>>,
  token: string | undefined,
): Promise<boolean> {
  try {
    const [pathStats, handleStats, owner] = await Promise.all([
      lstat(path),
      handle.stat(),
      token === undefined ? undefined : readLockOwner(path),
    ]);
    return (
      pathStats.dev === handleStats.dev &&
      pathStats.ino === handleStats.ino &&
      (token === undefined || owner?.token === token)
    );
  } catch {
    return false;
  }
}

function defaultProcessState(): ProcessState {
  return {
    rekordboxPid: getRekordboxPid(),
    rekordboxAgentPid: getRekordboxAgentPid(),
  };
}

function assertStopped(state: ProcessState): void {
  const running = [
    state.rekordboxPid ? `rekordbox (PID ${state.rekordboxPid})` : undefined,
    state.rekordboxAgentPid ? `rekordboxAgent (PID ${state.rekordboxAgentPid})` : undefined,
  ].filter((value): value is string => value !== undefined);
  if (running.length)
    throw new Error(
      `Close Rekordbox and rekordboxAgent before writing; running: ${running.join(", ")}`,
    );
}

function openDatabase(
  dbPath: string,
  options: GuardedCueWriteOptions,
  readonly: boolean,
): MasterDatabase {
  return new MasterDatabase({
    path: dbPath,
    readonly,
    unlock: options.unlock ?? true,
    key: options.key,
  });
}

function exactCue(actual: ContentCuePoint, expected: ContentCuePoint): boolean {
  return (
    actual.id === expected.id &&
    actual.contentId === expected.contentId &&
    actual.kind === expected.kind &&
    actual.slot === expected.slot &&
    actual.type === expected.type &&
    actual.startSeconds === expected.startSeconds &&
    actual.endSeconds === expected.endSeconds &&
    actual.comment === expected.comment &&
    actual.color === expected.color &&
    actual.colorTableIndex === expected.colorTableIndex &&
    actual.activeLoop === expected.activeLoop
  );
}

function nextCueUpdated(database: MasterDatabase, contentId: string): string | undefined {
  if (!database.hasTable("djmdContent") || !database.hasColumn("djmdContent", "CueUpdated"))
    return undefined;
  const rows = database.selectRawRows(
    `SELECT "CueUpdated" AS value FROM "djmdContent" WHERE "ID" = ?`,
    [contentId],
  );
  if (rows.length !== 1) throw new Error(`Content '${contentId}' was not found`);
  const current = Number.parseInt(String(rows[0]?.value ?? "0"), 10);
  return String(Number.isSafeInteger(current) && current >= 0 ? current + 1 : 1);
}

/** Verify that every active contentCue mirror entry exactly matches its normalized djmdCue row. */
export function assertContentCueMirrorMatches(database: MasterDatabase, contentId: string): void {
  if (!database.hasTable("contentCue")) return;
  const rows = database.selectRawRows(`SELECT * FROM "contentCue" WHERE "ContentID" = ?`, [
    contentId,
  ]);
  const active = rows.filter(
    (row) => row.rb_local_deleted == null || Number(row.rb_local_deleted) === 0,
  );
  if (active.length !== 1)
    throw new Error(
      `Content '${contentId}' has ${active.length} active contentCue mirror rows after commit`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(active[0]?.Cues ?? ""));
  } catch (error) {
    throw new Error(`Content '${contentId}' has malformed contentCue.Cues JSON`, { cause: error });
  }
  if (!Array.isArray(parsed))
    throw new Error(`Content '${contentId}' contentCue.Cues mirror is not an array`);
  const mirrored = parsed.map((entry): ContentCuePoint => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`Content '${contentId}' contentCue.Cues contains a non-object entry`);
    const object = entry as Record<string, unknown>;
    if (String(object.ContentID) !== contentId)
      throw new Error(`Content '${contentId}' contentCue.Cues contains a foreign content ID`);
    if (object.ID == null)
      throw new Error(`Content '${contentId}' contentCue.Cues contains an entry without an ID`);
    const kind = Number(object.Kind);
    const startMsec = Number(object.InMsec);
    const endMsec = object.OutMsec == null ? -1 : Number(object.OutMsec);
    const color = object.Color == null ? -1 : Number(object.Color);
    if (!Number.isInteger(kind) || kind < 0 || kind > 16)
      throw new Error(`Content '${contentId}' contentCue.Cues contains an invalid cue kind`);
    return {
      activeLoop: endMsec >= 0 && Number(object.ActiveLoop ?? 0) !== 0,
      color: color < 0 ? null : color,
      colorTableIndex: object.ColorTableIndex == null ? null : Number(object.ColorTableIndex),
      comment: String(object.Comment ?? ""),
      contentId: String(object.ContentID),
      endSeconds: endMsec < 0 ? null : endMsec / 1_000,
      id: String(object.ID),
      kind: kind === 0 ? "memory" : "hot",
      slot: kind === 0 ? null : (kind as HotCueSlot),
      startSeconds: startMsec / 1_000,
      type: endMsec < 0 ? "cue" : "loop",
    };
  });
  const expected = database.getContentCues(contentId);
  if (mirrored.length !== expected.length)
    throw new Error(`Content '${contentId}' contentCue.Cues count does not match active cues`);
  const mirroredById = new Map<string, ContentCuePoint>();
  for (const cue of mirrored) {
    if (!cue.id || mirroredById.has(cue.id))
      throw new Error(`Content '${contentId}' contentCue.Cues has a missing or duplicate cue ID`);
    mirroredById.set(cue.id, cue);
  }
  for (const cue of expected) {
    const mirror = mirroredById.get(cue.id);
    if (!mirror || !exactCue(mirror, cue))
      throw new Error(`Content '${contentId}' contentCue.Cues mismatch for cue '${cue.id}'`);
  }
}

function desiredCueInput(
  database: MasterDatabase,
  contentId: string,
  patch: ContentCuePatch,
): ContentCueInput {
  const cues = database.getContentCues(contentId);
  let existing: ContentCuePoint | undefined;
  if (patch.id !== undefined) {
    existing = cues.find(({ id }) => id === patch.id);
    if (!existing) throw new Error(`No active cue '${patch.id}' belongs to content '${contentId}'`);
  } else if (patch.kind === "hot" && patch.slot !== undefined) {
    existing = cues.find(({ kind, slot }) => kind === "hot" && slot === patch.slot);
  }

  const kind = patch.kind ?? existing?.kind ?? "memory";
  const type = patch.type ?? existing?.type ?? "cue";
  const slot = patch.slot ?? (existing?.kind === "hot" ? existing.slot : undefined);
  if (kind === "memory" && patch.slot !== undefined)
    throw new TypeError("Memory cues do not accept --slot");

  const endSeconds =
    patch.endSeconds !== undefined
      ? patch.endSeconds
      : type === "loop" && existing?.type === "loop"
        ? existing.endSeconds
        : undefined;
  const activeLoop =
    patch.activeLoop ??
    (type === "loop" && existing?.type === "loop" ? existing.activeLoop : false);
  const common = {
    activeLoop,
    color: patch.color !== undefined ? patch.color : existing?.color,
    colorTableIndex:
      patch.colorTableIndex !== undefined ? patch.colorTableIndex : existing?.colorTableIndex,
    comment: patch.comment !== undefined ? patch.comment : existing?.comment,
    endSeconds,
    id: patch.id,
    startSeconds: patch.startSeconds,
    type,
  };
  if (kind === "hot") {
    if (slot == null) throw new TypeError("Hot Cues require --slot A through P");
    return { ...common, kind, slot };
  }
  return { ...common, kind };
}

function verify(
  dbPath: string,
  options: GuardedCueWriteOptions,
  expectation: CueExpectation,
): void {
  const database = openDatabase(dbPath, options, true);
  try {
    const quickRows = database.selectRawRows("PRAGMA quick_check");
    const quickValues = quickRows.map((row) => String(Object.values(row)[0]));
    if (quickValues.length !== 1 || quickValues[0]?.toLocaleLowerCase() !== "ok")
      throw new Error(`Rekordbox quick_check failed: ${quickValues.join("; ")}`);
    const foreignKeys = database.selectRawRows("PRAGMA foreign_key_check");
    if (foreignKeys.length)
      throw new Error(`Rekordbox foreign_key_check found ${foreignKeys.length} violation(s)`);

    const cues = database.getContentCues(
      expectation.state === "present" ? expectation.cue.contentId : expectation.contentId,
    );
    const contentId =
      expectation.state === "present" ? expectation.cue.contentId : expectation.contentId;
    if (expectation.state === "present") {
      const actual = cues.find(({ id }) => id === expectation.cue.id);
      if (!actual || !exactCue(actual, expectation.cue))
        throw new Error(`Cue '${expectation.cue.id}' failed exact semantic verification`);
    } else if (cues.some(({ id }) => id === expectation.cueId))
      throw new Error(`Deleted cue '${expectation.cueId}' is still active after commit`);
    assertContentCueMirrorMatches(database, contentId);
    if (expectation.cueUpdated !== undefined) {
      const rows = database.selectRawRows(
        `SELECT "CueUpdated" AS value FROM "djmdContent" WHERE "ID" = ?`,
        [contentId],
      );
      if (rows.length !== 1 || String(rows[0]?.value) !== expectation.cueUpdated)
        throw new Error(`Content '${contentId}' CueUpdated did not increment exactly once`);
    }
  } finally {
    database.close();
  }
}

/**
 * Apply exactly one cue mutation behind the shared lock, stopped-process checks, durable backup,
 * one database commit, outcome journal, and read-only integrity/semantic verification.
 */
export async function performGuardedCueMutation(
  options: GuardedCueWriteOptions,
  mutation: GuardedCueMutation,
): Promise<GuardedCueMutationReceipt> {
  const dbPath = await realpath(resolve(options.dbPath));
  const getProcessState = options.getProcessState ?? defaultProcessState;
  const lock = await acquireCueWriteLock(dbPath);
  let backup: CueWriteBackup | undefined;
  let journal: CueWriteJournal | undefined;
  let journalPath: string | undefined;
  let committed = false;
  try {
    assertStopped(getProcessState());
    const mutationId = randomUUID();
    backup = await createBackup(dbPath, mutationId, options.backupRoot);
    const startedAt = new Date().toISOString();
    journalPath = join(backup.directory, `cue-mutation-${mutationId}.json`);
    journal = {
      schemaVersion: 1,
      mutationId,
      dbPath,
      backupDirectory: backup.directory,
      backupReportPath: backup.reportPath,
      startedAt,
      updatedAt: startedAt,
      intent: mutation,
      stages: {
        database: stage("pending"),
        verification: stage("pending"),
        receipt: stage("pending"),
      },
    };
    await writeJson(journalPath, journal, true);

    assertStopped(getProcessState());
    const writer = openDatabase(dbPath, options, false);
    let expectation: CueExpectation;
    let deleted: ContentCuePoint | undefined;
    try {
      const cueUpdated = nextCueUpdated(writer, mutation.contentId);
      if (mutation.type === "set-cue") {
        const cue = writer.upsertContentCue(
          mutation.contentId,
          desiredCueInput(writer, mutation.contentId, mutation.cue),
        );
        expectation = { state: "present", cue, cueUpdated };
        journal.changedId = cue.id;
      } else {
        deleted = writer.getContentCues(mutation.contentId).find(({ id }) => id === mutation.cueId);
        if (!deleted)
          throw new Error(
            `No active cue '${mutation.cueId}' belongs to content '${mutation.contentId}'`,
          );
        writer.deleteContentCue(mutation.contentId, mutation.cueId);
        expectation = {
          state: "absent",
          contentId: mutation.contentId,
          cueId: mutation.cueId,
          cueUpdated,
        };
        journal.changedId = mutation.cueId;
      }
      journal.stages.database = stage("in-progress");
      journal.updatedAt = new Date().toISOString();
      await writeJson(journalPath, journal);
      assertStopped(getProcessState());
      writer.commit({ allowWhileRunning: false });
      committed = true;
    } finally {
      writer.close();
    }

    journal.stages.database = stage("succeeded");
    journal.stages.verification = stage("in-progress");
    journal.updatedAt = new Date().toISOString();
    await writeJson(journalPath, journal);
    verify(dbPath, options, expectation);
    journal.stages.verification = stage("succeeded");

    const base: ReceiptBase = {
      operation: mutation.type,
      contentId: mutation.contentId,
      changedId: journal.changedId!,
      backupDirectory: backup.directory,
      backupReportPath: backup.reportPath,
      backupFiles: backup.files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })),
      journalPath,
      quickCheck: "ok",
      foreignKeyViolationCount: 0,
      semanticVerification: "exact",
      finishedAt: new Date().toISOString(),
    };
    const receipt: GuardedCueMutationReceipt =
      mutation.type === "set-cue"
        ? {
            ...base,
            operation: "set-cue",
            cue: expectation.state === "present" ? expectation.cue : never(),
          }
        : { ...base, operation: "delete-cue", deleted: deleted! };
    journal.receipt = receipt;
    journal.outcome = { status: "succeeded", committed: true };
    journal.stages.receipt = stage("succeeded");
    journal.updatedAt = new Date().toISOString();
    await writeJson(journalPath, journal);
    return receipt;
  } catch (error) {
    let failure: unknown = error;
    if (journal && journalPath) {
      journal.stages.database = committed ? stage("succeeded") : stage("failed", error);
      if (journal.stages.verification.status === "in-progress")
        journal.stages.verification = stage("failed", error);
      else if (!committed) journal.stages.verification = stage("failed", error);
      journal.stages.receipt = stage("failed", error);
      const normalized = asError(error);
      journal.outcome = {
        status: "failed",
        committed,
        error: { name: normalized.name, message: normalized.message },
      };
      journal.updatedAt = new Date().toISOString();
      try {
        await writeJson(journalPath, journal);
      } catch (journalError) {
        failure = new AggregateError(
          [normalized, asError(journalError)],
          "Cue mutation failed and its outcome journal could not be updated",
        );
      }
    }
    const recovery = backup
      ? `; recovery backup: ${backup.directory}; outcome journal: ${journalPath}`
      : "";
    throw new Error(
      `Guarded cue mutation '${mutation.type}' failed${committed ? " after commit" : " before commit"}: ${asError(failure).message}${recovery}`,
      { cause: failure },
    );
  } finally {
    await lock.release();
  }
}

function never(): never {
  throw new Error("Unreachable cue expectation");
}
