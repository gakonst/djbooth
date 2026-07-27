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
  `startAnalyze` incompatibility at concurrency one and were excluded. The default is four workers
  (bounded by the uncached track count); higher values remain explicit measured overrides. The batch
  result reports preflight time, analyzer time, cache hits, and throughput; a warm 26-track cache
  validation took 11.65 ms.
- Packaged sanitized DAT/EXT seed shapes and made them the fallback when a local Rekordbox analysis
  library is absent. Build and packed-package smoke checks now fail if either seed is missing. An
  extracted npm tarball analyzed the same track with an empty HOME and no prebuilt runtime cache in
  14.58 seconds cold, producing the same valid DAT/EXT/2EX, BPM, and key result.

## Analyzer scheduler/cancellation checkpoint (2026-07-14)

- Historical Codex sessions and the benchmark above showed that a blanket 64-worker default
  oversubscribed interactive hosts. Batch analysis now defaults to four process-isolated workers.
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
