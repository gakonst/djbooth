vi.mock("cloudflare:workflows", () => ({ NonRetryableError: Error }));
vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkflowEntrypoint: class {} }));
import { describe, expect, it, vi } from "vitest";
import { musicRoute, musicSources, pagePath, SoundCloudStreamCache } from "../src/music.js";
import type { Env } from "../src/index.js";
import type { Account } from "../src/auth.js";
const submit = vi.hoisted(() => vi.fn(async (_r, _e, _a, read) => Response.json(await read())));
vi.mock("../src/imports.js", async (original) => ({
  ...(await original<typeof import("../src/imports.js")>()),
  imports: submit,
}));
const account: Account = {
  id: "owner",
  grantId: "grant",
  expiresAt: 9999999999,
  capabilities: ["spotify", "soundcloud"],
};
const request = (path: string, method = "GET") =>
  new Request("https://library.test/v1/music/" + path, {
    method,
    headers: { authorization: "Bearer nc1.grant.token", "cache-control": "no-cache" },
  });
function fixture(responses: Record<string, unknown>) {
  const calls: string[] = [],
    objects = new Map<string, string>();
  const env = {
    LIBRARY_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
    CONNECT_API_SERVICE: {
      fetch: async (r: Request) => {
        expect(r.headers.get("authorization")).toBe("Bearer token");
        expect(r.headers.get("origin")).toBe("https://library.test");
        if (new URL(r.url).pathname.endsWith("/connectors"))
          return Response.json({
            connectors: {
              spotify: { connections: [{ id: "spotify-a", account_id: "alice", label: "Alice" }] },
              soundcloud: {
                connections: [{ id: "soundcloud-a", account_id: "123", label: "Alice SC" }],
              },
            },
            vault: [{ password: "do not expose" }],
          });
        const body = (await r.json()) as { path: string; method: string; connection_id: string };
        if (!r.url.endsWith("/soundcloud/stream")) expect(body.method).toBe("GET");
        expect(["spotify-a", "soundcloud-a"]).toContain(body.connection_id);
        calls.push(body.path);
        if (!(body.path in responses)) return new Response(null, { status: 404 });
        return Response.json(responses[body.path]);
      },
    },
    MEDIA: {
      get: async (key: string) =>
        objects.has(key) ? { json: async () => JSON.parse(objects.get(key)!) } : null,
      put: async (key: string, value: string) => {
        objects.set(key, value);
      },
    },
  } as unknown as Env;
  return { env, calls, objects };
}
const item = {
  id: "song",
  type: "track",
  name: "Music",
  artists: [{ name: "Artist" }],
  duration_ms: 1000,
  external_ids: { isrc: "US0000000001" },
};
describe("connected music authorization and provider contracts", () => {
  it("checks exact approved SoundCloud account before recording upload preflight", async () => {
    const { env } = fixture({});
    await expect(
      musicRoute(request("soundcloud/not-approved/recordings"), env, account, async () => ({})),
    ).rejects.toMatchObject({ status: 403 });
    const response = await musicRoute(
      request("soundcloud/soundcloud-a/recordings"),
      env,
      account,
      async () => ({}),
    );
    expect(await response.json()).toMatchObject({ available: false });
  });
  it("projects only opted-in sources and no unrelated account fields", async () => {
    const { env } = fixture({});
    expect(
      await musicSources(request("sources"), env, { ...account, capabilities: ["spotify"] }),
    ).toEqual([
      {
        id: "spotify:spotify-a",
        provider: "spotify",
        connectionID: "spotify-a",
        accountID: "alice",
        label: "Alice",
      },
    ]);
    await expect(
      musicRoute(request("spotify/not-approved/playlists"), env, account, async () => ({})),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("uses only the current request's issuer-verified connector projection", async () => {
    const { env } = fixture({});
    env.CONNECT_API_SERVICE!.fetch = vi.fn(async () => {
      throw new Error("Duplicate issuer request");
    }) as NonNullable<Env["CONNECT_API_SERVICE"]>["fetch"];
    const verified = {
      ...account,
      musicConnectors: {
        spotify: { connections: [{ id: "approved", account_id: "alice" }] },
      },
    };
    expect((await musicSources(request("sources"), env, verified)).map((v) => v.accountID)).toEqual(
      ["alice"],
    );
    expect(
      await musicSources(request("sources"), env, { ...verified, musicConnectors: {} }),
    ).toEqual([]);
    expect(env.CONNECT_API_SERVICE!.fetch).not.toHaveBeenCalled();
  });
  it("rejects pagination changing endpoint, host or injecting credentials", () => {
    for (const url of [
      "https://evil.test/v1/me/playlists",
      "https://api.spotify.com/v1/me",
      "https://api.spotify.com/v1/me/playlists?access_token=secret",
      "//evil.test/v1/me/playlists",
    ]) {
      expect(() => pagePath(url, "spotify", "/v1/me/playlists")).toThrow();
    }
    expect(
      pagePath(
        "https://api.spotify.com/v1/me/playlists?offset=50&limit=50",
        "spotify",
        "/v1/me/playlists",
      ),
    ).toBe("/v1/me/playlists?offset=50&limit=50");
  });
  it("accepts SoundCloud page_size cursors without admitting credentials or foreign hosts", () => {
    expect(
      pagePath(
        "https://api.soundcloud.com/me/playlists?cursor=opaque%3A123&linked_partitioning=true&page_size=50",
        "soundcloud",
        "/me/playlists",
      ),
    ).toBe("/me/playlists?cursor=opaque%3A123&linked_partitioning=true&page_size=50");
    expect(() =>
      pagePath(
        "https://api.soundcloud.com/me/playlists?page_size=50&oauth_token=secret",
        "soundcloud",
        "/me/playlists",
      ),
    ).toThrow();
    expect(() =>
      pagePath("https://evil.test/me/playlists?page_size=50", "soundcloud", "/me/playlists"),
    ).toThrow();
  });
  it("normalizes Spotify's exact connected-user playlist alias back to /me", () => {
    expect(
      pagePath(
        "https://api.spotify.com/v1/users/alice/playlists?offset=50&limit=50",
        "spotify",
        "/v1/me/playlists",
        "alice",
      ),
    ).toBe("/v1/me/playlists?offset=50&limit=50");
    expect(() =>
      pagePath(
        "https://api.spotify.com/v1/users/bob/playlists?offset=50",
        "spotify",
        "/v1/me/playlists",
        "alice",
      ),
    ).toThrow();
    expect(() =>
      pagePath(
        "https://evil.test/v1/users/alice/playlists?offset=50",
        "spotify",
        "/v1/me/playlists",
        "alice",
      ),
    ).toThrow();
  });
  it("keeps playlist order and duplicates, accepts current item and legacy track wrappers", async () => {
    const { env } = fixture({
      "/v1/playlists/p": { id: "p", name: "Playlist", tracks: { total: 2 } },
      "/v1/playlists/p/items?limit=100&offset=0": {
        items: [{ item }],
        next: "https://api.spotify.com/v1/playlists/p/items?offset=1&limit=100",
      },
      "/v1/playlists/p/items?offset=1&limit=100": { items: [{ track: item }], next: null },
    });
    const result = (await (
      await musicRoute(request("spotify/spotify-a/playlists/p"), env, account, async () => ({}))
    ).json()) as any;
    expect(result.tracks.map((v: any) => v.remoteID)).toEqual(["song", "song"]);
    expect(result.tracks[0].isrc).toBe("US0000000001");
    expect(result.tracks[0]).not.toHaveProperty("waveform");
  });
  it("downloads use a private metadata input and the existing import queue", async () => {
    const { env, objects } = fixture({
      "/v1/playlists/p": { id: "p", name: "Playlist", tracks: { total: 1 } },
      "/v1/playlists/p/items?limit=100&offset=0": { items: [{ item }] },
    });
    const id = "11111111-1111-4111-8111-111111111111";
    const response = await musicRoute(
      request("spotify/spotify-a/playlists/p/download", "POST"),
      env,
      account,
      async () => ({ id }),
    );
    expect(await response.json()).toEqual({ id, source: "https://open.spotify.com/playlist/p" });
    const artifact = JSON.parse(objects.get(`connected-playlists/owner/${id}.json`)!);
    expect(artifact.tracks[0]).toMatchObject({
      provider: "spotify",
      isrc: "US0000000001",
      order: 1,
    });
    expect(JSON.stringify(artifact)).not.toContain("token");
  });
  it("uses the same SoundCloud URL for catalog, download metadata, and queue identity", async () => {
    const playlist = {
      urn: "soundcloud:playlists:123",
      title: "Playlist",
      permalink_url:
        "https://soundcloud.com/artist/sets/playlist/s-private?utm_source=api&si=tracking",
      track_count: 1,
      tracks: [
        {
          urn: "soundcloud:tracks:456",
          title: "Track",
          permalink_url: "https://soundcloud.com/artist/track",
          duration: 300000,
        },
      ],
    };
    const { env, objects } = fixture({
      "/me/playlists?limit=50&linked_partitioning=true": { collection: [playlist] },
      "/playlists/soundcloud%3Aplaylists%3A123": playlist,
    });
    const source = "https://soundcloud.com/artist/sets/playlist/s-private";
    const catalog = (await (
      await musicRoute(request("soundcloud/soundcloud-a/playlists"), env, account, async () => ({}))
    ).json()) as { playlists: Array<{ url: string }> };
    expect(catalog.playlists[0]?.url).toBe(source);
    const id = "11111111-1111-4111-8111-111111111111";
    const response = await musicRoute(
      request("soundcloud/soundcloud-a/playlists/soundcloud:playlists:123/download", "POST"),
      env,
      account,
      async () => ({ id }),
    );
    expect(await response.json()).toEqual({ id, source });
    expect(JSON.parse(objects.get(`connected-playlists/owner/${id}.json`)!).url).toBe(source);
  });
  it("resolves full SoundCloud API streams through the grant-bound broker", async () => {
    const path = "/tracks/soundcloud:tracks:123/streams/abc-123/hls";
    const { env, calls } = fixture({
      "/tracks/soundcloud%3Atracks%3A123": {
        urn: "soundcloud:tracks:123",
        title: "Full",
        streamable: true,
      },
      "/tracks/soundcloud%3Atracks%3A123/streams": {
        hls_mp3_128_url: "https://api.soundcloud.com" + path,
      },
      [path]: { url: "https://media.sndcdn.com/audio.m3u8?Policy=signed" },
    });
    const response = await musicRoute(
      request("soundcloud/soundcloud-a/tracks/soundcloud:tracks:123/stream"),
      env,
      account,
      async () => ({}),
    );
    expect(await response.json()).toEqual({
      url: "https://media.sndcdn.com/audio.m3u8?Policy=signed",
    });
    expect(calls.at(-1)).toBe(path);
  });
  it.each(["hls_aac_160_url", "hls_aac_96_url"])(
    "plays modern SoundCloud %s streams",
    async (field) => {
      const path = "/tracks/123/streams/abc-123/hls";
      const url =
        "https://playback.media-streaming.soundcloud.cloud/track/aac/uuid/playlist.m3u8?Policy=signed";
      const { env } = fixture({
        "/tracks/123": { id: 123, title: "Full", access: "playable", streamable: true },
        "/tracks/123/streams": {
          hls_aac_160_url: "",
          [field]: "https://api.soundcloud.com" + path,
        },
        [path]: { url },
      });
      const response = await musicRoute(
        request("soundcloud/soundcloud-a/tracks/123/stream"),
        env,
        account,
        async () => ({}),
      );
      expect(await response.json()).toEqual({ url });
    },
  );
  it.each([
    "https://playback.media-streaming.soundcloud.cloud.evil.test/audio.m3u8",
    "https://user:secret@playback.media-streaming.soundcloud.cloud/audio.m3u8",
    "https://playback.media-streaming.soundcloud.cloud:444/audio.m3u8",
    "https://playback.media-streaming.soundcloud.cloud/audio.m3u8?access_token=secret",
    "not a URL",
  ])("rejects unsafe full stream URLs: %s", async (url) => {
    const { env } = fixture({
      "/tracks/123": { id: 123, title: "Full", streamable: true },
      "/tracks/123/streams": { hls_aac_160_url: url },
    });
    await expect(
      musicRoute(
        request("soundcloud/soundcloud-a/tracks/123/stream"),
        env,
        account,
        async () => ({}),
      ),
    ).rejects.toMatchObject({ status: 502 });
  });
  it("reports preview-only stream responses as unavailable instead of an internal error", async () => {
    const { env } = fixture({
      "/tracks/123": { id: 123, title: "Full", streamable: true },
      "/tracks/123/streams": { preview_mp3_128_url: "https://media.sndcdn.com/preview.mp3" },
    });
    await expect(
      musicRoute(
        request("soundcloud/soundcloud-a/tracks/123/stream"),
        env,
        account,
        async () => ({}),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("does not present previews as full playback or return arbitrary streaming hosts", async () => {
    let { env } = fixture({
      "/tracks/123": { id: 123, title: "Preview", access: "preview" },
      "/tracks/123/streams": { preview_mp3_128_url: "https://media.sndcdn.com/preview.mp3" },
    });
    await expect(
      musicRoute(
        request("soundcloud/soundcloud-a/tracks/123/stream"),
        env,
        account,
        async () => ({}),
      ),
    ).rejects.toMatchObject({ status: 403 });
    ({ env } = fixture({
      "/tracks/123": { id: 123, title: "Full", streamable: true },
      "/tracks/123/streams": { hls_aac_160_url: "https://evil.test/audio.m3u8" },
    }));
    await expect(
      musicRoute(
        request("soundcloud/soundcloud-a/tracks/123/stream"),
        env,
        account,
        async () => ({}),
      ),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe("SoundCloud stream startup latency", () => {
  it("checks account approval alongside independently authorized track and stream requests", async () => {
    const { env } = fixture({
      "/tracks/123": { id: 123, title: "Full", streamable: true },
      "/tracks/123/streams": {
        hls_aac_160_url: "https://playback.media-streaming.soundcloud.cloud/audio.m3u8",
      },
    });
    const original = env.CONNECT_API_SERVICE!.fetch.bind(env.CONNECT_API_SERVICE);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paths: string[] = [];
    env.CONNECT_API_SERVICE!.fetch = (async (r: Request) => {
      paths.push(
        new URL(r.url).pathname.endsWith("/connectors")
          ? "connectors"
          : ((await r.clone().json()) as { path: string }).path,
      );
      await gate;
      return original(r);
    }) as NonNullable<Env["CONNECT_API_SERVICE"]>["fetch"];
    const result = musicRoute(
      request("soundcloud/soundcloud-a/tracks/123/stream"),
      env,
      account,
      async () => ({}),
    );
    await vi.waitFor(() =>
      expect(paths).toEqual(["connectors", "/tracks/123", "/tracks/123/streams"]),
    );
    release();
    expect((await result).status).toBe(200);
  });
  it("shares in-flight resolution, expires quickly, separates grants and retries failures", async () => {
    let now = 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const cache = new SoundCloudStreamCache(15000, 2);
      let finish!: (value: string) => void;
      const resolve = vi.fn(
        () =>
          new Promise<string>((r) => {
            finish = r;
          }),
      );
      const first = cache.get("grant-a", resolve);
      const second = cache.get("grant-a", resolve);
      await Promise.resolve();
      expect(resolve).toHaveBeenCalledTimes(1);
      finish("https://media.sndcdn.com/audio");
      expect(await first).toBe(await second);
      expect(await cache.get("grant-a", resolve)).toBe(await first);
      const other = vi.fn(async () => "other");
      expect(await cache.get("grant-b", other)).toBe("other");
      now += 15001;
      expect(await cache.get("grant-a", other)).toBe("other");
      expect(other).toHaveBeenCalledTimes(2);
      await expect(
        cache.get("failed", async () => {
          throw new Error("retry");
        }),
      ).rejects.toThrow("retry");
      expect(await cache.get("failed", other)).toBe("other");
      // Bound memory: inserting a third key evicts the oldest entry.
      await cache.get("third", other);
      await cache.get("grant-a", other);
      expect(other).toHaveBeenCalledTimes(5);
    } finally {
      clock.mockRestore();
    }
  });
  it("rechecks approval before serving a cached stream and isolates grants", async () => {
    const { env, calls } = fixture({
      "/tracks/456": { id: 456, title: "Full", streamable: true },
      "/tracks/456/streams": { hls_aac_160_url: "https://media.sndcdn.com/audio.m3u8" },
    });
    const r = request("soundcloud/soundcloud-a/tracks/456/stream");
    r.headers.delete("cache-control");
    const read = (selected = account) => musicRoute(r, env, selected, async () => ({}));
    await Promise.all([read(), read()]);
    expect(calls).toHaveLength(2);
    await read({ ...account, grantId: "another-grant" });
    expect(calls).toHaveLength(4);
    const original = env.CONNECT_API_SERVICE!.fetch.bind(env.CONNECT_API_SERVICE);
    env.CONNECT_API_SERVICE!.fetch = (async (request: Request) =>
      new URL(request.url).pathname.endsWith("/connectors")
        ? Response.json({ connectors: {} })
        : original(request)) as NonNullable<Env["CONNECT_API_SERVICE"]>["fetch"];
    await expect(read()).rejects.toMatchObject({ status: 403 });
    expect(calls).toHaveLength(4);
  });
});
