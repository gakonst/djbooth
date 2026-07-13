# Music plugin

Claude Code and Codex packaging for the `music-ts` agent workflow.

## Prerequisite

Install `@gakonst/music` separately and ensure `music --version` succeeds. The plugin does not run a
package manager or install executables on the user's behalf. The bundled skill calls the Incur CLI;
users who prefer MCP can register the same command map separately with `music mcp add`.

Until the package's first npm release, use the cloned workspace with `pnpm music` (or link its built
`@gakonst/music` package globally). The marketplace installs agent instructions, not the repository's
native dependencies.

## Install

From the repository marketplace:

```sh
# Codex
codex plugin marketplace add gakonst/music-ts
codex plugin add music@music-ts

# Claude Code
claude plugin marketplace add gakonst/music-ts
claude plugin install music@music-ts
```

The plugin intentionally contains no `.mcp.json`. Its only agent component is the versioned Music
skill, keeping provider behavior identical and avoiding an automatic local process at session start.

## Development

The canonical source is `packages/music/skills/music`. Do not edit the generated copy under this
directory directly. The build also synchronizes plugin metadata to the `@gakonst/music` version;
`changeset:version` invokes it after package versioning.

```sh
node scripts/build-music-plugin.mjs
node scripts/build-music-plugin.mjs --check
```
