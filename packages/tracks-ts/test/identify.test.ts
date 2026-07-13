import { describe, expect, test, vi } from "vitest";

import { identify, rankTracklistCandidates } from "../src/identify.js";
import { createManifest } from "../src/manifest.js";

describe("identify", () => {
  test("accepts a library metadata client without spawning the ytdlp-ts CLI", async () => {
    const inspect = vi.fn(async () => ({
      id: "set-id",
      title: "Library Set",
      description: "00:00 Artist - Track\n03:00 Artist - Next",
      durationSeconds: 360,
      webpageUrl: "https://youtu.be/library",
      uploader: "DJ",
    }));

    const result = await identify("https://youtu.be/library", {
      provider: "description",
      cacheMode: "off",
      env: {},
      metadataClient: { inspect },
    });

    expect(result).toMatchObject({
      provider: "description",
      title: "Library Set",
      tracks: [
        { order: 1, startSeconds: 0, artist: "Artist", title: "Track" },
        { order: 2, startSeconds: 180, artist: "Artist", title: "Next" },
      ],
    });
    expect(inspect).toHaveBeenCalledOnce();
  });

  test("returns an existing 1001Tracklists result before recognition", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        data: {
          found: true,
          tracklist: {
            url: "https://www.1001tracklists.com/tracklist/set.html",
            title: "Known Set",
            entries: [{ position: 1, cueSeconds: 12, artist: "A", title: "B" }],
          },
        },
      }),
    ) as typeof globalThis.fetch;

    const result = await identify("https://youtu.be/known", {
      preferDescription: false,
      cacheMode: "off",
      env: { PARSE_API_KEY: "parse" },
      fetch,
      metadataClient: { inspect: vi.fn(async () => ({})) },
    });
    expect(result).toMatchObject({
      source: "https://youtu.be/known",
      provider: "1001tracklists",
      title: "Known Set",
      url: "https://www.1001tracklists.com/tracklist/set.html",
      complete: true,
      tracks: [{ order: 1, startSeconds: 12, artist: "A", title: "B" }],
    });
    expect(createManifest(result)).toMatchObject({
      source: {
        input: "https://youtu.be/known",
        url: "https://youtu.be/known",
      },
      tracklist: {
        provider: "1001tracklists",
        url: "https://www.1001tracklists.com/tracklist/set.html",
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("searches 1001Tracklists by inspected title after media URL lookup misses", async () => {
    const requests: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(url.href);
      if (url.pathname.endsWith("/find_by_media_url")) {
        return Response.json({ data: { found: false } });
      }
      if (url.pathname.endsWith("/search_tracklists")) {
        expect(url.searchParams.get("title")).toBe("Brunello @ Lightning in a Bottle 2026");
        expect(url.searchParams.get("uploader")).toBe("Brunello");
        return Response.json({
          data: {
            items: [
              {
                title: "Brunello @ Lightning in a Bottle 2026",
                url: "https://www.1001tracklists.com/tracklist/matched.html",
              },
            ],
          },
        });
      }
      return Response.json({
        data: {
          url: "https://www.1001tracklists.com/tracklist/matched.html",
          title: "Brunello @ Lightning in a Bottle 2026",
          entries: [{ position: 1, cueSeconds: 0, artist: "Jansons", title: "Panic" }],
        },
      });
    }) as typeof globalThis.fetch;

    const result = await identify("https://youtu.be/baDz12J2uNo", {
      cacheMode: "off",
      env: { PARSE_API_KEY: "parse" },
      fetch,
      metadataClient: {
        inspect: vi.fn(async () => ({
          title: "Brunello @ Lightning in a Bottle 2026",
          uploader: "Brunello",
          description: "No timestamps here",
        })),
      },
    });

    expect(result).toMatchObject({
      provider: "1001tracklists",
      tracks: [{ artist: "Jansons", title: "Panic" }],
    });
    expect(requests).toHaveLength(3);
  });

  test("runs metadata and exact lookup concurrently, races ranked title lookup, and cancels the loser", async () => {
    const requests: string[] = [];
    const timings: Array<{ stage: string; outcome: string; durationMs: number }> = [];
    let exactStarted = false;
    let metadataStarted = false;
    let exactAborted = false;
    let releaseMetadata!: () => void;
    const metadataGate = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(url.pathname.split("/").at(-1)!);
      if (url.pathname.endsWith("/find_by_media_url")) {
        exactStarted = true;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              exactAborted = true;
              reject(new DOMException("lookup superseded", "AbortError"));
            },
            { once: true },
          );
        });
      }
      if (url.pathname.endsWith("/search_tracklists")) {
        return Response.json({
          data: {
            items: [
              {
                title: "Someone Else @ Another Festival 2024",
                url: "https://www.1001tracklists.com/tracklist/wrong.html",
              },
              {
                title: "Brunello @ Lightning in a Bottle 2026",
                djName: "Brunello",
                durationSeconds: 7_050,
                url: "https://www.1001tracklists.com/tracklist/right.html",
              },
            ],
          },
        });
      }
      expect(url.searchParams.get("url")).toContain("right.html");
      return Response.json({
        data: {
          url: "https://www.1001tracklists.com/tracklist/right.html",
          title: "Brunello @ Lightning in a Bottle 2026",
          entries: [{ position: 1, cueSeconds: 0, artist: "Jansons", title: "Panic" }],
        },
      });
    }) as typeof globalThis.fetch;

    const resolution = identify("https://youtu.be/baDz12J2uNo", {
      cacheMode: "off",
      env: { PARSE_API_KEY: "parse" },
      fetch,
      metadataClient: {
        inspect: vi.fn(async () => {
          metadataStarted = true;
          await metadataGate;
          return {
            title: "BRUNELLO @ LIGHTNING IN A BOTTLE 2026",
            uploader: "Brunello",
            durationSeconds: 7_064,
            description: "No timestamps here",
          };
        }),
      },
      onStageTiming: (timing) => timings.push(timing),
    });

    await vi.waitFor(() => {
      expect(metadataStarted).toBe(true);
      expect(exactStarted).toBe(true);
    });
    releaseMetadata();
    const result = await resolution;
    expect(result).toMatchObject({
      provider: "1001tracklists",
      url: "https://www.1001tracklists.com/tracklist/right.html",
    });
    expect(requests).toEqual(["find_by_media_url", "search_tracklists", "get_tracklist"]);
    await vi.waitFor(() => expect(exactAborted).toBe(true));
    await vi.waitFor(() =>
      expect(timings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ stage: "metadata", outcome: "completed" }),
          expect.objectContaining({ stage: "database-search", outcome: "completed" }),
          expect.objectContaining({ stage: "database-tracklist", outcome: "matched" }),
          expect.objectContaining({ stage: "database-media", outcome: "cancelled" }),
        ]),
      ),
    );
    expect(timings.every((timing) => timing.durationMs >= 0)).toBe(true);
  });

  test("ranks title candidates by title, uploader, and duration instead of provider order", () => {
    const ranked = rankTracklistCandidates(
      [
        { title: "Brunello Interview 2026", url: "https://example.com/wrong" },
        {
          title: "Brunello @ Lightning in a Bottle Festival 2026",
          djName: "Brunello",
          durationSeconds: 7_050,
          url: "https://example.com/right",
        },
      ],
      {
        title: "BRUNELLO @ LIGHTNING IN A BOTTLE 2026",
        uploader: "Brunello",
        durationSeconds: 7_064,
      },
    );

    expect(ranked[0]?.candidate.url).toBe("https://example.com/right");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  test("falls through to AudD Enterprise and reports sampling precision", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("parse.bot")) {
        return Response.json({ data: { found: false } });
      }
      return Response.json({
        status: "success",
        result: [
          {
            offset: "00:48",
            songs: [{ artist: "A", title: "B", score: 95, start_offset: 2000 }],
          },
        ],
      });
    }) as typeof globalThis.fetch;

    const result = await identify("https://youtube.com/watch?v=unknown", {
      preferDescription: false,
      cacheMode: "off",
      env: { PARSE_API_KEY: "parse", AUDD_API_TOKEN: "audd" },
      fetch,
      metadataClient: { inspect: vi.fn(async () => ({})) },
    });
    expect(result).toMatchObject({
      provider: "audd",
      sampledEverySeconds: 60,
      complete: false,
      tracks: [{ startSeconds: 50, timestamp: "00:00:50", artist: "A", title: "B" }],
    });
    expect(result.warnings?.[0]).toMatch(/No 1001Tracklists entry matched/);
  });

  test("requires a configured recognition provider", async () => {
    await expect(
      identify("https://youtube.com/watch?v=unknown", {
        env: {},
        preferDatabase: false,
        preferDescription: false,
        cacheMode: "off",
      }),
    ).rejects.toThrow(/No recognition provider configured/);
  });

  test("fails closed when the preferred database lookup errors", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: "quota exceeded" }, { status: 429 }),
    ) as typeof globalThis.fetch;
    await expect(
      identify("https://youtube.com/watch?v=set", {
        preferDescription: false,
        cacheMode: "off",
        env: { PARSE_API_KEY: "parse", AUDD_API_TOKEN: "audd" },
        fetch,
        metadataClient: { inspect: vi.fn(async () => ({})) },
      }),
    ).rejects.toThrow("quota exceeded");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("does not disclose generic or signed URLs to the database wrapper", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://enterprise.audd.io/");
      return Response.json({
        status: "success",
        result: [{ offset: "00:00", songs: [{ artist: "A", title: "B", start_offset: 0 }] }],
      });
    }) as typeof globalThis.fetch;
    const result = await identify("https://cdn.example.com/set.mp3?token=secret", {
      env: { PARSE_API_KEY: "parse", AUDD_API_TOKEN: "audd" },
      fetch,
    });
    expect(result.provider).toBe("audd");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("does not report complete coverage when a full scan starts late", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        status: "success",
        result: [{ offset: "00:10", songs: [{ artist: "A", title: "B", start_offset: 0 }] }],
      }),
    ) as typeof globalThis.fetch;
    const result = await identify("https://youtube.com/watch?v=set", {
      provider: "audd",
      full: true,
      startSeconds: 10,
      env: { AUDD_API_TOKEN: "audd" },
      fetch,
    });
    expect(result.complete).toBe(false);
  });

  test("reports missing local Enterprise files as invalid sources", async () => {
    await expect(
      identify("/definitely/missing/set.mp3", {
        provider: "audd",
        env: { AUDD_API_TOKEN: "audd" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_SOURCE", exitCode: 2 });
  });
});
