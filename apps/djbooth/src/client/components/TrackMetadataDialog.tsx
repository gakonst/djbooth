import { CircleAlert, LoaderCircle, Save, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { TrackDetail, TrackMetadataInput } from "../../shared/types.js";

type Props = {
  open: boolean;
  targetTitle?: string;
  track?: TrackDetail;
  loading: boolean;
  error?: string;
  onClose(): void;
  onSubmit(metadata: TrackMetadataInput, expectedRevision: string): void;
};

export function shouldHydrateTrackMetadataDraft(
  open: boolean,
  trackId: string | undefined,
  hydratedTrackId: string | undefined,
): boolean {
  return open && trackId !== undefined && trackId !== hydratedTrackId;
}

export function TrackMetadataDialog({
  open,
  targetTitle,
  track,
  loading,
  error,
  onClose,
  onSubmit,
}: Props) {
  const titleId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const hydratedTrackIdRef = useRef<string | undefined>(undefined);
  const [expectedRevision, setExpectedRevision] = useState<string | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [album, setAlbum] = useState("");
  const [label, setLabel] = useState("");
  const [genre, setGenre] = useState("");
  const [key, setKey] = useState("");
  const [bpm, setBpm] = useState("");
  const [rating, setRating] = useState("0");
  const [releaseYear, setReleaseYear] = useState("");
  const [isrc, setIsrc] = useState("");
  const [comment, setComment] = useState("");

  useEffect(() => {
    if (!open) {
      hydratedTrackIdRef.current = undefined;
      setExpectedRevision(undefined);
      return;
    }
    if (!track || !shouldHydrateTrackMetadataDraft(open, track.id, hydratedTrackIdRef.current))
      return;
    hydratedTrackIdRef.current = track.id;
    setExpectedRevision(track.revision);
    setTitle(track.title);
    setArtist(track.artist ?? "");
    setAlbum(track.album ?? "");
    setLabel(track.label ?? "");
    setGenre(track.genre ?? "");
    setKey(track.key ?? "");
    setBpm(track.bpm == null ? "" : String(track.bpm));
    setRating(String(track.rating));
    setReleaseYear(track.releaseYear == null ? "" : String(track.releaseYear));
    setIsrc(track.isrc ?? "");
    setComment(track.comment ?? "");
    const timeout = window.setTimeout(() => titleRef.current?.focus(), 30);
    return () => window.clearTimeout(timeout);
  }, [open, track]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;
  const bpmValue = optionalNumber(bpm);
  const yearValue = optionalNumber(releaseYear);
  const valid =
    Boolean(track && expectedRevision && title.trim()) &&
    (bpmValue === null || (bpmValue > 0 && bpmValue <= 999)) &&
    (yearValue === null || (Number.isInteger(yearValue) && yearValue >= 0 && yearValue <= 9999));

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="dialog-card track-metadata-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow" title={targetTitle}>
              Rekordbox track metadata
            </span>
            <h2 id={titleId}>Edit {targetTitle ?? "track"}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose}>
            <X size={17} />
            <span className="sr-only">Close metadata editor</span>
          </button>
        </header>

        {error && !track ? (
          <>
            <div className="dialog-body track-metadata-loading dialog-error" role="alert">
              <CircleAlert size={20} /> {error}
            </div>
            <footer className="dialog-footer">
              <button className="secondary-button" type="button" onClick={onClose}>
                Close
              </button>
            </footer>
          </>
        ) : loading || !track ? (
          <div className="dialog-body track-metadata-loading">
            <LoaderCircle size={20} className="spin" /> Loading metadata
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!valid || !expectedRevision) return;
              onSubmit(
                {
                  title: title.trim(),
                  artist: optionalText(artist),
                  album: optionalText(album),
                  label: optionalText(label),
                  genre: optionalText(genre),
                  key: optionalText(key),
                  bpm: bpmValue,
                  rating: Number(rating),
                  comment: optionalText(comment),
                  releaseYear: yearValue,
                  isrc: optionalText(isrc),
                },
                expectedRevision,
              );
            }}
          >
            <div className="dialog-body track-metadata-grid">
              <label className="field-label metadata-wide-field">
                <span>Title</span>
                <input
                  ref={titleRef}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={255}
                  required
                />
              </label>
              <MetadataField label="Artist" value={artist} onChange={setArtist} />
              <MetadataField label="Album" value={album} onChange={setAlbum} />
              <MetadataField label="Label" value={label} onChange={setLabel} />
              <MetadataField label="Genre" value={genre} onChange={setGenre} />
              <MetadataField label="Key" value={key} onChange={setKey} maxLength={64} />
              <label className="field-label">
                <span>BPM</span>
                <input
                  type="number"
                  min="0.01"
                  max="999"
                  step="0.01"
                  value={bpm}
                  onChange={(event) => setBpm(event.target.value)}
                />
              </label>
              <label className="field-label">
                <span>Rating</span>
                <select value={rating} onChange={(event) => setRating(event.target.value)}>
                  <option value="0">Unrated</option>
                  {[1, 2, 3, 4, 5].map((value) => (
                    <option key={value} value={value}>
                      {"★".repeat(value)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                <span>Release year</span>
                <input
                  type="number"
                  min="0"
                  max="9999"
                  step="1"
                  value={releaseYear}
                  onChange={(event) => setReleaseYear(event.target.value)}
                />
              </label>
              <MetadataField label="ISRC" value={isrc} onChange={setIsrc} maxLength={32} />
              <label className="field-label metadata-wide-field">
                <span>Comment</span>
                <textarea
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  maxLength={255}
                  rows={3}
                />
              </label>
              {error ? (
                <div className="dialog-error metadata-wide-field" role="alert">
                  <CircleAlert size={15} /> {error}
                </div>
              ) : null}
            </div>
            <footer className="dialog-footer">
              <button className="secondary-button" type="button" onClick={onClose}>
                Cancel
              </button>
              <button className="primary-button" type="submit" disabled={!valid}>
                <Save size={14} /> Save metadata
              </button>
            </footer>
          </form>
        )}
      </section>
    </div>
  );
}

function MetadataField({
  label,
  value,
  onChange,
  maxLength = 255,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  maxLength?: number;
}) {
  return (
    <label className="field-label">
      <span>{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxLength={maxLength}
      />
    </label>
  );
}

function optionalText(value: string): string | null {
  return value.trim() || null;
}

function optionalNumber(value: string): number | null {
  return value.trim() ? Number(value) : null;
}
