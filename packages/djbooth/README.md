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
await djlink.doctorRekordboxDjLink();
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
import { loadDjLinkTrack, startRekordboxDjLink } from "@gakonst/djbooth/djlink";
import { exportLegacyDeviceLibrary } from "@gakonst/djbooth/usb";
import { transcribeAudioToMidi } from "@gakonst/djbooth/transcription";

await transcribeAudioToMidi("reference.wav", "reference.mid", {
  eventsPath: "reference.events.json",
  tempo: 126,
});
```

## CLI

Workflow stages sit directly under `djbooth`. Provider integrations remain grouped, while focused
package and implementation CLIs are reserved for development and diagnosis.

```sh
djbooth resolve "https://youtu.be/example" --format json
djbooth download "https://youtu.be/example" --format json
djbooth analyze "https://youtu.be/example" --analysis-threads 12 --format json
djbooth import "https://youtu.be/example" --format json
djbooth enrich --folder "DJ Sets I Like" --format json
djbooth stems "$CONTENT_ID" --layout four-stem --format json
djbooth status --format json
djbooth serve --open
djbooth serve --open --no-assistant
djbooth stop --format json
djbooth link "Artist - Track" --player 3 --format json
djbooth usb /mnt/cdj --playlist-folder "DJ Sets I Like" --format json
djbooth produce transcribe reference.wav reference.mid --tempo 126 --format json

# Specialist provider APIs remain namespaced.
djbooth spots auth status --format json
djbooth spots playlist create "Set IDs" --track "spotify:track:4iV5W9uYEdYUVa79Axb7Rh" --format json
djbooth soundcloud playlist create "Set IDs" --track "https://soundcloud.com/artist/track" --format json
djbooth slsk search "artist track" --timeout 8 --format json
```

Rekordbox `master.db` is the sole durable workflow state. `resolve` writes ordered rows; `download`
and `enrich` can advance independently; `analyze` checkpoints compatible ANLZ artifacts; and
`import` runs through an ordered playlist in one resumable command. Files are immutable
artifacts referenced by the database, not a second workflow ledger.

`serve --open` is the one-command startup: it starts or resumes the managed Pro DJ Link source,
hardware telemetry, and one loopback web app. The app has Library at `http://127.0.0.1:4179/` and
Live Booth at `http://127.0.0.1:4179/booth`. It returns readiness JSON immediately. `status` reports
library, import, UI, and Link state; `stop` shuts down the managed runtime. `link [track]` is the
bounded deck path when only serving or playback is needed.
Loading starts the selected deck and confirms playback from CDJ status.

`djbooth usb` is the separate front-panel content path. It first imports each unseen CDJ history
into the normal Rekordbox `master.db` as a `DJ Set YYYY-MM-DD` playlist, preserving order and
duplicates while updating play counts exactly once. It then differentially reconciles the complete
active library into legacy `PIONEER/rekordbox/export.pdb`, local audio, rewritten DAT/EXT/2EX
analysis, and playlists. SQLite stays authoritative and Device Library Plus is not involved. The
destination is a mounted FAT/exFAT media root or staging directory; no image is created by the sync
command. The standalone `cdj-usb` CLI retains lower-level export and diagnostics.

For a freshly formatted stick, `cdj-usb sync-playlist --fresh` exports one analyzed playlist to
both traditional Device Library and OneLibrary. Both indexes share one audio/ANLZ tree and are
validated before the receipt is published. Later runs omit `--fresh`; unchanged media is a
zero-copy no-op, while appends preserve existing dual-library rows.

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

Discover the complete typed command map through Incur or register it as MCP:

```sh
djbooth --help
djbooth --llms
djbooth --llms-full
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

- [`@gakonst/tracks`](https://github.com/gakonst/djbooth/tree/main/packages/tracks-ts): playlist/DJ-set resolution, enrichment, acquisition, and pipeline coordination.
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

### Audio recommendations with Clef-omni

`pnpm djbooth recommend reference.flac --candidate candidate-a.mp3 --candidate candidate-b.wav --brief "Keep the rolling groove, with a little more energy" --start 60 --duration 30 --format json`

This experimental command ranks supplied local tracks by their audible fit to a reference and brief. It requires `ffmpeg`, `CLOUDFLARE_ACCOUNT_ID`, and `CLOUDFLARE_API_TOKEN` (or `CLOUDFLARE_AUTH_TOKEN`) with Workers AI Run permission. It sends audio excerpts to Cloudflare and incurs one inference request per unique candidate (up to 20). It never changes the library or creates a playlist. CLI help/schema and MCP expose the same command.

Each file is decoded locally into a mono 24 kHz WAV excerpt, default 30 seconds and at most 60 seconds. `--start` applies to every file; choose a representative section, not a silent intro. Two clips per request stay below the documented 4-clip, 8 MiB/clip, 300-second/clip and 16 MiB combined limits. Candidates are scored individually with identical yes/no questions; output includes fit, groove and energy probabilities, sorted by fit. These are experimental model judgments, not measured BPM/key or guaranteed transition compatibility. No music-recommendation benchmark has been established for this model; audition results before mixing. Ranking across independent requests is heuristic.

All files are prepared before requests begin. A failed request stops the run without automatic retry; prior successful calls may already be billed. Excerpts live only in memory. `--progress always|auto|never` controls stderr progress. Credentials and audio are never included in the result.

Sources: [Clef announcement](https://blog.cloudflare.com/clef-faster-cheaper-multimodal/), [Clef-omni model documentation](https://developers.cloudflare.com/workers-ai/models/clef-omni/), [input schema](https://developers.cloudflare.com/workers-ai/models/clef-omni/schema-input.json), [output schema](https://developers.cloudflare.com/workers-ai/models/clef-omni/schema-output.json). Clef-omni is a typed decision API, not an embedding or music-generation endpoint; Clef and Clef-flash do not accept audio. A next step is evaluating blind DJ judgments against these rankings, then combining validated audio-fit scores with existing BPM/key analysis and library candidate retrieval.
