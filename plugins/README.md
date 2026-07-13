# Plugins

Provider-native plugin packages live here. The `music` plugin follows the same dual-provider
layout as EarthToJake's Text to CAD plugin: separate Claude Code and Codex manifests, one shared
generated skill payload, and provider-specific repository marketplaces.

`plugins/music/skills/` is generated from `packages/music/skills/`. Refresh it with:

```sh
node scripts/build-music-plugin.mjs
```

Check freshness and metadata without writing:

```sh
node scripts/build-music-plugin.mjs --check
```

Production plugin copies contain no symlinks and no credentials.
