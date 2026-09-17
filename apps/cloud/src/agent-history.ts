import { AuthError, CONNECT_API, CONNECT_APP_ID, credential, type Account } from "./auth.js";
import type { Env } from "./index.js";

/** History is bound to the verified grant. There is intentionally no agent selector. */
export async function agentHistory(
  request: Request,
  env: Env,
  account: Account,
): Promise<Response> {
  if (request.method !== "GET") throw new AuthError(405, "Method not allowed.");
  if (!account.agentId || !account.capabilities.includes("agent.history.read"))
    throw new AuthError(
      403,
      "Reconnect Nanocodex to allow history for just your DJ Booth conversation.",
    );
  const query = new URL(request.url).searchParams;
  const before = query.get("before");
  if (
    [...query.keys()].some((key) => key !== "before") ||
    query.getAll("before").length > 1 ||
    (before !== null && !/^[1-9][0-9]{0,18}$/.test(before))
  )
    throw new AuthError(400, "Invalid history cursor.");
  const url = new URL(
    `${CONNECT_API}/v1/grants/${account.grantId}/agents/${encodeURIComponent(account.agentId)}/events/history`,
  );
  url.searchParams.set("limit", "256");
  if (before) url.searchParams.set("before", before);
  const upstream = new Request(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential(request)!.split(".")[2]}`,
      origin: new URL(request.url).origin,
      "x-nanocodex-app-id": CONNECT_APP_ID,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const response = await (env.CONNECT_API_SERVICE
    ? env.CONNECT_API_SERVICE.fetch(upstream)
    : fetch(upstream));
  if (!response.ok)
    throw new AuthError(
      response.status === 403 ? 403 : 503,
      response.status === 403
        ? "Reconnect Nanocodex to allow history for just your DJ Booth conversation."
        : "Couldn’t load your conversation. Try again.",
    );
  const wire = await response.json<{
    data: Record<string, unknown>[];
    has_more: boolean;
    latest_cursor: string;
  }>();
  if (!Array.isArray(wire.data)) throw new AuthError(502, "Invalid history response.");
  const messages: { id: string; role: string; text: string; timestamp: number }[] = [];
  let oldest: bigint | undefined;
  for (const event of wire.data) {
    if (typeof event.cursor === "string" && /^[0-9]+$/.test(event.cursor)) {
      const cursor = BigInt(event.cursor);
      if (oldest === undefined || cursor < oldest) oldest = cursor;
    }
    const id = event.turn_id ?? event.id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) continue;
    const time = typeof event.created_at === "number" ? event.created_at : 0;
    const timestamp = time > 100_000_000_000 ? time / 1000 : time;
    if (event.type === "turn_accepted" && typeof event.input === "string") {
      // Prompts are versioned by behavior, but old turns remain in this same
      // conversation. Strip the stable wrapper across catalog upgrades too.
      const marker = " User request: ";
      const boundary = event.input.startsWith("You are the user's DJ Booth assistant. ")
        ? event.input.indexOf(marker)
        : -1;
      const text = boundary >= 0 ? event.input.slice(boundary + marker.length) : event.input;
      messages.push({ id: `user:${id}`, role: "You", text, timestamp });
    } else if (
      event.type === "turn_completed" &&
      account.capabilities.includes("agent.output.final") &&
      typeof event.final_message === "string"
    ) {
      messages.push({
        id: `assistant:${id}`,
        role: "DJ Booth",
        text: event.final_message,
        timestamp,
      });
    } else if (event.type === "turn_cancelled" || event.type === "turn_failed") {
      messages.push({
        id: `status:${id}`,
        role: "Status",
        text:
          event.type === "turn_cancelled"
            ? "Stopped."
            : "Your agent stopped before completing this request.",
        timestamp,
      });
    }
  }
  // Connect filters private events. An entirely filtered page still needs a
  // continuation. Cursors increase by at least one per stored event; subtracting
  // the page size is conservative even when there are gaps (it may overlap).
  if (wire.has_more && oldest === undefined) {
    const upper =
      before ??
      (/^[0-9]+$/.test(String(wire.latest_cursor))
        ? String(BigInt(wire.latest_cursor) + 1n)
        : undefined);
    if (!upper) throw new AuthError(502, "Invalid history cursor.");
    oldest = BigInt(upper) > 256n ? BigInt(upper) - 256n : 1n;
  }
  return Response.json(
    {
      agentID: account.agentId,
      messages,
      nextBefore: wire.has_more && oldest !== undefined && oldest > 1n ? String(oldest) : null,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
