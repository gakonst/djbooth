import { afterEach, expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {},
  DurableObject: class {
    constructor(
      public ctx: any,
      public env: any,
    ) {}
  },
}));
vi.mock("cloudflare:workflows", () => ({ NonRetryableError: Error }));
vi.mock("../src/imports.js", () => ({ promptDownload: vi.fn() }));
import { AgentTools } from "../src/agent-tools.js";
import { promptDownload } from "../src/imports.js";
import { CONNECT_APP_ID } from "../src/auth.js";

const owner = {
  account: { id: "account", grantId: "grant", agentId: "agent" },
  token: "nc1.grant.credential",
  origin: "https://library.test",
};
const databases: DatabaseSync[] = [];
afterEach(() => {
  databases.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
});
function setup() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  for (const file of readdirSync(new URL("../migrations/", import.meta.url)).sort()) {
    if (file.endsWith(".sql"))
      db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  const storage = {
    get: vi.fn(async () => owner),
    put: vi.fn(async () => {}),
    setAlarm: vi.fn(async () => {}),
    deleteAlarm: vi.fn(async () => {}),
  };
  const fetch = vi.fn(async (request: Request) => {
    expect(new URL(request.url).pathname).toBe("/v1/grants/grant/agents/agent");
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe("Bearer credential");
    expect(request.headers.get("origin")).toBe(owner.origin);
    expect(request.headers.get("x-nanocodex-app-id")).toBe(CONNECT_APP_ID);
    return Response.json({ active_turns: [] });
  });
  const prepare = vi.fn((sql: string) => ({
    bind(...args: any[]) {
      const statement = db.prepare(sql);
      return {
        first: async () => statement.get(...args) ?? null,
        all: async () => ({ results: statement.all(...args) }),
        run: async () => statement.run(...args),
      };
    },
  }));
  const host = new AgentTools(
    { storage } as any,
    {
      LIBRARY_DB: { prepare },
      CONNECT_API_SERVICE: { fetch },
    } as any,
  );
  vi.spyOn(host as any, "verified").mockResolvedValue(owner);
  const attach = vi.spyOn(host as any, "attach").mockResolvedValue(undefined);
  const close = vi.fn(async () => {});
  (host as any).runtime = { close };
  (host as any).attachment = { connected: true };
  vi.mocked(promptDownload).mockReset();
  const insert = (account = "account", grant = "grant", agent = "agent", status = "running") => {
    db.prepare(`INSERT INTO import_requests (account_id,id,container_id,source,status,phase,current,total,message,created_at,updated_at,agent_grant_id,agent_id,workflow_id)
      VALUES (?,?,?,?,?,'download',0,1,'Working',1,1,?,?,?)`).run(
      account,
      crypto.randomUUID(),
      crypto.randomUUID(),
      `https://example.com/${crypto.randomUUID()}`,
      status,
      grant,
      agent,
      crypto.randomUUID(),
    );
  };
  return { host, storage, fetch, prepare, close, attach, insert };
}
test.each(["queued", "running"])(
  "%s workflow keeps the host without legacy resubmission",
  async (status) => {
    const { host, insert, close, attach, fetch, storage } = setup();
    insert("account", "grant", "agent", status);
    await host.alarm();
    expect(attach).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(storage.deleteAlarm).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(promptDownload).not.toHaveBeenCalled();
  },
);
test("a managed turn with no import or phone keeps the host", async () => {
  const { host, fetch, close, attach, storage } = setup();
  fetch.mockResolvedValueOnce(Response.json({ active_turns: ["turn"] }));
  await host.alarm();
  expect(fetch).toHaveBeenCalledOnce();
  expect(attach).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  expect(storage.deleteAlarm).not.toHaveBeenCalled();
});
test("idle closes; other owners' and terminal imports do not keep this attachment", async () => {
  const { host, insert, fetch, close, attach, storage } = setup();
  insert("other");
  insert("account", "other");
  insert("account", "grant", "other");
  insert("account", "grant", "agent", "complete");
  await host.alarm();
  expect(fetch).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(attach).not.toHaveBeenCalled();
  expect(storage.deleteAlarm).toHaveBeenCalledOnce();
  expect((host as any).attachment).toBeUndefined();
});
test.each([503, 404, 401, 403])(
  "unavailable status (%s) retains the host and retry alarm",
  async (status) => {
    const { host, fetch, close, storage } = setup();
    fetch.mockResolvedValueOnce(new Response(null, { status }));
    await host.alarm();
    expect(close).not.toHaveBeenCalled();
    expect(storage.deleteAlarm).not.toHaveBeenCalled();
    expect(storage.setAlarm).toHaveBeenCalledTimes(2);
  },
);
test.each([{}, { active_turns: null }, { active_turns: [42] }, null])(
  "invalid status %j is not idle",
  async (value) => {
    const { host, fetch, close, storage } = setup();
    fetch.mockResolvedValueOnce(Response.json(value));
    await host.alarm();
    expect(close).not.toHaveBeenCalled();
    expect(storage.deleteAlarm).not.toHaveBeenCalled();
    expect(storage.setAlarm).toHaveBeenCalledTimes(2);
  },
);
test("network failure retains the host", async () => {
  const { host, fetch, close, storage } = setup();
  fetch.mockRejectedValueOnce(new Error("timeout"));
  await host.alarm();
  expect(close).not.toHaveBeenCalled();
  expect(storage.deleteAlarm).not.toHaveBeenCalled();
  expect(storage.setAlarm).toHaveBeenCalledTimes(2);
});
test("active-import query failure retains the host", async () => {
  const { host, prepare, close, storage } = setup();
  const original = prepare.getMockImplementation()!;
  prepare.mockImplementation((sql) => {
    if (sql.startsWith("SELECT id FROM")) throw new Error("database unavailable");
    return original(sql);
  });
  await host.alarm();
  expect(close).not.toHaveBeenCalled();
  expect(storage.deleteAlarm).not.toHaveBeenCalled();
  expect(storage.setAlarm).toHaveBeenCalledTimes(2);
});
