import { TracksError } from "./errors.js";
import { is1001Url, isHttpUrl } from "./media.js";
import { parseTimestamp } from "./time.js";
import type {
  RecognitionMoment,
  RecognitionProvider,
  Tracklist,
  TracklistEntry,
  TracklistSuggestion,
  TrackMediaLink,
  TracklistOverlap,
} from "./types.js";

export const MANIFEST_SCHEMA_VERSION = 1 as const;
export const MANIFEST_KIND = "dj-set-pipeline" as const;

export type PipelineStage =
  | "manifest"
  | "source"
  | "tracklist"
  | "identity"
  | "spotify"
  | "acquisition"
  | "rekordbox";

export type PipelineError = {
  stage: PipelineStage;
  message: string;
  code?: string;
  retryable?: boolean;
};

export type ManifestSource = {
  input: string;
  id?: string;
  url?: string;
  title?: string;
  uploader?: string;
  date?: string;
  lineup?: string[];
  durationSeconds?: number;
};

export type ManifestTracklist = {
  provider: RecognitionProvider;
  url?: string;
  complete: boolean;
  sampledEverySeconds?: number;
  matches?: RecognitionMoment[];
  suggestions?: TracklistSuggestion[];
};

export type TrackCue = {
  timestamp?: string;
  startSeconds?: number;
  endSeconds?: number;
};

type IdentityMetadata = {
  isId?: boolean;
  artist?: string;
  title?: string;
  mix?: string;
  album?: string;
  label?: string;
  genre?: string;
  releaseDate?: string;
  isrc?: string;
  upc?: string;
  songLink?: string;
  mediaLinks?: TrackMediaLink[];
  confidence?: number;
  overlaps?: TracklistOverlap[];
};

export type TrackIdentity =
  | (IdentityMetadata & {
      status: "identified";
      artist: string;
      title: string;
      searchQuery: string;
    })
  | (IdentityMetadata & {
      status: "unidentified";
      searchQuery?: never;
    });

export type SpotifyCandidate = {
  score: number;
  id: string;
  uri: string;
  url?: string;
  name: string;
  artists: string[];
  album?: string;
  albumArtists?: string[];
  releaseDate?: string;
  durationMs?: number;
  explicit?: boolean;
  isrc?: string;
};

export type SpotifyState =
  | { status: "pending"; query?: string }
  | {
      status: "matched";
      query: string;
      score: number;
      id: string;
      uri: string;
      url?: string;
      name?: string;
      artists?: string[];
      album?: string;
      albumArtists?: string[];
      releaseDate?: string;
      durationMs?: number;
      explicit?: boolean;
      isrc?: string;
      candidates?: SpotifyCandidate[];
    }
  | { status: "ambiguous"; query: string; candidates: SpotifyCandidate[] }
  | { status: "unmatched"; query: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; query?: string; error: PipelineError };

export type AcquisitionBackend = "slsk" | "ytdlp";
export type AcquisitionDownloadBackend = "local" | AcquisitionBackend;
export type AcquisitionKind = "individual" | "source-set-clip";

export type AcquisitionFallback = {
  from: "native";
  code: string;
};

export type AcquisitionCandidate = {
  backend: AcquisitionBackend;
  id: string;
  source: string;
  title: string;
  artist?: string;
  durationSeconds?: number;
  score?: number;
};

export type AcquisitionDownload = {
  backend: AcquisitionDownloadBackend;
  kind?: AcquisitionKind;
  mediaPath: string;
  files: string[];
  source?: string;
  engine?: "native" | "reference";
  fallback?: AcquisitionFallback;
  sha256?: string;
  spotifyId?: string;
  isrc?: string;
  variantKey?: string;
  clip?: {
    sourceSetUrl: string;
    sourceSetTitle?: string;
    startSeconds: number;
    endSeconds: number;
    containsTransitions: boolean;
    qualityNote: string;
  };
};

export type AcquisitionState =
  | { status: "pending"; query?: string }
  | { status: "searching"; query: string; candidates: AcquisitionCandidate[] }
  | {
      status: "selected";
      query: string;
      candidates: AcquisitionCandidate[];
      selected: AcquisitionCandidate;
    }
  | { status: "unmatched"; query: string; candidates: AcquisitionCandidate[] }
  | {
      status: "downloaded";
      query?: string;
      candidates?: AcquisitionCandidate[];
      selected?: AcquisitionCandidate;
      download: AcquisitionDownload;
      alternatives?: AcquisitionDownload[];
    }
  | { status: "skipped"; reason: string }
  | {
      status: "failed";
      query?: string;
      candidates?: AcquisitionCandidate[];
      error: PipelineError;
    };

export type RekordboxTarget = "m3u8" | "rekordbox-xml" | "rekordbox-db";

/** Durable analyzer metadata for one acquired recording. */
export type RekordboxAnalysisArtifact = {
  mediaPath: string;
  summaryPath: string;
  backend: string;
  tempoBpm: number | null;
  key: string | null;
  keySource: string | null;
  rhythmMode?: "normal" | "dynamic";
  rhythmModeRequested?: "normal" | "dynamic" | "auto";
  sourceMtimeMs: number;
  sourceSize: number;
};

/** Durable timing/counter checkpoint for one analysis-only invocation. */
export type RekordboxAnalysisRunArtifact = {
  analyzed: number;
  cacheHits: number;
  cancelled: number;
  failed: number;
  finishedAt: string;
  requested: number;
  startedAt: string;
  status: "completed" | "failed" | "cancelled";
  totalMs: number;
};

export type RekordboxState =
  | { status: "pending" }
  | {
      status: "exported" | "imported";
      target: RekordboxTarget;
      artifact?: string;
      xmlTrackId?: number;
      dbContentId?: string;
      playlistMembershipId?: string;
      dbContentIds?: string[];
      playlistMembershipIds?: string[];
    }
  | { status: "skipped"; reason: string }
  | { status: "failed"; target?: RekordboxTarget; error: PipelineError };

export type ResolvedTrack = {
  id: string;
  order: number;
  cue: TrackCue;
  identity: TrackIdentity;
  spotify: SpotifyState;
  acquisition: AcquisitionState;
  rekordbox: RekordboxState;
  warnings: string[];
  errors: PipelineError[];
};

export type ManifestArtifacts = {
  root?: string;
  manifest?: string;
  downloadDirectory?: string;
  m3u8?: string;
  rekordboxXml?: string;
  sourceSet?: {
    url: string;
    path: string;
    sha256: string;
    durationSeconds: number;
    codec: string;
    bitrate: number;
  };
  analysis?: RekordboxAnalysisArtifact[];
  analysisRuns?: RekordboxAnalysisRunArtifact[];
  rekordbox?: {
    target: "rekordbox-db";
    dbPath: string;
    folderName: string;
    folderId: string;
    playlistName: string;
    playlistId: string;
  };
};

export type SetManifest = {
  schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  kind: typeof MANIFEST_KIND;
  source: ManifestSource;
  tracklist: ManifestTracklist;
  entries: ResolvedTrack[];
  warnings: string[];
  errors: PipelineError[];
  artifacts: ManifestArtifacts;
};

export function createManifest(tracklist: Tracklist): SetManifest {
  const providerUrl =
    tracklist.provider === "agent" &&
    (tracklist.url !== tracklist.source || is1001Url(tracklist.source))
      ? tracklist.url
      : undefined;
  const sourceUrl =
    tracklist.provider === "agent"
      ? isHttpUrl(tracklist.source) && !is1001Url(tracklist.source)
        ? tracklist.source
        : undefined
      : tracklist.url;
  const entries = tracklist.tracks.map((track) => {
    const status = isUnidentified(track) ? "unidentified" : "identified";
    const searchQuery = status === "identified" ? trackSearchQuery(track)! : undefined;
    const spotifyMedia =
      status === "identified"
        ? track.mediaLinks?.find((link) => link.platform === "spotify")
        : undefined;
    const spotifyId = spotifyMedia?.sourceId;
    const identityMetadata = copyIdentityMetadata(track);
    const identity: TrackIdentity =
      status === "identified"
        ? {
            ...identityMetadata,
            status,
            artist: track.artist!,
            title: track.title!,
            searchQuery: searchQuery!,
          }
        : { ...identityMetadata, status };
    return {
      id: trackId(track.order),
      order: track.order,
      cue: {
        ...(track.timestamp === undefined ? {} : { timestamp: track.timestamp }),
        ...(track.startSeconds === undefined ? {} : { startSeconds: track.startSeconds }),
        ...(track.endSeconds === undefined ? {} : { endSeconds: track.endSeconds }),
      },
      identity,
      spotify:
        status === "unidentified"
          ? { status: "skipped" as const, reason: "Unresolved track identity" }
          : spotifyId
            ? {
                status: "matched" as const,
                query: `spotify:id:${spotifyId}`,
                score: 1,
                id: spotifyId,
                uri: `spotify:track:${spotifyId}`,
                url: `https://open.spotify.com/track/${spotifyId}`,
                ...(spotifyMedia.durationSeconds === undefined
                  ? {}
                  : { durationMs: Math.round(spotifyMedia.durationSeconds * 1000) }),
              }
            : { status: "pending" as const, query: searchQuery! },
      acquisition:
        status === "unidentified"
          ? { status: "skipped" as const, reason: "Unresolved track identity" }
          : { status: "pending" as const, query: searchQuery! },
      rekordbox:
        status === "unidentified"
          ? { status: "skipped" as const, reason: "Unresolved track identity" }
          : { status: "pending" as const },
      warnings: [],
      errors: [],
    };
  });

  const manifest: SetManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    source: {
      input: tracklist.source,
      ...(tracklist.sourceId === undefined ? {} : { id: tracklist.sourceId }),
      ...(sourceUrl === undefined ? {} : { url: sourceUrl }),
      ...(tracklist.title === undefined ? {} : { title: tracklist.title }),
      ...(tracklist.uploader === undefined ? {} : { uploader: tracklist.uploader }),
      ...(tracklist.date === undefined ? {} : { date: tracklist.date }),
      ...(tracklist.lineup === undefined ? {} : { lineup: [...tracklist.lineup] }),
      ...(tracklist.durationSeconds === undefined
        ? {}
        : { durationSeconds: tracklist.durationSeconds }),
    },
    tracklist: {
      provider: tracklist.provider,
      ...(providerUrl === undefined ? {} : { url: providerUrl }),
      complete: tracklist.complete,
      ...(tracklist.sampledEverySeconds === undefined
        ? {}
        : { sampledEverySeconds: tracklist.sampledEverySeconds }),
      ...(tracklist.matches === undefined ? {} : { matches: copyMatches(tracklist.matches) }),
      ...(tracklist.suggestions === undefined
        ? {}
        : { suggestions: tracklist.suggestions.map((suggestion) => ({ ...suggestion })) }),
    },
    entries,
    warnings: [...(tracklist.warnings ?? [])],
    errors: [],
    artifacts: {},
  };
  return parseManifest(manifest);
}

export function parseManifest(value: unknown): SetManifest {
  const migrated = migrateLegacyProvider(value);
  const root = strictObject(migrated, "$", [
    "schemaVersion",
    "kind",
    "source",
    "tracklist",
    "entries",
    "warnings",
    "errors",
    "artifacts",
  ]);
  literal(root.schemaVersion, MANIFEST_SCHEMA_VERSION, "$.schemaVersion");
  literal(root.kind, MANIFEST_KIND, "$.kind");
  validateSource(root.source, "$.source");
  validateTracklist(root.tracklist, "$.tracklist");
  const entries = array(root.entries, "$.entries");
  const ids = new Set<string>();
  const orders = new Set<number>();
  let previousOrder = 0;
  entries.forEach((entry, index) => {
    const parsed = validateEntry(entry, `$.entries[${index}]`);
    if (ids.has(parsed.id)) invalid(`$.entries[${index}].id`, "must be unique");
    if (orders.has(parsed.order)) invalid(`$.entries[${index}].order`, "must be unique");
    if (parsed.order <= previousOrder)
      invalid(`$.entries[${index}].order`, "must be in strictly ascending order");
    ids.add(parsed.id);
    orders.add(parsed.order);
    previousOrder = parsed.order;
  });
  stringArray(root.warnings, "$.warnings");
  errorArray(root.errors, "$.errors");
  validateArtifacts(root.artifacts, "$.artifacts");
  const artifacts = root.artifacts as ManifestArtifacts;
  const downloadedPaths = new Set(
    (entries as ResolvedTrack[]).flatMap((entry) =>
      entry.acquisition.status === "downloaded"
        ? [
            entry.acquisition.download.mediaPath,
            ...(entry.acquisition.alternatives ?? []).map((download) => download.mediaPath),
          ]
        : [],
    ),
  );
  artifacts.analysis?.forEach((artifact, index) => {
    if (!downloadedPaths.has(artifact.mediaPath)) {
      invalid(`$.artifacts.analysis[${index}].mediaPath`, "must reference a downloaded recording");
    }
  });
  const rekordboxArtifact = artifacts.rekordbox;
  if (rekordboxArtifact) {
    (entries as ResolvedTrack[]).forEach((entry, index) => {
      if (isSkippedEntry(entry)) return;
      if (entry.rekordbox.status !== "imported" || entry.rekordbox.target !== "rekordbox-db") {
        invalid(
          `$.entries[${index}].rekordbox.status`,
          "must be imported when artifacts.rekordbox is present",
        );
      }
      if (
        entry.rekordbox.status === "imported" &&
        entry.rekordbox.artifact !== undefined &&
        entry.rekordbox.artifact !== rekordboxArtifact.dbPath
      ) {
        invalid(`$.entries[${index}].rekordbox.artifact`, "must match artifacts.rekordbox.dbPath");
      }
    });
  }
  return migrated as SetManifest;
}

function migrateLegacyProvider(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const tracklist = (value as Record<string, unknown>).tracklist;
  if (typeof tracklist !== "object" || tracklist === null || Array.isArray(tracklist)) return value;
  if ((tracklist as Record<string, unknown>).provider !== "1001tracklists") return value;
  const migrated = structuredClone(value) as Record<string, unknown>;
  (migrated.tracklist as Record<string, unknown>).provider = "agent";
  return migrated;
}

function isSkippedEntry(entry: ResolvedTrack): boolean {
  return entry.acquisition.status === "skipped" && entry.rekordbox.status === "skipped";
}

export function trackSearchQuery(track: TracklistEntry): string | undefined {
  if (!track.artist || !track.title || isUnidentified(track)) return undefined;
  const artist = track.artist.trim();
  const title = track.title.trim();
  const mix = track.mix?.trim();
  return `${artist} - ${title}${mix ? ` (${mix})` : ""}`;
}

function copyIdentityMetadata(track: TracklistEntry): IdentityMetadata {
  return {
    ...(track.isId === undefined ? {} : { isId: track.isId }),
    ...(track.artist === undefined ? {} : { artist: track.artist }),
    ...(track.title === undefined ? {} : { title: track.title }),
    ...(track.mix === undefined ? {} : { mix: track.mix }),
    ...(track.album === undefined ? {} : { album: track.album }),
    ...(track.label === undefined ? {} : { label: track.label }),
    ...(track.genre === undefined ? {} : { genre: track.genre }),
    ...(track.releaseDate === undefined ? {} : { releaseDate: track.releaseDate }),
    ...(track.isrc === undefined ? {} : { isrc: track.isrc }),
    ...(track.upc === undefined ? {} : { upc: track.upc }),
    ...(track.songLink === undefined ? {} : { songLink: track.songLink }),
    ...(track.mediaLinks === undefined
      ? {}
      : { mediaLinks: track.mediaLinks.map((link) => ({ ...link })) }),
    ...(track.confidence === undefined ? {} : { confidence: track.confidence }),
    ...(track.overlaps === undefined
      ? {}
      : { overlaps: track.overlaps.map((overlap) => ({ ...overlap })) }),
  };
}

function copyMatches(matches: RecognitionMoment[]): RecognitionMoment[] {
  return matches.map((moment) => ({
    offsetSeconds: moment.offsetSeconds,
    matches: moment.matches.map((match) => ({ ...match })),
  }));
}

function trackId(order: number): string {
  return `track-${String(order).padStart(3, "0")}`;
}

function validateSource(value: unknown, path: string): void {
  const record = strictObject(value, path, [
    "input",
    "id",
    "url",
    "title",
    "uploader",
    "date",
    "lineup",
    "durationSeconds",
  ]);
  nonemptyString(record.input, `${path}.input`);
  optionalString(record, "id", path);
  optionalString(record, "url", path);
  optionalString(record, "title", path);
  optionalString(record, "uploader", path);
  optionalString(record, "date", path);
  if (record.lineup !== undefined) stringArray(record.lineup, `${path}.lineup`);
  if (record.durationSeconds !== undefined)
    positiveNumber(record.durationSeconds, `${path}.durationSeconds`);
}

function validateTracklist(value: unknown, path: string): void {
  const record = strictObject(value, path, [
    "provider",
    "url",
    "complete",
    "sampledEverySeconds",
    "matches",
    "suggestions",
  ]);
  oneOf(record.provider, ["description", "agent", "audd", "acrcloud"], `${path}.provider`);
  optionalString(record, "url", path);
  boolean(record.complete, `${path}.complete`);
  if (record.sampledEverySeconds !== undefined)
    positiveNumber(record.sampledEverySeconds, `${path}.sampledEverySeconds`);
  if (record.matches !== undefined) validateMatches(record.matches, `${path}.matches`);
  if (record.suggestions !== undefined)
    validateSuggestions(record.suggestions, `${path}.suggestions`);
}

function validateSuggestions(value: unknown, path: string): void {
  array(value, path).forEach((suggestion, index) => {
    const itemPath = `${path}[${index}]`;
    const item = strictObject(suggestion, itemPath, [
      "id",
      "position",
      "positionId",
      "type",
      "text",
      "timestamp",
      "startSeconds",
      "submitter",
    ]);
    nonemptyString(item.id, `${itemPath}.id`);
    positiveInteger(item.position, `${itemPath}.position`);
    nonemptyString(item.positionId, `${itemPath}.positionId`);
    nonnegativeInteger(item.type, `${itemPath}.type`);
    nonemptyString(item.text, `${itemPath}.text`);
    optionalString(item, "timestamp", itemPath);
    if (item.startSeconds !== undefined)
      nonnegativeNumber(item.startSeconds, `${itemPath}.startSeconds`);
    optionalString(item, "submitter", itemPath);
  });
}

function validateMatches(value: unknown, path: string): void {
  array(value, path).forEach((moment, index) => {
    const momentPath = `${path}[${index}]`;
    const record = strictObject(moment, momentPath, ["offsetSeconds", "matches"]);
    nonnegativeNumber(record.offsetSeconds, `${momentPath}.offsetSeconds`);
    array(record.matches, `${momentPath}.matches`).forEach((match, matchIndex) => {
      const matchPath = `${momentPath}.matches[${matchIndex}]`;
      const item = strictObject(match, matchPath, [
        "startSeconds",
        "endSeconds",
        "scanSeconds",
        "artist",
        "title",
        "album",
        "label",
        "genre",
        "releaseDate",
        "isrc",
        "upc",
        "songLink",
        "confidence",
        "provider",
      ]);
      nonnegativeNumber(item.startSeconds, `${matchPath}.startSeconds`);
      if (item.endSeconds !== undefined)
        nonnegativeNumber(item.endSeconds, `${matchPath}.endSeconds`);
      nonnegativeNumber(item.scanSeconds, `${matchPath}.scanSeconds`);
      nonemptyString(item.artist, `${matchPath}.artist`);
      nonemptyString(item.title, `${matchPath}.title`);
      for (const key of ["album", "label", "genre", "releaseDate", "isrc", "upc", "songLink"])
        optionalString(item, key, matchPath);
      if (item.confidence !== undefined) score100(item.confidence, `${matchPath}.confidence`);
      oneOf(item.provider, ["audd", "acrcloud"], `${matchPath}.provider`);
    });
  });
}

function validateEntry(value: unknown, path: string): { id: string; order: number } {
  const record = strictObject(value, path, [
    "id",
    "order",
    "cue",
    "identity",
    "spotify",
    "acquisition",
    "rekordbox",
    "warnings",
    "errors",
  ]);
  const id = nonemptyString(record.id, `${path}.id`);
  const order = positiveInteger(record.order, `${path}.order`);
  if (id !== trackId(order))
    invalid(`${path}.id`, `must equal ${trackId(order)} for order ${order}`);
  validateCue(record.cue, `${path}.cue`);
  validateIdentity(record.identity, `${path}.identity`);
  validateSpotify(record.spotify, `${path}.spotify`);
  validateAcquisition(record.acquisition, `${path}.acquisition`);
  validateRekordbox(record.rekordbox, `${path}.rekordbox`);
  const acquisition = record.acquisition as AcquisitionState;
  const rekordbox = record.rekordbox as RekordboxState;
  if (
    (rekordbox.status === "exported" || rekordbox.status === "imported") &&
    acquisition.status !== "downloaded"
  ) {
    invalid(`${path}.rekordbox.status`, "requires acquisition.status to equal downloaded");
  }
  if (rekordbox.status === "imported" && rekordbox.target !== "rekordbox-db") {
    invalid(`${path}.rekordbox.target`, "must equal rekordbox-db when status is imported");
  }
  stringArray(record.warnings, `${path}.warnings`);
  errorArray(record.errors, `${path}.errors`);
  return { id, order };
}

function validateCue(value: unknown, path: string): void {
  const record = strictObject(value, path, ["timestamp", "startSeconds", "endSeconds"]);
  optionalString(record, "timestamp", path);
  if (record.startSeconds !== undefined)
    nonnegativeNumber(record.startSeconds, `${path}.startSeconds`);
  if (record.endSeconds !== undefined) nonnegativeNumber(record.endSeconds, `${path}.endSeconds`);
  if (
    typeof record.startSeconds === "number" &&
    typeof record.endSeconds === "number" &&
    record.endSeconds < record.startSeconds
  )
    invalid(`${path}.endSeconds`, "must not precede startSeconds");
  if (typeof record.timestamp === "string") {
    const timestampSeconds = parseTimestamp(record.timestamp);
    if (timestampSeconds === undefined) invalid(`${path}.timestamp`, "must be a valid timestamp");
    if (
      typeof record.startSeconds === "number" &&
      Math.floor(timestampSeconds) !== Math.floor(record.startSeconds)
    )
      invalid(`${path}.timestamp`, "must equal startSeconds");
  }
}

function validateIdentity(value: unknown, path: string): void {
  const record = strictObject(value, path, [
    "status",
    "isId",
    "artist",
    "title",
    "mix",
    "album",
    "label",
    "genre",
    "releaseDate",
    "isrc",
    "upc",
    "songLink",
    "mediaLinks",
    "confidence",
    "overlaps",
    "searchQuery",
  ]);
  oneOf(record.status, ["identified", "unidentified"], `${path}.status`);
  if (record.isId !== undefined) boolean(record.isId, `${path}.isId`);
  for (const key of [
    "artist",
    "title",
    "mix",
    "album",
    "label",
    "genre",
    "releaseDate",
    "isrc",
    "upc",
    "songLink",
  ])
    optionalString(record, key, path);
  if (record.mediaLinks !== undefined) validateMediaLinks(record.mediaLinks, `${path}.mediaLinks`);
  if (record.confidence !== undefined) score100(record.confidence, `${path}.confidence`);
  if (record.overlaps !== undefined) validateOverlaps(record.overlaps, `${path}.overlaps`);
  if (record.status === "identified") {
    if (record.isId === true) invalid(`${path}.isId`, "must not be true for an identified entry");
    const artist = nonemptyString(record.artist, `${path}.artist`).trim();
    const title = nonemptyString(record.title, `${path}.title`).trim();
    if (isIdentityMarker(artist)) invalid(`${path}.artist`, "must not be an ID marker");
    if (isIdentityMarker(title)) invalid(`${path}.title`, "must not be an ID marker");
    const searchQuery = nonemptyString(record.searchQuery, `${path}.searchQuery`);
    const mix = typeof record.mix === "string" ? record.mix.trim() : undefined;
    const expected = `${artist} - ${title}${mix ? ` (${mix})` : ""}`;
    if (searchQuery !== expected)
      invalid(`${path}.searchQuery`, `must equal ${JSON.stringify(expected)}`);
  } else if (record.searchQuery !== undefined) {
    invalid(`${path}.searchQuery`, "is not allowed for an unidentified entry");
  }
}

function validateMediaLinks(value: unknown, path: string): void {
  array(value, path).forEach((link, index) => {
    const itemPath = `${path}[${index}]`;
    const item = strictObject(link, itemPath, [
      "platform",
      "sourceId",
      "url",
      "embedUrl",
      "durationSeconds",
    ]);
    nonemptyString(item.platform, `${itemPath}.platform`);
    nonemptyString(item.sourceId, `${itemPath}.sourceId`);
    nonemptyString(item.url, `${itemPath}.url`);
    optionalString(item, "embedUrl", itemPath);
    if (item.durationSeconds !== undefined)
      positiveInteger(item.durationSeconds, `${itemPath}.durationSeconds`);
  });
}

function validateOverlaps(value: unknown, path: string): void {
  array(value, path).forEach((overlap, index) => {
    const itemPath = `${path}[${index}]`;
    const item = strictObject(overlap, itemPath, ["artist", "title", "confidence"]);
    nonemptyString(item.artist, `${itemPath}.artist`);
    nonemptyString(item.title, `${itemPath}.title`);
    if (item.confidence !== undefined) score100(item.confidence, `${itemPath}.confidence`);
  });
}

function validateSpotify(value: unknown, path: string): void {
  const base = object(value, path);
  const status = oneOf(
    base.status,
    ["pending", "matched", "ambiguous", "unmatched", "skipped", "failed"],
    `${path}.status`,
  );
  const keys =
    status === "matched"
      ? [
          "status",
          "query",
          "score",
          "id",
          "uri",
          "url",
          "name",
          "artists",
          "album",
          "albumArtists",
          "releaseDate",
          "durationMs",
          "explicit",
          "isrc",
          "candidates",
        ]
      : status === "ambiguous"
        ? ["status", "query", "candidates"]
        : status === "unmatched"
          ? ["status", "query"]
          : status === "skipped"
            ? ["status", "reason"]
            : status === "failed"
              ? ["status", "query", "error"]
              : ["status", "query"];
  const record = strictObject(value, path, keys);
  if (status === "matched") {
    nonemptyString(record.query, `${path}.query`);
    score1(record.score, `${path}.score`);
    nonemptyString(record.id, `${path}.id`);
    nonemptyString(record.uri, `${path}.uri`);
    for (const key of ["url", "name", "album", "releaseDate", "isrc"])
      optionalString(record, key, path);
    if (record.artists !== undefined) stringArray(record.artists, `${path}.artists`);
    if (record.albumArtists !== undefined) {
      const albumArtists = stringArray(record.albumArtists, `${path}.albumArtists`);
      if (!albumArtists.length) invalid(`${path}.albumArtists`, "must contain at least one artist");
    }
    if (record.durationMs !== undefined) positiveInteger(record.durationMs, `${path}.durationMs`);
    if (record.explicit !== undefined) boolean(record.explicit, `${path}.explicit`);
    if (record.candidates !== undefined)
      validateSpotifyCandidates(record.candidates, `${path}.candidates`);
  } else if (status === "ambiguous") {
    nonemptyString(record.query, `${path}.query`);
    const candidates = validateSpotifyCandidates(record.candidates, `${path}.candidates`);
    if (!candidates.length) invalid(`${path}.candidates`, "must contain at least one candidate");
  } else if (status === "unmatched") {
    nonemptyString(record.query, `${path}.query`);
  } else if (status === "skipped") {
    nonemptyString(record.reason, `${path}.reason`);
  } else if (status === "failed") {
    optionalString(record, "query", path);
    validateError(record.error, `${path}.error`);
  } else {
    optionalString(record, "query", path);
  }
}

function validateSpotifyCandidates(value: unknown, path: string): unknown[] {
  const candidates = array(value, path);
  candidates.forEach((candidate, index) => {
    const candidatePath = `${path}[${index}]`;
    const record = strictObject(candidate, candidatePath, [
      "score",
      "id",
      "uri",
      "url",
      "name",
      "artists",
      "album",
      "albumArtists",
      "releaseDate",
      "durationMs",
      "explicit",
      "isrc",
    ]);
    score1(record.score, `${candidatePath}.score`);
    nonemptyString(record.id, `${candidatePath}.id`);
    nonemptyString(record.uri, `${candidatePath}.uri`);
    optionalString(record, "url", candidatePath);
    nonemptyString(record.name, `${candidatePath}.name`);
    const artists = stringArray(record.artists, `${candidatePath}.artists`);
    if (!artists.length) invalid(`${candidatePath}.artists`, "must contain at least one artist");
    optionalString(record, "album", candidatePath);
    if (record.albumArtists !== undefined) {
      const albumArtists = stringArray(record.albumArtists, `${candidatePath}.albumArtists`);
      if (!albumArtists.length)
        invalid(`${candidatePath}.albumArtists`, "must contain at least one artist");
    }
    optionalString(record, "releaseDate", candidatePath);
    if (record.durationMs !== undefined)
      positiveInteger(record.durationMs, `${candidatePath}.durationMs`);
    if (record.explicit !== undefined) boolean(record.explicit, `${candidatePath}.explicit`);
    optionalString(record, "isrc", candidatePath);
  });
  return candidates;
}

function validateAcquisition(value: unknown, path: string): void {
  const base = object(value, path);
  const status = oneOf(
    base.status,
    ["pending", "searching", "selected", "unmatched", "downloaded", "skipped", "failed"],
    `${path}.status`,
  );
  const keys =
    status === "searching" || status === "unmatched"
      ? ["status", "query", "candidates"]
      : status === "selected"
        ? ["status", "query", "candidates", "selected"]
        : status === "downloaded"
          ? ["status", "query", "candidates", "selected", "download", "alternatives"]
          : status === "skipped"
            ? ["status", "reason"]
            : status === "failed"
              ? ["status", "query", "candidates", "error"]
              : ["status", "query"];
  const record = strictObject(value, path, keys);
  if (status === "searching" || status === "unmatched") {
    nonemptyString(record.query, `${path}.query`);
    validateCandidates(record.candidates, `${path}.candidates`);
  } else if (status === "selected") {
    nonemptyString(record.query, `${path}.query`);
    const candidates = validateCandidates(record.candidates, `${path}.candidates`);
    if (!candidates.length) invalid(`${path}.candidates`, "must contain the selected candidate");
    const selected = validateCandidate(record.selected, `${path}.selected`);
    requireCandidateMembership(candidates, selected, `${path}.selected`);
  } else if (status === "downloaded") {
    optionalString(record, "query", path);
    let candidates: ValidatedCandidate[] | undefined;
    let selected: ValidatedCandidate | undefined;
    if (record.candidates !== undefined)
      candidates = validateCandidates(record.candidates, `${path}.candidates`);
    if (record.selected !== undefined)
      selected = validateCandidate(record.selected, `${path}.selected`);
    if (candidates && selected)
      requireCandidateMembership(candidates, selected, `${path}.selected`);
    const download = validateDownload(record.download, `${path}.download`);
    const alternatives =
      record.alternatives === undefined
        ? []
        : array(record.alternatives, `${path}.alternatives`).map((item, index) =>
            validateDownload(item, `${path}.alternatives[${index}]`),
          );
    const mediaPaths = [download.mediaPath, ...alternatives.map((item) => item.mediaPath)];
    if (new Set(mediaPaths).size !== mediaPaths.length)
      invalid(`${path}.alternatives`, "must use distinct mediaPath values");
    if (selected && download.backend !== selected.backend)
      invalid(`${path}.download.backend`, "must match the selected candidate backend");
    if (selected && download.source && download.source !== selected.source)
      invalid(`${path}.download.source`, "must match the selected candidate source");
  } else if (status === "skipped") {
    nonemptyString(record.reason, `${path}.reason`);
  } else if (status === "failed") {
    optionalString(record, "query", path);
    if (record.candidates !== undefined)
      validateCandidates(record.candidates, `${path}.candidates`);
    validateError(record.error, `${path}.error`);
  } else {
    optionalString(record, "query", path);
  }
}

type ValidatedCandidate = {
  backend: AcquisitionBackend;
  id: string;
  source: string;
};

function validateCandidates(value: unknown, path: string): ValidatedCandidate[] {
  return array(value, path).map((candidate, index) =>
    validateCandidate(candidate, `${path}[${index}]`),
  );
}

function validateCandidate(value: unknown, path: string): ValidatedCandidate {
  const record = strictObject(value, path, [
    "backend",
    "id",
    "source",
    "title",
    "artist",
    "durationSeconds",
    "score",
  ]);
  const backend = oneOf(record.backend, ["slsk", "ytdlp"], `${path}.backend`);
  const id = nonemptyString(record.id, `${path}.id`);
  const source = nonemptyString(record.source, `${path}.source`);
  nonemptyString(record.title, `${path}.title`);
  optionalString(record, "artist", path);
  if (record.durationSeconds !== undefined)
    positiveNumber(record.durationSeconds, `${path}.durationSeconds`);
  if (record.score !== undefined) score1(record.score, `${path}.score`);
  return { backend, id, source };
}

function requireCandidateMembership(
  candidates: readonly ValidatedCandidate[],
  selected: ValidatedCandidate,
  path: string,
): void {
  if (
    !candidates.some(
      (candidate) =>
        candidate.backend === selected.backend &&
        candidate.id === selected.id &&
        candidate.source === selected.source,
    )
  )
    invalid(path, "must match a candidate by backend, id, and source");
}

type ValidatedDownload = {
  backend: AcquisitionDownloadBackend;
  mediaPath: string;
  source?: string;
};

function validateDownload(value: unknown, path: string): ValidatedDownload {
  const record = strictObject(value, path, [
    "backend",
    "kind",
    "mediaPath",
    "files",
    "source",
    "engine",
    "fallback",
    "sha256",
    "spotifyId",
    "isrc",
    "variantKey",
    "clip",
  ]);
  const backend = oneOf(record.backend, ["local", "slsk", "ytdlp"], `${path}.backend`);
  const kind =
    record.kind === undefined
      ? "individual"
      : oneOf(record.kind, ["individual", "source-set-clip"], `${path}.kind`);
  const mediaPath = nonemptyString(record.mediaPath, `${path}.mediaPath`);
  if (!isAbsolutePath(mediaPath)) invalid(`${path}.mediaPath`, "must be an absolute path");
  const files = stringArray(record.files, `${path}.files`);
  if (!files.length) invalid(`${path}.files`, "must contain at least one file");
  files.forEach((file, index) => {
    if (!isAbsolutePath(file)) invalid(`${path}.files[${index}]`, "must be an absolute path");
  });
  if (!files.includes(mediaPath)) invalid(`${path}.files`, "must include mediaPath");
  optionalString(record, "source", path);
  optionalString(record, "spotifyId", path);
  optionalString(record, "isrc", path);
  optionalString(record, "variantKey", path);
  if (record.engine !== undefined) oneOf(record.engine, ["native", "reference"], `${path}.engine`);
  if (record.fallback !== undefined) {
    const fallback = strictObject(record.fallback, `${path}.fallback`, ["from", "code"]);
    oneOf(fallback.from, ["native"], `${path}.fallback.from`);
    nonemptyString(fallback.code, `${path}.fallback.code`);
  }
  if (record.sha256 !== undefined) {
    const sha256 = nonemptyString(record.sha256, `${path}.sha256`);
    if (!/^[a-f\d]{64}$/iu.test(sha256))
      invalid(`${path}.sha256`, "must be 64 hexadecimal characters");
  }
  if (kind === "source-set-clip") {
    if (record.source === undefined) invalid(`${path}.source`, "is required for a source-set clip");
    validateSourceClip(record.clip, `${path}.clip`);
  } else if (record.clip !== undefined) {
    invalid(`${path}.clip`, "is only allowed for a source-set clip");
  }
  return {
    backend,
    mediaPath,
    ...(typeof record.source === "string" ? { source: record.source } : {}),
  };
}

function validateSourceClip(value: unknown, path: string): void {
  const record = strictObject(value, path, [
    "sourceSetUrl",
    "sourceSetTitle",
    "startSeconds",
    "endSeconds",
    "containsTransitions",
    "qualityNote",
  ]);
  nonemptyString(record.sourceSetUrl, `${path}.sourceSetUrl`);
  optionalString(record, "sourceSetTitle", path);
  nonnegativeNumber(record.startSeconds, `${path}.startSeconds`);
  positiveNumber(record.endSeconds, `${path}.endSeconds`);
  if (
    typeof record.startSeconds === "number" &&
    typeof record.endSeconds === "number" &&
    record.endSeconds <= record.startSeconds
  )
    invalid(`${path}.endSeconds`, "must follow startSeconds");
  boolean(record.containsTransitions, `${path}.containsTransitions`);
  nonemptyString(record.qualityNote, `${path}.qualityNote`);
}

function validateRekordbox(value: unknown, path: string): void {
  const base = object(value, path);
  const status = oneOf(
    base.status,
    ["pending", "exported", "imported", "skipped", "failed"],
    `${path}.status`,
  );
  const keys =
    status === "exported" || status === "imported"
      ? [
          "status",
          "target",
          "artifact",
          "xmlTrackId",
          "dbContentId",
          "playlistMembershipId",
          "dbContentIds",
          "playlistMembershipIds",
        ]
      : status === "skipped"
        ? ["status", "reason"]
        : status === "failed"
          ? ["status", "target", "error"]
          : ["status"];
  const record = strictObject(value, path, keys);
  if (status === "exported" || status === "imported") {
    validateTarget(record.target, `${path}.target`);
    optionalString(record, "artifact", path);
    if (record.xmlTrackId !== undefined) positiveInteger(record.xmlTrackId, `${path}.xmlTrackId`);
    optionalString(record, "dbContentId", path);
    optionalString(record, "playlistMembershipId", path);
    const dbContentIds =
      record.dbContentIds === undefined
        ? undefined
        : stringArray(record.dbContentIds, `${path}.dbContentIds`);
    const playlistMembershipIds =
      record.playlistMembershipIds === undefined
        ? undefined
        : stringArray(record.playlistMembershipIds, `${path}.playlistMembershipIds`);
    if (
      record.artifact === undefined &&
      record.xmlTrackId === undefined &&
      record.dbContentId === undefined &&
      record.playlistMembershipId === undefined &&
      record.dbContentIds === undefined &&
      record.playlistMembershipIds === undefined
    )
      invalid(path, "must include an artifact or Rekordbox identifier");
    if (status === "imported") {
      const contentId =
        record.dbContentId === undefined
          ? undefined
          : nonemptyString(record.dbContentId, `${path}.dbContentId`);
      const membershipId =
        record.playlistMembershipId === undefined
          ? undefined
          : nonemptyString(record.playlistMembershipId, `${path}.playlistMembershipId`);
      if (!contentId && !dbContentIds?.length) {
        invalid(`${path}.dbContentIds`, "must identify imported content rows");
      }
      if (!membershipId && !playlistMembershipIds?.length) {
        invalid(`${path}.playlistMembershipIds`, "must identify imported membership rows");
      }
      if (dbContentIds && !dbContentIds.length) {
        invalid(`${path}.dbContentIds`, "must not be empty when present");
      }
      if (playlistMembershipIds && !playlistMembershipIds.length) {
        invalid(`${path}.playlistMembershipIds`, "must not be empty when present");
      }
      if (dbContentIds && new Set(dbContentIds).size !== dbContentIds.length) {
        invalid(`${path}.dbContentIds`, "must contain distinct IDs");
      }
      if (
        playlistMembershipIds &&
        new Set(playlistMembershipIds).size !== playlistMembershipIds.length
      ) {
        invalid(`${path}.playlistMembershipIds`, "must contain distinct IDs");
      }
      if (
        dbContentIds &&
        playlistMembershipIds &&
        dbContentIds.length !== playlistMembershipIds.length
      ) {
        invalid(`${path}.playlistMembershipIds`, "must match dbContentIds length");
      }
      if (contentId && dbContentIds && dbContentIds[0] !== contentId) {
        invalid(`${path}.dbContentId`, "must equal the first dbContentIds value");
      }
      if (membershipId && playlistMembershipIds && playlistMembershipIds[0] !== membershipId) {
        invalid(`${path}.playlistMembershipId`, "must equal the first playlistMembershipIds value");
      }
    }
  } else if (status === "skipped") {
    nonemptyString(record.reason, `${path}.reason`);
  } else if (status === "failed") {
    if (record.target !== undefined) validateTarget(record.target, `${path}.target`);
    validateError(record.error, `${path}.error`);
  }
}

function validateTarget(value: unknown, path: string): void {
  oneOf(value, ["m3u8", "rekordbox-xml", "rekordbox-db"], path);
}

function validateArtifacts(value: unknown, path: string): void {
  const record = strictObject(value, path, [
    "root",
    "manifest",
    "downloadDirectory",
    "m3u8",
    "rekordboxXml",
    "sourceSet",
    "analysis",
    "analysisRuns",
    "rekordbox",
  ]);
  for (const key of ["root", "manifest", "downloadDirectory", "m3u8", "rekordboxXml"])
    optionalString(record, key, path);
  if (record.sourceSet !== undefined) {
    const source = strictObject(record.sourceSet, `${path}.sourceSet`, [
      "url",
      "path",
      "sha256",
      "durationSeconds",
      "codec",
      "bitrate",
    ]);
    nonemptyString(source.url, `${path}.sourceSet.url`);
    const sourcePath = nonemptyString(source.path, `${path}.sourceSet.path`);
    if (!isAbsolutePath(sourcePath)) invalid(`${path}.sourceSet.path`, "must be an absolute path");
    const sha256 = nonemptyString(source.sha256, `${path}.sourceSet.sha256`);
    if (!/^[a-f\d]{64}$/iu.test(sha256))
      invalid(`${path}.sourceSet.sha256`, "must be 64 hexadecimal characters");
    positiveNumber(source.durationSeconds, `${path}.sourceSet.durationSeconds`);
    nonemptyString(source.codec, `${path}.sourceSet.codec`);
    positiveInteger(source.bitrate, `${path}.sourceSet.bitrate`);
  }
  if (record.analysis !== undefined) {
    const mediaPaths = new Set<string>();
    const summaryPaths = new Set<string>();
    array(record.analysis, `${path}.analysis`).forEach((value, index) => {
      const itemPath = `${path}.analysis[${index}]`;
      const item = strictObject(value, itemPath, [
        "mediaPath",
        "summaryPath",
        "backend",
        "tempoBpm",
        "key",
        "keySource",
        "rhythmMode",
        "rhythmModeRequested",
        "sourceMtimeMs",
        "sourceSize",
      ]);
      const mediaPath = nonemptyString(item.mediaPath, `${itemPath}.mediaPath`);
      const summaryPath = nonemptyString(item.summaryPath, `${itemPath}.summaryPath`);
      if (!isAbsolutePath(mediaPath)) invalid(`${itemPath}.mediaPath`, "must be an absolute path");
      if (!isAbsolutePath(summaryPath))
        invalid(`${itemPath}.summaryPath`, "must be an absolute path");
      if (mediaPaths.has(mediaPath)) invalid(`${itemPath}.mediaPath`, "must be unique");
      if (summaryPaths.has(summaryPath)) invalid(`${itemPath}.summaryPath`, "must be unique");
      mediaPaths.add(mediaPath);
      summaryPaths.add(summaryPath);
      nonemptyString(item.backend, `${itemPath}.backend`);
      if (item.tempoBpm !== null) positiveNumber(item.tempoBpm, `${itemPath}.tempoBpm`);
      if (item.key !== null) nonemptyString(item.key, `${itemPath}.key`);
      if (item.keySource !== null) nonemptyString(item.keySource, `${itemPath}.keySource`);
      if (item.rhythmMode !== undefined)
        oneOf(item.rhythmMode, ["normal", "dynamic"], `${itemPath}.rhythmMode`);
      if (item.rhythmModeRequested !== undefined)
        oneOf(
          item.rhythmModeRequested,
          ["normal", "dynamic", "auto"],
          `${itemPath}.rhythmModeRequested`,
        );
      nonnegativeNumber(item.sourceMtimeMs, `${itemPath}.sourceMtimeMs`);
      positiveInteger(item.sourceSize, `${itemPath}.sourceSize`);
    });
  }
  if (record.analysisRuns !== undefined) {
    array(record.analysisRuns, `${path}.analysisRuns`).forEach((value, index) => {
      const itemPath = `${path}.analysisRuns[${index}]`;
      const item = strictObject(value, itemPath, [
        "analyzed",
        "cacheHits",
        "cancelled",
        "failed",
        "finishedAt",
        "requested",
        "startedAt",
        "status",
        "totalMs",
      ]);
      const analyzed = nonnegativeInteger(item.analyzed, `${itemPath}.analyzed`);
      const cacheHits = nonnegativeInteger(item.cacheHits, `${itemPath}.cacheHits`);
      const cancelled = nonnegativeInteger(item.cancelled, `${itemPath}.cancelled`);
      const failed = nonnegativeInteger(item.failed, `${itemPath}.failed`);
      const requested = nonnegativeInteger(item.requested, `${itemPath}.requested`);
      if (analyzed + cacheHits + cancelled + failed !== requested) {
        invalid(itemPath, "analysis counters must sum to requested");
      }
      isoTimestamp(item.startedAt, `${itemPath}.startedAt`);
      isoTimestamp(item.finishedAt, `${itemPath}.finishedAt`);
      oneOf(item.status, ["completed", "failed", "cancelled"], `${itemPath}.status`);
      nonnegativeNumber(item.totalMs, `${itemPath}.totalMs`);
    });
  }
  if (record.rekordbox !== undefined) {
    const rekordbox = strictObject(record.rekordbox, `${path}.rekordbox`, [
      "target",
      "dbPath",
      "folderName",
      "folderId",
      "playlistName",
      "playlistId",
    ]);
    literal(rekordbox.target, "rekordbox-db", `${path}.rekordbox.target`);
    const dbPath = nonemptyString(rekordbox.dbPath, `${path}.rekordbox.dbPath`);
    if (!isAbsolutePath(dbPath)) invalid(`${path}.rekordbox.dbPath`, "must be an absolute path");
    nonemptyString(rekordbox.folderName, `${path}.rekordbox.folderName`);
    nonemptyString(rekordbox.folderId, `${path}.rekordbox.folderId`);
    nonemptyString(rekordbox.playlistName, `${path}.rekordbox.playlistName`);
    nonemptyString(rekordbox.playlistId, `${path}.rekordbox.playlistId`);
  }
}

function errorArray(value: unknown, path: string): PipelineError[] {
  return array(value, path).map((error, index) => validateError(error, `${path}[${index}]`));
}

function validateError(value: unknown, path: string): PipelineError {
  const record = strictObject(value, path, ["stage", "message", "code", "retryable"]);
  const stage = oneOf(
    record.stage,
    ["manifest", "source", "tracklist", "identity", "spotify", "acquisition", "rekordbox"],
    `${path}.stage`,
  ) as PipelineStage;
  const message = nonemptyString(record.message, `${path}.message`);
  optionalString(record, "code", path);
  if (record.retryable !== undefined) boolean(record.retryable, `${path}.retryable`);
  return {
    stage,
    message,
    ...(record.code === undefined ? {} : { code: record.code as string }),
    ...(record.retryable === undefined ? {} : { retryable: record.retryable as boolean }),
  };
}

function strictObject(
  value: unknown,
  path: string,
  allowed: readonly string[],
): Record<string, unknown> {
  const record = object(value, path);
  for (const key of Object.keys(record))
    if (!allowed.includes(key)) invalid(`${path}.${key}`, "unknown property");
  return record;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid(path, "must be an object");
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) invalid(path, "must be an array");
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  return array(value, path).map((item, index) => nonemptyString(item, `${path}[${index}]`));
}

function optionalString(record: Record<string, unknown>, key: string, path: string): void {
  if (record[key] !== undefined) nonemptyString(record[key], `${path}.${key}`);
}

function nonemptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") invalid(path, "must be a non-empty string");
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") invalid(path, "must be a boolean");
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    invalid(path, "must be a positive safe integer");
  return value;
}

function nonnegativeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid(path, "must be a non-negative safe integer");
  return value;
}

function isoTimestamp(value: unknown, path: string): string {
  const timestamp = nonemptyString(value, path);
  if (!Number.isFinite(Date.parse(timestamp))) invalid(path, "must be an ISO timestamp");
  return timestamp;
}

function positiveNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    invalid(path, "must be a positive finite number");
  return value;
}

function nonnegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    invalid(path, "must be a non-negative finite number");
  return value;
}

function score1(value: unknown, path: string): number {
  const score = nonnegativeNumber(value, path);
  if (score > 1) invalid(path, "must be between 0 and 1");
  return score;
}

function score100(value: unknown, path: string): number {
  const score = nonnegativeNumber(value, path);
  if (score > 100) invalid(path, "must be between 0 and 100");
  return score;
}

function literal<const T extends string | number>(value: unknown, expected: T, path: string): T {
  if (value !== expected) invalid(path, `must equal ${JSON.stringify(expected)}`);
  return expected;
}

function oneOf<const T extends string>(value: unknown, expected: readonly T[], path: string): T {
  if (typeof value !== "string" || !expected.includes(value as T))
    invalid(path, `must be one of ${expected.join(", ")}`);
  return value as T;
}

function invalid(path: string, message: string): never {
  throw new TracksError("INVALID_SOURCE", `Invalid manifest at ${path}: ${message}`, {
    exitCode: 2,
    details: { path },
  });
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[a-z]:[\\/]/iu.test(value) || value.startsWith("\\\\");
}

function isUnidentified(track: TracklistEntry): boolean {
  const artist = track.artist?.trim();
  const title = track.title?.trim();
  return (
    track.isId === true || !artist || !title || isIdentityMarker(artist) || isIdentityMarker(title)
  );
}

function isIdentityMarker(value: string): boolean {
  return /^(?:id|\?|unknown)$/iu.test(value);
}
