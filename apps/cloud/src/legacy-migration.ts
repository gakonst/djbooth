import type { Account } from "./auth.js";
import type { Env } from "./index.js";

interface LegacyRow {
  sequence: number;
  operation_id: string;
  kind: string;
  entity_id: string;
  payload: string | null;
  deleted: number;
  created_at: string;
}
interface LegacyJob {
  id: string;
  source: string;
  status: string;
  phase: string;
  current: number;
  total: number;
  message: string;
  collection_id: string | null;
  created_at: number;
  updated_at: number;
}
const latest = `SELECT old.* FROM legacy_sync_changes old WHERE old.sequence =
  (SELECT MAX(new.sequence) FROM legacy_sync_changes new WHERE new.kind=old.kind AND new.entity_id=old.entity_id)`;
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "private, no-store" } });

/** Explicit operator assignment, never first-login ownership. Every batch remains
 * authenticated as the assigned account; originals and newer target edits survive. */
export async function migrateLegacy(
  request: Request,
  env: Env,
  account: Account,
): Promise<Response> {
  if (!env.LEGACY_LIBRARY_OWNER || env.LEGACY_LIBRARY_OWNER !== account.id)
    return json(
      { error: { message: "Legacy ownership has not been assigned to this account." } },
      403,
    );
  const jobs = (
    await env.LIBRARY_DB.prepare(
      "SELECT * FROM legacy_import_requests ORDER BY id",
    ).all<LegacyJob>()
  ).results;
  const tasks = [
    { source: "sha256/", target: `accounts/${account.id}/sha256/`, name: "recordings" },
    {
      source: "compositions/",
      target: `accounts/${account.id}/compositions/`,
      name: "recording-indexes",
    },
    ...jobs.map((job) => {
      if (!env.PLAYLIST_CONTAINERS) throw new Error("Playlist storage is unavailable");
      const previous = env.PLAYLIST_CONTAINERS.idFromName(job.id).toString();
      const next = env.PLAYLIST_CONTAINERS.idFromName(`${account.id}:${job.id}`).toString();
      return {
        source: `playlist-snapshots/${previous}/`,
        target: `playlist-snapshots/${account.id}/${next}/`,
        name: `backup-${job.id}`,
      };
    }),
  ];
  if (request.method === "GET") {
    const counts = (
      await env.LIBRARY_DB.prepare(
        `SELECT kind, COUNT(*) AS total, SUM(deleted) AS deleted FROM (${latest}) GROUP BY kind`,
      ).all()
    ).results;
    const objects = [];
    for (const [id, task] of tasks.entries()) {
      let cursor: string | undefined,
        total = 0,
        bytes = 0;
      do {
        const page = await env.MEDIA.list({ prefix: task.source, cursor, limit: 1000 });
        total += page.objects.length;
        bytes += page.objects.reduce((n, object) => n + object.size, 0);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      objects.push({ id, name: task.name, total, bytes });
    }
    return json({ accountId: account.id, entities: counts, imports: jobs.length, objects });
  }
  if (request.method !== "POST") return json({ error: { message: "Method not allowed" } }, 405);
  const body = await request.json<{
    phase?: string;
    task?: number;
    cursor?: string;
    after?: number;
  }>();
  if (body.phase === "objects") {
    if (
      !Number.isInteger(body.task) ||
      body.task! < 0 ||
      body.task! >= tasks.length ||
      (body.cursor !== undefined && (typeof body.cursor !== "string" || body.cursor.length > 4096))
    )
      return json({ error: { message: "Invalid migration batch" } }, 400);
    const task = tasks[body.task!]!;
    const page = await env.MEDIA.list({ prefix: task.source, cursor: body.cursor, limit: 5 });
    let copied = 0,
      reused = 0;
    await Promise.all(
      page.objects.map(async (object) => {
        const destination = task.target + object.key.slice(task.source.length);
        const existing = await env.MEDIA.head(destination);
        if (existing) {
          if (existing.size !== object.size || existing.etag !== object.etag)
            throw new Error("Migration target differs from archived object");
          reused++;
          return;
        }
        const source = await env.MEDIA.get(object.key);
        if (!source) throw new Error("Archived object disappeared; retry migration");
        const hash = /(?:^sha256\/|\/chunks\/)([a-f0-9]{64})$/.exec(object.key)?.[1];
        await env.MEDIA.put(destination, source.body, {
          onlyIf: { etagDoesNotMatch: "*" },
          httpMetadata: source.httpMetadata,
          customMetadata: source.customMetadata,
          ...(hash ? { sha256: hash } : {}),
        });
        const written = await env.MEDIA.head(destination);
        if (!written || written.size !== source.size || written.etag !== source.etag)
          throw new Error("Migrated object failed verification");
        copied++;
      }),
    );
    return json({
      copied,
      reused,
      count: page.objects.length,
      cursor: page.truncated ? page.cursor : null,
    });
  }
  if (body.phase === "entities") {
    const after = body.after ?? 0;
    if (!Number.isSafeInteger(after) || after < 0)
      return json({ error: { message: "Invalid migration cursor" } }, 400);
    const rows = (
      await env.LIBRARY_DB.prepare(
        `SELECT * FROM (${latest}) WHERE sequence>? ORDER BY sequence LIMIT 10`,
      )
        .bind(after)
        .all<LegacyRow>()
    ).results;
    const conflicts: string[] = [];
    let copied = 0,
      reused = 0;
    for (const row of rows) {
      const result =
        await env.LIBRARY_DB.prepare(`INSERT INTO sync_changes(account_id,operation_id,kind,entity_id,base_version,payload,deleted,created_at)
        SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM sync_changes WHERE account_id=? AND kind=? AND entity_id=?)
        AND NOT EXISTS (SELECT 1 FROM sync_changes WHERE account_id=? AND operation_id=?)`)
          .bind(
            account.id,
            row.operation_id,
            row.kind,
            row.entity_id,
            0,
            row.payload,
            row.deleted,
            row.created_at,
            account.id,
            row.kind,
            row.entity_id,
            account.id,
            row.operation_id,
          )
          .run();
      if (result.meta.changes) copied++;
      else {
        const current = await env.LIBRARY_DB.prepare(
          "SELECT payload,deleted FROM sync_changes WHERE account_id=? AND kind=? AND entity_id=? ORDER BY sequence DESC LIMIT 1",
        )
          .bind(account.id, row.kind, row.entity_id)
          .first<LegacyRow>();
        if (current?.payload === row.payload && current?.deleted === row.deleted) reused++;
        else conflicts.push(`${row.kind}:${row.entity_id}`);
      }
    }
    return json({
      copied,
      reused,
      conflicts,
      count: rows.length,
      after: rows.at(-1)?.sequence ?? after,
      done: rows.length < 10,
    });
  }
  if (body.phase === "imports") {
    let copied = 0;
    const conflicts: string[] = [];
    for (const job of jobs) {
      const container = env.PLAYLIST_CONTAINERS!.idFromName(`${account.id}:${job.id}`).toString();
      // Interrupted old jobs must be deliberately resumed, never auto-launched during migration.
      const interrupted = ["queued", "running"].includes(job.status);
      const result =
        await env.LIBRARY_DB.prepare(`INSERT INTO import_requests(account_id,id,container_id,source,status,phase,current,total,message,collection_id,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM import_requests WHERE account_id=? AND (id=? OR source=?))`)
          .bind(
            account.id,
            job.id,
            container,
            job.source,
            interrupted ? "failed" : job.status,
            job.phase,
            job.current,
            job.total,
            interrupted
              ? "Previous import interrupted; retry to resume its restored backup"
              : job.message,
            job.collection_id,
            job.created_at,
            job.updated_at,
            account.id,
            job.id,
            job.source,
          )
          .run();
      copied += result.meta.changes;
      if (!result.meta.changes) {
        const current = await env.LIBRARY_DB.prepare(
          "SELECT id,source FROM import_requests WHERE account_id=? AND (id=? OR source=?)",
        )
          .bind(account.id, job.id, job.source)
          .first<LegacyJob>();
        if (current?.id !== job.id || current?.source !== job.source) conflicts.push(job.id);
      }
    }
    return json({ copied, count: jobs.length, conflicts });
  }
  return json({ error: { message: "Invalid migration phase" } }, 400);
}
