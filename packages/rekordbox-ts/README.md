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
  console.log(tracks, first?.Artist?.Name, playlists);
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

The package includes a universal macOS helper and the minimal Rekordbox 6.8.2.0018 runtime payload
needed to rehost its analyzer. It produces real `ANLZ0000.DAT`, `.EXT`, and `.2EX` files without
mutating the library:

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

Programmatically, use `analyzeTrack()` or the nonblocking `analyzeTrackAsync()`. `analyzeTracks()`
runs a bounded pool of isolated native worker processes, preserves input order, and defaults to at
most four workers. Keep database installation separate and serialized: call
`MasterDatabase.installContentAnalysis()` for each verified result only after analysis finishes.
Analysis requires macOS and Rosetta on Apple Silicon. `analyze doctor` validates the vendored binary
hash, offsets, cache, and signatures. `REKORDBOX_ANALYZER_APP` can explicitly select another
compatible `rekordbox.app`.

Release and preview workflows run on macOS, rebuild and ad-hoc sign both analyzer architectures,
package the minimal runtime, install the packed package in a clean consumer, and require the packed
`analyze doctor` check to pass. Sanitized DAT/EXT seed shapes are packaged with the runtime, so a new
machine needs Node.js, pnpm, and Rosetta on Apple Silicon; it does not need a separate Rekordbox
installation or an existing analyzed Rekordbox library for the pinned analyzer runtime.

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
