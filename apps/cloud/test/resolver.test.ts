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
