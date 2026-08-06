#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import cdjUsbCli from "@gakonst/cdj-usb/cli";
import djlinkCli from "@gakonst/djlink/cli";
import rekordboxCli from "@gakonst/rekordbox/cli";
import libraryCli from "@gakonst/djbooth-app/cli";
import soundcloudCli from "@gakonst/soundcloud/cli";
import spotsCli from "@gakonst/spots/cli";
import tracksCli from "@gakonst/tracks/cli";
import ytdlpCli from "@gakonst/ytdlp-ts/cli";
import { Cli } from "incur";
import slskCli from "slsk-ts/cli";

import { produceCli } from "./produce.js";

export const DJBOOTH_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

export const DJBOOTH_MCP_TOOL_FILTER = {
  include: [
    "djlink_*",
    "usb_doctor",
    "usb_export",
    "usb_sync",
    "usb_status",
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
    "rekordbox_stems_*",
    "rekordbox_db_info",
    "rekordbox_db_search",
    "rekordbox_db_content_*",
    "rekordbox_db_metadata_add",
    "rekordbox_db_playlist_*",
    "library_status",
    "produce_*",
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
    hint: "Full set flow: djbooth tracks import-set <url> --manifest <path> --write uses clean Auto rhythm analysis; use --analysis-rhythm-mode dynamic for known live/rubato sets; then djbooth djlink rekordbox <track> --player 3. For a fresh front USB, use djbooth usb sync-playlist <mounted-root> <playlist-id> --fresh --write to create compatible library artifacts.",
    mcp: {
      instructions:
        "For a request to find a DJ set's tracks, acquire them, analyze them, and create its Rekordbox playlist, use tracks_import-set once after the user explicitly approves the database write and any local source-set clipping. Do not manually sequence resolve/acquire/analyze/import when that command covers the request. It resumes durable state, preserves candidate and source provenance, auto-selects only safe deterministic Spotify acquisition primaries, runs the releasable clean-room analyzer with Auto rhythm mode by default, and performs at most two acquisition passes: individual sources first, then approved cue-bounded local-set recovery. Use Dynamic for known live/rubato/significantly changing tempo and Normal only when a static grid is intended. Use --analysis-engine reference only for an explicit local parity investigation; it is never a release dependency. Compare clean and reference beat grids in the same Normal or Dynamic mode, and compare waveforms with the rekordbox analyze beat-grid-diff and waveform-diff commands; use semantic timing/phase/downbeat/tempo/F1 and component count/correlation/MAE/bias metrics instead of raw ANLZ hashes. When the same request includes connected-CDJ loading after import, continue with one djlink_rekordbox call; do not wait for the user to restate doctor/start/devices/load. Use djlink_run only for an ad-hoc completed manifest not yet imported into master.db. If deck Search appears broken, run djlink_search first: it exercises the exact prewarmed matcher and RemoteDB row builder without changing deck or library state. After a passing preflight, inspect TCP/1051: CDJ-3000 keyboard edits emit 0x1500, while legacy Search may emit 0x1300. Per-keystroke reconnects mean server rejection; neither request means UI/source activation failed. DJ Link serves verified local recordings and ANLZ data; it never streams Spotify audio, and load does not claim remote PLAY. For a freshly formatted front USB, use usb_sync-playlist with --fresh and explicit write approval to create traditional Device Library plus OneLibrary with shared audio/ANLZ; omit --fresh on verified existing dual-library media. Complete-library usb_sync retains the legacy CDJ-history round trip. Use usb_export only for an outbound-only initial compile. Use usb_doctor and usb_status for transport inspection, and require physical USB STOP/eject before detach or synchronization. If DJ Link discovery is empty, use djlink_probe for a known deck IP. Use official rekordbox Performance mode for licensed Spotify playback. Inspect before standalone downloads; require explicit acknowledgement for every database or account mutation.",
      tools: DJBOOTH_MCP_TOOL_FILTER,
    },
    sync: {
      depth: 1,
      include: [resolve(import.meta.dirname, "../skills/djbooth")],
      suggestions: [
        "open my djbooth.ai workstation",
        "resolve a DJ set into tracks",
        "resolve, download, analyze, and create the Rekordbox playlist for a DJ set in one run",
        "recover unavailable tracks from an approved local DJ-set recording in the same run",
        "serve a completed set manifest to my connected CDJs",
        "validate, serve, discover, and cue a completed manifest track in one run",
        "load a local analyzed track onto player 3",
        "compare clean and reference Rekordbox beat grids",
        "compare clean and reference Rekordbox waveforms",
        "preflight a track search against the running DJ Link source",
        "show live DJ Link deck telemetry",
        "check whether this Linux board supports a front USB appliance",
        "sync my CDJ-3000 front USB and import its play history",
        "show the active front-deck USB image",
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

  cli.command(cdjUsbCli);
  cli.command(djlinkCli);
  cli.command(rekordboxCli);
  cli.command(libraryCli);
  cli.command(produceCli);
  cli.command(slskCli);
  cli.command(soundcloudCli);
  cli.command(spotsCli);
  cli.command(tracksCli);
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
