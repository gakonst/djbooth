# ytdlp-ts

A TypeScript port of [`yt-dlp`](https://github.com/yt-dlp/yt-dlp), exposed as an
[`incur`](https://github.com/wevm/incur) CLI for humans, agents, MCP clients, and HTTP callers.

> [!IMPORTANT]
> This is an active compatibility port. Native TypeScript support and reference-engine fallback
> coverage are tracked in [`docs/PARITY.md`](docs/PARITY.md). Every result identifies the engine
> that handled it; the project does not silently claim native parity.

## Development

Requires Node.js 22+, pnpm, and FFmpeg. Exact long-tail compatibility currently also requires a
`yt-dlp` executable while native extractors are being ported.

```sh
pnpm install
pnpm check
pnpm dev --help
```

## CLI shape

```sh
ytdlp-ts inspect 'https://example.com/video'
ytdlp-ts formats 'https://example.com/video'
ytdlp-ts parity 'https://example.com/video'
ytdlp-ts download 'https://example.com/video' --media-format 'bv*+ba/b'
ytdlp-ts compat --arg --dump-single-json --arg 'https://example.com/video'
ytdlp-ts --llms
ytdlp-ts --mcp
```

### YouTube and SoundCloud

```sh
ytdlp-ts download 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
ytdlp-ts download 'https://soundcloud.com/savedrecords/unconditional-feat-nasa'
```

YouTube uses the exact reference engine when its current player requires signature challenges.
Public SoundCloud tracks use the native TypeScript extractor and downloader; sets, profiles, private
tracks, and unsupported account flows fall back through `auto`.

The structured commands are implemented with incur and produce agent-friendly output. `compat`
passes arbitrary arguments to the reference engine during the parity migration.

## Architecture

- `native` is the TypeScript extractor, selector, downloader, and post-processing path.
- `reference` invokes an installed yt-dlp executable for exact long-tail compatibility.
- `auto` attempts native behavior and falls back explicitly when a URL or option is not yet ported.
- `parity` runs both extractors and reports stable metadata, format, and subtitle differences.

Native support never silently invokes Python. Each structured result reports the engine that handled
it, and the compatibility matrix distinguishes complete, partial, and delegated subsystems.

## Attribution

The behavioral model, public types, option semantics, and test fixtures are derived from yt-dlp,
which is released under the Unlicense. Incur is MIT-licensed. Upstream revisions are pinned in
[`docs/PROGRESS.md`](docs/PROGRESS.md).
