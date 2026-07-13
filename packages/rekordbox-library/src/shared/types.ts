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
  fileExists: boolean;
  path: string | null;
  playlistMembershipId?: string;
  trackNumber?: number;
};

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
  playlists: TrackPlaylistMembership[];
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
  | { type: "delete-playlist"; playlistId: string }
  | { type: "add-track"; playlistId: string; contentId: string; trackNumber?: number }
  | { type: "remove-track"; playlistId: string; membershipId: string }
  | {
      type: "move-track";
      playlistId: string;
      membershipId: string;
      trackNumber: number;
    };

export type MutationReceipt = {
  operation: LibraryMutation["type"];
  changedId: string;
  backupDirectory: string;
  quickCheck: "ok";
  foreignKeyViolationCount: 0;
  finishedAt: string;
};

export type ApiError = {
  error: {
    code: string;
    message: string;
  };
};
