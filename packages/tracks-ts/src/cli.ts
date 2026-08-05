#!/usr/bin/env node

import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
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
  type TrackAcquirer,
} from "./acquire-manifest.js";
import { readManifest } from "./acquisition.js";
import { analyzeExistingManifest } from "./analyze-existing.js";
import { cacheDigest, type CacheMode } from "./cache.js";
import { TracksError, errorMessage } from "./errors.js";
import { identify } from "./identify.js";
import { CachedSpotifyClient } from "./integrations/spotify-cache.js";
import { SoulseekLibraryAcquirer } from "./integrations/slsk-library.js";
import { getYtdlpTsCommand } from "./integrations/ytdlp.js";
import {
  YtdlpNativeAcquirer,
  YtdlpReferenceAcquirer,
  type YtdlpReferenceClient,
} from "./integrations/ytdlp-library.js";
import { defaultTrackLibraryRoot } from "./library-paths.js";
import { createManifest, parseManifest } from "./manifest.js";
import { enrichRekordboxMetadata } from "./metadata-enrichment.js";
import { runProcess } from "./process.js";
import { DEFAULT_PARSE_API_BASE, Tracklists1001Client } from "./providers/tracklists1001.js";
import {
  DEFAULT_RECOGNITION_CONCURRENCY,
  MAX_RECOGNITION_CONCURRENCY,
} from "./recognize-samples.js";
import { parseTracklistJson, renderTracklist } from "./render.js";
import { importManifestToRekordbox } from "./rekordbox-db.js";
import { requireTimestamp } from "./time.js";
import type { Environment } from "./types.js";
import {
  ReferenceSourceMetadataClient,
  SpotifySourceMetadataClient,
  type ExactSourceMetadataClient,
} from "./source-metadata.js";
import {
  DEFAULT_NATIVE_ANALYSIS_CONCURRENCY,
  DEFAULT_NATIVE_ANALYSIS_THREAD_BUDGET,
  MAX_NATIVE_ANALYSIS_CONCURRENCY,
  MAX_NATIVE_ANALYSIS_THREAD_BUDGET,
  runSetToRekordbox,
} from "./workflow.js";

const { version: VERSION } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

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

const provider = z
  .enum(["auto", "description", "1001tracklists", "audd", "acrcloud"])
  .default("auto")
  .describe("Resolution provider");

const providerEnv = z.object({
  PARSE_API_KEY: z.string().optional().describe("Parse API key for 1001Tracklists access"),
  PARSE_API_BASE: z.string().optional().describe("Override the complete Parse scraper base URL"),
  PARSE_SCRAPER_ID: z.string().optional().describe("Override the Parse canonical scraper ID"),
  TRACKS_1001_BROWSER_PATH: z
    .string()
    .optional()
    .describe("NanoCodex profile-session executable for headed 1001 fallback"),
  TRACKS_1001_BROWSER_SOURCE: z
    .enum(["brave", "chrome"])
    .optional()
    .describe("Source browser for allowlisted 1001 cookies"),
  TRACKS_1001_BROWSER_PROFILE: z.string().optional().describe("Source browser profile directory"),
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
  TRACKS_1001_BROWSER_PATH: z
    .string()
    .optional()
    .describe("NanoCodex profile-session executable for headed 1001 fallback"),
  TRACKS_1001_BROWSER_SOURCE: z.enum(["brave", "chrome"]).optional(),
  TRACKS_1001_BROWSER_PROFILE: z.string().optional(),
});

const importSetEnv = providerEnv.extend({
  SLSK_USERNAME: z.string().optional().describe("Soulseek username"),
  SLSK_PASSWORD: z.string().optional().describe("Soulseek password"),
  DJBOOTH_LIBRARY_ROOT: z
    .string()
    .optional()
    .describe("Canonical artist/album recording root; default ~/.djtools/tracks"),
  MUSIC_LIBRARY_ROOT: z.string().optional().describe("Legacy alias for DJBOOTH_LIBRARY_ROOT"),
});

const cacheModeOption = z
  .enum(["default", "refresh", "off"])
  .default("default")
  .describe("Use, refresh, or bypass the persistent provider metadata cache");

export type ImportSetAcquirerFactories = {
  soulseek(): TrackAcquirer;
  nativeYtdlp(): TrackAcquirer;
  referenceYtdlp(): TrackAcquirer;
};

export function orderedImportSetAcquirers(
  referenceYtdlp: boolean,
  factories: ImportSetAcquirerFactories,
): TrackAcquirer[] {
  const acquirers = [factories.soulseek(), factories.nativeYtdlp()];
  if (referenceYtdlp) acquirers.push(factories.referenceYtdlp());
  return acquirers;
}

export function createImportSetReferenceAcquirer(
  client: YtdlpReferenceClient,
  cacheMode: CacheMode,
): YtdlpReferenceAcquirer {
  return new YtdlpReferenceAcquirer(client, {
    cacheMode,
    requiresPriorCapabilityFailure: true,
  });
}

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

const mediaLinkOutput = z.object({
  platform: z.string(),
  sourceId: z.string(),
  url: z.string(),
  embedUrl: z.string().optional(),
  durationSeconds: z.number().int().positive().optional(),
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
  mediaLinks: z.array(mediaLinkOutput).optional(),
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
    suggestions: z
      .array(
        z.object({
          id: z.string(),
          position: z.number().int().positive(),
          positionId: z.string(),
          type: z.number().int().nonnegative(),
          text: z.string(),
          timestamp: z.string().optional(),
          startSeconds: z.number().nonnegative().optional(),
          submitter: z.string().optional(),
        }),
      )
      .optional(),
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
      })
      .optional(),
  }),
});

const databaseTrackOutput = z.object({
  order: z.number().int().positive(),
  isId: z.boolean().optional(),
  positionId: z.string().optional(),
  trackId: z.string().optional(),
  mediaItemId: z.string().optional(),
  kind: z.enum(["position", "mashup-part"]).optional(),
  durationSeconds: z.number().int().positive().optional(),
  artist: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  mix: z.string().nullable().optional(),
  timestamp: z.string().nullable().optional(),
  links: z.union([z.record(z.string(), z.string()), z.array(z.string()), z.null()]).optional(),
  media: z.array(mediaLinkOutput).optional(),
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
  suggestions: z
    .array(
      z.object({
        id: z.string(),
        position: z.number().int().positive(),
        positionId: z.string(),
        type: z.number().int(),
        text: z.string(),
        timestamp: z.string().optional(),
        startSeconds: z.number().nonnegative().optional(),
        submitter: z.string().optional(),
      }),
    )
    .optional(),
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
  automation: z.object({
    spotifyCanonicalSelections: z.number().int().nonnegative(),
    acquisitionPasses: z.number().int().positive(),
    sourceSetFallbacks: z.number().int().nonnegative(),
  }),
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
  description:
    "Resolve DJ sets or run one resumable resolve→enrich→acquire→analyze→Rekordbox playlist import.",
  hint: "One-shot: tracks import-set <set-url> --manifest <path> defaults to clean Auto rhythm and automatic cue-bounded set recovery; add --analysis-rhythm-mode dynamic for known live/rubato sets. Pass --source-set-path only to reuse an existing local set recording.",
  config: {
    flag: "config",
    files: ["tracks.json", "~/.config/tracks/config.json"],
  },
  mcp: {
    command: "tracks --mcp",
    instructions:
      "Use resolve for metadata-only DJ-set resolution. Use enrich as the idempotent whole-library metadata stage; it writes one verified update by default and supports --dry-run or optional --folder scoping. For an end-to-end request, call import-set once instead of manually sequencing resolve, Spotify, download, analysis, and playlist commands. import-set resumes one durable manifest, auto-selects a deterministic Spotify acquisition primary while retaining all alternatives, stores verified recordings under the canonical artist/album root, starts the clean-room analyzer with Auto rhythm mode as recordings verify, and creates or updates the ordered playlist in one verified Rekordbox database commit with analyzer BPM/key. Failed individual acquisitions automatically use cue-bounded recovery from the cached source set. --source-set-path overrides that cache with an existing local recording.",
  },
});

const metadataCoverageOutput = z.object({
  album: z.number().int().nonnegative(),
  label: z.number().int().nonnegative(),
  genre: z.number().int().nonnegative(),
  isrc: z.number().int().nonnegative(),
  releaseDate: z.number().int().nonnegative(),
});

tracksCli.command("enrich", {
  description:
    "Idempotently enrich every Rekordbox track from durable provenance, local metadata, Apple, Spotify, Discogs, Deezer, and MusicBrainz.",
  options: z.object({
    folder: z.string().optional().describe("Optional direct-child playlist-folder scope"),
    dbPath: z.string().optional().describe("Normal Rekordbox master.db override"),
    dbDirectory: z.string().optional().describe("Rekordbox database directory override"),
    manifestRoot: z
      .array(z.string())
      .default([])
      .describe("Manifest search root; repeat as needed; defaults to ~/.djtools and ~/Music"),
    catalogSearch: z
      .boolean()
      .default(true)
      .describe(
        "Allow strict Apple, Spotify, Discogs, Deezer, and MusicBrainz artist/title search for tracks without ISRC",
      ),
    cacheMode: cacheModeOption,
    probeConcurrency: z.number().int().min(1).max(32).default(8),
    dryRun: z.boolean().default(false).describe("Plan enrichment without updating Rekordbox"),
    progress: z.enum(["auto", "always", "never"]).default("auto"),
  }),
  output: z.object({
    dbPath: z.string(),
    scope: z.union([
      z.object({ kind: z.literal("library") }),
      z.object({ kind: z.literal("folder"), name: z.string() }),
    ]),
    tracks: z.number().int().nonnegative(),
    changed: z.number().int().nonnegative(),
    written: z.boolean(),
    coverageBefore: metadataCoverageOutput,
    coverageAfter: metadataCoverageOutput,
    sources: z.object({
      apple: z.number().int().nonnegative(),
      bandcamp: z.number().int().nonnegative(),
      deezer: z.number().int().nonnegative(),
      discogs: z.number().int().nonnegative(),
      embedded: z.number().int().nonnegative(),
      filename: z.number().int().nonnegative(),
      linkpage: z.number().int().nonnegative(),
      local: z.number().int().nonnegative(),
      "local-artist": z.number().int().nonnegative(),
      "local-release": z.number().int().nonnegative(),
      manifest: z.number().int().nonnegative(),
      musicbrainz: z.number().int().nonnegative(),
      sanitized: z.number().int().nonnegative(),
      sidecar: z.number().int().nonnegative(),
      soundcloud: z.number().int().nonnegative(),
      spotify: z.number().int().nonnegative(),
      title: z.number().int().nonnegative(),
      youtube: z.number().int().nonnegative(),
    }),
    catalogQueries: z.number().int().nonnegative(),
    catalogMatches: z.number().int().nonnegative(),
    providers: z.record(
      z.string(),
      z.object({
        queries: z.number().int().nonnegative(),
        matches: z.number().int().nonnegative(),
        fields: z.number().int().nonnegative(),
        cache: cacheStatsOutput.optional(),
      }),
    ),
    provenance: z.object({
      tracks: z.number().int().nonnegative(),
      links: z.number().int().nonnegative(),
      byProvider: z.record(z.string(), z.number().int().nonnegative()),
    }),
    unresolvedSummary: z.object({
      tracks: z.number().int().nonnegative(),
      fields: z.number().int().nonnegative(),
      byField: z.object({
        album: z.number().int().nonnegative(),
        label: z.number().int().nonnegative(),
        genre: z.number().int().nonnegative(),
      }),
      byReason: z.object({
        "catalog-miss": z.number().int().nonnegative(),
        "catalog-genre-too-broad": z.number().int().nonnegative(),
        "edit-or-unreleased": z.number().int().nonnegative(),
        "genre-taxonomy-missing": z.number().int().nonnegative(),
        "identity-unparsed": z.number().int().nonnegative(),
        "no-isrc": z.number().int().nonnegative(),
        "no-exact-source": z.number().int().nonnegative(),
        "source-metadata-miss": z.number().int().nonnegative(),
        "set-extract": z.number().int().nonnegative(),
      }),
    }),
    unresolved: z.array(
      z.object({
        contentId: z.string(),
        title: z.string(),
        artist: z.string().optional(),
        missing: z.array(z.enum(["album", "label", "genre"])),
        reasons: z.array(
          z.enum([
            "catalog-miss",
            "catalog-genre-too-broad",
            "edit-or-unreleased",
            "genre-taxonomy-missing",
            "identity-unparsed",
            "no-isrc",
            "no-exact-source",
            "source-metadata-miss",
            "set-extract",
          ]),
        ),
      }),
    ),
    changes: z.array(
      z.object({
        contentId: z.string(),
        title: z.string(),
        artist: z.string().optional(),
        updatedTitle: z.string().optional(),
        updatedArtist: z.string().optional(),
        album: z.string().nullable().optional(),
        label: z.string().nullable().optional(),
        genre: z.string().nullable().optional(),
        isrc: z.string().nullable().optional(),
        releaseDate: z.string().nullable().optional(),
        sources: z.record(
          z.string(),
          z.enum([
            "apple",
            "deezer",
            "discogs",
            "bandcamp",
            "embedded",
            "filename",
            "linkpage",
            "local",
            "local-artist",
            "local-release",
            "manifest",
            "musicbrainz",
            "sanitized",
            "sidecar",
            "soundcloud",
            "spotify",
            "title",
            "youtube",
          ]),
        ),
      }),
    ),
  }),
  async run(context) {
    try {
      const sourceClients = await metadataSourceClients(context.options.cacheMode);
      const showProgress =
        context.options.progress === "always" ||
        (context.options.progress === "auto" && (context.agent || !context.formatExplicit));
      const result = await enrichRekordboxMetadata({
        write: !context.options.dryRun,
        ...(context.options.folder ? { folder: context.options.folder } : {}),
        catalogSearch: context.options.catalogSearch,
        catalogOptions: { cacheMode: context.options.cacheMode },
        appleOptions: { cacheMode: context.options.cacheMode },
        deezerOptions: { cacheMode: context.options.cacheMode },
        discogsOptions: { cacheMode: context.options.cacheMode },
        sourceClients,
        probeConcurrency: context.options.probeConcurrency,
        ...(context.options.dbPath ? { dbPath: context.options.dbPath } : {}),
        ...(context.options.dbDirectory ? { dbDirectory: context.options.dbDirectory } : {}),
        ...(context.options.manifestRoot.length
          ? { manifestRoots: context.options.manifestRoot }
          : {}),
        ...(showProgress
          ? {
              onProgress(progress) {
                if (
                  progress.phase === "inventory" ||
                  progress.phase === "verify" ||
                  progress.current === 0 ||
                  progress.current === progress.total ||
                  progress.current % 10 === 0
                ) {
                  process.stderr.write(`[enrich:${progress.phase}] ${progress.message}\n`);
                }
              },
            }
          : {}),
      });
      return {
        dbPath: result.dbPath,
        scope: result.scope,
        tracks: result.tracks,
        changed: result.changed,
        written: result.written,
        coverageBefore: result.coverageBefore,
        coverageAfter: result.coverageAfter,
        sources: result.sources,
        catalogQueries: result.catalogQueries,
        catalogMatches: result.catalogMatches,
        providers: result.providers,
        provenance: result.provenance,
        unresolvedSummary: result.unresolvedSummary,
        unresolved: result.unresolved,
        changes: result.changes,
      };
    } catch (error) {
      return fail(context, error);
    }
  },
});

tracksCli.command("import-existing", {
  description:
    "Import checkpointed media and analyzer artifacts from one manifest in a single verified Rekordbox transaction.",
  args: z.object({ manifest: z.string().describe("Durable dj-set-pipeline manifest path") }),
  options: z.object({
    dbPath: z.string().optional().describe("Normal Rekordbox master.db override"),
    dbDirectory: z.string().optional().describe("Rekordbox database directory override"),
    folderName: z.string().optional().describe("Destination Rekordbox folder"),
    playlistName: z.string().optional().describe("Destination Rekordbox playlist"),
  }),
  output: z.object({
    manifestPath: z.string(),
    dbPath: z.string(),
    folderId: z.string(),
    playlistId: z.string(),
    imported: z.number().int().nonnegative(),
    expectedAnalysis: z.number().int().nonnegative(),
    verifiedAnalysis: z.number().int().nonnegative(),
    changed: z.boolean(),
    startedAt: z.string(),
    finishedAt: z.string(),
    totalMs: z.number().nonnegative(),
  }),
  async run(context) {
    try {
      const manifestPath = resolve(context.args.manifest);
      const manifest = await readManifest(manifestPath);
      const analysisDirectories = Object.fromEntries(
        (manifest.artifacts.analysis ?? []).map((artifact) => [
          resolve(artifact.mediaPath),
          dirname(resolve(artifact.summaryPath)),
        ]),
      );
      const result = await importManifestToRekordbox({
        manifest,
        manifestPath,
        analysisDirectories,
        ...(context.options.dbPath ? { dbPath: context.options.dbPath } : {}),
        ...(context.options.dbDirectory ? { dbDirectory: context.options.dbDirectory } : {}),
        ...(context.options.folderName ? { folderName: context.options.folderName } : {}),
        ...(context.options.playlistName ? { playlistName: context.options.playlistName } : {}),
      });
      return {
        manifestPath,
        dbPath: result.dbPath,
        folderId: result.folderId,
        playlistId: result.playlistId,
        imported: result.imported.length,
        expectedAnalysis: result.verification.expectedAnalysisCount,
        verifiedAnalysis: result.verification.verifiedAnalysisCount,
        changed: result.performance.changed,
        startedAt: result.performance.startedAt,
        finishedAt: result.performance.finishedAt,
        totalMs: result.performance.totalMs,
      };
    } catch (error) {
      return fail(context, error);
    }
  },
});

tracksCli.command("analyze-existing", {
  description:
    "Analyze only downloaded media already recorded in a durable manifest; never acquire, retag, or import.",
  args: z.object({ manifest: z.string().describe("Durable dj-set-pipeline manifest path") }),
  options: z.object({
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(MAX_NATIVE_ANALYSIS_CONCURRENCY)
      .default(DEFAULT_NATIVE_ANALYSIS_CONCURRENCY)
      .describe(
        `Parallel analyzer processes; CPU-adaptive default ${String(DEFAULT_NATIVE_ANALYSIS_CONCURRENCY)} here; more than one process per host core did not improve the profiled batch`,
      ),
    engine: z
      .enum(["clean", "reference"])
      .default("clean")
      .describe("Analyzer engine; clean is releasable, reference is a local parity oracle"),
    force: z.boolean().default(false).describe("Ignore valid cached analyzer summaries"),
    analyzerBinary: z.string().optional().describe("Selected analyzer binary override"),
    rekordboxApp: z
      .string()
      .optional()
      .describe("Reference-engine Rekordbox application directory override"),
    rekordboxCache: z
      .string()
      .optional()
      .describe("Reference-engine Rekordbox analysis cache override"),
    rhythmMode: z
      .enum(["normal", "dynamic", "auto"])
      .default("auto")
      .describe(
        "Beat grid: Auto for clean conservative selection; reference requires Normal or Dynamic",
      ),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .default(300_000)
      .describe("Per-track analyzer timeout in milliseconds"),
    threads: z
      .number()
      .int()
      .min(1)
      .max(MAX_NATIVE_ANALYSIS_THREAD_BUDGET)
      .default(DEFAULT_NATIVE_ANALYSIS_THREAD_BUDGET)
      .describe(
        `Total native scheduling slots shared across analyzer workers; profiled default ${String(DEFAULT_NATIVE_ANALYSIS_THREAD_BUDGET)} here keeps independent Auto DSP branches runnable`,
      ),
    progress: z.enum(["auto", "always", "never"]).default("auto").describe("Progress on stderr"),
  }),
  output: z.object({
    manifestPath: z.string(),
    requested: z.number().int().nonnegative(),
    analyzed: z.number().int().nonnegative(),
    cacheHits: z.number().int().nonnegative(),
    concurrency: z.number().int().nonnegative(),
    threadBudget: z.number().int().positive(),
    workerThreadBudgets: z.array(z.number().int().positive()),
    engine: z.enum(["clean", "reference"]),
    rhythmMode: z.enum(["normal", "dynamic", "auto"]),
    analysisDirectories: z.record(z.string(), z.string()),
    startedAt: z.string(),
    finishedAt: z.string(),
    totalMs: z.number().nonnegative(),
  }),
  async run(context) {
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error("Analysis cancelled by process signal"));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const showProgress =
        context.options.progress === "always" ||
        (context.options.progress === "auto" && (context.agent || !context.formatExplicit));
      const result = await analyzeExistingManifest({
        manifestPath: context.args.manifest,
        concurrency: context.options.concurrency,
        engine: context.options.engine,
        force: context.options.force,
        rhythmMode: context.options.rhythmMode,
        timeoutMs: context.options.timeoutMs,
        signal: controller.signal,
        threads: context.options.threads,
        ...(context.options.analyzerBinary
          ? { analyzerBinary: context.options.analyzerBinary }
          : {}),
        ...(context.options.rekordboxApp ? { rekordboxApp: context.options.rekordboxApp } : {}),
        ...(context.options.rekordboxCache
          ? { rekordboxCache: context.options.rekordboxCache }
          : {}),
        ...(showProgress
          ? {
              onProgress(progress) {
                process.stderr.write(
                  `[${new Date().toISOString()}] [analysis:${progress.phase}] ${String(progress.completed)}/${String(progress.total)} ${progress.audioPath}\n`,
                );
              },
            }
          : {}),
      });
      return {
        manifestPath: result.manifestPath,
        requested: result.analysis.requested,
        analyzed: result.analysis.analyzed,
        cacheHits: result.analysis.cacheHits,
        concurrency: result.analysis.concurrency,
        threadBudget: result.analysis.threadBudget,
        workerThreadBudgets: result.analysis.workerThreadBudgets,
        engine: context.options.engine,
        rhythmMode: context.options.rhythmMode,
        analysisDirectories: result.analysisDirectories,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        totalMs: result.totalMs,
      };
    } catch (error) {
      return fail(context, error);
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  },
});

tracksCli.command("import-set", {
  description:
    "One-shot a set through resolution, deterministic Spotify primary selection, canonical acquisition, automatic cue fallback, clean-room analysis, and one verified ordered Rekordbox playlist commit.",
  hint: "This is the full set workflow; clean Auto rhythm analysis and failed-track recovery from bounded set cues are automatic. Use --analysis-rhythm-mode dynamic for known live/rubato sets; --source-set-path optionally reuses a local set.",
  args: z.object({ source: z.string().describe("YouTube/SoundCloud set URL or local set") }),
  env: importSetEnv,
  options: z.object({
    manifest: z.string().describe("Durable manifest path; reused on every resume"),
    outputDirectory: z
      .string()
      .optional()
      .describe(
        "Canonical artist/album library root; defaults to DJBOOTH_LIBRARY_ROOT or ~/.djtools/tracks",
      ),
    localDirectory: z
      .array(z.string())
      .default([])
      .describe("Existing recording directory to adopt; repeat for multiple directories"),
    provider,
    cacheMode: cacheModeOption,
    referenceYtdlp: z
      .boolean()
      .default(false)
      .describe(
        "Explicitly permit external yt-dlp after Soulseek and a typed native capability gap",
      ),
    sourceSetPath: z
      .string()
      .optional()
      .describe(
        "Optional existing local set recording; overrides automatic caching of the exact public set",
      ),
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
      .describe("Parallel independent recording variants; defaults to 3"),
    verificationConcurrency: z
      .number()
      .int()
      .min(1)
      .max(MAX_VERIFICATION_CONCURRENCY)
      .default(DEFAULT_VERIFICATION_CONCURRENCY)
      .describe("Parallel media stat/hash/probe checks; defaults to 8"),
    spotifyConcurrency: z
      .number()
      .int()
      .min(1)
      .max(MAX_SPOTIFY_REFRESH_CONCURRENCY)
      .default(DEFAULT_SPOTIFY_REFRESH_CONCURRENCY)
      .describe("Parallel Spotify metadata requests; defaults to 8"),
    analysisConcurrency: z
      .number()
      .int()
      .min(1)
      .max(MAX_NATIVE_ANALYSIS_CONCURRENCY)
      .default(DEFAULT_NATIVE_ANALYSIS_CONCURRENCY)
      .describe(
        `Parallel analyzer processes; CPU-adaptive default ${String(DEFAULT_NATIVE_ANALYSIS_CONCURRENCY)} here; more than one process per host core did not improve the profiled batch`,
      ),
    analysisThreads: z
      .number()
      .int()
      .min(1)
      .max(MAX_NATIVE_ANALYSIS_THREAD_BUDGET)
      .default(DEFAULT_NATIVE_ANALYSIS_THREAD_BUDGET)
      .describe(
        `Total native scheduling slots shared across analyzer workers; profiled default ${String(DEFAULT_NATIVE_ANALYSIS_THREAD_BUDGET)} here keeps independent Auto DSP branches runnable`,
      ),
    analysisEngine: z
      .enum(["clean", "reference"])
      .default("clean")
      .describe(
        "Analyzer engine; clean is default, reference is a local proprietary parity oracle",
      ),
    analysisRhythmMode: z
      .enum(["normal", "dynamic", "auto"])
      .default("auto")
      .describe(
        "Beat grid: Auto selects Dynamic only for material tempo motion; reference engine requires Normal or Dynamic",
      ),
    analyzerBinary: z.string().optional().describe("Selected analyzer binary override"),
    rekordboxApp: z
      .string()
      .optional()
      .describe("Reference-engine Rekordbox application directory override"),
    rekordboxCache: z
      .string()
      .optional()
      .describe("Reference-engine Rekordbox analysis cache override"),
    analysisTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(300_000)
      .describe("Per-track analyzer timeout in milliseconds"),
    dbPath: z.string().optional().describe("Normal Rekordbox master.db override"),
    dbDirectory: z.string().optional().describe("Rekordbox database directory override"),
    folderName: z.string().optional().describe("Destination Rekordbox folder"),
    playlistName: z.string().optional().describe("Destination Rekordbox playlist"),
    progress: z.enum(["auto", "always", "never"]).default("auto").describe("Progress on stderr"),
  }),
  output: z.object({
    manifestPath: z.string(),
    outputDirectory: z.string(),
    source: z.string(),
    entries: z.number().int().nonnegative(),
    downloaded: z.number().int().nonnegative(),
    resumed: z.number().int().nonnegative(),
    spotifyCanonicalSelections: z.number().int().nonnegative(),
    acquisitionPasses: z.number().int().positive(),
    sourceSetFallbacks: z.number().int().nonnegative(),
    analyzed: z.number().int().nonnegative(),
    analysisCacheHits: z.number().int().nonnegative(),
    analysisEngine: z.enum(["clean", "reference"]),
    analysisRhythmMode: z.enum(["normal", "dynamic", "auto"]),
    analysisThreads: z.number().int().positive(),
    dbPath: z.string(),
    folderId: z.string(),
    playlistId: z.string(),
    performance: workflowPerformanceOutput,
  }),
  async run(context) {
    let soulseek: SoulseekClient | undefined;
    const controller = new AbortController();
    const cancel = () => controller.abort(new DOMException("Import interrupted", "AbortError"));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const spotify = await workflowSpotifyClient(context.options.cacheMode);
      soulseek = new SoulseekClient();
      const acquirers = orderedImportSetAcquirers(context.options.referenceYtdlp, {
        soulseek: () =>
          new SoulseekLibraryAcquirer(soulseek!, {
            signal: controller.signal,
            environment: {
              SLSK_USERNAME: context.env.SLSK_USERNAME,
              SLSK_PASSWORD: context.env.SLSK_PASSWORD,
            },
          }),
        nativeYtdlp: () =>
          new YtdlpNativeAcquirer({
            cacheMode: context.options.cacheMode,
            signal: controller.signal,
          }),
        referenceYtdlp: () =>
          createImportSetReferenceAcquirer(new ReferenceClient(), context.options.cacheMode),
      });
      const showProgress =
        context.options.progress === "always" ||
        (context.options.progress === "auto" && (context.agent || !context.formatExplicit));
      const result = await runSetToRekordbox({
        source: context.args.source,
        manifestPath: context.options.manifest,
        outputDirectory:
          context.options.outputDirectory ??
          defaultTrackLibraryRoot({ ...process.env, ...context.env }),
        identify: {
          provider: context.options.provider,
          cacheMode: context.options.cacheMode,
          env: { ...process.env, ...context.env },
        },
        spotify,
        acquirers,
        localArtifactDirectories: context.options.localDirectory,
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
        analysis: {
          engine: context.options.analysisEngine,
          rhythmMode: context.options.analysisRhythmMode,
          threads: context.options.analysisThreads,
          timeoutMs: context.options.analysisTimeoutMs,
          ...(context.options.analyzerBinary
            ? { analyzerBinary: context.options.analyzerBinary }
            : {}),
          ...(context.options.rekordboxApp ? { rekordboxApp: context.options.rekordboxApp } : {}),
          ...(context.options.rekordboxCache
            ? { rekordboxCache: context.options.rekordboxCache }
            : {}),
        },
        signal: controller.signal,
        rekordbox: {
          ...(context.options.dbPath ? { dbPath: context.options.dbPath } : {}),
          ...(context.options.dbDirectory ? { dbDirectory: context.options.dbDirectory } : {}),
          ...(context.options.folderName ? { folderName: context.options.folderName } : {}),
          ...(context.options.playlistName ? { playlistName: context.options.playlistName } : {}),
        },
        ...(showProgress
          ? {
              onProgress(progress) {
                process.stderr.write(
                  `[${new Date().toISOString()}] [${progress.stage}] ${progress.message}\n`,
                );
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
        spotifyCanonicalSelections: result.performance.automation.spotifyCanonicalSelections,
        acquisitionPasses: result.performance.automation.acquisitionPasses,
        sourceSetFallbacks: result.performance.automation.sourceSetFallbacks,
        analyzed: result.analysis.analyzed,
        analysisCacheHits: result.analysis.cacheHits,
        analysisEngine: context.options.analysisEngine,
        analysisRhythmMode: context.options.analysisRhythmMode,
        analysisThreads: result.analysis.threadBudget,
        dbPath: result.rekordbox.dbPath,
        folderId: result.rekordbox.folderId,
        playlistId: result.rekordbox.playlistId,
        performance: result.performance,
      };
    } catch (error) {
      return fail(context, error);
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
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
              (context.options.progress === "auto" && (context.agent || !context.formatExplicit))
            ) {
              const count =
                progress.current === undefined
                  ? ""
                  : ` ${progress.current}/${progress.total ?? "?"}`;
              process.stderr.write(
                `[${new Date().toISOString()}] [${progress.phase}]${count} ${progress.message}\n`,
              );
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
  description:
    "Resolve and cache 1001Tracklists through Parse, with headed page recovery and exact per-track media links.",
});

one001.command("get", {
  description:
    "Get an ordered tracklist plus all available Spotify, SoundCloud, YouTube, and store identities.",
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
    TRACKS_1001_BROWSER_PATH?: string | undefined;
    TRACKS_1001_BROWSER_SOURCE?: "brave" | "chrome" | undefined;
    TRACKS_1001_BROWSER_PROFILE?: string | undefined;
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
    ...(env.TRACKS_1001_BROWSER_PATH
      ? {
          browser: {
            command: env.TRACKS_1001_BROWSER_PATH,
            sourceBrowser: env.TRACKS_1001_BROWSER_SOURCE ?? "chrome",
            ...(env.TRACKS_1001_BROWSER_PROFILE
              ? { profile: env.TRACKS_1001_BROWSER_PROFILE }
              : {}),
          },
        }
      : {}),
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
      env: [
        "PARSE_API_KEY",
        "TRACKS_1001_BROWSER_PATH",
        "TRACKS_1001_BROWSER_SOURCE",
        "TRACKS_1001_BROWSER_PROFILE",
      ],
      capability:
        "Cached 1001 lookup plus exact per-track media URLs; headed NanoCodex fallback when Parse cannot render a page",
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

async function metadataSourceClients(cacheMode: CacheMode): Promise<ExactSourceMetadataClient[]> {
  const reference = new ReferenceClient();
  const clients: ExactSourceMetadataClient[] = [
    new ReferenceSourceMetadataClient("bandcamp", reference, { cacheMode }),
  ];
  try {
    const store = new FileSessionStore();
    const session = await store.load();
    if (!session) return clients;
    const credential = session.token.refreshToken ?? session.token.accessToken;
    const spotify = new CachedSpotifyClient(
      new SpotifyClient({
        auth: new SpotifyOAuth({
          clientId: session.clientId,
          redirectUri: session.redirectUri,
          store,
        }),
      }),
      {
        cacheMode,
        cacheScope: cacheDigest({ provider: "spotify", clientId: session.clientId, credential }),
      },
    );
    clients.push(new SpotifySourceMetadataClient(spotify));
  } catch {
    // Source-specific lookup is additive; damaged or absent provider auth must not block repair.
  }
  return clients;
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
    displayName: string;
    error(options: {
      code: string;
      exitCode?: number;
      message: string;
      retryable?: boolean;
      cta?: {
        description?: string;
        commands: Array<string | { command: string; description?: string }>;
      };
    }): never;
  },
  error: unknown,
): never {
  if (error instanceof TracksError) {
    const cta = tracksErrorCta(error, context.displayName);
    return context.error({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      exitCode: error.exitCode,
      ...(cta ? { cta } : {}),
    });
  }
  return context.error({
    code: "TRACKS_ERROR",
    message: errorMessage(error),
    retryable: false,
    exitCode: 1,
  });
}

function tracksErrorCta(
  error: TracksError,
  displayName: string,
):
  | {
      description: string;
      commands: Array<string | { command: string; description?: string }>;
    }
  | undefined {
  if (error.code === "AUTH_REQUIRED") {
    return {
      description: "Configure the missing provider, then retry the same manifest:",
      commands: [
        {
          command: tracksCtaCommand(displayName, "doctor"),
          description: "check credentials plus acquisition and analyzer dependencies",
        },
      ],
    };
  }
  if (error.code === "API_ERROR") {
    return {
      description: "Inspect provider configuration or choose an explicit resolution path:",
      commands: [
        {
          command: tracksCtaCommand(displayName, "doctor"),
          description: "check Parse and recognition configuration",
        },
        tracksCtaCommand(displayName, "resolve --help"),
      ],
    };
  }
  if (error.code === "TOOL_FAILED" || error.code === "INVALID_SOURCE") {
    return {
      description:
        "Review the one-shot import requirements (clean Auto rhythm by default), then retry the same manifest:",
      commands: [tracksCtaCommand(displayName, "import-set --help")],
    };
  }
  return undefined;
}

function tracksCtaCommand(displayName: string, command: string): string {
  const binary = displayName.trim().split(/[/\\]/u).at(-1);
  return binary === "tracks" || binary === "tracks-ts" ? command : `tracks ${command}`;
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
