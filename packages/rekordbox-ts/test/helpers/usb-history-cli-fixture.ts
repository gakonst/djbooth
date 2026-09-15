import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { LegacyDevicePdbWriter, inspectLegacyDevicePdb } from "../../src/devicelib/pdb.js";

const [mode, root, databasePath] = process.argv.slice(2);
if (!root || !databasePath) throw new Error("Expected mode, isolated USB root, and fake database");
const pdb = join(root, "PIONEER/rekordbox/export.pdb");
const marker = JSON.parse(readFileSync(join(root, ".music-cdj-export.json"), "utf8"));
if (mode === "play") {
  const writer = new LegacyDevicePdbWriter(readFileSync(pdb));
  const history = writer.createHistory("HISTORY 001");
  for (const contentID of ["2", "1", "2"]) {
    const mapping = marker.trackMap.find(
      (track: { contentId: string }) => track.contentId === contentID,
    );
    assert.ok(mapping);
    writer.addToHistory(history, mapping.pdbId);
  }
  writeFileSync(pdb, writer.build());
} else if (mode === "verify") {
  const database = new Database(databasePath, { readonly: true });
  try {
    const playlists = database
      .prepare("SELECT ID, Name FROM djmdPlaylist WHERE Name LIKE 'DJ Set %'")
      .all() as { ID: string; Name: string }[];
    assert.equal(playlists.length, 1);
    assert.deepEqual(
      database
        .prepare("SELECT ContentID FROM djmdSongPlaylist WHERE PlaylistID = ? ORDER BY TrackNo")
        .all(playlists[0]!.ID),
      [{ ContentID: "2" }, { ContentID: "1" }, { ContentID: "2" }],
    );
    assert.deepEqual(
      database.prepare("SELECT ID, DJPlayCount FROM djmdContent ORDER BY ID").all(),
      [
        { ID: "1", DJPlayCount: "3" },
        { ID: "2", DJPlayCount: "2" },
      ],
    );
    const inspection = inspectLegacyDevicePdb(readFileSync(pdb));
    assert.equal(inspection.histories.length, 0);
    assert.equal(marker.importedHistories.length, 1);
    const exported = inspection.playlists.find((playlist) => playlist.name === playlists[0]!.Name);
    assert.ok(exported);
    assert.deepEqual(
      exported.trackIds.map((id) => inspection.tracks.find((track) => track.id === id)!.title),
      ["Second", "First", "Second"],
    );
    console.log(
      "Verified one imported history, repeated track order, and exactly-once play counts.",
    );
  } finally {
    database.close();
  }
} else throw new Error("Expected play or verify");
