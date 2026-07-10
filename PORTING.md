# Porting log

This file is the durable project journal: source pins, compatibility scope, decisions, milestones, and verification results.

## Source pins

- `dylanljones/pyrekordbox`: `f695541827cc488af267d6ca8a8e0052598d85a0` (2025-12-24)
- `wevm/incur`: `4c0fc4b15b4e0b72136f30b0a0ad25cc35e0a84b` (2026-07-10), npm `0.4.13`

The Python source at the pinned revision is the behavioral specification. Tests are ported or replaced with equivalent fixtures as each area lands.

## Compatibility matrix

| Area                         | TypeScript API | CLI     | Parity tests | Status |
| ---------------------------- | -------------- | ------- | ------------ | ------ |
| Configuration discovery      | planned        | planned | planned      | queued |
| Utility functions            | planned        | n/a     | planned      | queued |
| Rekordbox XML                | planned        | planned | planned      | queued |
| ANLZ files                   | planned        | planned | planned      | queued |
| My Settings files            | planned        | planned | planned      | queued |
| Smart playlists              | planned        | planned | planned      | queued |
| Master database              | planned        | planned | planned      | queued |
| Master DB registry/aux files | planned        | planned | planned      | queued |
| Device Library Plus          | planned        | planned | planned      | queued |

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

## Progress

### 2026-07-10

- Inspected the complete pyrekordbox source/test tree (11,345 source lines, 2,617 test lines) and current incur API.
- Established source pins, project conventions, package exports, runtime dependencies, and the compatibility matrix.
- Created the initial TypeScript package and test/build scaffolding.

## Next

1. Land utility primitives and cross-platform configuration discovery.
2. Port Rekordbox XML with lossless read/write and playlist operations.
3. Port My Settings and ANLZ binary formats.
4. Port smart playlists and both database layers.
5. Complete incur command coverage, parity fixtures, docs, and end-to-end verification.
