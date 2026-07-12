import { describe, expect, test, vi } from "vitest";

import { AudDClient, parseEnterpriseResult } from "../src/providers/audd.js";

describe("AudD enterprise parsing", () => {
  test("uses scan offset plus accurate fragment offsets", () => {
    const result = parseEnterpriseResult([
      {
        offset: "01:02:00",
        songs: [
          {
            artist: "Artist",
            title: "Track",
            score: 88,
            start_offset: 1500,
            end_offset: 9000,
            timecode: "03:45",
            isrc: "TEST123",
          },
        ],
      },
    ]);

    expect(result).toEqual([
      {
        offsetSeconds: 3721.5,
        matches: [
          expect.objectContaining({
            startSeconds: 3721.5,
            endSeconds: 3729,
            scanSeconds: 3720,
            artist: "Artist",
            title: "Track",
            confidence: 88,
            isrc: "TEST123",
          }),
        ],
      },
    ]);
  });

  test("accepts flat SDK-style matches", () => {
    expect(
      parseEnterpriseResult([
        { artist: "A", title: "B", start_seconds: 12.5, end_seconds: 20, score: 99 },
      ])[0]?.matches[0],
    ).toMatchObject({ startSeconds: 12.5, endSeconds: 20, artist: "A", title: "B" });
  });

  test("separates disjoint tracks inside one scan fragment", () => {
    const result = parseEnterpriseResult([
      {
        offset: "00:00",
        songs: [
          { artist: "A", title: "One", score: 95, start_offset: 0, end_offset: 4000 },
          { artist: "B", title: "Two", score: 90, start_offset: 5000, end_offset: 11000 },
        ],
      },
    ]);
    expect(result).toHaveLength(2);
    expect(result.map((moment) => moment.matches[0]?.artist)).toEqual(["A", "B"]);
  });

  test("groups overlapping candidates as a blend", () => {
    const result = parseEnterpriseResult([
      {
        offset: "00:00",
        songs: [
          { artist: "A", title: "One", score: 95, start_offset: 0, end_offset: 8000 },
          { artist: "B", title: "Two", score: 80, start_offset: 3000, end_offset: 10000 },
        ],
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.matches).toHaveLength(2);
  });

  test("groups same-position flat candidates and skips missing positions", () => {
    const result = parseEnterpriseResult([
      { artist: "Missing", title: "Position", start_seconds: null },
      { artist: "A", title: "One", start_seconds: 12, end_seconds: 18, score: 95 },
      { artist: "B", title: "Two", start_seconds: 12, end_seconds: 20, score: 80 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.matches.map((item) => item.artist)).toEqual(["A", "B"]);
  });

  test("rejects malformed responses and marks application rate limits retryable", async () => {
    const malformed = new AudDClient({
      apiToken: "token",
      fetch: vi.fn(async () => Response.json({})) as typeof globalThis.fetch,
    });
    await expect(malformed.recognizeEnterprise("https://youtube.com/watch?v=set")).rejects.toThrow(
      "AudD response is missing status=success",
    );

    const limited = new AudDClient({
      apiToken: "token",
      fetch: vi.fn(async () =>
        Response.json({
          status: "error",
          error: { error_code: 611, error_message: "Requests limit reached" },
        }),
      ) as typeof globalThis.fetch,
    });
    await expect(
      limited.recognizeEnterprise("https://youtube.com/watch?v=set"),
    ).rejects.toMatchObject({ retryable: true });
  });

  test("does not mark deliberate cancellation retryable", async () => {
    const aborted = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    const client = new AudDClient({
      apiToken: "token",
      fetch: vi.fn(async () => Promise.reject(aborted)) as typeof globalThis.fetch,
    });
    await expect(
      client.recognizeEnterprise("https://youtube.com/watch?v=set"),
    ).rejects.toMatchObject({ retryable: false });
  });
});
