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
    dbPath: z.string().nullable(),
    pairingFile: z.string().nullable(),
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
    sourceKind: z.enum(["rekordbox", "manifest"]),
    bindIp: z.string(),
    broadcastIp: z.string(),
    playerNumber: z.number().int().positive(),
    tracks: z.number().int().nonnegative(),
    playlists: z.number().int().nonnegative(),
    uptimeMs: z.number().nonnegative(),
    libraryRefreshSupported: z.boolean(),
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

const runtimeStatusOutput = z.object({
  serve: serveStatusOutput,
  link: djLinkStatusOutput,
});

export const statusCli = Cli.create("status", {
  description: "Report library readiness and managed service state for the next agent action.",
  options: z.object({
    path: z
      .string()
      .optional()
      .describe("master.db path; defaults to the active runtime, then auto-discovery"),
    runtimeOnly: z
      .boolean()
      .default(false)
      .describe("Discover managed services without opening or discovering a library"),
  }),
  output: z.union([
    runtimeStatusOutput.extend({
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
      imports: importStatusOutput,
    }),
    runtimeStatusOutput,
  ]),
  async run(c) {
    const [serve, link] = await Promise.all([statusDjBoothRuntime(), statusDjLink()]);
    // Saved configuration identifies the web library even when Link is stopped.
    // A manifest-backed Link source is never a master.db path.
    const serveDatabasePath = serve.running
      ? (serve.options.databasePath ??
        (serve.link?.sourceKind === "rekordbox" ? serve.link.sourcePath : undefined))
      : undefined;
    const runtime = {
      serve: serve.running
        ? {
            running: true as const,
            pid: serve.pid,
            startedAt: serve.startedAt,
            url: serve.url,
            dbPath: serveDatabasePath ?? null,
            pairingFile: serve.pairingFile ?? null,
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
            sourceKind: link.sourceKind,
            bindIp: link.bindIp,
            broadcastIp: link.broadcastIp,
            playerNumber: link.playerNumber,
            tracks: link.tracks,
            playlists: link.playlists,
            uptimeMs: link.uptimeMs,
            libraryRefreshSupported: link.libraryRefreshSupported === true,
            logPath: link.logPath,
          }
        : link,
    };
    if (c.options.runtimeOnly) return runtime;
    const databasePath =
      c.options.path ??
      serveDatabasePath ??
      (!serve.running && link.running && link.sourceKind === "rekordbox"
        ? link.sourcePath
        : undefined);
    const database = new MasterDatabase({
      ...(databasePath ? { path: databasePath } : {}),
      playlistXml: false,
      readonly: true,
      unlock: true,
    });
    try {
      const library = {
        dbPath: database.path,
        dbDirectory: database.dbDirectory,
        writeEnabled: true,
        stats: database.getLibraryHealth(),
      };
      const imports = inspectRekordboxImports({ database }).imports;
      return {
        ...library,
        ...runtime,
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
