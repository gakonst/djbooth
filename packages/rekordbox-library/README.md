# @gakonst/rekordbox-library

Local-first browser workbench for a normal Rekordbox 6/7 library. It uses the typed
`@gakonst/rekordbox` API directly; it does not shell out to the CLI or upload a library.

```sh
music library status --format json
music library serve --open
music library serve --write
```

The server binds to `127.0.0.1`. Browsing is read-only. `--write` enables guarded playlist
mutations: cross-process lock, stopped Rekordbox/rekordboxAgent check, checksummed backup,
durable intent/outcome journal, single commit, and post-write semantic, SQLite-integrity, and
`masterPlaylists6.xml` verification. A failed mutation reports its recovery backup and journal;
the journal distinguishes database, playlist-sidecar, verification, and receipt outcomes.

The workstation provides:

- playlist hierarchy and search, health filters, ordered track browsing, and metadata and analysis
  inspection;
- a WaveSurfer player backed by HTTP range playback and bounded Rekordbox ANLZ peaks, with a flat
  streaming placeholder when analysis peaks are unavailable (never a full-file browser decode);
- Rekordbox artwork with embedded audio-tag cover fallback;
- memory-cue and Hot Cue A–P creation, editing, deletion, comments, colors, and loop ranges;
- guarded playlist create, rename, delete, membership, reorder, and atomic visual-order replacement;
- a persistent infinite set canvas whose connected track chain becomes playlist order;
- right-click track/playlist/canvas actions and a discoverable keyboard-shortcut palette;
- a local prompt dock for deterministic playlist, search, canvas, and cue commands; and
- server-sent library change events so successful web or local-server mutations refresh immediately.

Canvas layout and loose candidates stay in browser-local state until **Apply order** is pressed.
Connections determine order; loose candidates remain outside the playlist, while existing playlist
nodes remain members until explicitly removed. Destructive canvas replacement and folder deletion
carry the exact source snapshot and fail with a conflict if the library changed after confirmation.
Database changes still require `--write`; every playlist and cue write uses the same stopped-process,
lock, backup, journal, commit, and semantic-verification boundary. Audio, artwork, prompts, and
metadata remain local. The HTTP server rejects non-loopback binds, cross-origin writes, unsupported
media types, and symlink-backed media.

Smart-playlist count failures remain `null` in the API and appear as an explicit warning in the
sidebar; the workstation never presents an unavailable count as zero.
