---
"@gakonst/djbooth": minor
"@gakonst/djbooth-app": minor
"@gakonst/djlink": minor
"@gakonst/rekordbox": minor
"@gakonst/tracks": patch
---

Add opt-in, authenticated TLS Mac-library pairing for iPhone with certificate pinning,
hash-bound audio, analysis and artwork, and live bearer rotation. Preserve playlist
hierarchy and repeated entries, expose library addition dates, and support bounded
offline downloads without repeatedly persisting decoded waveform arrays.

Support OMNIS-DUO discovery, separate deck loading and transport state, forward
beat-grid position estimates, short NFS export paths, and live library refresh.
Persist daily playback history inside master.db for the desktop Link source.

Add immutable USB-audio copying and resumable OneLibrary playlist restoration.
Keep analysis artifacts beside explicitly selected databases and restore missing
analysis installations without duplicating content or playlist membership.
