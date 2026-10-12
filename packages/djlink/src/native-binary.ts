import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { resolve } from "node:path";

/** A rerun must launch a rebuilt helper instead of resuming the old process. */
export async function canResumeNativeBinary(
  selected: string,
  running: { binaryPath: string; startedAt: string } | undefined,
): Promise<boolean> {
  if (!running || resolve(selected) !== resolve(running.binaryPath)) return false;
  const started = Date.parse(running.startedAt);
  if (!Number.isFinite(started)) return false;
  return (await stat(selected)).mtimeMs <= started;
}

/** Explicit paths retain priority; default builds compete by freshness. */
export async function selectNativeBinary(
  overrides: readonly (string | undefined)[],
  defaults: readonly string[],
): Promise<string | undefined> {
  async function executable(path: string) {
    const absolute = resolve(path);
    try {
      await access(absolute, constants.X_OK);
      const info = await stat(absolute);
      return info.isFile() ? { path: absolute, modified: info.mtimeMs } : undefined;
    } catch {
      return undefined;
    }
  }

  for (const path of overrides) {
    if (!path) continue;
    const candidate = await executable(path);
    if (candidate) return candidate.path;
  }
  const candidates = await Promise.all(defaults.map(executable));
  return candidates
    .filter((candidate) => candidate !== undefined)
    .sort((a, b) => b.modified - a.modified)[0]?.path;
}
