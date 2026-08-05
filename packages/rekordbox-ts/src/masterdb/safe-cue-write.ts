import { randomUUID } from "node:crypto";
import { lstat, open, readFile, realpath, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { MasterDatabase } from "./database.js";
import type {
  ContentCueInput,
  ContentCueKind,
  ContentCuePoint,
  ContentCueType,
  HotCueSlot,
} from "./database.js";

const staleLockAgeMs = 24 * 60 * 60 * 1_000;

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
  key?: string;
  unlock?: boolean;
};

type ReceiptBase = {
  operation: GuardedCueMutation["type"];
  contentId: string;
  changedId: string;
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

/** Acquire the cross-process lock shared by every direct Rekordbox library writer. */
export async function acquireRekordboxWriteLock(
  dbPath: string,
): Promise<{ path: string; release: () => Promise<void> }> {
  return acquireCueWriteLock(dbPath);
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

/** Apply one cue mutation behind the shared lock, then verify the committed database. */
export async function performGuardedCueMutation(
  options: GuardedCueWriteOptions,
  mutation: GuardedCueMutation,
): Promise<GuardedCueMutationReceipt> {
  const dbPath = await realpath(resolve(options.dbPath));
  const lock = await acquireCueWriteLock(dbPath);
  let committed = false;
  try {
    const writer = openDatabase(dbPath, options, false);
    let expectation: CueExpectation;
    let deleted: ContentCuePoint | undefined;
    let changedId: string;
    try {
      const cueUpdated = nextCueUpdated(writer, mutation.contentId);
      if (mutation.type === "set-cue") {
        const cue = writer.upsertContentCue(
          mutation.contentId,
          desiredCueInput(writer, mutation.contentId, mutation.cue),
        );
        expectation = { state: "present", cue, cueUpdated };
        changedId = cue.id;
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
        changedId = mutation.cueId;
      }
      writer.commit();
      committed = true;
    } finally {
      writer.close();
    }

    verify(dbPath, options, expectation);

    const base: ReceiptBase = {
      operation: mutation.type,
      contentId: mutation.contentId,
      changedId,
      quickCheck: "ok",
      foreignKeyViolationCount: 0,
      semanticVerification: "exact",
      finishedAt: new Date().toISOString(),
    };
    return mutation.type === "set-cue"
      ? {
          ...base,
          operation: "set-cue",
          cue: expectation.state === "present" ? expectation.cue : never(),
        }
      : { ...base, operation: "delete-cue", deleted: deleted! };
  } catch (error) {
    throw new Error(
      `Cue mutation '${mutation.type}' failed${committed ? " after commit" : ""}: ${asError(error).message}`,
      { cause: error },
    );
  } finally {
    await lock.release();
  }
}

function never(): never {
  throw new Error("Unreachable cue expectation");
}
