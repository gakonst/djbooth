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

export type PlaylistItem = {
  countError?: string;
  id: string;
  name: string;
  parentId: string;
  seq: number;
  type: PlaylistKind;
  trackCount: number | null;
};

export type TrackSummary = {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  genre: string | null;
  key: string | null;
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
  source: "rekordbox" | "placeholder";
};

export type TracksResponse = {
  items: TrackSummary[];
  count: number;
  limit: number;
  offset: number;
};

export type LibraryMutation =
  | {
      type: "create-playlist";
      name: string;
      parentId?: string;
      kind?: Exclude<PlaylistKind, "smart">;
    }
  | { type: "rename-playlist"; playlistId: string; name: string }
  | { type: "delete-playlist"; playlistId: string; expectedPlaylistIds: string[] }
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
  backupDirectory: string;
  quickCheck: "ok";
  foreignKeyViolationCount: 0;
  finishedAt: string;
};

export type LibraryEvent = {
  id: number;
  type: "connected" | "mutation" | "external-change";
  emittedAt: string;
  mutation?: LibraryMutation["type"];
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
  | { type: "mutate"; mutation: LibraryMutation; label: string };

export type PromptPlan = {
  id: string;
  prompt: string;
  summary: string;
  actions: PromptAction[];
};

export type ApiError = {
  error: {
    code: string;
    message: string;
  };
};
