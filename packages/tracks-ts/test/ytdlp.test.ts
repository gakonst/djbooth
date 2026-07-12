import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { JsonDiskCache } from "../src/cache.js";
import { getYtdlpTsCommand, inspectMediaMetadata } from "../src/integrations/ytdlp.js";

describe("ytdlp-ts metadata integration", () => {
  test("uses the workspace-installed CLI by default", async () => {
    await expect(getYtdlpTsCommand({})).resolves.toEqual({
      executable: "ytdlp-ts",
      prefix: [],
    });
  });

  test("inspects metadata with no-playlist and never invokes download", async () => {
    const metadata = await inspectMediaMetadata("https://soundcloud.com/dj/set", {
      env: {
        YTDLP_TS_PATH: fileURLToPath(new URL("./fixtures/fake-ytdlp.js", import.meta.url)),
      },
      cache: false,
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

  test("bypasses persistent metadata caching when cookies are supplied", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-auth-metadata-cache-"));
    const cache = new JsonDiskCache({ namespace: "auth-test-v1", root });
    const options = {
      env: {
        YTDLP_TS_PATH: fileURLToPath(new URL("./fixtures/fake-ytdlp.js", import.meta.url)),
      },
      cookies: "/tmp/private-cookies.txt",
      cache,
    };

    await inspectMediaMetadata("https://soundcloud.com/dj/set", options);
    await inspectMediaMetadata("https://soundcloud.com/dj/set", options);

    expect(cache.snapshot()).toMatchObject({ hits: 0, misses: 0, writes: 0 });
  });

  test("bypasses persistent metadata caching for private share URLs", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-private-metadata-cache-"));
    const cache = new JsonDiskCache({ namespace: "private-source-test-v1", root });
    const options = {
      env: {
        YTDLP_TS_PATH: fileURLToPath(new URL("./fixtures/fake-ytdlp.js", import.meta.url)),
      },
      cache,
    };

    await inspectMediaMetadata("https://soundcloud.com/dj/set/s-private", options);
    await inspectMediaMetadata("https://soundcloud.com/dj/set?secret_token=s-private", options);

    expect(cache.snapshot()).toMatchObject({ hits: 0, misses: 0, writes: 0 });
  });

  test("does not persist metadata when a public source resolves to a private URL", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-private-result-cache-"));
    const namespace = "private-result-test-v1";
    const cache = new JsonDiskCache({ namespace, root });
    const options = {
      env: {
        YTDLP_TS_PATH: fileURLToPath(new URL("./fixtures/fake-ytdlp.js", import.meta.url)),
      },
      cache,
    };
    const first = await inspectMediaMetadata("https://soundcloud.com/dj/redirect", options);
    const second = await inspectMediaMetadata("https://soundcloud.com/dj/redirect", options);

    expect(first.webpageUrl).toContain("RedirectSecret");
    expect(second).toEqual(first);
    expect(cache.snapshot()).toMatchObject({ hits: 0, misses: 2, writes: 0 });
  });

  test("cache-level storage policies can reject otherwise valid values", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-storage-policy-cache-"));
    const cache = new JsonDiskCache({ namespace: "storage-policy-v1", root });
    let loads = 0;

    await cache.getOrLoad("private", async () => ({ secret: ++loads }), {
      shouldStore: () => false,
    });
    await cache.getOrLoad("private", async () => ({ secret: ++loads }), {
      shouldStore: () => false,
    });
    expect(loads).toBe(2);
    expect(cache.snapshot()).toMatchObject({ hits: 0, misses: 2, writes: 0 });
  });
});
