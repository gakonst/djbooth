import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { decodePath, encodePath, Node, RekordboxXml, XmlDuplicateError } from "../src/xml/index.js";

const fixture = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0">
  <PRODUCT Name="rekordbox" Version="7.0.9" Company="AlphaTheta"/>
  <COLLECTION Entries="2">
    <TRACK TrackID="7" Name="Track One" Artist="Artist" AverageBpm="128.00" Rating="204" Location="file://localhost/C:/Music/Track%20One.mp3" Custom="preserved">
      <TEMPO Inizio="0.025" Bpm="128.0" Metro="4/4" Battito="1"/>
      <POSITION_MARK Name="Cue" Type="0" Start="1.25" Num="-1"/>
      <UNKNOWN value="keep-me"/>
    </TRACK>
    <TRACK TrackID="11" Name="Track Two" Rating="0" Location="file://localhost/C:/Music/Track%20Two.mp3"/>
  </COLLECTION>
  <PLAYLISTS>
    <NODE Name="ROOT" Type="0" Count="2">
      <NODE Name="Folder" Type="0" Count="1">
        <NODE Name="Nested" Type="1" KeyType="0" Entries="1"><TRACK Key="7"/></NODE>
      </NODE>
      <NODE Name="Locations" Type="1" KeyType="1" Entries="1"><TRACK Key="C:/Music/Track Two.mp3"/></NODE>
    </NODE>
  </PLAYLISTS>
</DJ_PLAYLISTS>`;

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixturePath(): string {
  const root = mkdtempSync(join(tmpdir(), "rekordbox-ts-xml-"));
  roots.push(root);
  const path = join(root, "database.xml");
  writeFileSync(path, fixture);
  return path;
}

describe("path encoding", () => {
  it("matches the Rekordbox file URL representation", () => {
    const path = "C:\\Music\\PioneerDJ\\Demo Tracks\\Rock & Roll #1.mp3";
    const encoded =
      "file://localhost/C:/Music/PioneerDJ/Demo%20Tracks/Rock%20%26%20Roll%20%231.mp3";
    expect(encodePath(path)).toBe(encoded);
    expect(decodePath(encoded)).toContain(
      normalize("C:/Music/PioneerDJ/Demo Tracks/Rock & Roll #1.mp3"),
    );
  });
});

describe("RekordboxXml", () => {
  it("parses typed tracks, beat grids, marks, and playlists", () => {
    const xml = new RekordboxXml(fixturePath());
    expect(xml.numTracks).toBe(2);
    expect(xml.productName).toBe("rekordbox");
    expect(xml.getTrackIds()).toEqual([7, 11]);

    const track = xml.getTrack({ trackId: 7 });
    expect(track.Name).toBe("Track One");
    expect(track.AverageBpm).toBe(128);
    expect(track.Rating).toBe(4);
    expect(track.Location).toBe(normalize("C:/Music/Track One.mp3"));
    expect(track.tempos[0]?.Battito).toBe(1);
    expect(track.marks[0]?.Type).toBe("cue");

    const nested = xml.getPlaylist("Folder", "Nested");
    expect(nested.isPlaylist).toBe(true);
    expect(nested.keyType).toBe("TrackID");
    expect(nested.getTracks()).toEqual([7]);
    expect(xml.getPlaylist("Locations").getTracks()).toEqual(["C:/Music/Track Two.mp3"]);
  });

  it("adds unique tracks with monotonic IDs and typed nested elements", () => {
    const xml = new RekordboxXml(fixturePath());
    const track = xml.addTrack("C:/Music/New Track.mp3", { Name: "New Track", Rating: 5 });
    expect(track.TrackID).toBe(12);
    expect(track.Rating).toBe(5);
    expect(xml.numTracks).toBe(3);

    track.addTempo(0, 120);
    track.addMark("Loop", "loop", 4, 8, 0);
    expect(track.tempos).toHaveLength(1);
    expect(track.marks[0]?.End).toBe(8);

    expect(() => xml.addTrack("C:/Music/New Track.mp3")).toThrow(XmlDuplicateError);
    expect(() => xml.addTrack("C:/Music/Other.mp3", { TrackID: 7 })).toThrow(XmlDuplicateError);
  });

  it("updates playlist counts and entries", () => {
    const xml = new RekordboxXml();
    const folder = xml.addPlaylistFolder("Folder");
    const playlist = folder.addPlaylist("Set");
    expect(folder.count).toBe(1);
    expect(playlist).toBeInstanceOf(Node);
    expect(playlist.parent).toBe(folder.element);

    expect(playlist.addTrack(1)).toBeTypeOf("object");
    playlist.addTrack(2);
    expect(playlist.entries).toBe(2);
    expect(playlist.getTrack(1)).toBe(1);
    expect(playlist.removeTrack(1)).toBeTypeOf("object");
    expect(playlist.getTracks()).toEqual([2]);
    folder.removePlaylist("Set");
    expect(folder.count).toBe(0);
  });

  it("preserves unknown elements and attributes across save/reload", () => {
    const path = fixturePath();
    const xml = new RekordboxXml(path);
    const output = join(roots.at(-1)!, "saved.xml");
    xml.save(output);

    const serialized = new RekordboxXml(output).toString();
    expect(serialized).toContain('Custom="preserved"');
    expect(serialized).toContain('<UNKNOWN value="keep-me"/>');
    expect(new RekordboxXml(output).numTracks).toBe(xml.numTracks);
  });

  it("removes tracks and maintains collection count", () => {
    const xml = new RekordboxXml(fixturePath());
    xml.removeTrack(xml.getTrack(0));
    expect(xml.numTracks).toBe(1);
    expect(xml.getTrackIds()).toEqual([11]);
  });
});
