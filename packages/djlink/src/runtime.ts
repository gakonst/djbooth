import { spawn } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { resolve } from "node:path";

import { getConfig } from "@gakonst/rekordbox";

import { buildDjLinkSnapshot, resolveDjLinkTrack, writeDjLinkSnapshot } from "./snapshot.js";
import {
  DjLinkError,
  processExists,
  readState,
  requestControl,
  runtimePaths,
  statusDjLink,
  toServerStatus,
  validStatePaths,
  type NativeStatus,
  type RuntimePaths,
} from "./control.js";
import type {
  DjLinkDaemonState,
  DjLinkArpProbeResult,
  DjLinkBrowseResult,
  DjLinkDevice,
  DjLinkDoctorResult,
  DjLinkLoadResult,
  DjLinkMonitorResult,
  DjLinkPrepareResult,
  DjLinkRunResult,
  DjLinkSearchMode,
  DjLinkSearchResult,
  DjLinkRekordboxReport,
  DjLinkServerStatus,
  DjLinkSnapshot,
  DjLinkSourceKind,
} from "./types.js";

const startTimeoutMs = 30_000;
const requestTimeoutMs = 5_000;
const loadRequestTimeoutMs = 10_000;

type NativeDoctorOutput = {
  ok: boolean;
  tracks: number;
  playlists: number;
  analysis: { dat: number; ext: number; twoEx: number };
  missingAudio: string[];
  missingAnalysis: string[];
  rekordbox?: DjLinkRekordboxReport;
};

export type StartDjLinkOptions = {
  manifestPath: string;
  binaryPath?: string;
  bindIp?: string;
  broadcastIp?: string;
  name?: string;
  playerNumber?: number;
  stagehandSessionNonce?: string;
  allowMissingAnalysis?: boolean;
  env?: NodeJS.ProcessEnv;
};

export type DoctorDjLinkOptions = Pick<
  StartDjLinkOptions,
  "manifestPath" | "binaryPath" | "allowMissingAnalysis" | "env"
>;

export type StartRekordboxDjLinkOptions = Omit<StartDjLinkOptions, "manifestPath"> & {
  databasePath?: string;
};

export type DoctorRekordboxDjLinkOptions = Pick<
  StartRekordboxDjLinkOptions,
  "databasePath" | "binaryPath" | "allowMissingAnalysis" | "env"
>;

export type LoadDjLinkOptions = {
  selector: string;
  player: number;
  repeat?: number;
  intervalMs?: number;
  env?: NodeJS.ProcessEnv;
};

export type PrepareDjLinkOptions = LoadDjLinkOptions & {
  bpm: number;
  barsBefore?: number;
};

export type ListDjLinkDevicesOptions = {
  waitMs?: number;
  env?: NodeJS.ProcessEnv;
};

export type ProbeDjLinkDeviceOptions = {
  ip: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export type SearchDjLinkOptions = {
  query: string;
  mode?: DjLinkSearchMode;
  limit?: number;
  env?: NodeJS.ProcessEnv;
};

export type RunDjLinkOptions = StartDjLinkOptions & {
  selector: string;
  player: number;
  waitMs?: number;
  repeat?: number;
  intervalMs?: number;
};

export type RunRekordboxDjLinkOptions = StartRekordboxDjLinkOptions & {
  selector: string;
  player: number;
  waitMs?: number;
  repeat?: number;
  intervalMs?: number;
};

export type BrowseRekordboxDjLinkOptions = StartRekordboxDjLinkOptions & {
  waitMs?: number;
};

type DjLinkSource = {
  kind: DjLinkSourceKind;
  path: string;
  snapshot?: DjLinkSnapshot;
};

export { DjLinkError, statusDjLink } from "./control.js";

/** Validate a manifest projection through the imported native implementation. */
export async function doctorDjLink(options: DoctorDjLinkOptions): Promise<DjLinkDoctorResult> {
  const snapshot = await buildDjLinkSnapshot(options.manifestPath);
  const sourcePath = resolve(options.manifestPath);
  const env = options.env ?? process.env;
  const binaryPath = await resolveDjLinkBinary(options.binaryPath, env);
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "djbooth-djlink-doctor-"));
  const snapshotPath = resolve(temporaryRoot, "library.json");
  try {
    await writeDjLinkSnapshot(snapshotPath, snapshot);
    const result = await runNativeDoctor(
      binaryPath,
      ["--snapshot", snapshotPath],
      !options.allowMissingAnalysis,
      env,
    );
    return toDoctorResult(result, { kind: "manifest", path: sourcePath, snapshot }, binaryPath);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/** Validate the complete active Rekordbox master library directly and read-only. */
export async function doctorRekordboxDjLink(
  options: DoctorRekordboxDjLinkOptions = {},
): Promise<DjLinkDoctorResult> {
  const env = options.env ?? process.env;
  const databasePath = resolveRekordboxDatabasePath(options.databasePath);
  const binaryPath = await resolveDjLinkBinary(options.binaryPath, env);
  const result = await runNativeDoctor(
    binaryPath,
    ["--rekordbox-db", databasePath],
    !options.allowMissingAnalysis,
    env,
  );
  return toDoctorResult(result, { kind: "rekordbox", path: databasePath }, binaryPath);
}

/** Start one detached local DJ Link source from a durable tracks manifest. */
export async function startDjLink(
  options: StartDjLinkOptions,
): Promise<DjLinkServerStatus & { resumed: boolean }> {
  assertDarwin();
  const manifestPath = resolve(options.manifestPath);
  const resumed = await resumeOrRestartDjLink("manifest", manifestPath, options);
  if (resumed) return resumed;
  const snapshot = await buildDjLinkSnapshot(manifestPath);
  return startDjLinkSource({ kind: "manifest", path: manifestPath, snapshot }, options);
}

/** Start one detached source backed directly by the discovered Rekordbox master.db. */
export async function startRekordboxDjLink(
  options: StartRekordboxDjLinkOptions = {},
): Promise<DjLinkServerStatus & { resumed: boolean }> {
  assertDarwin();
  const databasePath = resolveRekordboxDatabasePath(options.databasePath);
  const resumed = await resumeOrRestartDjLink("rekordbox", databasePath, options);
  if (resumed) return resumed;
  return startDjLinkSource({ kind: "rekordbox", path: databasePath }, options);
}

async function startDjLinkSource(
  source: DjLinkSource,
  options: Omit<StartDjLinkOptions, "manifestPath">,
): Promise<DjLinkServerStatus & { resumed: boolean }> {
  const env = options.env ?? process.env;
  const paths = runtimePaths(env);
  const binaryPath = await resolveDjLinkBinary(options.binaryPath, env);
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await clearConfirmedStaleRuntime(paths);
  if (source.snapshot) await writeDjLinkSnapshot(paths.snapshot, source.snapshot);
  const nativeSourceArgs = source.snapshot
    ? ["--snapshot", paths.snapshot]
    : ["--rekordbox-db", source.path];
  const requireAnalysis =
    source.kind === "manifest"
      ? !options.allowMissingAnalysis
      : options.allowMissingAnalysis === false;
  const doctor = await runNativeDoctor(binaryPath, nativeSourceArgs, requireAnalysis, env);
  if (!doctor.ok) {
    throw new DjLinkError(
      "VALIDATION_FAILED",
      `DJ Link validation failed: missing audio=${doctor.missingAudio.length}, missing analysis=${doctor.missingAnalysis.length}`,
    );
  }
  const stagehandTarget = await discoverStagehandTarget(env);
  assertStagehandSessionNonce(options.stagehandSessionNonce);

  const args = [
    "link",
    "serve",
    ...nativeSourceArgs,
    "--socket",
    paths.socket,
    "--name",
    options.name ?? "music",
    "--player-number",
    String(options.playerNumber ?? 17),
    "--log-path",
    paths.log,
    "--stagehand-monitor",
    ...(options.stagehandSessionNonce
      ? ["--stagehand-session-nonce", options.stagehandSessionNonce]
      : []),
    ...(stagehandTarget
      ? ["--stagehand-target-ip", stagehandTarget.ip, "--stagehand-target-mac", stagehandTarget.mac]
      : []),
    ...(options.bindIp ? ["--bind-ip", options.bindIp] : []),
    ...(options.broadcastIp ? ["--broadcast-ip", options.broadcastIp] : []),
    ...(requireAnalysis ? ["--require-analysis"] : []),
  ];
  const output = openSync(paths.output, "a", 0o600);
  const child = spawn(binaryPath, args, {
    detached: true,
    env,
    stdio: ["ignore", output, output],
  });
  closeSync(output);

  try {
    await waitForControlSocket(paths.socket, child.pid, startTimeoutMs);
    const native = await requestControl<NativeStatus>(paths.socket, "status");
    const state: DjLinkDaemonState = {
      schemaVersion: 2,
      pid: child.pid!,
      sourceKind: source.kind,
      sourcePath: source.path,
      ...(source.snapshot ? { snapshotPath: paths.snapshot } : {}),
      socketPath: paths.socket,
      logPath: paths.log,
      outputPath: paths.output,
      binaryPath,
      startedAt: new Date().toISOString(),
    };
    await writeState(paths.state, state);
    child.unref();
    return {
      ...toServerStatus(state, native),
      resumed: false,
    };
  } catch (error) {
    if (child.pid && processExists(child.pid)) child.kill("SIGTERM");
    throw new DjLinkError("START_FAILED", `DJ Link failed to start; inspect ${paths.output}`, {
      cause: error,
    });
  }
}

async function resumeOrRestartDjLink(
  sourceKind: DjLinkSourceKind,
  sourcePath: string,
  options: Omit<StartDjLinkOptions, "manifestPath">,
): Promise<(DjLinkServerStatus & { resumed: true }) | undefined> {
  const env = options.env ?? process.env;
  const current = await statusDjLink({ env });
  if (!current.running) return undefined;
  if (current.sourceKind !== sourceKind || resolve(current.sourcePath) !== resolve(sourcePath)) {
    throw new DjLinkError(
      "ALREADY_RUNNING",
      `DJ Link is already serving ${current.sourceKind} source ${current.sourcePath}; stop it before switching sources`,
    );
  }
  const explicitConfigurationMatches =
    (options.bindIp === undefined || options.bindIp === current.bindIp) &&
    (options.broadcastIp === undefined || options.broadcastIp === current.broadcastIp) &&
    (options.playerNumber === undefined || options.playerNumber === current.playerNumber);
  const native = await requestControl<NativeStatus>(current.socketPath, "status");
  const stagehandSessionMatches =
    options.stagehandSessionNonce === undefined ||
    native.stagehandSessionNonce === options.stagehandSessionNonce;
  if (
    explicitConfigurationMatches &&
    stagehandSessionMatches &&
    shouldResumeDjLinkBind(current.bindIp, options.bindIp, localIpv4Addresses())
  ) {
    return { ...current, resumed: true };
  }
  const stopped = await stopDjLink({ env });
  if (!stopped.stopped) {
    throw new DjLinkError(
      "START_FAILED",
      `DJ Link source ${sourcePath} needs a network restart but process ${String(current.pid)} did not stop`,
    );
  }
  return undefined;
}

function assertStagehandSessionNonce(value: string | undefined): void {
  if (value === undefined) return;
  if (!/^\d+$/.test(value) || BigInt(value) > 0xffff_ffff_ffff_ffffn) {
    throw new TypeError(`Invalid Stagehand session nonce: ${value}`);
  }
}

function toDoctorResult(
  result: NativeDoctorOutput,
  source: DjLinkSource,
  binaryPath: string,
): DjLinkDoctorResult {
  return {
    ok: result.ok,
    tracks: result.tracks,
    playlists: result.playlists,
    analysis: result.analysis,
    missingAudio: result.missingAudio,
    missingAnalysis: result.missingAnalysis,
    binaryPath,
    sourceKind: source.kind,
    sourcePath: source.path,
    omittedEntries: source.snapshot?.omittedEntries ?? [],
    ...(result.rekordbox ? { rekordbox: result.rekordbox } : {}),
  };
}

/** Resolve an explicit or auto-discovered Rekordbox 7/6 master.db path. */
export function resolveRekordboxDatabasePath(databasePath?: string): string {
  if (databasePath) return resolve(databasePath);
  const configuration = getConfig("rekordbox7") ?? getConfig("rekordbox6");
  if (!configuration?.dbPath) {
    throw new DjLinkError("INVALID_STATE", "No Rekordbox 6/7 master.db was supplied or discovered");
  }
  return resolve(configuration.dbPath);
}

/** List currently discovered CDJs from the running DJ Link source. */
export async function listDjLinkDevices(
  options: ListDjLinkDevicesOptions = {},
): Promise<{ devices: DjLinkDevice[] }> {
  const state = await requireRunningState(options.env ?? process.env);
  const deadline = Date.now() + (options.waitMs ?? 0);
  while (true) {
    const result = await requestControl<{ devices: DjLinkDevice[] }>(state.socketPath, "devices");
    if (result.devices.length > 0 || Date.now() >= deadline) return result;
    await delay(Math.min(250, Math.max(1, deadline - Date.now())));
  }
}

/** Safely test whether one address answers ARP on the running DJ Link interface. */
export async function probeDjLinkDevice(
  options: ProbeDjLinkDeviceOptions,
): Promise<DjLinkArpProbeResult> {
  const state = await requireRunningState(options.env ?? process.env);
  return requestControl<DjLinkArpProbeResult>(state.socketPath, "probeArp", {
    ip: options.ip,
    timeoutMs: options.timeoutMs ?? 750,
  });
}

/** Return the latest status/beat/position summaries for one player. */
export async function monitorDjLink(
  player: number,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<DjLinkMonitorResult> {
  const state = await requireRunningState(options.env ?? process.env);
  return requestControl<DjLinkMonitorResult>(state.socketPath, "monitor", { player });
}

/** Search the running source's prewarmed RemoteDB library without changing deck state. */
export async function searchDjLink(options: SearchDjLinkOptions): Promise<DjLinkSearchResult> {
  const state = await requireRunningState(options.env ?? process.env);
  return requestControl<DjLinkSearchResult>(state.socketPath, "search", {
    query: options.query,
    mode: options.mode ?? "track",
    limit: options.limit ?? 20,
  });
}

/** Resolve and load one local recording onto a discovered player. */
export async function loadDjLinkTrack(options: LoadDjLinkOptions): Promise<DjLinkLoadResult> {
  const env = options.env ?? process.env;
  const state = await requireRunningState(env);
  let track: NativeResolvedTrack;
  if (state.sourceKind === "manifest") {
    if (!state.snapshotPath) {
      throw new DjLinkError("INVALID_STATE", "Manifest-backed DJ Link state has no snapshot path");
    }
    track = resolveDjLinkTrack(await readSnapshot(state.snapshotPath), options.selector);
  } else {
    track = await requestControl<NativeResolvedTrack>(state.socketPath, "resolveTrack", {
      selector: options.selector,
    });
  }
  const result = await requestControl<NativeLoadResult>(
    state.socketPath,
    "load",
    {
      player: options.player,
      trackId: track.trackId,
      repeat: options.repeat ?? 3,
      intervalMs: options.intervalMs ?? 250,
    },
    loadRequestTimeoutMs,
  );
  return {
    ...result,
    order: track.order,
    title: track.title,
    artist: track.artist,
  };
}

/** Load at a phrase-aware cue and set the target player tempo through DJ Link Sync. */
export async function prepareDjLinkTrack(
  options: PrepareDjLinkOptions,
): Promise<DjLinkPrepareResult> {
  const env = options.env ?? process.env;
  const state = await requireRunningState(env);
  let track: NativeResolvedTrack;
  if (state.sourceKind === "manifest") {
    if (!state.snapshotPath) {
      throw new DjLinkError("INVALID_STATE", "Manifest-backed DJ Link state has no snapshot path");
    }
    track = resolveDjLinkTrack(await readSnapshot(state.snapshotPath), options.selector);
  } else {
    track = await requestControl<NativeResolvedTrack>(state.socketPath, "resolveTrack", {
      selector: options.selector,
    });
  }
  const bpmHundreds = Math.round(options.bpm * 100);
  if (!Number.isSafeInteger(bpmHundreds) || bpmHundreds < 4_000 || bpmHundreds > 30_000) {
    throw new DjLinkError("CONTROL_FAILED", "BPM must be between 40.00 and 300.00");
  }
  const result = await requestControl<NativePrepareResult>(
    state.socketPath,
    "prepare",
    {
      player: options.player,
      trackId: track.trackId,
      bpmHundreds,
      barsBefore: options.barsBefore ?? 1,
      repeat: options.repeat ?? 3,
      intervalMs: options.intervalMs ?? 250,
    },
    15_000,
  );
  return {
    ...result,
    order: track.order,
    title: track.title,
    artist: track.artist,
  };
}

/** Validate, start/resume, discover, load, and start one manifest track. */
export async function runDjLink(options: RunDjLinkOptions): Promise<DjLinkRunResult> {
  const doctor = await doctorDjLink(options);
  const server = await startDjLink(options);
  const devices = await requireDjLinkDevices(server, options.waitMs, options.env);
  requireDjLinkPlayer(devices, options.player);
  const load = await loadDjLinkTrack({
    selector: options.selector,
    player: options.player,
    ...(options.repeat === undefined ? {} : { repeat: options.repeat }),
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    env: options.env,
  });
  return { doctor, server, devices, load };
}

/** Validate/start the full Rekordbox library and require visible connected decks. */
export async function browseRekordboxDjLink(
  options: BrowseRekordboxDjLinkOptions = {},
): Promise<DjLinkBrowseResult> {
  const doctor = await doctorRekordboxDjLink(options);
  const server = await startRekordboxDjLink(options);
  const devices = await requireDjLinkDevices(server, options.waitMs, options.env);
  return { doctor, server, devices };
}

/** Validate/start the full Rekordbox library, discover a deck, and cue one database track. */
export async function runRekordboxDjLink(
  options: RunRekordboxDjLinkOptions,
): Promise<DjLinkRunResult> {
  const { doctor, server, devices } = await browseRekordboxDjLink(options);
  requireDjLinkPlayer(devices, options.player);
  const load = await loadDjLinkTrack({
    selector: options.selector,
    player: options.player,
    ...(options.repeat === undefined ? {} : { repeat: options.repeat }),
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    env: options.env,
  });
  return { doctor, server, devices, load };
}

async function requireDjLinkDevices(
  server: DjLinkServerStatus,
  waitMs: number | undefined,
  env: NodeJS.ProcessEnv | undefined,
): Promise<DjLinkDevice[]> {
  const { devices } = await listDjLinkDevices({
    waitMs: waitMs ?? 5_000,
    env,
  });
  if (devices.length === 0) {
    const source =
      server.sourceKind === "rekordbox" ? "complete Rekordbox source" : "verified manifest source";
    throw new DjLinkError(
      "DEVICE_NOT_FOUND",
      `No CDJs announced on ${server.bindIp}; the ${source} remains running for retry`,
    );
  }
  return devices;
}

function requireDjLinkPlayer(devices: DjLinkDevice[], player: number): void {
  if (!devices.some((device) => device.playerNumber === player)) {
    throw new DjLinkError(
      "DEVICE_NOT_FOUND",
      `Player ${String(player)} was not discovered; available players: ${devices
        .map((device) => device.playerNumber)
        .join(", ")}`,
    );
  }
}

/** Ask the native runtime to stop and wait for its exact process to exit. */
export async function stopDjLink(
  options: {
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<{ stopped: boolean; wasRunning: boolean; pid?: number }> {
  const env = options.env ?? process.env;
  const paths = runtimePaths(env);
  const state = await readState(paths.state);
  if (!state || !validStatePaths(state, paths) || !processExists(state.pid)) {
    return { stopped: false, wasRunning: false };
  }
  await requestControl<{ stopping: true }>(state.socketPath, "stop");
  const deadline = Date.now() + requestTimeoutMs;
  while (processExists(state.pid) && Date.now() < deadline) await delay(50);
  const stopped = !processExists(state.pid);
  if (stopped) {
    await unlinkIfPresent(paths.state);
    await unlinkIfPresent(paths.socket);
  }
  return { stopped, wasRunning: true, pid: state.pid };
}

/** Locate the packaged/workspace native helper or an explicit override. */
export async function resolveDjLinkBinary(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const packageRoot = resolve(import.meta.dirname, "..");
  const candidates = [
    override,
    env.DJBOOTH_DJLINK_BINARY,
    env.MUSIC_DJLINK_BINARY,
    resolve(packageRoot, "native-bin/djbooth-rs"),
    resolve(packageRoot, "../../rust/target/release/djbooth-rs"),
    resolve(packageRoot, "../../rust/target/debug/djbooth-rs"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    try {
      await access(absolute, constants.X_OK);
      return absolute;
    } catch {
      // Try the next explicit/package/workspace candidate.
    }
  }
  throw new DjLinkError(
    "NATIVE_MISSING",
    `DJ Link native helper not found; checked ${candidates.map((path) => resolve(path)).join(", ")}`,
  );
}

type NativeLoadResult = {
  player: number;
  trackId: number;
  packetsSent: number;
  loaded: true;
  playing: boolean;
  transportNote: string;
};

type NativePrepareResult = Omit<DjLinkPrepareResult, "order" | "title" | "artist">;

type NativeResolvedTrack = {
  order: number;
  trackId: number;
  title: string;
  artist: string;
  canonicalName: string;
};

async function runNativeDoctor(
  binaryPath: string,
  sourceArgs: string[],
  requireAnalysis: boolean,
  env: NodeJS.ProcessEnv,
): Promise<NativeDoctorOutput> {
  const args = [
    "link",
    "doctor",
    ...sourceArgs,
    ...(requireAnalysis ? ["--require-analysis"] : []),
  ];
  const result = await runProcess(binaryPath, args, env);
  const line = result.stdout
    .trim()
    .split(/\r?\n/u)
    .findLast((candidate) => candidate.trim().startsWith("{"));
  if (!line) {
    throw new DjLinkError(
      "VALIDATION_FAILED",
      `Native DJ Link doctor returned no structured result: ${result.stderr.trim()}`,
    );
  }
  const parsed = JSON.parse(line) as NativeDoctorOutput;
  if (result.code !== 0 && parsed.ok) {
    throw new DjLinkError(
      "VALIDATION_FAILED",
      `Native DJ Link doctor exited ${String(result.code)} despite an ok result`,
    );
  }
  return parsed;
}

async function requireRunningState(env: NodeJS.ProcessEnv): Promise<DjLinkDaemonState> {
  const paths = runtimePaths(env);
  const state = await readState(paths.state);
  if (
    !state ||
    !validStatePaths(state, paths) ||
    !processExists(state.pid) ||
    !(await socketResponds(paths.socket))
  ) {
    throw new DjLinkError("NOT_RUNNING", "DJ Link is not running");
  }
  return state;
}

async function waitForControlSocket(
  socketPath: string,
  pid: number | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!pid) throw new DjLinkError("START_FAILED", "Native helper did not return a process id");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) throw new DjLinkError("START_FAILED", "Native helper exited early");
    if (await socketResponds(socketPath)) return;
    await delay(100);
  }
  throw new DjLinkError("START_FAILED", `Control socket did not become ready: ${socketPath}`);
}

async function socketResponds(socketPath: string): Promise<boolean> {
  try {
    await requestControl(socketPath, "status");
    return true;
  } catch {
    return false;
  }
}

async function readSnapshot(path: string): Promise<DjLinkSnapshot> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as DjLinkSnapshot;
  } catch (error) {
    throw new DjLinkError("INVALID_STATE", `Could not read DJ Link snapshot: ${path}`, {
      cause: error,
    });
  }
}

async function writeState(path: string, state: DjLinkDaemonState): Promise<void> {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

async function clearConfirmedStaleRuntime(paths: RuntimePaths): Promise<void> {
  const state = await readState(paths.state);
  if (state && validStatePaths(state, paths) && processExists(state.pid)) {
    try {
      await requestControl<{ stopping: true }>(state.socketPath, "stop");
    } catch {
      process.kill(state.pid, "SIGTERM");
    }
    const deadline = Date.now() + requestTimeoutMs;
    while (processExists(state.pid) && Date.now() < deadline) await delay(50);
    if (processExists(state.pid)) {
      throw new DjLinkError(
        "START_FAILED",
        `Confirmed stale DJ Link process ${String(state.pid)} did not stop`,
      );
    }
  }
  await unlinkIfPresent(paths.state);
  await unlinkIfPresent(paths.socket);
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function localIpv4Addresses(): Set<string> {
  return new Set(
    Object.values(networkInterfaces())
      .flatMap((addresses) => addresses ?? [])
      .filter((address) => address.family === "IPv4")
      .map((address) => address.address),
  );
}

export function shouldResumeDjLinkBind(
  currentBindIp: string,
  requestedBindIp: string | undefined,
  localAddresses: ReadonlySet<string>,
): boolean {
  if (!localAddresses.has(currentBindIp)) return false;
  if (requestedBindIp !== undefined) return requestedBindIp === currentBindIp;
  const djLinkInterfaceAvailable = [...localAddresses].some(isLinkLocalIpv4);
  return !djLinkInterfaceAvailable || isLinkLocalIpv4(currentBindIp);
}

function isLinkLocalIpv4(address: string): boolean {
  return address.startsWith("169.254.");
}

async function discoverStagehandTarget(
  env: NodeJS.ProcessEnv,
): Promise<{ ip: string; mac: string } | undefined> {
  try {
    const result = await runProcess("/usr/sbin/arp", ["-an"], env);
    if (result.code !== 0) return undefined;
    return parseStagehandTargetFromArp(result.stdout);
  } catch {
    return undefined;
  }
}

export function parseStagehandTargetFromArp(
  output: string,
): { ip: string; mac: string } | undefined {
  for (const line of output.split("\n")) {
    const match = line.match(
      /\((169\.254\.\d{1,3}\.\d{1,3})\) at (c8:3d:fc:[0-9a-f]{2}:[0-9a-f]{2}:[0-9a-f]{2})\b/i,
    );
    if (match?.[1] && match[2]) return { ip: match[1], mac: match[2].toLowerCase() };
  }
  return undefined;
}

async function runProcess(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectProcess);
    child.once("exit", (code) => resolveProcess({ code, stdout, stderr }));
  });
}

function assertDarwin(): void {
  if (process.platform !== "darwin") {
    throw new DjLinkError("START_FAILED", "The imported DJ Link runtime is currently macOS-only");
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
