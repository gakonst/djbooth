import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  GripVertical,
  Music,
} from "lucide-react";
import { useState } from "react";

import type { TrackSort, TrackSortField, TrackSummary } from "../../shared/types.js";
import { formatBpm, formatDuration } from "../format.js";
import { playlistDropTrackNumber } from "./playlist-order.js";
import { TrackWaveformPreview } from "./TrackWaveformPreview.js";

type Props = {
  items: TrackSummary[];
  count: number;
  limit: number;
  offset: number;
  loading: boolean;
  error?: string;
  selectedTrackId: string | null;
  ordered: boolean;
  canWrite: boolean;
  sort?: TrackSort;
  onSelect(track: TrackSummary): void;
  onActivate?(track: TrackSummary): void;
  onContextMenu?(
    point: { x: number; y: number },
    track: TrackSummary,
    returnFocus: HTMLElement,
  ): void;
  onPage(offset: number): void;
  onMove?(track: TrackSummary, trackNumber: number): void;
  onSort(sort: TrackSort): void;
  onRetry(): void;
};

export function TrackTable({
  items,
  count,
  limit,
  offset,
  loading,
  error,
  selectedTrackId,
  ordered,
  canWrite,
  sort,
  onSelect,
  onActivate,
  onContextMenu,
  onPage,
  onMove,
  onSort,
  onRetry,
}: Props) {
  const first = count === 0 ? 0 : offset + 1;
  const last = Math.min(offset + items.length, count);
  const [draggedTrack, setDraggedTrack] = useState<{
    membershipId: string;
    trackNumber: number;
  }>();
  const [dropTarget, setDropTarget] = useState<{
    membershipId: string;
    placement: "before" | "after";
  }>();
  const canReorder = ordered && canWrite && Boolean(onMove);

  return (
    <section className="track-table-shell" aria-label="Tracks">
      <div className="track-table-scroll">
        <table className="track-table">
          <thead>
            <tr>
              <th
                className="track-number-column"
                scope="col"
                aria-sort={sortAria(sort, "position")}
              >
                {ordered ? (
                  <SortButton label="#" field="position" sort={sort} onSort={onSort} />
                ) : (
                  <span aria-hidden="true">#</span>
                )}
              </th>
              <th className="title-column" scope="col" aria-sort={sortAria(sort, "title")}>
                <SortButton label="Title" field="title" sort={sort} onSort={onSort} />
              </th>
              <th className="album-column" scope="col" aria-sort={sortAria(sort, "album")}>
                <SortButton label="Album" field="album" sort={sort} onSort={onSort} />
              </th>
              <th className="genre-column" scope="col" aria-sort={sortAria(sort, "genre")}>
                <SortButton label="Genre" field="genre" sort={sort} onSort={onSort} />
              </th>
              <th className="bpm-column numeric" scope="col" aria-sort={sortAria(sort, "bpm")}>
                <SortButton label="BPM" field="bpm" sort={sort} onSort={onSort} align="end" />
              </th>
              <th className="key-column" scope="col" aria-sort={sortAria(sort, "key")}>
                <SortButton label="Key" field="key" sort={sort} onSort={onSort} />
              </th>
              <th
                className="duration-column numeric"
                scope="col"
                aria-sort={sortAria(sort, "duration")}
              >
                <SortButton label="Time" field="duration" sort={sort} onSort={onSort} align="end" />
              </th>
              {ordered ? (
                <th className="reorder-column" scope="col">
                  <span className="sr-only">Reorder</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <TrackRowsSkeleton ordered={ordered} />
            ) : error ? (
              <tr>
                <td colSpan={ordered ? 8 : 7}>
                  <TableMessage
                    icon={<CircleAlert size={20} />}
                    title="Couldn’t read the library"
                    detail={error}
                    action="Try again"
                    onAction={onRetry}
                  />
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td colSpan={ordered ? 8 : 7}>
                  <TableMessage
                    icon={<Music size={21} />}
                    title="No tracks here"
                    detail="Try another playlist, filter, or search."
                  />
                </td>
              </tr>
            ) : (
              items.map((track, index) => {
                const selected = track.id === selectedTrackId;
                const trackNumber = track.trackNumber ?? offset + index + 1;
                return (
                  <tr
                    key={`${track.id}:${track.playlistMembershipId ?? "library"}`}
                    className={[
                      selected ? "is-selected" : "",
                      dropTarget && dropTarget.membershipId === track.playlistMembershipId
                        ? `is-drop-${dropTarget.placement}`
                        : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    aria-selected={selected}
                    tabIndex={0}
                    draggable
                    onClick={() => onSelect(track)}
                    onDoubleClick={() => onActivate?.(track)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      onContextMenu?.(
                        { x: event.clientX, y: event.clientY },
                        track,
                        event.currentTarget,
                      );
                    }}
                    onDragStart={(event) => {
                      const ids = JSON.stringify([track.id]);
                      event.dataTransfer.effectAllowed = canReorder ? "copyMove" : "copy";
                      event.dataTransfer.setData("application/x-rekordbox-track-ids", ids);
                      event.dataTransfer.setData("application/x-rekordbox-track-id", track.id);
                      event.dataTransfer.setData("text/plain", track.id);
                      if (canReorder && track.playlistMembershipId) {
                        event.dataTransfer.setData(
                          "application/x-rekordbox-playlist-membership-id",
                          track.playlistMembershipId,
                        );
                        setDraggedTrack({
                          membershipId: track.playlistMembershipId,
                          trackNumber,
                        });
                      }
                    }}
                    onDragOver={(event) => {
                      if (
                        !draggedTrack ||
                        !track.playlistMembershipId ||
                        track.playlistMembershipId === draggedTrack.membershipId
                      )
                        return;
                      event.preventDefault();
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
                      onMove?.(
                        items.find(
                          (candidate) =>
                            candidate.playlistMembershipId === draggedTrack.membershipId,
                        ) ?? track,
                        playlistDropTrackNumber(
                          draggedTrack.trackNumber,
                          trackNumber,
                          placement,
                          count,
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
                      if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
                        event.preventDefault();
                        const bounds = event.currentTarget.getBoundingClientRect();
                        onContextMenu?.(
                          { x: bounds.left + 32, y: bounds.bottom },
                          track,
                          event.currentTarget,
                        );
                        return;
                      }
                      if (
                        event.altKey &&
                        canReorder &&
                        track.playlistMembershipId &&
                        (event.key === "ArrowUp" || event.key === "ArrowDown")
                      ) {
                        event.preventDefault();
                        onMove?.(
                          track,
                          Math.min(
                            count,
                            Math.max(1, trackNumber + (event.key === "ArrowUp" ? -1 : 1)),
                          ),
                        );
                        return;
                      }
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(track);
                      }
                    }}
                  >
                    <td className="track-number-column numeric muted-cell">{trackNumber}</td>
                    <td className="title-column">
                      <div className="track-title-cell">
                        {selected && ordered ? (
                          <span className="track-waveform-preview-wrap">
                            <TrackWaveformPreview
                              trackId={track.id}
                              className="track-waveform-preview"
                            />
                          </span>
                        ) : (
                          <span className="track-file-icon" aria-hidden="true">
                            <Music size={14} />
                          </span>
                        )}
                        <span className="track-primary-copy">
                          <strong title={track.title}>{track.title || "Untitled"}</strong>
                          <span title={track.artist ?? undefined}>
                            {track.artist ?? "Unknown artist"}
                          </span>
                        </span>
                      </div>
                    </td>
                    <td className="album-column truncate-cell" title={track.album ?? undefined}>
                      {track.album ?? "—"}
                    </td>
                    <td className="genre-column truncate-cell" title={track.genre ?? undefined}>
                      {track.genre ?? "—"}
                    </td>
                    <td className="bpm-column numeric tabular">{formatBpm(track.bpm)}</td>
                    <td className="key-column">
                      {track.key ? <span className="key-chip">{track.key}</span> : <span>—</span>}
                    </td>
                    <td className="duration-column numeric tabular muted-cell">
                      {formatDuration(track.durationSeconds)}
                    </td>
                    {ordered ? (
                      <td className="reorder-column">
                        {track.playlistMembershipId ? (
                          <span
                            className={`track-drag-handle ${canReorder ? "" : "is-disabled"}`}
                            aria-hidden="true"
                            title={
                              canReorder
                                ? "Drag to reorder · Alt+↑/↓"
                                : "Sort by position to reorder"
                            }
                          >
                            <GripVertical size={15} />
                          </span>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <footer className="table-pagination" aria-label="Track pagination">
        <span className="pagination-summary">
          {count === 0 ? "No tracks" : `${String(first)}–${String(last)} of ${String(count)}`}
        </span>
        <span className="pagination-buttons">
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={offset === 0}
            onClick={() => onPage(Math.max(0, offset - limit))}
          >
            <ChevronLeft size={14} /> Previous
          </button>
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={offset + limit >= count}
            onClick={() => onPage(offset + limit)}
          >
            Next <ChevronRight size={14} />
          </button>
        </span>
      </footer>
    </section>
  );
}

function SortButton({
  label,
  field,
  sort,
  onSort,
  align = "start",
}: {
  label: string;
  field: TrackSortField;
  sort?: TrackSort;
  onSort(sort: TrackSort): void;
  align?: "start" | "end";
}) {
  const active = sort?.field === field;
  const direction = active && sort.direction === "asc" ? "desc" : "asc";
  return (
    <button
      className={`table-sort-button is-${align} ${active ? "is-active" : ""}`}
      type="button"
      onClick={() => onSort({ field, direction })}
      title={`Sort by ${label}`}
    >
      <span>{label}</span>
      {active ? (
        sort.direction === "asc" ? (
          <ArrowUp size={10} />
        ) : (
          <ArrowDown size={10} />
        )
      ) : (
        <ArrowUpDown size={10} />
      )}
    </button>
  );
}

function sortAria(sort: TrackSort | undefined, field: TrackSortField) {
  if (sort?.field !== field) return undefined;
  return sort.direction === "asc" ? ("ascending" as const) : ("descending" as const);
}

function TableMessage({
  icon,
  title,
  detail,
  action,
  onAction,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
  action?: string;
  onAction?(): void;
}) {
  return (
    <div className="table-message">
      <span className="table-message-icon">{icon}</span>
      <strong>{title}</strong>
      <span>{detail}</span>
      {action && onAction ? (
        <button type="button" className="secondary-button" onClick={onAction}>
          {action}
        </button>
      ) : null}
    </div>
  );
}

function TrackRowsSkeleton({ ordered }: { ordered: boolean }) {
  return Array.from({ length: 9 }, (_, index) => (
    <tr key={index} className="skeleton-row" aria-hidden="true">
      <td className="track-number-column">
        <span className="skeleton-block skeleton-number" />
      </td>
      <td className="title-column">
        <span className="skeleton-title-wrap">
          <span className="skeleton-block skeleton-icon" />
          <span>
            <span className="skeleton-block skeleton-title" />
            <span className="skeleton-block skeleton-subtitle" />
          </span>
        </span>
      </td>
      <td className="album-column">
        <span className="skeleton-block skeleton-medium" />
      </td>
      <td className="genre-column">
        <span className="skeleton-block skeleton-small" />
      </td>
      <td className="bpm-column">
        <span className="skeleton-block skeleton-small" />
      </td>
      <td className="key-column">
        <span className="skeleton-block skeleton-small" />
      </td>
      <td className="duration-column">
        <span className="skeleton-block skeleton-small" />
      </td>
      {ordered ? <td className="reorder-column" /> : null}
    </tr>
  ));
}
