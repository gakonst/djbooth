import { queryOptions, type QueryClient } from "@tanstack/react-query";

import type { LibraryEvent, TracksResponse } from "../shared/types.js";
import { getAllTracks, getTrackWaveform } from "./api.js";

type DeferredLibraryEventRefreshOptions = {
  flush(events: readonly LibraryEvent[]): void;
  isBlocked(): boolean;
  notBefore(): number;
};

/** Coalesce events hidden by a local write and refresh once when its suppression window ends. */
export class DeferredLibraryEventRefresh {
  private externalChange: LibraryEvent | undefined;
  private readonly mutations = new Map<string, LibraryEvent>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: DeferredLibraryEventRefreshOptions) {}

  defer(event: LibraryEvent): void {
    if (event.type === "connected") return;
    if (event.type === "external-change") {
      this.externalChange = event;
      this.mutations.clear();
    } else if (!this.externalChange) {
      this.mutations.set(`${event.mutation ?? ""}\u0000${event.changedId ?? ""}`, event);
    }
    this.stateChanged();
  }

  /** Re-evaluate queued events after pending-write or suppression-deadline state changes. */
  stateChanged(): void {
    if (!this.hasEvents()) return;
    this.cancelTimer();
    if (this.options.isBlocked()) return;
    const delay = Math.max(0, this.options.notBefore() - Date.now());
    if (delay > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.stateChanged();
      }, delay);
      return;
    }
    const events = this.externalChange ? [this.externalChange] : [...this.mutations.values()];
    this.externalChange = undefined;
    this.mutations.clear();
    this.options.flush(events);
  }

  dispose(): void {
    this.cancelTimer();
    this.externalChange = undefined;
    this.mutations.clear();
  }

  private hasEvents(): boolean {
    return this.externalChange !== undefined || this.mutations.size > 0;
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

export const playlistTracksKey = (playlistId: string | undefined) =>
  ["playlist-tracks", playlistId] as const;

export function playlistTracksQueryOptions(playlistId: string | undefined) {
  return queryOptions({
    queryKey: playlistTracksKey(playlistId),
    queryFn: ({ signal }) => {
      if (!playlistId) throw new Error("A playlist is required to load its tracks");
      return getAllTracks({ playlistId, filter: "all" }, signal);
    },
  });
}

export const trackWaveformKey = (trackId: string) => ["track-waveform", trackId] as const;

export function trackWaveformQueryOptions(trackId: string) {
  return queryOptions({
    queryKey: trackWaveformKey(trackId),
    queryFn: ({ signal }) => getTrackWaveform(trackId, signal),
    staleTime: (query) =>
      query.state.data?.source === "placeholder" ? 5_000 : Number.POSITIVE_INFINITY,
    // Analysis files can appear without a master.db write. Poll only active placeholders and stop
    // permanently as soon as Rekordbox peaks become available.
    refetchInterval: (query) => (query.state.data?.source === "placeholder" ? 5_000 : false),
  });
}

/** Mark committed track details and full-playlist snapshots stale without clearing visible data. */
export function invalidateAuthoritativeTrackQueries(
  queryClient: QueryClient,
  trackIds: ReadonlySet<string>,
): Promise<void> {
  if (!trackIds.size) return Promise.resolve();
  return queryClient.invalidateQueries({
    predicate: (query) => {
      if (query.queryKey[0] === "track") return trackIds.has(String(query.queryKey[1]));
      if (query.queryKey[0] !== "playlist-tracks") return false;
      const response = query.state.data as TracksResponse | undefined;
      return response?.items.some((track) => trackIds.has(track.id)) ?? false;
    },
    refetchType: "active",
  });
}

/** Mark only canonical full-playlist snapshots stale after an incomplete optimistic projection. */
export function invalidateCanonicalPlaylistQueries(
  queryClient: QueryClient,
  playlistIds: ReadonlySet<string>,
): Promise<void> {
  if (!playlistIds.size) return Promise.resolve();
  return queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === "playlist-tracks" && playlistIds.has(String(query.queryKey[1])),
    refetchType: "active",
  });
}
