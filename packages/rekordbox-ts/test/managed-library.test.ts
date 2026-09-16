import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { MasterDatabase, DjmdContent, DjmdPlaylist } from "../src/masterdb/index.js";

test("a fresh encrypted cloud library supports normal writes and an online restorable backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "djbooth-managed-"));
  try {
    const path = join(root, "master.db");
    const db = MasterDatabase.createManaged(path);
    try {
      const audio = join(root, "track.wav");
      await writeFile(audio, "test audio artifact");
      const artist = db.addArtist("Artist");
      const album = db.addAlbum("Album", { artist });
      const track = db.addContent(audio, {
        Title: "Track",
        ArtistID: artist.ID,
        AlbumID: album.ID,
        BPM: 12800,
      });
      const folder = db.createPlaylistFolder("Imports");
      const playlist = db.createPlaylist("Set", { parent: folder });
      db.addToPlaylist(playlist, track, 1);
      db.commit();
      expect(db.playlistXml?.get(playlist.ID)).toBeDefined();
      await db.backup(join(root, "backup.db"));
      const restored = new MasterDatabase({ path: join(root, "backup.db") });
      try {
        expect(restored.query(DjmdContent).one().Title).toBe("Track");
        expect(restored.query(DjmdPlaylist).count()).toBe(2);
        expect(restored.playlistXml?.get(playlist.ID)).toBeDefined();
      } finally {
        restored.close();
      }
      expect(() => MasterDatabase.createManaged(path)).toThrow("Refusing");
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
