# Changelog

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

- e56a386: Consolidate the five music tools into one pnpm workspace and add `@gakonst/music` as the unified
  subpath API, CLI, agent Skill, and MCP entrypoint. Share validation, install previews, and
  Changesets-managed releases across the workspace.
- 89b78b2: Load CLI credentials from one workspace-root `.env` while retaining current-directory support for standalone package use.

## 0.1.0 — 2026-07-10

- Add the generated TypeScript client for all 96 operations in Spotify's official schema.
- Add OAuth Authorization Code with PKCE, refresh-token persistence, Client Credentials, and static
  access-token authentication.
- Add the `incur` CLI, including every OpenAPI operation, common personal-data shortcuts, MCP,
  agent discovery, and raw request support.
- Add automatic refresh, rate-limit handling, transient retries, pagination, and structured errors.
