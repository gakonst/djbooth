# Music stress and recovery validation

Validated on 2026-07-10 in Pacific Time. Live-site results are evidence for that run; deterministic
tests guard the behavior in CI without depending on third-party availability.

## Five-track mixed-service batch

- Inputs: three public SoundCloud tracks and two public YouTube tracks.
- Scheduler for this historical validation: explicit global concurrency 4, YouTube concurrency 1.
- Result: 5 downloaded, 0 failed.
- Artifacts: 5 audio files, 5 `.info.json` files, and 5 artwork files.
- SoundCloud selected the best exposed AAC streams (160 kbps on the tested Monstercat tracks).
- YouTube produced audio-only M4A files with embedded title, artist, and attached cover art.
- A repeat run skipped all five from URL fingerprints in 0.168 seconds without extraction requests.

## Interruption and resume

The live progressive SoundCloud test aborted after 326,450 bytes. The next invocation issued a Range
request, reported its first progress event at 358,347 bytes, and completed the 2,881,409-byte file.
FFprobe validated it as a 180.062-second MP3.

The deterministic test server also severs its first 512 KiB transfer. The downloader retries inside
the same invocation, sends `Range: bytes=<part-size>-`, and verifies the final bytes exactly.

## YouTube transfer policy

- Up to 64 YouTube tracks at a time by default, bounded by the global 64-track limit.
- One fragment at a time.
- One-second request spacing and randomized two-to-five-second spacing inside each transfer.
- Ten HTTP and fragment retries.
- Exponential retry sleeps from one to twenty seconds for HTTP, fragment, and extractor errors.
- Re-extraction when throughput falls below 100 KiB/s.
- Optional `--youtube-rate-limit` and cookies/browser cookies for account-specific access.
- Explicit `--concurrency` and `--youtube-concurrency` overrides for provider-specific throttling.

The default `best` mode never intentionally performs a lossy transcode. Conversion is enabled only
when `--audio-format` names a target codec.

## Final mixed resume-routing check

A three-track run exercised every production route after hardening:

- Progressive SoundCloud: native 128 kbps MP3 with JSON and artwork sidecars.
- HLS SoundCloud: reference 160 kbps AAC/M4A with JSON, artwork, title/artist tags, and attached cover.
- YouTube: serialized reference 128 kbps AAC/M4A with JSON, artwork, title/artist tags, and attached cover.

All three completed with zero failures. FFprobe confirmed the only video streams were explicitly
marked `attached_pic=1`; there was no playable video payload.
