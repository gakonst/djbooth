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
};

/** Stable Durable Object identity = one playlist = one container, across retries. */
export class PlaylistContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "2m";
  enableInternet = true;

  async enqueue(accountId: string, id: string, source: string): Promise<void> {
    await this.polling;
    const previous = await this.ctx.storage.get<Job>("job");
    if (previous) {
      if (previous.accountId !== accountId || previous.id !== id || previous.source !== source)
        throw new Error("Container ownership mismatch");
      // Repair a lost alarm after eviction or an interrupted submission.
      if (!this.polling) {
        this.deleteSchedules("poll");
        await this.schedule(1, "poll");
      }
      return;
    }
    const row = await this.env.LIBRARY_DB.prepare(
      "SELECT analysis_repair FROM import_requests WHERE account_id=? AND id=?",
    )
      .bind(accountId, id)
      .first<{ analysis_repair: number }>();
    await this.ctx.storage.put("job", {
      accountId,
      id,
      source,
      startedAt: Date.now(),
      failures: 0,
      analysisRepair: row?.analysis_repair === 1,
    } satisfies Job);
    await this.schedule(1, "poll");
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
    if (!job.accountId) {
      await this.destroy();
      await this.ctx.storage.delete("job");
      this.deleteSchedules("poll");
      return;
    }
    if (Date.now() - job.startedAt > 6 * 60 * 60 * 1000) {
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
      "UPDATE import_requests SET status='running', phase=CASE WHEN status='queued' THEN 'restore' ELSE phase END WHERE account_id=? AND id=? AND (status='running' OR (status='queued' AND (SELECT count(*) FROM import_requests WHERE status='running') < 5)) RETURNING id",
    )
      .bind(job.accountId, job.id)
      .first();
    if (!admitted) {
      const row = await this.env.LIBRARY_DB.prepare(
        "SELECT status FROM import_requests WHERE account_id=? AND id=?",
      )
        .bind(job.accountId, job.id)
        .first();
      if (row?.status === "complete" || row?.status === "failed") {
        await this.destroy();
        await this.ctx.storage.delete("job");
        this.deleteSchedules("poll");
      }
      return;
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
            ...providerEnv,
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
      const terminal = progress.status === "complete" || progress.status === "failed";
      await this.env.LIBRARY_DB.prepare(
        "UPDATE import_requests SET status=?, phase=?, current=?, total=?, message=?, collection_id=COALESCE(?,collection_id), analysis_version=CASE WHEN ?=1 THEN 1 ELSE analysis_version END, updated_at=? WHERE account_id=? AND id=?",
      )
        .bind(
          progress.status,
          progress.phase,
          progress.current,
          progress.total,
          progress.message,
          progress.collectionID ?? null,
          progress.status === "complete" ? progress.analysisVersion : 0,
          Date.now(),
          job.accountId,
          job.id,
        )
        .run();
      if (terminal) {
        await this.destroy();
        await this.ctx.storage.delete("job");
        this.deleteSchedules("poll");
      }
    } catch {
      job.failures++;
      await this.ctx.storage.put("job", job);
      if (job.failures >= 5)
        await this.finish(
          job,
          "Playlist container could not run. Check cloud configuration, then retry to resume.",
        );
    }
  }

  private async finish(job: Job, message: string): Promise<void> {
    await this.env.LIBRARY_DB.prepare(
      "UPDATE import_requests SET status='failed', phase='failed', message=?, updated_at=? WHERE account_id=? AND id=?",
    )
      .bind(message, Date.now(), job.accountId, job.id)
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
      "SELECT account_id FROM import_requests WHERE container_id=?",
    )
      .bind(ctx.containerId)
      .first<{ account_id: string }>();
    if (!owner) return new Response(null, { status: 403 });
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
