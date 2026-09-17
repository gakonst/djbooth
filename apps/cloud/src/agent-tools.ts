import { telemetry, failureKind, receiptFields } from "./telemetry.js";
import { configureAgent } from "./agent-settings.js";
import { DurableObject } from "cloudflare:workers";
import { createTools, type Tools, type AttachmentClient } from "nanocodex/tools";
import {
  authenticate,
  AuthError,
  CONNECT_API,
  CONNECT_APP_ID,
  credential,
  digest,
  type Account,
} from "./auth.js";
import { phoneToolDigest, phoneTools, appMcpTools } from "./phone-tools.js";
import { inspectImport } from "./imports.js";
import type { Env } from "./index.js";

type Owner = { account: Account; token: string; origin: string };
export function agentHost(env: Env, account: Account) {
  if (!env.AGENT_TOOLS || !account.agentId)
    throw new AuthError(503, "Cloud agent tools are unavailable.");
  return env.AGENT_TOOLS.getByName(`${account.id}:${account.grantId}:${account.agentId}`);
}
export async function requireAgentTools(account: Account): Promise<void> {
  if (
    !account.agentId ||
    !account.capabilities.includes("chatgpt") ||
    account.appToolCatalogDigest !== (await phoneToolDigest())
  )
    throw new AuthError(
      403,
      "Sign in again with Nanocodex to approve your agent's DJ Booth cloud workspace and phone app controls.",
    );
}
export async function ensureAgentTools(request: Request, env: Env, account: Account) {
  await requireAgentTools(account);
  const host = agentHost(env, account);
  await host.initialize({
    account,
    token: credential(request)!,
    origin: new URL(request.url).origin,
  });
  return host;
}

/** One signed Connect grant/agent owns the whole catalog; the phone owns its MCP server. */
export class AgentTools extends DurableObject<Env> {
  private runtime?: Tools;
  private attachment?: AttachmentClient;
  private connecting?: Promise<void>;
  private phone?: WebSocket;
  private queries = new Map<string, { resolve(value: string): void; reject(error: Error): void }>();

  async initialize(owner: Owner): Promise<void> {
    const prior = await this.ctx.storage.get<Owner>("owner");
    if (
      prior &&
      (prior.account.id !== owner.account.id ||
        prior.account.grantId !== owner.account.grantId ||
        prior.account.agentId !== owner.account.agentId ||
        prior.origin !== owner.origin)
    )
      throw new Error("Tool host ownership mismatch");
    await this.ctx.storage.put("owner", owner);
    await this.recoverDownloads(owner);
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
    await (this.connecting ??= this.attach(owner).finally(() => {
      this.connecting = undefined;
    }));
  }
  /** Cron repairs a missing alarm without exposing the stored Connect credential. */
  async wake(): Promise<void> {
    if (await this.ctx.storage.get<Owner>("owner")) await this.ctx.storage.setAlarm(Date.now() + 1);
  }
  private async recoverDownloads(owner: Owner): Promise<void> {
    // Recover jobs stopped by the old turn-boundary behavior when their approved
    // owner reconnects. Real acquisition/auth failures are deliberately excluded.
    await this.env.LIBRARY_DB.prepare(
      "UPDATE import_requests SET status='queued', phase='restore', message='Continuing download', updated_at=? WHERE workflow_id IS NULL AND account_id=? AND agent_grant_id=? AND agent_id=? AND status='failed' AND message='Your agent stopped before publishing all tracks. Retry to resume saved work.'",
    )
      .bind(Date.now(), owner.account.id, owner.account.grantId, owner.account.agentId)
      .run();
  }
  private async verified(): Promise<Owner> {
    const owner = await this.ctx.storage.get<Owner>("owner");
    if (!owner) throw new Error("Tool host is not connected");
    const account = await authenticate(
      new Request(`${owner.origin}/v1/agent/turns`, {
        headers: { authorization: `Bearer ${owner.token}` },
      }),
      this.env,
    );
    await requireAgentTools(account);
    if (
      account.id !== owner.account.id ||
      account.grantId !== owner.account.grantId ||
      account.agentId !== owner.account.agentId
    )
      throw new Error("Tool host ownership changed");
    return { ...owner, account };
  }
  private async attach(owner: Owner): Promise<void> {
    if (this.attachment?.connected) return;
    await configureAgent(this.env, owner);
    await this.runtime?.close();
    const target = `${CONNECT_API}/v1/grants/${owner.account.grantId}/agents/${owner.account.agentId}/tool-host`;
    this.runtime = await createTools({
      tools: phoneTools
        .filter((tool) => tool.name === "djbooth_exec")
        .map((tool) => ({
          ...tool,
          handler: async (input: unknown) => {
            const live = await this.verified();
            const value = input as Record<string, unknown>;
            const id = value.job_id;
            if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id))
              throw new Error("Invalid download job ID");
            if (value.operation === "status")
              return JSON.stringify(
                await inspectImport(
                  this.env,
                  live.account.id,
                  id,
                  value.offset === undefined ? 0 : Number(value.offset),
                ),
              );
            const row = await this.env.LIBRARY_DB.prepare(
              "SELECT source, status, collection_id, current, total FROM import_requests WHERE workflow_id IS NULL AND account_id=? AND id=? AND agent_grant_id=? AND agent_id=? AND status IN ('queued','running','complete')",
            )
              .bind(live.account.id, id, live.account.grantId, live.account.agentId)
              .first<{
                source: string;
                status: string;
                collection_id: string | null;
                current: number;
                total: number;
              }>();
            if (!row || !this.env.PLAYLIST_CONTAINERS)
              throw new Error("This download is not authorized for this agent and Connect grant");
            if (row.status === "complete")
              return JSON.stringify({
                status: "completed",
                download: "complete",
                collectionID: row.collection_id,
                current: row.current,
                total: row.total,
                message: "Audio and CDJ analysis were published and backed up.",
              });
            const sandbox = this.env.PLAYLIST_CONTAINERS.getByName(`${live.account.id}:${id}`);
            await sandbox.enqueue(live.account.id, id, row.source);
            return JSON.stringify(
              await sandbox.execute(
                live.account.id,
                live.account.grantId,
                live.account.agentId!,
                id,
                value,
              ),
            );
          },
        })),
      mcp: {
        djbooth: {
          description:
            "DJ Booth phone: library, playlists, playback, Sonos, decks, mixer and recording controls. Open the app to execute. Actions return durable receipts; poll operation_status.",
          client: {
            // Offline discovery is allowed; execution always reaches the phone.
            listTools: async () => ({ tools: appMcpTools }),
            callTool: async (params) => {
              const started = Date.now(),
                rpcID = crypto.randomUUID();
              const context = {
                rpcID,
                accountID: owner.account.id,
                agentID: owner.account.agentId,
                tool: params.name,
                requestID: params.arguments?.requestID,
                importID: params.arguments?.importID,
              };
              telemetry("mcp_call_started", context);
              try {
                await this.verified();
                const reply = JSON.parse(
                  await this.query({ jsonrpc: "2.0", id: rpcID, method: "tools/call", params }),
                );
                if (reply.error) throw new Error(reply.error.message);
                telemetry("mcp_call_finished", {
                  ...context,
                  durationMs: Date.now() - started,
                  status: reply.result?.isError ? "tool_error" : "delivered",
                  responseBytes: new TextEncoder().encode(JSON.stringify(reply.result)).byteLength,
                });
                const receipt = receiptFields(reply.result);
                if (receipt) telemetry("mcp_action_observed", { ...context, ...receipt });
                return reply.result;
              } catch (error) {
                telemetry("mcp_call_failed", {
                  ...context,
                  durationMs: Date.now() - started,
                  failure: failureKind(error),
                });
                throw error;
              }
            },
          },
          timeoutMs: 8000,
        },
      },
      mcpOptions: { catalogProvider: () => "javascript" },
    });
    this.attachment = await this.runtime
      .attach({
        endpoint: target.replace(/^https:/, "wss:"),
        transport: {
          connect: async () => {
            const owner = await this.verified();
            const request = new Request(`${target}/ticket`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${owner.token.split(".")[2]}`,
                origin: owner.origin,
                "x-nanocodex-app-id": CONNECT_APP_ID,
              },
            });
            const response = await (this.env.CONNECT_API_SERVICE
              ? this.env.CONNECT_API_SERVICE.fetch(request)
              : fetch(request));
            if (!response.ok) throw new Error("Connect tool ticket unavailable");
            const { ticket } = await response.json<{ ticket: string }>();
            if (!/^[A-Za-z0-9_-]{1,128}$/.test(ticket)) throw new Error("Invalid tool ticket");

            const upgradeRequest = new Request(`${target}?ticket=${encodeURIComponent(ticket)}`, {
              headers: { Upgrade: "websocket", Origin: owner.origin },
            });
            const upgrade = await (this.env.CONNECT_API_SERVICE
              ? this.env.CONNECT_API_SERVICE.fetch(upgradeRequest)
              : fetch(upgradeRequest));
            if (!upgrade.webSocket) throw new Error("Connect tool socket unavailable");
            upgrade.webSocket.accept();
            return upgrade.webSocket;
          },
        },
      })
      .connect();
  }
  async alarm(): Promise<void> {
    // Recover even if this invocation is interrupted during a network request.
    await this.ctx.storage.setAlarm(Date.now() + 30_000);
    try {
      const owner = await this.verified();
      await this.recoverDownloads(owner);
      const jobs = await this.env.LIBRARY_DB.prepare(
        "SELECT id, source, agent_turn_id FROM import_requests WHERE workflow_id IS NULL AND account_id=? AND agent_grant_id=? AND agent_id=? AND status IN ('queued','running')",
      )
        .bind(owner.account.id, owner.account.grantId, owner.account.agentId)
        .all<{ id: string; source: string; agent_turn_id: string | null }>();
      for (const job of jobs.results) {
        const resubmit = async () => {
          const { promptDownload } = await import("./imports.js");
          await promptDownload(
            new Request(`${owner.origin}/v1/imports`, {
              headers: { authorization: `Bearer ${owner.token}` },
            }),
            this.env,
            owner.account,
            job.id,
            job.source,
          );
        };
        try {
          if (!job.agent_turn_id) {
            await resubmit();
            continue;
          }
          const request = new Request(
            `${CONNECT_API}/v1/grants/${owner.account.grantId}/agents/${owner.account.agentId}/turns/${job.agent_turn_id}`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${owner.token.split(".")[2]}`,
                origin: owner.origin,
                "x-nanocodex-app-id": CONNECT_APP_ID,
              },
              signal: AbortSignal.timeout(20_000),
            },
          );
          const response = await (this.env.CONNECT_API_SERVICE
            ? this.env.CONNECT_API_SERVICE.fetch(request)
            : fetch(request));
          if (response.status === 404) {
            await resubmit();
            continue;
          }
          if (!response.ok) continue;
          const value = await response.json<{ terminal?: unknown }>();
          if (value.terminal) {
            // Flush publication first: a completed job needs no further agent turn.
            await this.env.PLAYLIST_CONTAINERS?.getByName(`${owner.account.id}:${job.id}`).poll();
            // Claim one continuation durably before sending it. If delivery is
            // interrupted, the next alarm resubmits this same idempotent turn ID.
            const claimed = await this.env.LIBRARY_DB.prepare(
              "UPDATE import_requests SET agent_turn_id=?, updated_at=? WHERE workflow_id IS NULL AND account_id=? AND id=? AND agent_grant_id=? AND agent_id=? AND agent_turn_id=? AND status IN ('queued','running') RETURNING id",
            )
              .bind(
                crypto.randomUUID(),
                Date.now(),
                owner.account.id,
                job.id,
                owner.account.grantId,
                owner.account.agentId,
                job.agent_turn_id,
              )
              .first<{ id: string }>();
            if (claimed) await resubmit();
          }
        } catch (error) {
          if (error instanceof AuthError && [401, 403].includes(error.status)) throw error;
          // A temporary broker/container error is retried by the next alarm.
          // It must not stop this download or the owner's other downloads.
        }
      }
      if (jobs.results.length || this.phone || this.queries.size) await this.initialize(owner);
      else {
        await this.runtime?.close();
        this.runtime = undefined;
        this.attachment = undefined;
        await this.ctx.storage.deleteAlarm();
      }
    } catch (error) {
      if (!(error instanceof AuthError) || ![401, 403].includes(error.status)) {
        telemetry("agent_host_reconnect", { failure: failureKind(error) });
        await this.ctx.storage.setAlarm(Date.now() + 30_000);
        return;
      }
      const owner = await this.ctx.storage.get<Owner>("owner");
      telemetry("agent_host_authorization_expired", { accountID: owner?.account.id });
      if (owner)
        await this.env.LIBRARY_DB.prepare(
          "UPDATE import_requests SET status='failed', message='Nanocodex authorization expired or was revoked. Reconnect, then retry.', updated_at=? WHERE workflow_id IS NULL AND account_id=? AND agent_grant_id=? AND agent_id=? AND (status IN ('queued','running') OR (status='failed' AND message='Your agent stopped before publishing all tracks. Retry to resume saved work.'))",
        )
          .bind(Date.now(), owner.account.id, owner.account.grantId, owner.account.agentId)
          .run();
      await this.runtime?.close();
      this.runtime = undefined;
      this.attachment = undefined;
      this.phone?.close(1008, "Connection expired");
      this.phone = undefined;
      await this.ctx.storage.deleteAlarm();
    }
  }
  async phoneTicket(): Promise<{ ticket: string }> {
    await this.verified();
    const ticket = crypto.randomUUID();
    await this.ctx.storage.put(`ticket:${await digest(ticket)}`, Date.now() + 30_000);
    return { ticket };
  }
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return new Response(null, { status: 426 });
    const ticket = new URL(request.url).searchParams.get("ticket") ?? "";
    const key = `ticket:${await digest(ticket)}`;
    const expiry = await this.ctx.storage.transaction(async (storage) => {
      const expires = await storage.get<number>(key);
      await storage.delete(key);
      return expires;
    });
    if (!expiry || expiry < Date.now()) return new Response(null, { status: 401 });
    const owner = await this.verified();
    if (request.headers.get("origin") !== owner.origin) return new Response(null, { status: 403 });
    const pair = new WebSocketPair();
    const socket = pair[1];
    socket.accept();
    for (const pending of this.queries.values())
      pending.reject(
        new Error("Phone reconnected; reuse the same action requestID when retrying."),
      );
    this.queries.clear();
    this.phone?.close(1000, "Reconnected");
    this.phone = socket;
    telemetry("phone_connected", { accountID: owner.account.id, agentID: owner.account.agentId });
    socket.addEventListener("message", (event) => {
      try {
        if (this.phone !== socket) return;
        if (typeof event.data !== "string" || event.data.length > 65536)
          throw new Error("Invalid frame");
        const frame = JSON.parse(event.data);
        if (frame.type === "catalog") socket.send(JSON.stringify({ type: "ready" }));
        else if (frame.type === "ping")
          socket.send(JSON.stringify({ type: "pong", nonce: frame.nonce }));
        else if (frame.type === "result") {
          const pending = this.queries.get(frame.call_id);
          if (!pending) return;
          this.queries.delete(frame.call_id);
          const output = frame.outcome?.output;
          if (typeof output?.output !== "string")
            pending.reject(new Error("Invalid phone response"));
          else if (output.success === false) pending.reject(new Error(output.output));
          else pending.resolve(output.output);
          socket.send(JSON.stringify({ type: "ack", call_id: frame.call_id }));
        }
      } catch {
        telemetry("phone_frame_rejected");
        socket.close(1008, "Invalid phone frame");
      }
    });
    socket.addEventListener("close", () => {
      if (this.phone === socket) {
        telemetry("phone_disconnected", {
          accountID: owner.account.id,
          pending: this.queries.size,
        });
        this.phone = undefined;
        for (const pending of this.queries.values())
          pending.reject(
            new Error("Phone disconnected; reuse the same action requestID when retrying."),
          );
        this.queries.clear();
      }
    });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  private async query(input: unknown): Promise<string> {
    if (!this.phone || this.phone.readyState !== WebSocket.OPEN)
      throw new Error(
        "Open DJ Booth on your phone to use its MCP tools. Cloud downloads remain available.",
      );
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.queries.delete(id);
        reject(
          new Error("Phone MCP call timed out; reuse the same action requestID when retrying"),
        );
      }, 8000);
      this.queries.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.phone!.send(
        JSON.stringify({
          type: "call",
          call_id: id,
          name: "mcp",
          input,
          deadline_at: Date.now() + 8000,
          output_byte_budget: 32000,
          output_token_budget: 8000,
        }),
      );
    });
  }
}
