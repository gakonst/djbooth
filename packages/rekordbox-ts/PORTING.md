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
| Device Library Plus          | implemented    | `device ...`    | 4 tests      | complete |

## Decisions

### 2026-07-12 — Analyzer distribution boundary

- Do not publish the repository's analyzer helper or any AlphaTheta/Rekordbox binary in the public
  npm package. Analysis discovers an explicit `analyzerBinary`, `REKORDBOX_ANALYZER_BINARY`, a
  `rekordbox-analyzer` on `PATH`, a user-local helper, or the repository-built development helper.
- Database, ANLZ parsing, locking, metadata, and web-library orchestration remain TypeScript-owned.

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

### 2026-07-12 — Master playlist commit boundary

- Replace `masterPlaylists6.xml` atomically through a same-directory exclusive temporary file, file sync, and rename. Failed writes retain the original source path and modified state while cleaning temporary output.
- Mark the SQLite transaction closed immediately after `COMMIT`. Accept committed row state even when the subsequent companion-file save fails, so the original sidecar error propagates and `close()` cannot mask it with a second rollback error.
- Advance the global local-USN counter for delete events without assigning a field on models already marked deleted; physical playlist and membership deletions can now commit without violating row lifecycle guards.

### 2026-07-10 — Shared database engine

- Reuse the validated schema/query/transaction implementation for Device Library Plus through a composed internal engine. Keep `MasterDatabase` and `DeviceLibraryPlus` as distinct public types because identically named helpers such as `getContent` return different row families.
- Preserve SQLite autoincrement IDs on newly flushed rows, and recognize Device Library Plus's timezone-bearing date columns even though its declared SQLite storage type is `TEXT`.
- Apply the same read-only default and explicit CLI `--write` acknowledgement to exported device libraries. Support the separate upstream default SQLCipher key and `REKORDBOX_DEVICE_DB_KEY` override.

### 2026-07-10 — Compatibility naming

- Keep idiomatic camelCase as the primary TypeScript convention while exporting upstream ANLZ handler names (`PQTZAnlzTag` through `PWVCAnlzTag`), configuration aliases, `toDict`, and the deprecated `Rekordbox6Database` migration class where names carry compatibility value.
- Model SQLAlchemy session features with synchronous callbacks: lifecycle events, `noAutoflush`, registry value access, and temporary/persistent USN tracking controls.

### 2026-07-10 — Global CLI installation and CI

- Treat the database API as the primary product path; collection XML remains a supported interchange format rather than the default local-library interface.
- Install `rekordbox` as the canonical global command and `rekordbox-ts` as an explicit alias. Build `dist` during package creation so published archives do not require committed build artifacts.
- Require pnpm 10's explicit `--allow-build=better-sqlite3-multiple-ciphers` acknowledgement for global installs. This preserves pnpm's native-script security model while enabling the SQLCipher binding needed by database commands.
- Run validation on Node 22 across Linux, macOS, and Windows. Package/global-install CI additionally invokes both command names and queries a real plain SQLite fixture, preventing a command-shim-only false positive.

### 2026-07-10 — Adversarial hardening

- Treat row identity and transaction state as explicit invariants: newly inserted rows retain their lifecycle across autoflush/rollback/delete, default-only inserts use SQLite's `DEFAULT VALUES`, and primary-key changes atomically rekey the identity map.
- Reject invalid runtime values even when TypeScript callers would normally prevent them. This covers query directions and limits, playlist positions and hierarchy cycles, smart-list flags/IDs/numbers, impossible datetimes, and CLI JSON shapes.
- Convert every truncated known ANLZ tag into a domain `AnlzLengthError`, and run 1,000 deterministic mutation cases to prevent native buffer-range exceptions or unstable successful rebuilds.
- Enforce repository-wide coverage floors in a dedicated CI job. Process-level CLI tests exercise incur dispatch, both human/agent command discovery and JSON output, real plain-SQLite queries, malformed arguments, and the write-safety gate.

### 2026-07-10 — Full programmability parity

- Treat SQLAlchemy's open-ended engine/session as a capability requirement, not merely its high-level helpers. Expose parameterized arbitrary SQL, selected-column queries, streaming iteration, the native SQLite connection, explicit model construction, schema metadata, and matching registry hooks.
- Mirror the complete master and Device Library relationship graphs, including writable to-one relationships, association proxies, mutable relationship collections, tree parents/children, and SQLAlchemy's playlist delete cascade.
- Generate master-model physical-column augmentations from the exact pinned Python model source. The checked-in generated declarations give TypeScript consumers the same complete schema surface while runtime introspection continues to tolerate newer Rekordbox columns.
- Match ANLZ's mutable Construct-container capability with raw and parsed byte editors for every tag, automatic PSSI re-obfuscation, complete PQT2 mutation, reparsing/length validation helpers, and CLI byte patching.
- Expose arbitrary SQL for both database families and every new binary/settings operation through incur while retaining read-only defaults, bounded output, parameter binding, and explicit write acknowledgement.

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
- Ported all 22 Device Library Plus models, typed columns, relationship and association-proxy traversal, all upstream query/add helpers, content search, transactions, JSON export, and SQLCipher/plain database access.
- Added `device info`, `table`, `search`, `copy-unlocked`, generic row mutations, content creation, playlist workflows, and My Tag workflows. The durable suite now has 46 passing tests.
- Audited public classes and methods across every pinned Python module, restored compatibility aliases and registry/session hooks, documented the TypeScript and incur interfaces, and prepared version `0.1.0`.
- Completed coordinated CLI coverage for master-library metadata, playlist deletion/rename/reordering, and content/ANLZ filename updates. The generated incur manifest contains 58 executable commands.
- Passed the final `pnpm validate` gate (lint/format, 46 tests, strict typecheck, declaration build), produced a 63-file/121.3 kB npm package, and installed it into a clean temporary project. Root and all format subpath imports plus the installed `rekordbox` binary passed on Node 22.
- Re-ran built CLI commands against upstream Rekordbox XML, My Settings, ANLZ, and encrypted `master.db` fixtures. Also copied the encrypted database to a temporary plain database and verified real metadata/playlist commits through the CLI.
- Confirmed `gakonst/rekordbox-ts` is private, uses `main`, and is synchronized with GitHub.
- Added GitHub Actions CI, source/package build lifecycles, globally installable `rekordbox` and `rekordbox-ts` commands, and database-level global-install smoke coverage. Reworked the README around `MasterDatabase` as the main API flow.
- The first live CI run exposed Windows CRLF checkout behavior in the formatter gate; added repository-wide LF attributes and upgraded to the current official action majors before rerunning the matrix.
- The Windows rerun then exposed POSIX-only XML path assertions. The implementation already matched pyrekordbox's platform-native `normpath`; made the parity tests assert native normalization on Windows as well.
- Completed an adversarial API/CLI audit and fixed transaction lifecycle, identity-map, bounded-count, default-insert, checksum-state, hierarchy-cycle, cross-playlist, runtime-validation, and truncated-binary edge cases.
- Expanded the durable suite from 46 to 56 tests, including 1,000 deterministic ANLZ mutations and subprocess-level CLI coverage. Added enforced V8 coverage floors and made the global package job depend on both cross-platform validation and adversarial coverage.
- Audited every public class method and top-level function in the pinned Python source with AST-generated inventories. Closed the remaining query/session, schema metadata, relationship read/write/cascade, model-construction, PQT2, arbitrary ANLZ mutation, settings reset, and XML return-value gaps.
- Added generated typings for every master.db physical column and new incur commands for arbitrary parameterized master/device SQL, PQT2 editing, raw/parsed ANLZ byte patching, and settings reset. The expanded suite passes 64 tests before differential fixture verification.
- Re-ran the pinned Python project itself under Python 3.12: all 278 upstream tests passed. Then expanded every tag from and byte-for-byte rebuilt all 48 real upstream ANLZ files, rebuilt all 169 My Settings fixtures, round-tripped both Rekordbox 5/6 collection XML fixtures, and sampled every mapped table from the encrypted upstream master database.

### 2026-07-12

- Hardened the direct master-database playlist commit boundary with atomic companion-file replacement and regression coverage for post-commit save failures, original-error propagation, cleanup, and close behavior.

## Next

The pinned pyrekordbox port and incur CLI are complete. Future work should track new upstream pyrekordbox or Rekordbox format revisions rather than expand the pinned scope.

## Native analyzer checkpoint

- Added a narrowly scoped Rust rehost helper containing only Rekordbox backend discovery/cache and
  native analysis code. The private package includes the same provenance-tracked minimal Rekordbox
  6.8.2.0018 runtime payload used by `djskills`; build caches and full application resources remain
  excluded.
- Added `analyzeTrack` plus `rekordbox analyze doctor|track`, producing parseable DAT/EXT/2EX files,
  an atomic JSON summary, and native log.
- Added `MasterDatabase.installContentAnalysis` and
  `rekordbox db content install-analysis` to copy verified artifacts into the UUID-derived share path,
  rewrite PPTH to the permanent content path, and update Rekordbox analysis fields.
- Extended installation to schema-validate `analysis.json`, bind its source fingerprint to the exact
  content audio path, persist tempo as integer BPM hundredths, normalize analyzer keys to canonical
  Camelot names, and resolve the corresponding active `djmdKey` row before commit. Added
  `MasterDatabase.syncContentAnalysisMetadata` and
  `rekordbox db content sync-analysis-metadata` for metadata-only repair without recopying ANLZ files.
- Strengthened set-import postverification to compare the reopened `djmdContent.BPM`, `KeyID`, and
  active key name with the analyzer summary. A warm checkpoint with installed analysis files but
  missing or mismatched BPM/key now enters the same backed-up transaction repair path instead of
  being accepted from `AnalysisDataPath` and `Analysed` alone.
- Verified native analysis against Rekordbox 6.8.2.0018 and database installation against a decrypted
  temporary copy of the live schema; the live library was not modified.
- Historical private builds included a vendored runtime. Public package verification now rejects
  AlphaTheta/Rekordbox binaries and requires an explicit or locally discovered analyzer helper.

## Playlist inspection checkpoint

- Added `MasterDatabase.getPlaylistTracks`, a single joined query that preserves membership
  duplicates and orders regular playlists by `djmdSongPlaylist.TrackNo`. Smart playlists compile
  relation-aware criteria into one joined query with deterministic content ordering; unsupported
  criteria fail closed instead of widening the selection.
- Added `rekordbox db playlist show <exact-name>`, defaulting to Incur's aligned Markdown table and
  returning complete, chainable track metadata with `--json`. Exact-name ambiguity fails with
  candidate playlist and parent IDs; `--parent-id` and `--id` provide explicit scoping.
- Covered joined artist/key metadata, BPM hundredths, nullable duration, file formats, pagination,
  playlists over 100 tracks, duplicate memberships, smart criteria, JSON, Markdown, packed CLI/MCP,
  and ambiguity behavior with plain-database fixtures, then verified both output modes read-only
  against the encrypted live Adam Ten playlist.

## Native analyzer performance checkpoint

- Profiled one 6:25 M4A with Xcode 26 Time Profiler. The original wrapper took 18.14 seconds wall;
  the optimized wrapper takes 8.65 seconds wall with identical 124.999776 BPM, F key, and parseable
  DAT/EXT/2EX output. Native completion is 8.31 seconds; backend setup fell from about 0.50 seconds
  to 0.06 seconds and template preparation from about 0.67 seconds to below timer resolution.
- Removed cache-hit codesigning, recursive 44,000-file template scans, full 101 MB binary hashing,
  and full-image offset validation from the per-track hot path. Cold cache creation and `doctor`
  still hash every source artifact; the hot path trusts the sized provenance manifest and validates
  the known function signatures with bounded file reads.
- Replaced one-second polling and a fixed two-second delay with 25 ms polling plus output stability.
  Treat `.2EX` as a newly created file, use monotonic deadlines, report explicit timeouts, and guard
  callback state with a mutex instead of racing Rekordbox's callback thread.
- Time Profiler places the remaining CPU time in Rekordbox AAC decode, beat, waveform, vocal, and
  song-structure analysis. The wrapper does not have another material CPU hotspot.
- Added `analyzeTrackAsync`, bounded `analyzeTracks`, and `rekordbox analyze tracks`. Each concurrent
  track uses an isolated x86_64 process because Rekordbox has singleton/global analyzer state and the
  rehost redirects process-global stdout/stderr. Four real Brunello-set tracks completed in 9.10
  seconds wall with four workers; serial execution would take roughly 35 seconds. A later full-set
  profile measured 26 real tracks at 60.02 seconds with four workers, 32.23 seconds with eight, and
  28.83 seconds with twelve. A 64-default stress run completed 27 compatible real artifacts in 23.85
  seconds at effective concurrency 27 and 1.13 tracks/second; two other files reproduced a native
  `startAnalyze` incompatibility at concurrency one and were excluded. The default remains 64
  (bounded by the uncached track count) to prioritize set-level wall time; callers can lower it to
  constrain CPU and memory. The batch result reports preflight time, analyzer time, cache hits, and
  throughput; a warm 26-track cache validation took 11.65 ms.
- Packaged sanitized DAT/EXT seed shapes and made them the fallback when a local Rekordbox analysis
  library is absent. Build and packed-package smoke checks now fail if either seed is missing. An
  extracted npm tarball analyzed the same track with an empty HOME and no prebuilt runtime cache in
  14.58 seconds cold, producing the same valid DAT/EXT/2EX, BPM, and key result.
