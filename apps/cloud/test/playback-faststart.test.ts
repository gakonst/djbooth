import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fastStartPlayback } from "../src/playback-faststart.js";
import { fixture, join, plan, free } from "./mp4-fixture.js";

type Range = { offset: number; length: number };
let nextID = 0;
function source(bytes = fixture().bytes) {
  const account = `faststart-test-${++nextID}`;
  const hash = "a".repeat(64);
  const key = `accounts/${account}/sha256/${hash}`;
  const objects = new Map([[key, bytes]]);
  const head = vi.fn(async (path: string) => {
    const value = objects.get(path);
    return value ? { size: value.length } : null;
  });
  const get = vi.fn(async (path: string, options: { range: Range }) => {
    const value = objects.get(path);
    if (!value) return null;
    const { offset, length } = options.range;
    return { body: new Response(value.slice(offset, offset + length)).body! };
  });
  const bucket = { head, get } as unknown as R2Bucket;
  const original = vi.fn(async (range?: Range, headOnly = false) => {
    const value = range ? bytes.slice(range.offset, range.offset + range.length) : bytes;
    return new Response(headOnly ? null : value, {
      status: range ? 206 : 200,
      headers: { "content-length": String(value.length), "content-type": "audio/mp4" },
    });
  });
  function request(headers: HeadersInit = {}, method = "GET", accountID = account) {
    return fastStartPlayback(
      new Request("https://media.test/playback/song", { method, headers }),
      bucket,
      accountID,
      hash,
      original,
    );
  }
  return { bytes, account, hash, key, objects, head, get, bucket, original, request };
}
async function expected(bytes: Uint8Array) {
  const value = (await plan(bytes))!;
  expect(value).not.toBeNull();
  return {
    value,
    bytes: join(
      bytes.slice(0, value.insertionOffset),
      value.moov,
      bytes.slice(value.insertionOffset, value.moovOffset),
      bytes.slice(value.moovOffset + value.moovSize),
    ),
  };
}
async function responseBytes(response: Response | null) {
  expect(response).not.toBeNull();
  return new Uint8Array(await response!.arrayBuffer());
}

describe("scoped faststart playback responses", () => {
  // Node lacks Workers' fixed-length body type. The real wire-header behavior
  // is covered by Miniflare; this shim enforces byte count and stream semantics.
  beforeAll(() => {
    vi.stubGlobal(
      "FixedLengthStream",
      class extends TransformStream<Uint8Array, Uint8Array> {
        constructor(length: number) {
          let written = 0;
          super({
            transform(chunk, controller) {
              written += chunk.byteLength;
              if (written > length) throw new Error("Fixed-length stream overflow");
              controller.enqueue(chunk);
            },
            flush() {
              if (written !== length) throw new Error("Fixed-length stream truncated");
            },
          });
        }
      },
    );
  });
  afterAll(() => vi.unstubAllGlobals());
  it("streams the complete virtual view and leaves canonical R2 bytes unchanged", async () => {
    const storage = source();
    const before = storage.bytes.slice();
    const virtual = await expected(storage.bytes);
    const response = await storage.request();
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-length")).toBe(String(before.length));
    expect(response?.headers.get("content-type")).toBe("audio/mp4");
    expect(response?.headers.get("accept-ranges")).toBe("bytes");
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(await responseBytes(response)).toEqual(virtual.bytes);
    expect(storage.objects.get(storage.key)).toEqual(before);
    expect(storage.original).not.toHaveBeenCalled();
  });
  it("maps ranges crossing every virtual segment boundary", async () => {
    const storage = source();
    const virtual = await expected(storage.bytes);
    const cuts = [
      virtual.value.insertionOffset,
      virtual.value.insertionOffset + virtual.value.moovSize,
      virtual.value.moovOffset + virtual.value.moovSize,
    ];
    for (const cut of cuts) {
      const offset = cut - 3,
        end = Math.min(cut + 3, virtual.bytes.length - 1);
      const response = await storage.request({ range: `bytes=${offset}-${end}` });
      expect(response?.status).toBe(206);
      expect(response?.headers.get("content-range")).toBe(
        `bytes ${offset}-${end}/${virtual.bytes.length}`,
      );
      expect(response?.headers.get("content-length")).toBe(String(end - offset + 1));
      expect(await responseBytes(response)).toEqual(virtual.bytes.slice(offset, end + 1));
    }
    const all = await storage.request({ range: `bytes=0-${virtual.bytes.length - 1}` });
    expect(await responseBytes(all)).toEqual(virtual.bytes);
  });
  it("handles suffix, open-ended, clamped, and invalid ranges", async () => {
    const storage = source();
    const virtual = (await expected(storage.bytes)).bytes;
    for (const [range, offset] of [
      ["bytes=-11", virtual.length - 11],
      ["bytes=17-", 17],
      ["bytes=17-999999", 17],
      ["bytes=-999999", 0],
    ] as const) {
      const response = await storage.request({ range });
      expect(response?.status).toBe(206);
      expect(await responseBytes(response)).toEqual(virtual.slice(offset));
    }
    for (const range of [
      `bytes=${virtual.length}-`,
      "bytes=9-2",
      "bytes=-0",
      "bytes=-",
      "bytes=0-1,3-4",
      "bytes=9007199254740992-",
    ]) {
      const response = await storage.request({ range });
      expect(response?.status).toBe(416);
      expect(response?.headers.get("content-range")).toBe(`bytes */${virtual.length}`);
      expect((await responseBytes(response)).length).toBe(0);
    }
  });
  it("serves HEAD and conditional validators without streaming media", async () => {
    const storage = source();
    const head = await storage.request({}, "HEAD");
    const etag = head!.headers.get("etag")!;
    expect(head?.status).toBe(200);
    expect(head?.body).toBeNull();
    expect(head?.headers.get("content-length")).toBe(String(storage.bytes.length));
    const reads = storage.get.mock.calls.length;
    for (const match of [etag, `W/${etag}`, `"different", ${etag}`, "*"]) {
      const response = await storage.request({ "if-none-match": match });
      expect(response?.status).toBe(304);
      expect(response?.body).toBeNull();
      expect(response?.headers.has("content-length")).toBe(false);
    }
    expect(storage.get.mock.calls.length).toBe(reads);
    const virtual = (await expected(storage.bytes)).bytes;
    const partial = await storage.request({ range: "bytes=5-9", "if-range": etag });
    expect(partial?.status).toBe(206);
    expect(await responseBytes(partial)).toEqual(virtual.slice(5, 10));
    for (const stale of ['"old"', `W/${etag}`, "Wed, 01 Jan 2025 00:00:00 GMT"]) {
      const response = await storage.request({ range: "bytes=5-9", "if-range": stale });
      expect(response?.status).toBe(200);
      expect(await responseBytes(response)).toEqual(virtual);
    }
  });
  it("returns unsupported layouts to the ordinary reader without changing their representation", async () => {
    const storage = source(new Uint8Array(50));
    expect(await storage.request()).toBeNull();
    expect(storage.original).not.toHaveBeenCalled();
  });
  it("fails closed on transient metadata errors and retries without caching the failure", async () => {
    const storage = source();
    storage.head.mockRejectedValueOnce(new Error("R2 temporarily unavailable"));
    const failed = await storage.request();
    expect(failed?.status).toBe(503);
    expect(failed?.headers.get("retry-after")).toBe("1");
    expect(failed?.body).toBeNull();
    expect(storage.original).not.toHaveBeenCalled();
    expect(await responseBytes(await storage.request())).toEqual(
      (await expected(storage.bytes)).bytes,
    );
  });
  it("fails closed when source metadata ranges are truncated", async () => {
    const storage = source();
    storage.get.mockImplementationOnce(async () => ({
      body: new Response(new Uint8Array(3)).body!,
    }));
    expect((await storage.request())?.status).toBe(503);
    expect(storage.original).not.toHaveBeenCalled();
  });
  it("propagates truncated source errors through the fixed-length response", async () => {
    const storage = source();
    await storage.request({}, "HEAD");
    storage.get.mockImplementation(async () => ({ body: new Response(new Uint8Array(1)).body! }));
    const response = await storage.request();
    await expect(response!.arrayBuffer()).rejects.toThrow(/fixed-length.*truncated/i);
  });
  it("cancels the active source reader when the response consumer disconnects", async () => {
    const storage = source();
    await storage.request({}, "HEAD");
    const canceled = vi.fn();
    let opened = false;
    storage.get.mockImplementation(async () => {
      opened = true;
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1));
          },
          cancel(reason) {
            canceled(reason);
          },
        }),
      };
    });
    const response = await storage.request();
    const reader = response!.body!.getReader();
    while (!opened) await reader.read();
    await reader.cancel("consumer disconnected");
    reader.releaseLock();
    await vi.waitFor(() => expect(canceled).toHaveBeenCalledWith("consumer disconnected"));
  });
  it("uses the identical virtual layout with the composed-media reader fallback", async () => {
    const storage = source();
    storage.objects.clear();
    const virtual = (await expected(storage.bytes)).bytes;
    expect(await responseBytes(await storage.request())).toEqual(virtual);
    expect(storage.original.mock.calls.some(([range, head]) => range === undefined && head)).toBe(
      true,
    );
    const result = await storage.request({ range: "bytes=13-37" });
    expect(result?.status).toBe(206);
    expect(await responseBytes(result)).toEqual(virtual.slice(13, 38));
    expect(storage.original.mock.calls.every(([range, head]) => !!range || head === true)).toBe(
      true,
    );
  });
  it("does not downgrade to original bytes when the composed reader fails", async () => {
    const storage = source();
    storage.objects.clear();
    storage.original.mockImplementation(async () => new Response(null, { status: 503 }));
    expect((await storage.request())?.status).toBe(503);
    expect(storage.original.mock.calls).toEqual([[undefined, true]]);
  });
  it("isolates metadata caches and reads by account even for the same hash", async () => {
    const storage = source();
    const other = `${storage.account}-other`;
    const second = join(storage.bytes, free);
    storage.objects.set(`accounts/${other}/sha256/${storage.hash}`, second);
    expect(await responseBytes(await storage.request())).toEqual(
      (await expected(storage.bytes)).bytes,
    );
    expect(await responseBytes(await storage.request({}, "GET", other))).toEqual(
      (await expected(second)).bytes,
    );
    expect(storage.head.mock.calls.map(([key]) => key)).toEqual([
      storage.key,
      `accounts/${other}/sha256/${storage.hash}`,
    ]);
    expect(await responseBytes(await storage.request())).toEqual(
      (await expected(storage.bytes)).bytes,
    );
    expect(storage.head.mock.calls.length).toBe(2);
  });
});
