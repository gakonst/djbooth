import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { Miniflare } from "miniflare";

test(
  "concurrent playlist Workflows retry independently and publish account-scoped results",
  { timeout: 60_000 },
  async () => {
    const workflow = {
      name: "test-download",
      className: "DownloadWorkflow",
      scriptName: "library",
    };
    const runtime = new Miniflare({
      workers: [
        {
          name: "driver",
          modules: true,
          compatibilityDate: "2026-08-01",
          workflows: { DOWNLOAD_WORKFLOW: workflow },
          d1Databases: { LIBRARY_DB: "workflow-library" },
          durableObjects: { PLAYLIST_CONTAINERS: { className: "TestPlaylist" } },
          script: `import { DurableObject } from "cloudflare:workers";
        export class TestPlaylist extends DurableObject {
          async enqueue() {} async poll() {}
          async workflowExecute(account, id, workflow, input) {
            if (input.operation === 'ready') return { status: 'ready' };
            if (!/^[a-z]+-[1-9][0-9]*$/.test(input.process_id)) throw new Error('Missing Workflow step attempt');
            await this.env.LIBRARY_DB.prepare('INSERT INTO test_steps(account,id,stage) VALUES (?,?,?)').bind(account,id,input.stage).run();
            if (input.stage === 'import' && !(await this.ctx.storage.get('retried'))) {
              await this.ctx.storage.put('retried', true);
              return { status:'failed', process_id:input.process_id, error:'Temporary download failure' };
            }
            let result = {};
            if (input.stage === 'import') result = { playlistId:account + ':' + id, entries:2, dbPath:'/data/master.db', sourceSetFallbacks:0 };
            if (input.stage === 'publish') {
              if (input.imported.playlistId !== account + ':' + id || input.imported.entries !== 2) throw new Error('Lost or mixed durable result');
              result = { collectionID:'cloud:' + id + ':playlist:17' };
              await this.env.LIBRARY_DB.prepare("UPDATE import_requests SET status='complete',collection_id=?,analysis_version=1 WHERE account_id=? AND id=? AND workflow_id=?").bind(result.collectionID,account,id,workflow).run();
            }
            return { status:'completed', process_id:input.process_id, result };
          }
        }
        export default { async fetch(request, env) {
          const id = new URL(request.url).pathname.slice(1);
          const instance = request.method === 'POST'
            ? await env.DOWNLOAD_WORKFLOW.create({id,params:await request.json()})
            : await env.DOWNLOAD_WORKFLOW.get(id);
          return Response.json(await instance.status());
        } };`,
        },
        {
          name: "library",
          modules: true,
          scriptPath: new URL("../dist/index.js", import.meta.url).pathname,
          compatibilityDate: "2026-08-01",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: { LIBRARY_DB: "workflow-library" },
          r2Buckets: ["MEDIA"],
          durableObjects: {
            PLAYLIST_CONTAINERS: { className: "TestPlaylist", scriptName: "driver" },
          },
        },
      ],
    });
    try {
      const db = await runtime.getD1Database("LIBRARY_DB", "driver");
      for (const file of (await readdir(new URL("../migrations/", import.meta.url))).sort())
        if (file.endsWith(".sql"))
          await db.exec(
            (await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"))
              .replace(/^--.*$/gm, "")
              .replace(/\n/g, " "),
          );
      await db.exec("CREATE TABLE test_steps(account TEXT,id TEXT,stage TEXT)");
      // Repeated playlist IDs across two owners must still get separate workspaces/results.
      const jobs = Array.from({ length: 6 }, (_, i) => ({
        id: `11111111-1111-1111-1111-11111111111${i % 3}`,
        accountId: `owner-${Math.floor(i / 3)}`,
        workflowId: `runtime-${i}`,
        source: `https://soundcloud.com/artist/sets/list-${i % 3}`,
      }));
      for (const job of jobs)
        await db
          .prepare(
            "INSERT INTO import_requests(account_id,id,container_id,source,created_at,updated_at,workflow_id) VALUES (?,?,?,?,0,0,?)",
          )
          .bind(job.accountId, job.id, job.workflowId, job.source, job.workflowId)
          .run();
      await Promise.all(
        jobs.map(async (job) => {
          const started = await runtime.dispatchFetch(`https://workflow.test/${job.workflowId}`, {
            method: "POST",
            body: JSON.stringify({ accountId: job.accountId, id: job.id, source: job.source }),
          });
          assert.equal(started.status, 200);
        }),
      );
      let statuses;
      for (let attempt = 0; attempt < 150; attempt++) {
        statuses = await Promise.all(
          jobs.map(async (job) =>
            (await runtime.dispatchFetch(`https://workflow.test/${job.workflowId}`)).json(),
          ),
        );
        if (
          statuses.every((status) => ["complete", "errored", "terminated"].includes(status.status))
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      for (const status of statuses)
        assert.equal(status.status, "complete", JSON.stringify(status));
      for (const job of jobs)
        assert.deepEqual(
          (
            await db
              .prepare("SELECT stage FROM test_steps WHERE account=? AND id=? ORDER BY rowid")
              .bind(job.accountId, job.id)
              .all()
          ).results.map((v) => v.stage),
          ["resolve", "import", "import", "enrich", "publish"],
        );
      assert.equal(
        (
          await db
            .prepare("SELECT count(*) AS n FROM import_requests WHERE status='complete'")
            .first()
        ).n,
        jobs.length,
      );
    } finally {
      await runtime.dispose();
    }
  },
);
