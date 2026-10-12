# ytdlp-ts

A music-first TypeScript port of [`yt-dlp`](https://github.com/yt-dlp/yt-dlp), exposed as an
[`incur`](https://github.com/wevm/incur) CLI for humans, agents, MCP clients, and HTTP callers.

> [!IMPORTANT]
> This is an active compatibility port. Native TypeScript support and reference-engine fallback
> coverage are tracked in [`docs/PARITY.md`](docs/PARITY.md). Every result identifies the engine
> that handled it; the project does not silently claim native parity.

## Installation

Requires Node.js 22+ and FFmpeg. Exact long-tail compatibility currently also requires a `yt-dlp`
executable while native extractors are being ported.

```sh
pnpm add --global @gakonst/ytdlp-ts
ytdlp-ts --help
```

For library use:

```sh
pnpm add @gakonst/ytdlp-ts
```

## Development

The source package lives in the `gakonst/djbooth` pnpm workspace:

```sh
gh repo clone gakonst/djbooth ~/github/gakonst/djbooth
cd ~/github/gakonst/djbooth
pnpm install
pnpm --filter @gakonst/ytdlp-ts check
pnpm --filter @gakonst/ytdlp-ts dev --help
```

## CLI shape

```sh
ytdlp-ts music 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
ytdlp-ts music 'https://soundcloud.com/artist/track' --url 'https://youtu.be/another-id'
ytdlp-ts music --input-file urls.txt --paths ~/Music
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
ytdlp-ts music 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
ytdlp-ts music 'https://soundcloud.com/savedrecords/unconditional-feat-nasa'
```

Public single-video YouTube URLs use the native TypeScript Android VR InnerTube path. It returns
direct signed M4A and WebM audio formats without loading or evaluating remote player JavaScript,
SABR, Python, or an external `yt-dlp`. Googlevideo transfers use concurrent bounded ranges with an
ordered, crash-resumable `.part` commit. Signed media URLs are kept in memory and redacted from
sidecars and errors. Public progressive SoundCloud tracks also use the native TypeScript extractor
and Range-resumable downloader. Sets, profiles, private/account flows, and unsupported sites remain
explicit `auto`/`reference` compatibility cases.

The library also exposes bounded native YouTube video search through the same shared
[`youtubei.js`](https://ytjs.dev/guide/creating-an-innertube-instance) client. Search uses a Web
session because its result parser supports the current search response; exact extraction explicitly
requests Android VR and keeps signed formats in memory. Results are canonical public page URLs with
stable IDs, uploader data, and durations. The default is 10 results; explicit limits are honored
until results are exhausted or a repeated page is detected. An
`AbortSignal` stops client creation, search, or pagination:

```ts
import { ExtractorRegistry, downloadMedia, searchYoutube } from '@gakonst/ytdlp-ts'

const [candidate] = await searchYoutube('Artist Track', { limit: 10, signal })
if (!candidate) throw new Error('No candidate')
const info = await new ExtractorRegistry().extract(candidate.url, { signal })
await downloadMedia(info, {
  format: 'bestaudio[ext=m4a]',
  output: '%(title)s.%(ext)s',
  signal,
})
```

`music` keeps the highest-quality Rekordbox-compatible source audio by default, preferring M4A and
then MP3 without transcoding. It writes `.info.json` metadata and cover art alongside every track,
embeds tags and artwork on the reference path, and only transcodes when `--audio-format` explicitly
requests a codec. Use the lower-level `download --media-format ...` command when container
compatibility is not required and another source format is preferred.

Batch source inspection and native YouTube downloads default to three concurrent tracks; reference
YouTube downloads default to one. Positive safe-integer overrides are accepted for `--concurrency`,
`--youtube-concurrency`, and `--native-youtube-concurrency`; workers never exceed queued tracks.
Native YouTube transfers use up
to two concurrent 1 MiB ranges per track; ordered commits keep the workload network-bound without
sacrificing exact resume state. Reference YouTube transfers retain exponential
HTTP/fragment/extractor retry delays, throttling detection, and one fragment at a time. A durable
`.ytdlp-ts-music-archive` in the target directory prevents repeat downloads and uses URL
fingerprints to skip completed tracks before any network request.

The `--youtube-rate-limit` value applies to each active native YouTube track. Setting it also
serializes that track's chunk requests; reduce `--native-youtube-concurrency` when a batch-wide
native ceiling is required.

Progressive downloads resume with HTTP Range requests. Native Googlevideo downloads validate every
`Content-Range` and expected total before atomic completion. HLS/DASH music that lacks a native
resumable path is routed through the explicit reference fragment downloader under `auto`. See
[`docs/STRESS.md`](docs/STRESS.md) for the validation record.

The structured commands are implemented with incur and produce agent-friendly output. `compat`
passes arbitrary arguments to the reference engine during the parity migration.

The complete CLI definition is importable without serving a process and can be mounted directly in
another Incur CLI. Its command-group name is `ytdlp-ts`:

```ts
import { Cli } from 'incur'
import ytdlpCli from '@gakonst/ytdlp-ts/cli'

Cli.create('music').command(ytdlpCli)
```

## Architecture

- `native` is the TypeScript extractor, selector, downloader, and post-processing path.
- `reference` invokes an installed yt-dlp executable for exact long-tail compatibility.
- `auto` delegates only for an allowlisted, typed native capability gap detected before media bytes
  are committed. Abort, network, lock, write, identity, and content-validation errors fail closed.
- `parity` runs both extractors and reports stable metadata, format, and subtitle differences.

Native support never silently invokes Python. Each structured result reports the engine that handled
it; delegated results also report the typed native fallback reason. The compatibility matrix
distinguishes complete, partial, and delegated subsystems. See
[`docs/PORTING.md`](docs/PORTING.md) for the engine boundary and scheduler contract.

## Attribution

The behavioral model, public types, option semantics, and test fixtures are derived from yt-dlp,
which is released under the Unlicense. Incur is MIT-licensed. Upstream revisions are pinned in
[`docs/PROGRESS.md`](docs/PROGRESS.md). Native InnerTube session/response handling uses
[`youtubei.js`](https://github.com/LuanRT/YouTube.js), which is MIT-licensed.
