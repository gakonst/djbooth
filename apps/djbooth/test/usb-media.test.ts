import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LegacyDevicePdbWriter } from "@gakonst/rekordbox/devicelib";
import { afterEach, describe, expect, it } from "vitest";

import { MountedUsbMediaService } from "../src/server/usb-media.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function mountRoot(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "djbooth-usb-media-"));
  roots.push(root);
  return root;
}

describe("mounted USB media", () => {
  it("reads Rekordbox playlists, history, metadata, and playable paths", async () => {
    const root = mountRoot();
    const mountPath = join(root, "MIXSTICK");
    const rekordboxPath = join(mountPath, "PIONEER", "rekordbox");
    const audioPath = join(mountPath, "Contents", "Artist", "first.flac");
    mkdirSync(rekordboxPath, { recursive: true });
    mkdirSync(join(mountPath, "Contents", "Artist"), { recursive: true });
    mkdirSync(join(mountPath, "PIONEER", "USBANLZ", "P001", "00000001"), {
      recursive: true,
    });
    writeFileSync(audioPath, "audio");
    writeFileSync(
      join(mountPath, "PIONEER", "USBANLZ", "P001", "00000001", "ANLZ0000.DAT"),
      waveformAnlz([2, 8, 31, 16]),
    );

    const writer = new LegacyDevicePdbWriter();
    const first = writer.addTrack({
      title: "First Light",
      artist: "Test Artist",
      album: "Test Album",
      genre: "House",
      key: "Am",
      filePath: "/Contents/Artist/first.flac",
      analyzePath: "/PIONEER/USBANLZ/P001/00000001/ANLZ0000.DAT",
      tempo: 12_450,
      duration: 301,
      playCount: 4,
    });
    const missing = writer.addTrack({
      title: "Missing Audio",
      filePath: "/Contents/Artist/missing.mp3",
    });
    const folder = writer.createPlaylist("Sets", { folder: true });
    const playlistId = writer.createPlaylist("Friday Night", { parentId: folder });
    writer.addToPlaylist(playlistId, missing);
    writer.addToPlaylist(playlistId, first);
    const historyId = writer.createHistory("HISTORY 001");
    writer.addToHistory(historyId, first);
    writeFileSync(join(rekordboxPath, "export.pdb"), writer.build());

    const service = new MountedUsbMediaService({ mountRoots: [root] });
    const media = await service.scan();

    expect(media.devices).toEqual([
      expect.objectContaining({
        name: "MIXSTICK",
        mountPath,
        libraryFormat: "device-library",
        status: "ready",
        tracks: 2,
        playlists: 1,
        histories: 1,
      }),
    ]);
    expect(media.devices[0]!.totalBytes).toBeGreaterThan(0);
    expect(media.playlists).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "All tracks", trackCount: 2 }),
        expect.objectContaining({ name: "Sets", type: "folder" }),
        expect.objectContaining({ name: "Friday Night", trackCount: 2 }),
        expect.objectContaining({ name: "Play History", type: "folder" }),
        expect.objectContaining({ name: "HISTORY 001", trackCount: 1 }),
      ]),
    );

    const playlist = media.playlists.find((item) => item.name === "Friday Night")!;
    const tracks = await service.getTracks(playlist.id);
    expect(tracks).toEqual([
      expect.objectContaining({
        title: "Missing Audio",
        fileExists: false,
        trackNumber: 1,
      }),
      expect.objectContaining({
        title: "First Light",
        artist: "Test Artist",
        bpm: 124.5,
        durationSeconds: 301,
        playCount: 4,
        fileExists: true,
        path: audioPath,
        trackNumber: 2,
      }),
    ]);
    await expect(service.getAudioPath(tracks[1]!.id)).resolves.toBe(audioPath);
    await expect(service.getAudioPath(tracks[0]!.id)).rejects.toThrow("is not available");
    await expect(service.getWaveform(tracks[1]!.id)).resolves.toMatchObject({
      durationSeconds: 301,
      peaks: [0.0645, 0.2581, 1, 0.5161],
      source: "rekordbox",
    });
  });

  it("reports unfinished syncs and empty mounted volumes without reading staging data", async () => {
    const root = mountRoot();
    mkdirSync(join(root, "PREPARING", ".music-cdj-playlist-staging-test"), {
      recursive: true,
    });
    mkdirSync(join(root, "EMPTY"));

    const media = await new MountedUsbMediaService({ mountRoots: [root] }).scan();

    expect(media.devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "PREPARING", status: "staging" }),
        expect.objectContaining({ name: "EMPTY", status: "empty" }),
      ]),
    );
    expect(media.playlists).toEqual([]);
  });
});

function waveformAnlz(heights: number[]): Buffer {
  const tag = Buffer.alloc(20 + heights.length);
  tag.write("PWAV", 0, "ascii");
  tag.writeUInt32BE(20, 4);
  tag.writeUInt32BE(tag.length, 8);
  tag.writeUInt32BE(heights.length, 12);
  heights.forEach((height, index) => tag.writeUInt8(height & 0x1f, 20 + index));
  const file = Buffer.alloc(28 + tag.length);
  file.write("PMAI", 0, "ascii");
  file.writeUInt32BE(28, 4);
  file.writeUInt32BE(file.length, 8);
  tag.copy(file, 28);
  return file;
}
