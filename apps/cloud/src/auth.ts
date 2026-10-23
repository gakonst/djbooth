import type { Env } from "./index.js";

export const CONNECT_APP_ID = "djbooth";
export const CONNECT_API = "https://nanocodex-connect-api.gakonst.workers.dev";
export const CONNECT_DIALOG = "https://nanocodex.gakonst.workers.dev/connect-dialog/";
const COOKIE = "djbooth_connect";
const CREDENTIAL = /^nc1\.(0x[a-fA-F0-9]{64})\.([A-Za-z0-9_-]{43})$/;
export interface Account {
  id: string;
  grantId: string;
  agentId?: string;
  conversationId?: string;
  appToolCatalogDigest?: string;
  expiresAt: number;
  capabilities: string[];
  /** Fresh issuer projection, retained only for this incoming music request. */
  musicConnectors?: Record<string, unknown>;
}
export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
export function credential(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization) return /^Bearer (\S+)$/i.exec(authorization)?.[1];
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
}
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    throw new AuthError(403, "Request origin is not allowed.");
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new AuthError(403, "Request origin is not allowed.");
}
/** Validate the bearer at the issuer on every request, including revocation and expiry.
 * Neither an account ID from the client nor a locally decoded grant is identity proof. */
export async function authenticate(request: Request, env: Env): Promise<Account> {
  assertSameOrigin(request);
  if (env.SHARED_LIBRARY_ACCOUNT) {
    if (!/^nc_[a-f0-9]{64}$/.test(env.SHARED_LIBRARY_ACCOUNT))
      throw new AuthError(503, "Shared library account is misconfigured.");
    const path = new URL(request.url).pathname;
    const login = ["/v1/auth/connect", "/v1/auth/exchange"].includes(path);
    if (!["GET", "HEAD"].includes(request.method) && !login) {
      const token = credential(request);
      if (
        !env.SHARED_LIBRARY_WRITE_TOKEN_HASH ||
        !token ||
        (await digest(token)) !== env.SHARED_LIBRARY_WRITE_TOKEN_HASH
      )
        throw new AuthError(401, "Library changes require the private publishing token.");
    }
    return {
      id: env.SHARED_LIBRARY_ACCOUNT,
      grantId: "shared-library",
      expiresAt: 4102444800,
      capabilities: [],
    };
  }
  const match = CREDENTIAL.exec(credential(request) ?? "");
  if (!match) throw new AuthError(401, "Continue with Nanocodex to access your library.");
  const music = new URL(request.url).pathname.startsWith("/v1/music/");
  const route = `/v1/grants/${match[1]}${music ? "/connectors?providers=spotify,soundcloud" : ""}`;
  const verification = new Request(`${CONNECT_API}${route}`, {
    headers: {
      authorization: `Bearer ${match[2]}`,
      origin: new URL(request.url).origin,
      "x-nanocodex-app-id": CONNECT_APP_ID,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  const response = await (env.CONNECT_API_SERVICE
    ? env.CONNECT_API_SERVICE.fetch(verification)
    : fetch(verification));
  if (response.status === 401 || response.status === 403 || response.status === 404)
    throw new AuthError(
      401,
      "Your Nanocodex connection has expired or was revoked. Sign in again.",
    );
  if (!response.ok)
    throw new AuthError(503, "Nanocodex authentication is temporarily unavailable.");
  const wire = await response.json<{
    account_id?: string;
    agent_id?: string;
    connectors?: Record<string, unknown>;
    grant?: {
      id?: string;
      status?: string;
      expires_at?: number;
      capabilities?: string[];
      app_tool_catalog_digest?: string;
      conversation_id?: string;
    };
  }>();
  const grant = wire.grant;
  if (
    !wire.account_id ||
    typeof wire.account_id !== "string" ||
    wire.account_id.length > 256 ||
    !grant ||
    grant.id?.toLowerCase() !== match[1].toLowerCase() ||
    grant.status !== "active" ||
    !Number.isSafeInteger(grant.expires_at) ||
    grant.expires_at! <= Date.now() / 1000 ||
    !Array.isArray(grant.capabilities) ||
    !grant.capabilities.every((v) => typeof v === "string")
  )
    throw new AuthError(401, "Invalid or expired Nanocodex connection.");
  if (
    music &&
    (!wire.connectors || typeof wire.connectors !== "object" || Array.isArray(wire.connectors))
  )
    throw new AuthError(503, "Nanocodex connector status is temporarily unavailable.");
  return {
    id: `nc_${await digest(wire.account_id)}`,
    grantId: grant.id,
    ...(typeof wire.agent_id === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(wire.agent_id)
      ? { agentId: wire.agent_id }
      : {}),
    expiresAt: grant.expires_at!,
    capabilities: grant.capabilities,
    ...(typeof grant.conversation_id === "string" && /^[a-f0-9-]{36}$/.test(grant.conversation_id)
      ? { conversationId: grant.conversation_id }
      : {}),
    ...(music ? { musicConnectors: wire.connectors } : {}),
    ...(typeof grant.app_tool_catalog_digest === "string"
      ? { appToolCatalogDigest: grant.app_tool_catalog_digest }
      : {}),
  };
}
const json = (body: unknown, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { "cache-control": "private, no-store", ...headers } });
function cookie(request: Request, value: string, age: number): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
export async function authRoute(
  request: Request,
  env: Env,
  readJSON: (r: Request) => Promise<unknown>,
): Promise<Response> {
  assertSameOrigin(request);
  const path = new URL(request.url).pathname;
  if (path === "/v1/auth/config" && request.method === "GET")
    return json({
      appId: CONNECT_APP_ID,
      api: CONNECT_API,
      dialog: CONNECT_DIALOG,
      mode: env.SHARED_LIBRARY_ACCOUNT ? "shared" : "connect",
    });
  if (path === "/v1/auth/logout" && request.method === "POST")
    return json({ signedOut: true }, 200, { "set-cookie": cookie(request, "", 0) });
  if (path === "/v1/auth/session" && request.method === "GET")
    return json({ account: await authenticate(request, env) });
  if (request.method !== "POST") throw new AuthError(405, "Method not allowed.");
  const body = (await readJSON(request)) as Record<string, unknown>;
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new AuthError(400, "Invalid login request.");
  if (path === "/v1/auth/exchange") {
    if (
      typeof body.code !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.code) ||
      typeof body.verifier !== "string" ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(body.verifier)
    )
      throw new AuthError(400, "Invalid login code.");
    const row = await env.LIBRARY_DB.prepare(
      "DELETE FROM login_codes WHERE code_hash=? AND challenge=? AND expires_at>? RETURNING credential",
    )
      .bind(await digest(body.code), await digest(body.verifier), Date.now())
      .first<{ credential: string }>();
    if (!row) throw new AuthError(401, "Login code expired or already used.");
    const verified = new Request(request.url, { headers: request.headers });
    verified.headers.set("authorization", `Bearer ${row.credential}`);
    return json({ token: row.credential, account: await authenticate(verified, env) });
  }
  if (path !== "/v1/auth/connect") throw new AuthError(404, "Not found.");
  const token = env.SHARED_LIBRARY_ACCOUNT ? "shared-library" : `nc1.${body.grantId}.${body.token}`;
  const verified = new Request(request.url, { headers: request.headers });
  verified.headers.set("authorization", `Bearer ${token}`);
  const account = await authenticate(verified, env);
  if (body.challenge !== undefined) {
    if (typeof body.challenge !== "string" || !/^[a-f0-9]{64}$/.test(body.challenge))
      throw new AuthError(400, "Invalid login challenge.");
    const code = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
    await env.LIBRARY_DB.batch([
      env.LIBRARY_DB.prepare("DELETE FROM login_codes WHERE expires_at<=?").bind(Date.now()),
      env.LIBRARY_DB.prepare("INSERT INTO login_codes VALUES (?,?,?,?)").bind(
        await digest(code),
        body.challenge,
        token,
        Date.now() + 60_000,
      ),
    ]);
    return json({ account, code });
  }
  return json({ account }, 200, {
    "set-cookie": cookie(
      request,
      token,
      Math.min(account.expiresAt - Math.floor(Date.now() / 1000), 30 * 86400),
    ),
  });
}
