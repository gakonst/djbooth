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

### 2026-07-28 — Samply profiles and adaptive clean scheduling

- Profile the optimized, debuginfo-enabled Rust release with Samply 0.13.1 at 1 kHz. A five-run,
  491-second M4A scalar profile attributes 23.6% of CPU to decode, 23.4% to waveform generation,
  22.9% to beat spectral flux, 18.6% to key chroma, and 10.3% to beat post-processing. Stateful
  waveform biquads are the largest leaf at 21.3%.
- Single-track scaling plateaus at four native threads: medians are 1,456.7 ms at one thread,
  705.5 ms at four, 704.9 ms at eight, and 721.8 ms at twelve. Default clean single-track wrappers
  to four threads while preserving explicit overrides.
- Prefer independent process parallelism for batches. A cold 100-track, 8.55-hour corpus improves
  from 16.09 seconds at four processes to 11.33 seconds at twelve (29.6% lower wall time);
  an initial 24-process run reaches 11.23 seconds. Rotated repeats put 12 and 24 at effectively
  identical 11.402/11.401-second medians, while 32 reaches 11.503 seconds. Aggregate analyzer RSS
  peaks at 0.60 GiB at four processes, 1.60 GiB at twelve, 3.02 GiB at twenty-four, and 4.10 GiB at
  thirty-two on the 12-core/32-GiB profiling host.
- Default clean batch concurrency to `min(12, availableParallelism, threadBudget, uncachedTracks)`.
  Preserve explicit concurrency and thread budgets, ordered results, isolated processes, and
  deterministic worker-budget division. Both explicit limits remain available through 64 for
  deliberate oversubscription.

### 2026-07-26 — Composed CLI runtime

- Pin Incur `0.4.13` across every package mounted by `@gakonst/music`. Clean consumers must not
  resolve structurally incompatible Incur copies for parent and child CLI definitions.
- Restore the hardware-proven periodic UDP/50002 `LINK_REPLY(0x06)` media
  announcement in the vendored DJ Link server. A live USB replug changed the
  Mac link-local address; after rebinding, all three CDJ-3000 keepalives arrived
  but no status/query/ACK traffic returned until the compatibility beacon was
  restored.

### 2026-07-13 — Long-lived database sessions

- Expose explicit identity-map expiry for services that retain an open SQLite connection. Reject
  expiry while changes are staged or flushed so transaction rollback never loses its row state.
- Collect Rekordbox and rekordboxAgent PIDs from one operating-system process snapshot at commit
  guards, preserving the existing individual process lookup APIs for compatibility.

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

- Added `MasterDatabase.listPlaylists` as the shared active-hierarchy inventory for the Rekordbox CLI
  and local library workbench. It filters soft-deleted and unsupported rows, batches regular-playlist
  membership counts, returns folder/regular/smart types with stable parent and sequence metadata, and
  preserves smart-count failures without failing the complete inventory.
- Added `rekordbox db playlist list`, returning the complete active hierarchy in Rekordbox tree order
  as an aligned table by default. `--type playable` selects regular and smart playlists, `--limit`
  and `--offset` opt into reported pagination, and `--json` adds canonical `pathSegments` and `idPath`
  alongside the presentation-only display path.
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
  `startAnalyze` incompatibility at concurrency one and were excluded. The original reference-engine
  default was four workers; the batch result reports preflight time, analyzer time, cache hits, and
  throughput. A warm 26-track cache validation took 11.65 ms.
- Packaged sanitized DAT/EXT seed shapes and made them the fallback when a local Rekordbox analysis
  library is absent. Build and packed-package smoke checks now fail if either seed is missing. An
  extracted npm tarball analyzed the same track with an empty HOME and no prebuilt runtime cache in
  14.58 seconds cold, producing the same valid DAT/EXT/2EX, BPM, and key result.

## Analyzer scheduler/cancellation checkpoint (2026-07-14)

- Historical Codex sessions and the benchmark above showed that a blanket 64-worker default
  oversubscribed interactive hosts. Batch analysis initially defaulted to four process-isolated
  workers; the 2026-07-28 clean-engine profile replaces that with a bounded CPU-adaptive default.
- Batch analysis exposes structured cache/start/completion/failure/cancellation progress. The Incur
  CLI renders it on stderr by default for humans and agents, with `--progress never` available.
- Progress callbacks are observational; callback exceptions are isolated from analyzer workers.
- A mixed-success batch throws `AnalyzeTracksError`, which carries indexed failure classes and the
  ordered partial result. Successful summaries stay durable and become cache hits on resume.
- A cancelled batch throws abort-compatible `AnalyzeTracksCancelledError` with the ordered sparse
  partial result and exact cancelled count, so callers can checkpoint completed/cache-hit work.
- Async analysis accepts an `AbortSignal`; SIGINT/SIGTERM abort active native children, escalate to
  SIGKILL after one second, and stop scheduling queued tracks. The synchronous single-track wrapper
  can reject an already-aborted signal but cannot interrupt `spawnSync()` after launch.
- The exact native `startAnalyze` status `-1` on Unicode-heavy paths retries through byte-identical
  ASCII input/output staging. Validated DAT/EXT/2EX/log artifacts move atomically to the canonical
  output path and the persisted summary is rewritten to the original source/output paths. Both real
  Brunello “Duel” variants completed through this compatibility path; unrelated failures do not
  trigger it.

## Content cue checkpoint (2026-07-13)

- Audited the pinned pyrekordbox declarations, the current Rekordbox 7 manual, PCOB/PCO2 parser,
  and a live database read-only. Confirmed `djmdCue.Kind = 0` for memory cues and `1..16` for Hot Cue
  slots A through P; `OutMsec = -1` distinguishes a point from a loop; memory ordering is temporal,
  not a stored sequence column; and master-library cue edits have a denormalized `contentCue.Cues`
  JSON mirror. No live database was modified.
- Added typed `ContentCuePoint`, `ContentCueInput`, `HotCueSlot`, and coordinated
  `getContentCues`, `upsertContentCue`, `deleteContentCue`, and `setContentCues` APIs. Mutations
  validate ownership, duration, millisecond quantization, cue/loop shape, active-loop use, comment
  and color bounds, ten-memory-cue capacity, unique Hot Cue slots, and canonical replacement order.
- Cue mutations stage the physical frame/time fields, increment `djmdContent.CueUpdated`, and sync
  the active `contentCue` JSON mirror in the same SQLite transaction. New arbitrary-time cues use
  Rekordbox's observed zero/null physical-field mode. Metadata-only edits preserve native MPEG,
  microsecond, beat-loop, and seek fields; moving a cue consistently downgrades those fields to the
  zero/null mode rather than creating a hybrid row. PCOB/PCO2 ANLZ tags remain byte-preserving and
  read-only until the binary writer can safely update every redundant cue representation.
- Added Incur `db content cues`, `set-cue`, and `delete-cue`. Mutations require explicit `--write`,
  reject the general `--allow-while-running` bypass, canonicalize real/relative/symlink database
  paths onto the shared `.tracks-ts.lock`, serialize stale-lock reclamation, verify the lock inode
  and UUID ownership token before release, require both Rekordbox processes stopped, create a
  checksummed pre-write database/companion backup and durable outcome journal, commit once, then
  reopen read-only for SQLite integrity and exact semantic verification. Update-by-ID uses patch
  semantics so omitted Hot Cue loop, comment, and color fields are preserved.
- Added copied plain-SQLite fixture coverage for reads, row classification, creation, slot upsert,
  deletion, exact replacement, mirror synchronization, physical field values, ordering, limits,
  malformed input, cross-content ownership, guarded backup/journal receipts, process refusal, and
  canonical-lock contention, mirror-field corruption, and exact CueUpdated verification. The
  package suite passes 98 tests.

## Pro DJ Link protocol/network checkpoint (2026-07-26)

- Imported the provenance-tracked `djskills` Rust server into `@gakonst/djlink`; the TypeScript
  bridge projects completed Tracks manifests into bounded RemoteDB/NFS libraries and exposes
  managed `music djlink doctor|start|status|devices|load|monitor|stop` commands.
- Wrote a versioned protocol map with pinned Beat Link, Dysentery, and prolink-connect references.
  Added golden keepalive, CDJ status, load-command, and load-ack packets from the proven CDJ-3000
  capture set. Replaced keepalive byte-offset parsing with typed frame/header/body codecs.
- Restored macOS interface fidelity lost during the async actor port. Every DJ Link UDP socket now
  uses `IP_BOUND_IF`; outbound TCP side channels bind the same interface and source address. A
  dedicated blocking actor exclusively owns the BPF descriptor for MAC-directed packets and
  1,500-byte IPv4 fragmentation, without holding a mutex across an async suspension point.
- Kept the kernel socket as the primary path. Link-local route failures and oversized NFS replies
  fall back to raw Ethernet/IPv4/UDP; broadcast failures use the interface broadcast MAC. Strict MAC
  parsing and reassembly tests cover the observed 64,512-byte NFS response ceiling.
- The focused Rust suite passes 88 tests. Live verification remains gated on renewed CDJ
  announcements; no unverified transport command or automatic PLAY action is enabled.

## Pro DJ Link source/pcap lab checkpoint (2026-07-26)

- Kept the provenance-tracked Rust implementation in `packages/djlink/native` and made direct
  `cargo run -p music-djlink` the protocol iteration path. Added `audit-pcap` for bounded JSON
  packet-shape reports, mandatory source-discovery gates, reference diffs, and exact static-payload
  checks against `/Users/gakonst/github/gakonst/djtools/rb-tracks.pcap`
  (`519c84fe225d5b310e7ab73c84bc2333c0ee7c048b32a5d3f11f9d519baf1845`).
- Added a source-owned `--wire-pcap` sink at the raw-BPF writer. It records only Ethernet frames
  successfully injected by the server, closing macOS's observability gap where a second BPF
  consumer does not see injected frames. External interface capture remains authoritative for
  deck replies.
- Promoted the real Rekordbox `0x16`, `0x29`, `0x06`, and `0x47` payloads plus the CDJ-3000
  `0x46` trigger into typed golden codecs. The real and formerly working captures prove
  `0x05→0x06` and `0x46→0x47` are unicast, response-gated exchanges; removed the rewrite's
  non-faithful periodic `0x06` broadcast.
- A live source capture passes the keepalive/link-init/mixer-status gates and matches the real
  Rekordbox `0x16` and `0x29` bytes exactly. The wired interface remains frozen at 480 inbound
  packets and the daemon sees zero decks, so hardware load verification is still gated below the
  parser by absent switch/deck ingress. The current Rust suite passes all 95 tests; the complete
  `@gakonst/djlink` validation also passes.

## Pro DJ Link RemoteDB cursor checkpoint (2026-07-26)

- Recovered the original native Rekordbox `rb-tracks.pcap` from git object
  `123e84e` and decoded it independently from the stale checked-in report. Native next-track
  renders at offsets 1 and 2 return `MENU_HEADER [1,1]` and `[1,2]`; the failing live server trace
  returned the correct track rows and file data but wrapped both in `MENU_HEADER [1,0]`.
- Changed render responses to echo the requested offset in the menu header. This is the concrete
  wire delta associated with the physical CDJ-3000 `NOW LOADING`/Back-button failure.
- Removed the per-deck-IP actor cache that guessed render menus by key and row count across TCP
  connections. Each spawned RemoteDB connection now owns only its last prepared menu, matching the
  protocol's request-then-render transaction model and isolating concurrent browse/metadata
  sessions without mutexes or reconnect recovery.
- Added regression coverage for nonzero native header offsets, last-request replacement, exact
  `r:m:s:t` matching, total-count rejection, parallel connection isolation, and stale-device
  expiry. Focused tests pass; the full Rust workspace passes 110 tests.
- Extended `audit-pcap` to reassemble every TCP direction, decode typed RemoteDB messages, correlate
  RENDER/MENU_HEADER pairs by transaction, and gate on at least one nonzero cursor. The immutable
  native capture passes all 25 renders; the prior broken live capture fails exactly three nonzero
  renders with header offset zero. Exact transaction `0x1883` request/response bytes are golden
  fixtures.
- Changed `music djlink rekordbox` with no track into one validate → start/resume → discover flow;
  refreshed Incur hints, retry metadata, CTAs, the canonical/plugin/global Music skill, and the
  generated global `music-djlink` skill. The complete root `pnpm validate` passes. Live repeated
  physical TRACK SEARCH verification remains the final hardware gate.
- Fixed actor-owned discovery expiry to enforce Beat Link's 10-second maximum announcement age and
  clear stale link/status/load state. A fresh restart now reports no devices instead of three
  14-minute-old false positives; player 3 still answers ARP but is not currently emitting DJ Link
  keep-alives, so the final gate awaits a physical wake.

## Pro DJ Link live load parser checkpoint (2026-07-26)

- Reconnected three physical CDJ-3000s and restarted the server on the adapter's renewed
  `169.254.147.145` link-local address. Added raw unicast fallback for macOS
  `EADDRNOTAVAIL` (`os error 49`) during link-local address churn.
- Verified the cursor change on player 3: a real Track Search render at offset 1 returned
  `MENU_HEADER [1,1]`, and the typed capture auditor reported 78 matching render/header pairs with
  no mismatch or missing header.
- Re-derived the remaining Back-button stall from the raw TCP capture. A `WAVEFORM_PREVIEW`
  request advertises five argument types but deliberately omits its final zero-length blob. The
  parser's blocking `peek()` waited for the first byte of the next request, so Back or the deck's
  15-second retry accidentally released the previous load.
- Replaced that heuristic with the RemoteDB length invariant: when a blob's immediately preceding
  length is zero, synthesize an empty blob without reading another byte. A regression test replays
  the exact 45-byte CDJ request while keeping the connection open and proves parsing completes
  without a follow-up request. The live server replay now returns the 948-byte waveform response in
  1.49 ms.
- Matched native Rekordbox artwork behavior by decoding, center-cropping, and caching 240×240 JPEG
  thumbnails instead of serving 500–800 px originals. The native capture contains only 240×240
  JPEGs (maximum 20,966 bytes); the old server sent images up to 105,957 bytes. RemoteDB sockets now
  enable `TCP_NODELAY`, check every load-path response write, and log response byte counts or exact
  errors rather than discarding `write_all` results.
- Verified the complete fixed path against physical CDJ-3000 player 3 with track `79496558`. The
  deck requested mount data after 4.8 ms, received its waveform-preview reply in 197 µs, began NFS
  FLAC reads after 293 ms, and reported the track paused/cued after 433 ms. Its artwork was a
  native-sized 15,639-byte JPEG and no response write failed. Nightly formatting and all 113 Rust
  workspace tests pass; the complete root `pnpm validate` also passes on Node.js 22.
- Verified a second consecutive hardware load without Back: player 3 acknowledged track `24490981`
  (`Glue`), completed metadata, analysis, artwork, waveform, and NFS requests, then reported it
  paused/cued after 536 ms. The final capture contains 13 matching RemoteDB render/header exchanges,
  zero mismatches, zero missing headers, and no TCP sequence gaps. The earlier physical Track
  Search capture remains the cursor gate: 78 matching exchanges including offset 1.

## Pro DJ Link search checkpoint (2026-07-27)

- Added an end-to-end loopback regression for the native CDJ Search flow. It fragments the
  documented packed `r:m:s:t,sort,len,query,zero` request across TCP writes, requires a bounded
  success response, and asserts the exact loadable title-and-artist row plus menu header/footer.
  It then issues a second split-context artist Search and packed render on the same connection,
  proving the prepared menu advances without Back or reconnect.
- Precomputed normalized title, artist, album, canonical-name, and metadata search documents when
  the server loads the Rekordbox snapshot. The 14,929-track live library's `SCIENCE` query dropped
  from 232.7 ms to 9–18 ms with identical results; an intentionally broad one-character query
  dropped from 81.9 ms to 31.4 ms after removing per-comparison title allocations.
- Added bounded, read-only `music djlink search <query> --mode track|artist|album` diagnostics over
  the protected control socket. It uses the exact prewarmed matcher and RemoteDB row builder served
  to CDJs, separating local index/result failures from a deck that never sends `SEARCH(0x1300)`.
  Updated CLI hints, README, canonical Music skill, and bundled plugin guidance.
- Removed the stale unsolicited `LINK_REPLY(0x06)` broadcaster. The native Rekordbox capture has
  one unicast `0x05 -> 0x06` exchange; the live corrected source likewise answered one startup
  query per deck and emitted no periodic media reply. The existing request handler remains
  byte-exact against the captured Rekordbox packet.
- Two bounded player-3 captures contained status traffic but no TCP/1051 data, Search status menu,
  or `SEARCH(0x1300)` request because no physical Search submission occurred during their windows.
  Final physical Search UI activation/result/load proof remains open.
- A subsequent trace captured the missing CDJ-3000 path: keyboard edits emitted `0x1500` requests
  (`R`, `RA`, `RAF`, `RAFA`) with packed context, sort, UTF-16 byte length, and string, but the
  server returned `INVALID_REQUEST(0x4003)`. The deck closed and rediscovered RemoteDB after each
  rejected keystroke. Added `0x1500` as incremental Search using the same prewarmed matcher,
  connection-local pending menu, and loadable row builder as legacy `0x1300`; pinned the captured
  `RAFA` request as a golden fixture and extended the no-Back same-socket Search/Render regression.
  Nightly format and all 112 `djtools-link` tests pass. Physical result/render/load proof is pending.

## Clean-room analyzer checkpoint (2026-07-27)

- Split a releasable `native/rekordbox-analyzer-core` crate from the private Rekordbox rehost. The
  core has no Rekordbox/JUCE bytes, loader offsets, patched application cache, or native framework
  dependency.
- Added a strict PMAI/tag parser and writer that preserves unknown headers, repeated/unknown tags,
  and opaque payload bytes. Added semantic builders for the complete Rekordbox 6.8.2 DAT, EXT, and
  2EX shapes: paths, VBR index, beat grids, all waveform families, and PWVC. Non-empty cues and the
  obfuscated song-structure payload remain losslessly opaque.
- Re-ran the same local audio through the 6.8.2 reference rehost. All three outputs matched the
  retained analysis byte-for-byte, establishing that the proprietary implementation is a stable
  exact oracle. The Rust semantic writer then rebuilt its 9,054-byte DAT, 188,324-byte EXT, and
  182,358-byte 2EX byte-for-byte.
- Added a structured `diff` gate with SHA-256, ordered-tag, length, and first-different-byte reports,
  plus `rebuild-anlz` for serializer parity. Unit tests cover malformed lengths, unknown-byte
  retention, DAT/2EX semantic round trips, checked-in sanitized DAT/EXT templates, and differential
  localization.
- Static symbols show that JUCE supplies orchestration, strings, threads, and audio I/O, while
  `BA_*` and `peakss::*` implement proprietary beat, waveform, and key analysis. Release-ready DSP
  parity remains open: audio framing/resampling, waveform quantization, VBR indexing, beat
  detection/post-adjustment, key detection, and phrase analysis must be re-derived against
  synthetic oracle probes. The vendor helper and Rekordbox runtime remain local-only references and
  must never enter release artifacts.

## Clean DSP and physical incremental-search checkpoint (2026-07-27)

- Completed a clean Rust audio-to-ANLZ path: Symphonia decode, deterministic mono/44.1 kHz
  resampling, all seven waveform families, spectral-flux/autocorrelation rhythm analysis,
  tuning-aware chroma/HPCP key detection, MP3 VBR indexing, and atomic DAT/EXT/2EX plus
  helper-compatible summary output persisted as `analysis.json` by the TypeScript wrapper. Nightly
  format, 25 passing unit tests, two end-to-end integration tests, and strict
  all-target/all-feature Clippy pass.
- Differential-tested three real recordings without mutating the library. Tempo error was
  0.105–0.177%; key matched D, Bm, and Gm; detailed monochrome waveform correlation was
  0.985–0.999; release analysis took 0.52–0.98 seconds per track. Downbeat phase, three-band
  normalization, phrase `PSSI`, and proprietary DSP byte parity remain open and are reported
  explicitly. Semantic EXT rebuilds now preserve undocumented FLAC `PVB2` sections byte-for-byte.
- Re-derived `PWV7` packing from 114 local 6.8.2 2EX oracles (5,279,881 entries) plus deterministic
  pure-tone probes: bytes are 7-bit low/mid/high, not 8-bit mid/high/low. Correcting only those two
  proven fields raised aligned three-track band correlations from 0.158–0.782 to 0.533–0.937 and
  cut mean per-band absolute error from 31.58–48.12 bytes to 9.50–12.78 bytes. The overlapping
  filters, stateful envelope, and channel-specific nonlinear normalization remain open.
- Re-derived MPEG-1 Layer III `PVBR` from 44 paired local Rekordbox 6.8.2 analyses: 36 CBR inputs
  retain the native zero table, while eight `Xing` VBR inputs match all 3,200 oracle entries using
  first-data-frame-relative offsets and an eight-frame decoder preroll. The Science Fiction
  generated `PVBR` tag now matches its oracle SHA-256 exactly. Unsupported MPEG/VBR variants fail
  conservatively to the zero table rather than emitting guessed byte offsets.
- Made clean analysis the TypeScript and one-shot Tracks default. Added explicit
  `clean|reference` engine selection, engine-safe caches, helper/runtime separation, and
  `import-set` analyzer binary/cache/timeout plumbing. An identity handshake rejects the legacy
  proprietary helper before clean audio analysis; the clean doctor and a full Crystalised CLI run
  pass without loading Rekordbox.
- Changed the analyzer build to produce only the clean universal Rust helper outside `vendor`.
  Package release files exclude the tracked private reference helper and the 102 MiB Rekordbox
  runtime; those remain local differential oracles. The helper build now places the required
  MPL-2.0 Symphonia source/license notice beside every universal binary.
- Hardened write boundaries after adversarial audit: input/log/artifact aliases and non-file
  targets fail before decode, semantic rebuilds reject in-place output and never write a non-exact
  candidate, temporary files are unique and synced, PQT2 uses the observed first/last beat anchors,
  and a 12-second synthetic D-major/120-BPM fixture gates deterministic full DAT/EXT/2EX output. A
  real Crystalised FLAC EXT containing `PVB2` and its 2EX both rebuild byte-for-byte. TypeScript
  `--force` now removes only the five known analyzer artifacts, preserves unrelated output-directory
  files, and rejects any output path that aliases the source recording.
- Serialized same-process database guard commands through a per-library promise lane. A 32-way
  stale-guard acquisition plus 32-way release stress gate eliminates the prior replacement-unlink
  race while retaining the on-disk cross-process guard.
- Replayed 20 fragmented CDJ-3000 `0x1500` keyboard edits with interleaved artwork, waveform, and
  one-row renders over one TCP connection. Every render uses the full result count and succeeds
  without Back or reconnect. The physical deck independently exercised repeated incremental
  searches and result renders on the running server, confirming the patched path is working.

## Bounded analyzer parallelism checkpoint (2026-07-27)

- Added one explicit Rayon pool per clean analysis. Waveform, rhythm, and key
  branches run concurrently; rhythm and key FFT frames use deterministic
  ordered partitions without changing the original global reduction order.
  The public Rust API and raw helper accept a validated `1..=64` thread budget,
  including `REKORDBOX_ANALYZER_THREADS`.
- Thread counts 1, 2, 3, 4, 8, and 12 retained exact DAT/EXT/2EX hashes and
  summary semantics across three real recordings and one 502-second recording.
  On the 12-core test host, automatic 12-thread medians improved by 1.74–2.38x
  over the pre-parallel scalar baseline while RSS remained stable.
- Added `rekordbox analyze track(s) --threads`, `tracks analyze-existing
--threads`, and `tracks import-set --analysis-threads`. Multi-track and
  streaming workflows interpret this as a total CPU budget and divide it
  deterministically across active analyzer processes/slots. A 12-thread,
  four-track batch improved from 1.86 seconds sequential to 0.81 seconds with
  worker budgets `[3, 3, 3, 3]`, without nested oversubscription.
- Kept the release boundary clean: Rayon and its permissive transitive
  dependencies are listed in `THIRD_PARTY_LICENSES.md`; the npm package
  allowlist excludes `vendor/`; and the native build compiles only the
  clean-room crate. No reference rehost or Rekordbox/JUCE bytes are needed in a
  release.

## Clean RGB waveform checkpoint (2026-07-27)

- Re-derived `PWV4` and `PWV5` as separate DSP paths from 31-frequency
  pure-tone outputs, 0 to -60 dB ladders/ramps, and three matched-PCM
  real-track references. `PWV4` now uses linear peak/filter amplitudes plus
  the nonzero inverse luminance byte instead of peak-power and a constant
  opacity byte.
- Made `PWV5` color amplitude-invariant spectral hue: continuous Butterworth
  band filters, 294-sample band RMS divided by broadband frame RMS, and
  independent three-bit RGB quantization. Kept the already-correlated
  peak-power height path separate. Exact tone hues now match at 80 Hz
  (`7/0/0`), 500 Hz (`0/7/1`), and 4 kHz (`0/2/7`) through -60 dB.
- Science Fiction visible mean RGB improved from `3.59/2.04/0.90` to
  `6.27/1.36/1.67`, against Rekordbox `6.59/0.98/1.84`. Its PWV4 fields now
  correlate `0.968/0.999/0.993/0.824/0.755` for amplitude/bottom/red/green/blue;
  RGB detail MAE is `0.63/0.79/1.21`, while height correlation remains
  `0.993`. Crystalised and Pleasure remain held-out parity gates rather than
  bundled fixtures.

## Clean beat-grid checkpoint (2026-07-27)

- Re-derived PQT2 from 1,745 paired real entries: each two-byte payload is the
  big-endian `0..=999` microsecond remainder of its PQTZ floor-millisecond
  timestamp. The word at offset 44 is the wrapping sum of
  `beat + bpm_hundredths + time_ms` across every PQTZ entry. The full synthetic
  audio pipeline now gates both facts.
- Replaced independent onset snapping with a deterministic continuous grid,
  FFT-center correction, low-band onset/meter evidence, reduced octave
  harmonic bias, and hierarchical sub-frame tempo/phase refinement. Science
  Fiction, Crystalised, and Pleasure now have exact native beat counts and bar
  labels, 70/100 ms F1 of `1.0`, and median timing error of
  `3.088/6.196/4.032` ms. The final grid integrator uses `f64`, limiting
  precise straight-grid interval quantization to one microsecond without
  widening the `f32` spectral-analysis path.
- Added `rekordbox-analyzer beat-grid-diff`: bounded monotonic
  insertion/deletion alignment plus precise endpoint, drift, tempo, downbeat,
  and 70/100 ms match reports. Tests cover an inserted beat, allocation bounds,
  nonzero PQT2 residuals/checksum, and one-microsecond straight-grid
  continuity.
- Kept variable-tempo tracking open instead of adding a corpus-regressing
  heuristic. James Brown live/remix and Chopin heldouts demonstrate the gap;
  Lenny Kravitz also retains a syncopated phase ambiguity and Michael Jackson a
  one-beat meter rotation/endpoint miss. The distributable remains solely the
  clean Rust helper; vendored Rekordbox/JUCE code and local oracle files are not
  runtime or release dependencies.

## Variable-tempo and phase audit (2026-07-27)

- Re-derived the native tempo-run structure across nine real PQTZ grids.
  Every run is at least four beats and the median is four beats. Ants, Get Up,
  and Chopin contain `176/73/22` runs over `107.25–108.59`,
  `146.88–151.06`, and `81.90–154.24` BPM respectively; nearly every short
  run is bar-aligned.
- Evaluated windowed local autocorrelation, confidence/distance-constrained
  snapping, unsmoothed and median-smoothed barwise integration, and
  overlap-added predominant local pulse phase evidence. The designs follow
  [Ellis (2007)](https://www.ee.columbia.edu/~dpwe/pubs/Ellis07-beattrack.pdf),
  [Wu et al. (2011)](https://ismir2011.ismir.net/papers/PS2-4.pdf), and
  [Chiu et al. (2023)](https://arxiv.org/abs/2308.10355).
- Ants' strongest barwise candidate moved median error/F1 from
  `53.496 ms, 0.579/0.641` to `34.986 ms, 0.592/0.650`, but p95 regressed
  from `251.856` to `267.531` ms. Get Up moved from
  `37.344 ms, 0.683/0.725` to `27.671 ms, 0.686/0.743`, but p95 regressed
  from `184.841` to `242.8` ms. Chopin's local-period search retained
  octave/subdivision ambiguity with `21.245/73.385` BPM median/p95 error.
- Rejected a track-specific Lenny phase shift. Its clean `35.4`-frame onset
  phase scores `0.685`; the native `50.861`-frame phase scores `0.312`, and
  integrated one-/three-/five-second pulse evidence selects `34.15` frames.
- Shipped no analyzer change: no candidate improved both variable-tempo
  targets while preserving timing tails plus Science Fiction, Crystalised,
  Pleasure from the Bass, Ana Tijoux, Michael Jackson, and Lenny Kravitz.
  Removed the diagnostic-only corpus tests and retained no private audio,
  oracle, or proprietary runtime dependency.

## Semantic beat-grid CLI surface (2026-07-27)

- Exposed the Rust `beat-grid-diff` oracle as the typed
  `compareBeatGrids()` API and `rekordbox analyze beat-grid-diff` command.
  The wrapper resolves both directories canonically, verifies the clean-room
  helper identity, applies a bounded timeout, validates the complete structured
  report, and rejects mismatched paths or malformed output.
- Added command help, public types, fake-helper failure coverage, Music CLI/MCP
  guidance, the bundled Music skill workflow, README usage, and packed-install
  smoke checks. Future parity passes can now use one discoverable structured
  command instead of invoking a hidden native helper or comparing raw ANLZ
  hashes.

## 110-track beat-grid and waveform differential (2026-07-28)

- Matched 113 local recordings to 115 Rekordbox 6.8.2 reference directories
  and completed read-only differentials on 110 valid decodes. Three malformed
  or truncated media inputs failed closed without partial output.
- Strengthened the center-tempo prior and blended 35% body-band onset evidence
  into phase scoring. The tempo change fixed all 26 observed 2:3 subharmonic
  selections while preserving all 78 formerly correct choices; body evidence
  fixed two additional half-beat phase errors. Mean F1 at 70 ms moved from
  `0.664846` to `0.752310`, and tracks at `>=0.99` moved from 59 to 79 of 110.
  Rejected a narrower low-band candidate that fixed three but regressed ten.
- Rebuilt `PWV6` as a mean reduction of encoded `PWV7` detail with
  independently gated low/mid preview calibration. Weighted low/mid/high MAE
  moved from `52.011/36.540/15.041` to `4.834/5.142/5.647`; all 110 tracks
  improved, with median correlations `0.8973/0.8128/0.9023`. On 77 independent
  tone/level/transient fixtures, 73 improved; the high path retained exact
  mean reduction to preserve the four non-regression cases.
- Kept PWV7 detail unchanged. A global calibration reduced aggregate error but
  regressed ten real tracks, confirming that the remaining gap is the
  overlapping stateful filter/envelope detector rather than a safe global
  gain. PWV3 remains at `0.99868` median correlation and `0.586` weighted MAE.
- Added native `waveform-diff`, typed `compareWaveforms()`, and
  `rekordbox analyze waveform-diff`. The bounded report decodes every supported
  waveform family into semantic components and returns counts, exact
  fractions, correlation, means, MAE, percentiles, extrema, and signed bias.
  Public docs, Music agent guidance, fake-helper tests, deterministic pipeline
  tests, and packed-install smoke contracts cover the new surface.

## Multi-band phase and metrical-tempo checkpoint (2026-07-28)

- Expanded the read-only release gate from the 110-track differential to 849
  independently sampled, decodable tracks with complete Rekordbox DAT/EXT/2EX
  references from the 16,071-track master library. The prior analyzer passed
  694/849 (`81.7%`) at 70 ms; failures separated into half-beat phase,
  metrical-tempo, and variable-grid classes.
- Added kick (`108–258 Hz`), cumulative bass (`<=258 Hz`), and mid-band
  (`710–1,378 Hz`) onset envelopes to the existing STFT pass. A phase can move
  to the opposite basin only when whole-track gain, at least eight 16-beat
  windows, and independently optimized bass evidence agree. A second mid-band
  gate requires both mean and squared-energy gains while rejecting candidates
  contradicted by kick evidence.
- Added a second autocorrelation tempo prior and retained it only for validated
  metrical lag-ratio families near `1/2`, `2/3`, `4/5`, and `4/3`. This avoids
  the three regressions produced by applying the stronger center prior
  globally while fixing the constant-grid subdivision errors.
- Production validation moved the original differential from 79/110 to 85/110
  tracks at `>=0.99` F1, with mean F1 `0.752310 → 0.803211` and mean p95 timing
  error `73.445 → 61.530 ms`. No formerly passing track regressed. On the
  independent library, the complete 64-track switch set produced 59 new
  passes, 63 improvements, and zero regressions, projecting `694 → 753/849`
  (`88.7%`) while every non-switch candidate retained the prior path.
- Kept the hot path bounded: the extra envelopes reuse the existing FFT,
  segment voting is allocation-free, and alternative tempo ranking spans only
  the existing lag range. Five real-track release runs averaged `466.68 ms`
  versus `459.51 ms` before the pass (`+1.56%`).
- Added synthetic gates for bass-supported kick consensus, off-beat-bass
  rejection, mid-band evidence with kick veto, and accepted/rejected metrical
  tempo families. Variable-tempo grids and contradictory/manual duplicate
  analyses remain explicit open cases rather than track-specific exceptions.

## Energy and time-domain phase consensus checkpoint (2026-07-28)

- Added non-flux STFT power envelopes for the kick band (`108–258 Hz`) and
  cumulative bass (`<=258 Hz`) without another transform. Opposite-phase
  selection requires at least eight 16-beat segments, 75% segment consensus,
  1.25x kick power, nondecreasing bass power, and 1.20x kick concentration
  relative to the cumulative bass gain.
- Added an independent 512-sample time-domain pass with broadband RMS,
  `250 Hz–4 kHz` mid RMS, `>4 kHz` high RMS, and peak envelopes. The selector
  accepts an opposite phase only for strongly separated broadband or mid-band
  evidence, or when broadband peaks and high-frequency energy agree. Both
  selectors evaluate the same previously selected phase; the stricter
  non-flux candidate takes precedence so overlapping evidence cannot flip a
  phase twice.
- Exact production replay moved the original differential from 85/110 to
  89/110 tracks at `>=0.99` F1, with mean F1 `0.803211 → 0.839553` and mean
  p95 timing error `61.530 → 53.546 ms`. IDs 39, 40, 74, and 108 became
  passes; none of the prior 85 passes regressed.
- A complete fresh replay of all 849 independent references moved
  `753 → 772/849` passes. Twenty tracks improved, nineteen became new passes,
  no track worsened, mean F1 reached `0.923541`, and mean p95 timing error
  reached `40.228 ms`.
- Reusing the FFT kept the non-flux path effectively free. Fifteen alternating
  five-track runs measured `349.77 ms` mean for the combined analyzer versus
  `357.46 ms` for the prior release, treated as no measurable slowdown rather
  than a claimed speedup.
- Added synthetic coverage for kick concentration and bass support,
  broadband RMS, mid-band squared energy, high-frequency/peak consensus, and
  high-frequency peak contradiction. Alternate Apathy and Conga copies retain
  half-beat-opposed Rekordbox references; those contradictory/manual analyses
  remain explicit corpus conflicts rather than track-specific exceptions.
- Audited HFC, SuperFlux, complex-domain, centroid, and power novelty
  envelopes against the 110 + 849 corpora. Two centroid consensus rules fixed
  residual IDs 17 and 109, but a frozen replay on 613 additional disjoint
  decodes selected already-correct tracks and flipped two from parity to zero
  F1. Rejected both rules and retained none of the diagnostic-only second FFT
  path.

## Barwise drift and residual consensus checkpoint (2026-07-28)

- Added one conservative `3:2` tempo escape for cases where both existing
  autocorrelation priors choose the same lag and the faster competing family
  retains at least 93% of its score. It selected only differential ID 5:
  `105.80 → 158.70 BPM`, 607/607 native beats, correct downbeat phase,
  `0.401186 → 1.0` F1, and `35.949 ms` p95 error. The gate selected no track
  in the 848 currently available held-out references.
- Added final body-band phase consensus after the existing flux, power, and
  time-domain selectors. A half-beat move requires a near-tied global grid,
  at least 15% kick gain and 60% segment support, bounded `1.5–5.0x` body
  gain, and noncontradictory mid/bass evidence. It selected only ID 17:
  `0 → 1.0` F1 with `18.264 ms` p95 error. The implementation reuses existing
  envelopes and performs no additional FFT.
- Added a guarded bar-boundary Viterbi tracker following the dynamic-programming
  structure in [Ellis (2007)](https://www.ee.columbia.edu/~dpwe/pubs/Ellis07-beattrack.pdf)
  and the barwise tempo-state model in
  [Krebs et al. (2015)](https://ismir2015.uma.es/articles/239_Paper.pdf).
  Quarter-frame offset states span `±0.48` global periods, transitions carry a
  quadratic tempo-change penalty, and selected offsets are linearly integrated
  into four-beat tempo runs. The variable grid is emitted only with at least
  `0.36` onset-emission gain, no transition above `0.75` frame, at least ten
  frames of accumulated forward drift, and no backward excursion below two
  frames.
- The tracker selected only differential ID 32. Its timing moved from
  `0.806266 → 0.999478` F1 and `113.321 → 10.182 ms` p95 error while emitting
  139 local tempo changes against the reference's 153. A full 849-track
  held-out replay selected no variable grid and preserved all prior outputs.
- Combined production replay reached 92/110 tracks at `>=0.99` F1, up from
  89/110, with mean F1 `0.839553 → 0.855844` and mean p95 error
  `53.546 → 49.187 ms`. Exactly IDs 5, 17, and 32 changed; all improved and no
  prior pass regressed. The held-out result remains 772/849.
- An additional disjoint screen completed 609 currently available recordings
  from the frozen 613-track fresh cohort. Neither new tempo path activated;
  four source recordings had moved or disappeared. The five adversarial
  controls that defeated the broader centroid rule remained byte-identical.
  Five paired ID-32 runs measured `1.404 s` mean for the tracker build versus
  `1.428 s` for the prior binary, treated as no measurable slowdown.
- Rejected a local-RMS phase rule despite two held-out fixes because it changed
  one exact held-out pass from `1 → 0` F1. Also rejected SuperFlux,
  complex-bass, and HFC combinations that failed the fresh controls. ID 12 and
  alternate Apathy/Conga copies retain contradictory half-beat annotations;
  no track-specific exception was added.

## Peak-cadence and backward-drift checkpoint (2026-07-28)

- Added a final time-domain cadence gate for residual half-beat errors. A phase
  can move only when at least eight complete 16-beat windows, bounded
  whole-track peak gain, reduced top-half peak saturation, and independent
  locally normalized low-band mean and segment votes agree. The low envelope
  reuses the existing `250 Hz` one-pole state; no transform or proprietary
  runtime was added.
- The first peak-only candidate correctly fixed both `I Never Knew` versions
  but incorrectly selected Jay Vegas' `Come Soon`, whose prior grid already
  scored `0.998588` F1. Low-band cadence voted `43–0` against that move, while
  the two valid corrections voted `28–1` and `37–1` for it. Requiring
  cross-band vote consensus retained both fixes and made `Come Soon`
  byte-identical again.
- Extended the existing barwise Viterbi selector with a symmetric
  negative-basin branch. It accepts only at least `0.24` emission gain,
  `<=2`-frame bar transitions, `>=20` frames of total drift, a
  `-10..=8`-frame basin, and at least `0.70` absolute Pearson correlation
  between bar index and selected offset. This adds only linear arithmetic over
  the already-computed state path.
- The backward branch changed only the two James Brown variable-tempo tracks.
  `I Got Ants In My Pants` moved from `0.579242 → 0.732132` F1 and
  `251.275 → 214.855 ms` p95 while emitting 140 local tempo changes against
  175 native changes. `Get Up Offa That Thing` moved from
  `0.682652 → 0.899859` F1 and `184.260 → 133.190 ms` p95 with 64 changes
  against 72 native changes.
- Combined exact replay changed only differential IDs 58, 61, 106, and 110.
  Tracks at `>=0.99` F1 moved from `92 → 94/110`; mean F1 moved from
  `0.855844 → 0.877391`, and mean p95 timing error from
  `49.187 → 44.088 ms`. Both `I Never Knew` versions reached `1.0` timing F1
  and `4.165/3.527 ms` p95. Their native grids retain a two-beat meter-label
  rotation, so downbeat numbering remains a separate open problem.
- Final selectors changed `0/848` available held-out DATs and `0/609`
  additional disjoint DATs. The three held-out paths admitted by the broader
  backward-drift superset had trend correlations of only
  `0.060/0.204/0.406` and remained byte-identical under the final gate.
  Forty alternating five-track runs measured `1.299 s` candidate versus
  `1.291 s` baseline median (`+0.60%`), with no failures.

## Residual-trend variable-grid refinement checkpoint (2026-07-28)

- Diagnosed the two remaining selected variable grids beat by beat. Both
  accumulated residual timing error against the native dynamic grid while the
  first-pass Viterbi path saturated at its `±0.48`-period state boundary. The
  existing activation predicate remains unchanged; refinement runs only after
  the already-screened coherent negative-basin gate accepts a track.
- Added one isolated second pass. A negative residual trend expands the
  zero-centered state lattice to `±0.96` period. A positive residual trend
  estimates one bounded period correction from the per-bar path slope,
  recenters a regular grid between the global and first-pass phases, and
  searches `±0.84` period. Refined timing is mapped back to the first-pass
  meter offset so the second pass cannot silently rotate beat labels.
- `I Got Ants In My Pants` moved from `0.732132 → 0.805469` F1 and
  `214.855 → 172.226 ms` p95 timing error, with `145` local tempo changes
  against `175` native changes. Its existing `0.377335` beat-label accuracy
  was preserved exactly; downbeat p95 changed by `+0.972 ms`, an explicit
  remaining meter gap rather than a hidden phase trade.
- `Get Up Offa That Thing` moved from `0.899859 → 0.926554` F1 and
  `133.190 → 96.337 ms` p95 timing error. Beat-label accuracy improved from
  `0.765537 → 0.798867`, downbeat p95 improved from
  `403.980 → 392.972 ms`, and both native and generated grids contain 354
  beats.
- Full 110-track replay changed exactly IDs 106 and 110; the other 108 DATs
  remained byte-identical. The `>=0.99` count remains `94/110`, while mean F1
  moved from `0.877391 → 0.878300` and mean p95 timing error from
  `44.088 → 43.365 ms`.
- Because refinement is strictly downstream of the unchanged selector, the
  prior `0/848` held-out and `0/609` disjoint activation proofs compose with
  this pass. Direct replays of the three closest held-out near misses and the
  fresh cadence adversary were also byte-identical. Thirty-two alternating
  four-track runs measured a `+0.10%` median runtime difference, treated as no
  measurable overhead. The release remains clean-room Rust with no Rekordbox,
  JUCE, FFmpeg, or proprietary runtime dependency.

## Pipelined SIMD analyzer checkpoint (2026-07-28)

- Replaced the long-track decode-then-analyze barrier with a bounded five-second
  pipeline. Symphonia decode publishes one shared PCM batch to independent beat,
  key, waveform, and time-domain consumers. Stateful consumers remain ordered;
  command delivery uses scoped Rayon work plus bounded channels, with no
  hot-path mutex.
- Enabled Symphonia's architecture SIMD, reused FFT plans and scratch buffers,
  fused spectral passes, added deterministic AArch64 NEON waveform filters, and
  avoided a copy/resample for already-valid 44.1 kHz mono PCM. Short,
  resampled, and one-thread inputs retain the simpler buffered path.
- A paired ten-run, eight-thread benchmark on a 491-second AAC/M4A moved from
  `720.22 ms` to `347.16 ms` median: `2.07x` faster and about `1,415x` real
  time. A final Samply profile averaged `3.48` occupied cores. The serial AAC
  decoder, about `315 ms` of process CPU in that profile, is now the critical
  path rather than the parallel DSP stages.
- Six and eight threads were effectively tied on AAC; eight won the mixed-codec
  check, while twelve regressed from topology and cache pressure. The
  single-track default is now eight. More threads cannot shorten the
  temporally dependent codec path.
- A cold 100-track, 8.55-hour corpus completed in `9.46 s` median with both 12
  and 16 one-thread processes, `9.65 s` with 20, and `9.51 s` with 24. The
  adaptive batch default remains 12, now `17.0%` faster than the prior
  `11.402 s` median without the extra memory pressure of oversubscription.
- Streamed versus buffered analysis produced 300/300 byte-identical artifacts.
  The 110-track beat-grid oracle remained at 94/110 tracks with `>=0.99` F1,
  mean F1 `0.878300`, and mean p95 `43.365 ms`. Codec SIMD versus the frozen
  scalar build changed 9/300 files only: maximum beat drift `0.174 ms` and one
  quantization level in each of two waveform values.

## Linked analyzer stage-trace checkpoint (2026-07-28)

- Added a private x86*64 callsite tracer around the local 6.8.2 reference
  rehost. Every patch verifies the original opcode, relative target, branch
  bytes, range, and page protection before installation. The trace records
  selected `BA*\*` engine, streamed frames, raw beat list, constant-grid
  adjustment input/output, final PQTZ, and semantic stage parity. It remains
  outside the distributable clean-room crate.
- Recovered four distinct beat engines: constant and variable tempo at 44.1
  and 48 kHz. `BeatAnalyzeReq` byte zero selects the family. The existing
  explicit reference workflow requests variable mode, while constant mode
  alone runs `UnitBeatAdjust`.
- A linked Science Fiction run selected 48 kHz variable mode and returned 839
  raw beats. All 839 sample-frame positions, meter labels, and BPM-hundredths
  matched final PQTZ after exact integer floor-millisecond conversion. This
  pins tempo-family, local timing, and meter decisions inside the proprietary
  `peakss::BeatInfoAnalyzer`, not the outer ANLZ writer.
- Forcing the same input through constant mode exposed the isolated
  postprocessor: `126.99882 → 126.99982 BPM`, `839 → 840` beats, one prepended
  boundary beat, and a global `+376`-frame (`7.83 ms`) phase shift.
  `UnitBeatAdjust` downsamples stereo by four, averages int16 channels, applies
  2 kHz high-pass then absolute value then 1 kHz low-pass, searches a
  `±50 ms` aggregate pulse basin, and refines a regular 70–180 BPM grid.

## Linked three-band waveform parity checkpoint (2026-07-28)

- Recovered the complete 6.8.2 PWV6/PWV7 path from the linked implementation.
  Source-rate mono feeds Butterworth biquads at `LP300`,
  `HP250 → LP1200`, and `HP3000 → LP9000`; each band is max-pooled into exact
  1 ms buckets and truncated to signed-16 amplitude.
- PWV6 uses 1,200 track-relative windows with different overlaps
  (`duration/1000`, `2*duration/3000`, and `duration/3000`), balances total
  band energy, then applies one shared peak constraint. The resulting
  low/mid/high gains are serialized in PWVC. PWV7 reconstructs finite peak
  histories of `300/200/100 ms` with `0.99/0.98/0.97` decay; low and mid are
  linear while high uses `64 * (1 - cos(pi*x/32768))`.
- Ported the verified path to clean Rust, preserving the decoded source sample
  rate before the rhythm/key 44.1 kHz resample. On Science Fiction, PWVC now
  matches exactly at `[80, 172, 147]`. PWV7 correlation is
  `0.999989/0.999978/0.999944`, MAE is
  `0.0144/0.0178/0.0220`, and `97.94–98.57%` of band bytes are exact. PWV6
  MAE is `0.0042/0.0092/0.1092`.
- A fresh 110-track read-only replay improved every PWV6 and PWV7 result
  against the frozen baseline, with zero regressions. Median PWV7 correlation
  is `0.999991/0.999977/0.999809`; median MAE is
  `0.0123/0.0169/0.0474`. The two material detail outliers are an explicitly
  mismatched reference/audio identity and one M4A with a seven-column decoder
  duration difference. No proprietary code or oracle asset enters release
  output.

## Linked variable-tempo decoder checkpoint (2026-07-28)

- Extended the private x86_64 reference tracer through
  `peakss::BeatInfoAnalyzer::analyze`, `segAdjust`, and both `gapCorrect`
  overloads. Schema v2 records the detector candidates both before and after
  native pruning, the tempo-section vector on both sides of phase adjustment,
  every boundary repair, and the final raw beat list. The outer writer still
  performs no rhythm decisions.
- Recovered the front-end topology used by the linked analyzer. Six synchronous
  paths use a `283 Hz` low-pass, `150 Hz` wide band-pass (`Q=1.5`), a
  `283–7,900 Hz` band-pass, a `7,900 Hz` high-pass, and two through paths.
  Peak histories propose interval/phase candidates; simultaneous candidates
  are voted first at integer BPM and then at `0.1 BPM` resolution.
- The native state decoder treats intervals as compatible when their direct,
  half-time, or double-time distance is within `min(4%, 20 ms)`. It retains
  independent tempo families, removes values without at least eight
  consecutive observations, creates one section per surviving family, and
  runs a separate phase search over each section. This is categorically
  different from the clean analyzer's current one-global-period tracker.
- Four linked traces isolate the failure modes. `Luv Techniques` reduced
  `12,085 → 1,422` detector candidates and produced one `125 BPM` section.
  `The Power (dub)` reduced `1,393 → 473` candidates and preserved a
  `145.50 → 108.40 BPM` transition; boundary repair moved only two beats.
  `Rafael – ID` reduced `968 → 182` candidates and preserved
  `117.05 → 108.80 → 165.81 BPM`; boundary repair removed two beats and
  rewrote the transition. `Get Up Offa That Thing` reduced
  `3,700 → 332` candidates and emitted one section whose four-beat intervals
  continue to track the live drummer.
- The linked return BPM is the dominant/longest section, not necessarily the
  first or arithmetic mean. Section phase adjustment searches nearby detected
  peaks with a tolerance no smaller than one-eighth of the candidate interval,
  scores multiple pulse spacings, then stores a section origin, pulse count,
  and subdivision. Gap correction is a separate, narrow boundary operation;
  it is not server-side recovery or a general post-hoc grid repair.
- Remaining clean-room work is now sharply bounded: reproduce the six-path
  peak candidate stream, port the two-stage tempo histogram plus minimum-run
  state decoder, synthesize each retained section independently, and port the
  observed boundary rules. The existing barwise Viterbi path remains useful
  inside one tempo family but cannot solve missing `3:2`, `4:3`, or unrelated
  section families by construction.

## Linked BeatSensor front-end checkpoint (2026-07-28)

- Extended the private reference tracer to the real
  `peakss::BeatSensor::create` callsite. Schema v3 snapshots its object, all six
  filter and peak-detector records, and every nested IIR stage immediately
  after construction. Four linked runs at 44.1 and 48 kHz completed without a
  trace warning; repeated tracks at one sample rate differed only in pointers
  and track length.
- The runtime call is exactly
  `create(sampleRate, 0, totalFrames, 8, 6)`. Each path is averaged over eight
  input samples. The independent paths are two identical `LP283` biquads, two
  identical `BP150/Q1.5` biquads, alternating `HP283/LP7900` biquads, and two
  identical `HP7900` biquads. Coefficients are double precision and now
  captured bit for bit for both native sample rates.
- The apparent fifth and sixth through-filter paths are not raw full-band
  detectors. After filtering and absolute value, path 4 copies the `LP283`
  envelope, subtracts a `max(2, round(sampleRate * 0.001))` moving average, and
  clamps at zero. Path 5 does the same to the `HP7900` envelope with
  `max(2, round(sampleRate * 0.0002))`. Their observed history lengths are
  `44/48` and `9/10` samples at 44.1/48 kHz.
- Every path uses the same `0.29 s`, `1.70 s`, and approximately `1.30 s`
  peak-detector windows. Construction stores exact scalar state
  `0.001/0.75/0.5/0.5`; sample-index state remains 64-bit. This front end is
  causal time-domain DSP, not the clean analyzer's current STFT spectral-flux
  onset curve. In particular, the two derived envelope-onset paths explain why
  a generic local tempogram failed to recover the linked `145 → 108 BPM` and
  `117 → 109 → 166 BPM` sections.
- Public Pioneer tempo-detection material independently describes voting
  periodic peaks across frequency components, but the linked runtime trace is
  the implementation oracle. Next porting unit: reproduce the six scalar
  streams and peak events, compare their emitted candidate records against
  schema-v2 survivor traces, then connect the already recovered section
  decoder.
