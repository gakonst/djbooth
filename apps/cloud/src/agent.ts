import { AuthError, CONNECT_API, CONNECT_APP_ID, credential, type Account } from "./auth.js";
import type { Env } from "./index.js";

/** A narrow native client adapter to the same grant-bound managed API the Connect SDK uses. */
export async function agentRoute(
  request: Request,
  env: Env,
  account: Account,
  readJSON: (r: Request) => Promise<unknown>,
): Promise<Response> {
  if (!account.agentId || !account.capabilities.includes("chatgpt"))
    throw new AuthError(403, "Connect ChatGPT in Nanocodex to use your music agent.");
  const path = new URL(request.url).pathname;
  const match = /^\/v1\/agent\/turns(?:\/([A-Za-z0-9_-]{1,128})(\/cancel)?)?$/.exec(path);
  if (!match) throw new AuthError(404, "Not found.");
  const creating = !match[1];
  if (request.method !== (creating || match[2] ? "POST" : "GET"))
    throw new AuthError(405, "Method not allowed.");
  let body: string | undefined;
  let id: string | undefined;
  if (creating) {
    const value = (await readJSON(request)) as { id?: unknown; input?: unknown } | null;
    if (
      !value ||
      typeof value.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) ||
      typeof value.input !== "string" ||
      !value.input.trim() ||
      value.input.length > 16000
    )
      throw new AuthError(400, "Enter a message of up to 16,000 characters.");
    id = value.id;
    body = JSON.stringify({
      id,
      input: `You are the user's DJ Booth music assistant. Use their approved Spotify and SoundCloud connections to explore saved music and suggest tracks or set ideas. Keep recording identifications honest and include provider links. User request: ${value.input}`,
    });
  }
  // The client cannot choose an agent or forward arbitrary headers. Its verified
  // grant determines both the owner and the connector access at Nanocodex.
  const upstream = new Request(
    `${CONNECT_API}/v1/grants/${account.grantId}/agents/${encodeURIComponent(account.agentId)}/turns${creating ? "" : `/${match[1]}${match[2] ?? ""}`}`,
    {
      method: "POST", // Connect tunnels managed reads as POST to carry Origin.
      headers: {
        authorization: `Bearer ${credential(request)!.split(".")[2]}`,
        origin: new URL(request.url).origin,
        "x-nanocodex-app-id": CONNECT_APP_ID,
        "content-type": "application/json",
        ...(id ? { "idempotency-key": `djbooth:${id}` } : {}),
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    },
  );
  const response = await (env.CONNECT_API_SERVICE
    ? env.CONNECT_API_SERVICE.fetch(upstream)
    : fetch(upstream));
  if (!response.ok)
    throw new AuthError(
      response.status >= 400 && response.status < 500 ? response.status : 503,
      "Your agent could not complete this request. Try again or reconnect Nanocodex.",
    );
  const wire = await response.json<{
    turn_id?: string;
    terminal?: { type?: string; final_message?: string; error?: string };
  }>();
  const turnID = wire.turn_id ?? match[1];
  if (!turnID || !/^[A-Za-z0-9_-]{1,128}$/.test(turnID))
    throw new AuthError(502, "Invalid agent response.");
  const terminal = wire.terminal;
  return Response.json(
    {
      id: turnID,
      status:
        terminal?.type === "turn_completed"
          ? "completed"
          : terminal?.type === "turn_cancelled"
            ? "cancelled"
            : terminal
              ? "failed"
              : match[2]
                ? "cancelling"
                : "running",
      ...(terminal?.type === "turn_completed" && account.capabilities.includes("agent.output.final")
        ? { finalMessage: terminal.final_message ?? "" }
        : {}),
      ...(terminal && terminal.type !== "turn_completed" && terminal.type !== "turn_cancelled"
        ? { error: "Your agent stopped before completing this request." }
        : {}),
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
