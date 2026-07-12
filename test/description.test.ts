import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import { parseDescriptionTracklist, tracklistFromDescription } from "../src/description.js";
import { createManifest } from "../src/manifest.js";

describe("description tracklists", () => {
  test("parses the real Adam Ten Burning Man 2025 reference tracklist", async () => {
    const description = await readFile(
      new URL("./fixtures/adam-ten-burning-man-2025.txt", import.meta.url),
      "utf8",
    );
    const result = parseDescriptionTracklist(description);
    expect(result.tracks).toHaveLength(29);
    expect(result.identifiedLines).toBe(22);
    expect(result.tracks[1]).toMatchObject({
      order: 2,
      timestamp: "00:01:26",
      startSeconds: 86,
      artist: "Assaf Michael",
      title: "The Big Guns (Edit)",
      isId: false,
    });
    expect(result.tracks[3]).toMatchObject({
      artist: "Noir & Haze",
      title: "Around (ID Remix)",
      overlaps: [{ artist: "40 Thieves ft. Qzen", title: "Don't Turn It Off" }],
    });
    expect(result.tracks[28]).toMatchObject({
      timestamp: "01:54:50",
      artist: "Daft Punk ft. Pharrell Williams",
      title: "Lose Yourself To Dance (Adam Ten Remix)",
    });
  });

  test("builds a downstream handoff manifest and skips IDs", () => {
    const tracklist = tracklistFromDescription("https://soundcloud.com/dj/set", {
      title: "Set",
      durationSeconds: 600,
      description: "00:00 A - One\n03:00 ID - ID\n05:00 B - Two",
    });
    expect(tracklist).toBeDefined();
    const manifest = createManifest(tracklist!);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      kind: "dj-set-pipeline",
      tracklist: { provider: "description" },
      entries: [
        { identity: { status: "identified", searchQuery: "A - One" } },
        { identity: { status: "unidentified" } },
        { identity: { status: "identified", searchQuery: "B - Two" } },
      ],
    });
  });

  test.each([
    ["0:00 Artist — Title", "Artist", "Title"],
    ["[01:02] 3) Artist | Title", "Artist", "Title"],
    ["Artist - Title (01:02:03)", "Artist", "Title"],
  ])("accepts common line form %s", (line, artist, title) => {
    expect(parseDescriptionTracklist(line).tracks[0]).toMatchObject({ artist, title });
  });
});
