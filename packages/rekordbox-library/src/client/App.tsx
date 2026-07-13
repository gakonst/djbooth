import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AudioLines,
  ChevronRight,
  CircleAlert,
  Database,
  Library,
  ListFilter,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  PanelRightOpen,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { LibraryMutation, PlaylistItem, TrackSummary } from "../shared/types.js";
import {
  getBootstrap,
  getPlaylists,
  getTrackDetail,
  getTracks,
  LibraryApiError,
  mutateLibrary,
} from "./api.js";
import { DeletePlaylistDialog, PlaylistDialog, Toast } from "./components/Dialogs.js";
import { LibrarySidebar } from "./components/LibrarySidebar.js";
import { TrackInspector } from "./components/TrackInspector.js";
import { TrackTable } from "./components/TrackTable.js";
import { compactCount } from "./format.js";
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

type ToastState = { message: string; tone: "success" | "error" } | null;

export function App() {
  const queryClient = useQueryClient();
  const { state: urlState, update: updateUrl } = useLibraryUrlState();
  const [offset, setOffset] = useState(0);
  const [searchInput, setSearchInput] = useState(urlState.query);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(Boolean(urlState.trackId));
  const [playlistDialog, setPlaylistDialog] = useState<PlaylistDialogState>(null);
  const [deleteDialogPlaylist, setDeleteDialogPlaylist] = useState<PlaylistItem>();
  const [toast, setToast] = useState<ToastState>(null);
  const searchRef = useRef<HTMLInputElement>(null);

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

  const selectedSummary = useMemo(
    () => tracksQuery.data?.items.find((track) => track.id === urlState.trackId),
    [tracksQuery.data?.items, urlState.trackId],
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
        queryClient.invalidateQueries({ queryKey: ["track"] }),
      ]);
      if (input.type === "create-playlist") {
        updateUrl({ playlistId: receipt.changedId, filter: "all", trackId: null });
      }
      if (input.type === "delete-playlist" && input.playlistId === urlState.playlistId) {
        updateUrl({ playlistId: null, filter: "all", trackId: null });
      }
      setPlaylistDialog(null);
      setDeleteDialogPlaylist(undefined);
      setToast({
        tone: "success",
        message: `Library updated · backup ${receipt.backupDirectory} · integrity ${receipt.quickCheck}`,
      });
    },
    onError: (error) => {
      setToast({ tone: "error", message: errorMessage(error) });
    },
  });

  useEffect(() => {
    setSearchInput(urlState.query);
  }, [urlState.query]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (searchInput !== urlState.query) {
        updateUrl({ query: searchInput, trackId: null }, { replace: true });
      }
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [searchInput, updateUrl, urlState.query]);

  useEffect(() => {
    setOffset(0);
  }, [urlState.filter, urlState.playlistId, urlState.query]);

  useEffect(() => {
    setInspectorOpen(Boolean(urlState.trackId));
  }, [urlState.trackId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "/" &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !isTextInput(event.target)
      ) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const processes = bootstrapQuery.data?.library.processes;
  const rekordboxRunning = Boolean(
    (processes?.rekordboxPid ?? 0) > 0 || (processes?.rekordboxAgentPid ?? 0) > 0,
  );
  const writeEnabled = bootstrapQuery.data?.library.writeEnabled === true;
  const canWrite = writeEnabled && !rekordboxRunning && !mutation.isPending;
  const tracks = tracksQuery.data?.items ?? [];
  const selectedTitle = selectedPlaylist?.name ?? filterLabels[urlState.filter] ?? "All tracks";
  const selectedDescription = selectedPlaylist
    ? selectedPlaylist.type === "smart"
      ? "Smart playlist · managed by Rekordbox rules"
      : `${compactCount(tracksQuery.data?.count)} tracks in playlist order`
    : descriptionForFilter(urlState.filter, bootstrapQuery.data?.library.stats);

  const selectTrack = (track: TrackSummary) => {
    updateUrl({ trackId: track.id });
    setInspectorOpen(true);
  };

  const applyMutation = (input: LibraryMutation) => {
    if (!canWrite) {
      setToast({
        tone: "error",
        message: rekordboxRunning
          ? "Quit Rekordbox and rekordboxAgent before changing the library."
          : "Library writes are disabled for this session.",
      });
      return;
    }
    mutation.mutate(input);
  };

  const refreshAll = useCallback(() => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["bootstrap"] }),
      queryClient.invalidateQueries({ queryKey: ["playlists"] }),
      queryClient.invalidateQueries({ queryKey: ["tracks"] }),
      queryClient.invalidateQueries({ queryKey: ["track"] }),
    ]);
  }, [queryClient]);

  return (
    <div className="workbench">
      <LibrarySidebar
        bootstrap={bootstrapQuery.data}
        items={playlists}
        selectedPlaylistId={urlState.playlistId}
        activeFilter={urlState.filter}
        loading={playlistsQuery.isLoading}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onSelectPlaylist={(playlistId) =>
          updateUrl({ playlistId, trackId: null, ...(playlistId ? { filter: "all" } : {}) })
        }
        onSelectFilter={(filter) => updateUrl({ filter, playlistId: null, trackId: null })}
        onCreatePlaylist={(defaultParentId) =>
          setPlaylistDialog({ mode: "create", defaultParentId })
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
              <strong>Local library unavailable.</strong>
              {errorMessage(bootstrapQuery.error)}
            </span>
            <button className="secondary-button compact-button" type="button" onClick={refreshAll}>
              Retry
            </button>
          </div>
        ) : rekordboxRunning ? (
          <div className="connection-banner is-warning">
            <Activity size={15} />
            <span>
              Browsing is available. Quit Rekordbox and rekordboxAgent to enable protected writes.
            </span>
          </div>
        ) : null}

        <section className="collection-toolbar">
          <div className="collection-title">
            <span className="collection-icon" aria-hidden="true">
              {urlState.filter === "attention" ? <AudioLines size={18} /> : <Library size={18} />}
            </span>
            <div>
              <h1>{selectedTitle}</h1>
              <p>{selectedDescription}</p>
            </div>
          </div>
          <div className="collection-actions">
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
                  onClick={() => setDeleteDialogPlaylist(selectedPlaylist)}
                >
                  <Trash2 size={14} /> <span>Delete</span>
                </button>
              </>
            ) : null}
            <button
              className="primary-button action-label-button"
              type="button"
              disabled={!canWrite}
              onClick={() => setPlaylistDialog({ mode: "create" })}
            >
              <Plus size={14} /> <span>New playlist</span>
            </button>
            <button
              className="icon-button more-button"
              type="button"
              aria-label="More collection actions"
              disabled
            >
              <MoreHorizontal size={16} />
            </button>
          </div>
        </section>

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
          ordered={Boolean(selectedPlaylist && selectedPlaylist.type === "playlist")}
          canWrite={canWrite}
          onSelect={selectTrack}
          onPage={setOffset}
          onRetry={() => void tracksQuery.refetch()}
          onMove={(track, trackNumber) => {
            if (!urlState.playlistId || !track.playlistMembershipId) return;
            applyMutation({
              type: "move-track",
              playlistId: urlState.playlistId,
              membershipId: track.playlistMembershipId,
              trackNumber,
            });
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
        onNotice={(message) => setToast({ message, tone: "success" })}
      />

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
          if (deleteDialogPlaylist) {
            applyMutation({ type: "delete-playlist", playlistId: deleteDialogPlaylist.id });
          }
        }}
      />

      {toast ? (
        <Toast message={toast.message} tone={toast.tone} onDismiss={() => setToast(null)} />
      ) : null}

      {mutation.isPending ? (
        <div className="mutation-indicator" role="status">
          <LoaderCircle size={14} className="spin" />
          Backing up and verifying library…
        </div>
      ) : null}
    </div>
  );
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

function isTextInput(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
