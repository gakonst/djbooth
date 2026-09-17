import { expect, test, vi } from "vitest";
vi.mock("../src/agent-tools.js", () => ({ ensureAgentTools: vi.fn() }));
import { agentRoute, AGENT_INSTRUCTIONS } from "../src/agent";
import type { Account } from "../src/auth";
import type { Env } from "../src/index";

const account: Account = {
  id: "owner",
  grantId: `0x${"1".repeat(64)}`,
  agentId: "only-this-agent",
  expiresAt: 9999999999,
  capabilities: ["chatgpt", "agent.history.read", "agent.output.final"],
};
function setup(data: unknown[] = [], has_more = false, latest_cursor = "1000") {
  const fetch = vi.fn(async (_request: Request) =>
    Response.json({ data, has_more, latest_cursor }),
  );
  const env = { CONNECT_API_SERVICE: { fetch } } as unknown as Env;
  const get = (query = "", owner = account) =>
    agentRoute(
      new Request(`https://library.test/v1/agent/history${query}`, {
        headers: { authorization: `Bearer nc1.${owner.grantId}.${"a".repeat(43)}` },
      }),
      env,
      owner,
      async () => ({}),
    );
  return { get, fetch };
}

test("history uses only the authenticated grant's agent and strips instructions/internal events", async () => {
  const { get, fetch } = setup(
    [
      {
        type: "turn_accepted",
        cursor: "10",
        turn_id: "turn-a",
        created_at: 1700000000000,
        input: AGENT_INSTRUCTIONS + "Find music",
      },
      { type: "event", cursor: "11", event: { type: "tool.call", payload: "private" } },
      {
        type: "turn_completed",
        cursor: "12",
        turn_id: "turn-a",
        created_at: 1700000001000,
        final_message: "Here you go",
        secret: "hidden",
      },
    ],
    true,
  );
  const response = await get();
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toEqual({
    agentID: "only-this-agent",
    nextBefore: "10",
    messages: [
      { id: "user:turn-a", role: "You", text: "Find music", timestamp: 1700000000 },
      { id: "assistant:turn-a", role: "DJ Booth", text: "Here you go", timestamp: 1700000001 },
    ],
  });
  const request = fetch.mock.calls[0][0];
  expect(new URL(request.url).pathname).toBe(
    `/v1/grants/${account.grantId}/agents/only-this-agent/events/history`,
  );
  expect(request.method).toBe("POST");
  await get("", { ...account, grantId: `0x${"2".repeat(64)}`, agentId: "second-account-agent" });
  expect(new URL(fetch.mock.calls[1][0].url).pathname).toBe(
    `/v1/grants/0x${"2".repeat(64)}/agents/second-account-agent/events/history`,
  );
});

test.each([
  "?agentId=other",
  "?thread=other",
  "?account=other",
  "?before=1&before=2",
  "?before=0",
  "?before=../other",
])("cannot widen history access: %s", async (query) => {
  const { get, fetch } = setup();
  await expect(get(query)).rejects.toMatchObject({ status: 400 });
  expect(fetch).not.toHaveBeenCalled();
});

test("a global history permission does not substitute for the agent-specific grant", async () => {
  const { get, fetch } = setup();
  await expect(
    get("", { ...account, capabilities: ["chatgpt", "history:read"] }),
  ).rejects.toMatchObject({ status: 403 });
  expect(fetch).not.toHaveBeenCalled();
});

test("filtered pages preserve a strictly earlier continuation without trace access", async () => {
  const { get } = setup([], true);
  expect(await (await get()).json()).toMatchObject({ messages: [], nextBefore: "745" });
  expect(await (await get("?before=745")).json()).toMatchObject({ nextBefore: "489" });
  expect(await (await get("?before=200")).json()).toMatchObject({ nextBefore: null });
});

test("final messages require the final-output capability", async () => {
  const { get } = setup([
    { type: "turn_completed", turn_id: "a", cursor: "5", final_message: "private" },
  ]);
  expect(
    await (await get("", { ...account, capabilities: ["chatgpt", "agent.history.read"] })).json(),
  ).toMatchObject({ messages: [], nextBefore: null });
});

test("catalog upgrades do not expose old agent instructions in durable history", async () => {
  const { get } = setup([
    {
      type: "turn_accepted",
      turn_id: "old",
      input:
        "You are the user's DJ Booth assistant. The phone query is read-only. User request: Keep this message",
    },
    { type: "turn_accepted", turn_id: "plain", input: "User request: preserve my own text" },
  ]);
  const result = (await (await get()).json()) as { messages: { text: string }[] };
  expect(result.messages.map((message) => message.text)).toEqual([
    "Keep this message",
    "User request: preserve my own text",
  ]);
});

test("each durable-agent turn receives the workflow policy and telemetry excludes user text", async () => {
  const requests: Request[] = [];
  const env = {
    CONNECT_API_SERVICE: {
      fetch: async (request: Request) => {
        requests.push(request);
        return Response.json({ turn_id: "accepted-turn", terminal: false });
      },
    },
  } as unknown as Env;
  const logs = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    for (const id of ["turn-one", "turn-two"]) {
      await agentRoute(
        new Request("https://library.test/v1/agent/turns", {
          method: "POST",
          headers: { authorization: `Bearer nc1.${account.grantId}.${"a".repeat(43)}` },
        }),
        env,
        account,
        async () => ({ id, input: "private-user-input" }),
      );
    }
    for (const request of requests) {
      const body = (await request.json()) as { input: string };
      expect(body.input).toBe(AGENT_INSTRUCTIONS + "private-user-input");
      expect(new URL(request.url).pathname).toContain("/only-this-agent/turns");
    }
    const events = logs.mock.calls.map(([line]) => JSON.parse(line));
    expect(events.filter((event) => event.event === "agent_broker_response")).toHaveLength(2);
    expect(events[1]).toMatchObject({
      turnID: "turn-two",
      policyVersion: "2026-09-17.1",
      httpStatus: 200,
    });
    expect(JSON.stringify(events)).not.toContain("private-user-input");
    expect(JSON.stringify(events)).not.toContain("a".repeat(43));
  } finally {
    logs.mockRestore();
  }
});
