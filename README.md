# rekordbox-ts

A TypeScript port of [dylanljones/pyrekordbox](https://github.com/dylanljones/pyrekordbox), with a synchronous typed library API and an agent-friendly CLI built on [wevm/incur](https://github.com/wevm/incur).

The port covers Rekordbox configuration discovery, collection XML, ANLZ analysis files, My Settings binaries, smart playlists, encrypted Rekordbox 6/7 master databases, `masterPlaylists6.xml`, and encrypted Device Library Plus exports. The pinned Python revision, compatibility policy, verification evidence, and implementation decisions are recorded in [PORTING.md](./PORTING.md).

> [!CAUTION]
> Back up your Rekordbox collection before using any write operation. This project is not affiliated with AlphaTheta Corporation, Pioneer Corporation, or their related companies.

## Requirements and setup

- Node.js 22 or newer
- pnpm 10
- macOS, Windows, or Linux; automatic Rekordbox installation discovery is implemented for macOS and Windows

```sh
git clone git@github.com:gakonst/rekordbox-ts.git
cd rekordbox-ts
pnpm install
pnpm build
pnpm cli --help
```

Use the local executable through `pnpm cli`, or link/install the package and invoke `rekordbox` directly.

## CLI

```sh
# Inspect discovered Rekordbox installations
pnpm cli config show

# Inspect collection formats
pnpm cli xml info collection.xml
pnpm cli anlz info ANLZ0000.DAT
pnpm cli settings show MYSETTING.DAT

# Read an encrypted Rekordbox 6/7 master database
pnpm cli db info --path /path/to/master.db
pnpm cli db search "track name" --path /path/to/master.db

# Read an encrypted Device Library Plus export
pnpm cli device info --path /Volumes/USB/PIONEER/rekordbox/exportLibrary.db
pnpm cli device playlist contents 12 --path /path/to/exportLibrary.db
```

Top-level command families:

| Command     | Purpose                                                       |
| ----------- | ------------------------------------------------------------- |
| `config`    | Discover Rekordbox 5/6/7 installations and library paths      |
| `xml`       | Inspect and mutate collection tracks and playlists            |
| `anlz`      | Scan, inspect, and mutate DAT/EXT/2EX analysis files          |
| `settings`  | Read, update, and create all four My Settings binary formats  |
| `smartlist` | Parse, construct, and compile smart playlists                 |
| `db`        | Query and mutate the Rekordbox 6/7 master database            |
| `device`    | Query and mutate Device Library Plus `exportLibrary.db` files |

Database mutation commands require `--write`; databases otherwise open read-only. Commits refuse to run while Rekordbox is open unless `--allow-while-running` is also supplied. Generic `row create`, `row update`, and `row delete` commands expose mapped physical tables, while content, playlist, and tag commands cover common coordinated workflows.

Use `--plain` for an unencrypted SQLite fixture or unlocked copy. The built-in upstream keys handle standard databases; override them with `REKORDBOX_DB_KEY` or `REKORDBOX_DEVICE_DB_KEY` when necessary.

incur provides structured output and discovery on every command:

```sh
pnpm cli --llms                 # LLM-readable command manifest
pnpm cli db info --schema       # input/output JSON Schema
pnpm cli db info --format json  # JSON, TOON, YAML, Markdown, or JSONL
pnpm cli db info --token-limit 500
```

## TypeScript API

The root entry point exports the common API. Format-specific subpaths avoid name collisions such as the separate master/device `Content`, `PlaylistType`, and `FileType` models.

### Collection XML

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

Unknown XML attributes and elements are retained when a document is rebuilt.

### ANLZ and My Settings

```ts
import { AnlzFile, PQTZAnlzTag } from "@gakonst/rekordbox/anlz";
import { readMySettingFile } from "@gakonst/rekordbox/mysettings";

const anlz = AnlzFile.parseFile("ANLZ0000.DAT");
const grid = anlz.getTag("PQTZ") as PQTZAnlzTag;
grid.setBpms(grid.getBpms().map(() => 128));
anlz.save("ANLZ0000-updated.DAT");

const settings = readMySettingFile("MYSETTING.DAT");
settings.set("quantize", "ON");
settings.save("MYSETTING-updated.DAT");
```

Untouched ANLZ tags and opaque My Settings bytes round-trip losslessly. Supported mutations recalculate lengths and checksums.

### Master database

```ts
import { DjmdContent, MasterDatabase } from "@gakonst/rekordbox/masterdb";

const db = new MasterDatabase({ path: "/path/to/master.db", readonly: true });
try {
  const tracks = db.searchContent("Orbital");
  const first = db.query(DjmdContent).orderBy("ID").first();
  console.log(tracks, first?.Artist?.Name);
} finally {
  db.close();
}
```

For a write workflow, open with `readonly: false`, stage mutations, then call `commit()`. `rollback()` restores staged rows. `copyUnlocked()` creates a new plain SQLite logical copy without modifying the encrypted source.

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

## Development and verification

```sh
pnpm validate
```

The suite includes fixed Python-compatible vectors, generated database fixtures, encrypted SQLCipher opening, mutation/rollback behavior, and exact differential verification against the pinned upstream fixtures. See [PORTING.md](./PORTING.md) for the full evidence log.

## License

MIT. This is an independent TypeScript port. The original pyrekordbox copyright and license notice are retained in [LICENSE](./LICENSE).
