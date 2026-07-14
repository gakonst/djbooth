import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ChevronRight,
  CircleAlert,
  Copy,
  Flag,
  Keyboard,
  Library,
  Menu,
  PanelRightOpen,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  HotCueSlot,
  LibraryEvent,
  LibraryMutation,
  MutationReceipt,
  PlaylistItem,
  TrackCue,
  TrackCueInput,
  TrackSort,
  TrackSummary,
} from "../shared/types.js";
import {
  getBootstrap,
  getPlaylists,
  getTrackDetail,
  getTracks,
  LibraryApiError,
  mutateLibrary,
  subscribeLibraryEvents,
} from "./api.js";
import { ContextMenu, type ContextMenuEntry, useContextMenu } from "./components/ContextMenu.js";
import { CueDialog, DeletePlaylistDialog, PlaylistDialog, Toast } from "./components/Dialogs.js";
import { LibrarySidebar } from "./components/LibrarySidebar.js";
import {
  PlayerPanel,
  type PlayerAdapter,
  type PlayerPanelHandle,
} from "./components/PlayerPanel.js";
import { PlaylistEditor } from "./components/PlaylistEditor.js";
import {
  deriveConnectedOrder,
  playlistMembershipSnapshot,
  SetCanvas,
  type CanvasPoint,
  type SetCanvasConnection,
  type SetCanvasNode,
} from "./components/SetCanvas.js";
import { TrackTable } from "./components/TrackTable.js";
import { TrackMetadataDialog } from "./components/TrackMetadataDialog.js";
import {
  DeferredLibraryEventRefresh,
  invalidateAuthoritativeTrackQueries,
  invalidateCanonicalPlaylistQueries,
  playlistTracksQueryOptions,
  trackWaveformQueryOptions,
} from "./library-queries.js";
import { libraryMutationCoalesceKey, useLibraryMutationQueue } from "./useLibraryMutationQueue.js";
import { buildHotkeyPalette, type HotkeyBinding, useHotkeys } from "./useHotkeys.js";
import {
  applyOptimisticLibraryMutation,
  cancelLibraryQueries,
  captureLibraryCache,
  isOptimisticPlaylistId,
  type LibraryCacheSnapshot,
  type OptimisticLibraryMutation,
  reconcileOptimisticLibraryMutation,
  resolveOptimisticMutationIds,
  restoreLibraryCache,
} from "./optimistic-library.js";
import { useLibraryUrlState } from "./url-state.js";

const PAGE_SIZE = 100;

const filterLabels: Record<string, string> = {
  all: "All tracks",
};

type PlaylistDialogState =
  | { mode: "create"; defaultParentId?: string }
  | { mode: "rename"; playlist: PlaylistItem }
  | null;

type CueDialogTarget = {
  contentId: string;
  trackTitle: string;
  durationSeconds: number | null;
};

type CueDialogState =
  | (CueDialogTarget & { cue: TrackCue })
  | (CueDialogTarget & {
      initial: { kind: "memory" | "hot"; slot?: HotCueSlot; startSeconds: number };
    })
  | null;

type ToastState = { message: string; tone: "success" | "error" } | null;

type DeletePlaylistState = PlaylistItem & { expectedPlaylistIds: string[] };

type ContextTarget =
  | { kind: "track"; track: TrackSummary }
  | {
      kind: "playlist";
      playlist: PlaylistItem;
      folderExpanded?: boolean;
      toggleFolder?(): void;
    }
  | { kind: "canvas-node"; nodeId: string };

type CanvasState = {
  nodes: SetCanvasNode[];
  connections: SetCanvasConnection[];
};

type LibraryMutationCommit = {
  optimistic: OptimisticLibraryMutation;
  receipt: MutationReceipt;
};

type OptimisticWriteSession = {
  ready: Promise<void>;
  snapshot: LibraryCacheSnapshot;
};

export function App() {
  const queryClient = useQueryClient();
  const playerAdapter = useMemo<PlayerAdapter>(
    () => ({
      getAudioUrl: (track) => `/api/audio/${encodeURIComponent(track.id)}`,
      getArtworkUrl: (track) => `/api/artwork/${encodeURIComponent(track.id)}`,
      loadWaveform: (track) => queryClient.ensureQueryData(trackWaveformQueryOptions(track.id)),
    }),
    [queryClient],
  );
  const { state: urlState, update: updateUrl } = useLibraryUrlState();
  const trackScope = `${urlState.playlistId ?? ""}\u0000${urlState.filter}\u0000${urlState.query}`;
  const [page, setPage] = useState({ scope: trackScope, offset: 0 });
  const offset = page.scope === trackScope ? page.offset : 0;
  const setOffset = useCallback(
    (nextOffset: number) => setPage({ scope: trackScope, offset: nextOffset }),
    [trackScope],
  );
  const [sort, setSort] = useState<TrackSort>();
  const [searchInput, setSearchInput] = useState(urlState.query);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editingPlaylistId, setEditingPlaylistId] = useState<string>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [playlistDialog, setPlaylistDialog] = useState<PlaylistDialogState>(null);
  const [deleteDialogPlaylist, setDeleteDialogPlaylist] = useState<DeletePlaylistState>();
  const [cueDialog, setCueDialog] = useState<CueDialogState>(null);
  const [metadataTarget, setMetadataTarget] = useState<TrackSummary>();
  const [toast, setToast] = useState<ToastState>(null);
  const [viewMode, setViewMode] = useState<"table" | "canvas">("table");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [autoPlayTrackId, setAutoPlayTrackId] = useState<string>();
  const [playerTrackId, setPlayerTrackId] = useState<string | null>(urlState.trackId);
  const [playerSummary, setPlayerSummary] = useState<TrackSummary>();
  const [canvasPlaylistId, setCanvasPlaylistId] = useState<string>();
  const [canvasState, setCanvasState] = useState<CanvasState>({ nodes: [], connections: [] });
  const [canvasExpectedMembershipIds, setCanvasExpectedMembershipIds] = useState<string[]>([]);
  const [canvasFailedFingerprint, setCanvasFailedFingerprint] = useState<string>();
  const [selectedCanvasNodeId, setSelectedCanvasNodeId] = useState<string>();
  const [pendingCanvasTrack, setPendingCanvasTrack] = useState<TrackSummary>();
  const searchRef = useRef<HTMLInputElement>(null);
  const playerRef = useRef<PlayerPanelHandle>(null);
  const playheadSecondsRef = useRef<number | null>(null);
  const selectedTrackIdRef = useRef<string | null>(urlState.trackId);
  const canvasHydratedKeyRef = useRef<string | undefined>(undefined);
  const canvasFingerprintRef = useRef("");
  const canvasQueuedFingerprintRef = useRef<string | undefined>(undefined);
  const localWritePendingRef = useRef(false);
  const optimisticWriteSessionRef = useRef<OptimisticWriteSession | undefined>(undefined);
  const optimisticPlaylistIdsRef = useRef(new Map<string, string>());
  const optimisticMembershipIdsRef = useRef(new Map<string, string>());
  const optimisticCueIdsRef = useRef(new Map<string, string>());
  const optimisticTrackRevisionsRef = useRef(new Map<string, string>());
  const playlistRevalidationsRef = useRef(new Set<string>());
  const canonicalPlaylistRevalidationsRef = useRef(new Set<string>());
  const trackRevalidationsRef = useRef(new Set<string>());
  const suppressExternalUntilRef = useRef(0);
  const flushDeferredRemoteEventsRef = useRef<(events: readonly LibraryEvent[]) => void>(
    () => undefined,
  );
  const contextMenu = useContextMenu<ContextTarget>();

  const bootstrapQuery = useQuery({
    queryKey: ["bootstrap"],
    queryFn: ({ signal }) => getBootstrap(signal),
  });
  const playlistsQuery = useQuery({
    queryKey: ["playlists"],
    queryFn: ({ signal }) => getPlaylists(signal),
  });
  const playlists = playlistsQuery.data ?? [];
  const selectedPlaylist = playlists.find((playlist) => playlist.id === urlState.playlistId);
  const normalPlaylist = selectedPlaylist?.type === "playlist" ? selectedPlaylist : undefined;
  const editingPlaylist = playlists.find(
    (playlist) => playlist.id === editingPlaylistId && playlist.type === "playlist",
  );
  const canvasPlaylist = playlists.find(
    (playlist) => playlist.id === canvasPlaylistId && playlist.type === "playlist",
  );

  const tracksQuery = useQuery({
    queryKey: [
      "tracks",
      {
        query: urlState.query,
        playlistId: urlState.playlistId,
        filter: urlState.filter,
        offset,
        sort,
      },
    ],
    queryFn: ({ signal }) =>
      getTracks(
        {
          query: urlState.query,
          playlistId: urlState.playlistId,
          filter: urlState.filter,
          limit: PAGE_SIZE,
          offset,
          ...(sort ? { sort } : {}),
        },
        signal,
      ),
    enabled: !isOptimisticPlaylistId(urlState.playlistId),
    placeholderData: isOptimisticPlaylistId(urlState.playlistId) ? undefined : keepPreviousData,
  });

  const canvasTracksQuery = useQuery({
    ...playlistTracksQueryOptions(canvasPlaylist?.id),
    enabled:
      viewMode === "canvas" &&
      Boolean(canvasPlaylist) &&
      !isOptimisticPlaylistId(canvasPlaylist?.id),
  });
  const editingTracksQuery = useQuery({
    ...playlistTracksQueryOptions(editingPlaylist?.id),
    enabled: editorOpen && Boolean(editingPlaylist) && !isOptimisticPlaylistId(editingPlaylist?.id),
  });

  const tracks = tracksQuery.data?.items ?? [];
  const playerDetailQuery = useQuery({
    queryKey: ["track", playerTrackId],
    queryFn: ({ signal }) => getTrackDetail(playerTrackId!, signal),
    enabled: Boolean(playerTrackId),
  });
  const metadataDetailQuery = useQuery({
    queryKey: ["track", metadataTarget?.id],
    queryFn: ({ signal }) => getTrackDetail(metadataTarget!.id, signal),
    enabled: Boolean(metadataTarget),
  });

  const processes = bootstrapQuery.data?.library.processes;
  const rekordboxRunning = Boolean(
    (processes?.rekordboxPid ?? 0) > 0 || (processes?.rekordboxAgentPid ?? 0) > 0,
  );
  const writeEnabled = bootstrapQuery.data?.library.writeEnabled === true;
  const writeReady = writeEnabled && !rekordboxRunning;
  const canWrite = writeReady;

  const refreshAll = useCallback(() => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["bootstrap"] }),
      queryClient.invalidateQueries({ queryKey: ["playlists"] }),
      queryClient.invalidateQueries({ queryKey: ["tracks"] }),
      queryClient.invalidateQueries({ queryKey: ["playlist-tracks"] }),
      queryClient.invalidateQueries({ queryKey: ["track"] }),
      queryClient.invalidateQueries({ queryKey: ["track-waveform"] }),
    ]);
  }, [queryClient]);

  const refreshRemoteMutation = useCallback(
    (event: LibraryEvent) => {
      const active = { refetchType: "active" as const };
      if (event.mutation === "update-track" && event.changedId) {
        const trackIds = new Set([event.changedId]);
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: ["bootstrap"], ...active }),
          queryClient.invalidateQueries({ queryKey: ["playlists"], ...active }),
          queryClient.invalidateQueries({ queryKey: ["tracks"], ...active }),
          invalidateAuthoritativeTrackQueries(queryClient, trackIds),
        ]);
        return;
      }

      const invalidations = [queryClient.invalidateQueries({ queryKey: ["playlists"], ...active })];
      if (event.mutation === "create-playlist" || event.mutation === "delete-playlist")
        invalidations.push(queryClient.invalidateQueries({ queryKey: ["bootstrap"], ...active }));
      if (event.mutation !== "create-playlist")
        invalidations.push(queryClient.invalidateQueries({ queryKey: ["track"], ...active }));
      if (
        event.mutation === "add-track" ||
        event.mutation === "remove-track" ||
        event.mutation === "move-track" ||
        event.mutation === "replace-playlist-tracks" ||
        event.mutation === "delete-playlist"
      )
        invalidations.push(
          queryClient.invalidateQueries({ queryKey: ["tracks"], ...active }),
          queryClient.invalidateQueries({ queryKey: ["playlist-tracks"], ...active }),
        );
      void Promise.all(invalidations);
    },
    [queryClient],
  );

  flushDeferredRemoteEventsRef.current = (events) => {
    const event = events.length === 1 ? events[0] : undefined;
    if (event?.type === "mutation") refreshRemoteMutation(event);
    else refreshAll();
  };
  const deferredRemoteRefreshRef = useRef<DeferredLibraryEventRefresh>(undefined);
  if (!deferredRemoteRefreshRef.current) {
    deferredRemoteRefreshRef.current = new DeferredLibraryEventRefresh({
      flush: (events) => flushDeferredRemoteEventsRef.current(events),
      isBlocked: () => localWritePendingRef.current,
      notBefore: () => suppressExternalUntilRef.current,
    });
  }
  const deferredRemoteRefresh = deferredRemoteRefreshRef.current;

  const writes = useLibraryMutationQueue<OptimisticLibraryMutation, LibraryMutationCommit>({
    coalesceKey: (queued) => libraryMutationCoalesceKey(queued.mutation),
    execute: async (optimistic) => {
      const token = bootstrapQuery.data?.csrfToken;
      if (!token) throw new Error("The local write token is unavailable. Refresh the workbench.");
      const input = resolveOptimisticMutationIds(optimistic.mutation, {
        playlists: optimisticPlaylistIdsRef.current,
        memberships: optimisticMembershipIdsRef.current,
        cues: optimisticCueIdsRef.current,
        trackRevisions: optimisticTrackRevisionsRef.current,
      });
      const receipt = await mutateLibrary(token, input);
      return { optimistic, receipt };
    },
    onPendingChange: (count) => {
      localWritePendingRef.current = count > 0;
      deferredRemoteRefresh.stateChanged();
    },
    onSuccess: ({ optimistic, receipt }) => {
      suppressExternalUntilRef.current = Date.now() + 1_500;
      const reconciled = reconcileOptimisticLibraryMutation(queryClient, optimistic, receipt);
      if (optimistic.temporaryPlaylistId) {
        const temporaryId = optimistic.temporaryPlaylistId;
        optimisticPlaylistIdsRef.current.set(temporaryId, receipt.changedId);
        setEditingPlaylistId((id) => (id === temporaryId ? receipt.changedId : id));
        setCanvasPlaylistId((id) => (id === temporaryId ? receipt.changedId : id));
        if (urlState.playlistId === temporaryId) updateUrl({ playlistId: receipt.changedId });
      }
      for (const [from, to] of reconciled.membershipIds)
        optimisticMembershipIdsRef.current.set(from, to);
      if (optimistic.mutation.type === "update-track" && receipt.revision)
        optimisticTrackRevisionsRef.current.set(optimistic.mutation.contentId, receipt.revision);
      if (optimistic.revalidatePlaylistId)
        playlistRevalidationsRef.current.add(
          optimisticPlaylistIdsRef.current.get(optimistic.revalidatePlaylistId) ??
            optimistic.revalidatePlaylistId,
        );
      if (optimistic.revalidateCanonicalPlaylistId)
        canonicalPlaylistRevalidationsRef.current.add(
          optimisticPlaylistIdsRef.current.get(optimistic.revalidateCanonicalPlaylistId) ??
            optimistic.revalidateCanonicalPlaylistId,
        );
      if (optimistic.revalidateTrackId)
        trackRevalidationsRef.current.add(optimistic.revalidateTrackId);
      if (optimistic.optimisticCueId)
        optimisticCueIdsRef.current.set(optimistic.optimisticCueId, receipt.changedId);
    },
    onError: (error) => {
      const session = optimisticWriteSessionRef.current;
      if (session) restoreLibraryCache(queryClient, session.snapshot);
      // Earlier entries in this queue may already be committed. The pre-batch rollback keeps the
      // UI coherent immediately; active reads then recover the authoritative partial commit.
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: ["bootstrap"], refetchType: "active" }),
        queryClient.invalidateQueries({ queryKey: ["playlists"], refetchType: "active" }),
        queryClient.invalidateQueries({ queryKey: ["tracks"], refetchType: "active" }),
        queryClient.invalidateQueries({ queryKey: ["playlist-tracks"], refetchType: "active" }),
        queryClient.invalidateQueries({ queryKey: ["track"], refetchType: "active" }),
      ]);
      optimisticWriteSessionRef.current = undefined;
      playlistRevalidationsRef.current.clear();
      canonicalPlaylistRevalidationsRef.current.clear();
      trackRevalidationsRef.current.clear();
      if (canvasQueuedFingerprintRef.current)
        setCanvasFailedFingerprint(canvasFingerprintRef.current);
      setToast({ tone: "error", message: errorMessage(error) });
    },
    onIdle: () => {
      localWritePendingRef.current = false;
      optimisticWriteSessionRef.current = undefined;
      optimisticPlaylistIdsRef.current.clear();
      optimisticMembershipIdsRef.current.clear();
      optimisticCueIdsRef.current.clear();
      optimisticTrackRevisionsRef.current.clear();
      const playlistIds = new Set(playlistRevalidationsRef.current);
      playlistRevalidationsRef.current.clear();
      const canonicalPlaylistIds = new Set(canonicalPlaylistRevalidationsRef.current);
      canonicalPlaylistRevalidationsRef.current.clear();
      const trackIds = new Set(trackRevalidationsRef.current);
      trackRevalidationsRef.current.clear();
      if (trackIds.size) {
        void queryClient.invalidateQueries({
          queryKey: ["bootstrap"],
          refetchType: "active",
        });
        // Track metadata can alter smart-playlist membership and its cached count.
        void queryClient.invalidateQueries({
          queryKey: ["playlists"],
          refetchType: "active",
        });
        void queryClient.invalidateQueries({
          queryKey: ["tracks"],
          refetchType: "active",
        });
        void invalidateAuthoritativeTrackQueries(queryClient, trackIds);
      }
      if (canonicalPlaylistIds.size)
        void invalidateCanonicalPlaylistQueries(queryClient, canonicalPlaylistIds);
      if (playlistIds.size)
        void queryClient.invalidateQueries({
          predicate: (query) => {
            if (query.queryKey[0] !== "tracks") return false;
            const options = query.queryKey[1];
            return (
              typeof options === "object" &&
              options !== null &&
              "playlistId" in options &&
              typeof options.playlistId === "string" &&
              playlistIds.has(options.playlistId)
            );
          },
          refetchType: "active",
        });
    },
  });

  const assertWritable = useCallback(() => {
    if (!writeReady) {
      throw new Error(
        rekordboxRunning
          ? "Quit Rekordbox and rekordboxAgent before changing the library."
          : "Library writes are disabled; restart this workbench with --write.",
      );
    }
  }, [rekordboxRunning, writeReady]);

  const applyMutationAsync = useCallback(
    async (input: LibraryMutation) => {
      assertWritable();
      let session = optimisticWriteSessionRef.current;
      if (!session) {
        session = {
          snapshot: captureLibraryCache(queryClient),
          ready: cancelLibraryQueries(queryClient),
        };
        optimisticWriteSessionRef.current = session;
      }
      await session.ready;
      const optimistic = applyOptimisticLibraryMutation(queryClient, input);
      if (input.type === "create-playlist" || input.type === "rename-playlist")
        setPlaylistDialog(null);
      if (input.type === "delete-playlist") setDeleteDialogPlaylist(undefined);
      if (input.type === "upsert-cue") setCueDialog(null);
      if (input.type === "delete-playlist" && input.playlistId === urlState.playlistId) {
        updateUrl({ playlistId: null, filter: "all", trackId: null });
        setViewMode("table");
      }
      if (input.type === "delete-playlist" && input.playlistId === canvasPlaylistId) {
        setCanvasPlaylistId(undefined);
        setCanvasState({ nodes: [], connections: [] });
        setCanvasExpectedMembershipIds([]);
        setViewMode("table");
      }
      if (input.type === "delete-playlist" && input.playlistId === editingPlaylistId) {
        setEditorOpen(false);
        setEditingPlaylistId(undefined);
      }
      const commit = await writes.enqueue(optimistic);
      return commit.receipt;
    },
    [
      assertWritable,
      canvasPlaylistId,
      editingPlaylistId,
      queryClient,
      updateUrl,
      urlState.playlistId,
      writes,
    ],
  );

  const applyMutation = useCallback(
    (input: LibraryMutation) => {
      void applyMutationAsync(input).catch(() => undefined);
    },
    [applyMutationAsync],
  );

  const openCueDialog = useCallback(
    (next: NonNullable<CueDialogState>) => {
      writes.reset();
      setCueDialog(next);
    },
    [writes],
  );

  const dismissToast = useCallback(() => setToast(null), []);

  const selectTrack = useCallback(
    (track: TrackSummary, activate = false) => {
      selectedTrackIdRef.current = track.id;
      updateUrl({ trackId: track.id });
      if (!activate) return;
      const sameTrack = playerTrackId === track.id;
      setPlayerTrackId(track.id);
      setPlayerSummary(track);
      if (!sameTrack) playheadSecondsRef.current = 0;
      if (sameTrack) {
        setAutoPlayTrackId(undefined);
        void playerRef.current?.play();
      } else {
        setAutoPlayTrackId(track.id);
      }
    },
    [playerTrackId, updateUrl],
  );

  const quickCue = useCallback(
    (kind: "memory" | "hot", startSeconds: number, slot?: HotCueSlot) => {
      if (!playerTrackId) {
        setToast({ tone: "error", message: "Select a track before setting a cue." });
        return;
      }
      const common = {
        type: "cue" as const,
        startSeconds,
        comment: "",
        color: null,
        colorTableIndex: null,
      };
      const cue: TrackCueInput =
        kind === "hot" && slot ? { ...common, kind: "hot", slot } : { ...common, kind: "memory" };
      applyMutation({ type: "upsert-cue", contentId: playerTrackId, cue });
    },
    [applyMutation, playerTrackId],
  );

  useEffect(() => setSearchInput(urlState.query), [urlState.query]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (searchInput !== urlState.query)
        updateUrl({ query: searchInput, trackId: null }, { replace: true });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [searchInput, updateUrl, urlState.query]);

  useEffect(() => {
    setPage((current) =>
      current.scope === trackScope ? current : { scope: trackScope, offset: 0 },
    );
  }, [trackScope]);

  useEffect(() => {
    selectedTrackIdRef.current = urlState.trackId;
  }, [urlState.trackId]);

  useEffect(
    () =>
      subscribeLibraryEvents((event) => {
        if (event.type === "mutation") {
          if (localWritePendingRef.current || Date.now() < suppressExternalUntilRef.current)
            deferredRemoteRefresh.defer(event);
          else refreshRemoteMutation(event);
          return;
        }
        if (event.type !== "external-change") return;
        if (localWritePendingRef.current || Date.now() < suppressExternalUntilRef.current)
          deferredRemoteRefresh.defer(event);
        else refreshAll();
      }),
    [deferredRemoteRefresh, refreshAll, refreshRemoteMutation],
  );

  useEffect(() => () => deferredRemoteRefresh.dispose(), [deferredRemoteRefresh]);

  const canvasStorageKey = useMemo(() => {
    const dbPath = bootstrapQuery.data?.library.dbPath;
    return dbPath && canvasPlaylist
      ? `music-library:canvas:v2:${dbPath}:${canvasPlaylist.id}`
      : undefined;
  }, [bootstrapQuery.data?.library.dbPath, canvasPlaylist]);

  const canvasContentIds = useMemo(() => {
    const byId = new Map(canvasState.nodes.map((node) => [node.id, node]));
    return deriveConnectedOrder(canvasState.nodes, canvasState.connections).flatMap((nodeId) => {
      const node = byId.get(nodeId);
      return node ? [node.track.id] : [];
    });
  }, [canvasState.connections, canvasState.nodes]);
  const persistedCanvasContentIds = useMemo(
    () => canvasTracksQuery.data?.items.map((track) => track.id) ?? [],
    [canvasTracksQuery.data?.items],
  );
  const canvasFingerprint = JSON.stringify(canvasContentIds);
  const canvasDirty = Boolean(
    canvasStorageKey &&
    canvasHydratedKeyRef.current === canvasStorageKey &&
    canvasFingerprint !== JSON.stringify(persistedCanvasContentIds),
  );
  canvasFingerprintRef.current = canvasFingerprint;

  useEffect(() => {
    const playlistTracks = canvasTracksQuery.data?.items;
    if (!canvasStorageKey || !playlistTracks) {
      canvasHydratedKeyRef.current = undefined;
      if (!canvasPlaylist) {
        setCanvasState({ nodes: [], connections: [] });
        setCanvasExpectedMembershipIds([]);
      }
      return;
    }
    if (canvasHydratedKeyRef.current === canvasStorageKey && canvasDirty) return;
    const stored = readCanvasState(canvasStorageKey);
    setCanvasState(mergeCanvasState(playlistTracks, stored));
    setCanvasExpectedMembershipIds(playlistMembershipSnapshot(playlistTracks));
    canvasHydratedKeyRef.current = canvasStorageKey;
  }, [canvasDirty, canvasPlaylist?.id, canvasStorageKey, canvasTracksQuery.data?.items]);

  useEffect(() => {
    if (!canvasStorageKey || canvasHydratedKeyRef.current !== canvasStorageKey) return;
    const timeout = window.setTimeout(() => {
      window.localStorage.setItem(canvasStorageKey, JSON.stringify(canvasState));
    }, 150);
    return () => window.clearTimeout(timeout);
  }, [canvasState, canvasStorageKey]);

  useEffect(() => {
    if (!pendingCanvasTrack || viewMode !== "canvas" || !canvasTracksQuery.data) return;
    setCanvasState((current) => addCandidateNode(current, pendingCanvasTrack));
    setPendingCanvasTrack(undefined);
  }, [canvasTracksQuery.data, pendingCanvasTrack, viewMode]);

  const playerTrack = playerDetailQuery.data ?? playerSummary;
  const playerIndex = tracks.findIndex((track) => track.id === playerTrack?.id);
  const previousTrack = playerIndex > 0 ? tracks[playerIndex - 1] : undefined;
  const nextTrack = playerIndex >= 0 ? tracks[playerIndex + 1] : undefined;

  const modalOpen = Boolean(
    playlistDialog ||
    deleteDialogPlaylist ||
    cueDialog ||
    metadataTarget ||
    shortcutsOpen ||
    contextMenu.open,
  );
  const managedPlaylist = editorOpen && editingPlaylist ? editingPlaylist : normalPlaylist;
  const selectedTrack = [
    ...tracks,
    ...(editingTracksQuery.data?.items ?? []),
    ...(canvasTracksQuery.data?.items ?? []),
    ...canvasState.nodes.map((node) => node.track),
    ...(playerDetailQuery.data ? [playerDetailQuery.data] : []),
    ...(playerSummary ? [playerSummary] : []),
  ].find((track) => track.id === selectedTrackIdRef.current);
  const selectedMembershipTrack = managedPlaylist
    ? [
        ...(managedPlaylist.id === normalPlaylist?.id ? tracks : []),
        ...(managedPlaylist.id === editingPlaylist?.id
          ? (editingTracksQuery.data?.items ?? [])
          : []),
        ...(managedPlaylist.id === canvasPlaylist?.id ? (canvasTracksQuery.data?.items ?? []) : []),
      ].find((track) => track.id === selectedTrackIdRef.current)
    : undefined;
  const selectedMembership =
    managedPlaylist && selectedMembershipTrack?.playlistMembershipId
      ? {
          id: managedPlaylist.id,
          name: managedPlaylist.name,
          membershipId: selectedMembershipTrack.playlistMembershipId,
          trackNumber: selectedMembershipTrack.trackNumber ?? 1,
        }
      : undefined;

  const openCanvas = useCallback(
    (playlist?: PlaylistItem) => {
      const target = playlist?.type === "playlist" ? playlist : (canvasPlaylist ?? normalPlaylist);
      if (!target) {
        setToast({ tone: "error", message: "Open a normal playlist before using the set canvas." });
        return;
      }
      if (target.id !== canvasPlaylist?.id) {
        canvasHydratedKeyRef.current = undefined;
        setCanvasState({ nodes: [], connections: [] });
        setCanvasExpectedMembershipIds([]);
        setCanvasFailedFingerprint(undefined);
        canvasQueuedFingerprintRef.current = undefined;
        setSelectedCanvasNodeId(undefined);
        setPendingCanvasTrack(undefined);
      }
      setCanvasPlaylistId(target.id);
      setViewMode("canvas");
    },
    [canvasPlaylist, normalPlaylist],
  );

  const hotkeyBindings: HotkeyBinding[] = [
    {
      id: "close-shortcuts",
      label: "Close keyboard shortcuts",
      shortcut: "escape",
      priority: 100,
      hideFromPalette: true,
      handler: () => setShortcutsOpen(false),
      when: () => shortcutsOpen,
    },
    {
      id: "search",
      label: "Search tracks",
      category: "Library",
      shortcut: "/",
      handler: () => searchRef.current?.focus(),
      when: () => !modalOpen,
    },
    {
      id: "play-pause",
      label: "Play / pause",
      category: "Player",
      shortcut: "space",
      handler: () => void playerRef.current?.toggle(),
      when: () => !modalOpen,
    },
    {
      id: "seek-back",
      label: "Seek back 5 seconds",
      category: "Player",
      shortcut: "arrowleft",
      allowRepeat: true,
      handler: () => playerRef.current?.seekBy(-5),
      when: () => !modalOpen,
    },
    {
      id: "seek-forward",
      label: "Seek forward 5 seconds",
      category: "Player",
      shortcut: "arrowright",
      allowRepeat: true,
      handler: () => playerRef.current?.seekBy(5),
      when: () => !modalOpen,
    },
    {
      id: "previous",
      label: "Previous track",
      category: "Player",
      shortcut: "shift+arrowleft",
      enabled: Boolean(previousTrack),
      handler: () => previousTrack && selectTrack(previousTrack, true),
      when: () => !modalOpen,
    },
    {
      id: "next",
      label: "Next track",
      category: "Player",
      shortcut: "shift+arrowright",
      enabled: Boolean(nextTrack),
      handler: () => nextTrack && selectTrack(nextTrack, true),
      when: () => !modalOpen,
    },
    {
      id: "memory-cue",
      label: "Set memory cue",
      category: "Cues",
      shortcut: "m",
      enabled: Boolean(playerTrack) && canWrite,
      handler: () => quickCue("memory", playerRef.current?.getCurrentTime() ?? 0),
      when: () => !modalOpen,
    },
    {
      id: "canvas",
      label: "Toggle set canvas",
      category: "Workspace",
      shortcut: "c",
      enabled: Boolean(normalPlaylist || canvasPlaylist),
      handler: () => {
        if (viewMode === "canvas") setViewMode("table");
        else openCanvas(normalPlaylist);
      },
      when: () => !modalOpen,
    },
    {
      id: "new-playlist",
      label: "New playlist",
      category: "Playlist",
      shortcut: "mod+n",
      enabled: canWrite,
      handler: () => setPlaylistDialog({ mode: "create" }),
      when: () => !modalOpen,
    },
    {
      id: "toggle-playlist-editor",
      label: editorOpen ? "Close playlist editor" : "Edit current playlist",
      category: "Playlist",
      shortcut: "shift+e",
      enabled: editorOpen || Boolean(normalPlaylist),
      handler: () => {
        if (editorOpen) setEditorOpen(false);
        else if (normalPlaylist) {
          setEditingPlaylistId(normalPlaylist.id);
          setEditorOpen(true);
        }
      },
      when: () => !modalOpen,
    },
    {
      id: "edit-track-metadata",
      label: "Edit selected track metadata",
      category: "Library",
      shortcut: "e",
      enabled: Boolean(canWrite && selectedTrack),
      handler: () => {
        if (selectedTrack) setMetadataTarget(selectedTrack);
      },
      when: () => !modalOpen,
    },
    {
      id: "add-to-editing-playlist",
      label: "Add selected track to editing playlist",
      category: "Playlist",
      shortcut: "mod+enter",
      enabled: Boolean(
        canWrite && editorOpen && editingPlaylist && selectedTrack && !selectedMembership,
      ),
      handler: () => {
        if (!editingPlaylist || !selectedTrack) return;
        applyMutation({
          type: "add-track",
          playlistId: editingPlaylist.id,
          contentId: selectedTrack.id,
        });
      },
      when: () => !modalOpen,
    },
    {
      id: "move-playlist-track-up",
      label: "Move selected playlist track up",
      category: "Playlist",
      shortcut: "alt+arrowup",
      allowRepeat: true,
      enabled: Boolean(canWrite && managedPlaylist && selectedMembership?.trackNumber !== 1),
      handler: () => {
        if (!managedPlaylist || !selectedMembership) return;
        applyMutation({
          type: "move-track",
          playlistId: managedPlaylist.id,
          membershipId: selectedMembership.membershipId,
          trackNumber: Math.max(1, selectedMembership.trackNumber - 1),
        });
      },
      when: () => !modalOpen,
    },
    {
      id: "move-playlist-track-down",
      label: "Move selected playlist track down",
      category: "Playlist",
      shortcut: "alt+arrowdown",
      allowRepeat: true,
      enabled: Boolean(
        canWrite &&
        managedPlaylist &&
        selectedMembership &&
        (managedPlaylist.trackCount === null ||
          selectedMembership.trackNumber < managedPlaylist.trackCount),
      ),
      handler: () => {
        if (!managedPlaylist || !selectedMembership) return;
        applyMutation({
          type: "move-track",
          playlistId: managedPlaylist.id,
          membershipId: selectedMembership.membershipId,
          trackNumber: Math.min(
            managedPlaylist.trackCount ?? selectedMembership.trackNumber + 1,
            selectedMembership.trackNumber + 1,
          ),
        });
      },
      when: () => !modalOpen,
    },
    {
      id: "remove-from-playlist",
      label: "Remove selected track from playlist",
      category: "Playlist",
      shortcut: "mod+delete",
      enabled: Boolean(canWrite && managedPlaylist && selectedMembership),
      handler: () => {
        if (!managedPlaylist || !selectedMembership) return;
        applyMutation({
          type: "remove-track",
          playlistId: managedPlaylist.id,
          membershipId: selectedMembership.membershipId,
        });
      },
      when: () => !modalOpen,
    },
    {
      id: "rename-playlist",
      label: "Rename current playlist",
      category: "Playlist",
      shortcut: "f2",
      enabled: Boolean(canWrite && managedPlaylist),
      handler: () => {
        if (managedPlaylist) setPlaylistDialog({ mode: "rename", playlist: managedPlaylist });
      },
      when: () => !modalOpen,
    },
    {
      id: "delete-playlist",
      label: "Delete current playlist…",
      category: "Playlist",
      shortcut: "mod+shift+delete",
      enabled: Boolean(canWrite && managedPlaylist),
      handler: () => {
        if (!managedPlaylist) return;
        setDeleteDialogPlaylist({
          ...managedPlaylist,
          expectedPlaylistIds: playlistSubtreeIds(playlists, managedPlaylist.id),
        });
      },
      when: () => !modalOpen,
    },
    {
      id: "shortcuts",
      label: "Show keyboard shortcuts",
      category: "Workspace",
      shortcut: "?",
      handler: () => setShortcutsOpen(true),
      when: () => !modalOpen,
    },
  ];
  useHotkeys(hotkeyBindings);
  const shortcutGroups = buildHotkeyPalette(hotkeyBindings);

  const selectedTitle =
    viewMode === "canvas"
      ? (canvasPlaylist?.name ?? "Set canvas")
      : (selectedPlaylist?.name ?? filterLabels[urlState.filter] ?? "All tracks");
  const addTrackToCanvas = (track: TrackSummary) => {
    const target = canvasPlaylist ?? normalPlaylist;
    if (!target) {
      setToast({
        tone: "error",
        message: "Open a normal playlist once to pin a set canvas before adding candidates.",
      });
      return;
    }
    if (target.id !== canvasPlaylist?.id) {
      canvasHydratedKeyRef.current = undefined;
      setCanvasState({ nodes: [], connections: [] });
      setCanvasExpectedMembershipIds([]);
      setCanvasFailedFingerprint(undefined);
      canvasQueuedFingerprintRef.current = undefined;
      setSelectedCanvasNodeId(undefined);
    }
    setCanvasPlaylistId(target.id);
    setPendingCanvasTrack(track);
    setViewMode("canvas");
  };

  const openPlaylistEditor = useCallback((playlist: PlaylistItem) => {
    if (playlist.type !== "playlist") return;
    setEditingPlaylistId(playlist.id);
    setEditorOpen(true);
  }, []);

  const syncCanvas = useCallback(() => {
    if (!canvasPlaylist || !canvasTracksQuery.data) return;
    canvasQueuedFingerprintRef.current = canvasFingerprint;
    setCanvasFailedFingerprint(undefined);
    applyMutation({
      type: "replace-playlist-tracks",
      playlistId: canvasPlaylist.id,
      contentIds: canvasContentIds,
      expectedMembershipIds: canvasExpectedMembershipIds,
    });
  }, [
    applyMutation,
    canvasContentIds,
    canvasExpectedMembershipIds,
    canvasFingerprint,
    canvasPlaylist,
    canvasTracksQuery.data,
  ]);

  useEffect(() => {
    if (!canvasDirty) {
      canvasQueuedFingerprintRef.current = undefined;
      return;
    }
    if (
      !canWrite ||
      canvasFailedFingerprint === canvasFingerprint ||
      canvasQueuedFingerprintRef.current === canvasFingerprint
    )
      return;
    const timeout = window.setTimeout(syncCanvas, 220);
    return () => window.clearTimeout(timeout);
  }, [canWrite, canvasDirty, canvasFailedFingerprint, canvasFingerprint, syncCanvas]);

  const contextEntries = useMemo<ContextMenuEntry[]>(() => {
    const target = contextMenu.value;
    if (!target) return [];
    if (target.kind === "playlist") {
      const playlist = target.playlist;
      return [
        { kind: "heading", label: playlist.name },
        {
          id: "open-playlist",
          label:
            playlist.type === "folder"
              ? target.folderExpanded
                ? "Collapse folder"
                : "Expand folder"
              : "Open playlist",
          icon: <Library size={14} />,
        },
        ...(playlist.type === "playlist"
          ? [
              {
                id: "edit-playlist",
                label: "Edit in split view",
                icon: <PanelRightOpen size={14} />,
              } satisfies ContextMenuEntry,
              {
                id: "open-canvas",
                label: "Build on set canvas",
                icon: <Workflow size={14} />,
              } satisfies ContextMenuEntry,
            ]
          : []),
        { kind: "separator" },
        {
          id: "create-child",
          label: playlist.type === "folder" ? "New playlist inside" : "New playlist",
          icon: <Plus size={14} />,
          disabled: !canWrite,
        },
        {
          id: "rename-playlist",
          label: "Rename",
          icon: <Pencil size={14} />,
          disabled: !canWrite || playlist.type === "smart",
        },
        {
          id: "delete-playlist",
          label: "Delete",
          icon: <Trash2 size={14} />,
          dangerous: true,
          disabled: !canWrite || playlist.type === "smart",
        },
      ];
    }
    const node =
      target.kind === "canvas-node"
        ? canvasState.nodes.find((candidate) => candidate.id === target.nodeId)
        : undefined;
    const track = target.kind === "track" ? target.track : node?.track;
    if (!track) return [];
    const inSelectedPlaylist = Boolean(
      normalPlaylist && track.playlistMembershipId && urlState.playlistId === normalPlaylist.id,
    );
    return [
      { kind: "heading", label: track.title },
      { id: "play-track", label: "Play", icon: <Play size={14} />, shortcut: "Space" },
      {
        id: "edit-track",
        label: "Edit metadata…",
        icon: <Pencil size={14} />,
        shortcut: "E",
        disabled: !canWrite,
      },
      {
        id: "add-canvas",
        label:
          target.kind === "canvas-node"
            ? "Already on canvas"
            : canvasPlaylist
              ? `Add to ${canvasPlaylist.name} canvas`
              : normalPlaylist
                ? `Add to ${normalPlaylist.name} canvas`
                : "Add to set canvas",
        icon: <Workflow size={14} />,
        disabled: target.kind === "canvas-node" || (!canvasPlaylist && !normalPlaylist),
      },
      ...(editingPlaylist
        ? [
            {
              id: "add-editing-playlist",
              label: `Add to ${editingPlaylist.name}`,
              icon: <Plus size={14} />,
              disabled: !canWrite,
            } satisfies ContextMenuEntry,
          ]
        : []),
      ...(normalPlaylist
        ? [
            inSelectedPlaylist
              ? ({
                  id: "remove-selected-playlist",
                  label: `Remove from ${normalPlaylist.name}`,
                  icon: <Trash2 size={14} />,
                  dangerous: true,
                  disabled: !canWrite,
                } satisfies ContextMenuEntry)
              : ({
                  id: "add-selected-playlist",
                  label: `Add to ${normalPlaylist.name}`,
                  icon: <Plus size={14} />,
                  disabled: !canWrite,
                } satisfies ContextMenuEntry),
          ]
        : []),
      { kind: "separator" },
      {
        id: "memory-cue",
        label: "Set memory cue at playhead",
        icon: <Flag size={14} />,
        disabled: !canWrite,
      },
      {
        id: "hot-cue",
        label: "Configure Hot Cue…",
        icon: <Sparkles size={14} />,
        disabled: !canWrite,
      },
      ...(target.kind === "canvas-node"
        ? [
            { kind: "separator" } satisfies ContextMenuEntry,
            {
              id: "remove-canvas-node",
              label: "Remove from canvas",
              icon: <X size={14} />,
              dangerous: true,
            } satisfies ContextMenuEntry,
          ]
        : []),
      ...(track.path
        ? [
            { kind: "separator" } satisfies ContextMenuEntry,
            {
              id: "copy-path",
              label: "Copy audio path",
              icon: <Copy size={14} />,
            } satisfies ContextMenuEntry,
          ]
        : []),
    ];
  }, [
    canWrite,
    canvasPlaylist,
    canvasState.nodes,
    contextMenu.value,
    editingPlaylist,
    normalPlaylist,
    urlState.playlistId,
  ]);

  const handleContextAction = async (id: string) => {
    const target = contextMenu.value;
    if (!target) return;
    if (target.kind === "playlist") {
      const playlist = target.playlist;
      if (id === "open-playlist") {
        if (playlist.type === "folder") target.toggleFolder?.();
        else {
          updateUrl({ playlistId: playlist.id, filter: "all", trackId: null });
          setViewMode("table");
        }
      } else if (id === "open-canvas" && playlist.type === "playlist") {
        updateUrl({ playlistId: playlist.id, filter: "all", trackId: null });
        openCanvas(playlist);
      } else if (id === "edit-playlist" && playlist.type === "playlist") {
        openPlaylistEditor(playlist);
      } else if (id === "create-child") {
        setPlaylistDialog({
          mode: "create",
          ...(playlist.type === "folder" ? { defaultParentId: playlist.id } : {}),
        });
      } else if (id === "rename-playlist") {
        setPlaylistDialog({ mode: "rename", playlist });
      } else if (id === "delete-playlist") {
        setDeleteDialogPlaylist({
          ...playlist,
          expectedPlaylistIds: playlistSubtreeIds(playlists, playlist.id),
        });
      }
      return;
    }
    const node =
      target.kind === "canvas-node"
        ? canvasState.nodes.find((candidate) => candidate.id === target.nodeId)
        : undefined;
    const track = target.kind === "track" ? target.track : node?.track;
    if (!track) return;
    if (id === "play-track") selectTrack(track, true);
    if (id === "edit-track") {
      selectTrack(track);
      setMetadataTarget(track);
    }
    if (id === "add-canvas") addTrackToCanvas(track);
    if (id === "add-editing-playlist" && editingPlaylist)
      applyMutation({ type: "add-track", playlistId: editingPlaylist.id, contentId: track.id });
    if (id === "add-selected-playlist" && normalPlaylist)
      applyMutation({ type: "add-track", playlistId: normalPlaylist.id, contentId: track.id });
    if (id === "remove-selected-playlist" && normalPlaylist && track.playlistMembershipId)
      applyMutation({
        type: "remove-track",
        playlistId: normalPlaylist.id,
        membershipId: track.playlistMembershipId,
      });
    if (id === "memory-cue") {
      selectTrack(track);
      const startSeconds =
        playerTrack?.id === track.id ? (playerRef.current?.getCurrentTime() ?? 0) : 0;
      openCueDialog({
        contentId: track.id,
        trackTitle: track.title,
        durationSeconds: track.durationSeconds,
        initial: { kind: "memory", startSeconds },
      });
    }
    if (id === "hot-cue") {
      selectTrack(track);
      const startSeconds =
        playerTrack?.id === track.id ? (playerRef.current?.getCurrentTime() ?? 0) : 0;
      let detail: Awaited<ReturnType<typeof getTrackDetail>>;
      try {
        detail = await queryClient.ensureQueryData({
          queryKey: ["track", track.id],
          queryFn: ({ signal }) => getTrackDetail(track.id, signal),
        });
      } catch (error) {
        setToast({ tone: "error", message: errorMessage(error) });
        return;
      }
      const occupied = new Set(detail.cues.flatMap((cue) => cue.slot ?? []));
      const slot = Array.from({ length: 16 }, (_, index) => (index + 1) as HotCueSlot).find(
        (candidate) => !occupied.has(candidate),
      );
      openCueDialog({
        contentId: track.id,
        trackTitle: track.title,
        durationSeconds: track.durationSeconds,
        initial: {
          kind: "hot",
          slot: slot ?? 1,
          startSeconds,
        },
      });
    }
    if (id === "remove-canvas-node" && node) {
      setCanvasState((current) => removeCanvasNode(current, node.id));
    }
    if (id === "copy-path" && track.path)
      void navigator.clipboard
        .writeText(track.path)
        .then(() => setToast({ tone: "success", message: "Audio path copied" }));
  };

  return (
    <div className={`workbench view-${viewMode}`}>
      <LibrarySidebar
        bootstrap={bootstrapQuery.data}
        items={playlists}
        selectedPlaylistId={urlState.playlistId}
        activeFilter={urlState.filter}
        loading={playlistsQuery.isLoading}
        open={sidebarOpen}
        canWrite={canWrite}
        onClose={() => setSidebarOpen(false)}
        onSelectPlaylist={(playlistId) => {
          updateUrl({ playlistId, trackId: null, ...(playlistId ? { filter: "all" } : {}) });
          setViewMode("table");
        }}
        onSelectFilter={(filter) => {
          updateUrl({ filter, playlistId: null, trackId: null });
          setViewMode("table");
        }}
        onCreatePlaylist={(defaultParentId) =>
          setPlaylistDialog({ mode: "create", defaultParentId })
        }
        onEditPlaylist={openPlaylistEditor}
        onPlaylistContextMenu={(point, playlist, returnFocus, folder) =>
          contextMenu.openAt(
            point,
            {
              kind: "playlist",
              playlist,
              ...(folder ? { folderExpanded: folder.expanded, toggleFolder: folder.toggle } : {}),
            },
            returnFocus,
          )
        }
      />

      {sidebarOpen ? (
        <button
          className="mobile-scrim"
          type="button"
          onClick={() => {
            setSidebarOpen(false);
          }}
          aria-label="Close open panel"
        />
      ) : null}

      <main className="library-main" id="library-content">
        <header className="topbar">
          <div className="topbar-leading">
            <button
              className="icon-button panel-open-button"
              type="button"
              onClick={() => setSidebarOpen(true)}
              aria-label="Open library browser"
              aria-expanded={sidebarOpen}
            >
              <Menu size={17} />
            </button>
            <nav className="breadcrumbs" aria-label="Breadcrumb">
              <span>
                <Library size={14} /> Library
              </span>
              <ChevronRight size={12} aria-hidden="true" />
              <strong>{selectedTitle}</strong>
            </nav>
          </div>
          <div className="topbar-actions">
            <button
              className={`split-editor-button ${editorOpen ? "is-active" : ""}`}
              type="button"
              onClick={() => {
                if (editorOpen) {
                  setEditorOpen(false);
                  return;
                }
                const target =
                  editingPlaylist ??
                  normalPlaylist ??
                  playlists.find((item) => item.type === "playlist");
                if (target) openPlaylistEditor(target);
                else
                  setToast({
                    tone: "error",
                    message: "Create a playlist before opening the editor.",
                  });
              }}
              aria-expanded={editorOpen}
              title={editorOpen ? "Collapse edit playlist" : "Open edit playlist"}
            >
              <PanelRightOpen size={14} />
              <span>{editorOpen && editingPlaylist ? editingPlaylist.name : "Edit playlist"}</span>
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={() => setShortcutsOpen(true)}
              title="Keyboard shortcuts (?)"
            >
              <Keyboard size={15} />
              <span className="sr-only">Keyboard shortcuts</span>
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={refreshAll}
              title="Refresh library"
            >
              <RefreshCw size={15} />
              <span className="sr-only">Refresh library</span>
            </button>
          </div>
        </header>

        <div className="player-dock">
          <PlayerPanel
            ref={playerRef}
            adapter={playerAdapter}
            track={playerTrack}
            cues={playerDetailQuery.data?.cues ?? []}
            canEditCues={canWrite}
            cueMutationPending={false}
            previousDisabled={!previousTrack}
            nextDisabled={!nextTrack}
            onPrevious={() => previousTrack && selectTrack(previousTrack, true)}
            onNext={() => nextTrack && selectTrack(nextTrack, true)}
            onReady={() => {
              if (autoPlayTrackId && autoPlayTrackId === playerTrack?.id) {
                setAutoPlayTrackId(undefined);
                void playerRef.current?.play();
              }
            }}
            onTimeChange={(seconds) => {
              playheadSecondsRef.current = seconds;
            }}
            onAddMemoryCue={(seconds) => quickCue("memory", seconds)}
            onAddHotCue={(slot, seconds) => quickCue("hot", seconds, slot)}
            onEditCue={(cue) =>
              openCueDialog({
                contentId: cue.contentId,
                trackTitle: playerTrack?.title ?? "Selected track",
                durationSeconds: playerTrack?.durationSeconds ?? null,
                cue,
              })
            }
            onDeleteCue={(cue) =>
              applyMutation({ type: "delete-cue", contentId: cue.contentId, cueId: cue.id })
            }
            onError={(error) => setToast({ tone: "error", message: error.message })}
          />
        </div>

        {bootstrapQuery.isError ? (
          <div className="connection-banner is-error" role="alert">
            <CircleAlert size={16} />
            <span>
              <strong>Local library unavailable.</strong> {errorMessage(bootstrapQuery.error)}
            </span>
            <button className="secondary-button compact-button" type="button" onClick={refreshAll}>
              Retry
            </button>
          </div>
        ) : rekordboxRunning ? (
          <div className="connection-banner is-warning">
            <Activity size={15} />
            <span>Browsing is available. Quit Rekordbox and rekordboxAgent to enable writes.</span>
          </div>
        ) : null}

        <div className={`workspace-split ${editorOpen && editingPlaylist ? "has-editor" : ""}`}>
          <section className="browser-workspace" aria-label={`Browsing ${selectedTitle}`}>
            {viewMode === "table" ? (
              <>
                <section className="search-toolbar" aria-label="Track search">
                  <label className="track-search">
                    <Search size={15} aria-hidden="true" />
                    <input
                      ref={searchRef}
                      value={searchInput}
                      onChange={(event) => setSearchInput(event.target.value)}
                      type="search"
                      placeholder="Search title, artist, album, genre…"
                      aria-label="Search tracks"
                    />
                    {searchInput ? (
                      <button
                        type="button"
                        onClick={() => setSearchInput("")}
                        aria-label="Clear track search"
                      >
                        <X size={14} />
                      </button>
                    ) : (
                      <kbd>/</kbd>
                    )}
                  </label>
                </section>

                <TrackTable
                  items={tracks}
                  count={tracksQuery.data?.count ?? 0}
                  limit={tracksQuery.data?.limit ?? PAGE_SIZE}
                  offset={tracksQuery.data?.offset ?? offset}
                  loading={tracksQuery.isLoading}
                  error={tracksQuery.isError ? errorMessage(tracksQuery.error) : undefined}
                  selectedTrackId={urlState.trackId}
                  ordered={Boolean(normalPlaylist)}
                  canWrite={
                    canWrite && (!sort || (sort.field === "position" && sort.direction === "asc"))
                  }
                  sort={sort}
                  onSort={(nextSort) => {
                    setSort(nextSort);
                    setOffset(0);
                  }}
                  onSelect={(track) => selectTrack(track)}
                  onActivate={(track) => selectTrack(track, true)}
                  onContextMenu={(point, track, returnFocus) =>
                    contextMenu.openAt(point, { kind: "track", track }, returnFocus)
                  }
                  onPage={setOffset}
                  onRetry={() => void tracksQuery.refetch()}
                  onMove={(track, trackNumber) => {
                    if (!normalPlaylist || !track.playlistMembershipId) return;
                    applyMutation({
                      type: "move-track",
                      playlistId: normalPlaylist.id,
                      membershipId: track.playlistMembershipId,
                      trackNumber,
                    });
                  }}
                />
              </>
            ) : canvasPlaylist ? (
              <div className="canvas-workspace">
                {canvasTracksQuery.isError ? (
                  <div className="table-message">
                    <CircleAlert size={20} />
                    <strong>Couldn’t load the playlist canvas</strong>
                    <span>{errorMessage(canvasTracksQuery.error)}</span>
                  </div>
                ) : (
                  <SetCanvas
                    nodes={canvasState.nodes}
                    connections={canvasState.connections}
                    selectedNodeId={selectedCanvasNodeId}
                    canWrite={canWrite}
                    onSelectNode={(nodeId) => {
                      setSelectedCanvasNodeId(nodeId ?? undefined);
                      const node = canvasState.nodes.find((candidate) => candidate.id === nodeId);
                      if (node) selectTrack(node.track);
                    }}
                    onNodesChange={(changes, options) => {
                      if (!options.commit) return;
                      setCanvasState((current) => ({
                        ...current,
                        nodes: current.nodes.map((node) => {
                          const change = changes.find((candidate) => candidate.nodeId === node.id);
                          return change ? { ...node, position: change.position } : node;
                        }),
                      }));
                    }}
                    onConnect={(intent) => {
                      setCanvasState((current) => ({
                        ...current,
                        connections: [
                          ...current.connections.filter(
                            (connection) => !intent.replaceConnectionIds.includes(connection.id),
                          ),
                          {
                            id: browserId("connection"),
                            fromNodeId: intent.fromNodeId,
                            toNodeId: intent.toNodeId,
                          },
                        ],
                      }));
                    }}
                    onDisconnect={(connectionId) => {
                      setCanvasState((current) => ({
                        ...current,
                        connections: current.connections.filter(
                          (connection) => connection.id !== connectionId,
                        ),
                      }));
                    }}
                    onRemoveNode={(nodeId) => {
                      setCanvasState((current) => removeCanvasNode(current, nodeId));
                    }}
                    onDropTrackIds={(trackIds, position) => {
                      const sources = [
                        ...tracks,
                        ...(canvasTracksQuery.data?.items ?? []),
                        ...(editingTracksQuery.data?.items ?? []),
                        ...(playerDetailQuery.data ? [playerDetailQuery.data] : []),
                      ];
                      setCanvasState((current) =>
                        trackIds.reduce((next, id, index) => {
                          const track = sources.find((candidate) => candidate.id === id);
                          return track
                            ? addCandidateNode(next, track, {
                                x: position.x + index * 32,
                                y: position.y + index * 32,
                              })
                            : next;
                        }, current),
                      );
                    }}
                    onNodeContextMenu={(nodeId, context) =>
                      contextMenu.openAt(context.client, { kind: "canvas-node", nodeId })
                    }
                  />
                )}
              </div>
            ) : (
              <div className="table-message">
                <Workflow size={22} />
                <strong>Open a normal playlist</strong>
                <span>The set canvas maps its connected track chain back to playlist order.</span>
              </div>
            )}
          </section>
          {editorOpen && editingPlaylist ? (
            <PlaylistEditor
              playlist={editingPlaylist}
              playlists={playlists}
              canWrite={canWrite}
              selectedTrackId={urlState.trackId}
              onClose={() => setEditorOpen(false)}
              onSelectPlaylist={(id) => setEditingPlaylistId(id)}
              onSelectTrack={selectTrack}
              onAddTracks={(contentIds, expectedMembershipIds) =>
                applyMutation({
                  type: "replace-playlist-tracks",
                  playlistId: editingPlaylist.id,
                  contentIds,
                  expectedMembershipIds,
                })
              }
              onRemoveTrack={(membershipId) =>
                applyMutation({
                  type: "remove-track",
                  playlistId: editingPlaylist.id,
                  membershipId,
                })
              }
              onMoveTrack={(membershipId, trackNumber) =>
                applyMutation({
                  type: "move-track",
                  playlistId: editingPlaylist.id,
                  membershipId,
                  trackNumber,
                })
              }
            />
          ) : null}
        </div>
      </main>

      <PlaylistDialog
        open={playlistDialog !== null}
        mode={playlistDialog?.mode ?? "create"}
        playlist={playlistDialog?.mode === "rename" ? playlistDialog.playlist : undefined}
        folders={playlists.filter((playlist) => playlist.type === "folder")}
        defaultParentId={
          playlistDialog?.mode === "create" ? playlistDialog.defaultParentId : undefined
        }
        pending={false}
        error={writes.isError ? errorMessage(writes.error) : undefined}
        onClose={() => {
          writes.reset();
          setPlaylistDialog(null);
        }}
        onSubmit={({ name, parentId, kind }) => {
          if (playlistDialog?.mode === "rename") {
            applyMutation({
              type: "rename-playlist",
              playlistId: playlistDialog.playlist.id,
              name,
            });
          } else {
            applyMutation({ type: "create-playlist", name, parentId, kind });
          }
        }}
      />

      <DeletePlaylistDialog
        open={Boolean(deleteDialogPlaylist)}
        playlist={deleteDialogPlaylist}
        pending={false}
        error={writes.isError ? errorMessage(writes.error) : undefined}
        onClose={() => {
          writes.reset();
          setDeleteDialogPlaylist(undefined);
        }}
        onConfirm={() => {
          if (deleteDialogPlaylist)
            applyMutation({
              type: "delete-playlist",
              playlistId: deleteDialogPlaylist.id,
              expectedPlaylistIds: deleteDialogPlaylist.expectedPlaylistIds,
            });
        }}
      />

      <CueDialog
        open={cueDialog !== null}
        cue={cueDialog && "cue" in cueDialog ? cueDialog.cue : undefined}
        initial={cueDialog && "initial" in cueDialog ? cueDialog.initial : undefined}
        targetTitle={cueDialog?.trackTitle}
        durationSeconds={cueDialog?.durationSeconds}
        pending={false}
        error={writes.isError ? errorMessage(writes.error) : undefined}
        onClose={() => {
          writes.reset();
          setCueDialog(null);
        }}
        onSubmit={(cue) => {
          if (!cueDialog) return;
          applyMutation({ type: "upsert-cue", contentId: cueDialog.contentId, cue });
        }}
      />

      <TrackMetadataDialog
        open={Boolean(metadataTarget)}
        targetTitle={metadataTarget?.title}
        track={
          metadataDetailQuery.data?.id === metadataTarget?.id ? metadataDetailQuery.data : undefined
        }
        loading={metadataDetailQuery.isLoading}
        error={metadataDetailQuery.isError ? errorMessage(metadataDetailQuery.error) : undefined}
        onClose={() => {
          writes.reset();
          setMetadataTarget(undefined);
        }}
        onSubmit={(metadata, expectedRevision) => {
          if (!metadataTarget) return;
          applyMutation({
            type: "update-track",
            contentId: metadataTarget.id,
            expectedRevision,
            metadata,
          });
          setMetadataTarget(undefined);
        }}
      />

      {shortcutsOpen ? (
        <div
          className="dialog-backdrop"
          role="presentation"
          onMouseDown={() => setShortcutsOpen(false)}
        >
          <section
            className="dialog-card shortcuts-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Keyboard shortcuts"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="dialog-header">
              <div>
                <span className="eyebrow">Keyboard</span>
                <h2>Work at deck speed</h2>
              </div>
              <button className="icon-button" type="button" onClick={() => setShortcutsOpen(false)}>
                <X size={17} />
                <span className="sr-only">Close keyboard shortcuts</span>
              </button>
            </header>
            <div className="dialog-body shortcut-groups">
              {shortcutGroups.map((group) => (
                <section key={group.category}>
                  <h3>{group.category}</h3>
                  {group.items.map((item) => (
                    <div className="shortcut-row" key={item.id}>
                      <span>{item.label}</span>
                      <span>
                        {item.shortcuts.map((shortcut) => (
                          <kbd key={shortcut}>{shortcut}</kbd>
                        ))}
                      </span>
                    </div>
                  ))}
                </section>
              ))}
            </div>
          </section>
        </div>
      ) : null}

      <ContextMenu
        open={contextMenu.open}
        point={contextMenu.point}
        entries={contextEntries}
        returnFocus={contextMenu.returnFocus}
        onClose={contextMenu.close}
        onSelect={(entry) => handleContextAction(entry.id)}
      />

      {toast ? <Toast message={toast.message} tone={toast.tone} onDismiss={dismissToast} /> : null}
    </div>
  );
}

function playlistSubtreeIds(playlists: readonly PlaylistItem[], rootId: string): string[] {
  const children = new Map<string, string[]>();
  for (const playlist of playlists) {
    const ids = children.get(playlist.parentId) ?? [];
    ids.push(playlist.id);
    children.set(playlist.parentId, ids);
  }
  const pending = [rootId];
  const visited = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return [...visited].sort();
}

function errorMessage(error: unknown): string {
  if (error instanceof LibraryApiError || error instanceof Error) return error.message;
  return String(error);
}

function browserId(prefix: string): string {
  return `${prefix}:${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function readCanvasState(key: string): CanvasState | undefined {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null") as CanvasState | null;
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.connections))
      return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function mergeCanvasState(tracks: TrackSummary[], stored?: CanvasState): CanvasState {
  const occurrences = new Map<string, number>();
  const storedById = new Map(stored?.nodes.map((node) => [node.id, node]) ?? []);
  const playlistNodes = tracks.map((track, index): SetCanvasNode => {
    const occurrence = occurrences.get(track.id) ?? 0;
    occurrences.set(track.id, occurrence + 1);
    const id = `playlist:${track.id}:${String(occurrence)}`;
    const existing = storedById.get(id);
    return {
      id,
      track,
      position: existing?.position ?? { x: 56 + index * 244, y: 72 + (index % 2) * 124 },
      kind: "playlist",
      playlistIndex: index,
      artworkUrl: `/api/artwork/${encodeURIComponent(track.id)}`,
    };
  });
  const playlistIds = new Set(playlistNodes.map((node) => node.id));
  const candidates =
    stored?.nodes.filter((node) => node.kind === "candidate" && !playlistIds.has(node.id)) ?? [];
  const nodes = [...playlistNodes, ...candidates];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const storedConnections =
    stored?.connections.filter(
      (connection) => nodeIds.has(connection.fromNodeId) && nodeIds.has(connection.toNodeId),
    ) ?? [];
  const connections = stored
    ? storedConnections
    : playlistNodes.slice(0, -1).map((node, index) => ({
        id: `initial:${node.id}`,
        fromNodeId: node.id,
        toNodeId: playlistNodes[index + 1]!.id,
      }));
  return { nodes, connections };
}

function addCandidateNode(
  state: CanvasState,
  track: TrackSummary,
  position?: CanvasPoint,
): CanvasState {
  const count = state.nodes.filter((node) => node.track.id === track.id).length;
  const node: SetCanvasNode = {
    id: browserId(`candidate:${track.id}:${String(count)}`),
    track,
    position: position ?? {
      x: 80 + (state.nodes.length % 4) * 236,
      y: 260 + Math.floor(state.nodes.length / 4) * 124,
    },
    kind: "candidate",
    artworkUrl: `/api/artwork/${encodeURIComponent(track.id)}`,
  };
  return { ...state, nodes: [...state.nodes, node] };
}

function removeCanvasNode(state: CanvasState, nodeId: string): CanvasState {
  return {
    nodes: state.nodes.filter((node) => node.id !== nodeId),
    connections: state.connections.filter(
      (connection) => connection.fromNodeId !== nodeId && connection.toNodeId !== nodeId,
    ),
  };
}
