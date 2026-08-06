import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";

import type { DjLinkDaemonState, DjLinkServerStatus, DjLinkStoppedStatus } from "./types.js";

const requestTimeoutMs = 5_000;

export type RuntimePaths = {
  root: string;
  state: string;
  snapshot: string;
  socket: string;
  log: string;
  output: string;
};

type ControlResponse<T> = {
  id: string;
  ok: boolean;
  result?: T;
  error?: string;
};

export type NativeStatus = {
  pid: number;
  bindIp: string;
  broadcastIp: string;
  playerNumber: number;
  stagehandSessionIp?: string;
  stagehandSessionNonce?: string;
  stagehandProtocolNonce?: string;
  tracks: number;
  playlists: number;
  uptimeMs: number;
  remoteTransportSupported: boolean;
  remoteDeckPreparationSupported?: boolean;
};

/** Typed DJ Link lifecycle/runtime failure. */
export class DjLinkError extends Error {
  constructor(
    readonly code:
      | "NATIVE_MISSING"
      | "NOT_RUNNING"
      | "ALREADY_RUNNING"
      | "START_FAILED"
      | "CONTROL_FAILED"
      | "DEVICE_NOT_FOUND"
      | "INVALID_STATE"
      | "VALIDATION_FAILED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DjLinkError";
  }
}

/** Read daemon state and verify it through the protected local control socket. */
export async function statusDjLink(
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<DjLinkServerStatus | DjLinkStoppedStatus> {
  const paths = runtimePaths(options.env ?? process.env);
  const state = await readState(paths.state);
  if (!state) return { running: false, staleState: false };
  if (!validStatePaths(state, paths) || !processExists(state.pid)) {
    return { running: false, staleState: true };
  }
  try {
    const native = await requestControl<NativeStatus>(paths.socket, "status");
    return toServerStatus(state, native);
  } catch {
    return { running: false, staleState: true };
  }
}

export async function requestControl<T>(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = requestTimeoutMs,
): Promise<T> {
  const id = randomUUID();
  return new Promise<T>((resolveRequest, rejectRequest) => {
    const socket = createConnection(socketPath);
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      rejectRequest(new DjLinkError("CONTROL_FAILED", `${method} timed out`));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    socket.on("data", (chunk: string) => {
      response += chunk;
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      socket.end();
      try {
        const envelope = JSON.parse(response.slice(0, newline)) as ControlResponse<T>;
        if (envelope.id !== id) {
          rejectRequest(new DjLinkError("CONTROL_FAILED", `${method} response id mismatch`));
        } else if (!envelope.ok || envelope.result === undefined) {
          rejectRequest(
            new DjLinkError("CONTROL_FAILED", envelope.error ?? `${method} request failed`),
          );
        } else resolveRequest(envelope.result);
      } catch (error) {
        rejectRequest(
          error instanceof DjLinkError
            ? error
            : new DjLinkError("CONTROL_FAILED", `${method} returned invalid JSON`, {
                cause: error,
              }),
        );
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      rejectRequest(new DjLinkError("CONTROL_FAILED", `${method} failed`, { cause: error }));
    });
  });
}

export function runtimePaths(env: NodeJS.ProcessEnv): RuntimePaths {
  const root = resolve(
    env.DJBOOTH_DJLINK_STATE_DIR ??
      env.MUSIC_DJLINK_STATE_DIR ??
      resolve(env.XDG_STATE_HOME ?? resolve(homedir(), ".local/state"), "djbooth/djlink"),
  );
  return {
    root,
    state: resolve(root, "daemon.json"),
    snapshot: resolve(root, "library.json"),
    socket: resolve(root, "control.sock"),
    log: resolve(root, "server.log"),
    output: resolve(root, "native-output.log"),
  };
}

export async function readState(path: string): Promise<DjLinkDaemonState | undefined> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const value: Record<string, unknown> =
      raw.schemaVersion === 1 &&
      typeof raw.manifestPath === "string" &&
      typeof raw.snapshotPath === "string"
        ? { ...raw, schemaVersion: 2, sourceKind: "manifest", sourcePath: raw.manifestPath }
        : raw;
    if (
      value.schemaVersion !== 2 ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) <= 0 ||
      (value.sourceKind !== "manifest" && value.sourceKind !== "rekordbox") ||
      typeof value.sourcePath !== "string" ||
      (value.snapshotPath !== undefined && typeof value.snapshotPath !== "string") ||
      (value.sourceKind === "manifest" && typeof value.snapshotPath !== "string") ||
      typeof value.socketPath !== "string" ||
      typeof value.logPath !== "string" ||
      typeof value.outputPath !== "string" ||
      typeof value.binaryPath !== "string" ||
      typeof value.startedAt !== "string"
    ) {
      throw new DjLinkError("INVALID_STATE", `Invalid DJ Link daemon state: ${path}`);
    }
    return value as DjLinkDaemonState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof DjLinkError) throw error;
    throw new DjLinkError("INVALID_STATE", `Could not read DJ Link daemon state: ${path}`, {
      cause: error,
    });
  }
}

export function validStatePaths(state: DjLinkDaemonState, paths: RuntimePaths): boolean {
  return (
    (state.snapshotPath === undefined || resolve(state.snapshotPath) === paths.snapshot) &&
    resolve(state.socketPath) === paths.socket &&
    resolve(state.logPath) === paths.log &&
    resolve(state.outputPath) === paths.output
  );
}

export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function toServerStatus(state: DjLinkDaemonState, native: NativeStatus): DjLinkServerStatus {
  return {
    running: true,
    pid: native.pid,
    sourceKind: state.sourceKind,
    sourcePath: state.sourcePath,
    ...(state.snapshotPath ? { snapshotPath: state.snapshotPath } : {}),
    socketPath: state.socketPath,
    logPath: state.logPath,
    bindIp: native.bindIp,
    broadcastIp: native.broadcastIp,
    playerNumber: native.playerNumber,
    tracks: native.tracks,
    playlists: native.playlists,
    uptimeMs: native.uptimeMs,
    remoteTransportSupported: native.remoteTransportSupported === true,
    remoteDeckPreparationSupported: native.remoteDeckPreparationSupported === true,
  };
}
