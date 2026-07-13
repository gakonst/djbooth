# @gakonst/music

Unified ESM entrypoint for the `music-ts` workspace. It keeps the seven focused libraries intact while offering collision-free namespace imports, direct subpath imports, and one agent-friendly `music` CLI.

## Install

```sh
pnpm add --allow-build=better-sqlite3-multiple-ciphers @gakonst/music
```

Node.js 22 or newer is required. The explicit build allowance compiles the native encrypted-SQLite
dependency used by Rekordbox; pnpm otherwise blocks dependency install scripts by default. Prefer
the focused subpaths below when one process does not need every integration; the root namespace
entrypoint eagerly loads all seven libraries, including the Rekordbox library workbench.

## Library

Use root namespaces when composing several packages:

```ts
import { library, rekordbox, slsk, soundcloud, spots, tracks, ytdlp } from "@gakonst/music";

const tracklist = await tracks.identify("https://youtu.be/example");
const spotify = new spots.SpotifyClient({
  auth: process.env.SPOTIFY_ACCESS_TOKEN!,
});
await spotify.createPlaylistWithTracks({
  name: "Set IDs",
  tracks: ["spotify:track:4iV5W9uYEdYUVa79Axb7Rh"],
  public: false,
});
const soulseek = new slsk.SoulseekClient();
const reference = new ytdlp.ReferenceClient();
const database = new rekordbox.MasterDatabase({ unlock: false });
const workbench = new library.RekordboxLibraryService({ writeEnabled: false });
```

Use subpaths for focused imports and smaller API surfaces:

```ts
import { identify } from "@gakonst/music/tracks";
import { SpotifyClient } from "@gakonst/music/spots";
import { SoundCloudClient } from "@gakonst/music/soundcloud";
import { SoulseekClient } from "@gakonst/music/slsk";
import { ReferenceClient } from "@gakonst/music/ytdlp";
import { MasterDatabase } from "@gakonst/music/rekordbox";
import { LibraryMutationError, RekordboxLibraryService } from "@gakonst/music/library";
```

## CLI

The umbrella mounts the seven package-owned Incur CLI definitions directly. Every specialist command
and schema remains defined once, in its owning package; `music` adds only the common root and agent
Skill.

```sh
music tracks resolve "https://youtu.be/example" --format json
music spots auth status --format json
music spots playlist create "Set IDs" --track "spotify:track:4iV5W9uYEdYUVa79Axb7Rh" --format json
music spots playlist get spotify:playlist:PLAYLIST_ID --format json
music soundcloud playlist create "Set IDs" --track "https://soundcloud.com/artist/track" --format json
music soundcloud playlist update soundcloud:playlists:PLAYLIST_ID --title "Renamed" --format json
music slsk search "artist track" --timeout 8 --format json
music ytdlp-ts engines --format json
music ytdlp-ts inspect "https://youtu.be/example" --format json
music rekordbox status --format json
music rekordbox db playlist list
music rekordbox db playlist list --json
music rekordbox db playlist show "Adam Ten — Burning Man 2025 [music-ts E2E]"
music rekordbox db playlist show "Adam Ten — Burning Man 2025 [music-ts E2E]" --json
music library status --format json
music library serve --open
```

`music rekordbox db playlist list` prints the complete active folder and playlist hierarchy as a
table, including direct track and child counts. Add `--json` for the same tree order with stable
IDs, parent links, path segments, pagination metadata, and explicit smart-playlist count errors.

The umbrella mounts the complete package-specific `tracks`, `spots`, `soundcloud`, `slsk`, `ytdlp`,
`rekordbox`, and `library` Incur CLIs. Its MCP surface filters those commands to the composable calls used for
set resolution, metadata lookup, individual acquisition, analysis, and normal Rekordbox database
maintenance; it does not impose a pipeline command.

The platform playlist commands preserve track order and duplicate entries, default to private, and
require a user OAuth login. They create playlists on the remote account and are marked destructive
in CLI/MCP discovery. Importable definitions are available from each package's `./cli` subpath for
other Incur parents to compose the same way.

Both provider groups expose `playlist create|get|update|delete`. SoundCloud deletion is permanent;
Spotify's delete command reflects Spotify's platform model and removes the playlist from the user's
library because Spotify provides no permanent delete endpoint.

Install the curated workflow skill plus Incur's typed command-group skills, or register the same
command map as MCP:

```sh
music skills add
music mcp add
```

For a zero-config local CodeMode MCP server, run:

```sh
music --codemode-mcp
# from this repository: pnpm --silent music:mcp:code
```

Use `pnpm --silent music:mcp` for the normal MCP from this repository. `--silent` keeps pnpm's
script banner off the stdio protocol stream.

It serves one `code` tool over stdio. Generated JavaScript runs inside Secure Exec with a virtual
filesystem, denied network access, bounded execution time, and only the music tools bridged back to
the host. The bundled Secure Exec sidecar currently supports macOS and Linux; Windows clients can
use the normal MCP or inject another isolated `Executor` into `createMusicCodeMcpServer`.

The package also exports explicit server factories. The normal server exposes the filtered typed
Incur commands; the CodeMode server collapses them into one sandboxed TypeScript `code` tool:

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
- [`@gakonst/soundcloud`](https://github.com/gakonst/music-ts/tree/main/packages/soundcloud): SoundCloud OAuth and Public API.
- [`slsk-ts`](https://github.com/gakonst/music-ts/tree/main/packages/slsk-ts): Soulseek protocol, search, and transfers.
- [`@gakonst/ytdlp-ts`](https://github.com/gakonst/music-ts/tree/main/packages/ytdlp-ts): YouTube/SoundCloud extraction and selected downloads.
- [`@gakonst/rekordbox`](https://github.com/gakonst/music-ts/tree/main/packages/rekordbox-ts): Rekordbox database and file formats.
- [`@gakonst/rekordbox-library`](https://github.com/gakonst/music-ts/tree/main/packages/rekordbox-library): Local, read-only-by-default Rekordbox library workbench and guarded playlist mutations.

## Development

```sh
pnpm --filter @gakonst/music validate
```

MIT licensed.
