# Pipeline performance

Measured on 2026-07-12 on the Brunello Lightning in a Bottle 2026 manifest: 26 cues,
22 Spotify recordings, 29 final media artifacts, and one normal encrypted Rekordbox playlist.
Durations below are wall time inside the library unless marked as process time.

## Historical baseline

The original run did not emit structured timing, so only filesystem/session evidence is safe:

| Evidence                                                      |               Time |
| ------------------------------------------------------------- | -----------------: |
| Cached 108 MiB source-set transfer window                     | approximately 23 s |
| First clip through final media artifact                       |              177 s |
| Final failed-source/recovery tail                             | approximately 70 s |
| Final successful Rekordbox import through manifest checkpoint |        at most 6 s |

The 1 h 22 min first-artifact-to-final-manifest envelope included implementation, debugging, and
multiple Rekordbox repair imports. It is not a clean E2E runtime and must not be used as one.

The historical acquisition implementation was serial. A warm resume also refreshed 22 Spotify IDs,
launched 88 ffprobe processes, and read approximately 582 MiB while verifying the same files up to
three times.

## Optimized measurements

| Phase                                   | Cold/miss | Warm/hit | Notes                                                   |
| --------------------------------------- | --------: | -------: | ------------------------------------------------------- |
| YouTube set metadata                    |  3,150 ms |  3.25 ms | Sanitized six-hour disk cache; warm includes bounded GC |
| Agent 1001Tracklists handoff            |       n/a |      n/a | Browser/VM research is performed by the calling agent   |
| Spotify enrichment, 24 searches         |  2,520 ms |  5.29 ms | Four workers; zero warm network requests                |
| Spotify refresh, 22 IDs                 |  2,258 ms | 11.62 ms | Individual endpoint; four workers                       |
| Acquisition resume                      |  2,313 ms | 45.60 ms | Cold scoped Spotify population vs fully warm receipts   |
| Rekordbox already-imported verification |       n/a | 1,842 ms | Full verification; no database write                    |

The fully warm stitched library path is approximately 1.90 s: cached set/1001/Spotify metadata,
verified acquisition resume, and normal Rekordbox integrity/membership verification. Separate CLI
invocations add process startup; the fully warm acquisition command measured 0.343 s process time
for 45.60 ms of library work. A completed cache-GC sweep is suppressed for one hour; a scheduled
bounded sweep added approximately 10 ms to acquisition in this dataset.

A real isolated three-track acquisition downloaded and retagged all three individual tracks with
`concurrency: 3` in 6,335 ms (`recordings` stage), 6,700 ms total. The temporary manifest and media
were removed after verification. This validates real yt-dlp concurrency without deleting or
redownloading the complete 29-file library.

### Adam Ten Burning Man 2025 end-to-end proof

Measured on the real 29-cue Adam Ten set after description/1001 sequence alignment: 27 identified
cue rows, two unresolved IDs, one overlap, 34 retained recording variants, 31 individual artifacts,
and three source-set clips.

| Run                                         | Library wall | Result                                                                  |
| ------------------------------------------- | -----------: | ----------------------------------------------------------------------- |
| One-time native SoundCloud source cache     |      85.18 s | 7,196.03 s AAC source, used only for cue recovery                       |
| Adoption-heavy v2 acquisition/analyzer pass |      29.09 s | 33 variants analyzed; one reviewed individual miss checkpointed         |
| Strict resume through clip + DB import      |      13.33 s | 34/34 analyzed, imported, and post-verified                             |
| Fully warm steady-state resume              |       1.56 s | 34 audio hits, 34 analysis hits, zero downloads, zero database mutation |

On this historical reference-engine resume, acquisition occupied 9.97 s and analysis occupied 9.41 s,
but they overlapped; the complete critical path including the 3.35 s Rekordbox boundary was 13.33 s
rather than their 22.73 s serial sum. The warm library path spent 49.84 ms in acquisition, 12.38 ms
in analysis, and 1.50 s fully reverifying the existing normal-database checkpoint. The surrounding
pnpm/tsx CLI process measured 2.14 s.

Independent post-checks returned `PRAGMA quick_check = ok`, zero foreign-key violations, 34 ordered
distinct playlist memberships, 34 analysis paths with `Analysed = 105`, and 102 installed
DAT/EXT/2EX files. Repeated warm runs retained playlist ID `86375504` without creating duplicate
rows. Those original checks did not compare analyzer tempo/key with
`djmdContent.BPM` and `KeyID`; the resulting gap motivated the stricter checkpoint described below.

The importer now persists each validated `analysis.json` summary in the durable manifest and writes
its tempo and normalized key during the serialized Rekordbox transaction. Postverification reopens
the database and requires exact BPM hundredths, a valid active `djmdKey` reference, and the expected
canonical Camelot name in addition to ANLZ paths, parseability, and flags. An older warm checkpoint
with valid installed DAT/EXT/2EX files but absent or incorrect BPM/key is repairable drift: the next
run reuses the cached analysis, synchronizes only its metadata inside the normal
transaction, and then returns to the no-mutation warm fast path.

The real playlist repair completed in 3.07 s total: 34 recording resumes, 34 analyzer cache hits,
zero downloads, zero analyzer executions, and a 2.92 s Rekordbox stage. Independent
read-only verification found 34/34 BPM values, 34/34 valid canonical key references, 102 parseable
ANLZ files, no metadata mismatches, `PRAGMA quick_check = ok`, and zero foreign-key violations. The
next run completed in 1.64 s and retained identical database and manifest checksums, proving the
repaired checkpoint returns to the no-mutation fast path.

## Implemented changes

- Atomic TTL cache: exact 1001 results, account-scoped Spotify search/track metadata, sanitized
  YouTube metadata, and stat-keyed audio verification receipts. Bounded persisted sweeps delete
  expired or malformed entries.
- Cache controls: default, refresh, and off; `TRACKS_CACHE_DIR` override.
- Three acquisition workers by default; ambiguity variants share the same global queue. Backend
  searches overlap while candidate downloads retain deterministic backend priority.
- Eight verification, Spotify enrichment, and Spotify refresh workers by default. Callers may
  override acquisition up to 8, verification up to 16, and Spotify work up to 32; actual workers
  never exceed queued work.
- Three local recognition workers by default with an eight-call cap; clean-room analysis defaults to
  four with an explicit 64-worker expert cap. Rekordbox media preflight and checksum verification use up to
  eight workers or Node's available parallelism, whichever is lower, while every encrypted database
  read, write, and the single commit remain serialized.
- One serialized manifest commit coordinator; unchanged checkpoints do not write.
- Fully verified acquisition fast path; no backend loading or repeated probe/hash work.
- Rekordbox idempotent fast path: full database integrity, sidecar, metadata, ordering, and analyzer
  BPM/key verification without a mutation. Media preflight records the artifact's probed, rounded duration beside its checksum and
  reuses that receipt for unchanged warm-path and commit rechecks instead of running ffprobe again.
  Legacy checkpoints with analysis-file flags but missing BPM/key, or with a `Length` derived from
  platform metadata, take a metadata-only warm repair path and do not rerun analysis or
  recopy DAT/EXT/2EX.
- Structured stage timing, cache counters, checkpoint counts, and wall timestamps in results.

Aggregate provider `loadMs` may exceed wall time because concurrent request durations are summed.
Cold full-library acquisition was not re-run destructively; only three real tracks were acquired in
an isolated temporary root. Provider miss timings vary with network and service latency.
