import { useQuery } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  CircleAlert,
  GripVertical,
  ListMusic,
  LoaderCircle,
  Trash2,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type { PlaylistItem, TrackSort, TrackSortField, TrackSummary } from "../../shared/types.js";
import { getAllTracks } from "../api.js";
import { formatBpm, formatDuration } from "../format.js";

const MIN_WIDTH = 300;
const MAX_WIDTH = 720;

type Props = {
  playlist: PlaylistItem;
  playlists: PlaylistItem[];
  canWrite: boolean;
  selectedTrackId: string | null;
  onClose(): void;
  onSelectPlaylist(id: string): void;
  onSelectTrack(track: TrackSummary, autoplay?: boolean): void;
  onAddTrack(contentId: string): void;
  onRemoveTrack(membershipId: string): void;
  onMoveTrack(membershipId: string, trackNumber: number): void;
};

export function PlaylistEditor({
  playlist,
  playlists,
  canWrite,
  selectedTrackId,
  onClose,
  onSelectPlaylist,
  onSelectTrack,
  onAddTrack,
  onRemoveTrack,
  onMoveTrack,
}: Props) {
  const [width, setWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem("music-library:playlist-editor-width"));
    return Number.isFinite(stored) && stored >= MIN_WIDTH ? stored : 380;
  });
  const [sort, setSort] = useState<TrackSort>({ field: "position", direction: "asc" });
  const resizeRef = useRef<{ x: number; width: number } | undefined>(undefined);
  const query = useQuery({
    queryKey: ["editor-tracks", playlist.id],
    queryFn: ({ signal }) => getAllTracks({ playlistId: playlist.id, filter: "all" }, signal),
  });
  const items = useMemo(() => sortEditorTracks(query.data?.items ?? [], sort), [query.data, sort]);
  const orderVisible = sort.field === "position" && sort.direction === "asc";

  const resize = (clientX: number) => {
    const start = resizeRef.current;
    if (!start) return width;
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, start.width + start.x - clientX));
    setWidth(next);
    return next;
  };

  return (
    <aside
      className="playlist-editor"
      style={{ "--playlist-editor-width": `${String(width)}px` } as React.CSSProperties}
      aria-label={`Editing ${playlist.name}`}
      onDragOver={(event) => {
        if (!canWrite) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        if (!canWrite) return;
        event.preventDefault();
        for (const id of droppedTrackIds(event.dataTransfer)) onAddTrack(id);
      }}
    >
      <div
        className="playlist-editor-resize"
        role="separator"
        aria-label="Resize edit playlist"
        aria-orientation="vertical"
        tabIndex={0}
        onPointerDown={(event) => {
          resizeRef.current = { x: event.clientX, width };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => resize(event.clientX)}
        onPointerUp={(event) => {
          const next = resize(event.clientX);
          resizeRef.current = undefined;
          event.currentTarget.releasePointerCapture(event.pointerId);
          window.localStorage.setItem("music-library:playlist-editor-width", String(next));
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const next = Math.min(
            MAX_WIDTH,
            Math.max(MIN_WIDTH, width + (event.key === "ArrowLeft" ? 24 : -24)),
          );
          setWidth(next);
          window.localStorage.setItem("music-library:playlist-editor-width", String(next));
        }}
      />

      <header className="playlist-editor-header">
        <span className="playlist-editor-mark" aria-hidden="true">
          <ListMusic size={14} />
        </span>
        <label className="playlist-editor-title">
          <span>Editing playlist</span>
          <select value={playlist.id} onChange={(event) => onSelectPlaylist(event.target.value)}>
            {playlists
              .filter((item) => item.type === "playlist")
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
          </select>
        </label>
        <span className="playlist-editor-count">
          {String(query.data?.count ?? playlist.trackCount ?? 0)}
        </span>
        <button
          className="icon-button"
          type="button"
          onClick={onClose}
          title="Collapse edit playlist"
          aria-label="Collapse edit playlist"
        >
          <ChevronLeft size={16} />
        </button>
      </header>

      <div className="playlist-editor-drop-hint">
        <GripVertical size={12} /> Drag tracks here while browsing
      </div>

      <div className="playlist-editor-scroll">
        {query.isLoading ? (
          <div className="playlist-editor-message">
            <LoaderCircle size={18} className="spin" /> Loading playlist
          </div>
        ) : query.isError ? (
          <div className="playlist-editor-message is-error">
            <CircleAlert size={18} /> Couldn’t load playlist
          </div>
        ) : items.length === 0 ? (
          <div className="playlist-editor-message">
            <ListMusic size={20} /> Drop tracks here
          </div>
        ) : (
          <table className="playlist-editor-table">
            <thead>
              <tr>
                <EditorSortHeader label="#" field="position" sort={sort} onSort={setSort} />
                <EditorSortHeader label="Title" field="title" sort={sort} onSort={setSort} />
                <EditorSortHeader label="BPM" field="bpm" sort={sort} onSort={setSort} />
                <EditorSortHeader label="Key" field="key" sort={sort} onSort={setSort} />
                <EditorSortHeader label="Time" field="duration" sort={sort} onSort={setSort} />
                <th scope="col">
                  <span className="sr-only">Edit order</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((track) => {
                const trackNumber = track.trackNumber ?? 0;
                return (
                  <tr
                    key={track.playlistMembershipId ?? `${track.id}:${String(trackNumber)}`}
                    className={track.id === selectedTrackId ? "is-selected" : ""}
                    onClick={() => onSelectTrack(track)}
                    onDoubleClick={() => onSelectTrack(track, true)}
                  >
                    <td>{String(trackNumber)}</td>
                    <td>
                      <strong title={track.title}>{track.title}</strong>
                      <span title={track.artist ?? undefined}>
                        {track.artist ?? "Unknown artist"}
                      </span>
                    </td>
                    <td>{formatBpm(track.bpm)}</td>
                    <td>{track.key ?? "—"}</td>
                    <td>{formatDuration(track.durationSeconds)}</td>
                    <td>
                      {track.playlistMembershipId ? (
                        <span className="playlist-editor-actions">
                          <button
                            type="button"
                            disabled={!canWrite || !orderVisible || trackNumber <= 1}
                            onClick={(event) => {
                              event.stopPropagation();
                              onMoveTrack(track.playlistMembershipId!, trackNumber - 1);
                            }}
                            aria-label={`Move ${track.title} up`}
                          >
                            <ArrowUp size={11} />
                          </button>
                          <button
                            type="button"
                            disabled={!canWrite || !orderVisible || trackNumber >= items.length}
                            onClick={(event) => {
                              event.stopPropagation();
                              onMoveTrack(track.playlistMembershipId!, trackNumber + 1);
                            }}
                            aria-label={`Move ${track.title} down`}
                          >
                            <ArrowDown size={11} />
                          </button>
                          <button
                            className="is-danger"
                            type="button"
                            disabled={!canWrite}
                            onClick={(event) => {
                              event.stopPropagation();
                              onRemoveTrack(track.playlistMembershipId!);
                            }}
                            aria-label={`Remove ${track.title} from ${playlist.name}`}
                          >
                            <Trash2 size={11} />
                          </button>
                        </span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </aside>
  );
}

function EditorSortHeader({
  label,
  field,
  sort,
  onSort,
}: {
  label: string;
  field: TrackSortField;
  sort: TrackSort;
  onSort(sort: TrackSort): void;
}) {
  const active = sort.field === field;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}
    >
      <button
        type="button"
        className={active ? "is-active" : ""}
        onClick={() =>
          onSort({ field, direction: active && sort.direction === "asc" ? "desc" : "asc" })
        }
      >
        {label}
      </button>
    </th>
  );
}

function sortEditorTracks(items: readonly TrackSummary[], sort: TrackSort): TrackSummary[] {
  const value = (track: TrackSummary): string | number | null => {
    if (sort.field === "position") return track.trackNumber ?? null;
    if (sort.field === "title") return track.title;
    if (sort.field === "bpm") return track.bpm;
    if (sort.field === "key") return track.key;
    if (sort.field === "duration") return track.durationSeconds;
    return track.title;
  };
  const direction = sort.direction === "desc" ? -1 : 1;
  return [...items].sort((left, right) => {
    const a = value(left);
    const b = value(right);
    const result =
      a === null
        ? b === null
          ? 0
          : 1
        : b === null
          ? -1
          : typeof a === "number" && typeof b === "number"
            ? a - b
            : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
    return direction * result || left.title.localeCompare(right.title);
  });
}

function droppedTrackIds(data: DataTransfer): string[] {
  for (const type of ["application/x-rekordbox-track-ids", "application/x-rekordbox-track-id"]) {
    const value = data.getData(type);
    if (!value) continue;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed))
        return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
    } catch {
      return [value];
    }
  }
  const fallback = data.getData("text/plain");
  return fallback ? [fallback] : [];
}
