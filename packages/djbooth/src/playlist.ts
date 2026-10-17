import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { playlistCli } from "@gakonst/rekordbox/cli";
import { analyzeTracks } from "@gakonst/rekordbox/analyzer";
import { DeviceLibraryPlus, Playlist, PlaylistContent } from "@gakonst/rekordbox/devicelib-plus";
import {
  DjmdAlbum,
  DjmdArtist,
  DjmdContent,
  DjmdGenre,
  DjmdLabel,
  DjmdPlaylist,
  DjmdSongPlaylist,
  MasterDatabase,
} from "@gakonst/rekordbox/masterdb";
import {
  defaultTrackLibraryRoot,
  importManifestToRekordbox,
  RekordboxPipelineStore,
  sha256File,
} from "@gakonst/tracks";
import { z } from "incur";

playlistCli.command("ready", {
  description:
    "Make downloaded import tracks available in their ordered playlist while acquisition continues.",
  args: z.object({ source: z.string().describe("Source URL of an existing import") }),
  options: z.object({
    path: z.string().optional().describe("Rekordbox master.db path"),
    folderName: z.string().optional().describe("Destination playlist folder"),
    playlistName: z.string().optional().describe("Destination playlist name"),
  }),
  async run({ args, options }) {
    const store = new RekordboxPipelineStore({
      source: args.source,
      outputDirectory: defaultTrackLibraryRoot(),
      ...(options.path ? { dbPath: options.path } : {}),
    });
    const manifest = await store.load();
    if (!manifest) throw new Error("No import found for this source");
    const total = manifest.entries.length;
    manifest.entries = manifest.entries.filter(
      (entry) => entry.acquisition.status === "downloaded",
    );
    const skipped: number[] = [];
    const verified = await Promise.all(
      manifest.entries.map(async (entry) => {
        if (entry.acquisition.status !== "downloaded") return false;
        for (const item of [
          entry.acquisition.download,
          ...(entry.acquisition.alternatives ?? []),
        ]) {
          const actual = await sha256File(resolve(store.artifactDirectory, item.mediaPath)).catch(
            () => undefined,
          );
          if (!actual || actual !== item.sha256) {
            skipped.push(entry.order);
            return false;
          }
        }
        return true;
      }),
    );
    manifest.entries = manifest.entries.filter((_, index) => verified[index]);
    if (!manifest.entries.length) throw new Error("No tracks have downloaded yet");
    const paths = [
      ...new Set(
        manifest.entries.flatMap((entry) =>
          entry.acquisition.status === "downloaded"
            ? [entry.acquisition.download, ...(entry.acquisition.alternatives ?? [])].map((item) =>
                resolve(store.artifactDirectory, item.mediaPath),
              )
            : [],
        ),
      ),
    ];
    process.stderr.write(`[playlist] analyzing ${paths.length} downloaded recordings\n`);
    const analysis = await analyzeTracks(paths, {
      rhythmMode: "auto",
      onProgress(progress) {
        process.stderr.write(
          `[analysis] ${progress.phase} ${progress.completed}/${progress.total}\n`,
        );
      },
    });
    process.stderr.write(`[playlist] updating ${manifest.entries.length}/${total} tracks\n`);
    const result = await importManifestToRekordbox({
      manifest,
      dbPath: store.location.dbPath,
      dbDirectory: store.location.dbDirectory,
      mediaBaseDirectory: store.artifactDirectory,
      ...(options.folderName ? { folderName: options.folderName } : {}),
      ...(options.playlistName ? { playlistName: options.playlistName } : {}),
      analysisDirectories: Object.fromEntries(
        analysis.results.map((item, index) => [paths[index]!, dirname(item.summaryPath)]),
      ),
    });
    // Acquisition owns the pipeline snapshot. Do not overwrite its concurrent
    // progress with this partial view; the normal import reuses these rows.
    process.stderr.write(`[complete] ${result.imported.length}/${total} tracks available\n`);
    return {
      playlistId: result.playlistId,
      playlistName: result.plan.playlistName,
      available: result.imported.length,
      total,
      skipped,
      tracks: result.imported,
    };
  },
});

playlistCli.command("restore-usb", {
  description:
    "Restore OneLibrary playlists and structured metadata for audio already copied into the library.",
  hint: "Reads the USB without modifying it. Rerun after audio import to fill pending memberships.",
  args: z.object({ mount: z.string().describe("Mounted USB volume") }),
  options: z.object({
    path: z.string().describe("Destination master.db"),
    libraryDirectory: z
      .string()
      .describe("Hash-addressed directory used by playlist add --copy-to"),
    structureOnly: z
      .boolean()
      .default(false)
      .describe(
        "Restore folders and playlist names immediately without scanning audio or changing memberships",
      ),
    progress: z.enum(["auto", "always", "never"]).default("auto"),
  }),
  async run({ args, options }) {
    let phase = "inspect";
    let current = 0;
    let total = 1;
    const emit = () => {
      if (options.progress === "never" || (options.progress === "auto" && !process.stderr.isTTY))
        return;
      try {
        process.stderr.write(`[${phase}] ${current}/${total}\n`);
      } catch {
        /* Progress is diagnostic. */
      }
    };
    emit();
    const timer = setInterval(emit, 5000);
    timer.unref();
    try {
      const mount = await realpath(args.mount);
      const libraryDirectory = await realpath(options.libraryDirectory);
      const source = new DeviceLibraryPlus(join(mount, "PIONEER/rekordbox/exportLibrary.db"));
      source.open();
      let playlists: Array<{
        id: number;
        parent: number;
        name: string;
        sequence: number;
        folder: boolean;
      }>;
      let memberships: Array<{ playlist: number; content: number; sequence: number }>;
      let contents: Array<{
        content_id: number;
        path: string;
        title: string | null;
        artist: string | null;
        album: string | null;
        albumArtist: string | null;
        genre: string | null;
        label: string | null;
        releaseYear: number | null;
        trackNo: number | null;
        djComment: string | null;
      }>;
      try {
        playlists = source
          .query(Playlist)
          .all()
          .map((row) => ({
            id: row.playlist_id,
            parent: row.playlist_id_parent ?? 0,
            name: row.name,
            sequence: row.sequenceNo,
            folder: row.attribute === 1,
          }))
          .sort((a, b) => a.sequence - b.sequence || a.id - b.id);
        memberships = source
          .query(PlaylistContent)
          .all()
          .map((row) => ({
            playlist: row.playlist_id,
            content: row.content_id,
            sequence: row.sequenceNo,
          }))
          .sort((a, b) => a.sequence - b.sequence);
        // Read only relevant columns: hardware exports can contain invalid date fields.
        contents = source
          .connection!.prepare(`SELECT c.content_id, c.path, c.title,
            ar.name AS artist, al.name AS album, aa.name AS albumArtist,
            g.name AS genre, l.name AS label, c.releaseYear, c.trackNo, c.djComment
            FROM content c
            LEFT JOIN artist ar ON ar.artist_id = c.artist_id_artist
            LEFT JOIN album al ON al.album_id = c.album_id
            LEFT JOIN artist aa ON aa.artist_id = al.artist_id
            LEFT JOIN genre g ON g.genre_id = c.genre_id
            LEFT JOIN label l ON l.label_id = c.label_id`)
          .all() as typeof contents;
      } finally {
        source.close();
      }
      const byId = new Map(playlists.map((row) => [row.id, row]));
      for (const row of playlists) {
        const seen = new Set([row.id]);
        let parent = row.parent;
        while (parent !== 0) {
          const ancestor = byId.get(parent);
          if (!ancestor?.folder || seen.has(parent))
            throw new Error(`Invalid USB playlist parent for ${row.name}`);
          seen.add(parent);
          parent = ancestor.parent;
        }
      }
      phase = "match-audio";
      current = 0;
      total = options.structureOnly ? 0 : contents.length;
      emit();
      const copiedPaths = new Map<number, string>();
      for (const content of options.structureOnly ? [] : contents) {
        const relative = content.path.replace(/^[/\\]+/u, "");
        const candidate = resolve(mount, relative);
        if (
          !relative ||
          relative.split(/[/\\]+/u).includes("..") ||
          !candidate.startsWith(`${mount}${sep}`)
        ) {
          throw new Error(`USB content ${content.content_id} has an invalid path`);
        }
        try {
          const original = await realpath(candidate);
          if (!original.startsWith(`${mount}${sep}`))
            throw new Error("USB audio symlink leaves the volume");
          const hash = await sha256File(original);
          const copy = join(libraryDirectory, hash, basename(original));
          if ((await stat(copy)).isFile() && (await sha256File(copy)) === hash)
            copiedPaths.set(content.content_id, copy);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        current++;
        if (current % 25 === 0) emit();
      }
      phase = "restore-playlists";
      current = 0;
      total = playlists.length;
      emit();
      const db = new MasterDatabase({ path: options.path, readonly: false });
      try {
        db.executeSql(`CREATE TABLE IF NOT EXISTS djbooth_usb_playlists (
          source_mount TEXT NOT NULL, source_id INTEGER NOT NULL, playlist_id TEXT NOT NULL,
          PRIMARY KEY (source_mount, source_id))`);
        const mapping = new Map(
          db
            .selectRawRows<{ source_id: number; playlist_id: string }>(
              "SELECT source_id, playlist_id FROM djbooth_usb_playlists WHERE source_mount = ?",
              [mount],
            )
            .map((row) => [row.source_id, row.playlist_id]),
        );
        const mapped = (id: number) => {
          const target = mapping.get(id);
          return target ? db.query(DjmdPlaylist).where({ ID: target }).oneOrNone() : undefined;
        };
        const root = mapped(-1) ?? db.createPlaylistFolder(`USB - ${basename(mount)} playlists`);
        if (root.Attribute !== 1) throw new Error("Restored USB root is no longer a folder");
        mapping.set(-1, root.ID);
        const targetRows = new Map<number, DjmdPlaylist>([[0, root]]);
        const ensure = (id: number): DjmdPlaylist => {
          const cached = targetRows.get(id);
          if (cached) return cached;
          const row = byId.get(id)!;
          const parent = ensure(row.parent);
          const target =
            mapped(id) ??
            (row.folder
              ? db.createPlaylistFolder(row.name, { parent })
              : db.createPlaylist(row.name, { parent }));
          if (target.Attribute !== (row.folder ? 1 : 0))
            throw new Error(`Restored playlist type changed: ${row.name}`);
          if (target.Name !== row.name) db.renamePlaylist(target, row.name);
          target.ParentID = parent.ID;
          targetRows.set(id, target);
          mapping.set(id, target.ID);
          return target;
        };
        const contentIds = new Map<number, string>();
        const artistId = (name: string | null) =>
          name
            ? (db.query(DjmdArtist).where({ Name: name }).oneOrNone() ?? db.addArtist(name)).ID
            : null;
        for (const row of contents) {
          const path = copiedPaths.get(row.content_id);
          if (!path) continue;
          const content = db.query(DjmdContent).where({ FolderPath: path }).oneOrNone();
          if (!content) continue;
          contentIds.set(row.content_id, content.ID);
          if (row.title) content.Title = row.title;
          if (row.artist) content.ArtistID = artistId(row.artist);
          if (row.album) {
            const albumArtist = artistId(row.albumArtist);
            content.AlbumID = (
              db
                .query(DjmdAlbum)
                .where({ Name: row.album, AlbumArtistID: albumArtist })
                .oneOrNone() ?? db.addAlbum(row.album, albumArtist ? { artist: albumArtist } : {})
            ).ID;
          }
          if (row.genre)
            content.GenreID = (
              db.query(DjmdGenre).where({ Name: row.genre }).oneOrNone() ?? db.addGenre(row.genre)
            ).ID;
          if (row.label)
            content.LabelID = String(
              (
                db.query(DjmdLabel).where({ Name: row.label }).oneOrNone() ?? db.addLabel(row.label)
              ).get("ID"),
            );
          if (row.releaseYear) content.ReleaseYear = row.releaseYear;
          if (row.trackNo) content.TrackNo = row.trackNo;
          if (row.djComment) content.Commnt = row.djComment;
        }
        const results = playlists.map((row) => {
          const target = ensure(row.id);
          const sourceMembers = memberships.filter((member) => member.playlist === row.id);
          const desired = sourceMembers.flatMap((member) => contentIds.get(member.content) ?? []);
          let available = desired.length;
          if (!row.folder) {
            const existing = db
              .query(DjmdSongPlaylist)
              .where({ PlaylistID: target.ID })
              .orderBy("TrackNo")
              .all();
            if (options.structureOnly) available = existing.length;
            for (
              let index = 0;
              !options.structureOnly && index < Math.max(existing.length, desired.length);
              index++
            ) {
              const song = existing[index];
              const content = desired[index];
              if (song && content) {
                song.ContentID = content;
                song.TrackNo = index + 1;
              } else if (song) db.delete(song);
              else if (content) db.addToPlaylist(target, content);
            }
          }
          current++;
          emit();
          return {
            sourceId: row.id,
            playlistId: target.ID,
            name: row.name,
            available,
            total: sourceMembers.length,
          };
        });
        // Creating siblings can shift existing sequence numbers. Order only after all exist.
        for (const row of playlists) {
          targetRows.get(row.id)!.Seq =
            playlists
              .filter((sibling) => sibling.parent === row.parent)
              .findIndex((sibling) => sibling.id === row.id) + 1;
        }
        db.flush();
        for (const [id, playlistId] of mapping)
          db.executeSql(
            "INSERT INTO djbooth_usb_playlists VALUES (?, ?, ?) ON CONFLICT(source_mount, source_id) DO UPDATE SET playlist_id = excluded.playlist_id",
            [mount, id, playlistId],
          );
        db.commit();
        phase = "complete";
        emit();
        return {
          folder: root.Name,
          folderId: root.ID,
          playlists: results,
          pendingMemberships: results.reduce((sum, row) => sum + row.total - row.available, 0),
        };
      } finally {
        db.close();
      }
    } finally {
      clearInterval(timer);
    }
  },
});

export { playlistCli };
