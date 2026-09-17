import type { CrewRoom } from "./crew-room.js";
type ReadJSON = (request: Request) => Promise<unknown>;
type Role = "owner" | "admin" | "dj" | "viewer";
interface CrewEnv {
  LIBRARY_DB: D1Database;
  MEDIA: R2Bucket;
  CREW_ROOMS?: DurableObjectNamespace<CrewRoom>;
}
interface CrewAccount {
  id: string;
}

class CrewError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(value, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
const ID = /^(crew|crate|item|invite)_[a-f0-9-]{32,36}$/;
const HASH = /^[a-f0-9]{64}$/;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new CrewError(400, "Send a JSON object.");
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string, maximum: number, optional = false): string | null {
  if (optional && (value === undefined || value === null || value === "")) return null;
  if (typeof value !== "string") throw new CrewError(400, `${name} must be text.`);
  const result = value.trim();
  if (!result || result.length > maximum) throw new CrewError(400, `${name} is invalid.`);
  return result;
}
function id(prefix: "crew" | "crate" | "item" | "invite"): string {
  return `${prefix}_${crypto.randomUUID()}`;
}
function token(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function requireID(value: string): string {
  if (!ID.test(value)) throw new CrewError(404, "Crew item was not found.");
  return value;
}

interface Membership {
  role: Role;
  display_name: string;
}
async function membership(env: CrewEnv, account: CrewAccount, crewID: string): Promise<Membership> {
  const member = await env.LIBRARY_DB.prepare(
    "SELECT role, display_name FROM crew_members WHERE crew_id = ? AND account_id = ?",
  )
    .bind(crewID, account.id)
    .first<Membership>();
  if (!member) throw new CrewError(404, "Crew was not found.");
  return member;
}
function canWrite(role: Role): boolean {
  return role !== "viewer";
}
function canAdmin(role: Role): boolean {
  return role === "owner" || role === "admin";
}

async function listCrews(env: CrewEnv, account: CrewAccount): Promise<Response> {
  const rows = await env.LIBRARY_DB.prepare(`
    SELECT c.id, c.name, m.role, c.updated_at AS updatedAt,
      (SELECT COUNT(*) FROM crew_members x WHERE x.crew_id = c.id) AS memberCount,
      (SELECT COUNT(*) FROM crew_crates x WHERE x.crew_id = c.id) AS crateCount
    FROM crew_members m JOIN crews c ON c.id = m.crew_id
    WHERE m.account_id = ? ORDER BY c.updated_at DESC, c.name COLLATE NOCASE
  `)
    .bind(account.id)
    .all();
  return json({ crews: rows.results });
}

async function createCrew(
  request: Request,
  env: CrewEnv,
  account: CrewAccount,
  readJSON: ReadJSON,
): Promise<Response> {
  const body = object(await readJSON(request));
  const crewID = id("crew");
  const name = text(body.name, "Crew name", 80)!;
  const displayName = text(body.displayName, "Display name", 80, true) ?? "You";
  await env.LIBRARY_DB.batch([
    env.LIBRARY_DB.prepare("INSERT INTO crews(id,name,created_by) VALUES(?,?,?)").bind(
      crewID,
      name,
      account.id,
    ),
    env.LIBRARY_DB.prepare(
      "INSERT INTO crew_members(crew_id,account_id,display_name,role) VALUES(?,?,?,'owner')",
    ).bind(crewID, account.id, displayName),
  ]);
  return json({ id: crewID, name, role: "owner", memberCount: 1, crateCount: 0 }, 201);
}

async function crewDetail(env: CrewEnv, account: CrewAccount, crewID: string): Promise<Response> {
  const own = await membership(env, account, crewID);
  const crew = await env.LIBRARY_DB.prepare(
    "SELECT id,name,created_at AS createdAt,updated_at AS updatedAt FROM crews WHERE id=?",
  )
    .bind(crewID)
    .first<{ id: string; name: string; createdAt: string; updatedAt: string }>();
  if (!crew) throw new CrewError(404, "Crew was not found.");
  const [members, crates] = await Promise.all([
    env.LIBRARY_DB.prepare(
      "SELECT account_id AS accountID,display_name AS displayName,role,joined_at AS joinedAt FROM crew_members WHERE crew_id=? ORDER BY joined_at",
    )
      .bind(crewID)
      .all(),
    env.LIBRARY_DB.prepare(`SELECT c.id,c.crew_id AS crewID,c.name,c.note,c.updated_at AS updatedAt,
      COUNT(i.id) AS itemCount FROM crew_crates c LEFT JOIN crew_crate_items i ON i.crate_id=c.id
      WHERE c.crew_id=? GROUP BY c.id ORDER BY c.updated_at DESC,c.name COLLATE NOCASE`)
      .bind(crewID)
      .all(),
  ]);
  return json({
    crew: { ...crew, role: own.role },
    members: members.results,
    crates: crates.results,
  });
}

async function createInvite(
  request: Request,
  env: CrewEnv,
  account: CrewAccount,
  crewID: string,
  readJSON: ReadJSON,
): Promise<Response> {
  const own = await membership(env, account, crewID);
  if (!canAdmin(own.role)) throw new CrewError(403, "Only crew admins can invite members.");
  const body = object(await readJSON(request));
  const roleValue = body.role ?? "dj";
  if (typeof roleValue !== "string" || !["admin", "dj", "viewer"].includes(roleValue))
    throw new CrewError(400, "Invite role is invalid.");
  const role = roleValue as Exclude<Role, "owner">;
  const raw = token();
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
  await env.LIBRARY_DB.prepare(
    "INSERT INTO crew_invites(id,crew_id,token_hash,role,created_by,expires_at) VALUES(?,?,?,?,?,?)",
  )
    .bind(id("invite"), crewID, await digest(raw), role, account.id, expiresAt)
    .run();
  return json({ token: raw, role, expiresAt }, 201);
}

/** Safe to open from Camera, Messages previews, or Safari: never consumes the invite. */
export async function crewInvitePage(request: Request, env: CrewEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!["GET", "HEAD"].includes(request.method)) return null;
  const page = /^\/join\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
  const preview = /^\/v1\/crew-invites\/([A-Za-z0-9_-]{43})$/.exec(url.pathname);
  const raw = page?.[1] ?? preview?.[1];
  if (!raw) return null;
  const invite =
    await env.LIBRARY_DB.prepare(`SELECT c.name AS crewName,i.role,i.expires_at AS expiresAt
    FROM crew_invites i JOIN crews c ON c.id=i.crew_id
    WHERE i.token_hash=? AND i.accepted_at IS NULL AND i.expires_at>?`)
      .bind(await digest(raw), Math.floor(Date.now() / 1000))
      .first<{ crewName: string; role: Role; expiresAt: number }>();
  if (preview)
    return invite
      ? json(invite)
      : json(
          { error: { message: "This invite expired or was already used. Ask for a new invite." } },
          410,
        );
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
    );
  const title = invite ? `Join ${escape(invite.crewName)}` : "This invite is no longer available";
  const description = invite
    ? "You’re invited to a shared folder in DJ Booth. Share playlists, discover tracks and build sets together."
    : "Ask a crew member to send you a fresh invite.";
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta property="og:title" content="${title}"><meta property="og:description" content="${description}"><title>${title} · DJ Booth</title>
  <style>body{margin:0;background:#101114;color:#fafafa;font:17px system-ui;min-height:100svh;display:grid;place-items:center}main{max-width:420px;padding:32px}h1{font-size:36px;letter-spacing:-1px}p{color:#bfc1c8;line-height:1.6}a{display:block;text-align:center;background:#d5ff70;color:#101114;padding:16px;border-radius:16px;text-decoration:none;font-weight:700}small{display:block;margin-top:24px;color:#bfc1c8}</style>
  <main><p>DJ BOOTH · CREWS</p><h1>${title}</h1><p>${description}</p>${invite ? `<a href="djbooth://join/${raw}">Open in DJ Booth</a><small>${invite.role === "viewer" ? "Can view playlists" : "Can edit playlists"} · One person · Expires ${new Date(invite.expiresAt * 1000).toISOString().slice(0, 10)}</small><p>Open this link on your iPhone with DJ Booth installed. You’ll review the invite before joining.</p>` : ""}</main></html>`;
  return new Response(request.method === "HEAD" ? null : html, {
    status: invite ? 200 : 410,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

async function acceptInvite(
  request: Request,
  env: CrewEnv,
  account: CrewAccount,
  raw: string,
  readJSON: ReadJSON,
): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new CrewError(404, "Invitation was not found.");
  const body = object(await readJSON(request));
  const displayName = text(body.displayName, "Display name", 80, true) ?? "DJ";
  const invite = await env.LIBRARY_DB.prepare(
    "SELECT id,crew_id AS crewID,role,accepted_by AS acceptedBy FROM crew_invites WHERE token_hash=? AND (accepted_by=? OR (accepted_at IS NULL AND expires_at>?))",
  )
    .bind(await digest(raw), account.id, Math.floor(Date.now() / 1000))
    .first<{ id: string; crewID: string; role: Role; acceptedBy: string | null }>();
  if (!invite) throw new CrewError(404, "Invitation expired or was already used.");
  if (invite.acceptedBy === account.id) return crewDetail(env, account, invite.crewID);
  const existing = await env.LIBRARY_DB.prepare(
    "SELECT 1 FROM crew_members WHERE crew_id=? AND account_id=?",
  )
    .bind(invite.crewID, account.id)
    .first();
  if (existing) return crewDetail(env, account, invite.crewID);
  const results = await env.LIBRARY_DB.batch([
    env.LIBRARY_DB.prepare(`INSERT OR IGNORE INTO crew_members(crew_id,account_id,display_name,role)
      SELECT crew_id,?,?,role FROM crew_invites WHERE id=? AND accepted_at IS NULL AND expires_at>?`).bind(
      account.id,
      displayName,
      invite.id,
      Math.floor(Date.now() / 1000),
    ),
    env.LIBRARY_DB.prepare(
      "UPDATE crew_invites SET accepted_at=?,accepted_by=? WHERE id=? AND accepted_at IS NULL",
    ).bind(Math.floor(Date.now() / 1000), account.id, invite.id),
  ]);
  if (results[1].meta.changes !== 1)
    throw new CrewError(404, "Invitation expired or was already used.");
  return crewDetail(env, account, invite.crewID);
}

async function createCrate(
  request: Request,
  env: CrewEnv,
  account: CrewAccount,
  crewID: string,
  readJSON: ReadJSON,
): Promise<Response> {
  const own = await membership(env, account, crewID);
  if (!canWrite(own.role)) throw new CrewError(403, "This crew role cannot edit crates.");
  const body = object(await readJSON(request));
  const crateID = id("crate");
  const name = text(body.name, "Crate name", 120)!;
  const note = text(body.note, "Crate note", 1000, true);
  await env.LIBRARY_DB.batch([
    env.LIBRARY_DB.prepare(
      "INSERT INTO crew_crates(id,crew_id,name,note,created_by) VALUES(?,?,?,?,?)",
    ).bind(crateID, crewID, name, note, account.id),
    env.LIBRARY_DB.prepare(
      "UPDATE crews SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
    ).bind(crewID),
  ]);
  return json({ id: crateID, crewID, name, note, itemCount: 0 }, 201);
}

async function crateDetail(
  env: CrewEnv,
  account: CrewAccount,
  crewID: string,
  crateID: string,
): Promise<Response> {
  await membership(env, account, crewID);
  const crate = await env.LIBRARY_DB.prepare(
    "SELECT id,crew_id AS crewID,name,note,updated_at AS updatedAt FROM crew_crates WHERE id=? AND crew_id=?",
  )
    .bind(crateID, crewID)
    .first();
  if (!crate) throw new CrewError(404, "Crate was not found.");
  const items =
    await env.LIBRARY_DB.prepare(`SELECT id,crate_id AS crateID,recording_id AS recordingID,
    asset_hash AS assetHash,local_track_id AS localTrackID,title,artist,bpm,musical_key AS musicalKey,
    duration_seconds AS durationSeconds,note,sort_key AS sortKey,added_by AS addedBy,created_at AS createdAt,
    updated_at AS updatedAt,track_json AS trackJSON FROM crew_crate_items WHERE crate_id=? ORDER BY sort_key,id`)
      .bind(crateID)
      .all();
  return json({
    crate,
    items: items.results.map(({ trackJSON, ...item }) => ({
      ...item,
      track: typeof trackJSON === "string" ? JSON.parse(trackJSON) : null,
    })),
  });
}

async function addItem(
  request: Request,
  env: CrewEnv,
  account: CrewAccount,
  crewID: string,
  crateID: string,
  readJSON: ReadJSON,
): Promise<Response> {
  const own = await membership(env, account, crewID);
  if (!canWrite(own.role)) throw new CrewError(403, "This crew role cannot edit crates.");
  const body = object(await readJSON(request));
  const track = object(body.track);
  const recordingID = text(track.recordingID ?? track.id, "Recording ID", 256)!;
  const title = text(track.title, "Track title", 512)!;
  const assetHash = text(track.assetHash ?? track.mediaHash, "Asset hash", 64, true);
  if (assetHash && !HASH.test(assetHash)) throw new CrewError(400, "Asset hash is invalid.");
  // Resolve metadata from an authorized cloud source, never trust a supplied owner/hash grant.
  let trackJSON: string | null = null;
  let mediaOwner: string | null = null;
  if (assetHash) {
    const ownTrack = await env.LIBRARY_DB.prepare(`SELECT payload FROM sync_changes
      WHERE account_id=? AND kind='track' AND entity_id=? ORDER BY sequence DESC LIMIT 1`)
      .bind(account.id, recordingID)
      .first<{ payload: string | null }>();
    if (ownTrack?.payload && JSON.parse(ownTrack.payload).mediaHash === assetHash) {
      trackJSON = ownTrack.payload;
      mediaOwner = account.id;
    } else {
      const shared =
        await env.LIBRARY_DB.prepare(`SELECT i.track_json AS payload,i.media_owner_id AS owner
        FROM crew_crate_items i JOIN crew_members m ON m.crew_id=i.crew_id
        WHERE m.account_id=? AND i.asset_hash=? AND i.track_json IS NOT NULL AND i.media_owner_id IS NOT NULL LIMIT 1`)
          .bind(account.id, assetHash)
          .first<{ payload: string; owner: string }>();
      if (shared) {
        trackJSON = shared.payload;
        mediaOwner = shared.owner;
      }
    }
    if (!mediaOwner || !trackJSON)
      throw new CrewError(409, "Sync this track to your cloud library before sharing it.");
    const available =
      (await env.MEDIA.head(`accounts/${mediaOwner}/sha256/${assetHash}`)) ??
      (await env.MEDIA.head(`accounts/${mediaOwner}/compositions/${assetHash}`));
    if (!available)
      throw new CrewError(
        409,
        "This track’s audio is not in the cloud yet. Finish uploading it before sharing.",
      );
  }
  const crate = await env.LIBRARY_DB.prepare("SELECT id FROM crew_crates WHERE id=? AND crew_id=?")
    .bind(crateID, crewID)
    .first();
  if (!crate) throw new CrewError(404, "Crate was not found.");
  const last = await env.LIBRARY_DB.prepare(
    "SELECT COALESCE(MAX(sort_key),0) AS value FROM crew_crate_items WHERE crate_id=?",
  )
    .bind(crateID)
    .first<{ value: number }>();
  const itemID = id("item");
  const optionalNumber = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  await env.LIBRARY_DB.batch([
    env.LIBRARY_DB.prepare(`INSERT INTO crew_crate_items
      (id,crew_id,crate_id,recording_id,asset_hash,local_track_id,title,artist,bpm,musical_key,duration_seconds,note,sort_key,added_by,track_json,media_owner_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      itemID,
      crewID,
      crateID,
      recordingID,
      assetHash,
      text(track.localTrackID ?? track.id, "Local track ID", 256, true),
      title,
      text(track.artist, "Artist", 512, true),
      optionalNumber(track.bpm),
      text(track.musicalKey ?? track.key, "Key", 32, true),
      optionalNumber(track.durationSeconds),
      text(body.note, "Track note", 1000, true),
      Number(last?.value ?? 0) + 1024,
      account.id,
      trackJSON,
      mediaOwner,
    ),
    env.LIBRARY_DB.prepare(`UPDATE crew_crates SET updated_at=${now} WHERE id=?`).bind(crateID),
    env.LIBRARY_DB.prepare(`UPDATE crews SET updated_at=${now} WHERE id=?`).bind(crewID),
  ]);
  return crateDetail(env, account, crewID, crateID);
}

async function deleteItem(
  env: CrewEnv,
  account: CrewAccount,
  crewID: string,
  crateID: string,
  itemID: string,
): Promise<Response> {
  const own = await membership(env, account, crewID);
  if (!canWrite(own.role)) throw new CrewError(403, "This crew role cannot edit crates.");
  const result = await env.LIBRARY_DB.prepare(
    "DELETE FROM crew_crate_items WHERE id=? AND crate_id=? AND crew_id=?",
  )
    .bind(itemID, crateID, crewID)
    .run();
  if (result.meta.changes !== 1) throw new CrewError(404, "Crate item was not found.");
  await env.LIBRARY_DB.prepare(
    "UPDATE crew_crates SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
  )
    .bind(crateID)
    .run();
  return new Response(null, { status: 204 });
}

async function moveItem(
  request: Request,
  env: CrewEnv,
  account: CrewAccount,
  crewID: string,
  crateID: string,
  itemID: string,
  readJSON: ReadJSON,
): Promise<Response> {
  const own = await membership(env, account, crewID);
  if (!canWrite(own.role)) throw new CrewError(403, "This crew role cannot edit crates.");
  const body = object(await readJSON(request));
  const afterItemID =
    body.afterItemID === null ? null : text(body.afterItemID, "Previous item", 64, true);
  const current = await env.LIBRARY_DB.prepare(
    "SELECT id FROM crew_crate_items WHERE id=? AND crate_id=? AND crew_id=?",
  )
    .bind(itemID, crateID, crewID)
    .first();
  if (!current) throw new CrewError(404, "Crate item was not found.");
  let sortKey: number;
  if (afterItemID) {
    const previous = await env.LIBRARY_DB.prepare(
      "SELECT sort_key AS sortKey FROM crew_crate_items WHERE id=? AND crate_id=?",
    )
      .bind(afterItemID, crateID)
      .first<{ sortKey: number }>();
    if (!previous) throw new CrewError(409, "The crate changed; refresh and try again.");
    const next = await env.LIBRARY_DB.prepare(
      "SELECT sort_key AS sortKey FROM crew_crate_items WHERE crate_id=? AND id<>? AND sort_key>? ORDER BY sort_key,id LIMIT 1",
    )
      .bind(crateID, itemID, previous.sortKey)
      .first<{ sortKey: number }>();
    sortKey = next ? (previous.sortKey + next.sortKey) / 2 : previous.sortKey + 1024;
  } else {
    const first = await env.LIBRARY_DB.prepare(
      "SELECT MIN(sort_key) AS sortKey FROM crew_crate_items WHERE crate_id=? AND id<>?",
    )
      .bind(crateID, itemID)
      .first<{ sortKey: number | null }>();
    sortKey = (first?.sortKey ?? 1024) - 1024;
  }
  await env.LIBRARY_DB.batch([
    env.LIBRARY_DB.prepare(
      "UPDATE crew_crate_items SET sort_key=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND crate_id=?",
    ).bind(sortKey, itemID, crateID),
    env.LIBRARY_DB.prepare(
      "UPDATE crew_crates SET updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
    ).bind(crateID),
  ]);
  return crateDetail(env, account, crewID, crateID);
}

async function route(
  request: Request,
  env: CrewEnv,
  account: CrewAccount,
  readJSON: ReadJSON,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/v1/crews") {
      if (request.method === "GET") return listCrews(env, account);
      if (request.method === "POST") return createCrew(request, env, account, readJSON);
    }
    if (url.pathname === "/v1/crews/events" && request.method === "GET") {
      if (!env.CREW_ROOMS) throw new CrewError(503, "Live updates are temporarily unavailable.");
      return env.CREW_ROOMS.get(env.CREW_ROOMS.idFromName(`account:${account.id}`)).fetch(request);
    }
    const events = /^\/v1\/crews\/([^/]+)\/events$/.exec(url.pathname);
    if (events && request.method === "GET") {
      const crewID = requireID(events[1]);
      await membership(env, account, crewID);
      if (!env.CREW_ROOMS) throw new CrewError(503, "Live updates are temporarily unavailable.");
      return env.CREW_ROOMS.get(env.CREW_ROOMS.idFromName(crewID)).fetch(request);
    }
    const accepted = /^\/v1\/crew-invites\/([A-Za-z0-9_-]{43})\/accept$/.exec(url.pathname);
    if (accepted && request.method === "POST")
      return acceptInvite(request, env, account, accepted[1], readJSON);
    const item = /^\/v1\/crews\/([^/]+)\/crates\/([^/]+)\/items\/([^/]+)$/.exec(url.pathname);
    if (item && request.method === "DELETE")
      return deleteItem(env, account, requireID(item[1]), requireID(item[2]), requireID(item[3]));
    if (item && request.method === "PATCH")
      return moveItem(
        request,
        env,
        account,
        requireID(item[1]),
        requireID(item[2]),
        requireID(item[3]),
        readJSON,
      );
    const crate = /^\/v1\/crews\/([^/]+)\/crates\/([^/]+)$/.exec(url.pathname);
    if (crate && request.method === "GET")
      return crateDetail(env, account, requireID(crate[1]), requireID(crate[2]));
    const items = /^\/v1\/crews\/([^/]+)\/crates\/([^/]+)\/items$/.exec(url.pathname);
    if (items && request.method === "POST")
      return addItem(request, env, account, requireID(items[1]), requireID(items[2]), readJSON);
    const crates = /^\/v1\/crews\/([^/]+)\/crates$/.exec(url.pathname);
    if (crates && request.method === "POST")
      return createCrate(request, env, account, requireID(crates[1]), readJSON);
    const invites = /^\/v1\/crews\/([^/]+)\/invites$/.exec(url.pathname);
    if (invites && request.method === "POST")
      return createInvite(request, env, account, requireID(invites[1]), readJSON);
    const crew = /^\/v1\/crews\/([^/]+)$/.exec(url.pathname);
    if (crew && request.method === "GET") return crewDetail(env, account, requireID(crew[1]));
    return json({ error: { message: "Method not allowed." } }, 405);
  } catch (error) {
    if (error instanceof CrewError)
      return json({ error: { message: error.message } }, error.status);
    throw error;
  }
}

export async function crewRoute(
  request: Request,
  env: CrewEnv,
  account: CrewAccount,
  readJSON: ReadJSON,
): Promise<Response> {
  // Await inside the router so asynchronous permission errors become HTTP responses.
  let response: Response;
  try {
    response = await route(request, env, account, readJSON);
  } catch (error) {
    if (error instanceof CrewError)
      return json({ error: { message: error.message } }, error.status);
    throw error;
  }
  if (response.ok && !["GET", "HEAD"].includes(request.method) && env.CREW_ROOMS) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/crews" || path.endsWith("/accept")) {
      try {
        await env.CREW_ROOMS.get(env.CREW_ROOMS.idFromName(`account:${account.id}`)).changed();
      } catch {
        console.warn("Crew membership notification failed; clients will reconcile.");
      }
    }
    let crewID = /^\/v1\/crews\/([^/]+)/.exec(path)?.[1];
    if (path.endsWith("/accept"))
      crewID = ((await response.clone().json()) as { crew: { id: string } }).crew.id;
    if (crewID) {
      try {
        await env.CREW_ROOMS.get(env.CREW_ROOMS.idFromName(crewID)).changed();
      } catch {
        console.warn("Crew update notification failed; clients will reconcile.");
      }
    }
  }
  return response;
}

/** Only the exact audio/analysis referenced by a current membership is shared. */
export async function sharedMediaOwner(
  env: CrewEnv,
  accountID: string,
  hash: string,
): Promise<string | null> {
  const row = await env.LIBRARY_DB.prepare(`SELECT i.media_owner_id AS owner FROM crew_crate_items i
    JOIN crew_members m ON m.crew_id=i.crew_id WHERE m.account_id=? AND i.media_owner_id IS NOT NULL
    AND (i.asset_hash=? OR json_extract(i.track_json,'$.analysis.dat')=?
      OR json_extract(i.track_json,'$.analysis.ext')=? OR json_extract(i.track_json,'$.analysis.twoEx')=?) LIMIT 1`)
    .bind(accountID, hash, hash, hash, hash)
    .first<{ owner: string }>();
  return row?.owner ?? null;
}
