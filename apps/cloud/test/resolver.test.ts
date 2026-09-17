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
