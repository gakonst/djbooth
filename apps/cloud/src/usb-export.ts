import type { Account } from "./auth.js";
import type { Env } from "./index.js";

/** Serve only genuine exports published by the trusted local USB exporter. */
export async function usbExport(
  request: Request,
  env: Env,
  account: Account,
  readJSON: (request: Request) => Promise<unknown>,
  media: (hash: string) => Promise<Response>,
): Promise<Response> {
  const reply = (message: string, status: number) =>
    Response.json({ error: { message } }, { status });
  const playlist = new URL(request.url).searchParams.get("playlist");
  if (!playlist || playlist.length > 512) return reply("Choose a playlist.", 400);
  const row = await env.LIBRARY_DB.prepare(
    "SELECT payload, deleted FROM sync_changes WHERE account_id=? AND kind='collection' AND entity_id=? ORDER BY sequence DESC LIMIT 1",
  )
    .bind(account.id, playlist)
    .first<{ payload: string; deleted: number }>();
  if (!row || row.deleted) return reply("Playlist not found.", 404);
  const collection = JSON.parse(row.payload) as { trackIDs: string[] };
  const key = `accounts/${account.id}/usb-exports/${encodeURIComponent(playlist)}.json`;
  if (request.method === "POST") {
    // The authenticated router restricts shared-library writes to the private publisher.
    const value = (await readJSON(request)) as { hash?: string; trackIDs?: string[] };
    if (
      !value ||
      typeof value.hash !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.hash) ||
      JSON.stringify(value.trackIDs) !== JSON.stringify(collection.trackIDs)
    )
      return reply("Export must match the current ordered playlist.", 409);
    const object =
      (await env.MEDIA.head(`accounts/${account.id}/sha256/${value.hash}`)) ??
      (await env.MEDIA.head(`accounts/${account.id}/compositions/${value.hash}`));
    if (!object) return reply("Upload the verified USB archive first.", 409);
    await env.MEDIA.put(key, JSON.stringify({ hash: value.hash, trackIDs: value.trackIDs }));
    return Response.json({ ready: true });
  }
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD, POST" } });
  const stored = await env.MEDIA.get(key);
  if (!stored)
    return reply(
      "This playlist has no USB export yet. Publish it with cloud publish --usb-export.",
      409,
    );
  const artifact = await stored.json<{ hash: string; trackIDs: string[] }>();
  if (JSON.stringify(artifact.trackIDs) !== JSON.stringify(collection.trackIDs))
    return reply("The playlist changed. Publish a fresh USB export before downloading.", 409);
  const response = await media(artifact.hash);
  if (!response.ok) return response;
  const headers = new Headers(response.headers);
  headers.set("content-type", "application/zip");
  headers.set("content-disposition", 'attachment; filename="djbooth-usb.zip"');
  headers.set("cache-control", "private, no-store");
  return new Response(response.body, { status: response.status, headers });
}
