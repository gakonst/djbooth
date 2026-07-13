import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AudioLines,
  Check,
  CircleAlert,
  Copy,
  Disc3,
  FileAudio,
  FolderTree,
  Gauge,
  Hash,
  LoaderCircle,
  Music2,
  Plus,
  Pencil,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";

import type { PlaylistItem, TrackCue, TrackDetail, TrackSummary } from "../../shared/types.js";
import { rekordboxHotCueColor } from "../cue-palette.js";
import {
  artworkHue,
  formatBitRate,
  formatBpm,
  formatBytes,
  formatDuration,
  formatSampleRate,
  pathBasename,
  titleInitials,
} from "../format.js";

type Props = {
  open: boolean;
  summary?: TrackSummary;
  detail?: TrackDetail;
  playlists: PlaylistItem[];
  selectedPlaylistId: string | null;
  loading: boolean;
  error?: string;
  canWrite: boolean;
  mutationPending: boolean;
  onClose(): void;
  onRetry(): void;
  onAddTrack(playlistId: string, contentId: string): void;
  onRemoveTrack(playlistId: string, membershipId: string): void;
  onEditCue(cue: TrackCue): void;
  onDeleteCue(cue: TrackCue): void;
  onNotice(message: string): void;
};

export function TrackInspector({
  open,
  summary,
  detail,
  playlists,
  selectedPlaylistId,
  loading,
  error,
  canWrite,
  mutationPending,
  onClose,
  onRetry,
  onAddTrack,
  onRemoveTrack,
  onEditCue,
  onDeleteCue,
  onNotice,
}: Props) {
  const track = detail ?? summary;
  const availablePlaylists = useMemo(
    () =>
      playlists.filter(
        (playlist) =>
          playlist.type === "playlist" &&
          !detail?.playlists.some((membership) => membership.id === playlist.id),
      ),
    [detail?.playlists, playlists],
  );
  const [targetPlaylist, setTargetPlaylist] = useState("");
  const [artworkFailed, setArtworkFailed] = useState(false);

  useEffect(() => {
    setTargetPlaylist(availablePlaylists[0]?.id ?? "");
  }, [availablePlaylists, track?.id]);

  useEffect(() => setArtworkFailed(false), [track?.id]);

  const currentMembership = detail?.playlists.find(
    (membership) => membership.id === selectedPlaylistId,
  );

  return (
    <aside
      className={`track-inspector ${open ? "is-open" : ""}`}
      aria-label="Track inspector"
      aria-hidden={!open && !track ? true : undefined}
    >
      <div className="inspector-header">
        <div>
          <span className="eyebrow">Inspector</span>
          <strong>{track ? "Track details" : "Nothing selected"}</strong>
        </div>
        <button className="icon-button" type="button" onClick={onClose}>
          <X size={17} />
          <span className="sr-only">Close track inspector</span>
        </button>
      </div>

      {!track ? (
        <div className="inspector-empty">
          <span className="inspector-empty-icon">
            <Music2 size={24} />
          </span>
          <strong>Select a track</strong>
          <span>Metadata, analysis, file health, and playlist memberships will appear here.</span>
        </div>
      ) : (
        <div className="inspector-scroll">
          <div className="track-hero">
            <div
              className="artwork-placeholder"
              style={{ "--artwork-hue": artworkHue(track.id) } as React.CSSProperties}
            >
              {!artworkFailed ? (
                <img
                  className="track-artwork-image"
                  src={`/api/artwork/${encodeURIComponent(track.id)}`}
                  alt={`${track.title} album cover`}
                  onError={() => setArtworkFailed(true)}
                />
              ) : (
                <>
                  <span>{titleInitials(track.title, track.artist)}</span>
                  <Disc3 size={82} strokeWidth={0.55} aria-hidden="true" />
                </>
              )}
            </div>
            <div className="track-hero-copy">
              <h2>{track.title || "Untitled"}</h2>
              <p>{track.artist ?? "Unknown artist"}</p>
              <span>{track.album ?? "Unknown album"}</span>
            </div>
          </div>

          <div className="analysis-strip">
            <Metric label="BPM" value={formatBpm(track.bpm)} />
            <Metric label="Key" value={track.key ?? "—"} />
            <Metric label="Time" value={formatDuration(track.durationSeconds)} />
            <Metric label="Rating" value={track.rating ? `${String(track.rating)} / 5` : "—"} />
          </div>

          <div className="inspector-status-row">
            {!track.fileExists ? (
              <span className="detail-status is-error">
                <CircleAlert size={13} /> File missing
              </span>
            ) : track.analyzed ? (
              <span className="detail-status is-success">
                <Check size={13} /> Analyzed
              </span>
            ) : (
              <span className="detail-status is-warning">
                <AudioLines size={13} /> Analysis pending
              </span>
            )}
            <span className="detail-status">
              <Activity size={13} /> {String(track.playCount)} plays
            </span>
          </div>

          {loading ? <InspectorSkeleton /> : null}
          {error ? (
            <div className="inline-error" role="alert">
              <CircleAlert size={16} />
              <span>
                <strong>Details unavailable</strong>
                {error}
              </span>
              <button className="small-icon-button" type="button" onClick={onRetry} title="Retry">
                <RotateCcw size={14} />
                <span className="sr-only">Retry track details</span>
              </button>
            </div>
          ) : null}

          {detail ? (
            <>
              <InspectorSection title="Recording" icon={<Gauge size={14} />}>
                <DefinitionList
                  items={[
                    ["Genre", detail.genre ?? "—"],
                    ["Release year", detail.releaseYear ? String(detail.releaseYear) : "—"],
                    ["ISRC", detail.isrc ?? "—"],
                    ["Bit rate", formatBitRate(detail.bitRate)],
                    ["Sample rate", formatSampleRate(detail.sampleRate)],
                    ["File size", formatBytes(detail.fileSize)],
                  ]}
                />
              </InspectorSection>

              <InspectorSection title="File" icon={<FileAudio size={14} />}>
                <div className="path-card">
                  <span className="path-filename">{pathBasename(detail.path)}</span>
                  <span className="path-full" title={detail.path ?? undefined}>
                    {detail.path ?? "No path recorded"}
                  </span>
                  {detail.path ? (
                    <button
                      className="secondary-button compact-button"
                      type="button"
                      onClick={async () => {
                        await navigator.clipboard.writeText(detail.path ?? "");
                        onNotice("Audio path copied");
                      }}
                    >
                      <Copy size={13} /> Copy path
                    </button>
                  ) : null}
                </div>
                {detail.analysisPath ? (
                  <div className="analysis-path">
                    <Hash size={12} />
                    <span title={detail.analysisPath}>{detail.analysisPath}</span>
                  </div>
                ) : null}
              </InspectorSection>

              <InspectorSection title="Playlists" icon={<FolderTree size={14} />}>
                {detail.playlists.length ? (
                  <div className="membership-list">
                    {detail.playlists.map((membership) => (
                      <div className="membership-row" key={membership.membershipId}>
                        <span className="membership-icon">
                          <Music2 size={13} />
                        </span>
                        <span className="membership-copy">
                          <strong>{membership.name}</strong>
                          <span>Track {String(membership.trackNumber)}</span>
                        </span>
                        <button
                          className="small-icon-button danger-hover"
                          type="button"
                          disabled={!canWrite || mutationPending}
                          onClick={() => onRemoveTrack(membership.id, membership.membershipId)}
                          aria-label={`Remove from ${membership.name}`}
                          title={`Remove from ${membership.name}`}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="section-empty">Not in a playlist.</p>
                )}

                <div className="add-to-playlist">
                  <select
                    value={targetPlaylist}
                    onChange={(event) => setTargetPlaylist(event.target.value)}
                    disabled={!availablePlaylists.length || !canWrite || mutationPending}
                    aria-label="Playlist to add track to"
                  >
                    {availablePlaylists.length ? (
                      availablePlaylists.map((playlist) => (
                        <option key={playlist.id} value={playlist.id}>
                          {playlist.name}
                        </option>
                      ))
                    ) : (
                      <option value="">No available playlist</option>
                    )}
                  </select>
                  <button
                    className="primary-button compact-button"
                    type="button"
                    disabled={!targetPlaylist || !canWrite || mutationPending}
                    onClick={() => onAddTrack(targetPlaylist, detail.id)}
                  >
                    {mutationPending ? (
                      <LoaderCircle size={13} className="spin" />
                    ) : (
                      <Plus size={13} />
                    )}
                    Add
                  </button>
                </div>
              </InspectorSection>

              <InspectorSection title="Cue points" icon={<AudioLines size={14} />}>
                {detail.cues.length ? (
                  <div className="membership-list cue-point-list">
                    {detail.cues.map((cue) => {
                      const paletteColor =
                        cue.kind === "hot" ? rekordboxHotCueColor(cue.colorTableIndex) : undefined;
                      return (
                        <div className="membership-row" key={cue.id}>
                          <span
                            className={`cue-kind-chip is-${cue.kind}${
                              paletteColor ? " has-palette-color" : ""
                            }`}
                            style={
                              paletteColor
                                ? ({ "--cue-color": paletteColor } as React.CSSProperties)
                                : undefined
                            }
                          >
                            {cue.kind === "hot" && cue.slot
                              ? String.fromCharCode(64 + cue.slot)
                              : "M"}
                          </span>
                          <span className="membership-copy">
                            <strong>{cue.comment || (cue.type === "loop" ? "Loop" : "Cue")}</strong>
                            <span>
                              {formatDuration(cue.startSeconds)}
                              {cue.endSeconds == null ? "" : ` → ${formatDuration(cue.endSeconds)}`}
                            </span>
                          </span>
                          <button
                            className="small-icon-button"
                            type="button"
                            disabled={!canWrite || mutationPending}
                            onClick={() => onEditCue(cue)}
                            aria-label={`Edit cue at ${formatDuration(cue.startSeconds)}`}
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            className="small-icon-button danger-hover"
                            type="button"
                            disabled={!canWrite || mutationPending}
                            onClick={() => onDeleteCue(cue)}
                            aria-label={`Delete cue at ${formatDuration(cue.startSeconds)}`}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="section-empty">No memory or Hot Cues.</p>
                )}
              </InspectorSection>

              {detail.comment ? (
                <InspectorSection title="Comment" icon={<Music2 size={14} />}>
                  <p className="track-comment">{detail.comment}</p>
                </InspectorSection>
              ) : null}

              {currentMembership ? (
                <div className="inspector-primary-action">
                  <button
                    className="danger-button"
                    type="button"
                    disabled={!canWrite || mutationPending}
                    onClick={() =>
                      onRemoveTrack(currentMembership.id, currentMembership.membershipId)
                    }
                  >
                    <Trash2 size={14} /> Remove from this playlist
                  </button>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      )}
    </aside>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="analysis-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

function InspectorSection({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="inspector-section">
      <h3>
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function DefinitionList({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className="definition-list">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function InspectorSkeleton() {
  return (
    <div className="inspector-skeleton" aria-label="Loading track details">
      <span className="skeleton-block" />
      <span className="skeleton-block" />
      <span className="skeleton-block" />
    </div>
  );
}
