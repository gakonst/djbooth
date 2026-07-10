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
