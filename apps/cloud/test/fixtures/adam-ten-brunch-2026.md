# Set-import benchmark: Adam Ten, Barcelona 2026

Input: https://www.youtube.com/watch?v=ubifmmR-Mf8&list=RDubifmmR-Mf8&start_radio=1

This is a DJ set, not a request to download the YouTube radio playlist. The public
`djbooth ytdlp-ts inspect` diagnostic confirms the video title and 7,022-second
duration. Its description has no tracklist. Observed 2026-09-17.

## Evidence and limits

The accompanying JSON records factual track metadata from
[groovesMAXXING's reference](https://groovesmaxxing.com/tracklists/adam-ten-sunset-brunch-electronik-barcelona-2026).
Its video and timestamp links point to this exact YouTube ID. It lists 34 slots,
28 named candidates and six IDs, including disputed identities and unreleased
edits. This is a community reference, not independently audio-verified ground
truth. The reference describes this as a reupload; timestamps from the earlier
upload must not be mixed into this timeline without alignment.

[Dancefloor](https://dancefloor.fm/es/set/ubifmmR-Mf8) lists 14 timestamped matches
for the same ID. Some titles/versions and times conflict with the larger reference.
Do not union those rows as if they were separate, confirmed recordings.
The earlier search missed a matching 1001Tracklists candidate supplied by the user:
[Adam Ten @ Brunch Electronik, Barcelona, Spain, 2026-08-23](https://www.1001tracklists.com/tracklist/2t37u0ck/adam-ten-brunch-electronik-barcelona-spain-2026-08-23.html).
This corrects the discovery record; it does not establish a verified 1001 row list.
A direct web-tool read on 2026-09-18 reported the URL inaccessible. The JSON retains
the community reference rows above, with no rows or timestamp alignment inferred
from the supplied URL. Treat the 1001 link as an explicit candidate for normal
page reading and exact-performance verification, without bypassing challenges.

The JSON's `uncertain` and `unreleased` flags are evaluation annotations. They do
not imply that the production acquisition pipeline currently understands every
such distinction. Preserve the six IDs; never give them fabricated recording names.

## Observed production baseline

Read-only inspection of the existing import found six entries marked resolved,
downloaded and analyzed, followed by a failed publication. Four distinct published
track rows reference audio hashes; this is not proof that every referenced asset
is playable. Published titles include an Armand Van Helden version of Uffie's
ADD SUV and the plain Daft Punk recording, whereas the reference names a DEDRO edit
and an unidentified Daft Punk edit. Those matches require verification; artist and
base-title similarity is insufficient to count the exact version as acquired.

## Acceptance criteria

1. Recover every evidenced reference slot in order, keeping six unknown identities
   visible and recording disagreements rather than silently choosing a recording.
2. Track coverage separately from acquisition: 6/6 downloaded must never imply the
   whole 117-minute set was identified. The reference itself remains incomplete.
3. Preserve mix/edit names. Do not replace an unavailable edit with the original or
   a different remix and count it as an exact match.
4. Report standalone recordings, source-set extracts, unresolved identities and
   failed acquisitions separately. Approximate cue times need validation before
   extracts can count as usable audio; reference slots are not precise boundaries.
5. Analyze and publish verified ready recordings, surface partial progress on the
   phone, and retain successful work when retrying identification or publication.
6. Verify playback and local caching, then shared-playlist playback on a second
   account/device, using the same published track assets.

`set-benchmark.test.ts` replays recorded rows with mocked browser/AI responses. It
checks canonical URL/video-ID search, the supplied inaccessible 1001 candidate,
selection after a sparse first result, preservation of
unknowns and version strings, and incomplete status. It does **not** establish live
search recall, AI extraction quality, acquisition success, or phone playback.
Live acquisition, publication repair and the two-device acceptance run remain open.
