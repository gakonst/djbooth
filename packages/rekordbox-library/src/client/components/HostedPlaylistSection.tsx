import {
  CheckCircle2,
  Circle,
  Cloud,
  CloudOff,
  ListMusic,
  LoaderCircle,
  LockKeyhole,
  Music2,
  PanelRightOpen,
  TriangleAlert,
} from "lucide-react";

import type {
  HostedPlaylistProvider,
  HostedProviderStatus,
  PlaylistItem,
} from "../../shared/types.js";
import { compactCount } from "../format.js";
import type { HostedPlaylistItem } from "../hosted-playlists.js";
import { hostedProviderLabel } from "../hosted-playlists.js";

type Props = {
  provider: HostedPlaylistProvider;
  status?: HostedProviderStatus;
  items: HostedPlaylistItem[];
  loading: boolean;
  selectedPlaylistId: string | null;
  onSelectPlaylist?(playlist: PlaylistItem): void;
  onEditPlaylist?(playlist: PlaylistItem): void;
  onToggleDownload?(playlist: PlaylistItem, enabled: boolean): void;
  onPlaylistContextMenu?(
    point: { x: number; y: number },
    playlist: PlaylistItem,
    returnFocus: HTMLElement,
  ): void;
};

export function HostedPlaylistSection({
  provider,
  status,
  items,
  loading,
  selectedPlaylistId,
  onSelectPlaylist,
  onEditPlaylist,
  onToggleDownload,
  onPlaylistContextMenu,
}: Props) {
  const providerLabel = hostedProviderLabel(provider);
  const ProviderIcon = provider === "spotify" ? Music2 : Cloud;

  return (
    <div className={`sidebar-section hosted-playlists-section provider-${provider}`}>
      <div className="sidebar-section-heading hosted-provider-heading">
        <span className="sidebar-section-label">
          <ProviderIcon size={12} aria-hidden="true" />
          {providerLabel}
        </span>
        <ProviderConnectionStatus providerLabel={providerLabel} status={status} loading={loading} />
      </div>

      {loading ? (
        <HostedPlaylistSkeleton />
      ) : !status?.connected ? (
        <div
          className={`sidebar-provider-message ${status?.error ? "is-error" : ""}`}
          role={status?.error ? "alert" : "status"}
          title={status?.error}
        >
          {status?.error ? <TriangleAlert size={13} /> : <CloudOff size={13} />}
          <span>{status?.error ?? `${providerLabel} is not connected`}</span>
        </div>
      ) : items.length === 0 ? (
        <div className="sidebar-empty hosted-playlists-empty">
          <ListMusic size={15} />
          <span>No playlists found</span>
        </div>
      ) : (
        <div className="hosted-playlist-list" role="list" aria-label={`${providerLabel} playlists`}>
          {items.map((playlist) => (
            <HostedPlaylistRow
              key={playlist.id}
              playlist={playlist}
              selected={playlist.id === selectedPlaylistId}
              onSelect={onSelectPlaylist}
              onEdit={onEditPlaylist}
              onToggleDownload={onToggleDownload}
              onContextMenu={onPlaylistContextMenu}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderConnectionStatus({
  providerLabel,
  status,
  loading,
}: {
  providerLabel: string;
  status?: HostedProviderStatus;
  loading: boolean;
}) {
  const label = loading
    ? `Loading ${providerLabel}`
    : status?.connected
      ? status.displayName
        ? `${providerLabel} connected as ${status.displayName}`
        : `${providerLabel} connected`
      : `${providerLabel} disconnected`;

  return (
    <span
      className={`hosted-provider-status ${status?.connected ? "is-online" : ""} ${status?.error ? "is-error" : ""}`}
      aria-label={label}
      title={label}
    >
      {loading ? <LoaderCircle className="spin" size={11} /> : <span className="status-dot" />}
      {status?.displayName ? <span>{status.displayName}</span> : null}
    </span>
  );
}

function HostedPlaylistRow({
  playlist,
  selected,
  onSelect,
  onEdit,
  onToggleDownload,
  onContextMenu,
}: {
  playlist: HostedPlaylistItem;
  selected: boolean;
  onSelect?(playlist: PlaylistItem): void;
  onEdit?(playlist: PlaylistItem): void;
  onToggleDownload?(playlist: PlaylistItem, enabled: boolean): void;
  onContextMenu?(
    point: { x: number; y: number },
    playlist: PlaylistItem,
    returnFocus: HTMLElement,
  ): void;
}) {
  const hosted = playlist.hosted;
  const canRead = hosted.capabilities.itemsReadable;
  const canEdit = hosted.capabilities.itemsEditable;
  const syncing = hosted.syncState === "queued" || hosted.syncState === "syncing";
  const readOnlyLabel = canRead ? "Read-only playlist" : "Playlist tracks unavailable";

  return (
    <div
      className={`playlist-node-row hosted-playlist-row ${selected ? "is-active" : ""} ${!canEdit ? "is-read-only" : ""}`}
      role="listitem"
      onContextMenu={(event) => {
        event.preventDefault();
        const returnFocus =
          event.target instanceof HTMLElement
            ? (event.target.closest("button") ?? event.currentTarget)
            : event.currentTarget;
        onContextMenu?.({ x: event.clientX, y: event.clientY }, playlist, returnFocus);
      }}
    >
      <button
        type="button"
        className="playlist-select hosted-playlist-select"
        onClick={() => onSelect?.(playlist)}
        onDoubleClick={() => canEdit && onEdit?.(playlist)}
        aria-current={selected ? "page" : undefined}
        aria-label={`${playlist.name}, ${playlist.trackCount ?? "unknown number of"} tracks${canEdit ? "" : `, ${readOnlyLabel.toLocaleLowerCase()}`}`}
      >
        <ListMusic size={14} aria-hidden="true" />
        <span className="playlist-name">{playlist.name}</span>
        {!canEdit ? (
          <span className="hosted-read-only" title={readOnlyLabel} aria-label={readOnlyLabel}>
            <LockKeyhole size={11} />
          </span>
        ) : null}
        <span className="sidebar-count">
          {playlist.trackCount === null ? "—" : compactCount(playlist.trackCount)}
        </span>
      </button>

      <button
        className={`hosted-download-toggle ${hosted.downloadEnabled ? "is-enabled" : ""} ${hosted.syncState === "error" ? "is-error" : ""}`}
        type="button"
        disabled={!canRead || !onToggleDownload || syncing}
        onClick={() => onToggleDownload?.(playlist, !hosted.downloadEnabled)}
        aria-pressed={hosted.downloadEnabled}
        aria-label={`${hosted.downloadEnabled ? "Stop keeping" : "Keep"} ${playlist.name} downloaded`}
        title={
          hosted.syncError ??
          (!canRead
            ? "Tracks are unavailable from this provider"
            : hosted.downloadEnabled
              ? "Keep downloaded"
              : "Download and keep in sync")
        }
      >
        {syncing ? (
          <LoaderCircle className="spin" size={12} />
        ) : hosted.syncState === "error" ? (
          <TriangleAlert size={12} />
        ) : hosted.downloadEnabled ? (
          <CheckCircle2 size={12} />
        ) : (
          <Circle size={12} />
        )}
      </button>

      {canEdit ? (
        <button
          className="playlist-edit-button hosted-playlist-edit-button"
          type="button"
          onClick={() => onEdit?.(playlist)}
          disabled={!onEdit}
          aria-label={`Edit ${playlist.name} in split view`}
          title="Edit hosted playlist in split view"
        >
          <PanelRightOpen size={12} />
        </button>
      ) : null}
    </div>
  );
}

function HostedPlaylistSkeleton() {
  return (
    <div className="playlist-skeleton hosted-playlist-skeleton" aria-label="Loading playlists">
      {[68, 82, 57].map((width) => (
        <div key={width} className="skeleton-line" style={{ width: `${width}%` }} />
      ))}
    </div>
  );
}
