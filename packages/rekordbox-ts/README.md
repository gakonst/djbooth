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
| `analyze`   | Produce native Rekordbox DAT/EXT/2EX analysis files on macOS  |
| `settings`  | Read, update, and create all four My Settings binary formats  |
| `smartlist` | Parse, construct, and compile smart playlists                 |
| `db`        | Query and mutate the Rekordbox 6/7 master database            |
| `device`    | Query and mutate Device Library Plus `exportLibrary.db` files |

Database mutation commands require `--write`; databases otherwise open read-only. Commits refuse to run while Rekordbox is open unless `--allow-while-running` is also supplied. Generic `row create`, `row update`, and `row delete` commands expose mapped physical tables, while content, playlist, and tag commands cover common coordinated workflows.

Use `--plain` for an unencrypted SQLite fixture or unlocked copy. The built-in upstream keys handle standard databases; override them with `REKORDBOX_DB_KEY` or `REKORDBOX_DEVICE_DB_KEY` when necessary.

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
  const playlists = db.query(DjmdPlaylist).orderBy("Seq").all();
  const playlistTracks = playlists[0] ? db.getPlaylistTracks(playlists[0]) : [];
  console.log(tracks, first?.Artist?.Name, playlists, playlistTracks);
} finally {
  db.close();
}
```

Databases open read-only by default. For a write workflow, pass `readonly: false`, stage changes through helpers such as `createPlaylist`, `addToPlaylist`, `renamePlaylist`, or row `set`, then call `commit()`. `rollback()` restores staged rows. Commits are blocked while Rekordbox is running, and `copyUnlocked()` produces a new plain SQLite logical copy without modifying the encrypted source.

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

### Native analysis and database installation

The repository can build a universal macOS rehost helper that produces real `ANLZ0000.DAT`, `.EXT`,
and `.2EX` files without mutating the library. The public package does not include that helper or a
Rekordbox runtime; analysis discovers an explicit, PATH-installed, user-local, or repository-built
helper:

```sh
rekordbox analyze doctor --format json
rekordbox analyze track /Music/track.flac --output-directory /Music/track.rekordbox --format json
rekordbox analyze tracks \
  --audio-path /Music/one.flac \
  --audio-path /Music/two.flac \
  --concurrency 4 \
  --format json
```

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
runs a bounded pool of isolated native worker processes, preserves input order, and defaults to 64
workers or the number of uncached tracks, whichever is lower. Keep database installation separate
and serialized: call
`MasterDatabase.installContentAnalysis()` for each verified result only after analysis finishes.
Use `MasterDatabase.syncContentAnalysisMetadata()` for an already-installed result. Both methods
validate `analysis.json` and its source fingerprint; their result includes the analyzer tempo,
hundredths value, normalized key name, and resolved key ID. The set-import workflow persists this
summary in its durable manifest, post-verifies `BPM`, `KeyID`, and the active key name after reopening
the database, and treats missing or mismatched values as repairable checkpoint drift on a warm
resume.
The default favors minimum playlist wall time: a 30–60 track playlist can analyze every uncached
track concurrently. On a 12-core machine, 26 real set tracks took 60.02 seconds with four workers,
32.23 seconds with eight, and 28.83 seconds with twelve. A 64-default stress run completed 27
compatible real artifacts in 23.85 seconds at an effective concurrency of 27 (1.13 tracks/second).
Two additional source files returned the same native `startAnalyze` incompatibility alone at
concurrency one and were excluded from that timing. Higher concurrency consumes more CPU and memory;
pass `concurrency` explicitly to constrain resource use. Warm validation of all 26 cached analyses
took 11.65 ms. Analysis
requires macOS and Rosetta on Apple Silicon. The public package does not redistribute an analyzer
helper or AlphaTheta/Rekordbox runtime. Set `REKORDBOX_ANALYZER_BINARY`, place a locally built
`rekordbox-analyzer` on `PATH`, or pass `analyzerBinary`; `analyze doctor` validates that local
helper, offsets, cache, and signatures. `REKORDBOX_ANALYZER_APP` selects the user's compatible
`rekordbox.app`.

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
