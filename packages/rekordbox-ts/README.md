# rekordbox-ts

A TypeScript port of [dylanljones/pyrekordbox](https://github.com/dylanljones/pyrekordbox), with a synchronous typed database API and an agent-friendly CLI built on [wevm/incur](https://github.com/wevm/incur).

The primary workflow is direct access to encrypted Rekordbox 6/7 `master.db` libraries through `MasterDatabase`. The port also covers Device Library Plus databases, ANLZ analysis files, My Settings binaries, smart playlists, `masterPlaylists6.xml`, and collection XML interchange. The pinned Python revision, compatibility policy, verification evidence, and implementation decisions are recorded in [PORTING.md](./PORTING.md).

> [!CAUTION]
> Back up your Rekordbox collection before using any write operation. This project is not affiliated with AlphaTheta Corporation, Pioneer Corporation, or their related companies.

## Installation

- Node.js 22 or newer
- pnpm 10
- macOS, Windows, or Linux; automatic Rekordbox installation discovery is implemented for macOS and Windows

```sh
pnpm add --global --allow-build=better-sqlite3-multiple-ciphers @gakonst/rekordbox
rekordbox --help
```

The package exposes `rekordbox` as the canonical command and `rekordbox-ts` as an explicit alias.
For library use, install it in a project with the native dependency explicitly approved:

```sh
pnpm add --allow-build=better-sqlite3-multiple-ciphers @gakonst/rekordbox
```

`better-sqlite3-multiple-ciphers` is the one native dependency and provides encrypted SQLCipher
access. pnpm 10 requires the explicit `--allow-build` acknowledgement shown above; without it,
command discovery works but database commands cannot load the native binding.

## Development

The source package lives in the `gakonst/music-ts` pnpm workspace:

```sh
gh repo clone gakonst/music-ts ~/github/gakonst/music-ts
cd ~/github/gakonst/music-ts
pnpm install
pnpm --filter @gakonst/rekordbox validate
pnpm --filter @gakonst/rekordbox cli --help
```

## CLI

```sh
# The main flow: discover, query, and manage the Rekordbox master database
rekordbox config show
rekordbox db info
rekordbox db search "track name"
rekordbox db playlist contents 123456
rekordbox db playlist list
rekordbox db playlist list --type playable --json
rekordbox db playlist show "Adam Ten — Burning Man 2025 [music-ts E2E]"
rekordbox db playlist show "Adam Ten — Burning Man 2025 [music-ts E2E]" --json
rekordbox db sql "SELECT Title FROM djmdContent WHERE ArtistID = ?" --parameters '["123"]'

# Read an encrypted Device Library Plus export
rekordbox device info --path /Volumes/USB/PIONEER/rekordbox/exportLibrary.db

# Work with secondary/interchange formats when needed
rekordbox anlz info ANLZ0000.DAT
rekordbox analyze doctor
rekordbox analyze track /Music/track.flac
rekordbox settings show MYSETTING.DAT
rekordbox xml info collection.xml
```

Top-level command families:

| Command     | Purpose                                                       |
| ----------- | ------------------------------------------------------------- |
| `config`    | Discover Rekordbox 5/6/7 installations and library paths      |
| `xml`       | Inspect and mutate collection tracks and playlists            |
| `anlz`      | Scan, inspect, and mutate DAT/EXT/2EX analysis files          |
| `analyze`   | Produce clean DAT/EXT/2EX analysis; optional macOS oracle     |
| `settings`  | Read, update, and create all four My Settings binary formats  |
| `smartlist` | Parse, construct, and compile smart playlists                 |
| `db`        | Query and mutate the Rekordbox 6/7 master database            |
| `device`    | Query and mutate Device Library Plus `exportLibrary.db` files |

Database mutation commands require `--write`; databases otherwise open read-only. Commits refuse to run while Rekordbox is open unless `--allow-while-running` is also supplied. Generic `row create`, `row update`, and `row delete` commands expose mapped physical tables, while content, playlist, and tag commands cover common coordinated workflows.

Use `--plain` for an unencrypted SQLite fixture or unlocked copy. The built-in upstream keys handle standard databases; override them with `REKORDBOX_DB_KEY` or `REKORDBOX_DEVICE_DB_KEY` when necessary.

`db playlist list` returns the complete active folder, regular-playlist, and smart-playlist hierarchy
in Rekordbox tree order by default. Its Markdown table uses a readable display path and includes each
entry's type, direct track count, direct child count, and ID. Use `--type playable` to keep only
regular and smart playlists, or `--limit` and `--offset` for explicit, reported pagination. With
`--json`, `pathSegments` and `idPath` are the canonical hierarchy representation; the joined display
path is presentation-only because Rekordbox names may themselves contain path separators.

`db playlist show` resolves an exact playlist name and defaults to an aligned Markdown table with
playlist position, artist, title, BPM, key, duration, and format. It returns the complete playlist by
default; use `--limit` and `--offset` for explicit, reported pagination. Pass `--json` for ordered
machine data including content and membership IDs, local paths, raw duration seconds, file type, and
analysis status. Duplicate names fail with their candidate IDs instead of choosing silently; use
`--parent-id` or `--id` to select one.

incur provides structured output and discovery on every command:

```sh
rekordbox --llms                 # LLM-readable command manifest
rekordbox db info --schema       # input/output JSON Schema
rekordbox db info --format json  # JSON, TOON, YAML, Markdown, or JSONL
rekordbox db info --token-limit 500
```

The complete CLI definition is import-safe and can be mounted beneath another Incur root:

```ts
import rekordboxCli from "@gakonst/rekordbox/cli";

root.command(rekordboxCli);
```

`runRekordboxCli()` remains available from the same subpath for standalone launchers.

## TypeScript API

The root entry point exports the common API. Format-specific subpaths avoid name collisions such as the separate master/device `Content`, `PlaylistType`, and `FileType` models.

### Primary workflow: master database

```ts
import { DjmdContent, DjmdPlaylist, MasterDatabase } from "@gakonst/rekordbox/masterdb";

// With no path, the latest Rekordbox 7/6 library is discovered automatically.
const db = new MasterDatabase();
try {
  const tracks = db.searchContent("Orbital");
  const first = db.query(DjmdContent).orderBy("ID").first();
  const playlistRows = db.query(DjmdPlaylist).orderBy("Seq").all();
  const playlists = db.listPlaylists();
  const playlistTracks = playlistRows[0] ? db.getPlaylistTracks(playlistRows[0]) : [];
  console.log(tracks, first?.Artist?.Name, playlists, playlistTracks);
} finally {
  db.close();
}
```

`MasterDatabase.listPlaylists()` is the shared active-playlist inventory used by the CLI and the
local Rekordbox library workbench. It returns stable IDs, parent IDs, sibling sequence, entry type,
and direct track counts without duplicating database-selection rules across those surfaces.

Databases open read-only by default. For a write workflow, pass `readonly: false`, stage changes through helpers such as `createPlaylist`, `addToPlaylist`, `renamePlaylist`, or row `set`, then call `commit()`. `rollback()` restores staged rows. Commits are blocked while Rekordbox is running, and `copyUnlocked()` produces a new plain SQLite logical copy without modifying the encrypted source.

Content cue helpers keep the normalized `djmdCue` rows and Rekordbox's denormalized `contentCue`
JSON mirror in the same transaction:

```ts
const db = new MasterDatabase({ readonly: false });
try {
  db.upsertContentCue("CONTENT_ID", {
    kind: "memory",
    startSeconds: 32,
    type: "cue",
  });
  db.upsertContentCue("CONTENT_ID", {
    activeLoop: true,
    endSeconds: 72,
    kind: "hot",
    slot: 1,
    startSeconds: 64,
    type: "loop",
  });
  console.log(db.getContentCues("CONTENT_ID"));
  db.commit();
} finally {
  db.close();
}
```

`getContentCues`, `upsertContentCue`, `deleteContentCue`, and `setContentCues` use seconds at the API
boundary and Rekordbox's millisecond plus 1/150-second frame fields in the database. They enforce
track duration, cue/loop shape, chronological memory-cue order, the 10-memory-cue limit, unique Hot
Cue slots A through P, comments, colors, and row ownership. `setContentCues` stages an exact
replacement; memory cues come first chronologically and Hot Cues follow in slot order. These master
database helpers deliberately do not rewrite PCOB/PCO2 tags in installed ANLZ files: the current ANLZ
port parses and preserves those binary cue lists but does not safely synthesize them.

The Incur CLI exposes the same model through `db content cues`, `set-cue`, and `delete-cue`.
Cue writes require `--write`, never accept `--allow-while-running`, and refuse to proceed while
either Rekordbox or rekordboxAgent is running. Each command acquires the canonical
`<master.db>.tracks-ts.lock`, creates a checksummed backup of the database and existing companions,
writes a durable intent/outcome journal, commits once, then reopens read-only for `quick_check`,
`foreign_key_check`, and exact cue verification. The receipt contains the backup and journal paths.
`set-cue --id` has patch semantics: omitted cue fields remain unchanged; use `--clear-comment`,
`--clear-color`, or `--clear-color-table-index` for explicit clearing.

```sh
music rekordbox db content cues CONTENT_ID --format json
music rekordbox db content set-cue CONTENT_ID 32 --write
music rekordbox db content set-cue CONTENT_ID 64 --kind hot --slot A \
  --type loop --end-seconds 72 --active-loop --comment "Drop loop" --write
music rekordbox db content delete-cue CONTENT_ID CUE_ID --write
```

For SQLAlchemy-style escape-hatch work, `executeSql()` supports parameterized joins, projections, aggregates, CTEs, and mutations, while the public native `connection` supports custom SQLite functions, savepoints, and streaming statements. Model rows expose complete generated physical-column types, relationship metadata, writable to-one relationships and association proxies, and live relationship collections.

### ANLZ and My Settings

```ts
import { AnlzFile, PQTZAnlzTag } from "@gakonst/rekordbox/anlz";
import { readMySettingFile } from "@gakonst/rekordbox/mysettings";

const anlz = AnlzFile.parseFile("ANLZ0000.DAT");
const grid = anlz.getTag("PQTZ") as PQTZAnlzTag;
grid.setBpms(grid.getBpms().map(() => 128));
anlz.getTag("PSSI").editParsed((bytes) => {
  // Low-level edits are re-obfuscated automatically when necessary.
  bytes[30] = 2;
});
anlz.save("ANLZ0000-updated.DAT");

const settings = readMySettingFile("MYSETTING.DAT");
settings.set("quantize", "ON");
settings.save("MYSETTING-updated.DAT");
```

Untouched ANLZ tags and opaque My Settings bytes round-trip losslessly. PQTZ and PQT2 expose typed beat-grid mutation; every tag additionally exposes bounded raw and parsed byte editing. Mutations recalculate file lengths/checksums and preserve PSSI obfuscation.

### Audio analysis and database installation

Analysis defaults to the releasable `rekordbox-analyzer` Rust binary. It decodes local audio and
produces deterministic `ANLZ0000.DAT`, `.EXT`, and `.2EX` files without opening Rekordbox or
`master.db`. The clean engine requires no Rekordbox/JUCE/runtime bytes and runs directly on supported
platforms.

`pnpm --filter @gakonst/rekordbox build:analyzer` produces a signed universal
macOS helper and copies `LICENSE` plus `THIRD_PARTY_LICENSES.md` beside it. Keep
both with any distributed binary: the bundled Symphonia 0.6.0 codec crates are
MPL-2.0 and the notice identifies their exact corresponding source.

The repository-local macOS rehost remains an explicit `--engine reference` parity oracle. Release
artifacts must never contain `packages/rekordbox-ts/vendor`, the reference helper, Rekordbox
application/runtime bytes, or captured goldens. Clean output is protocol-valid and structurally
compatible, but waveform, beat-grid, key, phrase, and unknown-tag values are not claimed to match the
proprietary DSP byte-for-byte.

```sh
rekordbox analyze doctor --engine clean --format json
rekordbox analyze track /Music/track.flac \
  --engine clean \
  --output-directory /Music/track.rekordbox \
  --threads 12 \
  --format json
rekordbox analyze tracks \
  --audio-path /Music/one.flac \
  --audio-path /Music/two.flac \
  --engine clean \
  --concurrency 4 \
  --threads 12 \
  --format json
rekordbox analyze beat-grid-diff \
  /Music/reference.rekordbox \
  /Music/candidate.rekordbox \
  --format json
rekordbox analyze waveform-diff \
  /Music/reference.rekordbox \
  /Music/candidate.rekordbox \
  --format json
```

`analyze beat-grid-diff` compares PQTZ plus PQT2 semantically instead of treating opaque ANLZ bytes
as the metric. Its bounded monotonic alignment reports missing/extra beats, sub-millisecond
timestamp distributions, drift, beat-number phase, downbeat error, tempo changes, and F1 at 70 and
100 ms. Use an independently produced Rekordbox directory as the reference during parity work.
`analyze waveform-diff` decodes every supported waveform family and compares its semantic
components over the overlapping columns. It reports entry-count deltas, exact-value fractions,
Pearson correlation, means, MAE, median/p95/max absolute error, and signed bias instead of conflating
packed bitfields or differing tail lengths.

For `analyze track`, `--threads` is the native worker count for that one
process. For `analyze tracks`, it is a total CPU budget, not a per-process
multiplier. The batch runner caps its process count to the budget and divides
the budget deterministically across active workers: for example,
`--concurrency 4 --threads 12` launches at most four clean analyzers with three
native threads each. Omitting it uses Node's available-parallelism value,
bounded to 64. The selected `threadBudget` and `workerThreadBudgets` are
reported in structured output.

After closing Rekordbox and backing up the library, install the verified artifacts for an existing
content row:

```sh
rekordbox db content install-analysis 123456 /Music/track.rekordbox --write --format json
```

Installation also reads `analysis.json`, validates its complete schema, and proves that both analyzer
source paths plus the recorded size and modification time still identify the content row's exact
audio file. A malformed, stale, unavailable, or wrong-track summary fails before any database commit.
The analyzer tempo is stored in `djmdContent.BPM` as integer hundredths of a BPM. Conventional keys
such as `Bm`, enharmonic spellings, and existing Camelot values are normalized to Rekordbox's
canonical Camelot name; installation requires one matching active `djmdKey` row and writes its ID to
`djmdContent.KeyID`. Null analyzer values remain unset rather than being inferred from Spotify or a
different DSP implementation.

For content whose DAT/EXT/2EX files and `AnalysisDataPath` are already installed, repair only the
missing database projection without copying the analysis files again:

```sh
rekordbox db content sync-analysis-metadata \
  123456 /Music/track.rekordbox --write --format json
```

Programmatically, use `analyzeTrack()` or the nonblocking `analyzeTrackAsync()`. `analyzeTracks()`
runs a bounded pool of isolated worker processes, preserves input order, and defaults to four
workers or the number of uncached tracks, whichever is lower. The CLI reports cache, start,
completion, failure, and cancellation progress on stderr; `--progress never` disables it.
SIGINT/SIGTERM stop active child analyzers and prevent new work. Keep database installation separate
and serialized: call
`MasterDatabase.installContentAnalysis()` for each verified result only after analysis finishes.
If some tracks fail, `AnalyzeTracksError` retains indexed typed failures and the ordered partial
results/cache hits. Cancellation throws the abort-compatible `AnalyzeTracksCancelledError`, whose
partial result also reports the exact unfinished count. Every successful `analysis.json` remains
durable for the next resume.
Use `MasterDatabase.syncContentAnalysisMetadata()` for an already-installed result. Both methods
validate `analysis.json` and its source fingerprint; their result includes the analyzer tempo,
hundredths value, normalized key name, and resolved key ID. The set-import workflow persists this
summary in its durable manifest, post-verifies `BPM`, `KeyID`, and the active key name after reopening
the database, and treats missing or mismatched values as repairable checkpoint drift on a warm
resume.
Four workers is the stable interactive default. Historical reference-engine measurements on a
12-core machine found that 26 real set tracks took 60.02 seconds with four workers,
32.23 seconds with eight, and 28.83 seconds with twelve. A 64-default stress run completed 27
compatible real artifacts in 23.85 seconds at an effective concurrency of 27 (1.13 tracks/second).
Two additional source files returned the same native `startAnalyze` incompatibility alone at
concurrency one and were excluded from that timing. Moving from 12 to 27 workers used more than twice
as many native processes for roughly 17% lower wall time, so higher concurrency remains an explicit,
measured override. Warm validation of all 26 cached analyses
took 11.65 ms. These numbers do not describe the clean engine.

For the clean engine on the same 12-core machine, deterministic native
parallelism reduced four representative single-track medians by 1.74–2.38x
versus the scalar baseline. A four-track run with one shared 12-thread budget
took 0.81 seconds using four processes with budgets `[3, 3, 3, 3]`, versus
1.86 seconds when processing the same files sequentially. DAT/EXT/2EX hashes
were unchanged at 1, 2, 3, 4, 8, and 12 threads. Treat these as host-specific
measurements; lower `--threads` when analysis competes with live DJ software.

Set `REKORDBOX_CLEAN_ANALYZER_BINARY`, place `rekordbox-analyzer` on `PATH`, or pass
`analyzerBinary` to select the clean binary. The legacy `REKORDBOX_ANALYZER_BINARY` override remains
reference-only so an old proprietary helper cannot be selected by the clean default. For an explicit
reference run, set `REKORDBOX_REFERENCE_ANALYZER_BINARY` or place
`rekordbox-analyzer-reference` on `PATH`; that mode requires macOS, Rosetta on Apple Silicon, and
`REKORDBOX_ANALYZER_APP` pointing to the user's compatible `rekordbox.app`.

Only the reference backend can reject otherwise valid Unicode-heavy source paths with
`startAnalyze` status `-1`. The async wrapper retries only that exact reference failure through a
byte-identical ASCII input/output staging directory, then atomically moves validated artifacts back
to their canonical output path and records the original source path in `analysis.json`. Other
reference failures remain fail-closed.

### Collection XML interchange

```ts
import { RekordboxXml } from "@gakonst/rekordbox/xml";

const xml = new RekordboxXml("collection.xml");
const track = xml.addTrack("/Music/new-track.mp3", {
  Artist: "Artist",
  Name: "New Track",
});
xml.addPlaylist("Imports").addTrack(track.TrackID);
xml.save("collection-updated.xml");
```

Use this API when importing/exporting collection XML rather than as the default interface to a local Rekordbox library. Unknown XML attributes and elements are retained when a document is rebuilt.

### Device Library Plus

```ts
import { Content, DeviceLibraryPlus, Playlist } from "@gakonst/rekordbox/devicelib-plus";

const db = new DeviceLibraryPlus("/Volumes/USB/PIONEER/rekordbox/exportLibrary.db");
try {
  const playlists = db.query(Playlist).orderBy("sequenceNo").all();
  const content = db.query(Content).where({ title: "The Box" }).first();
  console.log(playlists, content?.artist_name);
} finally {
  db.close();
}
```

## Compatibility notes

- Important pyrekordbox classes keep their names; primary TypeScript methods use camelCase (`parse_file` becomes `parseFile`, `get_content` becomes `getContent`).
- `Rekordbox6Database` remains as a deprecated compatibility class; use `MasterDatabase` for new code.
- SQLite schemas are introspected at runtime. Known tables receive named row classes, while newly introduced physical columns remain accessible through row properties and `get`/`set`.
- Library and CLI operations are synchronous except `copyUnlocked`, which returns a promise for API stability.

## Verification

```sh
pnpm --filter @gakonst/rekordbox validate
```

The suite includes fixed Python-compatible vectors, generated database fixtures, encrypted SQLCipher opening, mutation/rollback behavior, and exact differential verification against the pinned upstream fixtures. See [PORTING.md](./PORTING.md) for the full evidence log.

## License

MIT. This is an independent TypeScript port. The original pyrekordbox copyright and license notice are retained in [LICENSE](./LICENSE).
