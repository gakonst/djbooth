import { useEffect, useId, useRef, useState } from "react";
import { Check, CircleAlert, Folder, ListMusic, LoaderCircle, ShieldCheck, X } from "lucide-react";

import type {
  HotCueSlot,
  PlaylistItem,
  PlaylistKind,
  TrackCue,
  TrackCueInput,
} from "../../shared/types.js";
import {
  normalizeHotCuePaletteIndex,
  REKORDBOX_HOT_CUE_PALETTE,
  resolveCueColorFields,
} from "../cue-palette.js";

type PlaylistDialogProps = {
  open: boolean;
  mode: "create" | "rename";
  playlist?: PlaylistItem;
  folders: PlaylistItem[];
  defaultParentId?: string;
  pending: boolean;
  error?: string;
  onClose(): void;
  onSubmit(value: { name: string; parentId?: string; kind?: Exclude<PlaylistKind, "smart"> }): void;
};

export function PlaylistDialog({
  open,
  mode,
  playlist,
  folders,
  defaultParentId,
  pending,
  error,
  onClose,
  onSubmit,
}: PlaylistDialogProps) {
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"playlist" | "folder">("playlist");
  const [parentId, setParentId] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(mode === "rename" ? (playlist?.name ?? "") : "");
    setKind(playlist?.type === "folder" ? "folder" : "playlist");
    setParentId(defaultParentId ?? (playlist?.parentId === "root" ? "" : playlist?.parentId) ?? "");
    const timeout = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(timeout);
  }, [defaultParentId, mode, open, playlist]);

  useDialogEscape(open, pending, onClose);
  if (!open) return null;

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => !pending && onClose()}>
      <section
        className="dialog-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow">
              {mode === "create" ? "New collection" : "Edit collection"}
            </span>
            <h2 id={titleId}>
              {mode === "create" ? "Create a playlist" : `Rename ${playlist?.name ?? "playlist"}`}
            </h2>
          </div>
          <button className="icon-button" type="button" disabled={pending} onClick={onClose}>
            <X size={17} />
            <span className="sr-only">Close dialog</span>
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = name.trim();
            if (!trimmed) return;
            onSubmit({
              name: trimmed,
              ...(mode === "create"
                ? {
                    kind,
                    ...(parentId ? { parentId } : {}),
                  }
                : {}),
            });
          }}
        >
          <div className="dialog-body">
            <label className="field-label">
              <span>Name</span>
              <input
                ref={inputRef}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={180}
                placeholder={kind === "folder" ? "Folder name" : "Playlist name"}
                autoComplete="off"
              />
            </label>

            {mode === "create" ? (
              <>
                <fieldset className="choice-fieldset">
                  <legend>Type</legend>
                  <label className={kind === "playlist" ? "is-selected" : ""}>
                    <input
                      type="radio"
                      name="playlist-kind"
                      value="playlist"
                      checked={kind === "playlist"}
                      onChange={() => setKind("playlist")}
                    />
                    <ListMusic size={16} />
                    <span>
                      <strong>Playlist</strong>
                      <small>An ordered collection of tracks</small>
                    </span>
                  </label>
                  <label className={kind === "folder" ? "is-selected" : ""}>
                    <input
                      type="radio"
                      name="playlist-kind"
                      value="folder"
                      checked={kind === "folder"}
                      onChange={() => setKind("folder")}
                    />
                    <Folder size={16} />
                    <span>
                      <strong>Folder</strong>
                      <small>Organize playlists and folders</small>
                    </span>
                  </label>
                </fieldset>
                <label className="field-label">
                  <span>Location</span>
                  <select value={parentId} onChange={(event) => setParentId(event.target.value)}>
                    <option value="">Top level</option>
                    {folders.map((folder) => (
                      <option key={folder.id} value={folder.id}>
                        {folder.name}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}

            {error ? (
              <div className="dialog-error" role="alert">
                <CircleAlert size={15} />
                {error}
              </div>
            ) : null}
          </div>
          <footer className="dialog-footer">
            <button className="secondary-button" type="button" disabled={pending} onClick={onClose}>
              Cancel
            </button>
            <button className="primary-button" type="submit" disabled={!name.trim() || pending}>
              {pending ? <LoaderCircle size={14} className="spin" /> : null}
              {mode === "create" ? "Create" : "Save name"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export function DeletePlaylistDialog({
  open,
  playlist,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  playlist?: PlaylistItem;
  pending: boolean;
  error?: string;
  onClose(): void;
  onConfirm(): void;
}) {
  const titleId = useId();
  useDialogEscape(open, pending, onClose);
  if (!open || !playlist) return null;
  const isFolder = playlist.type === "folder";

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => !pending && onClose()}>
      <section
        className="dialog-card confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <div className="dialog-danger-icon">
            <CircleAlert size={19} />
          </div>
          <div>
            <span className="eyebrow">Permanent library change</span>
            <h2 id={titleId}>Delete “{playlist.name}”?</h2>
          </div>
          <button className="icon-button" type="button" disabled={pending} onClick={onClose}>
            <X size={17} />
            <span className="sr-only">Close dialog</span>
          </button>
        </header>
        <div className="dialog-body">
          <p className="confirm-copy">
            {isFolder
              ? "The folder and its playlist subtree will be removed from Rekordbox. Audio files are not deleted."
              : "The playlist and its memberships will be removed from Rekordbox. Audio files stay in your collection."}
          </p>
          <div className="safety-note">
            <ShieldCheck size={16} />
            <span>
              <strong>Queued write</strong>The playlist disappears immediately; the local writer
              commits the change in the background.
            </span>
          </div>
          {error ? (
            <div className="dialog-error" role="alert">
              <CircleAlert size={15} />
              {error}
            </div>
          ) : null}
        </div>
        <footer className="dialog-footer">
          <button className="secondary-button" type="button" disabled={pending} onClick={onClose}>
            Keep {isFolder ? "folder" : "playlist"}
          </button>
          <button className="danger-button" type="button" disabled={pending} onClick={onConfirm}>
            {pending ? <LoaderCircle size={14} className="spin" /> : null}
            Delete permanently
          </button>
        </footer>
      </section>
    </div>
  );
}

export function CueDialog({
  open,
  cue,
  initial,
  targetTitle,
  durationSeconds,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  cue?: TrackCue;
  initial?: { kind: "memory" | "hot"; slot?: HotCueSlot; startSeconds: number };
  targetTitle?: string;
  durationSeconds?: number | null;
  pending: boolean;
  error?: string;
  onClose(): void;
  onSubmit(cue: TrackCueInput): void;
}) {
  const titleId = useId();
  const startRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<"memory" | "hot">("memory");
  const [slot, setSlot] = useState<HotCueSlot>(1);
  const [cueType, setCueType] = useState<"cue" | "loop">("cue");
  const [startSeconds, setStartSeconds] = useState("0");
  const [endSeconds, setEndSeconds] = useState("");
  const [comment, setComment] = useState("");
  const [activeLoop, setActiveLoop] = useState(false);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [paletteChanged, setPaletteChanged] = useState(false);

  useEffect(() => {
    if (!open) return;
    const nextKind = cue?.kind ?? initial?.kind ?? "memory";
    setKind(nextKind);
    setSlot((cue?.slot ?? initial?.slot ?? 1) as HotCueSlot);
    setCueType(cue?.type ?? "cue");
    setStartSeconds(String(cue?.startSeconds ?? initial?.startSeconds ?? 0));
    setEndSeconds(cue?.endSeconds == null ? "" : String(cue.endSeconds));
    setComment(cue?.comment ?? "");
    setActiveLoop(cue?.activeLoop ?? false);
    setPaletteIndex(normalizeHotCuePaletteIndex(cue?.colorTableIndex));
    setPaletteChanged(false);
    const timeout = window.setTimeout(() => startRef.current?.focus(), 30);
    return () => window.clearTimeout(timeout);
  }, [cue, initial, open]);

  useDialogEscape(open, pending, onClose);
  if (!open) return null;
  const start = Number(startSeconds);
  const end = Number(endSeconds);
  const validStart =
    Number.isFinite(start) && start >= 0 && (!durationSeconds || start <= durationSeconds);
  const validEnd =
    cueType === "cue" ||
    (Number.isFinite(end) && end > start && (!durationSeconds || end <= durationSeconds));

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={() => !pending && onClose()}>
      <section
        className="dialog-card cue-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <div>
            <span className="eyebrow" title={targetTitle}>
              Rekordbox cue{targetTitle ? ` · ${targetTitle}` : ""}
            </span>
            <h2 id={titleId}>{cue ? "Configure cue point" : "Add cue point"}</h2>
          </div>
          <button className="icon-button" type="button" disabled={pending} onClick={onClose}>
            <X size={17} />
            <span className="sr-only">Close cue dialog</span>
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!validStart || !validEnd) return;
            const common = {
              ...(cue ? { id: cue.id } : {}),
              type: cueType,
              startSeconds: start,
              ...(cueType === "loop" ? { endSeconds: end, activeLoop } : {}),
              comment: comment.trim(),
              ...resolveCueColorFields({
                kind,
                ...(cue ? { existing: cue } : {}),
                paletteIndex,
                paletteChanged,
              }),
            } as const;
            onSubmit(kind === "hot" ? { ...common, kind, slot } : { ...common, kind });
          }}
        >
          <div className="dialog-body cue-dialog-grid">
            <label className="field-label">
              <span>Kind</span>
              <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}>
                <option value="memory">Memory cue</option>
                <option value="hot">Hot Cue</option>
              </select>
            </label>
            {kind === "hot" ? (
              <label className="field-label">
                <span>Hot Cue slot</span>
                <select
                  value={slot}
                  onChange={(event) => setSlot(Number(event.target.value) as HotCueSlot)}
                >
                  {Array.from({ length: 16 }, (_, index) => index + 1).map((value) => (
                    <option key={value} value={value}>
                      {String.fromCharCode(64 + value)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="field-label">
              <span>Type</span>
              <select
                value={cueType}
                onChange={(event) => setCueType(event.target.value as typeof cueType)}
              >
                <option value="cue">Point</option>
                <option value="loop">Loop</option>
              </select>
            </label>
            <label className="field-label">
              <span>Position (seconds)</span>
              <input
                ref={startRef}
                type="number"
                min="0"
                max={durationSeconds ?? undefined}
                step="0.001"
                value={startSeconds}
                onChange={(event) => setStartSeconds(event.target.value)}
              />
            </label>
            {cueType === "loop" ? (
              <label className="field-label">
                <span>Loop out (seconds)</span>
                <input
                  type="number"
                  min="0"
                  max={durationSeconds ?? undefined}
                  step="0.001"
                  value={endSeconds}
                  onChange={(event) => setEndSeconds(event.target.value)}
                />
              </label>
            ) : null}
            {kind === "hot" ? (
              <fieldset className="cue-palette-field">
                <legend>Hot Cue color</legend>
                <div className="cue-palette-picker" role="listbox" aria-label="Hot Cue color">
                  <button
                    className={`cue-palette-default${paletteIndex === 0 ? " is-selected" : ""}`}
                    type="button"
                    role="option"
                    aria-selected={paletteIndex === 0}
                    onClick={() => {
                      setPaletteIndex(0);
                      setPaletteChanged(true);
                    }}
                  >
                    {paletteIndex === 0 ? <Check size={10} /> : null} Default
                  </button>
                  <span className="cue-palette-swatches" role="presentation">
                    {REKORDBOX_HOT_CUE_PALETTE.slice(1).map((hex, offset) => {
                      const index = offset + 1;
                      const selected = paletteIndex === index;
                      return (
                        <button
                          className={`cue-palette-swatch${selected ? " is-selected" : ""}`}
                          type="button"
                          role="option"
                          aria-label={`Palette ${String(index)} ${hex}`}
                          aria-selected={selected}
                          title={`Palette ${String(index)} · ${hex}`}
                          style={{ "--cue-swatch": hex } as React.CSSProperties}
                          key={index}
                          onClick={() => {
                            setPaletteIndex(index);
                            setPaletteChanged(true);
                          }}
                        >
                          {selected ? <Check size={9} /> : null}
                        </button>
                      );
                    })}
                  </span>
                </div>
                <small>
                  {paletteIndex === 0
                    ? "Default · device color"
                    : `Palette ${String(paletteIndex)} · ${REKORDBOX_HOT_CUE_PALETTE[paletteIndex]}`}
                  {cue?.kind === "hot" && !paletteChanged ? " · raw values preserved" : ""}
                </small>
              </fieldset>
            ) : (
              <div className="field-label cue-color-field">
                <span>Color</span>
                <span className="cue-color-preserved">
                  {cue && (cue.color !== null || cue.colorTableIndex !== null)
                    ? "Existing memory-cue color preserved"
                    : "Rekordbox default"}
                </span>
              </div>
            )}
            <label className="field-label cue-comment-field">
              <span>Comment</span>
              <input
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                maxLength={255}
                placeholder="Drop, vocal, mix out…"
              />
            </label>
            {cueType === "loop" ? (
              <label className="cue-checkbox">
                <input
                  type="checkbox"
                  checked={activeLoop}
                  onChange={(event) => setActiveLoop(event.target.checked)}
                />
                Activate this loop when loaded
              </label>
            ) : null}
            {error ? (
              <div className="dialog-error" role="alert">
                <CircleAlert size={15} /> {error}
              </div>
            ) : null}
          </div>
          <footer className="dialog-footer">
            <button className="secondary-button" type="button" disabled={pending} onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={!validStart || !validEnd || pending}
            >
              {pending ? <LoaderCircle size={14} className="spin" /> : null}
              Save cue
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export function Toast({
  message,
  tone = "success",
  onDismiss,
}: {
  message: string;
  tone?: "success" | "error";
  onDismiss(): void;
}) {
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    const timeout = window.setTimeout(() => onDismissRef.current(), 4_000);
    return () => window.clearTimeout(timeout);
  }, [message]);

  return (
    <div className={`toast toast-${tone}`} role={tone === "error" ? "alert" : "status"}>
      {tone === "success" ? <ShieldCheck size={16} /> : <CircleAlert size={16} />}
      <span>{message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss notification">
        <X size={13} />
      </button>
    </div>
  );
}

function useDialogEscape(open: boolean, pending: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape" || pending) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open, pending]);
}
