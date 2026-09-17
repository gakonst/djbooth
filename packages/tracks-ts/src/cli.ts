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
import { createSoundCloudUserClient } from "@gakonst/soundcloud";
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
import {
  parseAgentTracklist,
  needs1001Research,
  retainResolvedRecordings,
  type AgentResolutionRequest,
} from "./agent-resolution.js";
import { cacheDigest, type CacheMode } from "./cache.js";
import { TracksError, errorMessage } from "./errors.js";
import { identify } from "./identify.js";
import {
  buildProviderPlaylistManifest,
  restoreProviderPlaylistMediaLinks,
  type ProviderPlaylistManifestInput,
} from "./provider-playlist-manifest.js";
import { prepareHostedImportSource, type ImportSourceKind } from "./import-source.js";
import { CachedSpotifyClient } from "./integrations/spotify-cache.js";
import { RekordboxPipelineStore } from "./pipeline-state.js";
import { SoulseekLibraryAcquirer } from "./integrations/slsk-library.js";
import { getYtdlpTsCommand, inspectMediaMetadata } from "./integrations/ytdlp.js";
import {
  YtdlpNativeAcquirer,
  YtdlpReferenceAcquirer,
  type YtdlpReferenceClient,
} from "./integrations/ytdlp-library.js";
import { defaultTrackLibraryRoot } from "./library-paths.js";
import { createManifest, type SetManifest } from "./manifest.js";
import { enrichRekordboxMetadata, type MetadataFieldSource } from "./metadata-enrichment.js";
import { runProcess } from "./process.js";
import {
  DEFAULT_RECOGNITION_CONCURRENCY,
  MAX_RECOGNITION_CONCURRENCY,
} from "./recognize-samples.js";
import { parseTracklistJson, renderTracklist } from "./render.js";
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
  .enum(["auto", "description", "agent", "audd", "acrcloud"])
  .default("auto")
  .describe("Resolution provider");

const providerEnv = z.object({
  AUDD_API_TOKEN: z.string().optional().describe("AudD API token"),
  ACR_HOST: z.string().optional().describe("ACRCloud identification project host"),
  ACR_ACCESS_KEY: z.string().optional().describe("ACRCloud identification access key"),
  ACR_ACCESS_SECRET: z.string().optional().describe("ACRCloud identification access secret"),
  YTDLP_TS_PATH: z.string().optional().describe("ytdlp-ts executable or dist/cli.js path"),
  FFMPEG_PATH: z.string().optional().describe("ffmpeg executable path"),
  FFPROBE_PATH: z.string().optional().describe("ffprobe executable path"),
});

const importEnv = providerEnv.extend({
  SLSK_USERNAME: z.string().optional().describe("Soulseek username"),
  SLSK_PASSWORD: z.string().optional().describe("Soulseek password"),
  DJBOOTH_LIBRARY_ROOT: z
    .string()
    .optional()
    .describe("Canonical artist/album recording root; default ~/.djtools/tracks"),
  MUSIC_LIBRARY_ROOT: z.string().optional().describe("Legacy alias for DJBOOTH_LIBRARY_ROOT"),
  SOUNDCLOUD_ACCESS_TOKEN: z.string().optional().describe("SoundCloud user access token"),
  SOUNDCLOUD_CLIENT_SECRET: z.string().optional().describe("SoundCloud OAuth refresh secret"),
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
    requiresPriorCapabilityFailure: false,
  });
}

const identifyOptions = z.object({
  provider,
  strategy: z
    .enum(["enterprise", "samples"])
    .default("enterprise")
    .describe("AudD long-file scan or local clip sampling"),
  preferDescription: z
    .boolean()
    .default(false)
    .describe("Explicitly use publisher description before 1001Tracklists research"),
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
    provider: z.enum(["description", "agent", "audd", "acrcloud"]),
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

const agentResolutionOutput = z.object({
  action: z.literal("agent-resolution-required"),
  source: z.string(),
  context: z.object({
    sourceId: z.string().optional(),
    title: z.string().optional(),
    uploader: z.string().optional(),
    durationSeconds: z.number().positive().optional(),
    webpageUrl: z.string().optional(),
    description: z.string().optional(),
    warning: z.string().optional(),
  }),
  prompt: z.string(),
  submit: z.object({
    option: z.literal("--agent-result-json"),
    format: z.literal("Tracklist"),
    requiredProvider: z.literal("agent"),
  }),
});

const providerStatusOutput = z.object({
  configured: z.boolean(),
  env: z.array(z.string()),
  capability: z.string(),
});

const providersOutput = z.object({
  description: providerStatusOutput,
  agent: providerStatusOutput,
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
    "Database-backed resolve → enrich → download → analyze → Rekordbox playlist workflows.",
  hint: "Use import for the complete resumable workflow; direct stages are available for diagnosis and explicit partial work.",
  config: {
    flag: "config",
    files: ["tracks.json", "~/.config/tracks/config.json"],
  },
  mcp: {
    command: "tracks --mcp",
    instructions:
      "Rekordbox master.db is the only workflow state. import accepts hosted playlists, DJ-set URLs, and local sets and resumes the complete workflow. resolve, enrich, download, and analyze expose explicit partial stages.",
  },
});

const metadataCoverageOutput = z.object({
  album: z.number().int().nonnegative(),
  label: z.number().int().nonnegative(),
  genre: z.number().int().nonnegative(),
  isrc: z.number().int().nonnegative(),
  releaseDate: z.number().int().nonnegative(),
});

export const enrichCli = Cli.create("enrich", {
  description:
    "Idempotently enrich every Rekordbox track from durable provenance, local metadata, Apple, Spotify, Discogs, Deezer, and MusicBrainz.",
  options: z.object({
    folder: z.string().optional().describe("Optional direct-child playlist-folder scope"),
    dbPath: z.string().optional().describe("Normal Rekordbox master.db override"),
    dbDirectory: z.string().optional().describe("Rekordbox database directory override"),
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
      const { manifest: _manifestSourceCount, ...sources } = result.sources;
      return {
        dbPath: result.dbPath,
        scope: result.scope,
        tracks: result.tracks,
        changed: result.changed,
        written: result.written,
        coverageBefore: result.coverageBefore,
        coverageAfter: result.coverageAfter,
        sources,
        catalogQueries: result.catalogQueries,
        catalogMatches: result.catalogMatches,
        providers: result.providers,
        provenance: result.provenance,
        unresolvedSummary: result.unresolvedSummary,
        unresolved: result.unresolved,
        changes: result.changes.map((change) => ({
          ...change,
          sources: withoutManifestSources(change.sources),
        })),
      };
    } catch (error) {
      return fail(context, error);
    }
  },
});

tracksCli.command(enrichCli);

const setWorkflowArgs = z.object({
  source: z
    .string()
    .describe("Spotify/SoundCloud playlist, YouTube/SoundCloud DJ set, or local set"),
});
const setWorkflowOptions = z.object({
  providerPlaylistFile: z
    .string()
    .optional()
    .describe(
      "Authorized provider playlist metadata snapshot; imported into master.db before acquisition",
    ),
  wholeSet: z
    .boolean()
    .default(false)
    .describe(
      "Keep the complete DJ mix as one analyzed library track; constituent-track imports retain separate resumable state",
    ),
  agentResultJson: z
    .string()
    .optional()
    .describe("Agent-resolved Tracklist JSON returned by a prior handoff"),
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
    .describe("Explicitly add external yt-dlp after Soulseek and the typed native downloader"),
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
  sourceSetDownloadUrl: z
    .string()
    .optional()
    .describe(
      "Verified alternate upload of this exact set; duration must match the resolved cue timeline",
    ),
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
    .describe("Analyzer engine; clean is default, reference is a local proprietary parity oracle"),
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
});
const completedSetWorkflowOutput = z.object({
  outputDirectory: z.string(),
  source: z.string(),
  sourceKind: z.enum(["dj-set", "soundcloud-playlist", "spotify-playlist"]),
  entries: z.number().int().nonnegative(),
  downloaded: z.number().int().nonnegative(),
  resumed: z.number().int().nonnegative(),
  spotifyCanonicalSelections: z.number().int().nonnegative(),
  acquisitionPasses: z.number().int().positive(),
  sourceSetFallbacks: z.number().int().nonnegative(),
  analyzed: z.number().int().nonnegative().optional(),
  analysisCacheHits: z.number().int().nonnegative().optional(),
  analysisEngine: z.enum(["clean", "reference"]).optional(),
  analysisRhythmMode: z.enum(["normal", "dynamic", "auto"]).optional(),
  analysisThreads: z.number().int().positive().optional(),
  dbPath: z.string().optional(),
  folderId: z.string().optional(),
  playlistId: z.string().optional(),
  performance: workflowPerformanceOutput,
});
const setWorkflowOutput = z.union([completedSetWorkflowOutput, agentResolutionOutput]);

type SetWorkflowContext = Parameters<typeof fail>[0] & {
  agent: boolean;
  args: z.output<typeof setWorkflowArgs>;
  env: z.output<typeof importEnv>;
  formatExplicit: boolean;
  options: z.output<typeof setWorkflowOptions>;
};

export const importCli = Cli.create("import", {
  description:
    "Import a hosted playlist or DJ set end to end: resolve, enrich, download, analyze, and update one ordered Rekordbox playlist.",
  hint: "This is the agent golden path. Rerun the same source to resume directly from master.db.",
  args: setWorkflowArgs,
  env: importEnv,
  options: setWorkflowOptions,
  output: setWorkflowOutput,
  async run(context) {
    return runSetWorkflowCommand(context, "rekordbox");
  },
});

export const downloadCli = Cli.create("download", {
  description:
    "Resolve and enrich a set, adopt or download every available recording, and checkpoint each result in Rekordbox master.db.",
  hint: "Analysis and playlist import do not run. Reruns verify and reuse completed files; refresh resolution to reconsider unavailable rows.",
  args: setWorkflowArgs,
  env: importEnv,
  options: setWorkflowOptions,
  output: setWorkflowOutput,
  async run(context) {
    return runSetWorkflowCommand(context, "download");
  },
});

export const analyzeCli = Cli.create("analyze", {
  description:
    "Resolve prerequisites, download missing recordings, then produce and checkpoint Rekordbox-compatible analysis without importing a playlist.",
  hint: "Download and analysis are idempotent; existing verified media and analyzer artifacts are reused.",
  args: setWorkflowArgs,
  env: importEnv,
  options: setWorkflowOptions,
  output: setWorkflowOutput,
  async run(context) {
    return runSetWorkflowCommand(context, "analysis");
  },
});

tracksCli.command(importCli);
tracksCli.command(downloadCli);
tracksCli.command(analyzeCli);

async function runSetWorkflowCommand(
  context: SetWorkflowContext,
  stopAfter: "download" | "analysis" | "rekordbox",
): Promise<z.output<typeof setWorkflowOutput>> {
  let soulseek: SoulseekClient | undefined;
  let stateStore: RekordboxPipelineStore | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const controller = new AbortController();
  const cancel = () => controller.abort(new DOMException("Import interrupted", "AbortError"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const showProgress =
      context.options.progress === "always" ||
      (context.options.progress === "auto" && (context.agent || !context.formatExplicit));
    let progressMessage = "[prepare] preparing 0/1";
    const reportProgress = () => {
      try {
        process.stderr.write(`[${new Date().toISOString()}] ${progressMessage}\n`);
      } catch {
        /* Diagnostics cannot interrupt the import. */
      }
    };
    if (showProgress) {
      reportProgress();
      heartbeat = setInterval(reportProgress, 2_000);
      heartbeat.unref();
    }
    const outputDirectory =
      context.options.outputDirectory ??
      defaultTrackLibraryRoot({ ...process.env, ...context.env });
    const workflowSource = context.options.wholeSet
      ? `djbooth:whole-set:${context.args.source}`
      : context.args.source;
    stateStore = new RekordboxPipelineStore({
      source: workflowSource,
      outputDirectory,
      keepOpen: true,
      ...(context.options.dbPath ? { dbPath: context.options.dbPath } : {}),
      ...(context.options.dbDirectory ? { dbDirectory: context.options.dbDirectory } : {}),
    });
    let initialState = (await stateStore.load()) ?? null;
    if (context.options.wholeSet && context.options.agentResultJson)
      throw new TracksError(
        "INVALID_SOURCE",
        "--whole-set reads the publisher's mix metadata; omit --agent-result-json",
        { exitCode: 2 },
      );
    if (context.options.wholeSet && !initialState) {
      const metadata = await inspectMediaMetadata(context.args.source, {
        cacheMode: context.options.cacheMode,
        signal: controller.signal,
      });
      if (!metadata.title || !metadata.durationSeconds)
        throw new TracksError(
          "INVALID_SOURCE",
          "Whole-set import requires a titled recording with a known duration",
          { exitCode: 2 },
        );
      const manifest = createManifest({
        source: workflowSource,
        url: context.args.source,
        provider: "description",
        title: metadata.title,
        ...(metadata.uploader ? { uploader: metadata.uploader } : {}),
        durationSeconds: metadata.durationSeconds,
        complete: true,
        tracks: [
          {
            order: 1,
            startSeconds: 0,
            endSeconds: metadata.durationSeconds,
            artist: metadata.uploader ?? "Unknown Artist",
            title: metadata.title,
          },
        ],
      });
      manifest.artifacts.root = stateStore.artifactDirectory;
      manifest.artifacts.downloadDirectory = outputDirectory;
      const original = new RekordboxPipelineStore({
        source: context.args.source,
        outputDirectory,
        ...(context.options.dbPath ? { dbPath: context.options.dbPath } : {}),
        ...(context.options.dbDirectory ? { dbDirectory: context.options.dbDirectory } : {}),
      });
      try {
        const prior = await original.load();
        if (prior?.artifacts.sourceSet) manifest.artifacts.sourceSet = prior.artifacts.sourceSet;
      } finally {
        original.close();
      }
      await stateStore.save(manifest);
      initialState = manifest;
    }
    let sourceKind: ImportSourceKind = inferImportSourceKind(initialState ?? undefined);
    const replacementPlaylistId = agentReplacementPlaylistId(
      initialState,
      context.options.agentResultJson !== undefined,
    );
    if (context.options.agentResultJson) {
      const submitted = createManifest(
        parseAgentTracklist(context.args.source, context.options.agentResultJson),
      );
      retainResolvedRecordings(initialState, submitted);
      submitted.artifacts.root = stateStore.artifactDirectory;
      submitted.artifacts.downloadDirectory = outputDirectory;
      await stateStore.save(submitted);
      initialState = submitted;
      sourceKind = "dj-set";
    }
    if (context.options.providerPlaylistFile) {
      const file = context.options.providerPlaylistFile;
      if ((await stat(file)).size > 8 * 1024 * 1024)
        throw new Error("Provider playlist snapshot is too large");
      const input = JSON.parse(await readFile(file, "utf8")) as ProviderPlaylistManifestInput;
      if (input.url !== context.args.source || !["spotify", "soundcloud"].includes(input.provider))
        throw new Error("Provider playlist snapshot does not match this source");
      const manifest = buildProviderPlaylistManifest(input);
      if (initialState) {
        if (restoreProviderPlaylistMediaLinks(initialState, manifest))
          await stateStore.save(initialState);
      } else {
        manifest.artifacts.root = stateStore.artifactDirectory;
        manifest.artifacts.downloadDirectory = outputDirectory;
        delete manifest.artifacts.manifest;
        await stateStore.save(manifest);
        initialState = manifest;
      }
      sourceKind = input.provider === "spotify" ? "spotify-playlist" : "soundcloud-playlist";
    }
    if (
      initialState &&
      !context.options.wholeSet &&
      !context.options.agentResultJson &&
      sourceKind === "dj-set" &&
      (context.options.provider ?? "auto") === "auto" &&
      needs1001Research(initialState)
    ) {
      // Leave durable rows/media untouched until the researched replacement is submitted.
      await identify(context.args.source, {
        provider: "agent",
        cacheMode: context.options.cacheMode,
        env: { ...process.env, ...context.env },
        signal: controller.signal,
      });
    }
    if (!initialState && !isHostedPlaylistCandidate(context.args.source)) {
      const resolved = createManifest(
        await identify(context.args.source, {
          provider: context.options.provider,
          cacheMode: context.options.cacheMode,
          env: { ...process.env, ...context.env },
          signal: controller.signal,
        }),
      );
      resolved.artifacts.root = stateStore.artifactDirectory;
      resolved.artifacts.downloadDirectory = outputDirectory;
      await stateStore.save(resolved);
      initialState = resolved;
    }
    const spotify = context.options.wholeSet
      ? undefined
      : await workflowSpotifyClient(context.options.cacheMode);
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
          allowReferenceFallback: context.options.referenceYtdlp,
          cacheMode: context.options.cacheMode,
          signal: controller.signal,
        }),
      referenceYtdlp: () =>
        createImportSetReferenceAcquirer(new ReferenceClient(), context.options.cacheMode),
    });
    if (!initialState) {
      const hosted = await prepareHostedImportSource(context.args.source, {
        ...(spotify ? { spotify } : {}),
        createSoundcloud: () =>
          createSoundCloudUserClient({
            ...(context.env.SOUNDCLOUD_ACCESS_TOKEN
              ? { accessToken: context.env.SOUNDCLOUD_ACCESS_TOKEN }
              : {}),
            ...(context.env.SOUNDCLOUD_CLIENT_SECRET
              ? { clientSecret: context.env.SOUNDCLOUD_CLIENT_SECRET }
              : {}),
          }),
        signal: controller.signal,
      });
      if (hosted) {
        sourceKind = hosted.kind;
        hosted.manifest.artifacts.root = stateStore.artifactDirectory;
        hosted.manifest.artifacts.downloadDirectory = outputDirectory;
        delete hosted.manifest.artifacts.manifest;
        await stateStore.save(hosted.manifest);
        initialState = hosted.manifest;
      }
    }
    const result = await runSetToRekordbox({
      source: workflowSource,
      stateStore,
      initialState,
      outputDirectory,
      ...(stopAfter === "rekordbox" ? {} : { stopAfter }),
      identify: {
        provider: context.options.provider,
        cacheMode: context.options.cacheMode,
        env: { ...process.env, ...context.env },
      },
      ...(spotify ? { spotify } : {}),
      acquirers,
      localArtifactDirectories: context.options.localDirectory,
      allowSourceSetClips: sourceKind === "dj-set",
      referenceYtdlp: context.options.referenceYtdlp,
      ...(context.options.sourceSetDownloadUrl
        ? { sourceSetDownloadUrl: context.options.sourceSetDownloadUrl }
        : {}),
      wholeSet: context.options.wholeSet,
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
        ...(replacementPlaylistId ? { playlistId: replacementPlaylistId } : {}),
        ...(context.options.dbPath ? { dbPath: context.options.dbPath } : {}),
        ...(context.options.dbDirectory ? { dbDirectory: context.options.dbDirectory } : {}),
        ...(context.options.folderName ? { folderName: context.options.folderName } : {}),
        ...(context.options.playlistName ? { playlistName: context.options.playlistName } : {}),
      },
      ...(showProgress
        ? {
            onProgress(progress) {
              progressMessage = `[${progress.stage}] ${progress.message}`;
              reportProgress();
            },
          }
        : {}),
    });
    if (showProgress) {
      progressMessage = "[complete] complete 1/1";
      reportProgress();
    }
    return {
      outputDirectory: result.outputDirectory,
      source: context.args.source,
      sourceKind,
      entries: result.manifest.entries.length,
      downloaded: result.acquisition.downloaded.length,
      resumed: result.acquisition.resumed.length,
      spotifyCanonicalSelections: result.performance.automation.spotifyCanonicalSelections,
      acquisitionPasses: result.performance.automation.acquisitionPasses,
      sourceSetFallbacks: result.performance.automation.sourceSetFallbacks,
      ...(result.analysis
        ? {
            analyzed: result.analysis.analyzed,
            analysisCacheHits: result.analysis.cacheHits,
            analysisEngine: context.options.analysisEngine,
            analysisRhythmMode: context.options.analysisRhythmMode,
            analysisThreads: result.analysis.threadBudget,
          }
        : {}),
      ...(result.rekordbox
        ? {
            dbPath: result.rekordbox.dbPath,
            folderId: result.rekordbox.folderId,
            playlistId: result.rekordbox.playlistId,
          }
        : {}),
      performance: result.performance,
    };
  } catch (error) {
    const handoff = agentResolutionFromError(error);
    if (handoff) return handoff;
    return fail(context, error);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    stateStore?.close();
    if (soulseek?.state !== "disconnected") await soulseek?.disconnect();
  }
}

/** Keep the exact local playlist target when browser research replaces resolved identities. */
export function agentReplacementPlaylistId(
  state: SetManifest | null | undefined,
  replacingResolution: boolean,
): string | undefined {
  return replacingResolution ? state?.artifacts.rekordbox?.playlistId : undefined;
}

function inferImportSourceKind(
  manifest: Awaited<ReturnType<RekordboxPipelineStore["load"]>>,
): ImportSourceKind {
  if (!manifest) return "dj-set";
  if (manifest.source.id?.startsWith("soundcloud:playlists:")) return "soundcloud-playlist";
  if (
    manifest.source.input.startsWith("spotify:playlist:") ||
    manifest.source.url?.includes("open.spotify.com/playlist/")
  ) {
    return "spotify-playlist";
  }
  return "dj-set";
}

function isHostedPlaylistCandidate(source: string): boolean {
  if (source.startsWith("spotify:playlist:")) return true;
  try {
    const url = new URL(source);
    return (
      /(^|\.)soundcloud\.com$/iu.test(url.hostname) ||
      (/(^|\.)spotify\.com$/iu.test(url.hostname) && url.pathname.startsWith("/playlist/"))
    );
  } catch {
    return false;
  }
}

export const resolveCli = Cli.create("resolve", {
  aliases: ["identify"],
  description:
    "Resolve playlist rows or request 1001Tracklists-first set research from the calling agent, without downloading the remote set.",
  args: z.object({ source: z.string().describe("YouTube/SoundCloud URL or local audio file") }),
  options: identifyOptions.extend({
    providerPlaylistFile: z.string().optional().describe("Connected-provider playlist snapshot"),
    outputDirectory: z
      .string()
      .optional()
      .describe("Canonical recording root; defaults to DJBOOTH_LIBRARY_ROOT"),
    dbPath: z.string().optional().describe("Normal Rekordbox master.db override"),
    dbDirectory: z.string().optional().describe("Rekordbox database directory override"),
    refresh: z.boolean().default(false).describe("Resolve the source again and replace its state"),
    agentResultJson: z
      .string()
      .optional()
      .describe("Agent-resolved Tracklist JSON returned by a prior handoff"),
  }),
  env: providerEnv,
  output: z.union([manifestOutput, agentResolutionOutput]),
  alias: {
    provider: "p",
    interval: "i",
    concurrency: "c",
  },
  examples: [
    {
      args: { source: "https://www.youtube.com/watch?v=vtJ100Znqw0" },
      description: "Read set metadata and hand 1001Tracklists research back to the calling agent",
    },
    {
      args: { source: "set.mp3" },
      options: { provider: "audd", strategy: "samples", interval: 45 },
      description: "Sample a local set every 45 seconds with AudD Standard",
    },
  ],
  async run(context) {
    try {
      const outputDirectory =
        context.options.outputDirectory ??
        defaultTrackLibraryRoot({ ...process.env, ...context.env });
      const stateStore = new RekordboxPipelineStore({
        source: context.args.source,
        outputDirectory,
        ...(context.options.dbPath ? { dbPath: context.options.dbPath } : {}),
        ...(context.options.dbDirectory ? { dbDirectory: context.options.dbDirectory } : {}),
      });
      if (context.options.agentResultJson) {
        const submitted = createManifest(
          parseAgentTracklist(context.args.source, context.options.agentResultJson),
        );
        retainResolvedRecordings(await stateStore.load(), submitted);
        submitted.artifacts.root = stateStore.artifactDirectory;
        submitted.artifacts.downloadDirectory = resolve(outputDirectory);
        await stateStore.save(submitted);
        return submitted;
      }
      if (!context.options.refresh) {
        const existing = await stateStore.load();
        if (
          existing &&
          ((context.options.provider ?? "auto") !== "auto" ||
            context.options.preferDescription ||
            inferImportSourceKind(existing) !== "dj-set" ||
            !needs1001Research(existing))
        )
          return existing;
      }
      let hostedManifest;
      if (context.options.providerPlaylistFile) {
        const file = context.options.providerPlaylistFile;
        if ((await stat(file)).size > 8 * 1024 * 1024)
          throw new Error("Provider playlist snapshot is too large");
        const input = JSON.parse(await readFile(file, "utf8")) as ProviderPlaylistManifestInput;
        if (
          input.url !== context.args.source ||
          !["spotify", "soundcloud"].includes(input.provider)
        )
          throw new Error("Provider playlist snapshot does not match this source");
        hostedManifest = buildProviderPlaylistManifest(input);
      } else if (isHostedPlaylistCandidate(context.args.source)) {
        const spotify = await workflowSpotifyClient(context.options.cacheMode);
        hostedManifest = (
          await prepareHostedImportSource(context.args.source, {
            ...(spotify ? { spotify } : {}),
            createSoundcloud: () => createSoundCloudUserClient(),
          })
        )?.manifest;
      }
      if (hostedManifest) {
        hostedManifest.artifacts.root = stateStore.artifactDirectory;
        hostedManifest.artifacts.downloadDirectory = resolve(outputDirectory);
        delete hostedManifest.artifacts.manifest;
        await stateStore.save(hostedManifest);
        return hostedManifest;
      }
      const manifest = createManifest(
        await identify(context.args.source, {
          provider: context.options.provider,
          strategy: context.options.strategy,
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
      manifest.artifacts.root = stateStore.artifactDirectory;
      manifest.artifacts.downloadDirectory = resolve(outputDirectory);
      await stateStore.save(manifest);
      return manifest;
    } catch (error) {
      const handoff = agentResolutionFromError(error);
      if (handoff) return handoff;
      return fail(context, error);
    }
  },
});

tracksCli.command(resolveCli);

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
    const readyForResolution = true;
    return {
      providers: providerStatus(env),
      tools: {
        ytdlpTs: tools[0],
        ffmpeg: tools[1],
        ffprobe: tools[2],
      },
      readyForLookup: true,
      readyForResolution,
      readyForRecognition,
      ready: readyForResolution,
    };
  },
});

function providerStatus(env: Environment) {
  return {
    description: {
      configured: true,
      env: ["YTDLP_TS_PATH"],
      capability: "Metadata-only YouTube/SoundCloud description resolution via ytdlp-ts",
    },
    agent: {
      configured: true,
      env: [],
      capability:
        "Structured browser/VM handoff for ordinary 1001Tracklists research and direct master.db submission",
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
): Promise<CachedSpotifyClient | undefined> {
  const store = new FileSessionStore();
  const session = await store.load();
  if (!session) return undefined;
  const credential = session.token.refreshToken ?? session.token.accessToken;
  const client = new SpotifyClient({
    auth: new SpotifyOAuth({
      clientId: session.clientId,
      redirectUri: session.redirectUri,
      ...(process.env.SPOTIFY_CLIENT_SECRET
        ? { clientSecret: process.env.SPOTIFY_CLIENT_SECRET }
        : {}),
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
          ...(process.env.SPOTIFY_CLIENT_SECRET
            ? { clientSecret: process.env.SPOTIFY_CLIENT_SECRET }
            : {}),
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

function withoutManifestSources(
  sources: Readonly<Record<string, MetadataFieldSource>>,
): Record<string, Exclude<MetadataFieldSource, "manifest">> {
  const filtered: Record<string, Exclude<MetadataFieldSource, "manifest">> = {};
  for (const [field, source] of Object.entries(sources)) {
    if (source !== "manifest") filtered[field] = source;
  }
  return filtered;
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

function agentResolutionFromError(error: unknown): AgentResolutionRequest | undefined {
  if (!(error instanceof TracksError) || error.code !== "AGENT_REQUIRED") return undefined;
  const details = error.details;
  if (
    typeof details !== "object" ||
    details === null ||
    !("action" in details) ||
    details.action !== "agent-resolution-required"
  ) {
    return undefined;
  }
  return details as AgentResolutionRequest;
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
      description: "Configure the missing provider, then retry the same source:",
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
          description: "check metadata and explicit recognition configuration",
        },
        tracksCtaCommand(displayName, "resolve --help"),
      ],
    };
  }
  if (error.code === "TOOL_FAILED" || error.code === "INVALID_SOURCE") {
    return {
      description: "Review the database-backed workflow requirements, then retry the same source:",
      commands: [tracksCtaCommand(displayName, "import --help")],
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
