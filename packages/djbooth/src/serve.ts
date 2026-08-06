import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import {
  startLibraryServer,
  type LibraryServerOptions,
  type RunningLibraryServer,
} from "@gakonst/djbooth-app";
import {
  startRekordboxDjLink,
  stopDjLink,
  type DjLinkServerStatus,
  type StartRekordboxDjLinkOptions,
} from "@gakonst/djlink";
import { Cli, z } from "incur";

import { startManagedDjBoothServer } from "./runtime.js";
import { startMonitorServer, type RunningMonitorServer } from "./monitor.js";

export type DjBoothServerOptions = {
  allowMissingAnalysis?: boolean;
  assistant?: boolean;
  binary?: string;
  bindIp?: string;
  broadcastIp?: string;
  databasePath?: string;
  host?: "127.0.0.1" | "localhost" | "::1";
  link?: boolean;
  name?: string;
  playerNumber?: number;
  port?: number;
};

export type RunningDjBoothServer = {
  assistantEnabled: boolean;
  close(): Promise<{ linkStopped: boolean }>;
  link: (DjLinkServerStatus & { resumed: boolean }) | null;
  monitor: RunningMonitorServer;
  reconcileLink(): Promise<(DjLinkServerStatus & { resumed: boolean }) | null>;
  url: string;
  web: RunningLibraryServer;
};

export type DjBoothServerDependencies = {
  startLibraryServer(options: LibraryServerOptions): Promise<RunningLibraryServer>;
  startMonitorServer(): Promise<RunningMonitorServer>;
  startRekordboxDjLink(
    options: StartRekordboxDjLinkOptions,
  ): Promise<DjLinkServerStatus & { resumed: boolean }>;
  stopDjLink(): Promise<{ stopped: boolean; wasRunning: boolean; pid?: number }>;
};

const defaultDependencies: DjBoothServerDependencies = {
  startLibraryServer,
  startMonitorServer,
  startRekordboxDjLink,
  stopDjLink,
};

/** Start the browser workstation/API and the matching master.db DJ Link source as one runtime. */
export async function startDjBoothServer(
  options: DjBoothServerOptions = {},
  dependencies: DjBoothServerDependencies = defaultDependencies,
): Promise<RunningDjBoothServer> {
  const assistantEnabled = options.assistant ?? true;
  const stagehandSessionNonce =
    process.env.DJBOOTH_STAGEHAND_SESSION_NONCE ?? randomBytes(8).readBigUInt64BE().toString();
  const stagehandProtocolNonce =
    process.env.DJBOOTH_STAGEHAND_PROTOCOL_NONCE ?? randomBytes(8).readBigUInt64BE().toString();
  const stagehandSessionIp = process.env.DJBOOTH_STAGEHAND_SESSION_IP;
  const linkOptions: StartRekordboxDjLinkOptions = {
    allowMissingAnalysis: options.allowMissingAnalysis ?? true,
    ...(options.binary ? { binaryPath: options.binary } : {}),
    ...(options.bindIp ? { bindIp: options.bindIp } : {}),
    ...(options.broadcastIp ? { broadcastIp: options.broadcastIp } : {}),
    ...(options.databasePath ? { databasePath: options.databasePath } : {}),
    name: options.name ?? "djbooth",
    playerNumber: options.playerNumber ?? 17,
    ...(stagehandSessionIp ? { stagehandSessionIp } : {}),
    stagehandSessionNonce,
    stagehandProtocolNonce,
  };
  let link: (DjLinkServerStatus & { resumed: boolean }) | null = null;
  let ownedLinkPid: number | undefined;
  let web: RunningLibraryServer | undefined;
  let monitor: RunningMonitorServer | undefined;
  try {
    if (options.link !== false) {
      link = await dependencies.startRekordboxDjLink(linkOptions);
      if (!link.resumed) ownedLinkPid = link.pid;
    }
    web = await dependencies.startLibraryServer({
      assistantEnabled,
      ...(options.databasePath ? { dbPath: options.databasePath } : {}),
      host: options.host ?? "127.0.0.1",
      port: options.port ?? 4179,
      writeEnabled: true,
    });
    monitor = await dependencies.startMonitorServer();
  } catch (error) {
    await monitor?.close().catch(() => undefined);
    await web?.close().catch(() => undefined);
    if (link && !link.resumed) await dependencies.stopDjLink().catch(() => undefined);
    throw error;
  }

  const url = workbenchUrl(web.url, assistantEnabled);
  let closePromise: Promise<{ linkStopped: boolean }> | undefined;
  let reconcilePromise: Promise<(DjLinkServerStatus & { resumed: boolean }) | null> | undefined;
  return {
    assistantEnabled,
    get link() {
      return link;
    },
    reconcileLink() {
      if (options.link === false || closePromise) return Promise.resolve(link);
      reconcilePromise ??= (async () => {
        const next = await dependencies.startRekordboxDjLink(linkOptions);
        if (!next.resumed) ownedLinkPid = next.pid;
        else if (ownedLinkPid !== next.pid) ownedLinkPid = undefined;
        link = next;
        return link;
      })().finally(() => {
        reconcilePromise = undefined;
      });
      return reconcilePromise;
    },
    url,
    web,
    monitor,
    close() {
      closePromise ??= (async () => {
        await reconcilePromise?.catch(() => undefined);
        await monitor.close();
        await web.close();
        if (!link || ownedLinkPid !== link.pid) return { linkStopped: false };
        const stopped = await dependencies.stopDjLink();
        return { linkStopped: stopped.stopped };
      })();
      return closePromise;
    },
  };
}

const linkStatusOutput = z.object({
  bindIp: z.string(),
  broadcastIp: z.string(),
  logPath: z.string(),
  pid: z.number().int().positive(),
  playerNumber: z.number().int().positive(),
  playlists: z.number().int().nonnegative(),
  resumed: z.boolean(),
  sourcePath: z.string(),
  tracks: z.number().int().nonnegative(),
});

export const serveCli = Cli.create("serve", {
  description: "Start or resume a managed background workstation/API and Pro DJ Link runtime.",
  hint: "Returns readiness JSON immediately. Rerun with the same options safely; use status and stop instead of babysitting a foreground process.",
  options: z.object({
    allowMissingAnalysis: z
      .boolean()
      .default(true)
      .describe("Serve tracks that do not yet have complete compatible analysis"),
    assistant: z
      .boolean()
      .default(true)
      .describe("Show the embedded assistant; disable when Codex or Claude hosts the chat"),
    binary: z.string().optional().describe("Native djbooth-rs helper override"),
    bindIp: z.string().optional().describe("DJ Link interface IPv4 address; auto-detected"),
    broadcastIp: z.string().optional().describe("DJ Link broadcast IPv4 address; auto-derived"),
    host: z.enum(["127.0.0.1", "localhost", "::1"]).default("127.0.0.1"),
    link: z.boolean().default(true).describe("Expose the library over Pro DJ Link"),
    name: z.string().min(1).default("djbooth").describe("Source name shown on CDJs"),
    open: z.boolean().default(false).describe("Open the workstation in the default browser"),
    path: z.string().optional().describe("master.db path; defaults to auto-discovery"),
    playerNumber: z
      .number()
      .int()
      .min(1)
      .max(19)
      .default(17)
      .describe("Virtual Rekordbox player number"),
    port: z.number().int().min(0).max(65_535).default(4179),
  }),
  output: z.object({
    action: z.enum(["started", "resumed"]),
    assistantEnabled: z.boolean(),
    link: linkStatusOutput.nullable(),
    logPath: z.string(),
    monitorUrl: z.string(),
    pid: z.number().int().positive(),
    url: z.string(),
  }),
  async run(context) {
    const server = await startManagedDjBoothServer({
      allowMissingAnalysis: context.options.allowMissingAnalysis,
      assistant: context.options.assistant,
      ...(context.options.binary ? { binary: context.options.binary } : {}),
      ...(context.options.bindIp ? { bindIp: context.options.bindIp } : {}),
      ...(context.options.broadcastIp ? { broadcastIp: context.options.broadcastIp } : {}),
      ...(context.options.path ? { databasePath: context.options.path } : {}),
      host: context.options.host,
      link: context.options.link,
      name: context.options.name,
      playerNumber: context.options.playerNumber,
      port: context.options.port,
    });
    if (context.options.open) openBrowser(server.url);
    return {
      action: server.resumed ? ("resumed" as const) : ("started" as const),
      assistantEnabled: server.assistantEnabled,
      link: compactLinkStatus(server.link),
      logPath: server.logPath,
      monitorUrl: server.monitorUrl,
      pid: server.pid,
      url: server.url,
    };
  },
});

function compactLinkStatus(
  status: (DjLinkServerStatus & { resumed: boolean }) | null,
): z.output<typeof linkStatusOutput> | null {
  if (!status) return null;
  return {
    bindIp: status.bindIp,
    broadcastIp: status.broadcastIp,
    logPath: status.logPath,
    pid: status.pid,
    playerNumber: status.playerNumber,
    playlists: status.playlists,
    resumed: status.resumed,
    sourcePath: status.sourcePath,
    tracks: status.tracks,
  };
}

function workbenchUrl(serverUrl: string, assistantEnabled: boolean): string {
  const url = new URL(serverUrl);
  if (assistantEnabled) url.searchParams.delete("assistant");
  else url.searchParams.set("assistant", "0");
  return url.toString();
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? { executable: "open", args: [url] }
      : process.platform === "win32"
        ? { executable: "cmd", args: ["/c", "start", "", url] }
        : { executable: "xdg-open", args: [url] };
  const child = spawn(command.executable, command.args, { detached: true, stdio: "ignore" });
  child.unref();
}
