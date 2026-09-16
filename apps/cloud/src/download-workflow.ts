import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Env } from "./index.js";

export type DownloadParams = { accountId: string; id: string; source: string };
type Receipt = {
  status: string;
  process_id: string;
  result?: {
    playlistId?: string;
    entries?: number;
    dbPath?: string;
    sourceSetFallbacks?: number;
    collectionID?: string;
  };
  error?: string;
};

/** Durable orchestration only. Per-recording state and artifacts belong to the existing CLI. */
export class DownloadWorkflow extends WorkflowEntrypoint<Env, DownloadParams> {
  async run(event: WorkflowEvent<DownloadParams>, step: WorkflowStep) {
    const { accountId, id, source } = event.payload;
    const workflowId = event.instanceId;
    const container = this.env.PLAYLIST_CONTAINERS!.getByName(`${accountId}:${id}`);
    const stage = (name: string, imported?: Receipt["result"]) =>
      step.do(
        name,
        {
          retries: { limit: 90, delay: "10 seconds", backoff: "constant" },
          timeout: "10 minutes",
        },
        async (context) => {
          const row = await this.env.LIBRARY_DB.prepare(
            "SELECT status, workflow_id, collection_id, analysis_version FROM import_requests WHERE account_id=? AND id=?",
          )
            .bind(accountId, id)
            .first<{
              status: string;
              workflow_id: string;
              collection_id: string;
              analysis_version: number;
            }>();
          if (!row || row.workflow_id !== workflowId || row.status === "failed")
            throw new NonRetryableError("Download was cancelled or superseded");
          if (
            name === "publish" &&
            row.status === "complete" &&
            row.analysis_version === 1 &&
            row.collection_id
          )
            return { collectionID: row.collection_id };
          await container.enqueue(accountId, id, source);
          // A replay attaches to an existing process. Only a failed/lost command is rerun.
          let receipt = (await container.workflowExecute(accountId, id, workflowId, {
            operation: "start",
            stage: name,
            process_id: `${name}-${context.attempt}`,
            imported,
          })) as Receipt;
          const until = Date.now() + 240_000;
          while (receipt.status === "running" && Date.now() < until) {
            receipt = (await container.workflowExecute(accountId, id, workflowId, {
              operation: "poll",
              process_id: receipt.process_id,
            })) as Receipt;
          }
          if (receipt.status !== "completed") {
            // Long commands remain alive across step retries; temporary transport loss does not cancel them.
            throw new Error(
              receipt.status === "failed"
                ? (receipt.error ?? "Command failed")
                : "Waiting for saved work",
            );
          }
          return receipt.result ?? {};
        },
      );
    try {
      await step.do(
        "prepare-workspace",
        {
          retries: { limit: 2160, delay: "30 seconds", backoff: "constant" },
          timeout: "2 minutes",
        },
        async () => {
          const row = await this.env.LIBRARY_DB.prepare(
            "SELECT status, workflow_id FROM import_requests WHERE account_id=? AND id=?",
          )
            .bind(accountId, id)
            .first<{ status: string; workflow_id: string }>();
          if (!row || row.workflow_id !== workflowId || row.status === "failed")
            throw new NonRetryableError("Download was cancelled or superseded");
          await container.enqueue(accountId, id, source);
          await container.workflowExecute(accountId, id, workflowId, { operation: "ready" });
        },
      );
      await stage("resolve");
      const imported = await stage("import");
      await stage("enrich");
      const published = await stage("publish", imported);
      await step.do("confirm-publication", async () => {
        await container.poll();
        const row = await this.env.LIBRARY_DB.prepare(
          "SELECT status, collection_id FROM import_requests WHERE account_id=? AND id=? AND workflow_id=?",
        )
          .bind(accountId, id, workflowId)
          .first<{ status: string; collection_id: string }>();
        if (row?.status !== "complete" || row.collection_id !== published.collectionID)
          throw new Error("Publication is not yet confirmed");
        return { collectionID: row.collection_id };
      });
      return published;
    } catch (error) {
      await step.do("record-failure", async () => {
        await this.env.LIBRARY_DB.prepare(
          "UPDATE import_requests SET status='failed', message='Cloud processing could not finish after automatic retries. Saved tracks are retained.', updated_at=? WHERE account_id=? AND id=? AND workflow_id=? AND status IN ('queued','running')",
        )
          .bind(Date.now(), accountId, id, workflowId)
          .run();
      });
      throw error;
    }
  }
}

/** Submission is idempotent; cron repairs a request interrupted between D1 and Workflows. */
export async function ensureDownloadWorkflow(env: Env, params: DownloadParams, workflowId: string) {
  if (!env.DOWNLOAD_WORKFLOW) throw new Error("Download workflow is not configured");
  try {
    await env.DOWNLOAD_WORKFLOW.create({ id: workflowId, params });
  } catch (error) {
    const instance = await env.DOWNLOAD_WORKFLOW.get(workflowId);
    const status = await instance.status();
    if (status.status === "unknown") throw error;
    // Failed instances never get silently restarted. An explicit retry gets a new ID.
    if (["errored", "terminated"].includes(status.status)) {
      await env.LIBRARY_DB.prepare(
        "UPDATE import_requests SET status='failed', message='Cloud processing could not finish after automatic retries. Saved tracks are retained.', updated_at=? WHERE account_id=? AND id=? AND workflow_id=? AND status IN ('queued','running')",
      )
        .bind(Date.now(), params.accountId, params.id, workflowId)
        .run();
    }
  }
}
