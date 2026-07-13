# tracks-ts

Metadata-first TypeScript resolver for DJ sets.

Give `tracks` a public YouTube/SoundCloud set URL, a 1001Tracklists URL, or a local audio file. It returns a versioned, nested manifest: set metadata at the root; ordered tracks, cue times, IDs, overlaps, provider metadata, and downstream search queries underneath.

> [!IMPORTANT]
> `tracks resolve` never downloads a remote source set. Remote YouTube/SoundCloud resolution begins with metadata-only `ytdlp-ts inspect`. A later, explicit acquisition run may cache the set once when cue-bounded extraction is the only usable source for an ID, unreleased edit, or otherwise unavailable track. Every extract retains its source URL, range, quality warning, and checksum.

`tracks resolve` also does not acquire the identified songs. The library pipeline composes `@gakonst/spots`, `slsk-ts`, `@gakonst/ytdlp-ts`, and `@gakonst/rekordbox` directly around the durable manifest; it does not shell between their CLIs. Individual acquisition and Rekordbox handoff remain explicit, resumable stages described in [Pipeline](#pipeline).

## Quick start

Node.js 22+ and the pnpm version pinned by the music-ts workspace are required.

```sh
gh repo clone gakonst/music-ts
cd music-ts
pnpm install
pnpm build
pnpm --filter @gakonst/tracks cli -- doctor
pnpm --filter @gakonst/tracks cli -- providers
```

The provider libraries are declared with `workspace:*` dependencies, so one root install links the exact local packages and a root build orders them before `@gakonst/tracks`. `YTDLP_TS_PATH` remains available only when an explicit alternative executable is needed. Tests and custom runtimes can still inject module objects directly.

In the music-ts workspace, keep provider credentials in the ignored root `.env`; the CLI loads it
automatically. For standalone package use, it also checks `.env` in the current working directory.

## Real example: Adam Ten at Burning Man 2025

The public SoundCloud upload includes a timestamped description. Resolution reads that metadata; it does not fetch the two-hour audio file.

```sh
SET_URL='https://soundcloud.com/120bpm-238035343/adam-ten-live-burning-man-2025-with-tracklist'

tracks resolve "$SET_URL" \
  --provider description \
  --progress never \
  --format json > adam-ten-burning-man-2025.json
```

Verified result: 29 ordered cue entries, six explicit IDs preserved, and 22 identified tracks with `searchQuery` values for downstream matching.

```json
{
  "schemaVersion": 1,
  "kind": "dj-set-pipeline",
  "source": {
    "input": "https://soundcloud.com/120bpm-238035343/adam-ten-live-burning-man-2025-with-tracklist",
    "title": "Adam Ten Live @ Burning Man 2025 with tracklist",
    "durationSeconds": 7196.003
  },
  "tracklist": { "provider": "description", "complete": true },
  "entries": [
    {
      "id": "track-002",
      "order": 2,
      "cue": { "timestamp": "00:01:26", "startSeconds": 86 },
      "identity": {
        "status": "identified",
        "artist": "Assaf Michael",
        "title": "The Big Guns (Edit)",
        "searchQuery": "Assaf Michael - The Big Guns (Edit)"
      },
      "spotify": { "status": "pending", "query": "Assaf Michael - The Big Guns (Edit)" },
      "acquisition": { "status": "pending", "query": "Assaf Michael - The Big Guns (Edit)" },
      "rekordbox": { "status": "pending" },
      "warnings": [],
      "errors": []
    },
    {
      "id": "track-005",
      "order": 5,
      "cue": { "timestamp": "00:14:34", "startSeconds": 874 },
      "identity": { "status": "unidentified", "artist": "ID", "title": "ID", "isId": true },
      "spotify": { "status": "pending" },
      "acquisition": { "status": "pending" },
      "rekordbox": { "status": "pending" },
      "warnings": [],
      "errors": []
    }
  ],
  "warnings": ["7 description entries are not directly searchable."],
  "errors": [],
  "artifacts": {}
}
```

`identify` remains an alias for `resolve`.

The complete CLI definition can be imported without loading `.env` or serving a process:

```ts
import tracksCli from "@gakonst/tracks/cli";

root.command(tracksCli);
```

`runTracksCli()` remains available from the same subpath for standalone launchers.

## Resolution flow

Automatic resolution is ordered and short-circuits at the first usable tracklist:

```text
YouTube / SoundCloud URL
└─ 1. ytdlp-ts metadata inspection
   └─ timestamped description found → manifest
└─ 2. 1001Tracklists media lookup, when configured
   └─ submitted tracklist found → manifest
└─ 3. configured recognizer
   ├─ AudD Enterprise → provider processes URL or local file
   └─ AudD Standard / ACRCloud → local-file clips only

1001Tracklists URL
└─ Parse-managed 1001 wrapper → manifest

Local audio file
└─ 1001 lookup skipped
└─ AudD Enterprise, AudD Standard samples, or ACRCloud samples
```

Provider summary:

| Provider                   | Purpose                                      | Credential                                        | Reads remote set bytes locally?    |
| -------------------------- | -------------------------------------------- | ------------------------------------------------- | ---------------------------------- |
| Description via `ytdlp-ts` | Free first pass for timestamped descriptions | None                                              | No; metadata only                  |
| 1001Tracklists via Parse   | Existing community tracklist                 | `PARSE_API_KEY`                                   | No; JSON only                      |
| AudD Enterprise            | Long-set recognition for URL or local file   | `AUDD_API_TOKEN` with Enterprise access           | No for URLs; AudD receives the URL |
| AudD Standard samples      | Cost-bounded recognition of a local file     | `AUDD_API_TOKEN`                                  | Local files only                   |
| ACRCloud samples           | Alternative recognition of a local file      | `ACR_HOST`, `ACR_ACCESS_KEY`, `ACR_ACCESS_SECRET` | Local files only                   |

Skip stages deliberately when needed:

```sh
tracks resolve "$SET_URL" --no-prefer-description
tracks resolve "$SET_URL" --no-prefer-database
tracks resolve "$SET_URL" --provider 1001tracklists
```

Description inspection may use `--cookies path.txt` or `--cookies-from-browser chrome`. These options affect metadata access only; they do not enable remote sampling.

## 1001Tracklists

1001Tracklists has no public developer API. `tracks` uses [Parse's maintained unofficial wrapper](https://parse.bot/marketplace/ec03e43b-6798-40ce-86c9-02832adedc4c/1001tracklists-com-api), rather than embedding a challenge-bypassing scraper.

```sh
export PARSE_API_KEY='…'

tracks 1001 find "$SET_URL"
tracks 1001 get 'https://www.1001tracklists.com/tracklist/…'
tracks 1001 search 'Adam Ten Burning Man 2025'
tracks 1001 latest
tracks 1001 charts --type trending
```

Exact tracklists are cached for seven days by default, avoiding repeated Parse credits. Use
`--cache-mode refresh` after a tracklist edit or `--cache-mode off` for a diagnostic network call.

Optional endpoint pinning:

```sh
export PARSE_SCRAPER_ID='your-pinned-scraper-id'
# Or override the complete endpoint root.
export PARSE_API_BASE='https://api.parse.bot/scraper/…'
```

Parse requests consume credits. Authentication, quota, and service errors fail closed; only a clean not-found result allows automatic fallback.

## Audio recognition

### Remote URL: AudD Enterprise

AudD fetches and processes the supplied URL. `tracks` does not create a local copy.

```sh
export AUDD_API_TOKEN='…'

# Development cap: at most ten billable fragments.
tracks resolve "$SET_URL" --provider audd --strategy enterprise --limit 10

# Cost-aware default: scan one 12-second fragment, skip four.
tracks resolve "$SET_URL" --provider audd --strategy enterprise

# Gapless provider-side scan. Review billing first.
tracks resolve "$SET_URL" --provider audd --strategy enterprise --full
```

AudD bills Enterprise recognition per processed fragment. Review [current Enterprise documentation](https://docs.audd.io/enterprise/) before removing `--limit` or using `--full`.

### Local file: AudD Standard or ACRCloud

Sampling never accepts a URL. Obtain an authorized local recording yourself, then pass its path. `ffmpeg` creates short mono clips in a temporary directory; each clip is deleted after recognition.

```sh
tracks resolve ./authorized-set.wav \
  --provider audd \
  --strategy samples \
  --interval 45 \
  --limit 20

tracks resolve ./authorized-set.wav \
  --provider acrcloud \
  --interval 60 \
  --clip 12 \
  --concurrency 3 \
  --limit 20
```

`--interval` controls time between samples. `--clip` accepts 5–25 seconds. `--limit` caps billable recognition calls. Sparse sampling reports `complete: false`; this describes coverage, not identification correctness.

Attempting remote sample recognition fails with:

```text
Remote sample recognition is disabled; use metadata/1001 resolution or AudD Enterprise so tracks never downloads the source set
```

## Manifest contract

Every `resolve` result is a `dj-set-pipeline` manifest with `schemaVersion: 1`.

`source` describes the set; `tracklist` records the provider and coverage. `entries[]` remains in play order. Each entry contains:

- stable `id`, `order`, and `cue`
- `identity`: artist/title/mix, IDs, release metadata, confidence, overlaps, status, search query
- resumable `spotify`, `acquisition`, and `rekordbox` stage states
- entry-local warnings and structured errors

Top-level `artifacts`, warnings, and structured errors complete the durable state. IDs and unknown slots stay in place with `identity.status: "unidentified"`; they are not silently dropped. The strict parser rejects unknown keys, invalid state combinations, duplicate orders, and malformed paths.

Validate any manifest changed by a pipeline stage before replacing the durable copy:

```sh
tracks manifest validate adam-ten-burning-man-2025.json --format json
```

Machine-readable and agent surfaces come from [incur](https://github.com/wevm/incur):

```sh
tracks resolve "$SET_URL" --format json
tracks resolve --schema
tracks --llms
tracks mcp add
tracks skills add
tracks completions zsh
```

## Pipeline

The intended system is a set of narrow workspace packages, joined by the manifest and the `build-dj-set-playlist` skill:

```text
set URL ── tracks-ts ───────────────┐
Spotify playlists ── spots ─────────┤
                                    ▼
                         nested set manifest
                                    │
                 per identified track / searchQuery
                                    │
               ┌────────────────────┴───────────────────┐
               ▼                                        ▼
       slsk-ts search/download               ytdlp-ts single-track fallback
       preferred individual file             selected track URL; no playlist
               └────────────────────┬───────────────────┘
                                    │ unavailable/ID only
                                    ├── bounded annotated source-set clip
                                    ▼
                         ordered local audio files
                                    │
                                    ▼
                   rekordbox-ts encrypted master.db
```

| Workspace package                                                                           | Responsibility                                                                      |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [`@gakonst/spots`](https://github.com/gakonst/music-ts/tree/main/packages/spots)            | Pull the user's Spotify playlists; enrich or verify track metadata                  |
| `@gakonst/tracks`                                                                           | Resolve one set, coordinate enrichment/acquisition, and retain the durable manifest |
| [`slsk-ts`](https://github.com/gakonst/music-ts/tree/main/packages/slsk-ts)                 | Preferred search and resumable download of each individual track                    |
| [`@gakonst/ytdlp-ts`](https://github.com/gakonst/music-ts/tree/main/packages/ytdlp-ts)      | Metadata inspection, selected-track fallback, and approved bounded set-cache source |
| [`@gakonst/rekordbox`](https://github.com/gakonst/music-ts/tree/main/packages/rekordbox-ts) | Approved, backed-up direct import into the normal encrypted Rekordbox database      |

The boundary is deliberate:

- `tracks resolve` currently implements resolution and manifest creation.
- It does not call `spots`, `slsk download`, `ytdlp-ts download`, or Rekordbox mutation commands.
- The bundled skill coordinates library calls, records selected sources and local paths under each track's `acquisition`, and leaves unresolved IDs visible.
- `slsk-ts` is preferred. A `ytdlp-ts` individual fallback targets a scored canonical track URL with playlists disabled. True recording ambiguities remain distinct alternatives and are all acquired.
- Compatible Soulseek FLAC, MP3, and M4A files retain their container; PCM sources become FLAC losslessly, while an unavoidable lossy compatibility transcode is annotated.
- If no individual release exists, a cue-bounded extract may come from one cached source-set download. It is marked lossy and transition-bearing; the cache is retained until every extract verifies.
- Direct Rekordbox import begins only after all planned files are present and checksummed. It requires explicit approval, stopped Rekordbox processes, an exclusive backup of the database and companion files, one transaction, and post-commit integrity/membership verification.

Illustrative individual-track calls—not an automatic `tracks` command:

```sh
slsk search 'Adam Ten & Rhye - 3 Days Later' --format json
slsk download '<user>' '<remote-file>' './tracks/Adam Ten & Rhye - 3 Days Later.flac'

ytdlp-ts inspect "$SELECTED_TRACK_URL" --no-playlist --format json
ytdlp-ts download "$SELECTED_TRACK_URL" \
  --no-playlist \
  --extract-audio \
  --audio-format m4a \
  --paths ./tracks
```

Use acquisition backends only for media you are authorized to download.

## Performance and persistent caches

Provider metadata is public but not immutable. `tracks` uses TTL-bounded, versioned JSON cache
entries under `TRACKS_CACHE_DIR` or `~/.cache/tracks-ts`; directories are mode `0700`, entries are
mode `0600`, writes are atomic, and credentials/cookies are never included. Volatile signed media
URLs are stripped before YouTube metadata is stored. A bounded, persisted sweep periodically removes
expired or malformed entries.

| Namespace                       | Default freshness |
| ------------------------------- | ----------------- |
| Exact 1001 tracklist            | 7 days            |
| 1001 media lookup/search        | 6 hours           |
| 1001 latest/charts              | 15 minutes        |
| Spotify search                  | 6 hours           |
| Spotify track metadata          | 24 hours          |
| YouTube/SoundCloud set metadata | 6 hours           |
| YouTube search/exact metadata   | 6/24 hours        |
| Stat-keyed audio verification   | 30 days           |

Spotify metadata remains temporary, consistent with [Spotify's caching requirements](https://developer.spotify.com/terms). Spotify's
[February 2026 Development Mode migration](https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide)
removed the multi-track metadata endpoint, so `CachedSpotifyClient` combines bounded individual
requests with persistent reuse. The underlying client still owns documented
[`429 Retry-After` handling](https://developer.spotify.com/documentation/web-api/concepts/rate-limits).
Spotify responses may depend on the authenticated account and market, so persistent caching requires
an opaque, non-secret `cacheScope` that identifies both. Caching is disabled when callers omit it;
the bundled runner derives a one-way session fingerprint without storing the credential.

`acquireManifest` defaults to three independent recording workers. Variants of one ambiguous cue,
candidate fallback, manifest writes, and all Rekordbox operations remain serialized. Completed
media gets one concurrent verification pass; the bundled runner injects a stat-keyed cache that
eliminates unchanged repeat hash/probe work. Library callers can inject the same `JsonDiskCache`
through `verificationCache`. A fully verified resume takes the fast path without loading an acquisition backend.
The normal Rekordbox importer similarly verifies an already-imported playlist and returns
`performance.changed: false` without another backup or write.

```sh
pnpm exec tsx src/run-brunello-acquisition.ts --concurrency 3
pnpm exec tsx src/run-brunello-acquisition.ts --refresh-cache
pnpm exec tsx src/run-brunello-acquisition.ts --no-cache
```

Acquisition and Rekordbox results both include monotonic stage durations and wall timestamps.
Acquisition additionally reports cache hit/miss/network-load counters, checkpoint writes, and the
effective concurrency. Cache load time is aggregate work; with parallel calls it can exceed wall
time. See the reproducible Brunello baseline and optimized measurements in
[docs/performance.md](docs/performance.md).

## Render/export

The resolver manifest can still be rendered as plain text, YouTube chapters, or a CUE sheet for the original set:

```sh
tracks render adam-ten-burning-man-2025.json --style text
tracks render adam-ten-burning-man-2025.json --style youtube
tracks render adam-ten-burning-man-2025.json \
  --style cue \
  --audio-file authorized-local-set.wav > set.cue
```

`text` retains `w/` overlaps. YouTube and CUE rendering require timestamps. This is separate from the M3U8/Rekordbox playlist built from acquired individual files.

## Configuration

Non-secret defaults may live in `tracks.json` or `~/.config/tracks/config.json`:

```json
{
  "commands": {
    "resolve": {
      "options": {
        "provider": "auto",
        "preferDescription": true,
        "preferDatabase": true,
        "skip": 4,
        "minScore": 50,
        "progress": "auto"
      }
    }
  }
}
```

Precedence: command line, config file, built-in default. Credentials remain environment-only. Run `tracks resolve --help` for the authoritative options and `tracks doctor` for readiness without printing secrets.

## Library

ESM-only.

```ts
import { createManifest, identify } from "@gakonst/tracks";

const tracklist = await identify(
  "https://soundcloud.com/120bpm-238035343/adam-ten-live-burning-man-2025-with-tracklist",
  {
    provider: "auto",
    env: process.env,
  },
);

const manifest = createManifest(tracklist);
console.log(
  manifest.entries.map(({ cue, identity }) => ({
    timestamp: cue.timestamp,
    searchQuery: identity.status === "identified" ? identity.searchQuery : undefined,
  })),
);
```

Pipeline APIs are exported as libraries: `enrichSpotifyManifest`, `acquireManifest`, `refreshKnownSpotifyTracks`, `CachedSpotifyClient`, `JsonDiskCache`, `SoulseekLibraryAcquirer`, `YtdlpReferenceAcquirer`, `verifyAcquisitionPlan`, and `importManifestToRekordbox`. `enrichSpotifyManifest` accepts one long-lived `@gakonst/spots` client, searches pending identified entries with bounded concurrency, and preserves weak or close matches as candidate arrays. Acquisition checkpoints reject concurrent manifest edits. The Rekordbox import requires `approved: true`, accepts an injected `@gakonst/rekordbox` module, and performs the stopped-process, exact-path backup, one-commit, verification, and atomic-manifest sequence described above. A successful import persists its database, folder, playlist, and backup identity under `artifacts.rekordbox`.

The checked-in Brunello recovery preset defaults to `~/Music/tracks-ts/brunello-lightning-in-a-bottle-2026`; set `TRACKS_BRUNELLO_ROOT` or inject module objects when running it elsewhere.

Provider clients and pure parsers remain exported for custom orchestration: `Tracklists1001Client`, `AudDClient`, `AcrCloudClient`, `parseDescriptionTracklist`, `parseEnterpriseResult`, `buildTimeline`, `createManifest`, and `parseManifest`.

## Accuracy and safety

- Description and 1001Tracklists entries are community/uploader metadata; they can be incomplete or wrong.
- IDs, edits, mashups, simultaneous layers, and unreleased versions may not map to an obtainable standalone release.
- Fingerprinting can return a source release rather than the exact edit played. Confident simultaneous matches remain in `overlaps`.
- ACRCloud/AudD sample timestamps have interval-level precision and can miss short edits.
- `complete` means the selected resolution strategy covered its intended input; it is not a guarantee that every track was identified.
- Parse is independent from 1001Tracklists. The project contains no CAPTCHA or access-control bypass.
- Only submit media you are authorized to process, and follow provider/platform terms.

## Development

```sh
pnpm --filter @gakonst/tracks validate
pnpm --filter @gakonst/tracks test:coverage
```

Tests use fixtures and injected HTTP transports; they consume no provider credits. The Adam Ten fixture mirrors the real SoundCloud description.

Primary documentation:

- [@gakonst/ytdlp-ts](https://github.com/gakonst/music-ts/tree/main/packages/ytdlp-ts)
- [incur](https://github.com/wevm/incur)
- [Parse 1001Tracklists wrapper](https://parse.bot/marketplace/ec03e43b-6798-40ce-86c9-02832adedc4c/1001tracklists-com-api)
- [AudD recognition](https://docs.audd.io/)
- [AudD Enterprise](https://docs.audd.io/enterprise/)
- [ACRCloud Identification API](https://docs.acrcloud.com/reference/identification-api/identification-api)
