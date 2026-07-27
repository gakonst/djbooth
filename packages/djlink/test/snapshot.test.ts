import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { createManifest } from "@gakonst/tracks";
import { afterEach, describe, expect, it } from "vitest";

import { buildDjLinkSnapshot, resolveDjLinkTrack, stableId } from "../src/snapshot.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("DJ Link manifest projection", () => {
  it("uses the same stable positive FNV identity as the imported Rust server", () => {
    expect(stableId("Artist")).toBe(343_332_862);
    expect(stableId("")).toBe(0);
  });

  it("projects downloaded audio and native analysis into one ordered playlist", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "music-djlink-snapshot-"));
    temporaryRoots.push(root);
    const mediaPath = resolve(root, "Artist - Track.mp3");
    const analysisRoot = resolve(root, "Artist - Track.rekordbox");
    const summaryPath = resolve(analysisRoot, "analysis.json");
    const manifestPath = resolve(root, "manifest.json");
    await mkdir(analysisRoot);
    await writeFile(mediaPath, Buffer.alloc(32_000, 1));
    for (const name of ["ANLZ0000.DAT", "ANLZ0000.EXT", "ANLZ0000.2EX"]) {
      await writeFile(resolve(analysisRoot, name), Buffer.from(name));
    }
    await writeFile(summaryPath, "{}\n");
    const media = await stat(mediaPath);

    const manifest = createManifest({
      source: "https://example.com/set",
      provider: "description",
      title: "Test Set",
      complete: true,
      tracks: [
        { order: 1, artist: "Raw Artist", title: "Raw Track" },
        { order: 2, artist: "Missing Artist", title: "Missing Track" },
      ],
    });
    manifest.entries[0]!.spotify = {
      status: "matched",
      query: "Raw Artist - Raw Track",
      score: 0.99,
      id: "spotify-track-id",
      uri: "spotify:track:spotify-track-id",
      name: "Track",
      artists: ["Artist"],
      album: "Album",
      releaseDate: "2024-05-01",
      durationMs: 240_000,
    };
    manifest.entries[0]!.acquisition = {
      status: "downloaded",
      download: {
        backend: "local",
        kind: "individual",
        mediaPath,
        files: [mediaPath],
        source: "soulseek://peer/file",
      },
    };
    manifest.artifacts.analysis = [
      {
        mediaPath,
        summaryPath,
        backend: "rekordbox-test",
        tempoBpm: 123.45,
        key: "Bm",
        keySource: "test",
        sourceMtimeMs: media.mtimeMs,
        sourceSize: media.size,
      },
    ];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const snapshot = await buildDjLinkSnapshot(manifestPath);

    expect(snapshot.tracks).toHaveLength(1);
    expect(snapshot.playlists).toHaveLength(1);
    expect(snapshot.playlists[0]?.tracks).toEqual([snapshot.tracks[0]?.trackId]);
    expect(snapshot.omittedEntries).toEqual([{ order: 2, reason: "recording is not downloaded" }]);
    expect(snapshot.tracks[0]).toMatchObject({
      order: 1,
      spotifyId: "spotify-track-id",
      artist: "Artist",
      title: "Track",
      album: "Album",
      durationSec: 240,
      bpmHundreds: 12_345,
      key: "Bm",
      camelot: "10A",
      mountPath: mediaPath,
      analysisDatPath: resolve(analysisRoot, "ANLZ0000.DAT"),
      analysisExtPath: resolve(analysisRoot, "ANLZ0000.EXT"),
      analysisTwoexPath: resolve(analysisRoot, "ANLZ0000.2EX"),
    });
    expect(resolveDjLinkTrack(snapshot, "1")).toBe(snapshot.tracks[0]);
    expect(resolveDjLinkTrack(snapshot, "spotify-track-id")).toBe(snapshot.tracks[0]);
    expect(resolveDjLinkTrack(snapshot, "Artist - Track")).toBe(snapshot.tracks[0]);
  });
});
