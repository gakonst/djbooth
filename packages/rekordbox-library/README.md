# @gakonst/rekordbox-library

Local-first browser workbench for a normal Rekordbox 6/7 library. It uses the typed
`@gakonst/rekordbox` API directly; it does not shell out to the CLI or upload a library.

```sh
music library status --format json
music library serve --open
music library serve --write
```

For repository development, one command starts the SQLite/API server on an ephemeral loopback port
and the Vite client with HMR on `http://127.0.0.1:4179/`:

```sh
pnpm library:dev
pnpm library:dev -- --read-only # optional
```

Development writes are enabled by default. `--path`, `--port`, `--api-port`, and `--open` are also
available; the browser always reaches the API through Vite's same-origin `/api` proxy.

The server binds to `127.0.0.1`. Browsing is read-only. `--write` enables serialized local SQLite
mutations behind the cross-process lock and stopped Rekordbox/rekordboxAgent check. Writes update
the optimistic UI immediately and commit once; they do not create per-edit backups, journals, or
post-write verification passes.

The workstation provides:

- playlist hierarchy and search, health filters, ordered and column-sortable track browsing;
- a compact persistent top player with key track metadata, RGB Rekordbox waveform previews, and
  allowlisted Spotify/SoundCloud/YouTube source links (plus a non-clickable Soulseek marker), backed
  by HTTP range playback and bounded ANLZ peaks (never a full-file browser decode);
- an independently pinned, collapsible, resizable edit-playlist split for editing one playlist
  while browsing another;
- Rekordbox artwork with embedded audio-tag cover fallback;
- memory-cue and Hot Cue A–P creation, editing, deletion, comments, colors, and loop ranges;
- guarded playlist create, rename, delete, membership, reorder, and atomic visual-order replacement;
- hosted Spotify/SoundCloud download subscriptions that start bounded native Rekordbox analysis for
  each verified recording immediately, then checkpoint and import the completed playlist;
- session-scoped undo/redo for reversible library edits, with toolbar controls and standard
  `Cmd/Ctrl+Z`, `Cmd+Shift+Z`, and `Ctrl+Y` shortcuts;
- a persistent infinite set canvas whose connected track chain becomes playlist order;
- right-click track/playlist/canvas actions and a discoverable keyboard-shortcut palette;
- server-sent library change events so successful web or local-server mutations refresh immediately.

Canvas layout and loose candidates stay in browser-local state until **Apply order** is pressed.
Connections determine order; loose candidates remain outside the playlist, while existing playlist
nodes remain members until explicitly removed. Destructive canvas replacement and folder deletion
carry the exact source snapshot and fail with a conflict if the library changed after confirmation.
Undo and redo execute inverse mutations through the same serialized server queue; they are disabled
while a write is pending or Rekordbox is running. Refreshes, external database changes, page reloads,
successful hosted-playlist writes, and populated playlist/folder deletion clear the in-memory
history.
Database changes still require `--write`; every playlist and cue write uses the same stopped-process,
lock, and SQLite transaction boundary. Audio, artwork, prompts, and metadata remain local. The HTTP
server rejects non-loopback binds, cross-origin writes, unsupported media types, and symlink-backed
media.

Smart-playlist count failures remain `null` in the API and appear as an explicit warning in the
sidebar; the workstation never presents an unavailable count as zero.
