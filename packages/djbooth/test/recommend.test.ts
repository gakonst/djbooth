import { describe, expect, it, vi } from "vitest";
import { recommendAudio } from "../src/recommend.js";

const accountId = "a".repeat(32);
const excerpt = vi.fn(async () => "data:audio/wav;base64,UklGRg==");
const result = (fit: number) =>
  new Response(
    JSON.stringify({
      success: true,
      result: {
        model: "clef-omni",
        answers: {
          fit: { type: "noul", noul: fit },
          groove: { type: "noul", noul: 0.6 },
          energy: { type: "noul", noul: 0.8 },
        },
      },
    }),
  );

describe("Clef audio recommendations", () => {
  it("sanitizes invalid JSON response bodies", async () => {
    await expect(
      recommendAudio(
        { reference: "/ref.wav", candidates: ["/a.wav"] },
        {
          accountId,
          token: "x",
          excerpt,
          fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("secret provider body")),
        },
      ),
    ).rejects.toThrow(/^Clef returned an invalid decision response$/);
  });
  it("sends paired embedded audio with the supported schema and ranks independent decisions", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(result(0.2))
      .mockResolvedValueOnce(result(0.9));
    const progress = vi.fn();
    const output = await recommendAudio(
      { reference: "/ref.wav", candidates: ["/a.wav", "/ref.wav", "/b.wav", "/a.wav"] },
      { accountId, token: "test-token", fetch: fetcher, excerpt, onProgress: progress },
    );
    expect(output.recommendations.map((r) => r.path)).toEqual(["/b.wav", "/a.wav"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/clef-omni`,
    );
    const body = JSON.parse(request!.body as string);
    expect(body.model).toBe("clef-omni");
    expect(body.audio).toHaveLength(2);
    expect(body.questions.fit.type).toBe("noul");
    expect(JSON.stringify(body)).not.toContain("/ref.wav");
    expect(progress).toHaveBeenLastCalledWith(2, 2);
  });
  it("rejects malformed probabilities instead of fabricating a ranking", async () => {
    await expect(
      recommendAudio(
        { reference: "/ref.wav", candidates: ["/a.wav"] },
        {
          accountId,
          token: "x",
          excerpt,
          fetch: vi.fn<typeof fetch>().mockResolvedValue(result(1.1)),
        },
      ),
    ).rejects.toThrow("invalid decision");
  });
  it("does not retry provider failures or disclose their response bodies", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("secret provider body", { status: 429 }));
    await expect(
      recommendAudio(
        { reference: "/ref.wav", candidates: ["/a.wav"] },
        { accountId, token: "x", excerpt, fetch: fetcher },
      ),
    ).rejects.toThrow("HTTP 429");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("prepares all files before billing and rejects bad local media", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const prepare = vi
      .fn()
      .mockResolvedValueOnce("audio")
      .mockRejectedValueOnce(new Error("bad file"));
    await expect(
      recommendAudio(
        { reference: "/ref.wav", candidates: ["/bad.wav"] },
        { accountId, token: "x", excerpt: prepare, fetch: fetcher },
      ),
    ).rejects.toThrow("bad file");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects invalid bounds, missing credentials and reference-only candidates before sending", async () => {
    for (const override of [
      { duration: 301 },
      { start: -1 },
      { candidates: [] },
      { candidates: ["/ref.wav"] },
    ]) {
      await expect(
        recommendAudio(
          { reference: "/ref.wav", candidates: ["/a.wav"], ...override },
          { accountId, token: "x", excerpt },
        ),
      ).rejects.toThrow();
    }
    await expect(
      recommendAudio(
        { reference: "/ref.wav", candidates: ["/a.wav"] },
        { accountId, token: "", excerpt },
      ),
    ).rejects.toThrow("CLOUDFLARE");
  });
});
