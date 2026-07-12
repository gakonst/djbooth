import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { cacheDigest, JsonDiskCache } from "../src/cache.js";

describe("JsonDiskCache", () => {
  test("persists values across instances and canonicalizes object keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-cache-"));
    let loads = 0;
    const first = new JsonDiskCache({ namespace: "test-v1", root });
    await expect(
      first.getOrLoad({ query: "track", market: "US" }, async () => {
        loads += 1;
        return { id: "one" };
      }),
    ).resolves.toEqual({ id: "one" });

    const second = new JsonDiskCache({ namespace: "test-v1", root });
    await expect(
      second.getOrLoad({ market: "US", query: "track" }, async () => {
        loads += 1;
        return { id: "two" };
      }),
    ).resolves.toEqual({ id: "one" });
    expect(loads).toBe(1);
    expect(second.snapshot()).toMatchObject({ hits: 1, misses: 0 });
  });

  test("expires values and supports refresh and off modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-cache-expiry-"));
    let now = Date.parse("2026-07-12T00:00:00.000Z");
    let value = 0;
    const cache = new JsonDiskCache({
      namespace: "expiry-v1",
      root,
      defaultTtlMs: 100,
      now: () => now,
    });
    const load = async () => ++value;

    await expect(cache.getOrLoad("key", load)).resolves.toBe(1);
    await expect(cache.getOrLoad("key", load)).resolves.toBe(1);
    await expect(cache.getOrLoad("key", load, { mode: "refresh" })).resolves.toBe(2);
    await expect(cache.getOrLoad("key", load, { mode: "off" })).resolves.toBe(3);
    now += 101;
    await expect(cache.getOrLoad("key", load)).resolves.toBe(4);
  });

  test("single-flights concurrent misses", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-cache-flight-"));
    const cache = new JsonDiskCache({ namespace: "flight-v1", root });
    let loads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = async () => {
      loads += 1;
      await gate;
      return "value";
    };

    const requests = [cache.getOrLoad("same", load), cache.getOrLoad("same", load)];
    release();
    await expect(Promise.all(requests)).resolves.toEqual(["value", "value"]);
    expect(loads).toBe(1);
    expect(cache.snapshot().coalesced).toBe(1);
  });

  test("treats corrupt entries as misses", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-cache-corrupt-"));
    const digest = cacheDigest("broken");
    const path = join(root, "corrupt-v1", digest.slice(0, 2), `${digest}.json`);
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(join(root, "corrupt-v1", digest.slice(0, 2)), { recursive: true }),
    );
    await writeFile(path, "not json");
    const cache = new JsonDiskCache({ namespace: "corrupt-v1", root });
    await expect(cache.getOrLoad("broken", async () => "recovered")).resolves.toBe("recovered");
    expect(cache.snapshot()).toMatchObject({ misses: 1, errors: 1, writes: 1 });
  });

  test("opportunistically prunes expired entries in bounded resumable sweeps", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-cache-prune-"));
    let now = Date.parse("2026-07-12T00:00:00.000Z");
    const namespace = "prune-v1";
    const seed = new JsonDiskCache({
      namespace,
      root,
      now: () => now,
      pruneMaxEntries: false,
    });
    await seed.getOrLoad("expired-one", async () => 1, { ttlMs: 100 });
    await seed.getOrLoad("expired-two", async () => 2, { ttlMs: 100 });
    await seed.getOrLoad("live", async () => 3, { ttlMs: 1_000 });
    now += 200;

    const entryPath = (key: string) => {
      const digest = cacheDigest(key);
      return join(root, namespace, digest.slice(0, 2), `${digest}.json`);
    };
    const expiredPaths = [entryPath("expired-one"), entryPath("expired-two")];
    const exists = async (path: string) =>
      access(path).then(
        () => true,
        () => false,
      );

    for (let sweep = 0; sweep < 3; sweep += 1) {
      const cache = new JsonDiskCache({
        namespace,
        root,
        now: () => now,
        pruneMaxEntries: 1,
      });
      await expect(
        cache.getOrLoad("live", async () => {
          throw new Error("live entry should remain cached");
        }),
      ).resolves.toBe(3);
      if (sweep === 0) {
        expect(
          (await Promise.all(expiredPaths.map(exists))).filter(Boolean).length,
        ).toBeGreaterThan(0);
      }
    }

    await expect(Promise.all(expiredPaths.map(exists))).resolves.toEqual([false, false]);
    await expect(exists(entryPath("live"))).resolves.toBe(true);
  });

  test("reports a bounded explicit prune and rejects invalid limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-cache-prune-api-"));
    let now = Date.parse("2026-07-12T00:00:00.000Z");
    const cache = new JsonDiskCache({
      namespace: "prune-api-v1",
      root,
      now: () => now,
      pruneMaxEntries: false,
    });
    await cache.getOrLoad("expired", async () => "old", { ttlMs: 10 });
    now += 11;

    await expect(cache.pruneExpired(1)).resolves.toEqual({ scanned: 1, removed: 1, errors: 0 });
    await expect(cache.pruneExpired(0)).rejects.toThrow("maxEntries must be a positive integer");
  });

  test("does not repeat a completed automatic sweep for one hour", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-cache-prune-interval-"));
    const namespace = "prune-interval-v1";
    const seed = new JsonDiskCache({ namespace, root, pruneMaxEntries: false });
    await seed.getOrLoad("live", async () => "value");

    const first = new JsonDiskCache({ namespace, root });
    await expect(first.getOrLoad("live", async () => "unexpected")).resolves.toBe("value");
    const cursorPath = join(root, namespace, ".prune-cursor.json");
    const cursor = await readFile(cursorPath, "utf8");
    expect(JSON.parse(cursor)).toMatchObject({ notBefore: expect.any(String) });

    const second = new JsonDiskCache({ namespace, root });
    await expect(second.getOrLoad("live", async () => "unexpected")).resolves.toBe("value");
    expect(await readFile(cursorPath, "utf8")).toBe(cursor);
  });

  test("rejects cache keys that cannot be deterministically represented as JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    class CustomKey {
      value = 1;
    }

    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      new Date("2026-07-12T00:00:00.000Z"),
      new Map([["key", "value"]]),
      new CustomKey(),
      cyclic,
    ]) {
      expect(() => cacheDigest(value)).toThrow(TypeError);
    }
    expect(() => cacheDigest(Array(1))).toThrow("sparse array");
  });
});
