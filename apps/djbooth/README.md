# djbooth.ai app

Local-first agentic workstation for discovery, acquisition, analysis, stems, library management,
and DJ practice. It uses typed APIs directly, keeps media local, and produces
Rekordbox-compatible database and analysis artifacts.

The same workstation ships as a Tauri 2 macOS app. Development and release builds are:

```sh
codex login # once; the app reuses the standard ~/.codex/auth.json ChatGPT session
pnpm --filter @gakonst/djbooth-app desktop:dev
pnpm --filter @gakonst/djbooth-app desktop:build
pnpm --filter @gakonst/djbooth-app desktop:dmg # optional Finder-styled DMG
```

The loopback host owns and refreshes the shared Codex ChatGPT credential; tokens never enter the
webview or WASM worker. `OPENAI_API_KEY` remains a fallback for machines without a ChatGPT login.

`desktop:build` creates `src-tauri/target/release/bundle/macos/djbooth.ai.app`. The bundle is
self-contained: it carries Node.js 22, the production dependency tree and encrypted SQLite addon,
the clean analyzer, uv, the standalone `python/stems-mlx` project, and the built web/WASM assets.
Python 3.12, locked MLX wheels, and the pinned
model are installed into the existing user cache on first stems use rather than inflating every app
download. Release preparation strips the copied Node sidecar and removes type maps, source maps,
native-addon build inputs, and browser-only YouTube bundles from the generated runtime tree; package
licenses and executable code remain. macOS signing/notarization credentials are intentionally left
to the release environment.

```sh
djbooth library status --format json
djbooth library serve --open
djbooth library serve --open --no-assistant # Codex/Claude hosts the conversation
djbooth library serve --write
```

Agent-hosted mode keeps the complete visual workbench and processing backend while omitting the
Nanocodex rail, browser worker, Responses authorization endpoint, and WebSocket proxy. Use the
marketplace djbooth skill to let Codex or Claude Code launch this mode beside its own chat surface.

For repository development, one command starts the SQLite/API server on an ephemeral loopback port
and the Vite client with HMR on `http://127.0.0.1:4179/`:

```sh
pnpm app:dev
pnpm app:dev -- --read-only # optional
```

Development writes are enabled by default. `--path`, `--port`, `--api-port`, and `--open` are also
available; the browser always reaches the API through Vite's same-origin `/api` proxy.

The server binds to `127.0.0.1`. Browsing is read-only. `--write` enables serialized local SQLite
mutations behind the cross-process lock and stopped Rekordbox/rekordboxAgent check. Writes update
the optimistic UI immediately and commit once; they do not create per-edit backups, journals, or
post-write verification passes.

The workstation provides:

- playlist hierarchy and search, health filters, ordered and column-sortable track browsing;
- a persistent one/two-deck practice surface with Deck A stacked above Deck B, key track metadata,
  RGB Rekordbox waveform
  previews, accessible rotary three-band Web Audio EQ/trim controls, equal-power crossfader, and
  timed A↔B transitions. Completed four-source jobs expose synchronized Orig/All/Vocal/Drums/Bass/
  Other switches directly on each playing deck without decoding the full stem set into memory.
  Allowlisted Spotify/SoundCloud/YouTube source links (plus a non-clickable Soulseek marker) retain
  provenance. Local playback uses HTTP ranges and bounded ANLZ peaks, never a full-file browser
  decode; provider embeds remain unmodified until an independently acquired local match exists;
- an independently pinned, collapsible, resizable edit-playlist split for editing one playlist
  while browsing another;
- Rekordbox artwork with embedded audio-tag cover fallback;
- memory-cue and Hot Cue A–P creation, editing, deletion, comments, colors, and loop ranges;
- guarded playlist create, rename, delete, membership, reorder, and atomic visual-order replacement;
- hosted Spotify/SoundCloud acquisition subscriptions that start automatically when a playlist is
  opened and run through the shared djbooth.ai identity, Soulseek/native fallback, verification,
  clean analysis, checkpoint, and import pipeline. Analysis begins for each verified recording
  immediately. Provider sections are collapsed by default and remember their expansion state.
  Playlist rows and the selected-playlist status strip expose durable acquisition progress, retry,
  and stop-sync actions. Reopening or retrying verifies and reuses completed canonical recordings;
  downloader calls run only for missing, corrupt, or identity/duration-invalid media.
  Playlist/track metadata is cached in the bounded local control database for 30 minutes and remains
  available as a seven-day offline fallback. Expired rows return immediately while one background
  refresh updates them, so provider latency never blocks revisiting a known playlist; acquired
  recordings are already durable local media.
  Because
  SoundCloud currently treats every OAuth client as confidential, `soundcloud auth login` retains
  that locally supplied app secret alongside rotating tokens in the same mode-`0600` session so a
  packaged app can refresh without inheriting shell environment variables;
- session-scoped undo/redo for reversible library edits, with toolbar controls and standard
  `Cmd/Ctrl+Z`, `Cmd+Shift+Z`, and `Ctrl+Y` shortcuts;
- a persistent infinite set canvas whose connected track chain becomes playlist order;
- right-click track/playlist/canvas actions and a discoverable keyboard-shortcut palette;
- server-sent library change events so successful web or local-server mutations refresh immediately.
- a full-height Nanocodex conversation rail. The persistent agent loop and retained history run in
  the published `nanocodex/browser` Rust/WASM binding inside a dedicated Worker; a same-origin
  loopback WebSocket relay adds the shared Codex/ChatGPT authorization without exposing it to the
  page. The CSP permits WebAssembly compilation through the narrow `wasm-unsafe-eval` source while
  explicitly permitting Nanocodex's generated JavaScript code cells; those cells execute in the
  dedicated Worker, whose stricter response policy allows only same-origin fetches and the local
  Responses socket;
- typed, validated assistant tools for literal lookup, semantic library discovery, playlist and cue
  writes, clean-room analysis, MLX stems, deck loading, EQ, crossfader placement, and timed
  transitions. Mood, occasion, energy, and set-building prompts first
  inspect bounded genre/BPM facets, then curate real playable IDs into a temporary, filterable crate;
  literal title/artist searches remain ordinary search. Filesystem paths are stripped from model
  candidate results. The model stages bounded plans; the normal application layer remains the sole
  executor of library mutations;
- visible per-deck MLX generation/live-mix controls and a local analyzer/MLX job queue. Duplicate active requests
  collapse, complete stem files are reused, and CPU analysis may overlap the serialized GPU lane.
  Compatible stem requests arriving in the same 50 ms burst run as one batch and share a single
  model load.
  Generated artifacts live under `~/Music/Rekordbox Derived/` and are not silently imported into
  the live Rekordbox database; the audition view can compare the original, four-stem sum, or any
  solo stem.

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
