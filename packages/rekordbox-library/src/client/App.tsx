import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AudioLines,
  ChevronRight,
  CircleAlert,
  Copy,
  Database,
  Flag,
  Keyboard,
  Library,
  ListFilter,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  PanelRightOpen,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Table2,
  Trash2,
  Workflow,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  HotCueSlot,
  LibraryMutation,
  PlaylistItem,
  PromptAction,
  TrackCue,
  TrackCueInput,
  TrackSummary,
} from "../shared/types.js";
import {
  getBootstrap,
  getAllTracks,
  getPlaylists,
  getTrackDetail,
  getTracks,
  LibraryApiError,
  mutateLibrary,
  planLibraryPrompt,
  subscribeLibraryEvents,
} from "./api.js";
import { ContextMenu, type ContextMenuEntry, useContextMenu } from "./components/ContextMenu.js";
import { CueDialog, DeletePlaylistDialog, PlaylistDialog, Toast } from "./components/Dialogs.js";
import { LibrarySidebar } from "./components/LibrarySidebar.js";
import { PlayerPanel, type PlayerPanelHandle } from "./components/PlayerPanel.js";
import { PromptDock } from "./components/PromptDock.js";
import {
  deriveConnectedOrder,
  playlistMembershipSnapshot,
  SetCanvas,
  type CanvasPoint,
  type SetCanvasConnection,
  type SetCanvasNode,
} from "./components/SetCanvas.js";
import { TrackInspector } from "./components/TrackInspector.js";
import { TrackTable } from "./components/TrackTable.js";
import { compactCount } from "./format.js";
import { buildHotkeyPalette, type HotkeyBinding, useHotkeys } from "./useHotkeys.js";
import { useLibraryUrlState } from "./url-state.js";

const PAGE_SIZE = 100;

const filterLabels: Record<string, string> = {
  all: "All tracks",
  analyzed: "Analyzed",
  attention: "Needs attention",
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

export function App() {
  const queryClient = useQueryClient();
  const { state: urlState, update: updateUrl } = useLibraryUrlState();
  const [offset, setOffset] = useState(0);
  const [searchInput, setSearchInput] = useState(urlState.query);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(Boolean(urlState.trackId));
  const [playlistDialog, setPlaylistDialog] = useState<PlaylistDialogState>(null);
  const [deleteDialogPlaylist, setDeleteDialogPlaylist] = useState<DeletePlaylistState>();
  const [cueDialog, setCueDialog] = useState<CueDialogState>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const [viewMode, setViewMode] = useState<"table" | "canvas">("table");
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [autoPlayTrackId, setAutoPlayTrackId] = useState<string>();
  const [canvasPlaylistId, setCanvasPlaylistId] = useState<string>();
  const [canvasState, setCanvasState] = useState<CanvasState>({ nodes: [], connections: [] });
  const [canvasExpectedMembershipIds, setCanvasExpectedMembershipIds] = useState<string[]>([]);
  const [canvasDirty, setCanvasDirty] = useState(false);
  const [selectedCanvasNodeId, setSelectedCanvasNodeId] = useState<string>();
  const [pendingCanvasTrack, setPendingCanvasTrack] = useState<TrackSummary>();
  const searchRef = useRef<HTMLInputElement>(null);
  const playerRef = useRef<PlayerPanelHandle>(null);
  const playheadSecondsRef = useRef<number | null>(null);
  const selectedTrackIdRef = useRef<string | null>(urlState.trackId);
  const canvasHydratedKeyRef = useRef<string | undefined>(undefined);
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
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });

  const canvasTracksQuery = useQuery({
    queryKey: ["canvas-tracks", canvasPlaylist?.id],
    queryFn: ({ signal }) =>
      getAllTracks(
        {
          playlistId: canvasPlaylist!.id,
          filter: "all",
        },
        signal,
      ),
    enabled: viewMode === "canvas" && Boolean(canvasPlaylist),
  });

  const tracks = tracksQuery.data?.items ?? [];
  const selectedSummary = useMemo(
    () =>
      tracks.find((track) => track.id === urlState.trackId) ??
      canvasState.nodes.find((node) => node.track.id === urlState.trackId)?.track,
    [canvasState.nodes, tracks, urlState.trackId],
  );
  const detailQuery = useQuery({
    queryKey: ["track", urlState.trackId],
    queryFn: ({ signal }) => getTrackDetail(urlState.trackId!, signal),
    enabled: Boolean(urlState.trackId),
  });

  const mutation = useMutation({
    mutationFn: (input: LibraryMutation) => {
      const token = bootstrapQuery.data?.csrfToken;
      if (!token) throw new Error("The local write token is unavailable. Refresh the workbench.");
      return mutateLibrary(token, input);
    },
    onSuccess: async (receipt, input) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["bootstrap"] }),
        queryClient.invalidateQueries({ queryKey: ["playlists"] }),
        queryClient.invalidateQueries({ queryKey: ["tracks"] }),
        queryClient.invalidateQueries({ queryKey: ["canvas-tracks"] }),
        queryClient.invalidateQueries({ queryKey: ["track"] }),
      ]);
      if (input.type === "create-playlist") {
        updateUrl({ playlistId: receipt.changedId, filter: "all", trackId: null });
      }
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
      if (input.type === "replace-playlist-tracks") setCanvasDirty(false);
      if (input.type === "upsert-cue") setCueDialog(null);
      setPlaylistDialog(null);
      setDeleteDialogPlaylist(undefined);
      setToast({
        tone: "success",
        message: `Library updated · verified ${receipt.quickCheck} · backup ${receipt.backupDirectory}`,
      });
    },
    onError: (error) => setToast({ tone: "error", message: errorMessage(error) }),
  });

  const processes = bootstrapQuery.data?.library.processes;
  const rekordboxRunning = Boolean(
    (processes?.rekordboxPid ?? 0) > 0 || (processes?.rekordboxAgentPid ?? 0) > 0,
  );
  const writeEnabled = bootstrapQuery.data?.library.writeEnabled === true;
  const writeReady = writeEnabled && !rekordboxRunning;
  const canWrite = writeReady && !mutation.isPending;

  const refreshAll = useCallback(() => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["bootstrap"] }),
      queryClient.invalidateQueries({ queryKey: ["playlists"] }),
      queryClient.invalidateQueries({ queryKey: ["tracks"] }),
      queryClient.invalidateQueries({ queryKey: ["canvas-tracks"] }),
      queryClient.invalidateQueries({ queryKey: ["track"] }),
    ]);
  }, [queryClient]);

  const assertWritable = useCallback(() => {
    if (!writeReady) {
      throw new Error(
        rekordboxRunning
          ? "Quit Rekordbox and rekordboxAgent before changing the library."
          : "Library writes are disabled; restart this workbench with --write.",
      );
    }
    if (mutation.isPending) throw new Error("Another protected library write is still running.");
  }, [mutation.isPending, rekordboxRunning, writeReady]);

  const applyMutationAsync = useCallback(
    async (input: LibraryMutation) => {
      assertWritable();
      return mutation.mutateAsync(input);
    },
    [assertWritable, mutation],
  );

  const applyMutation = useCallback(
    (input: LibraryMutation) => {
      void applyMutationAsync(input).catch(() => undefined);
    },
    [applyMutationAsync],
  );

  const openCueDialog = useCallback(
    (next: NonNullable<CueDialogState>) => {
      mutation.reset();
      setCueDialog(next);
    },
    [mutation],
  );

  const dismissToast = useCallback(() => setToast(null), []);

  const selectTrack = useCallback(
    (track: TrackSummary, autoplay = false) => {
      const sameTrack = selectedTrackIdRef.current === track.id;
      selectedTrackIdRef.current = track.id;
      updateUrl({ trackId: track.id });
      setInspectorOpen(true);
      if (!sameTrack) playheadSecondsRef.current = 0;
      if (autoplay && sameTrack) {
        setAutoPlayTrackId(undefined);
        void playerRef.current?.play();
      } else if (autoplay) {
        setAutoPlayTrackId(track.id);
      }
    },
    [updateUrl],
  );

  const quickCue = useCallback(
    (kind: "memory" | "hot", startSeconds: number, slot?: HotCueSlot) => {
      if (!urlState.trackId) {
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
      applyMutation({ type: "upsert-cue", contentId: urlState.trackId, cue });
    },
    [applyMutation, urlState.trackId],
  );

  useEffect(() => setSearchInput(urlState.query), [urlState.query]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (searchInput !== urlState.query)
        updateUrl({ query: searchInput, trackId: null }, { replace: true });
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [searchInput, updateUrl, urlState.query]);

  useEffect(() => setOffset(0), [urlState.filter, urlState.playlistId, urlState.query]);
  useEffect(() => setInspectorOpen(Boolean(urlState.trackId)), [urlState.trackId]);
  useEffect(() => {
    selectedTrackIdRef.current = urlState.trackId;
  }, [urlState.trackId]);

  useEffect(
    () =>
      subscribeLibraryEvents(() => {
        refreshAll();
      }),
    [refreshAll],
  );

  const canvasStorageKey = useMemo(() => {
    const dbPath = bootstrapQuery.data?.library.dbPath;
    return dbPath && canvasPlaylist
      ? `music-library:canvas:v2:${dbPath}:${canvasPlaylist.id}`
      : undefined;
  }, [bootstrapQuery.data?.library.dbPath, canvasPlaylist]);

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
    setCanvasDirty(false);
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
    setCanvasDirty(true);
    setPendingCanvasTrack(undefined);
  }, [canvasTracksQuery.data, pendingCanvasTrack, viewMode]);

  const playerTrack = detailQuery.data ?? selectedSummary;
  const playerIndex = tracks.findIndex((track) => track.id === playerTrack?.id);
  const previousTrack = playerIndex > 0 ? tracks[playerIndex - 1] : undefined;
  const nextTrack = playerIndex >= 0 ? tracks[playerIndex + 1] : undefined;

  const modalOpen = Boolean(
    playlistDialog || deleteDialogPlaylist || cueDialog || shortcutsOpen || contextMenu.open,
  );

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
        setCanvasDirty(false);
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
      category: "Library",
      shortcut: "mod+n",
      enabled: canWrite,
      handler: () => setPlaylistDialog({ mode: "create" }),
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
  const selectedDescription = selectedPlaylist
    ? selectedPlaylist.type === "smart"
      ? "Smart playlist · managed by Rekordbox rules"
      : `${compactCount(tracksQuery.data?.count)} tracks in playlist order`
    : descriptionForFilter(urlState.filter, bootstrapQuery.data?.library.stats);

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
      setCanvasDirty(false);
      setSelectedCanvasNodeId(undefined);
    }
    setCanvasPlaylistId(target.id);
    setPendingCanvasTrack(track);
    setViewMode("canvas");
  };

  const syncCanvas = () => {
    if (!canvasPlaylist || !canvasTracksQuery.data) return;
    const byId = new Map(canvasState.nodes.map((node) => [node.id, node]));
    const contentIds = deriveConnectedOrder(canvasState.nodes, canvasState.connections).flatMap(
      (nodeId) => {
        const node = byId.get(nodeId);
        return node ? [node.track.id] : [];
      },
    );
    applyMutation({
      type: "replace-playlist-tracks",
      playlistId: canvasPlaylist.id,
      contentIds,
      expectedMembershipIds: canvasExpectedMembershipIds,
    });
  };

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
    normalPlaylist,
    urlState.playlistId,
  ]);

  const handleContextAction = (id: string) => {
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
    if (id === "add-canvas") addTrackToCanvas(track);
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
      const occupied = new Set(
        detailQuery.data?.id === track.id
          ? detailQuery.data.cues.flatMap((cue) => cue.slot ?? [])
          : [],
      );
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
      setCanvasDirty(true);
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

      {sidebarOpen || inspectorOpen ? (
        <button
          className="mobile-scrim"
          type="button"
          onClick={() => {
            setSidebarOpen(false);
            if (inspectorOpen) {
              setInspectorOpen(false);
              updateUrl({ trackId: null });
            }
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
            {bootstrapQuery.isError ? (
              <span className="topbar-health is-error">
                <CircleAlert size={13} /> Offline
              </span>
            ) : rekordboxRunning ? (
              <span className="topbar-health is-warning">
                <Activity size={13} /> Read only · Rekordbox open
              </span>
            ) : writeEnabled ? (
              <span className="topbar-health is-ready">
                <ShieldCheck size={13} /> Safe writes ready
              </span>
            ) : (
              <span className="topbar-health">
                <Database size={13} /> Read only
              </span>
            )}
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
              disabled={tracksQuery.isFetching || bootstrapQuery.isFetching}
              title="Refresh library"
            >
              <RefreshCw
                size={15}
                className={tracksQuery.isFetching || bootstrapQuery.isFetching ? "spin" : ""}
              />
              <span className="sr-only">Refresh library</span>
            </button>
          </div>
        </header>

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
            <span>
              Browsing is available. Quit Rekordbox and rekordboxAgent for protected writes.
            </span>
          </div>
        ) : null}

        <section className="collection-toolbar">
          <div className="collection-title">
            <span className="collection-icon" aria-hidden="true">
              {viewMode === "canvas" ? (
                <Workflow size={18} />
              ) : urlState.filter === "attention" ? (
                <AudioLines size={18} />
              ) : (
                <Library size={18} />
              )}
            </span>
            <div>
              <h1>{selectedTitle}</h1>
              <p>
                {viewMode === "canvas"
                  ? "Visual set sequencing · connect tracks left to right"
                  : selectedDescription}
              </p>
            </div>
          </div>
          <div className="collection-actions">
            {normalPlaylist ? (
              <div className="view-switcher" role="group" aria-label="Playlist view">
                <button
                  type="button"
                  className={viewMode === "table" ? "is-active" : ""}
                  onClick={() => setViewMode("table")}
                  aria-pressed={viewMode === "table"}
                >
                  <Table2 size={14} /> Tracks
                </button>
                <button
                  type="button"
                  className={viewMode === "canvas" ? "is-active" : ""}
                  onClick={() => openCanvas(normalPlaylist)}
                  aria-pressed={viewMode === "canvas"}
                >
                  <Workflow size={14} /> Canvas
                </button>
              </div>
            ) : null}
            {selectedPlaylist && selectedPlaylist.type !== "smart" ? (
              <>
                <button
                  className="secondary-button action-label-button"
                  type="button"
                  disabled={!canWrite}
                  onClick={() => setPlaylistDialog({ mode: "rename", playlist: selectedPlaylist })}
                >
                  <Pencil size={14} /> <span>Rename</span>
                </button>
                <button
                  className="secondary-button action-label-button danger-hover"
                  type="button"
                  disabled={!canWrite}
                  onClick={() =>
                    setDeleteDialogPlaylist({
                      ...selectedPlaylist,
                      expectedPlaylistIds: playlistSubtreeIds(playlists, selectedPlaylist.id),
                    })
                  }
                >
                  <Trash2 size={14} /> <span>Delete</span>
                </button>
              </>
            ) : null}
            {viewMode === "canvas" && canvasPlaylist ? (
              <button
                className="primary-button action-label-button"
                type="button"
                disabled={!canWrite || !canvasDirty || !canvasTracksQuery.data}
                onClick={syncCanvas}
              >
                <ShieldCheck size={14} /> <span>Apply order</span>
              </button>
            ) : (
              <button
                className="primary-button action-label-button"
                type="button"
                disabled={!canWrite}
                onClick={() => setPlaylistDialog({ mode: "create" })}
              >
                <Plus size={14} /> <span>New playlist</span>
              </button>
            )}
            <button
              className="icon-button more-button"
              type="button"
              aria-label="More actions"
              disabled
            >
              <MoreHorizontal size={16} />
            </button>
          </div>
        </section>

        {viewMode === "table" ? (
          <>
            <section className="search-toolbar" aria-label="Track search and filters">
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
              <label className="filter-select">
                <ListFilter size={14} aria-hidden="true" />
                <span className="sr-only">Track filter</span>
                <select
                  value={urlState.filter}
                  onChange={(event) => updateUrl({ filter: event.target.value, trackId: null })}
                >
                  <option value="all">All tracks</option>
                  <option value="analyzed">Analyzed</option>
                  <option value="attention">Needs attention</option>
                </select>
              </label>
              {urlState.trackId ? (
                <button
                  className="secondary-button inspector-mobile-button"
                  type="button"
                  onClick={() => setInspectorOpen(true)}
                  aria-expanded={inspectorOpen}
                >
                  <PanelRightOpen size={14} /> Details
                </button>
              ) : null}
            </section>

            <TrackTable
              items={tracks}
              count={tracksQuery.data?.count ?? 0}
              limit={tracksQuery.data?.limit ?? PAGE_SIZE}
              offset={tracksQuery.data?.offset ?? offset}
              loading={tracksQuery.isLoading}
              fetching={tracksQuery.isFetching}
              error={tracksQuery.isError ? errorMessage(tracksQuery.error) : undefined}
              selectedTrackId={urlState.trackId}
              ordered={Boolean(normalPlaylist)}
              canWrite={canWrite}
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
                canWrite={!mutation.isPending}
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
                  setCanvasDirty(true);
                }}
                onDisconnect={(connectionId) => {
                  setCanvasState((current) => ({
                    ...current,
                    connections: current.connections.filter(
                      (connection) => connection.id !== connectionId,
                    ),
                  }));
                  setCanvasDirty(true);
                }}
                onRemoveNode={(nodeId) => {
                  setCanvasState((current) => removeCanvasNode(current, nodeId));
                  setCanvasDirty(true);
                }}
                onDropTrackIds={(trackIds, position) => {
                  const sources = [
                    ...tracks,
                    ...(canvasTracksQuery.data?.items ?? []),
                    ...(detailQuery.data ? [detailQuery.data] : []),
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
                  setCanvasDirty(true);
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

        <PromptDock
          playlistName={viewMode === "canvas" ? canvasPlaylist?.name : selectedPlaylist?.name}
          disabled={!bootstrapQuery.data}
          disabledReason="Waiting for the local library session"
          globalShortcutEnabled={!modalOpen}
          suggestions={[
            normalPlaylist ? `add current track to ${normalPlaylist.name}` : "open Oldschool",
            "search tracks for funky house",
            "set memory cue at playhead",
            "show set canvas",
          ]}
          onSubmit={async (submission) => {
            const token = bootstrapQuery.data?.csrfToken;
            if (!token) throw new Error("The local library session is not ready.");
            const plan = await planLibraryPrompt(token, submission.prompt, {
              playlistId: urlState.playlistId ?? canvasPlaylist?.id ?? null,
              trackId: urlState.trackId,
              playheadSeconds: playheadSecondsRef.current,
            });
            for (const action of plan.actions) {
              if (action.type === "open-playlist") {
                updateUrl({ playlistId: action.playlistId, filter: "all", trackId: null });
                setViewMode("table");
              } else if (action.type === "search-tracks") {
                setSearchInput(action.query);
                updateUrl({ query: action.query, playlistId: null, filter: "all", trackId: null });
                setViewMode("table");
              } else if (action.type === "show-canvas") {
                const target = normalPlaylist ?? canvasPlaylist;
                if (!target)
                  throw new Error("Open a normal playlist before showing its set canvas.");
                openCanvas(target);
              } else {
                await applyMutationAsync(action.mutation);
              }
            }
            return {
              summary: plan.summary,
              details: plan.actions.map((action: PromptAction) => action.label),
            };
          }}
        />
      </main>

      <TrackInspector
        open={inspectorOpen}
        summary={selectedSummary}
        detail={detailQuery.data}
        playlists={playlists}
        selectedPlaylistId={urlState.playlistId}
        loading={detailQuery.isLoading}
        error={detailQuery.isError ? errorMessage(detailQuery.error) : undefined}
        canWrite={canWrite}
        mutationPending={mutation.isPending}
        onClose={() => {
          setInspectorOpen(false);
          updateUrl({ trackId: null });
        }}
        onRetry={() => void detailQuery.refetch()}
        onAddTrack={(playlistId, contentId) =>
          applyMutation({ type: "add-track", playlistId, contentId })
        }
        onRemoveTrack={(playlistId, membershipId) =>
          applyMutation({ type: "remove-track", playlistId, membershipId })
        }
        onEditCue={(cue) =>
          openCueDialog({
            contentId: cue.contentId,
            trackTitle: detailQuery.data?.title ?? selectedSummary?.title ?? "Selected track",
            durationSeconds:
              detailQuery.data?.durationSeconds ?? selectedSummary?.durationSeconds ?? null,
            cue,
          })
        }
        onDeleteCue={(cue) =>
          applyMutation({ type: "delete-cue", contentId: cue.contentId, cueId: cue.id })
        }
        onNotice={(message) => setToast({ message, tone: "success" })}
      />

      <div className="player-dock">
        <PlayerPanel
          ref={playerRef}
          track={playerTrack}
          cues={detailQuery.data?.cues ?? []}
          canEditCues={canWrite}
          cueMutationPending={mutation.isPending}
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

      <PlaylistDialog
        open={playlistDialog !== null}
        mode={playlistDialog?.mode ?? "create"}
        playlist={playlistDialog?.mode === "rename" ? playlistDialog.playlist : undefined}
        folders={playlists.filter((playlist) => playlist.type === "folder")}
        defaultParentId={
          playlistDialog?.mode === "create" ? playlistDialog.defaultParentId : undefined
        }
        pending={mutation.isPending}
        error={mutation.isError ? errorMessage(mutation.error) : undefined}
        onClose={() => {
          if (!mutation.isPending) {
            mutation.reset();
            setPlaylistDialog(null);
          }
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
        pending={mutation.isPending}
        error={mutation.isError ? errorMessage(mutation.error) : undefined}
        onClose={() => {
          if (!mutation.isPending) {
            mutation.reset();
            setDeleteDialogPlaylist(undefined);
          }
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
        pending={mutation.isPending}
        error={mutation.isError ? errorMessage(mutation.error) : undefined}
        onClose={() => {
          if (mutation.isPending) return;
          mutation.reset();
          setCueDialog(null);
        }}
        onSubmit={(cue) => {
          if (!cueDialog) return;
          applyMutation({ type: "upsert-cue", contentId: cueDialog.contentId, cue });
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

      {mutation.isPending ? (
        <div className="mutation-indicator" role="status">
          <LoaderCircle size={14} className="spin" /> Backing up and verifying library…
        </div>
      ) : null}
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

function descriptionForFilter(
  filter: string,
  stats:
    | {
        tracks: number;
        analyzed: number;
        missingAnalysis: number;
        missingBpm: number;
        missingKey: number;
      }
    | undefined,
): string {
  if (!stats) return "Reading the local Rekordbox collection";
  if (filter === "analyzed")
    return `${compactCount(stats.analyzed)} tracks with Rekordbox analysis`;
  if (filter === "attention")
    return `${compactCount(stats.missingAnalysis)} missing analysis · ${compactCount(stats.missingBpm)} missing BPM · ${compactCount(stats.missingKey)} missing key`;
  return `${compactCount(stats.tracks)} tracks in the local Rekordbox collection`;
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
