<div align="center">

<h1>djbooth.ai</h1>

<p><strong>Give your agent a DJ booth.</strong></p>

<p>
One local system for finding music, acquiring recordings, analyzing tracks, separating stems,<br>
building playlists, preparing USBs, and playing through CDJs.
</p>

[![CI](https://img.shields.io/github/actions/workflow/status/gakonst/djbooth/main.yml?branch=main)][ci]
[![Node](https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white)][node]
[![Rust](https://img.shields.io/badge/native-Rust-black?logo=rust)][rust]
[![Local first](https://img.shields.io/badge/data-local--first-7c3aed)][local-first]

**[Install](#install)** · **[Why](#why-djboothai)** · **[Agent workflow](#the-agent-workflow)** ·
**[Workbench](#the-workbench)** · **[Hardware](#from-library-to-hardware)** ·
**[Architecture](#architecture)**

[ci]: https://github.com/gakonst/djbooth/actions/workflows/main.yml
[node]: https://nodejs.org/
[rust]: https://www.rust-lang.org/
[local-first]: #local-first-by-design

</div>

Install djbooth.ai, add its Skill to Codex or Claude Code, and your agent can run the complete DJ
workflow—not merely suggest what you should do next. It can resolve a set, find the recordings,
avoid downloading files you already own, analyze BPM/key/beat grids/phrases/waveforms, generate
stems, create playlists, prepare a Rekordbox-compatible USB, and serve or cue tracks over Pro DJ
Link.

Prefer to work directly? Open the same system as a local web or native Tauri app. Browse providers,
edit playlists, inspect analysis, toggle stems while a track plays, practice on two decks, shape EQ,
and audition transitions manually. Agent and UI operate on the same cached library and tools.

## Install

The npm release is not public yet. Install from source on Node.js 22:

```sh
gh repo clone gakonst/djbooth ~/github/gakonst/djbooth
cd ~/github/gakonst/djbooth
pnpm install
pnpm build
(cd packages/djbooth && npm link)
djbooth --version
```

Add the agent plugin:

```sh
# Codex
codex plugin marketplace add gakonst/djbooth
codex plugin add djbooth@djbooth-ai

# Claude Code
claude plugin marketplace add gakonst/djbooth
claude plugin install djbooth@djbooth-ai
```

Or install the Skill/MCP map from the CLI:

```sh
djbooth skills add
djbooth mcp add
```

Provider credentials live in the ignored root `.env`; see [`.env.example`](.env.example). Local
audio, sessions, cookies, databases, and model caches stay outside Git.

## Why djbooth.ai

### The DJ workflow is one job

Music tooling is usually a pile of disconnected steps: identify a tracklist in one place, search
for files somewhere else, analyze them in another application, rebuild the playlist, export it,
then discover at the decks that an artifact is missing.

An agent cannot reliably finish that job if it only has search results and chat. It needs typed,
composable tools spanning the whole lifecycle, durable state between steps, and enough validation
to know whether the result will actually play.

djbooth.ai makes the entire preparation loop one system:

```text
prompt, playlist, or set URL
  → resolve identities and ordering
  → reuse or acquire canonical local recordings
  → analyze audio and generate player-compatible artifacts
  → separate stems when requested
  → create or update the local library and playlists
  → practice in the workbench, sync a USB, or serve connected CDJs
```

### Agents should do the work

“Find tracks for a late-night warm-up” should not produce a search query named
`late-night warm-up`. The agent should inspect the library semantically, consider tempo, key,
energy, history, and availability, then assemble a temporary or durable playlist that can be heard,
edited, analyzed, and exported.

The Skill teaches Codex and Claude the workflow and safety contracts. The Incur CLI and MCP/Code
Mode surfaces provide bounded structured tools. The agent can parallelize independent searches,
downloads, analysis, and preparation while preserving ordered playlist results.

### Local-first by design

The valuable state is local: recordings, Rekordbox-compatible databases, analysis files, stems,
credentials, USB contents, listening history, and nearby hardware. djbooth.ai keeps that state on
your machine and treats hosted providers as inputs—not as the source of truth for your library.

Downloads, metadata, provider responses, model weights, analysis, stems, and playlist acquisition
are cached. Warm runs reuse completed work instead of redownloading or reanalyzing tracks.

### Compatibility without surrendering the workflow

Rekordbox and CDJs are compatibility targets, not djbooth.ai's product surface. The clean-room
analyzer produces compatible DAT/EXT/2EX analysis, the library tools read and write compatible
databases, USB sync emits the layouts players expect, and the DJ Link runtime serves local audio
and metadata directly.

That means the workflow can be automated and inspected end to end while the resulting media still
works with existing DJ hardware.

### Human control remains first-class

Agentic does not mean invisible. Every useful operation is also available through the CLI or
workbench. Destructive library writes remain explicit; the normal workbench opens the active
database read-only unless write access is requested.

## The agent workflow

Ask in outcomes:

```text
Import this Spotify playlist, acquire anything I do not already have, analyze every track,
and build me a Rekordbox-compatible playlist.

Find 20 tracks in my library for a deep late-night warm-up. Keep the energy rising, avoid tracks
I played last weekend, and open the result so I can audition it.

Create four-stem versions of these tracks, then suggest and audition three transitions on deck A/B.

Start this playlist fresh on my USB, verify every waveform artifact, and tell me when it is safe to
eject.

Serve my library to the CDJs and cue "Apathy" on player 3 without starting playback.
```

The agent composes the same `djbooth` commands available to humans. One representative explicit
pipeline:

```sh
djbooth tracks import-set "$SET_URL" \
  --manifest "$MANIFEST_PATH" \
  --write \
  --format json
```

It resolves the ordered tracklist, acquires missing local recordings, runs the clean-room analyzer,
and writes verified playlist membership. Recordings are shared under `~/.djtools/tracks/` by
default, so multiple playlists reuse the same files.

## The workbench

Open the browser workstation:

```sh
djbooth library serve --open
```

Use Codex or Claude as the chat surface and omit the embedded assistant rail:

```sh
djbooth library serve --open --no-assistant
```

The same workbench is packaged as the `djbooth.ai` Tauri desktop app. It provides:

- Local, Spotify, and SoundCloud browsing with collapsed provider controls and cached acquisition.
- Automatic download and analysis when hosted playlists enter the local workflow.
- Playlist creation, ordering, metadata editing, semantic search, and temporary set building.
- RGB waveforms, BPM/key/phrase inspection, cues, and on-demand MLX Mel-Band-RoFormer stems.
- Live stem enable/mute controls, two stacked decks, EQ/volume controls, and transition auditioning.
- USB synchronization and DJ Link status from the same library state.

## From library to hardware

### Analyze and separate stems

```sh
djbooth rekordbox analyze track ./track.flac \
  --output-directory ./analysis \
  --format json

djbooth rekordbox stems separate ./track.flac ./stems \
  --layout four-stem \
  --format json
```

Native analysis, USB, and DJ Link operations ship as one `djbooth-rs` binary with `analyzer`, `usb`,
and `link` subcommands. Apple Silicon stem separation is a standalone uv/MLX project invoked through
the same typed CLI.

### Sync a USB

```sh
djbooth usb sync-playlist /Volumes/CDJ "$PLAYLIST_ID" \
  --database /path/to/master.db \
  --fresh \
  --write \
  --format json
```

Warm reruns reuse unchanged audio and analysis. Full-library sync and CDJ history import are also
available:

```sh
djbooth usb sync /Volumes/CDJ --database /path/to/master.db --write --format json
```

### Serve connected CDJs

```sh
djbooth djlink rekordbox --format json
djbooth djlink rekordbox "Apathy" --player 3 --format json
```

DJ Link serves verified local recordings and ANLZ data. Spotify identities remain metadata; hosted
streaming audio is not exported over Link. Loading a track cues it and intentionally does not press
PLAY.

## Architecture

```text
Codex / Claude / Nanocodex             djbooth.ai workbench
              │                                  │
              └──────── Skill · MCP · CLI ───────┘
                                 │
                    typed TypeScript orchestration
                   ┌─────────────┼──────────────┐
                   │             │              │
          providers/library   djbooth-rs     MLX stems
                   │      analyzer·usb·link     │
                   └─────────────┼──────────────┘
                                 │
             local library · compatible artifacts · CDJs
```

The TypeScript layer owns workflow composition, validation, caching, structured output, and public
APIs. Rust owns latency-sensitive DSP, USB appliance behavior, and DJ Link. Python/uv owns the MLX
model runtime. The focused implementations remain directly runnable, but normal users and agents
enter through `djbooth`.

| Path                                          | Responsibility                                      |
| --------------------------------------------- | --------------------------------------------------- |
| [`packages/djbooth/`](packages/djbooth)       | Unified API, CLI, MCP map, and agent Skill          |
| [`apps/djbooth/`](apps/djbooth)               | Browser workstation and Tauri desktop application   |
| [`packages/`](packages)                       | Typed workflow libraries and focused Incur commands |
| [`rust/bin/djbooth-rs/`](rust/bin/djbooth-rs) | Unified native CLI                                  |
| [`rust/crates/`](rust/crates)                 | Reusable analyzer, core, and DJ Link libraries      |
| [`python/stems-mlx/`](python/stems-mlx)       | Standalone uv/MLX stem separator                    |
| [`archive/rekordbox/`](archive/rekordbox)     | Retired compatibility research artifacts            |

## Development

Requires Node.js 22, pnpm 10.30.2, Rust nightly, uv, and ffmpeg/ffprobe.

```sh
pnpm install
pnpm validate
cargo test --manifest-path rust/Cargo.toml --workspace
pnpm djbooth --help
```

See [`packages/rekordbox-ts/PORTING.md`](packages/rekordbox-ts/PORTING.md) for the durable clean-room
compatibility and verification journal.
