---
"@gakonst/rekordbox": minor
"@gakonst/tracks": minor
"@gakonst/ytdlp-ts": minor
"@gakonst/music": patch
---

Parallelize and instrument set resolution, Spotify enrichment, ambiguous recording acquisition,
artifact verification, Rekordbox analysis, backups, and import preflight while preserving a single
serialized manifest checkpoint stream and one Rekordbox database commit.

Keep agent discovery Incur-native by generating the aggregate music skill from command metadata
instead of shipping obsolete handwritten skill snapshots.

Default playlist-scale analysis, inspection, acquisition, verification, and metadata pools to 64
workers, while preserving deterministic ordering, provider retry/backoff, explicit lower overrides,
serialized manifest checkpoints, and the single Rekordbox database transaction.
