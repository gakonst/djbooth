---
"@gakonst/djbooth-app": minor
"@gakonst/djbooth": minor
"@gakonst/rekordbox": patch
"@gakonst/tracks": patch
---

Add a loopback-only React workbench over the native TypeScript Rekordbox APIs, with library health,
playlist hierarchy, sortable track search, a persistent range-streamed RGB waveform player, artwork,
cue editing, keyboard/context actions, an infinite set canvas, and explicitly enabled guarded
playlist mutations. Keep interactive edits instant with optimistic updates and short lock-coordinated
SQLite transactions.

Expose the workbench through the aggregate Incur CLI, share its database-writer lock, reject commits while either
Rekordbox process is active, and stop redistributing the proprietary analyzer helper/runtime in the
public npm package.
