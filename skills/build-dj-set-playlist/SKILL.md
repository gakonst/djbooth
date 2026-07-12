---
name: build-dj-set-playlist
description: Resolve a YouTube, SoundCloud, 1001Tracklists, or local DJ set into a resumable track manifest; enrich identities with spots; acquire only identified individual tracks with slsk-ts or ytdlp-ts; and prepare an M3U8 or Rekordbox XML playlist with rekordbox-ts. Use when asked to turn a set, mix, tracklist URL, Spotify playlist, or existing manifest into local DJ-library files or a Rekordbox playlist without downloading the source set.
---

# Build DJ Set Playlist

Build an auditable `set -> identities -> individual files -> playlist` pipeline. Treat the `tracks-ts` manifest as durable state. Never download a remote source set; inspect only its metadata or submit its URL to a configured remote recognition provider.

## Safety invariants

- Never run `ytdlp-ts download` against the set URL.
- Never pass `ytsearch...` directly to `ytdlp-ts download`. Inspect candidates, choose one canonical single-track URL, inspect it, then download that URL.
- Skip `unidentified`, `ambiguous`, intro, and overlap-only entries unless the user chooses them.
- Use subprocess argument arrays, not shell interpolation, when implementing adapters.
- Persist the manifest after every match, download, or export. Preserve user edits and completed states on resume.
- Keep Spotify metadata-only. Prefer Soulseek for acquisition; use YouTube or SoundCloud only as a selected single-track fallback.
- Default Rekordbox handoff to M3U8 or XML. Direct database writes require explicit user approval, Rekordbox closed, and a backup.

## Component ownership

| Component      | Owns                                                             | Must not own                                   |
| -------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| `tracks-ts`    | Set metadata, tracklist resolution, cues, manifest               | Remote set download                            |
| `spots`        | Spotify playlist/track metadata and identity enrichment          | Audio acquisition                              |
| `slsk-ts`      | Selected individual Soulseek file acquisition                    | Tracklist resolution                           |
| `ytdlp-ts`     | Metadata, bounded candidate search, selected individual fallback | Source-set or automatic search-result download |
| `rekordbox-ts` | M3U8/XML export and approved Rekordbox operations                | Identity guessing                              |

## 1. Preflight

Work from the sibling repositories' built CLIs or configured paths. Run:

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

For each identified primary entry, query Spotify with `spots`:

```sh
spots api search --q "isrc:$ISRC" --type track --market US --limit 10 --format json
spots api search --q "track:\"$TITLE\" artist:\"$ARTIST\"" --type track --market US --limit 10 --format json
```

Use ISRC exact match first. Otherwise score normalized artist/title/mix plus duration. A weak match or close top-two margin remains `ambiguous`; do not choose silently. Record the query, candidates, score, Spotify ID/URI/URL, duration, and ISRC.

## 4. Acquire individual tracks

Search Soulseek first:

```sh
slsk search "$ARTIST - $TITLE $MIX" --timeout 8 --max-results 100 --format json
slsk download "$USERNAME" "$REMOTE_FILE" "$DESTINATION" --resume --timeout 120 --format json
```

Prefer lossless files with plausible duration and metadata. Do not infer quality from extension alone. Record the selected peer/file before download and the absolute output path plus SHA-256 after download.

If Soulseek has no acceptable result, discover a bounded YouTube candidate set without media download:

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

Cap concurrent downloads. Resume pending entries; never redownload an existing verified file.

## 5. Prepare Rekordbox handoff

Prefer an M3U8 of absolute paths in manifest order:

```sh
NEXT_M3U8="${M3U8}.next"
jq -e '([.entries[] | select(.acquisition.status == "downloaded")] | length) > 0 and all(.entries[] | select(.acquisition.status == "downloaded"); .acquisition.download.mediaPath as $p | ($p | startswith("/")) or ($p | test("^[A-Za-z]:[\\\\/]")))' "$MANIFEST" >/dev/null
{ printf '#EXTM3U\n'; jq -r '.entries[] | select(.acquisition.status == "downloaded") | .acquisition.download.mediaPath' "$MANIFEST"; } > "$NEXT_M3U8"
mv -f -- "$NEXT_M3U8" "$M3U8"
```

For richer metadata, create Rekordbox XML:

```sh
rekordbox xml create "$XML" --name tracks-ts --version=0.1.0 --format json
rekordbox xml playlist add "$XML" "$PLAYLIST" --key-type TrackID --format json
rekordbox xml track add "$XML" "$ABS_PATH" --artist "$ARTIST" --name "$TITLE" --album "$ALBUM" --format json
rekordbox xml playlist add-track "$XML" "$PLAYLIST" "$TRACK_ID" --format json
```

Use each `track.TrackID` returned by `track add`. Sanitize `/` in playlist names. Record export state and artifact paths. Tell the user to import the M3U8 via Rekordbox File -> Import -> Import Playlist, or configure and import the generated XML.

## 6. Handoff

Return: source/title, provider, resolved/unresolved counts, Spotify match counts, acquired/skipped/failed counts by backend, output directory, manifest path, playlist artifact, and any manual decisions. Never claim completion while identified entries remain pending unless the user chose a partial playlist.

## Manifest and resume contract

Use only schema states accepted by `tracks manifest validate` and the exported `parseManifest` library function:

- `identity.status`: `identified` or `unidentified`.
- `spotify.status`: `pending`, `matched`, `ambiguous`, `unmatched`, `failed`, or `skipped`.
- `acquisition.status`: `pending`, `searching`, `selected`, `downloaded`, `unmatched`, `failed`, or `skipped`.
- `rekordbox.status`: `pending`, `exported`, `imported`, `failed`, or `skipped`.

Do not mark `downloaded` without an absolute `mediaPath` included in `files`. Do not mark `exported` without its target and artifact or Rekordbox identifier. Append structured errors; preserve earlier warnings and user edits.

Persist atomically: write and flush a sibling temporary manifest, run `tracks manifest validate "$NEXT_MANIFEST" --format json`, then rename it over the old file. On resume, preserve completed stages and verified files; retry only pending or explicitly selected failed stages; recompute SHA-256 when a file changes; serialize Rekordbox operations.

Required environment by stage: `YTDLP_TS_PATH`/provider credentials for resolution; Spotify login or token for `spots`; `SLSK_USERNAME` and `SLSK_PASSWORD` for Soulseek; `REKORDBOX_DB_KEY` only for explicitly approved encrypted database access.
