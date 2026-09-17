import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vitest";
vi.mock("cloudflare:workflows", () => ({ NonRetryableError: Error }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {} }));
vi.mock("../src/agent-tools.js", () => ({ ensureAgentTools: vi.fn() }));
import { imports, inspectImport } from "../src/imports.js";

const id = "11111111-1111-4111-8111-111111111111";
const retryID = "22222222-2222-4222-8222-222222222222";
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE import_requests(account_id TEXT, id TEXT, source TEXT, status TEXT, phase TEXT,
    current INTEGER, total INTEGER, message TEXT, stage_progress TEXT, collection_id TEXT,
    created_at INTEGER, updated_at INTEGER, workflow_id TEXT, analysis_repair INTEGER,
    agent_grant_id TEXT, agent_id TEXT, agent_turn_id TEXT);
    INSERT INTO import_requests VALUES('owner','${id}','https://youtu.be/set','complete','complete',2,2,'2 set extracts',
    '{}','cloud:${id}:playlist:1',0,0,'old-workflow',1,'grant','agent',NULL);`);
  const report = vi.fn(async () => ({
    total: 2,
    tracks: [{ order: 1, kind: "source-set-clip" }],
    nextOffset: null,
  }));
  const env = {
    LIBRARY_DB: {
      prepare: (sql: string) => ({
        bind: (...args: any[]) => ({
          first: async () => db.prepare(sql).get(...args),
          run: async () => db.prepare(sql).run(...args),
        }),
      }),
    },
    PLAYLIST_CONTAINERS: {
      getByName: vi.fn(() => ({ importReport: report, importTelemetry: async () => null })),
    },
    DOWNLOAD_WORKFLOW: { create: vi.fn(async () => ({})) },
  } as any;
  const retry = (body: unknown, account = "owner") =>
    imports(
      new Request(`https://library.test/v1/imports/${id}/retry`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
      env,
      { id: account, grantId: "grant", agentId: "agent" } as any,
      (request) => request.json(),
    );
  return { db, env, report, retry };
}

test("completed imports require explicit refresh, reuse the library and deduplicate retry receipts", async () => {
  const { db, env, retry } = setup();
  try {
    expect((await (await retry({})).json()).status).toBe("complete");
    expect((await retry({ mode: "refresh" })).status).toBe(400);
    const refreshed = await (await retry({ mode: "refresh", requestID: retryID })).json();
    expect(refreshed).toMatchObject({
      id,
      status: "queued",
      execution: "workflow",
      collectionID: `cloud:${id}:playlist:1`,
    });
    expect(
      db.prepare("SELECT workflow_id,analysis_repair,stage_progress FROM import_requests").get(),
    ).toMatchObject({ workflow_id: retryID, analysis_repair: 0, stage_progress: null });
    db.exec("UPDATE import_requests SET status='complete'");
    expect((await (await retry({ mode: "refresh", requestID: retryID })).json()).status).toBe(
      "complete",
    );
    expect(env.DOWNLOAD_WORKFLOW.create).toHaveBeenCalledTimes(1);
    expect(
      (await retry({ mode: "refresh", requestID: crypto.randomUUID() }, "stranger")).status,
    ).toBe(404);
  } finally {
    db.close();
  }
});

test("status reads fresh job progress and account-scoped paginated reports without launching work", async () => {
  const { db, env, report } = setup();
  try {
    expect(await inspectImport(env, "owner", id, 50)).toMatchObject({
      status: "complete",
      reportAvailable: true,
    });
    expect(report).toHaveBeenCalledWith("owner", id, 50);
    db.exec("UPDATE import_requests SET status='running',phase='download'");
    expect(await inspectImport(env, "owner", id)).toMatchObject({
      status: "running",
      phase: "download",
    });
    await expect(inspectImport(env, "stranger", id)).rejects.toThrow("Import not found");
    await expect(inspectImport(env, "owner", id, 1)).rejects.toThrow("multiples of 50");
    expect(env.DOWNLOAD_WORKFLOW.create).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});

test("unavailable diagnostics preserve status and prior-run reports are flagged", async () => {
  const { db, env, report } = setup();
  try {
    expect(await inspectImport(env, "owner", id)).toMatchObject({
      reportCurrent: false,
      telemetry: null,
      ageMs: expect.any(Number),
    });
    report.mockRejectedValue(new Error("private token=https://example.test/secret"));
    expect(await inspectImport(env, "owner", id)).toMatchObject({
      status: "complete",
      reportAvailable: false,
      reportCurrent: false,
    });
  } finally {
    db.close();
  }
});
