#!/usr/bin/env node
import { runMusicCli } from "./cli.js";
import { serveLocalMusicCodeMcp } from "./mcp.js";

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--codemode-mcp") {
  await serveLocalMusicCodeMcp();
} else {
  await runMusicCli();
}
