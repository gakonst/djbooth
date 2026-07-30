export type LibraryStats = {
  tracks: number;
  playlists: number;
  folders: number;
  analyzed: number;
  missingAnalysis: number;
  missingBpm: number;
  missingKey: number;
};

export type LibraryProcesses = {
  rekordboxPid: number;
  rekordboxAgentPid: number;
};

export type LibraryBootstrap = {
  csrfToken: string;
  library: {
    dbPath: string;
    dbDirectory: string;
    writeEnabled: boolean;
    processes: LibraryProcesses;
    stats: LibraryStats;
  };
};

export type PlaylistKind = "playlist" | "folder" | "smart";

export type HostedPlaylistProvider = "spotify" | "soundcloud";

export type HostedPlaylistCapabilities = {
  itemsReadable: boolean;
  detailsEditable: boolean;
  itemsEditable: boolean;
};

export type HostedPlaylistSyncState = "idle" | "queued" | "syncing" | "error";

export type HostedPlaylist = {
  provider: HostedPlaylistProvider;
  /** Provider-native stable playlist ID or URN. */
  remoteId: string;
  revision: string | null;
  externalUrl: string | null;
  owned: boolean;
  capabilities: HostedPlaylistCapabilities;
  downloadEnabled: boolean;
  syncState: HostedPlaylistSyncState;
  syncError?: string;
};

export type PlaylistItem = {
  countError?: string;
  id: string;
  name: string;
  parentId: string;
  seq: number;
  type: PlaylistKind;
  trackCount: number | null;
  hosted?: HostedPlaylist;
};

export type HostedTrackDownloadState = "remote" | "queued" | "downloading" | "downloaded" | "error";

export type HostedTrackStreamKind = "hls" | "progressive";

export type HostedTrack = {
  provider: HostedPlaylistProvider;
  /** Provider-native track URI or URN. */
  remoteId: string;
  externalUrl: string | null;
  localContentId: string | null;
  downloadState: HostedTrackDownloadState;
  downloadError?: string;
  /** Provider playback transport, when it can be determined from catalog metadata. */
  streamKind?: HostedTrackStreamKind;
  /** Provider identity metadata retained for exact acquisition matching. */
  isrc?: string;
  releaseDate?: string;
  albumArtists?: string[];
  explicit?: boolean;
};

export type TrackColorId = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8";

export type TrackSummary = {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  genre: string | null;
  key: string | null;
  colorId: TrackColorId | null;
  bpm: number | null;
  durationSeconds: number | null;
  rating: number;
  playCount: number;
  analyzed: boolean;
  artworkAvailable: boolean;
  fileExists: boolean;
  path: string | null;
  playlistMembershipId?: string;
  trackNumber?: number;
  hosted?: HostedTrack;
};

export type TrackSortField =
  | "position"
  | "title"
  | "album"
  | "genre"
  | "bpm"
  | "key"
  | "plays"
  | "status"
  | "duration";

export type TrackSort = {
  field: TrackSortField;
  direction: "asc" | "desc";
};

export type HotCueSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16;

export type TrackCue = {
  id: string;
  contentId: string;
  kind: "memory" | "hot";
  type: "cue" | "loop";
  slot: HotCueSlot | null;
  startSeconds: number;
  endSeconds: number | null;
  activeLoop: boolean;
  comment: string;
  color: number | null;
  colorTableIndex: number | null;
};

type TrackCueInputCommon = {
  activeLoop?: boolean;
  color?: number | null;
  colorTableIndex?: number | null;
  comment?: string;
  endSeconds?: number | null;
  id?: string;
  startSeconds: number;
  type: "cue" | "loop";
};

export type TrackCueInput = TrackCueInputCommon &
  ({ kind: "memory"; slot?: never } | { kind: "hot"; slot: HotCueSlot });

export type TrackPlaylistMembership = {
  id: string;
  name: string;
  membershipId: string;
  trackNumber: number;
};

export type TrackDetail = TrackSummary & {
  /** Exact djmdContent.updated_at value used as the metadata compare-and-swap revision. */
  revision: string;
  comment: string | null;
  isrc: string | null;
  releaseYear: number | null;
  bitRate: number | null;
  sampleRate: number | null;
  fileSize: number | null;
  analysisPath: string | null;
  cues: TrackCue[];
  playlists: TrackPlaylistMembership[];
};

export type TrackWaveform = {
  durationSeconds: number | null;
  peaks: number[];
  /** Rekordbox RGB frequency colours, one entry per peak when colour analysis is available. */
  colors?: Array<[number, number, number]>;
  /** Native Rekordbox PQTZ beat positions. Beat 1 is the first beat of a bar. */
  beatGrid?: TrackBeatGridEntry[];
  source: "rekordbox" | "placeholder";
};

export type TrackBeatGridEntry = {
  beat: 1 | 2 | 3 | 4;
  timeSeconds: number;
};

export type TracksResponse = {
  items: TrackSummary[];
  count: number;
  limit: number;
  offset: number;
};

export type TrackMetadataInput = {
  title: string;
  artist: string | null;
  album: string | null;
  genre: string | null;
  key: string | null;
  bpm: number | null;
  rating: number;
  comment: string | null;
  releaseYear: number | null;
  isrc: string | null;
};

export type LibraryMutation =
  | {
      type: "create-playlist";
      name: string;
      parentId?: string;
      kind?: Exclude<PlaylistKind, "smart">;
      /** Exact sibling position used when undo restores an empty playlist or folder. */
      seq?: number;
    }
  | { type: "rename-playlist"; playlistId: string; name: string }
  | { type: "delete-playlist"; playlistId: string; expectedPlaylistIds: string[] }
  | { type: "set-track-color"; contentId: string; colorId: TrackColorId | null }
  | {
      type: "update-track";
      contentId: string;
      expectedRevision: string;
      metadata: TrackMetadataInput;
    }
  | { type: "add-track"; playlistId: string; contentId: string; trackNumber?: number }
  | { type: "remove-track"; playlistId: string; membershipId: string }
  | {
      type: "move-track";
      playlistId: string;
      membershipId: string;
      trackNumber: number;
    }
  | {
      type: "replace-playlist-tracks";
      playlistId: string;
      contentIds: string[];
      expectedMembershipIds: string[];
    }
  | {
      type: "upsert-cue";
      contentId: string;
      cue: TrackCueInput;
    }
  | { type: "delete-cue"; contentId: string; cueId: string };

export type MutationReceipt = {
  operation: LibraryMutation["type"];
  changedId: string;
  /** Authoritative membership order returned by a playlist replacement transaction. */
  membershipIds?: string[];
  /** Authoritative track revision returned by a content metadata, color, or cue transaction. */
  revision?: string;
  /** @deprecated Interactive mutations no longer create per-edit backups. */
  backupDirectory?: string;
  /** @deprecated Integrity checks are reserved for bulk workflows, not each interactive edit. */
  quickCheck?: "ok";
  /** @deprecated Integrity checks are reserved for bulk workflows, not each interactive edit. */
  foreignKeyViolationCount?: 0;
  finishedAt: string;
};

export type HostedPlaylistMutation =
  | {
      type: "set-hosted-playlist-download";
      playlistId: string;
      enabled: boolean;
    }
  | {
      type: "create-hosted-playlist";
      provider: HostedPlaylistProvider;
      name: string;
    }
  | {
      type: "rename-hosted-playlist";
      playlistId: string;
      name: string;
      expectedRevision: string | null;
    }
  | {
      type: "delete-hosted-playlist";
      playlistId: string;
      expectedRevision: string | null;
    }
  | {
      type: "replace-hosted-playlist-tracks";
      playlistId: string;
      remoteTrackIds: string[];
      expectedRevision: string | null;
    };

export type HostedMutationReceipt = {
  operation: HostedPlaylistMutation["type"];
  playlistId: string;
  revision: string | null;
  queuedAt: string;
};

export type HostedProviderStatus = {
  provider: HostedPlaylistProvider;
  connected: boolean;
  displayName?: string;
  error?: string;
};

export type HostedPlaylistsResponse = {
  items: PlaylistItem[];
  providers: HostedProviderStatus[];
};

export type LibraryEvent = {
  id: number;
  type:
    | "connected"
    | "mutation"
    | "external-change"
    | "hosted-mutation"
    | "hosted-job"
    | "processing-job";
  emittedAt: string;
  mutation?: LibraryMutation["type"] | HostedPlaylistMutation["type"];
  changedId?: string;
};

export type PromptContext = {
  playlistId: string | null;
  trackId: string | null;
  playheadSeconds: number | null;
};

export type PromptAction =
  | { type: "open-playlist"; playlistId: string; label: string }
  | { type: "search-tracks"; query: string; label: string }
  | { type: "show-canvas"; label: string }
  | {
      type: "process-track";
      contentId: string;
      operation: "analyze" | "stems";
      stem?: "vocals" | "instrumental" | "all";
      label: string;
    }
  | { type: "mutate"; mutation: LibraryMutation; label: string };

export type PromptPlan = {
  id: string;
  prompt: string;
  summary: string;
  actions: PromptAction[];
};

export type ProcessingJobStatus = "queued" | "running" | "completed" | "failed";

export type ProcessingJob = {
  id: string;
  contentId: string;
  trackTitle: string;
  operation: "analyze" | "stems";
  status: ProcessingJobStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  outputDirectory?: string;
  message?: string;
  error?: string;
  artifacts?: Array<{
    label: string;
    stem?: string;
    url?: string;
    path: string;
  }>;
};

export type ApiError = {
  error: {
    code: string;
    message: string;
  };
};
