#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  acquireManifest,
  type AcquireManifestOptions,
  type AcquireManifestResult,
  type SpotifyLibraryClient,
} from "./acquire-manifest.js";
import {
  YtdlpReferenceAcquirer,
  unavailableTrackAcquirer,
  type YtdlpReferenceClient,
} from "./integrations/ytdlp-library.js";
import {
  BRUNELLO_MANIFEST_PATH,
  buildBrunelloAcquisitionPlan,
  reconcileBrunelloManifest,
} from "./presets/brunello-lib-2026.js";

type SpotsSession = { clientId: string; redirectUri: string };
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

export type RunBrunelloAcquisitionOptions = {
  manifestPath?: string;
  refreshSpotify?: boolean;
  dryRun?: boolean;
  continueOnError?: boolean;
  spotsModule?: SpotsModule;
  ytdlpModule?: YtdlpModule;
  onProgress?: AcquireManifestOptions["onProgress"];
};

/** Compose spots and ytdlp-ts as libraries for the concrete 2026 Brunello set. */
export async function runBrunelloAcquisition(
  options: RunBrunelloAcquisitionOptions = {},
): Promise<AcquireManifestResult> {
  const refreshSpotify = options.refreshSpotify ?? true;
  const [spots, ytdlp] = await Promise.all([
    refreshSpotify ? (options.spotsModule ?? loadSpots()) : undefined,
    options.dryRun ? undefined : (options.ytdlpModule ?? loadYtdlp()),
  ]);
  const store = spots ? new spots.FileSessionStore() : undefined;
  const session = await store?.load();
  const spotify =
    session && spots && store
      ? new spots.SpotifyClient({
          auth: new spots.SpotifyOAuth({
            clientId: session.clientId,
            redirectUri: session.redirectUri,
            store,
          }),
        })
      : undefined;
  const slskReason =
    process.env.SLSK_USERNAME && process.env.SLSK_PASSWORD
      ? "Soulseek credentials exist, but this run is pinned to the audited ytdlp sources"
      : "SLSK_USERNAME/SLSK_PASSWORD are not configured";
  return acquireManifest({
    manifestPath: resolve(options.manifestPath ?? BRUNELLO_MANIFEST_PATH),
    prepare: reconcileBrunelloManifest,
    plan: buildBrunelloAcquisitionPlan,
    ...(spotify ? { spotify } : {}),
    refreshSpotify,
    acquirers: [
      unavailableTrackAcquirer("slsk", slskReason),
      ytdlp
        ? new YtdlpReferenceAcquirer(new ytdlp.ReferenceClient())
        : unavailableTrackAcquirer("ytdlp", "dry run does not load an acquisition backend"),
    ],
    minimumScore: 0.78,
    requireCompletePlan: true,
    dryRun: options.dryRun ?? false,
    continueOnError: options.continueOnError ?? true,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
}

async function loadSpots(): Promise<SpotsModule> {
  try {
    const packageName = "spots";
    return (await import(packageName)) as SpotsModule;
  } catch (packageError) {
    const path = resolve(import.meta.dirname, "../../spots/dist/index.js");
    try {
      return (await import(pathToFileURL(path).href)) as SpotsModule;
    } catch (siblingError) {
      throw new AggregateError(
        [packageError, siblingError],
        "Could not load spots as an installed package or built sibling checkout",
      );
    }
  }
}

async function loadYtdlp(): Promise<YtdlpModule> {
  try {
    const packageName = "@gakonst/ytdlp-ts";
    return (await import(packageName)) as YtdlpModule;
  } catch (packageError) {
    const path = resolve(import.meta.dirname, "../../ytdlp-ts/dist/index.js");
    try {
      return (await import(pathToFileURL(path).href)) as YtdlpModule;
    } catch (siblingError) {
      throw new AggregateError(
        [packageError, siblingError],
        "Could not load ytdlp-ts as an installed package or built sibling checkout",
      );
    }
  }
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
