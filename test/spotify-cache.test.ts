import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { JsonDiskCache } from "../src/cache.js";
import { CachedSpotifyClient, type SpotifyRawClient } from "../src/integrations/spotify-cache.js";

describe("CachedSpotifyClient", () => {
  test("caches public search and single-track metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-spotify-cache-"));
    const raw = vi.fn(async (_method: string, path: string) => ({ path }));
    const rawClient: SpotifyRawClient = {
      raw: async <T>(method: string, path: string) => (await raw(method, path)) as T,
    };
    const client = new CachedSpotifyClient(rawClient, {
      cache: new JsonDiskCache({ namespace: "spotify-test-v1", root }),
      cacheScope: "test-user-us",
    });

    await expect(
      client.raw("GET", "search", { query: { q: "track", type: "track" } }),
    ).resolves.toEqual({ path: "search" });
    await client.raw("GET", "search", { query: { type: "track", q: "track" } });
    await client.raw("GET", "tracks/abc");
    await client.raw("GET", "/tracks/abc/");
    expect(raw).toHaveBeenCalledTimes(2);
    expect(client.cacheStats()).toMatchObject({ hits: 2, misses: 2, writes: 2 });
  });

  test("does not cache user-specific or mutating calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-spotify-bypass-"));
    const raw = vi.fn(async () => ({ ok: true }));
    const rawClient: SpotifyRawClient = {
      raw: async <T>() => (await raw()) as T,
    };
    const client = new CachedSpotifyClient(rawClient, {
      cache: new JsonDiskCache({ namespace: "spotify-bypass-v1", root }),
      cacheScope: "test-user-us",
    });

    await client.raw("GET", "me");
    await client.raw("GET", "me");
    await client.raw("POST", "playlists/id/items");
    await client.raw("POST", "playlists/id/items");
    expect(raw).toHaveBeenCalledTimes(4);
  });

  test("does not cache account-scoped responses without an explicit scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "tracks-spotify-unscoped-"));
    const raw = vi.fn(async () => ({ ok: true }));
    const rawClient: SpotifyRawClient = {
      raw: async <T>() => (await raw()) as T,
    };
    const client = new CachedSpotifyClient(rawClient, {
      cache: new JsonDiskCache({ namespace: "spotify-unscoped-v1", root }),
    });

    await client.raw("GET", "search", { query: { q: "track", type: "track" } });
    await client.raw("GET", "search", { query: { q: "track", type: "track" } });
    expect(raw).toHaveBeenCalledTimes(2);
    expect(client.cacheStats()).toBeUndefined();
  });
});
