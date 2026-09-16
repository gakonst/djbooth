import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
  ContainerProxy: class {},
  Container: class {
    ctx: any;
    env: any;
    schedules = new Set<string>();
    startAndWaitForPorts = vi.fn(async () => {});
    containerFetch = vi.fn(async () =>
      Response.json({
        status: "running",
        phase: "analyze",
        current: 2,
        total: 4,
        message: "Analyzing recordings",
      }),
    );
    destroy = vi.fn(async () => {});
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
    async schedule(_delay: number, callback: string) {
      this.schedules.add(callback);
    }
    deleteSchedules(callback: string) {
      this.schedules.delete(callback);
    }
  },
}));
import * as library from "../src/index.js";
import { PlaylistContainer, validProgress } from "../src/playlist-container.js";

const id = "11111111-1111-1111-1111-111111111111";
function setup(admit = true) {
  const state = new Map<string, unknown>();
  const writes: unknown[][] = [];
  const storage = {
    get: async (key: string) => state.get(key),
    put: async (key: string, value: unknown) => {
      state.set(key, structuredClone(value));
    },
    delete: async (key: string) => state.delete(key),
  };
  const env = {
    IMPORT_PROVIDER_ENV: JSON.stringify({ SLSK_USERNAME: "user", SLSK_PASSWORD: "password" }),
    LIBRARY_DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async () =>
            sql.includes("RETURNING") ? (admit ? { id } : null) : { status: "queued" },
          run: async () => {
            writes.push(args);
            return {};
          },
        }),
      }),
    },
  };
  const runner = new PlaylistContainer({ storage } as any, env as any) as PlaylistContainer & {
    schedules: Set<string>;
  };
  return { runner, state, writes };
}

describe("playlist container lifecycle", () => {
  beforeEach(() => vi.restoreAllMocks());
  test("a durable scheduled job progresses with no phone connection and shuts down on completion", async () => {
    const { runner, state, writes } = setup();
    await runner.enqueue("account-a", id, "https://soundcloud.com/artist/sets/playlist");
    await runner.enqueue("account-a", id, "https://soundcloud.com/artist/sets/playlist");
    expect(state.size).toBe(1);
    expect(runner.schedules.has("poll")).toBe(true);
    await runner.poll();
    const startup = vi.mocked(runner.startAndWaitForPorts).mock.calls[0]![0] as any;
    expect(startup.startOptions.envVars.DJBOOTH_IMPORT_ID).toBe(id);
    expect(startup.startOptions.envVars.DJBOOTH_CONTAINER_BINDINGS).toBe("1");
    expect(JSON.stringify(startup)).not.toMatch(/R2_|SNAPSHOT_BUCKET|CLOUD_TOKEN|CLOUD_URL/);
    expect(startup.startOptions.envVars.SLSK_PASSWORD).toBe("password");
    expect(writes[0]!.slice(0, 4)).toEqual(["running", "analyze", 2, 4]);
    expect(JSON.stringify(writes)).not.toContain("password");
    expect(runner.destroy).not.toHaveBeenCalled();
    vi.mocked(runner.containerFetch).mockResolvedValueOnce(
      Response.json({
        status: "complete",
        phase: "complete",
        analysisVersion: 1,
        current: 4,
        total: 4,
        message: "Published 4 tracks",
        collectionID: `cloud:${id}:playlist:1`,
      }),
    );
    await runner.poll();
    expect(runner.destroy).toHaveBeenCalledOnce();
    expect(state.size).toBe(0);
    expect(runner.schedules.has("poll")).toBe(false);
    expect(writes.at(-1)![0]).toBe("complete");
    expect(writes.at(-1)![6]).toBe(1);
  });
  test("capacity keeps playlists queued without launching or consuming startup retries", async () => {
    const { runner, state } = setup(false);
    await runner.enqueue("account-a", id, "https://youtu.be/set");
    await runner.poll();
    expect(runner.startAndWaitForPorts).not.toHaveBeenCalled();
    expect((state.get("job") as any).failures).toBe(0);
    expect(runner.schedules.has("poll")).toBe(true);
  });
  test("startup failures are bounded and retry schedules a fresh attempt on the same identity", async () => {
    const { runner, state, writes } = setup();
    await runner.enqueue("account-a", id, "https://youtu.be/set");
    vi.mocked(runner.startAndWaitForPorts).mockRejectedValue(
      new Error("capacity or configuration"),
    );
    for (let attempt = 0; attempt < 5; attempt++) await runner.poll();
    expect(writes.at(-1)![0]).toContain("could not run");
    expect(runner.destroy).toHaveBeenCalledOnce();
    expect(state.size).toBe(0);
    await runner.enqueue("account-a", id, "https://youtu.be/set");
    expect((state.get("job") as any).id).toBe(id);
    expect((state.get("job") as any).failures).toBe(0);
    expect(runner.schedules.has("poll")).toBe(true);
  });
  test("overlapping alarms share one in-flight poll", async () => {
    const { runner } = setup();
    await runner.enqueue("account-a", id, "https://youtu.be/set");
    await Promise.all([runner.poll(), runner.poll()]);
    expect(runner.containerFetch).toHaveBeenCalledOnce();
  });
  test("rejects corrupt progress", () => {
    expect(
      validProgress({
        status: "complete",
        phase: "complete",
        current: 3,
        total: 3,
        message: "Audio only",
      }),
    ).toBe(false);
    expect(
      validProgress({ status: "running", phase: "analyze", current: 5, total: 3, message: "bad" }),
    ).toBe(false);
    expect(
      validProgress({
        status: "running",
        phase: "analyze",
        current: 1,
        total: 3,
        message: "ok",
        collectionID: "/private/master.db",
      }),
    ).toBe(false);
  });
});

test("outbound requests derive ownership from the container, ignoring supplied account headers", async () => {
  const handler = PlaylistContainer.outboundByHost!["djbooth.internal"]!;
  const fetch = vi.spyOn(library, "accountFetch").mockResolvedValue(new Response("ok"));
  const bind = vi.fn(() => ({ first: async () => ({ account_id: "account-a" }) }));
  const env = { LIBRARY_DB: { prepare: () => ({ bind }) } } as any;
  const context = { containerId: "container-a", className: "PlaylistContainer", params: undefined };
  expect(
    (await handler(new Request("http://djbooth.internal/v1/imports"), env, context)).status,
  ).toBe(404);
  expect(fetch).not.toHaveBeenCalled();
  await handler(
    new Request("http://djbooth.internal/v1/sync/changes", {
      headers: { "x-account-id": "account-b", authorization: "Bearer other" },
    }),
    env,
    context,
  );
  expect(bind).toHaveBeenCalledWith("container-a");
  expect(fetch.mock.calls[0]![2].id).toBe("account-a");
  const denied = {
    LIBRARY_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
  } as any;
  expect(
    (await handler(new Request("http://djbooth.internal/snapshot/files"), denied, context)).status,
  ).toBe(403);
});
