#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import { usbCli } from "@gakonst/cdj-usb/cli";
import { statusCli } from "@gakonst/djbooth-app/cli";
import { linkCli } from "@gakonst/djlink/cli";
import { stemsCli } from "@gakonst/rekordbox/cli";
import soundcloudCli from "@gakonst/soundcloud/cli";
import spotsCli from "@gakonst/spots/cli";
import { analyzeCli, downloadCli, enrichCli, importSetCli, resolveCli } from "@gakonst/tracks/cli";
import ytdlpCli from "@gakonst/ytdlp-ts/cli";
import { Cli } from "incur";
import slskCli from "slsk-ts/cli";

import { serveCli } from "./serve.js";

export const DJBOOTH_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

export const DJBOOTH_MCP_TOOL_FILTER = {
  include: [
    "resolve",
    "enrich",
    "download",
    "analyze",
    "import-set",
    "link",
    "status",
    "stems",
    "usb",
    "spots_auth_status",
    "spots_me",
    "spots_recent",
    "spots_request",
    "spots_api_search",
    "spots_api_get-track",
    "spots_api_get-several-tracks",
    "spots_api_get-playlist",
    "spots_api_get-playlists-items",
    "spots_playlist_*",
    "soundcloud_auth_status",
    "soundcloud_likes_*",
    "soundcloud_me",
    "soundcloud_recent",
    "soundcloud_resolve",
    "soundcloud_search_*",
    "soundcloud_request",
    "soundcloud_api_get-tracks*",
    "soundcloud_playlist_*",
    "slsk_info",
    "slsk_search",
    "slsk_download",
    "ytdlp-ts_engines",
    "ytdlp-ts_inspect",
    "ytdlp-ts_formats",
    "ytdlp-ts_music",
    "ytdlp-ts_download",
  ],
};

/**
 * Compose every package-owned Incur CLI without duplicating its command definitions.
 *
 * Native Rust and Python executables remain directly usable implementation CLIs. Their owning
 * TypeScript commands provide the typed Incur wrapper and route execution to those helpers.
 */
export function createDjBoothCli(): ReturnType<typeof Cli.create> {
  const cli = Cli.create("djbooth", {
    version: DJBOOTH_VERSION,
    description:
      "Agentically drive DJ-set discovery, acquisition, analysis, stems, library management, deck serving, and Rekordbox-compatible exports.",
    hint: "Run djbooth <command> --help for examples and typed options. Workflow stages are direct commands; specialist providers remain grouped.",
    mcp: {
      instructions:
        "Use the narrowest typed djbooth tool that completes the request. Tool descriptions, schemas, and errors are the workflow source of truth.",
      tools: DJBOOTH_MCP_TOOL_FILTER,
    },
  });

  cli.command(resolveCli);
  cli.command(enrichCli);
  cli.command(downloadCli);
  cli.command(analyzeCli);
  cli.command(importSetCli);
  cli.command(stemsCli);
  cli.command(linkCli);
  cli.command(serveCli);
  cli.command(statusCli);
  cli.command(usbCli);
  cli.command(slskCli);
  cli.command(soundcloudCli);
  cli.command(spotsCli);
  cli.command(ytdlpCli);
  return cli;
}

export async function runDjBoothCli(argv = process.argv.slice(2)): Promise<void> {
  loadWorkspaceEnvironment();
  const cli = createDjBoothCli();
  if (argv.length === 1 && argv[0] === "--codemode-mcp") {
    const { serveLocalDjBoothCodeMcp } = await import("./mcp.js");
    await serveLocalDjBoothCodeMcp({ cli });
    return;
  }
  await cli.serve(argv);
}

function loadWorkspaceEnvironment(): void {
  const candidates = [
    process.env.DJBOOTH_ENV_FILE,
    process.env.MUSIC_ENV_FILE,
    ...ancestorEnvironmentFiles(process.cwd()),
    resolve(homedir(), ".config/djbooth/.env"),
    resolve(homedir(), ".config/music-ts/.env"),
    resolve(import.meta.dirname, "../../../.env"),
  ].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path) loadEnvFile(path);
}

function ancestorEnvironmentFiles(start: string): string[] {
  const files: string[] = [];
  let directory = resolve(start);
  while (true) {
    files.push(resolve(directory, ".env"));
    const parent = dirname(directory);
    if (parent === directory) return files;
    directory = parent;
  }
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

/** Legacy API alias for callers using the former product name. */
export const MUSIC_VERSION = DJBOOTH_VERSION;

/** Legacy API alias for callers using the former product name. */
export const MUSIC_MCP_TOOL_FILTER = DJBOOTH_MCP_TOOL_FILTER;

/** Legacy API alias for callers using the former product name. */
export const createMusicCli = createDjBoothCli;

/** Legacy API alias for callers using the former product name. */
export const runMusicCli = runDjBoothCli;

if (isMainModule()) await runDjBoothCli();
