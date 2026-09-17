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

/** Configure the newly approved thread before accepting its first turn. */
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
    return response.json<{ settings?: Record<string, unknown> }>();
  };
  const matches = (settings?: Record<string, unknown>) =>
    settings !== undefined &&
    Object.entries(AGENT_SETTINGS).every(([key, value]) => settings[key] === value);
  // Model patches are forbidden after the first turn, even for an unchanged
  // model. Read first so reconnects preserve the already configured agent.
  const current = await call("", "POST");
  if (!matches(current.settings)) {
    const updated = await call("/settings", "PATCH", AGENT_SETTINGS);
    if (!matches(updated.settings))
      throw new AuthError(502, "Nanocodex did not apply the requested agent settings.");
  }
  telemetry("agent_settings_verified", {
    accountID: owner.account.id,
    agentID: owner.account.agentId,
    model: AGENT_SETTINGS.model,
    thinking: AGENT_SETTINGS.thinking,
    fastMode: AGENT_SETTINGS.fast_mode,
  });
}
