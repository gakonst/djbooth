# @gakonst/music

Unified ESM entrypoint for the `music-ts` workspace. It keeps the five focused libraries intact while offering collision-free namespace imports, direct subpath imports, and one agent-friendly `music` CLI.

## Install

```sh
pnpm add --allow-build=better-sqlite3-multiple-ciphers @gakonst/music
```

Node.js 22 or newer is required. The explicit build allowance compiles the native encrypted-SQLite
dependency used by Rekordbox; pnpm otherwise blocks dependency install scripts by default. Prefer
the focused subpaths below when one process does not need every integration; the root namespace
entrypoint eagerly loads all five libraries, including Rekordbox.

## Library

Use root namespaces when composing several packages:

```ts
import { rekordbox, slsk, spots, tracks, ytdlp } from "@gakonst/music";

const tracklist = await tracks.identify("https://youtu.be/example");
const spotify = new spots.SpotifyClient({
  auth: process.env.SPOTIFY_ACCESS_TOKEN!,
});
const soulseek = new slsk.SoulseekClient();
const reference = new ytdlp.ReferenceClient();
const database = new rekordbox.MasterDatabase({ unlock: false });
```

Use subpaths for focused imports and smaller API surfaces:

```ts
import { identify } from "@gakonst/music/tracks";
import { SpotifyClient } from "@gakonst/music/spots";
import { SoulseekClient } from "@gakonst/music/slsk";
import { ReferenceClient } from "@gakonst/music/ytdlp";
import { MasterDatabase } from "@gakonst/music/rekordbox";
```

## CLI

The umbrella CLI calls the packages as libraries. It does not spawn their CLIs.

```sh
music tracks resolve "https://youtu.be/example" --format json
music spots session --format json
music slsk search "artist track" --timeout 8 --format json
music ytdlp engines --format json
music ytdlp inspect "https://youtu.be/example" --format json
music rekordbox status --format json
```

The umbrella intentionally exposes the cross-package happy path. The package-specific `tracks`, `spots`, `slsk`, `ytdlp-ts`, and `rekordbox` CLIs retain their complete specialist command surfaces.

Install the single aggregate agent skill, or register the same command map as MCP:

```sh
music skills add
music mcp add
```

For a zero-config local CodeMode MCP server, run:

```sh
music --codemode-mcp
# from this repository: pnpm music:mcp:code
```

It serves one `code` tool over stdio. Generated JavaScript runs inside Secure Exec with a virtual
filesystem, denied network access, bounded execution time, and only the music tools bridged back to
the host. The bundled Secure Exec sidecar currently supports macOS and Linux; Windows clients can
use the normal MCP or inject another isolated `Executor` into `createMusicCodeMcpServer`.

The package also exports explicit server factories. The normal server exposes the same six typed
commands as the CLI; the CodeMode server collapses them into one sandboxed TypeScript `code` tool:

```ts
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createMusicCodeMcpServer, createMusicMcpServer } from "@gakonst/music/mcp";

const normal = createMusicMcpServer();
const codeMode = await createMusicCodeMcpServer({
  executor: new DynamicWorkerExecutor({ loader: env.LOADER }),
});
```

`createLocalMusicCodeMcpServer` uses the same local Secure Exec default as the CLI.
`createMusicCodeMcpServer` accepts an injected `Executor`; Cloudflare Workers should provide a
`worker_loaders` binding and `DynamicWorkerExecutor`.

## Packages

- [`@gakonst/tracks`](https://github.com/gakonst/music-ts/tree/main/packages/tracks-ts): DJ-set resolution, manifests, enrichment, and pipeline coordination.
- [`@gakonst/spots`](https://github.com/gakonst/music-ts/tree/main/packages/spots): Spotify OAuth and Web API.
- [`slsk-ts`](https://github.com/gakonst/music-ts/tree/main/packages/slsk-ts): Soulseek protocol, search, and transfers.
- [`@gakonst/ytdlp-ts`](https://github.com/gakonst/music-ts/tree/main/packages/ytdlp-ts): YouTube/SoundCloud extraction and selected downloads.
- [`@gakonst/rekordbox`](https://github.com/gakonst/music-ts/tree/main/packages/rekordbox-ts): Rekordbox database and file formats.

## Development

```sh
pnpm --filter @gakonst/music validate
```

MIT licensed.
