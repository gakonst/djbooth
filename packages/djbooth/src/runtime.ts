import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DjLinkServerStatus } from "@gakonst/djlink";

import type { DjBoothServerOptions } from "./serve.js";
import type { SonosBridgeStatus } from "./sonos.js";

export const DJBOOTH_RUNTIME_VERSION = 2 as const;

export type DjBoothRuntimeState = {
  version: typeof DJBOOTH_RUNTIME_VERSION;
  pid: number;
  startedAt: string;
  url: string;
  assistantEnabled: boolean;
  options: DjBoothServerOptions;
  link: (DjLinkServerStatus & { resumed: boolean }) | null;
  logPath: string;
  monitorUrl: string;
  sonos: SonosBridgeStatus | null;
  pairingFile?: string | null;
};

export type DjBoothRuntimeStatus =
  | ({ running: true } & DjBoothRuntimeState)
  | { running: false; staleState: boolean; logPath: string };

export function djBoothRuntimePaths(env: NodeJS.ProcessEnv = process.env): {
  directory: string;
  log: string;
  state: string;
} {
  const directory = env.DJBOOTH_RUNTIME_DIR?.trim() || join(homedir(), ".djtools", "djbooth");
  return { directory, log: join(directory, "serve.log"), state: join(directory, "serve.json") };
}

export async function statusDjBoothRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DjBoothRuntimeStatus> {
  const paths = djBoothRuntimePaths(env);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(paths.state, "utf8"));
  } catch (error) {
    if (isMissing(error)) return { running: false, staleState: false, logPath: paths.log };
    return { running: false, staleState: true, logPath: paths.log };
  }
  const state = parseRuntimeState(value);
  if (!state || !processExists(state.pid)) {
    return { running: false, staleState: true, logPath: paths.log };
  }
  return { running: true, ...state };
}

export async function startManagedDjBoothServer(
  options: DjBoothServerOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DjBoothRuntimeState & { resumed: boolean }> {
  const current = await statusDjBoothRuntime(env);
  if (current.running) {
    if (!sameServerOptions(current.options, options)) {
      throw new Error(
        `djbooth is already running as PID ${String(current.pid)} with different options; run djbooth stop before changing its configuration`,
      );
    }
    return { ...current, resumed: true };
  }
  const paths = djBoothRuntimePaths(env);
  await mkdir(paths.directory, { recursive: true });
  if (current.staleState) await unlink(paths.state).catch(() => undefined);
  const javascript = new URL("./serve-daemon.js", import.meta.url);
  const daemon = existsSync(fileURLToPath(javascript))
    ? javascript
    : new URL("./serve-daemon.ts", import.meta.url);
  const payload = Buffer.from(JSON.stringify(options)).toString("base64url");
  const log = openSync(paths.log, "a");
  let child;
  try {
    child = spawn(process.execPath, [...process.execArgv, fileURLToPath(daemon), payload], {
      detached: true,
      env,
      stdio: ["ignore", log, log],
    });
  } finally {
    closeSync(log);
  }
  if (!child.pid) throw new Error(`Failed to start djbooth; inspect ${paths.log}`);
  child.unref();
  const deadline = Date.now() + (options.sonos ? 45_000 : 20_000);
  while (Date.now() < deadline) {
    const status = await statusDjBoothRuntime(env);
    if (status.running && status.pid === child.pid) return { ...status, resumed: false };
    if (!processExists(child.pid)) break;
    await delay(100);
  }
  if (processExists(child.pid)) process.kill(child.pid, "SIGTERM");
  throw new Error(`djbooth did not become ready; inspect ${paths.log}`);
}

export async function stopManagedDjBoothServer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stopped: boolean; wasRunning: boolean; pid?: number }> {
  const status = await statusDjBoothRuntime(env);
  const paths = djBoothRuntimePaths(env);
  if (!status.running) {
    if (status.staleState) await unlink(paths.state).catch(() => undefined);
    return { stopped: false, wasRunning: false };
  }
  process.kill(status.pid, "SIGTERM");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && processExists(status.pid)) await delay(100);
  const stopped = !processExists(status.pid);
  if (stopped) await unlink(paths.state).catch(() => undefined);
  return { stopped, wasRunning: true, pid: status.pid };
}

function parseRuntimeState(value: unknown): DjBoothRuntimeState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as Partial<DjBoothRuntimeState>;
  if (
    state.version !== DJBOOTH_RUNTIME_VERSION ||
    !Number.isSafeInteger(state.pid) ||
    state.pid! <= 0 ||
    typeof state.startedAt !== "string" ||
    typeof state.url !== "string" ||
    typeof state.assistantEnabled !== "boolean" ||
    typeof state.options !== "object" ||
    state.options === null ||
    typeof state.logPath !== "string" ||
    typeof state.monitorUrl !== "string"
  ) {
    return undefined;
  }
  return { ...(state as DjBoothRuntimeState), sonos: state.sonos ?? null };
}

function sameServerOptions(left: DjBoothServerOptions, right: DjBoothServerOptions): boolean {
  return (
    JSON.stringify(normalizeServerOptions(left)) === JSON.stringify(normalizeServerOptions(right))
  );
}

function normalizeServerOptions(options: DjBoothServerOptions): Required<DjBoothServerOptions> {
  return {
    allowMissingAnalysis: options.allowMissingAnalysis ?? true,
    assistant: options.assistant ?? true,
    binary: options.binary ?? "",
    bindIp: options.bindIp ?? "",
    broadcastIp: options.broadcastIp ?? "",
    databasePath: options.databasePath ?? "",
    host: options.host ?? "127.0.0.1",
    link: options.link ?? true,
    name: options.name ?? "djbooth",
    playerNumber: options.playerNumber ?? 17,
    port: options.port ?? 4179,
    sonos: options.sonos ?? "",
    sonosPort: options.sonosPort ?? 0,
    shareHost: options.shareHost ?? "",
    sharePort: options.sharePort ?? 4184,
    pairingFile: options.pairingFile ?? "",
  };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
