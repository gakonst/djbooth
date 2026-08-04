# djbooth.ai

An agentic, local-first workflow for turning music into prepared DJ sets: discovery, acquisition,
analysis, stems, library management, practice, and playback. Rekordbox is a compatibility target;
djbooth.ai produces the database, analysis, and USB artifacts that existing players understand.

## The workflow

```text
set URL
  → resolve the tracklist
  → find and acquire local recordings
  → analyze BPM, key, beat grids, phrases, and waveforms
  → create an ordered compatible playlist
  → practice in the workbench or separate stems
  → serve directly to CDJs or sync a USB
```

Everything enters through the Incur-based `djbooth` CLI. Focused TypeScript, Rust, and Python CLIs
remain available for development, but normal user and agent flows use `djbooth …`.

## 1. Import a set

```sh
djbooth tracks import-set "$SET_URL" \
  --manifest "$MANIFEST_PATH" \
  --write \
  --format json
```

This one resumable command resolves the set, acquires canonical local recordings, runs the
clean-room analyzer, and writes verified ordered membership as Rekordbox-compatible database
artifacts. Tracks are shared under `~/.djtools/tracks/` by default, so another playlist reuses them
instead of creating copies. Set `DJBOOTH_LIBRARY_ROOT` to choose another location;
`MUSIC_LIBRARY_ROOT` remains a compatibility alias.

For a track unavailable from individual sources, permit a bounded recovery from a local set
recording:

```sh
djbooth tracks import-set "$SET_URL" \
  --manifest "$MANIFEST_PATH" \
  --allow-set-clips \
  --source-set-path "$LOCAL_SET" \
  --write
```

## 2. Browse and practice

Open the local djbooth.ai workstation:

```sh
djbooth library serve --open
djbooth library serve --open --no-assistant # use Codex or Claude as the chat surface
```

The server stays on loopback and opens `master.db` read-only unless writes are explicitly enabled.

Create MLX Mel-Band-RoFormer stems on Apple Silicon:

```sh
djbooth rekordbox stems doctor
djbooth rekordbox stems separate ./track.flac ./stems \
  --layout four-stem \
  --format json
```

The model and converted weights are cached. The standalone implementation lives in
`python/stems-mlx` and is invoked through the typed Incur wrapper.

## 3. Play on CDJs

### Pro DJ Link

Expose the complete local library to connected players using Rekordbox-compatible metadata:

```sh
djbooth djlink rekordbox --format json
```

Cue one track on a player in the same flow:

```sh
djbooth djlink rekordbox "$TRACK" --player 3 --format json
```

DJ Link serves local audio and ANLZ data. It does not stream Spotify audio or remotely press PLAY.

### USB

Create or update one playlist on a front-panel USB:

```sh
djbooth usb sync-playlist /Volumes/CDJ "$PLAYLIST_ID" \
  --database /path/to/master.db \
  --fresh \
  --write \
  --format json
```

Omit `--fresh` for an existing compatible stick. Warm reruns reuse unchanged audio and analysis
files. Full-library synchronization and CDJ history import are also available:

```sh
djbooth usb sync /Volumes/CDJ --database /path/to/master.db --write --format json
```

## Agents

The same workflow is exposed as an agent Skill and optional MCP command map:

```sh
djbooth skills add
djbooth mcp add
```

This repository also ships one marketplace plugin for Codex and Claude Code:

```sh
codex plugin marketplace add gakonst/music-ts
codex plugin add djbooth@djbooth-ai

claude plugin marketplace add gakonst/music-ts
claude plugin install djbooth@djbooth-ai
```

## Repository map

| Path                                      | Workflow responsibility                                |
| ----------------------------------------- | ------------------------------------------------------ |
| [`packages/`](packages)                   | TypeScript libraries, focused CLIs, and Incur wrappers |
| [`apps/djbooth/`](apps/djbooth)           | Browser/loopback workstation and Tauri application     |
| [`packages/djbooth/`](packages/djbooth)   | Unified API, CLI, MCP map, and agent Skill             |
| [`rust/bin/`](rust/bin)                   | Native analyzer, DJ Link, and USB CLI packages         |
| [`rust/crates/`](rust/crates)             | Reusable Rust libraries                                |
| [`python/stems-mlx/`](python/stems-mlx)   | Standalone uv/MLX stem separator                       |
| [`archive/rekordbox/`](archive/rekordbox) | Retired rehost and proprietary research artifacts      |

The TypeScript command owns validation and structured output; it shells out only when crossing into
a Rust or Python implementation helper.

## Development

Requires Node.js 22, pnpm 10.30.2, Rust nightly, uv, and ffmpeg/ffprobe.

```sh
pnpm install
pnpm validate
pnpm djbooth --help
```

Copy `.env.example` to the ignored root `.env` for local credentials. Never commit sessions,
cookies, downloaded media, Rekordbox databases, or proprietary runtime caches.
