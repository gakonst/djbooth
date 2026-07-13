---
name: music
description: Resolve YouTube, SoundCloud, 1001Tracklists, local DJ sets, or Spotify playlists into durable track manifests; enrich identities through Spotify; create ordered playlists on Spotify or SoundCloud; acquire individual recordings with Soulseek or selected ytdlp sources; recover unavailable tracks from cue-bounded set clips; and import verified playlists into the normal Rekordbox database. Use for DJ-set resolution, music metadata, platform playlist publishing, individual-track downloads, Rekordbox library maintenance, or end-to-end music-ts workflows.
---

# Music

Build an auditable `source -> identities -> platform playlist and/or recordings -> Rekordbox playlist` pipeline with
`@gakonst/music`. Prefer its TypeScript subpath APIs for automation; use the `music` CLI for
interactive work, diagnostics, Skills, and MCP registration.

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
```

Do not shell between package CLIs from TypeScript. Construct the exported clients once and pass
them into the orchestration pipeline.

## ytdlp engine contract

Prefer the TypeScript-native engine. The Incur CLI's engine names are a behavioral contract:

- `native` runs only the TypeScript extractor, selector, downloader, and post-processing code. It
  never invokes Python or an external `yt-dlp` executable and fails closed for unported behavior.
- `auto` tries native first and may explicitly fall back to the external reference executable. Do
  not describe an `auto` result as native; inspect and persist the returned `engine`.
- `reference` deliberately invokes the external `yt-dlp` compatibility executable.

When the user requires the TypeScript implementation, force `--engine native` or construct
`ExtractorRegistry` plus `downloadMedia`; never construct `ReferenceClient`. Record the requested
engine, actual engine, package version, start/finish timestamps, and any typed limitation in the
manifest. Do not silently install, upgrade, or switch to the reference executable. Current native
YouTube support fails with `YOUTUBE_SIGNATURE_REQUIRED` when a player-signature transform is
needed; mark that recording unavailable unless the user separately accepts reference fallback.
Public progressive SoundCloud tracks are supported natively, while some HLS, sets, profiles, and
private/account flows may still require reference behavior.

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
- Treat Spotify and SoundCloud playlist creation as external account writes. Require an explicit
  request, validate every reference before creation, default to private, and preserve order and
  duplicates. Never retry a playlist-creation POST automatically.
- Preserve every credible recording when an ambiguity remains. Collapse only confirmed duplicates
  sharing release identity, ISRC, and plausible duration.
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
unless the user explicitly launches `music library serve --write`. Before each mutation, require
Rekordbox and `rekordboxAgent` to be stopped, hold the shared database lock, create a checksummed
backup, commit once, pass `quick_check` plus `foreign_key_check`, and semantically verify the exact
playlist/membership state and `masterPlaylists6.xml`. A durable stage journal beside the backup must
identify database/sidecar partial commits and the recovery path. Never enable network binding,
upload the private library, expose `.env` values, follow symlink-backed audio, or test writes against
the live library; use a copied fixture.

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

Treat cue changes like playlist changes: stopped Rekordbox processes, the shared database lock,
checksummed backup and durable journal, then semantic and SQLite verification. The master database
and its cue mirror are writable; preserve the unknown/native ANLZ bytes, including PCOB/PCO2,
unless a separately verified native rewrite path exists.

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
```

Require provider credentials only for the stage that needs them. Resolution can begin from a
timestamped YouTube or SoundCloud description without credentials. Set `PARSE_API_KEY` for
1001Tracklists, Spotify credentials for enrichment, and `SLSK_USERNAME` plus `SLSK_PASSWORD` for
Soulseek acquisition. Require ffmpeg and ffprobe only for media verification or cue extraction.

## 2. Resolve the source

Resolve a DJ set without media acquisition:

```sh
music tracks resolve "$SET_URL" --provider auto --cache-mode default --format json > manifest.next.json
```

Parse and validate the returned manifest through `@gakonst/music/tracks` before atomically replacing
durable state. Resolution order: timestamped description, configured 1001Tracklists lookup, then
configured recognition. Report identified, unresolved, overlap-only, and ambiguous counts before
acquisition. Stop and repair implausible ordering or cue boundaries.

For a Spotify playlist, page through playlist items with one authenticated `SpotifyClient`. Preserve
playlist order, duplicates, unavailable rows, Spotify IDs/URIs/URLs, ISRC, artists, title, mix,
album, and duration. Skip episodes unless requested.

## 3. Enrich identities

Create one `SpotifyOAuth`/`SpotifyClient` backed by `FileSessionStore`, wrap it with the package's
persistent cache, and reuse it. Search exact ISRC first; otherwise score normalized artist, title,
mix/version tokens, and duration. Keep weak or close top-two results ambiguous. Record the query,
candidates, score, Spotify identity, duration, and ISRC.

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

Create one `SoulseekClient`, connect once, and search each unresolved recording with bounded
concurrency. Prefer plausible lossless results, but inspect metadata and duration instead of trusting
the extension. Record the selected peer and remote file before download, then the absolute path and
SHA-256 after verification.

When Soulseek has no acceptable result, inspect the selected exact URL with the native ytdlp
extractor and download it with `downloadMedia`. In CLI workflows, force `--engine native` when
external fallback is not accepted. Inspect at most a small candidate set, reject sets,
compilations, covers, previews, and the wrong mix, then download only the selected canonical URL.
Preserve compatible FLAC, MP3, and M4A. Convert WAV/AIFF to FLAC losslessly; transcode unsupported
lossy formats only when Rekordbox requires it, and record the degradation. Use `auto` or
`ReferenceClient` only when the user accepts the explicitly reported external compatibility path.

Cap independent downloads at three by default. Resume verified files and completed manifest states;
do not redownload them.

## 5. Recover unavailable tracks

Only after explicit approval, download one canonical set source into a temporary cache. For each
otherwise unavailable entry with complete cues, extract exactly `[startSeconds, endSeconds)` using
ffmpeg stream copy where possible. Mark the title/comment with `[Set Extract]`, the source set, cue
range, checksum, codec, and a warning about transitions and lossy ancestry. Keep the full cache until
every requested clip verifies, then ask before deleting it.

## 6. Analyze for Rekordbox

On macOS, use the native Rekordbox rehost analyzer after audio has been acquired. Analysis reads the
installed Rekordbox application but does not open or mutate `master.db`:

```sh
rekordbox analyze doctor --format json
rekordbox analyze track "$AUDIO_PATH" --output-directory "$ANALYSIS_DIR" --format json
rekordbox analyze tracks \
  --audio-path "$AUDIO_PATH_1" \
  --audio-path "$AUDIO_PATH_2" \
  --concurrency 4 \
  --format json
```

Require macOS, Rosetta on Apple Silicon, and successful doctor checks before analysis. Public npm
packages do not redistribute the proprietary helper or Rekordbox runtime: set
`REKORDBOX_ANALYZER_BINARY`, install `rekordbox-analyzer` on `PATH`, or build the repository-local
helper, and use `--rekordbox-app` to select a compatible user-installed application. The output
directory must contain parseable `ANLZ0000.DAT`, `ANLZ0000.EXT`,
`ANLZ0000.2EX`, `analysis.json`, and `rehost-native.log`. Keep these artifacts with the recording or
manifest. Do not treat Spotify BPM/key or a local DSP approximation as Rekordbox analysis.
For multiple independent tracks, prefer `analyze tracks`; it uses bounded isolated x86_64 worker
processes and preserves input order. Default to at most four workers unless measurement on the target
machine supports another limit. Parallelize analysis only. Keep Rekordbox database installation
stopped-Rekordbox, backed up, locked, and serialized through the workflow below.

## 7. Import into Rekordbox

Use `@gakonst/music/rekordbox` against the normal encrypted database:

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

## 8. Handoff and resume

Return source/title, provider, resolution counts, Spotify match counts, acquisition counts by
backend, output directory, manifest path, Rekordbox identifiers, backup path, cache statistics,
stage timings, warnings, and unresolved decisions. Never claim completion while identified entries
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
