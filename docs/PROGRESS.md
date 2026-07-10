# Progress log

This is the append-only engineering journal for the port. Dates use Pacific Time.

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
