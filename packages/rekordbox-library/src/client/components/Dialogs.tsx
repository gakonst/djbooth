import { useEffect, useId, useRef, useState } from "react";
import { CircleAlert, Folder, ListMusic, LoaderCircle, ShieldCheck, X } from "lucide-react";

import type { PlaylistItem, PlaylistKind } from "../../shared/types.js";

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
              <strong>Protected write</strong>A database backup and integrity check are required
              before this can finish.
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

export function Toast({
  message,
  tone = "success",
  onDismiss,
}: {
  message: string;
  tone?: "success" | "error";
  onDismiss(): void;
}) {
  useEffect(() => {
    const timeout = window.setTimeout(onDismiss, 4_000);
    return () => window.clearTimeout(timeout);
  }, [message, onDismiss]);

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
      if (event.key === "Escape" && !pending) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open, pending]);
}
