import type { HostedPlaylistProvider, TrackSummary } from "../shared/types.js";

export type HostedTrackResolution = {
  items: TrackSummary[];
  rejectedTrackIds: string[];
};

/** Resolve dragged row IDs to provider tracks without silently crossing provider boundaries. */
export function resolveHostedPlaylistTracks(
  trackIds: readonly string[],
  sources: readonly TrackSummary[],
  provider: HostedPlaylistProvider,
  playlistId: string,
): HostedTrackResolution {
  const sourceById = new Map(sources.map((track) => [track.id, track]));
  const items: TrackSummary[] = [];
  const rejectedTrackIds: string[] = [];
  for (const trackId of trackIds) {
    const track = sourceById.get(trackId);
    if (!track?.hosted || track.hosted.provider !== provider) {
      rejectedTrackIds.push(trackId);
      continue;
    }
    items.push(track);
  }
  return {
    items: numberHostedPlaylistTracks(items, playlistId),
    rejectedTrackIds,
  };
}

export function hostedRemoteTrackIds(
  items: readonly TrackSummary[],
  provider: HostedPlaylistProvider,
): string[] | undefined {
  const remoteTrackIds: string[] = [];
  for (const track of items) {
    if (!track.hosted || track.hosted.provider !== provider) return undefined;
    remoteTrackIds.push(track.hosted.remoteId);
  }
  return remoteTrackIds;
}

export function moveHostedPlaylistTrack(
  items: readonly TrackSummary[],
  membershipId: string,
  trackNumber: number,
  playlistId: string,
): TrackSummary[] | undefined {
  const sourceIndex = items.findIndex((track) => track.playlistMembershipId === membershipId);
  if (sourceIndex < 0) return undefined;
  const next = [...items];
  const [track] = next.splice(sourceIndex, 1);
  if (!track) return undefined;
  const targetIndex = Math.min(next.length, Math.max(0, Math.trunc(trackNumber) - 1));
  next.splice(targetIndex, 0, track);
  return numberHostedPlaylistTracks(next, playlistId);
}

export function removeHostedPlaylistTrack(
  items: readonly TrackSummary[],
  membershipId: string,
  playlistId: string,
): TrackSummary[] | undefined {
  const sourceIndex = items.findIndex((track) => track.playlistMembershipId === membershipId);
  if (sourceIndex < 0) return undefined;
  return numberHostedPlaylistTracks(
    items.filter((_, index) => index !== sourceIndex),
    playlistId,
  );
}

export function numberHostedPlaylistTracks(
  items: readonly TrackSummary[],
  playlistId: string,
): TrackSummary[] {
  return items.map((track, index) => ({
    ...track,
    playlistMembershipId: `${playlistId}:item:${String(index)}`,
    trackNumber: index + 1,
  }));
}

/** Match a provider row to a player that may have switched to its downloaded local content ID. */
export function activeTrackIndex(
  items: readonly TrackSummary[],
  activeTrackId: string | null | undefined,
): number {
  if (!activeTrackId) return -1;
  return items.findIndex(
    (track) => track.id === activeTrackId || track.hosted?.localContentId === activeTrackId,
  );
}

/** Return the local Rekordbox ID suitable for local-only edits, if one exists. */
export function localTrackContentId(track: TrackSummary): string | undefined {
  return track.hosted?.localContentId ?? (track.hosted ? undefined : track.id);
}
