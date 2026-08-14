import { createAgentResolutionRequest } from "./agent-resolution.js";
import { tracklistFromDescription } from "./description.js";
import { TracksError } from "./errors.js";
import { inspectMediaMetadata, type MediaMetadata } from "./integrations/ytdlp.js";
import { isHttpUrl, isSupportedDownloadUrl } from "./media.js";
import { AcrCloudClient } from "./providers/acrcloud.js";
import { AudDClient } from "./providers/audd.js";
import { recognizeSamples } from "./recognize-samples.js";
import { buildTimeline } from "./timeline.js";
import type { Environment, IdentifyOptions, RecognitionMoment, Tracklist } from "./types.js";

export async function identify(source: string, options: IdentifyOptions = {}): Promise<Tracklist> {
  if (source.trim() === "") {
    throw new TracksError("INVALID_SOURCE", "A media URL or local audio path is required", {
      exitCode: 2,
    });
  }

  const env = options.env ?? process.env;
  const provider = options.provider ?? "auto";
  const fetch = options.fetch ?? globalThis.fetch;

  if (provider === "auto" || provider === "description" || provider === "agent") {
    const supportedMedia = isSupportedDownloadUrl(source);
    if (provider === "description" && !supportedMedia) {
      throw new TracksError(
        "INVALID_SOURCE",
        "Description resolution requires a public YouTube or SoundCloud URL",
        { exitCode: 2 },
      );
    }

    let metadata: MediaMetadata | undefined;
    let metadataWarning: string | undefined;
    if (supportedMedia) {
      try {
        metadata = await loadMediaMetadata(source, options, env);
      } catch (error) {
        if (provider === "description") throw error;
        metadataWarning = `Metadata inspection failed: ${errorMessage(error)}`;
      }
    }

    if (provider !== "agent" && (options.preferDescription ?? true) && metadata) {
      const described = tracklistFromDescription(source, metadata);
      if (described) return described;
      if (provider === "description") {
        throw new TracksError(
          "NOT_FOUND",
          "No timestamped tracklist found in the media description",
          { exitCode: 4 },
        );
      }
    }

    const request = createAgentResolutionRequest(source, metadata, metadataWarning);
    throw new TracksError("AGENT_REQUIRED", "Track resolution requires agent browser research", {
      exitCode: 0,
      details: request,
    });
  }

  const selected = selectRecognizer(provider, env);
  const warnings: string[] = [];
  let moments: RecognitionMoment[];
  let durationSeconds: number | undefined;
  let title: string | undefined;
  let sampledEverySeconds: number | undefined;
  let complete = false;

  if (selected === "audd" && (options.strategy ?? "enterprise") === "enterprise") {
    const every = options.every ?? 1;
    const skip = options.full ? 0 : (options.skip ?? 4);
    options.onProgress?.({
      phase: "recognize",
      message: options.full
        ? "Scanning every 12-second fragment with AudD"
        : `Scanning ${every} fragment(s), then skipping ${skip}`,
    });
    const client = new AudDClient({
      apiToken: env.AUDD_API_TOKEN!,
      fetch,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    moments = await client.recognizeEnterprise(source, {
      every,
      skip,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.startSeconds === undefined ? {} : { startSeconds: options.startSeconds }),
    });
    sampledEverySeconds = (every + skip) * 12;
    complete = skip === 0 && options.limit === undefined && (options.startSeconds ?? 0) === 0;
  } else {
    const recognizer =
      selected === "audd"
        ? new AudDClient({
            apiToken: env.AUDD_API_TOKEN!,
            fetch,
            ...(options.signal ? { signal: options.signal } : {}),
          })
        : new AcrCloudClient({
            host: env.ACR_HOST!,
            accessKey: env.ACR_ACCESS_KEY!,
            accessSecret: env.ACR_ACCESS_SECRET!,
            fetch,
            ...(options.signal ? { signal: options.signal } : {}),
          });
    const result = await recognizeSamples(source, recognizer, options);
    moments = result.moments;
    durationSeconds = result.durationSeconds;
    title = result.title;
    sampledEverySeconds = result.intervalSeconds;
    complete = result.complete;
  }

  options.onProgress?.({ phase: "aggregate", message: "Building track timeline" });
  const tracks = buildTimeline(moments, {
    minScore: options.minScore ?? 40,
    blendScore: options.blendScore ?? 50,
  });
  if (!tracks.length)
    warnings.push("No tracks were recognized; try --full or a shorter --interval.");

  return {
    source,
    provider: selected,
    ...(title ? { title } : {}),
    ...(isHttpUrl(source) ? { url: source } : {}),
    ...(durationSeconds === undefined ? {} : { durationSeconds }),
    ...(sampledEverySeconds === undefined ? {} : { sampledEverySeconds }),
    complete,
    tracks,
    ...(warnings.length ? { warnings } : {}),
    ...(options.includeMatches ? { matches: moments } : {}),
  };
}

async function loadMediaMetadata(
  source: string,
  options: IdentifyOptions,
  env: Environment,
): Promise<MediaMetadata> {
  options.onProgress?.({ phase: "metadata", message: "Reading set metadata with ytdlp-ts" });
  return timedMetadataStage(
    options,
    () =>
      options.metadataClient?.inspect(source, {
        env,
        ...(options.cookies ? { cookies: options.cookies } : {}),
        ...(options.cookiesFromBrowser ? { cookiesFromBrowser: options.cookiesFromBrowser } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.cacheMode ? { cacheMode: options.cacheMode } : {}),
      }) ??
      inspectMediaMetadata(source, {
        env,
        ...(options.cookies ? { cookies: options.cookies } : {}),
        ...(options.cookiesFromBrowser ? { cookiesFromBrowser: options.cookiesFromBrowser } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.cacheMode ? { cacheMode: options.cacheMode } : {}),
      }),
  );
}

async function timedMetadataStage<T>(options: IdentifyOptions, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    const value = await run();
    const durationMs = roundMilliseconds(performance.now() - started);
    options.onStageTiming?.({ stage: "metadata", outcome: "completed", durationMs });
    options.onProgress?.({
      phase: "metadata",
      message: `Read set metadata in ${formatDuration(durationMs)}`,
    });
    return value;
  } catch (error) {
    options.onStageTiming?.({
      stage: "metadata",
      outcome: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed",
      durationMs: roundMilliseconds(performance.now() - started),
    });
    throw error;
  }
}

function selectRecognizer(
  provider: IdentifyOptions["provider"],
  env: Environment,
): "audd" | "acrcloud" {
  if (provider === "audd") {
    if (!env.AUDD_API_TOKEN) throw authRequired("AUDD_API_TOKEN", "AudD");
    return "audd";
  }
  if (provider === "acrcloud") {
    if (!env.ACR_HOST || !env.ACR_ACCESS_KEY || !env.ACR_ACCESS_SECRET)
      throw authRequired("ACR_HOST, ACR_ACCESS_KEY, and ACR_ACCESS_SECRET", "ACRCloud");
    return "acrcloud";
  }
  throw new TracksError(
    "INVALID_SOURCE",
    "Audio recognition must be selected explicitly with --provider audd or --provider acrcloud",
    { exitCode: 2 },
  );
}

function authRequired(variable: string, provider: string): TracksError {
  return new TracksError("AUTH_REQUIRED", `${variable} is required for ${provider}`, {
    exitCode: 2,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatDuration(value: number): string {
  return value < 1_000 ? `${Math.round(value)}ms` : `${(value / 1_000).toFixed(2)}s`;
}
