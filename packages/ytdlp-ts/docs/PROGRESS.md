# Progress log

This is the append-only engineering journal for the port. Dates use Pacific Time.

## 2026-07-14 — Resilient native YouTube search pagination

- Kept valid earlier-page search candidates when a later YouTube.js continuation is empty or
  fails, including its `No contents found in search response` parser failure.
- Preserved fail-closed behavior when no valid candidate has been collected and preserved aborts
  at every pagination boundary.
- Added isolated failed, empty, and aborted-continuation coverage without media downloads.

## 2026-07-13 — Fail-closed delegation and bounded defaults

- Changed total music workers and native YouTube tracks to a network-bound default of three;
  reference YouTube defaults to one. Explicit caps are 16, 4, and 16 respectively.
- Centralized typed native capability fallback. `auto` no longer starts the reference engine after
  abort, HTTP/network, output-lock, write, identity, content-length/range, or other validation
  errors, and untyped native exceptions fail closed.
- Added fallback provenance to delegated structured engine results; music batch items continue to
  report the engine that actually downloaded each track.
- Added isolated engine-boundary fixtures plus batch coverage for defaults, caps, safe range
  negotiation, and forbidden post-transfer fallback classes.
- Added abort-aware native YouTube video search over the shared YouTube.js Web session, with stable
  canonical results, duration/uploader metadata, deduplication, five-page pagination, a 10-result
  default, and a 50-result cap. Exact direct-format extraction remains Android VR.
- Wired `tracks import-set` to use native search plus exact M4A extraction/download by default.
  External `ReferenceClient` construction now requires `--reference-ytdlp`, and delegation remains
  limited to the centralized pre-transfer capability allowlist.

## 2026-07-12 — Native YouTube audio and network-bound transfer

- Replaced watch-page-only YouTube extraction with YouTube.js 17.2 Android VR InnerTube metadata.
- Direct signed M4A/WebM formats feed the existing `MediaInfo` and `downloadMedia` pipeline; no
  `ReferenceClient`, external `yt-dlp`, SABR client, player retrieval, or remote JavaScript
  evaluation is used.
- Extraction fails closed with `YOUTUBE_DIRECT_FORMATS_UNAVAILABLE` when Android VR supplies no direct
  audio format.
- Added concurrent 1 MiB HTTP range batches with ordered `.part` commits, exact resume offsets,
  `Content-Range` validation, two range requests per track, and three independent YouTube track
  workers by default. Six simultaneous requests passed the production probe; nine showed an
  intermittent upstream 403.
- Transient signed URLs are redacted from native info sidecars and network errors. Callers freshly
  inspect before every download.
- Live exact validation: 14/14 reviewed music URLs exposed native audio formats in 1.247 s; one
  3,511,486-byte M4A downloaded and FFprobe-validated in 1.879 s; the production six-request probe
  downloaded three tracks totaling 12,007,913 bytes in 1.522 s.

## 2026-07-10 — Repository bootstrap

- Pinned yt-dlp reference revision `59d9ae606a24a80523da35de9fb75b71eb35b501`.
- Pinned incur reference revision `4c0fc4b15b4e0b72136f30b0a0ad25cc35e0a84b` and npm release `0.4.13`.
- Measured upstream scope: ~225k Python lines, ~196k extractor lines, 2,033 extractor classes.
- Chose Node.js 22 ESM, strict TypeScript, pnpm, Vitest, and the Unlicense.
- Created a layered architecture: stable public info model, extractor registry, download pipeline,
  incur commands, and a reference bridge for behavior not yet native.

### Next

- Implement the reference bridge and incur command surface.
- Implement native direct-media and generic webpage extraction.
- Implement format selection, filename templates, resumable HTTP downloads, and FFmpeg merging.

## 2026-07-10 — Executable compatibility surface

- Added a shell-free, abortable reference-engine process adapter with bounded output capture and
  structured errors.
- Added typed incur commands for inspection, formats, subtitles, downloading, extractor inventory,
  engine diagnostics, and exact raw compatibility.
- Mapped common authentication, network, format, subtitle, thumbnail, metadata, SponsorBlock, and
  post-processing options to reference behavior.
- Added tests that pin the compatibility argument translation, including the `--` URL boundary.

## 2026-07-10 — First native extractors

- Added an ordered native extractor registry with explicit `Direct` and fallback `Generic`
  extractors.
- Added retrying, timeout-bounded HTTP requests and bounded in-memory webpage reads.
- Added direct audio/video discovery by URL extension and content type.
- Added generic HTML discovery through OpenGraph, Twitter cards, `<video>`, `<audio>`, `<source>`,
  and JSON-LD VideoObject/AudioObject metadata.
- Added native HLS master and media-playlist parsing with relative URL resolution, resolution,
  framerate, bitrate, and codec fields.
- Changed `auto` to try the native registry before transparently falling back to the reference
  engine; forcing `native` never delegates.
- Added isolated HTTP-server and manifest tests with no internet dependency.

## 2026-07-10 — Native selection and download pipeline

- Added a format-expression parser covering best/worst video/audio, muxed formats, explicit IDs,
  nth-best suffixes, `+` merge, `/` fallback, comma selection, and numeric/string filters.
- Added yt-dlp-style output template fields, fallback keys, padding, precision, percent escapes, and
  cross-platform filename sanitation.
- Added native HTTP download with `.part` files, Range resume, server resume detection, retries,
  byte validation, rate limiting, progress events, and atomic final rename.
- Added native HLS download and multi-format merge through shell-free FFmpeg invocation, plus audio
  extraction.
- Wired `download --engine native`; `auto` uses native only when every requested option is supported
  and otherwise preserves behavior through the reference engine.
- Added unit and local-server integration tests for selection, templates, rate parsing, transfer,
  and resume.

## 2026-07-10 — YouTube metadata and DASH

- Added a native YouTube URL matcher and balanced `ytInitialPlayerResponse` decoder.
- Added native mapping for public player metadata, direct progressive/adaptive formats, thumbnails,
  manual captions, automatic captions, live status, and HLS/DASH manifest URLs.
- Kept signature-ciphered formats explicit: native mode returns a typed limitation, while `auto`
  falls back rather than returning incomplete media.
- Added a native DASH parser for BaseURL representations, adaptation metadata, bandwidth,
  dimensions, framerate fractions, and XML entity decoding; FFmpeg handles manifest fallback.
- Fixed incur error propagation to return its error sentinel from every command path. This was
  found by a live native YouTube smoke test and is now part of the CLI behavior audit.
- Added YouTube player-response and DASH fixture tests, bringing the suite to 16 tests.

## 2026-07-10 — Native archival sidecars

- Added native `.info.json` metadata sidecars using the complete compatible information object.
- Added manual and automatic subtitle selection by language wildcard/exclusion and format
  preference, supporting both inline data and remote caption downloads.
- Added best-thumbnail selection and native thumbnail download.
- Added a typed incur `thumbnails` command alongside the existing subtitle inventory command.
- Kept embedding and conversion options on the reference path until their FFmpeg container matrix
  has differential coverage.

## 2026-07-10 — Differential parity harness

- Added a typed comparison report for stable metadata fields, shared format fields, format counts,
  and subtitle language inventories.
- Added an incur `parity` command that reports unsupported native URLs without losing the reference
  baseline.
- Added CI for Node.js 22 with frozen dependency installation, type checking, tests, and build.
- Verified the first GitHub Actions run passed, then advanced checkout, setup-node, and pnpm setup
  to their current official major releases to remove the deprecated Node 20 action runtime.

## 2026-07-10 — YouTube and SoundCloud live compatibility

- Verified live YouTube extraction through `auto`, including a playable 360p media format.
- Added a native SoundCloud public-track extractor using page hydration data and runtime client-ID
  discovery from SoundCloud's deployed asset bundles.
- Added native SoundCloud transcoding resolution for progressive MP3 and HLS MP3/AAC/Opus streams,
  with compatible metadata, uploader, counters, artwork, duration, and upload date fields.
- Kept SoundCloud sets and profiles on the exact reference path until their pagination semantics are
  ported.
- Completed live end-to-end download smoke tests and validated outputs with FFprobe:
  - SoundCloud native progressive MP3: 180.062 seconds, 2,881,409 bytes.
  - YouTube automatic reference fallback MP4: 213.043 seconds, 11,829,048 bytes.

## 2026-07-10 — Music batch, resume, and rate-limit hardening

- Added the opinionated `music` command with source-quality audio selection, optional conversion,
  metadata JSON, artwork, embedded reference tags/artwork, URL files, and repeated URL arguments.
- Added concurrent batch scheduling with a separate one-at-a-time YouTube semaphore.
- Added conservative YouTube request/track sleeps, one fragment at a time, throttled-rate
  re-extraction, ten transfer/fragment retries, and exponential HTTP/fragment/extractor backoff.
- Added a durable yt-dlp-compatible extractor/ID archive plus normalized URL fingerprints. A repeat
  five-track batch now skips without network requests in 0.168 seconds.
- Hardened native progressive downloads to retry mid-stream failures automatically from the `.part`
  byte offset. HLS/DASH best-audio formats use the fragment-resumable reference downloader.
- Added deterministic four-track scheduler/archive stress coverage and a severed-stream test that
  proves the retry sends a Range request.
- Completed a five-track live stress run (three SoundCloud, two YouTube): five downloaded, zero
  failed, five audio files, five `.info.json` files, and five artwork files.
- Completed a live SoundCloud interruption test: preserved a 326,450-byte part, resumed from
  358,347 bytes, and validated the final 2,881,409-byte/180.062-second MP3 with FFprobe.
