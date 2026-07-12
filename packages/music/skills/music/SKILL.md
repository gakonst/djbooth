---
name: music
description: Resolve YouTube, SoundCloud, 1001Tracklists, local DJ sets, or Spotify playlists into durable track manifests; enrich identities through Spotify; acquire individual recordings with Soulseek or selected ytdlp sources; recover unavailable tracks from cue-bounded set clips; and import verified playlists into the normal Rekordbox database. Use for DJ-set resolution, music metadata, individual-track downloads, Rekordbox library maintenance, or end-to-end music-ts workflows.
---

# Music

Build an auditable `source -> identities -> recordings -> Rekordbox playlist` pipeline with
`@gakonst/music`. Prefer its TypeScript subpath APIs for automation; use the `music` CLI for
interactive work, diagnostics, Skills, and MCP registration.

## Install and discover

Install the umbrella package and approve the Rekordbox SQLite native build:

```sh
pnpm add @gakonst/music --allow-build=better-sqlite3-multiple-ciphers
music skills add
music --help
```

Use project-local skill installation with `music skills add --no-global`. This command installs this
single aggregate skill for Codex, Claude Code, and other supported agents.

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

## Safety invariants

- Resolve metadata without downloading the source set.
- Prefer an individual release. Download a source set only with explicit approval and complete cue
  boundaries; keep only bounded clips and annotate source URL, time range, checksum, and lossy or
  transition-bearing quality.
- Never pass a raw `ytsearch...` result to a downloader. Inspect a bounded candidate list, select a
  canonical single-track URL, validate its identity and duration, then download that URL with
  playlists disabled.
- Keep Spotify metadata-only. Prefer Soulseek for audio, then a reviewed YouTube or SoundCloud
  single-track fallback.
- Preserve every credible recording when an ambiguity remains. Collapse only confirmed duplicates
  sharing release identity, ISRC, and plausible duration.
- Persist the manifest atomically after each match, selection, download, extraction, and export.
- Write the normal Rekordbox database only with explicit approval, Rekordbox processes stopped, an
  exclusive lock, complete backups, and post-write integrity checks. Do not substitute collection
  XML.

## 1. Preflight

Run non-mutating checks:

```sh
music tracks resolve --help
music spots session --format json
music ytdlp engines --format json
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

Use bounded concurrency and honor `Retry-After`. Cache stable track/search metadata by account and
market scope. Never cache tokens or authentication failures.

## 4. Acquire individual recordings

Create one `SoulseekClient`, connect once, and search each unresolved recording with bounded
concurrency. Prefer plausible lossless results, but inspect metadata and duration instead of trusting
the extension. Record the selected peer and remote file before download, then the absolute path and
SHA-256 after verification.

When Soulseek has no acceptable result, use one `ReferenceClient` from
`@gakonst/music/ytdlp`. Inspect at most a small candidate set, reject sets, compilations, covers,
previews, and the wrong mix, then download only the selected canonical URL. Preserve compatible
FLAC, MP3, and M4A. Convert WAV/AIFF to FLAC losslessly; transcode unsupported lossy formats only
when Rekordbox requires it, and record the degradation.

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
```

Require macOS, Rosetta on Apple Silicon, and successful doctor checks before analysis. The package
includes the pinned minimal Rekordbox 6.8.2.0018 runtime; use `--rekordbox-app` only to override it
with another compatible app. The output directory must contain parseable `ANLZ0000.DAT`, `ANLZ0000.EXT`,
`ANLZ0000.2EX`, `analysis.json`, and `rehost-native.log`. Keep these artifacts with the recording or
manifest. Do not treat Spotify BPM/key or a local DSP approximation as Rekordbox analysis.

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
a normal MCP client needs the same typed command map. For an embedded normal server, import
`createMusicMcpServer` from `@gakonst/music/mcp`. For CodeMode, import
`createMusicCodeMcpServer` and inject a sandboxed executor, or run `music --codemode-mcp` for the
deny-by-default local Secure Exec adapter. Never evaluate generated code directly in the Node.js
host. Keep hosted and plugin adapters thin: call these factories and subpath libraries rather than
reimplementing pipeline logic.
