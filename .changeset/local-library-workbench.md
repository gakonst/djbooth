---
"@gakonst/rekordbox-library": patch
"@gakonst/music": minor
"@gakonst/rekordbox": patch
"@gakonst/tracks": patch
---

Add a loopback-only React workbench over the native TypeScript Rekordbox APIs, with library health,
playlist hierarchy, track search and inspection, audio preview, and explicitly enabled guarded
playlist mutations.

Package one generated Music skill for both Claude Code and Codex marketplaces, expose the workbench
through the aggregate Incur CLI, share its database-writer lock, reject commits while either
Rekordbox process is active, and stop redistributing the proprietary analyzer helper/runtime in the
public npm package.
