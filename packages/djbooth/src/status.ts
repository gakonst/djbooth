import { statusDjLink } from "@gakonst/djlink/control";
import { MasterDatabase } from "@gakonst/rekordbox/masterdb";
import { inspectRekordboxImports } from "@gakonst/tracks/pipeline-state";
import { Cli, z } from "incur";

import { statusDjBoothRuntime } from "./runtime.js";

const serveStatusOutput = z.discriminatedUnion("running", [
  z.object({
    running: z.literal(true),
    pid: z.number().int().positive(),
    startedAt: z.string(),
    url: z.string(),
    assistantEnabled: z.boolean(),
    logPath: z.string(),
    monitorUrl: z.string(),
    views: z.object({ library: z.string(), booth: z.string() }),
    sonos: z
      .object({ room: z.string(), coordinatorIp: z.string(), streamUrl: z.string() })
      .nullable(),
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
    const database = new MasterDatabase({
      ...(c.options.path ? { path: c.options.path } : {}),
      playlistXml: false,
      readonly: true,
      unlock: true,
    });
    try {
      const [serve, link] = await Promise.all([statusDjBoothRuntime(), statusDjLink()]);
      const library = {
        dbPath: database.path,
        dbDirectory: database.dbDirectory,
        writeEnabled: true,
        stats: database.getLibraryHealth(),
      };
      const imports = inspectRekordboxImports({ database }).imports;
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
              monitorUrl: serve.monitorUrl,
              views: { library: serve.url, booth: serve.monitorUrl },
              sonos: serve.sonos,
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
      database.close();
    }
  },
});

function sum(
  imports: ReturnType<typeof inspectRekordboxImports>["imports"],
  key: "tracks" | "downloaded" | "analyzed" | "ready" | "blocked" | "pending",
): number {
  return imports.reduce((total, item) => total + item[key], 0);
}
