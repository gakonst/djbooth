import { AuthError, CONNECT_API, CONNECT_APP_ID, type Account } from "./auth.js";
import type { Env } from "./index.js";
import { telemetry } from "./telemetry.js";
import { FAST_AGENT_CONVERSATION_ID } from "./agent-permissions.js";

export const AGENT_SETTINGS = {
  model: "gpt-5.6-luna",
  thinking: "low",
  reasoning_mode: "standard",
  fast_mode: true,
} as const;

/** Apply app defaults while preserving immutable settings on resumed threads. */
export async function configureAgent(
  env: Env,
  owner: { account: Account; token: string; origin: string },
): Promise<void> {
  const selected = owner.account.conversationId === FAST_AGENT_CONVERSATION_ID;
  telemetry("agent_settings_policy", {
    accountID: owner.account.id,
    agentID: owner.account.agentId,
    conversationID: owner.account.conversationId,
    status: selected ? "luna" : "legacy",
  });
  if (!selected) return;
  const url = `${CONNECT_API}/v1/grants/${owner.account.grantId}/agents/${owner.account.agentId}`;
  const headers = {
    authorization: `Bearer ${owner.token.split(".")[2]}`,
    origin: owner.origin,
    "x-nanocodex-app-id": CONNECT_APP_ID,
    "content-type": "application/json",
  };
  const call = async (suffix: string, method: string, body?: unknown) => {
    const request = new Request(url + suffix, {
      method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const response = await (env.CONNECT_API_SERVICE
      ? env.CONNECT_API_SERVICE.fetch(request)
      : fetch(request));
    if (!response.ok)
      throw new AuthError(
        response.status >= 400 && response.status < 500 ? response.status : 503,
        "Could not configure the fast DJ Booth agent. Try again.",
      );
    return response.json<{ settings?: Record<string, unknown>; accepted_turns?: number }>();
  };
  const current = await call("", "POST");
  if (!current.settings) throw new AuthError(502, "Nanocodex returned no agent settings.");
  const expected: Record<string, unknown> = { ...AGENT_SETTINGS };
  // Nanocodex2 rejects the presence of immutable fields after the first turn,
  // even when their values are unchanged. Preserve an established conversation's
  // model instead of breaking its tool attachment or changing conversation scope.
  for (const key of ["model", "reasoning_mode"] as const) {
    if (current.accepted_turns !== 0) {
      if (typeof current.settings[key] !== "string")
        throw new AuthError(502, "Nanocodex returned incomplete agent settings.");
      expected[key] = current.settings[key];
    }
  }
  const patch = Object.fromEntries(
    Object.entries(expected).filter(([key, value]) => current.settings![key] !== value),
  );
  if (Object.keys(patch).length) {
    const updated = await call("/settings", "PATCH", patch);
    if (!Object.entries(expected).every(([key, value]) => updated.settings?.[key] === value))
      throw new AuthError(502, "Nanocodex did not apply the requested agent settings.");
  }
  telemetry("agent_settings_verified", {
    accountID: owner.account.id,
    agentID: owner.account.agentId,
    model: expected.model,
    thinking: AGENT_SETTINGS.thinking,
    fastMode: AGENT_SETTINGS.fast_mode,
  });
}
