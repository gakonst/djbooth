import type { QueryClient } from "@tanstack/react-query";

import type {
  LibraryMutation,
  MutationReceipt,
  PlaylistItem,
  TrackCue,
  TrackCueInput,
  TrackDetail,
  TrackMetadataInput,
  TrackSummary,
  TracksResponse,
} from "../shared/types.js";
import { normalizeTrackMetadataInput } from "../shared/track-metadata.js";

export type LibraryHistoryIdentity = "cue" | "membership" | "playlist";

export type LibraryHistoryAlias =
  | {
      identity: LibraryHistoryIdentity;
      previousId: string;
      receipt: "changedId";
    }
  | {
      identity: "membership";
      index: number;
      previousId: string;
      receipt: "membershipIds";
    };

export type LibraryHistoryMutation = {
  mutation: LibraryMutation;
  aliases?: LibraryHistoryAlias[];
};

export type LibraryHistoryEntry = LibraryHistoryMutation & {
  id: number;
  label: string;
};

export type LibraryHistoryPreparation =
  | {
      kind: "undoable";
      complete(receipt: MutationReceipt): LibraryHistoryMutation | undefined;
    }
  | { kind: "barrier" }
  | { kind: "ignore" };

export type LibraryHistoryRemap = {
  identity: LibraryHistoryIdentity;
  from: string;
  to: string;
};

/** Capture the inverse of one mutation from the last committed/optimistic cache state. */
export function prepareLibraryMutationHistory(
  queryClient: QueryClient,
  mutation: LibraryMutation,
): LibraryHistoryPreparation {
  switch (mutation.type) {
    case "create-playlist":
      return undoable((receipt) => ({
        mutation: {
          type: "delete-playlist",
          playlistId: receipt.changedId,
          expectedPlaylistIds: [receipt.changedId],
        },
      }));

    case "rename-playlist": {
      const playlist = findCachedPlaylist(queryClient, mutation.playlistId);
      if (!playlist) return barrier();
      if (playlist.name === mutation.name.trim()) return ignore();
      return undoable(() => ({
        mutation: {
          type: "rename-playlist",
          playlistId: mutation.playlistId,
          name: playlist.name,
        },
      }));
    }

    case "delete-playlist": {
      const playlist = restorableEmptyPlaylist(queryClient, mutation);
      if (!playlist) return barrier();
      const inverse: LibraryMutation = {
        type: "create-playlist",
        name: playlist.name,
        kind: playlist.type === "folder" ? "folder" : "playlist",
        seq: playlist.seq,
        ...(playlist.parentId === "root" ? {} : { parentId: playlist.parentId }),
      };
      return undoable(() => ({
        mutation: inverse,
        aliases: [
          {
            identity: "playlist",
            previousId: playlist.id,
            receipt: "changedId",
          },
        ],
      }));
    }

    case "update-track": {
      const detail = queryClient.getQueryData<TrackDetail>(["track", mutation.contentId]);
      if (!detail) return barrier();
      const metadata = metadataFromTrack(detail);
      if (metadataEqual(metadata, normalizeTrackMetadataInput(mutation.metadata))) return ignore();
      return undoable((receipt) =>
        receipt.revision
          ? {
              mutation: {
                type: "update-track",
                contentId: mutation.contentId,
                expectedRevision: receipt.revision,
                metadata,
              },
            }
          : undefined,
      );
    }

    case "set-track-color": {
      const track = findCachedTrack(queryClient, mutation.contentId);
      if (!track) return barrier();
      if (track.colorId === mutation.colorId) return ignore();
      return undoable(() => ({
        mutation: {
          type: "set-track-color",
          contentId: mutation.contentId,
          colorId: track.colorId,
        },
      }));
    }

    case "add-track":
      return undoable((receipt) => ({
        mutation: {
          type: "remove-track",
          playlistId: mutation.playlistId,
          membershipId: receipt.changedId,
        },
      }));

    case "remove-track": {
      const membership = findCachedMembership(queryClient, mutation.membershipId);
      if (!membership?.trackNumber) return barrier();
      return undoable(() => ({
        mutation: {
          type: "add-track",
          playlistId: mutation.playlistId,
          contentId: membership.id,
          trackNumber: membership.trackNumber,
        },
        aliases: [
          {
            identity: "membership",
            previousId: mutation.membershipId,
            receipt: "changedId",
          },
        ],
      }));
    }

    case "move-track": {
      const membership = findCachedMembership(queryClient, mutation.membershipId);
      if (!membership?.trackNumber) return barrier();
      if (membership.trackNumber === mutation.trackNumber) return ignore();
      return undoable(() => ({
        mutation: {
          ...mutation,
          trackNumber: membership.trackNumber!,
        },
      }));
    }

    case "replace-playlist-tracks": {
      const response = findCompletePlaylistTracks(queryClient, mutation.playlistId);
      const membershipIds = response?.items.flatMap((track) => track.playlistMembershipId ?? []);
      if (!response || response.items.length !== membershipIds?.length) return barrier();
      const contentIds = response.items.map((track) => track.id);
      if (sameStrings(contentIds, mutation.contentIds)) return ignore();
      return undoable((receipt) =>
        receipt.membershipIds?.length === mutation.contentIds.length
          ? {
              mutation: {
                type: "replace-playlist-tracks",
                playlistId: mutation.playlistId,
                contentIds,
                expectedMembershipIds: receipt.membershipIds,
              },
              aliases: membershipIds.map((previousId, index) => ({
                identity: "membership" as const,
                index,
                previousId,
                receipt: "membershipIds" as const,
              })),
            }
          : undefined,
      );
    }

    case "upsert-cue": {
      const detail = queryClient.getQueryData<TrackDetail>(["track", mutation.contentId]);
      const existing = detail ? matchingCue(detail.cues, mutation.cue) : undefined;
      if ((mutation.cue.id || mutation.cue.kind === "hot") && !detail) return barrier();
      if (mutation.cue.id && !existing) return barrier();
      if (existing) {
        const cue = cueInput(existing, true);
        if (!cue) return barrier();
        return undoable(() => ({
          mutation: { type: "upsert-cue", contentId: mutation.contentId, cue },
        }));
      }
      return undoable((receipt) => ({
        mutation: {
          type: "delete-cue",
          contentId: mutation.contentId,
          cueId: receipt.changedId,
        },
      }));
    }

    case "delete-cue": {
      const cue = queryClient
        .getQueryData<TrackDetail>(["track", mutation.contentId])
        ?.cues.find((candidate) => candidate.id === mutation.cueId);
      const input = cue ? cueInput(cue, false) : undefined;
      if (!input) return barrier();
      return undoable(() => ({
        mutation: { type: "upsert-cue", contentId: mutation.contentId, cue: input },
        aliases: [
          {
            identity: "cue",
            previousId: mutation.cueId,
            receipt: "changedId",
          },
        ],
      }));
    }
  }
}

export function libraryMutationHistoryLabel(mutation: LibraryMutation): string {
  switch (mutation.type) {
    case "create-playlist":
      return mutation.kind === "folder" ? "create folder" : "create playlist";
    case "rename-playlist":
      return "rename playlist";
    case "delete-playlist":
      return "delete playlist";
    case "update-track":
      return "edit track metadata";
    case "set-track-color":
      return "set track color";
    case "add-track":
      return "add track to playlist";
    case "remove-track":
      return "remove track from playlist";
    case "move-track":
      return "move playlist track";
    case "replace-playlist-tracks":
      return "apply playlist order";
    case "upsert-cue":
      return mutation.cue.id ? "edit cue" : "set cue";
    case "delete-cue":
      return "delete cue";
  }
}

/** Resolve identities recreated by an undo/redo mutation from its authoritative receipt. */
export function libraryHistoryIdentityRemaps(
  action: LibraryHistoryMutation,
  receipt: MutationReceipt,
): LibraryHistoryRemap[] | undefined {
  if (!action.aliases?.length) return [];
  const remaps: LibraryHistoryRemap[] = [];
  for (const alias of action.aliases) {
    const to =
      alias.receipt === "changedId" ? receipt.changedId : receipt.membershipIds?.[alias.index];
    if (!to) return undefined;
    if (alias.previousId !== to)
      remaps.push({ identity: alias.identity, from: alias.previousId, to });
  }
  return remaps;
}

/** Rewrite queued history after a recreated playlist, membership, or cue receives a new ID. */
export function remapLibraryHistoryMutation(
  action: LibraryHistoryMutation,
  remaps: readonly LibraryHistoryRemap[],
): LibraryHistoryMutation {
  if (!remaps.length) return action;
  const playlistId = (id: string) => remapIdentity("playlist", id, remaps);
  const membershipId = (id: string) => remapIdentity("membership", id, remaps);
  const cueId = (id: string) => remapIdentity("cue", id, remaps);
  const mutation = action.mutation;
  let remapped: LibraryMutation;
  switch (mutation.type) {
    case "create-playlist":
      remapped = mutation.parentId
        ? { ...mutation, parentId: playlistId(mutation.parentId) }
        : mutation;
      break;
    case "rename-playlist":
      remapped = { ...mutation, playlistId: playlistId(mutation.playlistId) };
      break;
    case "delete-playlist":
      remapped = {
        ...mutation,
        playlistId: playlistId(mutation.playlistId),
        expectedPlaylistIds: mutation.expectedPlaylistIds.map(playlistId),
      };
      break;
    case "add-track":
      remapped = { ...mutation, playlistId: playlistId(mutation.playlistId) };
      break;
    case "remove-track":
      remapped = {
        ...mutation,
        playlistId: playlistId(mutation.playlistId),
        membershipId: membershipId(mutation.membershipId),
      };
      break;
    case "move-track":
      remapped = {
        ...mutation,
        playlistId: playlistId(mutation.playlistId),
        membershipId: membershipId(mutation.membershipId),
      };
      break;
    case "replace-playlist-tracks":
      remapped = {
        ...mutation,
        playlistId: playlistId(mutation.playlistId),
        expectedMembershipIds: mutation.expectedMembershipIds.map(membershipId),
      };
      break;
    case "upsert-cue":
      remapped = {
        ...mutation,
        cue: mutation.cue.id ? { ...mutation.cue, id: cueId(mutation.cue.id) } : mutation.cue,
      };
      break;
    case "delete-cue":
      remapped = { ...mutation, cueId: cueId(mutation.cueId) };
      break;
    case "update-track":
    case "set-track-color":
      remapped = mutation;
      break;
  }
  return {
    mutation: remapped,
    ...(action.aliases
      ? {
          aliases: action.aliases.map((alias) => ({
            ...alias,
            previousId: remapIdentity(alias.identity, alias.previousId, remaps),
          })),
        }
      : {}),
  };
}

/** Advance queued metadata actions after the same track receives a new CAS revision. */
export function remapLibraryHistoryTrackRevision(
  action: LibraryHistoryMutation,
  contentId: string,
  revision: string,
): LibraryHistoryMutation {
  return action.mutation.type === "update-track" && action.mutation.contentId === contentId
    ? {
        ...action,
        mutation: { ...action.mutation, expectedRevision: revision },
      }
    : action;
}

function undoable(
  complete: (receipt: MutationReceipt) => LibraryHistoryMutation | undefined,
): LibraryHistoryPreparation {
  return { kind: "undoable", complete };
}

function barrier(): LibraryHistoryPreparation {
  return { kind: "barrier" };
}

function ignore(): LibraryHistoryPreparation {
  return { kind: "ignore" };
}

function findCachedPlaylist(queryClient: QueryClient, id: string): PlaylistItem | undefined {
  return queryClient.getQueryData<PlaylistItem[]>(["playlists"])?.find((item) => item.id === id);
}

function restorableEmptyPlaylist(
  queryClient: QueryClient,
  mutation: Extract<LibraryMutation, { type: "delete-playlist" }>,
): PlaylistItem | undefined {
  if (mutation.expectedPlaylistIds.length !== 1) return undefined;
  const playlists = queryClient.getQueryData<PlaylistItem[]>(["playlists"]);
  const playlist = playlists?.find((item) => item.id === mutation.playlistId);
  if (!playlist || playlist.type === "smart") return undefined;
  if (playlists?.some((item) => item.parentId === playlist.id)) return undefined;
  return playlist.type === "folder" || playlist.trackCount === 0 ? playlist : undefined;
}

function findCachedMembership(
  queryClient: QueryClient,
  membershipId: string,
): Pick<TrackSummary, "id" | "trackNumber"> | undefined {
  for (const [, response] of queryClient.getQueriesData<TracksResponse>({
    predicate: (query) => query.queryKey[0] === "tracks" || query.queryKey[0] === "playlist-tracks",
  })) {
    const track = response?.items.find((item) => item.playlistMembershipId === membershipId);
    if (track) return track;
  }
  return undefined;
}

function findCachedTrack(queryClient: QueryClient, id: string): TrackSummary | undefined {
  const detail = queryClient.getQueryData<TrackDetail>(["track", id]);
  if (detail) return detail;
  for (const [, response] of queryClient.getQueriesData<TracksResponse>({
    predicate: (query) => query.queryKey[0] === "tracks" || query.queryKey[0] === "playlist-tracks",
  })) {
    const track = response?.items.find((item) => item.id === id);
    if (track) return track;
  }
  return undefined;
}

function findCompletePlaylistTracks(
  queryClient: QueryClient,
  playlistId: string,
): TracksResponse | undefined {
  const canonical = queryClient.getQueryData<TracksResponse>(["playlist-tracks", playlistId]);
  if (canonical && canonical.items.length === canonical.count) return canonical;
  for (const [key, response] of queryClient.getQueriesData<TracksResponse>({
    predicate: (query) => query.queryKey[0] === "tracks",
  })) {
    const options = key[1];
    if (
      response &&
      response.items.length === response.count &&
      typeof options === "object" &&
      options !== null &&
      "playlistId" in options &&
      options.playlistId === playlistId
    )
      return response;
  }
  return undefined;
}

function metadataFromTrack(track: TrackDetail): TrackMetadataInput {
  return {
    title: track.title,
    artist: track.artist,
    album: track.album,
    genre: track.genre,
    key: track.key,
    bpm: track.bpm,
    rating: track.rating,
    comment: track.comment,
    releaseYear: track.releaseYear,
    isrc: track.isrc,
  };
}

function metadataEqual(left: TrackMetadataInput, right: TrackMetadataInput): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchingCue(cues: readonly TrackCue[], input: TrackCueInput): TrackCue | undefined {
  if (input.id) return cues.find((cue) => cue.id === input.id);
  if (input.kind === "hot")
    return cues.find((cue) => cue.kind === "hot" && cue.slot === input.slot);
  return undefined;
}

function cueInput(cue: TrackCue, preserveId: boolean): TrackCueInput | undefined {
  const common = {
    ...(preserveId ? { id: cue.id } : {}),
    type: cue.type,
    startSeconds: cue.startSeconds,
    endSeconds: cue.endSeconds,
    activeLoop: cue.activeLoop,
    comment: cue.comment,
    color: cue.color,
    colorTableIndex: cue.colorTableIndex,
  };
  if (cue.kind === "memory") return { ...common, kind: "memory" };
  return cue.slot ? { ...common, kind: "hot", slot: cue.slot } : undefined;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function remapIdentity(
  identity: LibraryHistoryIdentity,
  id: string,
  remaps: readonly LibraryHistoryRemap[],
): string {
  const byId = new Map(
    remaps.filter((remap) => remap.identity === identity).map((remap) => [remap.from, remap.to]),
  );
  let current = id;
  const visited = new Set<string>();
  while (byId.has(current) && !visited.has(current)) {
    visited.add(current);
    current = byId.get(current)!;
  }
  return current;
}
