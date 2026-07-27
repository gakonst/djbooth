#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import djlinkCli from "./cli.js";

/** Run the standalone DJ Link CLI. */
export async function runDjLinkCli(argv = process.argv.slice(2)): Promise<void> {
  await djlinkCli.serve(argv);
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
  } catch {
    return false;
  }
}

if (isMainModule()) await runDjLinkCli();
