import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type {
  LibraryBootstrap,
  MutationReceipt,
  PlaylistItem,
  TrackDetail,
  TrackSummary,
  TracksResponse,
} from "../src/shared/types.js";
import {
  applyOptimisticLibraryMutation,
  captureLibraryCache,
  reconcileOptimisticLibraryMutation,
  resolveOptimisticMutationIds,
  restoreLibraryCache,
} from "../src/client/optimistic-library.js";

const playlist: PlaylistItem = {
  id: "playlist",
  name: "Working set",
  parentId: "root",
  seq: 1,
  type: "playlist",
  trackCount: 2,
};

describe("optimistic library cache", () => {
  it("creates, reconciles, renames, deletes, and rolls back playlists synchronously", () => {
    const queryClient = seededClient();
    const snapshot = captureLibraryCache(queryClient);
    const created = applyOptimisticLibraryMutation(queryClient, {
      type: "create-playlist",
      name: "  New set  ",
    });
    const temporaryId = created.temporaryPlaylistId!;

    expect(queryClient.getQueryData<PlaylistItem[]>(["playlists"])?.at(-1)).toMatchObject({
      id: temporaryId,
      name: "New set",
      trackCount: 0,
    });
    expect(queryClient.getQueryData<LibraryBootstrap>(["bootstrap"])?.library.stats.playlists).toBe(
      2,
    );

    reconcileOptimisticLibraryMutation(queryClient, created, receipt("create-playlist", "real"));
    expect(queryClient.getQueryData<PlaylistItem[]>(["playlists"])?.at(-1)?.id).toBe("real");

    applyOptimisticLibraryMutation(queryClient, {
      type: "rename-playlist",
      playlistId: "real",
      name: "Renamed",
    });
    expect(
      queryClient.getQueryData<PlaylistItem[]>(["playlists"])?.find((item) => item.id === "real")
        ?.name,
    ).toBe("Renamed");

    applyOptimisticLibraryMutation(queryClient, {
      type: "delete-playlist",
      playlistId: "real",
      expectedPlaylistIds: ["real"],
    });
    expect(queryClient.getQueryData<PlaylistItem[]>(["playlists"])).toEqual([playlist]);

    restoreLibraryCache(queryClient, snapshot);
    expect(queryClient.getQueryData<PlaylistItem[]>(["playlists"])).toEqual([playlist]);
    expect(queryClient.getQueryData<LibraryBootstrap>(["bootstrap"])?.library.stats.playlists).toBe(
      1,
    );
  });

  it("keeps cached track playlist memberships aligned with rename and deletion", () => {
    const queryClient = seededClient();

    applyOptimisticLibraryMutation(queryClient, {
      type: "rename-playlist",
      playlistId: playlist.id,
      name: "Renamed set",
    });
    expect(queryClient.getQueryData<TrackDetail>(["track", "1"])?.playlists[0]?.name).toBe(
      "Renamed set",
    );

    applyOptimisticLibraryMutation(queryClient, {
      type: "delete-playlist",
      playlistId: playlist.id,
      expectedPlaylistIds: [playlist.id],
    });
    expect(queryClient.getQueryData<TrackDetail>(["track", "1"])?.playlists).toEqual([]);
  });

  it("adds, reconciles, moves, removes, and replaces memberships without waiting for SQLite", () => {
    const queryClient = seededClient();
    const third = track("3", "Three");
    queryClient.setQueryData<TrackDetail>(["track", third.id], detail(third));

    const added = applyOptimisticLibraryMutation(queryClient, {
      type: "add-track",
      playlistId: playlist.id,
      contentId: third.id,
    });
    const temporaryMembershipId = added.temporaryMembershipId!;
    expect(editor(queryClient).items.map((item) => item.title)).toEqual(["One", "Two", "Three"]);
    expect(editor(queryClient).items[2]?.playlistMembershipId).toBe(temporaryMembershipId);
    expect(queryClient.getQueryData<PlaylistItem[]>(["playlists"])?.[0]?.trackCount).toBe(3);

    reconcileOptimisticLibraryMutation(queryClient, added, receipt("add-track", "membership-3"));
    expect(editor(queryClient).items[2]?.playlistMembershipId).toBe("membership-3");

    applyOptimisticLibraryMutation(queryClient, {
      type: "move-track",
      playlistId: playlist.id,
      membershipId: "membership-3",
      trackNumber: 1,
    });
    expect(editor(queryClient).items.map((item) => item.title)).toEqual(["Three", "One", "Two"]);

    applyOptimisticLibraryMutation(queryClient, {
      type: "remove-track",
      playlistId: playlist.id,
      membershipId: "membership-1",
    });
    expect(editor(queryClient).items.map((item) => item.title)).toEqual(["Three", "Two"]);
    expect(queryClient.getQueryData<PlaylistItem[]>(["playlists"])?.[0]?.trackCount).toBe(2);

    applyOptimisticLibraryMutation(queryClient, {
      type: "replace-playlist-tracks",
      playlistId: playlist.id,
      contentIds: ["2", "3"],
      expectedMembershipIds: ["membership-3", "membership-2"],
    });
    expect(editor(queryClient).items.map((item) => [item.id, item.trackNumber])).toEqual([
      ["2", 1],
      ["3", 2],
    ]);
  });

  it("updates cues immediately and reconciles temporary cue IDs", () => {
    const queryClient = seededClient();
    const optimistic = applyOptimisticLibraryMutation(queryClient, {
      type: "upsert-cue",
      contentId: "1",
      cue: { kind: "hot", slot: 1, type: "cue", startSeconds: 12.5, comment: "Drop" },
    });

    expect(queryClient.getQueryData<TrackDetail>(["track", "1"])?.cues[0]).toMatchObject({
      id: optimistic.optimisticCueId,
      slot: 1,
      startSeconds: 12.5,
    });
    reconcileOptimisticLibraryMutation(queryClient, optimistic, receipt("upsert-cue", "cue-real"));
    expect(queryClient.getQueryData<TrackDetail>(["track", "1"])?.cues[0]?.id).toBe("cue-real");

    applyOptimisticLibraryMutation(queryClient, {
      type: "delete-cue",
      contentId: "1",
      cueId: "cue-real",
    });
    expect(queryClient.getQueryData<TrackDetail>(["track", "1"])?.cues).toEqual([]);
  });

  it("normalizes track metadata immediately and schedules authoritative revalidation", () => {
    const queryClient = seededClient();
    const browserKey = [
      "tracks",
      { query: "one", filter: "all", offset: 0, sort: { field: "title", direction: "asc" } },
    ] as const;
    queryClient.setQueryData<TracksResponse>(browserKey, editor(queryClient));

    const optimistic = applyOptimisticLibraryMutation(queryClient, {
      type: "update-track",
      contentId: "1",
      expectedRevision: "2026-07-12 12:00:00.000 +00:00",
      metadata: {
        title: "  Renamed  ",
        artist: "  Another artist  ",
        album: "   ",
        genre: "  House ",
        key: "  F minor ",
        bpm: 124.567,
        rating: 4,
        comment: "  Peak-time  ",
        releaseYear: 2026,
        isrc: "  US-ABC-26-00001  ",
      },
    });

    expect(optimistic.revalidateTrackId).toBe("1");
    expect(queryClient.getQueryData<TracksResponse>(browserKey)?.items[0]).toMatchObject({
      title: "Renamed",
      artist: "Another artist",
      album: null,
      genre: "House",
      key: "F minor",
      bpm: 124.57,
      rating: 4,
    });
    expect(editor(queryClient).items[0]).toMatchObject({ title: "Renamed", genre: "House" });
    expect(queryClient.getQueryData<TrackDetail>(["track", "1"])).toMatchObject({
      title: "Renamed",
      comment: "Peak-time",
      releaseYear: 2026,
      isrc: "US-ABC-26-00001",
    });

    const committedRevision = "2026-07-12 12:00:01.000 +00:00";
    reconcileOptimisticLibraryMutation(queryClient, optimistic, {
      ...receipt("update-track", "1"),
      revision: committedRevision,
    });
    expect(queryClient.getQueryData<TrackDetail>(["track", "1"])?.revision).toBe(committedRevision);

    if (optimistic.mutation.type !== "update-track") throw new Error("Expected track update");
    const next = resolveOptimisticMutationIds(
      {
        ...optimistic.mutation,
        expectedRevision: "2026-07-12 12:00:00.000 +00:00",
      },
      {
        playlists: new Map(),
        memberships: new Map(),
        cues: new Map(),
        trackRevisions: new Map([["1", committedRevision]]),
      },
    );
    expect(next).toMatchObject({ type: "update-track", expectedRevision: committedRevision });
  });

  it("keeps unknown replacement tracks ordered until the canonical snapshot revalidates", () => {
    const queryClient = seededClient();
    const optimistic = applyOptimisticLibraryMutation(queryClient, {
      type: "replace-playlist-tracks",
      playlistId: playlist.id,
      contentIds: ["1", "not-cached"],
      expectedMembershipIds: ["membership-1", "membership-2"],
    });

    expect(editor(queryClient).items.map((track) => track.id)).toEqual(["1", "not-cached"]);
    expect(editor(queryClient).count).toBe(2);
    expect(optimistic.replacementMembershipIds).toHaveLength(2);
    expect(optimistic.revalidateCanonicalPlaylistId).toBe(playlist.id);

    const reconciled = reconcileOptimisticLibraryMutation(
      queryClient,
      optimistic,
      receipt("replace-playlist-tracks", playlist.id, ["membership-1", "membership-new"]),
    );
    expect(editor(queryClient).items[1]?.playlistMembershipId).toBe("membership-new");
    expect(reconciled.membershipIds).toContainEqual([
      optimistic.replacementMembershipIds![1],
      "membership-new",
    ]);
  });

  it("resolves optimistic IDs before dependent background commits", () => {
    const resolved = resolveOptimisticMutationIds(
      {
        type: "move-track",
        playlistId: "optimistic-playlist:one",
        membershipId: "optimistic-membership:one",
        trackNumber: 2,
      },
      {
        playlists: new Map([["optimistic-playlist:one", "playlist-real"]]),
        memberships: new Map([["optimistic-membership:one", "membership-real"]]),
        cues: new Map(),
      },
    );
    expect(resolved).toEqual({
      type: "move-track",
      playlistId: "playlist-real",
      membershipId: "membership-real",
      trackNumber: 2,
    });
  });

  it("reconciles replacement membership IDs for the next queued playlist write", () => {
    const queryClient = seededClient();
    const third = track("3", "Three");
    queryClient.setQueryData<TrackDetail>(["track", third.id], detail(third));
    const optimistic = applyOptimisticLibraryMutation(queryClient, {
      type: "replace-playlist-tracks",
      playlistId: playlist.id,
      contentIds: ["1", "3"],
      expectedMembershipIds: ["membership-1", "membership-2"],
    });
    const temporaryId = optimistic.replacementMembershipIds?.[1];
    expect(temporaryId).toMatch(/^optimistic-membership:/u);

    const reconciled = reconcileOptimisticLibraryMutation(
      queryClient,
      optimistic,
      receipt("replace-playlist-tracks", playlist.id, ["membership-1", "membership-3"]),
    );
    expect(editor(queryClient).items.map((item) => item.playlistMembershipId)).toEqual([
      "membership-1",
      "membership-3",
    ]);

    const resolved = resolveOptimisticMutationIds(
      {
        type: "replace-playlist-tracks",
        playlistId: playlist.id,
        contentIds: ["3", "1"],
        expectedMembershipIds: [temporaryId!, "membership-1"],
      },
      {
        playlists: new Map(),
        memberships: new Map(reconciled.membershipIds),
        cues: new Map(),
      },
    );
    expect(resolved).toMatchObject({
      expectedMembershipIds: ["membership-3", "membership-1"],
    });
  });
});

function seededClient(): QueryClient {
  const queryClient = new QueryClient();
  const one = { ...track("1", "One"), playlistMembershipId: "membership-1", trackNumber: 1 };
  const two = { ...track("2", "Two"), playlistMembershipId: "membership-2", trackNumber: 2 };
  const response: TracksResponse = { items: [one, two], count: 2, limit: 2, offset: 0 };
  queryClient.setQueryData(["bootstrap"], bootstrap());
  queryClient.setQueryData(["playlists"], [playlist]);
  queryClient.setQueryData(["playlist-tracks", playlist.id], response);
  queryClient.setQueryData(
    ["track", one.id],
    detail(one, [
      { id: playlist.id, name: playlist.name, membershipId: "membership-1", trackNumber: 1 },
    ]),
  );
  queryClient.setQueryData(
    ["track", two.id],
    detail(two, [
      { id: playlist.id, name: playlist.name, membershipId: "membership-2", trackNumber: 2 },
    ]),
  );
  return queryClient;
}

function track(id: string, title: string): TrackSummary {
  return {
    id,
    title,
    artist: "Artist",
    album: null,
    genre: null,
    key: null,
    bpm: null,
    durationSeconds: 180,
    rating: 0,
    playCount: 0,
    analyzed: true,
    artworkAvailable: false,
    fileExists: true,
    path: `/music/${id}.m4a`,
  };
}

function detail(summary: TrackSummary, playlists: TrackDetail["playlists"] = []): TrackDetail {
  return {
    ...summary,
    revision: "2026-07-12 12:00:00.000 +00:00",
    comment: null,
    isrc: null,
    releaseYear: null,
    bitRate: null,
    sampleRate: null,
    fileSize: null,
    analysisPath: null,
    cues: [],
    playlists,
  };
}

function editor(queryClient: QueryClient): TracksResponse {
  return queryClient.getQueryData<TracksResponse>(["playlist-tracks", playlist.id])!;
}

function receipt(
  operation: MutationReceipt["operation"],
  changedId: string,
  membershipIds?: string[],
): MutationReceipt {
  return {
    operation,
    changedId,
    finishedAt: "2026-07-13T00:00:00.000Z",
    ...(membershipIds ? { membershipIds } : {}),
  };
}

function bootstrap(): LibraryBootstrap {
  return {
    csrfToken: "token",
    library: {
      dbPath: "/library/master.db",
      dbDirectory: "/library",
      writeEnabled: true,
      processes: { rekordboxPid: 0, rekordboxAgentPid: 0 },
      stats: {
        tracks: 3,
        playlists: 1,
        folders: 0,
        analyzed: 3,
        missingAnalysis: 0,
        missingBpm: 0,
        missingKey: 0,
      },
    },
  };
}
