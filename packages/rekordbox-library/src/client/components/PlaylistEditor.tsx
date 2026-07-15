import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  CircleAlert,
  GripVertical,
  ListMusic,
  LoaderCircle,
  Trash2,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type { PlaylistItem, TrackSort, TrackSortField, TrackSummary } from "../../shared/types.js";
import { formatBpm, formatDuration } from "../format.js";
import { playlistTracksQueryOptions } from "../library-queries.js";
import { isOptimisticPlaylistId } from "../optimistic-library.js";
import { playlistDropTrackNumber } from "./playlist-order.js";
import { HostedTrackStatus } from "./TrackTable.js";
import { TrackWaveformPreview } from "./TrackWaveformPreview.js";

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
  onAddTracks(contentIds: string[], expectedMembershipIds: string[]): void;
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
  onAddTracks,
  onRemoveTrack,
  onMoveTrack,
}: Props) {
  const [width, setWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem("music-library:playlist-editor-width"));
    return Number.isFinite(stored) && stored >= MIN_WIDTH ? stored : 380;
  });
  const [sort, setSort] = useState<TrackSort>({ field: "position", direction: "asc" });
  const [draggedTrack, setDraggedTrack] = useState<{
    membershipId: string;
    trackNumber: number;
  }>();
  const [dropTarget, setDropTarget] = useState<{
    membershipId: string;
    placement: "before" | "after";
  }>();
  const resizeRef = useRef<{ x: number; width: number } | undefined>(undefined);
  const query = useQuery({
    ...playlistTracksQueryOptions(playlist.id),
    enabled: !isOptimisticPlaylistId(playlist.id),
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
        if (!canWrite || !query.data) return;
        if (event.dataTransfer.getData("application/x-rekordbox-editor-membership-id")) return;
        event.preventDefault();
        const addedIds = droppedTrackIds(event.dataTransfer);
        if (!addedIds.length) return;
        onAddTracks(
          [...query.data.items.map((track) => track.id), ...addedIds],
          query.data.items.flatMap((track) => track.playlistMembershipId ?? []),
        );
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
                  {item.hosted
                    ? `${item.name} · ${item.hosted.provider === "spotify" ? "Spotify" : "SoundCloud"}`
                    : item.name}
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
        {canWrite ? (
          <>
            <GripVertical size={12} /> Drop tracks from the library · drag rows to reorder
          </>
        ) : (
          <>
            <ListMusic size={12} /> Read-only provider playlist
          </>
        )}
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
            <ListMusic size={20} /> {canWrite ? "Drop tracks here" : "No tracks"}
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
                    className={[
                      track.id === selectedTrackId ? "is-selected" : "",
                      dropTarget && dropTarget.membershipId === track.playlistMembershipId
                        ? `is-drop-${dropTarget.placement}`
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    tabIndex={0}
                    draggable={Boolean(canWrite && orderVisible && track.playlistMembershipId)}
                    onClick={() => onSelectTrack(track)}
                    onDoubleClick={() => onSelectTrack(track, true)}
                    onDragStart={(event) => {
                      if (!track.playlistMembershipId || !orderVisible) return;
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData(
                        "application/x-rekordbox-playlist-membership-id",
                        track.playlistMembershipId,
                      );
                      event.dataTransfer.setData(
                        "application/x-rekordbox-editor-membership-id",
                        track.playlistMembershipId,
                      );
                      event.dataTransfer.setData(
                        "application/x-rekordbox-track-ids",
                        JSON.stringify([track.id]),
                      );
                      setDraggedTrack({
                        membershipId: track.playlistMembershipId,
                        trackNumber,
                      });
                    }}
                    onDragOver={(event) => {
                      if (
                        !draggedTrack ||
                        !track.playlistMembershipId ||
                        track.playlistMembershipId === draggedTrack.membershipId
                      )
                        return;
                      event.preventDefault();
                      event.stopPropagation();
                      event.dataTransfer.dropEffect = "move";
                      const bounds = event.currentTarget.getBoundingClientRect();
                      setDropTarget({
                        membershipId: track.playlistMembershipId,
                        placement:
                          event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
                      });
                    }}
                    onDrop={(event) => {
                      if (
                        !draggedTrack ||
                        !dropTarget ||
                        dropTarget.membershipId !== track.playlistMembershipId
                      )
                        return;
                      const placement = dropTarget.placement;
                      event.preventDefault();
                      event.stopPropagation();
                      onMoveTrack(
                        draggedTrack.membershipId,
                        playlistDropTrackNumber(
                          draggedTrack.trackNumber,
                          trackNumber,
                          placement,
                          items.length,
                        ),
                      );
                      setDraggedTrack(undefined);
                      setDropTarget(undefined);
                    }}
                    onDragEnd={() => {
                      setDraggedTrack(undefined);
                      setDropTarget(undefined);
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.altKey &&
                        canWrite &&
                        orderVisible &&
                        track.playlistMembershipId &&
                        (event.key === "ArrowUp" || event.key === "ArrowDown")
                      ) {
                        event.preventDefault();
                        onMoveTrack(
                          track.playlistMembershipId,
                          Math.min(
                            items.length,
                            Math.max(1, trackNumber + (event.key === "ArrowUp" ? -1 : 1)),
                          ),
                        );
                      }
                    }}
                  >
                    <td>{String(trackNumber)}</td>
                    <td>
                      <div className="playlist-editor-track-copy">
                        <span className="playlist-editor-waveform-wrap">
                          {track.hosted && !track.hosted.localContentId ? (
                            <HostedTrackStatus track={track} />
                          ) : (
                            <TrackWaveformPreview
                              trackId={track.hosted?.localContentId ?? track.id}
                              className="playlist-editor-waveform"
                            />
                          )}
                        </span>
                        <span>
                          <strong title={track.title}>{track.title}</strong>
                          <span title={track.artist ?? undefined}>
                            {track.artist ?? "Unknown artist"}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td>{formatBpm(track.bpm)}</td>
                    <td>{track.key ?? "—"}</td>
                    <td>{formatDuration(track.durationSeconds)}</td>
                    <td>
                      {track.playlistMembershipId ? (
                        <span className="playlist-editor-actions">
                          <span
                            className={`playlist-editor-drag-handle ${canWrite && orderVisible ? "" : "is-disabled"}`}
                            aria-hidden="true"
                            title={
                              orderVisible
                                ? "Drag to reorder · Alt+↑/↓"
                                : "Sort by position to reorder"
                            }
                          >
                            <GripVertical size={13} />
                          </span>
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

export function sortEditorTracks(items: readonly TrackSummary[], sort: TrackSort): TrackSummary[] {
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
    if (a === null) return b === null ? left.title.localeCompare(right.title) : 1;
    if (b === null) return -1;
    const result =
      typeof a === "number" && typeof b === "number"
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
