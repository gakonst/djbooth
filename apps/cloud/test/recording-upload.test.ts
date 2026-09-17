import { describe, expect, it, vi } from "vitest";
import { recordingUpload } from "../src/recording-upload.js";
import type { Env } from "../src/index.js";
const input = {
  audioHash: "a".repeat(64),
  title: "Set",
  description: "00:00 Artist – Track",
  uploadID: "00000000-0000-4000-8000-000000000000",
};
const request = (method = "POST") =>
  new Request("https://library.test/v1/music/soundcloud/selected/recordings", {
    method,
    headers: { authorization: "Bearer nc1.grant.token" },
  });
describe("recorded set publication", () => {
  it("fails before reading or uploading audio when streaming connector is absent", async () => {
    const read = vi.fn();
    expect(
      await (await recordingUpload(request("GET"), {} as Env, "selected", read)).json(),
    ).toMatchObject({ available: false });
    await expect(recordingUpload(request(), {} as Env, "selected", read)).rejects.toMatchObject({
      status: 503,
    });
    expect(read).not.toHaveBeenCalled();
  });
  it("streams immutable audio with exact grant selection, complete tracklist, and stable upload ID", async () => {
    const bytes = new Uint8Array([82, 73, 70, 70, 0, 255, 13, 10, 87, 65, 86, 69]);
    const fetch = vi.fn(async (r: Request) => {
      expect(r.url).toBe("https://soundcloud-upload.internal/v1/connections/selected/tracks");
      expect(r.headers.get("authorization")).toBe("Bearer token");
      expect(r.headers.get("idempotency-key")).toBe(input.uploadID);
      const data = await r.arrayBuffer();
      expect(data.byteLength).toBe(Number(r.headers.get("content-length")));
      const copy = new Request(r.url, { method: "POST", headers: r.headers, body: data });
      const form = await copy.formData();
      expect(form.get("track[description]")).toBe(input.description);
      expect(form.get("track[sharing]")).toBe("private");
      expect(new Uint8Array(await (form.get("track[asset_data]") as File).arrayBuffer())).toEqual(
        bytes,
      );
      return Response.json({
        permalink_url: "https://soundcloud.com/owner/set",
        urn: "soundcloud:tracks:1",
        state: "processing",
      });
    });
    const env = { SOUNDCLOUD_UPLOAD_SERVICE: { fetch } } as unknown as Env;
    const response = await recordingUpload(
      request(),
      env,
      "selected",
      async () => input,
      async (hash) => {
        expect(hash).toBe(input.audioHash);
        return new Response(bytes, { headers: { "content-length": String(bytes.length) } });
      },
    );
    expect(await response.json()).toMatchObject({
      url: "https://soundcloud.com/owner/set",
      state: "processing",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("never truncates a long tracklist or automatically retries ambiguous publication", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 503 }));
    const env = { SOUNDCLOUD_UPLOAD_SERVICE: { fetch } } as unknown as Env;
    const media = vi.fn(
      async () => new Response("RIFF0000WAVE", { headers: { "content-length": "12" } }),
    );
    await expect(
      recordingUpload(
        request(),
        env,
        "selected",
        async () => ({ ...input, description: "x".repeat(4001) }),
        media,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(media).not.toHaveBeenCalled();
    await expect(
      recordingUpload(request(), env, "selected", async () => input, media),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
