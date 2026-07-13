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

The workbench provides playlist hierarchy and search, health filters, ordered track browsing,
metadata and analysis inspection, local audio preview, and guarded playlist create, rename, delete,
membership, and reorder operations. Audio and metadata remain local; the HTTP server rejects
non-loopback binds, cross-origin resources, unsupported audio types, and symlink-backed audio.
Smart-playlist count failures remain `null` in the API and appear as an explicit warning in the
sidebar; the workbench never presents an unavailable count as zero.
