import {
  diagnosticEvent,
  telemetry,
  failureKind,
  type EventFields,
  type DiagnosticEvent,
} from "./telemetry.js";
import { Container } from "@cloudflare/containers";
import { accountFetch, type Env } from "./index.js";
import { snapshots } from "./snapshots.js";
import { resolveTracklist } from "./resolver.js";

type Job = {
  accountId: string;
  id: string;
  source: string;
  startedAt: number;
  failures: number;
  analysisRepair?: boolean;
  agentGrantId?: string;
  agentId?: string;
  agentTurnId?: string;
  completedAt?: number;
  workflowId?: string;
  admittedAt?: number;
};

/** Stable Durable Object identity = one playlist = one container, across retries. */
export class PlaylistContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "2m";
  enableInternet = true;

  /** Bounded diagnostic history only; never used to drive or resume the workflow. */
  async recordImportEvent(accountId: string, id: string, event: string, fields: EventFields = {}) {
    try {
      const row = await this.env.LIBRARY_DB.prepare(
        "SELECT id FROM import_requests WHERE account_id=? AND id=?",
      )
        .bind(accountId, id)
        .first();
      if (!row) return;
      await this.ctx.storage.transaction(async (storage) => {
        const prior = await storage.get<{
          accountId: string;
          id: string;
          events: DiagnosticEvent[];
        }>("import-telemetry");
        if (prior && (prior.accountId !== accountId || prior.id !== id)) return;
        const entry = diagnosticEvent(event, { ...fields, importID: id });
        await storage.put("import-telemetry", {
          accountId,
          id,
          events: [...(prior?.events ?? []), entry].slice(-100),
        });
      });
    } catch {
      telemetry("telemetry_storage_failed", { importID: id });
    }
  }

  async importTelemetry(accountId: string, id: string, workflowID?: string | null) {
    const value = await this.ctx.storage.get<{
      accountId: string;
      id: string;
      events: DiagnosticEvent[];
    }>("import-telemetry");
    if (value?.accountId !== accountId || value.id !== id) return null;
    const events =
      workflowID === undefined
        ? value.events
        : value.events.filter((event) => (event.workflowID ?? null) === workflowID);
    return { events: events.slice(-20), retained: events.length, limit: 100 };
  }

  /** Read a cached projection of master.db, including after the container sleeps. */
  async importReport(accountId: string, id: string, offset: number) {
    return this.ctx.storage.transaction(async (storage) => {
      const summary = await storage.get<{
        accountId: string;
        id: string;
        total: number;
        updatedAt: string;
        workflowID?: string;
        tracklist: unknown;
        warnings: unknown;
      }>("import-report");
      if (!summary || summary.accountId !== accountId || summary.id !== id) return null;
      const { accountId: _account, id: _id, ...report } = summary;
      const tracks =
        offset >= summary.total
          ? []
          : ((await storage.get<unknown[]>(`import-report:${Math.floor(offset / 50)}`)) ?? []);
      return {
        ...report,
        tracks,
        offset,
        nextOffset: offset + 50 < summary.total ? offset + 50 : null,
      };
    });
  }

  async enqueue(accountId: string, id: string, source: string): Promise<void> {
    await this.polling;
    const row = await this.env.LIBRARY_DB.prepare(
      "SELECT workflow_id, analysis_repair, agent_grant_id, agent_id, agent_turn_id FROM import_requests WHERE account_id=? AND id=?",
    )
      .bind(accountId, id)
      .first<{
        workflow_id: string | null;
        analysis_repair: number;
        agent_grant_id: string | null;
        agent_id: string | null;
        agent_turn_id: string | null;
      }>();
    const previous = await this.ctx.storage.get<Job>("job");
    if (previous) {
      if (previous.accountId !== accountId || previous.id !== id || previous.source !== source)
        throw new Error("Container ownership mismatch");
      if (
        previous.workflowId !== (row?.workflow_id ?? undefined) ||
        previous.agentGrantId !== (row?.agent_grant_id ?? undefined) ||
        previous.agentId !== (row?.agent_id ?? undefined)
      ) {
        // A different grant or agent must not inherit a live executor.
        // Its authorized retry restores the private master.db snapshot.
        await this.destroy();
        this.deleteSchedules("poll");
      } else {
        // A continuation belongs to the same workflow. Keep its CLI process,
        // receipts and original runtime budget alive across agent turns.
        if (previous.agentTurnId !== (row?.agent_turn_id ?? undefined)) {
          previous.agentTurnId = row?.agent_turn_id ?? undefined;
          await this.ctx.storage.put("job", previous);
        }
        // Repair a lost alarm after eviction or an interrupted submission.
        if (!this.polling && !previous.completedAt) {
          this.deleteSchedules("poll");
          await this.schedule(1, "poll");
        }
        return;
      }
    }
    await this.ctx.storage.put("job", {
      accountId,
      id,
      source,
      startedAt: Date.now(),
      failures: 0,
      analysisRepair: row?.analysis_repair === 1,
      workflowId: row?.workflow_id ?? undefined,
      agentGrantId: row?.agent_grant_id ?? undefined,
      agentId: row?.agent_id ?? undefined,
      agentTurnId: row?.agent_turn_id ?? undefined,
    } satisfies Job);
    await this.schedule(1, "poll");
  }

  /** Internal RPC only; the public Worker never exposes container fetch/exec. */
  async execute(
    accountId: string,
    grantId: string,
    agentId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const job = await this.ctx.storage.get<Job>("job");
    if (
      !job ||
      job.accountId !== accountId ||
      job.id !== id ||
      job.workflowId ||
      job.agentGrantId !== grantId ||
      job.agentId !== agentId
    )
      throw new Error("Sandbox ownership mismatch");
    await this.poll();
    const admitted = await this.env.LIBRARY_DB.prepare(
      "SELECT status FROM import_requests WHERE account_id=? AND id=? AND agent_grant_id=? AND agent_id=?",
    )
      .bind(accountId, id, grantId, agentId)
      .first<{ status: string }>();
    if (!admitted || !["running", "complete"].includes(admitted.status))
      throw new Error("Sandbox is queued. Retry shortly.");
    const response = await this.containerFetch("http://container/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok)
      throw new Error(
        response.status === 503 ? "Sandbox is restoring. Retry shortly." : "Sandbox command failed",
      );
    return response.json();
  }

  /** Only the bound workflow can call this RPC; it is never routed from public HTTP. */
  async workflowExecute(
    accountId: string,
    id: string,
    workflowId: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const job = await this.ctx.storage.get<Job>("job");
    if (!job || job.accountId !== accountId || job.id !== id || job.workflowId !== workflowId)
      throw new Error("Workflow ownership mismatch");
    await this.poll();
    const row = await this.env.LIBRARY_DB.prepare(
      "SELECT status FROM import_requests WHERE account_id=? AND id=? AND workflow_id=?",
    )
      .bind(accountId, id, workflowId)
      .first<{ status: string }>();
    if (!row || !["running", "complete"].includes(row.status))
      throw new Error("Workspace is queued or unavailable");
    if (input.operation === "ready") return { status: "ready" };
    const response = await this.containerFetch("http://container/workflow", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error("Workspace is restoring; retry shortly");
    return response.json();
  }

  private polling?: Promise<void>;
  async poll(): Promise<void> {
    return (this.polling ??= this.pollOnce().finally(() => {
      this.polling = undefined;
    }));
  }
  private async pollOnce(): Promise<void> {
    const job = await this.ctx.storage.get<Job>("job");
    if (!job) return;
    if (job.completedAt) {
      if (Date.now() - job.completedAt < 120_000) {
        this.deleteSchedules("poll");
        await this.schedule(15, "poll");
        return;
      }
      await this.destroy();
      await this.ctx.storage.delete("job");
      this.deleteSchedules("poll");
      return;
    }
    if (!job.accountId) {
      await this.destroy();
      await this.ctx.storage.delete("job");
      this.deleteSchedules("poll");
      return;
    }
    if (
      Date.now() - (job.workflowId ? (job.admittedAt ?? Date.now()) : job.startedAt) >
      6 * 60 * 60 * 1000
    ) {
      await this.finish(
        job,
        "Cloud processing reached its six-hour limit. Retry to resume saved work.",
      );
      return;
    }
    // Register recovery BEFORE network I/O, including if the DO is evicted or startup fails.
    this.deleteSchedules("poll");
    await this.schedule(15, "poll");
    const admitted = await this.env.LIBRARY_DB.prepare(
      "UPDATE import_requests SET status='running', phase=CASE WHEN status='queued' THEN 'restore' ELSE phase END WHERE account_id=? AND id=? AND workflow_id IS ? AND (status='running' OR (status='queued' AND (SELECT count(*) FROM import_requests WHERE status='running') < 5)) RETURNING id",
    )
      .bind(job.accountId, job.id, job.workflowId ?? null)
      .first();
    if (!admitted) {
      const row = await this.env.LIBRARY_DB.prepare(
        "SELECT status, workflow_id FROM import_requests WHERE account_id=? AND id=?",
      )
        .bind(job.accountId, job.id)
        .first();
      if (
        row?.status === "complete" ||
        row?.status === "failed" ||
        (row?.workflow_id ?? undefined) !== job.workflowId
      ) {
        await this.destroy();
        await this.ctx.storage.delete("job");
        this.deleteSchedules("poll");
      }
      return;
    }
    if (job.workflowId && !job.admittedAt) {
      job.admittedAt = Date.now();
      await this.ctx.storage.put("job", job);
    }
    try {
      const providerEnv: Record<string, string> = this.env.IMPORT_PROVIDER_ENV
        ? JSON.parse(this.env.IMPORT_PROVIDER_ENV)
        : {};
      const allowed = new Set([
        "SLSK_USERNAME",
        "SLSK_PASSWORD",
        "SOUNDCLOUD_CLIENT_ID",
        "SOUNDCLOUD_CLIENT_SECRET",
        "SPOTIFY_CLIENT_ID",
        "SPOTIFY_CLIENT_SECRET",
        "SPOTIFY_REDIRECT_URI",
        "ACR_HOST",
        "ACR_ACCESS_KEY",
        "ACR_ACCESS_SECRET",
        "AUDD_API_TOKEN",
      ]);
      if (
        Object.entries(providerEnv).some(
          ([key, value]) => !allowed.has(key) || typeof value !== "string",
        )
      )
        throw new Error("Invalid provider configuration");
      await this.startAndWaitForPorts({
        startOptions: {
          envVars: {
            ...(job.agentGrantId && !job.workflowId ? {} : providerEnv),
            DJBOOTH_AGENT: job.agentGrantId && !job.workflowId ? "1" : "0",
            DJBOOTH_WORKFLOW: job.workflowId ? "1" : "0",
            DJBOOTH_IMPORT_ID: job.id,
            DJBOOTH_IMPORT_SOURCE: job.source,
            DJBOOTH_CONTAINER_BINDINGS: "1",
            DJBOOTH_ANALYSIS_REPAIR: job.analysisRepair ? "1" : "0",
          },
        },
        cancellationOptions: { portReadyTimeoutMS: 60_000 },
      });
      const response = await this.containerFetch("http://container/status");
      if (!response.ok) throw new Error("Container status unavailable");
      const progress = await response.json<Record<string, unknown>>();
      if (!validProgress(progress)) throw new Error("Invalid container status");
      const report = progress.report as
        | { updatedAt?: string; tracklist?: unknown; warnings?: unknown; tracks?: unknown[] }
        | undefined;
      if (
        report &&
        typeof report.updatedAt === "string" &&
        Array.isArray(report.tracks) &&
        report.tracks.length <= 10000
      ) {
        // Cache only the read projection. master.db remains the source of truth.
        const tracks = report.tracks;
        try {
          await this.ctx.storage.transaction(async (storage) => {
            const prior = await storage.get<{ updatedAt: string }>("import-report");
            if (prior?.updatedAt !== report.updatedAt) {
              for (let offset = 0; offset < tracks.length; offset += 50)
                await storage.put(
                  `import-report:${offset / 50}`,
                  tracks.slice(offset, offset + 50),
                );
              await storage.put("import-report", {
                accountId: job.accountId,
                id: job.id,
                updatedAt: report.updatedAt,
                workflowID: job.workflowId ?? null,
                tracklist: report.tracklist ?? null,
                warnings: report.warnings ?? [],
                total: tracks.length,
              });
            }
          });
        } catch {
          telemetry("import_report_cache_failed", { importID: job.id });
        }
      }
      if ((job.agentGrantId || job.workflowId) && progress.status === "failed") {
        // An agent-mode terminal status here means workspace initialization
        // failed; command failures are receipts owned by the running agent.
        // Restart from the existing snapshot and keep the download active.
        await this.destroy();
        throw new Error("Workspace initialization will retry");
      }
      if (job.failures) {
        job.failures = 0;
        await this.ctx.storage.put("job", job);
      }
      const observed = {
        workflowID: job.workflowId,
        stage: progress.phase,
        status: progress.status,
        current: progress.current,
        total: progress.total,
      };
      const signature = JSON.stringify(observed);
      if (
        (await this.ctx.storage.get<string>("telemetry-progress").catch(() => undefined)) !==
        signature
      ) {
        telemetry("import_progress", { ...observed, importID: job.id });
        await this.recordImportEvent(job.accountId, job.id, "import_progress", observed);
        // This cache suppresses duplicate logs only; it never controls workflow progress.
        try {
          await this.ctx.storage.put("telemetry-progress", signature);
        } catch {
          /* best effort */
        }
      }
      const terminal = progress.status === "complete" || progress.status === "failed";
      await this.env.LIBRARY_DB.prepare(
        "UPDATE import_requests SET status=?, phase=?, current=?, total=?, message=?, stage_progress=json_patch(COALESCE(stage_progress,'{}'),COALESCE(?,'{}')), collection_id=COALESCE(?,collection_id), analysis_version=CASE WHEN ?=1 THEN 1 ELSE analysis_version END, updated_at=? WHERE account_id=? AND id=? AND workflow_id IS ? AND status IN ('queued','running')",
      )
        .bind(
          progress.status,
          progress.phase,
          progress.current,
          progress.total,
          progress.message,
          progress.stages ? JSON.stringify(progress.stages) : null,
          progress.collectionID ?? null,
          progress.status === "complete" ? progress.analysisVersion : 0,
          Date.now(),
          job.accountId,
          job.id,
          job.workflowId ?? null,
        )
        .run();
      if (terminal && (job.agentGrantId || job.workflowId) && progress.status === "complete") {
        job.completedAt = Date.now();
        await this.ctx.storage.put("job", job);
      } else if (terminal) {
        await this.destroy();
        await this.ctx.storage.delete("job");
        this.deleteSchedules("poll");
      }
    } catch (error) {
      const retryDelayMs = Math.min(120, 15 * 2 ** Math.min(job.failures + 1, 3)) * 1000;
      const fields = {
        workflowID: job.workflowId,
        attempt: job.failures + 1,
        failure: failureKind(error),
        retryDelayMs,
      };
      telemetry("container_retry", { ...fields, importID: job.id });
      await this.recordImportEvent(job.accountId, job.id, "container_retry", fields);
      job.failures++;
      await this.ctx.storage.put("job", job);
      // Temporary startup/status failures do not require a tap to resume.
      // Preserve any live process and retry within the original job budget.
      this.deleteSchedules("poll");
      await this.schedule(Math.min(120, 15 * 2 ** Math.min(job.failures, 3)), "poll");
    }
  }

  private async finish(job: Job, message: string): Promise<void> {
    await this.env.LIBRARY_DB.prepare(
      "UPDATE import_requests SET status='failed', message=?, updated_at=? WHERE account_id=? AND id=? AND workflow_id IS ?",
    )
      .bind(message, Date.now(), job.accountId, job.id, job.workflowId ?? null)
      .run();
    await this.destroy();
    await this.ctx.storage.delete("job");
    this.deleteSchedules("poll");
  }
}

export function validProgress(value: Record<string, unknown>): boolean {
  return (
    ["running", "complete", "failed"].includes(String(value.status)) &&
    (value.status !== "complete" || value.analysisVersion === 1) &&
    [
      "restore",
      "import",
      "resolve",
      "enrich",
      "download",
      "analyze",
      "publish",
      "backup",
      "complete",
      "failed",
    ].includes(String(value.phase)) &&
    Number.isSafeInteger(value.current) &&
    Number.isSafeInteger(value.total) &&
    Number(value.current) >= 0 &&
    Number(value.total) >= Number(value.current) &&
    typeof value.message === "string" &&
    value.message.length <= 500 &&
    (value.stages == null ||
      (typeof value.stages === "object" &&
        !Array.isArray(value.stages) &&
        Object.entries(value.stages).every(
          ([key, stage]) =>
            ["resolve", "download", "analyze", "enrich", "publish"].includes(key) &&
            stage &&
            typeof stage === "object" &&
            ["running", "complete"].includes(stage.status) &&
            Number.isSafeInteger(stage.current) &&
            stage.current >= 0 &&
            Number.isSafeInteger(stage.total) &&
            stage.total >= stage.current,
        ))) &&
    (value.collectionID == null ||
      (typeof value.collectionID === "string" &&
        /^cloud:[a-f0-9-]{36}:playlist:[\w-]{1,128}$/i.test(value.collectionID)))
  );
}

// Intercepted inside Cloudflare; snapshots are scoped to the durable container identity.
PlaylistContainer.outboundByHost = {
  "djbooth.internal": async (request, env: Env, ctx) => {
    const path = new URL(request.url).pathname;
    const owner = await env.LIBRARY_DB.prepare(
      "SELECT account_id, id FROM import_requests WHERE container_id=?",
    )
      .bind(ctx.containerId)
      .first<{ account_id: string; id: string }>();
    if (!owner) return new Response(null, { status: 403 });
    if (path === "/provider-playlist" && request.method === "GET") {
      const input = await env.MEDIA.get(`connected-playlists/${owner.account_id}/${owner.id}.json`);
      return new Response(input?.body ?? null, {
        status: input ? 200 : 404,
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/resolve") return resolveTracklist(request, env);
    if (path.startsWith("/snapshot/"))
      return snapshots(request, env.MEDIA, `${owner.account_id}/${ctx.containerId}`);
    if (path !== "/v1/sync/changes" && !/^\/v1\/media\/[a-f0-9]{64}(\/compose)?$/.test(path))
      return new Response(null, { status: 404 });
    return accountFetch(request, env, {
      id: owner.account_id,
      grantId: "",
      expiresAt: 0,
      capabilities: [],
    });
  },
};
