export type RecognitionProvider = "description" | "1001tracklists" | "audd" | "acrcloud";
export type Environment = Record<string, string | undefined>;

export interface TrackMatch {
  /** Absolute position of the match in the source set. */
  startSeconds: number;
  /** End of the matched region in the source set, when provided. */
  endSeconds?: number;
  /** Scan window containing this match. */
  scanSeconds: number;
  artist: string;
  title: string;
  album?: string;
  label?: string;
  releaseDate?: string;
  isrc?: string;
  upc?: string;
  songLink?: string;
  confidence?: number;
  provider: "audd" | "acrcloud";
}

export interface RecognitionMoment {
  offsetSeconds: number;
  matches: TrackMatch[];
}

export interface TracklistEntry {
  order: number;
  isId?: boolean;
  timestamp?: string;
  startSeconds?: number;
  endSeconds?: number;
  artist?: string;
  title?: string;
  mix?: string;
  album?: string;
  label?: string;
  releaseDate?: string;
  isrc?: string;
  upc?: string;
  songLink?: string;
  mediaLinks?: TrackMediaLink[];
  confidence?: number;
  overlaps?: TracklistOverlap[];
}

/** One exact catalog/media identity attached to a resolved tracklist row. */
export type TrackMediaLink = {
  platform: string;
  sourceId: string;
  url: string;
  embedUrl?: string;
  durationSeconds?: number;
};

export interface TracklistOverlap {
  artist: string;
  title: string;
  confidence?: number;
}

export interface Tracklist {
  source: string;
  sourceId?: string;
  provider: RecognitionProvider;
  title?: string;
  url?: string;
  uploader?: string;
  date?: string;
  lineup?: string[];
  durationSeconds?: number;
  sampledEverySeconds?: number;
  complete: boolean;
  tracks: TracklistEntry[];
  suggestions?: DatabaseTrackSuggestion[];
  warnings?: string[];
  matches?: RecognitionMoment[];
}

export interface IdentifyOptions {
  provider?: "auto" | RecognitionProvider;
  strategy?: "enterprise" | "samples";
  preferDatabase?: boolean;
  preferDescription?: boolean;
  full?: boolean;
  every?: number;
  skip?: number;
  limit?: number;
  startSeconds?: number;
  intervalSeconds?: number;
  clipSeconds?: number;
  /** Concurrent local sample extraction/recognition calls. Defaults to 3; maximum 8. */
  concurrency?: number;
  minScore?: number;
  blendScore?: number;
  includeMatches?: boolean;
  cookies?: string;
  cookiesFromBrowser?: string;
  cacheMode?: "default" | "refresh" | "off";
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  env?: Environment;
  metadataClient?: MediaMetadataClient;
  onProgress?: (progress: IdentifyProgress) => void;
  onStageTiming?: (timing: IdentifyStageTiming) => void;
}

export interface IdentifyProgress {
  phase: "metadata" | "database" | "download" | "recognize" | "aggregate";
  current?: number;
  total?: number;
  message: string;
}

export interface IdentifyStageTiming {
  stage: "metadata" | "database-media" | "database-search" | "database-tracklist";
  outcome: "completed" | "matched" | "missed" | "failed" | "cancelled";
  durationMs: number;
}

export interface DatabaseTrack {
  order: number;
  isId?: boolean;
  positionId?: string;
  trackId?: string;
  mediaItemId?: string;
  kind?: "position" | "mashup-part";
  durationSeconds?: number;
  artist?: string | null;
  title?: string | null;
  label?: string | null;
  mix?: string | null;
  timestamp?: string | null;
  links?: Record<string, string> | string[] | null;
  media?: TrackMediaLink[];
}

export type DatabaseTrackSuggestion = {
  id: string;
  position: number;
  positionId: string;
  type: number;
  text: string;
  timestamp?: string;
  startSeconds?: number;
  submitter?: string;
};

export interface DatabaseTracklist {
  url: string;
  durationSeconds?: number;
  event: {
    name: string;
    date?: string;
    djName?: string;
    lineup: string[];
  };
  tracks: DatabaseTrack[];
  suggestions?: DatabaseTrackSuggestion[];
}

export interface TracklistSummary {
  title: string;
  url: string;
  djName?: string;
  durationSeconds?: number;
}

export interface ChartTrack {
  name: string;
  url: string;
  rank?: number;
}

export interface LatestTracklists {
  items: TracklistSummary[];
}

export interface SearchTracklists {
  items: TracklistSummary[];
}

export interface ChartTracks {
  chart: string;
  items: ChartTrack[];
}

export type FindTracklistResult = { found: false } | ({ found: true } & DatabaseTracklist);
import type { MediaMetadataClient } from "./integrations/ytdlp.js";
