# rekordbox-ts

A TypeScript port of [dylanljones/pyrekordbox](https://github.com/dylanljones/pyrekordbox), with a synchronous typed database API and an agent-friendly CLI built on [wevm/incur](https://github.com/wevm/incur).

The primary workflow is direct access to encrypted Rekordbox 6/7 `master.db` libraries through `MasterDatabase`. The port also covers Device Library Plus databases, ANLZ analysis files, My Settings binaries, smart playlists, `masterPlaylists6.xml`, and collection XML interchange. The pinned Python revision, compatibility policy, verification evidence, and implementation decisions are recorded in [PORTING.md](./PORTING.md).

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
pnpm i -g --allow-build=better-sqlite3-multiple-ciphers "$(pwd)"
rekordbox --help
```

The global install exposes `rekordbox` as the canonical command and `rekordbox-ts` as an explicit package-name alias. A GitHub install works as well when Git authentication can access the private repository:

```sh
pnpm i -g --allow-build=better-sqlite3-multiple-ciphers github:gakonst/rekordbox-ts
rekordbox status
```

`better-sqlite3-multiple-ciphers` is the one native dependency and provides encrypted SQLCipher access. pnpm 10 requires the explicit `--allow-build` acknowledgement shown above; without it, command discovery works but database commands cannot load the native binding. For development without a global install, use `pnpm cli --help`.

## CLI

```sh
# The main flow: discover, query, and manage the Rekordbox master database
rekordbox config show
rekordbox db info
rekordbox db search "track name"
rekordbox db playlist contents 123456

# Read an encrypted Device Library Plus export
rekordbox device info --path /Volumes/USB/PIONEER/rekordbox/exportLibrary.db

# Work with secondary/interchange formats when needed
rekordbox anlz info ANLZ0000.DAT
rekordbox settings show MYSETTING.DAT
rekordbox xml info collection.xml
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

## Development and verification

```sh
pnpm validate
```

The suite includes fixed Python-compatible vectors, generated database fixtures, encrypted SQLCipher opening, mutation/rollback behavior, and exact differential verification against the pinned upstream fixtures. See [PORTING.md](./PORTING.md) for the full evidence log.

## License

MIT. This is an independent TypeScript port. The original pyrekordbox copyright and license notice are retained in [LICENSE](./LICENSE).
