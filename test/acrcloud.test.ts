import { describe, expect, test, vi } from "vitest";

import { AcrCloudClient, signAcrCloud } from "../src/providers/acrcloud.js";

describe("ACRCloud", () => {
  test("signs the documented canonical request", () => {
    expect(signAcrCloud("secret", "key", "1700000000")).toBe("tWbqxXkbyadGeaHIJS/OzfF+KdU=");
  });

  test("maps music metadata and sends signed multipart data", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect(form.get("access_key")).toBe("key");
      expect(form.get("signature")).toBe("tWbqxXkbyadGeaHIJS/OzfF+KdU=");
      return Response.json({
        status: { code: 0, msg: "Success" },
        metadata: {
          music: [
            {
              title: "Track",
              artists: [{ name: "Artist" }],
              score: 91,
              sample_begin_time_offset_ms: 1500,
              sample_end_time_offset_ms: 9000,
              external_ids: { isrc: "TEST" },
            },
          ],
        },
      });
    }) as typeof globalThis.fetch;
    const client = new AcrCloudClient({
      host: "identify-eu-west-1.acrcloud.com",
      accessKey: "key",
      accessSecret: "secret",
      now: () => 1_700_000_000_000,
      fetch,
    });

    const result = await client.recognizeClip(new Blob(["audio"]), 120);
    expect(result.matches[0]).toMatchObject({
      artist: "Artist",
      title: "Track",
      confidence: 91,
      isrc: "TEST",
      startSeconds: 121.5,
      endSeconds: 129,
    });
  });

  test("rejects malformed successful responses", async () => {
    const client = new AcrCloudClient({
      host: "identify.acrcloud.com",
      accessKey: "key",
      accessSecret: "secret",
      fetch: vi.fn(async () => Response.json({})) as typeof globalThis.fetch,
    });
    await expect(client.recognizeClip(new Blob(["audio"]), 0)).rejects.toThrow(
      "ACRCloud response is missing status.code",
    );
  });

  test("marks application-level QPS limits retryable", async () => {
    const client = new AcrCloudClient({
      host: "identify.acrcloud.com",
      accessKey: "key",
      accessSecret: "secret",
      fetch: vi.fn(async () =>
        Response.json({ status: { code: 3015, msg: "QPS limit" } }),
      ) as typeof globalThis.fetch,
    });
    await expect(client.recognizeClip(new Blob(["audio"]), 0)).rejects.toMatchObject({
      retryable: true,
    });
  });
});
