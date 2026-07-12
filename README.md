# music-ts

One TypeScript workspace for resolving DJ sets, enriching their metadata, acquiring individual
recordings, and maintaining Rekordbox playlists. The five original repositories retain their full
Git histories under `packages/`.

## Packages

| Package                                       | CLI         | Responsibility                                                         |
| --------------------------------------------- | ----------- | ---------------------------------------------------------------------- |
| [`@gakonst/music`](packages/music)            | `music`     | Unified namespace/subpath API, CLI, agent Skill, and MCP entrypoint    |
| [`@gakonst/tracks`](packages/tracks-ts)       | `tracks`    | Set/tracklist resolution, orchestration, caches, acquisition manifests |
| [`@gakonst/spots`](packages/spots)            | `spots`     | Typed Spotify Web API, OAuth, playlists, metadata                      |
| [`slsk-ts`](packages/slsk-ts)                 | `slsk`      | Soulseek protocol, search, shares, individual-file downloads           |
| [`@gakonst/ytdlp-ts`](packages/ytdlp-ts)      | `ytdlp-ts`  | YouTube/SoundCloud inspection and resilient media acquisition          |
| [`@gakonst/rekordbox`](packages/rekordbox-ts) | `rekordbox` | Normal encrypted Rekordbox database and format APIs                    |

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
```

## Pipeline

```text
YouTube / SoundCloud set
  -> tracks: description or 1001Tracklists resolution
  -> spots: Spotify metadata enrichment
  -> slsk-ts, then ytdlp-ts: individual recordings
  -> tracks: bounded set extracts only for unavailable IDs
  -> rekordbox: verified playlist in the normal encrypted database
```

`tracks` imports the other four packages through `workspace:*` dependencies. Independent recording
jobs run concurrently; manifest checkpoints and Rekordbox mutations stay serialized and fail closed.
The umbrella CLI composes their library APIs; it does not shell between package CLIs.

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
```

Install the single aggregate agent skill or register the same typed command map as MCP:

```sh
pnpm music skills add
pnpm music mcp add
```

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
