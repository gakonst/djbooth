---
"@gakonst/rekordbox": patch
"@gakonst/music": patch
"@gakonst/spots": patch
"@gakonst/tracks": patch
"@gakonst/ytdlp-ts": patch
"slsk-ts": patch
---

Consolidate the five music tools into one pnpm workspace and add `@gakonst/music` as the unified
subpath API, CLI, agent Skill, and MCP entrypoint. Share validation, install previews, and
Changesets-managed releases across the workspace.
