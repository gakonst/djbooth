import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { inspectMediaMetadata } from "../src/integrations/ytdlp.js";

describe("ytdlp-ts metadata integration", () => {
  test("inspects metadata with no-playlist and never invokes download", async () => {
    const metadata = await inspectMediaMetadata("https://soundcloud.com/dj/set", {
      env: {
        YTDLP_TS_PATH: fileURLToPath(new URL("./fixtures/fake-ytdlp.js", import.meta.url)),
      },
    });

    expect(metadata).toEqual({
      id: "set-id",
      title: "DJ Set",
      description: "00:00 Artist - Track",
      durationSeconds: 3600,
      webpageUrl: "https://soundcloud.com/dj/set",
      uploader: "DJ",
      extractor: "Soundcloud",
    });
  });
});
