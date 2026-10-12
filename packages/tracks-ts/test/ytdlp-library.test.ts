import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { JsonDiskCache } from "../src/cache.js";
import {
  YtdlpReferenceAcquirer,
  type YtdlpReferenceClient,
} from "../src/integrations/ytdlp-library.js";

describe("YtdlpReferenceAcquirer", () => {
  test("keeps browser-authenticated metadata out of the shared disk cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-auth-search-"));
    let calls = 0;
    const client: YtdlpReferenceClient = {
      async inspect(_source, options) {
        expect(options?.cookiesFromBrowser).toBe("brave");
        calls += 1;
        return { id: "search", title: "search", entries: [] };
      },
      async download() {
        throw new Error("not used");
      },
    };
    const acquirer = new YtdlpReferenceAcquirer(client, {
      cookiesFromBrowser: "brave",
      cache: new JsonDiskCache({ root, namespace: "auth-test" }),
    });
    const target = { artists: ["Artist"], title: "Track" };
    await acquirer.search(target);
    await acquirer.search(target);
    expect(calls).toBe(2);
    expect(await readdir(root)).toEqual([]);
  });

  test("searches the primary artist when an upload omits collaborator credits", async () => {
    const queries: string[] = [];
    const client: YtdlpReferenceClient = {
      async inspect(source) {
        queries.push(source);
        return {
          id: "search",
          title: "search",
          entries:
            source === "scsearch10:Artist Track"
              ? [
                  {
                    id: "123",
                    title: "Track",
                    uploader: "Artist",
                    duration: 300,
                    webpage_url: "https://soundcloud.com/artist/track",
                  },
                ]
              : [],
        };
      },
      async download() {
        throw new Error("not used");
      },
    };
    const acquirer = new YtdlpReferenceAcquirer(client, {
      cache: false,
      searchProviders: ["soundcloud"],
    });
    expect(
      await acquirer.search({ artists: ["Artist", "Collaborator"], title: "Track" }),
    ).toHaveLength(1);
    expect(queries).toEqual(["scsearch10:Artist Collaborator Track", "scsearch10:Artist Track"]);
  });

  test("retains SoundCloud page URLs in cached flat results when YouTube search fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-soundcloud-search-"));
    const queries: string[] = [];
    const client: YtdlpReferenceClient = {
      async inspect(source) {
        queries.push(source);
        if (source.startsWith("ytsearch")) throw new Error("YouTube unavailable");
        return {
          id: "search",
          title: "search",
          entries: [
            {
              id: "12345",
              title: "Artist - Track",
              url: "https://soundcloud.com/artist/track",
              duration: 300,
              uploader: "Artist",
              extractor: "soundcloud",
            },
          ],
        };
      },
      async download() {
        throw new Error("not used");
      },
    };
    const cache = new JsonDiskCache({ root, namespace: "soundcloud-test" });
    const acquirer = new YtdlpReferenceAcquirer(client, {
      cache,
      searchProviders: ["youtube", "soundcloud"],
    });
    const target = { artists: ["Artist"], title: "Track", durationSeconds: 300 };
    const first = await acquirer.search(target);
    expect(first).toEqual([
      expect.objectContaining({
        source: "https://soundcloud.com/artist/track",
        durationSeconds: 300,
      }),
    ]);
    expect(await acquirer.search(target)).toEqual(first);
    expect(queries.filter((query) => query.startsWith("scsearch"))).toEqual([
      "scsearch10:Artist Track",
    ]);
  });

  test.each([undefined, "brave"])(
    "searches and downloads a direct M4A with browser session %s",
    async (cookiesFromBrowser) => {
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
      const acquirer = new YtdlpReferenceAcquirer(client, {
        searchLimit: 4,
        cache: false,
        ...(cookiesFromBrowser ? { cookiesFromBrowser } : {}),
      });

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
          ...(cookiesFromBrowser ? { cookiesFromBrowser } : {}),
        },
      });
      if (cookiesFromBrowser) {
        expect(calls[0]).toMatchObject({ options: { cookiesFromBrowser } });
        expect(calls[1]).toMatchObject({ options: { cookiesFromBrowser } });
      }
    },
  );

  test("reuses sanitized YouTube search metadata from disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-youtube-cache-"));
    let inspections = 0;
    const client: YtdlpReferenceClient = {
      async inspect() {
        inspections += 1;
        return {
          id: "search",
          title: "search",
          entries: [
            {
              id: "abcdefghijk",
              title: "Artist - Track",
              duration: 300,
              extractor: "youtube",
              webpage_url: "https://www.youtube.com/watch?v=abcdefghijk&list=tracking",
              url: "https://signed.example/audio?token=secret",
            },
          ],
        };
      },
      async download() {
        throw new Error("not used");
      },
    };
    const cache = new JsonDiskCache({ namespace: "youtube-test-v1", root });
    const acquirer = new YtdlpReferenceAcquirer(client, { cache });
    const target = { artists: ["Artist"], title: "Track", durationSeconds: 300 };

    const first = await acquirer.search(target);
    const second = await acquirer.search(target);

    expect(inspections).toBe(1);
    expect(first[0]?.source).toBe("https://www.youtube.com/watch?v=abcdefghijk");
    expect(second).toEqual(first);
    expect(acquirer.cacheStats()).toMatchObject({ hits: 1, misses: 1, writes: 1 });
  });

  test("omits private SoundCloud share credentials from cached search metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-soundcloud-private-cache-"));
    const namespace = "soundcloud-private-test-v1";
    let inspections = 0;
    const client: YtdlpReferenceClient = {
      async inspect() {
        inspections += 1;
        return {
          id: "search",
          title: "search",
          entries: [
            {
              id: "private-path",
              title: "Private path",
              extractor: "soundcloud",
              webpage_url: "https://soundcloud.com/artist/private-track/s-PathSecret",
            },
            {
              id: "private-query",
              title: "Private query",
              extractor: "soundcloud",
              original_url:
                "https://soundcloud.com/artist/private-query?secret_token=s-QuerySecret",
            },
            {
              id: "public-track",
              title: "Public track",
              extractor: "soundcloud",
              webpage_url: "https://soundcloud.com/artist/public-track?utm_source=test",
            },
          ],
        };
      },
      async download() {
        throw new Error("not used");
      },
    };
    const cache = new JsonDiskCache({ namespace, root });
    const acquirer = new YtdlpReferenceAcquirer(client, { cache });
    const target = { artists: ["Artist"], title: "Track" };

    const first = await acquirer.search(target);
    const second = await acquirer.search(target);

    expect(inspections).toBe(1);
    expect(first).toEqual([
      {
        id: "public-track",
        source: "https://soundcloud.com/artist/public-track",
        title: "Public track",
      },
    ]);
    expect(second).toEqual(first);
    const prefixes = await readdir(join(root, namespace));
    const cacheFiles = await readdir(join(root, namespace, prefixes[0]!));
    const cached = await readFile(join(root, namespace, prefixes[0]!, cacheFiles[0]!), "utf8");
    expect(cached).not.toContain("PathSecret");
    expect(cached).not.toContain("QuerySecret");
    expect(cached).not.toContain("Private path");
    expect(cached).not.toContain("Private query");
    expect(acquirer.cacheStats()).toMatchObject({ hits: 1, misses: 1, writes: 1 });
  });

  test("does not cache exact metadata derived from private media", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-private-exact-cache-"));
    const cache = new JsonDiskCache({ namespace: "private-exact-test-v1", root });
    let inspections = 0;
    const client: YtdlpReferenceClient = {
      async inspect() {
        inspections += 1;
        return {
          id: "private-track",
          title: "Private track",
          webpage_url: "https://soundcloud.com/artist/private/s-ResolvedSecret",
          formats: [{ ext: "m4a", acodec: "aac", vcodec: "none" }],
        };
      },
      async download(_url, options) {
        const path = join(options!.paths!, "track.m4a");
        await writeFile(path, "audio");
        return { files: [path], stdout: "", stderr: "" };
      },
    };
    const acquirer = new YtdlpReferenceAcquirer(client, { cache });
    const candidate = {
      id: "public-redirect",
      source: "https://soundcloud.com/artist/public-redirect",
      title: "Private track",
      score: 1,
    };

    await acquirer.download(candidate, join(root, "first"), "track");
    await acquirer.download(candidate, join(root, "second"), "track");

    expect(inspections).toBe(2);
    expect(cache.snapshot()).toMatchObject({ hits: 0, misses: 2, writes: 0 });
  });
});
