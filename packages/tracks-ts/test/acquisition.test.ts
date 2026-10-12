import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  audioMetadataWithAcquisitionSource,
  createSourceSetClip,
  normalizeMatchText,
  probeAudio,
  readManifest,
  retagAudio,
  safeFilename,
  scoreYoutubeCandidates,
  sourceSetClipEncoding,
  verifyAudioFile,
  writeManifestAtomic,
} from "../src/acquisition.js";
import { createManifest } from "../src/manifest.js";

describe("acquisition primitives", () => {
  test.skipIf(spawnSync("ffmpeg", ["-version"]).status !== 0)(
    "replaces FLAC tracknumber aliases instead of appending the new playlist position",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tracks-flac-tags-"));
      try {
        const sourcePath = join(directory, "source.mka");
        execFileSync("ffmpeg", [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=duration=1",
          "-metadata",
          "track=4/4",
          "-metadata",
          "TRACKNUMBER=4/4",
          "-metadata",
          "genre=House",
          sourcePath,
        ]);
        const result = await retagAudio({
          sourcePath,
          outputPath: join(directory, "tagged.flac"),
          audioCodec: "flac",
          metadata: {
            title: "Extender",
            artists: ["Oldboy"],
            comment: "Imported recording",
            trackNumber: 34,
            trackTotal: 110,
          },
        });
        expect(result.probe.tags).toMatchObject({ track: "34/110", genre: "House" });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(spawnSync("ffmpeg", ["-version"]).status !== 0)(
    "rejects damaged AAC packets even when MP4 headers and duration are intact",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tracks-decode-"));
      try {
        const path = join(directory, "audio.m4a");
        execFileSync("ffmpeg", [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=1",
          "-c:a",
          "aac",
          path,
        ]);
        await expect(verifyAudioFile(path)).resolves.toMatchObject({ probe: { codec: "aac" } });
        const bytes = await readFile(path);
        const mdat = bytes.indexOf(Buffer.from("mdat"));
        expect(mdat).toBeGreaterThan(3);
        const size = bytes.readUInt32BE(mdat - 4);
        bytes.fill(0xff, mdat + 4, mdat - 4 + size);
        await writeFile(path, bytes);
        await expect(probeAudio(path)).resolves.toMatchObject({ codec: "aac", durationSeconds: 1 });
        await expect(verifyAudioFile(path)).rejects.toThrow(/ffmpeg failed/);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(spawnSync("ffmpeg", ["-version"]).status !== 0)(
    "writes streamable M4A atom order while preserving metadata for acquisitions and set clips",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "tracks-faststart-"));
      try {
        const sourcePath = join(directory, "source.m4a");
        execFileSync("ffmpeg", [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=1",
          "-c:a",
          "aac",
          sourcePath,
        ]);
        const metadata = {
          title: "Streamable & tagged",
          artists: ["Test Artist"],
          label: "Test Publisher",
          comment: "Acquisition provenance",
        };
        for (const kind of ["retag", "clip"] as const) {
          const outputPath = join(directory, `${kind}.m4a`);
          const options = { sourcePath, outputPath, metadata };
          const verified =
            kind === "retag"
              ? await retagAudio(options)
              : await createSourceSetClip({ ...options, startSeconds: 0, endSeconds: 0.5 });
          expect(verified.probe).toMatchObject({
            codec: "aac",
            tags: {
              title: metadata.title,
              artist: metadata.artists[0],
              publisher: metadata.label,
              comment: metadata.comment,
            },
          });
          const bytes = await readFile(outputPath);
          const atoms: string[] = [];
          // Walk box boundaries: byte searches could mistake embedded metadata
          // or audio payload for a top-level moov/mdat atom.
          let offset = 0;
          while (offset < bytes.length) {
            expect(offset + 8).toBeLessThanOrEqual(bytes.length);
            const size = bytes.readUInt32BE(offset);
            expect(size).toBeGreaterThanOrEqual(8);
            expect(offset + size).toBeLessThanOrEqual(bytes.length);
            atoms.push(bytes.toString("ascii", offset + 4, offset + 8));
            offset += size;
          }
          expect(atoms).toContain("moov");
          expect(atoms).toContain("mdat");
          expect(atoms.indexOf("moov")).toBeLessThan(atoms.indexOf("mdat"));
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("transcodes source clips only when the target container requires it", () => {
    expect(sourceSetClipEncoding("opus", ".m4a")).toEqual({
      codec: "aac",
      bitrate: "320k",
    });
    expect(sourceSetClipEncoding("aac", ".m4a")).toEqual({ codec: "copy" });
    expect(sourceSetClipEncoding("flac", ".flac")).toEqual({ codec: "copy" });
    expect(sourceSetClipEncoding("opus", ".flac")).toEqual({ codec: "flac" });
  });

  test("appends canonical download provenance to audio comments exactly once", () => {
    const metadata = { title: "Track", artists: ["Artist"], comment: "Resolved from set" };
    const youtube = audioMetadataWithAcquisitionSource(metadata, {
      backend: "ytdlp",
      source: "https://www.youtube.com/watch?v=abcdefghijk",
    });
    const soundcloud = audioMetadataWithAcquisitionSource(metadata, {
      backend: "ytdlp",
      source: "https://soundcloud.com/artist/track",
    });
    const soulseek = audioMetadataWithAcquisitionSource(metadata, {
      backend: "slsk",
      source: "slsk://download?username=peer&filename=Artist%20-%20Track.flac",
    });

    expect(youtube.comment).toBe(
      "Resolved from set\nDownloaded from YouTube: https://www.youtube.com/watch?v=abcdefghijk",
    );
    expect(soundcloud.comment).toBe(
      "Resolved from set\nDownloaded from SoundCloud: https://soundcloud.com/artist/track",
    );
    expect(soulseek.comment).toBe(
      "Resolved from set\nDownloaded from Soulseek: slsk://download?username=peer&filename=Artist%20-%20Track.flac",
    );
    expect(
      audioMetadataWithAcquisitionSource(youtube, {
        backend: "ytdlp",
        source: "https://www.youtube.com/watch?v=abcdefghijk",
      }),
    ).toBe(youtube);
  });

  test("scores an exact recording above wrong live and short versions", () => {
    const results = scoreYoutubeCandidates(
      {
        title: "Blinding Lights - Joris Voorn Remix",
        artists: ["Alex Kennon", "Joris Voorn"],
        durationSeconds: 313.748,
      },
      [
        {
          id: "wrong-live",
          source: "https://youtube.test/wrong-live",
          title: "Alex Kennon - Blinding Lights (Joris Voorn Remix) LIVE",
          uploader: "Fan Uploads",
          durationSeconds: 500,
        },
        {
          id: "exact",
          source: "https://youtube.test/exact",
          title: "Blinding Lights (Joris Voorn Remix)",
          artist: "Alex Kennon, Joris Voorn",
          uploader: "Alex Kennon - Topic",
          durationSeconds: 314.026,
        },
        {
          id: "radio",
          source: "https://youtube.test/radio",
          title: "Blinding Lights Joris Voorn Remix Radio Edit",
          artist: "Alex Kennon",
          durationSeconds: 180,
        },
      ],
    );

    expect(results.map((item) => item.id)).toEqual(["exact", "radio", "wrong-live"]);
    expect(results[0]!.score).toBeGreaterThan(0.78);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  test("normalizes punctuation and creates filesystem-safe names", () => {
    expect(normalizeMatchText("Sébastien Léger & Tim Green")).toBe("sebastien leger and tim green");
    expect(safeFilename("A/B: C\\D\u0000")).toBe("A-B- C-D-");
  });

  test("uses measured backend quality only as a bounded tie-break", () => {
    const results = scoreYoutubeCandidates(
      { title: "Track", artists: ["Artist"], durationSeconds: 300 },
      [
        {
          id: "low-quality",
          source: "slsk://low",
          title: "Artist - Track",
          artist: "Artist",
          durationSeconds: 300,
          sourceQualityScore: 0.2,
        },
        {
          id: "high-quality",
          source: "slsk://high",
          title: "Artist - Track",
          artist: "Artist",
          durationSeconds: 300,
          sourceQualityScore: 0.95,
        },
      ],
    );

    expect(results.map((candidate) => candidate.id)).toEqual(["high-quality", "low-quality"]);
    expect(results[0]!.score - results[1]!.score).toBeLessThanOrEqual(0.1);
  });

  test("validates and atomically checkpoints a private manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tracks-acquisition-"));
    const path = join(directory, "manifest.json");
    const manifest = createManifest({
      source: "https://youtube.test/set",
      provider: "description",
      complete: true,
      tracks: [{ order: 1, artist: "Artist", title: "Track" }],
    });

    await writeManifestAtomic(path, manifest);

    await expect(readManifest(path)).resolves.toEqual(manifest);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(manifest);
  });
});
