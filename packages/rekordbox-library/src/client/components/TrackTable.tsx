import {
  AudioLines,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileQuestion,
  LoaderCircle,
  Music,
} from "lucide-react";

import type { TrackSummary } from "../../shared/types.js";
import { formatBpm, formatDuration } from "../format.js";

type Props = {
  items: TrackSummary[];
  count: number;
  limit: number;
  offset: number;
  loading: boolean;
  fetching: boolean;
  error?: string;
  selectedTrackId: string | null;
  ordered: boolean;
  canWrite: boolean;
  onSelect(track: TrackSummary): void;
  onPage(offset: number): void;
  onMove?(track: TrackSummary, trackNumber: number): void;
  onRetry(): void;
};

export function TrackTable({
  items,
  count,
  limit,
  offset,
  loading,
  fetching,
  error,
  selectedTrackId,
  ordered,
  canWrite,
  onSelect,
  onPage,
  onMove,
  onRetry,
}: Props) {
  const first = count === 0 ? 0 : offset + 1;
  const last = Math.min(offset + items.length, count);

  return (
    <section className="track-table-shell" aria-label="Tracks">
      <div className="track-table-scroll">
        <table className="track-table">
          <thead>
            <tr>
              <th className="track-number-column" scope="col">
                <span className="sr-only">Track number</span>
                <span aria-hidden="true">#</span>
              </th>
              <th className="title-column" scope="col">
                Title
              </th>
              <th className="album-column" scope="col">
                Album
              </th>
              <th className="genre-column" scope="col">
                Genre
              </th>
              <th className="bpm-column numeric" scope="col">
                BPM
              </th>
              <th className="key-column" scope="col">
                Key
              </th>
              <th className="plays-column numeric" scope="col">
                Plays
              </th>
              <th className="status-column" scope="col">
                Status
              </th>
              <th className="duration-column numeric" scope="col">
                Time
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
                <td colSpan={ordered ? 10 : 9}>
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
                <td colSpan={ordered ? 10 : 9}>
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
                    className={selected ? "is-selected" : ""}
                    aria-selected={selected}
                    tabIndex={0}
                    onClick={() => onSelect(track)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onSelect(track);
                      }
                    }}
                  >
                    <td className="track-number-column numeric muted-cell">{trackNumber}</td>
                    <td className="title-column">
                      <div className="track-title-cell">
                        <span className="track-file-icon" aria-hidden="true">
                          <Music size={14} />
                        </span>
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
                    <td className="plays-column numeric tabular">{track.playCount || "—"}</td>
                    <td className="status-column">
                      <TrackStatus track={track} />
                    </td>
                    <td className="duration-column numeric tabular muted-cell">
                      {formatDuration(track.durationSeconds)}
                    </td>
                    {ordered ? (
                      <td className="reorder-column">
                        {track.playlistMembershipId ? (
                          <span className="reorder-actions">
                            <button
                              className="table-icon-button"
                              type="button"
                              disabled={!canWrite || trackNumber <= 1}
                              onClick={(event) => {
                                event.stopPropagation();
                                onMove?.(track, trackNumber - 1);
                              }}
                              aria-label={`Move ${track.title} up`}
                              title="Move up"
                            >
                              <ArrowUp size={13} />
                            </button>
                            <button
                              className="table-icon-button"
                              type="button"
                              disabled={!canWrite || trackNumber >= count}
                              onClick={(event) => {
                                event.stopPropagation();
                                onMove?.(track, trackNumber + 1);
                              }}
                              aria-label={`Move ${track.title} down`}
                              title="Move down"
                            >
                              <ArrowDown size={13} />
                            </button>
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
        {fetching && !loading ? (
          <div className="table-fetch-indicator" role="status">
            <LoaderCircle size={14} className="spin" /> Updating
          </div>
        ) : null}
      </div>

      <footer className="table-pagination" aria-label="Track pagination">
        <span className="pagination-summary">
          {count === 0 ? "No tracks" : `${String(first)}–${String(last)} of ${String(count)}`}
        </span>
        <span className="pagination-buttons">
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={offset === 0 || fetching}
            onClick={() => onPage(Math.max(0, offset - limit))}
          >
            <ChevronLeft size={14} /> Previous
          </button>
          <button
            className="secondary-button compact-button"
            type="button"
            disabled={offset + limit >= count || fetching}
            onClick={() => onPage(offset + limit)}
          >
            Next <ChevronRight size={14} />
          </button>
        </span>
      </footer>
    </section>
  );
}

function TrackStatus({ track }: { track: TrackSummary }) {
  if (!track.fileExists) {
    return (
      <span className="status-pill status-missing" title="The referenced audio file is unavailable">
        <FileQuestion size={12} /> Missing
      </span>
    );
  }
  if (!track.analyzed) {
    return (
      <span className="status-pill status-pending" title="Rekordbox analysis is missing">
        <AudioLines size={12} /> Pending
      </span>
    );
  }
  return (
    <span className="status-pill status-ready" title="Audio and Rekordbox analysis are available">
      <Check size={12} /> Ready
    </span>
  );
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
      <td className="plays-column">
        <span className="skeleton-block skeleton-small" />
      </td>
      <td className="status-column">
        <span className="skeleton-block skeleton-medium" />
      </td>
      <td className="duration-column">
        <span className="skeleton-block skeleton-small" />
      </td>
      {ordered ? <td className="reorder-column" /> : null}
    </tr>
  ));
}
