#!/usr/bin/env node

import { Cli, z } from "incur";

import { version } from "./index.js";

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

cli.serve();

export default cli;
