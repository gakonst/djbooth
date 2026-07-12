import { normalizeMatchText } from "./acquisition.js";
import type { CacheStats } from "./cache.js";
import type { ResolvedTrack, SetManifest, SpotifyCandidate, TrackIdentity } from "./manifest.js";
import { mapConcurrent } from "./process.js";

export type SpotifySearchClient = {
  raw<T = unknown>(
    method: string,
    path: string,
    options?: {
      query?: Record<
        string,
        string | number | boolean | readonly (string | number | boolean)[] | undefined
      >;
      signal?: AbortSignal;
    },
  ): Promise<T | undefined>;
  cacheStats?(): CacheStats | undefined;
};

export type SpotifyScoringTarget = {
  artist: string;
  title: string;
  mix?: string;
  isrc?: string;
  durationMs?: number;
};

export type SpotifyTrackCandidate = Omit<SpotifyCandidate, "score">;

export type SpotifyEnrichmentProgress = {
  current: number;
  total: number;
  entryId: string;
  order: number;
  query: string;
  status: "searching" | "matched" | "ambiguous" | "unmatched" | "failed";
};

export type SpotifyEnrichmentOptions = {
  /** Optional ISO 3166-1 alpha-2 market passed through to Spotify Search. */
  market?: string;
  /** Spotify reduced Search's maximum to 10 in February 2026. */
  searchLimit?: number;
  concurrency?: number;
  minimumMatchScore?: number;
  minimumCandidateScore?: number;
  ambiguityMargin?: number;
  maxCandidates?: number;
  signal?: AbortSignal;
  continueOnError?: boolean;
  /** Recording duration only. A set cue's span is deliberately not used. */
  expectedDurationMs?: (entry: ResolvedTrack) => number | undefined;
  onProgress?: (progress: SpotifyEnrichmentProgress) => void;
};

export type SpotifyEnrichmentResult = {
  manifest: SetManifest;
  attempted: number;
  requests: number;
  networkRequests: number;
  concurrency: number;
  maxConcurrency: number;
  matched: number;
  ambiguous: number;
  unmatched: number;
  skipped: number;
  failed: number;
  untouched: number;
  durationMs: number;
  cache?: CacheStats;
};

type ResolvedOptions = {
  market?: string;
  searchLimit: number;
  concurrency: number;
  minimumMatchScore: number;
  minimumCandidateScore: number;
  ambiguityMargin: number;
  maxCandidates: number;
  signal?: AbortSignal;
  continueOnError: boolean;
  expectedDurationMs?: (entry: ResolvedTrack) => number | undefined;
  onProgress?: (progress: SpotifyEnrichmentProgress) => void;
};

const VERSION_WORDS = new Set([
  "acoustic",
  "club",
  "dub",
  "edit",
  "extended",
  "instrumental",
  "live",
  "mix",
  "mixed",
  "radio",
  "remaster",
  "remastered",
  "remix",
]);

/**
 * Enrich every pending, identified manifest row through one injected `spots` client.
 * Existing decisions are checkpoints: matched, ambiguous, unmatched, failed, and skipped rows are
 * never searched again or overwritten.
 */
export async function enrichSpotifyManifest(
  manifest: SetManifest,
  spotify: SpotifySearchClient,
  options: SpotifyEnrichmentOptions = {},
): Promise<SpotifyEnrichmentResult> {
  const started = performance.now();
  const cacheBefore = spotify.cacheStats?.();
  const resolved = resolveOptions(options);
  const pending = manifest.entries.filter((entry) => entry.spotify.status === "pending");
  const identified = pending.filter(
    (
      entry,
    ): entry is ResolvedTrack & { identity: Extract<TrackIdentity, { status: "identified" }> } =>
      entry.identity.status === "identified",
  );
  const unidentified = pending.filter((entry) => entry.identity.status === "unidentified");
  for (const entry of unidentified) {
    entry.spotify = { status: "skipped", reason: "Track identity is unresolved" };
  }

  let requests = 0;
  let activeRequests = 0;
  let maxConcurrency = 0;
  const searches = new Map<string, Promise<SpotifyTrackCandidate[]>>();
  await mapConcurrent(identified, resolved.concurrency, async (entry, index) => {
    const query = spotifySearchQuery(entry.identity);
    resolved.onProgress?.({
      current: index + 1,
      total: identified.length,
      entryId: entry.id,
      order: entry.order,
      query,
      status: "searching",
    });
    try {
      const cacheKey = JSON.stringify([query, resolved.market, resolved.searchLimit]);
      let search = searches.get(cacheKey);
      if (!search) {
        requests += 1;
        search = (async () => {
          activeRequests += 1;
          maxConcurrency = Math.max(maxConcurrency, activeRequests);
          try {
            return await searchSpotify(spotify, query, resolved);
          } finally {
            activeRequests -= 1;
          }
        })();
        searches.set(cacheKey, search);
      }
      const expectedDurationMs = resolved.expectedDurationMs?.(entry);
      const target: SpotifyScoringTarget = {
        artist: entry.identity.artist,
        title: entry.identity.title,
        ...(entry.identity.mix ? { mix: entry.identity.mix } : {}),
        ...(entry.identity.isrc ? { isrc: entry.identity.isrc } : {}),
        ...(expectedDurationMs === undefined ? {} : { durationMs: expectedDurationMs }),
      };
      const candidates = scoreSpotifyCandidates(target, await search).slice(
        0,
        resolved.maxCandidates,
      );
      const plausible = candidates.filter(
        (candidate) => candidate.score >= resolved.minimumCandidateScore,
      );
      const best = plausible[0];
      if (!best) {
        entry.spotify = { status: "unmatched", query };
      } else {
        const runnerUp = plausible[1];
        const close =
          runnerUp !== undefined && best.score - runnerUp.score < resolved.ambiguityMargin;
        if (
          best.score >= resolved.minimumMatchScore &&
          isSafeAutomaticMatch(target, best) &&
          !close
        ) {
          entry.spotify = {
            status: "matched",
            query,
            ...best,
            candidates,
          };
          enrichIdentity(entry.identity, best);
        } else {
          entry.spotify = { status: "ambiguous", query, candidates: plausible };
        }
      }
      resolved.onProgress?.({
        current: index + 1,
        total: identified.length,
        entryId: entry.id,
        order: entry.order,
        query,
        status: entry.spotify.status as "matched" | "ambiguous" | "unmatched",
      });
    } catch (error) {
      entry.spotify = {
        status: "failed",
        query,
        error: {
          stage: "spotify",
          code: "SPOTIFY_SEARCH_FAILED",
          message: errorMessage(error),
          retryable: true,
        },
      };
      resolved.onProgress?.({
        current: index + 1,
        total: identified.length,
        entryId: entry.id,
        order: entry.order,
        query,
        status: "failed",
      });
      if (!resolved.continueOnError) throw error;
    }
  });

  const processed = new Set(pending.map((entry) => entry.id));
  const cacheAfter = spotify.cacheStats?.();
  const cache = cacheAfter ? subtractCacheStats(cacheAfter, cacheBefore) : undefined;
  return {
    manifest,
    attempted: identified.length,
    requests,
    networkRequests: cache
      ? Math.max(0, cache.misses + cache.bypasses - cache.coalesced)
      : requests,
    concurrency: resolved.concurrency,
    maxConcurrency,
    matched: countStatus(pending, "matched"),
    ambiguous: countStatus(pending, "ambiguous"),
    unmatched: countStatus(pending, "unmatched"),
    skipped: countStatus(pending, "skipped"),
    failed: countStatus(pending, "failed"),
    untouched: manifest.entries.filter((entry) => !processed.has(entry.id)).length,
    durationMs: Math.round((performance.now() - started) * 100) / 100,
    ...(cache ? { cache } : {}),
  };
}

function subtractCacheStats(after: CacheStats, before?: CacheStats): CacheStats {
  const baseline = before ?? {
    hits: 0,
    misses: 0,
    writes: 0,
    bypasses: 0,
    coalesced: 0,
    errors: 0,
    readMs: 0,
    loadMs: 0,
    writeMs: 0,
  };
  return Object.fromEntries(
    Object.entries(after).map(([key, value]) => [
      key,
      Math.round((value - baseline[key as keyof CacheStats]) * 100) / 100,
    ]),
  ) as CacheStats;
}

export function spotifySearchQuery(
  identity: Extract<TrackIdentity, { status: "identified" }>,
): string {
  const isrc = normalizeIsrc(identity.isrc);
  if (isrc) return `isrc:${isrc}`;
  return `track:"${searchTerm(expectedTitle(identity))}" artist:"${searchTerm(identity.artist)}"`;
}

export function scoreSpotifyCandidates(
  target: SpotifyScoringTarget,
  candidates: readonly SpotifyTrackCandidate[],
): SpotifyCandidate[] {
  const unique = new Map<string, SpotifyTrackCandidate>();
  for (const candidate of candidates) unique.set(candidate.id, candidate);
  return [...unique.values()]
    .map((candidate) => ({
      ...candidate,
      score: scoreSpotifyCandidate(target, candidate),
    }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

export function scoreSpotifyCandidate(
  target: SpotifyScoringTarget,
  candidate: SpotifyTrackCandidate,
): number {
  const expectedIsrc = normalizeIsrc(target.isrc);
  const candidateIsrc = normalizeIsrc(candidate.isrc);
  if (expectedIsrc && candidateIsrc === expectedIsrc) return 1;

  const targetTitle = normalizeMatchText(expectedTitle(target));
  const candidateTitle = normalizeMatchText(candidate.name);
  const title = titleSimilarity(targetTitle, candidateTitle);
  const artist = artistSimilarity(target.artist, candidate.artists);
  const duration = durationSimilarity(target.durationMs, candidate.durationMs);
  const durationWeight = duration === undefined ? 0 : 0.1;
  let score =
    title * (0.7 - durationWeight * 0.8) +
    artist * (0.3 - durationWeight * 0.2) +
    (duration ?? 0) * durationWeight -
    versionPenalty(targetTitle, candidateTitle);
  if (expectedIsrc && candidateIsrc && expectedIsrc !== candidateIsrc)
    score = Math.min(score, 0.49);
  return roundScore(clamp(score));
}

async function searchSpotify(
  spotify: SpotifySearchClient,
  query: string,
  options: ResolvedOptions,
): Promise<SpotifyTrackCandidate[]> {
  const response = await spotify.raw<unknown>("GET", "search", {
    query: {
      q: query,
      type: "track",
      limit: options.searchLimit,
      ...(options.market ? { market: options.market } : {}),
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return parseSearchTracks(response);
}

function parseSearchTracks(value: unknown): SpotifyTrackCandidate[] {
  const body = asRecord(value);
  const tracks = asRecord(body.tracks);
  const items = Array.isArray(tracks.items) ? tracks.items : [];
  return items.flatMap((item) => {
    const track = asRecord(item);
    if (typeof track.id !== "string" || typeof track.name !== "string") return [];
    const artists = Array.isArray(track.artists)
      ? track.artists
          .map(asRecord)
          .map((artist) => artist.name)
          .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
      : [];
    if (!artists.length) return [];
    const album = asRecord(track.album);
    const albumArtists = Array.isArray(album.artists)
      ? album.artists
          .map(asRecord)
          .map((artist) => artist.name)
          .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
      : [];
    const externalIds = asRecord(track.external_ids);
    const externalUrls = asRecord(track.external_urls);
    return [
      {
        id: track.id,
        uri: typeof track.uri === "string" ? track.uri : `spotify:track:${track.id}`,
        ...(typeof externalUrls.spotify === "string" ? { url: externalUrls.spotify } : {}),
        name: track.name,
        artists,
        ...(typeof album.name === "string" ? { album: album.name } : {}),
        ...(albumArtists.length ? { albumArtists } : {}),
        ...(typeof album.release_date === "string" ? { releaseDate: album.release_date } : {}),
        ...(positiveInteger(track.duration_ms) === undefined
          ? {}
          : { durationMs: positiveInteger(track.duration_ms)! }),
        ...(typeof track.explicit === "boolean" ? { explicit: track.explicit } : {}),
        ...(typeof externalIds.isrc === "string" ? { isrc: externalIds.isrc } : {}),
      },
    ];
  });
}

function resolveOptions(options: SpotifyEnrichmentOptions): ResolvedOptions {
  const searchLimit = integerOption(options.searchLimit, 10, 1, 10, "searchLimit");
  const concurrency = integerOption(options.concurrency, 8, 1, 32, "concurrency");
  const maxCandidates = integerOption(options.maxCandidates, 5, 1, searchLimit, "maxCandidates");
  const minimumMatchScore = scoreOption(options.minimumMatchScore, 0.84, "minimumMatchScore");
  const minimumCandidateScore = scoreOption(
    options.minimumCandidateScore,
    0.58,
    "minimumCandidateScore",
  );
  const ambiguityMargin = scoreOption(options.ambiguityMargin, 0.06, "ambiguityMargin");
  if (minimumCandidateScore > minimumMatchScore) {
    throw new RangeError("minimumCandidateScore must not exceed minimumMatchScore");
  }
  const market = options.market?.trim().toUpperCase();
  if (market && !/^[A-Z]{2}$/u.test(market)) {
    throw new RangeError("market must be an ISO 3166-1 alpha-2 code");
  }
  return {
    ...(market ? { market } : {}),
    searchLimit,
    concurrency,
    minimumMatchScore,
    minimumCandidateScore,
    ambiguityMargin,
    maxCandidates,
    ...(options.signal ? { signal: options.signal } : {}),
    continueOnError: options.continueOnError ?? true,
    ...(options.expectedDurationMs ? { expectedDurationMs: options.expectedDurationMs } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  };
}

function expectedTitle(target: { title: string; mix?: string }): string {
  const mix = target.mix?.trim();
  if (!mix || normalizeMatchText(target.title).includes(normalizeMatchText(mix)))
    return target.title;
  return `${target.title} (${mix})`;
}

function titleSimilarity(expected: string, candidate: string): number {
  if (!expected || !candidate) return 0;
  if (expected === candidate) return 1;
  const expectedTokens = tokenSet(expected);
  const candidateTokens = tokenSet(candidate);
  const overlap = intersectionSize(expectedTokens, candidateTokens);
  if (!overlap) return 0;
  const recall = overlap / expectedTokens.size;
  const precision = overlap / candidateTokens.size;
  const f1 = (2 * precision * recall) / (precision + recall);
  return f1 * 0.55 + recall * 0.45;
}

function artistSimilarity(expected: string, candidateArtists: readonly string[]): number {
  const expectedTokens = artistTokens(expected);
  const candidateTokens = artistTokens(candidateArtists.join(" "));
  const overlap = intersectionSize(expectedTokens, candidateTokens);
  if (!overlap || !expectedTokens.size || !candidateTokens.size) return 0;
  const recall = overlap / expectedTokens.size;
  const precision = overlap / candidateTokens.size;
  const f1 = (2 * precision * recall) / (precision + recall);
  return recall * 0.7 + f1 * 0.3;
}

function artistRecall(expected: string, candidateArtists: readonly string[]): number {
  const expectedTokens = artistTokens(expected);
  if (!expectedTokens.size) return 0;
  return (
    intersectionSize(expectedTokens, artistTokens(candidateArtists.join(" "))) / expectedTokens.size
  );
}

function isSafeAutomaticMatch(
  target: SpotifyScoringTarget,
  candidate: SpotifyTrackCandidate,
): boolean {
  const expectedIsrc = normalizeIsrc(target.isrc);
  if (expectedIsrc) return normalizeIsrc(candidate.isrc) === expectedIsrc;
  const expected = normalizeMatchText(expectedTitle(target));
  const actual = normalizeMatchText(candidate.name);
  if (titleSimilarity(expected, actual) < 0.82) return false;
  if (artistRecall(target.artist, candidate.artists) < 0.75) return false;
  if (versionPenalty(expected, actual) > 0) return false;
  if (target.durationMs !== undefined && candidate.durationMs !== undefined) {
    const ratio = Math.abs(target.durationMs - candidate.durationMs) / target.durationMs;
    if (ratio > 0.12) return false;
  }
  return true;
}

function durationSimilarity(
  expectedDurationMs: number | undefined,
  candidateDurationMs: number | undefined,
): number | undefined {
  if (
    expectedDurationMs === undefined ||
    candidateDurationMs === undefined ||
    expectedDurationMs <= 0 ||
    candidateDurationMs <= 0
  ) {
    return undefined;
  }
  const ratio = Math.abs(expectedDurationMs - candidateDurationMs) / expectedDurationMs;
  if (ratio <= 0.01) return 1;
  if (ratio <= 0.05) return 0.9;
  if (ratio <= 0.1) return 0.65;
  if (ratio <= 0.2) return 0.25;
  return 0;
}

function versionPenalty(expected: string, candidate: string): number {
  const expectedVersions = versionWords(expected);
  const candidateVersions = versionWords(candidate);
  const missing = [...expectedVersions].some((word) => !candidateVersions.has(word));
  const extra = [...candidateVersions].some((word) => !expectedVersions.has(word));
  return (missing ? 0.16 : 0) + (extra ? 0.14 : 0);
}

function versionWords(value: string): Set<string> {
  return new Set([...tokenSet(value)].filter((word) => VERSION_WORDS.has(word)));
}

function tokenSet(value: string): Set<string> {
  return new Set(normalizeMatchText(value).split(" ").filter(Boolean));
}

function artistTokens(value: string): Set<string> {
  const tokens = tokenSet(value);
  for (const connector of ["and", "versus", "vs", "x"]) tokens.delete(connector);
  return tokens;
}

function intersectionSize(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let matches = 0;
  for (const value of left) if (right.has(value)) matches += 1;
  return matches;
}

function enrichIdentity(
  identity: Extract<TrackIdentity, { status: "identified" }>,
  candidate: SpotifyCandidate,
): void {
  if (!identity.album && candidate.album) identity.album = candidate.album;
  if (!identity.releaseDate && candidate.releaseDate) identity.releaseDate = candidate.releaseDate;
  if (!identity.isrc && candidate.isrc) identity.isrc = candidate.isrc;
}

function countStatus(
  entries: readonly ResolvedTrack[],
  status: ResolvedTrack["spotify"]["status"],
): number {
  return entries.filter((entry) => entry.spotify.status === status).length;
}

function normalizeIsrc(value: string | undefined): string | undefined {
  const normalized = value?.replace(/[^a-z0-9]/giu, "").toUpperCase();
  return normalized && /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/u.test(normalized) ? normalized : undefined;
}

function searchTerm(value: string): string {
  return value.replace(/["\\]/gu, " ").trim().replace(/\s+/gu, " ");
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function integerOption(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    throw new RangeError(
      `${name} must be an integer from ${String(minimum)} to ${String(maximum)}`,
    );
  }
  return selected;
}

function scoreOption(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected < 0 || selected > 1) {
    throw new RangeError(`${name} must be between 0 and 1`);
  }
  return selected;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
