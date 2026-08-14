# Boris Brejcha Tomorrowland import and A2SB benchmark

Date: 2026-08-09 (America/Los_Angeles)

## Inputs

- Tracklist evidence: `https://www.1001tracklists.com/tracklist/yfd6329/boris-brejcha-mainstage-tomorrowland-weekend-1-belgium-2026-07-18.html`
- Official source set: `https://www.youtube.com/watch?v=NpL_bT5vgmU`
- Initial anonymous browser result: 14 ordered cues, 5 apparently named rows, 9 apparent IDs, duration 59:40. Later provider cross-checking established 9 verified names and 5 genuine IDs; see the correction below.
- Source artifact: AAC/M4A, 129472 bit/s, 3578.98449 seconds, SHA-256 `33123bb168a98d710657fbaa1b43244102e67f890a325a2a14f0c9bd9eec1ad4`.

## Cold canonical import

Command route: `pnpm djbooth import <official-youtube-source> --agent-result-json <browser-result>`

- Result: 14 downloaded, 14 analyzed, 14 Rekordbox playlist memberships.
- Total wall time: 14207.37 ms.
- Peak concurrency: 9.
- Source-set cache: 9568.90 ms, 1 network request.
- Spotify: 27.71 ms, 5/5 cache hits, 0 network requests.
- Acquisition: 4056.48 ms, 14 operations, concurrency 8, 2 passes.
- Analysis: 3705.36 ms, 14 operations, concurrency 9, 0 cache hits, clean engine, auto rhythm, 24 threads.
- Rekordbox writer: 549.88 ms, 14 operations, serialized concurrency 1.
- Nine unresolved rows were sliced immediately. All five named pre-release rows failed individual acquisition and were recovered from cue-bounded source-set slices on pass 2.
- Audio cache: 9 misses, 9 writes, 691.82 ms load time, 13.30 ms write time.

## Exact 1001Tracklists-source reconciliation

Command route: rerun the supplied 1001Tracklists URL with the cached official recording via `--source-set-path` and `--source-set-url`.

- Result: reused playlist ID `25978518` in folder `1671026022`.
- Total wall time: 2209.66 ms.
- Peak concurrency: 8.
- Source-set describe: 53.89 ms.
- Spotify: 30.69 ms, 5/5 cache hits.
- Acquisition: 1764.48 ms, 14 operations, concurrency 8, 1 pass.
- Analysis: 1493.24 ms, 14 operations, concurrency 5, 9 cache hits.
- Rekordbox writer: 356.91 ms, 14 operations.

## Initial playlist verification

- Playlist: `Boris Brejcha @ Mainstage, Tomorrowland Weekend 1, Belgium 2026-07-18 [tracks-ts]`.
- Playlist ID: `25978518`.
- Ordered members: 14/14; no pagination remainder.
- Every member has BPM, key, duration, M4A format, and Rekordbox analysis state `105`.
- Initial all-slice BPM range observed: 127.98-128.00. The corrected final playlist includes canonical recordings and spans 125-130 BPM.

## Tracklist data-integrity correction

The anonymous 1001Tracklists response was later found to rotate decoy artist/title text between page loads while retaining the same 14 cue IDs and media-record IDs. The initial five displayed names were therefore invalid. The cue count, timestamps, official source video, and media durations remained stable.

Corrected identities were cross-checked against Boris Brejcha's published channel tracklist, independent event recaps, and stable provider media:

1. Boris Brejcha - Cello Tears
2. ID
3. ID
4. Boris Brejcha - Midnight Bells
5. ID
6. Boris Brejcha - Maya
7. Moby - In This World (Boris Brejcha Remix)
8. Boris Brejcha - Bad Girl
9. Boris Brejcha & MC Flipside - Dirty Beat
10. Boris Brejcha - Stay Close
11. Boris Brejcha & Chemutai Sage - Don't Stress Your Mind
12. ID
13. ID
14. Boris Brejcha & Chemutai Sage - Alicante

Stable 1001 media evidence included YouTube `cCo5jRiIVVw` for Maya, YouTube `-72-yNWU5R4` for Bad Girl, Spotify `3DSY7B0roAopGKkCQGut3K` for Dirty Beat, and Spotify `5IEOhfUcuMHfhEeiReQOcH` for Alicante.

The first corrected import acquired and analyzed all changed rows, then exposed a resume bug at the writer boundary: agent-resolution replacement discarded the checkpointed playlist ID, so name-based reconciliation refused stale memberships as tracks outside the new manifest. Before the writer failure:

- Source-set describe: 60.29 ms.
- Spotify: 1707.76 ms.
- Acquisition: 15258.43 ms.
- Analysis: 15117.05 ms, overlapped with acquisition.

The fix carries the exact checkpointed playlist ID into an agent-resolution replacement. This activates the writer's existing stale-membership deletion for the owned target without touching unrelated playlists. Validation passed formatting, TypeScript checking, and all 273 tests across 35 test files.

Post-fix canonical reconciliation reused all 14 recordings and analyses in 923.63 ms total; the exact 1001Tracklists source then reconciled in 636.14 ms. Both source keys report 14 downloaded, 14 analyzed, 14 ready, 9 identified, 5 unresolved IDs, and no pending work. Playlist ID `25978518` remained stable.

## A2SB environment

- Backend/device: MLX, `Device(gpu, 0)` on arm64.
- MLX: 0.31.2; Python: 3.12.12.
- Model revision: `c3d0f52831b3c1c216ad98736dc9fd9253d38342`.
- One-split and both two-split converted float16 checkpoints were ready.
- License reported by runtime: NVIDIA Source Code License for A2SB (noncommercial).

## A2SB trials

### Trial 1: interrupted baseline

- Input at run time: `Real Good [identity-997bcdf2f291].m4a` (cue-bounded source-set extract). The rotating-name issue later established that this audio is the 24:40 Maya cue, not Real Good.
- Requested output: 30-second 24-bit FLAC, one-split defaults, 50 configured bridge steps.
- Observed progress before interruption: steps 1 through 5 of 49.
- The client interruption terminated the process cleanly; no partial output artifact remained.
- Rough early-step latency was approximately 15 seconds per bridge step. A timestamped rerun follows below.

### Trial 2: timestamped rerun

- Input and requested output were identical to trial 1. Timing and spectral results remain valid for the 24:40 Maya set cue despite the stale filename.
- Invocation timestamp: 2026-08-09T20:36:51Z.
- First completed bridge step: 2026-08-09T20:37:11Z (20-second startup/model preparation).
- Final completed bridge step and structured result: 2026-08-09T20:52:07Z.
- Runtime-reported processing time: 913.3003202080727 seconds for 30 seconds of audio, or 30.443x real time.
- The 48 measured step-to-step intervals had mean 18.667 seconds, median 18 seconds, minimum 17 seconds, maximum 22 seconds, and p95 21 seconds.
- Profile: one-split; steps: 50; generated bridge transitions: 49; batch size: 1; overlap enabled; SDE (`ode=false`); seed 0; mid-side stereo.
- Cutoff: 16149 Hz via codec-edge detection; detected spectral rolloff: 14000 Hz.
- Output: 44.1 kHz 24-bit FLAC, 6,105,884 bytes, SHA-256 `08a8bd5938ee78363e435298c333e635a4a5c7cc03bd06c5a1229c1ef2948514`.
- Corrected output path: `/Users/gakonst/.djtools/tracks/Boris Brejcha/Singles/Maya [set-extract-24m40s] [A2SB 30s trial].flac`.

Timestamp trace:

```text
2026-08-09T20:37:11Z A2SB step 1/49
2026-08-09T20:37:29Z A2SB step 2/49
2026-08-09T20:37:46Z A2SB step 3/49
2026-08-09T20:38:04Z A2SB step 4/49
2026-08-09T20:38:22Z A2SB step 5/49
2026-08-09T20:38:42Z A2SB step 6/49
2026-08-09T20:39:02Z A2SB step 7/49
2026-08-09T20:39:20Z A2SB step 8/49
2026-08-09T20:39:38Z A2SB step 9/49
2026-08-09T20:39:56Z A2SB step 10/49
2026-08-09T20:40:13Z A2SB step 11/49
2026-08-09T20:40:31Z A2SB step 12/49
2026-08-09T20:40:49Z A2SB step 13/49
2026-08-09T20:41:07Z A2SB step 14/49
2026-08-09T20:41:25Z A2SB step 15/49
2026-08-09T20:41:42Z A2SB step 16/49
2026-08-09T20:42:00Z A2SB step 17/49
2026-08-09T20:42:18Z A2SB step 18/49
2026-08-09T20:42:36Z A2SB step 19/49
2026-08-09T20:42:54Z A2SB step 20/49
2026-08-09T20:43:13Z A2SB step 21/49
2026-08-09T20:43:32Z A2SB step 22/49
2026-08-09T20:43:50Z A2SB step 23/49
2026-08-09T20:44:08Z A2SB step 24/49
2026-08-09T20:44:27Z A2SB step 25/49
2026-08-09T20:44:46Z A2SB step 26/49
2026-08-09T20:45:04Z A2SB step 27/49
2026-08-09T20:45:23Z A2SB step 28/49
2026-08-09T20:45:41Z A2SB step 29/49
2026-08-09T20:46:00Z A2SB step 30/49
2026-08-09T20:46:18Z A2SB step 31/49
2026-08-09T20:46:36Z A2SB step 32/49
2026-08-09T20:46:56Z A2SB step 33/49
2026-08-09T20:47:16Z A2SB step 34/49
2026-08-09T20:47:38Z A2SB step 35/49
2026-08-09T20:47:58Z A2SB step 36/49
2026-08-09T20:48:18Z A2SB step 37/49
2026-08-09T20:48:39Z A2SB step 38/49
2026-08-09T20:49:01Z A2SB step 39/49
2026-08-09T20:49:21Z A2SB step 40/49
2026-08-09T20:49:39Z A2SB step 41/49
2026-08-09T20:49:58Z A2SB step 42/49
2026-08-09T20:50:16Z A2SB step 43/49
2026-08-09T20:50:35Z A2SB step 44/49
2026-08-09T20:50:53Z A2SB step 45/49
2026-08-09T20:51:12Z A2SB step 46/49
2026-08-09T20:51:30Z A2SB step 47/49
2026-08-09T20:51:48Z A2SB step 48/49
2026-08-09T20:52:07Z A2SB step 49/49
```

## Optimization leads from this run

- Benchmark lower `--steps` values first: step time is nearly constant and sampling dominates the 913-second runtime.
- Compare overlap on/off next; the default overlap may duplicate window work, but seam quality needs an audio comparison.
- Test larger batch sizes only with memory telemetry. Batch size 1 showed no obvious progressive slowdown in this 30-second run.
- Keep one-split as the speed baseline before trying the two-split ensemble, which should be expected to add model work.
- Separate model startup (~20 seconds here) from steady-state throughput when evaluating persistent workers or batching several tracks.
- Compare explicit 14 kHz and codec-edge 16.149 kHz cutoffs; the detector and rolloff disagreed materially on this AAC source.
