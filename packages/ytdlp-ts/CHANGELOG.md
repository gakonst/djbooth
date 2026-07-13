# @gakonst/ytdlp-ts

## 0.3.0

### Minor Changes

- 91008dd: Parallelize and instrument set resolution, Spotify enrichment, ambiguous recording acquisition,
  artifact verification, Rekordbox analysis, backups, and import preflight while preserving a single
  serialized manifest checkpoint stream and one Rekordbox database commit.

  Keep agent discovery Incur-native by generating the aggregate music skill from command metadata
  instead of shipping obsolete handwritten skill snapshots.

  Default playlist-scale analysis, inspection, acquisition, verification, and metadata pools to 64
  workers, while preserving deterministic ordering, provider retry/backoff, explicit lower overrides,
  serialized manifest checkpoints, and the single Rekordbox database transaction.

- 9f40ea2: Expose every specialist Incur CLI as an importable module and mount their composable DJ-workflow
  commands in the unified normal and CodeMode MCP servers.
- 0ee52b6: Create, read, update, and delete playlists directly in Spotify and SoundCloud from track IDs, URNs,
  or platform URLs. Add user-OAuth preflights, private-by-default CLI and MCP commands, Spotify
  batching, partial-write recovery, and safe non-retrying creation requests. Export every package's
  side-effect-free Incur definition through a `./cli` subpath and compose those definitions directly
  under the `music` CLI.

### Patch Changes

- e56a386: Consolidate the five music tools into one pnpm workspace and add `@gakonst/music` as the unified
  subpath API, CLI, agent Skill, and MCP entrypoint. Share validation, install previews, and
  Changesets-managed releases across the workspace.
