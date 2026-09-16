vi.mock("cloudflare:workflows", () => ({ NonRetryableError: Error }));
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
vi.mock("../src/imports.js", () => ({ promptDownload: vi.fn() }));
import { AgentTools } from "../src/agent-tools.js";
import { promptDownload } from "../src/imports.js";
import { AuthError } from "../src/auth.js";

const owner = {
  account: { id: "account", grantId: "grant", agentId: "agent" },
  token: "test.test.test",
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
  db.prepare(`INSERT INTO import_requests (account_id,id,container_id,source,status,phase,current,total,message,created_at,updated_at,agent_grant_id,agent_id,agent_turn_id,stage_progress)
    VALUES ('account','job','container','https://soundcloud.com/owner/sets/list','running','download',12,50,'Downloading',1,1,'grant','agent','turn-original',?)`).run(
    JSON.stringify({ resolve: { status: "complete", current: 50, total: 50 } }),
  );
  const storage = {
    get: vi.fn(async () => owner),
    put: vi.fn(async () => {}),
    setAlarm: vi.fn(async () => {}),
    deleteAlarm: vi.fn(async () => {}),
  };
  const poll = vi.fn(async () => {});
  const fetch = vi.fn(async () => Response.json({ terminal: { type: "turn_completed" } }));
  const env = {
    LIBRARY_DB: {
      prepare(sql: string) {
        return {
          bind(...args: any[]) {
            const statement = db.prepare(sql);
            return {
              first: async () => statement.get(...args) ?? null,
              all: async () => ({ results: statement.all(...args) }),
              run: async () => statement.run(...args),
            };
          },
        };
      },
    },
    CONNECT_API_SERVICE: { fetch },
    PLAYLIST_CONTAINERS: { getByName: () => ({ poll }) },
  };
  const host = new AgentTools({ storage } as any, env as any);
  vi.spyOn(host as any, "verified").mockResolvedValue(owner);
  vi.spyOn(host, "initialize").mockResolvedValue(undefined);
  vi.mocked(promptDownload).mockReset().mockResolvedValue(undefined);
  const row = () => db.prepare("SELECT * FROM import_requests WHERE id='job'").get() as any;
  return { db, host, storage, poll, fetch, row };
}

test("an ended agent turn automatically continues without losing stages or CLI progress", async () => {
  const { host, row, poll } = setup();
  await host.alarm();
  expect(row()).toMatchObject({
    status: "running",
    phase: "download",
    current: 12,
    total: 50,
    message: "Downloading",
  });
  expect(JSON.parse(row().stage_progress).resolve.status).toBe("complete");
  expect(row().agent_turn_id).not.toBe("turn-original");
  expect(poll).toHaveBeenCalledOnce();
  expect(promptDownload).toHaveBeenCalledOnce();
});
test("publication during the final poll prevents another turn", async () => {
  const { host, db, poll, row } = setup();
  poll.mockImplementationOnce(async () => {
    db.exec("UPDATE import_requests SET status='complete'");
  });
  await host.alarm();
  expect(row().status).toBe("complete");
  expect(row().agent_turn_id).toBe("turn-original");
  expect(promptDownload).not.toHaveBeenCalled();
});
test("uncertain continuation delivery retries the same persisted turn ID", async () => {
  const { host, fetch, row, storage } = setup();
  vi.mocked(promptDownload).mockRejectedValueOnce(new Error("lost response"));
  await host.alarm();
  const turn = row().agent_turn_id;
  expect(turn).not.toBe("turn-original");
  fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
  await host.alarm();
  expect(row().agent_turn_id).toBe(turn);
  expect(row().status).toBe("running");
  expect(promptDownload).toHaveBeenCalledTimes(2);
  expect(storage.setAlarm).toHaveBeenCalledTimes(2);
});
test("a running turn is left alone and temporary broker failures keep retrying", async () => {
  const { host, fetch, row } = setup();
  fetch.mockResolvedValueOnce(Response.json({}));
  await host.alarm();
  fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
  await host.alarm();
  expect(row().agent_turn_id).toBe("turn-original");
  expect(row().status).toBe("running");
  expect(promptDownload).not.toHaveBeenCalled();
});
test("revoked authorization stops continuation without discarding completed stages", async () => {
  const { host, row, storage } = setup();
  vi.spyOn(host as any, "verified").mockRejectedValue(new AuthError(403, "revoked"));
  await host.alarm();
  expect(row().status).toBe("failed");
  expect(row().current).toBe(12);
  expect(row().message).toContain("authorization");
  expect(promptDownload).not.toHaveBeenCalled();
  expect(storage.deleteAlarm).toHaveBeenCalled();
});

test("reconnecting recovers old turn-boundary failures only for the same approved owner", async () => {
  const { host, db, row } = setup();
  const oldMessage = "Your agent stopped before publishing all tracks. Retry to resume saved work.";
  db.prepare("UPDATE import_requests SET status='failed',phase='failed',message=?").run(oldMessage);
  vi.mocked(host.initialize).mockRestore();
  vi.spyOn(host as any, "attach").mockResolvedValue(undefined);
  await host
    .initialize({ ...owner, account: { ...owner.account, grantId: "other" } } as any)
    .catch(() => {});
  expect(row().status).toBe("failed");
  await host.initialize(owner as any);
  expect(row()).toMatchObject({ status: "queued", phase: "restore", current: 12, total: 50 });
  db.exec("UPDATE import_requests SET status='failed',message='Source unavailable'");
  await host.initialize(owner as any);
  expect(row().status).toBe("failed");
});
