---
name: music
description: Resolve YouTube, SoundCloud, 1001Tracklists, local DJ sets, or Spotify playlists into durable track manifests; enrich identities through Spotify; create ordered playlists on Spotify or SoundCloud; acquire individual recordings with Soulseek or selected ytdlp sources; analyze Normal, Dynamic, or Auto Rekordbox beat grids; recover unavailable tracks from cue-bounded set clips; import verified playlists into the normal Rekordbox database; and serve analyzed local recordings to connected CDJs over Pro DJ Link. Use for DJ-set resolution, music metadata, platform playlist publishing, individual-track downloads, Rekordbox library maintenance, connected-CDJ loading, or one-shot resolve-download-analyze-playlist music-ts workflows.
---

# Music

Build an auditable
`source -> identities -> platform playlist and/or recordings -> Rekordbox playlist -> connected CDJ`
pipeline with `@gakonst/music`. Prefer its TypeScript subpath APIs for automation; use the `music`
CLI for interactive work, diagnostics, Skills, and MCP registration.

When one request asks to find a set's tracks, acquire and analyze them, and create its Rekordbox
playlist, run `music tracks import-set` once after the required approvals. Do not decompose that
request into separate CLI commands unless the user asks for a stage-only workflow.
When the same request includes a connected deck, continue after import with one
`music djlink rekordbox <track>`; use `djlink run` only before the recording is in master.db.

## Install and discover

Install the umbrella package and approve the Rekordbox SQLite native build:

```sh
pnpm add @gakonst/music --allow-build=better-sqlite3-multiple-ciphers
music skills add
music --help
```

Use project-local skill installation with `music skills add --no-global`. Incur installs this
curated workflow together with generated, typed references for each top-level command group across
Codex, Claude Code, and other supported agents.

Import only the capability needed by a program:

```ts
import * as tracks from "@gakonst/music/tracks";
import * as spots from "@gakonst/music/spots";
import * as slsk from "@gakonst/music/slsk";
import * as ytdlp from "@gakonst/music/ytdlp";
import * as rekordbox from "@gakonst/music/rekordbox";
import * as djlink from "@gakonst/music/djlink";
```

Do not shell between package CLIs from TypeScript. Construct the exported clients once and pass
them into the orchestration pipeline.

## ytdlp engine contract

Prefer the TypeScript-native engine. The Incur CLI's engine names are a behavioral contract:

- `native` runs only the TypeScript extractor, selector, downloader, and post-processing code. It
  never invokes Python or an external `yt-dlp` executable and fails closed for unported behavior.
- `auto` tries native first and may invoke the external reference executable only after a
  centralized, typed capability gap detected before response bytes are committed. Abort,
  HTTP/network, lock, write, identity, content-range/length, and other validation failures fail
  closed. Do not describe an `auto` result as native; inspect and persist the returned `engine` and
  fallback provenance.
- `reference` deliberately invokes the external `yt-dlp` compatibility executable.

When the user requires the TypeScript implementation, force `--engine native` or construct
`ExtractorRegistry` plus `downloadMedia`; never construct `ReferenceClient`. Record the requested
engine, actual engine, package version, start/finish timestamps, and any typed limitation in the
manifest. Do not silently install, upgrade, or switch to the reference executable. Current native
YouTube support uses a YouTube.js Web session for bounded search and explicitly requests Android VR
for direct signed M4A/WebM extraction without player-code evaluation. It fails with
`YOUTUBE_DIRECT_FORMATS_UNAVAILABLE` when no direct audio is available; mark that recording
unavailable unless the user separately accepts reference fallback. Public progressive SoundCloud
tracks are supported natively, while some HLS, sets, profiles, and private/account flows may still
require reference behavior.

```sh
music ytdlp-ts inspect "$TRACK_URL" --engine native --format json
music ytdlp-ts music "$TRACK_URL" --engine native --format json
```

## Safety invariants

- Resolve metadata without downloading the source set.
- Prefer an individual release. Download a source set only with explicit approval and complete cue
  boundaries; keep only bounded clips and annotate source URL, time range, checksum, and lossy or
  transition-bearing quality.
- Never pass a raw `ytsearch...` result to a downloader. Inspect a bounded candidate list, select a
  canonical single-track URL, validate its identity and duration, then download that URL with
  playlists disabled.
- Keep Spotify audio metadata-only. Creating a Spotify playlist writes references, never audio.
  Prefer Soulseek for audio, then a reviewed YouTube or SoundCloud
  single-track fallback.
- DJ Link serves only verified local recordings plus native Rekordbox ANLZ artifacts. Spotify IDs
  may identify a recording but never supply its bytes. Do not build a Spotify SDK-to-deck bridge or
  use Spotify APIs for DJ mixing, segueing, or overlapping playback.
- Treat `music djlink load` as remote load/cue, not transport control. Keep deck PLAY physical;
  CDJ-3000 remote play/pause is not a confirmed safe DJ Link command.
- When discovery is empty, use `music djlink probe <known-ip>` as the bounded physical-presence
  check. Do not send speculative DJ Link control packets to undiscovered devices.
- When CDJ Search appears broken, run `music djlink search <query>` first. It exercises the exact
  prewarmed matcher and RemoteDB row builder without touching the deck. After a passing preflight,
  inspect TCP/1051: CDJ-3000 keyboard edits emit incremental `0x1500`; legacy Search may emit
  `0x1300`. A RemoteDB reconnect after each keystroke means the server rejected Search. No request
  of either type means the deck never activated Search.
- Treat Spotify and SoundCloud playlist creation as external account writes. Require an explicit
  request, validate every reference before creation, default to private, and preserve order and
  duplicates. Never retry a playlist-creation POST automatically.
- Preserve every credible recording when an ambiguity remains. An approved end-to-end import may
  choose one deterministic safe acquisition primary, but must retain all candidates and record its
  policy. Collapse only confirmed duplicates sharing release identity, ISRC, and plausible duration.
- Persist the manifest atomically after each match, selection, download, extraction, and export.
- Write the normal Rekordbox database only with explicit approval, Rekordbox processes stopped, an
  exclusive lock, complete backups, and post-write integrity checks. Do not substitute collection
  XML.

## Local library workbench

Use the Incur-composed local workbench to inspect the normal Rekordbox library without shelling
between CLIs or exposing the database to a hosted service:

```sh
music library status --format json
music library serve --open
```

The server binds to loopback, opens the database read-only by default, streams only audio paths
already indexed by Rekordbox, and requires a per-run request token. Playlist mutations are disabled
unless the user explicitly launches `music library serve --write`. Each interactive mutation checks
that Rekordbox and `rekordboxAgent` are stopped, holds the shared cross-process database lock only
for one short SQLite transaction, and updates the client optimistically. Do not create a full library
backup or heavyweight verification pass for every drag, reorder, or cue edit. Long-running imports
and explicitly approved offline bulk workflows still use their own backup/checkpoint contract. The
server watches the database and sidecar and publishes an external-change event, so writes made
through another local `music` CLI refresh the open workbench without stopping it. Never enable
network binding, upload the private library, expose `.env` values, follow symlink-backed audio, or
test write code against the live library; use a copied fixture.

The workbench is the preferred interactive surface for library management. Its WaveSurfer player
uses bounded precomputed Rekordbox peaks and HTTP-range playback, with a flat streaming placeholder
when peaks are unavailable, so playback stays network-bound instead of buffering or decoding a
whole recording. It can show indexed or embedded artwork, configure memory
cues and Hot Cues A–P (including loops, comments, and colors), and edit playlist membership and
order. The infinite set canvas keeps loose candidates and layout in browser-local state;
connections determine order, candidates enter the playlist only when connected, and existing
playlist nodes leave only when explicitly removed. Nothing persists before an explicit **Apply
order** write. Replacement and subtree deletion carry optimistic source snapshots and refuse stale
writes. Prompt commands are planned locally and must cross the same protected mutation boundary
before they alter the database.

For non-visual cue automation, inspect first and keep `--write` explicit:

```sh
music rekordbox db content cues "$CONTENT_ID" --format json
music rekordbox db content set-cue "$CONTENT_ID" 32.5 --kind memory --type cue --write
music rekordbox db content set-cue "$CONTENT_ID" 64 --kind hot --slot A \
  --type loop --end-seconds 72 --write
music rekordbox db content delete-cue "$CONTENT_ID" "$CUE_ID" --write
```

Workbench cue changes use the same instant boundary as other interactive edits: stopped Rekordbox
processes, shared database lock, short transaction, optimistic UI, and conflict-safe rollback. The
standalone `music rekordbox db content set-cue` and `delete-cue` commands retain their checksummed
backup, durable journal, and read-only post-write verification contract. The master database and its
cue mirror are writable; preserve the unknown/native ANLZ bytes, including PCOB/PCO2, unless a
separately verified native rewrite path exists.

## 1. Preflight

Run non-mutating checks:

```sh
music tracks resolve --help
music spots auth status --format json
spots auth status --format json
soundcloud auth status --format json
music ytdlp-ts engines --format json
music rekordbox status --format json
rekordbox analyze doctor --format json
music djlink status --format json
```

Require provider credentials only for the stage that needs them. Resolution can begin from a
timestamped YouTube or SoundCloud description without credentials. Set `PARSE_API_KEY` for
1001Tracklists, Spotify credentials for enrichment, and `SLSK_USERNAME` plus `SLSK_PASSWORD` for
Soulseek acquisition. Require ffmpeg and ffprobe only for media verification or cue extraction.
The CLI loads `MUSIC_ENV_FILE` first, then a nearest ancestor `.env`, then
`~/.config/music-ts/.env`; do not ask the user to export a root-workspace credential again when one
of those files already contains it.

## 2. Resolve the source

Resolve a DJ set without media acquisition:

```sh
music tracks resolve "$SET_URL" --provider auto --cache-mode default --format json > manifest.next.json
```

Parse and validate the returned manifest through `@gakonst/music/tracks` before atomically replacing
durable state. Resolution order: timestamped description, configured 1001Tracklists lookup, then
configured recognition. Report identified, unresolved, overlap-only, and ambiguous counts before
acquisition. Stop and repair implausible ordering or cue boundaries.
The maintained Parse wrapper uses `POST /scraper/{scraper_id}/{endpoint}` with endpoint parameters
in a JSON body and `X-API-Key`; do not reconstruct the obsolete query-string request.

For a Spotify playlist, page through playlist items with one authenticated `SpotifyClient`. Preserve
playlist order, duplicates, unavailable rows, Spotify IDs/URIs/URLs, ISRC, artists, title, mix,
album, and duration. Skip episodes unless requested.

## 3. Enrich identities

Create one `SpotifyOAuth`/`SpotifyClient` backed by `FileSessionStore`, wrap it with the package's
persistent cache, and reuse it. Search exact ISRC first; otherwise score normalized artist, title,
mix/version tokens, and duration. Keep weak or close top-two results ambiguous. Record the query,
candidates, score, Spotify identity, duration, and ISRC.
For an approved `import-set`, select a primary only from candidates with safe title/version and
artist agreement. Prefer the earliest plausible release on or before the set date, retain the
complete candidate list, and persist an auto-selection warning. Leave unsafe collaborator,
version, identity, or duration conflicts unresolved.

## Publish a playlist on Spotify or SoundCloud

Publish without downloading audio. Resolve every input to the target platform first, report any
unmatched or ambiguous tracks, and create a partial playlist only when the user explicitly accepts
the omissions.

For Spotify, use a user OAuth session with `playlist-modify-private` for private playlists or
`playlist-modify-public` for public playlists. Existing sessions created without these scopes must
log in again. Inputs may be track URIs, `open.spotify.com/track/...` URLs, or track IDs; requests are
batched at 100 items while retaining order and duplicates:

```sh
music spots playlist create "$PLAYLIST_NAME" \
  --input-file spotify-tracks.txt \
  --visibility private \
  --format json
```

Spotify Web API “private” means hidden from profiles/search, not access-controlled; a holder of the
link may still open it. Do not promise link secrecy from the API visibility flag.

For SoundCloud, use an Authorization Code user session; Client Credentials cannot modify an
account. Inputs may be track URNs, SoundCloud track URLs, or numeric IDs. URLs are resolved to track
URNs before one playlist-creation request, with at most 500 tracks:

```sh
music soundcloud playlist create "$PLAYLIST_NAME" \
  --input-file soundcloud-tracks.txt \
  --sharing private \
  --format json
```

Input files contain one reference per line; blank lines and lines beginning with `#` are ignored.
Return the provider playlist ID/URN and URL, normalized ordered track references, batch snapshots
where applicable, visibility, and the number of tracks added.

Manage the resulting playlist through the same provider group:

```sh
music spots playlist get "$SPOTIFY_PLAYLIST" --format json
music spots playlist update "$SPOTIFY_PLAYLIST" --name "$NEW_NAME" --input-file spotify-tracks.txt
music spots playlist delete "$SPOTIFY_PLAYLIST" --format json

music soundcloud playlist get "$SOUNDCLOUD_PLAYLIST" --format json
music soundcloud playlist update "$SOUNDCLOUD_PLAYLIST" --title "$NEW_TITLE" --input-file soundcloud-tracks.txt
music soundcloud playlist delete "$SOUNDCLOUD_PLAYLIST" --format json
```

SoundCloud deletion permanently removes an owned playlist. Spotify has no permanent playlist-delete
operation; its delete command removes `spotify:playlist:{id}` from the current user's library and
returns `permanentlyDeleted: false`. When testing Spotify cleanup, clear tracks before removal and
verify `/me/library/contains` returns `false`.

Use bounded concurrency and honor `Retry-After`. Cache stable track/search metadata by account and
market scope. Never cache tokens or authentication failures.

## 4. Acquire individual recordings

Use one shared canonical library root for final recordings. The default is `~/.djtools/tracks`,
overridable with `MUSIC_LIBRARY_ROOT`; final paths are
`<root>/<artist>/<album>/<title> [recording identity].ext`. Scan that root before acquisition and
reuse verified matches. Do not create playlist-specific audio copies: playlist identity, order, and
membership belong in Rekordbox.

For the supported end-to-end set workflow, use one command after explicit database-write approval:

```sh
music tracks import-set "$SET_URL" --manifest "$MANIFEST_PATH" --write --format json
```

This resolves, enriches, acquires into the canonical library, analyzes, then creates or updates the
ordered Rekordbox playlist. Call it once; do not ask for separate resolution, download, analysis,
or add-to-playlist steps after it succeeds. Clean-room analysis is automatic; do not pause to ask
which analyzer to use. The workflow defaults to `--analysis-rhythm-mode auto`. Pass
`--analysis-engine reference` only for an explicit local parity request.

When the user also approves cue recovery from an existing local set recording, include the approval
in the same invocation:

```sh
music tracks import-set "$SET_URL" \
  --manifest "$MANIFEST_PATH" \
  --allow-set-clips \
  --source-set-path "$LOCAL_SET" \
  --write --format json
```

The workflow attempts individual recordings first. It checkpoints every failure, then performs at
most one internal recovery pass for failed identified entries with complete cues. The same command
continues into analysis and one Rekordbox commit after every recording verifies. Report
`acquisitionPasses`, `sourceSetFallbacks`, and `spotifyCanonicalSelections` from its output.

Create one `SoulseekClient`, connect once, and search each unresolved recording with bounded
concurrency. Prefer plausible lossless results, but inspect metadata and duration instead of trusting
the extension. Record the selected peer and remote file before download, then the absolute path and
SHA-256 after verification. Append the canonical Soulseek or HTTP acquisition source to the output
recording's embedded comment and carry the same source into the Rekordbox comment; keep Spotify as a
separate identity reference rather than describing it as the audio source.

When Soulseek has no acceptable result, use bounded native `searchYoutube`, score its stable
identity/duration fields, inspect the selected exact URL with `ExtractorRegistry`, and download its
direct M4A with `downloadMedia`. `tracks import-set` always registers that native path after
Soulseek; it constructs and appends `ReferenceClient` only when the user explicitly passes
`--reference-ytdlp`. Even then, reference download may follow only a centralized typed capability
gap; reference search stays deferred until that gap, and post-transfer or untyped failures stop.
Inspect at most a small candidate set, reject sets,
compilations, covers, previews, and the wrong mix, then download only the selected canonical URL.
Preserve compatible FLAC, MP3, and M4A. Convert WAV/AIFF to FLAC losslessly; transcode unsupported
lossy formats only when Rekordbox requires it, and record the degradation. Use `auto` or
`ReferenceClient` only when the user accepts the explicitly reported external compatibility path.

Cap independent downloads at three by default (explicit cap eight). Keep native YouTube transfers
at three by default (cap sixteen) and explicit reference transfers at one (cap four). These are
separate network pools, not one blanket concurrency value. Resume verified files and completed
manifest states; do not redownload them.

## 5. Recover unavailable tracks

Only after explicit approval, use one existing verified local set source. `import-set` never
downloads the remote set. For each otherwise unavailable entry with complete cues, extract exactly
`[startSeconds, endSeconds)` using ffmpeg stream copy where possible. Mark the title/comment with
`[Set Extract]`, source set, cue range, checksum, codec, and a warning about transitions and lossy
ancestry. Preserve the exact individual-acquisition failure as a manifest warning. Keep the local
source untouched.

## 6. Analyze for Rekordbox

Use the releasable clean-room Rust analyzer after audio has been acquired. It is the default on every
supported platform, requires no Rekordbox application/JUCE/runtime bytes, and never opens or mutates
`master.db`:

```sh
music rekordbox analyze doctor --engine clean --format json
music rekordbox analyze track "$AUDIO_PATH" \
  --engine clean \
  --rhythm-mode auto \
  --output-directory "$ANALYSIS_DIR" \
  --threads 8 \
  --format json
music rekordbox analyze tracks \
  --audio-path "$AUDIO_PATH_1" \
  --audio-path "$AUDIO_PATH_2" \
  --engine clean \
  --rhythm-mode auto \
  --format json
music rekordbox analyze beat-grid-diff \
  "$REFERENCE_ANALYSIS_DIR" \
  "$CANDIDATE_ANALYSIS_DIR" \
  --format json
music rekordbox analyze waveform-diff \
  "$REFERENCE_ANALYSIS_DIR" \
  "$CANDIDATE_ANALYSIS_DIR" \
  --format json
```

Require a successful clean doctor check before analysis. Discover `rekordbox-analyzer` through
`REKORDBOX_CLEAN_ANALYZER_BINARY`, `PATH`, or the repository build. Treat the legacy
`REKORDBOX_ANALYZER_BINARY` override as reference-only so it cannot contaminate the clean default.
The output directory must contain parseable `ANLZ0000.DAT`, `ANLZ0000.EXT`, `ANLZ0000.2EX`,
`analysis.json`, and `clean-room-analyzer.log`. Keep these artifacts with the recording or manifest.
Treat analyzer BPM/key as measurements from the acquired audio; never substitute Spotify metadata.
Choose `normal` for a static grid on steady-tempo tracks, `dynamic` for live, rubato, or materially
changing tempo, and `auto` when the request does not specify. Auto rejects isolated tempo outliers
and selects Dynamic only when the central 90% of recovered local tempi span at least 0.75%; otherwise
it selects Normal. The selected and requested modes are persisted in `analysis.json` and the Tracks
manifest, and a cache from another mode must be recomputed. Rekordbox 6.8.2 reference comparisons
must use the same explicit mode: Normal and Dynamic are different algorithms, not interchangeable
quality levels.

The clean engine emits protocol-valid Rekordbox shapes and deterministic waveform/beat/key baselines.
Do not claim whole-analyzer proprietary byte identity: the recovered Dynamic beat path can match
reference timing while waveform, phrase, and finishing stages still have independent parity work.
For parity work, use `analyze beat-grid-diff` rather than raw file hashes. Require matching beat
counts and labels for steady-tempo material, inspect median/p95/max timing error and drift, and retain
the reported missing/extra beats, downbeat error, tempo changes, and F1 collars for held-out tracks.
Use `analyze waveform-diff` for waveform parity. Compare decoded component correlations, means, MAE,
signed bias, exact fractions, and entry-count deltas; do not compare packed waveform bytes as scalar
samples or silently discard non-overlapping tails.

Use `--engine reference` only when the user explicitly asks for local parity investigation. That
mode requires macOS, Rosetta on Apple Silicon, a separately supplied
`rekordbox-analyzer-reference`, and a compatible user-installed Rekordbox application. Neither the
reference helper nor Rekordbox/JUCE/runtime bytes may enter a release artifact. Do not silently fall
back from clean to reference. Always choose explicit `normal` or `dynamic` mode for the reference
engine and use the same mode for the clean candidate; reference `auto` is unsupported because Auto
is the clean engine's conservative selector rather than a Rekordbox 6.8.2 analysis mode.

For multiple independent tracks, prefer `analyze tracks`; it uses bounded isolated worker processes
and preserves input order. `--threads` is one total native scheduling budget divided
deterministically across active processes, not a per-process multiplier; `--concurrency 4
--threads 12` produces worker budgets `[3, 3, 3, 3]`. Process concurrency is capped to host
parallelism. On Apple Silicon, the default scheduling budget keeps two Rayon slots per core so
independent Auto, waveform, and SRC branches remain runnable without adding extra analyzer
processes. On the 12-core profiling host, 12 processes/24 slots analyzed the 100-track corpus in
about 15.9 seconds; 24 processes were slower. Small default batches are capped at eight threads per
track. Lower either limit when analysis competes with live DJ software. Both limits accept explicit
values through 64. Parallelize analysis only. Keep Rekordbox database installation
stopped-Rekordbox, backed up, locked, and serialized through the workflow below.

For a durable Tracks manifest whose media is already acquired, resume only the analysis stage. This
does not load provider credentials or download anything. It checkpoints per-item cache results and a
timestamped run ledger in the manifest:

```sh
music tracks analyze-existing "$MANIFEST" \
  --engine clean \
  --rhythm-mode auto \
  --progress always \
  --format json
```

## 7. Import into Rekordbox

Use `@gakonst/music/rekordbox` against the normal encrypted database:

```sh
music tracks import-existing "$MANIFEST" \
  --db-path "$REKORDBOX_DB" \
  --folder-name "DJ Sets I Like" \
  --playlist-name "$PLAYLIST_NAME" \
  --backup-root "$BACKUP_ROOT" \
  --write --format json
```

`import-existing` loads only checkpointed media and analyzer artifacts, takes one verified backup when
state must change, commits once, and is a no-backup `changed: false` verification on a warm rerun.
Its result includes UTC start/finish timestamps and stage duration. Keep the workbench open; the
shared lock serializes the brief write and the database watcher refreshes the UI.

1. Confirm Rekordbox and `rekordboxAgent` are stopped.
2. Hold the manifest lock and a database-path lock.
3. Back up `master.db`, WAL/SHM/journal files when present, and `masterPlaylists6.xml`; checksum the
   backup.
4. Find or create the target folder and playlist. Dedupe tracks only by exact permanent path,
   albums by name plus album artist, and memberships by playlist/content IDs.
5. Write enriched artist, title, album, label, ISRC, release, source, and quality-note metadata in
   one transaction.
6. For an analyzed track already present in `djmdContent`, resolve its content ID by exact permanent
   audio path, then install the generated files and update its analysis fields:

   ```sh
   rekordbox db content install-analysis "$CONTENT_ID" "$ANALYSIS_DIR" --write --format json
   ```

   This copies DAT/EXT/2EX into `share/PIONEER/USBANLZ/<UUID>/`, rewrites each PPTH tag to the
   content row's permanent audio path, and sets `AnalysisDataPath`, `Analysed`, `AnalysisUpdated`,
   and `TrackInfoUpdated`. Do not use `--replace` unless replacing existing analysis was explicitly
   requested and backed up.

7. Reopen read-only. Require `PRAGMA quick_check = ok`, no foreign-key failures, parseable installed
   DAT/EXT/2EX files, exact ordered
   membership paths, and a well-formed playlist sidecar before marking the manifest imported.

Retain an M3U8 only as a recovery artifact, not as the primary Rekordbox integration.

## 8. Serve and load connected CDJs

For everything already imported, serve the complete Rekordbox library directly:

```sh
music djlink rekordbox --format json
music djlink rekordbox "$TRACK" --player 3 --format json
```

This validates, starts/resumes, verifies discovery, and exposes all folders, playlists, artists,
albums, and tracks; a selector also cues it. Use `run "$MANIFEST" <track>` only for an ad-hoc
manifest before import. Use stage commands only for diagnosis:

```sh
music djlink doctor "$MANIFEST" --format json
music djlink start "$MANIFEST" --format json
music djlink devices --wait-ms 5000 --format json
music djlink probe 169.254.7.4 --format json
music djlink load 4 --player 3 --format json
music djlink search "Science Fiction" --mode track --format json
music djlink monitor --player 3 --format json
music djlink stop --format json
```

`doctor` and `start` require complete local ANLZ data by default. One detached daemon serves one
manifest; starting the same manifest resumes it, while switching manifests requires `stop`.
An empty device list after the wait means the CDJ/network path is not visible. Report the selected
bind address; if a prior deck IP is known, run one ARP `probe` before blaming the protocol. Do not
attempt a load until the player is discovered. `load` addresses a track by manifest order, native
ID, Spotify ID, or title and cues it on the selected player. It does not press PLAY and exposes no
unsafe/private packet-replay surface. `search` is read-only and bounded; use it before packet
changes. Then trace TCP/1051 for CDJ-3000 incremental `0x1500` or legacy `SEARCH(0x1300)`;
per-keystroke reconnects identify server rejection, while no request identifies UI/source
activation.

For protocol implementation work only, iterate on the provenance-tracked Rust source in
`packages/djlink/native`:

```sh
pnpm djlink:lab serve --help
pnpm djlink:lab audit-pcap --pcap /tmp/source.pcap --reference /tmp/native.pcap --require-core
pnpm djlink:lab audit-pcap --pcap /tmp/live.pcap --require-remote-db-cursors
```

Start `serve` with `--wire-pcap`: raw-BPF injections are not visible to a separate macOS
`tcpdump`. Capture the wired interface separately for deck replies. Treat the real Rekordbox pcap
from git object `123e84e` (SHA-256 `a2238f…35ad`) and hashed golden fixtures as authoritative; do
not trust a same-named later capture or a derived analyzer report. Require the RemoteDB cursor gate
after repeated physical TRACK SEARCH: every same-transaction MENU_HEADER must echo the requested
nonzero RENDER offset. Keep packet builders typed and byte-exact. Source
`0x06` and `0x47` are response-gated by deck `0x05` and `0x46`, not periodic broadcasts. If the
interface counters and ARP probe show zero ingress, repair the Ethernet/switch path before changing
parsers or control packets.

For a request to play Spotify on a deck, choose the legitimate path explicitly:

- Licensed streaming: use Spotify Premium through rekordbox Performance mode with internet access.
  Spotify streaming tracks cannot be LINK EXPORTed, exported to USB, or served by this CLI.
- DJ Link: acquire an independently available local recording through the approved workflow,
  analyze it, then serve that verified file. Spotify metadata may help identity matching but must
  not be described as the audio source.

## 9. Handoff and resume

Return source/title, provider, resolution counts, Spotify match counts, acquisition counts by
backend, output directory, manifest path, Rekordbox identifiers, backup path, cache statistics,
stage timings, automation pass/selection counters, warnings, and unresolved decisions. When DJ Link
was requested, also return daemon status, bind address, discovered players, selected track/player,
and whether the physical PLAY handoff remains. Never claim completion while identified entries
remain pending unless the user accepted a partial playlist.

Preserve these manifest states on resume:

- identity: `identified` or `unidentified`
- Spotify: `pending`, `matched`, `ambiguous`, `unmatched`, `failed`, or `skipped`
- acquisition: `pending`, `searching`, `selected`, `downloaded`, `unmatched`, `failed`, or `skipped`
- Rekordbox: `pending`, `exported`, `imported`, `failed`, or `skipped`

Do not mark audio downloaded without an absolute verified path. Do not mark Rekordbox imported
without database, folder, playlist, and backup identifiers. Preserve prior warnings, errors, user
edits, and completed stages.

## Agent transports

Use `music skills add` for the lightest local integration. Use `music mcp add` or `music --mcp` when
a normal MCP client needs the same typed command map. Keep hosted, CodeMode, and plugin adapters
thin: call the exported CLI command map and subpath libraries rather than reimplementing pipeline
logic.
