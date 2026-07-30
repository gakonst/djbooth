import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { JsonDiskCache } from "../src/cache.js";
import {
  isDatabaseMediaUrl,
  normalizeMediaUrl,
  parse1001TracklistHtml,
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
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toMatch(/\/get_tracklist$/u);
      expect(url.searchParams.get("url")).toBe(
        "https://www.1001tracklists.com/tracklist/test.html",
      );
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("X-API-Key")).toBe("key");
      return Response.json({
        status: "success",
        data: {
          url: "https://www.1001tracklists.com/tracklist/test.html",
          event: { name: "DJ at Club", date: "2026-01-01", lineup: ["DJ"] },
          tracks: [{ order: 1, artist: "A", title: "B", label: "Label", links: {} }],
        },
      });
    }) as typeof globalThis.fetch;
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
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("url")).toBe("https://www.youtube.com/watch?v=abc");
      expect(init?.method).toBe("GET");
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

  test("expires negative media lookups sooner than stable matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-1001-negative-cache-"));
    let now = Date.parse("2026-07-12T00:00:00.000Z");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ data: { found: false } }))
      .mockResolvedValueOnce(
        Response.json({
          data: {
            found: true,
            tracklist: {
              url: "https://www.1001tracklists.com/tracklist/new.html",
              title: "New Set",
              entries: [],
            },
          },
        }),
      ) as typeof globalThis.fetch;
    const client = new Tracklists1001Client({
      apiKey: "key",
      fetch,
      cache: new JsonDiskCache({
        namespace: "1001-negative-v1",
        root,
        now: () => now,
        pruneMaxEntries: false,
      }),
    });

    await expect(client.findByMediaUrl("https://youtu.be/new")).resolves.toEqual({ found: false });
    await expect(client.findByMediaUrl("https://youtu.be/new")).resolves.toEqual({ found: false });
    now += 15 * 60 * 1_000 + 1;
    await expect(client.findByMediaUrl("https://youtu.be/new")).resolves.toMatchObject({
      found: true,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test("deduplicates equivalent normalized title searches", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-1001-search-cache-"));
    const fetch = jsonFetch({ data: { items: [] } });
    const client = new Tracklists1001Client({
      apiKey: "key",
      fetch,
      cache: new JsonDiskCache({ namespace: "1001-search-v1", root }),
    });

    await client.search("  BRUNELLO   @ LIGHTNING IN A BOTTLE 2026 ", " Brunello ");
    await client.search("brunello @ lightning in a bottle 2026", "brunello");
    expect(fetch).toHaveBeenCalledTimes(1);
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
      expect(init?.method).toBe("GET");
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

  test("parses rendered rows, IDs, duration, and unapproved suggestions", () => {
    expect(parse1001TracklistHtml(TRACKLIST_HTML, TRACKLIST_URL)).toMatchObject({
      url: TRACKLIST_URL,
      durationSeconds: 7109,
      event: {
        name: "Lee Burridge & Patricio @ Lightning In A Bottle Festival 2026-05-24",
        date: "2026-05-24",
        djName: "Lee Burridge & Patricio",
        lineup: ["Lee Burridge", "Patricio"],
      },
      tracks: [
        {
          order: 1,
          isId: false,
          positionId: "14103334",
          trackId: "f45gvfnf",
          mediaItemId: "1154917",
          artist: "Mita Gami & Rafael",
          title: "What Is Luv",
        },
        { order: 2, isId: true, positionId: "14103335" },
      ],
      suggestions: [
        {
          id: "952278",
          position: 2,
          positionId: "14103335",
          text: "Newman (I Love) - Love to Love",
          timestamp: "01:12:27",
          startSeconds: 4347,
          submitter: "Guest",
        },
      ],
    });
  });

  test("rejects headless placeholder identities", () => {
    const decoy = TRACKLIST_HTML.replace(
      '<span class="trackValue">Mita Gami &amp; Rafael - What Is Luv</span>',
      '<span class="trackValue">Unrelated Artist - Placeholder Track</span>',
    );
    expect(() => parse1001TracklistHtml(decoy, TRACKLIST_URL)).toThrow(
      "mismatched placeholder identities",
    );
  });

  test("falls back to a headed page, expands every media URL, and caches the result", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-1001-headed-cache-"));
    const loadHtml = vi.fn(async () => TRACKLIST_HTML);
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/get_tracklist")) {
        return new Response("<!doctype html><title>upstream failure</title>", { status: 502 });
      }
      expect(url.pathname).toBe("/ajax/get_medialink.php");
      expect(url.searchParams.get("idItem")).toBe("1154917");
      return Response.json({
        success: true,
        data: [
          {
            source: "36",
            playerId: "shortSpotifyVersion",
            duration: "234",
            player:
              '<iframe src="https://open.spotify.com/embed/track/shortSpotifyVersion"></iframe>',
          },
          {
            source: "36",
            playerId: "5wptlXe6PweNiihKvbHIV8",
            duration: "326",
            player:
              '<iframe src="https://open.spotify.com/embed/track/5wptlXe6PweNiihKvbHIV8"></iframe>',
          },
          {
            source: "10",
            playerId: "2134256460",
            duration: "242",
            player:
              '<iframe src="https://w.soundcloud.com/player/?url=https://api.soundcloud.com/tracks/2134256460"></iframe>',
          },
        ],
        more: [{ source: "13", idLink: "n4wxIcorAyU", type: "video" }],
      });
    }) as typeof globalThis.fetch;
    const client = new Tracklists1001Client({
      apiKey: "key",
      fetch,
      browser: { loadHtml },
      cache: new JsonDiskCache({ namespace: "1001-resolved-test-v1", root }),
      pageCache: new JsonDiskCache({ namespace: "1001-page-test-v1", root }),
      mediaCache: new JsonDiskCache({ namespace: "1001-media-test-v1", root }),
    });

    const first = await client.get(TRACKLIST_URL);
    const second = await client.get(TRACKLIST_URL);

    expect(second).toEqual(first);
    expect(first.tracks[0]?.media).toEqual([
      {
        platform: "spotify",
        sourceId: "5wptlXe6PweNiihKvbHIV8",
        url: "https://open.spotify.com/track/5wptlXe6PweNiihKvbHIV8",
        embedUrl: "https://open.spotify.com/embed/track/5wptlXe6PweNiihKvbHIV8",
        durationSeconds: 326,
      },
      {
        platform: "spotify",
        sourceId: "shortSpotifyVersion",
        url: "https://open.spotify.com/track/shortSpotifyVersion",
        embedUrl: "https://open.spotify.com/embed/track/shortSpotifyVersion",
        durationSeconds: 234,
      },
      {
        platform: "soundcloud",
        sourceId: "2134256460",
        url: "https://api.soundcloud.com/tracks/2134256460",
        embedUrl:
          "https://w.soundcloud.com/player/?url=https://api.soundcloud.com/tracks/2134256460",
        durationSeconds: 242,
      },
      {
        platform: "youtube",
        sourceId: "n4wxIcorAyU",
        url: "https://www.youtube.com/watch?v=n4wxIcorAyU",
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(loadHtml).toHaveBeenCalledTimes(1);
    expect(client.cacheStats()).toMatchObject({ hits: 1, misses: 3, writes: 3 });
  });
});

function jsonFetch(body: unknown): typeof globalThis.fetch {
  return vi.fn(async () => Response.json(body)) as typeof globalThis.fetch;
}

const TRACKLIST_URL = "https://www.1001tracklists.com/tracklist/example/lee-burridge-patricio.html";

const TRACKLIST_HTML = String.raw`
  <html>
    <head>
      <title>Lee Burridge &amp; Patricio @ Lightning In A Bottle Festival 2026-05-24</title>
      <link rel="canonical" href="${TRACKLIST_URL}">
      <meta property="og:url" content="${TRACKLIST_URL}">
      <meta property="og:title" content="Lee Burridge &amp; Patricio @ Lightning In A Bottle Festival 2026-05-24">
      <meta name="dcterms.modified" content="2026-05-24">
    </head>
    <body>
      <div itemtype="https://schema.org/VideoObject">
        <meta itemprop="duration" content="PT118M29S">
      </div>
      <div class="tlpItem" data-id="14103334" data-isided="true" data-trackid="f45gvfnf">
        <div>
          <input id="tlp14103334_cue_seconds" value="0">
          <meta itemprop="name" content="Mita Gami &amp; Rafael - What Is Luv">
          <meta itemprop="byArtist" content="Mita Gami &amp; Rafael">
          <meta itemprop="duration" content="PT5M26S">
          <span class="trackValue">Mita Gami &amp; Rafael - What Is Luv</span>
        </div>
        <div class="mediaRow" data-trackid="1154917"></div>
      </div>
      <div class="tlpItem" data-id="14103335" data-isid="true">
        <div><input id="tlp14103335_cue_seconds" value="0"><span class="trackValue">ID - ID</span></div>
      </div>
      <div class="sugTog" id="sug_952278" data-pos="1" data-tlp="14103335" data-type="0">
        <span id="sug952278_cue_value">1:12:27</span>
        <div id="sug952278_value">Newman (I Love) - Love to Love</div>
        Guest
      </div>
    </body>
  </html>
`;
