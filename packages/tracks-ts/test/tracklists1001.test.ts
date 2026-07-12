import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { JsonDiskCache } from "../src/cache.js";
import {
  isDatabaseMediaUrl,
  normalizeMediaUrl,
  Tracklists1001Client,
} from "../src/providers/tracklists1001.js";

describe("1001Tracklists client", () => {
  test("normalizes common YouTube links", () => {
    expect(normalizeMediaUrl("https://youtu.be/abc123?t=9")).toBe(
      "https://www.youtube.com/watch?v=abc123",
    );
    expect(normalizeMediaUrl("https://m.youtube.com/watch?v=abc123&list=x")).toBe(
      "https://www.youtube.com/watch?v=abc123",
    );
    expect(normalizeMediaUrl("https://www.youtube.com/live/abc123?feature=share")).toBe(
      "https://www.youtube.com/watch?v=abc123",
    );
    expect(normalizeMediaUrl("https://youtube.com/shorts/abc123")).toBe(
      "https://www.youtube.com/watch?v=abc123",
    );
    expect(normalizeMediaUrl("https://soundcloud.com/dj/set?si=tracking")).toBe(
      "https://soundcloud.com/dj/set",
    );
  });

  test("only forwards supported public media URLs to the database wrapper", () => {
    expect(isDatabaseMediaUrl("https://youtube.com/watch?v=abc123")).toBe(true);
    expect(isDatabaseMediaUrl("https://soundcloud.com/dj/public-set?si=share")).toBe(true);
    expect(isDatabaseMediaUrl("https://soundcloud.com/dj/private/s-secret")).toBe(false);
    expect(isDatabaseMediaUrl("https://soundcloud.com/dj/set?secret_token=s-test")).toBe(false);
    expect(isDatabaseMediaUrl("https://cdn.example.com/signed.mp3?token=secret")).toBe(false);
  });

  test("parses the detailed documented shape", async () => {
    const fetch = jsonFetch({
      status: "success",
      data: {
        url: "https://www.1001tracklists.com/tracklist/test.html",
        event: { name: "DJ at Club", date: "2026-01-01", lineup: ["DJ"] },
        tracks: [{ order: 1, artist: "A", title: "B", label: "Label", links: {} }],
      },
    });
    const client = new Tracklists1001Client({ apiKey: "key", fetch, cache: false });
    await expect(client.get("https://www.1001tracklists.com/tracklist/test.html")).resolves.toEqual(
      {
        url: "https://www.1001tracklists.com/tracklist/test.html",
        event: { name: "DJ at Club", date: "2026-01-01", lineup: ["DJ"] },
        tracks: [{ order: 1, artist: "A", title: "B", label: "Label", links: {} }],
      },
    );
  });

  test("caches exact tracklists on disk", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-1001-cache-"));
    const fetch = jsonFetch({
      data: {
        url: "https://www.1001tracklists.com/tracklist/cached.html",
        event: { name: "Cached Set", lineup: ["DJ"] },
        tracks: [{ order: 1, artist: "A", title: "B" }],
      },
    });
    const cache = new JsonDiskCache({ namespace: "1001-test-v1", root });
    const client = new Tracklists1001Client({ apiKey: "key", fetch, cache });
    const url = "https://www.1001tracklists.com/tracklist/cached.html";

    await client.get(url);
    await client.get(url);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(client.cacheStats()).toMatchObject({ hits: 1, misses: 1, writes: 1 });
  });

  test("does not cache a malformed successful response", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-1001-invalid-cache-"));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: {} }))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            url: "https://www.1001tracklists.com/tracklist/recovered.html",
            event: { name: "Recovered", lineup: [] },
            tracks: [],
          },
        }),
      ) as typeof globalThis.fetch;
    const client = new Tracklists1001Client({
      apiKey: "key",
      fetch,
      cache: new JsonDiskCache({ namespace: "1001-invalid-v1", root }),
    });
    const url = "https://www.1001tracklists.com/tracklist/recovered.html";

    await expect(client.get(url)).rejects.toThrow("missing tracklist URL");
    await expect(client.get(url)).resolves.toMatchObject({ url });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("parses media lookup entries with cue seconds", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("url")).toBe("https://www.youtube.com/watch?v=abc");
      return Response.json({
        data: {
          found: true,
          tracklist: {
            url: "https://www.1001tracklists.com/tracklist/test.html",
            title: "Set",
            djName: "DJ",
            durationSeconds: 3600,
            entries: [{ position: 1, cueSeconds: 90, artist: "A", title: "A - B", isId: false }],
          },
        },
      });
    }) as typeof globalThis.fetch;
    const result = await new Tracklists1001Client({
      apiKey: "key",
      fetch,
      cache: false,
    }).findByMediaUrl("https://youtu.be/abc?t=42");
    expect(result).toMatchObject({
      found: true,
      durationSeconds: 3600,
      event: { name: "Set", djName: "DJ", lineup: ["DJ"] },
      tracks: [{ order: 1, timestamp: "90", artist: "A", title: "B", isId: false }],
    });
  });

  test("preserves a clean not-found result", async () => {
    const client = new Tracklists1001Client({
      apiKey: "key",
      fetch: jsonFetch({ status: "success", data: { found: false } }),
      cache: false,
    });
    await expect(client.findByMediaUrl("https://youtube.com/watch?v=missing")).resolves.toEqual({
      found: false,
    });
  });

  test("quotes exact API errors", async () => {
    const client = new Tracklists1001Client({
      apiKey: "key",
      fetch: vi.fn(async () =>
        Response.json({ error: "Missing X-API-Key header", status_code: 401 }, { status: 401 }),
      ) as typeof globalThis.fetch,
      cache: false,
    });
    await expect(client.latest()).rejects.toThrow(
      "1001Tracklists wrapper error: Missing X-API-Key header",
    );
  });

  test("preserves search duration metadata", async () => {
    const client = new Tracklists1001Client({
      apiKey: "key",
      fetch: jsonFetch({
        data: {
          results: [
            {
              title: "DJ - Set",
              url: "https://www.1001tracklists.com/tracklist/set.html",
              djName: "DJ",
              durationSeconds: 3540,
            },
          ],
        },
      }),
      cache: false,
    });
    await expect(client.search("Set")).resolves.toEqual({
      items: [
        {
          title: "DJ - Set",
          url: "https://www.1001tracklists.com/tracklist/set.html",
          djName: "DJ",
          durationSeconds: 3540,
        },
      ],
    });
  });

  test("parses latest and chart endpoints", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("X-API-Key")).toBe("key");
      const endpoint = new URL(String(input)).pathname.split("/").at(-1);
      if (endpoint === "list_latest") {
        return Response.json({
          data: {
            latest: [
              {
                title: "Latest Set",
                url: "https://www.1001tracklists.com/tracklist/latest.html",
              },
            ],
          },
        });
      }
      expect(new URL(String(input)).searchParams.get("type")).toBe("trending");
      return Response.json({
        data: {
          chart: "trending",
          tracks: [{ rank: 2, name: "Artist - Track", url: "https://example.com/track" }],
        },
      });
    }) as typeof globalThis.fetch;
    const client = new Tracklists1001Client({ apiKey: "key", fetch, cache: false });

    await expect(client.latest()).resolves.toEqual({
      items: [
        {
          title: "Latest Set",
          url: "https://www.1001tracklists.com/tracklist/latest.html",
        },
      ],
    });
    await expect(client.charts("trending")).resolves.toEqual({
      chart: "trending",
      items: [{ rank: 2, name: "Artist - Track", url: "https://example.com/track" }],
    });
  });

  test("rejects a missing Parse data envelope", async () => {
    const client = new Tracklists1001Client({
      apiKey: "key",
      fetch: jsonFetch({}),
      cache: false,
    });
    await expect(client.latest()).rejects.toThrow(
      "1001Tracklists wrapper response is missing data",
    );
  });
});

function jsonFetch(body: unknown): typeof globalThis.fetch {
  return vi.fn(async () => Response.json(body)) as typeof globalThis.fetch;
}
