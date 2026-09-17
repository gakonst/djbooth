import { describe, expect, test, vi } from "vitest";

import { parseAgentTracklist } from "../src/agent-resolution.js";
import { identify } from "../src/identify.js";

describe("identify", () => {
  test("returns a publisher description only when explicitly requested", async () => {
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

  test("hands unresolved sets to the calling agent with explicit 1001Tracklists instructions", async () => {
    const resolution = identify("https://youtu.be/unknown", {
      env: {
        // Recognition credentials must not change automatic behavior.
        AUDD_API_TOKEN: "also-ignored-unless-explicit",
      },
      metadataClient: {
        inspect: vi.fn(async () => ({
          id: "unknown",
          title: "DJ @ Festival",
          uploader: "Festival",
          durationSeconds: 3_600,
          description: "No timestamped list here",
        })),
      },
    });

    await expect(resolution).rejects.toMatchObject({
      code: "AGENT_REQUIRED",
      exitCode: 0,
      details: {
        action: "agent-resolution-required",
        source: "https://youtu.be/unknown",
        context: {
          sourceId: "unknown",
          title: "DJ @ Festival",
          uploader: "Festival",
          durationSeconds: 3_600,
        },
        submit: {
          option: "--agent-result-json",
          format: "Tracklist",
          requiredProvider: "agent",
        },
      },
    });
    await expect(resolution).rejects.toHaveProperty(
      "details.prompt",
      expect.stringContaining("ordinary 1001Tracklists website"),
    );
  });

  test("requires timestamps when description resolution is explicitly requested", async () => {
    await expect(
      identify("https://youtu.be/unknown", {
        provider: "description",
        env: {},
        metadataClient: { inspect: vi.fn(async () => ({ description: "No tracks" })) },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", exitCode: 4 });
  });

  test("uses AudD only when selected explicitly", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        status: "success",
        result: [
          {
            offset: "00:48",
            songs: [{ artist: "A", title: "B", score: 95, start_offset: 2000 }],
          },
        ],
      }),
    ) as typeof globalThis.fetch;

    const result = await identify("https://youtube.com/watch?v=unknown", {
      provider: "audd",
      cacheMode: "off",
      env: { AUDD_API_TOKEN: "audd" },
      fetch,
    });
    expect(result).toMatchObject({
      provider: "audd",
      sampledEverySeconds: 60,
      complete: false,
      tracks: [{ startSeconds: 50, timestamp: "00:00:50", artist: "A", title: "B" }],
    });
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

describe("agent tracklist submission", () => {
  test("accepts an ordered timestamped result", () => {
    const source = "https://youtu.be/set";
    expect(
      parseAgentTracklist(
        source,
        JSON.stringify({
          source,
          provider: "agent",
          title: "Set",
          url: "https://www.1001tracklists.com/tracklist/example.html",
          complete: false,
          tracks: [
            { order: 1, timestamp: "00:00", artist: "Artist", title: "Track" },
            { order: 2, timestamp: "03:00", isId: true, title: "ID" },
          ],
        }),
      ),
    ).toMatchObject({
      source,
      provider: "agent",
      tracks: [
        { order: 1, startSeconds: 0 },
        { order: 2, startSeconds: 180, isId: true },
      ],
    });
  });

  test("fills cue ends from the following start and recording duration, preserving explicit boundaries", () => {
    const source = "https://youtu.be/set";
    const result = parseAgentTracklist(
      source,
      JSON.stringify({
        source,
        provider: "agent",
        complete: false,
        durationSeconds: 600,
        tracks: [
          { order: 1, startSeconds: 0, endSeconds: 100, artist: "A", title: "B" },
          { order: 2, startSeconds: 180, artist: "C", title: "D" },
          { order: 3, startSeconds: 360, isId: true, title: "ID" },
        ],
      }),
    );
    expect(result.tracks.map((row) => row.endSeconds)).toEqual([100, 360, 600]);
    expect(result.tracks[2]!.isId).toBe(true);
  });

  test("rejects a mismatched source but accepts identified recordings without cues", () => {
    expect(() =>
      parseAgentTracklist(
        "https://youtu.be/set",
        JSON.stringify({
          source: "https://youtu.be/other",
          provider: "agent",
          complete: true,
          tracks: [{ order: 1, timestamp: "00:00", artist: "A", title: "B" }],
        }),
      ),
    ).toThrow(/source must exactly match/);

    expect(
      parseAgentTracklist(
        "https://youtu.be/set",
        JSON.stringify({
          source: "https://youtu.be/set",
          provider: "agent",
          complete: true,
          tracks: [{ order: 1, artist: "A", title: "B" }],
        }),
      ),
    ).toMatchObject({ tracks: [{ order: 1, artist: "A", title: "B" }] });
  });
});

test("auto always researches 1001 even when the publisher lists tracks", async () => {
  await expect(
    identify("https://youtu.be/library", {
      metadataClient: {
        inspect: async () => ({ title: "DJ Set", description: "00:00 A - B\n03:00 C - D" }),
      },
    }),
  ).rejects.toMatchObject({
    code: "AGENT_REQUIRED",
    details: { context: { description: "00:00 A - B\n03:00 C - D" } },
  });
});

test("missing intermediate cues never fabricate a clip spanning the rest of a set", () => {
  const result = parseAgentTracklist(
    "https://youtu.be/set",
    JSON.stringify({
      source: "https://youtu.be/set",
      provider: "agent",
      complete: false,
      durationSeconds: 600,
      tracks: [
        { order: 1, startSeconds: 0, artist: "A", title: "B" },
        { order: 2, artist: "C", title: "D" },
        { order: 3, startSeconds: 500, artist: "E", title: "F" },
      ],
    }),
  );
  expect(result.tracks.map((row) => row.endSeconds)).toEqual([undefined, undefined, 600]);
});
