import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { evidencedRows, researchLinks, resolveTracklist } from "../src/resolver.js";
import type { Env } from "../src/index.js";

describe("cloud tracklist evidence", () => {
  test("recovers the exact media upload named by the matched tracklist page", async () => {
    const response = await resolveTracklist(
      new Request("http://djbooth.internal/resolve", {
        method: "POST",
        body: JSON.stringify({
          action: "source-recovery-required",
          source: "https://youtube.com/watch?v=example",
          context: { evidenceURL: "https://set79.com/tracklist/soundcloud.com/publisher/same-set" },
        }),
      }),
      { AI: {}, BROWSER: {} } as Env,
    );
    expect(await response.json()).toEqual({ url: "https://soundcloud.com/publisher/same-set" });
  });
  const page = "Rafael B2B Brunello at the pier\n00:00 Brunello - Science Fiction\n04:50 ID";
  const valid = {
    matched: true,
    matchEvidence: "Rafael B2B Brunello at the pier",
    tracks: [
      {
        timestamp: "00:00",
        artist: "Brunello",
        title: "Science Fiction",
        evidence: "00:00 Brunello - Science Fiction",
      },
      { timestamp: "04:50", isId: true, title: "ID", evidence: "04:50 ID" },
    ],
  };
  test("preserves grounded rows and unidentified recordings", () => {
    expect(evidencedRows(valid, page, 600)).toEqual([
      { startSeconds: 0, artist: "Brunello", title: "Science Fiction" },
      { startSeconds: 290, isId: true, title: "ID" },
    ]);
  });
  test("rejects hallucinated identity, timestamp, match, and out-of-range rows", () => {
    for (const changes of [
      { title: "Invented" },
      { timestamp: "03:12" },
      { artist: "Someone else" },
    ])
      expect(
        evidencedRows({ ...valid, tracks: [{ ...valid.tracks[0], ...changes }] }, page, 600),
      ).toEqual([]);
    expect(evidencedRows({ ...valid, matched: false }, page, 600)).toEqual([]);
    expect(
      evidencedRows({ ...valid, matchEvidence: "Made up matching evidence" }, page, 600),
    ).toEqual([]);
    expect(evidencedRows(valid, page, 200)).toEqual([]);
  });
  test("accepts literal names after Markdown escaping without accepting different names", () => {
    const markdown = "Rafael B2B Brunello at the pier\n00:00 Artist - Track \\[Extended\\]";
    const row = { timestamp: "00:00", artist: "Artist", title: "Track [Extended]" };
    expect(evidencedRows({ ...valid, tracks: [row] }, markdown, 600)).toHaveLength(1);
  });
  test("research only follows public source links, including Google redirects", () => {
    expect(
      researchLinks(
        "[x](https://www.google.com/url?q=https%3A%2F%2Fwww.1001tracklists.com%2Ftracklist%2Fabc.html) https://evil.test/x https://youtube.com@127.0.0.1/x https://set79.com/set/123",
      ),
    ).toEqual(["https://www.1001tracklists.com/tracklist/abc.html", "https://set79.com/set/123"]);
  });
});

test("accepts exact multiline rows and standalone identities without invented timestamps", () => {
  const markdown =
    "DJ Exact Festival Set\n01\n00:00\nArtist One\nTrack One\n02\nArtist Two\nTrack Two";
  const result = evidencedRows(
    {
      matched: true,
      matchEvidence: "DJ Exact Festival Set",
      tracks: [
        {
          timestamp: "00:00",
          artist: "Artist One",
          title: "Track One",
          evidence: "01\n00:00\nArtist One\nTrack One",
        },
        { artist: "Artist Two", title: "Track Two", evidence: "02\nArtist Two\nTrack Two" },
      ],
    },
    markdown,
    600,
  );
  expect(result).toEqual([
    { startSeconds: 0, artist: "Artist One", title: "Track One" },
    { artist: "Artist Two", title: "Track Two" },
  ]);
});

test("uses a verified direct 1001 page without searching or replacing it with publisher extracts", async () => {
  const url = "https://www.1001tracklists.com/tracklist/example/set.html";
  const visited: string[] = [];
  const response = await resolveTracklist(
    new Request("https://internal/resolve", {
      method: "POST",
      body: JSON.stringify({ source: url }),
    }),
    {
      BROWSER: {
        quickAction: async (_: string, options: { url: string }) => {
          visited.push(options.url);
          return Response.json({
            success: true,
            result: "DJ Exact Festival Set\nArtist - Recording",
          });
        },
      },
      AI: {
        run: async () => ({
          response: {
            matched: true,
            matchEvidence: "DJ Exact Festival Set",
            tracks: [{ artist: "Artist", title: "Recording", evidence: "Artist - Recording" }],
          },
        }),
      },
    } as unknown as Env,
  );
  expect(response.status).toBe(200);
  expect(visited).toEqual([url]);
  expect(await response.json()).toMatchObject({
    url,
    tracks: [{ order: 1, artist: "Artist", title: "Recording" }],
  });
});

test("searches 1001 before fallback and keeps its match even when another site lists more rows", async () => {
  const source = "https://youtube.com/watch?v=performance",
    page = "https://www.1001tracklists.com/tracklist/performance.html";
  const visited: string[] = [];
  const response = await resolveTracklist(
    new Request("https://internal/resolve", {
      method: "POST",
      body: JSON.stringify({ source, context: { title: "DJ Exact Festival Set" } }),
    }),
    {
      BROWSER: {
        quickAction: async (_: string, options: { url: string }) => {
          visited.push(options.url);
          return Response.json({
            success: true,
            result: options.url.includes("duckduckgo")
              ? `${page}\nhttps://set79.com/tracklist/longer`
              : "DJ Exact Festival Set\nArtist - Recording",
          });
        },
      },
      AI: {
        run: async () => ({
          response: {
            matched: true,
            matchEvidence: "DJ Exact Festival Set",
            tracks: [{ artist: "Artist", title: "Recording", evidence: "Artist - Recording" }],
          },
        }),
      },
    } as unknown as Env,
  );
  expect(response.status).toBe(200);
  expect(visited).toHaveLength(3);
  expect(
    visited
      .slice(0, 2)
      .every((url) => new URL(url).searchParams.get("q")?.includes("site:1001tracklists.com")),
  ).toBe(true);
  expect(((await response.json()) as { url: string }).url).toBe(page);
});

// Exercise orchestration through the public resolver, not just query helpers.
function discoveryHarness(
  searchResult: (query: string) => string,
  blocked = new Set<string>(),
  unmatched = new Set<string>(),
) {
  const queries: string[] = [];
  const pages: string[] = [];
  const env = {
    BROWSER: {
      quickAction: async (_: string, options: { url: string }) => {
        const query = new URL(options.url).searchParams.get("q");
        if (query) {
          queries.push(query);
          return Response.json({ success: true, result: searchResult(query) });
        }
        pages.push(options.url);
        if (blocked.has(options.url)) return new Response("Challenge", { status: 403 });
        return Response.json({
          success: true,
          result: "DJ Exact Festival Set\nArtist - Recording",
        });
      },
    },
    AI: {
      run: async (_: string, input: { messages: Array<{ content: string }> }) => ({
        response: {
          matched: !unmatched.has(JSON.parse(input.messages[1].content).pageURL),
          matchEvidence: "DJ Exact Festival Set",
          tracks: [{ artist: "Artist", title: "Recording", evidence: "Artist - Recording" }],
        },
      }),
    },
  } as unknown as Env;
  const resolve = (source: string, context: object = {}) =>
    resolveTracklist(
      new Request("https://internal/resolve", {
        method: "POST",
        body: JSON.stringify({ source, context }),
      }),
      env,
    );
  return { queries, pages, resolve };
}

const discoveryCandidate = "https://www.1001tracklists.com/tracklist/exact-performance.html";

test.each([
  "https://www.youtube.com/watch?v=abcdefghijk&list=RDabcdefghijk&start_radio=1",
  "https://youtu.be/abcdefghijk?si=tracking&t=20",
  "https://m.youtube.com/watch?v=abcdefghijk&feature=shared",
  "https://www.youtube.com/live/abcdefghijk?si=tracking",
])("searches canonical recording identity and normalized performance title: %s", async (source) => {
  const harness = discoveryHarness((query) =>
    query.startsWith('"https://www.youtube.com/watch?v=abcdefghijk"') ? discoveryCandidate : "",
  );
  const response = await harness.resolve(source, { title: "DJ Éxact @ Festival | FULL SET [4K]" });
  expect(response.status).toBe(200);
  expect(harness.queries).toEqual([
    '"https://www.youtube.com/watch?v=abcdefghijk" site:1001tracklists.com/tracklist/',
    "DJ Exact Festival site:1001tracklists.com/tracklist/",
  ]);
  expect(harness.pages).toEqual([discoveryCandidate]);
  expect(await response.json()).toMatchObject({ source, url: discoveryCandidate });
});

test("video ID fallback finds a page missed by canonical URL and title queries", async () => {
  const harness = discoveryHarness((query) =>
    query === '"abcdefghijk" site:1001tracklists.com' ? discoveryCandidate : "",
  );
  const response = await harness.resolve("https://www.youtube.com/watch?v=abcdefghijk&list=radio", {
    title: "DJ Exact Festival",
  });
  expect(response.status).toBe(200);
  expect(harness.queries).toHaveLength(4);
  expect(harness.pages).toEqual([discoveryCandidate]);
  expect(await response.json()).toMatchObject({ url: discoveryCandidate });
});

test("general fallback still gives a verified 1001 candidate precedence", async () => {
  const harness = discoveryHarness((query) =>
    query.endsWith(" tracklist")
      ? `https://set79.com/tracklist/secondary\n${discoveryCandidate}`
      : "",
  );
  const response = await harness.resolve("https://www.youtube.com/watch?v=abcdefghijk", {
    title: "DJ Exact Festival",
  });
  expect(response.status).toBe(200);
  expect(harness.pages).toEqual([discoveryCandidate]);
});

test("supplied evidenceURL is read and verified before search", async () => {
  const harness = discoveryHarness(() => "");
  const response = await harness.resolve("https://www.youtube.com/watch?v=abcdefghijk", {
    evidenceURL: discoveryCandidate,
  });
  expect(response.status).toBe(200);
  expect(harness.queries).toEqual([]);
  expect(harness.pages).toEqual([discoveryCandidate]);
});

test("failed supplied evidence is not accepted or retried, and page/search budgets span rounds", async () => {
  const candidates = Array.from(
    { length: 10 },
    (_, i) => `https://www.1001tracklists.com/tracklist/candidate-${i}.html`,
  );
  const secondary = Array.from(
    { length: 10 },
    (_, i) => `https://set79.com/tracklist/candidate-${i}`,
  );
  const source = "https://www.youtube.com/watch?v=abcdefghijk";
  const harness = discoveryHarness(
    () => [...candidates, ...secondary].join("\n"),
    new Set([...candidates, ...secondary, source]),
  );
  const response = await harness.resolve(source, {
    title: "DJ Exact Festival",
    evidenceURL: candidates[0],
  });
  expect(response.status).toBe(422);
  expect(harness.queries).toHaveLength(8);
  expect(harness.pages.filter((url) => url.includes("1001tracklists"))).toHaveLength(6);
  expect(harness.pages.filter((url) => url.includes("set79"))).toHaveLength(6);
  expect(new Set(harness.pages).size).toBe(harness.pages.length);
});

test("a readable supplied candidate still needs an exact performance match", async () => {
  const unrelated = "https://www.1001tracklists.com/tracklist/unrelated.html";
  const harness = discoveryHarness(() => discoveryCandidate, new Set(), new Set([unrelated]));
  const response = await harness.resolve("https://www.youtube.com/watch?v=abcdefghijk", {
    title: "DJ Exact Festival",
    evidenceURL: unrelated,
  });
  expect(response.status).toBe(200);
  expect(harness.pages).toEqual([unrelated, discoveryCandidate]);
  expect(harness.queries).toHaveLength(2);
  expect(await response.json()).toMatchObject({ url: discoveryCandidate });
});

test("normalizes Markdown escapes and deduplicates media upload aliases", () => {
  expect(
    researchLinks(
      [
        "https://www.youtube.com/watch?v=abcdefghijk\\",
        "https://music.youtube.com/watch?v=abcdefghijk",
        "https://youtu.be/abcdefghijk?si=share",
        "https://m.youtube.com/live/abcdefghijk",
        "https://www.youtube.com/watch?v=abc\\_defghij&list=radio",
      ].join("\n"),
    ),
  ).toEqual([
    "https://www.youtube.com/watch?v=abcdefghijk",
    "https://www.youtube.com/watch?v=abc_defghij",
  ]);
});

test("challenged 1001 and media-heavy results still discover all 34 grounded secondary slots", async () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/adam-ten-brunch-2026.json", import.meta.url), "utf8"),
  );
  const videoID = new URL(fixture.canonicalSource).searchParams.get("v");
  const rows = fixture.tracks.map((row: any) => ({
    ...row,
    evidence: `${row.timestamp} ${row.artist ? row.artist + " - " : ""}${row.title}`,
  }));
  const matchEvidence = `${fixture.title} ${fixture.canonicalSource}`;
  const markdown = `${matchEvidence}\n${rows.map((row: any) => row.evidence).join("\n")}`;
  const pages: string[] = [];
  const queries: string[] = [];
  const response = await resolveTracklist(
    new Request("https://internal/resolve", {
      method: "POST",
      body: JSON.stringify({
        source: fixture.source,
        context: { title: fixture.title, durationSeconds: fixture.durationSeconds },
      }),
    }),
    {
      BROWSER: {
        quickAction: async (_: string, options: { url: string }) => {
          const query = new URL(options.url).searchParams.get("q");
          if (query) {
            queries.push(query);
            const result = query.includes("site:1001tracklists.com")
              ? fixture.supplied1001Candidate.url
              : query === `"${videoID}" site:groovesmaxxing.com/tracklists/`
                ? fixture.evidenceURL
                : query === `"${videoID}" site:dancefloor.fm`
                  ? fixture.secondaryEvidenceURL
                  : [
                      fixture.canonicalSource + "\\",
                      `https://music.youtube.com/watch?v=${videoID}`,
                      `https://youtu.be/${videoID}?si=share`,
                      ...Array.from(
                        { length: 7 },
                        (_, i) => `https://www.youtube.com/watch?v=unrelated0${i}`,
                      ),
                      "https://soundcloud.com/publisher/other-set",
                    ].join("\n");
            return Response.json({ success: true, result });
          }
          pages.push(options.url);
          return Response.json({
            success: true,
            result: options.url === fixture.evidenceURL ? markdown : "No verified rows",
          });
        },
      },
      AI: {
        run: async (_: string, input: { messages: Array<{ content: string }> }) => ({
          response:
            JSON.parse(input.messages[1].content).pageURL === fixture.evidenceURL
              ? { matched: true, matchEvidence, tracks: rows }
              : { matched: false, tracks: [] },
        }),
      },
    } as unknown as Env,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    source: fixture.source,
    url: fixture.evidenceURL,
    tracks: fixture.tracks.map((row: any) => ({ order: row.order, title: row.title })),
  });
  expect(pages.slice(0, 3)).toEqual([
    fixture.supplied1001Candidate.url,
    fixture.evidenceURL,
    fixture.secondaryEvidenceURL,
  ]);
  expect(pages.filter((url) => url === fixture.canonicalSource)).toHaveLength(1);
  expect(pages.filter((url) => !url.includes("1001tracklists.com"))).toHaveLength(6);
  expect(new Set(pages).size).toBe(pages.length);
  expect(queries).toHaveLength(8);
});
