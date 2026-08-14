export type RecognitionProvider = "description" | "agent" | "audd" | "acrcloud";
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
  genre?: string;
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
  genre?: string;
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
  suggestions?: TracklistSuggestion[];
  warnings?: string[];
  matches?: RecognitionMoment[];
}

export interface IdentifyOptions {
  provider?: "auto" | RecognitionProvider;
  strategy?: "enterprise" | "samples";
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
  phase: "metadata" | "download" | "recognize" | "aggregate";
  current?: number;
  total?: number;
  message: string;
}

export interface IdentifyStageTiming {
  stage: "metadata";
  outcome: "completed" | "failed" | "cancelled";
  durationMs: number;
}

export type TracklistSuggestion = {
  id: string;
  position: number;
  positionId: string;
  type: number;
  text: string;
  timestamp?: string;
  startSeconds?: number;
  submitter?: string;
};
import type { MediaMetadataClient } from "./integrations/ytdlp.js";
