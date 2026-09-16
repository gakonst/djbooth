import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { Miniflare } from "miniflare";

test(
  "real Workers Workflow retries a failed sandbox stage and confirms publication",
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
            await this.env.LIBRARY_DB.prepare('INSERT INTO test_steps(stage) VALUES (?)').bind(input.stage).run();
            if (input.stage === 'import' && !(await this.ctx.storage.get('retried'))) {
              await this.ctx.storage.put('retried', true);
              return { status:'failed', process_id:input.process_id, error:'Temporary download failure' };
            }
            let result = {};
            if (input.stage === 'import') result = { playlistId:'17', entries:2, dbPath:'/data/master.db', sourceSetFallbacks:0 };
            if (input.stage === 'publish') {
              if (input.imported.playlistId !== '17' || input.imported.entries !== 2) throw new Error('Lost durable result');
              result = { collectionID:'cloud:' + id + ':playlist:17' };
              await this.env.LIBRARY_DB.prepare("UPDATE import_requests SET status='complete',collection_id=?,analysis_version=1 WHERE account_id=? AND id=? AND workflow_id=?").bind(result.collectionID,account,id,workflow).run();
            }
            return { status:'completed', process_id:input.process_id, result };
          }
        }
        export default { async fetch(request, env) {
          const instance = request.method === 'POST'
            ? await env.DOWNLOAD_WORKFLOW.create({id:'runtime-test',params:await request.json()})
            : await env.DOWNLOAD_WORKFLOW.get('runtime-test');
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
      const id = "11111111-1111-1111-1111-111111111111";
      const source = "https://soundcloud.com/artist/sets/list";
      await db.exec("CREATE TABLE test_steps(stage TEXT)");
      await db
        .prepare(
          "INSERT INTO import_requests(account_id,id,container_id,source,created_at,updated_at,workflow_id) VALUES ('owner',?,'container',?,0,0,'runtime-test')",
        )
        .bind(id, source)
        .run();
      const started = await runtime.dispatchFetch("https://workflow.test/", {
        method: "POST",
        body: JSON.stringify({ accountId: "owner", id, source }),
      });
      assert.equal(started.status, 200);
      let status;
      for (let attempt = 0; attempt < 150; attempt++) {
        status = await (await runtime.dispatchFetch("https://workflow.test/")).json();
        if (["complete", "errored", "terminated"].includes(status.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.equal(status.status, "complete", JSON.stringify(status));
      assert.deepEqual(
        (await db.prepare("SELECT stage FROM test_steps ORDER BY rowid").all()).results.map(
          (v) => v.stage,
        ),
        ["resolve", "import", "import", "enrich", "publish"],
      );
      assert.equal(
        (await db.prepare("SELECT status FROM import_requests").first()).status,
        "complete",
      );
    } finally {
      await runtime.dispose();
    }
  },
);
