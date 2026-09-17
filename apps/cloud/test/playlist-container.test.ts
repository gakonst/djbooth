vi.mock("cloudflare:workflows", () => ({ NonRetryableError: Error }));
vi.mock("cloudflare:workers", () => ({ DurableObject: class {}, WorkflowEntrypoint: class {} }));
import { beforeEach, describe, expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

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

test("scheduled cloud maintenance resumes old completed imports once, without retrying failures or ready libraries", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE login_codes(expires_at INTEGER);
    CREATE TABLE playback_sessions(expires_at INTEGER);
    CREATE TABLE import_requests(account_id TEXT, id TEXT, source TEXT, status TEXT, phase TEXT,
      current INTEGER, total INTEGER, message TEXT, updated_at INTEGER, created_at INTEGER, analysis_version INTEGER, analysis_repair INTEGER DEFAULT 0);
    INSERT INTO import_requests VALUES
      ('account-a','old','https://youtu.be/old','complete','complete',3,3,'done',0,0,0,0),
      ('account-b','ready','https://youtu.be/ready','complete','complete',3,3,'done',0,0,1,0),
      ('account-a','failed','https://youtu.be/failed','failed','failed',0,3,'failed',0,0,0,0);`);
  const launched: string[] = [];
  const env = {
    LIBRARY_DB: {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        return {
          bind: (...args: any[]) => ({ run: async () => statement.run(...args) }),
          all: async () => ({ results: statement.all() }),
        };
      },
    },
    PLAYLIST_CONTAINERS: {
      getByName: (name: string) => ({
        enqueue: async () => {
          launched.push(name);
        },
      }),
    },
  };
  try {
    await library.default.scheduled({} as any, env as any);
    expect(launched).toEqual(["account-a:old"]);
    expect(
      db.prepare("SELECT status,message,analysis_repair FROM import_requests WHERE id='old'").get(),
    ).toMatchObject({
      status: "queued",
      message: "Updating CDJ files in the cloud",
      analysis_repair: 1,
    });
    db.exec("UPDATE import_requests SET status='complete',analysis_version=1 WHERE id='old'");
    launched.length = 0;
    await library.default.scheduled({} as any, env as any);
    expect(launched).toEqual([]);
  } finally {
    db.close();
  }
});
function setup(admit = true, repair = false, owner: Record<string, string> = {}) {
  const state = new Map<string, unknown>();
  const writes: unknown[][] = [];
  const storage = {
    transaction: async (callback: (storage: any) => Promise<unknown>) => callback(storage),
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
            sql.includes("RETURNING")
              ? admit
                ? { id }
                : null
              : { status: "queued", analysis_repair: repair ? 1 : 0, ...owner },
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
  test("retains paginated, account-scoped diagnostics after the workspace sleeps", async () => {
    const { runner, state } = setup();
    await runner.enqueue("account-a", id, "https://youtu.be/existing");
    vi.mocked(runner.containerFetch).mockResolvedValue(
      Response.json({
        status: "complete",
        phase: "complete",
        current: 51,
        total: 51,
        message: "Published",
        analysisVersion: 1,
        report: {
          updatedAt: "2026-09-17T00:00:00Z",
          tracklist: { provider: "agent" },
          warnings: [],
          tracks: Array.from({ length: 51 }, (_, i) => ({
            order: i + 1,
            kind: i ? "individual" : "source-set-clip",
          })),
        },
      }),
    );
    await runner.poll();
    expect(state.has("job")).toBe(false);
    expect((await runner.importReport("account-a", id, 0))?.tracks).toHaveLength(50);
    expect(await runner.importReport("account-a", id, 50)).toMatchObject({
      tracks: [{ order: 51, kind: "individual" }],
      nextOffset: null,
    });
    expect((await runner.importReport("account-a", id, 100))?.tracks).toEqual([]);
    expect(await runner.importReport("account-b", id, 0)).toBeNull();
  });
  test("maintenance restores the saved import with artifact-only publication", async () => {
    const { runner, state } = setup(true, true);
    await runner.enqueue("account-a", id, "https://youtu.be/existing");
    expect((state.get("job") as any).analysisRepair).toBe(true);
    await runner.poll();
    const startup = vi.mocked(runner.startAndWaitForPorts).mock.calls[0]![0] as any;
    expect(startup.startOptions.envVars.DJBOOTH_ANALYSIS_REPAIR).toBe("1");
  });
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
    expect(state.has("job")).toBe(false);
    expect((await runner.importTelemetry("account-a", id))?.events.at(-1)).toMatchObject({
      status: "complete",
    });
    expect(runner.schedules.has("poll")).toBe(false);
    expect(writes.at(-1)![0]).toBe("complete");
    expect(writes.at(-1)![7]).toBe(1);
  });
  test("continuation preserves the running executor and its original deadline", async () => {
    const owner = { agent_grant_id: "grant", agent_id: "agent", agent_turn_id: "turn-one" };
    const { runner, state } = setup(true, false, owner);
    await runner.enqueue("account-a", id, "https://youtu.be/set");
    const original = structuredClone(state.get("job")) as any;
    owner.agent_turn_id = "turn-two";
    await runner.enqueue("account-a", id, "https://youtu.be/set");
    expect(state.get("job")).toEqual({ ...original, agentTurnId: "turn-two" });
    expect(runner.destroy).not.toHaveBeenCalled();
    expect(runner.schedules.has("poll")).toBe(true);
    owner.agent_grant_id = "new-grant";
    await runner.enqueue("account-a", id, "https://youtu.be/set");
    expect(runner.destroy).toHaveBeenCalledOnce();
  });
  test("capacity keeps playlists queued without launching or consuming startup retries", async () => {
    const { runner, state } = setup(false);
    await runner.enqueue("account-a", id, "https://youtu.be/set");
    await runner.poll();
    expect(runner.startAndWaitForPorts).not.toHaveBeenCalled();
    expect((state.get("job") as any).failures).toBe(0);
    expect(runner.schedules.has("poll")).toBe(true);
  });
  test("temporary startup failures keep retrying without deleting saved work", async () => {
    const { runner, state } = setup();
    await runner.enqueue("account-a", id, "https://youtu.be/set");
    vi.mocked(runner.startAndWaitForPorts).mockRejectedValue(new Error("capacity"));
    for (let attempt = 0; attempt < 6; attempt++) await runner.poll();
    expect(runner.destroy).not.toHaveBeenCalled();
    expect((state.get("job") as any).failures).toBe(6);
    expect(runner.schedules.has("poll")).toBe(true);
    vi.mocked(runner.startAndWaitForPorts).mockResolvedValue(undefined as any);
    await runner.poll();
    expect((state.get("job") as any).failures).toBe(0);
  });
  test("agent workspace initialization failures restart automatically with the same job", async () => {
    const { runner, state, writes } = setup(true, false, {
      agent_grant_id: "grant",
      agent_id: "agent",
      agent_turn_id: "turn",
    });
    await runner.enqueue("account-a", id, "https://youtu.be/set");
    vi.mocked(runner.containerFetch).mockResolvedValueOnce(
      Response.json({
        status: "failed",
        phase: "failed",
        current: 0,
        total: 1,
        message: "Storage temporarily unavailable",
      }),
    );
    await runner.poll();
    expect(runner.destroy).toHaveBeenCalledOnce();
    expect((state.get("job") as any).failures).toBe(1);
    expect(writes).toEqual([]);
    expect(runner.schedules.has("poll")).toBe(true);
    await runner.poll();
    expect((state.get("job") as any).failures).toBe(0);
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

test("container RPC independently rejects another account, Connect grant or agent", async () => {
  const { runner, state } = setup();
  await runner.enqueue("account-a", id, "https://soundcloud.com/owner/sets/playlist");
  const job = state.get("job") as any;
  job.agentGrantId = "grant-a";
  job.agentId = "agent-a";
  state.set("job", job);
  for (const [account, grant, agent] of [
    ["account-b", "grant-a", "agent-a"],
    ["account-a", "grant-b", "agent-a"],
    ["account-a", "grant-a", "agent-b"],
  ]) {
    await expect(
      runner.execute(account!, grant!, agent!, id, { operation: "instructions" }),
    ).rejects.toThrow("ownership");
  }
  expect(runner.containerFetch).not.toHaveBeenCalled();
});

test("workflow ownership fences agent execution and changed attempts restore the same private workspace", async () => {
  const owner = { workflow_id: "workflow-a", agent_grant_id: "grant", agent_id: "agent" };
  const { runner, state } = setup(true, false, owner);
  await runner.enqueue("account-a", id, "https://youtu.be/existing");
  await expect(
    runner.execute("account-a", "grant", "agent", id, { operation: "start" }),
  ).rejects.toThrow("ownership");
  await expect(runner.workflowExecute("account-b", id, "workflow-a", {})).rejects.toThrow(
    "ownership",
  );
  await expect(runner.workflowExecute("account-a", id, "workflow-b", {})).rejects.toThrow(
    "ownership",
  );
  await runner.poll();
  const startup = vi.mocked(runner.startAndWaitForPorts).mock.calls[0]![0] as any;
  expect(startup.startOptions.envVars.DJBOOTH_WORKFLOW).toBe("1");
  expect(startup.startOptions.envVars.DJBOOTH_AGENT).toBe("0");
  owner.workflow_id = "workflow-b";
  await runner.enqueue("account-a", id, "https://youtu.be/existing");
  expect(runner.destroy).toHaveBeenCalledOnce();
  expect((state.get("job") as any).workflowId).toBe("workflow-b");
});

test("deployment adopts interrupted agent jobs once and preserves genuine source failures", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../migrations/", import.meta.url)).sort())
    if (file.endsWith(".sql"))
      db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  db.prepare(
    "INSERT INTO import_requests(account_id,id,container_id,source,status,message,created_at,updated_at) VALUES ('owner','interrupted','saved-container','https://soundcloud.com/artist/sets/list','failed','Your agent stopped before publishing all tracks. Retry to resume saved work.',0,0)",
  ).run();
  db.prepare(
    "INSERT INTO import_requests(account_id,id,container_id,source,status,message,created_at,updated_at) VALUES ('owner','unresolved','other-container','https://youtu.be/no-tracklist','failed','No verified tracklist was found',0,0)",
  ).run();
  const created: string[] = [];
  const env: any = {
    LIBRARY_DB: {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        return {
          all: async () => ({ results: statement.all() }),
          bind: (...args: any[]) => ({
            run: async () => statement.run(...args),
            first: async () => statement.get(...args),
          }),
        };
      },
    },
    DOWNLOAD_WORKFLOW: {
      create: async ({ id }: any) => {
        created.push(id);
      },
    },
    PLAYLIST_CONTAINERS: { getByName: () => ({ enqueue: async () => {} }) },
  };
  try {
    await library.default.scheduled({} as any, env);
    const first: any = db.prepare("SELECT * FROM import_requests WHERE id='interrupted'").get();
    expect(first).toMatchObject({ status: "queued", container_id: "saved-container" });
    expect(first.workflow_id).toMatch(/^[a-f0-9]{32}$/);
    await library.default.scheduled({} as any, env);
    expect(created).toEqual([first.workflow_id, first.workflow_id]);
    expect(
      db.prepare("SELECT status,workflow_id FROM import_requests WHERE id='unresolved'").get(),
    ).toMatchObject({ status: "failed", workflow_id: null });
  } finally {
    db.close();
  }
});

test("diagnostic history is bounded, account scoped and survives completion", async () => {
  const { runner, state } = setup();
  for (let attempt = 1; attempt <= 110; attempt++) {
    await runner.recordImportEvent("account-a", id, "workflow_stage_started", {
      attempt,
      stage: "import",
      token: "secret",
      source: "https://private.test/?token=secret",
    });
  }
  const history = await runner.importTelemetry("account-a", id);
  expect(history).toMatchObject({ retained: 100, limit: 100 });
  expect(history?.events).toHaveLength(20);
  expect(history?.events.at(-1)).toMatchObject({ attempt: 110, importID: id });
  expect(JSON.stringify(history)).not.toContain("secret");
  expect(await runner.importTelemetry("account-b", id)).toBeNull();
  await runner.recordImportEvent("account-b", id, "malicious_event");
  expect((await runner.importTelemetry("account-a", id))?.events.at(-1)?.event).toBe(
    "workflow_stage_started",
  );
  state.delete("job");
  expect(await runner.importTelemetry("account-a", id)).toEqual(history);
});

test("diagnostic storage failures never prevent import progress", async () => {
  const { runner } = setup();
  await runner.enqueue("account-a", id, "https://youtu.be/existing");
  vi.spyOn((runner as any).ctx.storage, "transaction").mockRejectedValue(
    new Error("storage unavailable"),
  );
  await expect(
    runner.recordImportEvent("account-a", id, "workflow_stage_started"),
  ).resolves.toBeUndefined();
  await runner.poll();
  expect(runner.destroy).not.toHaveBeenCalled();
});

test("a refreshed import cannot inherit the earlier workflow's failure timeline", async () => {
  const { runner } = setup();
  await runner.recordImportEvent("account-a", id, "workflow_failed", {
    workflowID: "old-run",
    status: "failed",
  });
  expect((await runner.importTelemetry("account-a", id, "new-run"))?.events).toEqual([]);
  await runner.recordImportEvent("account-a", id, "workflow_stage_started", {
    workflowID: "new-run",
    stage: "resolve",
  });
  expect((await runner.importTelemetry("account-a", id, "new-run"))?.events).toEqual([
    expect.objectContaining({ workflowID: "new-run", stage: "resolve" }),
  ]);
});
