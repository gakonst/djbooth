---
"@gakonst/tracks": minor
"@gakonst/rekordbox": minor
"@gakonst/music": patch
"@gakonst/ytdlp-ts": patch
---

Add a resumable set-to-Rekordbox library workflow and Incur command that resolves a set, enriches
Spotify metadata, acquires every individual or explicitly approved cue-bounded recording, pipelines
bounded four-worker native analysis with acquisition, and installs verified analysis in one normal
Rekordbox database transaction. Add offline `analyze-existing` and `import-existing` stage commands
with manifest checkpoints, run timestamps, partial-result recovery, and idempotent warm verification.

Add generic acquisition planning with local recording adoption, overlap and ambiguity preservation,
stage-specific bounded network/provider pools, typed native-download fallback provenance, persistent
checkpoints, warm resume, cancellation-safe cleanup, and critical-path performance metrics.

Harden batch analysis with structured progress, abort-aware child cleanup, indexed partial failures,
atomic artifact validation, exact PPTH source-basename checks, and a narrow ASCII-staging retry for
the known native Unicode-path incompatibility.

Fix the documented ytdlp `--no-overwrites` flag so it maps to the internal negative boolean without
being rejected by Incur.
