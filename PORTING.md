# Porting log

This file is the durable project journal: source pins, compatibility scope, decisions, milestones, and verification results.

## Source pins

- `dylanljones/pyrekordbox`: `f695541827cc488af267d6ca8a8e0052598d85a0` (2025-12-24)
- `wevm/incur`: `4c0fc4b15b4e0b72136f30b0a0ad25cc35e0a84b` (2026-07-10), npm `0.4.13`

The Python source at the pinned revision is the behavioral specification. Tests are ported or replaced with equivalent fixtures as each area lands.

## Compatibility matrix

| Area                         | TypeScript API | CLI            | Parity tests | Status   |
| ---------------------------- | -------------- | -------------- | ------------ | -------- |
| Configuration discovery      | implemented    | `config show`  | 4 tests      | complete |
| Utility functions            | implemented    | n/a            | 6 tests      | complete |
| Rekordbox XML                | implemented    | `xml ...`      | 6 tests      | complete |
| ANLZ files                   | planned        | planned        | planned      | queued   |
| My Settings files            | implemented    | `settings ...` | 7 tests      | complete |
| Smart playlists              | planned        | planned        | planned      | queued   |
| Master database              | planned        | planned        | planned      | queued   |
| Master DB registry/aux files | planned        | planned        | planned      | queued   |
| Device Library Plus          | planned        | planned        | planned      | queued   |

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

## Next

1. Port ANLZ binary formats.
2. Port smart playlists and both database layers.
3. Complete incur command coverage, parity fixtures, docs, and end-to-end verification.
