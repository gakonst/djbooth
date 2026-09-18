import { expect, test, vi } from "vitest";
import { configureAgent, AGENT_SETTINGS } from "../src/agent-settings";
import { FAST_AGENT_CONVERSATION_ID } from "../src/agent-permissions";
import type { Env } from "../src/index";
import type { Account } from "../src/auth";

const owner = {
  account: {
    id: "account-a",
    grantId: "grant-a",
    agentId: "agent-a",
    conversationId: FAST_AGENT_CONVERSATION_ID,
  } as Account,
  token: "nc1.grant-a.credential",
  origin: "https://library.test",
};
function setup(
  settings: Record<string, unknown> = { ...AGENT_SETTINGS, model: "gpt-6-astra", fast_mode: false },
  accepted_turns = 0,
) {
  const fetch = vi.fn(async (request: Request) => {
    expect(request.headers.get("authorization")).toBe("Bearer credential");
    expect(request.headers.get("origin")).toBe(owner.origin);
    expect(new URL(request.url).pathname).toMatch(
      /^\/v1\/grants\/grant-a\/agents\/agent-a(?:\/settings)?$/,
    );
    if (request.method === "PATCH") {
      const patch = (await request.clone().json()) as Record<string, unknown>;
      if (accepted_turns > 0) {
        expect(patch).not.toHaveProperty("model");
        expect(patch).not.toHaveProperty("reasoning_mode");
      }
      return Response.json({ settings: { ...settings, ...patch } });
    }
    expect(request.method).toBe("POST"); // Connect's grant-bound read tunnel.
    return Response.json({ settings, accepted_turns });
  });
  return { fetch, env: { CONNECT_API_SERVICE: { fetch } } as unknown as Env };
}
test("new approved conversation gets Luna fast low before use", async () => {
  const { env, fetch } = setup();
  await configureAgent(env, owner);
  expect(fetch).toHaveBeenCalledTimes(2);
});
test("reconnecting an already configured thread never patches its locked model", async () => {
  const { env, fetch } = setup(AGENT_SETTINGS);
  await configureAgent(env, owner);
  expect(fetch).toHaveBeenCalledTimes(1);
});
test("old conversations are left intact", async () => {
  const { env, fetch } = setup();
  await configureAgent(env, { ...owner, account: { ...owner.account, conversationId: undefined } });
  expect(fetch).not.toHaveBeenCalled();
});
test("configuration errors and unconfirmed settings stop admission", async () => {
  const { env, fetch } = setup();
  fetch.mockResolvedValueOnce(new Response(null, { status: 403 }));
  await expect(configureAgent(env, owner)).rejects.toMatchObject({ status: 403 });
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValueOnce(Response.json({ settings: {}, accepted_turns: 0 }));
  fetch.mockResolvedValueOnce(Response.json({ settings: { ...AGENT_SETTINGS, fast_mode: false } }));
  await expect(configureAgent(env, owner)).rejects.toMatchObject({ status: 502 });
});

test("used conversations repair mutable settings without resending locked fields", async () => {
  const { env, fetch } = setup({ ...AGENT_SETTINGS, fast_mode: false }, 3);
  await configureAgent(env, owner);
  expect(fetch).toHaveBeenCalledTimes(2);
  const request = fetch.mock.calls[1]?.[0];
  expect(await request?.clone().json()).toEqual({ fast_mode: true });
});

test("an established conversation keeps its immutable model while cloud tools reconnect", async () => {
  const { env, fetch } = setup({ ...AGENT_SETTINGS, model: "gpt-6-astra", fast_mode: false }, 3);
  await configureAgent(env, owner);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(await fetch.mock.calls[1]?.[0].clone().json()).toEqual({ fast_mode: true });
});
