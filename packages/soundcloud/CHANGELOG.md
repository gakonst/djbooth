# @gakonst/soundcloud

## 0.2.0

### Minor Changes

- 9f40ea2: Expose every specialist Incur CLI as an importable module and mount their composable DJ-workflow
  commands in the unified normal and CodeMode MCP servers.
- 0ee52b6: Create, read, update, and delete playlists directly in Spotify and SoundCloud from track IDs, URNs,
  or platform URLs. Add user-OAuth preflights, private-by-default CLI and MCP commands, Spotify
  batching, partial-write recovery, and safe non-retrying creation requests. Export every package's
  side-effect-free Incur definition through a `./cli` subpath and compose those definitions directly
  under the `music` CLI.

### Patch Changes

- 3fe21bf: Add the complete typed SoundCloud API client, OAuth 2.1 account sessions, and Incur CLI.
- 89b78b2: Load CLI credentials from one workspace-root `.env` while retaining current-directory support for standalone package use.
