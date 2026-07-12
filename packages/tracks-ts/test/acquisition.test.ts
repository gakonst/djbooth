import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  normalizeMatchText,
  readManifest,
  safeFilename,
  scoreYoutubeCandidates,
  writeManifestAtomic,
} from "../src/acquisition.js";
import { createManifest } from "../src/manifest.js";

describe("acquisition primitives", () => {
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
