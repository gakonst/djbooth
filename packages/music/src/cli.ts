#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import rekordboxCli from "@gakonst/rekordbox/cli";
import libraryCli from "@gakonst/rekordbox-library/cli";
import soundcloudCli from "@gakonst/soundcloud/cli";
import spotsCli from "@gakonst/spots/cli";
import tracksCli from "@gakonst/tracks/cli";
import ytdlpCli from "@gakonst/ytdlp-ts/cli";
import { Cli } from "incur";
import slskCli from "slsk-ts/cli";

export const MUSIC_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

export const MUSIC_MCP_TOOL_FILTER = {
  include: [
    "tracks_*",
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
    "ytdlp_engines",
    "ytdlp_inspect",
    "ytdlp_formats",
    "ytdlp_music",
    "ytdlp_download",
    "rekordbox_status",
    "rekordbox_analyze_*",
    "rekordbox_db_info",
    "rekordbox_db_search",
    "rekordbox_db_content_*",
    "rekordbox_db_metadata_add",
    "rekordbox_db_playlist_*",
    "library_status",
  ],
};

/** Compose every package-owned Incur CLI without duplicating its command definitions. */
export function createMusicCli(): ReturnType<typeof Cli.create> {
  const cli = Cli.create("music", {
    version: MUSIC_VERSION,
    description: "Unified metadata, acquisition, platform, and DJ-library tools.",
    hint: "Local CodeMode MCP: music --codemode-mcp",
    mcp: {
      instructions:
        "Compose metadata resolution, provider lookup, platform playlist management, individual-track acquisition, analysis, and normal Rekordbox database operations. Inspect before downloading; require explicit write acknowledgement for database mutations.",
      tools: MUSIC_MCP_TOOL_FILTER,
    },
    sync: {
      depth: 1,
      include: [resolve(import.meta.dirname, "../skills/music")],
      suggestions: [
        "open my Rekordbox library workbench",
        "resolve a DJ set into tracks",
        "create a playlist on Spotify",
        "create a playlist on SoundCloud",
        "search Soulseek for a track",
        "inspect a YouTube or SoundCloud URL",
        "check whether Rekordbox is running",
        "list my Rekordbox playlist hierarchy with track counts",
        "show tracks in a Rekordbox playlist by name",
      ],
    },
  });

  cli.command(rekordboxCli);
  cli.command(libraryCli);
  cli.command(slskCli);
  cli.command(soundcloudCli);
  cli.command(spotsCli);
  cli.command(tracksCli);
  cli.command(ytdlpCli);
  return cli;
}

export async function runMusicCli(argv = process.argv.slice(2)): Promise<void> {
  loadWorkspaceEnvironment();
  const cli = createMusicCli();
  if (argv.length === 1 && argv[0] === "--codemode-mcp") {
    const { serveLocalMusicCodeMcp } = await import("./mcp.js");
    await serveLocalMusicCodeMcp({ cli });
    return;
  }
  await cli.serve(argv);
}

function loadWorkspaceEnvironment(): void {
  const candidates = [
    process.env.MUSIC_ENV_FILE,
    resolve(homedir(), ".config/music-ts/.env"),
    resolve(import.meta.dirname, "../../../.env"),
    resolve(process.cwd(), ".env"),
  ].filter(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path) loadEnvFile(path);
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

if (isMainModule()) await runMusicCli();
