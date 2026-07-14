import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { YtdlpError, type MediaInfo } from "@gakonst/ytdlp-ts";
import { describe, expect, test } from "vitest";

import { JsonDiskCache } from "../src/cache.js";
import {
  YtdlpNativeAcquirer,
  type YtdlpNativeAcquirerDependencies,
} from "../src/integrations/ytdlp-library.js";

const mediaInfo: MediaInfo = {
  id: "abcdefghijk",
  title: "Artist - Track",
  webpage_url: "https://www.youtube.com/watch?v=abcdefghijk",
  extractor: "youtube",
  extractor_key: "Youtube",
  formats: [
    {
      format_id: "140",
      url: "https://audio.googlevideo.com/videoplayback",
      ext: "m4a",
      acodec: "mp4a.40.2",
      vcodec: "none",
    },
  ],
};

describe("YtdlpNativeAcquirer", () => {
  test("searches and downloads an exact M4A without a reference client", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tracks-ytdlp-native-"));
    const calls: Array<{ kind: string; value: unknown }> = [];
    const dependencies: YtdlpNativeAcquirerDependencies = {
      async searchYoutube(query, options) {
        calls.push({ kind: "search", value: { query, options } });
        return [
          {
            id: "abcdefghijk",
            title: "Artist - Track",
            url: "https://www.youtube.com/watch?v=abcdefghijk&tracking=discarded",
            uploader: "Artist - Topic",
            durationSeconds: 300,
          },
        ];
      },
      async extract(url, context) {
        calls.push({ kind: "extract", value: { url, context } });
        return mediaInfo;
      },
      async downloadMedia(info, options) {
        calls.push({ kind: "download", value: { info, options } });
        const path = join(options!.paths!, "track.m4a");
        await writeFile(path, "native audio");
        return { files: [path], selectedFormats: ["140"] };
      },
      async probeAudio(path) {
        calls.push({ kind: "probe", value: path });
        return {};
      },
    };
    const acquirer = new YtdlpNativeAcquirer({ searchLimit: 4, cache: false }, dependencies);

    const candidates = await acquirer.search({
      artists: ["Artist"],
      title: "Track",
      durationSeconds: 300,
    });
    const result = await acquirer.download({ ...candidates[0]!, score: 1 }, directory, "track");

    expect(candidates).toEqual([
      {
        id: "abcdefghijk",
        source: "https://www.youtube.com/watch?v=abcdefghijk",
        title: "Artist - Track",
        uploader: "Artist - Topic",
        durationSeconds: 300,
      },
    ]);
    expect(calls).toMatchObject([
      { kind: "search", value: { query: "Artist Track", options: { limit: 4 } } },
      {
        kind: "extract",
        value: { url: "https://www.youtube.com/watch?v=abcdefghijk", context: {} },
      },
      {
        kind: "download",
        value: {
          info: mediaInfo,
          options: {
            format: "bestaudio[ext=m4a]",
            paths: directory,
            output: "track.%(ext)s",
            noOverwrites: true,
            continueDownload: true,
            retries: 5,
            writeInfoJson: false,
            writeThumbnail: false,
          },
        },
      },
    ]);
    expect(result).toEqual({
      path: join(directory, "track.m4a"),
      source: "https://www.youtube.com/watch?v=abcdefghijk",
      engine: "native",
      temporary: true,
      transcoded: false,
      qualityNote: "Downloaded direct source AAC/M4A with the TypeScript-native ytdlp-ts engine.",
    });
    expect(await readFile(result.path, "utf8")).toBe("native audio");
  });

  test("reuses bounded sanitized search metadata without caching signed media URLs", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-ytdlp-native-cache-"));
    const namespace = "youtube-native-test-v1";
    let searches = 0;
    const dependencies: Partial<YtdlpNativeAcquirerDependencies> = {
      async searchYoutube() {
        searches += 1;
        return [
          {
            id: "abcdefghijk",
            title: "Artist - Track",
            url: "https://signed.example/audio?token=secret",
          },
        ];
      },
    };
    const cache = new JsonDiskCache({ namespace, root });
    const acquirer = new YtdlpNativeAcquirer({ cache }, dependencies);
    const target = { artists: ["Artist"], title: "Track" };

    const first = await acquirer.search(target);
    const second = await acquirer.search(target);

    expect(searches).toBe(1);
    expect(second).toEqual(first);
    expect(first[0]?.source).toBe("https://www.youtube.com/watch?v=abcdefghijk");
    expect(acquirer.cacheStats()).toMatchObject({ hits: 1, misses: 1, writes: 1 });
    const prefixes = await readdir(join(root, namespace));
    const cacheFiles = await readdir(join(root, namespace, prefixes[0]!));
    const cached = await readFile(join(root, namespace, prefixes[0]!, cacheFiles[0]!), "utf8");
    expect(cached).not.toContain("signed.example");
    expect(cached).not.toContain("token=secret");
  });

  test("re-extracts once after a signed media 403 and retries the same YouTube ID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tracks-ytdlp-native-refresh-"));
    let extractions = 0;
    let downloads = 0;
    const dependencies: Partial<YtdlpNativeAcquirerDependencies> = {
      async extract() {
        extractions += 1;
        return {
          ...mediaInfo,
          formats: [
            {
              ...mediaInfo.formats![0]!,
              url: `https://audio.googlevideo.com/videoplayback?refresh=${extractions}`,
            },
          ],
        };
      },
      async downloadMedia(info, options) {
        downloads += 1;
        if (downloads === 1) {
          throw new YtdlpError("HTTP_ERROR", "signed URL expired", { status: 403 });
        }
        expect(info.formats?.[0]?.url).toContain("refresh=2");
        const path = join(options!.paths!, "track.m4a");
        await writeFile(path, "refreshed native audio");
        return { files: [path], selectedFormats: ["140"] };
      },
    };
    const acquirer = new YtdlpNativeAcquirer({ cache: false }, dependencies);

    const result = await acquirer.download(
      {
        id: mediaInfo.id,
        source: mediaInfo.webpage_url!,
        title: mediaInfo.title,
        score: 1,
      },
      directory,
      "track",
    );

    expect(extractions).toBe(2);
    expect(downloads).toBe(2);
    expect(await readFile(result.path, "utf8")).toBe("refreshed native audio");
  });

  test("fails closed when a signed media refresh changes the YouTube ID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tracks-ytdlp-native-mismatch-"));
    let extractions = 0;
    let downloads = 0;
    const dependencies: Partial<YtdlpNativeAcquirerDependencies> = {
      async extract() {
        extractions += 1;
        return extractions === 1 ? mediaInfo : { ...mediaInfo, id: "zyxwvutsrqp" };
      },
      async downloadMedia() {
        downloads += 1;
        throw new YtdlpError("HTTP_ERROR", "signed URL expired", { status: 403 });
      },
    };
    const acquirer = new YtdlpNativeAcquirer({ cache: false }, dependencies);

    await expect(
      acquirer.download(
        {
          id: mediaInfo.id,
          source: mediaInfo.webpage_url!,
          title: mediaInfo.title,
          score: 1,
        },
        directory,
        "track",
      ),
    ).rejects.toMatchObject({ code: "YOUTUBE_IDENTITY_MISMATCH" });
    expect(extractions).toBe(2);
    expect(downloads).toBe(1);
  });

  test("only retries a signed media 403 once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tracks-ytdlp-native-one-refresh-"));
    let extractions = 0;
    let downloads = 0;
    const dependencies: Partial<YtdlpNativeAcquirerDependencies> = {
      async extract() {
        extractions += 1;
        return mediaInfo;
      },
      async downloadMedia() {
        downloads += 1;
        throw new YtdlpError("HTTP_ERROR", "signed URL expired", { status: 403 });
      },
    };
    const acquirer = new YtdlpNativeAcquirer({ cache: false }, dependencies);

    await expect(
      acquirer.download(
        {
          id: mediaInfo.id,
          source: mediaInfo.webpage_url!,
          title: mediaInfo.title,
          score: 1,
        },
        directory,
        "track",
      ),
    ).rejects.toMatchObject({ code: "HTTP_ERROR", details: { status: 403 } });
    expect(extractions).toBe(2);
    expect(downloads).toBe(2);
  });

  test("only permits the centralized typed native capability allowlist to continue", () => {
    const acquirer = new YtdlpNativeAcquirer({ cache: false });

    expect(
      acquirer.shouldContinueAfterError(
        new YtdlpError("YOUTUBE_DIRECT_FORMATS_UNAVAILABLE", "no direct audio"),
      ),
    ).toEqual({ from: "native", code: "YOUTUBE_DIRECT_FORMATS_UNAVAILABLE" });
    for (const code of ["NETWORK_ERROR", "CONTENT_TOO_SHORT", "WRITE_FAILED"]) {
      expect(acquirer.shouldContinueAfterError(new YtdlpError(code, code))).toBe(false);
    }
    expect(acquirer.shouldContinueAfterError(new Error("unexpected"))).toBe(false);
  });
});
