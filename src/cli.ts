#!/usr/bin/env node

import { Cli, z } from "incur";

import { updateConfig, version } from "./index.js";

const cli = Cli.create("rekordbox", {
  version,
  description: "Inspect and modify Rekordbox libraries and export formats.",
  sync: {
    suggestions: [
      "inspect my Rekordbox configuration",
      "summarize a Rekordbox XML export",
      "inspect an ANLZ file",
      "list playlists in my Rekordbox library",
    ],
  },
});

cli.command("status", {
  description: "Show implementation and runtime status.",
  output: z.object({
    name: z.string(),
    version: z.string(),
    runtime: z.string(),
    phase: z.string(),
  }),
  run() {
    return {
      name: "@gakonst/rekordbox",
      version,
      runtime: process.version,
      phase: "active-port",
    };
  },
});

const configCli = Cli.create("config", {
  description: "Discover Rekordbox installations and library paths.",
}).command("show", {
  description: "Show detected Rekordbox paths and versions.",
  options: z.object({
    appDir: z.string().optional().describe("Pioneer application-data directory"),
    installDir: z.string().optional().describe("Pioneer/Rekordbox installation root"),
    rekordbox5Dirname: z.string().optional().describe("Exact Rekordbox 5 directory name"),
    rekordbox6Dirname: z.string().optional().describe("Exact Rekordbox 6 directory name"),
    rekordbox7Dirname: z.string().optional().describe("Exact Rekordbox 7 directory name"),
  }),
  examples: [{ description: "Auto-detect Rekordbox installations" }],
  run(c) {
    return updateConfig({
      pioneerAppDir: c.options.appDir,
      pioneerInstallDir: c.options.installDir,
      rekordbox5Dirname: c.options.rekordbox5Dirname,
      rekordbox6Dirname: c.options.rekordbox6Dirname,
      rekordbox7Dirname: c.options.rekordbox7Dirname,
    });
  },
});

cli.command(configCli);

cli.serve();

export default cli;
