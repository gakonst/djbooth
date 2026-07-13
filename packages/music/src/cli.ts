#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import rekordboxCli from "@gakonst/rekordbox/cli";
import soundcloudCli from "@gakonst/soundcloud/cli";
import spotsCli from "@gakonst/spots/cli";
import tracksCli from "@gakonst/tracks/cli";
import ytdlpCli from "@gakonst/ytdlp-ts/cli";
import { Cli } from "incur";
import slskCli from "slsk-ts/cli";

const MUSIC_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/** Compose every package-owned Incur CLI without duplicating its command definitions. */
export function createMusicCli(): ReturnType<typeof Cli.create> {
  const cli = Cli.create("music", {
    version: MUSIC_VERSION,
    description: "Unified metadata, acquisition, platform, and DJ-library tools.",
    sync: {
      depth: 0,
      include: [resolve(import.meta.dirname, "../skills/*")],
      suggestions: [
        "resolve a DJ set into tracks",
        "create a playlist on Spotify",
        "create a playlist on SoundCloud",
        "search Soulseek for a track",
        "inspect a YouTube or SoundCloud URL",
        "check whether Rekordbox is running",
      ],
    },
  });

  cli.command(rekordboxCli);
  cli.command(slskCli);
  cli.command(soundcloudCli);
  cli.command(spotsCli);
  cli.command(tracksCli);
  cli.command(ytdlpCli);
  return cli;
}

export async function runMusicCli(argv = process.argv.slice(2)): Promise<void> {
  loadWorkspaceEnvironment();
  await createMusicCli().serve(argv);
}

function loadWorkspaceEnvironment(): void {
  const candidates = [
    resolve(import.meta.dirname, "../../../.env"),
    resolve(process.cwd(), ".env"),
  ];
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
