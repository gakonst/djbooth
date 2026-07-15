import type {
  HostedPlaylistMutation,
  HostedPlaylistProvider,
  HostedPlaylistSyncState,
  HostedTrackDownloadState,
  PlaylistItem,
  TrackSummary,
} from "../../shared/types.js";

export type Awaitable<T> = T | Promise<T>;

export type HostedAdapterListResult = {
  displayName?: string;
  items: PlaylistItem[];
};

export interface HostedPlaylistProviderAdapter {
  readonly provider: HostedPlaylistProvider;
  listPlaylists(): Promise<HostedAdapterListResult>;
  getTracks(remotePlaylistId: string): Promise<TrackSummary[]>;
  createPlaylist(name: string): Promise<PlaylistItem>;
  renamePlaylist(
    remotePlaylistId: string,
    name: string,
    expectedRevision: string | null,
  ): Promise<PlaylistItem>;
  replacePlaylistTracks(
    remotePlaylistId: string,
    remoteTrackIds: readonly string[],
    expectedRevision: string | null,
  ): Promise<PlaylistItem>;
  deletePlaylist(remotePlaylistId: string, expectedRevision: string | null): Promise<void>;
  streamTrack?(remoteTrackId: string): Promise<Response>;
}

export type HostedPlaylistStoredState = {
  provider: HostedPlaylistProvider;
  remoteId: string;
  downloadEnabled: boolean;
  revision: string | null;
  syncState: HostedPlaylistSyncState;
  syncError: string | null;
};

export type HostedTrackStoredState = {
  provider: HostedPlaylistProvider;
  remoteTrackId: string;
  localContentId: string | null;
  downloadState: HostedTrackDownloadState;
  downloadError: string | null;
};

/** Structural subset implemented by HostedPlaylistStateStore. */
export interface HostedPlaylistStateReaderWriter {
  listPlaylists?(): Awaitable<HostedPlaylistStoredState[]>;
  getPlaylist(
    provider: HostedPlaylistProvider,
    remoteId: string,
  ): Awaitable<HostedPlaylistStoredState | undefined>;
  setDownloadEnabled(
    provider: HostedPlaylistProvider,
    remoteId: string,
    enabled: boolean,
  ): Awaitable<HostedPlaylistStoredState>;
  updatePlaylistSync(
    provider: HostedPlaylistProvider,
    remoteId: string,
    input: {
      revision?: string | null;
      state?: HostedPlaylistSyncState;
      error?: string | null;
    },
  ): Awaitable<HostedPlaylistStoredState>;
  getTrack(
    provider: HostedPlaylistProvider,
    remoteTrackId: string,
  ): Awaitable<HostedTrackStoredState | undefined>;
  listTracks?(provider: HostedPlaylistProvider): Awaitable<HostedTrackStoredState[]>;
}

export type HostedMutationWithoutDownload = Exclude<
  HostedPlaylistMutation,
  { type: "set-hosted-playlist-download" }
>;

export class HostedPlaylistConflictError extends Error {
  readonly playlistId: string;
  readonly expectedRevision: string | null;
  readonly actualRevision: string | null;

  constructor(options: {
    playlistId: string;
    expectedRevision: string | null;
    actualRevision: string | null;
  }) {
    super(
      `Hosted playlist ${options.playlistId} changed remotely (expected ${formatRevision(options.expectedRevision)}, got ${formatRevision(options.actualRevision)})`,
    );
    this.name = "HostedPlaylistConflictError";
    this.playlistId = options.playlistId;
    this.expectedRevision = options.expectedRevision;
    this.actualRevision = options.actualRevision;
  }
}

export class HostedPlaylistCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedPlaylistCapabilityError";
  }
}

export class HostedPlaylistVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedPlaylistVerificationError";
  }
}

export function assertExpectedRevision(
  playlistId: string,
  expectedRevision: string | null,
  actualRevision: string | null,
): void {
  if (expectedRevision === actualRevision) return;
  throw new HostedPlaylistConflictError({
    playlistId,
    expectedRevision,
    actualRevision,
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return "status" in error && (error as { status?: unknown }).status === 404;
}

function formatRevision(revision: string | null): string {
  return revision === null ? "no revision" : revision;
}
