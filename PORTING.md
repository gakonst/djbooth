# Porting log

This file is the durable project journal: source pins, compatibility scope, decisions, milestones, and verification results.

## Source pins

- `dylanljones/pyrekordbox`: `f695541827cc488af267d6ca8a8e0052598d85a0` (2025-12-24)
- `wevm/incur`: `4c0fc4b15b4e0b72136f30b0a0ad25cc35e0a84b` (2026-07-10), npm `0.4.13`

The Python source at the pinned revision is the behavioral specification. Tests are ported or replaced with equivalent fixtures as each area lands.

## Compatibility matrix

| Area                         | TypeScript API | CLI             | Parity tests | Status   |
| ---------------------------- | -------------- | --------------- | ------------ | -------- |
| Configuration discovery      | implemented    | `config show`   | 4 tests      | complete |
| Utility functions            | implemented    | n/a             | 6 tests      | complete |
| Rekordbox XML                | implemented    | `xml ...`       | 6 tests      | complete |
| ANLZ files                   | implemented    | `anlz ...`      | 5 tests      | complete |
| My Settings files            | implemented    | `settings ...`  | 7 tests      | complete |
| Smart playlists              | implemented    | `smartlist ...` | 7 tests      | complete |
| Master database              | implemented    | `db ...`        | 5 tests      | complete |
| Master DB registry/aux files | implemented    | via `db ...`    | 1 test       | complete |
| Device Library Plus          | planned        | planned         | planned      | queued   |

## Decisions

### 2026-07-10 — Runtime and packaging

- Require Node.js 22, matching incur's supported runtime.
- Use ESM, strict TypeScript, declaration output, pnpm, Vitest, Oxlint, and Oxfmt.
- Publish from one package with explicit format subpath exports and a `rekordbox` binary.

### 2026-07-10 — API parity policy

- Preserve the important upstream class names (`RekordboxXml`, `AnlzFile`, `MasterDatabase`, `DeviceLibraryPlus`) and semantics.
- Use idiomatic camelCase for the primary TypeScript API. CLI command names use kebab-case.
- Preserve lossless binary/XML round trips wherever pyrekordbox does. Mutating operations must never silently discard unknown data.
- Treat database write commands as opt-in and make dry-run/read-only behavior easy to select.

### 2026-07-10 — Dependencies

- Use `better-sqlite3-multiple-ciphers` for synchronous SQLite and SQLCipher-compatible access. The synchronous model maps closely to pyrekordbox's session-oriented API and incur command handlers.
- Use `fast-xml-parser` for low-level XML tokenization/serialization, wrapped by domain models so the public API is not coupled to the parser.
- Implement Rekordbox binary structures explicitly with `Buffer`/`DataView` instead of adopting an unmaintained Python-Construct analogue.

### 2026-07-10 — XML representation

- Keep the parser's ordered node representation internally so unknown attributes, elements, and their ordering survive a read/write round trip.
- Correct the upstream parsed-document ID bug by seeding auto-increment from the maximum existing track ID, preventing accidental ID reuse.
- Expose source-preserving writes in the library and optional output destinations in mutation commands; overwriting a source file remains explicit in the command invocation.

### 2026-07-10 — Binary preservation

- Keep original ANLZ tag bytes until a supported mutation occurs. This preserves unknown tags and retains the original garbled PSSI representation while exposing a deobfuscated parsed view.
- Bound large waveform/beat-grid CLI output by default and expose offset/limit controls through incur.

### 2026-07-10 — Database safety and mapping

- Introspect physical SQLite schemas at runtime and wrap all 37 upstream models with typed, mutation-tracked row classes. This tolerates schema additions across Rekordbox releases without discarding unknown columns.
- Open databases read-only by default. CLI mutations additionally require `--write`, and commits refuse to run while Rekordbox is open unless explicitly overridden.
- Use SQLCipher legacy mode 4 for Rekordbox's encrypted database and a logical schema/data export for plain-SQLite copies because native page backup cannot cross cipher formats.

## Progress

### 2026-07-10

- Inspected the complete pyrekordbox source/test tree (11,345 source lines, 2,617 test lines) and current incur API.
- Established source pins, project conventions, package exports, runtime dependencies, and the compatibility matrix.
- Created the initial TypeScript package and test/build scaffolding.
- Created and pushed the private `gakonst/rekordbox-ts` GitHub repository.
- Ported utility primitives, including byte-for-byte-compatible zlib/XOR/base85 obfuscation.
- Ported settings/options parsing and cross-platform Rekordbox 5/6/7 installation discovery.
- Added the incur `config show` command and 11 total tests.
- Ported the complete Rekordbox XML domain model: tracks, typed attributes, beat grids, position marks, playlist folders, playlists, key modes, mutation, serialization, and unknown-field preservation.
- Added read and mutation commands under `xml`, verified them against both Rekordbox 5/6 fixtures, and reached 17 passing tests.
- Ported all four My Settings binary formats with symbolic enum values, opaque-byte preservation, strict validation, and CRC-16/XMODEM generation.
- Differentially verified lossless parsing and mutation against all 155 upstream per-setting fixtures; the durable suite now has 24 passing tests.
- Added `settings list`, `show`, `set`, and `create` incur commands, including allowed-value discovery.
- Ported all 15 supported ANLZ tag types, including beat-grid/path mutation, cue lists, PSSI deobfuscation, VBR indices, and monochrome/color/three-byte waveforms.
- Differentially parsed, expanded, and byte-for-byte rebuilt 48 real upstream DAT/EXT/2EX fixtures; the durable suite now has 29 passing tests.
- Added bounded `anlz scan`, `info`, `tag`, `set-path`, and `set-beat-grid` commands.
- Ported smart-playlist XML, condition/operator validation, signed playlist-ID conversion, and parameterized SQLite compilation for all mapped properties.
- Added `smartlist parse`, `build`, and `sql` commands; the durable suite now has 36 passing tests.
- Ported the master database across 37 models: schema introspection, typed relationships, queries, search, staged mutations, rollback/commit, USN assignment, playlists, metadata/content creation, ANLZ coordination, and plain-SQLite export.
- Ported `masterPlaylists6.xml` mutation/synchronization and verified both encrypted and unencrypted upstream databases. The durable suite now has 42 passing tests.
- Added read, generic row, content, playlist, and explicit-write commands under `db`.

## Next

1. Port Device Library Plus.
2. Complete incur command coverage, parity fixtures, docs, and end-to-end verification.
