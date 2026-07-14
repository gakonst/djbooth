#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { JsonDiskCache, cacheDigest, type CacheMode, type CacheStats } from "./cache.js";
import {
  acquireManifest,
  DEFAULT_ACQUISITION_CONCURRENCY,
  DEFAULT_SPOTIFY_REFRESH_CONCURRENCY,
  DEFAULT_VERIFICATION_CONCURRENCY,
  MAX_ACQUISITION_CONCURRENCY,
  MAX_SPOTIFY_REFRESH_CONCURRENCY,
  MAX_VERIFICATION_CONCURRENCY,
  type AcquireManifestOptions,
  type AcquireManifestResult,
  type SpotifyLibraryClient,
  type TrackAcquirer,
} from "./acquire-manifest.js";
import {
  YtdlpReferenceAcquirer,
  unavailableTrackAcquirer,
  type YtdlpReferenceClient,
} from "./integrations/ytdlp-library.js";
import { CachedSpotifyClient } from "./integrations/spotify-cache.js";
import {
  BRUNELLO_MANIFEST_PATH,
  buildBrunelloAcquisitionPlan,
  reconcileBrunelloManifest,
} from "./presets/brunello-lib-2026.js";

type SpotsSession = {
  clientId: string;
  redirectUri: string;
  token?: { accessToken: string; refreshToken?: string };
};
type SpotsStore = { load(): Promise<SpotsSession | undefined> };
export type SpotsModule = {
  FileSessionStore: new () => SpotsStore;
  SpotifyOAuth: new (options: {
    clientId: string;
    redirectUri: string;
    store: SpotsStore;
  }) => unknown;
  SpotifyClient: new (options: { auth: unknown }) => SpotifyLibraryClient;
};
export type YtdlpModule = {
  ReferenceClient: new () => YtdlpReferenceClient;
};

type CacheAwareTrackAcquirer = TrackAcquirer & {
  cacheStats(): CacheStats | undefined;
};

export type RunBrunelloAcquisitionOptions = {
  manifestPath?: string;
  refreshSpotify?: boolean;
  dryRun?: boolean;
  continueOnError?: boolean;
  /** Independent recording variants. Defaults to 3; accepts 1 through 8. */
  concurrency?: number;
  /** Parallel media verification. Defaults to 8; accepts 1 through 16. */
  verificationConcurrency?: number;
  /** Parallel Spotify metadata refreshes. Defaults to 8; accepts 1 through 32. */
  spotifyConcurrency?: number;
  cacheMode?: CacheMode;
  spotsModule?: SpotsModule;
  ytdlpModule?: YtdlpModule;
  onProgress?: AcquireManifestOptions["onProgress"];
};

/** Compose spots and ytdlp-ts as libraries for the concrete 2026 Brunello set. */
export async function runBrunelloAcquisition(
  options: RunBrunelloAcquisitionOptions = {},
): Promise<AcquireManifestResult> {
  const orchestrationStartedAt = new Date();
  const orchestrationStarted = performance.now();
  const refreshSpotify = options.refreshSpotify ?? true;
  const spots = refreshSpotify ? (options.spotsModule ?? (await loadSpots())) : undefined;
  const store = spots ? new spots.FileSessionStore() : undefined;
  const session = await store?.load();
  const spotifyClient =
    session && spots && store
      ? new spots.SpotifyClient({
          auth: new spots.SpotifyOAuth({
            clientId: session.clientId,
            redirectUri: session.redirectUri,
            store,
          }),
        })
      : undefined;
  const cacheScope = spotifyCacheScope(session);
  const spotify = spotifyClient
    ? new CachedSpotifyClient(spotifyClient, {
        ...(cacheScope ? { cacheScope } : {}),
        ...(options.cacheMode ? { cacheMode: options.cacheMode } : {}),
      })
    : undefined;
  const slskReason =
    process.env.SLSK_USERNAME && process.env.SLSK_PASSWORD
      ? "Soulseek credentials exist, but this run is pinned to the audited ytdlp sources"
      : "SLSK_USERNAME/SLSK_PASSWORD are not configured";
  const ytdlpAcquirer: CacheAwareTrackAcquirer = options.dryRun
    ? {
        ...unavailableTrackAcquirer("ytdlp", "dry run does not load an acquisition backend"),
        cacheStats: () => undefined,
      }
    : lazyYtdlpAcquirer(options.ytdlpModule, options.cacheMode);
  const verificationCache = new JsonDiskCache({
    namespace: "audio-verification-v1",
    ...(options.cacheMode ? { mode: options.cacheMode } : {}),
  });
  const result = await acquireManifest({
    manifestPath: resolve(options.manifestPath ?? BRUNELLO_MANIFEST_PATH),
    prepare: reconcileBrunelloManifest,
    plan: buildBrunelloAcquisitionPlan,
    ...(spotify ? { spotify } : {}),
    refreshSpotify,
    acquirers: [unavailableTrackAcquirer("slsk", slskReason), ytdlpAcquirer],
    minimumScore: 0.78,
    requireCompletePlan: true,
    dryRun: options.dryRun ?? false,
    continueOnError: options.continueOnError ?? true,
    concurrency: options.concurrency ?? DEFAULT_ACQUISITION_CONCURRENCY,
    verificationConcurrency: options.verificationConcurrency ?? DEFAULT_VERIFICATION_CONCURRENCY,
    spotifyConcurrency: options.spotifyConcurrency ?? DEFAULT_SPOTIFY_REFRESH_CONCURRENCY,
    verificationCache,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  result.performance.totalMs = Math.round((performance.now() - orchestrationStarted) * 100) / 100;
  result.performance.startedAt = orchestrationStartedAt.toISOString();
  result.performance.finishedAt = new Date().toISOString();
  result.performance.caches = {
    ...result.performance.caches,
    ...(spotify?.cacheStats() ? { spotify: spotify.cacheStats()! } : {}),
    ...(ytdlpAcquirer.cacheStats() ? { youtube: ytdlpAcquirer.cacheStats()! } : {}),
  };
  return result;
}

function spotifyCacheScope(session: SpotsSession | undefined): string | undefined {
  const credential = session?.token?.refreshToken ?? session?.token?.accessToken;
  if (!session || !credential) return undefined;
  return cacheDigest({ provider: "spotify", clientId: session.clientId, credential });
}

function lazyYtdlpAcquirer(
  module: YtdlpModule | undefined,
  cacheMode: CacheMode | undefined,
): CacheAwareTrackAcquirer {
  let delegate: YtdlpReferenceAcquirer | undefined;
  let loading: Promise<YtdlpReferenceAcquirer> | undefined;
  const load = async (): Promise<YtdlpReferenceAcquirer> => {
    if (delegate) return delegate;
    loading ??= (async () => {
      const ytdlp = module ?? (await loadYtdlp());
      return new YtdlpReferenceAcquirer(
        new ytdlp.ReferenceClient(),
        cacheMode ? { cacheMode } : {},
      );
    })();
    delegate = await loading;
    return delegate;
  };
  return {
    backend: "ytdlp",
    availability: async () => (await load()).availability(),
    search: async (target) => (await load()).search(target),
    download: async (candidate, destinationDirectory, basename) =>
      (await load()).download(candidate, destinationDirectory, basename),
    cacheStats: () => delegate?.cacheStats(),
  };
}

async function loadSpots(): Promise<SpotsModule> {
  const packageName = "@gakonst/spots";
  return (await import(packageName)) as SpotsModule;
}

async function loadYtdlp(): Promise<YtdlpModule> {
  const packageName = "@gakonst/ytdlp-ts";
  return (await import(packageName)) as YtdlpModule;
}

function parseArguments(arguments_: readonly string[]): RunBrunelloAcquisitionOptions {
  const options: RunBrunelloAcquisitionOptions = {};
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!;
    if (argument === "--manifest") {
      const value = arguments_[++index];
      if (!value) throw new Error("--manifest requires a path");
      options.manifestPath = value;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--no-spotify-refresh") {
      options.refreshSpotify = false;
    } else if (argument === "--stop-on-error") {
      options.continueOnError = false;
    } else if (argument === "--concurrency") {
      const value = Number(arguments_[++index]);
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ACQUISITION_CONCURRENCY) {
        throw new Error(
          `--concurrency requires an integer between 1 and ${String(MAX_ACQUISITION_CONCURRENCY)}`,
        );
      }
      options.concurrency = value;
    } else if (argument === "--verification-concurrency") {
      const value = Number(arguments_[++index]);
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX_VERIFICATION_CONCURRENCY) {
        throw new Error(
          `--verification-concurrency requires an integer between 1 and ${String(MAX_VERIFICATION_CONCURRENCY)}`,
        );
      }
      options.verificationConcurrency = value;
    } else if (argument === "--spotify-concurrency") {
      const value = Number(arguments_[++index]);
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SPOTIFY_REFRESH_CONCURRENCY) {
        throw new Error(
          `--spotify-concurrency requires an integer between 1 and ${String(MAX_SPOTIFY_REFRESH_CONCURRENCY)}`,
        );
      }
      options.spotifyConcurrency = value;
    } else if (argument === "--refresh-cache") {
      options.cacheMode = "refresh";
    } else if (argument === "--no-cache") {
      options.cacheMode = "off";
    } else {
      throw new Error(`Unknown argument ${argument}`);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const result = await runBrunelloAcquisition({
    ...options,
    onProgress: (progress) => {
      process.stderr.write(`${progress.message}\n`);
    },
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        downloaded: result.downloaded,
        resumed: result.resumed,
        failures: result.failures,
        unavailableBackends: result.unavailableBackends,
        performance: result.performance,
      },
      null,
      2,
    )}\n`,
  );
  if (result.failures.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
