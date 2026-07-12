import { tracklistFromDescription } from "./description.js";
import { isAbortError, TracksError } from "./errors.js";
import { inspectMediaMetadata } from "./integrations/ytdlp.js";
import type { MediaMetadata } from "./integrations/ytdlp.js";
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
  IdentifyStageTiming,
  RecognitionMoment,
  Tracklist,
  TracklistSummary,
} from "./types.js";

type Settled<T> = { status: "fulfilled"; value: T } | { status: "rejected"; error: unknown };
type DatabaseLookup =
  | { status: "matched"; tracklist: DatabaseTracklist }
  | { status: "missed" }
  | { status: "failed"; error: unknown };

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
    const tracklist = await timedStage(
      "database-tracklist",
      "database",
      "Loaded 1001Tracklists tracklist",
      options,
      () => create1001Client(env, fetch, options.signal, options.cacheMode).get(source),
    );
    return fromDatabase(source, tracklist, options.includeMatches);
  }

  if (!isHttpUrl(source) && source.trim() === "") {
    throw new TracksError("INVALID_SOURCE", "A media URL or local audio path is required", {
      exitCode: 2,
    });
  }

  const descriptionEnabled =
    provider === "description" || (provider === "auto" && preferDescription);
  const databaseEnabled =
    provider === "1001tracklists" ||
    (provider === "auto" && preferDatabase && Boolean(env.PARSE_API_KEY));
  const supportedMedia = isSupportedDownloadUrl(source);
  const databaseMedia = isDatabaseMediaUrl(source);

  if (provider === "description" && !supportedMedia) {
    throw new TracksError(
      "INVALID_SOURCE",
      "Description resolution requires a public YouTube or SoundCloud URL",
      { exitCode: 2 },
    );
  }
  if (databaseEnabled && !env.PARSE_API_KEY) {
    throw new TracksError(
      "AUTH_REQUIRED",
      "PARSE_API_KEY is required for the 1001Tracklists provider",
      {
        exitCode: 2,
      },
    );
  }
  if (provider === "1001tracklists" && !databaseMedia) {
    throw new TracksError(
      "INVALID_SOURCE",
      "1001Tracklists lookup requires a public YouTube or SoundCloud URL",
      { exitCode: 2 },
    );
  }

  // The two independent cold operations start together. Metadata remains authoritative for a
  // timestamped description; otherwise exact media and ranked title matches race to completion.
  const localAbort = new AbortController();
  const lookupSignal = combineSignals(options.signal, localAbort.signal);
  const client =
    databaseEnabled && databaseMedia
      ? create1001Client(env, fetch, lookupSignal, options.cacheMode)
      : undefined;
  const metadataPromise =
    supportedMedia && (descriptionEnabled || Boolean(client))
      ? settle(loadMediaMetadata(source, options, env, lookupSignal))
      : undefined;
  const exactPromise = client
    ? settleDatabase(
        timedStage(
          "database-media",
          "database",
          "Completed 1001Tracklists media URL lookup",
          options,
          async () => {
            options.onProgress?.({
              phase: "database",
              message: "Searching 1001Tracklists by media URL",
            });
            const result = await client.findByMediaUrl(source);
            return result.found ? result : undefined;
          },
          (result) => (result ? "matched" : "missed"),
        ),
      )
    : undefined;

  if (descriptionEnabled && metadataPromise) {
    const metadata = await metadataPromise;
    if (metadata.status === "fulfilled") {
      const described = tracklistFromDescription(source, metadata.value);
      if (described) {
        localAbort.abort();
        return described;
      }
      if (provider === "description") {
        localAbort.abort();
        throw new TracksError(
          "NOT_FOUND",
          "No timestamped tracklist found in the media description",
          {
            exitCode: 4,
          },
        );
      }
      warnings.push("No timestamped tracklist found in the media description.");
    } else {
      if (provider === "description") throw metadata.error;
      warnings.push(`Description lookup failed: ${errorMessage(metadata.error)}`);
    }
  }

  if (client && exactPromise) {
    const titlePromise = metadataPromise
      ? settleTitleLookup(metadataPromise, client, options)
      : Promise.resolve<DatabaseLookup>({ status: "missed" });
    const result = await firstDatabaseMatch(exactPromise, titlePromise);
    if (result.status === "matched") {
      localAbort.abort();
      return fromDatabase(source, result.tracklist, options.includeMatches);
    }
    if (result.status === "failed") throw result.error;
    if (provider === "1001tracklists") {
      throw new TracksError(
        "NOT_FOUND",
        "No 1001Tracklists entry matched the media URL or inspected set title",
        { exitCode: 4 },
      );
    }
    warnings.push(
      "No 1001Tracklists entry matched the media URL or inspected set title; used audio recognition instead.",
    );
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

async function loadMediaMetadata(
  source: string,
  options: IdentifyOptions,
  env: Environment,
  signal: AbortSignal,
): Promise<MediaMetadata> {
  options.onProgress?.({ phase: "metadata", message: "Reading set metadata with ytdlp-ts" });
  return timedStage(
    "metadata",
    "metadata",
    "Read set metadata",
    options,
    () =>
      options.metadataClient?.inspect(source, {
        env,
        ...(options.cookies ? { cookies: options.cookies } : {}),
        ...(options.cookiesFromBrowser ? { cookiesFromBrowser: options.cookiesFromBrowser } : {}),
        signal,
        ...(options.cacheMode ? { cacheMode: options.cacheMode } : {}),
      }) ??
      inspectMediaMetadata(source, {
        env,
        ...(options.cookies ? { cookies: options.cookies } : {}),
        ...(options.cookiesFromBrowser ? { cookiesFromBrowser: options.cookiesFromBrowser } : {}),
        signal,
        ...(options.cacheMode ? { cacheMode: options.cacheMode } : {}),
      }),
  );
}

async function settleTitleLookup(
  metadataPromise: Promise<Settled<MediaMetadata>>,
  client: Tracklists1001Client,
  options: IdentifyOptions,
): Promise<DatabaseLookup> {
  const metadata = await metadataPromise;
  if (metadata.status === "rejected") return { status: "missed" };
  if (!metadata.value.title) return { status: "missed" };

  try {
    options.onProgress?.({
      phase: "database",
      message: "Searching 1001Tracklists by inspected set title and uploader",
    });
    const search = await timedStage(
      "database-search",
      "database",
      "Searched 1001Tracklists by title",
      options,
      () => client.search(metadata.value.title!, metadata.value.uploader),
      (result) => (result.items.length ? "completed" : "missed"),
    );
    const [ranked] = rankTracklistCandidates(search.items, metadata.value);
    if (!ranked || ranked.score < 0.35) return { status: "missed" };

    options.onProgress?.({
      phase: "database",
      message: `Loading ranked 1001Tracklists candidate (${Math.round(ranked.score * 100)}% match)`,
    });
    const tracklist = await timedStage(
      "database-tracklist",
      "database",
      "Loaded ranked 1001Tracklists candidate",
      options,
      () => client.get(ranked.candidate.url),
      () => "matched",
    );
    return { status: "matched", tracklist };
  } catch (error) {
    return { status: "failed", error };
  }
}

/** Rank title-search results so a provider's incidental ordering never selects the wrong set. */
export function rankTracklistCandidates(
  candidates: readonly TracklistSummary[],
  metadata: Pick<MediaMetadata, "title" | "uploader" | "durationSeconds">,
): { candidate: TracklistSummary; score: number }[] {
  return candidates
    .map((candidate) => ({ candidate, score: scoreTracklistCandidate(candidate, metadata) }))
    .sort(
      (left, right) =>
        right.score - left.score || left.candidate.url.localeCompare(right.candidate.url),
    );
}

function scoreTracklistCandidate(
  candidate: TracklistSummary,
  metadata: Pick<MediaMetadata, "title" | "uploader" | "durationSeconds">,
): number {
  const titleScore = tokenSimilarity(metadata.title, candidate.title);
  let weightedScore = titleScore * 0.75;
  let weight = 0.75;
  if (metadata.uploader) {
    const djText = candidate.djName ?? candidate.title;
    weightedScore += tokenSimilarity(metadata.uploader, djText) * 0.15;
    weight += 0.15;
  }
  if (metadata.durationSeconds && candidate.durationSeconds) {
    const difference = Math.abs(metadata.durationSeconds - candidate.durationSeconds);
    weightedScore += Math.max(0, 1 - difference / Math.max(metadata.durationSeconds, 1)) * 0.1;
    weight += 0.1;
  }
  return Math.round((weightedScore / weight) * 10_000) / 10_000;
}

function tokenSimilarity(left: string | undefined, right: string | undefined): number {
  const leftTokens = normalizedTokens(left);
  const rightTokens = normalizedTokens(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

function normalizedTokens(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]+/gu) ?? [],
  );
}

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (error) {
    return { status: "rejected", error };
  }
}

async function settleDatabase(
  promise: Promise<DatabaseTracklist | undefined>,
): Promise<DatabaseLookup> {
  try {
    const tracklist = await promise;
    return tracklist ? { status: "matched", tracklist } : { status: "missed" };
  } catch (error) {
    return { status: "failed", error };
  }
}

async function firstDatabaseMatch(
  exact: Promise<DatabaseLookup>,
  title: Promise<DatabaseLookup>,
): Promise<DatabaseLookup> {
  return new Promise((resolve) => {
    const outcomes: DatabaseLookup[] = [];
    const complete = (outcome: DatabaseLookup) => {
      if (outcome.status === "matched") {
        resolve(outcome);
        return;
      }
      outcomes.push(outcome);
      if (outcomes.length < 2) return;
      const failed = outcomes.find(
        (item): item is Extract<DatabaseLookup, { status: "failed" }> =>
          item.status === "failed" && !isAbortError(item.error),
      );
      resolve(failed ?? outcomes.find((item) => item.status === "failed") ?? { status: "missed" });
    };
    void exact.then(complete);
    void title.then(complete);
  });
}

async function timedStage<T>(
  stage: IdentifyStageTiming["stage"],
  phase: "metadata" | "database",
  completedMessage: string,
  options: IdentifyOptions,
  run: () => Promise<T>,
  outcome: (value: T) => IdentifyStageTiming["outcome"] = () => "completed",
): Promise<T> {
  const started = performance.now();
  try {
    const value = await run();
    const durationMs = roundMilliseconds(performance.now() - started);
    const result = outcome(value);
    options.onStageTiming?.({ stage, outcome: result, durationMs });
    options.onProgress?.({
      phase,
      message: `${completedMessage}${result === "completed" ? "" : ` (${result})`} in ${formatDuration(durationMs)}`,
    });
    return value;
  } catch (error) {
    const durationMs = roundMilliseconds(performance.now() - started);
    const result = isAbortError(error) ? "cancelled" : "failed";
    options.onStageTiming?.({ stage, outcome: result, durationMs });
    throw error;
  }
}

function combineSignals(parent: AbortSignal | undefined, local: AbortSignal): AbortSignal {
  return parent ? AbortSignal.any([parent, local]) : local;
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
