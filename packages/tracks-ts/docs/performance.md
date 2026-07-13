# Pipeline performance

Measured on 2026-07-12 on the Brunello Lightning in a Bottle 2026 manifest: 26 cues,
22 Spotify recordings, 29 final media artifacts, and one normal encrypted Rekordbox playlist.
Durations below are wall time inside the library unless marked as process time.

## Historical baseline

The original run did not emit structured timing, so only filesystem/session evidence is safe:

| Evidence                                                            |               Time |
| ------------------------------------------------------------------- | -----------------: |
| Cached 108 MiB source-set transfer window                           | approximately 23 s |
| First clip through final media artifact                             |              177 s |
| Final failed-source/recovery tail                                   | approximately 70 s |
| Final successful Rekordbox backup start through manifest checkpoint |        at most 6 s |

The 1 h 22 min first-artifact-to-final-manifest envelope included implementation, debugging, and
multiple Rekordbox repair imports. It is not a clean E2E runtime and must not be used as one.

The historical acquisition implementation was serial. A warm resume also refreshed 22 Spotify IDs,
launched 88 ffprobe processes, and read approximately 582 MiB while verifying the same files up to
three times.

## Optimized measurements

| Phase                                   | Cold/miss | Warm/hit | Notes                                                   |
| --------------------------------------- | --------: | -------: | ------------------------------------------------------- |
| YouTube set metadata                    |  3,150 ms |  3.25 ms | Sanitized six-hour disk cache; warm includes bounded GC |
| Exact 1001 tracklist                    | 10,545 ms |  7.17 ms | Parsed seven-day disk cache; one Parse credit on miss   |
| Spotify enrichment, 24 searches         |  2,520 ms |  5.29 ms | Four workers; zero warm network requests                |
| Spotify refresh, 22 IDs                 |  2,258 ms | 11.62 ms | Individual endpoint; four workers                       |
| Acquisition resume                      |  2,313 ms | 45.60 ms | Cold scoped Spotify population vs fully warm receipts   |
| Rekordbox already-imported verification |       n/a | 1,842 ms | Recovery backup rehashed; no DB write or new backup     |

The fully warm stitched library path is approximately 1.90 s: cached set/1001/Spotify metadata,
verified acquisition resume, and normal Rekordbox integrity/membership verification. Separate CLI
invocations add process startup; the fully warm acquisition command measured 0.343 s process time
for 45.60 ms of library work. A completed cache-GC sweep is suppressed for one hour; a scheduled
bounded sweep added approximately 10 ms to acquisition in this dataset.

A real isolated three-track acquisition downloaded and retagged all three individual tracks with
`concurrency: 3` in 6,335 ms (`recordings` stage), 6,700 ms total. The temporary manifest and media
were removed after verification. This validates real yt-dlp concurrency without deleting or
redownloading the complete 29-file library.

## Implemented changes

- Atomic TTL cache: exact 1001 results, account-scoped Spotify search/track metadata, sanitized
  YouTube metadata, and stat-keyed audio verification receipts. Bounded persisted sweeps delete
  expired or malformed entries.
- Cache controls: default, refresh, and off; `TRACKS_CACHE_DIR` override.
- Sixty-four independent recording workers by default; ambiguity variants share the same global
  queue and candidate fallback remains serial within each recording.
- Sixty-four clip, verification, Spotify enrichment, and Spotify refresh workers by default. The
  scheduler caps actual workers to queued work; callers may override each limit from 1 through 256.
- Sixty-four local recognition workers by default and a 64-call cap. Rekordbox media preflight,
  checksum verification, and backup copies also fan out to 64 while every encrypted database read,
  write, and the single commit remain serialized.
- One serialized manifest commit coordinator; unchanged checkpoints do not write.
- Fully verified acquisition fast path; no backend loading or repeated probe/hash work.
- Rekordbox idempotent fast path: full database integrity, sidecar, metadata, ordering, and recovery
  backup checksum verification, but no redundant backup or mutation.
- Structured stage timing, cache counters, checkpoint counts, and wall timestamps in results.

Aggregate provider `loadMs` may exceed wall time because concurrent request durations are summed.
Cold full-library acquisition was not re-run destructively; only three real tracks were acquired in
an isolated temporary root. Provider miss timings vary with network and service latency.
