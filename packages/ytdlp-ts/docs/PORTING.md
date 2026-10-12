# Native port contract

This document defines the boundary between the TypeScript-native port and the temporary yt-dlp
reference bridge.

## Engine selection

- `native` executes TypeScript only and never delegates.
- `reference` executes the external compatibility engine directly.
- `auto` starts native and may delegate only for a typed, allowlisted capability gap.

The capability allowlist is centralized in `src/core/errors.ts`. It covers unsupported URLs,
playlists, options, formats, public SoundCloud account cases, unavailable direct YouTube formats,
and range support rejected before any response bytes are committed.

`auto` fails closed for every untyped error and for typed abort, HTTP/network, output-lock, write,
identity, response-length, content-range, and other validation failures. A runtime or data-integrity
failure must never start a second downloader against the same output.

Structured delegated results report `engine: "reference"` plus
`fallback: { from: "native", code }`. Music batch items always report the engine that actually
wrote the result.

## Native YouTube discovery

`searchYoutube` is the typed discovery boundary for individual YouTube videos. It uses the shared
YouTube.js Web session, returns stable canonical watch URLs plus identity/duration fields, defaults
to 10 results, honors explicit result limits, detects repeated pages, deduplicates video IDs, excludes
live results, and honors `AbortSignal` around client creation and every request. Exact extraction
continues to request Android VR explicitly through `ExtractorRegistry`.

Callers may cache sanitized search results. They must never cache extraction responses or signed
Googlevideo URLs, and they must freshly extract the selected canonical URL immediately before a
native download.

## Network scheduling

Music scheduling uses independent bounded pools:

| Limit                                     | Default | Maximum |
| ----------------------------------------- | ------: | ------: |
| Source inspection and total track workers |       3 |      16 |
| Reference YouTube tracks                  |       1 |       4 |
| Native YouTube tracks                     |       3 |      16 |

Native Googlevideo tracks may issue two concurrent bounded-range requests. This keeps the default
network-bound while avoiding the burst created by the former 64-track scheduler. Callers must opt
into higher track counts explicitly.

## Adding native behavior

1. Add an isolated fixture for the native behavior.
2. Add differential coverage against the pinned reference revision where observable yt-dlp
   behavior changes.
3. Return a typed capability error only when reference delegation is safe before durable transfer.
4. Do not add abort, network, filesystem, or validation errors to the fallback allowlist.
5. Record the milestone and any new upstream revision in `docs/PROGRESS.md`.
