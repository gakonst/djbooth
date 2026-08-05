# music-ts hardening backlog

Audit date: 2026-07-12

Scope: SoundCloud/Spotify/1001Tracklists resolution, native TypeScript media acquisition,
Rekordbox analysis/import, and the No Static case-study workflow.

## Current evidence

- No Static: 21 slots; 18 identified; 3 unidentified; 20 reviewed variants across 12 slots;
  9 explicit hard stops.
- Native acquisition: 20/20 artifacts; 14 YouTube and 6 SoundCloud; M4A; no reference
  downloader used.
- Rekordbox analysis: 20/20; BPM and beat grids present.
- Rekordbox import: playlist ID `196926526`; folder ID `1671026022`; database integrity and
  installed DAT/EXT/2EX/PPTH checks passed.
- Confirmed live-data defect: the imported tracks initially had `KeyID = NULL` for 20/20 rows.
  Code-level BPM/key persistence has landed on `origin/main`; live repair and no-op verification
  remain required.
- Downloader implementation: TypeScript-native for supported progressive YouTube and SoundCloud
  paths. Rekordbox beat/key/waveform computation remains binary-backed; it is not a TypeScript
  analyzer implementation yet.

## P0: correctness and safety

### Rekordbox correctness

- [ ] Repair and verify key metadata for the 20 imported No Static tracks.
  - Back up the live database first.
  - Map analyzer keys to `djmdKey` and persist the correct `KeyID`.
  - Verify BPM to hundredths, key, beat grid, PPTH, DAT, EXT, and 2EX.
  - Require the second run to return a verified no-op.
- [ ] Add a durable import recovery journal and restore API.
  - States: `prepared -> installing_analysis -> db_committed -> verified`.
  - Back up database, WAL/SHM/journal, playlist XML, and existing analysis directories.
  - Fault/SIGKILL injection after every backup, analysis install, SQLite commit, XML rename,
    verification, and manifest checkpoint boundary.
  - Resume must verify the exact commit or restore the original state byte-for-byte.
- [ ] Make analysis generation and installation atomic.
  - Unique temporary directory; exclusive output lock; `fsync`; atomic exposure.
  - Never expose a mixed or partial DAT/EXT/2EX set.
- [ ] Standardize one database lock contract.
  - All Tracks imports, Rekordbox write CLIs, and analysis installers must use it.
  - Typed owner diagnostics and stale-lock/PID-reuse handling.
- [ ] Complete process and path guards.
  - Block writers while either Rekordbox or `rekordboxAgent` is running.
  - Validate UUID and `AnalysisDataPath` containment.
  - Reject symlink media, analysis, and backup inputs; cover symlink swaps/TOCTOU.
- [ ] Preserve per-recording release identity.
  - Never copy entry-level Spotify ISRC/album/release metadata to every variant.
  - Require explicit variant-level Spotify ID or ISRC binding.
  - Unbound radio/extended/edit/remix variants keep release fields null.
- [ ] Verify existing installed analysis against current audio before skipping.
  - Detect changed audio, missing installed files, and broken paths.
  - Preserve curated metadata unless an explicit overwrite policy applies.

### Credentials and request safety

- [ ] Rotate the exposed SoundCloud client secret.
  - Update the root `.env`; invalidate old tokens/sessions.
  - Keep `.env` ignored and mode `0600`.
- [ ] Redact credentials and signed parameters from all logs and errors.
  - Cover request URLs, FFmpeg stderr, SoundCloud/AWS parameters, reference output, and warnings.
- [ ] Add SSRF protection to Incur HTTP/MCP inputs.
  - Validate DNS and every redirect destination.
  - Block loopback, private, link-local, and cloud metadata ranges unless explicitly opted in.

### Native downloader contract

- [ ] Wire native acquisition into the productized Tracks/Incur pipeline.
  - Add `--engine native|auto|reference`; default `native`.
  - Lazily construct the reference client only for explicit `auto`/`reference` use.
  - Persist requested engine, actual engine, package version, timestamps, and typed limitations.
  - Native acceptance test: Python and external `yt-dlp` absent from `PATH`.
- [ ] Make `auto` fallback fail closed.
  - Fallback only for typed, pre-transfer capability limitations.
  - Never fallback for `WRITE_FAILED`, `OUTPUT_LOCKED`, abort, validation, or corruption errors.
- [ ] Make final output transactional.
  - Precompute and sanitize final media/sidecar paths.
  - Lock the final artifact namespace, not an intermediate filename.
  - Random same-directory temporary files; atomic promotion; final `noOverwrites` enforcement.
  - Prevent traversal through media IDs, format IDs, subtitle languages, and extensions.
  - Validate the final container and hash before success.
- [ ] Enforce strict HTTP resume semantics.
  - Validate `206`, `Content-Range`, offset, total length, and expected format size.
  - Never promote a short self-consistent `200` response.
  - `fsync` partial content before promotion.
- [ ] Propagate `AbortSignal` end to end.
  - Inspect, refresh, ranges, reference child, FFmpeg, batches, and archive writes.
  - Already-aborted calls launch nothing.
  - `continueOnError=false` cancels and drains siblings before returning.
  - Child shutdown: TERM, bounded wait, then KILL.

### Durable pipeline state

- [ ] Define canonical manifest v2.
  - Stable slot and variant IDs.
  - Preserve source order, timestamps, alternatives, evidence, decisions, and unresolved gaps.
  - Explicit `accepted_hard_stop` state.
  - `--allow-partial` only with persisted approval.
  - Migrate v1 and the No Static case manifest without losing provenance.
- [ ] Persist candidate review decisions.
  - `tracks candidates discover|list|select|reject`.
  - Stable candidate key, title, artist, version, duration, uploader, confidence, evidence,
    reviewer, and acceptance timestamp.
  - Replay accepted selections without searching again unless `--refresh` is supplied.
- [x] Remove proprietary Rekordbox bytes from public package output.
  - Public tarball must contain no AlphaTheta executable hashes.
  - Prefer discovery of a compatible user-installed application plus strict checksums/version gates,
    or finish a legally clean native analyzer implementation.
  - Keep non-macOS database/ANLZ functionality installable without analyzer payloads.

## P1: reusable and reliable workflow

- [ ] Add stageable execution and exact resume.
  - `pipeline run --through resolve|enrich|discover|acquire|analyze|import`.
  - `pipeline status` plus run lease/CAS protection.
  - Load credentials and backends only for pending stages.
  - A completed warm run must work offline and without provider sessions.
- [ ] Persist an auditable performance journal.
  - `runId`, attempt, sequence, stage/span IDs, and one terminal event per start.
  - Queue, active, pause, cache, network, retry, byte, and concurrency timings.
  - Store large diagnostics as hashed sidecars; never persist secrets or signed URLs.
- [ ] Strengthen analysis provenance and caching.
  - Source SHA-256; DAT/EXT/2EX hashes; helper/analyzer binary hash and version;
    template/schema version; options.
  - A changed audio file with preserved size/mtime, artifact mutation, or analyzer upgrade must miss
    cache or refuse import.
- [ ] Make the analyzer lifecycle safe.
  - Run doctor once before uncached work.
  - Require expected tags, nonempty beat grid, sane BPM/key, callback success, and source binding.
  - Per-output locking, atomic summary writes, cancellation, and typed incompatibility failures.
- [ ] Replace analyzer concurrency `64` with a measured adaptive CPU/memory budget.
  - Benchmark the No Static corpus at 1/2/4/8/12 workers across repeated runs.
  - Set an RSS ceiling and stable default; schedule longest tracks first while preserving result order.
- [ ] Make the download archive trustworthy.
  - Serialize with locking and `fsync`.
  - Record source, destination, size, hash, and engine.
  - Verify the artifact before skipping it.
  - Update in-memory state only after durable append succeeds.
- [ ] Add bounded provider-aware retries and a circuit breaker.
  - Retry `408`, `425`, `429`, and bounded `5xx`; honor `Retry-After`; add jitter.
  - Drain response bodies and distinguish timeout from user abort.
  - Refresh bounded expired URL statuses; global cooldown after failure bursts.
  - Never reinterpret local I/O errors as provider failures.
- [ ] Share provider-aware network budgets globally.
  - Global and per-host limits; adaptive reduction after throttling.
  - Replace the effectively per-track `rateLimit` with a shared token bucket, or rename it.
  - No 64-request inspect burst and no 64-child reference burst.
- [ ] Productize the No Static unresolved queue.
  - `tracks unresolved list|retry`.
  - Six exact edits/remixes still missing; three timestamp slots unidentified.
  - Cue inference/fingerprint alignment against a local full set only after approval.
  - No source-set clipping without complete cue bounds and explicit approval.
  - Never silently substitute another version.
- [ ] Clean repository and release state.
  - Reconcile the root checkout with current `main`.
  - Preserve active work; prune merged stale worktrees using `wt`.
  - Run filtered checks, then `pnpm validate`.
  - Publish through Changesets only after recovery/security tests pass.

## P2: speed and flakiness

- [ ] Avoid unconditional double YouTube inspection.
  - Reuse fresh capabilities; refresh only by age or expiry response.
- [ ] Tune native range size and concurrency.
  - Measure p50/p95 throughput, bytes, retries, and `403` rate.
- [ ] Cache and batch 1001Tracklists/candidate discovery.
  - Bound provider concurrency and preserve review evidence.
- [ ] Reduce analyzer process startup.
  - Warm workers or batch protocol; retain per-track checkpoints and isolation.
- [ ] Add content-addressed analysis caching.
  - Identical audio bytes analyze once; PPTH rewrites correctly for each installed path.
- [ ] Add backup retention and reflink support.
  - Keep recent verified recovery points without unlimited full copies.
- [ ] Add conservative live canaries.
  - Representative YouTube and SoundCloud artifacts.
  - Timestamp extraction, refresh, range, retry, throughput, and throttle events.

## P3: native feature parity

- [ ] Add a pluggable YouTube client/PO-token strategy without remote player evaluation.
- [ ] Support explicit local cookie/account configuration with redaction and scope controls.
- [ ] Implement native segmented HLS resume, then DASH assembly.
- [ ] Expand SoundCloud support: sets, profiles, private/account streams, liked-track pagination and
      authentication canaries.
- [ ] Add remaining playlist, live/private, subtitle, post-processing, and format cases only while
      preserving the native fail-closed contract.
- [ ] Add other sites last.
- [ ] Maintain a supported Rekordbox version/schema matrix and fail closed on unknown hashes.
- [ ] Add dedicated `backup`, `verify`, and `restore` commands with explicit approval gates.

## Definition of done

- [ ] One Incur command reproduces No Static from canonical manifest and reviewed selections.
- [ ] Native acquisition passes with Python and external `yt-dlp` unavailable.
- [ ] Fault injection at every mutation boundary always resumes exactly or restores byte-for-byte.
- [ ] Three representative 20-track network soaks complete without throttle storms or corrupt files.
- [ ] Warm resume performs zero provider, downloader, analyzer, or database mutation work.
- [ ] Rekordbox verifies 20/20 BPM, key, beat grid, PPTH, DAT, EXT, and 2EX.
- [ ] Every started journal span has one terminal event and timings reconcile with wall time.
- [ ] Secret scan is clean.
- [ ] Public package tarballs contain no proprietary Rekordbox binaries.

## External constraints

- Rekordbox warns that unsupported third-party tools can corrupt libraries; recovery and
  fault-injection testing are release blockers:
  <https://rekordbox.com/en/support/faq/library-6/#faq-q600163>
- YouTube request-rate/account guidance:
  <https://github.com/yt-dlp/yt-dlp/wiki/Extractors>
- Current YouTube proof-of-origin token behavior:
  <https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide>
- YouTube.js authentication guidance:
  <https://ytjs.dev/guide/authentication>
