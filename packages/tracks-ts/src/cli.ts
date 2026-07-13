#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import { Cli, z } from "incur";
import { SoulseekClient } from "slsk-ts";
import { FileSessionStore, SpotifyClient, SpotifyOAuth } from "@gakonst/spots";
import { ReferenceClient } from "@gakonst/ytdlp-ts";

import {
  DEFAULT_ACQUISITION_CONCURRENCY,
  DEFAULT_SPOTIFY_REFRESH_CONCURRENCY,
  DEFAULT_VERIFICATION_CONCURRENCY,
  MAX_ACQUISITION_CONCURRENCY,
  MAX_SPOTIFY_REFRESH_CONCURRENCY,
  MAX_VERIFICATION_CONCURRENCY,
} from "./acquire-manifest.js";
import { cacheDigest } from "./cache.js";
import { TracksError, errorMessage } from "./errors.js";
import { identify } from "./identify.js";
import { CachedSpotifyClient } from "./integrations/spotify-cache.js";
import { SoulseekLibraryAcquirer } from "./integrations/slsk-library.js";
import { getYtdlpTsCommand } from "./integrations/ytdlp.js";
import { YtdlpReferenceAcquirer } from "./integrations/ytdlp-library.js";
import { createManifest, parseManifest } from "./manifest.js";
import { runProcess } from "./process.js";
import { DEFAULT_PARSE_API_BASE, Tracklists1001Client } from "./providers/tracklists1001.js";
import {
  DEFAULT_RECOGNITION_CONCURRENCY,
  MAX_RECOGNITION_CONCURRENCY,
} from "./recognize-samples.js";
import { parseTracklistJson, renderTracklist } from "./render.js";
import { requireTimestamp } from "./time.js";
import type { Environment } from "./types.js";
import { runSetToRekordbox } from "./workflow.js";

const { version: VERSION } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

function loadWorkspaceEnvironment(): void {
  const candidates = [
    resolve(import.meta.dirname, "../../../.env"),
    resolve(process.cwd(), ".env"),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path) loadEnvFile(path);
}

const provider = z
  .enum(["auto", "description", "1001tracklists", "audd", "acrcloud"])
  .default("auto")
  .describe("Resolution provider");

const providerEnv = z.object({
  PARSE_API_KEY: z.string().optional().describe("Parse API key for 1001Tracklists access"),
  PARSE_API_BASE: z.string().optional().describe("Override the complete Parse scraper base URL"),
  PARSE_SCRAPER_ID: z.string().optional().describe("Override the Parse canonical scraper ID"),
  AUDD_API_TOKEN: z.string().optional().describe("AudD API token"),
  ACR_HOST: z.string().optional().describe("ACRCloud identification project host"),
  ACR_ACCESS_KEY: z.string().optional().describe("ACRCloud identification access key"),
  ACR_ACCESS_SECRET: z.string().optional().describe("ACRCloud identification access secret"),
  YTDLP_TS_PATH: z.string().optional().describe("ytdlp-ts executable or dist/cli.js path"),
  FFMPEG_PATH: z.string().optional().describe("ffmpeg executable path"),
  FFPROBE_PATH: z.string().optional().describe("ffprobe executable path"),
});

const parseEnv = z.object({
  PARSE_API_KEY: z.string().optional().describe("Parse API key from https://parse.bot"),
  PARSE_API_BASE: z.string().optional().describe("Override the complete Parse scraper base URL"),
  PARSE_SCRAPER_ID: z.string().optional().describe("Override the Parse canonical scraper ID"),
});

const importSetEnv = providerEnv.extend({
  SLSK_USERNAME: z.string().optional().describe("Soulseek username"),
  SLSK_PASSWORD: z.string().optional().describe("Soulseek password"),
});

const cacheModeOption = z
  .enum(["default", "refresh", "off"])
  .default("default")
  .describe("Use, refresh, or bypass the persistent provider metadata cache");

const identifyOptions = z.object({
  provider,
  strategy: z
    .enum(["enterprise", "samples"])
    .default("enterprise")
    .describe("AudD long-file scan or local clip sampling"),
  preferDatabase: z
    .boolean()
    .default(true)
    .describe("Check 1001Tracklists before paid audio recognition"),
  preferDescription: z
    .boolean()
    .default(true)
    .describe("Resolve timestamped tracks from the media description first"),
  full: z
    .boolean()
    .default(false)
    .describe("AudD: scan every 12-second fragment instead of the cost-aware sample"),
  every: z.number().int().min(1).max(20).default(1).describe("AudD chunks scanned per cycle"),
  skip: z.number().int().min(0).max(100).default(4).describe("AudD chunks skipped per cycle"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum billable chunks or local samples"),
  start: z.string().optional().describe("Start at seconds, MM:SS, or HH:MM:SS"),
  interval: z
    .number()
    .int()
    .min(12)
    .default(60)
    .describe("Seconds between local samples for AudD Standard or ACRCloud"),
  clip: z.number().int().min(5).max(25).default(12).describe("Sample clip length in seconds"),
  concurrency: z
    .number()
    .int()
    .min(1)
    .max(MAX_RECOGNITION_CONCURRENCY)
    .default(DEFAULT_RECOGNITION_CONCURRENCY)
    .describe("Concurrent local sample recognition calls"),
  minScore: z.number().min(0).max(100).default(40).describe("Minimum primary match score"),
  blendScore: z.number().min(0).max(100).default(50).describe("Minimum overlap match score"),
  includeMatches: z.boolean().default(false).describe("Include raw recognition moments"),
  cookies: z.string().optional().describe("Netscape cookie file passed to yt-dlp"),
  cookiesFromBrowser: z.string().optional().describe("Browser cookie source passed to yt-dlp"),
  cacheMode: z
    .enum(["default", "refresh", "off"])
    .default("default")
    .describe("Use, refresh, or bypass the persistent provider metadata cache"),
  progress: z.enum(["auto", "always", "never"]).default("auto").describe("Progress on stderr"),
});

const pipelineErrorOutput = z.object({
  stage: z.enum([
    "manifest",
    "source",
    "tracklist",
    "identity",
    "spotify",
    "acquisition",
    "rekordbox",
  ]),
  message: z.string(),
  code: z.string().optional(),
  retryable: z.boolean().optional(),
});

const overlapOutput = z.object({
  artist: z.string(),
  title: z.string(),
  confidence: z.number().min(0).max(100).optional(),
});

const identityMetadataOutput = {
  isId: z.boolean().optional(),
  artist: z.string().optional(),
  title: z.string().optional(),
  mix: z.string().optional(),
  album: z.string().optional(),
  label: z.string().optional(),
  releaseDate: z.string().optional(),
  isrc: z.string().optional(),
  upc: z.string().optional(),
  songLink: z.string().optional(),
  confidence: z.number().min(0).max(100).optional(),
  overlaps: z.array(overlapOutput).optional(),
};

const identityOutput = z.union([
  z.object({
    status: z.literal("identified"),
    ...identityMetadataOutput,
    artist: z.string(),
    title: z.string(),
    searchQuery: z.string(),
  }),
  z.object({ status: z.literal("unidentified"), ...identityMetadataOutput }),
]);

const spotifyCandidateOutput = z.object({
  score: z.number().min(0).max(1),
  id: z.string(),
  uri: z.string(),
  url: z.string().optional(),
  name: z.string(),
  artists: z.array(z.string()),
  album: z.string().optional(),
  albumArtists: z.array(z.string()).optional(),
  releaseDate: z.string().optional(),
  durationMs: z.number().int().positive().optional(),
  explicit: z.boolean().optional(),
  isrc: z.string().optional(),
});

const spotifyOutput = z.union([
  z.object({ status: z.literal("pending"), query: z.string().optional() }),
  z.object({
    status: z.literal("matched"),
    query: z.string(),
    score: z.number().min(0).max(1),
    id: z.string(),
    uri: z.string(),
    url: z.string().optional(),
    name: z.string().optional(),
    artists: z.array(z.string()).optional(),
    album: z.string().optional(),
    albumArtists: z.array(z.string()).optional(),
    releaseDate: z.string().optional(),
    durationMs: z.number().int().positive().optional(),
    explicit: z.boolean().optional(),
    isrc: z.string().optional(),
    candidates: z.array(spotifyCandidateOutput).optional(),
  }),
  z.object({
    status: z.literal("ambiguous"),
    query: z.string(),
    candidates: z.array(spotifyCandidateOutput),
  }),
  z.object({ status: z.literal("unmatched"), query: z.string() }),
  z.object({ status: z.literal("skipped"), reason: z.string() }),
  z.object({
    status: z.literal("failed"),
    query: z.string().optional(),
    error: pipelineErrorOutput,
  }),
]);

const acquisitionCandidateOutput = z.object({
  backend: z.enum(["slsk", "ytdlp"]),
  id: z.string(),
  source: z.string(),
  title: z.string(),
  artist: z.string().optional(),
  durationSeconds: z.number().positive().optional(),
  score: z.number().min(0).max(1).optional(),
});

const acquisitionDownloadOutput = z.object({
  backend: z.enum(["local", "slsk", "ytdlp"]),
  kind: z.enum(["individual", "source-set-clip"]).optional(),
  mediaPath: z.string(),
  files: z.array(z.string()),
  source: z.string().optional(),
  engine: z.enum(["native", "reference"]).optional(),
  sha256: z.string().optional(),
  spotifyId: z.string().optional(),
  isrc: z.string().optional(),
  clip: z
    .object({
      sourceSetUrl: z.string(),
      sourceSetTitle: z.string().optional(),
      startSeconds: z.number().nonnegative(),
      endSeconds: z.number().positive(),
      containsTransitions: z.boolean(),
      qualityNote: z.string(),
    })
    .optional(),
});

const acquisitionOutput = z.union([
  z.object({ status: z.literal("pending"), query: z.string().optional() }),
  z.object({
    status: z.literal("searching"),
    query: z.string(),
    candidates: z.array(acquisitionCandidateOutput),
  }),
  z.object({
    status: z.literal("selected"),
    query: z.string(),
    candidates: z.array(acquisitionCandidateOutput),
    selected: acquisitionCandidateOutput,
  }),
  z.object({
    status: z.literal("unmatched"),
    query: z.string(),
    candidates: z.array(acquisitionCandidateOutput),
  }),
  z.object({
    status: z.literal("downloaded"),
    query: z.string().optional(),
    candidates: z.array(acquisitionCandidateOutput).optional(),
    selected: acquisitionCandidateOutput.optional(),
    download: acquisitionDownloadOutput,
    alternatives: z.array(acquisitionDownloadOutput).optional(),
  }),
  z.object({ status: z.literal("skipped"), reason: z.string() }),
  z.object({
    status: z.literal("failed"),
    query: z.string().optional(),
    candidates: z.array(acquisitionCandidateOutput).optional(),
    error: pipelineErrorOutput,
  }),
]);

const rekordboxOutput = z.union([
  z.object({ status: z.literal("pending") }),
  z.object({
    status: z.enum(["exported", "imported"]),
    target: z.enum(["m3u8", "rekordbox-xml", "rekordbox-db"]),
    artifact: z.string().optional(),
    xmlTrackId: z.number().int().positive().optional(),
    dbContentId: z.string().optional(),
    playlistMembershipId: z.string().optional(),
    dbContentIds: z.array(z.string()).optional(),
    playlistMembershipIds: z.array(z.string()).optional(),
  }),
  z.object({ status: z.literal("skipped"), reason: z.string() }),
  z.object({
    status: z.literal("failed"),
    target: z.enum(["m3u8", "rekordbox-xml", "rekordbox-db"]).optional(),
    error: pipelineErrorOutput,
  }),
]);

const manifestOutput = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("dj-set-pipeline"),
  source: z.object({
    input: z.string(),
    id: z.string().optional(),
    url: z.string().optional(),
    title: z.string().optional(),
    uploader: z.string().optional(),
    date: z.string().optional(),
    lineup: z.array(z.string()).optional(),
    durationSeconds: z.number().positive().optional(),
  }),
  tracklist: z.object({
    provider: z.enum(["description", "1001tracklists", "audd", "acrcloud"]),
    url: z.string().optional(),
    complete: z.boolean(),
    sampledEverySeconds: z.number().positive().optional(),
    matches: z.array(z.unknown()).optional(),
  }),
  entries: z.array(
    z.object({
      id: z.string(),
      order: z.number().int().positive(),
      cue: z.object({
        timestamp: z.string().optional(),
        startSeconds: z.number().nonnegative().optional(),
        endSeconds: z.number().nonnegative().optional(),
      }),
      identity: identityOutput,
      spotify: spotifyOutput,
      acquisition: acquisitionOutput,
      rekordbox: rekordboxOutput,
      warnings: z.array(z.string()),
      errors: z.array(pipelineErrorOutput),
    }),
  ),
  warnings: z.array(z.string()),
  errors: z.array(pipelineErrorOutput),
  artifacts: z.object({
    root: z.string().optional(),
    manifest: z.string().optional(),
    downloadDirectory: z.string().optional(),
    m3u8: z.string().optional(),
    rekordboxXml: z.string().optional(),
    sourceSet: z
      .object({
        url: z.string(),
        path: z.string(),
        sha256: z.string(),
        durationSeconds: z.number().positive(),
        codec: z.string(),
        bitrate: z.number().int().positive(),
      })
      .optional(),
    rekordbox: z
      .object({
        target: z.literal("rekordbox-db"),
        dbPath: z.string(),
        folderName: z.string(),
        folderId: z.string(),
        playlistName: z.string(),
        playlistId: z.string(),
        backupDirectory: z.string(),
      })
      .optional(),
  }),
});

const databaseTrackOutput = z.object({
  order: z.number().int().positive(),
  isId: z.boolean().optional(),
  artist: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  mix: z.string().nullable().optional(),
  timestamp: z.string().nullable().optional(),
  links: z.union([z.record(z.string(), z.string()), z.array(z.string()), z.null()]).optional(),
});

const databaseTracklistOutput = z.object({
  url: z.string(),
  durationSeconds: z.number().positive().optional(),
  event: z.object({
    name: z.string(),
    date: z.string().optional(),
    djName: z.string().optional(),
    lineup: z.array(z.string()),
  }),
  tracks: z.array(databaseTrackOutput),
});

const summaryOutput = z.object({
  title: z.string(),
  url: z.string(),
  djName: z.string().optional(),
  durationSeconds: z.number().positive().optional(),
});

const providerStatusOutput = z.object({
  configured: z.boolean(),
  env: z.array(z.string()),
  capability: z.string(),
});

const providersOutput = z.object({
  description: providerStatusOutput,
  tracklists1001: providerStatusOutput,
  audd: providerStatusOutput,
  acrcloud: providerStatusOutput,
});

const toolStatusOutput = z.object({
  available: z.boolean(),
  command: z.string(),
  version: z.string().optional(),
  error: z.string().optional(),
});

const cacheStatsOutput = z.object({
  hits: z.number().nonnegative(),
  misses: z.number().nonnegative(),
  writes: z.number().nonnegative(),
  bypasses: z.number().nonnegative(),
  coalesced: z.number().nonnegative(),
  errors: z.number().nonnegative(),
  readMs: z.number().nonnegative(),
  loadMs: z.number().nonnegative(),
  writeMs: z.number().nonnegative(),
});

const workflowPerformanceOutput = z.object({
  startedAt: z.string(),
  finishedAt: z.string(),
  totalMs: z.number().nonnegative(),
  warmResume: z.boolean(),
  peakConcurrency: z.number().int().positive(),
  stages: z.array(
    z.object({
      stage: z.enum(["resolve", "source-set", "spotify", "acquisition", "analysis", "rekordbox"]),
      status: z.enum(["completed", "resumed", "skipped"]),
      durationMs: z.number().nonnegative(),
      operations: z.number().int().nonnegative().optional(),
      cacheHits: z.number().nonnegative().optional(),
      networkRequests: z.number().int().nonnegative().optional(),
      concurrency: z.number().int().nonnegative().optional(),
    }),
  ),
  caches: z.record(z.string(), cacheStatsOutput),
});

export const tracksCli = Cli.create("tracks", {
  version: VERSION,
  description: "Resolve DJ sets into resumable track manifests without downloading remote sets.",
  config: {
    flag: "config",
    files: ["tracks.json", "~/.config/tracks/config.json"],
  },
  mcp: {
    command: "tracks --mcp",
    instructions:
      "Use resolve for a DJ set URL. It inspects media metadata once, reads timestamped descriptions, checks an exact 1001Tracklists media association, then searches 1001Tracklists by the inspected title/uploader before recognition. Use import-set only for an explicitly approved local end-to-end run: it resumes the durable manifest, fans Spotify, individual-track acquisition, verification, and native analysis out to playlist-scale concurrency, then performs one verified normal Rekordbox database commit. It never downloads a remote source set; cue clips require both --allow-set-clips and an existing --source-set-path.",
  },
  sync: {
    cwd: import.meta.dirname,
    include: ["../skills/*"],
    suggestions: [
      "resolve a YouTube DJ set into a versioned track manifest",
      "find the 1001Tracklists entry for a YouTube URL",
      "search 1001Tracklists for a DJ set",
      "import an approved resolved set into Rekordbox at playlist-scale concurrency",
      "render a tracklist as YouTube chapters",
    ],
  },
});

tracksCli.command("import-set", {
  description:
    "Resume an approved set through resolution, Spotify enrichment, individual-track acquisition, 64-way native analysis, and one verified normal Rekordbox database commit.",
  args: z.object({ source: z.string().describe("YouTube/SoundCloud set URL or local set") }),
  env: importSetEnv,
  options: z.object({
    manifest: z.string().describe("Durable manifest path; reused on every resume"),
    outputDirectory: z.string().describe("Destination for individual recordings"),
    localDirectory: z
      .array(z.string())
      .default([])
      .describe("Existing recording directory to adopt; repeat for multiple directories"),
    provider,
    cacheMode: cacheModeOption,
    referenceYtdlp: z
      .boolean()
      .default(false)
      .describe("Explicitly permit the external yt-dlp reference fallback after Soulseek"),
    allowSetClips: z
      .boolean()
      .default(false)
      .describe("Explicitly permit cue-bounded clips from an existing local set recording"),
    sourceSetPath: z
      .string()
      .optional()
      .describe("Existing local set recording; never downloaded by this command"),
    sourceSetUrl: z
      .string()
      .optional()
      .describe("Canonical URL annotated on source-set clips; defaults to the input set URL"),
    acquisitionConcurrency: z
      .number()
      .int()
      .min(1)
      .max(MAX_ACQUISITION_CONCURRENCY)
      .default(DEFAULT_ACQUISITION_CONCURRENCY)
      .describe("Parallel independent recording variants; defaults to one 64-track wave"),
    verificationConcurrency: z
      .number()
      .int()
      .min(1)
      .max(MAX_VERIFICATION_CONCURRENCY)
      .default(DEFAULT_VERIFICATION_CONCURRENCY)
      .describe("Parallel media stat/hash/probe checks; defaults to 64"),
    spotifyConcurrency: z
      .number()
      .int()
      .min(1)
      .max(MAX_SPOTIFY_REFRESH_CONCURRENCY)
      .default(DEFAULT_SPOTIFY_REFRESH_CONCURRENCY)
      .describe("Parallel Spotify metadata requests; defaults to 64"),
    analysisConcurrency: z
      .number()
      .int()
      .min(1)
      .max(64)
      .default(64)
      .describe("Parallel native Rekordbox analyzer workers; defaults to 64"),
    dbPath: z.string().optional().describe("Normal Rekordbox master.db override"),
    dbDirectory: z.string().optional().describe("Rekordbox database directory override"),
    folderName: z.string().optional().describe("Destination Rekordbox folder"),
    playlistName: z.string().optional().describe("Destination Rekordbox playlist"),
    backupRoot: z.string().optional().describe("Backup directory root"),
    write: z
      .boolean()
      .default(false)
      .describe("Required acknowledgement for normal Rekordbox database mutation"),
    progress: z.enum(["auto", "always", "never"]).default("auto").describe("Progress on stderr"),
  }),
  output: z.object({
    manifestPath: z.string(),
    outputDirectory: z.string(),
    source: z.string(),
    entries: z.number().int().nonnegative(),
    downloaded: z.number().int().nonnegative(),
    resumed: z.number().int().nonnegative(),
    analyzed: z.number().int().nonnegative(),
    analysisCacheHits: z.number().int().nonnegative(),
    dbPath: z.string(),
    folderId: z.string(),
    playlistId: z.string(),
    backupDirectory: z.string(),
    performance: workflowPerformanceOutput,
  }),
  async run(context) {
    let soulseek: SoulseekClient | undefined;
    try {
      if (!context.options.write) {
        throw new TracksError(
          "INVALID_SOURCE",
          "Set import requires the explicit --write acknowledgement",
          { exitCode: 2 },
        );
      }
      const spotify = await workflowSpotifyClient(context.options.cacheMode);
      soulseek = new SoulseekClient();
      const acquirers = [
        new SoulseekLibraryAcquirer(soulseek, {
          environment: {
            SLSK_USERNAME: context.env.SLSK_USERNAME,
            SLSK_PASSWORD: context.env.SLSK_PASSWORD,
          },
        }),
        ...(context.options.referenceYtdlp
          ? [
              new YtdlpReferenceAcquirer(new ReferenceClient(), {
                cacheMode: context.options.cacheMode,
              }),
            ]
          : []),
      ];
      const showProgress =
        context.options.progress === "always" ||
        (context.options.progress === "auto" && !context.agent && !context.formatExplicit);
      const result = await runSetToRekordbox({
        source: context.args.source,
        manifestPath: context.options.manifest,
        outputDirectory: context.options.outputDirectory,
        approved: true,
        identify: {
          provider: context.options.provider,
          cacheMode: context.options.cacheMode,
          env: { ...process.env, ...context.env },
        },
        spotify,
        acquirers,
        localArtifactDirectories: context.options.localDirectory,
        allowSourceSetClips: context.options.allowSetClips,
        ...(context.options.sourceSetPath
          ? {
              sourceSet: {
                path: context.options.sourceSetPath,
                ...(context.options.sourceSetUrl ? { url: context.options.sourceSetUrl } : {}),
              },
            }
          : {}),
        cacheMode: context.options.cacheMode,
        acquisitionConcurrency: context.options.acquisitionConcurrency,
        verificationConcurrency: context.options.verificationConcurrency,
        spotifyConcurrency: context.options.spotifyConcurrency,
        analysisConcurrency: context.options.analysisConcurrency,
        rekordbox: {
          ...(context.options.dbPath ? { dbPath: context.options.dbPath } : {}),
          ...(context.options.dbDirectory ? { dbDirectory: context.options.dbDirectory } : {}),
          ...(context.options.folderName ? { folderName: context.options.folderName } : {}),
          ...(context.options.playlistName ? { playlistName: context.options.playlistName } : {}),
          ...(context.options.backupRoot ? { backupRoot: context.options.backupRoot } : {}),
        },
        ...(showProgress
          ? {
              onProgress(progress) {
                process.stderr.write(`[${progress.stage}] ${progress.message}\n`);
              },
            }
          : {}),
      });
      return {
        manifestPath: result.manifestPath,
        outputDirectory: result.outputDirectory,
        source: result.manifest.source.input,
        entries: result.manifest.entries.length,
        downloaded: result.acquisition.downloaded.length,
        resumed: result.acquisition.resumed.length,
        analyzed: result.analysis.analyzed,
        analysisCacheHits: result.analysis.cacheHits,
        dbPath: result.rekordbox.dbPath,
        folderId: result.rekordbox.folderId,
        playlistId: result.rekordbox.playlistId,
        backupDirectory: result.rekordbox.backup.directory,
        performance: result.performance,
      };
    } catch (error) {
      return fail(context, error);
    } finally {
      if (soulseek?.state !== "disconnected") await soulseek?.disconnect();
    }
  },
});

tracksCli.command("resolve", {
  aliases: ["identify"],
  description:
    "Resolve a set by inspecting its URL, reading timestamped metadata, matching 1001Tracklists by URL then title/uploader, and only then using recognition—without downloading the remote set.",
  args: z.object({ source: z.string().describe("YouTube/SoundCloud URL or local audio file") }),
  options: identifyOptions,
  env: providerEnv,
  output: manifestOutput,
  alias: {
    provider: "p",
    interval: "i",
    concurrency: "c",
  },
  examples: [
    {
      args: { source: "https://www.youtube.com/watch?v=vtJ100Znqw0" },
      description:
        "Inspect the YouTube title/uploader, read timestamps, then match 1001Tracklists by URL or title before recognition",
    },
    {
      args: { source: "set.mp3" },
      options: { provider: "audd", strategy: "samples", interval: 45 },
      description: "Sample a local set every 45 seconds with AudD Standard",
    },
  ],
  async run(context) {
    try {
      return createManifest(
        await identify(context.args.source, {
          provider: context.options.provider,
          strategy: context.options.strategy,
          preferDatabase: context.options.preferDatabase,
          preferDescription: context.options.preferDescription,
          full: context.options.full,
          every: context.options.every,
          skip: context.options.skip,
          ...(context.options.limit === undefined ? {} : { limit: context.options.limit }),
          ...(context.options.start === undefined
            ? {}
            : { startSeconds: requireTimestamp(context.options.start) }),
          intervalSeconds: context.options.interval,
          clipSeconds: context.options.clip,
          concurrency: context.options.concurrency,
          minScore: context.options.minScore,
          blendScore: context.options.blendScore,
          includeMatches: context.options.includeMatches,
          ...(context.options.cookies ? { cookies: context.options.cookies } : {}),
          ...(context.options.cookiesFromBrowser
            ? { cookiesFromBrowser: context.options.cookiesFromBrowser }
            : {}),
          cacheMode: context.options.cacheMode,
          env: { ...process.env, ...context.env },
          onProgress(progress) {
            if (
              context.options.progress === "always" ||
              (context.options.progress === "auto" && !context.agent && !context.formatExplicit)
            ) {
              const count =
                progress.current === undefined
                  ? ""
                  : ` ${progress.current}/${progress.total ?? "?"}`;
              process.stderr.write(`[${progress.phase}]${count} ${progress.message}\n`);
            }
          },
        }),
      );
    } catch (error) {
      return fail(context, error);
    }
  },
});

const one001 = Cli.create("1001", {
  description: "Read 1001Tracklists through the managed Parse wrapper.",
});

one001.command("get", {
  description: "Get a complete tracklist by 1001Tracklists URL.",
  args: z.object({ url: z.url().describe("1001Tracklists tracklist URL") }),
  env: parseEnv,
  options: z.object({ cacheMode: cacheModeOption }),
  output: databaseTracklistOutput,
  async run(context) {
    try {
      return await parseClient(context.env, context.options.cacheMode).get(context.args.url);
    } catch (error) {
      return fail(context, error);
    }
  },
});

one001.command("find", {
  description: "Find the tracklist referencing a YouTube or SoundCloud URL.",
  args: z.object({ url: z.url().describe("YouTube or SoundCloud media URL") }),
  env: parseEnv,
  options: z.object({ cacheMode: cacheModeOption }),
  output: z.union([
    z.object({ found: z.literal(false) }),
    databaseTracklistOutput.extend({ found: z.literal(true) }),
  ]),
  async run(context) {
    try {
      return await parseClient(context.env, context.options.cacheMode).findByMediaUrl(
        context.args.url,
      );
    } catch (error) {
      return fail(context, error);
    }
  },
});

one001.command("search", {
  description: "Search DJ-set tracklist pages by title.",
  args: z.object({ title: z.string().min(1).describe("Set title or search text") }),
  options: z.object({
    uploader: z.string().optional().describe("DJ or uploader used to narrow results"),
    cacheMode: cacheModeOption,
  }),
  env: parseEnv,
  output: z.object({ items: z.array(summaryOutput) }),
  async run(context) {
    try {
      return await parseClient(context.env, context.options.cacheMode).search(
        context.args.title,
        context.options.uploader,
      );
    } catch (error) {
      return fail(context, error);
    }
  },
});

one001.command("latest", {
  description: "List tracklists most recently added to 1001Tracklists.",
  env: parseEnv,
  options: z.object({ cacheMode: cacheModeOption }),
  output: z.object({ items: z.array(summaryOutput) }),
  async run(context) {
    try {
      return await parseClient(context.env, context.options.cacheMode).latest();
    } catch (error) {
      return fail(context, error);
    }
  },
});

one001.command("charts", {
  description: "List a current 1001Tracklists chart.",
  options: z.object({
    type: z.enum(["weekly", "trending", "mostheard"]).default("weekly").describe("Chart type"),
    cacheMode: cacheModeOption,
  }),
  env: parseEnv,
  output: z.object({
    chart: z.string(),
    items: z.array(
      z.object({ name: z.string(), url: z.string(), rank: z.number().int().positive().optional() }),
    ),
  }),
  async run(context) {
    try {
      return await parseClient(context.env, context.options.cacheMode).charts(context.options.type);
    } catch (error) {
      return fail(context, error);
    }
  },
});

tracksCli.command(one001);

const manifest = Cli.create("manifest", {
  description: "Validate and summarize resumable DJ-set pipeline manifests.",
});

const stageCountOutput = z.object({ status: z.string(), count: z.number().int().nonnegative() });

manifest.command("validate", {
  description: "Strictly validate a pipeline manifest and summarize its stage states.",
  args: z.object({ file: z.string().describe("Path to a dj-set-pipeline JSON manifest") }),
  output: z.object({
    valid: z.literal(true),
    schemaVersion: z.literal(1),
    kind: z.literal("dj-set-pipeline"),
    source: z.object({ input: z.string(), title: z.string().optional() }),
    entries: z.number().int().nonnegative(),
    identified: z.number().int().nonnegative(),
    unidentified: z.number().int().nonnegative(),
    spotify: z.array(stageCountOutput),
    acquisition: z.array(stageCountOutput),
    rekordbox: z.array(stageCountOutput),
  }),
  async run(context) {
    try {
      const value = await readJsonFile(context.args.file);
      const parsed = parseManifest(asData(value));
      const identified = parsed.entries.filter(
        (entry) => entry.identity.status === "identified",
      ).length;
      return {
        valid: true as const,
        schemaVersion: parsed.schemaVersion,
        kind: parsed.kind,
        source: {
          input: parsed.source.input,
          ...(parsed.source.title ? { title: parsed.source.title } : {}),
        },
        entries: parsed.entries.length,
        identified,
        unidentified: parsed.entries.length - identified,
        spotify: stageCounts(parsed.entries.map((entry) => entry.spotify.status)),
        acquisition: stageCounts(parsed.entries.map((entry) => entry.acquisition.status)),
        rekordbox: stageCounts(parsed.entries.map((entry) => entry.rekordbox.status)),
      };
    } catch (error) {
      return fail(context, error);
    }
  },
});

tracksCli.command(manifest);

tracksCli.command("render", {
  description: "Render a JSON tracklist as text, YouTube chapters, or a CUE sheet.",
  args: z.object({
    file: z.string().describe("JSON file produced by `tracks identify --format json`"),
  }),
  options: z.object({
    style: z.enum(["text", "youtube", "cue"]).default("text").describe("Output style"),
    audioFile: z.string().optional().describe("Audio filename embedded in CUE output"),
  }),
  alias: { style: "s" },
  output: z.string(),
  async run(context) {
    try {
      const json = await readJsonFile(context.args.file);
      return renderTracklist(parseTracklistJson(json), {
        style: context.options.style,
        ...(context.options.audioFile ? { audioFile: context.options.audioFile } : {}),
      });
    } catch (error) {
      return fail(context, error);
    }
  },
});

tracksCli.command("providers", {
  description: "Show configured providers without revealing secrets.",
  env: providerEnv,
  output: providersOutput,
  run(context) {
    return providerStatus({ ...process.env, ...context.env });
  },
});

tracksCli.command("doctor", {
  description: "Check resolution providers and local-file sampling dependencies.",
  env: providerEnv,
  output: z.object({
    providers: providersOutput,
    tools: z.object({
      ytdlpTs: toolStatusOutput,
      ffmpeg: toolStatusOutput,
      ffprobe: toolStatusOutput,
    }),
    readyForLookup: z.boolean(),
    readyForResolution: z.boolean(),
    readyForRecognition: z.boolean(),
    ready: z.boolean(),
  }),
  async run(context) {
    const env = { ...process.env, ...context.env };
    const ytdlpTs = await getYtdlpTsCommand(env);
    const tools = await Promise.all([
      toolStatus(ytdlpTs.executable, [...ytdlpTs.prefix, "--version"]),
      toolStatus(env.FFMPEG_PATH ?? "ffmpeg", ["-version"]),
      toolStatus(env.FFPROBE_PATH ?? "ffprobe", ["-version"]),
    ]);
    const acrConfigured = Boolean(env.ACR_HOST && env.ACR_ACCESS_KEY && env.ACR_ACCESS_SECRET);
    const readyForRecognition = Boolean(
      env.AUDD_API_TOKEN || (acrConfigured && tools[1]?.available && tools[2]?.available),
    );
    const readyForResolution = Boolean(
      tools[0]?.available || env.PARSE_API_KEY || readyForRecognition,
    );
    return {
      providers: providerStatus(env),
      tools: {
        ytdlpTs: tools[0],
        ffmpeg: tools[1],
        ffprobe: tools[2],
      },
      readyForLookup: Boolean(env.PARSE_API_KEY),
      readyForResolution,
      readyForRecognition,
      ready: readyForResolution,
    };
  },
});

function parseClient(
  env: {
    PARSE_API_KEY?: string | undefined;
    PARSE_API_BASE?: string | undefined;
    PARSE_SCRAPER_ID?: string | undefined;
  },
  cacheMode: "default" | "refresh" | "off" = "default",
): Tracklists1001Client {
  if (!env.PARSE_API_KEY) {
    throw new TracksError("AUTH_REQUIRED", "PARSE_API_KEY is required for 1001Tracklists access", {
      exitCode: 2,
    });
  }
  return new Tracklists1001Client({
    apiKey: env.PARSE_API_KEY,
    baseUrl:
      env.PARSE_API_BASE ??
      (env.PARSE_SCRAPER_ID
        ? `https://api.parse.bot/scraper/${env.PARSE_SCRAPER_ID}`
        : DEFAULT_PARSE_API_BASE),
    cacheMode,
  });
}

function providerStatus(env: Environment) {
  return {
    description: {
      configured: true,
      env: ["YTDLP_TS_PATH"],
      capability: "Metadata-only YouTube/SoundCloud description resolution via ytdlp-ts",
    },
    tracklists1001: {
      configured: Boolean(env.PARSE_API_KEY),
      env: ["PARSE_API_KEY"],
      capability: "Existing 1001Tracklists lookup, search, latest, and charts",
    },
    audd: {
      configured: Boolean(env.AUDD_API_TOKEN),
      env: ["AUDD_API_TOKEN"],
      capability: "Direct long-file and YouTube audio recognition",
    },
    acrcloud: {
      configured: Boolean(env.ACR_HOST && env.ACR_ACCESS_KEY && env.ACR_ACCESS_SECRET),
      env: ["ACR_HOST", "ACR_ACCESS_KEY", "ACR_ACCESS_SECRET"],
      capability: "Local short-clip fingerprint sampling",
    },
  };
}

async function workflowSpotifyClient(
  cacheMode: "default" | "refresh" | "off",
): Promise<CachedSpotifyClient> {
  const store = new FileSessionStore();
  const session = await store.load();
  if (!session) {
    throw new TracksError(
      "AUTH_REQUIRED",
      "No spots OAuth session found; run `spots auth login` before import-set",
      { exitCode: 2 },
    );
  }
  const credential = session.token.refreshToken ?? session.token.accessToken;
  const client = new SpotifyClient({
    auth: new SpotifyOAuth({
      clientId: session.clientId,
      redirectUri: session.redirectUri,
      store,
    }),
  });
  return new CachedSpotifyClient(client, {
    cacheMode,
    cacheScope: cacheDigest({
      provider: "spotify",
      clientId: session.clientId,
      credential,
    }),
  });
}

async function toolStatus(command: string, args: string[]) {
  try {
    const result = await runProcess(command, args, { maxOutputBytes: 1024 * 1024 });
    const version = `${result.stdout}\n${result.stderr}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return { available: true, command, ...(version ? { version } : {}) };
  } catch (error) {
    return { available: false, command, error: errorMessage(error) };
  }
}

function asData(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return "data" in value ? (value as { data: unknown }).data : value;
}

async function readJsonFile(path: string): Promise<unknown> {
  const bytes = (await stat(path)).size;
  const maxBytes = 20 * 1024 * 1024;
  if (bytes > maxBytes) {
    throw new TracksError(
      "INVALID_SOURCE",
      `JSON file is ${bytes} bytes; maximum supported size is ${maxBytes}`,
      { exitCode: 2 },
    );
  }
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function stageCounts(statuses: readonly string[]): { status: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => ({
      status,
      count,
    }));
}

function fail(
  context: {
    error(options: {
      code: string;
      exitCode?: number;
      message: string;
      retryable?: boolean;
      cta?: { commands: string[] };
    }): never;
  },
  error: unknown,
): never {
  if (error instanceof TracksError) {
    return context.error({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      exitCode: error.exitCode,
      ...(error.code === "AUTH_REQUIRED" ? { cta: { commands: ["doctor"] } } : {}),
    });
  }
  return context.error({
    code: "TRACKS_ERROR",
    message: errorMessage(error),
    retryable: false,
    exitCode: 1,
  });
}

export async function runTracksCli(argv = process.argv.slice(2)): Promise<void> {
  loadWorkspaceEnvironment();
  await tracksCli.serve(argv);
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isMainModule()) await runTracksCli();

export default tracksCli;
