#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Cli } from "incur";
import { z } from "zod";

import { RekordboxLibraryService } from "./server/library.js";
import { startLibraryServer } from "./server/server.js";

const version = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

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

async function waitForShutdown(): Promise<"SIGINT" | "SIGTERM"> {
  return new Promise((resolveSignal) => {
    const onInterrupt = () => resolveSignal("SIGINT");
    const onTerminate = () => resolveSignal("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
  });
}

export const libraryCli = Cli.create("library", {
  version,
  description: "Browse and safely manage the local Rekordbox library in a web workbench.",
  sync: {
    suggestions: [
      "open my Rekordbox library",
      "browse my Rekordbox playlists",
      "find tracks missing analysis",
    ],
  },
});

libraryCli.command("status", {
  description: "Show the discovered library and read-only health counts.",
  options: z.object({
    path: z.string().optional().describe("master.db path; defaults to auto-discovery"),
  }),
  output: z.object({
    dbPath: z.string(),
    dbDirectory: z.string(),
    writeEnabled: z.boolean(),
    processes: z.object({ rekordboxPid: z.number(), rekordboxAgentPid: z.number() }),
    stats: z.object({
      tracks: z.number(),
      playlists: z.number(),
      folders: z.number(),
      analyzed: z.number(),
      missingAnalysis: z.number(),
      missingBpm: z.number(),
      missingKey: z.number(),
    }),
  }),
  run(c) {
    const service = new RekordboxLibraryService({ dbPath: c.options.path });
    try {
      return service.getBootstrap("").library;
    } finally {
      service.close();
    }
  },
});

libraryCli.command("serve", {
  description: "Serve the loopback-only Rekordbox library workbench until interrupted.",
  options: z.object({
    host: z.enum(["127.0.0.1", "localhost", "::1"]).default("127.0.0.1"),
    open: z.boolean().default(false).describe("Open the workbench in the default browser"),
    path: z.string().optional().describe("master.db path; defaults to auto-discovery"),
    port: z.number().int().min(0).max(65_535).default(4179),
    write: z.boolean().default(false).describe("Enable direct local playlist mutations"),
  }),
  output: z.object({
    action: z.literal("stopped"),
    signal: z.enum(["SIGINT", "SIGTERM"]),
    url: z.string(),
    writeEnabled: z.boolean(),
  }),
  async run(c) {
    const server = await startLibraryServer({
      dbPath: c.options.path,
      host: c.options.host,
      port: c.options.port,
      writeEnabled: c.options.write,
    });
    process.stderr.write(
      `${JSON.stringify({ action: "started", url: server.url, writeEnabled: c.options.write })}\n`,
    );
    if (c.options.open) openBrowser(server.url);
    const signal = await waitForShutdown();
    await server.close();
    return { action: "stopped" as const, signal, url: server.url, writeEnabled: c.options.write };
  },
});

export async function runLibraryCli(argv = process.argv.slice(2)): Promise<void> {
  await libraryCli.serve(argv);
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(resolve(entrypoint))).href;
  } catch {
    return false;
  }
}

if (isMainModule()) await runLibraryCli();

export default libraryCli;
