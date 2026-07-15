import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  libraryHistoryIdentityRemaps,
  prepareLibraryMutationHistory,
  remapLibraryHistoryMutation,
  remapLibraryHistoryTrackRevision,
  type LibraryHistoryMutation,
  type LibraryHistoryPreparation,
} from "../src/client/library-history.js";
import type {
  LibraryMutation,
  MutationReceipt,
  PlaylistItem,
  TrackDetail,
  TrackSummary,
  TracksResponse,
} from "../src/shared/types.js";

describe("library mutation history", () => {
  it("undoes creation and remaps later history when redo recreates a playlist", () => {
    const queryClient = seededClient();
    const create: LibraryMutation = { type: "create-playlist", name: "New set" };
    const removeCreated = complete(
      prepareLibraryMutationHistory(queryClient, create),
      receipt("create-playlist", "playlist-new"),
    );
    expect(removeCreated.mutation).toEqual({
      type: "delete-playlist",
      playlistId: "playlist-new",
      expectedPlaylistIds: ["playlist-new"],
    });

    queryClient.setQueryData<PlaylistItem[]>(["playlists"], (items) => [
      ...(items ?? []),
      {
        id: "playlist-new",
        name: "New set",
        parentId: "root",
        seq: 2,
        type: "playlist",
        trackCount: 0,
      },
    ]);
    const recreate = complete(
      prepareLibraryMutationHistory(queryClient, removeCreated.mutation),
      receipt("delete-playlist", "playlist-new"),
    );
    expect(recreate.mutation).toEqual({
      type: "create-playlist",
      name: "New set",
      kind: "playlist",
      seq: 2,
    });

    const remaps = libraryHistoryIdentityRemaps(
      recreate,
      receipt("create-playlist", "playlist-recreated"),
    );
    expect(remaps).toEqual([
      { identity: "playlist", from: "playlist-new", to: "playlist-recreated" },
    ]);
    expect(
      remapLibraryHistoryMutation(
        {
          mutation: {
            type: "add-track",
            playlistId: "playlist-new",
            contentId: "track-1",
          },
        },
        remaps!,
      ).mutation,
    ).toMatchObject({ playlistId: "playlist-recreated" });
  });

  it("restores removed memberships at their old position and remaps dependent moves", () => {
    const queryClient = seededClient();
    const restore = complete(
      prepareLibraryMutationHistory(queryClient, {
        type: "remove-track",
        playlistId: "playlist",
        membershipId: "membership-1",
      }),
      receipt("remove-track", "membership-1"),
    );
    expect(restore.mutation).toEqual({
      type: "add-track",
      playlistId: "playlist",
      contentId: "track-1",
      trackNumber: 1,
    });

    const remaps = libraryHistoryIdentityRemaps(
      restore,
      receipt("add-track", "membership-restored"),
    );
    const move: LibraryHistoryMutation = {
      mutation: {
        type: "move-track",
        playlistId: "playlist",
        membershipId: "membership-1",
        trackNumber: 2,
      },
    };
    expect(remapLibraryHistoryMutation(move, remaps!).mutation).toMatchObject({
      membershipId: "membership-restored",
    });
  });

  it("uses committed revisions for metadata undo and preserves playlist replacement identities", () => {
    const queryClient = seededClient();
    const metadataUndo = complete(
      prepareLibraryMutationHistory(queryClient, {
        type: "update-track",
        contentId: "track-1",
        expectedRevision: "revision-1",
        metadata: {
          ...metadata(detail()),
          title: "Renamed",
        },
      }),
      { ...receipt("update-track", "track-1"), revision: "revision-2" },
    );
    expect(metadataUndo.mutation).toMatchObject({
      type: "update-track",
      expectedRevision: "revision-2",
      metadata: { title: "Track one" },
    });
    expect(
      remapLibraryHistoryTrackRevision(metadataUndo, "track-1", "revision-4").mutation,
    ).toMatchObject({
      type: "update-track",
      expectedRevision: "revision-4",
    });

    const replaceUndo = complete(
      prepareLibraryMutationHistory(queryClient, {
        type: "replace-playlist-tracks",
        playlistId: "playlist",
        contentIds: ["track-2", "track-3"],
        expectedMembershipIds: ["membership-1", "membership-2"],
      }),
      {
        ...receipt("replace-playlist-tracks", "playlist"),
        membershipIds: ["membership-2", "membership-3"],
      },
    );
    expect(replaceUndo.mutation).toEqual({
      type: "replace-playlist-tracks",
      playlistId: "playlist",
      contentIds: ["track-1", "track-2"],
      expectedMembershipIds: ["membership-2", "membership-3"],
    });
    expect(
      libraryHistoryIdentityRemaps(replaceUndo, {
        ...receipt("replace-playlist-tracks", "playlist"),
        membershipIds: ["membership-1-restored", "membership-2"],
      }),
    ).toContainEqual({
      identity: "membership",
      from: "membership-1",
      to: "membership-1-restored",
    });
  });

  it("restores deleted cues with a remapped ID and barriers populated playlist deletion", () => {
    const queryClient = seededClient();
    const restoreCue = complete(
      prepareLibraryMutationHistory(queryClient, {
        type: "delete-cue",
        contentId: "track-1",
        cueId: "cue-1",
      }),
      receipt("delete-cue", "cue-1"),
    );
    expect(restoreCue.mutation).toMatchObject({
      type: "upsert-cue",
      cue: { kind: "memory", startSeconds: 12, comment: "Intro" },
    });
    expect((restoreCue.mutation as Extract<LibraryMutation, { type: "upsert-cue" }>).cue.id).toBe(
      undefined,
    );
    expect(libraryHistoryIdentityRemaps(restoreCue, receipt("upsert-cue", "cue-restored"))).toEqual(
      [{ identity: "cue", from: "cue-1", to: "cue-restored" }],
    );

    expect(
      prepareLibraryMutationHistory(queryClient, {
        type: "delete-playlist",
        playlistId: "playlist",
        expectedPlaylistIds: ["playlist"],
      }).kind,
    ).toBe("barrier");
  });
});

function complete(
  preparation: LibraryHistoryPreparation,
  mutationReceipt: MutationReceipt,
): LibraryHistoryMutation {
  expect(preparation.kind).toBe("undoable");
  if (preparation.kind !== "undoable") throw new Error("Expected undoable mutation");
  const result = preparation.complete(mutationReceipt);
  expect(result).toBeDefined();
  return result!;
}

function seededClient(): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData<PlaylistItem[]>(
    ["playlists"],
    [
      {
        id: "playlist",
        name: "Working set",
        parentId: "root",
        seq: 1,
        type: "playlist",
        trackCount: 2,
      },
    ],
  );
  queryClient.setQueryData<TrackDetail>(["track", "track-1"], detail());
  const response: TracksResponse = {
    items: [
      { ...track("track-1", "Track one"), playlistMembershipId: "membership-1", trackNumber: 1 },
      { ...track("track-2", "Track two"), playlistMembershipId: "membership-2", trackNumber: 2 },
    ],
    count: 2,
    limit: 2,
    offset: 0,
  };
  queryClient.setQueryData(["playlist-tracks", "playlist"], response);
  return queryClient;
}

function detail(): TrackDetail {
  return {
    ...track("track-1", "Track one"),
    revision: "revision-1",
    comment: "Original",
    isrc: "US-AAA-26-00001",
    releaseYear: 2026,
    bitRate: 320,
    sampleRate: 44_100,
    fileSize: 1_000,
    analysisPath: null,
    cues: [
      {
        id: "cue-1",
        contentId: "track-1",
        kind: "memory",
        type: "cue",
        slot: null,
        startSeconds: 12,
        endSeconds: null,
        activeLoop: false,
        comment: "Intro",
        color: null,
        colorTableIndex: null,
      },
    ],
    playlists: [
      {
        id: "playlist",
        name: "Working set",
        membershipId: "membership-1",
        trackNumber: 1,
      },
    ],
  };
}

function metadata(trackDetail: TrackDetail) {
  return {
    title: trackDetail.title,
    artist: trackDetail.artist,
    album: trackDetail.album,
    genre: trackDetail.genre,
    key: trackDetail.key,
    bpm: trackDetail.bpm,
    rating: trackDetail.rating,
    comment: trackDetail.comment,
    releaseYear: trackDetail.releaseYear,
    isrc: trackDetail.isrc,
  };
}

function track(id: string, title: string): TrackSummary {
  return {
    id,
    title,
    artist: "Artist",
    album: "Album",
    genre: "House",
    key: "Am",
    colorId: null,
    bpm: 124,
    durationSeconds: 180,
    rating: 3,
    playCount: 1,
    analyzed: true,
    artworkAvailable: false,
    fileExists: true,
    path: `/music/${id}.flac`,
  };
}

function receipt(operation: LibraryMutation["type"], changedId: string): MutationReceipt {
  return {
    operation,
    changedId,
    finishedAt: "2026-07-14T00:00:00.000Z",
  };
}
