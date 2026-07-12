import { describe, expect, test, vi } from "vitest";

import { identify } from "../src/identify.js";

describe("identify", () => {
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
      env: { PARSE_API_KEY: "parse" },
      fetch,
    });
    expect(result).toMatchObject({
      provider: "1001tracklists",
      title: "Known Set",
      complete: true,
      tracks: [{ order: 1, startSeconds: 12, artist: "A", title: "B" }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
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
      env: { PARSE_API_KEY: "parse", AUDD_API_TOKEN: "audd" },
      fetch,
    });
    expect(result).toMatchObject({
      provider: "audd",
      sampledEverySeconds: 60,
      complete: false,
      tracks: [{ startSeconds: 50, timestamp: "00:00:50", artist: "A", title: "B" }],
    });
    expect(result.warnings?.[0]).toMatch(/No existing 1001Tracklists entry/);
  });

  test("requires a configured recognition provider", async () => {
    await expect(
      identify("https://youtube.com/watch?v=unknown", {
        env: {},
        preferDatabase: false,
        preferDescription: false,
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
        env: { PARSE_API_KEY: "parse", AUDD_API_TOKEN: "audd" },
        fetch,
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
