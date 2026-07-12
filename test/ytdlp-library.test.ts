import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  YtdlpReferenceAcquirer,
  type YtdlpReferenceClient,
} from "../src/integrations/ytdlp-library.js";

describe("YtdlpReferenceAcquirer", () => {
  test("searches one track and downloads a direct M4A through the injected library", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tracks-ytdlp-library-"));
    const calls: Array<{ kind: string; url: string; options: unknown }> = [];
    const client: YtdlpReferenceClient = {
      async inspect(url, options) {
        calls.push({ kind: "inspect", url, options });
        if (url.startsWith("ytsearch")) {
          return {
            id: "search",
            title: "search",
            entries: [
              {
                id: "abcdefghijk",
                title: "Artist - Track",
                uploader: "Artist - Topic",
                duration: 300,
                extractor: "youtube",
              },
            ],
          };
        }
        return {
          id: "abcdefghijk",
          title: "Artist - Track",
          formats: [{ ext: "m4a", acodec: "mp4a.40.2", vcodec: "none" }],
        };
      },
      async download(url, options) {
        calls.push({ kind: "download", url, options });
        await writeFile(join(directory, "track.m4a"), "audio");
        return { files: ["track.m4a"], stdout: "", stderr: "" };
      },
    };
    const acquirer = new YtdlpReferenceAcquirer(client, { searchLimit: 4 });

    const candidates = await acquirer.search({
      artists: ["Artist"],
      title: "Track",
      durationSeconds: 300,
    });
    const download = await acquirer.download({ ...candidates[0]!, score: 1 }, directory, "track");

    expect(candidates).toEqual([
      {
        id: "abcdefghijk",
        source: "https://www.youtube.com/watch?v=abcdefghijk",
        title: "Artist - Track",
        uploader: "Artist - Topic",
        durationSeconds: 300,
      },
    ]);
    expect(download).toEqual({
      path: join(directory, "track.m4a"),
      source: "https://www.youtube.com/watch?v=abcdefghijk",
      engine: "reference",
      temporary: true,
      transcoded: false,
      qualityNote:
        "Downloaded the source AAC/M4A audio and stream-copied tags without re-encoding.",
    });
    expect(calls[0]).toMatchObject({
      kind: "inspect",
      url: "ytsearch4:Artist Track",
      options: { flatPlaylist: true },
    });
    expect(calls[2]).toMatchObject({
      kind: "download",
      options: {
        playlist: false,
        format: "bestaudio[ext=m4a]/bestaudio/best",
        extractAudio: true,
        audioFormat: "m4a",
        noOverwrites: true,
      },
    });
  });
});
