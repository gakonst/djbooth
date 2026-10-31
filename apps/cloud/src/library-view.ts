import type { Env } from "./index.js";
import type { Account } from "./auth.js";
/** Compact current library for web clients; sync's complete history remains unchanged. */
export async function libraryView(request: Request, env: Env, account: Account): Promise<Response> {
  if (request.method !== "GET")
    return Response.json(
      { error: { message: "Method not allowed." } },
      { status: 405, headers: { allow: "GET" } },
    );
  const collectionId = new URL(request.url).searchParams.get("collection");
  if (collectionId !== null) {
    if (!collectionId || collectionId.length > 256)
      return Response.json({ error: { message: "Invalid playlist ID." } }, { status: 400 });
    const row = await env.LIBRARY_DB.withSession("first-primary")
      .prepare(
        "SELECT sequence, payload, deleted FROM sync_changes WHERE account_id = ? AND kind = 'collection' AND entity_id = ? ORDER BY sequence DESC LIMIT 1",
      )
      .bind(account.id, collectionId)
      .first<{ sequence: number; payload: string | null; deleted: number }>();
    return Response.json(
      {
        collection: row && !row.deleted && row.payload ? JSON.parse(row.payload) : null,
        version: row?.sequence ?? 0,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  }
  const trackId = new URL(request.url).searchParams.get("track");
  if (trackId !== null) {
    if (!trackId || trackId.length > 512)
      return Response.json({ error: { message: "Invalid track ID." } }, { status: 400 });
    const row = await env.LIBRARY_DB.withSession("first-primary")
      .prepare(
        "SELECT payload, deleted FROM sync_changes WHERE account_id = ? AND kind = 'track' AND entity_id = ? ORDER BY sequence DESC LIMIT 1",
      )
      .bind(account.id, trackId)
      .first<{ payload: string | null; deleted: number }>();
    return Response.json(
      {
        track:
          row && !row.deleted && row.payload ? { ...JSON.parse(row.payload), id: trackId } : null,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  }
  const raw = new URL(request.url).searchParams.get("after") ?? "0";
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    return Response.json({ error: { message: "Invalid cursor." } }, { status: 400 });
  const { results } = await env.LIBRARY_DB.withSession("first-primary")
    .prepare(`
    SELECT sequence, kind, entity_id AS id,
      json_remove(payload, '$.waveform', '$.beatGrid') AS payload
    FROM sync_changes AS current
    WHERE account_id = ? AND kind IN ('track', 'collection') AND deleted = 0 AND sequence > ?
      AND sequence = (SELECT MAX(sequence) FROM sync_changes AS latest WHERE latest.account_id = current.account_id AND latest.kind = current.kind AND latest.entity_id = current.entity_id)
    ORDER BY sequence LIMIT 501
  `)
    .bind(account.id, Number(raw))
    .all<{ sequence: number; kind: string; id: string; payload: string }>();
  const rows = results.slice(0, 500);
  return Response.json(
    {
      items: rows.map((row) => ({ kind: row.kind, ...JSON.parse(row.payload), id: row.id })),
      cursor: rows.at(-1)?.sequence ?? Number(raw),
      hasMore: results.length > 500,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
