#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { usbCli } from "@gakonst/cdj-usb/cli";
import { linkCli } from "@gakonst/djlink/cli";
import { enhanceCli, enhancementGroupCli, stemsCli } from "@gakonst/rekordbox/cli";
import { playlistCli } from "./playlist.js";
import soundcloudCli from "@gakonst/soundcloud/cli";
import spotsCli from "@gakonst/spots/cli";
import { analyzeCli, downloadCli, enrichCli, importCli, resolveCli } from "@gakonst/tracks/cli";
import ytdlpCli from "@gakonst/ytdlp-ts/cli";
import { Cli } from "incur";
import slskCli from "slsk-ts/cli";

import { pairingCli, serveCli } from "./serve.js";
import { visualsCli } from "./visuals.js";
import { replayCli } from "./replay.js";
import { statusCli } from "./status.js";
import { stopCli } from "./stop.js";
import { loadDjBoothEnvironment } from "./environment.js";
import { produceCli } from "./produce.js";
import { createDjBoothRoot, DJBOOTH_VERSION } from "./root.js";
import { cloudCli } from "./cloud.js";

export { DJBOOTH_VERSION } from "./root.js";

export const DJBOOTH_MCP_TOOL_FILTER = {
  include: [
    "resolve",
    "enrich",
    "download",
    "analyze",
    "enhance",
    "enhancement_*",
    "import",
    "cloud_*",
    "link",
    "replay",
    "playlist_*",
    "produce_*",
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
  const cli = createDjBoothRoot({ tools: DJBOOTH_MCP_TOOL_FILTER });

  cli.command(resolveCli);
  cli.command(enrichCli);
  cli.command(downloadCli);
  cli.command(analyzeCli);
  cli.command(enhanceCli);
  cli.command(enhancementGroupCli);
  cli.command(importCli);
  cli.command(cloudCli);
  cli.command(playlistCli);
  cli.command(produceCli);
  cli.command(stemsCli);
  cli.command(linkCli);
  cli.command(replayCli);
  cli.command(serveCli);
  cli.command(pairingCli);
  cli.command(visualsCli);
  cli.command(statusCli);
  cli.command(stopCli);
  cli.command(usbCli);
  cli.command(slskCli);
  cli.command(soundcloudCli);
  cli.command(spotsCli);
  cli.command(ytdlpCli);
  return cli;
}

export async function runDjBoothCli(
  argv = process.argv.slice(2),
  options: { environmentLoaded?: boolean } = {},
): Promise<void> {
  if (!options.environmentLoaded) loadDjBoothEnvironment();
  const cli = createDjBoothCli();
  if (argv.length === 1 && argv[0] === "--codemode-mcp") {
    const { serveLocalDjBoothCodeMcp } = await import("./mcp.js");
    await serveLocalDjBoothCodeMcp({ cli });
    return;
  }
  await cli.serve(argv);
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
