# music-ts

One TypeScript workspace for resolving DJ sets, enriching their metadata, publishing playlists to
Spotify or SoundCloud, acquiring individual recordings, and maintaining Rekordbox playlists. The
five original repositories retain their full Git histories under `packages/`.

End-to-end set imports keep one shared on-disk library at
`~/.djtools/tracks/<artist>/<album>/<title> [identity].ext` by default. Playlist order lives in the
normal Rekordbox database, so importing another set reuses canonical recordings instead of making
playlist-specific file copies. Set `MUSIC_LIBRARY_ROOT` to move the shared root.

## Packages

| Package                                                    | CLI                 | Responsibility                                                         |
| ---------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------- |
| [`@gakonst/music`](packages/music)                         | `music`             | Unified namespace/subpath API, CLI, agent Skill, and MCP entrypoint    |
| [`@gakonst/tracks`](packages/tracks-ts)                    | `tracks`            | Set/tracklist resolution, orchestration, caches, acquisition manifests |
| [`@gakonst/spots`](packages/spots)                         | `spots`             | Typed Spotify Web API, OAuth, playlists, metadata                      |
| [`@gakonst/soundcloud`](packages/soundcloud)               | `soundcloud`        | Typed SoundCloud API, OAuth, account playlists, uploads                |
| [`slsk-ts`](packages/slsk-ts)                              | `slsk`              | Soulseek protocol, search, shares, individual-file downloads           |
| [`@gakonst/ytdlp-ts`](packages/ytdlp-ts)                   | `ytdlp-ts`          | YouTube/SoundCloud inspection and resilient media acquisition          |
| [`@gakonst/rekordbox`](packages/rekordbox-ts)              | `rekordbox`         | Normal encrypted Rekordbox database and format APIs                    |
| [`@gakonst/rekordbox-library`](packages/rekordbox-library) | `rekordbox-library` | Loopback-only Rekordbox library workbench                              |

Package licenses remain package-local; `ytdlp-ts` uses the Unlicense and the other packages use MIT.

Install one package and use only the subpaths needed by a process:

```sh
pnpm add --allow-build=better-sqlite3-multiple-ciphers @gakonst/music
```

```ts
import { identify } from "@gakonst/music/tracks";
import { SpotifyClient } from "@gakonst/music/spots";
import { SoulseekClient } from "@gakonst/music/slsk";
import { ReferenceClient } from "@gakonst/music/ytdlp";
import { MasterDatabase } from "@gakonst/music/rekordbox";
import { RekordboxLibraryService } from "@gakonst/music/library";
```

## Pipeline

```text
YouTube / SoundCloud set
  -> tracks: description or 1001Tracklists resolution
  -> spots: Spotify metadata enrichment
  -> spots / soundcloud: optional ordered playlist publishing on-platform
  -> slsk-ts, then ytdlp-ts: canonical artist/album recordings
  -> tracks: bounded set extracts only for unavailable IDs
  -> rekordbox: automatic verified playlist membership in the normal encrypted database
```

`tracks` imports the other four packages through `workspace:*` dependencies. Independent recording
jobs run concurrently; manifest checkpoints and Rekordbox mutations stay serialized and fail closed.
The umbrella CLI mounts each package's exported Incur CLI definition; it neither shells out nor
maintains a second set of command schemas.

## Development

Requirements: Node.js 22 or 24, pnpm 10.30.2, plus ffmpeg/ffprobe for media integration tests.

Copy `.env.example` to the ignored workspace-root `.env`. The `music`, `tracks`, `spots`,
`soundcloud`, and `slsk` CLIs load this one file; do not keep credentials inside package folders.

```sh
pnpm install
pnpm validate

pnpm music --help
pnpm tracks --help
pnpm spots --help
pnpm slsk --help
pnpm ytdlp --help
pnpm rekordbox --help
pnpm library --help
```

Install the curated workflow skill plus Incur's typed command-group skills, or register the same
command map as MCP:

```sh
pnpm music skills add
pnpm music mcp add
```

## Rekordbox library workbench

Browse the normal encrypted library through the native TypeScript APIs, without uploading the
database or shelling through another CLI:

```sh
pnpm music library status --format json
pnpm music library serve --open
pnpm library:dev # repository checkout: writes + Vite HMR on 127.0.0.1:4179
```

The server binds only to loopback and opens `master.db` read-only by default. Launch with `--write`
only for an intentional playlist edit. Every mutation refuses to run while Rekordbox or
`rekordboxAgent` is active and holds the shared database lock. Interactive edits update the UI
optimistically and commit in one serialized SQLite transaction without a per-edit backup, journal,
or heavyweight post-write verification pass. The repository-only `library:dev` workflow enables
writes by default and serves live source through Vite; pass `--read-only` when needed.

## Claude Code and Codex plugins

The repository is a marketplace for one shared `music` skill, packaged with native manifests for
both agents. Install the `music` CLI first, then add the marketplace:

```sh
# Codex
codex plugin marketplace add gakonst/music-ts
codex plugin add music@music-ts

# Claude Code
claude plugin marketplace add gakonst/music-ts
claude plugin install music@music-ts
```

The plugin does not install executables or start a background MCP server. Agents call the same Incur
CLI; `music mcp add` remains an explicit opt-in. During development, rebuild and verify the generated
plugin payload with `pnpm plugin:build` and `pnpm plugin:check`.

Package-scoped iteration remains available:

```sh
pnpm --filter @gakonst/tracks test
pnpm --filter @gakonst/ytdlp-ts build
pnpm --filter @gakonst/rekordbox validate
```

Live Soulseek tests and direct Rekordbox mutations are not part of the default suite. Never commit
Spotify sessions, cookies, Soulseek credentials, downloaded media, or Rekordbox databases.

## Releases

Release automation follows [`wevm/incur`](https://github.com/wevm/incur): Changesets owns package
versions and changelogs, `changesets/action` maintains a version PR, and `pkg-pr-new` publishes
installable previews for pull requests.

For every publishable change:

```sh
pnpm changeset
```

Commit the generated `.changeset/*.md` file with the implementation. After merge:

1. `main.yml` runs the full workspace verification.
2. Changesets opens or updates `chore: version packages`.
3. Merging that PR builds and publishes changed packages, then creates GitHub releases.

The publish job supports npm trusted publishing through GitHub OIDC and intentionally carries no
long-lived token. Each npm package must be configured with `gakonst/music-ts` and `main.yml` as its
trusted publisher. The packages do not yet exist on npm, so the initial publication must establish
ownership before OIDC-only updates can run. Because this repository is private, npm can use trusted
publishing but cannot attach public provenance attestations.

Versions are independent; a dependency bump propagates as a patch through workspace relationships.
The workflow and config live in [`.github/workflows/main.yml`](.github/workflows/main.yml) and
[`.changeset/config.json`](.changeset/config.json).
