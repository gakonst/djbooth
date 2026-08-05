import { RekordboxLibraryService } from "@gakonst/djbooth-app";
import { statusDjLink } from "@gakonst/djlink";
import { inspectRekordboxImports } from "@gakonst/tracks";
import { Cli, z } from "incur";

import { statusDjBoothRuntime, stopManagedDjBoothServer } from "./runtime.js";

const serveStatusOutput = z.discriminatedUnion("running", [
  z.object({
    running: z.literal(true),
    pid: z.number().int().positive(),
    startedAt: z.string(),
    url: z.string(),
    assistantEnabled: z.boolean(),
    logPath: z.string(),
  }),
  z.object({
    running: z.literal(false),
    staleState: z.boolean(),
    logPath: z.string(),
  }),
]);

const djLinkStatusOutput = z.discriminatedUnion("running", [
  z.object({
    running: z.literal(true),
    pid: z.number().int().positive(),
    sourcePath: z.string(),
    bindIp: z.string(),
    broadcastIp: z.string(),
    playerNumber: z.number().int().positive(),
    tracks: z.number().int().nonnegative(),
    playlists: z.number().int().nonnegative(),
    uptimeMs: z.number().nonnegative(),
    logPath: z.string(),
  }),
  z.object({ running: z.literal(false), staleState: z.boolean() }),
]);

const importStatusOutput = z.object({
  total: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  tracks: z.number().int().nonnegative(),
  downloaded: z.number().int().nonnegative(),
  analyzed: z.number().int().nonnegative(),
  ready: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  recent: z.array(
    z.object({
      source: z.string(),
      title: z.string().optional(),
      updatedAt: z.string(),
      tracks: z.number().int().nonnegative(),
      identified: z.number().int().nonnegative(),
      downloaded: z.number().int().nonnegative(),
      analyzed: z.number().int().nonnegative(),
      ready: z.number().int().nonnegative(),
      blocked: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
    }),
  ),
});

export const statusCli = Cli.create("status", {
  description: "Report library readiness and managed service state for the next agent action.",
  options: z.object({
    path: z.string().optional().describe("master.db path; defaults to auto-discovery"),
  }),
  output: z.object({
    dbPath: z.string(),
    dbDirectory: z.string(),
    writeEnabled: z.boolean(),
    stats: z.object({
      tracks: z.number(),
      playlists: z.number(),
      folders: z.number(),
      analyzed: z.number(),
      missingAnalysis: z.number(),
      missingBpm: z.number(),
      missingKey: z.number(),
    }),
    serve: serveStatusOutput,
    link: djLinkStatusOutput,
    imports: importStatusOutput,
  }),
  async run(c) {
    const service = new RekordboxLibraryService(
      c.options.path ? { dbPath: c.options.path } : undefined,
    );
    try {
      const [serve, link] = await Promise.all([statusDjBoothRuntime(), statusDjLink()]);
      const library = service.getBootstrap("").library;
      const imports = inspectRekordboxImports({ dbPath: library.dbPath }).imports;
      return {
        ...library,
        serve: serve.running
          ? {
              running: true as const,
              pid: serve.pid,
              startedAt: serve.startedAt,
              url: serve.url,
              assistantEnabled: serve.assistantEnabled,
              logPath: serve.logPath,
            }
          : serve,
        link: link.running
          ? {
              running: true as const,
              pid: link.pid,
              sourcePath: link.sourcePath,
              bindIp: link.bindIp,
              broadcastIp: link.broadcastIp,
              playerNumber: link.playerNumber,
              tracks: link.tracks,
              playlists: link.playlists,
              uptimeMs: link.uptimeMs,
              logPath: link.logPath,
            }
          : link,
        imports: {
          total: imports.length,
          active: imports.filter((item) => item.pending > 0).length,
          tracks: sum(imports, "tracks"),
          downloaded: sum(imports, "downloaded"),
          analyzed: sum(imports, "analyzed"),
          ready: sum(imports, "ready"),
          blocked: sum(imports, "blocked"),
          pending: sum(imports, "pending"),
          recent: imports.slice(0, 10),
        },
      };
    } finally {
      service.close();
    }
  },
});

function sum(
  imports: ReturnType<typeof inspectRekordboxImports>["imports"],
  key: "tracks" | "downloaded" | "analyzed" | "ready" | "blocked" | "pending",
): number {
  return imports.reduce((total, item) => total + item[key], 0);
}

export const stopCli = Cli.create("stop", {
  description: "Stop the managed djbooth workstation/API and its owned Pro DJ Link runtime.",
  output: z.object({
    stopped: z.boolean(),
    wasRunning: z.boolean(),
    pid: z.number().int().positive().optional(),
  }),
  async run() {
    return stopManagedDjBoothServer();
  },
});
