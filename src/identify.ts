import { tracklistFromDescription } from "./description.js";
import { TracksError } from "./errors.js";
import { inspectMediaMetadata } from "./integrations/ytdlp.js";
import { is1001Url, isHttpUrl, isSupportedDownloadUrl } from "./media.js";
import { AcrCloudClient } from "./providers/acrcloud.js";
import { AudDClient } from "./providers/audd.js";
import {
  databaseTracklistToEntries,
  isDatabaseMediaUrl,
  Tracklists1001Client,
} from "./providers/tracklists1001.js";
import { recognizeSamples } from "./recognize-samples.js";
import { buildTimeline } from "./timeline.js";
import type {
  DatabaseTracklist,
  Environment,
  IdentifyOptions,
  RecognitionMoment,
  Tracklist,
} from "./types.js";

export async function identify(source: string, options: IdentifyOptions = {}): Promise<Tracklist> {
  const env = options.env ?? process.env;
  const provider = options.provider ?? "auto";
  const preferDatabase = options.preferDatabase ?? true;
  const preferDescription = options.preferDescription ?? true;
  const warnings: string[] = [];
  const fetch = options.fetch ?? globalThis.fetch;

  if (is1001Url(source)) {
    if (!env.PARSE_API_KEY) {
      throw new TracksError(
        "AUTH_REQUIRED",
        "PARSE_API_KEY is required to read a 1001Tracklists URL; get one at https://parse.bot",
        { exitCode: 2 },
      );
    }
    options.onProgress?.({ phase: "database", message: "Loading 1001Tracklists tracklist" });
    const tracklist = await create1001Client(env, fetch, options.signal, options.cacheMode).get(
      source,
    );
    return fromDatabase(source, tracklist, options.includeMatches);
  }

  if (!isHttpUrl(source) && source.trim() === "") {
    throw new TracksError("INVALID_SOURCE", "A media URL or local audio path is required", {
      exitCode: 2,
    });
  }

  if (
    (provider === "auto" && preferDescription && isSupportedDownloadUrl(source)) ||
    provider === "description"
  ) {
    if (!isSupportedDownloadUrl(source)) {
      throw new TracksError(
        "INVALID_SOURCE",
        "Description resolution requires a public YouTube or SoundCloud URL",
        { exitCode: 2 },
      );
    }
    options.onProgress?.({ phase: "metadata", message: "Reading set description with ytdlp-ts" });
    try {
      const metadata = await inspectMediaMetadata(source, {
        env,
        ...(options.cookies ? { cookies: options.cookies } : {}),
        ...(options.cookiesFromBrowser ? { cookiesFromBrowser: options.cookiesFromBrowser } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.cacheMode ? { cacheMode: options.cacheMode } : {}),
      });
      const described = tracklistFromDescription(source, metadata);
      if (described) return described;
      if (provider === "description") {
        throw new TracksError(
          "NOT_FOUND",
          "No timestamped tracklist found in the media description",
          {
            exitCode: 4,
          },
        );
      }
      warnings.push("No timestamped tracklist found in the media description.");
    } catch (error) {
      if (provider === "description") throw error;
      warnings.push(
        `Description lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (
    (provider === "auto" && preferDatabase && env.PARSE_API_KEY) ||
    provider === "1001tracklists"
  ) {
    if (!env.PARSE_API_KEY) {
      throw new TracksError(
        "AUTH_REQUIRED",
        "PARSE_API_KEY is required for the 1001Tracklists provider",
        { exitCode: 2 },
      );
    }
    if (!isDatabaseMediaUrl(source)) {
      if (provider === "1001tracklists") {
        throw new TracksError(
          "INVALID_SOURCE",
          "1001Tracklists lookup requires a public YouTube or SoundCloud URL",
          {
            exitCode: 2,
          },
        );
      }
    } else {
      options.onProgress?.({ phase: "database", message: "Searching 1001Tracklists by media URL" });
      const result = await create1001Client(
        env,
        fetch,
        options.signal,
        options.cacheMode,
      ).findByMediaUrl(source);
      if (result.found) return fromDatabase(source, result, options.includeMatches);
      if (provider === "1001tracklists") {
        throw new TracksError("NOT_FOUND", "No 1001Tracklists entry references this media URL", {
          exitCode: 4,
        });
      }
      warnings.push("No existing 1001Tracklists entry found; used audio recognition instead.");
    }
  }

  const selected = selectRecognizer(provider, env);
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
  if (env.AUDD_API_TOKEN) return "audd";
  if (env.ACR_HOST && env.ACR_ACCESS_KEY && env.ACR_ACCESS_SECRET) return "acrcloud";
  throw new TracksError(
    "AUTH_REQUIRED",
    "No recognition provider configured; set AUDD_API_TOKEN or ACR_HOST, ACR_ACCESS_KEY, and ACR_ACCESS_SECRET",
    { exitCode: 2 },
  );
}

function authRequired(variable: string, provider: string): TracksError {
  return new TracksError("AUTH_REQUIRED", `${variable} is required for ${provider}`, {
    exitCode: 2,
  });
}

function create1001Client(
  env: Environment,
  fetch: typeof globalThis.fetch,
  signal?: AbortSignal,
  cacheMode?: "default" | "refresh" | "off",
): Tracklists1001Client {
  const baseUrl =
    env.PARSE_API_BASE ??
    (env.PARSE_SCRAPER_ID ? `https://api.parse.bot/scraper/${env.PARSE_SCRAPER_ID}` : undefined);
  return new Tracklists1001Client({
    apiKey: env.PARSE_API_KEY!,
    fetch,
    ...(baseUrl ? { baseUrl } : {}),
    ...(signal ? { signal } : {}),
    ...(cacheMode ? { cacheMode } : {}),
  });
}

function fromDatabase(
  source: string,
  tracklist: DatabaseTracklist,
  _includeMatches?: boolean,
): Tracklist {
  return {
    source,
    provider: "1001tracklists",
    title: tracklist.event.name,
    url: tracklist.url,
    ...(tracklist.event.date ? { date: tracklist.event.date } : {}),
    ...(tracklist.event.lineup.length ? { lineup: tracklist.event.lineup } : {}),
    ...(tracklist.durationSeconds === undefined
      ? {}
      : { durationSeconds: tracklist.durationSeconds }),
    complete: true,
    tracks: databaseTracklistToEntries(tracklist),
  };
}
