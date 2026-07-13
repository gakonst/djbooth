---
"@gakonst/tracks": minor
"@gakonst/rekordbox": minor
"@gakonst/music": patch
"@gakonst/ytdlp-ts": patch
---

Add a resumable set-to-Rekordbox library workflow and Incur command that resolves a set, enriches
Spotify metadata, acquires every individual or explicitly approved cue-bounded recording, pipelines
64-way native analysis with acquisition, and installs verified analysis in one normal Rekordbox
database transaction.

Add generic acquisition planning with local recording adoption, overlap and ambiguity preservation,
parallel fallback searches, persistent checkpoints, warm resume, and critical-path performance
metrics.

Fix the documented ytdlp `--no-overwrites` flag so it maps to the internal negative boolean without
being rejected by Incur.
