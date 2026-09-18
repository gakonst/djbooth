import { expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    constructor(
      public ctx: any,
      public env: any,
    ) {}
  },
}));
vi.mock("cloudflare:workflows", () => ({ NonRetryableError: class extends Error {} }));
import { DownloadWorkflow, ensureDownloadWorkflow } from "../src/download-workflow.js";
import { imports } from "../src/imports.js";
vi.mock("../src/agent-tools.js", () => ({
  ensureAgentTools: vi.fn(() => {
    throw new Error("Agent must not be involved");
  }),
}));
vi.mock("../src/agent.js", () => ({
  agentRoute: vi.fn(() => {
    throw new Error("Agent must not be involved");
  }),
}));

function setup() {
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../migrations/", import.meta.url)).sort())
    if (file.endsWith(".sql"))
      db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  const instances = new Map<string, any>();
  const env: any = {
    LIBRARY_DB: {
      prepare: (sql: string) => ({
        bind: (...args: any[]) => ({
          first: async () => db.prepare(sql).get(...args) ?? null,
          run: async () => db.prepare(sql).run(...args),
        }),
      }),
    },
    DOWNLOAD_WORKFLOW: {
      create: vi.fn(async ({ id, params }) => {
        if (instances.has(id)) throw new Error("Already exists");
        instances.set(id, params);
      }),
      get: vi.fn(async (id) => ({
        status: async () => {
          if (!instances.has(id)) throw new Error("Unavailable");
          return { status: "running" };
        },
      })),
    },
    PLAYLIST_CONTAINERS: { idFromName: (name: string) => name, getByName: vi.fn() },
  };
  const account = { id: "account-a", grantId: "grant", expiresAt: 9999999999, capabilities: [] };
  const id = "11111111-1111-1111-1111-111111111111";
  const source = "https://soundcloud.com/artist/sets/list";
  const submit = (body: any, owner = account, path = "/v1/imports") =>
    imports(
      new Request(`https://library.test${path}`, { method: "POST" }),
      env,
      owner,
      async () => body,
    );
  return { db, env, account, id, source, submit, instances };
}

test("mobile submission needs no agent catalog, deduplicates delivery, and isolates accounts", async () => {
  const { db, env, account, id, source, submit, instances } = setup();
  try {
    expect((await submit({ id, source })).status).toBe(200);
    expect((await submit({ id, source })).status).toBe(200);
    expect(instances.size).toBe(1);
    expect((await submit({ id, source }, { ...account, id: "account-b" })).status).toBe(200);
    expect(instances.size).toBe(2);
    expect((await submit({ id, source: "https://youtu.be/other" })).status).toBe(409);
    const prior: any = db
      .prepare("SELECT * FROM import_requests WHERE account_id='account-a'")
      .get();
    db.prepare("UPDATE import_requests SET status='failed' WHERE account_id='account-a'").run();
    await submit({}, account, `/v1/imports/${id}/retry`);
    const next: any = db
      .prepare("SELECT * FROM import_requests WHERE account_id='account-a'")
      .get();
    expect(next.workflow_id).not.toBe(prior.workflow_id);
    expect(next.container_id).toBe(prior.container_id);
    expect(next.agent_turn_id).toBeNull();
    expect(env.PLAYLIST_CONTAINERS.getByName).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});

test.each([false, true])(
  "workflow retries interrupted stages and carries resolution refresh=%s into the container",
  async (refreshResolution) => {
    const { db, env, id, source, submit } = setup();
    try {
      await submit({ id, source });
      const row: any = db.prepare("SELECT * FROM import_requests").get();
      let fail = true;
      let oldResolveReceipt = refreshResolution;
      const stages: string[] = [];
      const imported = {
        playlistId: "17",
        entries: 2,
        dbPath: "/data/master.db",
        sourceSetFallbacks: 0,
      };
      const collectionID = `cloud:${id}:playlist:17`;
      const container = {
        recordImportEvent: vi.fn(async () => {}),
        enqueue: vi.fn(),
        poll: vi.fn(),
        workflowExecute: vi.fn(
          async (account: string, job: string, instance: string, input: any) => {
            expect([account, job, instance]).toEqual(["account-a", id, row.workflow_id]);
            if (input.operation === "ready") return { status: "ready" };
            stages.push(input.stage);
            expect(input.refresh_resolution === true).toBe(
              input.stage === "resolve" && refreshResolution,
            );
            if (input.stage === "resolve" && oldResolveReceipt) {
              oldResolveReceipt = false;
              return { status: "completed", process_id: input.process_id, result: { entries: 6 } };
            }
            if (input.stage === "import" && fail) {
              fail = false;
              throw new Error("Connection closed: Durable Object restarted");
            }
            if (input.stage === "publish") {
              expect(input.imported).toEqual(imported);
              db.prepare(
                "UPDATE import_requests SET status='complete',collection_id=?,analysis_version=1",
              ).run(collectionID);
            }
            return {
              status: "completed",
              process_id: input.process_id,
              result:
                input.stage === "import"
                  ? imported
                  : input.stage === "publish"
                    ? { collectionID }
                    : refreshResolution
                      ? { refreshed: true }
                      : {},
            };
          },
        ),
      };
      env.PLAYLIST_CONTAINERS.getByName.mockReturnValue(container);
      const step: any = {
        do: async (_name: string, config: any, fn?: any) => {
          const callback = fn ?? config;
          try {
            return await callback({ attempt: 1 });
          } catch {
            return callback({ attempt: 2 });
          }
        },
      };
      const workflow = new DownloadWorkflow({} as any, env);
      const event: any = {
        payload: { accountId: "account-a", id, source, refreshResolution },
        instanceId: row.workflow_id,
      };
      expect(await workflow.run(event, step)).toEqual({ collectionID });
      expect(stages).toEqual([
        "resolve",
        ...(refreshResolution ? ["resolve"] : []),
        "import",
        "import",
        "enrich",
        "publish",
      ]);
      // An RPC stub stays broken after eviction; every retry needs a fresh stub.
      expect(env.PLAYLIST_CONTAINERS.getByName.mock.calls.length).toBeGreaterThanOrEqual(7);
      const events = container.recordImportEvent.mock.calls as unknown as [
        string,
        string,
        string,
        Record<string, unknown>,
      ][];
      expect(
        events
          .filter(([, , name]) => name === "workflow_stage_failed")
          .map(([, , , fields]) => fields),
      ).toEqual([
        ...(refreshResolution
          ? [
              expect.objectContaining({
                stage: "resolve",
                attempt: 1,
              }),
            ]
          : []),
        expect.objectContaining({
          importID: id,
          workflowID: row.workflow_id,
          stage: "import",
          attempt: 1,
          failure: "transport",
        }),
      ]);
      expect(events.at(-1)?.[2]).toBe("workflow_completed");
      expect(events.every(([account, job]) => account === "account-a" && job === id)).toBe(true);
    } finally {
      db.close();
    }
  },
);

test("submission uncertainty is retried by cron using the persisted ID", async () => {
  const { db, env, id, source } = setup();
  try {
    env.DOWNLOAD_WORKFLOW.create.mockRejectedValueOnce(new Error("Network lost"));
    await expect(
      ensureDownloadWorkflow(env, { accountId: "account-a", id, source }, "stable"),
    ).rejects.toThrow();
    await ensureDownloadWorkflow(env, { accountId: "account-a", id, source }, "stable");
    await ensureDownloadWorkflow(env, { accountId: "account-a", id, source }, "stable");
    expect(env.DOWNLOAD_WORKFLOW.create.mock.calls.map((call: any) => call[0].id)).toEqual([
      "stable",
      "stable",
      "stable",
    ]);
  } finally {
    db.close();
  }
});

test("import evidence persists on create and eligible retry, with idempotent deliveries", async () => {
  const { db, id, source, submit, account, instances } = setup();
  const first = "https://groovesmaxxing.com/tracklists/first-set";
  const next = "https://groovesmaxxing.com/tracklists/corrected-set";
  try {
    expect(await (await submit({ id, source, evidenceURL: first })).json()).toMatchObject({
      evidenceURL: first,
    });
    expect((await submit({ id, source, evidenceURL: first })).status).toBe(200);
    expect(instances.size).toBe(1);
    expect((await submit({ id, source, evidenceURL: next })).status).toBe(409);
    expect((await submit({ evidenceURL: next }, account, `/v1/imports/${id}/retry`)).status).toBe(
      409,
    );
    db.prepare("UPDATE import_requests SET status='failed'").run();
    const requestID = "22222222-2222-2222-2222-222222222222";
    expect(
      await (
        await submit({ requestID, evidenceURL: next }, account, `/v1/imports/${id}/retry`)
      ).json(),
    ).toMatchObject({ evidenceURL: next });
    expect(
      (await submit({ requestID, evidenceURL: next }, account, `/v1/imports/${id}/retry`)).status,
    ).toBe(200);
    expect(instances.size).toBe(2);
    expect(instances.get(requestID)).toMatchObject({ refreshResolution: true });
    db.prepare("UPDATE import_requests SET status='failed'").run();
    expect(await (await submit({}, account, `/v1/imports/${id}/retry`)).json()).toMatchObject({
      evidenceURL: next,
    });
    expect(db.prepare("SELECT resolution_evidence_url FROM import_requests").get()).toMatchObject({
      resolution_evidence_url: next,
    });
    expect(
      (await submit({ evidenceURL: first }, { ...account, id: "other" }, `/v1/imports/${id}/retry`))
        .status,
    ).toBe(404);
  } finally {
    db.close();
  }
});

test.each([
  null,
  4,
  "http://groovesmaxxing.com/set",
  "https://127.0.0.1/set",
  "https://groovesmaxxing.com.evil.test/set",
  "https://user:pass@groovesmaxxing.com/set",
  "https://groovesmaxxing.com:8443/set",
  "https://groovesmaxxing.com/",
  "https://groovesmaxxing.com/login",
  "https://groovesmaxxing.com/set#fragment",
  "See https://groovesmaxxing.com/set",
])("rejects invalid import evidence %s before persistence", async (evidenceURL) => {
  const { db, id, source, submit, account, instances } = setup();
  try {
    expect((await submit({ id, source, evidenceURL })).status).toBe(400);
    expect((await submit({ evidenceURL }, account, `/v1/imports/${id}/retry`)).status).toBe(400);
    expect(db.prepare("SELECT count(*) AS count FROM import_requests").get()).toMatchObject({
      count: 0,
    });
    expect(instances.size).toBe(0);
  } finally {
    db.close();
  }
});
