import { AuthError, digest, type Account } from "./auth.js";
import type { Env } from "./index.js";
import { fastStartPlayback } from "./playback-faststart.js";

const HASH = /^[a-f0-9]{64}$/;
const TYPES: Record<string, string> = {
  mp3: "audio/mpeg",
  flac: "audio/flac",
  wav: "audio/wav",
  aiff: "audio/aiff",
  aif: "audio/aiff",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
};
const response = (value: unknown) =>
  Response.json(value, { headers: { "cache-control": "private, no-store" } });

/** A speaker receives only a short-lived capability for the selected media,
 * never the phone's account credential. Sonos owns the queue while iOS sleeps. */
export async function createPlayback(
  request: Request,
  env: Env,
  account: Account,
  readJSON: (request: Request) => Promise<unknown>,
): Promise<Response> {
  if (request.method !== "POST") throw new AuthError(405, "Use POST to create a playback session.");
  const body = (await readJSON(request)) as { tracks?: unknown };
  if (!body || !Array.isArray(body.tracks) || !body.tracks.length || body.tracks.length > 2000)
    throw new AuthError(400, "Choose between 1 and 2000 library tracks.");
  const media: Record<string, string> = {};
  for (const item of body.tracks) {
    if (!item || typeof item !== "object") throw new AuthError(400, "Invalid playback track.");
    const { hash, extension } = item as { hash?: unknown; extension?: unknown };
    if (
      typeof hash !== "string" ||
      !HASH.test(hash) ||
      typeof extension !== "string" ||
      !Object.hasOwn(TYPES, extension)
    )
      throw new AuthError(400, "Invalid playback media or format.");
    media[hash] = extension;
  }
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  const expires = Math.min(Date.now() + 6 * 60 * 60 * 1000, account.expiresAt * 1000);
  await env.LIBRARY_DB.prepare(
    "INSERT INTO playback_sessions(token_hash,account_id,grant_id,expires_at,media_json) VALUES(?,?,?,?,?)",
  )
    .bind(await digest(token), account.id, account.grantId, expires, JSON.stringify(media))
    .run();
  const base = new URL(`/v1/playback/${token}`, request.url).href;
  return response({
    session: token,
    expiresAt: expires,
    urls: Object.fromEntries(
      Object.entries(media).map(([hash, extension]) => [
        hash,
        `${base}/${hash}/audio.${extension}${["m4a", "mp4"].includes(extension) ? "?layout=faststart-v1" : ""}`,
      ]),
    ),
  });
}

export async function revokePlayback(token: string, env: Env, account: Account): Promise<Response> {
  await env.LIBRARY_DB.prepare("DELETE FROM playback_sessions WHERE token_hash=? AND account_id=?")
    .bind(await digest(token), account.id)
    .run();
  return response({ revoked: true });
}

export async function playbackMedia(
  request: Request,
  env: Env,
  token: string,
  hash: string,
  readMedia: (request: Request, env: Env, hash: string, account: Account) => Promise<Response>,
): Promise<Response> {
  if (!["GET", "HEAD"].includes(request.method))
    throw new AuthError(405, "Playback sessions are read-only.");
  const row = await env.LIBRARY_DB.prepare(
    "SELECT account_id,grant_id,expires_at,media_json FROM playback_sessions WHERE token_hash=? AND expires_at>?",
  )
    .bind(await digest(token), Date.now())
    .first<{ account_id: string; grant_id: string; expires_at: number; media_json: string }>();
  if (!row) throw new AuthError(404, "Playback session expired or was revoked.");
  const media = JSON.parse(row.media_json) as Record<string, string>;
  if (!Object.hasOwn(media, hash))
    throw new AuthError(404, "This track is outside the playback session.");
  const account = {
    id: row.account_id,
    grantId: row.grant_id,
    expiresAt: row.expires_at / 1000,
    capabilities: [],
  };
  if (
    ["m4a", "mp4"].includes(media[hash]!) &&
    new URL(request.url).searchParams.get("layout") === "faststart-v1"
  ) {
    // Cached MP4 headers must not outlive a shared playlist's media permission.
    const authorized = await readMedia(
      new Request(request.url, { method: "HEAD" }),
      env,
      hash,
      account,
    );
    if (!authorized.ok) return authorized;
    const optimized = await fastStartPlayback(
      request,
      env.MEDIA,
      row.account_id,
      hash,
      (range, head) =>
        readMedia(
          new Request(request.url, {
            method: head ? "HEAD" : "GET",
            headers: range
              ? { range: `bytes=${range.offset}-${range.offset + range.length - 1}` }
              : {},
          }),
          env,
          hash,
          account,
        ),
    );
    if (optimized) return optimized;
  }
  const result = await readMedia(request, env, hash, {
    id: row.account_id,
    grantId: row.grant_id,
    expiresAt: row.expires_at / 1000,
    capabilities: [],
  });
  const headers = new Headers(result.headers);
  headers.set("cache-control", "private, no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("content-type", TYPES[media[hash]]);
  return new Response(result.body, { status: result.status, headers });
}
