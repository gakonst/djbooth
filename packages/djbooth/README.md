# @gakonst/djbooth

Unified ESM entrypoint for djbooth.ai. It keeps focused libraries intact while offering
collision-free namespace imports, direct subpath imports, and one agent-friendly `djbooth` CLI.

## Install

```sh
pnpm add --allow-build=better-sqlite3-multiple-ciphers @gakonst/djbooth
```

Node.js 22 or newer is required. The explicit build allowance compiles the native encrypted-SQLite
dependency used by Rekordbox; pnpm otherwise blocks dependency install scripts by default. Prefer
the focused subpaths below when one process does not need every integration; the root namespace
entrypoint eagerly loads all libraries, including the djbooth.ai workstation.

## Library

Use root namespaces when composing several packages:

```ts
import {
  djlink,
  library,
  rekordbox,
  slsk,
  soundcloud,
  spots,
  tracks,
  usb,
  ytdlp,
} from "@gakonst/djbooth";

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
const workbench = new library.DjBoothLibraryService({ writeEnabled: false });
await djlink.doctorDjLink({ manifestPath: "./set/manifest.json" });
await usb.exportLegacyDeviceLibrary({
  databasePath: "/path/to/master.db",
  targetDirectory: "/mnt/cdj",
});
```

Use subpaths for focused imports and smaller API surfaces:

```ts
import { identify } from "@gakonst/djbooth/tracks";
import { SpotifyClient } from "@gakonst/djbooth/spots";
import { SoundCloudClient } from "@gakonst/djbooth/soundcloud";
import { SoulseekClient } from "@gakonst/djbooth/slsk";
import { ReferenceClient } from "@gakonst/djbooth/ytdlp";
import { MasterDatabase } from "@gakonst/djbooth/rekordbox";
import { DjBoothLibraryService, LibraryMutationConflictError } from "@gakonst/djbooth/library";
import { loadDjLinkTrack, startDjLink } from "@gakonst/djbooth/djlink";
import { exportLegacyDeviceLibrary } from "@gakonst/djbooth/usb";
```

## CLI

The umbrella mounts the package-owned Incur CLI definitions directly. Every specialist command
and schema remains defined once, in its owning package; `djbooth` adds only the common root and agent
Skill. Focused package CLIs and native/Python implementation CLIs remain available for development
and diagnosis. Normal user and agent flows enter through `djbooth`; the owning Incur command validates
arguments, invokes its Rust or Python helper, and returns bounded structured output.

```sh
djbooth tracks resolve "https://youtu.be/example" --format json
djbooth tracks import-set "https://youtu.be/example" --manifest ./set/manifest.json \
  --analysis-threads 12 --write --format json
djbooth spots auth status --format json
djbooth spots playlist create "Set IDs" --track "spotify:track:4iV5W9uYEdYUVa79Axb7Rh" --format json
djbooth spots playlist get spotify:playlist:PLAYLIST_ID --format json
djbooth soundcloud playlist create "Set IDs" --track "https://soundcloud.com/artist/track" --format json
djbooth soundcloud playlist update soundcloud:playlists:PLAYLIST_ID --title "Renamed" --format json
djbooth slsk search "artist track" --timeout 8 --format json
djbooth ytdlp-ts engines --format json
djbooth ytdlp-ts inspect "https://youtu.be/example" --format json
djbooth rekordbox status --format json
djbooth rekordbox analyze track ./track.flac --output-directory ./analysis --format json
djbooth rekordbox stems separate ./track.flac ./stems --layout four-stem --format json
djbooth rekordbox db playlist list
djbooth rekordbox db playlist list --json
djbooth rekordbox db playlist show "Adam Ten — Burning Man 2025 [djbooth.ai E2E]"
djbooth rekordbox db playlist show "Adam Ten — Burning Man 2025 [djbooth.ai E2E]" --json
djbooth library status --format json
djbooth library serve --open
djbooth library serve --open --no-assistant
djbooth djlink rekordbox --format json
djbooth djlink search "Science Fiction" --mode track --format json
djbooth djlink run ./set/manifest.json 1 --player 3 --format json
djbooth djlink probe 169.254.7.4 --format json
djbooth djlink stop --format json
djbooth usb sync /mnt/cdj --database /path/to/master.db --write --format json
djbooth usb sync-playlist /mnt/cdj "$PLAYLIST_ID" --database /path/to/master.db --fresh --write --format json
djbooth usb sync-playlist /mnt/cdj "$PLAYLIST_ID" --database /path/to/master.db --write --format json
djbooth usb doctor ./rekordbox-usb.img --format json
```

`djbooth tracks import-set` is the single local acquisition path: recordings land under
`~/.djtools/tracks/<artist>/<album>/` (or `DJBOOTH_LIBRARY_ROOT`) and verified ordered membership is
written directly to Rekordbox. It deterministically selects safe Spotify release ties while
retaining every candidate. With `--allow-set-clips --source-set-path <local-set>`, it performs one
bounded internal recovery pass after individual failures. It does not download the remote set or
create per-playlist copies on disk. `--analysis-threads` is one total native scheduling budget
shared across its overlapping clean-room analyzer slots. Apple Silicon defaults to two Rayon slots
per core while process count stays host-bounded. Releases need only the redistributable Rust helper,
never the local vendored Rekordbox/JUCE reference implementation.

`djbooth rekordbox db playlist list` prints the complete active folder and playlist hierarchy as a
table, including direct track and child counts. Add `--json` for the same tree order with stable
IDs, parent links, path segments, pagination metadata, and explicit smart-playlist count errors.

The umbrella mounts the complete package-specific `tracks`, `spots`, `soundcloud`, `slsk`, `ytdlp`,
`rekordbox`, `library`, `djlink`, and `usb` Incur CLIs. Its MCP surface filters those commands to the
composable calls used for set resolution, metadata lookup, individual acquisition, analysis,
normal Rekordbox database maintenance, and safe CDJ loading. Agents should prefer the mounted
`tracks import-set` pipeline command for an approved resolve-download-analyze-playlist request,
then continue without another prompt with one `djlink rekordbox <track>` when a connected-deck
handoff was requested. Use `djlink run` only for a completed manifest not yet imported. Stage
commands remain available for diagnosis.

`djbooth djlink rekordbox` is the default full-library path: validate direct read-only master.db
ingestion, start or resume the source, wait for deck discovery, then expose folders, playlists,
artists, albums, and tracks. Add an optional track selector to cue it in the same command.
Manifest-backed `run` remains available before a new import is visible in master.db.
If deck Search appears broken, run `djbooth djlink search <query>` first. It exercises the running
daemon's prewarmed matcher and the same RemoteDB row builder used by the deck, without changing
deck or library state. A successful CLI result isolates a missing deck Search request from an
index or result-construction failure.

DJ Link serves only verified local recordings and native ANLZ files. Spotify identities remain
metadata. Licensed Spotify playback belongs to
rekordbox's official Performance-mode integration; streaming tracks cannot be LINK EXPORTed or
served by `djbooth djlink`. A successful `load` cues the selected deck and intentionally reports
`playing: false`; press PLAY on the deck.

`djbooth usb sync` is the separate front-panel content path. It first imports each unseen CDJ history
into the normal Rekordbox `master.db` as a `DJ Set YYYY-MM-DD` playlist, preserving order and
duplicates while updating play counts exactly once. It then differentially reconciles the complete
active library into legacy `PIONEER/rekordbox/export.pdb`, local audio, rewritten DAT/EXT/2EX
analysis, and playlists. SQLite stays authoritative and Device Library Plus is not involved. The
destination is a mounted FAT/exFAT media root or staging directory; no image is created by the sync
command. `djbooth usb export` remains available for an outbound-only initial compile.

For a freshly formatted stick, `djbooth usb sync-playlist --fresh` exports one analyzed playlist to
both traditional Device Library and OneLibrary. Both indexes share one audio/ANLZ tree and are
validated before the receipt is published. Later runs omit `--fresh`; unchanged media is a
zero-copy no-op, while appends preserve existing dual-library rows and back up both databases.

The lower-level `doctor`, `publish`, `attach`, `detach`, `status`, and `run` commands control the
current immutable-image Linux gadget transport. Publication is forbidden while configured, and
detach requires a physical USB STOP/eject confirmation.

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
djbooth skills add
djbooth mcp add
```

For a zero-config local CodeMode MCP server, run:

```sh
djbooth --codemode-mcp
# from this repository: pnpm --silent djbooth:mcp:code
```

Use `pnpm --silent djbooth:mcp` for the normal MCP from this repository. `--silent` keeps pnpm's
script banner off the stdio protocol stream.

It serves one `code` tool over stdio. Generated JavaScript runs inside Secure Exec with a virtual
filesystem, denied network access, bounded execution time, and only the djbooth tools bridged back to
the host. The bundled Secure Exec sidecar currently supports macOS and Linux; Windows clients can
use the normal MCP or inject another isolated `Executor` into `createDjBoothCodeMcpServer`.

The package also exports explicit server factories. The normal server exposes the filtered typed
Incur commands; the CodeMode server collapses them into one sandboxed TypeScript `code` tool:

```ts
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { createDjBoothCodeMcpServer, createDjBoothMcpServer } from "@gakonst/djbooth/mcp";

const normal = createDjBoothMcpServer();
const codeMode = await createDjBoothCodeMcpServer({
  executor: new DynamicWorkerExecutor({ loader: env.LOADER }),
});
```

`createLocalDjBoothCodeMcpServer` uses the same local Secure Exec default as the CLI.
`createDjBoothCodeMcpServer` accepts an injected `Executor`; Cloudflare Workers should provide a
`worker_loaders` binding and `DynamicWorkerExecutor`.

## Packages

- [`@gakonst/tracks`](https://github.com/gakonst/djbooth/tree/main/packages/tracks-ts): DJ-set resolution, manifests, enrichment, and pipeline coordination.
- [`@gakonst/spots`](https://github.com/gakonst/djbooth/tree/main/packages/spots): Spotify OAuth and Web API.
- [`@gakonst/soundcloud`](https://github.com/gakonst/djbooth/tree/main/packages/soundcloud): SoundCloud OAuth and Public API.
- [`slsk-ts`](https://github.com/gakonst/djbooth/tree/main/packages/slsk-ts): Soulseek protocol, search, and transfers.
- [`@gakonst/ytdlp-ts`](https://github.com/gakonst/djbooth/tree/main/packages/ytdlp-ts): YouTube/SoundCloud extraction and selected downloads.
- [`@gakonst/rekordbox`](https://github.com/gakonst/djbooth/tree/main/packages/rekordbox-ts): Rekordbox-compatible database and file formats.
- [`@gakonst/djbooth-app`](https://github.com/gakonst/djbooth/tree/main/apps/djbooth): Local djbooth.ai workstation and guarded library mutations.
- [`@gakonst/djlink`](https://github.com/gakonst/djbooth/tree/main/packages/djlink): Native Pro DJ Link RemoteDB/NFS server and bounded CDJ load control.
- [`@gakonst/cdj-usb`](https://github.com/gakonst/djbooth/tree/main/packages/cdj-usb): CDJ-3000 mounted-media synchronizer and Linux USB mass-storage gadget.

## Development

```sh
pnpm --filter @gakonst/djbooth validate
```

MIT licensed.
