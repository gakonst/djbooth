import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type {
  LibraryBootstrap,
  LibraryMutation,
  MutationReceipt,
  PlaylistItem,
  TrackCue,
  TrackCueInput,
  TrackDetail,
  TrackMetadataInput,
  TrackPlaylistMembership,
  TrackSummary,
  TracksResponse,
} from "../shared/types.js";

const libraryQueryRoots = new Set([
  "bootstrap",
  "playlists",
  "tracks",
  "canvas-tracks",
  "editor-tracks",
  "track",
]);

export type OptimisticLibraryMutation = {
  mutation: LibraryMutation;
  temporaryMembershipId?: string;
  temporaryPlaylistId?: string;
  optimisticCueId?: string;
  revalidateTrackQueries?: boolean;
};

export type LibraryCacheSnapshot = Array<readonly [QueryKey, unknown]>;

export type OptimisticIdMaps = {
  memberships: ReadonlyMap<string, string>;
  playlists: ReadonlyMap<string, string>;
  cues: ReadonlyMap<string, string>;
};

export function isOptimisticPlaylistId(id: string | null | undefined): boolean {
  return id?.startsWith("optimistic-playlist:") ?? false;
}

/** Stop foreground reads from racing an optimistic write batch. */
export function cancelLibraryQueries(queryClient: QueryClient): Promise<void> {
  return queryClient.cancelQueries({ predicate: isLibraryQuery }, { silent: true });
}

/** Capture one rollback point for a complete serialized write batch. */
export function captureLibraryCache(queryClient: QueryClient): LibraryCacheSnapshot {
  return queryClient
    .getQueriesData({ predicate: isLibraryQuery })
    .map(([queryKey, data]) => [queryKey, data] as const);
}

/** Restore the last committed UI if any background write in the batch fails. */
export function restoreLibraryCache(
  queryClient: QueryClient,
  snapshot: LibraryCacheSnapshot,
): void {
  for (const [queryKey, data] of snapshot) queryClient.setQueryData(queryKey, data);
}

/** Apply every interactive mutation synchronously to the existing library cache. */
export function applyOptimisticLibraryMutation(
  queryClient: QueryClient,
  mutation: LibraryMutation,
): OptimisticLibraryMutation {
  if (mutation.type === "create-playlist") {
    const temporaryPlaylistId = optimisticId("playlist");
    queryClient.setQueryData<PlaylistItem[]>(["playlists"], (items) => {
      if (!items) return items;
      const parentId = mutation.parentId ?? "root";
      const seq =
        Math.max(0, ...items.filter((item) => item.parentId === parentId).map((item) => item.seq)) +
        1;
      return [
        ...items,
        {
          id: temporaryPlaylistId,
          name: mutation.name.trim(),
          parentId,
          seq,
          type: mutation.kind ?? "playlist",
          trackCount: mutation.kind === "folder" ? 0 : 0,
        },
      ];
    });
    updateBootstrapPlaylistStats(queryClient, mutation.kind ?? "playlist", 1);
    return { mutation, temporaryPlaylistId };
  }

  if (mutation.type === "rename-playlist") {
    queryClient.setQueryData<PlaylistItem[]>(["playlists"], (items) =>
      items?.map((playlist) =>
        playlist.id === mutation.playlistId
          ? { ...playlist, name: mutation.name.trim() }
          : playlist,
      ),
    );
    return { mutation };
  }

  if (mutation.type === "delete-playlist") {
    const deletedIds = new Set(mutation.expectedPlaylistIds);
    const deleted =
      queryClient
        .getQueryData<PlaylistItem[]>(["playlists"])
        ?.filter((playlist) => deletedIds.has(playlist.id)) ?? [];
    queryClient.setQueryData<PlaylistItem[]>(["playlists"], (items) =>
      items?.filter((playlist) => !deletedIds.has(playlist.id)),
    );
    for (const playlist of deleted) updateBootstrapPlaylistStats(queryClient, playlist.type, -1);
    return { mutation };
  }

  if (mutation.type === "update-track") {
    updateTrackMetadata(queryClient, mutation.contentId, mutation.metadata);
    // Search membership, pagination, and every metadata sort can change. Keep the visible row
    // instant, then revalidate browser queries after SQLite commits.
    return { mutation, revalidateTrackQueries: true };
  }

  if (mutation.type === "add-track") {
    const temporaryMembershipId = optimisticId("membership");
    const track = findCachedTrack(queryClient, mutation.contentId);
    const playlist = findCachedPlaylist(queryClient, mutation.playlistId);
    let assignedTrackNumber = mutation.trackNumber;
    updatePlaylistTrackResponses(queryClient, mutation.playlistId, (response) => {
      const trackNumber = clampTrackNumber(
        mutation.trackNumber ?? response.count + 1,
        response.count + 1,
      );
      assignedTrackNumber ??= trackNumber;
      return track
        ? addTrackToResponse(response, track, temporaryMembershipId, trackNumber)
        : { ...response, count: response.count + 1 };
    });
    updatePlaylistCount(queryClient, mutation.playlistId, 1);
    if (track && playlist) {
      addDetailMembership(queryClient, track.id, {
        id: playlist.id,
        name: playlist.name,
        membershipId: temporaryMembershipId,
        trackNumber: assignedTrackNumber ?? Math.max(1, playlist.trackCount ?? 1),
      });
    }
    return { mutation, temporaryMembershipId };
  }

  if (mutation.type === "remove-track") {
    const membership = findCachedMembership(queryClient, mutation.membershipId);
    updatePlaylistTrackResponses(queryClient, mutation.playlistId, (response) =>
      removeTrackFromResponse(response, mutation.membershipId, membership?.trackNumber),
    );
    updatePlaylistCount(queryClient, mutation.playlistId, -1);
    removeDetailMembership(
      queryClient,
      mutation.playlistId,
      mutation.membershipId,
      membership?.trackNumber,
    );
    return { mutation };
  }

  if (mutation.type === "move-track") {
    const membership = findCachedMembership(queryClient, mutation.membershipId);
    updatePlaylistTrackResponses(queryClient, mutation.playlistId, (response) =>
      moveTrackInResponse(
        response,
        mutation.membershipId,
        mutation.trackNumber,
        membership?.trackNumber,
      ),
    );
    if (membership?.trackNumber !== undefined) {
      moveDetailMembership(
        queryClient,
        mutation.playlistId,
        mutation.membershipId,
        membership.trackNumber,
        mutation.trackNumber,
      );
    }
    return { mutation };
  }

  if (mutation.type === "replace-playlist-tracks") {
    const desired = desiredPlaylistTracks(queryClient, mutation.playlistId, mutation.contentIds);
    updatePlaylistTrackResponses(queryClient, mutation.playlistId, (response) =>
      replaceTracksInResponse(response, desired),
    );
    setPlaylistCount(queryClient, mutation.playlistId, mutation.contentIds.length);
    replaceDetailMemberships(queryClient, mutation.playlistId, desired);
    return { mutation };
  }

  if (mutation.type === "upsert-cue") {
    const optimisticCueId = upsertOptimisticCue(queryClient, mutation.contentId, mutation.cue);
    return { mutation, optimisticCueId };
  }

  removeOptimisticCue(queryClient, mutation.contentId, mutation.cueId);
  return { mutation };
}

/** Replace browser-only IDs with the IDs returned by the committed SQLite transaction. */
export function reconcileOptimisticLibraryMutation(
  queryClient: QueryClient,
  optimistic: OptimisticLibraryMutation,
  receipt: MutationReceipt,
): void {
  if (optimistic.temporaryPlaylistId) {
    replacePlaylistId(queryClient, optimistic.temporaryPlaylistId, receipt.changedId);
  }
  if (optimistic.temporaryMembershipId) {
    replaceMembershipId(queryClient, optimistic.temporaryMembershipId, receipt.changedId);
  }
  if (optimistic.optimisticCueId) {
    replaceCueId(queryClient, optimistic.optimisticCueId, receipt.changedId);
  }
}

/** Resolve IDs created optimistically by earlier writes in the same serialized batch. */
export function resolveOptimisticMutationIds(
  mutation: LibraryMutation,
  maps: OptimisticIdMaps,
): LibraryMutation {
  const playlistId = (id: string) => resolveMappedId(maps.playlists, id);
  const membershipId = (id: string) => resolveMappedId(maps.memberships, id);
  const cueId = (id: string) => resolveMappedId(maps.cues, id);
  switch (mutation.type) {
    case "create-playlist":
      return mutation.parentId
        ? { ...mutation, parentId: playlistId(mutation.parentId) }
        : mutation;
    case "rename-playlist":
      return { ...mutation, playlistId: playlistId(mutation.playlistId) };
    case "delete-playlist":
      return {
        ...mutation,
        playlistId: playlistId(mutation.playlistId),
        expectedPlaylistIds: mutation.expectedPlaylistIds.map(playlistId),
      };
    case "update-track":
      return mutation;
    case "add-track":
      return { ...mutation, playlistId: playlistId(mutation.playlistId) };
    case "remove-track":
      return {
        ...mutation,
        playlistId: playlistId(mutation.playlistId),
        membershipId: membershipId(mutation.membershipId),
      };
    case "move-track":
      return {
        ...mutation,
        playlistId: playlistId(mutation.playlistId),
        membershipId: membershipId(mutation.membershipId),
      };
    case "replace-playlist-tracks":
      return { ...mutation, playlistId: playlistId(mutation.playlistId) };
    case "upsert-cue":
      return mutation.cue.id
        ? { ...mutation, cue: { ...mutation.cue, id: cueId(mutation.cue.id) } }
        : mutation;
    case "delete-cue":
      return { ...mutation, cueId: cueId(mutation.cueId) };
  }
}

function updateTrackMetadata(
  queryClient: QueryClient,
  contentId: string,
  metadata: TrackMetadataInput,
): void {
  const summary = {
    title: metadata.title.trim(),
    artist: metadata.artist,
    album: metadata.album,
    genre: metadata.genre,
    key: metadata.key,
    bpm: metadata.bpm,
    rating: metadata.rating,
  };
  queryClient.setQueriesData<TracksResponse>(
    {
      predicate: (query) =>
        query.queryKey[0] === "tracks" || query.queryKey[0] === "playlist-tracks",
    },
    (response) =>
      response
        ? {
            ...response,
            items: response.items.map((track) =>
              track.id === contentId ? { ...track, ...summary } : track,
            ),
          }
        : response,
  );
  queryClient.setQueryData<TrackDetail>(["track", contentId], (track) =>
    track
      ? {
          ...track,
          ...summary,
          comment: metadata.comment,
          releaseYear: metadata.releaseYear,
          isrc: metadata.isrc,
        }
      : track,
  );
}

function isLibraryQuery(query: { queryKey: QueryKey }): boolean {
  return typeof query.queryKey[0] === "string" && libraryQueryRoots.has(query.queryKey[0]);
}

function findCachedPlaylist(queryClient: QueryClient, id: string): PlaylistItem | undefined {
  return queryClient.getQueryData<PlaylistItem[]>(["playlists"])?.find((item) => item.id === id);
}

function findCachedTrack(queryClient: QueryClient, id: string): TrackSummary | undefined {
  const detail = queryClient.getQueryData<TrackDetail>(["track", id]);
  if (detail) return detail;
  for (const [, response] of queryClient.getQueriesData<TracksResponse>({
    predicate: (query) =>
      ["tracks", "canvas-tracks", "editor-tracks"].includes(String(query.queryKey[0])),
  })) {
    const track = response?.items.find((item) => item.id === id);
    if (track) return track;
  }
  return undefined;
}

function findCachedMembership(
  queryClient: QueryClient,
  membershipId: string,
): Pick<TrackSummary, "id" | "trackNumber"> | undefined {
  for (const [, response] of queryClient.getQueriesData<TracksResponse>({
    predicate: (query) =>
      ["tracks", "canvas-tracks", "editor-tracks"].includes(String(query.queryKey[0])),
  })) {
    const track = response?.items.find((item) => item.playlistMembershipId === membershipId);
    if (track) return track;
  }
  return undefined;
}

function updatePlaylistTrackResponses(
  queryClient: QueryClient,
  playlistId: string,
  update: (response: TracksResponse) => TracksResponse,
): void {
  queryClient.setQueriesData<TracksResponse>(
    {
      predicate: (query) => {
        if (query.queryKey[0] !== "tracks") return false;
        const options = query.queryKey[1];
        return (
          typeof options === "object" &&
          options !== null &&
          "playlistId" in options &&
          options.playlistId === playlistId
        );
      },
    },
    (response) => (response ? update(response) : response),
  );
  for (const root of ["canvas-tracks", "editor-tracks"] as const) {
    queryClient.setQueryData<TracksResponse>([root, playlistId], (response) =>
      response ? update(response) : response,
    );
  }
}

function addTrackToResponse(
  response: TracksResponse,
  track: TrackSummary,
  membershipId: string,
  trackNumber: number,
): TracksResponse {
  const shifted = response.items.map((item) =>
    item.trackNumber !== undefined && item.trackNumber >= trackNumber
      ? { ...item, trackNumber: item.trackNumber + 1 }
      : item,
  );
  const added = { ...track, playlistMembershipId: membershipId, trackNumber };
  const all = [...shifted, added].sort(compareTrackNumber);
  return pageResponse(response, all, response.count + 1);
}

function removeTrackFromResponse(
  response: TracksResponse,
  membershipId: string,
  knownTrackNumber?: number,
): TracksResponse {
  const removed = response.items.find((track) => track.playlistMembershipId === membershipId);
  const removedTrackNumber = removed?.trackNumber ?? knownTrackNumber;
  const items = response.items
    .filter((track) => track.playlistMembershipId !== membershipId)
    .map((track) =>
      removedTrackNumber !== undefined &&
      track.trackNumber !== undefined &&
      track.trackNumber > removedTrackNumber
        ? { ...track, trackNumber: track.trackNumber - 1 }
        : track,
    );
  return pageResponse(response, items, Math.max(0, response.count - 1));
}

function moveTrackInResponse(
  response: TracksResponse,
  membershipId: string,
  targetTrackNumber: number,
  knownTrackNumber?: number,
): TracksResponse {
  const moving = response.items.find((track) => track.playlistMembershipId === membershipId);
  const currentTrackNumber = moving?.trackNumber ?? knownTrackNumber;
  if (currentTrackNumber === undefined || currentTrackNumber === targetTrackNumber) {
    return response;
  }
  const items = response.items
    .map((track) => {
      const trackNumber = track.trackNumber;
      if (track.playlistMembershipId === membershipId) {
        return { ...track, trackNumber: targetTrackNumber };
      }
      if (trackNumber === undefined) return track;
      if (
        targetTrackNumber < currentTrackNumber &&
        trackNumber >= targetTrackNumber &&
        trackNumber < currentTrackNumber
      ) {
        return { ...track, trackNumber: trackNumber + 1 };
      }
      if (
        targetTrackNumber > currentTrackNumber &&
        trackNumber <= targetTrackNumber &&
        trackNumber > currentTrackNumber
      ) {
        return { ...track, trackNumber: trackNumber - 1 };
      }
      return track;
    })
    .sort(compareTrackNumber);
  return { ...response, items };
}

function desiredPlaylistTracks(
  queryClient: QueryClient,
  playlistId: string,
  contentIds: readonly string[],
): TrackSummary[] {
  const existingByContent = new Map<string, TrackSummary[]>();
  const seenMemberships = new Set<string>();
  for (const [, response] of queryClient.getQueriesData<TracksResponse>({
    predicate: (query) =>
      (query.queryKey[0] === "canvas-tracks" || query.queryKey[0] === "editor-tracks") &&
      query.queryKey[1] === playlistId,
  })) {
    for (const track of response?.items ?? []) {
      if (!track.playlistMembershipId || seenMemberships.has(track.playlistMembershipId)) continue;
      seenMemberships.add(track.playlistMembershipId);
      const matches = existingByContent.get(track.id) ?? [];
      matches.push(track);
      existingByContent.set(track.id, matches);
    }
  }
  return contentIds.flatMap((contentId, index) => {
    const existing = existingByContent.get(contentId)?.shift();
    const source = existing ?? findCachedTrack(queryClient, contentId);
    if (!source) return [];
    return [
      {
        ...source,
        playlistMembershipId: existing?.playlistMembershipId ?? optimisticId("membership"),
        trackNumber: index + 1,
      },
    ];
  });
}

function replaceTracksInResponse(
  response: TracksResponse,
  desired: readonly TrackSummary[],
): TracksResponse {
  return pageResponse(response, [...desired], desired.length);
}

function pageResponse(
  response: TracksResponse,
  orderedItems: TrackSummary[],
  count: number,
): TracksResponse {
  const complete = response.offset === 0 && response.items.length === response.count;
  const items = complete
    ? orderedItems
    : orderedItems.filter((track) => {
        const number = track.trackNumber ?? 0;
        return number > response.offset && number <= response.offset + response.limit;
      });
  return {
    ...response,
    count,
    items,
    ...(complete ? { limit: Math.max(response.limit, count) } : {}),
  };
}

function compareTrackNumber(left: TrackSummary, right: TrackSummary): number {
  return (
    (left.trackNumber ?? Number.MAX_SAFE_INTEGER) - (right.trackNumber ?? Number.MAX_SAFE_INTEGER)
  );
}

function updatePlaylistCount(queryClient: QueryClient, playlistId: string, delta: number): void {
  queryClient.setQueryData<PlaylistItem[]>(["playlists"], (items) =>
    items?.map((playlist) =>
      playlist.id === playlistId && playlist.trackCount !== null
        ? { ...playlist, trackCount: Math.max(0, playlist.trackCount + delta) }
        : playlist,
    ),
  );
}

function setPlaylistCount(queryClient: QueryClient, playlistId: string, count: number): void {
  queryClient.setQueryData<PlaylistItem[]>(["playlists"], (items) =>
    items?.map((playlist) =>
      playlist.id === playlistId && playlist.trackCount !== null
        ? { ...playlist, trackCount: count }
        : playlist,
    ),
  );
}

function updateBootstrapPlaylistStats(
  queryClient: QueryClient,
  type: PlaylistItem["type"],
  delta: number,
): void {
  queryClient.setQueryData<LibraryBootstrap>(["bootstrap"], (bootstrap) => {
    if (!bootstrap) return bootstrap;
    const field = type === "folder" ? "folders" : "playlists";
    return {
      ...bootstrap,
      library: {
        ...bootstrap.library,
        stats: {
          ...bootstrap.library.stats,
          [field]: Math.max(0, bootstrap.library.stats[field] + delta),
        },
      },
    };
  });
}

function updateTrackDetails(
  queryClient: QueryClient,
  update: (detail: TrackDetail) => TrackDetail,
): void {
  queryClient.setQueriesData<TrackDetail>(
    { predicate: (query) => query.queryKey[0] === "track" },
    (detail) => (detail ? update(detail) : detail),
  );
}

function addDetailMembership(
  queryClient: QueryClient,
  contentId: string,
  membership: TrackPlaylistMembership,
): void {
  updateTrackDetails(queryClient, (detail) => {
    const shifted = detail.playlists.map((item) =>
      item.id === membership.id && item.trackNumber >= membership.trackNumber
        ? { ...item, trackNumber: item.trackNumber + 1 }
        : item,
    );
    return detail.id === contentId
      ? { ...detail, playlists: [...shifted, membership] }
      : { ...detail, playlists: shifted };
  });
}

function removeDetailMembership(
  queryClient: QueryClient,
  playlistId: string,
  membershipId: string,
  removedTrackNumber?: number,
): void {
  updateTrackDetails(queryClient, (detail) => ({
    ...detail,
    playlists: detail.playlists
      .filter((item) => item.membershipId !== membershipId)
      .map((item) =>
        item.id === playlistId &&
        removedTrackNumber !== undefined &&
        item.trackNumber > removedTrackNumber
          ? { ...item, trackNumber: item.trackNumber - 1 }
          : item,
      ),
  }));
}

function moveDetailMembership(
  queryClient: QueryClient,
  playlistId: string,
  membershipId: string,
  currentTrackNumber: number,
  targetTrackNumber: number,
): void {
  updateTrackDetails(queryClient, (detail) => ({
    ...detail,
    playlists: detail.playlists.map((item) => {
      if (item.id !== playlistId) return item;
      if (item.membershipId === membershipId) return { ...item, trackNumber: targetTrackNumber };
      if (
        targetTrackNumber < currentTrackNumber &&
        item.trackNumber >= targetTrackNumber &&
        item.trackNumber < currentTrackNumber
      ) {
        return { ...item, trackNumber: item.trackNumber + 1 };
      }
      if (
        targetTrackNumber > currentTrackNumber &&
        item.trackNumber <= targetTrackNumber &&
        item.trackNumber > currentTrackNumber
      ) {
        return { ...item, trackNumber: item.trackNumber - 1 };
      }
      return item;
    }),
  }));
}

function replaceDetailMemberships(
  queryClient: QueryClient,
  playlistId: string,
  desired: readonly TrackSummary[],
): void {
  const playlist = findCachedPlaylist(queryClient, playlistId);
  if (!playlist) return;
  const byContent = new Map<string, TrackPlaylistMembership[]>();
  for (const track of desired) {
    if (!track.playlistMembershipId || track.trackNumber === undefined) continue;
    const memberships = byContent.get(track.id) ?? [];
    memberships.push({
      id: playlist.id,
      name: playlist.name,
      membershipId: track.playlistMembershipId,
      trackNumber: track.trackNumber,
    });
    byContent.set(track.id, memberships);
  }
  updateTrackDetails(queryClient, (detail) => ({
    ...detail,
    playlists: [
      ...detail.playlists.filter((membership) => membership.id !== playlistId),
      ...(byContent.get(detail.id) ?? []),
    ],
  }));
}

function upsertOptimisticCue(
  queryClient: QueryClient,
  contentId: string,
  input: TrackCueInput,
): string {
  const detail = queryClient.getQueryData<TrackDetail>(["track", contentId]);
  const existing = input.id
    ? detail?.cues.find((cue) => cue.id === input.id)
    : input.kind === "hot"
      ? detail?.cues.find((cue) => cue.kind === "hot" && cue.slot === input.slot)
      : undefined;
  const id = existing?.id ?? input.id ?? optimisticId("cue");
  const cue: TrackCue = {
    id,
    contentId,
    kind: input.kind,
    type: input.type,
    slot: input.kind === "hot" ? input.slot : null,
    startSeconds: input.startSeconds,
    endSeconds: input.endSeconds ?? null,
    activeLoop: input.activeLoop ?? false,
    comment: input.comment ?? "",
    color: input.color ?? null,
    colorTableIndex: input.colorTableIndex ?? null,
  };
  queryClient.setQueryData<TrackDetail>(["track", contentId], (current) => {
    if (!current) return current;
    return {
      ...current,
      cues: [...current.cues.filter((item) => item.id !== id), cue].sort(
        (left, right) => left.startSeconds - right.startSeconds,
      ),
    };
  });
  return id;
}

function removeOptimisticCue(queryClient: QueryClient, contentId: string, cueId: string): void {
  queryClient.setQueryData<TrackDetail>(["track", contentId], (detail) =>
    detail ? { ...detail, cues: detail.cues.filter((cue) => cue.id !== cueId) } : detail,
  );
}

function replacePlaylistId(queryClient: QueryClient, from: string, to: string): void {
  queryClient.setQueryData<PlaylistItem[]>(["playlists"], (items) =>
    items?.map((playlist) => ({
      ...playlist,
      id: playlist.id === from ? to : playlist.id,
      parentId: playlist.parentId === from ? to : playlist.parentId,
    })),
  );
  updateTrackDetails(queryClient, (detail) => ({
    ...detail,
    playlists: detail.playlists.map((playlist) =>
      playlist.id === from ? { ...playlist, id: to } : playlist,
    ),
  }));
  aliasPlaylistQueries(queryClient, from, to);
}

function replaceMembershipId(queryClient: QueryClient, from: string, to: string): void {
  queryClient.setQueriesData<TracksResponse>(
    {
      predicate: (query) =>
        query.queryKey[0] === "tracks" ||
        query.queryKey[0] === "canvas-tracks" ||
        query.queryKey[0] === "editor-tracks",
    },
    (response) =>
      response
        ? {
            ...response,
            items: response.items.map((track) =>
              track.playlistMembershipId === from ? { ...track, playlistMembershipId: to } : track,
            ),
          }
        : response,
  );
  updateTrackDetails(queryClient, (detail) => ({
    ...detail,
    playlists: detail.playlists.map((playlist) =>
      playlist.membershipId === from ? { ...playlist, membershipId: to } : playlist,
    ),
  }));
}

function replaceCueId(queryClient: QueryClient, from: string, to: string): void {
  updateTrackDetails(queryClient, (detail) => ({
    ...detail,
    cues: detail.cues.map((cue) => (cue.id === from ? { ...cue, id: to } : cue)),
  }));
}

function aliasPlaylistQueries(queryClient: QueryClient, from: string, to: string): void {
  for (const [queryKey, data] of queryClient.getQueriesData({ predicate: isLibraryQuery })) {
    if (queryKey[0] === "tracks") {
      const options = queryKey[1];
      if (
        typeof options === "object" &&
        options !== null &&
        "playlistId" in options &&
        options.playlistId === from
      ) {
        queryClient.setQueryData(["tracks", { ...options, playlistId: to }], data);
      }
    }
    if (
      (queryKey[0] === "canvas-tracks" || queryKey[0] === "editor-tracks") &&
      queryKey[1] === from
    ) {
      queryClient.setQueryData([queryKey[0], to], data);
    }
  }
}

function resolveMappedId(map: ReadonlyMap<string, string>, initial: string): string {
  let id = initial;
  const visited = new Set<string>();
  while (map.has(id) && !visited.has(id)) {
    visited.add(id);
    id = map.get(id)!;
  }
  return id;
}

function clampTrackNumber(value: number, maximum: number): number {
  return Math.max(1, Math.min(maximum, Math.trunc(value)));
}

function optimisticId(kind: string): string {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `optimistic-${kind}:${id}`;
}
