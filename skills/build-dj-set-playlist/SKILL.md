---
name: build-dj-set-playlist
description: Resolve a YouTube, SoundCloud, 1001Tracklists, or local DJ set into a resumable track manifest; enrich identities with spots; acquire releases with slsk-ts or ytdlp-ts; cue-extract unavailable tracks from a cached set when explicitly approved; and import an ordered playlist into the normal Rekordbox database with rekordbox-ts. Use when asked to turn a set, mix, tracklist URL, Spotify playlist, or existing manifest into local DJ-library files or a Rekordbox playlist.
---

# Build DJ Set Playlist

Build an auditable `set -> identities -> audio files -> playlist` pipeline. Treat the `tracks-ts` manifest as durable state. Resolution is metadata-only. Acquisition may cache a source set once when the user explicitly permits cue-bounded recovery of IDs, unreleased edits, or otherwise unavailable tracks.

## Safety invariants

- Never download the set during resolution or use it when a suitable individual recording exists.
- A source-set cache requires explicit approval and complete cues. Extract only bounded ranges, mark them as lossy/transition-bearing, retain source URL/range/checksum, and keep the cache until every clip verifies.
- Never pass `ytsearch...` directly to `ytdlp-ts download`. Inspect candidates, choose one canonical single-track URL, inspect it, then download that URL.
- Skip intro and overlap-only entries unless the user chooses them. By default, preserve and acquire every distinct candidate for a true recording ambiguity; collapse duplicate releases sharing an ISRC and duration.
- Use subprocess argument arrays, not shell interpolation, when implementing adapters.
- Persist the manifest after every match, download, or export. Preserve user edits and completed states on resume.
- Keep Spotify metadata-only. Prefer Soulseek for acquisition; use YouTube or SoundCloud only as a selected single-track fallback.
- Direct database writes require explicit user approval, Rekordbox and its agent closed, shared manifest serialization, a database-scoped import lock, exclusive backups of `master.db`, WAL/SHM files when present, and `masterPlaylists6.xml`, followed by integrity verification.

## Component ownership

| Component      | Owns                                                            | Must not own                                |
| -------------- | --------------------------------------------------------------- | ------------------------------------------- |
| `tracks-ts`    | Set metadata, resolution, cues, manifest, pipeline coordination | Unannotated or unbounded source extraction  |
| `spots`        | Spotify playlist/track metadata and identity enrichment         | Audio acquisition                           |
| `slsk-ts`      | Selected individual Soulseek file acquisition                   | Tracklist resolution                        |
| `ytdlp-ts`     | Metadata, bounded candidate search, selected fallback/cache     | Automatic unreviewed search-result download |
| `rekordbox-ts` | Approved, backed-up normal encrypted database import            | Identity guessing                           |

## 1. Preflight

Import the sibling packages in one Node.js process for pipeline work. Their CLIs remain useful only for manual preflight and debugging. Run:

```sh
tracks doctor --format json
ytdlp-ts --version
spots --version
slsk --version
rekordbox --version
```

Build a missing sibling with `pnpm install && pnpm build`. Require Soulseek credentials only when acquisition begins. Require Spotify auth only when enrichment begins.

## 2. Resolve the input

### DJ set

Create and validate a new manifest before replacing durable state:

```sh
NEXT_MANIFEST="${MANIFEST}.next"
tracks resolve "$SET_URL" --format json --progress never > "$NEXT_MANIFEST"
tracks manifest validate "$NEXT_MANIFEST" --format json
mv -f -- "$NEXT_MANIFEST" "$MANIFEST"
```

Resolution order: timestamped media description, configured 1001Tracklists lookup, then configured remote AudD. ACRCloud/AudD sample mode accepts local files only. Use `--provider description` for a credential-free metadata-only run. Use `tracks 1001 get` for an exact 1001Tracklists page.

Inspect the summary before acquisition. Report counts for identified, unresolved, and overlap-only rows. If track ordering or timestamps look implausible, stop and repair the manifest.

### User Spotify playlist

Do not call `tracks resolve`. List the user's playlists if no playlist ID was supplied, then fetch playlist metadata and every page of items with `spots`:

```sh
spots api get-a-list-of-current-users-playlists --limit 50 --offset 0 --format json
spots api get-playlist "$PLAYLIST_ID" --market US --format json
spots api get-playlists-items "$PLAYLIST_ID" --market US --limit 50 --offset 0 --format json
```

Increment `--offset` until the response has no next page. Build the acquisition plan in playlist order from each track's artists, name, album, duration, Spotify ID/URI/URL, and `external_ids.isrc`. Preserve duplicates and unavailable rows explicitly; skip episodes unless requested. Mark valid Spotify tracks as already metadata-matched, then continue at individual acquisition. The strict `dj-set-pipeline` schema and `tracks manifest validate` apply only to manifests produced from DJ sets.

## 3. Enrich identities

Create one `SpotifyOAuth`/`SpotifyClient` backed by `FileSessionStore`, wrap it in `CachedSpotifyClient`, and reuse it for every entry. Supply an opaque, non-secret `cacheScope` for the authenticated account plus market (for example, `cacheDigest({ account: spotifyUserId, market })`); persistence is deliberately disabled without one. Search remains one logical request per identity; an unexpired cache hit performs no network request. Spotify removed `GET /tracks` (Get Several Tracks) in February 2026; refresh known IDs with `GET /tracks/{id}` using bounded concurrency and the client's `Retry-After` handling. Equivalent manual diagnostics with `spots` are:

```sh
spots api search --q "isrc:$ISRC" --type track --market US --limit 10 --format json
spots api search --q "track:\"$TITLE\" artist:\"$ARTIST\"" --type track --market US --limit 10 --format json
```

Use ISRC exact match first. Otherwise score normalized artist/title/mix plus duration. A weak match or close top-two margin remains `ambiguous`; do not choose silently. Record the query, candidates, score, Spotify ID/URI/URL, duration, and ISRC.

## 4. Acquire individual tracks

Create one `SoulseekClient` and search Soulseek first. Equivalent manual diagnostics are:

```sh
slsk search "$ARTIST - $TITLE $MIX" --timeout 8 --max-results 100 --format json
slsk download "$USERNAME" "$REMOTE_FILE" "$DESTINATION" --resume --timeout 120 --format json
```

Prefer lossless files with plausible duration and metadata. Do not infer quality from extension alone. Record the selected peer/file before download and the absolute output path plus SHA-256 after download.

Preserve compatible Soulseek FLAC, MP3, and M4A containers. Convert WAV/AIFF to FLAC losslessly; transcode unsupported lossy containers to AAC only when Rekordbox compatibility requires it, and record that degradation.

If Soulseek is unavailable or has no acceptable result, use one `ReferenceClient` from `@gakonst/ytdlp-ts` to discover a bounded YouTube candidate set without media download. Equivalent manual diagnostics are:

```sh
ytdlp-ts inspect "ytsearch5:$ARTIST - $TITLE $MIX" --engine reference --flat-playlist --format json
```

Reject sets, compilations, covers, previews, and wrong mix/version tokens. Fully inspect the chosen canonical video URL with `--no-playlist`, validate its duration, then download that URL only:

```sh
ytdlp-ts download "$TRACK_URL" --engine reference --no-playlist \
  --media-format 'bestaudio/best' --paths "$OUTPUT_DIR" \
  --output '%(title)s [%(id)s].%(ext)s' --extract-audio \
  --audio-format m4a --embed-metadata --format json
```

Cap independent recording downloads at three by default. Keep variants and candidate fallback for one cue serial. Resume pending entries; never redownload an existing verified file. Manifest checkpoints must pass through one serialized commit coordinator.

## 5. Recover unavailable tracks from a set cache

Only with explicit approval and complete cue boundaries, download one canonical set source through the `ytdlp-ts` library. Extract each missing track's `[startSeconds, endSeconds)` range with ffmpeg stream copy when the source codec/container permits. Tag it with `[Set Extract]`, source URL/title, range, checksum, and a warning that the lossy recording may contain transitions. Unknown slots need distinct timestamped titles. Verify every output before optionally removing the cache.

## 6. Import into the normal Rekordbox database

Use the `rekordbox-ts` library, not collection XML. Expand primary and alternative recordings in cue order. Before opening the encrypted database writable:

1. Confirm both Rekordbox and `rekordboxAgent` are stopped.
2. Hold the shared manifest lock and a database-path lock. Require a readable/writable `masterPlaylists6.xml`, then create an exclusive, checksummed backup directory containing it plus `master.db` and `master.db-wal`/`master.db-shm`/`master.db-journal` when present.
3. Open `MasterDatabase` with writes enabled and the normal SQLCipher key path.
4. Find or create the target playlist under the requested folder. Dedupe tracks only by exact permanent `FolderPath`, albums by name plus album artist, and memberships by playlist/content IDs.
5. Add enriched artist/title/album/label/ISRC/release/comment metadata and commit once.
6. Reopen read-only; require `PRAGMA quick_check = ok`, zero `foreign_key_check` rows, exact ordered membership paths, and well-formed sidecar XML with exactly one playlist node under the expected folder/type before marking the manifest imported. Persist the DB path, folder ID/name, playlist ID/name, and backup directory under `artifacts.rekordbox`.

An M3U8 may still be emitted as a recovery artifact:

```sh
NEXT_M3U8="${M3U8}.next"
jq -e '([.entries[] | select(.acquisition.status == "downloaded")] | length) > 0' "$MANIFEST" >/dev/null
{ printf '#EXTM3U\n'; jq -r '.entries[] | select(.acquisition.status == "downloaded") | .acquisition as $a | $a.download.mediaPath, ($a.alternatives[]?.mediaPath)' "$MANIFEST"; } > "$NEXT_M3U8"
mv -f -- "$NEXT_M3U8" "$M3U8"
```

## 7. Handoff

Return: source/title, provider, resolved/unresolved counts, Spotify match counts, acquired/skipped/failed counts by backend, output directory, manifest path, playlist artifact, cache hit/miss counters, stage timing, and any manual decisions. Never claim completion while identified entries remain pending unless the user chose a partial playlist.

Use the default persistent metadata cache for exact 1001 pages, Spotify search/track responses,
sanitized YouTube metadata, and stat-keyed audio verification. Use `--refresh-cache` after a known
provider edit and `--no-cache` only for diagnostics. Never cache credentials, cookies, signed format
URLs, Soulseek peer results, authentication failures, or quota failures.

## Manifest and resume contract

Use only schema states accepted by `tracks manifest validate` and the exported `parseManifest` library function:

- `identity.status`: `identified` or `unidentified`.
- `spotify.status`: `pending`, `matched`, `ambiguous`, `unmatched`, `failed`, or `skipped`.
- `acquisition.status`: `pending`, `searching`, `selected`, `downloaded`, `unmatched`, `failed`, or `skipped`.
- `rekordbox.status`: `pending`, `exported`, `imported`, `failed`, or `skipped`.

Do not mark `downloaded` without an absolute `mediaPath` included in `files`. Do not mark `exported` without its target and artifact or Rekordbox identifier. Append structured errors; preserve earlier warnings and user edits.

Persist atomically with an expected-content/hash check: write and flush a sibling temporary manifest, verify the durable source did not change, run `tracks manifest validate "$NEXT_MANIFEST" --format json`, then rename it over the old file. On resume, preserve completed stages and verified files; retry only pending or explicitly selected failed stages; recompute SHA-256 when a file changes; serialize Rekordbox operations.

Required environment by stage: `YTDLP_TS_PATH`/provider credentials for resolution; Spotify login or token for `spots`; `SLSK_USERNAME` and `SLSK_PASSWORD` for Soulseek. Direct database access uses rekordbox-ts's validated bundled key unless `REKORDBOX_DB_KEY` explicitly overrides it.
