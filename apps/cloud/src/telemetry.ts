/** Operational metadata only: never prompts, tool arguments, URLs, tokens or raw errors. */
export const WORKFLOW_POLICY_VERSION = "2026-09-17.1";
const identifiers = new Set([
  "accountID",
  "agentID",
  "conversationID",
  "turnID",
  "requestID",
  "importID",
  "workflowID",
  "rpcID",
]);
const labels = new Set([
  "model",
  "thinking",
  "stage",
  "status",
  "operation",
  "tool",
  "failure",
  "execution",
  "policyVersion",
]);
const metrics = new Set([
  "durationMs",
  "attempt",
  "current",
  "total",
  "responseBytes",
  "httpStatus",
  "pending",
  "retryDelayMs",
]);
export type EventFields = Record<string, unknown>;
export function diagnosticEvent(
  event: string,
  fields: EventFields = {},
): { event: string; timeMs: number } & Record<string, string | number | boolean> {
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (
      (identifiers.has(key) || labels.has(key)) &&
      typeof value === "string" &&
      /^[A-Za-z0-9_.:-]{1,160}$/.test(value)
    )
      safe[key] = value;
    else if (metrics.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0)
      safe[key] = Math.round(value);
    else if (
      ["replayed", "reportAvailable", "fastMode"].includes(key) &&
      typeof value === "boolean"
    )
      safe[key] = value;
  }
  return {
    event: /^[a-z_]{1,64}$/.test(event) ? event : "invalid_event",
    timeMs: Date.now(),
    ...safe,
  };
}
export type DiagnosticEvent = ReturnType<typeof diagnosticEvent>;
export function telemetry(event: string, fields: EventFields = {}) {
  const entry = diagnosticEvent(event, fields);
  try {
    console.log(JSON.stringify({ service: "djbooth", telemetryVersion: 1, ...entry }));
  } catch {
    /* Diagnostics must not interrupt work. */
  }
  return entry;
}
export function failureKind(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return "authorization";
  if (status === 429) return "rate_limit";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/timeout|timed out/.test(message)) return "timeout";
  if (/cancel|superseded|abort/.test(message)) return "cancelled";
  if (/phone.*(open|reconnect)|open dj booth/.test(message)) return "phone_unavailable";
  if (/catalog|approve/.test(message)) return "catalog_approval";
  if (/queued|restor|waiting/.test(message)) return "waiting";
  if (/network|fetch|socket|connection/.test(message)) return "transport";
  return "internal";
}

/** Read only receipt identifiers/status, never retain the receipt's user-facing output. */
export function receiptFields(result: unknown): EventFields | null {
  try {
    const content = (result as { content?: { type?: string; text?: string }[] })?.content;
    const text = content?.find((item) => item.type === "text")?.text;
    if (!text) return null;
    const receipt = JSON.parse(text);
    if (
      typeof receipt.requestID !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(receipt.requestID) ||
      !["running", "completed", "failed", "interrupted"].includes(receipt.status)
    )
      return null;
    const fields: EventFields = { requestID: receipt.requestID, status: receipt.status };
    try {
      const job = JSON.parse(receipt.output);
      if (typeof job.id === "string" && /^[a-f0-9-]{36}$/i.test(job.id)) fields.importID = job.id;
    } catch {
      /* Most actions return plain text, not an import job. */
    }
    return fields;
  } catch {
    return null;
  }
}
