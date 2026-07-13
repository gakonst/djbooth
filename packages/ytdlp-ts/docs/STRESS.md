# Music stress and recovery validation

Validated on 2026-07-10 in Pacific Time. Live-site results are evidence for that run; deterministic
tests guard the behavior in CI without depending on third-party availability.

## Native YouTube direct-audio validation — 2026-07-12 Pacific Time

- `2026-07-13T00:16:21.994Z`–`2026-07-13T00:16:23.241Z`: 14/14 reviewed exact
  YouTube URLs returned direct Android VR M4A/WebM audio formats; elapsed 1,247.19 ms.
- `2026-07-13T00:16:06.688Z`–`2026-07-13T00:16:08.568Z`: native format 140 downloaded
  3,511,486 bytes in 1,879.13 ms. FFprobe measured an M4A duration of 216.774218 seconds.
- `2026-07-13T00:16:30.745Z`–`2026-07-13T00:16:32.575Z`: the initial three-range
  implementation downloaded three native tracks concurrently; 12,007,913 total bytes in
  1,829.59 ms.
- A later nine-request probe produced an intermittent HTTP 403. The production setting is two
  ranges per track: `2026-07-13T00:34:10.045Z`–`2026-07-13T00:34:11.567Z` completed the same three
  M4A tracks (12,007,913 bytes) with six concurrent requests in 1,521.88 ms.
- The final production `downloadMusicBatch` path, including fresh pre-transfer inspection, ran from
  `2026-07-13T00:34:53.887Z` to `2026-07-13T00:34:55.686Z`: 3/3 native M4A tracks, zero failures,
  12,007,913 bytes in 1,798.50 ms.
- After rebasing onto the concurrent-inspection pipeline, the final path ran from
  `2026-07-13T00:43:45.267Z` to `2026-07-13T00:43:47.216Z`: 3/3 native M4A tracks, zero failures,
  12,007,913 bytes in 1,948.66 ms.
- No `ReferenceClient`, external `yt-dlp`, remote player evaluation, or SABR path ran.
- Each track now uses up to two concurrent 1 MiB HTTP ranges. Completed chunks commit in order so
  every `.part` file remained a contiguous resumable prefix.
- Tests cover exact-offset resume, concurrent out-of-order range completion, `Content-Range`
  validation, transient URL sidecar redaction, and error redaction.

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

- Native YouTube defaults to three tracks at a time, two bounded ranges per track.
- Reference YouTube supports up to 64 tracks at a time by default, bounded by the global 64-track
  limit.
- The explicit reference route retains its conservative per-request sleeps and retries.
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
